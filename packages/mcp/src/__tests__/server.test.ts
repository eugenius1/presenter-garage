import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ElicitRequestSchema,
  type ElicitRequest,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  capsByLine,
  CONFIGURED_GROUPS,
  MACROS,
  syntheticGroupsFile,
  syntheticMacroSong,
  syntheticMacrosFile,
  syntheticMediaFile,
  syntheticTextPresentation,
  SYNTHETIC,
  textLines,
  withAttributes,
} from "@presenter-garage/core/lib/__tests__/synthetic";
import { encodeDocument, messageType } from "@presenter-garage/core/lib/decode";
import { decodeMediaDocument, rawItems, walkNodes } from "@presenter-garage/core/lib/model";
import { applyOperations } from "@presenter-garage/core/lib/operations";
import { decodePlaylistsDocument, headerEntry, mediaEntry, presentationEntry } from "@presenter-garage/core/lib/playlists";
import { decodePresentation, encodePresentation, slidesInOrder, textBoxRanges } from "@presenter-garage/core/lib/presentation";
import { syntheticPresentationFile } from "@presenter-garage/core/lib/__tests__/synthetic";
import { findPresentations, openRoots, readFoundFile, readLibraryFile, resolveInRoots } from "@presenter-garage/node/library";
import { parseArgs } from "../args";
import { connect } from "./connect";
import { applyPlan, planSlideEdits, PlanStore } from "../edits";
import { auditMediaBin } from "../tools";
import { toJson } from "../server";

/**
 * The server end to end, over an in-memory pipe, against a library built on
 * disk from the synthetic fixtures. Going through a real client means the
 * schemas, the argument parsing and the error wrapping are all exercised, not
 * just the functions behind them.
 */

/**
 * What this machine lets the fixtures do, probed once before any test is
 * collected so a test can skip itself. Root reads a file whatever its mode,
 * and Windows has no unreadable mode at all; Windows also refuses to make a
 * symlink without a privilege most accounts lack. A fixture the machine cannot
 * make is left out rather than made and quietly not doing its job.
 */
const can = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "pp-mcp-probe-"));
  const file = path.join(probe, "probe");
  fs.writeFileSync(file, "");
  fs.chmodSync(file, 0o000);
  let lock = true;
  try {
    fs.readFileSync(file);
    lock = false;
  } catch {
    // Refused, as wanted.
  }
  fs.chmodSync(file, 0o644);
  let symlink = true;
  try {
    fs.symlinkSync(file, path.join(probe, "link"));
  } catch {
    symlink = false;
  }
  fs.rmSync(probe, { recursive: true, force: true });
  return { lock, symlink };
})();

let tmp: string;
let library: string;
let church: string;
let client: Client;
let call: Awaited<ReturnType<typeof connect>>["call"];

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-mcp-")));
  library = path.join(tmp, "ProPresenter");
  const songs = path.join(library, "Libraries", "Default");
  fs.mkdirSync(songs, { recursive: true });
  fs.mkdirSync(path.join(library, "Playlists"));

  fs.writeFileSync(path.join(songs, "Checked Song.pro"), syntheticTextPresentation());
  fs.writeFileSync(path.join(songs, "Sainte Cène.pro"), syntheticTextPresentation("Sainte Cène"));
  fs.writeFileSync(path.join(songs, "Chords.pro"), "{title: Amazing Grace}\n[G]Amazing grace\n");
  fs.writeFileSync(path.join(songs, "._Checked Song.pro"), "resource fork noise");
  // A presentation with nothing to report, so a clean file stays unlisted.
  const Presentation = messageType("rv.data.Presentation");
  fs.writeFileSync(path.join(songs, "Clean.pro"), Presentation.encode(Presentation.fromObject({ name: "Clean" })).finish());
  // One the walk finds but cannot open.
  if (can.lock) {
    fs.writeFileSync(path.join(songs, "Locked.pro"), syntheticTextPresentation("Locked"));
    fs.chmodSync(path.join(songs, "Locked.pro"), 0o000);
  }
  fs.writeFileSync(path.join(library, "Playlists", "Media"), syntheticMediaFile());
  // A library of its own, so the shared one's counts stay what they were.
  church = path.join(tmp, "Church");
  fs.mkdirSync(path.join(church, "Libraries", "Chants"), { recursive: true });
  fs.mkdirSync(path.join(church, "Configuration"));
  fs.writeFileSync(path.join(church, "Libraries", "Chants", "Macro Song.pro"), syntheticMacroSong());
  fs.writeFileSync(path.join(church, "Configuration", "Groups"), syntheticGroupsFile());
  fs.writeFileSync(path.join(church, "Configuration", "Macros"), syntheticMacrosFile());

  // Outside the library, and a link inside it pointing there.
  fs.writeFileSync(path.join(tmp, "secret.txt"), "not yours");
  if (can.symlink) fs.symlinkSync(path.join(tmp, "secret.txt"), path.join(songs, "escape.pro"));

  ({ client, call } = await connect(library));
});

afterAll(async () => {
  await client?.close();
  if (can.lock) fs.chmodSync(path.join(library, "Libraries", "Default", "Locked.pro"), 0o644);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const READING_TOOLS = [
  "audit_media_bin",
  "check_presentations",
  "current_library",
  "list_presentations",
  "list_themes",
  "preview_style",
  "read_groups_and_macros",
  "read_media_bin",
  "read_playlists",
  "read_presentation",
  "read_rules",
  "search_text",
  "use_library",
];

/** The tools that write their results to an `out` folder, offered only when the server may write. */
const OUT_TOOLS = ["check_rules", "compare_libraries", "dump_library", "find_libraries"];

describe("the tools offered", () => {
  it("read, except the ones that apply a confirmed edit, save the rules, or write results to a folder", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...READING_TOOLS, ...OUT_TOOLS, "apply_slide_edits", "plan_slide_edits", "open_review", "read_review", "save_rules"].sort()
    );
    // plan_slide_edits writes a review folder when given `out`.
    const writing = new Set(["apply_slide_edits", "plan_slide_edits", "save_rules", "check_presentations", ...OUT_TOOLS]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(!writing.has(tool.name));
    }
    expect(tools.find((t) => t.name === "apply_slide_edits")?.annotations?.destructiveHint).toBe(true);
  });

  it("are all read-only, with nothing that edits even offered, when started read-only", async () => {
    const { client: readOnly } = await connect(library, { readOnly: true });
    const { tools } = await readOnly.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(READING_TOOLS);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
    // Nor is the folder check_presentations would write to.
    expect(tools.find((t) => t.name === "check_presentations")?.inputSchema.properties).not.toHaveProperty("out");
    await readOnly.close();
  });

  it("are the ones the Claude Desktop extension says it has", async () => {
    // Claude Desktop shows the manifest's list before the server ever runs.
    const manifest = JSON.parse(fs.readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));
    const { tools } = await client.listTools();
    expect(manifest.tools.map((t: { name: string }) => t.name).sort()).toEqual(tools.map((t) => t.name).sort());
  });
});

describe("list_presentations", () => {
  it("lists .pro files, skipping hidden files and symlinks", async () => {
    const { presentations } = (await call("list_presentations")).json();
    const names = presentations.map((p: { name: string }) => p.name);
    expect(names).toContain("Checked Song");
    expect(names).toContain("Sainte Cène");
    expect(names).not.toContain("._Checked Song");
    expect(names).not.toContain("escape");
    expect(presentations[0].library).toBe("Default");
  });

  it("filters ignoring case and accents", async () => {
    const { presentations } = (await call("list_presentations", { query: "cene" })).json();
    expect(presentations.map((p: { name: string }) => p.name)).toEqual(["Sainte Cène"]);
  });
});

describe("read_presentation", () => {
  it("returns each slide's lines with the addresses a fix would use", async () => {
    const doc = (await call("read_presentation", { path: "Libraries/Default/Checked Song.pro" })).json();
    expect(doc.name).toBe("Checked Song");
    expect(doc.fidelity).not.toBe("lossy");
    expect(doc.emptyTextBoxes).toBe(1);

    const first = doc.slides[0];
    expect(first).toMatchObject({ slideIndex: 0, label: "Clean", group: "Verse" });
    expect(first.textBoxes[0]).toEqual({ boxIndex: 0, lines: ["A tidy line", "And another"] });
    // A slide whose only box is an empty placeholder is still listed, with no boxes.
    expect(doc.slides).toHaveLength(doc.slideCount);
    expect(doc.slides.find((s: { label: string }) => s.label === "Empty").textBoxes).toEqual([]);
  });

  it("gives each slide's group and macros, a non-breaking space escaped where a reader sees it", async () => {
    const { client: own, call: callOwn } = await connect(church);
    const result = await callOwn("read_presentation", { path: "Libraries/Chants/Macro Song.pro" });
    await own.close();
    // Visible in the text a model reads, and the very character once parsed.
    expect(result.text).toContain('"group":"Couplet\\u00a01"');
    expect(result.text).not.toContain("\u00a0");
    const { slides } = result.json();
    expect(slides[0]).toMatchObject({ group: "Couplet\u00a01", macros: [{ name: "Bienvenue", uuid: MACROS.bienvenue.uuid }] });
    expect(slides[3].macros).toEqual([
      { name: "Louange", uuid: MACROS.louange.uuid },
      { name: "Lumières", uuid: MACROS.lumieres.uuid, disabled: true },
    ]);
    expect(slides[5].macros).toEqual([]);
  });

  it("names a chord chart for what it is", async () => {
    const result = await call("read_presentation", { path: "Libraries/Default/Chords.pro" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/ChordPro/);
  });

  it.skipIf(!can.symlink)("refuses a symlink that leads out of the library", async () => {
    const result = await call("read_presentation", { path: "Libraries/Default/escape.pro" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Outside/);
  });

  it("refuses a path that climbs out of the library", async () => {
    const result = await call("read_presentation", { path: "../secret.txt" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Outside/);
  });

  it("refuses an absolute path elsewhere", async () => {
    const result = await call("read_presentation", { path: path.join(tmp, "secret.txt") });
    expect(result.isError).toBe(true);
  });
});

describe("invisible characters in an answer", () => {
  it("are written as escapes a reader sees, and parse back to the very same text", () => {
    const names = [
      "Couplet\u00a01",
      // A bidirectional isolate around a name: shows nothing, and is not the plain name.
      "\u2066Couplet 1\u2069",
      "\u2067Refrain\u2068\u2069",
      "Pont\u200b",
      "\ufeffTag",
    ];
    const text = toJson({ names });
    expect(text).toContain("Couplet\\u00a01");
    expect(text).toContain("\\u2066Couplet 1\\u2069");
    expect(text).toContain("\\u2067Refrain\\u2068\\u2069");
    expect(text).toMatch(/^[\x20-\x7e]*$/);
    expect(JSON.parse(text)).toEqual({ names });
  });

  it("leave ordinary text, accents included, as it is", () => {
    expect(toJson({ name: "Pré-refrain 2" })).toBe('{"name":"Pré-refrain 2"}');
  });
});

describe("read_groups_and_macros", () => {
  it("reads ProPresenter's configured lists from beside Libraries, names exactly as stored", async () => {
    const { client: own, call: callOwn } = await connect(church);
    const result = await callOwn("read_groups_and_macros");
    await own.close();
    expect(result.text).toContain('"name":"Couplet\\u00a01"');
    const answer = result.json();
    expect(answer.groupsPath).toBe(path.join(church, "Configuration", "Groups"));
    expect(answer.groups.map((g: { name: string }) => g.name)).toEqual(CONFIGURED_GROUPS.map((g) => g.name));
    expect(answer.groups[0]).toEqual({ name: "Couplet\u00a01", uuid: CONFIGURED_GROUPS[0].uuid.string, color: "rgb(0,102,204)" });
    expect(answer.macros).toEqual([
      { ...MACROS.bienvenue, collections: ["Default Collection"] },
      { ...MACROS.louange, collections: ["Default Collection", "Louange"] },
      { ...MACROS.lumieres, collections: [] },
    ]);
    expect(answer.unreadable).toBeUndefined();
  });

  it("says which list it could not read, and refuses when it found neither", async () => {
    const other = path.join(tmp, "Other");
    fs.mkdirSync(path.join(other, "Configuration"), { recursive: true });
    fs.writeFileSync(path.join(other, "Configuration", "Groups"), "not a protobuf \xff\xff");
    const { client: one, call: callOne } = await connect(other);
    const answer = (await callOne("read_groups_and_macros")).json();
    expect(answer.groups).toEqual([]);
    expect(answer.unreadable.groups).toBeTruthy();
    expect(answer.unreadable.macros).toMatch(/Configuration\/Macros/);
    await one.close();

    const empty = path.join(tmp, "Empty");
    fs.mkdirSync(empty);
    const { client: none, call: callNone } = await connect(empty);
    const refused = await callNone("read_groups_and_macros");
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/neither/);
    await none.close();
  });
});

describe("search_text", () => {
  it("finds a line ignoring case and accents, and reports what it could not read", async () => {
    const result = (await call("search_text", { query: "TIDY" })).json();
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]).toMatchObject({ slideIndex: 0, boxIndex: 0, lineIndex: 0, text: "A tidy line" });
    expect(result.unreadable.map((p: string) => path.basename(p))).toEqual(
      can.lock ? ["Chords.pro", "Locked.pro"] : ["Chords.pro"]
    );
  });

  it("stops at the limit and says so", async () => {
    const result = (await call("search_text", { query: "tidy", limit: 1 })).json();
    expect(result.matches).toHaveLength(1);
    expect(result.truncated).toBe(true);
    // Counts the files it got through, up to the one holding the match it
    // stopped at -- here the last, after the chord chart, the clean file and
    // the locked one, where this machine can lock one.
    expect(result.filesSearched).toBe(can.lock ? 5 : 4);
  });

  it("refuses a file passed as the folder rather than finding nothing", async () => {
    const result = await call("search_text", { query: "tidy", folder: "Libraries/Default/Checked Song.pro" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Not a folder/);
  });

  it("refuses an empty query", async () => {
    expect((await call("search_text", { query: "  " })).isError).toBe(true);
  });
});

describe("check_presentations", () => {
  it("gives the same findings as the browser tool", async () => {
    const result = (await call("check_presentations", { path: "Libraries/Default/Checked Song.pro" })).json();
    expect(result.filesChecked).toBe(1);
    expect(result.totals).toMatchObject({ "leading-trailing-space": 2, "blank-line": 1, "repeated-space": 1 });
    // With no rules.json anywhere it looked, the default text checks ran, and it says so.
    expect(result.rules).toMatchObject({ defaulted: true });
    expect(result.notes).toEqual([expect.stringContaining("only the default text checks ran")]);
  });

  it("refuses a file that is not a presentation", async () => {
    const result = await call("check_presentations", { path: "Playlists/Media" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Not a presentation/);
  });

  it("checks a whole folder, carrying on past files it cannot read", async () => {
    const result = (await call("check_presentations")).json();
    const byName = Object.fromEntries(
      result.files.map((f: { path: string }) => [path.basename(f.path), f])
    );
    expect(byName["Checked Song.pro"].findings.length).toBeGreaterThan(0);
    expect(byName["Chords.pro"].error).toMatch(/ChordPro/);
    if (can.lock) expect(byName["Locked.pro"].error).toMatch(/Could not read/);
    expect(byName["Clean.pro"]).toBeUndefined();
  });

  it("says when it listed fewer files than had findings", async () => {
    const result = (await call("check_presentations", { limit: 1 })).json();
    expect(result.files).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});

describe("the media bin", () => {
  it("is found in Playlists/Media when no path is given", async () => {
    const bin = (await call("read_media_bin")).json();
    expect(bin.itemCount).toBe(SYNTHETIC.items);
    expect(bin.playlists).toHaveLength(SYNTHETIC.playlistsWithItems);
  });

  it("is audited with items cut down to what identifies them", async () => {
    const audit = (await call("audit_media_bin")).json();
    expect(audit.totals.items).toBe(SYNTHETIC.items);
    expect(audit.emptyPlaylists).toHaveLength(SYNTHETIC.emptyPlaylists);
    for (const item of audit.hiddenItems) expect(item).not.toHaveProperty("variantKey");
  });

  it("says where to look when there is none", async () => {
    await expect(auditMediaBin(path.join(library, "Libraries"))).rejects.toThrow(/No media bin found/);
  });

  it("refuses a presentation passed as a media bin", async () => {
    const result = await call("read_media_bin", { path: "Libraries/Default/Checked Song.pro" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not a ProPresenter media bin/);
  });
});

describe("openRoots", () => {
  it("refuses a folder that does not exist", async () => {
    await expect(openRoots([path.join(tmp, "missing")])).rejects.toThrow(/not found/);
  });

  it("refuses a file given as a folder", async () => {
    await expect(openRoots([path.join(tmp, "secret.txt")])).rejects.toThrow(/Not a folder/);
  });
});

describe("resolveInRoots", () => {
  it.skipIf(!can.symlink)("tries a relative path against every root, not just the first", async () => {
    const first = path.join(tmp, "first");
    fs.mkdirSync(first, { recursive: true });
    fs.symlinkSync(tmp, path.join(first, "Libraries"));
    const roots = await openRoots([first, library]);
    await expect(resolveInRoots(roots, "Libraries/Default/Checked Song.pro")).resolves.toBe(
      path.join(library, "Libraries", "Default", "Checked Song.pro")
    );
  });

  it("does not mistake a sibling folder sharing a prefix for the root", async () => {
    const sibling = `${library}-other`;
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, "x.pro"), "");
    await expect(resolveInRoots([library], path.join(sibling, "x.pro"))).rejects.toThrow(/Outside/);
  });
});

describe("readFoundFile", () => {
  it.skipIf(!can.symlink)("refuses a symlink rather than following it", async () => {
    await expect(readFoundFile(path.join(library, "Libraries", "Default", "escape.pro"))).rejects.toThrow(
      /Could not read/
    );
  });

  it("refuses a folder", async () => {
    await expect(readFoundFile(library)).rejects.toThrow(/Not a file|Could not read/);
  });
});

describe.skipIf(!can.symlink)("a folder swapped for a symlink mid-read", () => {
  // A real race cannot be timed in a test, so each one steps in through a spy
  // at the moment the code has to catch: after a path was found, before it is
  // used.
  let root: string;
  let inner: string;
  let outside: string;

  const swap = () => {
    fs.renameSync(inner, `${inner}-moved`);
    fs.symlinkSync(outside, inner);
  };
  const unswap = () => {
    fs.rmSync(inner);
    fs.renameSync(`${inner}-moved`, inner);
  };

  beforeAll(() => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-mcp-swap-")));
    root = path.join(base, "library");
    inner = path.join(root, "Inner");
    outside = path.join(base, "outside");
    fs.mkdirSync(inner, { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(inner, "Song.pro"), "inside");
    fs.writeFileSync(path.join(outside, "Song.pro"), "outside");
    fs.writeFileSync(path.join(outside, "Leak.pro"), "outside");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.lstatSync(inner).isSymbolicLink()) unswap();
  });

  afterAll(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));

  it("does not list a queued folder that has become a symlink", async () => {
    const readdir = fsp.readdir;
    vi.spyOn(fsp, "readdir").mockImplementation((async (dir: string, options: never) => {
      const entries = await readdir(dir, options);
      if (dir === root) swap();
      return entries;
    }) as typeof fsp.readdir);

    const { files } = await findPresentations([root]);
    expect(files).toEqual([]);
  });

  it("refuses a file whose folder became a symlink before it was opened", async () => {
    const open = fsp.open;
    vi.spyOn(fsp, "open").mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      swap();
      return open(...args);
    });

    await expect(readLibraryFile([root], "Inner/Song.pro")).rejects.toThrow(/reached through a symlink/);
  });

  it("refuses a file whose folder was a symlink only while it was opened", async () => {
    const open = fsp.open;
    vi.spyOn(fsp, "open").mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      swap();
      const handle = await open(...args);
      unswap();
      return handle;
    });

    await expect(readLibraryFile([root], "Inner/Song.pro")).rejects.toThrow(/changed while being opened/);
  });

  it("reads the same file when nothing moves", async () => {
    const { bytes } = await readLibraryFile([root], "Inner/Song.pro");
    expect(new TextDecoder().decode(bytes)).toBe("inside");
  });
});

describe("findPresentations", () => {
  it("stops at the folder cap even with no presentation found", async () => {
    // The library itself, capped at one folder: the root is listed, and the
    // folders it queued are not.
    const { files, truncated } = await findPresentations([library], 1);
    expect(files).toEqual([]);
    expect(truncated).toBe(true);
  });
});

describe("what a presentation records about itself", () => {
  // A library of its own, so the counts the tests above assert stay put.
  let dated: string;
  let server: Awaited<ReturnType<typeof connect>>;
  const at = (iso: string) => ({ seconds: Date.parse(iso) / 1000 });
  const list = async (args: Record<string, unknown> = {}) =>
    (await server.call("list_presentations", args)).json();
  const read = async (file: string) => (await server.call("read_presentation", { path: file })).json();

  beforeAll(async () => {
    dated = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-mcp-dated-")));
    const Presentation = messageType("rv.data.Presentation");
    const write = (name: string, fields: Record<string, unknown>) =>
      fs.writeFileSync(
        path.join(dated, `${name}.pro`),
        Presentation.encode(Presentation.fromObject({ name, ...fields })).finish()
      );

    write("Recent", {
      application_info: {
        platform: "PLATFORM_WINDOWS",
        application_version: { major_version: 21, minor_version: 4, patch_version: 2 },
      },
      last_date_used: at("2026-10-13T18:37:48Z"),
      last_modified_date: at("2026-10-23T18:47:31Z"),
      category: "Louange",
      notes: "Capo 2 pour la chorale",
      ccli: { song_title: "Recent", author: "Someone", song_number: 1234567, copyright_year: 2019 },
      music: { original_music_key: "G", user_music_key: "A" },
      cue_groups: [
        { group: { uuid: { string: "g-verse" }, name: "Couplet" } },
        { group: { uuid: { string: "g-chorus" }, name: "Refrain" } },
      ],
      arrangements: [
        {
          uuid: { string: "a-1" },
          name: "Dimanche",
          group_identifiers: [{ string: "g-verse" }, { string: "g-chorus" }, { string: "g-gone" }],
        },
      ],
    });
    write("Old", { last_date_used: at("2024-01-07T10:00:00Z") });
    write("Never", {});
    fs.writeFileSync(path.join(dated, "Chords.pro"), "{title: Amazing Grace}\n[G]Amazing grace\n");

    server = await connect(dated);
  });

  afterAll(async () => {
    await server?.client.close();
    fs.rmSync(dated, { recursive: true, force: true });
  });

  it("reads ProPresenter's dates, notes, CCLI, key and arrangements", async () => {
    const doc = await read("Recent.pro");
    expect(doc).toMatchObject({
      lastUsed: "2026-10-13T18:37:48.000Z",
      lastModified: "2026-10-23T18:47:31.000Z",
      category: "Louange",
      notes: "Capo 2 pour la chorale",
      ccli: { songTitle: "Recent", author: "Someone", songNumber: 1234567, copyrightYear: 2019 },
      musicKey: { original: "G", user: "A" },
      arrangements: [{ name: "Dimanche", groups: ["Couplet", "Refrain", null] }],
      savedBy: { appVersion: "21.4.2", platform: "WINDOWS" },
    });
    expect(doc.fileModified).toEqual(expect.any(String));
    expect(doc).not.toHaveProperty("created");
  });

  it("leaves out what a file does not record", async () => {
    const doc = await read("Never.pro");
    for (const key of ["lastUsed", "lastModified", "category", "notes", "ccli", "musicKey", "savedBy"]) {
      expect(doc[key]).toBeUndefined();
    }
    expect(doc.arrangements).toEqual([]);
  });

  it("lists without opening any file unless asked about use", async () => {
    const { presentations, unreadable } = await list();
    expect(unreadable).toBeUndefined();
    for (const p of presentations) {
      expect(p.fileModified).toEqual(expect.any(String));
      expect(p).not.toHaveProperty("lastUsed");
    }
  });

  it("finds what has not been shown since a date, never-shown included", async () => {
    const { presentations, unreadable } = await list({ notUsedSince: "2025-01-01" });
    expect(presentations.map((p: { name: string }) => p.name).sort()).toEqual(["Never", "Old"]);
    expect(presentations.find((p: { name: string }) => p.name === "Never").lastUsed).toBeNull();
    // A file it could not decode is said so, not quietly counted as unused.
    expect(unreadable.map((f: string) => path.basename(f))).toEqual(["Chords.pro"]);
  });

  it("finds what has been shown since a date, most recent first", async () => {
    const recent = await list({ usedSince: "2025-01-01" });
    expect(recent.presentations.map((p: { name: string }) => p.name)).toEqual(["Recent"]);

    const sorted = await list({ sort: "lastUsed" });
    expect(sorted.presentations.map((p: { name: string }) => p.name)).toEqual(["Recent", "Old", "Never"]);
  });

  it("refuses a date it cannot read", async () => {
    const result = await server.call("list_presentations", { usedSince: "last spring" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not a date/);
  });

  it("tells the calling model about the cost and the missing creation date", async () => {
    const { tools } = await server.client.listTools();
    const about = (name: string) => tools.find((t) => t.name === name)!.description!;
    expect(about("list_presentations")).toMatch(/decoded/);
    expect(about("read_presentation")).toMatch(/Prefer `lastModified`/);
    for (const name of ["list_presentations", "read_presentation"]) {
      expect(about(name)).toMatch(/No creation date/);
    }
  });
});

describe("playlists and themes", () => {
  // A ProPresenter folder of its own, so the counts the tests above assert stay put.
  let show: string;
  let server: Awaited<ReturnType<typeof connect>>;
  const json = async (name: string, args: Record<string, unknown> = {}) => (await server.call(name, args)).json();
  const song = () => path.join(show, "Libraries", "Default", "Checked Song.pro");

  /** A theme slide whose one text box is set in bold, centred, over a shape. */
  const lyricsSlide = {
    elements: [
      {
        info: 3,
        element: {
          uuid: { string: "THEME-LYRICS" },
          name: "Lyrics",
          text: {
            rtf_data: new TextEncoder().encode(
              "{\\rtf1\\ansi\\ansicpg1252\\cocoartf2709\n{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica-Bold;}\n" +
                "\\pard\\qc\\partightenfactor0\n\n\\f0\\b\\fs200 \\cf2 Style words}"
            ),
          },
        },
      },
      { info: 1, element: { uuid: { string: "THEME-SHAPE" }, name: "Shape" } },
    ],
  };

  beforeAll(async () => {
    show = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-mcp-show-")));
    fs.mkdirSync(path.join(show, "Libraries", "Default"), { recursive: true });
    fs.mkdirSync(path.join(show, "Playlists"));
    fs.writeFileSync(song(), syntheticTextPresentation());
    fs.writeFileSync(path.join(show, "Playlists", "Media"), syntheticMediaFile());

    // A presentation whose second slide's box is marked as a text element, so it can lend its look.
    const styled = decodePresentation(syntheticTextPresentation("Styled")) as any;
    slidesInOrder(styled)[1].cue.actions[0].slide.presentation.base_slide.elements[0].info = 3;
    fs.writeFileSync(path.join(show, "Libraries", "Default", "Styled.pro"), encodePresentation(styled));

    // A service: a header, the song, and a background from the media bin.
    const playlists = decodePlaylistsDocument(syntheticPresentationFile()) as any;
    const sunday = playlists.root_node.playlists.playlists[0].uuid.string;
    const background = walkNodes((decodeMediaDocument(syntheticMediaFile()) as any).root_node).flatMap(rawItems)[0];
    const location = { root: show, platform: "PLATFORM_MACOS" as const };
    const service = applyOperations(playlists, [
      { kind: "insertItem", playlistUuid: sunday, itemName: "Chants", entry: headerEntry("Chants") },
      {
        kind: "insertItem",
        playlistUuid: sunday,
        itemName: "Checked Song",
        entry: presentationEntry({ path: "Libraries/Default/Checked Song.pro", location }),
      },
      { kind: "insertItem", playlistUuid: sunday, itemName: "Fond", entry: mediaEntry(background) },
    ]);
    fs.writeFileSync(path.join(show, "Playlists", "Library"), encodeDocument(service));

    const Theme = messageType("rv.data.Template.Document");
    fs.mkdirSync(path.join(show, "Themes", "White"), { recursive: true });
    fs.writeFileSync(
      path.join(show, "Themes", "White", "Theme"),
      Theme.encode(
        Theme.fromObject({
          slides: [
            { name: "Lyrics", base_slide: lyricsSlide },
            { name: "Blank", base_slide: { elements: [] } },
          ],
        })
      ).finish()
    );
    fs.mkdirSync(path.join(show, "Themes", "Broken"), { recursive: true });
    fs.writeFileSync(path.join(show, "Themes", "Broken", "Theme"), "not a theme");

    server = await connect(show);
  });

  afterAll(async () => {
    await server?.client.close();
    fs.rmSync(show, { recursive: true, force: true });
  });

  it("reads a service from Playlists/Library, entries in order", async () => {
    const result = await json("read_playlists");
    expect(result.path).toBe(path.join(show, "Playlists", "Library"));
    expect(result.playlists).toEqual([
      {
        path: "Sunday",
        items: [
          { kind: "header", name: "Chants" },
          { kind: "presentation", name: "Checked Song", file: song() },
          // A media entry is the media bin's cue, under the bin's own name.
          { kind: "media", name: "Rose Gradient", file: path.join(show, "Media", "Assets", "rose-gradient.jpg") },
        ],
      },
    ]);
  });

  it("hands out a presentation's file in a form read_presentation takes back", async () => {
    const entry = (await json("read_playlists")).playlists[0].items[1];
    expect((await json("read_presentation", { path: entry.file })).name).toBe("Checked Song");
  });

  it("gives the recorded absolute path for a copy kept outside Playlists", async () => {
    const copy = path.join(show, "Backups", "2026", "Library");
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(path.join(show, "Playlists", "Library"), copy);
    try {
      const entry = (await json("read_playlists", { path: copy })).playlists[0].items[1];
      // From the entry's absolute_string, not two folders up from the copy.
      expect(entry.file).toBe(song());
    } finally {
      fs.rmSync(path.join(show, "Backups"), { recursive: true, force: true });
    }
  });

  it("gives the recorded absolute path for an entry relative to another root", async () => {
    const PlaylistItem = messageType("rv.data.PlaylistItem");
    const location = { root: show, platform: "PLATFORM_MACOS" as const };
    const recorded = presentationEntry({ path: "Libraries/Default/Checked Song.pro", location });
    const entry = PlaylistItem.toObject(recorded, { enums: String }) as any;
    entry.presentation.document_path.local = { root: "ROOT_USER_DOCUMENTS", path: "Elsewhere/Checked Song.pro" };
    const playlists = decodePlaylistsDocument(syntheticPresentationFile()) as any;
    const service = applyOperations(playlists, [
      {
        kind: "insertItem",
        playlistUuid: playlists.root_node.playlists.playlists[0].uuid.string,
        itemName: "Checked Song",
        entry: PlaylistItem.fromObject(entry),
      },
    ]);
    const file = path.join(show, "Playlists", "Documents Library");
    fs.writeFileSync(file, encodeDocument(service));
    try {
      const items = (await json("read_playlists", { path: file })).playlists[0].items;
      expect(items.find((i: any) => i.kind === "presentation").file).toBe(song());
    } finally {
      fs.rmSync(file);
    }
  });

  it("hands out the same file when the server is pointed at the folder above", async () => {
    const above = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-mcp-above-")));
    fs.renameSync(show, path.join(above, "ProPresenter"));
    const outer = await connect(above);
    try {
      const entry = (await outer.call("read_playlists", {})).json().playlists[0].items[1];
      expect(entry.file).toBe(path.join(above, "ProPresenter", "Libraries", "Default", "Checked Song.pro"));
      expect((await outer.call("read_presentation", { path: entry.file })).json().name).toBe("Checked Song");
    } finally {
      await outer.client.close();
      fs.renameSync(path.join(above, "ProPresenter"), show);
      fs.rmSync(above, { recursive: true, force: true });
    }
  });

  it("refuses the media bin passed as the presentation playlists", async () => {
    const result = await server.call("read_playlists", { path: "Playlists/Media" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not ProPresenter's presentation playlists/);
  });

  it("lists each theme's styles, and names one it cannot read", async () => {
    const { themes, unreadable } = await json("list_themes");
    expect(themes).toEqual([
      {
        name: "White",
        path: path.join(show, "Themes", "White", "Theme"),
        styles: [
          { styleIndex: 0, name: "Lyrics", textBoxes: 1 },
          { styleIndex: 1, name: "Blank", textBoxes: 0 },
        ],
      },
    ]);
    expect(unreadable).toEqual([expect.objectContaining({ path: path.join(show, "Themes", "Broken", "Theme") })]);
  });

  it.skipIf(!can.symlink)("does not list themes a symlinked Themes folder leads out to", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-mcp-linked-")));
    fs.symlinkSync(path.join(show, "Themes"), path.join(root, "Themes"));
    const linked = await connect(root);
    try {
      expect((await linked.call("list_themes", {})).json()).toEqual({ themes: [], unreadable: [] });
    } finally {
      await linked.client.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("previews a theme style slide by slide, and writes nothing", async () => {
    const before = fs.readFileSync(song());
    const preview = await json("preview_style", { path: song(), theme: "white", style: "Lyrics" });

    expect(preview).toMatchObject({ style: "Lyrics", fidelity: expect.stringMatching(/identical|equivalent/) });
    expect(preview.restyled + preview.leftAlone).toBe(preview.slides.length);
    expect(preview.slides.find((s: any) => s.label === "Leading").textBoxes).toEqual([{ lines: ["Fine here", " leading space"] }]);
    expect(fs.readFileSync(song())).toEqual(before);
  });

  it("leaves alone the slides it is told to, and says why", async () => {
    const preview = await json("preview_style", { path: song(), theme: "White", style: 0, skipSlides: [1] });
    expect(preview.slides[1].skip).toBe("listed");
    expect(preview.slides[0].skip).toBeUndefined();
  });

  it("takes a style from another presentation's slide, numbered as read_presentation numbers it", async () => {
    const preview = await json("preview_style", { path: song(), fromPresentation: "Libraries/Default/Styled.pro", style: 1 });
    expect(preview.style).toBe("Styled 2");
    expect(preview.restyled).toBeGreaterThan(0);
  });

  it("says what is wrong with a style it cannot use", async () => {
    const error = async (args: Record<string, unknown>) => {
      const result = await server.call("preview_style", { path: song(), ...args });
      expect(result.isError).toBe(true);
      return result.text;
    };
    expect(await error({ theme: "White" })).toMatch(/2 styles.*0: Lyrics, 1: Blank/);
    expect(await error({ theme: "White", style: "Chorus" })).toMatch(/No style "Chorus".*0: Lyrics/);
    expect(await error({ theme: "White", style: "Blank" })).toMatch(/has no text box/);
    expect(await error({ theme: "Navy" })).toMatch(/No theme named "Navy"/);
    expect(await error({ theme: "Broken" })).toMatch(/not a ProPresenter theme/);
    expect(await error({ theme: "White", fromPresentation: "Libraries/Default/Styled.pro" })).toMatch(/exactly one/);
    expect(await error({ fromPresentation: "Libraries/Default/Styled.pro", style: 99 })).toMatch(/no slide 100/);
  });
});

describe("editing slide text", () => {
  let dir: string;
  let file: string;
  let backups: string;
  /** What the person answers when asked; set per test. */
  let reply: (request: ElicitRequest) => ElicitResult | Promise<ElicitResult>;
  let asked: ElicitRequest[];
  let edit: Awaited<ReturnType<typeof connect>>["call"];
  let editor: Client;

  /** The form a request asks the person to fill in; this server sends nothing else. */
  const form = (request: ElicitRequest) =>
    request.params as { message: string; requestedSchema: { properties: Record<string, { description: string }> } };

  const lines = () => textLines(new Uint8Array(fs.readFileSync(file)));
  /** What a field says of its own change, before the slides around it. */
  const change = (field: { description: string }) => field.description.split("\n\n")[0];

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-mcp-edit-")));
    const songs = path.join(dir, "ProPresenter", "Libraries", "Default");
    fs.mkdirSync(songs, { recursive: true });
    file = path.join(songs, "Song.pro");
    backups = path.join(dir, "Backups");

    ({ client: editor, call: edit } = await connect(
      path.join(dir, "ProPresenter"),
      { backupDir: backups },
      { elicitation: { form: {} } }
    ));
    editor.setRequestHandler(ElicitRequestSchema, (request) => {
      asked.push(request);
      return reply(request);
    });
  });

  beforeEach(() => {
    fs.writeFileSync(file, syntheticTextPresentation("Song"));
    fs.rmSync(backups, { recursive: true, force: true });
    asked = [];
    reply = (request) => ({
      action: "accept",
      content: Object.fromEntries(Object.keys(form(request).requestedSchema.properties).map((k) => [k, true])),
    });
  });

  afterAll(async () => {
    await editor?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const plan = async (edits: Record<string, unknown>[]) =>
    (await edit("plan_slide_edits", { edits: edits.map((e) => ({ path: "Libraries/Default/Song.pro", ...e })) })).json();

  it("plans without writing, showing each line as it is and as it would read", async () => {
    const before = fs.readFileSync(file);
    const planned = await plan([{ boxIndex: 0, lineIndex: 0, text: "A tidier line" }]);
    expect(planned.files[0].lines).toEqual([
      expect.objectContaining({ n: 1, slideIndex: 0, group: "Verse", before: "A tidy line", after: "A tidier line" }),
    ]);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("adds lines, shows each as it would read and where it goes, and writes only those left ticked", async () => {
    const planned = await plan([
      { boxIndex: 6, lineIndex: 0, text: "Que ton nom,", insert: "after" },
      { boxIndex: 6, lineIndex: 2, text: "(bis)", insert: "after" },
      { boxIndex: 6, lineIndex: 0, text: "Refrain", insert: "before" },
    ]);
    // In reading order, each saying which side of which line it goes, with no line before it.
    expect(planned.files[0].lines.map((l: Record<string, unknown>) => [l.n, l.lineIndex, l.insert, l.before, l.after])).toEqual([
      [1, 0, "before", null, "Refrain"],
      [2, 0, "after", null, "Que ton nom,"],
      [3, 2, "after", null, "(bis)"],
    ]);

    reply = () => ({ action: "accept", content: { line1: true, line2: true, line3: false } });
    const result = (await edit("apply_slide_edits", { planId: planned.planId })).json();
    const { properties } = form(asked[0]).requestedSchema;
    expect(change(properties.line2)).toBe("Added after “Que ton nom,”: “Que ton nom,”");
    expect((properties.line1 as { title?: string }).title).toMatch(/text box 7, new line before line 1\)/);

    expect(result).toMatchObject({ answer: "accept", files: [{ written: true, lines: 2 }] });
    expect(lines()[6]).toEqual(["Refrain", "Que ton nom,", "Que ton nom,", "pour toujours ,", "sois glorifie"]);
  });

  it("moves the capitals with the text, and shows the styling an added line takes", async () => {
    fs.writeFileSync(
      file,
      withAttributes(syntheticTextPresentation("Song"), { 0: capsByLine(["A tidy line", "And another"]) })
    );
    const planned = await plan([
      { boxIndex: 0, lineIndex: 0, text: "new line", insert: "after" },
      { boxIndex: 1, lineIndex: 0, text: "not", insert: "after" },
    ]);
    expect(planned.files[0].lines.map((l: Record<string, unknown>) => l.styling)).toEqual([
      ["All Caps on the whole line, as on the line beside it"],
      undefined,
    ]);

    const result = (await edit("apply_slide_edits", { planId: planned.planId })).json();
    const { properties } = form(asked[0]).requestedSchema;
    expect(change(properties.line1)).toBe(
      "Added after “A tidy line”: “new line”. Styling: All Caps on the whole line, as on the line beside it."
    );
    expect(change(properties.line2)).toBe("Added after “Fine here”: “not”");
    expect(result).toMatchObject({ answer: "accept", files: [{ written: true, lines: 2 }] });
    const ranges = textBoxRanges(decodePresentation(new Uint8Array(fs.readFileSync(file)))).get(0)!;
    // "A tidy line" and the new line under one range, "And another" moved past it.
    expect(ranges.map((r) => [r.start, r.end])).toEqual([
      [0, 20],
      [21, 32],
    ]);
  });

  it("refuses at plan time an added line whether a range covers would be a guess", async () => {
    fs.writeFileSync(
      file,
      withAttributes(syntheticTextPresentation("Song"), { 0: [{ range: { start: 0, end: 11 }, original_font_size: 120 }] })
    );
    const result = await edit("plan_slide_edits", {
      edits: [{ path: "Libraries/Default/Song.pro", boxIndex: 0, lineIndex: 0, text: "new", insert: "after" }],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/box 0 line 0: a text box has formatting that cannot be moved .*: a line would be added beside formatting other than All Caps/);
  });

  it("refuses an added line it cannot place, saying which", async () => {
    const result = await edit("plan_slide_edits", {
      edits: [{ path: "Libraries/Default/Song.pro", boxIndex: 0, lineIndex: 1, text: "", insert: "after" }],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/box 0, a line added after line 1: an added line needs some text.*Nothing was planned/);
  });

  it("asks the person, then writes what they confirmed and backs up the original first", async () => {
    const original = fs.readFileSync(file);
    const { planId } = await plan([
      { boxIndex: 0, lineIndex: 0, text: "A tidier line" },
      { boxIndex: 6, lineIndex: 0, text: "Que ton nom" },
    ]);
    const result = (await edit("apply_slide_edits", { planId })).json();

    expect(asked).toHaveLength(1);
    const { message, requestedSchema } = form(asked[0]);
    expect(message).toContain(backups);
    expect(change(requestedSchema.properties.line1)).toBe("“A tidy line” → “A tidier line”");
    expect((requestedSchema.properties.line1 as { title?: string }).title).toMatch(/text box 1, line 1/);

    expect(result).toMatchObject({ answer: "accept", files: [{ written: true, lines: 2 }] });
    expect(lines()[0]).toEqual(["A tidier line", "And another"]);
    expect(lines()[6][0]).toBe("Que ton nom");
    expect(fs.readFileSync(result.files[0].backup)).toEqual(original);
  });

  describe("shows each change among the slides around it", () => {
    /** The form for a plan, with every line left ticked and nothing written that matters here. */
    const formFor = async (edits: Record<string, unknown>[]) => {
      const { planId } = await plan(edits);
      await edit("apply_slide_edits", { planId });
      return form(asked.at(-1)!);
    };
    const around = (field: { description: string }) => field.description.split("\n\n").slice(1).join("\n\n");

    it("two slides either side of a change in the middle, each with its group, the change marked", async () => {
      const { message, requestedSchema } = await formFor([{ boxIndex: 3, lineIndex: 0, text: "Above it" }]);
      expect(change(requestedSchema.properties.line1)).toBe("“Above” → “Above it”");
      expect(around(requestedSchema.properties.line1)).toBe(
        [
          "Slides 2–6:",
          "  2 [Verse]: Fine here ⏎  leading space",
          "  3 [Chorus]: trailing space  ⏎ Fine",
          "> 4 [Chorus]: ⟦1: Above⟧ ⏎ ∅ ⏎ Below",
          "  5 [Chorus]: two  spaces here",
          "  6 [Chorus]: ∅",
        ].join("\n")
      );
      expect(message).toMatch(/the 2 slides either side of it as they read now/);
    });

    it("fewer at the start and at the end", async () => {
      const start = await formFor([{ boxIndex: 0, lineIndex: 1, text: "And one more" }]);
      expect(around(start.requestedSchema.properties.line1).split("\n")).toEqual([
        "Slides 1–3:",
        "> 1 [Verse]: A tidy line ⏎ ⟦1: And another⟧",
        "  2 [Verse]: Fine here ⏎  leading space",
        "  3 [Chorus]: trailing space  ⏎ Fine",
      ]);
      const end = await formFor([{ boxIndex: 7, lineIndex: 3, text: "Gloire!", insert: "after" }]);
      expect(around(end.requestedSchema.properties.line1).split("\n")).toEqual([
        "Slides 6–8:",
        "  6 [Chorus]: ∅",
        "  7 [Chorus]: Que ton nom, ⏎ pour toujours , ⏎ sois glorifie",
        "> 8 [Chorus]: Tu es saint; ⏎ je te loue. ⏎ et je chanterai… ⏎ Gloire... ⏎ ⟦1: added⟧",
      ]);
    });

    it("a single-slide presentation as that slide alone", async () => {
      const raw = decodePresentation(syntheticTextPresentation("Song")) as any;
      raw.cues = raw.cues.slice(0, 1);
      raw.cue_groups = [{ ...raw.cue_groups[0], cue_identifiers: raw.cue_groups[0].cue_identifiers.slice(0, 1) }];
      fs.writeFileSync(file, encodePresentation(raw));
      const { requestedSchema } = await formFor([{ boxIndex: 0, lineIndex: 0, text: "Before", insert: "before" }]);
      expect(around(requestedSchema.properties.line1)).toBe("Slide 1:\n> 1 [Verse]: ⟦1: added⟧ ⏎ A tidy line ⏎ And another");
    });

    it("tells one text box from the next on a slide", async () => {
      const raw = decodePresentation(syntheticTextPresentation("Song")) as any;
      const elements = (cue: any) => cue.actions[0].slide.presentation.base_slide.elements;
      elements(raw.cues[0]).push(structuredClone(elements(raw.cues[1])[0]));
      fs.writeFileSync(file, encodePresentation(raw));
      const { requestedSchema } = await formFor([{ boxIndex: 1, lineIndex: 0, text: "Fine" }]);
      expect(around(requestedSchema.properties.line1).split("\n").slice(0, 2)).toEqual([
        "Slides 1–3:",
        "> 1 [Verse]: A tidy line ⏎ And another ‖ ⟦1: Fine here⟧ ⏎  leading space",
      ]);
    });

    it("changes close together share their slides, shown once; changes far apart each get their own", async () => {
      const { requestedSchema } = await formFor([
        { boxIndex: 0, lineIndex: 0, text: "First" },
        { boxIndex: 0, lineIndex: 1, text: "Second" },
        { boxIndex: 1, lineIndex: 1, text: "leading space" },
        { boxIndex: 7, lineIndex: 0, text: "Tu es saint" },
      ]);
      const { line1, line2, line3, line4 } = requestedSchema.properties;
      // Slides 1 and 2: one run, under the first change in it. Slide 8 is
      // too far from them to meet (their runs end at 4 and start at 6).
      expect(around(line1).split("\n")).toEqual([
        "Slides 1–4:",
        "> 1 [Verse]: ⟦1: A tidy line⟧ ⏎ ⟦2: And another⟧",
        "> 2 [Verse]: Fine here ⏎ ⟦3:  leading space⟧",
        "  3 [Chorus]: trailing space  ⏎ Fine",
        "  4 [Chorus]: Above ⏎ ∅ ⏎ Below",
      ]);
      expect(around(line2)).toBe("Slides 1–4: shown under change 1.");
      expect(around(line3)).toBe("Slides 1–4: shown under change 1.");
      expect(around(line4).split("\n")).toEqual([
        "Slides 6–8:",
        "  6 [Chorus]: ∅",
        "  7 [Chorus]: Que ton nom, ⏎ pour toujours , ⏎ sois glorifie",
        "> 8 [Chorus]: ⟦4: Tu es saint;⟧ ⏎ je te loue. ⏎ et je chanterai… ⏎ Gloire...",
      ]);
    });

    it("names each slide's macros, one switched off said so, and shows a non-breaking space in a group name", async () => {
      fs.writeFileSync(file, syntheticMacroSong());
      const { requestedSchema } = await formFor([{ boxIndex: 1, lineIndex: 1, text: "leading space" }]);
      expect(around(requestedSchema.properties.line1).split("\n")).toEqual([
        "Slides 1–4:",
        "  1 [Couplet⍽1] (Bienvenue): A tidy line ⏎ And another",
        "> 2 [Couplet⍽1] (Louange): Fine here ⏎ ⟦1:  leading space⟧",
        "  3 [Chorus] (Louange): trailing space  ⏎ Fine",
        "  4 [Chorus] (Louange, Lumières (off)): Above ⏎ ∅ ⏎ Below",
      ]);
    });

    it("adds nothing that can be ticked: one tick box per changed line, and only those", async () => {
      const { requestedSchema } = await formFor([
        { boxIndex: 0, lineIndex: 0, text: "First" },
        { boxIndex: 3, lineIndex: 0, text: "Above it" },
      ]);
      expect(Object.keys(requestedSchema.properties)).toEqual(["line1", "line2"]);
      expect(Object.values(requestedSchema.properties).map((p) => (p as { type?: string }).type)).toEqual(["boolean", "boolean"]);
    });
  });

  it("writes only the lines left ticked", async () => {
    reply = () => ({ action: "accept", content: { line1: false, line2: true } });
    const { planId } = await plan([
      { boxIndex: 0, lineIndex: 0, text: "Not this" },
      { boxIndex: 0, lineIndex: 1, text: "But this" },
    ]);
    await edit("apply_slide_edits", { planId });
    expect(lines()[0]).toEqual(["A tidy line", "But this"]);
  });

  it("writes nothing when the person declines, and the plan cannot be replayed", async () => {
    const before = fs.readFileSync(file);
    reply = () => ({ action: "decline" });
    const { planId } = await plan([{ boxIndex: 0, lineIndex: 0, text: "Nope" }]);
    expect((await edit("apply_slide_edits", { planId })).json()).toEqual({ answer: "decline", files: [] });
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.existsSync(backups)).toBe(false);

    reply = () => ({ action: "accept", content: { line1: true } });
    const again = await edit("apply_slide_edits", { planId });
    expect(again.isError).toBe(true);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("writes nothing when the client gives up on the call before the person answers", async () => {
    const before = fs.readFileSync(file);
    const { planId } = await plan([{ boxIndex: 0, lineIndex: 0, text: "Too late" }]);
    const controller = new AbortController();
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    reply = () => {
      // The person is still reading when the client cancels; they accept after.
      controller.abort();
      return answered.then(() => ({ action: "accept" as const, content: { line1: true } }));
    };
    const call = editor.callTool({ name: "apply_slide_edits", arguments: { planId } }, undefined, {
      signal: controller.signal,
    });
    await expect(call).rejects.toThrow();
    answer();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("applies two plans for one song one after the other, so the second is refused rather than landing over the first", async () => {
    const first = await plan([{ boxIndex: 0, lineIndex: 0, text: "From the first plan" }]);
    const second = await plan([{ boxIndex: 0, lineIndex: 1, text: "From the second plan" }]);
    const results = await Promise.all([
      edit("apply_slide_edits", { planId: first.planId }),
      edit("apply_slide_edits", { planId: second.planId }),
    ]);
    const [a, b] = results.map((r) => r.json().files[0]);
    expect(a).toMatchObject({ written: true });
    expect(b).toMatchObject({ written: false, reason: "stale" });
    expect(lines()[0]).toEqual(["From the first plan", "And another"]);
  });

  it("writes nothing for a confirmed plan whose call was cancelled while it waited its turn", async () => {
    const before = fs.readFileSync(file);
    const roots = await openRoots([path.join(dir, "ProPresenter")]);
    const store = new PlanStore();
    const { planId } = await planSlideEdits(roots, store, [
      { path: file, boxIndex: 0, lineIndex: 0, text: "Queued, then cancelled" },
    ]);
    const plan = store.take(planId)!;
    const controller = new AbortController();
    controller.abort();
    await expect(applyPlan(roots[0], plan, new Set([1]), backups, controller.signal)).rejects.toThrow(/cancelled/);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.existsSync(backups)).toBe(false);
  });

  it("leaves alone a file that changed after the plan was made", async () => {
    const { planId } = await plan([{ boxIndex: 0, lineIndex: 0, text: "Mine" }]);
    fs.writeFileSync(file, syntheticTextPresentation("Saved by ProPresenter meanwhile"));
    const changed = fs.readFileSync(file);
    const result = (await edit("apply_slide_edits", { planId })).json();
    expect(result.files[0]).toMatchObject({ written: false, reason: "stale" });
    expect(fs.readFileSync(file)).toEqual(changed);
  });

  it("refuses to plan the lot when one edit cannot be made", async () => {
    const result = await edit("plan_slide_edits", {
      edits: [
        { path: "Libraries/Default/Song.pro", boxIndex: 0, lineIndex: 0, text: "Fine" },
        { path: "Libraries/Default/Song.pro", boxIndex: 0, lineIndex: 1, text: "two\nlines" },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/box 0 line 1: .*line break.*Nothing was planned/);
  });

  it("refuses to plan a path outside the library", async () => {
    const result = await edit("plan_slide_edits", { edits: [{ path: "../../secret.pro", boxIndex: 0, lineIndex: 0, text: "x" }] });
    expect(result.isError).toBe(true);
  });

  it("refuses to plan a file that is not a presentation", async () => {
    const playlist = path.join(dir, "ProPresenter", "Libraries", "Default", "Notes.txt");
    fs.writeFileSync(playlist, "not a song");
    const result = await edit("plan_slide_edits", { edits: [{ path: playlist, boxIndex: 0, lineIndex: 0, text: "x" }] });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Not a presentation/);
  });

  it("writes nothing through a client that cannot ask its user", async () => {
    // The shared client declares no elicitation: no person to confirm.
    const shared = path.join(library, "Libraries", "Default", "Checked Song.pro");
    const before = fs.readFileSync(shared);
    const { planId } = (
      await call("plan_slide_edits", { edits: [{ path: shared, boxIndex: 0, lineIndex: 0, text: "Unconfirmed" }] })
    ).json();
    const result = await call("apply_slide_edits", { planId });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/cannot ask its user/);
    expect(fs.readFileSync(shared)).toEqual(before);
  });
});

describe("the command line", () => {
  it("takes one folder, --read-only and --backup-dir", () => {
    expect(parseArgs(["/a"])).toEqual({ folder: "/a", readOnly: false });
    expect(parseArgs([])).toEqual({ readOnly: false });
    expect(parseArgs(["--read-only", "/a"])).toMatchObject({ folder: "/a", readOnly: true });
    expect(parseArgs(["--backup-dir=/x=y", "/a"])).toMatchObject({ backupDir: "/x=y" });
  });

  it("refuses a second folder rather than reading two libraries", () => {
    expect(() => parseArgs(["/a", "/b"])).toThrow(/One library folder at a time: \/a and \/b/);
    expect(() => parseArgs(["/a", "--read-only", "/b"])).toThrow(/use_library/);
  });

  it("takes the Claude Desktop extension's --read-only=true|false", () => {
    expect(parseArgs(["--read-only=true"]).readOnly).toBe(true);
    expect(parseArgs(["--read-only=false"]).readOnly).toBe(false);
    expect(() => parseArgs(["--read-only=yes"])).toThrow();
  });

  it("refuses an option it does not know rather than reading it as a folder", () => {
    expect(() => parseArgs(["--readonly"])).toThrow(/Unknown option/);
    expect(() => parseArgs(["--backup-dir"])).toThrow(/needs a folder/);
  });
});
