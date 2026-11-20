import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syntheticTextPresentation } from "@presenter-garage/core/lib/__tests__/synthetic";
import { applyPlan, planSlideEdits, PlanStore } from "../edits";
import { openRoots } from "../library";
import { sqlite, storeOf } from "./workspace-db";
import { createWritableWorkspace, presentationRoot, putPresentation, UUID } from "./workspace-writable";

/**
 * A plan that spans several roots: AGENTS.md's second guard is for the whole
 * call, so a backup that cannot be made in one root writes nothing in any.
 * Synthetic presentations only.
 */

/**
 * The backup this run cannot make: any copy whose path holds `marker`,
 * inside the backup folder. With `cancel`, that copy is made, and the call
 * is cancelled as it is. `fired` counts the copies it was asked for, so a
 * marker that no longer matches fails the test instead of passing it.
 */
const failing = vi.hoisted(() => ({
  backups: "",
  marker: undefined as string | undefined,
  cancel: undefined as AbortController | undefined,
  fired: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = ((file: Parameters<typeof actual.open>[0], ...rest: unknown[]) => {
    const where = String(file);
    if (failing.marker && where.startsWith(failing.backups) && where.includes(failing.marker)) {
      failing.fired++;
      if (failing.cancel) failing.cancel.abort();
      else return Promise.reject(Object.assign(new Error(`EIO: i/o error, open '${where}'`), { code: "EIO" }));
    }
    return (actual.open as (...args: unknown[]) => ReturnType<typeof actual.open>)(file, ...rest);
  }) as typeof actual.open;
  return { ...actual, open, default: { ...actual, open } };
});

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-apply-roots-")));
  failing.backups = path.join(tmp, "Backups");
  failing.marker = undefined;
  failing.cancel = undefined;
  failing.fired = 0;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Every snapshot in a workspace's store, for telling whether a run changed it. */
function snapshots(root: string): Uint8Array[] {
  const db = new sqlite!.DatabaseSync(storeOf(root), { readOnly: true });
  const all = db.prepare("SELECT snapshot FROM workspace_streams ORDER BY document_id").all() as { snapshot: Uint8Array }[];
  db.close();
  return all.map((row) => row.snapshot);
}

/** A workspace in a folder of its own under `tmp`, holding one song. */
function workspace(name: string): string {
  const root = createWritableWorkspace(path.join(tmp, name));
  putPresentation(root, "Song", presentationRoot());
  return root;
}

/** A plain folder of `.pro` files under `tmp`, holding one song. */
function folder(name: string): string {
  const root = path.join(tmp, name);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "Song.pro"), syntheticTextPresentation());
  return root;
}

const songIn = (root: string) =>
  fs.existsSync(path.join(root, "Song.pro")) ? path.join(root, "Song.pro") : path.join(root, "Libraries", "Default", "Song.pro");

/** Plan the same one-line change to the song in each root, ticked throughout, and apply it. */
async function changeEverySong(roots: string[], signal?: AbortSignal) {
  const store = new PlanStore();
  const planned = await planSlideEdits(
    roots,
    store,
    roots.map((root) => ({ path: songIn(root), boxIndex: 6, lineIndex: 0, text: "Que ton nom" }))
  );
  const plan = store.take(planned.planId)!;
  return applyPlan(roots, plan, new Set(plan.files.flatMap((file) => file.lines.map(({ n }) => n))), failing.backups, signal);
}

describe.skipIf(!sqlite)("a plan that spans several roots", () => {
  it("writes nothing in a workspace when the backup of a .pro file in another root cannot be made", async () => {
    const roots = await openRoots([workspace("Church"), folder("Songs")]);
    const [church, songs] = roots;
    const before = { rows: snapshots(church), file: fs.readFileSync(songIn(songs)) };
    // Workspaces are written first, so the .pro file's is the second group's backup.
    failing.marker = `${path.sep}Songs${path.sep}`;

    const result = await changeEverySong(roots);

    expect(result.files.map((file) => [file.written, file.reason])).toEqual([
      [false, "backupFailed"],
      [false, "backupFailed"],
    ]);
    expect(result.files[0].detail).toMatch(/another file's backup could not be made \(EIO\)/);
    expect(result.files[1].detail).toBe("EIO");
    expect(snapshots(church)).toEqual(before.rows);
    expect(fs.readFileSync(songIn(songs))).toEqual(before.file);
    expect(failing.fired).toBe(1);

    // And the workspace was let go: with nothing failing, the same call writes both.
    failing.marker = undefined;
    const again = await changeEverySong(roots);
    expect(again.files.map((file) => [file.written, file.reason])).toEqual([
      [true, undefined],
      [true, undefined],
    ]);
  });

  it("writes nothing in the first workspace when the second workspace's backup cannot be made", async () => {
    const roots = await openRoots([workspace("First"), workspace("Second")]);
    const before = roots.map(snapshots);
    // Both workspaces are folders named by their uuid, so their backups are told apart by number.
    failing.marker = `${UUID} (2)`;

    const result = await changeEverySong(roots);

    expect(result.files.map((file) => [file.written, file.reason])).toEqual([
      [false, "backupFailed"],
      [false, "backupFailed"],
    ]);
    expect(result.files[0].detail).toMatch(/another file's backup could not be made/);
    expect(roots.map(snapshots)).toEqual(before);
    // The second workspace's three copies: snapshot, columns and conversion.
    expect(failing.fired).toBeGreaterThan(0);

    failing.marker = undefined;
    const again = await changeEverySong(roots);
    expect(again.files.map((file) => file.written)).toEqual([true, true]);
    expect(roots.map(snapshots)).not.toEqual(before);
  });

  it("writes nothing in any root when the call is cancelled while the last backup is made", async () => {
    const roots = await openRoots([workspace("Church"), folder("Songs")]);
    const [church, songs] = roots;
    const before = { rows: snapshots(church), file: fs.readFileSync(songIn(songs)) };
    failing.marker = `${path.sep}Songs${path.sep}`;
    failing.cancel = new AbortController();

    await expect(changeEverySong(roots, failing.cancel.signal)).rejects.toThrow(/cancelled before anything changed, so nothing was written/);
    expect(failing.fired).toBe(1);
    expect(snapshots(church)).toEqual(before.rows);
    expect(fs.readFileSync(songIn(songs))).toEqual(before.file);

    // And the workspace was let go.
    failing.marker = undefined;
    failing.cancel = undefined;
    const again = await changeEverySong(roots);
    expect(again.files.map((file) => file.written)).toEqual([true, true]);
  });
});
