import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LoroDoc } from "loro-crdt/base64";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLibrary, decodeMediaDocument } from "@presenter-garage/core/lib/model";
import { decodePlaylistsDocument } from "@presenter-garage/core/lib/playlists";
import { decodePresentation, openPresentation, readPresentation } from "@presenter-garage/core/lib/presentation";
import {
  SYNTHETIC,
  syntheticMediaFile,
  syntheticPresentationFile,
  syntheticTextPresentation,
  textLines,
} from "@presenter-garage/core/lib/__tests__/synthetic";
import { workspacePlaylists, workspacePresentation } from "@presenter-garage/core/lib/__tests__/workspace-fixtures";
import { presentationFromWorkspace } from "@presenter-garage/core/lib/workspace";
import {
  findMediaBin,
  findPlaylists,
  findPresentations,
  findThemes,
  isFile,
  LibraryError,
  openRoots,
  readFoundFile,
  readLibraryFile,
  resolveFolder,
  resolveInRoots,
  statFoundFile,
} from "../library";
import {
  defaultLibrary,
  folderWorkspaces,
  folderWorkspacesDir,
  openDatabase,
  staleNotes,
  workspacesDir,
  isInWorkspace,
  registeredWorkspaces,
  WORKSPACE_READ_ONLY,
  type RegisteredWorkspace,
} from "../workspace";
import { openBackupDir, replaceWithBackup } from "../write";
import { createWorkspace, MODIFIED, putDocument, sqlite, storeOf } from "./workspace-db";

/**
 * A ProPresenter 22 workspace read through the same functions as a folder of
 * files, against a database built here in the layout a real one was seen to
 * have: `DocumentStore/workspace-v1.sqlite3`, one Loro snapshot per row.
 */

let tmp: string;
let workspace: string;
let roots: string[];

const store = () => storeOf(workspace);
const put = (kind: string, corePath: string | null, root: Record<string, unknown> | null, scope = 0) =>
  putDocument(workspace, kind, corePath, root, scope);

const inWorkspace = (...segments: string[]) => path.join(workspace, ...segments);

beforeEach(async (context) => {
  if (!sqlite) return context.skip();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-workspace-")));
  workspace = path.join(tmp, "Workspaces", "1ca74a0b");
  createWorkspace(workspace);

  put("Presentation", "Default/Amazing Grace", workspacePresentation(syntheticTextPresentation("Amazing Grace")));
  put("Presentation", "Default/Céleste", workspacePresentation(syntheticTextPresentation("Céleste")));
  put("Presentation", "Chants/Gloire", workspacePresentation(syntheticTextPresentation("Gloire")));
  put("PlaylistMedia", null, workspacePlaylists(syntheticMediaFile()));
  put("PlaylistLibrary", null, workspacePlaylists(syntheticPresentationFile()));
  // Which folders are expanded, on this computer: never the document itself.
  put("PlaylistLibrary", null, { node_states: {}, type: 1 }, 1);
  put("Theme", "Lyric Styles/White Box/Theme", { slides: [{ name: "Lyrics", base_slide: { uuid: "s-1", elements: [] } }] });
  put("Stage", null, { layouts: [] });

  roots = await openRoots([workspace]);
});

afterEach(() => tmp && fs.rmSync(tmp, { recursive: true, force: true }));

describe("a workspace as a library", () => {
  it("lists its presentations at the paths their files used to have", async () => {
    const { files, truncated } = await findPresentations(roots);
    expect(truncated).toBe(false);
    expect(files).toEqual([
      inWorkspace("Libraries", "Chants", "Gloire.pro"),
      inWorkspace("Libraries", "Default", "Amazing Grace.pro"),
      inWorkspace("Libraries", "Default", "Céleste.pro"),
    ]);
  });

  it("lists only what is under a folder", async () => {
    const folder = await resolveFolder(roots, "Libraries/Default");
    expect((await findPresentations([folder])).files.map((f) => path.basename(f))).toEqual(["Amazing Grace.pro", "Céleste.pro"]);
  });

  it("reads a presentation as the bytes its file would have held", async () => {
    const { bytes, size, modified } = await readFoundFile(inWorkspace("Libraries", "Default", "Amazing Grace.pro"));
    expect(size).toBe(bytes.length);
    expect(modified).toEqual(new Date(MODIFIED));
    expect(openPresentation(bytes).doc?.name).toBe("Amazing Grace");
    expect(textLines(bytes)).toEqual(textLines(syntheticTextPresentation("Amazing Grace")));
  });

  it("finds a document whatever the case or accent composition of the path", async () => {
    const canonical = inWorkspace("Libraries", "Default", "Céleste.pro");
    expect(await resolveInRoots(roots, "libraries/default/CÉLESTE.pro")).toBe(canonical);
    expect(await resolveInRoots(roots, inWorkspace("Libraries", "Default", "Céleste.pro".normalize("NFD")))).toBe(canonical);
    expect((await readLibraryFile(roots, "Libraries/Default/Céleste.pro")).path).toBe(canonical);
  });

  it("tells a document from a folder of them", async () => {
    expect(await isFile(inWorkspace("Libraries", "Default", "Céleste.pro"))).toBe(true);
    expect(await isFile(inWorkspace("Libraries", "Default"))).toBe(false);
    await expect(resolveFolder(roots, "Libraries/Default/Céleste.pro")).rejects.toThrow("Not a folder");
  });

  it("does not find what is not there", async () => {
    await expect(resolveInRoots(roots, "Libraries/Default/Missing.pro")).rejects.toThrow(LibraryError);
    await expect(resolveInRoots(roots, "../outside.pro")).rejects.toThrow(LibraryError);
  });

  it("gives a size and date without the caller reading the document", async () => {
    const stat = await statFoundFile(inWorkspace("Libraries", "Chants", "Gloire.pro"));
    expect(stat?.modified).toEqual(new Date(MODIFIED));
    expect(stat?.size).toBeGreaterThan(0);
  });

  it("finds the media bin and the playlists where they used to be", async () => {
    const media = await findMediaBin(roots);
    expect(media).toBe(inWorkspace("Playlists", "Media"));
    expect(buildLibrary(decodeMediaDocument((await readFoundFile(media!)).bytes)).items).toHaveLength(SYNTHETIC.items);

    const playlists = await findPlaylists(roots);
    expect(playlists).toBe(inWorkspace("Playlists", "Library"));
    // The shared document, not the per-computer one stored beside it.
    expect(decodePlaylistsDocument((await readFoundFile(playlists!)).bytes).root_node).toBeTruthy();
  });

  it("lists themes under the names ProPresenter shows", async () => {
    expect(await findThemes(roots)).toEqual([
      { name: "Lyric Styles/White Box", file: inWorkspace("Themes", "Lyric Styles", "White Box", "Theme") },
    ]);
  });

  it("sees what ProPresenter saved since the last read", async () => {
    expect((await findPresentations(roots)).files).toHaveLength(3);
    put("Presentation", "Default/New Song", workspacePresentation(syntheticTextPresentation("New Song")));
    expect((await findPresentations(roots)).files).toHaveLength(4);
    expect(openPresentation((await readLibraryFile(roots, "Libraries/Default/New Song.pro")).bytes).doc?.name).toBe("New Song");
  });

  it("says a Cloud document is not downloaded rather than that it is empty", async () => {
    put("Presentation", "Default/Elsewhere", null);
    const file = inWorkspace("Libraries", "Default", "Elsewhere.pro");
    expect((await findPresentations(roots)).files).toContain(file);
    expect(await statFoundFile(file)).toBeUndefined();
    await expect(readFoundFile(file)).rejects.toThrow("not downloaded");
  });

  it("reports a snapshot it cannot read as that document's problem", async () => {
    const db = new sqlite!.DatabaseSync(store());
    db.prepare("UPDATE workspace_streams SET snapshot = ?, sha256 = ? WHERE core_path = ?").run(
      new Uint8Array([1, 2, 3]),
      new Uint8Array(32).fill(250),
      "Chants/Gloire"
    );
    db.close();
    await expect(readFoundFile(inWorkspace("Libraries", "Chants", "Gloire.pro"))).rejects.toThrow(LibraryError);
    expect((await readFoundFile(inWorkspace("Libraries", "Default", "Céleste.pro"))).bytes.length).toBeGreaterThan(0);
  });

  it("reports a database it cannot read as a problem to act on, not a crash", async () => {
    // Appended to, as ProPresenter's write-ahead log is, so the list is read again.
    fs.writeFileSync(store(), "no longer a database");
    await expect(findPresentations(roots)).rejects.toThrow(LibraryError);
    await expect(findPresentations(roots)).rejects.toThrow(store());
  });

  it("leaves no file behind in a workspace ProPresenter has closed", async () => {
    // A database in WAL mode, closed cleanly: just the one file, as ProPresenter leaves it.
    const db = new sqlite!.DatabaseSync(store());
    db.exec("PRAGMA journal_mode = WAL");
    db.close();
    const before = fs.readdirSync(path.dirname(store()));
    expect(before).toEqual(["workspace-v1.sqlite3"]);

    expect((await findPresentations(roots)).files).toHaveLength(3);
    await readFoundFile(inWorkspace("Libraries", "Chants", "Gloire.pro"));
    expect(fs.readdirSync(path.dirname(store()))).toEqual(before);
  });

  it("reads beside ProPresenter while it has the database open", async () => {
    const running = new sqlite!.DatabaseSync(store());
    running.exec("PRAGMA journal_mode = WAL");
    running.exec("UPDATE workspace_streams SET core_path = 'Default/Renamed' WHERE core_path = 'Default/Amazing Grace'");
    // The rename is in the log, not yet in the database file.
    expect(fs.statSync(`${store()}-wal`).size).toBeGreaterThan(0);
    expect((await findPresentations(roots)).files).toContain(inWorkspace("Libraries", "Default", "Renamed.pro"));
    running.close();
  });

  it("finds a document by a path written with backslashes", async () => {
    expect(await resolveInRoots(roots, "Libraries\\Default\\Amazing Grace.pro")).toBe(
      inWorkspace("Libraries", "Default", "Amazing Grace.pro")
    );
  });

  it("still reads the real files a workspace holds", async () => {
    fs.mkdirSync(inWorkspace("Media", "Assets"), { recursive: true });
    fs.writeFileSync(inWorkspace("Media", "Assets", "loop.mov"), "not a film");
    expect((await readLibraryFile(roots, "Media/Assets/loop.mov")).bytes.length).toBe(10);
  });
});

describe("a workspace is never written", () => {
  it("knows a path inside one", async () => {
    expect(await isInWorkspace(inWorkspace("Libraries", "Default", "Céleste.pro"))).toBe(true);
    expect(await isInWorkspace(path.join(tmp, "elsewhere.pro"))).toBe(false);
  });

  it("refuses to replace a document before backing anything up", async () => {
    const file = inWorkspace("Libraries", "Default", "Céleste.pro");
    const { bytes } = await readFoundFile(file);
    const backups = await openBackupDir(path.join(tmp, "Backups"), roots);
    await expect(replaceWithBackup(roots, backups, [{ path: file, original: bytes, updated: bytes }])).rejects.toThrow(
      WORKSPACE_READ_ONLY
    );
    expect(fs.readdirSync(backups)).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("the registry of workspaces", () => {
  const REGISTRY = `CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    CREATE TABLE workspaces (local_uuid TEXT PRIMARY KEY NOT NULL, root_path TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL, cloud_uuid TEXT UNIQUE, schema_version TEXT NOT NULL, availability TEXT NOT NULL)`;

  it("lists them, the active one first, with the folder each was made from", async () => {
    const dir = path.join(tmp, "Workspaces");
    const db = new sqlite!.DatabaseSync(path.join(dir, "registry-v1.sqlite3"));
    db.exec(REGISTRY);
    const add = db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)");
    add.run("aaa", "/ws/aaa", "Old", null, "22.9.0", "local");
    add.run("bbb", "/ws/bbb", "Church", "cloud-1", "22.9.0", "local");
    const meta = db.prepare("INSERT INTO meta VALUES (?, ?)");
    meta.run("active_local_uuid", "bbb");
    meta.run("copied_from:aaa", "/Users/someone/Documents/ProPresenter");
    db.close();

    expect(await registeredWorkspaces(dir)).toEqual([
      { root: "/ws/bbb", name: "Church", active: true, cloud: true, schemaVersion: "22.9.0", copiedFrom: undefined },
      {
        root: "/ws/aaa",
        name: "Old",
        active: false,
        cloud: false,
        schemaVersion: "22.9.0",
        copiedFrom: "/Users/someone/Documents/ProPresenter",
      },
    ]);
  });

  it("is empty where ProPresenter 22 has never run, or its registry cannot be read", async () => {
    expect(await registeredWorkspaces(path.join(tmp, "nowhere"))).toEqual([]);
    const dir = path.join(tmp, "broken");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "registry-v1.sqlite3"), "not a database");
    expect(await registeredWorkspaces(dir)).toEqual([]);
  });
});

describe("the library read when none is named", () => {
  const registered = (active: boolean): RegisteredWorkspace => ({
    root: "/ws/v22",
    name: "Church",
    active,
    cloud: false,
    schemaVersion: "22.9.0",
  });
  const DOCUMENTS = "/home/Documents/ProPresenter";

  it("finds the workspaces ProPresenter 20 and 21 made, and nothing else kept beside them", async () => {
    const dir = path.join(tmp, "UserWorkspaces");
    fs.mkdirSync(path.join(dir, "Youth", "Libraries"), { recursive: true });
    fs.mkdirSync(path.join(dir, "Main", "Playlists"), { recursive: true });
    fs.mkdirSync(path.join(dir, "Cache"), { recursive: true });
    fs.writeFileSync(path.join(dir, "notes.txt"), "");
    expect(await folderWorkspaces(dir)).toEqual([path.join(dir, "Main"), path.join(dir, "Youth")]);
    expect(await folderWorkspaces(path.join(tmp, "nowhere"))).toEqual([]);
  });

  it("looks for both kinds of workspace side by side in ProPresenter's own support folder", () => {
    expect(path.basename(workspacesDir())).toBe("Workspaces");
    expect(["UserWorkspaces", "LocalWorkspaces"]).toContain(path.basename(folderWorkspacesDir()));
    expect(path.dirname(folderWorkspacesDir())).toBe(path.dirname(workspacesDir()));
    expect(path.dirname(workspacesDir()).endsWith(path.join("RenewedVision", "ProPresenter"))).toBe(true);
  });

  it("says which folder is a copy ProPresenter no longer updates, unless its workspace is read too", () => {
    const upgraded: RegisteredWorkspace = { ...registered(true), copiedFrom: DOCUMENTS };
    const [note] = staleNotes([DOCUMENTS], [upgraded]);
    expect(note).toContain(DOCUMENTS);
    expect(note).toContain("/ws/v22");
    expect(staleNotes([DOCUMENTS, "/ws/v22"], [upgraded])).toEqual([]);
    expect(staleNotes(["/somewhere/else"], [upgraded])).toEqual([]);
    expect(staleNotes([DOCUMENTS], [registered(true)])).toEqual([]);
  });

  it("is the workspace ProPresenter 22 has open, whatever else exists", () => {
    expect(
      defaultLibrary({ registered: [registered(true)], documents: DOCUMENTS, documentsExists: true, folders: ["/a"] })
    ).toBe("/ws/v22");
  });

  it("is Documents when that is there, and when nothing is", () => {
    const none = { registered: [registered(false)], documents: DOCUMENTS };
    expect(defaultLibrary({ ...none, documentsExists: true, folders: ["/a", "/b"] })).toBe(DOCUMENTS);
    // Named anyway, so "folder not found" says where a library was expected.
    expect(defaultLibrary({ ...none, documentsExists: false, folders: [] })).toBe(DOCUMENTS);
  });

  it("is the one workspace made elsewhere, and asks when there are several", () => {
    const none = { registered: [], documents: DOCUMENTS, documentsExists: false };
    expect(defaultLibrary({ ...none, folders: ["/ws/Main"] })).toBe("/ws/Main");
    expect(() => defaultLibrary({ ...none, folders: ["/ws/Main", "/ws/Youth"] })).toThrow("/ws/Main, /ws/Youth");
  });
});

/**
 * The proof the conversion rests on: a real library before ProPresenter 22
 * upgraded it, and the workspace the upgrade made from it. Every presentation
 * must read the same from both. Skipped where there is no such pair, which
 * includes CI; see *Testing against real files* in CONTRIBUTING.md.
 */
const REAL_WORKSPACE = process.env.PP_WORKSPACE_DIR;
const REAL_LEGACY = process.env.PP_LEGACY_LIBRARY_DIR;

describe.skipIf(!REAL_WORKSPACE || !REAL_LEGACY)("a real workspace against the library it was made from", () => {
  it("reads every presentation's slides, groups and text as the old file did", async () => {
    const real = await openRoots([REAL_WORKSPACE!]);
    const { files } = await findPresentations(real);
    expect(files.length).toBeGreaterThan(0);

    // Matched by the presentation's own uuid, which the upgrade keeps. Paths
    // do not survive being carried between machines: a zip made on Windows
    // and opened on a Mac turned every accented name into something else.
    const legacy = new Map<string, Uint8Array>();
    for (const file of (await findPresentations(await openRoots([REAL_LEGACY!]))).files) {
      const bytes = fs.readFileSync(file);
      const opened = openPresentation(bytes);
      // A library holds files that are not presentations; they have no counterpart to find.
      const uuid: string | undefined = opened.problem ? undefined : opened.raw.uuid?.string;
      if (uuid) legacy.set(uuid.toLowerCase(), bytes);
    }

    // A workspace that has been used since is no longer what it was made
    // from. The upgrade stamps every document within minutes of the others,
    // so one saved well after the middle of them was edited later.
    const saved = new Map<string, number>();
    for (const file of files) saved.set(file, (await statFoundFile(file))!.modified.getTime());
    const times = [...saved.values()].sort((x, y) => x - y);
    const editedAfter = times[Math.floor(times.length / 2)] + 10 * 60 * 1000;

    const shape = (bytes: Uint8Array) => {
      const doc = readPresentation(decodePresentation(bytes));
      return [doc.slideCount, doc.textBoxes.map((b) => [b.slideIndex, b.boxIndex, b.groupName, b.lines.map((l) => l.text)])];
    };
    const different: string[] = [];
    let compared = 0;
    for (const file of files) {
      if (saved.get(file)! > editedAfter) continue;
      const converted = (await readFoundFile(file)).bytes;
      const before = legacy.get(String(decodePresentation(converted).uuid?.string).toLowerCase());
      if (!before) continue;
      compared++;
      if (JSON.stringify(shape(converted)) !== JSON.stringify(shape(before))) different.push(file);
    }
    // Nearly all of them: a library is not rebuilt in the days after an upgrade.
    expect(compared).toBeGreaterThan(files.length * 0.9);
    expect(different).toEqual([]);
  }, 300_000);

  it("leaves out only what is new in version 22", async () => {
    const db = await openDatabase(storeOf(REAL_WORKSPACE!));
    const rows = db.prepare("SELECT snapshot FROM workspace_streams WHERE kind = 'Presentation' AND scope = 0").all();
    db.close();
    const unmapped = new Set<string>();
    for (const row of rows) {
      const doc = new LoroDoc();
      doc.import(row.snapshot as Uint8Array);
      presentationFromWorkspace((doc.toJSON() as { root: unknown }).root).unmapped.forEach((key) => unmapped.add(key));
      doc.free();
    }
    // Media is identified by an asset id from version 22, beside its path.
    expect([...unmapped].filter((key) => !key.startsWith("rv.data.Media."))).toEqual([]);
  }, 120_000);
});
