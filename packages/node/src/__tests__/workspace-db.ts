import fs from "node:fs";
import path from "node:path";
import { LoroDoc } from "loro-crdt/base64";

/**
 * A ProPresenter 22 workspace built on disk for a test, in the layout a real
 * one was seen to have: `DocumentStore/workspace-v1.sqlite3`, one Loro
 * snapshot per row. What goes in each snapshot is the caller's; see
 * `workspace-fixtures.ts` in core for documents made from the synthetic files.
 */

type Sqlite = typeof import("node:sqlite");

/** Not there before Node 22.5; a suite that needs it skips itself when this is undefined. */
export const sqlite: Sqlite | undefined = await import("node:sqlite").catch(() => undefined);

/** The columns the reader uses, under the names and types ProPresenter gives them. */
export const SCHEMA = `CREATE TABLE workspace_streams (
  document_id BLOB NOT NULL, scope INTEGER NOT NULL, location_type INTEGER NOT NULL, kind TEXT NOT NULL,
  core_path TEXT, availability INTEGER NOT NULL, snapshot BLOB, version_vector BLOB, sha256 BLOB,
  byte_count INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, core_path_key TEXT,
  PRIMARY KEY(document_id, scope))`;

/** When every document of a test workspace was last saved. */
export const MODIFIED = Date.UTC(2026, 10, 15, 19, 27);

export const storeOf = (workspace: string) => path.join(workspace, "DocumentStore", "workspace-v1.sqlite3");

function snapshot(root: Record<string, unknown>): Uint8Array {
  const doc = new LoroDoc();
  const map = doc.getMap("root");
  for (const [key, value] of Object.entries(root)) map.set(key, value as never);
  doc.commit();
  const bytes = doc.export({ mode: "snapshot" });
  doc.free();
  return bytes;
}

/** An empty workspace, with the old folders ProPresenter leaves in place beside the database. */
export function createWorkspace(workspace: string): void {
  fs.mkdirSync(path.join(workspace, "DocumentStore"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "Libraries", "Default"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "Playlists"));
  const db = new sqlite!.DatabaseSync(storeOf(workspace));
  db.exec(SCHEMA);
  db.close();
}

let nextId = 1;

/**
 * Store one document. `corePath` is the old relative path without its
 * extension, for the kinds that have one. `root` as `null` is a document of
 * a Cloud workspace that is listed but not yet downloaded, and a snapshot's
 * bytes are stored as they are, for a test that needs a history. `scope` 1 is
 * the per-computer copy some kinds keep beside the shared one.
 */
export function putDocument(
  workspace: string,
  kind: string,
  corePath: string | null,
  root: Record<string, unknown> | Uint8Array | null,
  scope = 0
): void {
  const db = new sqlite!.DatabaseSync(storeOf(workspace));
  const bytes = root instanceof Uint8Array ? root : root ? snapshot(root) : null;
  const id = new Uint8Array(16);
  new DataView(id.buffer).setUint32(12, nextId++);
  db.prepare("INSERT INTO workspace_streams VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    scope,
    corePath ? 1 : 0,
    kind,
    corePath,
    bytes ? 0 : 1,
    bytes,
    bytes ? new Uint8Array(1) : null,
    // Stands in for the hash: all the reader needs is that it differs between snapshots.
    bytes ? new Uint8Array(new BigUint64Array([BigInt(nextId), 0n, 0n, 0n]).buffer) : null,
    bytes?.length ?? 0,
    MODIFIED,
    corePath?.toLowerCase() ?? null
  );
  db.close();
}
