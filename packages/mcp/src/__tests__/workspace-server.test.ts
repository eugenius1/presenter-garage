import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema, type ElicitRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  MACROS,
  SYNTHETIC,
  syntheticGroupsFile,
  syntheticMacroSong,
  syntheticMacrosFile,
  syntheticMediaFile,
  syntheticTextPresentation,
} from "@presenter-garage/core/lib/__tests__/synthetic";
import { decodeGroupsDocument, decodeMacrosDocument } from "@presenter-garage/core/lib/configuration";
import {
  localUrl,
  treeNode,
  workspaceDocument,
  workspacePlaylists,
  workspacePresentation,
} from "@presenter-garage/core/lib/__tests__/workspace-fixtures";
import { createWorkspace, putDocument, sqlite, storeOf } from "@presenter-garage/node/__tests__/workspace-db";
import { openRoots } from "@presenter-garage/node/library";
import { applyPlan, planSlideEdits, PlanStore } from "../edits";
import { createWritableWorkspace, presentationRoot, putPresentation } from "@presenter-garage/node/__tests__/workspace-writable";
import { CLOUD_REFUSED } from "@presenter-garage/node/workspace-write";
import { callTool, connect } from "./connect";

/**
 * The server pointed at a ProPresenter 22 workspace, end to end: the same
 * tools give the same answers as over a folder of files, and slide text is
 * written into the workspace's own database once the person confirms it.
 */

let tmp: string;
let workspace: string;
let client: Client;

const call = (name: string, args: Record<string, unknown> = {}) => callTool(client, name, args);

/** One service, whose one song is recorded the way ProPresenter records it: relative to the workspace. */
const PLAYLISTS = {
  type: 1,
  live_video_playlist_nodes: [],
  playlists: [
    treeNode("group", "PLAYLIST", {}, [
      treeNode("playlist", "Sunday", { LinkData: { __tag: null } }, [
        treeNode("item", "Amazing Grace", {
          is_hidden: false,
          ItemType: {
            __tag: "presentation",
            presentation: {
              arrangement_name: "",
              // Recorded twice, as ProPresenter does: the absolute half names
              // wherever the library was before the upgrade.
              document_path: localUrl("Libraries/Default/Amazing Grace.pro", "file:///somewhere/else/Amazing%20Grace.pro"),
            },
          },
        }),
      ]),
    ]),
  ],
};

const suite = describe.skipIf(!sqlite);

beforeAll(async () => {
  if (!sqlite) return;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-mcp-workspace-")));
  workspace = path.join(tmp, "Workspaces", "1ca74a0b");
  createWorkspace(workspace);
  putDocument(workspace, "Presentation", "Default/Amazing Grace", workspacePresentation(syntheticTextPresentation("Amazing Grace")));
  putDocument(workspace, "Presentation", "Chants/Sainte Cène", workspacePresentation(syntheticTextPresentation("Sainte Cène")));
  putDocument(workspace, "PlaylistMedia", null, workspacePlaylists(syntheticMediaFile()));
  putDocument(workspace, "PlaylistLibrary", null, PLAYLISTS);
  putDocument(workspace, "Groups", null, workspaceDocument("rv.data.ProGroupsDocument", decodeGroupsDocument(syntheticGroupsFile())));
  putDocument(workspace, "Macros", null, workspaceDocument("rv.data.MacrosDocument", decodeMacrosDocument(syntheticMacrosFile())));
  ({ client } = await connect([workspace]));
});

afterAll(async () => {
  await client?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

suite("a ProPresenter 22 workspace through the server", () => {
  it("lists presentations with the library each is in", async () => {
    const { presentations, total } = (await call("list_presentations")).json();
    expect(total).toBe(2);
    expect(presentations.map((p: any) => [p.library, p.name])).toEqual([
      ["Chants", "Sainte Cène"],
      ["Default", "Amazing Grace"],
    ]);
    expect(presentations[0].sizeBytes).toBeGreaterThan(0);
  });

  it("reads a presentation's slides, and says it cannot be written back", async () => {
    const read = (await call("read_presentation", { path: "Libraries/Default/Amazing Grace.pro" })).json();
    expect(read.name).toBe("Amazing Grace");
    expect(read.slides[0]).toMatchObject({ slideIndex: 0, group: "Verse", textBoxes: [{ lines: ["A tidy line", "And another"] }] });
    expect(read.fidelity).toBe("lossy");
  });

  it("reads each slide's group and macros", async () => {
    putDocument(workspace, "Presentation", "Chants/Macro Song", workspacePresentation(syntheticMacroSong()));
    let result;
    try {
      result = await call("read_presentation", { path: "Libraries/Chants/Macro Song.pro" });
    } finally {
      // Taken out again, so the other tests' counts stay those of the two songs.
      const db = new sqlite!.DatabaseSync(storeOf(workspace));
      db.prepare("DELETE FROM workspace_streams WHERE core_path = ?").run("Chants/Macro Song");
      db.close();
    }
    expect(result.text).toContain('"group":"Couplet\\u00a01"');
    const { slides } = result.json();
    // The workspace keeps uuids in its own case; compare without regard to it.
    expect(slides[0].macros.map((m: any) => [m.name, m.uuid.toLowerCase()])).toEqual([["Bienvenue", MACROS.bienvenue.uuid]]);
    expect(slides[3].macros.map((m: any) => [m.name, m.disabled])).toEqual([["Louange", undefined], ["Lumières", true]]);
  });

  it("reads the configured groups and macros from the workspace's own documents", async () => {
    const result = await call("read_groups_and_macros");
    expect(result.text).toContain('"name":"Couplet\\u00a01"');
    const answer = result.json();
    expect(answer.groupsPath).toBe(path.join(workspace, "Configuration", "Groups"));
    expect(answer.macrosPath).toBe(path.join(workspace, "Configuration", "Macros"));
    expect(answer.macros.map((m: any) => [m.name, m.collections])).toEqual([
      ["Bienvenue", ["Default Collection"]],
      ["Louange", ["Default Collection", "Louange"]],
      ["Lumières", []],
    ]);
    expect(answer.unreadable).toBeUndefined();
  });

  it("searches and checks every document", async () => {
    const search = (await call("search_text", { query: "tidy" })).json();
    expect(search.filesSearched).toBe(2);
    expect(search.matches).toHaveLength(2);

    const check = (await call("check_presentations")).json();
    expect(check.filesChecked).toBe(2);
    expect(check.totals.trailingComma).toBeGreaterThan(0);
  });

  it("reads the media bin", async () => {
    expect((await call("read_media_bin")).json().itemCount).toBe(SYNTHETIC.items);
  });

  it("hands out a playlist entry's file in a form read_presentation takes back", async () => {
    const { playlists } = (await call("read_playlists")).json();
    expect(playlists).toHaveLength(1);
    const [entry] = playlists[0].items;
    expect(entry).toMatchObject({ kind: "presentation", name: "Amazing Grace" });
    // Through the workspace, not the absolute path recorded beside it, which
    // names wherever the library was before the upgrade.
    expect(entry.file).toBe(path.join(workspace, "Libraries", "Default", "Amazing Grace.pro"));
    expect((await call("read_presentation", { path: entry.file })).json().name).toBe("Amazing Grace");
  });

  it("refuses to filter by when a song was last shown rather than calling every one unused", async () => {
    const refused = await call("list_presentations", { notUsedSince: "2026-01-01" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("does not record");
  });

  it("refuses to plan an edit in a workspace whose format it cannot check", async () => {
    // This one has no registry beside it, so nothing says which format it is.
    const refused = await call("plan_slide_edits", {
      edits: [{ path: "Libraries/Default/Amazing Grace.pro", slideIndex: 0, boxIndex: 0, lineIndex: 0, text: "Changed" }],
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/no registry-v1\.sqlite3 beside it/);
  });

  it("passes on what it was told about the folder it reads", async () => {
    const { client: noted } = await connect([workspace], {
      readOnly: true,
      notes: ["This folder is a copy ProPresenter no longer updates."],
    });
    expect(noted.getInstructions()).toContain("Important: This folder is a copy ProPresenter no longer updates.");
    await noted.close();
  });
});

suite("editing slide text in a ProPresenter 22 workspace through the server", () => {
  let dir: string;
  let root: string;
  let editor: Client;
  let asked: ElicitRequest[];
  let edit: (name: string, args?: Record<string, unknown>) => ReturnType<typeof callTool>;

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-mcp-workspace-edit-")));
    root = createWritableWorkspace(dir);
    putPresentation(root, "Song", presentationRoot());
    // The box that opens "Que ton nom,": All Caps on "ton nom," alone, and a range past the end of the text.
    const opening = (lines: string[]) => lines[0] === "Que ton nom,";
    putPresentation(
      root,
      "Styled",
      presentationRoot((lines) => (opening(lines) ? [{ start: 4, end: 12 }, { start: 0, end: 50 }] : []))
    );
    // And All Caps on "ton" alone.
    putPresentation(root, "Partial", presentationRoot((lines) => (opening(lines) ? [{ start: 4, end: 7 }] : [])));
    asked = [];
    ({ client: editor, call: edit } = await connect([root], { backupDir: path.join(dir, "Backups") }, { elicitation: { form: {} } }));
    editor.setRequestHandler(ElicitRequestSchema, (request) => {
      asked.push(request);
      const { properties } = (request.params as { requestedSchema: { properties: Record<string, unknown> } }).requestedSchema;
      return { action: "accept", content: Object.fromEntries(Object.keys(properties).map((k) => [k, true])) };
    });
  });

  afterAll(async () => {
    await editor?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("plans, asks the person, writes, and reads back what was promised", async () => {
    const song = "Libraries/Default/Song.pro";
    const planned = (await edit("plan_slide_edits", { edits: [{ path: song, boxIndex: 6, lineIndex: 0, text: "Que ton nom" }] })).json();
    expect(planned.files[0].lines[0]).toMatchObject({ before: "Que ton nom,", after: "Que ton nom" });

    const result = (await edit("apply_slide_edits", { planId: planned.planId })).json();
    expect((asked[0].params as { message: string }).message).toContain("Quit ProPresenter first");
    expect(result.files).toEqual([expect.objectContaining({ written: true, lines: 1 })]);
    expect(result.files[0].reason).toBeUndefined();
    expect(fs.existsSync(`${result.files[0].backup}.loro`)).toBe(true);

    const read = (await edit("read_presentation", { path: song })).json();
    expect(read.slides[6].textBoxes[0].lines).toEqual(["Que ton nom", "pour toujours ,", "sois glorifie"]);
  });

  it("adds a line, widening the All Caps range of the line it copies", async () => {
    const song = "Libraries/Default/Song.pro";
    const planned = (
      await edit("plan_slide_edits", { edits: [{ path: song, boxIndex: 6, lineIndex: 2, text: "sois glorifie", insert: "after" }] })
    ).json();
    expect(planned.files[0].lines[0]).toMatchObject({
      lineIndex: 2,
      insert: "after",
      before: null,
      after: "sois glorifie",
      styling: ["All Caps on the whole line, as on the line beside it"],
    });

    const result = (await edit("apply_slide_edits", { planId: planned.planId })).json();
    expect(result.files).toEqual([expect.objectContaining({ written: true, lines: 1 })]);
    const { properties } = (asked.at(-1)!.params as { requestedSchema: { properties: Record<string, { description: string }> } }).requestedSchema;
    expect(properties.line1.description).toBe(
      "Added after “sois glorifie”: “sois glorifie”. Styling: All Caps on the whole line, as on the line beside it."
    );
    const read = (await edit("read_presentation", { path: song })).json();
    expect(read.slides[6].textBoxes[0].lines.slice(-2)).toEqual(["sois glorifie", "sois glorifie"]);
  });

  it("refuses before anybody is asked a line added beside formatting it would have to guess at", async () => {
    // A gradient over the whole of a one-line box: whether a new line takes it is not known.
    const gradient = { __tag: "text_gradient_fill", text_gradient_fill: {} };
    putPresentation(root, "Gradient", presentationRoot((lines) => [{ start: 0, end: lines.join("\n").length, attribute: gradient }]));
    const before = asked.length;
    const refused = await edit("plan_slide_edits", {
      edits: [{ path: "Libraries/Default/Gradient.pro", boxIndex: 4, lineIndex: 0, text: "x2", insert: "after" }],
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/box 4 line 0: a text box has formatting that cannot be moved .*: a line would be added beside formatting other than All Caps/);
    expect(asked.length).toBe(before);
  });

  it("shows the person what each change does to the styling on its line, and writes it", async () => {
    const styled = "Libraries/Default/Styled.pro";
    const planned = (await edit("plan_slide_edits", { edits: [{ path: styled, boxIndex: 6, lineIndex: 0, text: "Que ton nom" }] })).json();
    const styling = [
      "All Caps on “ton nom,” → on “ton nom”",
      "All Caps on the whole line, as before",
      "formatting that ran past the end of the text box is cut back to its end, which changes nothing visible",
    ];
    expect(planned.files[0].lines[0].styling).toEqual(styling);

    const result = (await edit("apply_slide_edits", { planId: planned.planId })).json();
    const { properties } = (asked.at(-1)!.params as { requestedSchema: { properties: Record<string, { description: string }> } })
      .requestedSchema;
    expect(properties.line1.description).toBe(`“Que ton nom,” → “Que ton nom”. Styling: ${styling.join("; ")}.`);
    expect(result.files).toEqual([expect.objectContaining({ written: true, lines: 1 })]);
  });

  it("refuses, before anybody is asked, a change that would leave a range's place to a guess", async () => {
    const asks = asked.length;
    const refused = await edit("plan_slide_edits", {
      edits: [{ path: "Libraries/Default/Partial.pro", boxIndex: 6, lineIndex: 0, text: "Que notre Dieu," }],
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/box 6 line 0: a text box has formatting that cannot be moved .* where it starts or ends in the new text is a guess\. Nothing was planned\.$/);
    expect(asked).toHaveLength(asks);
  });

  it("refuses a Cloud workspace before anybody is asked", async () => {
    const cloudDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-mcp-workspace-cloud-")));
    const cloud = createWritableWorkspace(cloudDir, { cloud: true });
    putPresentation(cloud, "Song", presentationRoot());
    const { client, call: cloudCall } = await connect([cloud], { backupDir: path.join(cloudDir, "Backups") });
    const refused = await cloudCall("plan_slide_edits", {
      edits: [{ path: "Libraries/Default/Song.pro", boxIndex: 6, lineIndex: 0, text: "Que ton nom" }],
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(CLOUD_REFUSED);
    await client.close();
    fs.rmSync(cloudDir, { recursive: true, force: true });
  });
});

suite("a plan across two workspaces", () => {
  it("reports what it wrote when a later workspace is refused, rather than saying nothing was", async () => {
    const dirs = [0, 1].map(() => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-mcp-two-workspaces-"))));
    const workspaces = dirs.map((dir) => createWritableWorkspace(dir));
    for (const root of workspaces) putPresentation(root, "Song", presentationRoot());
    const roots = await openRoots(workspaces);
    const store = new PlanStore();
    const planned = await planSlideEdits(
      roots,
      store,
      roots.map((root) => ({ path: path.join(root, "Libraries", "Default", "Song.pro"), boxIndex: 6, lineIndex: 0, text: "Que ton nom" }))
    );
    const plan = store.take(planned.planId)!;
    // ProPresenter has the second workspace open.
    const open = new sqlite!.DatabaseSync(storeOf(roots[1]));
    open.prepare("SELECT count(*) FROM workspace_streams").get();
    try {
      const result = await applyPlan(roots, plan, new Set([1, 2]), path.join(dirs[0], "Backups"));
      expect(result.backupFolder).toBeDefined();
      expect(result.files.map((file) => [file.written, file.reason])).toEqual([
        [true, undefined],
        [false, "writeFailed"],
      ]);
      expect(result.files[1].detail).toMatch(/Quit ProPresenter/);
      // Said of the workspace it stopped, not of the whole call.
      expect(result.files[1].detail).toMatch(/nothing in it was written/);
      expect(result.files[1].detail).not.toMatch(/nothing was written/);
    } finally {
      open.close();
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
