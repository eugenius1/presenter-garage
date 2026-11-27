import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planLineEdits, type LineFix } from "@presenter-garage/core/lib/fixes";
import { openPresentation } from "@presenter-garage/core/lib/presentation";
import { openRoots } from "../library";
import { REGISTRY, workspaceAt, type Workspace } from "../workspace";
import {
  allowCloudWorkspace,
  allowedCloudWorkspace,
  CLOUD_REFUSED,
  readForPlanning,
  writeWorkspaceEdits,
  type WorkspaceReplacement,
} from "../workspace-write";
import { openBackupDir } from "../write";
import { sqlite, storeOf } from "./workspace-db";
import { createWritableWorkspace, presentationRoot, putPresentation, UUID } from "./workspace-writable";

/**
 * The one Cloud workspace a person names with `--allow-cloud-workspace`, for
 * #55's experiments: written to as a local one is, and every other Cloud
 * workspace still refused. Against a synthetic Cloud workspace -- a registry
 * row with a `cloud_uuid`, and an `imprint.cloud` in its folder -- never a
 * real library.
 */

const OTHER = "1ca74a0b-0000-4000-8000-0000000000ff";

let tmp: string;
let root: string;
let registry: string;
let ws: Workspace;

const suite = describe.skipIf(!sqlite);

/** Every row as stored. */
function rows(): Record<string, unknown>[] {
  const db = new sqlite!.DatabaseSync(storeOf(root), { readOnly: true });
  const all = db.prepare("SELECT * FROM workspace_streams ORDER BY document_id").all();
  db.close();
  return all;
}

const documentNamed = async (name: string) => (await ws.find(path.join(root, "Libraries", "Default", `${name}.pro`)))!;

/** The first line of the box that starts "Que ton nom,", changed to `text`. */
async function plan(text: string): Promise<WorkspaceReplacement & { cloud: boolean; box: number }> {
  const document = await documentNamed("Song");
  const planned = await readForPlanning(ws, document);
  const { doc } = openPresentation(planned.bytes);
  const box = doc!.textBoxes.find((b) => b.lines[0]?.text === "Que ton nom,")!.boxIndex;
  const fixes: LineFix[] = planLineEdits(doc!, [{ boxIndex: box, lineIndex: 0, text }]);
  return { path: document.path, documentId: document.id, sha256: planned.sha256, fixes, cloud: planned.cloud, box };
}

const write = async (replacements: WorkspaceReplacement[]) =>
  writeWorkspaceEdits(ws, [root], await openBackupDir(path.join(tmp, "Backups"), [root]), replacements);

const message = (p: Promise<unknown>) =>
  p.then(
    () => "",
    (e: Error) => e.message
  );

suite("the one Cloud workspace named for #55's experiments", () => {
  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-workspace-cloud-")));
    root = createWritableWorkspace(tmp, { cloud: true });
    fs.writeFileSync(path.join(root, "imprint.cloud"), "{}");
    registry = path.join(tmp, "Workspaces", REGISTRY);
    putPresentation(root, "Song", presentationRoot());
    [root] = await openRoots([root]);
    ws = (await workspaceAt(root))!;
  });

  afterEach(async () => {
    await allowCloudWorkspace(undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("is refused without the opt-in, at plan time and at apply time", async () => {
    expect(await message(readForPlanning(ws, await documentNamed("Song")))).toBe(CLOUD_REFUSED);
    const document = await documentNamed("Song");
    const before = rows();
    expect(await message(write([{ path: document.path, documentId: document.id, sha256: "", fixes: [{} as LineFix] }]))).toBe(
      CLOUD_REFUSED
    );
    expect(rows()).toEqual(before);
  });

  it("is refused when the opt-in names another Cloud workspace", async () => {
    // A second Cloud workspace in the same registry, which the opt-in names instead.
    const db = new sqlite!.DatabaseSync(registry);
    db.prepare("INSERT INTO workspaces VALUES (?, ?, 'Other', 'cloud-2', '22.9.0', 'local')").run(OTHER, path.join(tmp, "Workspaces", OTHER));
    db.close();
    await allowCloudWorkspace(OTHER, registry);
    expect(allowedCloudWorkspace()).toBe(OTHER);
    expect(await message(readForPlanning(ws, await documentNamed("Song")))).toBe(CLOUD_REFUSED);
  });

  it("is written to when the opt-in names it, and says it is Cloud", async () => {
    await allowCloudWorkspace(UUID, registry);
    const edit = await plan("Que ton nom");
    expect(edit.cloud).toBe(true);
    const run = await write([edit]);
    expect(run.outcomes.map((o) => [o.written, o.reason])).toEqual([[true, undefined]]);
    const { doc } = openPresentation((await readForPlanning(ws, await documentNamed("Song"))).bytes);
    expect(doc!.textBoxes[edit.box].lines[0].text).toBe("Que ton nom");
    // Guard 2 as ever: the row as it was is in the backup folder.
    expect(fs.readdirSync(path.join(tmp, "Backups"))).toHaveLength(1);
  });

  it("still refuses a document with no snapshot (availability 1)", async () => {
    await allowCloudWorkspace(UUID, registry);
    const edit = await plan("Que ton nom");
    // Listed but not downloaded, as a Cloud document can be.
    const db = new sqlite!.DatabaseSync(storeOf(root));
    db.exec("UPDATE workspace_streams SET availability = 1, snapshot = NULL, sha256 = NULL, version_vector = NULL, byte_count = 0");
    db.close();
    const before = rows();
    const run = await write([edit]);
    expect(run.outcomes.map((o) => [o.written, o.reason])).toEqual([[false, "stale"]]);
    expect(rows()).toEqual(before);
    expect(await message(readForPlanning(ws, await documentNamed("Song")))).toMatch(/no longer in the workspace/);
  });

  it("still checks the format of the one it names", async () => {
    const db = new sqlite!.DatabaseSync(registry);
    db.prepare("UPDATE workspaces SET schema_version = '22.10.0'").run();
    db.close();
    await allowCloudWorkspace(UUID, registry);
    expect(await message(readForPlanning(ws, await documentNamed("Song")))).toMatch(/format is 22\.10\.0/);
  });

  it("fails at start for a uuid the registry does not list, one that is not Cloud, or not a uuid", async () => {
    await expect(allowCloudWorkspace(OTHER, registry)).rejects.toThrow(/lists no workspace with that uuid/);
    const db = new sqlite!.DatabaseSync(registry);
    db.prepare("UPDATE workspaces SET cloud_uuid = NULL").run();
    db.close();
    await expect(allowCloudWorkspace(UUID, registry)).rejects.toThrow(/not a Cloud workspace/);
    await expect(allowCloudWorkspace("Sebi test cloud", registry)).rejects.toThrow(/takes a workspace's uuid/);
    await expect(allowCloudWorkspace(UUID, path.join(tmp, "nowhere.sqlite3"))).rejects.toThrow(/no ProPresenter 22 registry/);
    expect(allowedCloudWorkspace()).toBeUndefined();
  });
});
