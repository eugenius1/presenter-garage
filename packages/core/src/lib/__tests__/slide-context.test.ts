import { describe, expect, it } from "vitest";
import { decodePresentation, encodePresentation, readPresentation } from "../presentation";
import { contextSlides, contextWindows } from "../slide-context";
import { MACROS, syntheticMacroSong, syntheticTextPresentation } from "./synthetic";

const docOf = (bytes: Uint8Array) => readPresentation(decodePresentation(bytes));

/** The synthetic song cut down to its first slide alone. */
function oneSlide(): Uint8Array {
  const raw = decodePresentation(syntheticTextPresentation("One")) as any;
  raw.cues = raw.cues.slice(0, 1);
  raw.cue_groups = [{ ...raw.cue_groups[0], cue_identifiers: raw.cue_groups[0].cue_identifiers.slice(0, 1) }];
  return encodePresentation(raw);
}

describe("contextWindows", () => {
  it("shows two slides either side of a change in the middle", () => {
    expect(contextWindows([10], 20)).toEqual([{ from: 8, to: 12 }]);
  });

  it("shows fewer at the start and the end of a presentation", () => {
    expect(contextWindows([0], 20)).toEqual([{ from: 0, to: 2 }]);
    expect(contextWindows([1], 20)).toEqual([{ from: 0, to: 3 }]);
    expect(contextWindows([19], 20)).toEqual([{ from: 17, to: 19 }]);
  });

  it("shows a single-slide presentation alone", () => {
    expect(contextWindows([0], 1)).toEqual([{ from: 0, to: 0 }]);
  });

  it("shares the context of changes close together, so no slide is shown twice", () => {
    // Overlapping, then only meeting: both one run.
    expect(contextWindows([5, 7], 20)).toEqual([{ from: 3, to: 9 }]);
    expect(contextWindows([5, 10], 20)).toEqual([{ from: 3, to: 12 }]);
    // One slide apart from meeting: two runs.
    expect(contextWindows([5, 11], 20)).toEqual([
      { from: 3, to: 7 },
      { from: 9, to: 13 },
    ]);
  });

  it("takes the changes in any order, each slide once, and ignores slides the presentation has not got", () => {
    expect(contextWindows([12, 2, 2, 40, -1], 20)).toEqual([
      { from: 0, to: 4 },
      { from: 10, to: 14 },
    ]);
    expect(contextWindows([], 20)).toEqual([]);
  });
});

describe("contextSlides", () => {
  // Verse: Clean, Leading. Chorus: Trailing, Gap, Doubled, Empty, Comma, Punctuation.
  const doc = docOf(syntheticTextPresentation("Song"));

  it("gives each slide around a change its group and the lines it shows", () => {
    const slides = contextSlides(doc, [{ slideIndex: 3, boxIndex: 3, lineIndex: 1 }]);
    expect(slides.map((s) => [s.slideIndex, s.groupName, s.lines.map((l) => l.text)])).toEqual([
      [1, "Verse", ["Fine here", " leading space"]],
      [2, "Chorus", ["trailing space ", "Fine"]],
      [3, "Chorus", ["Above", "", "Below"]],
      [4, "Chorus", ["two  spaces here"]],
      // An empty placeholder shows nothing, and is still a slide.
      [5, "Chorus", []],
    ]);
    expect(slides[2].lines.map((l) => [l.boxIndex, l.lineIndex])).toEqual([
      [3, 0],
      [3, 1],
      [3, 2],
    ]);
  });

  it("stops at the start and the end, and shares the slides of changes close together", () => {
    const start = contextSlides(doc, [{ slideIndex: 0, boxIndex: 0, lineIndex: 0 }]);
    expect(start.map((s) => s.slideIndex)).toEqual([0, 1, 2]);
    const end = contextSlides(doc, [{ slideIndex: 7, boxIndex: 7, lineIndex: 0 }]);
    expect(end.map((s) => s.slideIndex)).toEqual([5, 6, 7]);
    const both = contextSlides(doc, [
      { slideIndex: 1, boxIndex: 1, lineIndex: 1 },
      { slideIndex: 2, boxIndex: 2, lineIndex: 0 },
      { slideIndex: 2, boxIndex: 2, lineIndex: 1 },
    ]);
    expect(both.map((s) => s.slideIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it("shows a single-slide presentation as that slide", () => {
    const slides = contextSlides(docOf(oneSlide()), [{ slideIndex: 0, boxIndex: 0, lineIndex: 0 }]);
    expect(slides.map((s) => [s.slideIndex, s.lines.map((l) => l.text)])).toEqual([[0, ["A tidy line", "And another"]]]);
  });

  it("keeps a line a change names even where the slide shows nothing", () => {
    const slides = contextSlides(doc, [{ slideIndex: 5, boxIndex: 5, lineIndex: 0 }]);
    expect(slides.find((s) => s.slideIndex === 5)!.lines).toEqual([{ boxIndex: 5, lineIndex: 0, text: "" }]);
  });

  it("carries each slide's macros, a switched-off one marked so", () => {
    const slides = contextSlides(docOf(syntheticMacroSong()), [{ slideIndex: 3, boxIndex: 3, lineIndex: 0 }]);
    const gap = slides.find((s) => s.slideIndex === 3)!;
    expect(gap.macros).toEqual([
      { name: MACROS.louange.name, uuid: MACROS.louange.uuid, enabled: true },
      { name: MACROS.lumieres.name, uuid: MACROS.lumieres.uuid, enabled: false },
    ]);
    expect(slides.find((s) => s.slideIndex === 5)!.macros).toEqual([]);
  });

  it("shows nothing when nothing changes", () => {
    expect(contextSlides(doc, [])).toEqual([]);
  });
});
