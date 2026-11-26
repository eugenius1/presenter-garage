import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ElicitRequestSchema, type ElicitRequest } from "@modelcontextprotocol/sdk/types.js";
import { MARKER } from "@presenter-garage/node/commands/out-folder";
import { writeLibrary } from "@presenter-garage/node/__tests__/songs";
import { connect } from "./connect";

/**
 * The tools that write their results to a folder: what each leaves there,
 * that its answer is counts and paths without a lyric, and which folders it
 * refuses. The libraries are built for the test, and every run names its
 * rules and where libraries are looked for, so nothing on the computer
 * running the suite is read.
 */

const LYRIC = "Holy holy x3";
const RULES = {
  version: 1,
  rules: [{ id: "repeats", check: "line-marker", tier: 2, markers: ["x{n}"], means: "repeat" }],
  exceptions: [],
};

let tmp: string;
let church: string;
let other: string;
let team: string;
let session: Awaited<ReturnType<typeof connect>>;
const asked: ElicitRequest["params"][] = [];
let reply: "accept" | "decline" = "accept";

/** Every file under a folder, relative, sorted: what a run left behind. */
function listing(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return (fs.readdirSync(dir, { recursive: true }) as string[]).map((f) => f.split(path.sep).join("/")).sort();
}

const text = (file: string) => fs.readFileSync(file, "utf8");

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pg-out-")));
  church = path.join(tmp, "church");
  other = path.join(tmp, "other");
  team = path.join(tmp, "team");
  writeLibrary(church, {
    "Libraries/Songs/Holy.pro": { name: "Holy", groups: [{ name: "Verse", slides: [["One"], [LYRIC], ["Three"]] }] },
    "Libraries/Songs/Clean.pro": { name: "Clean", groups: [{ name: "Verse", slides: [["Words"]] }] },
  });
  writeLibrary(other, {
    "Libraries/Songs/Holy.pro": { name: "Holy", groups: [{ name: "Verse", slides: [["One"], ["Holy holy"], ["Three"]] }] },
    "Libraries/Songs/Elsewhere.pro": { name: "Elsewhere", groups: [{ name: "Verse", slides: [["Only there"]] }] },
  });
  fs.mkdirSync(team);
  fs.writeFileSync(path.join(team, "rules.json"), JSON.stringify(RULES));
  session = await connect(
    church,
    {
      backupDir: path.join(tmp, "backups"),
      rulesDirs: [team],
      sources: { workspaces: path.join(tmp, "no-registry"), folders: path.join(tmp, "no-folders"), documents: church },
    },
    { elicitation: { form: {} } }
  );
  session.client.setRequestHandler(ElicitRequestSchema, (request) => {
    asked.push(request.params);
    return { action: reply };
  });
});

afterAll(async () => {
  await session.client.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("dump_library", () => {
  it("writes every song as JSON and text, and answers with counts and paths alone", async () => {
    const before = listing(church);
    const out = path.join(tmp, "dump");
    const result = await session.call("dump_library", { out });
    expect(result.isError).toBe(false);
    expect(result.text).not.toContain("Holy holy");
    expect(result.json()).toMatchObject({
      out,
      files: { index: path.join(out, "index.json"), songs: path.join(out, "songs") },
      source: { label: "church", root: church, kind: "folder", songs: 2, notRead: 0, truncated: false },
    });
    expect(listing(out)).toEqual([MARKER, "index.json", "songs", "songs/Songs", "songs/Songs/Clean.json", "songs/Songs/Clean.txt", "songs/Songs/Holy.json", "songs/Songs/Holy.txt"]);
    expect(text(path.join(out, "songs", "Songs", "Holy.txt"))).toBe(`[Verse]\nOne\n\n${LYRIC}\n\nThree\n`);
    expect(text(path.join(out, "index.json"))).not.toContain("Holy holy");
    expect(listing(church)).toEqual(before);
  });
});

describe("check_presentations with out", () => {
  it("writes every break with its line, and answers with counts and paths alone", async () => {
    const out = path.join(tmp, "check");
    const result = await session.call("check_presentations", { out, lang: "en" });
    expect(result.isError).toBe(false);
    expect(result.text).not.toContain(LYRIC);
    expect(result.json()).toMatchObject({
      files: { json: path.join(out, "check.json"), text: path.join(out, "check.txt") },
      source: { songs: 2 },
      rules: { json: path.join(team, "rules.json"), rules: 1 },
      breaks: { total: 1, byTier: [0, 1, 0], songs: 1, excepted: 0 },
    });
    const written = JSON.parse(text(path.join(out, "check.json")));
    expect(written.songs).toEqual([
      expect.objectContaining({
        file: "Songs/Holy.pro",
        findings: [expect.objectContaining({ rule: "repeats", slideIndex: 1, text: LYRIC, message: 'Repeat marker "x3": sung 3 times' })],
      }),
    ]);
    expect(text(path.join(out, "check.txt"))).toContain(`>   ${LYRIC}`);
  });

  it("checks only the file or folder it is given, against the whole library's lists", async () => {
    const out = path.join(tmp, "check-one");
    const result = (await session.call("check_presentations", { out, path: "Libraries/Songs/Clean.pro" })).json();
    expect(result).toMatchObject({ source: { songs: 1 }, breaks: { total: 0 } });
    expect((await session.call("check_presentations", { out: path.join(tmp, "check-two"), path: "Playlists" })).isError).toBe(true);
  });
});

describe("compare_libraries", () => {
  it("reads the other library only once the person approves, and writes the comparison", async () => {
    asked.length = 0;
    reply = "accept";
    const out = path.join(tmp, "compare");
    const result = await session.call("compare_libraries", { other, out });
    expect(result.isError).toBe(false);
    expect(asked).toHaveLength(1);
    expect(asked[0].message).toContain(`Read ${other} to compare it with ${church}?`);
    expect(result.text).not.toMatch(/Holy holy|Only there/);
    expect(result.json()).toMatchObject({
      answer: "accept",
      summary: { matched: 1, buckets: { onlyA: 1, onlyB: 1 } },
      a: { label: "church", songs: 2 },
      b: { label: "other", songs: 2 },
      files: { report: path.join(out, "report.html"), text: { a: path.join(out, "text", "church"), b: path.join(out, "text", "other") } },
    });
    expect(listing(out)).toEqual(
      expect.arrayContaining(["compare.json", "report.html", "text/church/Songs/Holy.txt", "text/other/Songs/Holy.txt", "text/other/Songs/Elsewhere.txt"])
    );
  });

  it("reads and writes nothing when the person declines", async () => {
    reply = "decline";
    const out = path.join(tmp, "declined");
    expect((await session.call("compare_libraries", { other, out })).json()).toEqual({ answer: "decline" });
    expect(fs.existsSync(out)).toBe(false);
    reply = "accept";
  });

  it("refuses labels the file system would take for one, and the open library itself, before asking", async () => {
    asked.length = 0;
    const out = path.join(tmp, "unasked");
    const same = await session.call("compare_libraries", { other, out, labels: { open: "A", other: "a" } });
    expect(same.text).toContain("give each its own in `labels`");
    expect((await session.call("compare_libraries", { other: church, out })).text).toContain("is the library open now");
    expect(asked).toHaveLength(0);
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe("find_libraries and check_rules", () => {
  it("write the libraries found and the rules loaded, answering with counts", async () => {
    const sources = path.join(tmp, "sources");
    expect((await session.call("find_libraries", { out: sources })).json()).toMatchObject({
      workspaces: 0,
      folderWorkspaces: 0,
      documents: true,
      active: false,
      files: { json: path.join(sources, "sources.json") },
    });
    expect(JSON.parse(text(path.join(sources, "sources.json")))).toMatchObject({ documents: church });

    const rules = path.join(tmp, "rules");
    expect((await session.call("check_rules", { out: rules })).json()).toMatchObject({ rules: { rules: 1, defaulted: false } });
    expect(JSON.parse(text(path.join(rules, "rules-check.json"))).set.rules[0].id).toBe("repeats");
  });
});

describe("the out folder", () => {
  it("is refused inside the library, or holding it, and nothing is made there", async () => {
    const before = listing(church);
    for (const out of [path.join(church, "results"), church, tmp]) {
      const result = await session.call("dump_library", { out });
      expect(result.isError, out).toBe(true);
    }
    expect((await session.call("dump_library", { out: path.join(church, "results") })).text).toContain("is inside the library");
    expect(listing(church)).toEqual(before);
  });

  it("is refused when it holds anything this tool did not write, which is left as it was", async () => {
    const foreign = path.join(tmp, "foreign");
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, "notes.txt"), "mine");
    const result = await session.call("check_rules", { out: foreign });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("is not empty and is not a folder this command wrote");
    expect(listing(foreign)).toEqual(["notes.txt"]);
  });

  it("is refused when another tool wrote it, and written again by the one that did, keeping what a person added", async () => {
    const out = path.join(tmp, "dump-again");
    expect((await session.call("dump_library", { out })).isError).toBe(false);
    const other = await session.call("check_presentations", { out });
    expect(other.text).toContain("holds what dump wrote");
    fs.writeFileSync(path.join(out, "README.txt"), "beside the results");
    expect((await session.call("dump_library", { out })).isError).toBe(false);
    expect(text(path.join(out, "README.txt"))).toBe("beside the results");

    fs.writeFileSync(path.join(out, "songs", "Songs", "Holy notes.txt"), "among the results");
    const refused = await session.call("dump_library", { out });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("was not written by dump");
    expect(text(path.join(out, "songs", "Songs", "Holy notes.txt"))).toBe("among the results");
    expect(listing(out)).toContain("songs/Songs/Holy.txt");
  });

  it("is written by one call at a time", async () => {
    const out = path.join(tmp, "together");
    const results = await Promise.all([1, 2, 3].map(() => session.call("check_presentations", { out })));
    expect(results.map((r) => r.isError)).toEqual([false, false, false]);
    expect(listing(out)).toEqual([MARKER, "check.json", "check.txt"]);
    expect(JSON.parse(text(path.join(out, MARKER))).files).toEqual(["check.json", "check.txt"]);
  });

  it("is refused when it is not an absolute path", async () => {
    const result = await session.call("dump_library", { out: "results" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Give an absolute folder");
  });
});
