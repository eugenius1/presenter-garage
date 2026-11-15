import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LoroDoc } from "loro-crdt/base64";
import {
  playlistDocumentFromWorkspace,
  presentationFromWorkspace,
  themeFromWorkspace,
  type Converted,
} from "@presenter-garage/core/lib/workspace";
import { isInside, LibraryError, type FoundFile, type FoundTheme } from "./library";

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
 * `Playlists/Media`, `Themes/<name>/Theme` -- and read by converting its
 * snapshot back into the bytes that file would have held. The paths are the
 * ones ProPresenter's own playlists still record for their entries, so a
 * playlist's entry opens the presentation it names with nothing translated.
 * No such file exists; `library.ts` asks here before it asks the disk.
 *
 * Read-only, and not only by omission: nothing here opens the database for
 * writing, and `write.ts` refuses a path inside a workspace outright. The
 * bytes handed out are a conversion, so writing them anywhere would not be
 * writing the document back. ProPresenter keeps the database open while it
 * runs; a read-only connection in WAL mode reads beside it without blocking.
 */

const STORE = path.join("DocumentStore", "workspace-v1.sqlite3");
const REGISTRY = "registry-v1.sqlite3";

/** What the database holds for one document, without its snapshot. */
interface StoredDocument {
  /** Absolute, in the old layout. Not a file on disk. */
  path: string;
  kind: string;
  id: Uint8Array;
  /** Of the snapshot; what a conversion is cached under. */
  sha256: string;
  modified: Date;
  /** False for a document of a Cloud workspace that has not been downloaded to this computer. */
  available: boolean;
}

/**
 * One spelling for a path however it was composed, cased or separated. The
 * database's own key is lower-case too, and a playlist written on Windows
 * records its entries with backslashes wherever it is read.
 */
const keyOf = (p: string) => p.normalize("NFC").toLowerCase().replaceAll("\\", "/").replaceAll(path.sep, "/");

const FIXED_PATHS: Record<string, string> = {
  PlaylistLibrary: path.join("Playlists", "Library"),
  PlaylistMedia: path.join("Playlists", "Media"),
  PlaylistAudio: path.join("Playlists", "Audio"),
};

/** Where a document's file was in the old layout, or nothing for a kind no tool reads. */
function legacyPath(kind: string, corePath: string | null): string | undefined {
  if (FIXED_PATHS[kind]) return FIXED_PATHS[kind];
  if (!corePath) return undefined;
  const segments = corePath.split("/");
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
};

type Database = import("node:sqlite").DatabaseSync;

/**
 * Open a database for reading only.
 *
 * `node:sqlite` is loaded when first needed, not imported: it does not exist
 * before Node 22.5, and a server started on an older Node must still read a
 * folder of `.pro` files.
 *
 * Read-only is not enough to leave the folder alone. The databases are in
 * WAL mode, and SQLite opening one read-only still creates the `-shm` and
 * `-wal` files beside it if they are not there, which they are not whenever
 * ProPresenter is closed: found by reading a copy and seeing two new files
 * in it. So with no write-ahead log the database is opened `immutable`,
 * which creates nothing and takes no lock, and is correct because without a
 * log the file is the whole database. With a log, ProPresenter is running
 * and has made both files itself, and an ordinary read-only connection reads
 * beside it. ProPresenter starting between the check and the open could give
 * an immutable reader a page mid-change; that surfaces as an error or is put
 * right by the next read, since the list is refreshed when the log appears.
 */
async function openDatabase(file: string): Promise<Database> {
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
    return new sqlite.DatabaseSync(url, { readOnly: true });
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
  /** Converted bytes by snapshot hash, so a search does not convert a document twice. */
  private converted = new Map<string, Uint8Array>();

  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private get store(): string {
    return path.join(this.root, STORE);
  }

  /**
   * Read the list of documents again if the database changed since it was
   * last read. ProPresenter saves as it goes, and a server that listed the
   * library once at start-up would answer from this morning's.
   */
  private async refresh(): Promise<void> {
    const stamp = await stampOf(this.store);
    if (stamp === this.stamp) return;
    const rows = await withDatabase(this.store, (db) =>
      db
        .prepare(
          "SELECT document_id, kind, core_path, sha256, availability, updated_at_ms FROM workspace_streams WHERE scope = 0"
        )
        .all()
    );
    const documents = new Map<string, StoredDocument>();
    const folders = new Set<string>([keyOf(this.root)]);
    for (const row of rows) {
      const relative = legacyPath(String(row.kind), row.core_path as string | null);
      if (!relative) continue;
      const full = path.join(this.root, relative);
      documents.set(keyOf(full), {
        path: full,
        kind: String(row.kind),
        id: row.document_id as Uint8Array,
        sha256: row.sha256 ? Buffer.from(row.sha256 as Uint8Array).toString("hex") : "",
        modified: new Date(Number(row.updated_at_ms)),
        available: Number(row.availability) === 0,
      });
      for (let dir = path.dirname(full); isInside(this.root, dir) && dir !== this.root; dir = path.dirname(dir)) {
        folders.add(keyOf(dir));
      }
    }
    const current = new Set([...documents.values()].map((d) => d.sha256));
    for (const sha of this.converted.keys()) if (!current.has(sha)) this.converted.delete(sha);
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
    return [...this.documents.values()]
      .filter((d) => d.kind === kind && isInside(dir, d.path))
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

  async stat(file: string): Promise<{ size: number; modified: Date } | undefined> {
    const document = await this.find(file);
    if (!document?.available) return undefined;
    // The size of the file this stands for is only known by making it.
    return { size: (await this.read(document.path)).size, modified: document.modified };
  }

  /**
   * The bytes the document's file would have held in the old layout.
   *
   * The snapshot is checked against the hash the list was read with, so a
   * document ProPresenter saved in between is read again rather than cached
   * under the wrong hash.
   */
  async read(file: string): Promise<FoundFile> {
    const document = await this.find(file);
    if (!document) throw new LibraryError(`Not found in the workspace: ${file}`);
    if (!document.available) {
      throw new LibraryError(`${file}: not downloaded to this computer yet. Open the workspace in ProPresenter to sync it.`);
    }
    let bytes = this.converted.get(document.sha256);
    if (!bytes) {
      const row = await withDatabase(this.store, (db) =>
        db.prepare("SELECT snapshot FROM workspace_streams WHERE document_id = ? AND scope = 0").get(document.id)
      );
      if (!row?.snapshot) throw new LibraryError(`Could not read ${file}: it is no longer in the workspace`);
      bytes = convertSnapshot(document.kind, row.snapshot as Uint8Array, file);
      this.converted.set(document.sha256, bytes);
    }
    return { bytes, size: bytes.length, modified: document.modified };
  }
}

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
    found = fs
      .stat(path.join(root, STORE))
      .then((stat) => (stat.isFile() ? new Workspace(root) : undefined))
      .catch(() => undefined);
    workspaces.set(root, found);
  }
  return found;
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

/**
 * Said wherever a write is refused, so the person is told what to do rather
 * than only that it did not happen.
 */
export const WORKSPACE_READ_ONLY =
  "This is a ProPresenter 22 workspace, which is read-only here: its documents live in a database " +
  "ProPresenter keeps open and may be syncing to the cloud, and nothing writes to it yet. " +
  "Make the change in ProPresenter itself.";

/** Whether a path is inside a ProPresenter 22 workspace, and so cannot be written. */
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
