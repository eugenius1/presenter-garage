import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "@presenter-garage/core/lib/rules";
import { findRules, libraryOf, loadRules, rulesConfiguration, rulesSearchDirs, saveRules } from "../rules";
import { openRoots } from "../library";
import { sha256 } from "../write";

const RULES = { version: 1, rules: [{ id: "ends", check: "last-group", tier: 2, group: "Pause" }], exceptions: [] };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("finding the rules", () => {
  it("looks in the working folder, then Documents/ProPresenter", () => {
    expect(rulesSearchDirs("/work", "/home/me")).toEqual(["/work", path.join("/home/me", "Documents", "ProPresenter")]);
  });

  it("takes the first folder holding either file, and both files from it", async () => {
    const empty = path.join(dir, "empty");
    const team = path.join(dir, "team");
    fs.mkdirSync(empty);
    fs.mkdirSync(team);
    fs.writeFileSync(path.join(team, "RULES.md"), "# Our rules\n");
    fs.writeFileSync(path.join(team, "rules.json"), JSON.stringify(RULES));
    expect(await findRules(undefined, [empty, team])).toEqual({ markdown: path.join(team, "RULES.md"), json: path.join(team, "rules.json") });
    expect(await findRules(undefined, [empty])).toBeUndefined();
  });

  it("takes a named file with the other one beside it, and refuses one that is not there", async () => {
    fs.writeFileSync(path.join(dir, "RULES.md"), "# Our rules\n");
    expect(await findRules(path.join(dir, "RULES.md"))).toEqual({ markdown: path.join(dir, "RULES.md") });
    await expect(findRules(path.join(dir, "rules.json"))).rejects.toThrow("Rules file not found");
  });
});

describe("loading and saving", () => {
  it("stands the default text checks in when nothing is compiled yet, and says the prose is waiting", async () => {
    fs.writeFileSync(path.join(dir, "RULES.md"), "# Our rules\n");
    const loaded = await loadRules(await findRules(dir));
    expect(loaded).toMatchObject({ set: DEFAULT_RULES, defaulted: true, stale: true });
  });

  it("stamps the prose's hash when saving, and notices when the prose changes after", async () => {
    const markdown = path.join(dir, "RULES.md");
    fs.writeFileSync(markdown, "# Our rules\n");
    const saved = await saveRules(markdown, RULES);
    expect(saved.path).toBe(path.join(dir, "rules.json"));
    expect(saved.set.source?.file).toBe("RULES.md");

    expect(await loadRules(await findRules(dir))).toMatchObject({ stale: false, defaulted: false, set: { rules: RULES.rules } });
    fs.appendFileSync(markdown, "A new rule.\n");
    expect((await loadRules(await findRules(dir))).stale).toBe(true);
    // No temporary file is left behind.
    expect(fs.readdirSync(dir).sort()).toEqual(["RULES.md", "rules.json"]);
  });

  it("refuses to stamp rules compiled from a RULES.md that has changed since", async () => {
    const markdown = path.join(dir, "RULES.md");
    fs.writeFileSync(markdown, "# Our rules\n");
    const read = sha256(new Uint8Array(fs.readFileSync(markdown)));
    fs.appendFileSync(markdown, "A rule added while the old ones were being compiled.\n");
    await expect(saveRules(markdown, RULES, read)).rejects.toThrow("has changed since it was read");
    expect(fs.existsSync(path.join(dir, "rules.json"))).toBe(false);
    await expect(saveRules(markdown, RULES, sha256(new Uint8Array(fs.readFileSync(markdown))))).resolves.toMatchObject({ path: path.join(dir, "rules.json") });
  });

  it("writes nothing that does not parse, and only beside a RULES.md", async () => {
    const markdown = path.join(dir, "RULES.md");
    fs.writeFileSync(markdown, "# Our rules\n");
    await expect(saveRules(markdown, { version: 1, rules: [{ id: "x", check: "nothing", tier: 1 }] })).rejects.toThrow("check must be one of");
    await expect(saveRules(path.join(dir, "notes.md"), RULES)).rejects.toThrow("beside a RULES.md");
    expect(fs.readdirSync(dir)).toEqual(["RULES.md"]);
  });

  it("says where a broken rules.json is broken", async () => {
    fs.writeFileSync(path.join(dir, "rules.json"), JSON.stringify({ version: 1, rules: [{ id: "a", check: "last-group", tier: 2 }] }));
    await expect(loadRules(await findRules(dir))).rejects.toThrow("last-group needs group");
  });
});

describe("ProPresenter's lists", () => {
  it("says when a list is there but empty, since nothing could be checked against it", async () => {
    fs.mkdirSync(path.join(dir, "Libraries"));
    fs.mkdirSync(path.join(dir, "Configuration"));
    fs.writeFileSync(path.join(dir, "Configuration", "Groups"), new Uint8Array());
    fs.writeFileSync(path.join(dir, "Configuration", "Macros"), new Uint8Array());
    const config = await rulesConfiguration(await openRoots([dir]));
    expect(config.groups).toEqual([]);
    expect(config.problems).toEqual([expect.stringContaining("group list is empty"), expect.stringContaining("macro list is empty")]);
  });
});

describe("a song's library", () => {
  it("is the folder under Libraries, or under the root when there is none, or the root itself", () => {
    expect(libraryOf("/pp", path.join("/pp", "Libraries", "Songs", "Holy.pro"))).toBe("Songs");
    expect(libraryOf("/copy", path.join("/copy", "Songs", "Holy.pro"))).toBe("Songs");
    // A library read on its own keeps its name, so rules kept to it still run.
    expect(libraryOf("/pp/Libraries/Songs", path.join("/pp/Libraries/Songs", "Holy.pro"))).toBe("Songs");
    expect(libraryOf("/pp/Libraries", path.join("/pp/Libraries", "Holy.pro"))).toBeUndefined();
    // A song in a folder inside a library is in that library, whichever folder is read.
    const advent = path.join("/pp", "Libraries", "Songs", "Advent", "Holy.pro");
    expect(libraryOf("/pp", advent)).toBe("Songs");
    expect(libraryOf("/pp/Libraries/Songs", advent)).toBe("Songs");
    expect(libraryOf("/pp/Libraries/Songs/Advent", advent)).toBe("Songs");
  });
});

describe("the repository's sample", () => {
  // The sample is what a team copies: it must load, and its rules.json must be compiled from the RULES.md beside it.
  it("loads, and is compiled from the RULES.md beside it", async () => {
    const sample = path.join(__dirname, "..", "..", "..", "..", "docs", "rules");
    const loaded = await loadRules(await findRules(sample));
    expect(loaded).toMatchObject({ stale: false, defaulted: false });
    expect(loaded.set.rules.length).toBeGreaterThan(0);
  });
});
