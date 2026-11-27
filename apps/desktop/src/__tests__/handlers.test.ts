import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChosenFile, DesktopBridge } from "@presenter-garage/core/lib/desktop";
import { examine, planFixes } from "@presenter-garage/core/lib/fixes";
import type { TextIssueKind } from "@presenter-garage/core/lib/presentation";
import { syntheticMacrosFile, syntheticTextPresentation } from "@presenter-garage/core/lib/__tests__/synthetic";
import { sqlite, storeOf } from "@presenter-garage/node/__tests__/workspace-db";
import { createWritableWorkspace, presentationRoot, putPresentation } from "@presenter-garage/node/__tests__/workspace-writable";
import { CHANNELS } from "../channels";
import { createHandlers } from "../handlers";

/**
 * The main process's half of the desktop app, against real files in a
 * temporary folder: what the page can read, and the one call that writes,
 * with each of the four guards in AGENTS.md shown to hold on it. A test here
 * fails if a guard is skipped.
 */

/**
 * Guard 1's verdict, made to say `lossy` where a test asks, since no real
 * file the suite can build is: for the bytes `lossy` picks out, given the
 * call's number since `calls` was last reset, so a test can let planning and
 * one of applying's two checks pass and see the other refuse; and, for guard 4, a write that also changes a
 * box nobody chose, as an encoder that went wrong would.
 */
const gate = vi.hoisted(() => ({ lossy: undefined as ((bytes: Uint8Array, call: number) => boolean) | undefined, calls: 0, tamper: undefined as { boxIndex: number; rtf: string } | undefined }));
vi.mock("@presenter-garage/core/lib/presentation", async (original) => {
  const actual = await original<typeof import("@presenter-garage/core/lib/presentation")>();
  return {
    ...actual,
    checkPresentationFidelity: (bytes: Uint8Array) =>
 gate.lossy?.(bytes, ++gate.calls)
        ? { ...actual.checkPresentationFidelity(bytes), fidelity: "lossy", exportSafe: false }
        : actual.checkPresentationFidelity(bytes),
    writeTextBoxes: (...[doc, replacements]: Parameters<typeof actual.writeTextBoxes>) => {
      actual.writeTextBoxes(doc, replacements);
      if (gate.tamper) actual.writeTextBoxes(doc, new Map([[gate.tamper.boxIndex, gate.tamper.rtf]]));
    },
  };
});

const KINDS: TextIssueKind[] = ["leadingSpace", "trailingSpace", "blankLine", "repeatedSpace"];

let tmp: string;
let library: string;
let backups: string;
let shown: string[];
let bridge: ReturnType<typeof createHandlers>;

function song(name: string, bytes = syntheticTextPresentation(name)): string {
  const file = path.join(library, "Libraries", "Default", `${name}.pro`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return fs.realpathSync(file);
}

/** Every fix the page would show for a file, ticked, as the page sends them. */
async function chosen(file: string, pick: (lines: ChosenFile["lines"]) => ChosenFile["lines"] = (l) => l): Promise<ChosenFile> {
  const { bytes, sha256 } = await bridge.read(file);
  const { report, fixable } = examine(file, bytes);
  const fixes = planFixes(fixable, report.issues.filter((issue) => KINDS.includes(issue.kind)));
  const lines = fixes.map(({ boxIndex, lineIndex, before, after }) => ({ boxIndex, lineIndex, before, after }));
  return { path: file, sha256, kinds: KINDS, lines: pick(lines) };
}

/** The lines each box reads, as the page would show them. */
const textOf = (bytes: Uint8Array) => {
  const { report } = examine("x", bytes);
  return report.issues.map((issue) => `${issue.boxIndex}:${issue.lineIndex}:${issue.kind}`);
};

/** Whether this machine lets the suite make links: Windows needs Developer Mode or the privilege. */
const canSymlink = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "pg-desktop-probe-"));
  try {
    fs.symlinkSync(probe, path.join(probe, "link"));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

const make = (dir = backups) =>
  createHandlers({
    chooseFolder: async () => (shown.length > 0 ? shown.shift() : undefined),
    showFolder: async () => undefined,
    stateFile: path.join(tmp, "state.json"),
    backupDir: dir,
    workspacesDir: path.join(tmp, "Workspaces"),
    rulesDirs: [path.join(tmp, "Rules")],
  });

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pg-desktop-")));
  library = path.join(tmp, "ProPresenter");
  backups = path.join(tmp, "Backups");
  shown = [];
  gate.lossy = undefined;
  gate.calls = 0;
  gate.tamper = undefined;
  bridge = make();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the bridge", () => {
  it("answers exactly the calls the preload exposes, and has no call that writes bytes", () => {
    expect(Object.keys(bridge).sort()).toEqual([...CHANNELS].sort());
    // `applyFixes` is the one way to change anything; nothing takes bytes or a destination.
    const writers = CHANNELS.filter((c) => /write|save|copy|move|rename|delete|remove|put/i.test(c));
    expect(writers).toEqual([]);
    const methods: (keyof DesktopBridge)[] = [...CHANNELS];
    expect(methods).toContain("applyFixes");
  });
});

describe("a folder of .pro files", () => {
  it("lists every presentation with its real path, and the path inside the folder", async () => {
    const file = song("Checked Song");
    shown.push(library);
    const folder = (await bridge.pickFolder())!;
    expect(folder.root).toBe(fs.realpathSync(library));
    expect(folder.workspace).toBeUndefined();
    expect(folder.files).toEqual([{ path: file, relative: "Libraries/Default/Checked Song.pro", name: "Checked Song.pro" }]);
  });

  it("reads nothing outside the folder that is open, and nothing before one is", async () => {
    const file = song("Checked Song");
    await expect(bridge.read(file)).rejects.toThrow();
    shown.push(path.join(library, "Libraries"));
    await bridge.pickFolder();
    const outside = path.join(tmp, "Secret.pro");
    fs.writeFileSync(outside, "x");
    await expect(bridge.read(outside)).rejects.toThrow();
    await expect(bridge.read(path.join(library, "Libraries", "..", "..", "Secret.pro"))).rejects.toThrow();
    // Inside the folder, only the presentations it listed: not whatever else is kept beside them.
    const beside = path.join(fs.realpathSync(library), "Libraries", "Default", "private.txt");
    fs.writeFileSync(beside, "x");
    await expect(bridge.read(beside)).rejects.toThrow();
    await expect(bridge.read(file)).resolves.toBeDefined();
  });

  it.skipIf(!canSymlink)("follows no link out of the folder, nor one put in place of a listed file", async () => {
    const file = song("Checked Song");
    shown.push(path.join(library, "Libraries"));
    await bridge.pickFolder();
    const outside = path.join(tmp, "Secret.pro");
    fs.writeFileSync(outside, "x");
    // A link inside the folder that points out of it is not followed.
    fs.symlinkSync(outside, path.join(library, "Libraries", "Default", "Link.pro"));
    await expect(bridge.read(path.join(library, "Libraries", "Default", "Link.pro"))).rejects.toThrow();
    // Nor through a listed file replaced, since the folder was opened, by a link to something it did not list.
    const beside = path.join(fs.realpathSync(library), "Libraries", "Default", "private.txt");
    fs.writeFileSync(beside, "x");
    fs.rmSync(file);
    fs.symlinkSync(beside, file);
    await expect(bridge.read(file)).rejects.toThrow();
  });

  it.skipIf(!canSymlink)("refuses as stale a file replaced, since it was shown, by a link to another song", async () => {
    // The same bytes, so neither the hash nor the lines tell them apart: only where the path now leads.
    const shownSong = song("Shown Song", syntheticTextPresentation("Same"));
    const other = song("Other Song", syntheticTextPresentation("Same"));
    const before = fs.readFileSync(other);
    shown.push(library);
    await bridge.pickFolder();
    const choice = await chosen(shownSong);
    fs.rmSync(shownSong);
    fs.symlinkSync(other, shownSong);

    const run = await bridge.applyFixes([choice]);

    expect(run.files).toEqual([expect.objectContaining({ path: shownSong, written: false, reason: "stale" })]);
    expect(fs.readFileSync(other)).toEqual(before);
  });

  it("opens a folder chosen in a dialog that was up when the last one was forgotten", async () => {
    song("Checked Song");
    let answer: (dir: string) => void = () => {};
    bridge = createHandlers({
      chooseFolder: () => new Promise<string>((resolve) => (answer = resolve)),
      showFolder: async () => undefined,
      stateFile: path.join(tmp, "state.json"),
      backupDir: backups,
      workspacesDir: path.join(tmp, "Workspaces"),
    });
    const picking = bridge.pickFolder();
    await bridge.forgetLast();
    answer(library);

    const folder = (await picking)!;
    expect(folder.root).toBe(fs.realpathSync(library));
    await expect(bridge.read(folder.files[0].path)).resolves.toBeDefined();
  });

  it.skipIf(!sqlite)("keeps a workspace opened while the folder dialog was still up", async () => {
    putPresentation(createWritableWorkspace(tmp), "Checked Song", presentationRoot(() => []));
    song("Checked Song");
    let answer: (dir: string) => void = () => {};
    bridge = createHandlers({
      chooseFolder: () => new Promise<string>((resolve) => (answer = resolve)),
      showFolder: async () => undefined,
      stateFile: path.join(tmp, "state.json"),
      backupDir: backups,
      workspacesDir: path.join(tmp, "Workspaces"),
    });
    const picking = bridge.pickFolder();
    const [workspace] = await bridge.workspaces();
    const opened = await bridge.openWorkspace(workspace.root);

    const refused = expect(picking).rejects.toThrow();
    answer(library);
    await refused;
    await expect(bridge.read(opened.files[0].path)).resolves.toBeDefined();
  });

  it("leaves a folder closed that was forgotten while it was still opening", async () => {
    const file = song("Checked Song");
    shown.push(library);
    const opening = bridge.pickFolder();
    // Let the open reach its walk of the folder, which waits on the disk.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // Watched before the forget: the open can give up while the forget is still saving.
    const refused = expect(opening).rejects.toThrow();
    await bridge.forgetLast();

    await refused;
    await expect(bridge.read(file)).rejects.toThrow();
    expect(JSON.parse(fs.readFileSync(path.join(tmp, "state.json"), "utf8"))).toEqual({});
    expect(await make().reopenLast()).toBeNull();
  });

  it("backs up each file before changing it, writes the ticked lines, and reads them back", async () => {
    const file = song("Checked Song");
    const original = fs.readFileSync(file);
    shown.push(library);
    await bridge.pickFolder();
    const choice = await chosen(file);
    expect(choice.lines.length).toBeGreaterThan(0);

    const run = await bridge.applyFixes([choice]);

    expect(run.refused).toBeUndefined();
    expect(run.files).toEqual([expect.objectContaining({ path: file, written: true, lines: choice.lines.length })]);
    // Guard 2: the copy is the file exactly as it was.
    expect(fs.readFileSync(run.files[0].backup!)).toEqual(original);
    expect(run.backupFolder && run.files[0].backup!.startsWith(run.backupFolder)).toBe(true);
    // Guard 4 ran inside the write; here, what it promised is what is on disk.
    const after = new Uint8Array(fs.readFileSync(file));
    expect(textOf(after).filter((issue) => KINDS.some((k) => issue.endsWith(k)))).toEqual([]);
  });

  it("writes nothing when the result does not read back as promised, even in a box nobody chose", async () => {
    const file = song("Checked Song");
    const original = fs.readFileSync(file);
    shown.push(library);
    await bridge.pickFolder();
    const choice = await chosen(file);
    const ticked = choice.lines[0].boxIndex;
    const boxes = examine(file, new Uint8Array(original)).fixable.textBoxes;
    const other = boxes.find((box) => box.boxIndex !== ticked && box.rtf !== boxes.find((b) => b.boxIndex === ticked)!.rtf)!;
    // Box `other` is not among the ticked lines; the write changes it anyway.
    gate.tamper = { boxIndex: other.boxIndex, rtf: boxes.find((b) => b.boxIndex === ticked)!.rtf };

    const run = await bridge.applyFixes([{ ...choice, lines: choice.lines.filter((line) => line.boxIndex === ticked) }]);

    expect(run.files).toEqual([expect.objectContaining({ path: file, written: false, reason: "verifyFailed" })]);
    expect(fs.readFileSync(file)).toEqual(original);
  });

  it("changes only the lines the person left ticked", async () => {
    const file = song("Checked Song");
    shown.push(library);
    await bridge.pickFolder();
    const all = await chosen(file);
    expect(all.lines.length).toBeGreaterThan(1);
    const [first, ...rest] = all.lines;

    const run = await bridge.applyFixes([{ ...all, lines: [first] }]);
    expect(run.files[0].written).toBe(true);

    // Every other line is offered again, exactly as before.
    const again = await chosen(file);
    expect(again.lines).toEqual(rest);
  });

  it("leaves alone a file that changed since the page read it", async () => {
    const file = song("Checked Song");
    shown.push(library);
    await bridge.pickFolder();
    const choice = await chosen(file);
    fs.writeFileSync(file, syntheticTextPresentation("Renamed In ProPresenter"));
    const before = fs.readFileSync(file);

    const run = await bridge.applyFixes([choice]);

    expect(run.files).toEqual([expect.objectContaining({ written: false, reason: "stale" })]);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(run.backupFolder).toBeUndefined();
  });

  it("writes nothing the person was not shown (guard 3)", async () => {
    const file = song("Checked Song");
    const before = fs.readFileSync(file);
    shown.push(library);
    await bridge.pickFolder();
    const choice = await chosen(file);
    const tampered = { ...choice, lines: [{ ...choice.lines[0], after: "Something else entirely" }, ...choice.lines.slice(1)] };

    const run = await bridge.applyFixes([tampered]);

    expect(run.files).toEqual([expect.objectContaining({ written: false, reason: "stale" })]);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("refuses, file by file, what cannot be planned, and writes the rest", async () => {
    const file = song("Checked Song");
    const other = song("Other Song");
    const third = song("Third Song");
    const before = fs.readFileSync(other);
    shown.push(library);
    await bridge.pickFolder();
    const good = await chosen(file);
    const twice = await chosen(other, (lines) => [lines[0], lines[0]]);
    const outside = { ...good, path: path.join(tmp, "Elsewhere.pro") };
    const none = { ...(await chosen(third)), lines: [] };
    // The same file again, spelled another way: one backup and one write per file.
    const again = { ...good, path: `${path.dirname(file)}${path.sep}.${path.sep}${path.basename(file)}` };

    const run = await bridge.applyFixes([good, twice, outside, none, again]);

    expect(run.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: file, written: true }),
        // A line sent twice is not written twice; the file is left alone.
        expect.objectContaining({ path: other, written: false, reason: "stale" }),
        expect.objectContaining({ path: outside.path, written: false, reason: "unreadable" }),
        expect.objectContaining({ path: third, written: false, reason: "unchanged" }),
        expect.objectContaining({ path: again.path, written: false, reason: "stale" }),
      ])
    );
    expect(run.files.filter((outcome) => outcome.written)).toHaveLength(1);
    expect(fs.readFileSync(other)).toEqual(before);
    // Nothing the page is told carries the server's English.
    for (const outcome of run.files) expect(outcome).not.toHaveProperty("detail");
  });

  it("refuses a file the fidelity gate rates lossy when planned (guard 1)", async () => {
    const file = song("Checked Song");
    const before = fs.readFileSync(file);
    shown.push(library);
    await bridge.pickFolder();
    const choice = await chosen(file);
    gate.lossy = () => true;

    const run = await bridge.applyFixes([choice]);

    expect(run.files).toEqual([expect.objectContaining({ written: false, reason: "lossy" })]);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  // Planning checks the file as read (call 1); applying checks it as read again, then as it would be written.
  const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;
  it.each([
    ["as read", (before: Buffer) => (bytes: Uint8Array, call: number) => call > 1 && same(bytes, before)],
    ["as written", (before: Buffer) => (bytes: Uint8Array) => !same(bytes, before)],
  ])("refuses a file the fidelity gate rates lossy only when applied, %s (guard 1)", async (_, lossy) => {
    const file = song("Checked Song");
    const before = fs.readFileSync(file);
    shown.push(library);
    await bridge.pickFolder();
    const choice = await chosen(file);
    gate.calls = 0;
    gate.lossy = lossy(before);

    const run = await bridge.applyFixes([choice]);

    expect(run.files).toEqual([expect.objectContaining({ written: false, reason: "lossy" })]);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("refuses a file that no longer decodes as unreadable, and saves the rest", async () => {
    const broken = song("Broken Song");
    const fine = song("Fine Song");
    shown.push(library);
    await bridge.pickFolder();
    const choices = [await chosen(broken), await chosen(fine)];
    fs.writeFileSync(broken, Uint8Array.from([0xff, 0xff, 0xff, 0xff]));

    const run = await bridge.applyFixes(choices);

    expect(run.refused).toBeUndefined();
    expect(run.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: broken, written: false, reason: "unreadable" }),
        expect.objectContaining({ path: fine, written: true }),
      ])
    );
  });

  it("writes nothing when no backup can be made (guard 2)", async () => {
    const file = song("Checked Song");
    const before = fs.readFileSync(file);
    // A backup folder inside the library is refused before anything is copied.
    bridge = make(path.join(library, "Backups"));
    shown.push(library);
    await bridge.pickFolder();

    const run = await bridge.applyFixes([await chosen(file)]);

    expect(run.refused?.code).toBe("failed");
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("changes nothing when one backup copy fails after another was made (guard 2)", async () => {
    const first = song("First Song");
    const second = song("Second Song");
    const before = [fs.readFileSync(first), fs.readFileSync(second)];
    shown.push(library);
    await bridge.pickFolder();
    const choices = [await chosen(first), await chosen(second)];
    const open = fsp.open.bind(fsp);
    vi.spyOn(fsp, "open").mockImplementation(async (p, ...rest) => {
      const file = String(p);
      if (file.startsWith(backups) && file.endsWith("Second Song.pro")) throw new Error("disk full");
      return open(p, ...rest);
    });

    const run = await bridge.applyFixes(choices);

    expect(run.files).toEqual([
      expect.objectContaining({ path: first, written: false, reason: "backupFailed" }),
      expect.objectContaining({ path: second, written: false, reason: "backupFailed" }),
    ]);
    expect([fs.readFileSync(first), fs.readFileSync(second)]).toEqual(before);
  });

  it("opens only backup folders its own runs made", async () => {
    const file = song("Checked Song");
    const opened: string[] = [];
    bridge = createHandlers({
      chooseFolder: async () => library,
      showFolder: async (dir) => void opened.push(dir),
      stateFile: path.join(tmp, "state.json"),
      backupDir: backups,
    });
    await expect(bridge.showBackups(tmp)).rejects.toThrow();
    await bridge.pickFolder();
    const run = await bridge.applyFixes([await chosen(file)]);
    await bridge.showBackups(run.backupFolder!);
    expect(opened).toEqual([run.backupFolder]);
  });

  it("reopens the folder from last time, until it is forgotten", async () => {
    song("Checked Song");
    shown.push(library);
    await bridge.pickFolder();
    expect((await make().reopenLast())?.root).toBe(fs.realpathSync(library));
    await bridge.forgetLast();
    expect(await make().reopenLast()).toBeNull();
  });

  it("refuses lines sent in a shape it does not know", async () => {
    shown.push(library);
    song("Checked Song");
    await bridge.pickFolder();
    await expect(bridge.applyFixes([{ path: 1 } as never])).rejects.toThrow();
  });
});

describe.skipIf(!sqlite)("a ProPresenter 22 workspace", () => {
  let root: string;

  const store = () => fs.readFileSync(storeOf(root));

  beforeEach(() => {
    root = createWritableWorkspace(tmp);
    // No formatting ranges: those have their own suite in packages/node.
    putPresentation(root, "Checked Song", presentationRoot(() => []));
  });

  it("is offered from ProPresenter's registry, and nothing else can be opened by path", async () => {
    const listed = await bridge.workspaces();
    expect(listed).toEqual([{ root, name: "Church", active: false, cloud: false }]);
    await expect(bridge.openWorkspace(library)).rejects.toThrow();

    const folder = await bridge.openWorkspace(root);
    expect(folder.workspace).toEqual({ name: "Church", cloud: false });
    expect(folder.files.map((f) => f.relative)).toEqual(["Libraries/Default/Checked Song.pro"]);
  });

  it("lets no workspace open replace the folder on screen once the dialog has been asked for", async () => {
    const file = song("Checked Song");
    shown.push(library);
    await bridge.pickFolder();

    // The workspace is still being looked up when the dialog is opened, then dismissed.
    const opening = bridge.openWorkspace(root);
    const refused = expect(opening).rejects.toThrow();
    expect(await bridge.pickFolder()).toBeNull();
    await refused;

    await expect(bridge.read(file)).resolves.toBeDefined();
  });

  it("stays closed when forgotten while the registry was still being asked", async () => {
    const opening = bridge.openWorkspace(root);
    const refused = expect(opening).rejects.toThrow();
    await bridge.forgetLast();

    await refused;
    expect(JSON.parse(fs.readFileSync(path.join(tmp, "state.json"), "utf8"))).toEqual({});
    expect(await make().reopenLast()).toBeNull();
  });

  it("writes the ticked lines into the database, with a backup of the rows first", async () => {
    const folder = await bridge.openWorkspace(root);
    const file = folder.files[0].path;
    const choice = await chosen(file);

    const run = await bridge.applyFixes([choice]);

    expect(run.refused).toBeUndefined();
    expect(run.files).toEqual([expect.objectContaining({ path: file, written: true })]);
    expect(fs.existsSync(run.files[0].backup!)).toBe(true);
    // Read back as the page would read it again.
    const { report } = examine(file, (await bridge.read(file)).bytes);
    expect(report.issues.filter((issue) => KINDS.includes(issue.kind))).toEqual([]);
  });

  it("writes nothing while ProPresenter has the workspace open", async () => {
    const folder = await bridge.openWorkspace(root);
    const choice = await chosen(folder.files[0].path);
    const before = store();
    const other = new sqlite!.DatabaseSync(storeOf(root));
    other.prepare("SELECT count(*) FROM workspace_streams").get();
    try {
      const run = await bridge.applyFixes([choice]);
      expect(run.refused?.code).toBe("propresenterOpen");
      expect(run.files).toEqual([]);
    } finally {
      other.close();
    }
    expect(store()).toEqual(before);
  });

  it("treats a workspace carrying Cloud's marker as Cloud, whatever the registry says", async () => {
    fs.writeFileSync(path.join(root, "imprint.cloud"), "");
    expect((await bridge.openWorkspace(root)).workspace?.cloud).toBe(true);
  });

  it("writes to a Cloud workspace a document Cloud has caught up with", async () => {
    fs.rmSync(path.join(tmp, "Workspaces"), { recursive: true });
    root = createWritableWorkspace(tmp, { cloud: true });
    putPresentation(root, "Song", presentationRoot(), { lastShared: "synced" });
    const folder = await bridge.openWorkspace(root);
    expect(folder.workspace?.cloud).toBe(true);
    const file = folder.files[0].path;

    const run = await bridge.applyFixes([await chosen(file)]);

    expect(run.refused).toBeUndefined();
    expect(run.files).toEqual([expect.objectContaining({ path: file, written: true })]);
    const { report } = examine(file, (await bridge.read(file)).bytes);
    expect(report.issues.filter((issue) => KINDS.includes(issue.kind))).toEqual([]);
  });

  it("refuses as stale a workspace that has turned Cloud since the page showed it without the warning", async () => {
    putPresentation(root, "Song", presentationRoot(), { lastShared: "synced" });
    const folder = await bridge.openWorkspace(root);
    expect(folder.workspace?.cloud).toBe(false);
    const choice = await chosen(folder.files.find((f) => f.name === "Song.pro")!.path);
    fs.writeFileSync(path.join(root, "imprint.cloud"), "");
    const before = store();

    const run = await bridge.applyFixes([choice]);

    expect(run.files).toEqual([expect.objectContaining({ written: false, reason: "stale" })]);
    expect(store()).toEqual(before);
  });

  it("saves the folder the page still shows while a Cloud workspace is half way through opening", async () => {
    putPresentation(root, "Song", presentationRoot(), { lastShared: "synced" });
    const cloudRoot = createWritableWorkspace(path.join(tmp, "Elsewhere"), { cloud: true });
    putPresentation(cloudRoot, "Song", presentationRoot(), { lastShared: "synced" });
    // Remembering the folder is the open's last wait: held, the open is past its every other check.
    let hold = false;
    let release: () => void = () => {};
    let reached: () => void = () => {};
    const atRemember = new Promise<void>((resolve) => (reached = resolve));
    bridge = createHandlers({
      chooseFolder: async () => cloudRoot,
      showFolder: async () => undefined,
      stateFile: path.join(tmp, "state.json"),
      saveState: () => {
        if (!hold) return Promise.resolve();
        reached();
        return new Promise<void>((resolve) => (release = resolve));
      },
      backupDir: backups,
      workspacesDir: path.join(tmp, "Workspaces"),
    });
    const shownFolder = await bridge.openWorkspace(root);
    expect(shownFolder.workspace?.cloud).toBe(false);
    const choice = await chosen(shownFolder.files.find((f) => f.name === "Song.pro")!.path);

    hold = true;
    const opening = bridge.pickFolder();
    await atRemember;
    // The page still shows the local workspace, with no Cloud warning: the save is of that one.
    const run = await bridge.applyFixes([choice]);
    expect(run.files).toEqual([expect.objectContaining({ path: choice.path, written: true })]);

    release();
    const cloudFolder = await opening;
    expect(cloudFolder.workspace?.cloud).toBe(true);
    // And once it has opened, the Cloud workspace is the open one.
    await expect(bridge.read(choice.path)).rejects.toThrow(/Not a presentation in the open folder/);
  });

  it("refuses a Cloud document with changes ProPresenter has not sent, saying why", async () => {
    fs.rmSync(path.join(tmp, "Workspaces"), { recursive: true });
    root = createWritableWorkspace(tmp, { cloud: true });
    putPresentation(root, "Song", presentationRoot(), { lastShared: null, absenceReason: null });
    const folder = await bridge.openWorkspace(root);
    const choice = await chosen(folder.files[0].path);
    const before = store();

    const run = await bridge.applyFixes([choice]);

    expect(run.refused).toBeUndefined();
    expect(run.files).toEqual([expect.objectContaining({ written: false, reason: "unsynced" })]);
    expect(store()).toEqual(before);
  });
});

describe("the team's rules", () => {
  const rulesDir = () => path.join(tmp, "Rules");
  const compiled = { version: 1, rules: [{ id: "commas", check: "trailing-comma", tier: 2 }], exceptions: [] };

  it("reads rules.json and says nothing is stale without a RULES.md", async () => {
    fs.mkdirSync(rulesDir());
    fs.writeFileSync(path.join(rulesDir(), "rules.json"), JSON.stringify(compiled));
    const found = await bridge.loadTeamRules();
    expect(found.set.rules.map((r) => r.id)).toEqual(["commas"]);
    expect(found).toMatchObject({ stale: false, defaulted: false, json: path.join(rulesDir(), "rules.json") });
  });

  it("says when RULES.md has changed since rules.json was compiled, and writes nothing", async () => {
    fs.mkdirSync(rulesDir());
    fs.writeFileSync(path.join(rulesDir(), "RULES.md"), "Pas de virgule.");
    fs.writeFileSync(path.join(rulesDir(), "rules.json"), JSON.stringify(compiled));
    const before = fs.readdirSync(rulesDir()).sort();
    expect(await bridge.loadTeamRules()).toMatchObject({ stale: true, defaulted: false });
    expect(fs.readdirSync(rulesDir()).sort()).toEqual(before);
  });

  it("falls back to the defaults, with no file named, when none is found", async () => {
    const found = await bridge.loadTeamRules();
    expect(found).toMatchObject({ defaulted: true, stale: false });
    expect(found.markdown ?? found.json).toBeUndefined();
  });

  it("reads ProPresenter's configured lists from the folder open, and nothing before one is", async () => {
    expect(await bridge.readConfiguration()).toEqual({ problems: [] });
    song("Checked Song");
    fs.mkdirSync(path.join(library, "Configuration"));
    fs.writeFileSync(path.join(library, "Configuration", "Macros"), syntheticMacrosFile());
    shown.push(library);
    await bridge.pickFolder();
    const config = await bridge.readConfiguration();
    expect(config.macros?.map((m) => m.name)).toEqual(["Bienvenue", "Louange", "Lumières"]);
    expect(config.problems).toEqual(["No configured groups found."]);
  });

  it("refuses a rules.json that does not parse", async () => {
    fs.mkdirSync(rulesDir());
    fs.writeFileSync(path.join(rulesDir(), "rules.json"), "{ not json");
    await expect(bridge.loadTeamRules()).rejects.toThrow(/not JSON/);
  });
});
