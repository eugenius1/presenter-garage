// Kept whole: one job, a ProPresenter 22 workspace read as the folder of files
// it replaced. Finding the store, giving each document its old path and
// converting it back are steps of that one read, and nothing else uses them.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LoroDoc } from "loro-crdt/base64";
import {
  groupsFromWorkspace,
  macrosFromWorkspace,
  playlistDocumentFromWorkspace,
  presentationFromWorkspace,
  themeFromWorkspace,
  type Converted,
} from "@presenter-garage/core/lib/workspace";
import { isInside, LibraryError, type FoundFile, type FoundTheme } from "./paths";

/**
 * A ProPresenter 22 workspace on disk, read as though it were the folder of
 * files it replaced.
 *
 * From version 22 a workspace has no `.pro` files and no `Playlists/Library`:
 * every document is a row of `DocumentStore/workspace-v1.sqlite3`, holding a
 * Loro CRDT snapshot. docs/propresenter-22-workspaces.md has the layout.
 *
 * Rather than teach every tool a second way to read, each document is given
 * the path its file had in the old layout -- `Libraries/<library>/<name>.pro`,
 * `Playlists/Media`, `Themes/<name>/Theme`, `Configuration/Groups` -- and read
 * by converting its snapshot back into the bytes that file would have held. The paths are the
 * ones ProPresenter's own playlists still record for their entries, so a
 * playlist's entry opens the presentation it names with nothing translated.
 * No such file exists; `library.ts` asks here before it asks the disk.
 *
 * Read-only, and not only by omission: nothing here opens the database for
 * writing, and `write.ts` refuses a path inside a workspace outright. The
 * bytes handed out are a conversion, so writing them anywhere would not be
 * writing the document back; slide text is written into the document itself,
 * by `workspace-write.ts` alone. ProPresenter keeps the database open while it
 * runs; a read-only connection in WAL mode reads beside it without blocking.
 */

const STORE = path.join("DocumentStore", "workspace-v1.sqlite3");
export const REGISTRY = "registry-v1.sqlite3";

/** What the database holds for one document, without its snapshot. */
export interface StoredDocument {
  /** Absolute, in the old layout. Not a file on disk. */
  path: string;
  kind: string;
  id: Uint8Array;
  /** Of the snapshot; what a conversion is cached under. */
  sha256: string;
  /** Of the snapshot as stored. The file it stands for would be another size, known only by making it. */
  size: number;
  modified: Date;
  /** False for a document of a Cloud workspace that has not been downloaded to this computer. */
  available: boolean;
}

/**
 * One change in a document's history.
 *
 * The upgrade's own changes are told apart from a person's by what they
 * carry: the import is stamped with no time at all (peer 1, timestamp 0),
 * and ProPresenter's later migrations each name themselves in a message
 * ("ProCore media identity migration"), where an edit made in the editor has
 * a time and no message. Seen across all 1,227 presentations of a real Cloud
 * workspace.
 */
export interface DocumentChange {
  peer: string;
  at?: Date;
  message?: string;
}

/** Whether a change is one a person made in ProPresenter, rather than the upgrade's own. */
export const isEdit = (change: DocumentChange): boolean => change.at !== undefined && change.message === undefined;

/**
 * One spelling for a path however it was composed, cased or separated. The
 * database's own key is lower-case too, and a playlist written on Windows
 * records its entries with backslashes wherever it is read.
 */
const keyOf = (p: string) => p.normalize("NFC").toLowerCase().replaceAll("\\", "/");

/**
 * How much converted content a workspace keeps to hand. Enough for the whole
 * of a large library, whose conversions come to a third or so of its
 * snapshots, so a second search does not convert it again; a stop for one
 * that would otherwise sit in an idle server's memory without limit.
 */
const MAX_CONVERTED_BYTES = 128 * 1024 * 1024;

const FIXED_PATHS: Record<string, string> = {
  PlaylistLibrary: path.join("Playlists", "Library"),
  PlaylistMedia: path.join("Playlists", "Media"),
  PlaylistAudio: path.join("Playlists", "Audio"),
  Groups: path.join("Configuration", "Groups"),
  Macros: path.join("Configuration", "Macros"),
};

/**
 * Where a document's file was in the old layout, or nothing for a kind no
 * tool reads.
 *
 * Nothing, too, for a path that is not plainly a name inside a folder. The
 * path is a string out of a database, and one reading `../../private/Secret`
 * would otherwise be handed out as a file beside the workspace: a listing
 * would name it, nothing in the workspace would answer to it, and the read
 * would fall through to whatever is on disk there.
 */
function legacyPath(kind: string, corePath: string | null): string | undefined {
  if (FIXED_PATHS[kind]) return FIXED_PATHS[kind];
  if (!corePath) return undefined;
  const segments = corePath.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.includes("\\") || s.includes("\0"))) return undefined;
  if (kind === "Presentation") return `${path.join("Libraries", ...segments)}.pro`;
  if (kind === "Theme") return path.join("Themes", ...segments);
  return undefined;
}

const CONVERT: Record<string, (root: unknown) => Converted> = {
  Presentation: presentationFromWorkspace,
  Theme: themeFromWorkspace,
  PlaylistLibrary: playlistDocumentFromWorkspace,
  PlaylistMedia: playlistDocumentFromWorkspace,
  PlaylistAudio: playlistDocumentFromWorkspace,
  Groups: groupsFromWorkspace,
  Macros: macrosFromWorkspace,
};

type Database = import("node:sqlite").DatabaseSync;

/**
 * Open a database for reading only.
 *
 * `node:sqlite` is loaded when first needed, not imported: it does not exist
 * before Node 22.5 and needs a flag until 22.13, which is the version asked
 * for, and a server started on an older Node must still read a folder of
 * `.pro` files.
 *
 * Read-only is not enough to leave the folder alone. The databases are in
 * WAL mode, and SQLite opening one read-only still creates the `-shm` and
 * `-wal` files beside it if they are not there, which on Windows they are
 * not once ProPresenter has quit: found by reading a copy and seeing two new
 * files in it. So with no write-ahead log the database is opened
 * `immutable`, which creates nothing and takes no lock, and is correct
 * because without a log the file is the whole database.
 *
 * With a log the database is not whole without it, so it has to be read:
 * ProPresenter is running, or is the macOS one, which leaves megabytes in
 * the log when it quits. An ordinary read-only connection reads beside it.
 * If nothing else has the database open that connection rebuilds the `-shm`
 * index, the one file this ever changes; it holds nothing of the workspace
 * and whatever opens the database next rebuilds it again.
 *
 * ProPresenter starting between the check and the open could give
 * an immutable reader a page mid-change; that surfaces as an error or is put
 * right by the next read, since the list is refreshed when the log appears.
 */
export async function openDatabase(file: string): Promise<Database> {
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = await import("node:sqlite");
  } catch {
    throw new LibraryError(
      `Reading a ProPresenter 22 workspace needs Node 22.13 or later; this is ${process.version}.`
    );
  }
  try {
    if (await fs.stat(`${file}-wal`).catch(() => undefined)) return new sqlite.DatabaseSync(file, { readOnly: true });
    const url = pathToFileURL(file);
    url.searchParams.set("immutable", "1");
    try {
      return new sqlite.DatabaseSync(url, { readOnly: true });
    } catch {
      // Node takes a URL here only from 22.15. Before that the choice is
      // between leaving two empty files beside the database and not reading
      // the workspace at all, and a library that will not open helps nobody.
      return new sqlite.DatabaseSync(file, { readOnly: true });
    }
  } catch (e) {
    throw new LibraryError(`Could not open ${file}: ${(e as Error).message}`);
  }
}

async function withDatabase<T>(file: string, fn: (db: Database) => T): Promise<T> {
  const db = await openDatabase(file);
  try {
    return fn(db);
  } catch (e) {
    if (e instanceof LibraryError) throw e;
    throw new LibraryError(`Could not read ${file}: ${(e as Error).message}`);
  } finally {
    db.close();
  }
}

/** When the database last changed: its own file, or the write-ahead log ProPresenter appends to first. */
async function stampOf(store: string): Promise<string> {
  const stats = await Promise.all([store, `${store}-wal`].map((f) => fs.stat(f).catch(() => undefined)));
  return stats.map((s) => (s ? `${s.mtimeMs}:${s.size}` : "-")).join("|");
}

export class Workspace {
  private documents = new Map<string, StoredDocument>();
  private folders = new Set<string>();
  private stamp = "";
  private refreshing: Promise<void> | undefined;
  /**
   * Converted bytes by snapshot hash, least recently read first, so a search
   * does not convert a document twice. Bounded by `MAX_CONVERTED_BYTES`.
   */
  private converted = new Map<string, Uint8Array>();
  private convertedBytes = 0;

  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** The document database. */
  get store(): string {
    return path.join(this.root, STORE);
  }

  /**
   * Read from the document database, having checked it is the workspace's own.
   *
   * A root is the limit of what may be read, and a `DocumentStore` that is a
   * symlink would make another workspace's songs appear under this root's
   * paths. SQLite opens by path and hands back nothing to check afterwards,
   * as `readFoundFile` checks its handle, so the path is checked on both
   * sides of the read: what is left is a link swapped in and out again
   * around each of those calls.
   */
  private async withStore<T>(fn: (db: Database) => T): Promise<T> {
    const refuse = async () => {
      if (!(await isOwnPath(this.store))) {
        throw new LibraryError(`Could not read ${this.store}: it is reached through a symlink`);
      }
    };
    await refuse();
    const result = await withDatabase(this.store, fn);
    await refuse();
    return result;
  }

  /**
   * Read the list of documents again if the database changed since it was
   * last read. ProPresenter saves as it goes, and a server that listed the
   * library once at start-up would answer from this morning's.
   *
   * Callers arriving while one read is under way share it: a listing asks
   * about two hundred documents at once, and each would otherwise find the
   * list out of date and read it again.
   */
  private refresh(): Promise<void> {
    this.refreshing ??= this.readList().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async readList(): Promise<void> {
    const stamp = await stampOf(this.store);
    if (stamp === this.stamp) return;
    const rows = await this.withStore((db) =>
      db
        .prepare(
          "SELECT document_id, kind, core_path, sha256, byte_count, availability, updated_at_ms " +
            "FROM workspace_streams WHERE scope = 0"
        )
        .all()
    );
    const documents = new Map<string, StoredDocument>();
    const folders = new Set<string>([keyOf(this.root)]);
    for (const row of rows) {
      const relative = legacyPath(String(row.kind), row.core_path as string | null);
      if (!relative) continue;
      const full = path.join(this.root, relative);
      // Held to the root here as well, whatever the check above let through.
      if (!isInside(this.root, full) || full === this.root) continue;
      documents.set(keyOf(full), {
        path: full,
        kind: String(row.kind),
        id: row.document_id as Uint8Array,
        sha256: hex(row.sha256),
        size: Number(row.byte_count),
        modified: new Date(Number(row.updated_at_ms)),
        available: Number(row.availability) === 0,
      });
      for (let dir = path.dirname(full); isInside(this.root, dir) && dir !== this.root; dir = path.dirname(dir)) {
        folders.add(keyOf(dir));
      }
    }
    this.documents = documents;
    this.folders = folders;
    this.stamp = stamp;
  }

  /** The document whose old-layout path this is, if there is one. */
  async find(file: string): Promise<StoredDocument | undefined> {
    await this.refresh();
    return this.documents.get(keyOf(file));
  }

  /** Whether documents sit under this folder of the old layout. */
  async hasFolder(dir: string): Promise<boolean> {
    await this.refresh();
    return this.folders.has(keyOf(dir));
  }

  /** The old-layout paths of every document of a kind at or under `dir`, in a stable order. */
  async list(kind: string, dir: string = this.root): Promise<string[]> {
    await this.refresh();
    // Compared as keys, as the folder was when it was resolved: it arrives in
    // whatever case and accent composition the caller typed.
    const under = `${keyOf(dir)}/`;
    const all = keyOf(dir) === keyOf(this.root);
    return [...this.documents.values()]
      .filter((d) => d.kind === kind && (all || keyOf(d.path).startsWith(under)))
      .map((d) => d.path)
      .sort((a, b) => a.localeCompare(b));
  }

  async themes(): Promise<FoundTheme[]> {
    // `Themes/<name>/Theme`, where a name can itself hold folders.
    return (await this.list("Theme")).map((file) => ({
      name: path.relative(path.join(this.root, "Themes"), path.dirname(file)).split(path.sep).join("/"),
      file,
    }));
  }

  /**
   * A document's size and date without reading it. The size is the stored
   * snapshot's: a listing of two hundred songs must not convert two hundred
   * songs to say how big each is. One not downloaded yet has no size but is
   * still a song the workspace holds, so it is listed, and reading it says
   * why it cannot be read.
   */
  stat(document: StoredDocument): { size: number; modified: Date } {
    return { size: document.size, modified: document.modified };
  }

  /**
   * The bytes the document's file would have held in the old layout.
   *
   * Cached under the hash stored beside the snapshot that was converted, not
   * the one the list was read with, so a document ProPresenter saved in
   * between is never kept under the hash of its earlier self.
   */
  async read(document: StoredDocument): Promise<FoundFile> {
    const file = document.path;
    if (!document.available) {
      throw new LibraryError(`${file}: not downloaded to this computer yet. Open the workspace in ProPresenter to sync it.`);
    }
    let bytes = document.sha256 ? this.recall(document.sha256) : undefined;
    let digest = document.sha256;
    if (!bytes) {
      const row = await this.withStore((db) =>
        db.prepare("SELECT snapshot, sha256 FROM workspace_streams WHERE document_id = ? AND scope = 0").get(document.id)
      );
      if (!row?.snapshot) throw new LibraryError(`Could not read ${file}: it is no longer in the workspace`);
      const sha = hex(row.sha256);
      // ProPresenter may have saved since `document` was looked up: these bytes are this row's.
      digest = sha;
      // A snapshot stored with no hash has nothing to be remembered under:
      // one entry would answer for every such document.
      const convert = () => convertSnapshot(document.kind, row.snapshot as Uint8Array, file);
      bytes = sha ? (this.recall(sha) ?? this.remember(sha, convert())) : convert();
    }
    return { bytes, size: bytes.length, modified: document.modified, converted: true, sha256: digest };
  }

  /**
   * The document as `read` gives it, with its change history: who changed
   * it and when, oldest first. Both come from one read of the snapshot, so
   * the history is that of the very song converted, not of one ProPresenter
   * saved in between.
   *
   * ProPresenter 22 keeps no edit date of its own, and the presentation it
   * converted from carries none either, so this is the only record of when a
   * song was last edited after the upgrade. Each Loro change carries the
   * peer that made it, one per computer and run, and a timestamp in seconds.
   */
  async readWithHistory(document: StoredDocument): Promise<FoundFile & { history: DocumentChange[] }> {
    const file = document.path;
    if (!document.available) {
      throw new LibraryError(`${file}: not downloaded to this computer yet. Open the workspace in ProPresenter to sync it.`);
    }
    const row = await this.withStore((db) =>
      db.prepare("SELECT snapshot, sha256 FROM workspace_streams WHERE document_id = ? AND scope = 0").get(document.id)
    );
    if (!row?.snapshot) throw new LibraryError(`Could not read ${file}: it is no longer in the workspace`);
    const snapshot = row.snapshot as Uint8Array;
    const sha = hex(row.sha256);
    const convert = () => convertSnapshot(document.kind, snapshot, file);
    const bytes = sha ? (this.recall(sha) ?? this.remember(sha, convert())) : convert();
    return { bytes, size: bytes.length, modified: document.modified, converted: true, sha256: sha, history: historyOf(snapshot, file) };
  }

  private recall(sha: string): Uint8Array | undefined {
    const bytes = this.converted.get(sha);
    if (bytes) {
      // Moved to the end, where the most recently read are.
      this.converted.delete(sha);
      this.converted.set(sha, bytes);
    }
    return bytes;
  }

  private remember(sha: string, bytes: Uint8Array): Uint8Array {
    this.converted.set(sha, bytes);
    this.convertedBytes += bytes.length;
    for (const [oldest, held] of this.converted) {
      if (this.convertedBytes <= MAX_CONVERTED_BYTES || oldest === sha) break;
      this.converted.delete(oldest);
      this.convertedBytes -= held.length;
    }
    return bytes;
  }
}

/** Whether a path is its own real path: no part of it, the last included, is a symlink. */
export const isOwnPath = async (p: string) => (await fs.realpath(p).catch(() => undefined)) === p;

export const hex = (bytes: unknown) => (bytes ? Buffer.from(bytes as Uint8Array).toString("hex") : "");

/** A snapshot, as the bytes of the old file of that kind. */
function convertSnapshot(kind: string, snapshot: Uint8Array, file: string): Uint8Array {
  const doc = new LoroDoc();
  try {
    doc.import(snapshot);
    const { message } = CONVERT[kind]((doc.toJSON() as { root?: unknown }).root);
    return message.$type.encode(message).finish();
  } catch (e) {
    throw new LibraryError(`Could not read ${file}: ${(e as Error).message}`);
  } finally {
    doc.free();
  }
}

const workspaces = new Map<string, Promise<Workspace | undefined>>();

/**
 * The workspace at a folder, if it is one: a folder holding the document
 * database. `root` must already be a real path. Answered once per folder; a
 * folder does not become a workspace while the server runs.
 */
export function workspaceAt(root: string): Promise<Workspace | undefined> {
  let found = workspaces.get(root);
  if (!found) {
    const store = path.join(root, STORE);
    // Not a workspace if its database is reached through a link: see `withStore`.
    found = Promise.all([fs.stat(store), isOwnPath(store)])
      .then(([stat, own]) => (stat.isFile() && own ? new Workspace(root) : undefined))
      .catch(() => undefined);
    workspaces.set(root, found);
  }
  return found;
}

/**
 * The workspaces directly inside a folder: what `Workspaces` itself holds.
 * That folder is the one ProPresenter's own paths and this project's README
 * name, and one level above anything that can be read.
 */
export async function workspacesIn(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(dir, entry.name);
    if ((await fs.stat(path.join(folder, STORE)).catch(() => undefined))?.isFile()) found.push(folder);
  }
  return found.sort((a, b) => a.localeCompare(b));
}

/**
 * The workspace a path is inside, among the folders already recognised as
 * one. A path can only have come from a listing or a lookup that started at
 * a root, and those are what recognise a workspace.
 */
export async function workspaceOf(p: string): Promise<Workspace | undefined> {
  for (const [root, found] of workspaces) {
    if (isInside(root, p)) {
      const workspace = await found;
      if (workspace) return workspace;
    }
  }
  return undefined;
}

/** The document a path names in the workspace it is inside, with that workspace, if there is one. */
export async function documentAt(p: string): Promise<{ workspace: Workspace; document: StoredDocument } | undefined> {
  const workspace = await workspaceOf(p);
  const document = await workspace?.find(p);
  return workspace && document ? { workspace, document } : undefined;
}

/**
 * Said where a file write is refused inside a workspace, so the person is
 * told what to do rather than only that it did not happen.
 */
export const WORKSPACE_READ_ONLY =
  "This is a ProPresenter 22 workspace, which has no files to write: its documents live in a database. " +
  "Only slide text can be changed in it, with plan_slide_edits and apply_slide_edits; " +
  "make any other change in ProPresenter itself.";

/**
 * Whether a workspace's folder carries ProPresenter Cloud's marker. The
 * registry says so too, as `cloud_uuid`; this is the half that needs no
 * registry, asked by whatever decides whether a workspace can be written.
 */
export const hasCloudImprint = (root: string) =>
  fs.stat(path.join(root, "imprint.cloud")).then(
    () => true,
    () => false
  );

/** Whether a path is inside a ProPresenter 22 workspace, and so is not a file that can be written. */
export async function isInWorkspace(p: string): Promise<boolean> {
  return (await workspaceOf(p)) !== undefined;
}

export interface RegisteredWorkspace {
  root: string;
  name: string;
  /** The one ProPresenter opens. */
  active: boolean;
  /** Synced through ProPresenter Cloud, as opposed to kept on this computer alone. */
  cloud: boolean;
  /** The format's own version, e.g. `22.9.0`, not the application's. */
  schemaVersion: string;
  /** The folder of files this workspace was made from when ProPresenter 22 first ran, which it no longer reads. */
  copiedFrom?: string;
}

/**
 * Where ProPresenter 22 keeps its workspaces and the registry of them.
 *
 * Seen on both: `~/Library/Application Support` on macOS and `%APPDATA%`
 * (`AppData\Roaming`) on Windows, then `RenewedVision/ProPresenter/Workspaces`.
 */
export function workspacesDir(): string {
  return path.join(supportDir(), "Workspaces");
}

/** ProPresenter's own folder under the user's application support. */
function supportDir(): string {
  const support =
    process.platform === "win32"
      ? (process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"))
      : path.join(os.homedir(), "Library", "Application Support");
  return path.join(support, "RenewedVision", "ProPresenter");
}

/**
 * Where ProPresenter 20 and 21 make a new workspace: a folder of the same
 * files as ever, no longer in Documents. Named differently on each system,
 * by Renewed Vision's own note on the move.
 */
export function folderWorkspacesDir(): string {
  return path.join(supportDir(), process.platform === "win32" ? "LocalWorkspaces" : "UserWorkspaces");
}

/**
 * The workspaces ProPresenter 20 or 21 made, each a folder in the old
 * layout. Told from anything else kept there by holding `Libraries` or
 * `Playlists`. Which one ProPresenter has open is recorded only in its
 * preferences -- a property list on macOS, `PathSettings.proPaths` beside
 * this folder on Windows -- and is not read here.
 */
export async function folderWorkspaces(dir: string = folderWorkspacesDir()): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const folder = path.join(dir, entry.name);
    const holds = await Promise.all(
      ["Libraries", "Playlists"].map((name) => fs.stat(path.join(folder, name)).then((s) => s.isDirectory(), () => false))
    );
    if (holds.some(Boolean)) found.push(folder);
  }
  return found.sort((a, b) => a.localeCompare(b));
}

/**
 * What to say about each root that is a folder ProPresenter 22 made a
 * workspace from, unless that workspace is being read too.
 *
 * The upgrade copies the folder and never touches it again, so it goes on
 * reading perfectly as the library of the day of the upgrade. Nothing in the
 * folder says so; only the registry does.
 */
export function staleNotes(roots: readonly string[], registered: readonly RegisteredWorkspace[]): string[] {
  // A root is read as the ProPresenter folder and as the folder above it.
  const read = new Set(roots.flatMap((root) => [root, path.join(root, "ProPresenter")]));
  return registered
    .filter((w) => w.copiedFrom && read.has(path.resolve(w.copiedFrom)) && !roots.includes(w.root))
    .map(
      (w) =>
        `${w.copiedFrom} is the folder ProPresenter 22 made the workspace "${w.name}" from. ` +
        `ProPresenter no longer reads or updates it, so it shows the library as it was before the upgrade. ` +
        `The current one is ${w.root}.`
    );
}

/**
 * The library to read when none was named, most certain first.
 *
 * The workspace ProPresenter 22 has open, since its registry says so. Then
 * `Documents/ProPresenter`, where every version before 20 keeps its only
 * library and later ones keep the first. Then a workspace ProPresenter 20 or
 * 21 made elsewhere, but only when there is one: with several there is no
 * telling which is in use, and reading the wrong church's songs without a
 * word is worse than asking, so that is an error naming them.
 *
 * `documents` comes back even when it does not exist, so the caller's own
 * "folder not found" names the place a person would expect.
 */
export function defaultLibrary(found: {
  registered: readonly RegisteredWorkspace[];
  documents: string;
  documentsExists: boolean;
  folders: readonly string[];
}): string {
  const active = found.registered.find((w) => w.active);
  if (active) return active.root;
  if (found.documentsExists || found.folders.length === 0) return found.documents;
  if (found.folders.length === 1) return found.folders[0];
  throw new LibraryError(
    `ProPresenter has ${found.folders.length} workspaces and no folder was named. Pass the one to read: ${found.folders.join(", ")}`
  );
}

/**
 * The workspaces ProPresenter 22 knows of on this computer, the active one
 * first. Empty where there is no registry: before version 22, or on a
 * computer ProPresenter has never run on. Empty too when it cannot be read,
 * since this is only ever asked to choose a default or word a warning.
 */
export async function registeredWorkspaces(dir: string = workspacesDir()): Promise<RegisteredWorkspace[]> {
  const registry = path.join(dir, REGISTRY);
  if (!(await fs.stat(registry).catch(() => undefined))?.isFile()) return [];
  try {
    return await withDatabase(registry, (db) => {
      const meta = new Map(
        db
          .prepare("SELECT key, value FROM meta")
          .all()
          .map((row) => [String(row.key), String(row.value)])
      );
      return db
        .prepare("SELECT local_uuid, root_path, display_name, cloud_uuid, schema_version FROM workspaces")
        .all()
        .map((row) => ({
          root: String(row.root_path),
          name: String(row.display_name),
          active: meta.get("active_local_uuid") === row.local_uuid,
          cloud: row.cloud_uuid !== null,
          schemaVersion: String(row.schema_version),
          copiedFrom: meta.get(`copied_from:${String(row.local_uuid)}`),
        }))
        .sort((a, b) => Number(b.active) - Number(a.active));
    });
  } catch {
    return [];
  }
}

/** Every change a snapshot records, oldest first. */
function historyOf(snapshot: Uint8Array, file: string): DocumentChange[] {
  const doc = new LoroDoc();
  try {
    doc.import(snapshot);
    const changes: DocumentChange[] = [];
    for (const [peer, list] of doc.getAllChanges()) {
      for (const change of list) {
        changes.push({
          peer,
          at: change.timestamp ? new Date(change.timestamp * 1000) : undefined,
          message: change.message || undefined,
        });
      }
    }
    return changes.sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
  } catch (e) {
    throw new LibraryError(`Could not read ${file}: ${(e as Error).message}`);
  } finally {
    doc.free();
  }
}
