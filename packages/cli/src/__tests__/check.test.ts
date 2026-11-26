import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run, type Io } from "../cli";
import { syntheticMacrosFile } from "@presenter-garage/core/lib/__tests__/synthetic";
import { writeLibrary } from "@presenter-garage/node/__tests__/songs";

/**
 * `check` and `rules check` end to end, over a folder of `.pro` files and a
 * team's rules beside it. Every run names its rules: without `--rules` the
 * command would look in the folder it runs in and in Documents/ProPresenter,
 * which on a developer's computer may hold a real team's.
 */

let tmp: string;
let library: string;
let team: string;

function capture(): Io & { stdout: string; stderr: string } {
  const io = {
    stdout: "",
    stderr: "",
    out: (text: string) => void (io.stdout += `${text}\n`),
    err: (text: string) => void (io.stderr += `${text}\n`),
  };
  return io;
}

const RULES = {
  version: 1,
  rules: [
    { id: "repeats", check: "line-marker", tier: 2, markers: ["x{n}"], means: "repeat" },
    { id: "ends-on-pause", check: "last-group", tier: 2, group: "Pause", libraries: ["Songs"] },
    { id: "praise-alone", check: "macro-alone", tier: 2, macro: "Praise" },
  ],
  exceptions: [{ rule: "ends-on-pause", song: "Reading", reason: "read, not sung" }],
};

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pg-check-")));
  library = path.join(tmp, "library");
  team = path.join(tmp, "team");
  writeLibrary(library, {
    "Songs/Holy.pro": {
      name: "Holy",
      groups: [
        { name: "Verse", slides: [["One"], ["Two"], { lines: ["Holy holy x3"], macros: ["Praise", "Lights"] }, ["Four"], ["Five"], ["Six"]] },
      ],
    },
    "Songs/Reading.pro": { name: "Reading", groups: [{ name: "Verse", slides: [["Words"]] }] },
    "Songs/Clean.pro": { name: "Clean", groups: [{ name: "Verse", slides: [["Words"]] }, { name: "Pause", slides: [[""]] }] },
    "Other/Elsewhere.pro": { name: "Elsewhere", groups: [{ name: "Verse", slides: [["Words"]] }] },
  });
  fs.mkdirSync(team);
  fs.writeFileSync(path.join(team, "RULES.md"), "# Our rules\n");
  fs.writeFileSync(path.join(team, "rules.json"), JSON.stringify(RULES));
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("check", () => {
  it("lists each break with two slides either side, in the language asked for", async () => {
    const io = capture();
    expect(await run(["check", `lib=${library}`, "--rules", team, "--lang", "en"], io)).toBe(0);
    const out = io.stdout;
    expect(out).toContain("=== Songs/Holy.pro");
    expect(out).toContain('slide 3 [Verse]: Repeat marker "x3": sung 3 times (repeats, tier 2)');
    expect(out).toContain('slide 3 [Verse]: "Praise" together with "Lights" (praise-alone, tier 2)');
    // Two slides before and after the one with the break, and not a third.
    expect(out).toContain("  1 [Verse]");
    expect(out).toContain("> 3 [Verse] (Praise, Lights)");
    expect(out).toContain(">   Holy holy x3");
    expect(out).toContain("  5 [Verse]");
    expect(out).not.toContain("  6 [Verse]");
    // The library rule runs in Songs only, and the exception is shown as one.
    expect(out).not.toContain("Elsewhere");
    expect(out).toContain('Ends on "Verse", not "Pause" (ends-on-pause, tier 2, excepted: read, not sung)');
    // RULES.md was written after rules.json was compiled without a hash: it is said to be stale.
    expect(out).toContain("has changed since");
  });

  it("speaks French when asked", async () => {
    const io = capture();
    await run(["check", `lib=${library}`, "--rules", team, "--lang", "fr"], io);
    expect(io.stdout).toContain("diapositive 3 [Verse]: Marqueur de répétition « x3 » : chanté 3 fois (repeats, niveau 2)");
  });

  it("gives an agent where each break is and what it says, and the words only when asked", async () => {
    const io = capture();
    await run(["check", `lib=${library}`, "--rules", team, "--json", "--lang", "en"], io);
    const result = JSON.parse(io.stdout);
    expect(result.rules).toMatchObject({ json: path.join(team, "rules.json"), rules: 3, exceptions: 1, stale: true, defaulted: false });
    const holy = result.songs.find((s: { file: string }) => s.file === "Songs/Holy.pro");
    // Its repeat marker, its macros, and its last group.
    expect(holy.breaks).toEqual([0, 3, 0]);
    expect(holy.findings.find((f: { rule: string }) => f.rule === "repeats")).toMatchObject({ rule: "repeats", slideIndex: 2, message: 'Repeat marker "x3": sung 3 times' });
    expect(io.stdout).not.toContain("Holy holy");

    const withWords = capture();
    await run(["check", `lib=${library}`, "--rules", team, "--json", "--lyrics"], withWords);
    expect(withWords.stdout).toContain("Holy holy x3");
  });

  it("with --out, writes every break and its words there, and prints counts and paths alone", async () => {
    const out = path.join(tmp, "check-out");
    const io = capture();
    expect(await run(["check", `lib=${library}`, "--rules", team, "--lang", "en", "--out", out], io)).toBe(0);
    expect(io.stdout).toContain("lib: 3 rule breaks in 1 of 4 songs, 1 more excepted");
    expect(io.stdout).toContain(`Text: ${path.join(out, "check.txt")}`);
    expect(io.stdout).not.toContain("Holy holy");
    // The same as printed without --out: the files are what the terminal would have shown.
    const printed = capture();
    await run(["check", `lib=${library}`, "--rules", team, "--lang", "en"], printed);
    expect(fs.readFileSync(path.join(out, "check.txt"), "utf8")).toBe(printed.stdout);
    const withWords = capture();
    await run(["check", `lib=${library}`, "--rules", team, "--lang", "en", "--json", "--lyrics"], withWords);
    expect(JSON.parse(fs.readFileSync(path.join(out, "check.json"), "utf8"))).toEqual(JSON.parse(withWords.stdout));

    const json = capture();
    expect(await run(["check", `lib=${library}`, "--rules", team, "--out", out, "--json"], json)).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ breaks: { total: 3, byTier: [0, 3, 0], songs: 1, excepted: 1 }, source: { songs: 4 } });
  });

  it("never writes inside the library it reads", async () => {
    const before = fs.readdirSync(library, { recursive: true });
    const io = capture();
    expect(await run(["check", `lib=${library}`, "--rules", team, "--out", path.join(library, "Songs", "results")], io)).toBe(1);
    expect(io.stderr).toContain("is inside the library");
    expect(fs.readdirSync(library, { recursive: true })).toEqual(before);
  });

  it("refuses rules it cannot read, saying where", async () => {
    const broken = path.join(tmp, "broken");
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, "rules.json"), JSON.stringify({ version: 1, rules: [{ id: "a", check: "last-group", tier: 2 }] }));
    const io = capture();
    expect(await run(["check", `lib=${library}`, "--rules", broken], io)).toBe(1);
    expect(io.stderr).toContain("last-group needs group");
  });
});

describe("check, with ProPresenter's macro list", () => {
  it("reports a file that will not open and checks the rest, though a rule kept to its library names a macro the list lacks", async () => {
    const church = path.join(tmp, "church");
    writeLibrary(church, { "Songs/Holy.pro": { name: "Holy", groups: [{ name: "Verse", slides: [["Words"]] }] } });
    fs.mkdirSync(path.join(church, "Readings"));
    fs.writeFileSync(path.join(church, "Readings", "Chords.pro"), "{title: Not a presentation}\n");
    fs.mkdirSync(path.join(church, "Configuration"));
    fs.writeFileSync(path.join(church, "Configuration", "Macros"), syntheticMacrosFile());
    const rules = path.join(tmp, "kept");
    fs.mkdirSync(rules);
    fs.writeFileSync(
      path.join(rules, "rules.json"),
      JSON.stringify({ version: 1, rules: [{ id: "absent", check: "macro-alone", tier: 2, macro: "Absent", libraries: ["Readings"] }], exceptions: [] })
    );
    const io = capture();
    expect(await run(["check", `church=${church}`, "--rules", rules, "--lang", "en"], io)).toBe(0);
    expect(io.stdout).toContain("Readings/Chords.pro");
    expect(io.stdout).toContain("church: 0 rule breaks in 0 of 1 songs");
  });
});

describe("rules check", () => {
  it("lists the rules and says when RULES.md is newer", async () => {
    const io = capture();
    expect(await run(["rules", "check", path.join(team, "rules.json")], io)).toBe(0);
    expect(io.stdout).toContain("3 rules (tier 1: 0, tier 2: 3, tier 3: 0, off: 0), 1 exceptions");
    expect(io.stdout).toContain("ends-on-pause: last-group, tier 2, only in Songs");
    expect(io.stdout).toContain("compile it again");
  });

  it("with --out, writes the rules there as well as printing them", async () => {
    const out = path.join(tmp, "rules-out");
    const io = capture();
    expect(await run(["rules", "check", path.join(team, "rules.json"), "--out", out], io)).toBe(0);
    expect(io.stdout).toContain(`Written to ${out}`);
    expect(fs.readFileSync(path.join(out, "rules-check.txt"), "utf8")).toContain("ends-on-pause: last-group, tier 2, only in Songs");
    expect(JSON.parse(fs.readFileSync(path.join(out, "rules-check.json"), "utf8"))).toMatchObject({ rules: 3, exceptions: 1, stale: true });
  });

  it("stops the whole read with exit 1, a clean error and nothing printed as findings, when a song opens and its rules name a macro the list lacks", async () => {
    const church = path.join(tmp, "church2");
    writeLibrary(church, { "Songs/Holy.pro": { name: "Holy", groups: [{ name: "Verse", slides: [["Words"]] }] } });
    fs.mkdirSync(path.join(church, "Configuration"));
    fs.writeFileSync(path.join(church, "Configuration", "Macros"), syntheticMacrosFile());
    const rules = path.join(tmp, "kept2");
    fs.mkdirSync(rules);
    fs.writeFileSync(
      path.join(rules, "rules.json"),
      JSON.stringify({ version: 1, rules: [{ id: "absent", check: "macro-alone", tier: 2, macro: "Absent" }], exceptions: [] })
    );
    const io = capture();
    expect(await run(["check", `church=${church}`, "--rules", rules, "--lang", "en"], io)).toBe(1);
    expect(io.stderr).toContain("the rules name macros ProPresenter's list does not have: Absent");
    expect(io.stdout).toBe("");
  });
});
