import { describe, expect, it } from "vitest";
import { openPresentation } from "@presenter-garage/core/lib/presentation";
import { compareSongs, contentOf, laterOf, looseLine, summarise, summaryText, type Pair } from "../compare";
import { alignGroups, BREAK, sideBySide } from "../diff";
import { nameKey, songOf, songText, type Edited, type Group, type Song } from "../song";
import { proFile, type SongSpec } from "./fixtures";

const NBSP = " ";

function song(spec: SongSpec, file = `Chants/${spec.name}.pro`, edited: Edited = { source: "none" }): Song {
  const opened = openPresentation(proFile(spec));
  if (opened.problem) throw new Error(opened.problem);
  return songOf(file, opened.raw, opened.doc, edited);
}

const VERSE = { name: "Couplet 1", slides: [["Que ton nom", "soit glorifié"], ["Pour toujours"]] };
const CHORUS = { name: "Refrain", slides: [{ lines: ["Gloire à toi"], macros: ["Louange"] }] };

describe("a song", () => {
  it("is its groups in order, each slide's shown lines and macros, its uuid and its findings", () => {
    const s = song({
      name: "Gloire",
      uuid: "ABCDEF00-0000-4000-8000-000000000001",
      groups: [VERSE, { name: "Refrain", slides: [{ lines: ["", "Gloire à toi, ", ""], macros: ["Louange"] }] }],
    });
    expect(s.name).toBe("Gloire");
    expect(s.id).toBe("abcdef00-0000-4000-8000-000000000001");
    expect(s.groups).toEqual([
      { name: "Couplet 1", slides: [{ lines: ["Que ton nom", "soit glorifié"], macros: [] }, { lines: ["Pour toujours"], macros: [] }] },
      // The blank lines around the words are padding, not part of them.
      { name: "Refrain", slides: [{ lines: ["Gloire à toi, "], macros: ["Louange"] }] },
    ]);
    expect(s.issues).toEqual({ trailingSpace: 1, trailingComma: 1 });
    expect(s.ruleBreaks).toBe(2);
  });

  it("reads as [Group] headers, then each slide's lines", () => {
    expect(songText(song({ name: "S", groups: [VERSE, CHORUS] }))).toBe(
      "[Couplet 1]\nQue ton nom\nsoit glorifié\n\nPour toujours\n\n[Refrain]\n(macro: Louange)\nGloire à toi\n"
    );
  });

  it("is matched by name with _ for ', curly apostrophes, either accent composition, case and spacing folded", () => {
    expect(nameKey("Gloire a l_Agneau")).toBe(nameKey("gloire a l'agneau"));
    expect(nameKey("Gloire a l’Agneau")).toBe(nameKey("Gloire a l'Agneau"));
    expect(nameKey("Célébrez")).toBe(nameKey("Célébrez"));
    expect(nameKey("  Two   spaces ")).toBe("two spaces");
    expect(nameKey("Gloire")).not.toBe(nameKey("Gloria"));
  });
});

describe("how two versions differ", () => {
  const groups = (spec: SongSpec["groups"]): Group[] => song({ name: "x", groups: spec }).groups;

  it("is identical only when everything on screen is", () => {
    expect(contentOf(groups([VERSE, CHORUS]), groups([VERSE, CHORUS]))).toBe("identical");
  });

  it("is spacing when only spaces, blank lines or end punctuation differ", () => {
    const loose = { name: "Couplet 1", slides: [["Que  ton nom,", "", "soit glorifié."], ["Pour" + NBSP + "toujours ;"]] };
    expect(contentOf(groups([VERSE]), groups([loose]))).toBe("spacing");
    expect(looseLine(" Pour toujours ; ")).toBe("Pour toujours");
    // A question mark is a different line, not punctuation to fold.
    expect(contentOf(groups([VERSE]), groups([{ name: "Couplet 1", slides: [["Que ton nom ?", "soit glorifié"], ["Pour toujours"]] }]))).toBe(
      "different"
    );
  });

  it("is group names when only they differ, a non-breaking space against a space included", () => {
    expect(contentOf(groups([VERSE]), groups([{ ...VERSE, name: `Couplet${NBSP}1` }]))).toBe("groups");
    expect(contentOf(groups([VERSE]), groups([{ ...VERSE, name: "Verse 1", slides: [["Que ton nom,", "soit glorifié"], ["Pour toujours"]] }]))).toBe(
      "groups"
    );
  });

  it("is different when a word, a slide break or a macro is", () => {
    expect(contentOf(groups([VERSE]), groups([{ name: "Couplet 1", slides: [["Que ton nom", "soit glorifie"], ["Pour toujours"]] }]))).toBe("different");
    expect(contentOf(groups([VERSE]), groups([{ name: "Couplet 1", slides: [["Que ton nom", "soit glorifié", "Pour toujours"]] }]))).toBe("different");
    expect(contentOf(groups([CHORUS]), groups([{ name: "Refrain", slides: [{ lines: ["Gloire à toi"], macros: ["Bienvenue"] }] }]))).toBe(
      "different"
    );
  });
});

describe("which side was edited later", () => {
  it("compares dates where both have one", () => {
    expect(laterOf({ at: "2026-01-02T00:00:00.000Z", source: "file" }, { at: "2026-01-01T00:00:00.000Z", source: "file" })).toBe("a");
    expect(laterOf({ at: "2026-01-01T00:00:00.000Z", source: "file" }, { at: "2026-01-02T00:00:00.000Z", source: "history" })).toBe("b");
    expect(laterOf({ at: "2026-01-01T00:00:00.000Z", source: "file" }, { at: "2026-01-01T00:00:00.000Z", source: "file" })).toBe("same");
  });

  it("knows a workspace song nobody edited since the upgrade is older than an edit after it, and nothing more", () => {
    const untouched: Edited = { source: "none", notAfter: "2026-11-07T16:50:47.000Z" };
    expect(laterOf({ at: "2026-11-10T00:00:00.000Z", source: "file" }, untouched)).toBe("a");
    expect(laterOf(untouched, { at: "2026-11-10T00:00:00.000Z", source: "file" })).toBe("b");
    expect(laterOf({ at: "2026-10-01T00:00:00.000Z", source: "file" }, untouched)).toBe("unknown");
    expect(laterOf({ source: "none" }, { source: "none" })).toBe("unknown");
  });
});

describe("comparing two libraries", () => {
  const labels = { a: "bas", b: "haut" };
  const run = (as: Song[], bs: Song[], prefer = "haut") => compareSongs(as, bs, { labels, prefer });
  const only = (pairs: Pair[]) => {
    expect(pairs).toHaveLength(1);
    return pairs[0];
  };

  it("matches by uuid before name, and calls a different name under one uuid a rename", () => {
    const id = "11111111-0000-4000-8000-000000000001";
    const pair = only(run([song({ name: "Old name", uuid: id, groups: [VERSE] })], [song({ name: "New name", uuid: id.toUpperCase(), groups: [VERSE] })]));
    expect(pair).toMatchObject({ bucket: "renamed", matchedBy: "id", content: "identical" });
    expect(pair.proposed).toBeUndefined();
  });

  it("matches by normalised name where the uuids differ", () => {
    const pair = only(run([song({ name: "Gloire a l_Agneau", groups: [VERSE] })], [song({ name: "Gloire a l’agneau", groups: [VERSE] })]));
    expect(pair).toMatchObject({ bucket: "identical", matchedBy: "name" });
  });

  it("pairs copies sharing a uuid by name, and leaves an ambiguous uuid to the name", () => {
    const id = "22222222-0000-4000-8000-000000000002";
    const pairs = run(
      [song({ name: "Copy", uuid: id, groups: [VERSE] }), song({ name: "Original", uuid: id, groups: [VERSE] })],
      [song({ name: "Original", uuid: id, groups: [VERSE] }), song({ name: "Copy", uuid: id, groups: [CHORUS] })]
    );
    expect(pairs.map((p) => [p.a?.name, p.b?.name, p.matchedBy, p.bucket])).toEqual([
      ["Copy", "Copy", "id", "different"],
      ["Original", "Original", "id", "identical"],
    ]);
  });

  it("prefers the same folder when one name is in several", () => {
    const pair = run(
      [song({ name: "Psaume", groups: [VERSE] }, "DPS/Psaume.pro")],
      [song({ name: "Psaume", groups: [CHORUS] }, "Chants/Psaume.pro"), song({ name: "Psaume", groups: [VERSE] }, "DPS/Psaume.pro")]
    );
    expect(pair.map((p) => [p.a?.file, p.b?.file, p.bucket])).toEqual([
      ["DPS/Psaume.pro", "DPS/Psaume.pro", "identical"],
      [undefined, "Chants/Psaume.pro", "onlyB"],
    ]);
  });

  it("matches every song in its own folder before any across folders", () => {
    // Kept in library order, the song with no counterpart in its folder would
    // otherwise take DPS's before DPS's own song is reached.
    const pairs = run(
      [song({ name: "Psaume", groups: [CHORUS] }, "Autres/Psaume.pro"), song({ name: "Psaume", groups: [VERSE] }, "DPS/Psaume.pro")],
      [song({ name: "Psaume", groups: [VERSE] }, "DPS/Psaume.pro")]
    );
    expect(pairs.map((p) => [p.a?.file, p.b?.file, p.bucket])).toEqual([
      ["Autres/Psaume.pro", undefined, "onlyA"],
      ["DPS/Psaume.pro", "DPS/Psaume.pro", "identical"],
    ]);
  });

  it("lists what only one side has, proposing to keep it", () => {
    const pairs = run([song({ name: "Only here", groups: [VERSE] })], [song({ name: "Only there", groups: [VERSE] })]);
    expect(pairs.map((p) => [p.bucket, p.proposed])).toEqual([
      ["onlyA", { pick: "a", reason: "only in bas" }],
      ["onlyB", { pick: "b", reason: "only in haut" }],
    ]);
  });

  describe("proposes", () => {
    const at = (iso: string): Edited => ({ at: iso, source: "file" });
    const clean = (edited: Edited) => song({ name: "S", groups: [VERSE] }, "Chants/S.pro", edited);
    const messy = (edited: Edited) => song({ name: "S", groups: [{ name: "Couplet 1", slides: [["Que ton nom ", "soit glorifié"]] }] }, "Chants/S.pro", edited);

    it("fewer rule breaks first, whatever the dates", () => {
      const pair = only(run([clean(at("2020-01-01T00:00:00Z"))], [messy(at("2026-01-01T00:00:00Z"))]));
      expect(pair.later).toBe("b");
      expect(pair.proposed).toEqual({ pick: "a", reason: "fewer rule breaks: bas has 0, haut 1" });
    });

    it("then the later edit", () => {
      const other = song({ name: "S", groups: [{ name: "Couplet 1", slides: [["Que ton nom", "soit béni"]] }] }, "Chants/S.pro", at("2026-03-04T00:00:00Z"));
      const pair = only(run([other], [clean(at("2025-01-01T00:00:00Z"))]));
      expect(pair.proposed).toEqual({ pick: "a", reason: "bas edited later (2026-03-04 against 2025-01-01)" });
    });

    it("then the main library, or the first named when neither is", () => {
      const other = song({ name: "S", groups: [{ name: "Couplet 1", slides: [["Que ton nom", "soit béni"]] }] });
      expect(only(run([other], [clean({ source: "none" })])).proposed).toEqual({
        pick: "b",
        reason: "no edit dates to tell them apart; haut is the main library",
      });
      expect(only(run([other], [clean({ source: "none" })], "elsewhere")).proposed).toEqual({
        pick: "a",
        reason: "no edit dates to tell them apart; bas named first",
      });
    });
  });

  it("sums up in counts, without a word of the songs", () => {
    const pairs = run(
      [song({ name: "Same", groups: [VERSE] }), song({ name: "Spaced", groups: [VERSE] }), song({ name: "Gone", groups: [CHORUS] })],
      [song({ name: "Same", groups: [VERSE] }), song({ name: "Spaced", groups: [{ ...VERSE, name: `Couplet${NBSP}1` }] }), song({ name: "New", groups: [CHORUS] })]
    );
    const summary = summarise(pairs, { label: "bas", songs: 3, failures: 0 }, { label: "haut", songs: 3, failures: 0 });
    expect(summary).toMatchObject({
      matched: 2,
      byName: 2,
      buckets: { identical: 1, groups: 1, onlyA: 1, onlyB: 1, different: 0 },
      later: { unknown: 1 },
    });
    const text = summaryText(summary);
    expect(text).toContain("Matched 2 songs (by ID 0, by name 2)");
    expect(text).toContain("1 group names only");
    expect(text).toContain("Only in bas: 1 · only in haut: 1");
    expect(text).not.toContain("glorifié");
  });
});

describe("the side-by-side view", () => {
  const groups = (spec: SongSpec["groups"]): Group[] => song({ name: "x", groups: spec }).groups;
  const named = (...names: string[]) => names.map((name) => ({ name, slides: [] }));

  it("lines up groups by name, sets renamed ones beside each other and leaves extras alone", () => {
    const rows = alignGroups(named("Intro", "Couplet 1", "Refrain", "Pause"), named("Intro", "Verse 1", "Refrain", "Pont", `Pause`));
    expect(rows.map(([a, b]) => [a?.name, b?.name])).toEqual([
      ["Intro", "Intro"],
      ["Couplet 1", "Verse 1"],
      ["Refrain", "Refrain"],
      [undefined, "Pont"],
      ["Pause", "Pause"],
    ]);
    expect(alignGroups(named("Couplet 1"), named(`couplet${NBSP}1`)).map(([a, b]) => [a?.name, b?.name])).toEqual([["Couplet 1", `couplet${NBSP}1`]]);
  });

  it("marks the words and macros one side has and the other does not", () => {
    const [row] = sideBySide(
      groups([{ name: "Refrain", slides: [{ lines: ["Gloire à toi Seigneur"], macros: ["Louange"] }] }]),
      groups([{ name: "Refrain", slides: [{ lines: ["Gloire à Toi Seigneur,"], macros: ["Bienvenue"] }] }])
    );
    expect(row.a!.slides[0]).toEqual({ macros: [["Louange"]], lines: [["Gloire à ", ["toi Seigneur"]]] });
    expect(row.b!.slides[0]).toEqual({ macros: [["Bienvenue"]], lines: [["Gloire à ", ["Toi Seigneur,"]]] });
  });

  it("marks a space of another kind, or a doubled one, between words both sides share", () => {
    const [row] = sideBySide(groups([{ name: "R", slides: [["Que ton nom"]] }]), groups([{ name: "R", slides: [["Que\u00a0ton  nom"]] }]));
    expect(row.a!.slides[0].lines[0]).toEqual(["Que", [" "], "ton", [" "], "nom"]);
    expect(row.b!.slides[0].lines[0]).toEqual(["Que", ["\u00a0"], "ton", ["  "], "nom"]);
  });

  it("marks a line or slide break the other side does not have", () => {
    const [row] = sideBySide(
      groups([{ name: "R", slides: [["il est vivant, il est vivant"], ["alors"]] }]),
      groups([{ name: "R", slides: [["il est vivant,", "il est vivant", "alors"]] }])
    );
    expect(row.a!.slides[0].split).toBe(true);
    expect(row.b!.slides[0].lines[0]).toEqual(["il est vivant,", [BREAK]]);
    expect(row.b!.slides[0].split).toBeUndefined();
  });

  it("marks the whole of a group the other side does not have", () => {
    const rows = sideBySide(groups([VERSE]), groups([VERSE, CHORUS]));
    expect(rows[1]).toEqual({ b: { name: ["Refrain"], slides: [{ macros: [["Louange"]], lines: [[["Gloire à toi"]]] }] } });
  });
});
