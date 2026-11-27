// Kept whole: one transaction. Every step of a workspace write runs inside the
// same exclusive lock, in the order AGENTS.md's guards need; split, the
// lock's start and its end would sit in different files.

import { randomBytes } from "node:crypto";
import { isContainer, LoroDoc, LoroList, LoroMap, LoroMovableList, LoroTree, type Container, type TreeID } from "loro-crdt/base64";
import { createI18n } from "@presenter-garage/core/i18n/core";
import { FixError, type FixRefusal, type LineFix } from "@presenter-garage/core/lib/fixes";
import type { StructureChange } from "@presenter-garage/core/lib/structure";
import { encodePresentation } from "@presenter-garage/core/lib/presentation";
import { isObject, presentationFromWorkspace } from "@presenter-garage/core/lib/workspace";
import { AttributeRangeError } from "@presenter-garage/core/lib/ranges";
import {
  checkWorkspaceEdit,
  coversVersion,
  decodeVersionVector,
  encodeVersionVector,
  onlyPeerAdded,
  planWorkspaceEdit,
  stableJson,
  type LoroKey,
  type WorkspaceEdit,
} from "@presenter-garage/core/lib/workspace-edit";
import { LibraryError, LossyFile, WorkspaceRefused } from "./paths";
import { backupPath, errorDetail, runFolder, same, sha256, writeBackups, type WriteOutcome } from "./write";
import { hex, isOwnPath, openDatabase, type StoredDocument, type Workspace } from "./workspace";
import { checkWritableWorkspace, unverified, VERIFIED_USER_VERSION } from "./workspace-check";

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

const refusals = createI18n("en").t.tools.presentations.refusals;

export const PROPRESENTER_OPEN =
  "ProPresenter has this workspace open, so nothing in it was written: a change made under it is lost the next " +
  "time it saves the presentation. Quit ProPresenter, then plan and apply the edits again.";

// The workspace-level half of guard 1 is `workspace-check.ts`.
export { checkWritableWorkspace, VERIFIED_SCHEMA_VERSION } from "./workspace-check";

/** A row of `workspace_streams`, as the write path reads it. */
interface Row {
  snapshot: Uint8Array;
  sha256: Uint8Array;
  version_vector: Uint8Array;
  last_shared_version_vector: Uint8Array | null;
  /** Named as ProPresenter names it: docs/propresenter-22-workspaces.md lists every column. */
  last_shared_version_vector_absence_reason: number | null;
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

/**
 * Guard 1 for a document of a ProPresenter Cloud workspace: Cloud has
 * confirmed every change in it. Its `last_shared_version_vector` is what
 * was last sent and acknowledged, and lags the version vector while a
 * change is still to go up -- seen with sync paused, where a local edit
 * leaves it behind until sync resumes. Written over then, the change not
 * yet sent would be folded into ours and sent as one, so it is refused, as
 * a row with no shared vector or with a reason it has none is. Throws
 * `FixError("unsynced")`.
 */
export function syncedWithCloud(row: Row, version: ReadonlyMap<string, number>): void {
  const shared = row.last_shared_version_vector;
  const decoded = ArrayBuffer.isView(shared) ? decodeVersionVector(shared as Uint8Array) : undefined;
  if (row.last_shared_version_vector_absence_reason !== null || !decoded || !coversVersion(decoded, version)) throw new FixError("unsynced");
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
): Promise<{ bytes: Uint8Array; sha256: string; root: unknown; snapshot: Uint8Array; cloud: boolean }> {
  const { cloud } = await checkWritableWorkspace(workspace);
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
  // And again once read, as `Workspace.withStore` does: SQLite opens by path
  // and gives nothing back to check, so a store swapped for a link in between
  // is caught on this side.
  if (!(await isOwnPath(workspace.store))) {
    throw new LibraryError(`Could not read ${workspace.store}: it is reached through a symlink`);
  }
  if (!row?.snapshot) throw new LibraryError(`Could not read ${document.path}: it is no longer in the workspace`);
  let root, version;
  try {
    ({ root, version } = gate(row));
  } catch {
    throw new LossyFile(
      `${document.path}: this document does not come back exactly as it was through a read and a rewrite, ` +
        "so it is not written to. Nothing was planned."
    );
  }
  if (cloud) {
    try {
      syncedWithCloud(row, version);
    } catch {
      throw new LibraryError(`${document.path}: ${refusals.unsynced}. Nothing was planned.`);
    }
  }
  const { message } = presentationFromWorkspace(root);
  return { bytes: encodePresentation(message), sha256: hex(row.sha256), root, snapshot: row.snapshot, cloud };
}

/** Refuse a document store of a version this has not been checked against. */
function checkStoreVersion(db: Database): void {
  const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (version !== VERIFIED_USER_VERSION) {
    throw new WorkspaceRefused(unverified(`document store is version ${version}, not ${VERIFIED_USER_VERSION}`), "unverifiedWorkspace");
  }
}

/**
 * Let the store go. Best effort: a close that fails after a COMMIT does not
 * undo it, and one that throws must not keep another workspace's store from
 * being let go after it.
 */
function closeQuietly(db: Database): void {
  try {
    db.close();
  } catch {
    // Nothing left to do with it.
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
  let db: Database | undefined;
  let locked = false;
  try {
    db = new DatabaseSync(store);
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("BEGIN IMMEDIATE");
    locked = true;
    checkStoreVersion(db);
    return db;
  } catch (e) {
    // Closed whatever went wrong, so a refused run never keeps the store
    // from ProPresenter; closing also ends the transaction, if one began.
    db?.close();
    if (e instanceof LibraryError) throw e;
    if (!locked && /locked|busy/i.test((e as Error).message)) throw new WorkspaceRefused(PROPRESENTER_OPEN, "propresenterOpen");
    throw new LibraryError(`Could not open ${store} for writing: ${(e as Error).message}`);
  }
}

/** One presentation to change: the document, the row it was planned against, and the changes chosen. */
export interface WorkspaceReplacement {
  /** The document's old-layout path, as the plan named it. */
  path: string;
  documentId: Uint8Array;
  /** Of the row the plan was made from. */
  sha256: string;
  fixes: LineFix[];
  /** The structural changes chosen: a group renamed, a macro swapped. */
  changes?: StructureChange[];
}

/** How many changes a presentation has chosen, lines and structure together. */
const chosen = (r: WorkspaceReplacement) => r.fixes.length + (r.changes?.length ?? 0);

/**
 * Why a presentation in a workspace was not written, beyond the refusals the
 * `.pro` path shares (`attributeRanges` among them: a box's character
 * ranges cannot be moved with its text, or a line added to it, without a
 * guess, as `moveRanges()` in core says):
 *
 * - `rolledBack`: this one was fine, but another in the same workspace was
 *   not, and a workspace's run is written whole or not at all.
 */
export type WorkspaceRefusal =
  | FixRefusal
  | "rolledBack"
  | "backupFailed"
  | "readBackFailed";

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
 * A workspace run taken and backed up, and not yet written: the store is
 * held exclusively, so the rows backed up are the rows `commit()` replaces.
 * Every way out ends in `commit()` or `release()`, or ProPresenter is kept
 * from its own store.
 */
export interface StagedWorkspaceWrite {
  /** The dated folder this run's backups are in, if it got that far. */
  readonly backupFolder?: string;
  /** One per replacement, in the order given; `commit()` fills in the rest. */
  readonly outcomes: WorkspaceOutcome[];
  /** Why the backups could not be made, when they could not; nothing is held then, and nothing will be written. */
  readonly backupFailed?: string;
  /** Whether there are rows backed up and waiting, with the store held. */
  readonly pending: boolean;
  /** Write every row waiting, in one transaction, then let the store go and read every row back. */
  commit(hooks?: WriteHooks): Promise<void>;
  /** Let the store go without writing, each row waiting refused for `reason` if one is given. Does nothing once settled. */
  abandon(reason?: WorkspaceRefusal, detail?: string): void;
}

/**
 * Take the store and back up every row about to change, writing nothing.
 *
 * `backupDir` must already be open (`openBackupDir`). A presentation refused
 * before the backup -- stale, failing the gate, ranges off its lines -- is
 * left out and the rest go ahead, as a `.pro` file refused would be. Throws,
 * holding nothing, when the workspace cannot be written at all: ProPresenter
 * has it open, or it is not a format this was checked against.
 *
 * Kept apart from the commit so a call that writes into more than one root
 * can make every backup before any root is written: AGENTS.md's second
 * guard is for the whole run, not for each workspace by itself.
 */
export async function stageWorkspaceEdits(
  workspace: Workspace,
  roots: readonly string[],
  backupDir: string,
  replacements: readonly WorkspaceReplacement[],
  { now = new Date() }: { now?: Date } = {}
): Promise<StagedWorkspaceWrite> {
  // A presentation with no change left ticked has nothing to write, and must
  // not make the run take the lock: with ProPresenter open, that would refuse
  // a call that was never going to change anything.
  const outcomes: WorkspaceOutcome[] = replacements.map((r) =>
    chosen(r) === 0 ? { path: r.path, written: false, reason: "unchanged" } : { path: r.path, written: false }
  );
  const nothing = (backupFolder?: string, backupFailed?: string): StagedWorkspaceWrite => ({
    backupFolder,
    outcomes,
    backupFailed,
    pending: false,
    commit: async () => undefined,
    abandon: () => undefined,
  });
  if (replacements.every((r) => chosen(r) === 0)) return nothing();

  const { cloud } = await checkWritableWorkspace(workspace);
  if (!(await isOwnPath(workspace.store))) {
    throw new LibraryError(`Could not open ${workspace.store}: it is reached through a symlink`);
  }
  const db = await lockStore(workspace.store);
  let held = true;
  /** Rolled back however the run ends short of a commit, and closed, which folds the write-ahead log into the database. */
  const release = (commit: boolean) => {
    if (!held) return;
    held = false;
    try {
      db.exec(commit ? "COMMIT" : "ROLLBACK");
    } catch (e) {
      // A failed ROLLBACK leaves nothing to undo, since nothing was
      // committed, and closing discards what was not. A failed COMMIT is
      // the caller's to hear about, once the store is let go.
      if (commit) {
        closeQuietly(db);
        throw e;
      }
    }
    closeQuietly(db);
  };

  let backupFolder: string | undefined;
  const ready: Ready[] = [];
  try {
    // Again now it is open: a store swapped for a link between the check
    // above and the open would have the run write somewhere else. What is
    // left is a link swapped in and out again around the open, the same
    // window `Workspace.withStore` leaves the read path.
    if (!(await isOwnPath(workspace.store))) {
      throw new LibraryError(`Could not open ${workspace.store}: it is reached through a symlink`);
    }
    for (const [index, replacement] of replacements.entries()) {
      if (chosen(replacement) === 0) continue;
      try {
        ready.push(prepare(db, index, replacement, cloud));
      } catch (e) {
        Object.assign(outcomes[index], refusalOf(e));
      }
    }
  } catch (e) {
    release(false);
    throw e;
  }
  if (ready.length === 0) {
    release(false);
    return nothing();
  }

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
    release(false);
    const detail = errorDetail(e);
    for (const { index } of ready) Object.assign(outcomes[index], { reason: "backupFailed", detail });
    return nothing(backupFolder, detail);
  }

  let settled = false;
  return {
    backupFolder,
    outcomes,
    get pending() {
      return !settled;
    },
    abandon(reason, detail) {
      if (settled) return;
      settled = true;
      release(false);
      if (reason) for (const { index } of ready) Object.assign(outcomes[index], { reason, detail });
    },
    async commit(hooks) {
      if (settled) return;
      settled = true;
      const written: { item: Ready; snapshot: Uint8Array }[] = [];
      let current: Ready | undefined;
      try {
        for (current of ready) written.push({ item: current, snapshot: writeOne(db, current, hooks) });
      } catch (e) {
        release(false);
        const { reason, detail } = failure(e);
        for (const { index } of ready) outcomes[index].reason = "rolledBack";
        Object.assign(outcomes[current!.index], { reason, detail });
        return;
      }
      release(true);
      for (const { index } of ready) outcomes[index].written = true;
      // Once more, from a connection of its own, as the next reader will see it.
      await readBack(workspace.store, written, outcomes);
    },
  };
}

/**
 * Write each presentation's chosen lines into the workspace, in one
 * transaction, or none of them: `stageWorkspaceEdits`, then `commit()`, for
 * a run in this one workspace. `applyPlan()` takes the two steps apart, to
 * back up every root of a call first.
 *
 * `backupDir` must already be open (`openBackupDir`). Past the backup, one
 * presentation that fails stops all of them.
 */
export async function writeWorkspaceEdits(
  workspace: Workspace,
  roots: readonly string[],
  backupDir: string,
  replacements: readonly WorkspaceReplacement[],
  { now = new Date(), signal, hooks }: { now?: Date; signal?: AbortSignal; hooks?: WriteHooks } = {}
): Promise<{ backupFolder?: string; outcomes: WorkspaceOutcome[] }> {
  const staged = await stageWorkspaceEdits(workspace, roots, backupDir, replacements, { now });
  const { backupFolder, outcomes } = staged;
  if (signal?.aborted && staged.pending) {
    staged.abandon();
    throw new LibraryError(
      `The call was cancelled before anything in this workspace changed, so nothing in it was written. Its backups are in ${backupFolder}.`
    );
  }
  await staged.commit(hooks);
  return { backupFolder, outcomes };
}

function refusalOf(e: unknown): Pick<WorkspaceOutcome, "reason" | "detail"> {
  if (e instanceof FixError) return { reason: e.reason };
  if (e instanceof AttributeRangeError) {
    const where = e.lineIndex === undefined ? `box ${e.boxIndex}` : `box ${e.boxIndex} line ${e.lineIndex}`;
    return { reason: "attributeRanges", detail: `${where}, ${e.reason}` };
  }
  return { reason: "unreadable", detail: (e as Error).message };
}

/**
 * The checks before anything is backed up: the row is the planned one, the
 * document passes the gate, Cloud has confirmed it if it is Cloud's, and it
 * takes the edit.
 */
function prepare(db: Database, index: number, replacement: WorkspaceReplacement, cloud: boolean): Ready {
  const row = db.prepare(SELECT_ROW).get(replacement.documentId) as Row | undefined;
  if (!row?.snapshot || row.kind !== "Presentation" || Number(row.availability) !== 0) throw new FixError("stale");
  if (hex(row.sha256) !== replacement.sha256) throw new FixError("stale");
  const { root, version } = gate(row);
  // Inside the lock, on the row about to be replaced: ProPresenter may have run since the plan.
  if (cloud) syncedWithCloud(row, version);
  const edit = planWorkspaceEdit(root, replacement.fixes, replacement.changes);
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

/**
 * The container at a path of keys from the document's `root`, or nothing if
 * any step is not a container. A tree node is reached by its id, and is its
 * own map, the one `toJSON()` calls `meta`.
 */
function containerAt(doc: LoroDoc, path: readonly LoroKey[]): Container | undefined {
  let at: Container = doc.getMap("root");
  for (const key of path) {
    let next: unknown;
    if (typeof key === "object") next = at instanceof LoroTree ? at.getNodeByID(key.node as TreeID)?.data : undefined;
    else if (at instanceof LoroMap) next = at.get(String(key));
    else if (at instanceof LoroMovableList || at instanceof LoroList) next = at.get(Number(key));
    if (!isContainer(next)) return undefined;
    at = next;
  }
  return at;
}

/**
 * Make the edit on the Loro document itself. Only values are set, in maps
 * that are already there, and no container is created. The rule found in
 * ProPresenter 22.0.1's ProCore library forbids creating one under a key that
 * already holds one (a log message found with `strings`; see "Edit" in
 * docs/propresenter-22-writing.md). Under a new key it is untried, so not done.
 * Nor is a value set over a container, which would take that container out.
 */
function editDocument(doc: LoroDoc, { boxes, values }: WorkspaceEdit): void {
  for (const { path, key, value } of values) {
    const map = containerAt(doc, path);
    if (!(map instanceof LoroMap) || isContainer(map.get(key))) throw new FixError("lossy");
    map.set(key, value);
  }
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

/**
 * Make an edit on a copy of a document in memory, as `writeOne` will, and
 * check the result as it will: for planning, so a document not shaped as
 * its JSON suggests -- a map that is not a container, a tree that is not a
 * tree -- is refused before anybody is asked rather than after. Writes
 * nothing. Throws `FixError` or `AttributeRangeError`.
 */
export function rehearseWorkspaceEdit(snapshot: Uint8Array, fixes: readonly LineFix[], changes: readonly StructureChange[]): void {
  const doc = new LoroDoc();
  const after = new LoroDoc();
  try {
    doc.import(snapshot);
    const root = (doc.toJSON() as { root?: unknown }).root;
    const edit = planWorkspaceEdit(root, fixes, changes);
    const version = doc.version().toJSON();
    const peer = newPeer(version);
    doc.setPeerId(peer);
    editDocument(doc, edit);
    doc.commit();
    after.import(doc.export({ mode: "snapshot" }));
    if (!onlyPeerAdded(version, after.version().toJSON(), String(peer))) throw new FixError("verifyFailed");
    checkWorkspaceEdit(root, (after.toJSON() as { root?: unknown }).root, edit, fixes);
  } finally {
    doc.free();
    after.free();
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
    editDocument(doc, item.edit);
    doc.commit({ message: "Presenter Garage: slide edits" });
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
