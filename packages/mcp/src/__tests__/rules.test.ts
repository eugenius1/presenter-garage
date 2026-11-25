import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MACROS, syntheticGroupsFile, syntheticMacroSong, syntheticMacrosFile } from "@presenter-garage/core/lib/__tests__/synthetic";
import { connect } from "./connect";

/**
 * The team's rules through the server: found where the agent works, read in
 * their own words, compiled by the model, checked and saved, then run.
 */

let tmp: string;
let church: string;
let team: string;

const RULES = {
  version: 1,
  rules: [
    { id: "premiere-diapo", check: "slide-macros", tier: 2, where: "first", allowed: [MACROS.bienvenue.name, MACROS.louange.name], min: 1 },
    { id: "louange-ailleurs", check: "slide-macros", tier: 3, where: "rest", required: [MACROS.louange.name], max: 1 },
    { id: "groupes", check: "group-names", tier: 2 },
  ],
  exceptions: [{ rule: "groupes", value: "Chorus", reason: "kept on purpose" }],
};

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-mcp-rules-")));
  church = path.join(tmp, "Church");
  fs.mkdirSync(path.join(church, "Libraries", "Chants"), { recursive: true });
  fs.mkdirSync(path.join(church, "Configuration"));
  fs.writeFileSync(path.join(church, "Libraries", "Chants", "Macro Song.pro"), syntheticMacroSong());
  fs.writeFileSync(path.join(church, "Configuration", "Groups"), syntheticGroupsFile());
  fs.writeFileSync(path.join(church, "Configuration", "Macros"), syntheticMacrosFile());
  team = path.join(tmp, "team");
  fs.mkdirSync(team);
  fs.writeFileSync(path.join(team, "RULES.md"), "# Nos règles\n\nLouange sur chaque diapositive.\n");
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("the team's rules", () => {
  it("are pointed out in the instructions, read in the team's words, compiled, saved and run", async () => {
    const { client, call } = await connect([church], { rulesDirs: [team], rules: { markdown: path.join(team, "RULES.md") } });
    expect(client.getInstructions()).toContain(`The team's rules are in ${path.join(team, "RULES.md")}: read them with read_rules`);
    expect(client.getInstructions()).toContain("It has not been compiled yet");

    const read = (await call("read_rules")).json();
    expect(read.markdown.text).toContain("Louange sur chaque diapositive");
    expect(read.json).toBeUndefined();
    expect(Object.keys(read.checks)).toContain("slide-macros");

    // A macro ProPresenter does not have is refused, and nothing is written.
    const wrong = { version: 1, rules: [{ id: "x", check: "macro-alone", tier: 2, macro: "Louanges" }], exceptions: [] };
    const refused = await call("save_rules", { rules: wrong });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Louanges");
    expect(fs.existsSync(path.join(team, "rules.json"))).toBe(false);

    const saved = (await call("save_rules", { rules: RULES })).json();
    expect(saved).toEqual({ path: path.join(team, "rules.json"), rules: 3, exceptions: 1 });
    expect((await call("read_rules")).json()).toMatchObject({ stale: false, json: { path: path.join(team, "rules.json") } });

    const check = (await call("check_presentations", { lang: "fr" })).json();
    expect(check.rules).toMatchObject({ json: path.join(team, "rules.json"), stale: false, defaulted: false });
    expect(check.notes).toEqual([]);
    // "Empty" and "Punctuation" carry no macro; the excepted group is counted apart.
    expect(check.totals).toEqual({ "louange-ailleurs": 2 });
    expect(check.excepted).toBe(1);
    const [song] = check.files;
    expect(song.findings.find((f: { rule: string }) => f.rule === "louange-ailleurs").message).toBe("Aucune macro ; Il manque « Louange »");
    await client.close();
  });

  it("can be tried inline before they are saved", async () => {
    const { client, call } = await connect([church], { rulesDirs: [team] });
    const check = (await call("check_presentations", { rules: { version: 1, rules: [{ id: "ends", check: "last-group", tier: 2, group: "Pause" }], exceptions: [] } })).json();
    expect(check.rules).toMatchObject({ inline: true });
    expect(check.totals).toEqual({ ends: 1 });
    const bad = await call("check_presentations", { rules: { version: 1, rules: [{ id: "ends", check: "last-group", tier: 2 }] } });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("last-group needs group");
    await client.close();
  });

  it("cannot be saved by a read-only server", async () => {
    const { client } = await connect([church], { readOnly: true, rulesDirs: [team] });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("read_rules");
    expect(tools.map((t) => t.name)).not.toContain("save_rules");
    await client.close();
  });
});
