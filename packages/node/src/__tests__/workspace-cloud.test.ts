import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LoroDoc } from "loro-crdt/base64";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planLineEdits, type LineFix } from "@presenter-garage/core/lib/fixes";
import { encodePresentation, openPresentation } from "@presenter-garage/core/lib/presentation";
import { presentationFromWorkspace } from "@presenter-garage/core/lib/workspace";
import { coversVersion, decodeVersionVector, encodeVersionVector } from "@presenter-garage/core/lib/workspace-edit";
import { openRoots } from "../library";
import { REGISTRY, workspaceAt, type Workspace } from "../workspace";
import { readForPlanning, writeWorkspaceEdits, type WorkspaceReplacement } from "../workspace-write";
import { openBackupDir } from "../write";
import { sqlite, storeOf } from "./workspace-db";
import { createWritableWorkspace, presentationRoot, putPresentation, UUID } from "./workspace-writable";

/**
 * A ProPresenter Cloud workspace: written to as a local one is, but only a
 * document all of whose changes Cloud has confirmed, its
 * `last_shared_version_vector` covering its version vector. Against a
 * synthetic Cloud workspace -- a registry row with a `cloud_uuid`, and an
 * `imprint.cloud` in its folder -- never a real library.
 */

let tmp: string;
let root: string;
let ws: Workspace;

const suite = describe.skipIf(!sqlite);

/** Every row as stored. */
function rows(): Record<string, any>[] {
  const db = new sqlite!.DatabaseSync(storeOf(root), { readOnly: true });
  const all = db.prepare("SELECT * FROM workspace_streams ORDER BY document_id").all();
  db.close();
  return all;
}

const run = (sql: string, ...values: (string | number | null | Uint8Array)[]) => {
  const db = new sqlite!.DatabaseSync(storeOf(root));
  db.prepare(sql).run(...values);
  db.close();
};

const documentNamed = async (name = "Song") => (await ws.find(path.join(root, "Libraries", "Default", `${name}.pro`)))!;

/** The first line of the box that starts "Que ton nom,", changed to `text`. */
async function plan(text: string): Promise<WorkspaceReplacement & { cloud: boolean; box: number }> {
  const document = await documentNamed();
  const planned = await readForPlanning(ws, document);
  const { doc } = openPresentation(planned.bytes);
  const box = doc!.textBoxes.find((b) => b.lines[0]?.text === "Que ton nom,")!.boxIndex;
  const fixes: LineFix[] = planLineEdits(doc!, [{ boxIndex: box, lineIndex: 0, text }]);
  return { path: document.path, documentId: document.id, sha256: planned.sha256, fixes, cloud: planned.cloud, box };
}

/** A box's lines as the row now holds them, read straight from its snapshot. */
function linesOf(box: number): string[] {
  const doc = new LoroDoc();
  doc.import(rows()[0].snapshot);
  const { message } = presentationFromWorkspace((doc.toJSON() as { root: unknown }).root);
  doc.free();
  return openPresentation(encodePresentation(message)).doc!.textBoxes[box].lines.map((l) => l.text);
}

const write = async (replacements: WorkspaceReplacement[]) =>
  writeWorkspaceEdits(ws, [root], await openBackupDir(path.join(tmp, "Backups"), [root]), replacements);

const message = (p: Promise<unknown>) =>
  p.then(
    () => "",
    (e: Error) => e.message
  );

/** A version vector behind every one the fixture makes: peer 1 at its first change only. */
const BEHIND = encodeVersionVector(new Map([["1", 1]]));

async function cloudWorkspace(shared: Parameters<typeof putPresentation>[3]): Promise<void> {
  root = createWritableWorkspace(tmp, { cloud: true });
  fs.writeFileSync(path.join(root, "imprint.cloud"), "{}");
  putPresentation(root, "Song", presentationRoot(), shared);
  [root] = await openRoots([root]);
  ws = (await workspaceAt(root))!;
}

suite("writing to a ProPresenter Cloud workspace", () => {
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-workspace-cloud-")));
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("writes a document Cloud has confirmed, says it is Cloud, and leaves the shared vector to ProPresenter", async () => {
    await cloudWorkspace({ lastShared: "synced" });
    const edit = await plan("Que ton nom");
    expect(edit.cloud).toBe(true);
    const [before] = rows();
    const outcome = await write([edit]);
    expect(outcome.outcomes.map((o) => [o.written, o.reason])).toEqual([[true, undefined]]);
    expect(linesOf(edit.box)[0]).toBe("Que ton nom");
    const [after] = rows();
    expect(after.last_shared_version_vector).toEqual(before.last_shared_version_vector);
    expect(after.last_shared_version_vector_absence_reason).toBeNull();
    expect(fs.readdirSync(path.join(tmp, "Backups"))).toHaveLength(1);
    // Our change is now the one Cloud has not confirmed: nothing more until ProPresenter has synced it.
    expect(await message(readForPlanning(ws, await documentNamed()))).toMatch(/not sent to Cloud yet/);
  });

  it("refuses a document whose shared vector lags its version vector, at plan time and inside the lock", async () => {
    await cloudWorkspace({ lastShared: BEHIND });
    expect(await message(readForPlanning(ws, await documentNamed()))).toMatch(
      /: this Cloud presentation has changes ProPresenter has not sent to Cloud yet\. Open ProPresenter, let it sync, quit it, and try again\. Nothing was planned\.$/
    );

    // Planned while it was confirmed, then ProPresenter saved a change it has not sent yet.
    run("UPDATE workspace_streams SET last_shared_version_vector = version_vector");
    const edit = await plan("Que ton nom");
    run("UPDATE workspace_streams SET last_shared_version_vector = ?", BEHIND);
    const before = rows();
    const outcome = await write([edit]);
    expect(outcome.outcomes.map((o) => [o.written, o.reason])).toEqual([[false, "unsynced"]]);
    expect(rows()).toEqual(before);
  });

  it("refuses a document with no shared vector, a reason it has none, or one it cannot read", async () => {
    await cloudWorkspace({ lastShared: null, absenceReason: null });
    expect(await message(readForPlanning(ws, await documentNamed()))).toMatch(/not sent to Cloud yet/);
    run("UPDATE workspace_streams SET last_shared_version_vector = version_vector, last_shared_version_vector_absence_reason = 2");
    expect(await message(readForPlanning(ws, await documentNamed()))).toMatch(/not sent to Cloud yet/);
    run("UPDATE workspace_streams SET last_shared_version_vector = x'ff', last_shared_version_vector_absence_reason = NULL");
    expect(await message(readForPlanning(ws, await documentNamed()))).toMatch(/not sent to Cloud yet/);
  });

  it("leaves a local workspace alone, and tells Cloud by its marker as well as by the registry", async () => {
    root = createWritableWorkspace(tmp);
    putPresentation(root, "Song", presentationRoot(), { lastShared: BEHIND, absenceReason: null });
    [root] = await openRoots([root]);
    ws = (await workspaceAt(root))!;
    // Local by both: the shared vector is not looked at.
    expect((await plan("Que ton nom")).cloud).toBe(false);
    fs.writeFileSync(path.join(root, "imprint.cloud"), "{}");
    expect(await message(readForPlanning(ws, await documentNamed()))).toMatch(/not sent to Cloud yet/);
  });

  it("still refuses a document with no snapshot (availability 1)", async () => {
    await cloudWorkspace({ lastShared: "synced" });
    const edit = await plan("Que ton nom");
    // Listed but not downloaded, as a Cloud document can be.
    run("UPDATE workspace_streams SET availability = 1, snapshot = NULL, sha256 = NULL, version_vector = NULL, byte_count = 0");
    const before = rows();
    const outcome = await write([edit]);
    expect(outcome.outcomes.map((o) => [o.written, o.reason])).toEqual([[false, "stale"]]);
    expect(rows()).toEqual(before);
    expect(await message(readForPlanning(ws, await documentNamed()))).toMatch(/no longer in the workspace/);
  });

  it("finds a workspace's row by a root_path ending in /, and refuses two rows for one folder", async () => {
    await cloudWorkspace({ lastShared: "synced" });
    const registry = new sqlite!.DatabaseSync(path.join(tmp, "Workspaces", REGISTRY));
    // Found by its root_path alone, as a workspace downloaded from Cloud has it.
    registry.prepare("UPDATE workspaces SET local_uuid = 'elsewhere', root_path = ?").run(`${root}/`);
    expect((await plan("Que ton nom")).cloud).toBe(true);
    registry.prepare("INSERT INTO workspaces VALUES (?, ?, 'Copy', NULL, '22.9.0', 'local')").run(UUID, path.join(tmp, "other"));
    registry.close();
    expect(await message(readForPlanning(ws, await documentNamed()))).toMatch(/lists it 2 times/);
  });
});

describe("version vectors as stored", () => {
  it("read back exactly what is written, and nothing else", () => {
    const vv = new Map([
      ["2", 5],
      ["8605992135545059269", 436],
      ["6668784730159926922", 1],
    ]);
    expect(decodeVersionVector(encodeVersionVector(vv))).toEqual(vv);
    expect(decodeVersionVector(new Uint8Array([0]))).toEqual(new Map());
    // Cut short, left over, out of order, not a varint.
    expect(decodeVersionVector(encodeVersionVector(vv).slice(0, -1))).toBeUndefined();
    expect(decodeVersionVector(new Uint8Array([...encodeVersionVector(vv), 0]))).toBeUndefined();
    expect(decodeVersionVector(new Uint8Array([0x02, 0x09, 0x02, 0x02, 0x02]))).toBeUndefined();
    expect(decodeVersionVector(new Uint8Array([0xff]))).toBeUndefined();
  });

  it("cover a version only with every peer at least as far", () => {
    const vv = new Map([
      ["1", 1],
      ["2", 436],
    ]);
    expect(coversVersion(vv, vv)).toBe(true);
    expect(coversVersion(new Map([...vv, ["3", 1]]), vv)).toBe(true);
    expect(coversVersion(new Map([["1", 1], ["2", 435]]), vv)).toBe(false);
    expect(coversVersion(new Map([["2", 436]]), vv)).toBe(false);
  });
});
