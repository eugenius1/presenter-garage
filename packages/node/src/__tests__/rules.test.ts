import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "@presenter-garage/core/lib/rules";
import { findRules, libraryOf, loadRules, rulesSearchDirs, saveRules } from "../rules";

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

describe("a song's library", () => {
  it("is the folder under Libraries, or under the root when there is none", () => {
    expect(libraryOf("/pp", path.join("/pp", "Libraries", "Songs", "Holy.pro"))).toBe("Songs");
    expect(libraryOf("/copy", path.join("/copy", "Songs", "Holy.pro"))).toBe("Songs");
    expect(libraryOf("/copy", path.join("/copy", "Holy.pro"))).toBeUndefined();
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
