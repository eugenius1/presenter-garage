import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SYNTHETIC, syntheticMediaFile, syntheticTextPresentation } from "@presenter-garage/core/lib/__tests__/synthetic";
import {
  localUrl,
  treeNode,
  workspacePlaylists,
  workspacePresentation,
} from "@presenter-garage/core/lib/__tests__/workspace-fixtures";
import { createWorkspace, putDocument, sqlite } from "@presenter-garage/node/__tests__/workspace-db";
import { WORKSPACE_READ_ONLY } from "@presenter-garage/node/workspace";
import { callTool, connect } from "./connect";

/**
 * The server pointed at a ProPresenter 22 workspace, end to end: the same
 * tools give the same answers as over a folder of files, and the ones that
 * would write say why they will not.
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

  it("refuses to plan an edit, and says where to make it instead", async () => {
    const refused = await call("plan_slide_edits", {
      edits: [{ path: "Libraries/Default/Amazing Grace.pro", slideIndex: 0, boxIndex: 0, lineIndex: 0, text: "Changed" }],
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(WORKSPACE_READ_ONLY);
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
