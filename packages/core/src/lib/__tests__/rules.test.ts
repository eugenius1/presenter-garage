import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createI18n } from "../../i18n/core";
import { describeFinding, findingTags } from "../../i18n/rules";
import { decodeGroupsDocument, decodeMacrosDocument, readGroups, readMacros } from "../configuration";
import { decodePresentation, openPresentation, readPresentation, type PresentationDoc, type SlideMacro } from "../presentation";
import type { RtfLine } from "../rtf";
import {
  checkRules,
  countByTier,
  DEFAULT_RULES,
  libraryOfSong,
  markerPattern,
  parseRules,
  RulesError,
  unknownMacros,
  type Finding,
  type Rule,
  type RuleSet,
} from "../rules";
import { REAL_LIBRARY, hasRealLibrary, libraryFiles, readLibraryFile } from "./corpus";
import { MACROS, syntheticGroupsFile, syntheticMacroSong, syntheticMacrosFile } from "./synthetic";

/** A song built from its slides alone: group, macros and lines, with nothing else to get in the way. */
function song(slides: { group?: string; macros?: (string | SlideMacro)[]; lines?: string[] }[]): PresentationDoc {
  return {
    name: "Song",
    slideCount: slides.length,
    slides: slides.map((s, slideIndex) => ({
      slideIndex,
      cueName: String(slideIndex + 1),
      groupName: s.group,
      macros: (s.macros ?? []).map((m) => (typeof m === "string" ? { name: m, enabled: true } : m)),
    })),
    textBoxes: slides.flatMap((s, slideIndex) =>
      s.lines
        ? [
            {
              boxIndex: slideIndex,
              slideIndex,
              cueName: String(slideIndex + 1),
              groupName: s.group,
              rtf: "",
              lines: s.lines.map((text, index) => ({ index, text, markupOnly: false, spans: [], sourceStart: 0, sourceEnd: 0 }) as RtfLine),
            },
          ]
        : []
    ),
  };
}

const rules = (...list: Rule[]): RuleSet => ({ version: 1, rules: list, exceptions: [] });
const run = (doc: PresentationDoc, set: RuleSet, library?: string) => checkRules(doc, set, { song: "Song", library });
const brief = (findings: Finding[]) => findings.map((f) => [f.rule, f.slideIndex, f.value ?? f.text]);

describe("rules.json", () => {
  it("reads a valid file back as it was written", () => {
    const set = {
      version: 1,
      source: { file: "RULES.md", sha256: "ab" },
      rules: [
        { id: "marqueurs-repetition", check: "line-marker", tier: 2, markers: ["x{n}", "bis"], means: "repeat" },
        { id: "premiere", check: "slide-macros", tier: 2, where: "first", allowed: ["Welcome"], min: 1, libraries: ["Songs"] },
        { id: "spaces", check: "repeated-space", tier: "off" },
      ],
      exceptions: [{ rule: "premiere", song: "Psalm 2", reason: "read, not sung" }],
    };
    expect(parseRules(set)).toEqual(set);
  });

  it("refuses what it does not understand, listing every problem at once", () => {
    const attempt = () =>
      parseRules({
        version: 2,
        rules: [
          { id: "règle", check: "slide-macros", tier: 4, where: "middle", alowed: ["A"], min: 3, max: 1 },
          { id: "x", check: "no-such-check", tier: 1 },
          { id: "y", check: "last-group", tier: 1 },
          { id: "y", check: "repeated-space", tier: 1 },
        ],
        exceptions: [{ rule: "z" }],
      });
    expect(attempt).toThrow(RulesError);
    let problems: string[] = [];
    try {
      attempt();
    } catch (e) {
      problems = (e as RulesError).problems;
    }
    expect(problems).toEqual([
      "version: must be 1",
      "rules[0] (règle): id must be ASCII letters, digits, '.', '_' or '-'",
      'rules[0] (règle): tier must be 1, 2, 3 or "off"',
      "rules[0] (règle): unknown key alowed for slide-macros",
      'rules[0] (règle): where must be "first" or "rest"',
      "rules[0] (règle): min is more than max",
      expect.stringContaining("rules[1] (x): check must be one of"),
      "rules[2] (y): last-group needs group",
      "rules[3] (y): id is used twice",
      "exceptions[0]: no rule has the id z",
      "exceptions[0]: says nothing about what it covers: give a song, a library or a value",
    ]);
  });

  it("refuses an exception that does not say which rule it is to", () => {
    expect(() => parseRules({ version: 1, rules: [], exceptions: [{ song: "Psalm 2" }] })).toThrow("exceptions[0]: needs the rule it is an exception to");
  });

  it("says when the file is not shaped like rules at all", () => {
    const problems = (value: unknown) => {
      try {
        parseRules(value);
      } catch (e) {
        return (e as RulesError).problems;
      }
      return [];
    };
    expect(problems([])).toEqual(["the file must hold one JSON object"]);
    expect(problems({ version: 1, source: "RULES.md", rules: {}, exceptions: {}, extra: 1 })).toEqual([
      "extra: unknown key",
      "source: must be { file, sha256 }",
      "rules: must be a list",
      "exceptions: must be a list",
    ]);
    expect(problems({ version: 1, rules: [null], exceptions: [null] })).toEqual(["rules[0]: must be an object", "exceptions[0]: must be an object"]);
  });

  it("names every macro a rule gives that ProPresenter's list does not hold", () => {
    const set = rules(
      { id: "a", check: "slide-macros", tier: 2, where: "first", required: ["Welcome"], allowed: ["Praise"] },
      { id: "b", check: "macro-alone", tier: 2, macro: "Praise" }
    );
    expect(unknownMacros(set, { macros: [{ name: "Praise", collections: [] }] })).toEqual(["Welcome"]);
    expect(unknownMacros(set, {})).toEqual([]);
    // A rule kept to one library needs its macros only there.
    const scoped = rules({ id: "a", check: "macro-alone", tier: 2, macro: "Welcome", libraries: ["Songs"] });
    const praiseOnly = { macros: [{ name: "Praise", collections: [] }] };
    expect(unknownMacros(scoped, praiseOnly, { library: "Readings" })).toEqual([]);
    expect(unknownMacros(scoped, praiseOnly, { library: undefined })).toEqual([]);
    expect(unknownMacros(scoped, praiseOnly, { library: "Songs" })).toEqual(["Welcome"]);
    // Every rule, when no song is in question.
    expect(unknownMacros(scoped, praiseOnly)).toEqual(["Welcome"]);
    // A rule that is off stops nothing for a macro since removed.
    const off = rules({ id: "a", check: "macro-alone", tier: "off", macro: "Gone" });
    expect(unknownMacros(off, { macros: [{ name: "Praise", collections: [] }] })).toEqual([]);
  });
});

describe("the checks", () => {
  it("text checks report each line as the Presentations tool does", () => {
    const doc = song([{ group: "Verse", lines: [" Leading", "Two  spaces", "Comma,", "Stop.", "Trail…"] }]);
    expect(run(doc, DEFAULT_RULES).map((f) => [f.rule, f.lineIndex])).toEqual([
      ["leading-trailing-space", 0],
      ["repeated-space", 1],
      ["trailing-comma", 2],
      ["trailing-full-stop", 3],
    ]);
  });

  it("finds a line marker as a whole word, with its count", () => {
    const set = rules({ id: "repeat", check: "line-marker", tier: 2, markers: ["x{n}", "({n}x)", "bis"], means: "repeat" });
    const doc = song([{ group: "Chorus", lines: ["Holy holy x2", "Sing it (3X).", "Again bis", "Six", "x2 at the start", "Box2"] }]);
    expect(run(doc, set).map((f) => f.detail)).toEqual([
      { kind: "marker", marker: "x2", count: 2, means: "repeat" },
      { kind: "marker", marker: "(3X)", count: 3, means: "repeat" },
      { kind: "marker", marker: "bis", count: 2, means: "repeat" },
    ]);
  });

  it("reads the count from a marker that holds {n} twice, rather than failing to build", () => {
    const set = rules({ id: "repeat", check: "line-marker", tier: 2, markers: ["{n}x{n}"], means: "repeat" });
    expect(run(song([{ group: "Chorus", lines: ["Holy 3x4"] }]), set).map((f) => f.detail)).toEqual([
      { kind: "marker", marker: "3x4", count: 3, means: "repeat" },
    ]);
  });

  it("looks for a marker where the rule says", () => {
    const line = (at: "start" | "whole" | "anywhere", text: string) => markerPattern(["(chorus)"], at).test(text);
    expect(line("start", "(Chorus) Holy")).toBe(true);
    expect(line("start", "Holy (chorus)")).toBe(false);
    expect(line("whole", "  (chorus) ")).toBe(true);
    expect(line("whole", "(chorus) Holy")).toBe(false);
    expect(line("anywhere", "Holy (chorus) holy")).toBe(true);
  });

  it("checks group names against ProPresenter's list, and says when only a space differs", () => {
    const set = rules({ id: "groups", check: "group-names", tier: 2 });
    const doc = song([{ group: "Verse\u00a01" }, { group: "Bridge" }, { group: "Chorus" }, { group: "Bridge" }]);
    const config = { groups: [{ name: "Verse 1" }, { name: "Chorus" }] };
    expect(checkRules(doc, set, { song: "Song" }, config).map((f) => f.detail)).toEqual([
      { kind: "groupName", group: "Verse\u00a01", spacing: "Verse 1" },
      { kind: "groupName", group: "Bridge" },
    ]);
    const own = rules({ id: "groups", check: "group-names", tier: 2, names: ["Verse\u00a01", "Bridge", "Chorus"] });
    expect(checkRules(doc, own, { song: "Song" }, config)).toEqual([]);
  });

  it("says nothing about group names when the configured list is empty", () => {
    const set = rules({ id: "groups", check: "group-names", tier: 2 });
    expect(checkRules(song([{ group: "Verse" }]), set, { song: "Song" }, { groups: [] })).toEqual([]);
  });

  it("finds a group straight after another, and a song that does not end on the right one", () => {
    const set = rules(
      { id: "no-pause-after-intro", check: "no-group-after", tier: 2, group: "Pause", after: "Intro" },
      { id: "ends-on-pause", check: "last-group", tier: 2, group: "Pause" }
    );
    const doc = song([{ group: "Intro" }, { group: "Intro" }, { group: "Pause" }, { group: "Verse" }]);
    expect(brief(run(doc, set))).toEqual([
      ["no-pause-after-intro", 2, "Pause"],
      ["ends-on-pause", 3, "Verse"],
    ]);
    expect(run(song([{ group: "Verse" }, { group: "Pause" }]), set)).toEqual([]);
  });

  it("finds a song that does not start on the right group", () => {
    const set = rules({ id: "starts-on-intro", check: "first-group", tier: 2, group: "Intro" });
    expect(run(song([{ group: "Verse" }, { group: "Intro" }]), set).map((f) => [f.slideIndex, f.detail])).toEqual([
      [0, { kind: "firstGroup", expected: "Intro", actual: "Verse" }],
    ]);
    expect(run(song([{}, { group: "Intro" }]), set).map((f) => f.detail)).toEqual([{ kind: "firstGroup", expected: "Intro" }]);
    expect(run(song([{ group: "Intro" }, { group: "Verse" }]), set)).toEqual([]);
    expect(run(song([]), set)).toEqual([]);
  });

  it("finds a repeated group whose words differ, ignoring what the text checks already report", () => {
    const set = rules({ id: "same-chorus", check: "repeated-group-text", tier: 2 });
    const chorus = (lines: string[]) => ({ group: "Chorus", lines });
    const doc = song([chorus(["Holy holy,"]), { group: "Verse", lines: ["Words"] }, chorus(["Holy  holy."]), { group: "Verse", lines: ["Other words"] }]);
    expect(run(doc, set).map((f) => f.detail)).toEqual([{ kind: "repeatedGroup", group: "Verse", firstSlide: 1 }]);
    // The same words broken over two lines on one slide count as a change...
    const between = { group: "Verse", lines: ["Words"] };
    const reflowed = song([chorus(["Holy holy"]), between, chorus(["Holy", "holy"])]);
    expect(run(reflowed, set).map((f) => f.detail)).toEqual([{ kind: "repeatedGroup", group: "Chorus", firstSlide: 0 }]);
    // ...unless the rule says only the words count.
    expect(run(reflowed, rules({ id: "same-chorus", check: "repeated-group-text", tier: 2, ignoreLineBreaks: true }))).toEqual([]);
    // Split over two slides they differ either way: a slide shows them apart.
    const split = run(song([chorus(["Holy holy"]), between, chorus(["Holy"]), chorus(["holy"])]), set);
    expect(split.map((f) => f.detail)).toEqual([{ kind: "repeatedGroup", group: "Chorus", firstSlide: 0 }]);
    const wordsOnly = rules({ id: "same-chorus", check: "repeated-group-text", tier: 2, ignoreLineBreaks: true });
    expect(run(song([chorus(["Holy holy"]), between, chorus(["Holy"]), chorus(["holy"])]), wordsOnly)).toHaveLength(1);
  });

  it("holds each slide's macros to the set, the first slide apart from the rest", () => {
    const set = rules(
      { id: "first", check: "slide-macros", tier: 2, where: "first", allowed: ["Welcome", "Intro", "Praise"], min: 1 },
      { id: "rest", check: "slide-macros", tier: 3, where: "rest", required: ["Praise"], max: 1 }
    );
    const doc = song([
      { macros: [] },
      { macros: ["Praise"] },
      { macros: ["Praise", "Lights"] },
      { macros: [{ name: "Praise", enabled: false }] },
      { macros: ["Welcome"] },
    ]);
    expect(run(doc, set).map((f) => [f.rule, f.slideIndex, f.detail])).toEqual([
      ["first", 0, { kind: "slideMacros", where: "first", missing: [], extra: [], count: 0, min: 1, disabled: [] }],
      ["rest", 2, { kind: "slideMacros", where: "rest", missing: [], extra: ["Lights"], count: 2, max: 1, disabled: [] }],
      ["rest", 3, { kind: "slideMacros", where: "rest", missing: ["Praise"], extra: [], count: 0, max: 1, disabled: ["Praise"] }],
      ["rest", 4, { kind: "slideMacros", where: "rest", missing: ["Praise"], extra: ["Welcome"], count: 1, max: 1, disabled: [] }],
    ]);
  });

  it("leaves the first slide to a first-slide rule even when that rule is off", () => {
    const set = rules(
      { id: "first", check: "slide-macros", tier: "off", where: "first", allowed: ["Welcome"] },
      { id: "rest", check: "slide-macros", tier: 3, where: "rest", required: ["Praise"] }
    );
    expect(run(song([{ macros: ["Welcome"] }, { macros: ["Praise"] }]), set)).toEqual([]);
  });

  it("leaves the first slide to the rest where the first-slide rule is kept to other libraries", () => {
    const set = rules(
      { id: "first", check: "slide-macros", tier: 2, where: "first", allowed: ["Welcome"], libraries: ["Songs"] },
      { id: "rest", check: "slide-macros", tier: 3, where: "rest", required: ["Praise"] }
    );
    const doc = song([{ macros: ["Welcome"] }, { macros: ["Praise"] }]);
    expect(run(doc, set, "Songs")).toEqual([]);
    expect(run(doc, set, "Readings").map((f) => [f.rule, f.slideIndex])).toEqual([["rest", 0]]);
  });

  it("does not count a deleted macro as the new one of the same name", () => {
    const config = { macros: [{ name: "Praise", uuid: "BB-2", collections: [] }] };
    const set = rules({ id: "rest", check: "slide-macros", tier: 3, where: "rest", required: ["Praise"] });
    const deleted = song([{ macros: [{ name: "Praise", uuid: "aa-1", enabled: true }] }]);
    expect(checkRules(deleted, set, { song: "Song" }, config).map((f) => f.detail)).toMatchObject([{ missing: ["Praise"], extra: ["Praise"] }]);
    const unrecorded = song([{ macros: [{ name: "Praise", enabled: true }] }]);
    expect(checkRules(unrecorded, set, { song: "Song" }, config)).toEqual([]);
  });

  it("finds a macro that should stand alone carrying another", () => {
    const set = rules({ id: "alone", check: "macro-alone", tier: 2, macro: "Praise" });
    const doc = song([{ macros: ["Welcome", "Praise"] }, { macros: ["Praise"] }, { macros: ["Welcome", { name: "Lights", enabled: true }] }]);
    expect(run(doc, set).map((f) => [f.slideIndex, f.detail])).toEqual([[0, { kind: "macroAlone", macro: "Praise", others: ["Welcome"] }]]);
  });

  it("matches a renamed macro by its uuid through ProPresenter's list", () => {
    const config = { macros: [{ name: "Praise", uuid: "AB-12", collections: [] }] };
    const set = rules({ id: "rest", check: "slide-macros", tier: 3, where: "rest", required: ["Praise"], max: 1 });
    const doc = song([{ macros: [{ name: "Old name", uuid: "ab-12", enabled: true }] }]);
    expect(checkRules(doc, set, { song: "Song" }, config)).toEqual([]);
  });

  it("gives a library read on its own its name", () => {
    expect(libraryOfSong("Songs", ["Holy.pro"])).toBe("Songs");
    expect(libraryOfSong("ProPresenter", ["Libraries", "Songs", "Holy.pro"])).toBe("Songs");
    expect(libraryOfSong("Libraries", ["Holy.pro"])).toBeUndefined();
  });

  it("runs a rule only on its libraries", () => {
    const set = rules({ id: "ends", check: "last-group", tier: 2, group: "Pause", libraries: ["Songs"] });
    const doc = song([{ group: "Verse" }]);
    expect(run(doc, set, "songs")).toHaveLength(1);
    expect(run(doc, set, "Readings")).toEqual([]);
    expect(run(doc, set)).toEqual([]);
  });

  it("marks what a person excepted, and leaves it out of the counts", () => {
    const set: RuleSet = {
      version: 1,
      rules: [{ id: "groups", check: "group-names", tier: 2, names: ["Verse"] }],
      exceptions: [{ rule: "groups", value: "Psalm 2:1-12", reason: "a reading's heading" }],
    };
    const findings = run(song([{ group: "Psalm 2:1-12" }, { group: "Bridge" }]), set);
    expect(findings.map((f) => [f.value, f.excepted])).toEqual([
      ["Psalm 2:1-12", "a reading's heading"],
      ["Bridge", undefined],
    ]);
    expect(countByTier(findings)).toEqual([0, 1, 0]);
  });

  it("leaves out of the counts an exception given without a reason too", () => {
    const set: RuleSet = {
      version: 1,
      rules: [{ id: "groups", check: "group-names", tier: 2, names: ["Verse"] }],
      exceptions: [{ rule: "groups", value: "Bridge" }],
    };
    const findings = run(song([{ group: "Bridge" }]), set);
    expect(findings.map((f) => f.excepted)).toEqual([""]);
    expect(countByTier(findings)).toEqual([0, 0, 0]);
  });
});

describe("findings in words", () => {
  it("reads each finding in English and in French", () => {
    const set = rules(
      { id: "ends", check: "last-group", tier: 2, group: "Pause" },
      { id: "repeat", check: "line-marker", tier: 2, markers: ["x{n}"], means: "repeat" }
    );
    const [ends, marker] = [...run(song([{ group: "Verse", lines: ["Holy x3"] }]), set)].sort((a, b) => a.rule.localeCompare(b.rule));
    const en = createI18n("en");
    const fr = createI18n("fr");
    expect(describeFinding(en, ends)).toBe('Ends on "Verse", not "Pause"');
    expect(describeFinding(fr, ends)).toBe("Se termine par « Verse », pas par « Pause »");
    expect(describeFinding(en, marker)).toBe('Repeat marker "x3": sung 3 times');
    expect(findingTags(fr, { ...marker, excepted: "" })).toBe("niveau 2, exception");
  });
});

describe("every finding in words", () => {
  const finding = (detail: Finding["detail"]): Finding => ({ rule: "r", check: "last-group", tier: 2, slideIndex: 0, detail });
  const details: Finding["detail"][] = [
    { kind: "text", issue: "trailingComma" },
    { kind: "marker", marker: "(chorus)" },
    { kind: "marker", marker: "x2", count: 2, means: "repeat" },
    { kind: "groupName", group: "Bridge" },
    { kind: "groupName", group: "Verse\u00a01", spacing: "Verse 1" },
    { kind: "groupAfter", group: "Blank", after: "Intro" },
    { kind: "lastGroup", expected: "Blank", actual: "Verse" },
    { kind: "lastGroup", expected: "Blank" },
    { kind: "firstGroup", expected: "Intro", actual: "Verse" },
    { kind: "firstGroup", expected: "Intro" },
    { kind: "repeatedGroup", group: "Chorus", firstSlide: 1 },
    { kind: "slideMacros", where: "rest", missing: ["Song"], extra: [], count: 0, disabled: ["Song"] },
    { kind: "slideMacros", where: "first", missing: [], extra: ["Lights"], count: 3, min: 1, max: 2, disabled: [] },
    { kind: "slideMacros", where: "first", missing: [], extra: [], count: 0, min: 1, disabled: [] },
    { kind: "macroAlone", macro: "Song", others: ["Welcome"] },
  ];

  it("has a sentence in each language for every kind, and never the same one in both", () => {
    const en = createI18n("en");
    const fr = createI18n("fr");
    for (const detail of details) {
      const [english, french] = [describeFinding(en, finding(detail)), describeFinding(fr, finding(detail))];
      expect(english, detail.kind).not.toBe("");
      expect(french, detail.kind).not.toBe(english);
    }
    expect(describeFinding(en, finding(details[12]))).toBe('Not expected here: "Lights"; Takes at most 2 macros');
    // Adding the missing one would still leave the slide short.
    const short = finding({ kind: "slideMacros", where: "first", missing: ["Song"], extra: [], count: 1, min: 3, disabled: [] });
    expect(describeFinding(en, short)).toBe('Missing "Song"; Needs at least 3 macros');
    expect(findingTags(en, { ...finding(details[0]), excepted: "kept" })).toBe("tier 2, excepted: kept");
  });
});

describe("the synthetic macro song", () => {
  it("is checked by uuid against the configured macros and groups", () => {
    const doc = readPresentation(decodePresentation(syntheticMacroSong()));
    const config = {
      groups: readGroups(decodeGroupsDocument(syntheticGroupsFile())),
      macros: readMacros(decodeMacrosDocument(syntheticMacrosFile())),
    };
    const set = rules(
      { id: "first", check: "slide-macros", tier: 2, where: "first", allowed: [MACROS.bienvenue.name, MACROS.louange.name], min: 1 },
      { id: "rest", check: "slide-macros", tier: 3, where: "rest", required: [MACROS.louange.name], max: 1 },
      { id: "groups", check: "group-names", tier: 2 }
    );
    expect(unknownMacros(set, config)).toEqual([]);
    const findings = checkRules(doc, set, { song: "Macro Song" }, config);
    // Its "Couplet 1" carries the non-breaking space the configured one has, so only "Chorus" is unlisted.
    expect(findings.filter((f) => f.rule === "groups").map((f) => f.detail)).toEqual([{ kind: "groupName", group: "Chorus" }]);
    // "Empty" and "Punctuation" carry no macro; "Gap" has a second one, switched off, which does not count.
    expect(findings.filter((f) => f.rule === "rest").map((f) => doc.slides[f.slideIndex].cueName)).toEqual(["Empty", "Punctuation"]);
  });
});

/** Every rule on, over a real library: none may throw, and every finding must point at a slide that exists. */
describe.skipIf(!hasRealLibrary)("a real library", () => {
  let files: string[] = [];
  beforeAll(() => {
    files = libraryFiles();
  });

  it("runs every check on every song", () => {
    const set = rules(
      ...DEFAULT_RULES.rules,
      { id: "markers", check: "line-marker", tier: 2, markers: ["x{n}", "({n}x)", "bis"], means: "repeat" },
      { id: "groups", check: "group-names", tier: 2, names: [] },
      { id: "after", check: "no-group-after", tier: 2, group: "Pause", after: "Intro" },
      { id: "last", check: "last-group", tier: 2, group: "Pause" },
      { id: "same", check: "repeated-group-text", tier: 2 },
      { id: "first", check: "slide-macros", tier: 2, where: "first", min: 1 },
      { id: "rest", check: "slide-macros", tier: 3, where: "rest", max: 1 },
      { id: "alone", check: "macro-alone", tier: 2, macro: "Louange" }
    );
    let total = 0;
    for (const file of files) {
      const opened = openPresentation(readLibraryFile(file));
      if (opened.problem) continue;
      const library = path.relative(REAL_LIBRARY, file).split(path.sep)[0];
      const findings = checkRules(opened.doc, set, { song: path.basename(file, ".pro"), library });
      for (const f of findings) {
        if (f.slideIndex < 0 || f.slideIndex >= opened.doc.slideCount) throw new Error(`${file}: ${f.rule} on slide ${f.slideIndex}`);
      }
      total += findings.length;
    }
    expect(total).toBeGreaterThan(0);
  });
});
