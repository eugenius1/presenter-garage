import { describe, expect, it } from "vitest";
import { examine } from "@presenter-garage/core/lib/fixes";
import { decodePresentation, encodePresentation, type TextIssueKind } from "@presenter-garage/core/lib/presentation";
import { syntheticTextPresentation } from "@presenter-garage/core/lib/__tests__/synthetic";
import { reviewRuns, rowsFor, type ReviewSlide, type Row } from "../rows";

/**
 * Slides of the synthetic song, by index: 0 Clean, 1 Leading, 2 Trailing,
 * 3 Gap, 4 Doubled, 5 Empty, 6 Comma, 7 Punctuation (a full stop on its
 * second line). Each kind of finding sits on one slide.
 */
const SLIDE_OF: Partial<Record<TextIssueKind, number>> = {
  leadingSpace: 1,
  trailingSpace: 2,
  blankLine: 3,
  repeatedSpace: 4,
  trailingFullStop: 7,
};

function review(bytes: Uint8Array, kinds: TextIssueKind[]) {
  const one = examine("Song.pro", bytes);
  const rows = rowsFor(one, new Set(kinds));
  return { rows, ...reviewRuns(rows, one.context, one.report.slideCount) };
}

const song = syntheticTextPresentation("Song");

/** What a run shows: each slide's number and, in order, its rows by key and its other lines by text. */
const shape = (run: ReviewSlide[]) =>
  run.map((slide) => [slide.slideIndex, slide.items.map((item) => ("row" in item ? `row ${item.row.lineIndex}` : item.line.text))]);

/** Every row a set of runs shows, in order. */
const shown = (runs: ReviewSlide[][]): Row[] =>
  runs.flatMap((run) => run.flatMap((slide) => slide.items.flatMap((item) => ("row" in item ? [item.row] : []))));

describe("reviewRuns", () => {
  it("shows a row in the middle with two slides either side, the row in place of its line", () => {
    const { runs, stray } = review(song, ["blankLine"]);
    expect(SLIDE_OF.blankLine).toBe(3);
    expect(runs.map(shape)).toEqual([
      [
        [1, ["Fine here", " leading space"]],
        [2, ["trailing space ", "Fine"]],
        [3, ["Above", "row 1", "Below"]],
        [4, ["two  spaces here"]],
        [5, []],
      ],
    ]);
    expect(runs[0].map((slide) => slide.holdsRow)).toEqual([false, false, true, false, false]);
    expect(runs[0].map((slide) => slide.groupName)).toEqual(["Verse", "Chorus", "Chorus", "Chorus", "Chorus"]);
    expect(stray).toEqual([]);
  });

  it("shows fewer slides at the start and at the end", () => {
    expect(review(song, ["leadingSpace"]).runs.map((run) => run.map((s) => s.slideIndex))).toEqual([[0, 1, 2, 3]]);
    expect(review(song, ["trailingFullStop"]).runs.map(shape)).toEqual([
      [
        [5, []],
        [6, ["Que ton nom,", "pour toujours ,", "sois glorifie"]],
        [7, ["Tu es saint;", "row 1", "et je chanterai…", "Gloire..."]],
      ],
    ]);
  });

  it("shows a single-slide presentation as that slide alone", () => {
    const raw = decodePresentation(song) as any;
    raw.cues = raw.cues.slice(1, 2);
    raw.cue_groups = [{ ...raw.cue_groups[0], cue_identifiers: raw.cue_groups[0].cue_identifiers.slice(1, 2) }];
    const { runs } = review(encodePresentation(raw), ["leadingSpace"]);
    expect(runs.map(shape)).toEqual([[[0, ["Fine here", "row 1"]]]]);
  });

  it("shares the slides of rows close together, each slide once, and parts rows far apart", () => {
    const close = review(song, ["leadingSpace", "trailingSpace", "blankLine", "repeatedSpace"]);
    expect(close.runs.map((run) => run.map((s) => s.slideIndex))).toEqual([[0, 1, 2, 3, 4, 5, 6]]);
    expect(close.runs[0].filter((s) => s.holdsRow).map((s) => s.slideIndex)).toEqual([1, 2, 3, 4]);

    // Slides 1 and 7 (from zero): their runs end at 3 and start at 5.
    const apart = review(song, ["leadingSpace", "trailingFullStop"]);
    expect(apart.runs.map((run) => run.map((s) => s.slideIndex))).toEqual([
      [0, 1, 2, 3],
      [5, 6, 7],
    ]);
  });

  it("shows every row exactly once, and nothing else as a row", () => {
    const { rows, runs, stray } = review(song, ["leadingSpace", "trailingSpace", "blankLine", "repeatedSpace", "trailingFullStop"]);
    expect(rows.length).toBe(5);
    expect([...shown(runs), ...stray].sort((a, b) => a.key.localeCompare(b.key))).toEqual(
      [...rows].sort((a, b) => a.key.localeCompare(b.key))
    );
    expect(stray).toEqual([]);
  });

  it("still shows a row its context does not hold, rather than drop a line that can be ticked", () => {
    const one = examine("Song.pro", song);
    const rows = rowsFor(one, new Set<TextIssueKind>(["leadingSpace"]));
    // Its slide held, its line not: the row goes on the slide.
    const lineless = one.context.map((slide) => ({ ...slide, lines: [] }));
    expect(shape(reviewRuns(rows, lineless, one.report.slideCount).runs[0])).toContainEqual([1, ["row 1"]]);
    // Its slide not held at all: the row comes back apart.
    expect(reviewRuns(rows, [], one.report.slideCount)).toEqual({ runs: [], stray: rows });
  });
});
