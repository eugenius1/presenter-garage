import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LoroDoc, LoroTree } from "loro-crdt/base64";
import { FixError } from "@presenter-garage/core/lib/fixes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeGroupsDocument, decodeMacrosDocument, readGroups, readMacros } from "@presenter-garage/core/lib/configuration";
import { decodePresentation, encodePresentation, openPresentation } from "@presenter-garage/core/lib/presentation";
import { planStructure, readStructure, type StructureRequest } from "@presenter-garage/core/lib/structure";
import { syntheticGroupsFile, syntheticMacroSong, syntheticMacrosFile, textLines } from "@presenter-garage/core/lib/__tests__/synthetic";
import { workspacePresentation } from "@presenter-garage/core/lib/__tests__/workspace-fixtures";
import { openRoots } from "../library";
import { workspaceAt, type Workspace } from "../workspace";
import { readForPlanning, rehearseWorkspaceEdit, writeWorkspaceEdits, type WorkspaceReplacement } from "../workspace-write";
import { openBackupDir } from "../write";
import { sqlite, storeOf } from "./workspace-db";
import { createWritableWorkspace, putPresentation } from "./workspace-writable";

/**
 * A group renamed and a macro swapped in a ProPresenter 22 workspace built
 * as a real one was seen to be: the groups and slides a Loro tree, every
 * message a map of its own. No real library data.
 */

type Json = any;

const config = {
  groups: readGroups(decodeGroupsDocument(syntheticGroupsFile())),
  macros: readMacros(decodeMacrosDocument(syntheticMacrosFile())),
};

let tmp: string;
let root: string;
let ws: Workspace;

/** The macro song as a workspace stores it, its Chorus coloured grey so a rename can recolour it. */
function songRoot(): Json {
  const doc = decodePresentation(syntheticMacroSong()) as Json;
  doc.cue_groups[1].group.color = { red: 0.5, green: 0.5, blue: 0.5, alpha: 1 };
  return workspacePresentation(encodePresentation(doc));
}

const snapshotOf = (name: string) => {
  const db = new sqlite!.DatabaseSync(storeOf(root), { readOnly: true });
  const row = db.prepare("SELECT snapshot FROM workspace_streams WHERE core_path = ?").get(`Default/${name}`) as { snapshot: Uint8Array };
  db.close();
  return row.snapshot;
};

/** Plan as `plan_slide_edits` does, from the row read now. */
async function plan(name: string, requests: StructureRequest[]): Promise<WorkspaceReplacement> {
  const document = (await ws.find(path.join(root, "Libraries", "Default", `${name}.pro`)))!;
  const planned = await readForPlanning(ws, document);
  const { raw } = openPresentation(planned.bytes) as { raw: Json };
  return { path: document.path, documentId: document.id, sha256: planned.sha256, fixes: [], changes: planStructure(raw, requests, config) };
}

async function read(name: string) {
  const document = (await ws.find(path.join(root, "Libraries", "Default", `${name}.pro`)))!;
  return (await readForPlanning(ws, document)).bytes;
}

describe.skipIf(!sqlite)("structural changes in a workspace", () => {
  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-workspace-structure-")));
    root = createWritableWorkspace(tmp);
    putPresentation(root, "Song", songRoot());
    putPresentation(root, "Other", songRoot());
    [root] = await openRoots([root]);
    ws = (await workspaceAt(root))!;
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("renames a group and swaps a macro, leaving every line, slide and the other song as they were", async () => {
    const before = await read("Song");
    const other = snapshotOf("Other");
    const edit = await plan("Song", [
      { kind: "renameGroup", groupIndex: 1, name: "Refrain" },
      { kind: "swapMacro", slideIndex: 2, from: "Louange", to: "Bienvenue" },
    ]);
    const run = await writeWorkspaceEdits(ws, [root], await openBackupDir(path.join(tmp, "Backups"), [root]), [edit]);
    expect(run.outcomes.map((o) => [o.written, o.reason])).toEqual([[true, undefined]]);

    const after = await read("Song");
    const was = readStructure(decodePresentation(before));
    const now = readStructure(decodePresentation(after));
    expect(now.groups[1]).toMatchObject({ uuid: was.groups[1].uuid, name: "Refrain", color: config.groups[2].rgba, cues: was.groups[1].cues });
    expect(now.groups[0]).toEqual(was.groups[0]);
    expect(now.slides[2].macros.map((m) => m.name)).toEqual(["Bienvenue"]);
    expect(now.slides.filter((_, i) => i !== 2)).toEqual(was.slides.filter((_, i) => i !== 2));
    expect(textLines(after)).toEqual(textLines(before));
    expect(Buffer.from(snapshotOf("Other")).equals(Buffer.from(other))).toBe(true);

    // The tree is still a tree, its nodes where they were: only values in its nodes' maps changed.
    const doc = new LoroDoc();
    doc.import(snapshotOf("Song"));
    const tree = doc.getMap("root").get("cue_group_placements");
    expect(tree).toBeInstanceOf(LoroTree);
    const old = new LoroDoc();
    old.import(fs.readFileSync(`${run.outcomes[0].backup}.loro`));
    const ids = (d: LoroDoc) => (d.toJSON().root.cue_group_placements as Json[]).map((n) => [n.id, n.children.map((c: Json) => c.id)]);
    expect(ids(doc)).toEqual(ids(old));
    doc.free();
    old.free();
  });

  it("rehearses a change on the stored snapshot at plan time, refusing a document not shaped as its JSON reads", async () => {
    const edit = await plan("Song", [{ kind: "renameGroup", groupIndex: 1, name: "Refrain" }]);
    expect(() => rehearseWorkspaceEdit(snapshotOf("Song"), [], edit.changes!)).not.toThrow();
    // The same JSON with every message a plain value rather than a map of its own: nothing to set a value in.
    const flat = new LoroDoc();
    for (const [key, value] of Object.entries(songRoot())) flat.getMap("root").set(key, value as never);
    flat.commit();
    const bytes = flat.export({ mode: "snapshot" });
    flat.free();
    expect(() => rehearseWorkspaceEdit(bytes, [], edit.changes!)).toThrow(new FixError("lossy"));
  });

  it("refuses at the lock a change the document no longer holds, and writes nothing", async () => {
    const edit = await plan("Song", [{ kind: "renameGroup", groupIndex: 1, name: "Refrain" }]);
    // The row moved on since: another rename, as ProPresenter might have made.
    const moved = await plan("Song", [{ kind: "renameGroup", groupIndex: 1, name: "Pont" }]);
    await writeWorkspaceEdits(ws, [root], await openBackupDir(path.join(tmp, "Backups"), [root]), [moved]);
    const run = await writeWorkspaceEdits(ws, [root], await openBackupDir(path.join(tmp, "Backups"), [root]), [edit]);
    expect(run.outcomes.map((o) => [o.written, o.reason])).toEqual([[false, "stale"]]);
    expect(readStructure(decodePresentation(await read("Song"))).groups[1].name).toBe("Pont");
  });
});
