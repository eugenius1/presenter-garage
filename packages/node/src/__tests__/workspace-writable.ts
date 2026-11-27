import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LoroDoc, LoroMap, LoroMovableList, LoroTree, type LoroTreeNode } from "loro-crdt/base64";
import { decodeRtf, extractLines } from "@presenter-garage/core/lib/rtf";
import { syntheticTextPresentation } from "@presenter-garage/core/lib/__tests__/synthetic";
import { workspacePresentation } from "@presenter-garage/core/lib/__tests__/workspace-fixtures";
import { encodeVersionVector } from "@presenter-garage/core/lib/workspace-edit";
import { REGISTRY } from "../workspace";
import { VERIFIED_SCHEMA_VERSION } from "../workspace-write";
import { sqlite, storeOf } from "./workspace-db";

/**
 * A ProPresenter 22 workspace that can be written to, built for a test as a
 * real one was seen to be: a registry in the folder above it, a store in WAL
 * mode at `user_version` 9, and each document a Loro snapshot made of nested
 * containers, with its real hash and version vector beside it. No real
 * library data: the documents are the synthetic presentation.
 *
 * `workspace-db.ts` builds the simpler kind the read path needs, whose
 * snapshots hold one value each and whose bookkeeping is made up.
 */

/** A store's columns, as ProPresenter 22.0.1 makes them, with the constraint a wrong `byte_count` meets. */
const SCHEMA = `CREATE TABLE workspace_streams (
  document_id BLOB NOT NULL, scope INTEGER NOT NULL, location_type INTEGER NOT NULL, kind TEXT NOT NULL,
  core_path TEXT, availability INTEGER NOT NULL, snapshot BLOB, version_vector BLOB, sha256 BLOB,
  byte_count INTEGER NOT NULL CHECK (snapshot IS NULL OR byte_count = length(snapshot)),
  updated_at_ms INTEGER NOT NULL, core_path_key TEXT,
  last_shared_version_vector BLOB, last_shared_absence_reason INTEGER,
  PRIMARY KEY(document_id, scope))`;

export const REGISTRY_SCHEMA = `CREATE TABLE workspaces (
  local_uuid TEXT PRIMARY KEY NOT NULL, root_path TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  cloud_uuid TEXT UNIQUE, schema_version TEXT NOT NULL, availability TEXT NOT NULL);
  CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);`;

export const UUID = "1ca74a0b-0000-4000-8000-000000000001";
export const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();
type Json = any;

/**
 * Fill a Loro map as ProPresenter does: every message and list a container
 * of its own, except an attribute's `range`, which it keeps as one value,
 * and a presentation's groups and slides a tree, as its JSON shows them to be.
 */
function fill(map: LoroMap, value: Record<string, Json>): void {
  for (const [key, v] of Object.entries(value)) {
    if (key === "cue_group_placements" && Array.isArray(v)) {
      const tree = map.setContainer(key, new LoroTree());
      tree.enableFractionalIndex(0);
      fillTree(tree, v);
    } else if (Array.isArray(v)) fillList(map.setContainer(key, new LoroMovableList()), v);
    else if (v && typeof v === "object" && !ArrayBuffer.isView(v) && key !== "range") fill(map.setContainer(key, new LoroMap()), v);
    else map.set(key, v);
  }
}

/** Tree nodes as `toJSON()` gives them, each node's `meta` its own map. */
function fillTree(tree: LoroTree, nodes: Json[], parent?: LoroTreeNode): void {
  for (const node of nodes) {
    const created = parent ? parent.createNode() : tree.createNode();
    fill(created.data, node.meta ?? {});
    fillTree(tree, node.children ?? [], created);
  }
}

function fillList(list: LoroMovableList, values: Json[]): void {
  for (const [i, v] of values.entries()) {
    if (v && typeof v === "object" && !ArrayBuffer.isView(v)) fill(list.insertContainer(i, new LoroMap()), v);
    else list.insert(i, v);
  }
}

function snapshotOf(root: Json): { snapshot: Uint8Array; vv: Uint8Array } {
  const doc = new LoroDoc();
  doc.setPeerId(1);
  fill(doc.getMap("root"), root);
  doc.commit();
  const out = { snapshot: doc.export({ mode: "snapshot" }), vv: encodeVersionVector(doc.version().toJSON()) };
  doc.free();
  return out;
}

/**
 * The synthetic presentation as a workspace document, with an All Caps range
 * on each line of every box, as most real boxes have, or the ranges given:
 * All Caps too unless they say which attribute they are.
 */
export function presentationRoot(ranges?: (lines: string[]) => { start: number; end: number; attribute?: Json }[]): Json {
  const root = workspacePresentation(syntheticTextPresentation());
  // Every text element, found by what it holds rather than by the walk the
  // code under test makes, so a wrong walk there cannot hide in the fixture.
  const texts: Json[] = [];
  const visit = (value: Json): void => {
    if (!value || typeof value !== "object" || ArrayBuffer.isView(value)) return;
    if (ArrayBuffer.isView(value.rtf_data)) texts.push(value);
    else Object.values(value).forEach(visit);
  };
  visit(root.cues);
  for (const text of texts) {
    const lines = extractLines(decodeRtf(text.rtf_data)).map((line) => line.text);
    let at = 0;
    const perLine = (): { start: number; end: number; attribute?: Json }[] =>
      lines.map((t) => {
        const range = { start: at, end: at + t.length };
        at += t.length + 1;
        return range;
      });
    text.attributes = {
      custom_attributes: (ranges ? ranges(lines) : perLine()).map(({ attribute, ...range }) => ({
        Attribute: attribute ?? { __tag: "capitalization", capitalization: 1 },
        range,
      })),
    };
  }
  return root;
}

/** A workspace at `<tmp>/Workspaces/<UUID>`, listed in a registry beside it. Returns its folder. */
export function createWritableWorkspace(
  tmp: string,
  { cloud = false, schema = VERIFIED_SCHEMA_VERSION, userVersion = 9 } = {}
): string {
  const root = path.join(tmp, "Workspaces", UUID);
  fs.mkdirSync(path.join(root, "DocumentStore"), { recursive: true });
  fs.mkdirSync(path.join(root, "Libraries", "Default"), { recursive: true });
  const registry = new sqlite!.DatabaseSync(path.join(tmp, "Workspaces", REGISTRY));
  registry.exec(REGISTRY_SCHEMA);
  registry
    .prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, 'local')")
    .run(UUID, root, "Church", cloud ? "cloud-1" : null, schema);
  registry.close();
  const db = new sqlite!.DatabaseSync(storeOf(root));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`PRAGMA user_version = ${userVersion}`);
  db.exec(SCHEMA);
  db.close();
  return root;
}

let nextId = 1;

/**
 * Store a presentation as `Libraries/Default/<name>.pro`, with its real hash
 * and version vector. Returns its id. Its `last_shared_version_vector` and
 * `last_shared_absence_reason` are a local workspace's, `NULL` and 2, unless
 * given: `"synced"` for the version vector itself, as a Cloud document all
 * of whose changes Cloud has confirmed.
 */
export function putPresentation(
  root: string,
  name: string,
  json: Json,
  {
    versionVector,
    lastShared = null,
    absenceReason = lastShared === null ? 2 : null,
  }: { versionVector?: Uint8Array; lastShared?: Uint8Array | "synced" | null; absenceReason?: number | null } = {}
): Uint8Array {
  const { snapshot, vv } = snapshotOf(json);
  const id = new Uint8Array(16);
  new DataView(id.buffer).setUint32(12, nextId++);
  const db = new sqlite!.DatabaseSync(storeOf(root));
  db.prepare("INSERT INTO workspace_streams VALUES (?, 0, 1, 'Presentation', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    `Default/${name}`,
    snapshot,
    versionVector ?? vv,
    sha(snapshot),
    snapshot.length,
    1_700_000_000_000,
    `default/${name}`.toLowerCase(),
    lastShared === "synced" ? (versionVector ?? vv) : lastShared,
    absenceReason
  );
  db.close();
  return id;
}

