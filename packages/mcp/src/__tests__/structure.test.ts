import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema, type ElicitRequest, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { decodePresentation, readPresentation } from "@presenter-garage/core/lib/presentation";
import { readStructure } from "@presenter-garage/core/lib/structure";
import { syntheticGroupsFile, syntheticMacroSong, syntheticMacrosFile } from "@presenter-garage/core/lib/__tests__/synthetic";
import { connect } from "./connect";
import { describeChange } from "../edits";

/**
 * Renaming a group and swapping a macro through the MCP server, end to end:
 * `read_presentation` gives the addresses, `plan_slide_edits` plans,
 * `apply_slide_edits` asks the person with one tick box per change and
 * writes only what they left ticked. A `.pro` library with ProPresenter's
 * configured lists beside it, built from the synthetic fixtures.
 */

const SONG = "Libraries/Chants/Macro Song.pro";

let dir: string;
let file: string;
let backups: string;
let asked: ElicitRequest[];
let reply: (request: ElicitRequest) => ElicitResult;
let client: Client;
let call: Awaited<ReturnType<typeof connect>>["call"];

type Form = { message: string; requestedSchema: { properties: Record<string, { title: string; description: string }> } };
const form = (request: ElicitRequest) => request.params as unknown as Form;
const structure = () => readStructure(decodePresentation(new Uint8Array(fs.readFileSync(file))));

beforeAll(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-mcp-structure-")));
  const church = path.join(dir, "Church");
  fs.mkdirSync(path.join(church, "Libraries", "Chants"), { recursive: true });
  fs.mkdirSync(path.join(church, "Configuration"));
  fs.writeFileSync(path.join(church, "Configuration", "Groups"), syntheticGroupsFile());
  fs.writeFileSync(path.join(church, "Configuration", "Macros"), syntheticMacrosFile());
  file = path.join(church, SONG);
  backups = path.join(dir, "Backups");
  ({ client, call } = await connect(church, { backupDir: backups }, { elicitation: { form: {} } }));
  client.setRequestHandler(ElicitRequestSchema, (request) => {
    asked.push(request);
    return reply(request);
  });
});

beforeEach(() => {
  fs.writeFileSync(file, syntheticMacroSong());
  asked = [];
  reply = (request) => ({
    action: "accept",
    content: Object.fromEntries(Object.keys(form(request).requestedSchema.properties).map((k) => [k, true])),
  });
});

afterAll(async () => {
  await client?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("changing a song's structure through the MCP server", () => {
  it("lists every group with the index a rename names it by", async () => {
    const read = (await call("read_presentation", { path: SONG })).json();
    expect(read.groups).toEqual([
      { groupIndex: 0, name: "Couplet 1", slides: [0, 1] },
      { groupIndex: 1, name: "Chorus", slides: [2, 3, 4, 5, 6, 7] },
    ]);
  });

  it("plans a rename and a swap without writing, saying each as it is and as it would be", async () => {
    const before = fs.readFileSync(file);
    const planned = (
      await call("plan_slide_edits", {
        renameGroups: [{ path: SONG, groupIndex: 1, name: "Refrain" }],
        swapMacros: [{ path: SONG, slideIndex: 2, from: "Louange", to: "Bienvenue" }],
      })
    ).json();
    expect(planned.files[0].lines).toEqual([]);
    expect(planned.files[0].changes).toEqual([
      {
        n: 1,
        kind: "renameGroup",
        groupIndex: 1,
        slides: [2, 3, 4, 5, 6, 7],
        before: { name: "Chorus", color: "none" },
        after: { name: "Refrain", color: "rgba(255,69,0,0.5)" },
      },
      { n: 2, kind: "swapMacro", slideIndex: 2, group: "Chorus", before: "Louange", after: "Bienvenue" },
    ]);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("asks with one tick box per change, among the slides around it, and writes only those left ticked", async () => {
    const { planId } = (
      await call("plan_slide_edits", {
        edits: [{ path: SONG, boxIndex: 0, lineIndex: 0, text: "A tidier line" }],
        renameGroups: [{ path: SONG, groupIndex: 1, name: "Refrain" }],
        swapMacros: [
          { path: SONG, slideIndex: 2, from: "Louange", to: "Bienvenue" },
          { path: SONG, slideIndex: 3, from: "Louange", to: "Bienvenue" },
        ],
      })
    ).json();
    reply = () => ({ action: "accept", content: { line1: true, change2: true, change3: false, change4: true } });
    const result = (await call("apply_slide_edits", { planId })).json();

    const { message, requestedSchema } = form(asked[0]);
    expect(message).toMatch(/^Make 1 line and 3 other changes in 1 presentation\?/);
    expect(Object.keys(requestedSchema.properties)).toEqual(["line1", "change2", "change3", "change4"]);
    const { change2, change3 } = requestedSchema.properties;
    expect(change2.title).toBe("2. Macro Song (group 2, slides 3, 4, 5, 6, 7, 8)");
    expect(change2.description.split("\n\n")[0]).toBe(
      "Group renamed: “Chorus” → “Refrain”. Colour: none → rgba(255,69,0,0.5), as the configured group has it. " +
        "Arrangements name groups by uuid, which does not change, so each keeps the group where it was."
    );
    expect(change3.title).toBe("3. Macro Song (slide 3, Chorus)");
    expect(change3.description.split("\n\n")[0]).toBe(
      "Macro swapped: “Louange” → “Bienvenue”. Its action is renamed to match: “Louange” → “Bienvenue”."
    );
    // Every change shares the one run of context, the line change's, which marks the rest where they fall.
    const context = requestedSchema.properties.line1.description.split("\n\n").slice(1).join("\n\n");
    expect(context).toContain("> 3 [⟦2: Chorus⟧] (⟦3: Louange⟧)");
    expect(context).toContain("> 4 [⟦2: Chorus⟧] (⟦4: Louange⟧, Lumières (off))");
    expect(context).toContain("  2 [Couplet⍽1] (Louange)");
    expect(change3.description).toMatch(/shown under change 1\.$/);

    expect(result).toMatchObject({ answer: "accept", files: [{ written: true, lines: 3 }] });
    const now = structure();
    expect(now.groups[1].name).toBe("Refrain");
    expect(now.slides[2].macros.map((m) => m.name)).toEqual(["Louange"]);
    expect(now.slides[3].macros.map((m) => m.name)).toEqual(["Bienvenue", "Lumières"]);
    expect(readPresentation(decodePresentation(new Uint8Array(fs.readFileSync(file)))).textBoxes[0].lines[0].text).toBe("A tidier line");
    expect(fs.readFileSync(result.files[0].backup)).toEqual(Buffer.from(syntheticMacroSong()));
  });

  it("says every difference it writes, a colour too close to show and a macro known by one name included", () => {
    const grey = { red: 0.5, green: 0.5, blue: 0.5, alpha: 1 };
    expect(
      describeChange({
        kind: "renameGroup",
        groupIndex: 0,
        slides: [],
        before: { name: "A", color: grey },
        after: { name: "A", color: { ...grey, red: 0.5000001 } },
      })
    ).toContain("Colour: rgb(128,128,128) → rgb(128,128,128), as the configured group has it (the same to the eye, set exactly).");
    expect(
      describeChange({
        kind: "swapMacro",
        slideIndex: 0,
        cueUuid: "c",
        actionIndex: 0,
        macroIndex: 0,
        before: { name: "Louange", uuid: "1", actionName: "Louange" },
        after: { name: "Louange", uuid: "2", actionName: "Louange" },
      })
    ).toBe("Macro swapped: “Louange” (1) → “Louange” (2).");
  });

  it("says a tie moved or cut, a collection moved, and how many slides a group holds", () => {
    const tie = (uuid: string, name: string) => ({ uuid, name });
    const rename = (before: object, after: object, slides: number[]) =>
      ({ kind: "renameGroup", groupIndex: 0, slides, before: { name: "A", ...before }, after: { name: "B", ...after } }) as const;
    expect(describeChange(rename({ link: tie("1", "A") }, {}, []))).toContain("No longer tied to configured group “A”");
    expect(describeChange(rename({ link: tie("1", "A") }, { link: tie("2", "B") }, [0]))).toContain(
      "Tied to configured group “B” (2) instead of “A” (1)."
    );
    expect(
      describeChange({
        kind: "swapMacro",
        slideIndex: 0,
        cueUuid: "c",
        actionIndex: 0,
        macroIndex: 0,
        before: { name: "Louange", uuid: "1", actionName: "x", collection: { uuid: "a", name: "Chants" } },
        after: { name: "Bienvenue", uuid: "2", actionName: "x", collection: { uuid: "b", name: "Chants" } },
      })
    ).toBe("Macro swapped: “Louange” → “Bienvenue”. The slide records it in collection “Chants” (b) instead of “Chants” (a).");
  });

  it("refuses a plan of more changes than one plan takes", async () => {
    const many = Array.from({ length: 201 }, () => ({ path: SONG, groupIndex: 0, name: "x" }));
    expect((await call("plan_slide_edits", { edits: [], renameGroups: many.slice(0, 200), swapMacros: [{ path: SONG, slideIndex: 0, from: "a", to: "b" }] })).text).toMatch(
      /At most 200 changes in one plan/
    );
  });

  it("refuses at plan time what it cannot plan, saying which", async () => {
    const refused = await call("plan_slide_edits", { swapMacros: [{ path: SONG, slideIndex: 2, from: "Louange", to: "Nothing" }] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/slide 2, macro “Louange”: no configured macro has that name or uuid\. Nothing was planned/);
    const empty = await call("plan_slide_edits", {});
    expect(empty.text).toMatch(/No edits given/);
  });

  it("writes nothing when the person turns the plan down", async () => {
    const before = fs.readFileSync(file);
    const { planId } = (await call("plan_slide_edits", { renameGroups: [{ path: SONG, groupIndex: 0, name: "Couplet 1" }] })).json();
    reply = () => ({ action: "decline" });
    expect((await call("apply_slide_edits", { planId })).json()).toEqual({ answer: "decline", files: [] });
    expect(fs.readFileSync(file)).toEqual(before);
  });
});
