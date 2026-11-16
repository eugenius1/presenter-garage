import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isContainer, LoroDoc, LoroList, LoroMap, LoroMovableList, type Container } from "loro-crdt/base64";
import { FixError, type FixRefusal, type LineFix } from "@presenter-garage/core/lib/fixes";
import { encodePresentation } from "@presenter-garage/core/lib/presentation";
import { isObject, presentationFromWorkspace } from "@presenter-garage/core/lib/workspace";
import {
  AttributeRangeError,
  checkWorkspaceEdit,
  encodeVersionVector,
  onlyPeerAdded,
  planWorkspaceEdit,
  stableJson,
  type BoxEdit,
  type LoroKey,
  type WorkspaceEdit,
} from "@presenter-garage/core/lib/workspace-edit";
import { LibraryError } from "./paths";
import { backupPath, errorDetail, runFolder, same, sha256, writeBackups, type WriteOutcome } from "./write";
import { hex, isOwnPath, openDatabase, REGISTRY, type StoredDocument, type Workspace } from "./workspace";

/**
 * Writing slide text into a ProPresenter 22 workspace.
 *
 * The disk half of the workspace write path, as `write.ts` is for `.pro`
 * files: `workspace-edit.ts` in core says what each edit is in the Loro
 * document's terms and checks the result, and this takes the lock, makes
 * the backup, edits the document and replaces its row. What was found out
 * on the way, and why each step is here, is docs/propresenter-22-writing.md.
 *
 * In short, for every presentation of a run, in one transaction on one
 * connection that holds the store exclusively:
 *
 * 1. the row is still the one the plan was made from, by its `sha256`;
 * 2. the document passes the fidelity gate as it is now (`gate`);
 * 3. every row about to change is backed up, read back, and flushed;
 * 4. the document is edited as itself, by a new peer, in one commit;
 * 5. the new snapshot is decoded afresh and checked against the plan;
 * 6. the row is replaced, read back on the same connection and checked again.
 *
 * Anything wrong in 4 to 6 rolls the whole run back. Then the store is
 * reopened read-only and every row checked once more.
 */

/** The formats this has been checked against: the registry's `schema_version`, and the store's `user_version`. */
export const VERIFIED_SCHEMA_VERSION = "22.9.0";
const VERIFIED_USER_VERSION = 9;

export const PROPRESENTER_OPEN =
  "ProPresenter has this workspace open, so nothing was written: a change made under it is lost the next " +
  "time it saves the presentation. Quit ProPresenter, then plan and apply the edits again.";

export const CLOUD_REFUSED =
  "This is a ProPresenter Cloud workspace, which is not written to yet: what Cloud does with a change made " +
  "outside ProPresenter has not been tried (https://github.com/eugenius1/presenter-garage/issues/55). " +
  "Make the change in ProPresenter itself.";

const unverified = (what: string) =>
  `This workspace's ${what}, which this has not been checked against, so it is not written to. ` +
  "Make the change in ProPresenter itself.";

/**
 * Refuse a workspace this cannot write to: one synced through ProPresenter
 * Cloud, or one whose format is not a version this was checked against.
 * Part of guard 1: the gate on a document means little if the store around
 * it is a format nobody has looked at.
 *
 * The registry is the one in the folder above the workspace, where
 * ProPresenter keeps it, and the workspace's row is the one named by the
 * folder's own name, which is the workspace's uuid.
 */
export async function checkWritableWorkspace(workspace: Workspace): Promise<void> {
  const root = workspace.root;
  if (await fs.stat(path.join(root, "imprint.cloud")).catch(() => undefined)) throw new LibraryError(CLOUD_REFUSED);
  const registry = path.join(path.dirname(root), REGISTRY);
  if (!(await fs.stat(registry).catch(() => undefined))?.isFile()) {
    throw new LibraryError(unverified(`format version could not be read: there is no ${REGISTRY} beside it`));
  }
  const db = await openDatabase(registry);
  let row;
  try {
    row = db
      .prepare("SELECT cloud_uuid, schema_version FROM workspaces WHERE local_uuid = ? OR root_path = ?")
      .get(path.basename(root), root);
  } catch (e) {
    throw new LibraryError(`Could not read ${registry}: ${(e as Error).message}`);
  } finally {
    db.close();
  }
  if (!row) throw new LibraryError(unverified(`format version could not be read: ${REGISTRY} does not list it`));
  if (row.cloud_uuid !== null) throw new LibraryError(CLOUD_REFUSED);
  if (row.schema_version !== VERIFIED_SCHEMA_VERSION) {
    throw new LibraryError(unverified(`format is ${String(row.schema_version)}, not ${VERIFIED_SCHEMA_VERSION}`));
  }
}

/** A row of `workspace_streams`, as the write path reads it. */
interface Row {
  snapshot: Uint8Array;
  sha256: Uint8Array;
  version_vector: Uint8Array;
  [column: string]: unknown;
}

/**
 * Guard 1 on one document, as stored: the hash beside the snapshot is its
 * hash; the snapshot imports, exports and imports again to the same JSON,
 * version vector and frontiers, so nothing in it is lost on the way through
 * our Loro; and our encoding of its version vector is byte for byte the
 * stored one, which shows the row's bookkeeping is understood. Returns the
 * document's `root` and version vector, or throws `FixError("lossy")`.
 */
export function gate(row: Row): { root: unknown; version: Map<string, number> } {
  const doc = new LoroDoc();
  const again = new LoroDoc();
  try {
    if (!row.snapshot || sha256(row.snapshot) !== hex(row.sha256)) throw new FixError("lossy");
    doc.import(row.snapshot);
    again.import(doc.export({ mode: "snapshot" }));
    const json = doc.toJSON() as { root?: unknown };
    const version = doc.version().toJSON();
    // Compared encoded, which puts the peers in order: a Map gives them in
    // whatever order it holds them, which differs between two imports.
    const encoded = encodeVersionVector(version);
    const roundTrips =
      stableJson(json) === stableJson(again.toJSON()) &&
      same(encoded, encodeVersionVector(again.version().toJSON())) &&
      heads(doc) === heads(again) &&
      same(encoded, row.version_vector ?? new Uint8Array());
    if (!roundTrips) throw new FixError("lossy");
    return { root: json.root, version };
  } catch (e) {
    throw e instanceof FixError ? e : new FixError("lossy");
  } finally {
    doc.free();
    again.free();
  }
}

type Database = import("node:sqlite").DatabaseSync;

/** A document's frontiers in one spelling, in order. */
const heads = (doc: LoroDoc) =>
  doc
    .frontiers()
    .map(({ peer, counter }) => `${peer}@${counter}`)
    .sort()
    .join(",");

const SELECT_ROW = "SELECT * FROM workspace_streams WHERE document_id = ? AND scope = 0";

/**
 * What a plan needs of a document: its row's hash, and the bytes of the
 * `.pro` file it converts to, which is what the person is shown. Refused
 * here, before anybody reads a line, for anything the apply would refuse
 * for the document as it stands.
 */
export async function readForPlanning(
  workspace: Workspace,
  document: StoredDocument
): Promise<{ bytes: Uint8Array; sha256: string; root: unknown }> {
  await checkWritableWorkspace(workspace);
  if (document.kind !== "Presentation") throw new LibraryError(`Not a presentation: ${document.path}`);
  if (!(await isOwnPath(workspace.store))) {
    throw new LibraryError(`Could not read ${workspace.store}: it is reached through a symlink`);
  }
  const db = await openDatabase(workspace.store);
  let row: Row | undefined;
  try {
    checkStoreVersion(db);
    row = db.prepare(SELECT_ROW).get(document.id) as Row | undefined;
  } finally {
    db.close();
  }
  if (!row?.snapshot) throw new LibraryError(`Could not read ${document.path}: it is no longer in the workspace`);
  let root;
  try {
    ({ root } = gate(row));
  } catch {
    throw new LibraryError(
      `${document.path}: this document does not come back exactly as it was through a read and a rewrite, ` +
        "so it is not written to. Nothing was planned."
    );
  }
  const { message } = presentationFromWorkspace(root);
  return { bytes: encodePresentation(message), sha256: hex(row.sha256), root };
}

/** Refuse a document store of a version this has not been checked against. */
function checkStoreVersion(db: Database): void {
  const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (version !== VERIFIED_USER_VERSION) {
    throw new LibraryError(unverified(`document store is version ${version}, not ${VERIFIED_USER_VERSION}`));
  }
}

/**
 * Take the store for ourselves, or refuse.
 *
 * `locking_mode = EXCLUSIVE` before anything is read, then a write
 * transaction with no waiting: refused whenever another connection has the
 * store open, which ProPresenter's does for as long as it runs. Seen to be
 * refused every time while it ran and granted once it had quit. While we
 * hold it ProPresenter cannot open the store either.
 */
async function lockStore(store: string): Promise<Database> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(store);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("BEGIN IMMEDIATE");
  } catch (e) {
    db.close();
    if (/locked|busy/i.test((e as Error).message)) throw new LibraryError(PROPRESENTER_OPEN);
    throw new LibraryError(`Could not open ${store} for writing: ${(e as Error).message}`);
  }
  try {
    checkStoreVersion(db);
  } catch (e) {
    db.exec("ROLLBACK");
    db.close();
    throw e;
  }
  return db;
}

/** One presentation to change: the document, the row it was planned against, and the lines chosen. */
export interface WorkspaceReplacement {
  /** The document's old-layout path, as the plan named it. */
  path: string;
  documentId: Uint8Array;
  /** Of the row the plan was made from. */
  sha256: string;
  fixes: LineFix[];
}

/**
 * Why a presentation in a workspace was not written, beyond the refusals the
 * `.pro` path shares:
 *
 * - `attributeRanges`: a box's character ranges do not fall on its lines, so
 *   they cannot be moved with the text.
 * - `rolledBack`: this one was fine, but another in the same run was not,
 *   and a run is written whole or not at all.
 */
export type WorkspaceRefusal = FixRefusal | "attributeRanges" | "rolledBack" | "backupFailed" | "readBackFailed";

export interface WorkspaceOutcome extends Omit<WriteOutcome, "reason"> {
  reason?: WorkspaceRefusal;
}

/** Seams for the tests, to make a row read back wrong. Never set in use. */
export interface WriteHooks {
  afterUpdate?: (db: Database, documentId: Uint8Array) => void;
}

/** A presentation that passed its checks and is about to be backed up and written. */
interface Ready {
  index: number;
  replacement: WorkspaceReplacement;
  row: Row;
  root: unknown;
  version: Map<string, number>;
  edit: WorkspaceEdit;
}

/** Why a presentation failed once the transaction had begun, which rolls back the run. */
class WriteFailed extends Error {
  readonly reason: WorkspaceRefusal;
  readonly detail?: string;

  constructor(reason: WorkspaceRefusal, detail?: string) {
    super(detail ?? reason);
    this.reason = reason;
    this.detail = detail;
  }
}

/** A failure in the steps that edit and write, as the reason it is reported under. */
const failure = (e: unknown, fallback: WorkspaceRefusal = "verifyFailed") =>
  e instanceof WriteFailed
    ? e
    : e instanceof FixError
      ? new WriteFailed(e.reason)
      : new WriteFailed(fallback, errorDetail(e));

/**
 * Write each presentation's chosen lines into the workspace, in one
 * transaction, or none of them.
 *
 * `backupDir` must already be open (`openBackupDir`). A presentation refused
 * before the backup -- stale, failing the gate, ranges off its lines -- is
 * left out and the rest go ahead, as a `.pro` file refused would be; past
 * the backup, one that fails stops all of them.
 */
export async function writeWorkspaceEdits(
  workspace: Workspace,
  roots: readonly string[],
  backupDir: string,
  replacements: readonly WorkspaceReplacement[],
  { now = new Date(), signal, hooks }: { now?: Date; signal?: AbortSignal; hooks?: WriteHooks } = {}
): Promise<{ backupFolder?: string; outcomes: WorkspaceOutcome[] }> {
  const outcomes: WorkspaceOutcome[] = replacements.map((r) => ({ path: r.path, written: false }));
  if (replacements.length === 0) return { outcomes };

  await checkWritableWorkspace(workspace);
  if (!(await isOwnPath(workspace.store))) {
    throw new LibraryError(`Could not open ${workspace.store}: it is reached through a symlink`);
  }
  const db = await lockStore(workspace.store);
  let backupFolder: string | undefined;
  let committed = false;
  const written: { item: Ready; snapshot: Uint8Array }[] = [];
  try {
    const ready: Ready[] = [];
    for (const [index, replacement] of replacements.entries()) {
      try {
        ready.push(prepare(db, index, replacement));
      } catch (e) {
        Object.assign(outcomes[index], refusalOf(e));
      }
    }
    if (ready.length === 0) return { outcomes };

    // Guard 2, inside the lock, so these are the rows that get replaced.
    try {
      const folder = (backupFolder = await runFolder(backupDir, now));
      const files = ready.flatMap(({ index, replacement, row, root }) => {
        const copy = backupPath(folder, roots, replacement.path);
        outcomes[index].backup = copy;
        return backupOf(copy, row, root);
      });
      await writeBackups(backupDir, files);
    } catch (e) {
      for (const { index } of ready) Object.assign(outcomes[index], { reason: "backupFailed", detail: errorDetail(e) });
      return { backupFolder, outcomes };
    }
    if (signal?.aborted) {
      throw new LibraryError(
        `The call was cancelled before anything changed, so nothing was written. Its backups are in ${backupFolder}.`
      );
    }

    let current: Ready | undefined;
    try {
      for (current of ready) written.push({ item: current, snapshot: writeOne(db, current, hooks) });
    } catch (e) {
      const { reason, detail } = failure(e);
      for (const { index } of ready) outcomes[index].reason = "rolledBack";
      Object.assign(outcomes[current!.index], { reason, detail });
      return { backupFolder, outcomes };
    }
    db.exec("COMMIT");
    committed = true;
    for (const { index } of ready) outcomes[index].written = true;
  } finally {
    // Rolled back however the run ended short of a commit; a failed
    // ROLLBACK leaves nothing to undo, since nothing was committed.
    if (!committed) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Nothing was committed, and closing discards what was not.
      }
    }
    // Closing the last connection folds the write-ahead log into the database.
    db.close();
  }

  // Once more, from a connection of its own, as the next reader will see it.
  await readBack(workspace.store, written, outcomes);
  return { backupFolder, outcomes };
}

function refusalOf(e: unknown): Pick<WorkspaceOutcome, "reason" | "detail"> {
  if (e instanceof FixError) return { reason: e.reason };
  if (e instanceof AttributeRangeError) return { reason: "attributeRanges", detail: `text box ${e.boxIndex + 1}` };
  return { reason: "unreadable", detail: (e as Error).message };
}

/** The checks before anything is backed up: the row is the planned one, and the document passes the gate and takes the edit. */
function prepare(db: Database, index: number, replacement: WorkspaceReplacement): Ready {
  const row = db.prepare(SELECT_ROW).get(replacement.documentId) as Row | undefined;
  if (!row?.snapshot || row.kind !== "Presentation" || Number(row.availability) !== 0) throw new FixError("stale");
  if (hex(row.sha256) !== replacement.sha256) throw new FixError("stale");
  const { root, version } = gate(row);
  const edit = planWorkspaceEdit(root, replacement.fixes);
  return { index, replacement, row, root, version, edit };
}

/**
 * The backup of one row: the snapshot as stored, the other columns beside it
 * (bytes as hex), and the `.pro` file the conversion gives, for a person to
 * read. Together they are enough to put the row back as it was.
 */
function backupOf(copy: string, row: Row, root: unknown): { path: string; bytes: Uint8Array }[] {
  const columns = Object.fromEntries(
    Object.entries(row)
      .filter(([column]) => column !== "snapshot")
      .map(([column, value]) => [column, ArrayBuffer.isView(value) ? hex(value) : value])
  );
  const bytes = (text: string) => new TextEncoder().encode(text);
  return [
    { path: `${copy}.loro`, bytes: row.snapshot },
    { path: `${copy}.row.json`, bytes: bytes(`${JSON.stringify(columns, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2)}\n`) },
    { path: copy, bytes: encodePresentation(presentationFromWorkspace(root).message) },
  ];
}

/** A peer id nobody has used in this document: random, and never one already in its version vector. */
function newPeer(version: Map<string, number>): bigint {
  for (;;) {
    // 63 bits: Loro reserves the top of the range.
    const peer = randomBytes(8).readBigUInt64LE() >> 1n;
    if (peer > 0n && !version.has(String(peer))) return peer;
  }
}

/** The container at a path of keys from the document's `root`, or nothing if any step is not a container. */
function containerAt(doc: LoroDoc, path: readonly LoroKey[]): Container | undefined {
  let at: Container = doc.getMap("root");
  for (const key of path) {
    const next: unknown =
      at instanceof LoroMap ? at.get(String(key)) : at instanceof LoroMovableList || at instanceof LoroList ? at.get(Number(key)) : undefined;
    if (!isContainer(next)) return undefined;
    at = next;
  }
  return at;
}

/**
 * Make the edit on the Loro document itself. Only values are set, in maps
 * that are already there: no container is ever created, which ProPresenter's
 * own messages say a writer must never do under a key that holds one.
 */
function editDocument(doc: LoroDoc, boxes: readonly BoxEdit[]): void {
  for (const box of boxes) {
    const text = containerAt(doc, box.path);
    if (!(text instanceof LoroMap)) throw new FixError("lossy");
    text.set("rtf_data", box.rtf);
    for (const { index, start, end } of box.ranges) {
      const attribute = containerAt(doc, [...box.path, "attributes", "custom_attributes", index]);
      const range = attribute instanceof LoroMap ? attribute.get("range") : undefined;
      // A plain value, as ProPresenter keeps a range: replaced, never a container written into.
      if (!(attribute instanceof LoroMap) || !isObject(range) || isContainer(range)) throw new FixError("lossy");
      attribute.set("range", { ...range, start, end });
    }
  }
}

/** The new snapshot, decoded afresh, is exactly the plan; throws `WriteFailed` if not. */
function checkSnapshot(item: Ready, snapshot: Uint8Array, peer: bigint): Uint8Array {
  const doc = new LoroDoc();
  try {
    doc.import(snapshot);
    const version = doc.version().toJSON();
    if (!onlyPeerAdded(item.version, version, String(peer))) throw new WriteFailed("verifyFailed", "version vector");
    checkWorkspaceEdit(item.root, (doc.toJSON() as { root?: unknown }).root, item.edit, item.replacement.fixes);
    return encodeVersionVector(version);
  } catch (e) {
    throw failure(e);
  } finally {
    doc.free();
  }
}

/** Edit one document and replace its row, then read the row back. Returns the new snapshot. */
function writeOne(db: Database, item: Ready, hooks: WriteHooks | undefined): Uint8Array {
  const doc = new LoroDoc();
  let snapshot: Uint8Array;
  const peer = newPeer(item.version);
  try {
    doc.import(item.row.snapshot);
    doc.setPeerId(peer);
    // As ProPresenter's own changes carry one.
    doc.setRecordTimestamp(true);
    editDocument(doc, item.edit.boxes);
    doc.commit({ message: "Presenter Garage: slide text" });
    snapshot = doc.export({ mode: "snapshot" });
  } catch (e) {
    throw failure(e);
  } finally {
    doc.free();
  }

  const versionVector = checkSnapshot(item, snapshot, peer);
  const digest = Buffer.from(sha256(snapshot), "hex");
  const { documentId } = item.replacement;
  const changed = db
    .prepare(
      "UPDATE workspace_streams SET snapshot = ?, sha256 = ?, byte_count = ?, version_vector = ?, updated_at_ms = ? " +
        "WHERE document_id = ? AND scope = 0 AND sha256 = ?"
    )
    .run(snapshot, digest, snapshot.length, versionVector, Date.now(), documentId, item.row.sha256).changes;
  if (Number(changed) !== 1) throw new WriteFailed("stale");
  hooks?.afterUpdate?.(db, documentId);

  // Read back on the same connection, before anything is committed.
  const back = db.prepare(SELECT_ROW).get(documentId) as Row | undefined;
  const asWritten =
    back &&
    same(back.snapshot, snapshot) &&
    same(back.sha256, digest) &&
    Number(back.byte_count) === snapshot.length &&
    same(back.version_vector, versionVector);
  if (!asWritten) throw new WriteFailed("readBackFailed");
  // And checked again as the row now holds it, as guard 4 says, though the
  // bytes are the ones just checked: cheap beside the cost of being wrong.
  checkSnapshot(item, back.snapshot, peer);
  return snapshot;
}

/**
 * Every written row, from a fresh read-only connection: what was committed is
 * what was checked. One that is not is reported, and its backup has the row
 * as it was; nothing is put back without a person choosing it.
 */
async function readBack(
  store: string,
  written: readonly { item: Ready; snapshot: Uint8Array }[],
  outcomes: WorkspaceOutcome[]
): Promise<void> {
  if (written.length === 0) return;
  let db: Database | undefined;
  try {
    db = await openDatabase(store);
    for (const { item, snapshot } of written) {
      const row = db.prepare(SELECT_ROW).get(item.replacement.documentId) as Row | undefined;
      if (!row || !same(row.snapshot, snapshot) || hex(row.sha256) !== sha256(snapshot)) outcomes[item.index].reason = "readBackFailed";
    }
  } catch (e) {
    for (const { item } of written) Object.assign(outcomes[item.index], { reason: "readBackFailed", detail: errorDetail(e) });
  } finally {
    db?.close();
  }
}
