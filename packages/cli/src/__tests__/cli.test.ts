import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { putDocument } from "@presenter-garage/node/__tests__/workspace-db";
import { run, type Io } from "../cli";
import { discover, foundText } from "@presenter-garage/node/commands/discover";
import { writeSources } from "@presenter-garage/node/commands/output";
import { activeWorkspace } from "@presenter-garage/node/commands/source";
import { sqlite, writeLibrary, writeRegistry, writeWorkspace, type SongSpec } from "@presenter-garage/node/__tests__/songs";

/**
 * The command end to end, over a folder of `.pro` files ("bas") and a
 * ProPresenter 22 workspace ("haut") built for the test, with the folder of
 * files the workspace was made from beside it for its older edit dates.
 */

const VERSE = { name: "Couplet 1", slides: [["Que ton nom soit glorifié"], ["Pour toujours"]] };
const LAMB = "aaaaaaaa-0000-4000-8000-000000000001";
const EDITED = "bbbbbbbb-0000-4000-8000-000000000002";
const ONLY_HAUT = "cccccccc-0000-4000-8000-000000000003";

const spec = (name: string, lines: string[], extra: Partial<SongSpec> = {}): SongSpec => ({
  name,
  groups: [{ name: "Refrain", slides: [lines] }],
  ...extra,
});

let tmp: string;
let bas: string;
let haut: string;
let registry: string;
let legacy: string;

function capture(): Io & { stdout: string; stderr: string } {
  const io = {
    stdout: "",
    stderr: "",
    out: (text: string) => void (io.stdout += `${text}\n`),
    err: (text: string) => void (io.stderr += `${text}\n`),
  };
  return io;
}

const listing = (dir: string) => fs.readdirSync(dir).sort();
/** Every file and folder under a folder, relative. */
const tree = (dir: string) => (fs.readdirSync(dir, { recursive: true }) as string[]).map((f) => f.split(path.sep).join("/")).sort();

describe.skipIf(!sqlite)("presenter-garage", () => {
  beforeAll(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pg-cli-")));
    bas = path.join(tmp, "bas");
    registry = path.join(tmp, "Workspaces");
    haut = path.join(registry, "ebcb5c83-0000-4000-8000-000000000000");
    legacy = path.join(tmp, "LocalWorkspaces", "ProPresenter");

    writeLibrary(bas, {
      // The underscore is how one machine writes an apostrophe in a file name.
      "Chants/Gloire a l_Agneau.pro": spec("Gloire a l_Agneau", ["Digne est l'Agneau", "</script><b>pas du HTML</b>"], {
        uuid: LAMB,
        modified: "2026-11-10T09:00:00Z",
      }),
      "Chants/Same.pro": { name: "Same", groups: [VERSE], modified: "2025-05-05T00:00:00Z" },
      "Chants/Edited.pro": spec("Edited", ["Ancienne ligne"], { uuid: EDITED, modified: "2026-10-01T00:00:00Z" }),
      "Chants/Only bas.pro": spec("Only bas", ["Seulement ici"]),
    });
    fs.writeFileSync(path.join(bas, "Chants", "Chords.pro"), "{title: Not a presentation}\n");

    writeLibrary(legacy, {
      "Libraries/Chants/Gloire a l'Agneau.pro": spec("Gloire a l'Agneau", ["Digne est l'Agneau de Dieu"], {
        uuid: LAMB,
        modified: "2026-01-01T00:00:00Z",
      }),
      // A copy made in ProPresenter shares the uuid; the one at the same path is the song.
      "Libraries/Chants/Copie.pro": spec("Copie", ["Digne est l'Agneau"], { uuid: LAMB, modified: "2026-10-01T00:00:00Z" }),
      // Another song at the same path, its uuid not the workspace's: no date for it.
      "Libraries/Chants/Same.pro": { name: "Same", groups: [VERSE], modified: "2025-01-01T00:00:00Z" },
      // Edited after the upgrade, so not the file the workspace was made from: no date either.
      "Libraries/Chants/Only haut.pro": spec("Only haut", ["Seulement là"], { uuid: ONLY_HAUT, modified: "2026-11-12T00:00:00Z" }),
    });
    writeWorkspace(haut, {
      "Chants/Gloire a l'Agneau": { spec: spec("Gloire a l'Agneau", ["Digne est l'Agneau de Dieu"], { uuid: LAMB }) },
      "Chants/Same": { spec: { name: "Same", groups: [VERSE] } },
      "Chants/Edited": { spec: spec("Edited", ["Nouvelle ligne"], { uuid: EDITED }), editedAt: "2026-11-15T13:55:23Z", peer: "42" },
      "Chants/Only haut": { spec: spec("Only haut", ["Seulement là"], { uuid: ONLY_HAUT }) },
    });
    // A Cloud document listed but not downloaded to this computer.
    putDocument(haut, "Presentation", "Chants/Not here", null);
    writeRegistry(registry, haut, legacy);
  });

  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  describe("compare", () => {
    let out: string;
    let io: ReturnType<typeof capture>;
    let store: string[];

    beforeAll(async () => {
      out = path.join(tmp, "out");
      store = listing(path.join(haut, "DocumentStore"));
      io = capture();
      expect(await run(["compare", `bas=${bas}`, `haut=${haut}`, "--out", out], io)).toBe(0);
    });

    it("prints a summary of counts and paths, and no lyrics", () => {
      expect(io.stdout).toContain("bas: 4 songs, 1 unreadable · haut: 4 songs, 1 unreadable");
      expect(io.stdout).toContain("Matched 3 songs (by ID 2, by name 1)");
      expect(io.stdout).toContain("Only in bas: 1 · only in haut: 1");
      expect(io.stdout).toContain("Chants/Chords.pro: This is a text file");
      expect(io.stdout).toContain("not downloaded to this computer yet");
      expect(io.stdout).not.toMatch(/Digne|Seulement|ligne/);
    });

    it("leaves the workspace as it found it", () => {
      expect(listing(path.join(haut, "DocumentStore"))).toEqual(store);
    });

    it("dates each side as well as it can be, and says which edited later", () => {
      const json = JSON.parse(fs.readFileSync(path.join(out, "compare.json"), "utf8"));
      const pair = (name: string) => json.pairs.find((p: any) => (p.a ?? p.b).name === name);

      const lamb = pair("Gloire a l_Agneau");
      // The underscore is the apostrophe, so this is no rename.
      expect(lamb).toMatchObject({ bucket: "different", matchedBy: "id", content: "different", later: "a" });
      // Untouched since the upgrade: dated by the file it was made from, found through the registry.
      expect(lamb.b.edited).toEqual({ at: "2026-01-01T00:00:00.000Z", source: "beforeUpgrade" });
      expect(lamb.proposed).toEqual({ pick: "a", reason: "bas edited later (2026-11-10 against 2026-01-01)" });

      const edited = pair("Edited");
      expect(edited.b.edited).toEqual({ at: "2026-11-15T13:55:23.000Z", source: "history", peer: "42" });
      expect(edited).toMatchObject({ bucket: "different", later: "b", proposed: { pick: "b" } });

      expect(pair("Same")).toMatchObject({ bucket: "identical", matchedBy: "name" });
      // Not dated by a file whose uuid or date says it is not the one the song was made from.
      const upgrade = { source: "none", notAfter: "2026-11-07T16:50:47.000Z" };
      expect(pair("Same").b.edited).toEqual(upgrade);
      expect(pair("Only haut").b.edited).toEqual(upgrade);
      expect(json.b).toMatchObject({ kind: "workspace", upgradedAt: "2026-11-07T16:50:47.000Z", legacy });
      // No words in the data an agent reads.
      expect(JSON.stringify(json)).not.toMatch(/Digne|Seulement|ligne/);
    });

    it("writes each pair's two text views under one name, for git diff", () => {
      expect(fs.readFileSync(path.join(out, "text", "bas", "Chants", "Gloire a l_Agneau.txt"), "utf8")).toBe(
        "[Refrain]\nDigne est l'Agneau\n</script><b>pas du HTML</b>\n"
      );
      expect(fs.readFileSync(path.join(out, "text", "haut", "Chants", "Gloire a l_Agneau.txt"), "utf8")).toBe(
        "[Refrain]\nDigne est l'Agneau de Dieu\n"
      );
      expect(fs.existsSync(path.join(out, "text", "haut", "Chants", "Only haut.txt"))).toBe(true);
    });

    it("writes a self-contained report no lyric can break out of", () => {
      const html = fs.readFileSync(path.join(out, "report.html"), "utf8");
      expect(html.match(/<\/script>/g)).toHaveLength(2);
      expect(html).toContain("\\u003c/script>\\u003cb>pas du HTML");
      expect(html).not.toMatch(/<(link|img)\b|src=|https?:\/\//);
      const data = JSON.parse(html.match(/<script type="application\/json" id="data">(.*?)<\/script>/s)![1]);
      const lamb = data.pairs.find((p: any) => p.a?.name === "Gloire a l_Agneau");
      expect(lamb.rows[0].b.slides[0].lines[0]).toEqual(["Digne est l'Agneau ", ["de Dieu"]]);
    });

    it("writes again into its own output, and into nothing else that is not empty", async () => {
      // A file a person put among the results, and a link left where the report goes, are theirs: the run stops and removes nothing.
      fs.writeFileSync(path.join(out, "text", "bas", "notes.txt"), "mine");
      const elsewhere = path.join(tmp, "elsewhere.txt");
      fs.writeFileSync(elsewhere, "untouched");
      fs.rmSync(path.join(out, "report.html"));
      fs.symlinkSync(elsewhere, path.join(out, "report.html"));
      const before = tree(out);
      const kept = capture();
      expect(await run(["compare", `bas=${bas}`, `haut=${haut}`, "--out", out], kept)).toBe(1);
      expect(kept.stderr).toContain("were not written by compare");
      expect(tree(out)).toEqual(before);
      expect(fs.readFileSync(elsewhere, "utf8")).toBe("untouched");

      fs.rmSync(path.join(out, "text", "bas", "notes.txt"));
      fs.rmSync(path.join(out, "report.html"));
      expect(await run(["compare", `bas=${bas}`, `haut=${haut}`, "--out", out, "--json"], capture())).toBe(0);
      expect(fs.lstatSync(path.join(out, "report.html")).isFile()).toBe(true);
      expect(tree(out)).toEqual(before.filter((f) => f !== "text/bas/notes.txt"));

      const foreign = path.join(tmp, "foreign");
      fs.mkdirSync(foreign);
      fs.writeFileSync(path.join(foreign, "notes.txt"), "mine");
      const refused = capture();
      expect(await run(["compare", `bas=${bas}`, `haut=${haut}`, "--out", foreign], refused)).toBe(1);
      expect(refused.stderr).toContain("is not empty and is not a folder this command wrote");
      expect(listing(foreign)).toEqual(["notes.txt"]);
    });

    it("answers in JSON for an agent", async () => {
      const json = capture();
      expect(await run(["compare", `bas=${bas}`, `haut=${haut}`, "--out", path.join(tmp, "out-json"), "--json"], json)).toBe(0);
      const parsed = JSON.parse(json.stdout);
      expect(parsed.summary.buckets).toMatchObject({ identical: 1, different: 2, renamed: 0, onlyA: 1, onlyB: 1 });
      expect(parsed.files.report).toBe(path.join(tmp, "out-json", "report.html"));
      expect(json.stdout).not.toMatch(/Digne|Seulement|ligne/);
    });
  });

  describe("dump", () => {
    it("writes every song as JSON and text, with an index that holds no words", async () => {
      const out = path.join(tmp, "dump");
      const io = capture();
      expect(await run(["dump", `haut=${haut}`, "--out", out], io)).toBe(0);
      expect(io.stdout).toContain(`haut: 4 songs written to ${out}`);
      const song = JSON.parse(fs.readFileSync(path.join(out, "songs", "Chants", "Edited.json"), "utf8"));
      expect(song).toMatchObject({ name: "Edited", id: EDITED, groups: [{ name: "Refrain", slides: [{ lines: ["Nouvelle ligne"] }] }] });
      expect(fs.readFileSync(path.join(out, "songs", "Chants", "Edited.txt"), "utf8")).toBe("[Refrain]\nNouvelle ligne\n");
      const index = fs.readFileSync(path.join(out, "index.json"), "utf8");
      expect(JSON.parse(index).songs).toHaveLength(4);
      expect(index).not.toContain("Nouvelle");
    });

    it("never writes into the .pro folder a workspace was made from, which it reads too", async () => {
      const before = fs.readdirSync(legacy, { recursive: true });
      const io = capture();
      expect(await run(["dump", `haut=${haut}`, "--out", path.join(legacy, "results")], io)).toBe(1);
      expect(io.stderr).toContain("is inside the library");
      expect(fs.readdirSync(legacy, { recursive: true })).toEqual(before);
    });

    it("prints the songs only when asked", async () => {
      const text = capture();
      expect(await run(["dump", `bas=${bas}`, "--lyrics"], text)).toBe(0);
      expect(text.stdout).toContain("=== Chants/Edited.pro\n[Refrain]\nAncienne ligne\n");
      // What could not be read is said beside the songs, not among them.
      expect(text.stderr).toContain("Chants/Chords.pro: This is a text file");
      expect(text.stdout).not.toContain("Chords.pro");

      const json = capture();
      expect(await run(["dump", `bas=${bas}`, "--lyrics", "--json"], json)).toBe(0);
      expect(JSON.parse(json.stdout).songs.map((s: any) => s.name)).toContain("Only bas");

      const neither = capture();
      expect(await run(["dump", `bas=${bas}`], neither)).toBe(2);
      expect(neither.stderr).toContain("dump needs --out <dir>, or --lyrics");
    });

    it("keeps Libraries/ in a song's path where not every song is under it", async () => {
      const mixed = path.join(tmp, "mixed");
      writeLibrary(mixed, { "Chants/S.pro": spec("S", ["Ici"]), "Libraries/Chants/S.pro": spec("S", ["Là"]) });
      const json = capture();
      expect(await run(["dump", `mixed=${mixed}`, "--lyrics", "--json"], json)).toBe(0);
      expect(JSON.parse(json.stdout).songs.map((s: any) => s.file).sort()).toEqual(["Chants/S.pro", "Libraries/Chants/S.pro"]);
    });
  });

  describe("sources", () => {
    it("lists the registered workspaces, the folder workspaces and Documents, and which is active", async () => {
      const folders = path.join(tmp, "LocalWorkspaces");
      const found = await discover({ workspaces: registry, folders, documents: path.join(tmp, "nowhere") });
      expect(found).toMatchObject({ active: haut, folders: [legacy], documents: undefined });
      expect(found.workspaces).toEqual([
        expect.objectContaining({ root: haut, active: true, cloud: true, present: true, copiedFrom: legacy }),
      ]);
      const text = foundText(found);
      expect(text).toContain(`* ProPresenter: ${haut} (Cloud, schema 22.9.0, active)`);
      expect(text).toContain(`made from ${legacy}`);
      expect(await activeWorkspace(registry)).toBe(haut);

      // With --out, the same list is written, and the terminal gets counts and the folder.
      const out = path.join(tmp, "sources");
      const written = await writeSources(out, found);
      expect(written).toMatchObject({ workspaces: 1, folderWorkspaces: 1, documents: false, active: true });
      expect(fs.readFileSync(path.join(out, "sources.txt"), "utf8")).toBe(`${text}\n`);
      expect(JSON.parse(fs.readFileSync(path.join(out, "sources.json"), "utf8"))).toEqual(JSON.parse(JSON.stringify(found)));
      // Not into a folder inside a library it found.
      await expect(writeSources(path.join(haut, "results"), found)).rejects.toThrow("is inside the library");
      await expect(activeWorkspace(path.join(tmp, "nowhere"))).rejects.toThrow("no active workspace");
    });
  });

  describe("usage", () => {
    it("explains itself, and refuses what it cannot do", async () => {
      const help = capture();
      expect(await run(["--help"], help)).toBe(0);
      expect(help.stdout).toContain("Usage: presenter-garage");
      for (const argv of [[], ["frobnicate"], ["compare", bas], ["compare", bas, haut], ["compare", `x=${bas}`, `x=${haut}`, "--out", tmp], ["compare", `bas=${bas}`, `Bas=${haut}`, "--out", tmp], ["--nope"]]) {
        const io = capture();
        expect(await run(argv, io), argv.join(" ")).toBe(2);
      }
      const missing = capture();
      expect(await run(["dump", `x=${path.join(tmp, "missing")}`, "--lyrics", "--json"], missing)).toBe(1);
      expect(JSON.parse(missing.stderr)).toEqual({ error: `Library folder not found: ${path.join(tmp, "missing")}` });
      const file = path.join(tmp, "a-file");
      fs.writeFileSync(file, "");
      const notFolder = capture();
      expect(await run(["dump", `bas=${bas}`, "--out", file], notFolder)).toBe(1);
      expect(notFolder.stderr).toContain("ENOTDIR");
      const unlabelled = capture();
      expect(await run(["dump", path.parse(tmp).root, "--lyrics"], unlabelled)).toBe(1);
      expect(unlabelled.stderr).toContain("a label");
    });
  });
});
