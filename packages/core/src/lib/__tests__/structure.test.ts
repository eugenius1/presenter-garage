import { describe, expect, it } from "vitest";
import { decodeGroupsDocument, decodeMacrosDocument, readGroups, readMacros } from "../configuration";
import { applyFixes, FixError, planLineEdits } from "../fixes";
import { decodePresentation, encodePresentation, readPresentation } from "../presentation";
import {
  canonical,
  expectStructure,
  planStructure,
  readStructure,
  sameStructure,
  StructureError,
  type StructureConfiguration,
  type StructureRequest,
} from "../structure";
import { CONFIGURED_GROUPS, MACROS, syntheticGroupsFile, syntheticMacroSong, syntheticMacrosFile, textLines } from "./synthetic";

/**
 * Structural changes to a `.pro` file: a group renamed, a macro swapped.
 * Planned against the synthetic macro song and ProPresenter's configured
 * lists as the synthetic `Configuration` files hold them.
 */

const config: StructureConfiguration = {
  groups: readGroups(decodeGroupsDocument(syntheticGroupsFile())),
  macros: readMacros(decodeMacrosDocument(syntheticMacrosFile())),
};

/** The macro song, with whatever a test needs done to its decoded message first. */
function song(edit?: (doc: any) => void): Uint8Array {
  const doc = decodePresentation(syntheticMacroSong()) as any;
  edit?.(doc);
  return encodePresentation(doc);
}

const plan = (bytes: Uint8Array, requests: StructureRequest[], with_ = config) => planStructure(decodePresentation(bytes), requests, with_);
const structureOf = (bytes: Uint8Array) => readStructure(decodePresentation(bytes));
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof StructureError || e instanceof FixError) return e.reason;
    throw e;
  }
  return undefined;
};

/** A slide's macros by name, in order. */
const macrosOn = (bytes: Uint8Array, slideIndex: number) => structureOf(bytes).slides[slideIndex].macros.map((m) => m.name);

describe("reading a presentation's structure", () => {
  it("has every group with its slides, every slide in order with its group and macros, and the arrangements", () => {
    const bytes = song((doc) => {
      doc.arrangements = [{ uuid: doc.cue_groups[1].group.uuid, name: "Default", group_identifiers: [doc.cue_groups[1].group.uuid, doc.cue_groups[0].group.uuid] }];
    });
    const structure = structureOf(bytes);
    expect(structure.groups.map((g) => [g.name, g.cues.length])).toEqual([
      ["Couplet 1", 2],
      ["Chorus", 6],
    ]);
    expect(structure.slides.map((s) => s.groupIndex)).toEqual([0, 0, 1, 1, 1, 1, 1, 1]);
    expect(structure.slides.map((s) => s.macros.map((m) => [m.name, m.enabled]))).toEqual(
      readPresentation(decodePresentation(bytes)).slides.map((s) => s.macros.map((m) => [m.name, m.enabled]))
    );
    expect(structure.arrangements).toEqual([
      { uuid: structure.groups[1].uuid, name: "Default", groups: [structure.groups[1].uuid, structure.groups[0].uuid] },
    ]);
  });
});

describe("renaming a group", () => {
  it("takes the configured group's colour, keeps its uuid, and leaves the arrangements naming it", () => {
    const bytes = song((doc) => {
      doc.arrangements = [{ name: "Default", group_identifiers: [doc.cue_groups[1].group.uuid] }];
    });
    const [change] = plan(bytes, [{ kind: "renameGroup", groupIndex: 1, name: "Refrain" }]);
    expect(change).toMatchObject({
      kind: "renameGroup",
      groupIndex: 1,
      slides: [2, 3, 4, 5, 6, 7],
      before: { name: "Chorus" },
      after: { name: "Refrain", color: config.groups![2].rgba },
    });

    const written = applyFixes(bytes, [], [change]);
    const before = structureOf(bytes);
    const after = structureOf(written);
    expect(after.groups[1]).toEqual({ ...before.groups[1], name: "Refrain", color: config.groups![2].rgba });
    // Everything else as it was: the other group, every slide, every macro, the arrangement.
    expect(after.groups[0]).toEqual(before.groups[0]);
    expect(after.slides).toEqual(before.slides);
    expect(after.arrangements).toEqual(before.arrangements);
    expect(textLines(written)).toEqual(textLines(bytes));
    expect(readPresentation(decodePresentation(written)).slides.map((s) => s.groupName)).toEqual([
      "Couplet 1",
      "Couplet 1",
      ...Array(6).fill("Refrain"),
    ]);
  });

  it("keeps the group's own colour when the name is not a configured group's", () => {
    const bytes = song((doc) => (doc.cue_groups[1].group.color = { red: 0.5, green: 0.5, blue: 0.5, alpha: 1 }));
    const [change] = plan(bytes, [{ kind: "renameGroup", groupIndex: 1, name: "Pont" }]);
    expect(change.kind === "renameGroup" && change.after.color).toEqual(change.kind === "renameGroup" && change.before.color);
    const after = structureOf(applyFixes(bytes, [], [change]));
    expect(after.groups[1].name).toBe("Pont");
    expect(after.groups[1].color).toEqual(structureOf(bytes).groups[1].color);
  });

  it("ties a group tied to a configured group to the new one, and cuts the tie for a name no configured group has", () => {
    const tied = song((doc) => {
      doc.cue_groups[1].group.application_group_identifier = { string: CONFIGURED_GROUPS[1].uuid.string };
      doc.cue_groups[1].group.application_group_name = "Couplet 4";
    });
    const [toConfigured] = plan(tied, [{ kind: "renameGroup", groupIndex: 1, name: "Refrain" }]);
    expect(structureOf(applyFixes(tied, [], [toConfigured])).groups[1].link).toEqual({ uuid: CONFIGURED_GROUPS[2].uuid.string, name: "Refrain" });

    const [toOwn] = plan(tied, [{ kind: "renameGroup", groupIndex: 1, name: "Pont" }]);
    const written = decodePresentation(applyFixes(tied, [], [toOwn])) as any;
    expect(readStructure(written).groups[1].link).toBeUndefined();
    expect(written.cue_groups[1].group.application_group_identifier).toBeNull();
  });

  it("leaves a group tied to nothing as it was", () => {
    const [change] = plan(song(), [{ kind: "renameGroup", groupIndex: 1, name: "Refrain" }]);
    expect(change.kind === "renameGroup" && change.after.link).toBeUndefined();
  });

  it("refuses what it cannot plan, and plans nothing", () => {
    const bytes = song();
    const at = (requests: StructureRequest[]) => refusal(() => plan(bytes, requests));
    expect(at([{ kind: "renameGroup", groupIndex: 2, name: "x" }])).toBe("noSuchGroup");
    expect(at([{ kind: "renameGroup", groupIndex: 1, name: "  " }])).toBe("badName");
    expect(at([{ kind: "renameGroup", groupIndex: 1, name: "a\nb" }])).toBe("badName");
    expect(at([{ kind: "renameGroup", groupIndex: 1, name: "Chorus" }])).toBe("unchanged");
    expect(
      at([
        { kind: "renameGroup", groupIndex: 1, name: "A" },
        { kind: "renameGroup", groupIndex: 1, name: "B" },
      ])
    ).toBe("duplicate");
  });

  it("refuses without the configured groups, rather than cut a tie it should move", () => {
    const tied = song((doc) => {
      doc.cue_groups[1].group.application_group_identifier = { string: CONFIGURED_GROUPS[1].uuid.string };
      doc.cue_groups[1].group.application_group_name = "Couplet 4";
    });
    const rename: StructureRequest[] = [{ kind: "renameGroup", groupIndex: 1, name: "Refrain" }];
    expect(refusal(() => plan(tied, rename, { macros: config.macros }))).toBe("noGroupList");
    expect(refusal(() => plan(tied, rename, { ...config, groups: [] }))).toBe("noGroupList");
    // Two configured groups of the name: which one's colour and uuid is a guess.
    const twice = { ...config, groups: [...config.groups!, { ...config.groups![2], uuid: "99999999-0000-4000-8000-000000000009" }] };
    expect(refusal(() => plan(tied, rename, twice))).toBe("ambiguousGroup");
    // A configured group of the name with no uuid has nothing to tie the group to.
    const noUuid = { ...config, groups: config.groups!.map((g) => (g.name === "Refrain" ? { ...g, uuid: undefined } : g)) };
    expect(refusal(() => plan(tied, rename, noUuid))).toBe("groupTie");
  });

  it("keeps the exact name asked for, a non-breaking space a different name from a space", () => {
    const [change] = plan(song(), [{ kind: "renameGroup", groupIndex: 0, name: "Couplet 1" }]);
    expect(change.kind === "renameGroup" && change.after).toEqual({ name: "Couplet 1" });
  });
});

describe("swapping a macro", () => {
  // Slide 2 is the first Chorus slide, which triggers Louange.
  const louangeSlide = 2;

  it("records the configured macro's uuid and name on the chosen slide only", () => {
    const bytes = song();
    const [change] = plan(bytes, [{ kind: "swapMacro", slideIndex: louangeSlide, from: "Louange", to: "Bienvenue" }]);
    expect(change).toMatchObject({
      kind: "swapMacro",
      slideIndex: louangeSlide,
      groupName: "Chorus",
      before: { uuid: MACROS.louange.uuid, name: "Louange", actionName: "Louange" },
      after: { uuid: MACROS.bienvenue.uuid, name: "Bienvenue", actionName: "Bienvenue" },
    });

    const written = applyFixes(bytes, [], [change]);
    expect(macrosOn(written, louangeSlide)).toEqual(["Bienvenue"]);
    const before = structureOf(bytes);
    const after = structureOf(written);
    expect(after.slides.filter((_, i) => i !== louangeSlide)).toEqual(before.slides.filter((_, i) => i !== louangeSlide));
    expect(after.groups).toEqual(before.groups);
    expect(textLines(written)).toEqual(textLines(bytes));
  });

  it("names the macro on the slide by uuid too, in either case, and keeps an action renamed by hand", () => {
    const bytes = song((doc) => {
      const cue = doc.cues.find((c: any) => c.name === "Leading");
      cue.actions.find((a: any) => a.macro).name = "My own name";
    });
    const slide = structureOf(bytes).slides.findIndex((s) => s.macros.some((m) => m.actionName === "My own name"));
    const [change] = plan(bytes, [{ kind: "swapMacro", slideIndex: slide, from: MACROS.louange.uuid.toUpperCase(), to: MACROS.bienvenue.uuid }]);
    expect(change.kind === "swapMacro" && change.after.actionName).toBe("My own name");
  });

  it("names a macro the slide records no name for by its action's, as read_presentation lists it", () => {
    const bytes = song((doc) => {
      const cue = doc.cues.find((c: any) => c.name === "Leading");
      cue.actions.find((a: any) => a.macro).macro.identification.parameter_name = "";
    });
    const slide = structureOf(bytes).slides.findIndex((s) => s.macros.some((m) => m.name === ""));
    const [change] = plan(bytes, [{ kind: "swapMacro", slideIndex: slide, from: "Louange", to: "Bienvenue" }]);
    expect(macrosOn(applyFixes(bytes, [], [change]), slide)).toEqual(["Bienvenue"]);
  });

  it("refuses a macro the slide records nothing of its own for", () => {
    const bytes = song((doc) => {
      const cue = doc.cues.find((c: any) => c.name === "Leading");
      cue.actions.find((a: any) => a.macro).macro.identification = null;
    });
    const slide = structureOf(bytes).slides.findIndex((s) => s.macros.some((m) => m.uuid === undefined));
    expect(refusal(() => plan(bytes, [{ kind: "swapMacro", slideIndex: slide, from: "Louange", to: "Bienvenue" }]))).toBe("noIdentification");
  });

  it("moves the collection the slide records to one the new macro is in", () => {
    const bytes = song((doc) => {
      for (const cue of doc.cues) {
        for (const action of cue.actions ?? []) {
          if (action.macro?.identification?.parameter_name !== "Louange") continue;
          action.macro.identification.parent_collection = { parameter_uuid: { string: "00000000-0000-4000-8000-000000006979" }, parameter_name: "Louange" };
        }
      }
    });
    const [change] = plan(bytes, [{ kind: "swapMacro", slideIndex: louangeSlide, from: "Louange", to: "Bienvenue" }]);
    // Bienvenue is not in "Louange", so the slide records the first collection it is in.
    expect(change.kind === "swapMacro" && change.after.collection).toEqual({ uuid: "00000000-0000-4000-8000-000000006978", name: "Default Collection" });
    expect(structureOf(applyFixes(bytes, [], [change])).slides[louangeSlide].macros[0].collection).toEqual({
      uuid: "00000000-0000-4000-8000-000000006978",
      name: "Default Collection",
    });
    // Lumières is in no collection, so a slide recording one cannot take it.
    expect(refusal(() => plan(bytes, [{ kind: "swapMacro", slideIndex: louangeSlide, from: "Louange", to: "Lumières" }]))).toBe("macroCollection");
  });

  it("refuses what it cannot plan", () => {
    const bytes = song();
    const at = (request: Partial<StructureRequest>, with_ = config) =>
      refusal(() => plan(bytes, [{ kind: "swapMacro", slideIndex: louangeSlide, from: "Louange", to: "Bienvenue", ...request } as StructureRequest], with_));
    expect(at({ slideIndex: 99 })).toBe("noSuchSlide");
    expect(at({ from: "Nothing" })).toBe("noSuchMacro");
    expect(at({ to: "Nothing" })).toBe("unknownMacro");
    expect(at({ to: "Louange" })).toBe("unchanged");
    expect(at({}, { groups: config.groups })).toBe("noMacroList");
    const twice = { ...config, macros: [...config.macros!, { ...config.macros![0], uuid: "99999999-0000-4000-8000-000000000009" }] };
    expect(at({}, twice)).toBe("ambiguousMacro");
    expect(
      refusal(() =>
        plan(bytes, [
          { kind: "swapMacro", slideIndex: louangeSlide, from: "Louange", to: "Bienvenue" },
          { kind: "swapMacro", slideIndex: louangeSlide, from: MACROS.louange.uuid, to: "Lumières" },
        ])
      )
    ).toBe("duplicate");
  });
});

describe("writing structural changes", () => {
  it("writes text and structure together, and reads both back", () => {
    const bytes = song();
    const doc = readPresentation(decodePresentation(bytes));
    const fixes = planLineEdits(doc, [{ boxIndex: 0, lineIndex: 0, text: "A tidier line" }]);
    const changes = plan(bytes, [
      { kind: "renameGroup", groupIndex: 1, name: "Refrain" },
      { kind: "swapMacro", slideIndex: 2, from: "Louange", to: "Bienvenue" },
    ]);
    const written = applyFixes(bytes, fixes, changes);
    expect(textLines(written)[0][0]).toBe("A tidier line");
    expect(sameStructure(structureOf(written), expectStructure(structureOf(bytes), changes))).toBe(true);
  });

  it("refuses a change planned against a file that has moved on", () => {
    const bytes = song();
    const [change] = plan(bytes, [{ kind: "renameGroup", groupIndex: 1, name: "Refrain" }]);
    const moved = song((doc) => (doc.cue_groups[1].group.name = "Chorus 2"));
    expect(refusal(() => applyFixes(moved, [], [change]))).toBe("stale");
    const [swap] = plan(bytes, [{ kind: "swapMacro", slideIndex: 2, from: "Louange", to: "Bienvenue" }]);
    const swapped = song((doc) => {
      const cue = doc.cues.find((c: any) => c.uuid.string === (swap as { cueUuid: string }).cueUuid);
      cue.actions.find((a: any) => a.macro).macro.identification.parameter_name = "Other";
    });
    expect(refusal(() => applyFixes(swapped, [], [swap]))).toBe("stale");
  });

  it("refuses nothing at all", () => {
    expect(refusal(() => applyFixes(song(), [], []))).toBe("unchanged");
  });

  it("compares the whole structure, so a change anywhere it was not promised is caught", () => {
    const bytes = song();
    const [change] = plan(bytes, [{ kind: "renameGroup", groupIndex: 1, name: "Refrain" }]);
    const want = expectStructure(structureOf(bytes), [change]);
    const got = structureOf(applyFixes(bytes, [], [change]));
    expect(sameStructure(got, want)).toBe(true);
    // A macro, a slide's place, an arrangement: any of them off is a different structure.
    expect(sameStructure({ ...got, slides: got.slides.toReversed() }, want)).toBe(false);
    expect(sameStructure({ ...got, arrangements: [{ name: "x", groups: [] }] }, want)).toBe(false);
    const macroOff = structuredClone(got);
    macroOff.slides[2].macros[0].enabled = false;
    expect(sameStructure(macroOff, want)).toBe(false);
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
  });
});
