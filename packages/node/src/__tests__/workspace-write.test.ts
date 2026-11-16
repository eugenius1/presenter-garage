import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LoroDoc } from "loro-crdt/base64";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planLineEdits, type LineChange, type LineFix } from "@presenter-garage/core/lib/fixes";
import { openPresentation, readPresentation } from "@presenter-garage/core/lib/presentation";
import { presentationFromWorkspace } from "@presenter-garage/core/lib/workspace";
import { encodeVersionVector, planWorkspaceEdit, valueAt } from "@presenter-garage/core/lib/workspace-edit";
import { openRoots } from "../library";
import { REGISTRY, workspaceAt, type StoredDocument, type Workspace } from "../workspace";
import {
  CLOUD_REFUSED,
  PROPRESENTER_OPEN,
  readForPlanning,
  VERIFIED_SCHEMA_VERSION,
  writeWorkspaceEdits,
  type WorkspaceReplacement,
} from "../workspace-write";
import { openBackupDir } from "../write";
import { sqlite, storeOf } from "./workspace-db";
import {
  createWritableWorkspace,
  presentationRoot,
  putPresentation,
  REGISTRY_SCHEMA,
  sha,
  UUID,
} from "./workspace-writable";

/**
 * Writing slide text into a ProPresenter 22 workspace, against a workspace
 * built as `workspace-writable.ts` builds one. No real library data, except
 * in the last suite, which copies one only where it is configured.
 */

type Json = any;

let tmp: string;
let root: string;
let backups: string;

/** Every row as stored, for telling what a run changed. */
function rows(): Record<string, Json>[] {
  const db = new sqlite!.DatabaseSync(storeOf(root), { readOnly: true });
  const all = db.prepare("SELECT * FROM workspace_streams ORDER BY document_id").all();
  db.close();
  return all;
}

let ws: Workspace;

async function open(): Promise<Workspace> {
  const [real] = await openRoots([root]);
  root = real;
  return (await workspaceAt(real))!;
}

async function documentNamed(name: string): Promise<StoredDocument> {
  return (await ws.find(path.join(root, "Libraries", "Default", `${name}.pro`)))!;
}

/** Plan as `plan_slide_edits` does: the row read now, the lines read through the conversion. */
async function plan(name: string, changes: (doc: ReturnType<typeof readPresentation>) => LineChange[]): Promise<WorkspaceReplacement> {
  const document = await documentNamed(name);
  const planned = await readForPlanning(ws, document);
  const opened = openPresentation(planned.bytes);
  if (opened.problem) throw new Error(opened.problem);
  const fixes: LineFix[] = planLineEdits(opened.doc, changes(opened.doc));
  return { path: document.path, documentId: document.id, sha256: planned.sha256, fixes };
}

const threeLines = (doc: ReturnType<typeof readPresentation>) => doc.textBoxes.find((b) => b.lines[0]?.text === "Que ton nom,")!;

async function linesOf(name: string, boxIndex: number): Promise<string[]> {
  const planned = await readForPlanning(ws, await documentNamed(name));
  const opened = openPresentation(planned.bytes);
  return opened.doc!.textBoxes[boxIndex].lines.map((l) => l.text);
}

async function write(replacements: WorkspaceReplacement[], hooks?: Parameters<typeof writeWorkspaceEdits>[4]) {
  return writeWorkspaceEdits(ws, [root], await openBackupDir(backups, [root]), replacements, hooks);
}

const suite = describe.skipIf(!sqlite);

suite("writing slide text into a workspace", () => {
  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-workspace-write-")));
    backups = path.join(tmp, "Backups");
    root = createWritableWorkspace(tmp);
    putPresentation(root, "Song", presentationRoot());
    putPresentation(root, "Other", presentationRoot());
    ws = await open();
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("writes the chosen lines, moves the ranges with them, and keeps the row's bookkeeping true", async () => {
    const before = rows();
    let box = 0;
    const edit = await plan("Song", (doc) => {
      box = threeLines(doc).boxIndex;
      return [
        { boxIndex: box, lineIndex: 0, text: "Que ton nom" },
        { boxIndex: box, lineIndex: 1, text: "pour toujours et à jamais ," },
      ];
    });
    const run = await write([edit]);

    expect(run.outcomes.map((o) => [o.written, o.reason])).toEqual([[true, undefined]]);
    expect(await linesOf("Song", box)).toEqual(["Que ton nom", "pour toujours et à jamais ,", "sois glorifie"]);

    const after = rows();
    const [changed, untouched] = [after[0], after[1]];
    // The other presentation is byte for byte as it was.
    expect(untouched).toEqual(before[1]);
    // The row's own bookkeeping, and nothing else of it beyond the time.
    expect(Buffer.from(changed.sha256).equals(sha(changed.snapshot))).toBe(true);
    expect(changed.byte_count).toBe(changed.snapshot.length);
    expect(changed.updated_at_ms).toBeGreaterThan(before[0].updated_at_ms);
    expect(changed.last_shared_version_vector).toBeNull();
    expect(changed.last_shared_absence_reason).toBe(2);
    expect(changed.core_path).toBe(before[0].core_path);

    const old = new LoroDoc();
    old.import(before[0].snapshot);
    const doc = new LoroDoc();
    doc.import(changed.snapshot);
    const version = doc.version().toJSON();
    // The old peer as it was, and one new one.
    expect(version.get("1")).toBe(old.version().toJSON().get("1"));
    expect(version.size).toBe(2);
    old.free();
    expect(Buffer.from(changed.version_vector).equals(Buffer.from(encodeVersionVector(version)))).toBe(true);

    // Each range on the line it was on: the first line one shorter, the second twelve longer.
    const root = doc.toJSON().root;
    const { message } = presentationFromWorkspace(root);
    const text = valueAt(root, planWorkspaceEdit(root, planLineEdits(readPresentation(message), [{ boxIndex: box, lineIndex: 2, text: "x" }])).boxes[0].path);
    expect(text.attributes.custom_attributes.map((a: Json) => a.range)).toEqual([
      { start: 0, end: 11 },
      { start: 12, end: 39 },
      { start: 40, end: 53 },
    ]);
    doc.free();
  });

  it("backs up the row as it was, with the file it reads as, before it changes", async () => {
    const before = rows()[0];
    const run = await write([await plan("Song", (doc) => [{ boxIndex: threeLines(doc).boxIndex, lineIndex: 0, text: "Que ton nom" }])]);
    const backup = run.outcomes[0].backup!;
    expect(backup.startsWith(run.backupFolder!)).toBe(true);
    expect(backup).toBe(path.join(run.backupFolder!, UUID, "Libraries", "Default", "Song.pro"));
    expect(Buffer.from(fs.readFileSync(`${backup}.loro`)).equals(Buffer.from(before.snapshot))).toBe(true);
    const columns = JSON.parse(fs.readFileSync(`${backup}.row.json`, "utf8"));
    expect(columns.sha256).toBe(Buffer.from(before.sha256).toString("hex"));
    expect(columns.version_vector).toBe(Buffer.from(before.version_vector).toString("hex"));
    expect(columns.core_path).toBe("Default/Song");
    expect(openPresentation(fs.readFileSync(backup)).doc!.textBoxes.some((b) => b.lines[0]?.text === "Que ton nom,")).toBe(true);
  });

  it("writes every presentation of a run in one go", async () => {
    const edits = [
      await plan("Song", (doc) => [{ boxIndex: threeLines(doc).boxIndex, lineIndex: 2, text: "sois glorifié" }]),
      await plan("Other", (doc) => [{ boxIndex: threeLines(doc).boxIndex, lineIndex: 2, text: "sois béni" }]),
    ];
    const run = await write(edits);
    expect(run.outcomes.map((o) => o.written)).toEqual([true, true]);
  });

  it("refuses to begin while another connection has the store open, as ProPresenter does", async () => {
    const edit = await plan("Song", (doc) => [{ boxIndex: threeLines(doc).boxIndex, lineIndex: 0, text: "Que ton nom" }]);
    const before = rows();
    const other = new sqlite!.DatabaseSync(storeOf(root));
    other.prepare("SELECT count(*) FROM workspace_streams").get();
    try {
      await expect(write([edit])).rejects.toThrow(PROPRESENTER_OPEN);
    } finally {
      other.close();
    }
    expect(rows()).toEqual(before);
    expect(fs.existsSync(backups) ? fs.readdirSync(backups) : []).toEqual([]);
    // And goes ahead once it has gone.
    expect((await write([edit])).outcomes[0].written).toBe(true);
  });

  it("does not take the lock for a presentation with no line left ticked", async () => {
    const edit = await plan("Song", (doc) => [{ boxIndex: threeLines(doc).boxIndex, lineIndex: 0, text: "Que ton nom" }]);
    const other = new sqlite!.DatabaseSync(storeOf(root));
    other.prepare("SELECT count(*) FROM workspace_streams").get();
    try {
      const run = await write([{ ...edit, fixes: [] }]);
      expect(run.outcomes[0]).toMatchObject({ written: false, reason: "unchanged" });
    } finally {
      other.close();
    }
  });

  it("leaves a presentation alone that changed since the plan, and writes the rest", async () => {
    const stale = await plan("Song", (doc) => [{ boxIndex: threeLines(doc).boxIndex, lineIndex: 0, text: "Que ton nom" }]);
    const fresh = await plan("Other", (doc) => [{ boxIndex: threeLines(doc).boxIndex, lineIndex: 0, text: "Que ton nom" }]);
    const run = await write([{ ...stale, sha256: "00".repeat(32) }, fresh]);
    expect(run.outcomes.map((o) => [o.written, o.reason])).toEqual([
      [false, "stale"],
      [true, undefined],
    ]);
    expect(run.outcomes[0].backup).toBeUndefined();
  });

  it("refuses a box whose ranges do not fall on its lines, when planning and when applying", async () => {
    const id = putPresentation(root, "Tabbed", presentationRoot((lines) => [{ start: 1, end: lines[0].length }]));
    ws = await open();
    const document = await documentNamed("Tabbed");
    expect(document.id).toEqual(id);
    const planned = await readForPlanning(ws, document);
    const fixes = planLineEdits(openPresentation(planned.bytes).doc!, [{ boxIndex: 0, lineIndex: 0, text: "Changed" }]);
    expect(() => planWorkspaceEdit(planned.root, fixes)).toThrow(/do not fall on its lines/);

    const before = rows();
    const run = await write([{ path: document.path, documentId: id, sha256: planned.sha256, fixes }]);
    expect(run.outcomes[0]).toMatchObject({ written: false, reason: "attributeRanges" });
    expect(rows()).toEqual(before);
  });

  it("refuses a document whose stored version vector it does not reproduce", async () => {
    putPresentation(root, "Odd", presentationRoot(), { versionVector: new Uint8Array([1, 1, 2]) });
    ws = await open();
    await expect(readForPlanning(ws, await documentNamed("Odd"))).rejects.toThrow(/does not come back exactly/);
  });

  it("writes nothing when the backup cannot be made", async () => {
    const edit = await plan("Song", (doc) => [{ boxIndex: threeLines(doc).boxIndex, lineIndex: 0, text: "Que ton nom" }]);
    const before = rows();
    // A file where the backup folder should be: nothing can be made inside it.
    fs.writeFileSync(path.join(tmp, "NotAFolder"), "");
    const run = await writeWorkspaceEdits(ws, [root], path.join(tmp, "NotAFolder"), [edit]);
    expect(run.outcomes[0]).toMatchObject({ written: false, reason: "backupFailed" });
    expect(rows()).toEqual(before);
  });

  it("rolls the whole run back when a row does not read back as written", async () => {
    const edits = [
      await plan("Song", (doc) => [{ boxIndex: threeLines(doc).boxIndex, lineIndex: 0, text: "Que ton nom" }]),
      await plan("Other", (doc) => [{ boxIndex: threeLines(doc).boxIndex, lineIndex: 0, text: "Que ton nom" }]),
    ];
    const before = rows();
    const run = await write(edits, {
      hooks: {
        afterUpdate: (db, id) => {
          if (Buffer.from(id).equals(Buffer.from(edits[1].documentId))) {
            db.prepare("UPDATE workspace_streams SET version_vector = x'00' WHERE document_id = ?").run(id);
          }
        },
      },
    });
    expect(run.outcomes.map((o) => [o.written, o.reason])).toEqual([
      [false, "rolledBack"],
      [false, "readBackFailed"],
    ]);
    expect(rows()).toEqual(before);
  });

  it("does not leave the run cancelled half way", async () => {
    const edit = await plan("Song", (doc) => [{ boxIndex: threeLines(doc).boxIndex, lineIndex: 0, text: "Que ton nom" }]);
    const before = rows();
    const controller = new AbortController();
    controller.abort();
    await expect(write([edit], { signal: controller.signal })).rejects.toThrow(/cancelled before anything in this workspace changed/);
    expect(rows()).toEqual(before);
  });
});

suite("which workspaces are written to", () => {
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-workspace-write-")));
    backups = path.join(tmp, "Backups");
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  async function refusal(): Promise<string> {
    putPresentation(root, "Song", presentationRoot());
    ws = await open();
    const document = await documentNamed("Song");
    const planning = await readForPlanning(ws, document).then(
      () => "",
      (e: Error) => e.message
    );
    // Refused before any line is looked at, so a stand-in line will do.
    const applying = await write([{ path: document.path, documentId: document.id, sha256: "", fixes: [{} as LineFix] }]).then(
      () => "",
      (e: Error) => e.message
    );
    expect(applying).toBe(planning);
    return planning;
  }

  it("refuses a Cloud workspace, and says where that stands", async () => {
    root = createWritableWorkspace(tmp, { cloud: true });
    expect(await refusal()).toBe(CLOUD_REFUSED);
    expect(CLOUD_REFUSED).toMatch(/issues\/55/);
  });

  it("refuses a workspace with an imprint.cloud, whatever the registry says", async () => {
    root = createWritableWorkspace(tmp);
    fs.writeFileSync(path.join(root, "imprint.cloud"), "{}");
    expect(await refusal()).toBe(CLOUD_REFUSED);
  });

  it("refuses a format version it has not been checked against", async () => {
    root = createWritableWorkspace(tmp, { schema: "22.10.0" });
    expect(await refusal()).toMatch(/format is 22\.10\.0, not 22\.9\.0/);
  });

  it("refuses a workspace no registry lists", async () => {
    root = createWritableWorkspace(tmp);
    fs.rmSync(path.join(tmp, "Workspaces", REGISTRY));
    expect(await refusal()).toMatch(/no registry-v1\.sqlite3 beside it/);
  });

  it("refuses a store of a version it has not been checked against", async () => {
    root = createWritableWorkspace(tmp, { userVersion: 10 });
    expect(await refusal()).toMatch(/document store is version 10, not 9/);
  });
});

/**
 * Against a copy of a real workspace, where one is configured: see *Testing
 * against real files* in CONTRIBUTING.md. The database is copied into a
 * temporary folder first, with a registry made for the copy, and only the
 * copy is written: the configured workspace is opened read-only, if at all.
 */
const REAL_WORKSPACE = process.env.PP_WORKSPACE_DIR;

// `backup` is Node 22.16 and later; the copy is made with it so the source is only ever read.
describe.skipIf(!REAL_WORKSPACE || !sqlite?.backup)("writing into a copy of a real workspace", () => {
  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-workspace-write-real-")));
    backups = path.join(tmp, "Backups");
    root = path.join(tmp, "Workspaces", UUID);
    fs.mkdirSync(path.join(root, "DocumentStore"), { recursive: true });
    // Through SQLite's own backup, which reads the -wal as well and leaves the source alone.
    const source = new sqlite!.DatabaseSync(storeOf(REAL_WORKSPACE!), { readOnly: true });
    await sqlite!.backup(source, storeOf(root));
    source.close();
    const registry = new sqlite!.DatabaseSync(path.join(tmp, "Workspaces", REGISTRY));
    registry.exec(REGISTRY_SCHEMA);
    registry.prepare("INSERT INTO workspaces VALUES (?, ?, 'Copy', NULL, ?, 'local')").run(UUID, root, VERIFIED_SCHEMA_VERSION);
    registry.close();
    ws = await open();
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("edits a line of the first presentations that can be, and reads them back as promised", { timeout: 120_000 }, async () => {
    let written = 0;
    for (const file of (await ws.list("Presentation")).slice(0, 25)) {
      const document = (await ws.find(file))!;
      const planned = await readForPlanning(ws, document);
      const { doc } = openPresentation(planned.bytes);
      const box = doc?.textBoxes.find((b) => b.lines.length > 1 && b.lines[1].text.length > 0);
      if (!box) continue;
      const fixes = planLineEdits(doc!, [{ boxIndex: box.boxIndex, lineIndex: 1, text: `${box.lines[1].text} (garage)` }]);
      const run = await write([{ path: file, documentId: document.id, sha256: planned.sha256, fixes }]);
      if (run.outcomes[0].reason === "attributeRanges") continue;
      expect([run.outcomes[0].written, run.outcomes[0].reason]).toEqual([true, undefined]);
      const again = openPresentation((await readForPlanning(ws, (await ws.find(file))!)).bytes).doc!;
      expect(again.textBoxes[box.boxIndex].lines[1].text).toBe(`${box.lines[1].text} (garage)`);
      written++;
    }
    expect(written).toBeGreaterThan(0);
  });
});
