import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeGroupsDocument,
  decodeMacrosDocument,
  readGroups,
  readMacros,
} from "../configuration";
import { checkTypeFidelity, messageType } from "../decode";
import { decodePresentation, readPresentation, slidesInOrder } from "../presentation";
import { groupsFromWorkspace, macrosFromWorkspace } from "../workspace";
import { REAL_LIBRARY, hasRealLibrary, libraryFiles, readLibraryFile } from "./corpus";
import {
  CONFIGURED_GROUPS,
  MACROS,
  syntheticGroupsFile,
  syntheticMacroSong,
  syntheticMacrosFile,
} from "./synthetic";
import { workspaceDocument } from "./workspace-fixtures";

describe("a slide's group and macros", () => {
  const song = () => readPresentation(decodePresentation(syntheticMacroSong()));

  it("lists every slide with its group and the macros it triggers, in ProPresenter's order", () => {
    const { slides } = song();
    expect(slides.map((s) => [s.slideIndex, s.cueName, s.groupName, s.macros.map((m) => m.name)])).toEqual([
      [0, "Clean", "Couplet 1", ["Bienvenue"]],
      [1, "Leading", "Couplet 1", ["Louange"]],
      [2, "Trailing", "Chorus", ["Louange"]],
      [3, "Gap", "Chorus", ["Louange", "Lumières"]],
      [4, "Doubled", "Chorus", ["Louange"]],
      [5, "Empty", "Chorus", []],
      [6, "Comma", "Chorus", ["Louange"]],
      [7, "Punctuation", "Chorus", []],
    ]);
  });

  it("keeps the uuid, and says which macro is switched off", () => {
    const gap = song().slides[3];
    expect(gap.macros).toEqual([
      { name: "Louange", uuid: MACROS.louange.uuid, enabled: true },
      { name: "Lumières", uuid: MACROS.lumieres.uuid, enabled: false },
    ]);
  });

  it("gives the same macros from the slides in order as from the read", () => {
    const raw = decodePresentation(syntheticMacroSong());
    expect(slidesInOrder(raw).map((s) => s.macros)).toEqual(song().slides.map((s) => s.macros));
  });

  it("falls back to the action's own name when the slide does not record the macro's", () => {
    const raw = decodePresentation(syntheticMacroSong()) as any;
    const action = raw.cues.find((c: any) => c.name === "Clean").actions.find((a: any) => a.macro);
    action.macro.identification.parameter_name = "";
    action.name = "Accueil";
    expect(readPresentation(raw).slides[0].macros[0].name).toBe("Accueil");
  });

  it("leaves a slide that is in no group without one", () => {
    const raw = decodePresentation(syntheticMacroSong()) as any;
    raw.cue_groups[0].cue_identifiers.shift();
    const last = readPresentation(raw).slides.at(-1)!;
    expect([last.cueName, last.groupName, last.macros.map((m) => m.name)]).toEqual(["Clean", undefined, ["Bienvenue"]]);
  });
});

describe("the configured groups", () => {
  it("reads each group's exact name, uuid and colour, in order", () => {
    expect(readGroups(decodeGroupsDocument(syntheticGroupsFile()))).toEqual([
      { name: "Couplet 1", uuid: CONFIGURED_GROUPS[0].uuid.string, color: "rgb(0,102,204)" },
      { name: "Couplet 4", uuid: CONFIGURED_GROUPS[1].uuid.string, color: "rgb(0,51,77)" },
      { name: "Refrain", uuid: CONFIGURED_GROUPS[2].uuid.string, color: "rgba(255,69,0,0.5)" },
    ]);
  });

  it("reads a workspace's Groups document the same", () => {
    const message = decodeGroupsDocument(syntheticGroupsFile());
    const { message: converted, unmapped } = groupsFromWorkspace(
      workspaceDocument("rv.data.ProGroupsDocument", message)
    );
    expect(unmapped).toEqual([]);
    // The workspace writes uuids in another case; nothing else differs.
    expect(readGroups(converted).map(({ uuid, ...rest }) => ({ ...rest, uuid: uuid?.toLowerCase() }))).toEqual(
      readGroups(message)
    );
  });

  it("reads nothing from an empty document", () => {
    expect(readGroups(decodeGroupsDocument(new Uint8Array()))).toEqual([]);
  });
});

describe("the configured macros", () => {
  it("reads a Configuration/Macros file, with the collections listing each", () => {
    expect(readMacros(decodeMacrosDocument(syntheticMacrosFile()))).toEqual([
      { ...MACROS.bienvenue, collections: ["Default Collection"] },
      { ...MACROS.louange, collections: ["Default Collection", "Louange"] },
      { ...MACROS.lumieres, collections: [] },
    ]);
  });

  it("reads a workspace's Macros document, which holds each macro inside its collection", () => {
    // Written out from what a real workspace was seen to hold: no macro at
    // the top, upper-case uuids, and the action's oneof as `__tag`.
    const root = {
      macro_collections: [
        {
          name: "Default Collection",
          uuid: "CAF50A82-C688-4D5E-AB60-5FE791A5174B",
          macros: [
            {
              name: "Louange",
              uuid: MACROS.louange.uuid.toUpperCase(),
              image_type: 0,
              trigger_on_startup: false,
              color: { red: 0.3, green: 0.2, blue: 0.7, alpha: 1 },
              actions: [
                {
                  uuid: "9B11746C-1EC8-4F26-BCE9-AC4B1CC0D108",
                  name: "Aspect du public",
                  isEnabled: true,
                  delay_time: 0,
                  duration: 0,
                  type: 18,
                  label: { text: null, color: null },
                  ActionTypeData: {
                    __tag: "audience_look",
                    audience_look: { identification: { parameter_uuid: "D06F4296-EEEC-4610-8B18-6B22E461420E", parameter_name: "Louange" } },
                  },
                },
              ],
            },
            { name: "Intro Louange", uuid: "5A179008-AF4A-4ECC-AD0F-8D4B964301D8", actions: [] },
          ],
        },
      ],
    };
    const { message, unmapped } = macrosFromWorkspace(root);
    expect(unmapped).toEqual([]);
    expect(readMacros(message)).toEqual([
      { name: "Louange", uuid: MACROS.louange.uuid.toUpperCase(), collections: ["Default Collection"] },
      { name: "Intro Louange", uuid: "5A179008-AF4A-4ECC-AD0F-8D4B964301D8", collections: ["Default Collection"] },
    ]);
    expect((message as any).macro_collections[0].macros[0].actions[0].audience_look.identification.parameter_name).toBe(
      "Louange"
    );
  });

  it("lists a macro held both at the top and in a collection once", () => {
    const type = messageType("rv.data.MacrosDocument");
    const louange = { uuid: { string: MACROS.louange.uuid }, name: "Louange" };
    const doc = type.fromObject({
      macros: [louange],
      macro_collections: [{ name: "A", macros: [{ ...louange, uuid: { string: MACROS.louange.uuid.toUpperCase() } }] }],
    });
    expect(readMacros(doc as any)).toEqual([{ ...MACROS.louange, collections: ["A"] }]);
  });

  it("keeps macros with no uuid apart", () => {
    const type = messageType("rv.data.MacrosDocument");
    const doc = type.fromObject({ macros: [{ name: "One" }, { name: "Two" }] });
    expect(readMacros(doc as any).map((m) => m.name)).toEqual(["One", "Two"]);
  });
});

/**
 * ProPresenter's own `Configuration` folder, beside the `Libraries` the
 * presentation tests read. Set PP_CONFIGURATION_DIR to read another. Skipped
 * without one; see *Testing against real files* in CONTRIBUTING.md.
 */
const REAL_CONFIGURATION = process.env.PP_CONFIGURATION_DIR ?? path.join(path.dirname(REAL_LIBRARY), "Configuration");
const realConfig = (name: string) => path.join(REAL_CONFIGURATION, name);
const hasRealConfiguration = fs.existsSync(realConfig("Groups")) && fs.existsSync(realConfig("Macros"));

describe.skipIf(!hasRealConfiguration)("a real Configuration folder", () => {
  it("decodes both lists with nothing the schema does not cover", () => {
    for (const [name, typeName] of [
      ["Groups", "rv.data.ProGroupsDocument"],
      ["Macros", "rv.data.MacrosDocument"],
    ]) {
      expect(checkTypeFidelity(messageType(typeName), fs.readFileSync(realConfig(name))).exportSafe, name).toBe(true);
    }
    const groups = readGroups(decodeGroupsDocument(fs.readFileSync(realConfig("Groups"))));
    const macros = readMacros(decodeMacrosDocument(fs.readFileSync(realConfig("Macros"))));
    expect(groups.length).toBeGreaterThan(0);
    expect(macros.length).toBeGreaterThan(0);
    for (const entry of [...groups, ...macros]) {
      expect(entry.name).not.toBe("");
      expect(entry.uuid).toBeTruthy();
    }
  });

  it.skipIf(!hasRealLibrary)("knows most of the macros the library's slides trigger", () => {
    const configured = new Set(
      readMacros(decodeMacrosDocument(fs.readFileSync(realConfig("Macros")))).map((m) => m.uuid?.toLowerCase())
    );
    let triggered = 0;
    let known = 0;
    for (const file of libraryFiles()) {
      let slides;
      try {
        slides = readPresentation(decodePresentation(readLibraryFile(file))).slides;
      } catch {
        continue;
      }
      for (const macro of slides.flatMap((s) => s.macros)) {
        triggered++;
        if (configured.has(macro.uuid?.toLowerCase())) known++;
      }
    }
    // A macro deleted since a slide was given it is still on the slide, so not all.
    expect(triggered).toBeGreaterThan(0);
    expect(known / triggered).toBeGreaterThan(0.9);
  }, 120_000);
});
