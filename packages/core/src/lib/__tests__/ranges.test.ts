import { beforeAll, describe, expect, it } from "vitest";
import { applyFixes, EditError, FixError, planLineEdits, presentationRanges, verifyRanges, type LineChange } from "../fixes";
import { decodePresentation, openPresentation, readPresentation, textBoxRanges, type AttributeRange } from "../presentation";
import { AttributeRangeError } from "../ranges";
import { hasRealLibrary, libraryFiles, readLibraryFile } from "./corpus";
import { capsByLine, syntheticTextPresentation, textLines, withAttributes } from "./synthetic";

/**
 * A `.pro` file's attribute ranges moving with its text. ProPresenter
 * 20.0.1 does not work them out again on opening a file, nor at its next
 * edit, so a writer that left them put the capitals on the wrong
 * characters; the first cases below are the boxes it was seen to happen in.
 */

const TIDY = ["A tidy line", "And another"];
const COMMA = ["Que ton nom,", "pour toujours ,", "sois glorifie"];
/** The checked song with All Caps over each line of box 0 and box 6, one range to a line. */
const song = () => withAttributes(syntheticTextPresentation(), { 0: capsByLine(TIDY), 6: capsByLine(COMMA) });

const open = (bytes: Uint8Array) => readPresentation(decodePresentation(bytes));
const plan = (bytes: Uint8Array, changes: LineChange[]) => planLineEdits(open(bytes), changes);
const write = (bytes: Uint8Array, changes: LineChange[]) => applyFixes(bytes, plan(bytes, changes));
const ranges = (bytes: Uint8Array, box: number) => textBoxRanges(decodePresentation(bytes)).get(box)!.map((r) => [r.start, r.end]);

/** A box's lines as ProPresenter shows them: every character a capitalization covers in capitals. */
function shown(bytes: Uint8Array, box: number): string[] {
  const text = textLines(bytes)[box].join("\n");
  const caps = textBoxRanges(decodePresentation(bytes)).get(box)!.filter((r) => r.caps);
  return [...text].map((c, i) => (caps.some((r) => r.start <= i && i < r.end) ? c.toUpperCase() : c)).join("").split("\n");
}

describe("moving a .pro file's ranges with its text", () => {
  it("starts from capitals on every line", () => {
    expect(shown(song(), 0)).toEqual(["A TIDY LINE", "AND ANOTHER"]);
    expect(shown(song(), 6)).toEqual(["QUE TON NOM,", "POUR TOUJOURS ,", "SOIS GLORIFIE"]);
  });

  it("adds a line after the first in capitals, and the next keeps its own", () => {
    // ProPresenter 20.0.1, without this: "PG66 APRES la premiere ligne", then "était tombé" in lower case.
    const bytes = write(song(), [{ boxIndex: 0, lineIndex: 0, text: "new line", insert: "after" }]);
    expect(shown(bytes, 0)).toEqual(["A TIDY LINE", "NEW LINE", "AND ANOTHER"]);
    expect(ranges(bytes, 0)).toEqual([
      [0, 20],
      [21, 32],
    ]);
  });

  it("adds a line before the first in capitals, and the first keeps all of its own", () => {
    // Without this: the capitals cut short over the new line and the first.
    const bytes = write(song(), [{ boxIndex: 0, lineIndex: 0, text: "new line", insert: "before" }]);
    expect(shown(bytes, 0)).toEqual(["NEW LINE", "A TIDY LINE", "AND ANOTHER"]);
  });

  it("adds a line after the middle one, and the last keeps its capitals", () => {
    // Without this: "That saved a wretch like me" lost its capitals.
    const bytes = write(song(), [{ boxIndex: 6, lineIndex: 1, text: "x2", insert: "after" }]);
    expect(shown(bytes, 6)).toEqual(["QUE TON NOM,", "POUR TOUJOURS ,", "X2", "SOIS GLORIFIE"]);
  });

  it("adds a line after the last in capitals too, as the line it takes its formatting from", () => {
    const bytes = write(song(), [{ boxIndex: 0, lineIndex: 1, text: "(bis)", insert: "after" }]);
    expect(shown(bytes, 0)).toEqual(["A TIDY LINE", "AND ANOTHER", "(BIS)"]);
  });

  it("keeps each line's capitals when lines grow, shrink or go (#56)", () => {
    const bytes = write(song(), [
      { boxIndex: 0, lineIndex: 0, text: "A much tidier line" },
      { boxIndex: 6, lineIndex: 0, text: "Que" },
      { boxIndex: 6, lineIndex: 1, text: null },
    ]);
    expect(shown(bytes, 0)).toEqual(["A MUCH TIDIER LINE", "AND ANOTHER"]);
    expect(shown(bytes, 6)).toEqual(["QUE", "SOIS GLORIFIE"]);
  });

  it("writes whichever added lines the person leaves ticked, each in capitals", () => {
    const fixes = plan(song(), [
      { boxIndex: 6, lineIndex: 0, text: "one", insert: "before" },
      { boxIndex: 6, lineIndex: 1, text: "two", insert: "after" },
      { boxIndex: 6, lineIndex: 2, text: "three", insert: "after" },
    ]);
    expect(shown(applyFixes(song(), fixes), 6)).toEqual(["ONE", "QUE TON NOM,", "POUR TOUJOURS ,", "TWO", "SOIS GLORIFIE", "THREE"]);
    expect(shown(applyFixes(song(), [fixes[1]]), 6)).toEqual(["QUE TON NOM,", "POUR TOUJOURS ,", "TWO", "SOIS GLORIFIE"]);
    expect(shown(applyFixes(song(), [fixes[0], fixes[2]]), 6)).toEqual(["ONE", "QUE TON NOM,", "POUR TOUJOURS ,", "SOIS GLORIFIE", "THREE"]);
  });

  it("leaves every other box's ranges where they were", () => {
    const bytes = write(song(), [{ boxIndex: 0, lineIndex: 0, text: "new", insert: "after" }]);
    expect(ranges(bytes, 6)).toEqual(ranges(song(), 6));
  });

  it("says which added lines come out in capitals", () => {
    const bytes = song();
    const fixes = plan(bytes, [
      { boxIndex: 0, lineIndex: 0, text: "in capitals", insert: "after" },
      { boxIndex: 1, lineIndex: 0, text: "not", insert: "after" },
    ]);
    const { capitals } = presentationRanges(decodePresentation(bytes), open(bytes), fixes);
    expect([...capitals]).toEqual([fixes[0]]);
  });

  it("refuses a box whose ranges are not on its lines", () => {
    const bytes = withAttributes(syntheticTextPresentation(), {
      0: [{ range: { start: 0, end: 6 }, capitalization: "CAPITALIZATION_ALL_CAPS" }],
    });
    expect(() => write(bytes, [{ boxIndex: 0, lineIndex: 0, text: "A tidier line" }])).toThrow(new FixError("attributeRanges"));
  });

  it("refuses an added line where whether it takes a range would be a guess", () => {
    // A font size over the first line only: the new line would show at it or not, and nobody said which.
    const bytes = withAttributes(syntheticTextPresentation(), {
      0: [{ range: { start: 0, end: 11 }, original_font_size: 120 }],
    });
    const fixes = plan(bytes, [{ boxIndex: 0, lineIndex: 0, text: "new", insert: "after" }]);
    expect(() => presentationRanges(decodePresentation(bytes), open(bytes), fixes)).toThrow(AttributeRangeError);
    expect(() => applyFixes(bytes, fixes)).toThrow(new FixError("addedLineRanges"));
  });

  it("takes only All Caps for capitals, refusing a line added beside title case", () => {
    const bytes = withAttributes(syntheticTextPresentation(), {
      0: [{ range: { start: 0, end: 11 }, capitalization: "CAPITALIZATION_TITLE_CASE" }],
    });
    expect(textBoxRanges(decodePresentation(bytes)).get(0)![0].caps).toBe(false);
    const fixes = plan(bytes, [{ boxIndex: 0, lineIndex: 0, text: "new", insert: "after" }]);
    expect(() => applyFixes(bytes, fixes)).toThrow(new FixError("addedLineRanges"));
  });

  it("refuses a file whose ranges do not read back where they were planned", () => {
    const bytes = song();
    const fixes = plan(bytes, [{ boxIndex: 0, lineIndex: 0, text: "new", insert: "after" }]);
    const planned = presentationRanges(decodePresentation(bytes), open(bytes), fixes);
    const written = textBoxRanges(decodePresentation(applyFixes(bytes, fixes)));
    expect(() => verifyRanges(written, planned)).not.toThrow();

    const shift = (box: number, by: number) => {
      const moved = new Map(written);
      moved.set(box, moved.get(box)!.map((r, i) => (i === 0 ? { ...r, end: r.end + by } : r)));
      return moved;
    };
    // An edited box with a range one character off, and a box no fix touched.
    expect(() => verifyRanges(shift(0, 1), planned)).toThrow(new FixError("verifyFailed"));
    expect(() => verifyRanges(shift(6, -1), planned)).toThrow(new FixError("verifyFailed"));
    const fewer = new Map(written);
    fewer.delete(6);
    expect(() => verifyRanges(fewer, planned)).toThrow(new FixError("verifyFailed"));
  });
});

/**
 * Whether each line is all in capitals, by the capitalizations among
 * `ranges`. An empty line is when one reaches it -- a placeholder's All Caps
 * over no characters -- since whatever is typed there comes out in capitals.
 */
function capsOnLines(lines: readonly string[], ranges: readonly { start: number; end: number; caps?: boolean }[]): boolean[] {
  const caps = ranges.filter((r) => r.caps);
  let at = 0;
  return lines.map((line) => {
    const start = at;
    at += line.length + 1;
    // Several ranges may meet over one line; walk them in order.
    let reached = start;
    for (const r of [...caps].sort((a, b) => a.start - b.start)) if (r.start <= reached) reached = Math.max(reached, r.end);
    if (line.length === 0) return caps.some((r) => r.start <= start && r.end >= start);
    return reached >= start + line.length;
  });
}

/**
 * Over a real library: beside every line of every box with ranges, a line
 * added after it and one before it, and the line itself lengthened. Each
 * that is not refused leaves every line in capitals exactly where it was,
 * and an added line in capitals exactly where its neighbour is. Then one
 * file write per presentation, with the first line added to each box that
 * took one, wherever it went, reads back with every range where it was
 * planned. A ChordPro chart, which shares the extension, is passed over as
 * the app passes it over. Only a machine with a library runs it.
 */
describe.skipIf(!hasRealLibrary)("moving the ranges of a real library", () => {
  const files: { file: string; bytes: Uint8Array }[] = [];

  beforeAll(() => {
    if (!hasRealLibrary) return;
    for (const file of libraryFiles()) files.push({ file, bytes: readLibraryFile(file) });
  });

  it("keeps every line's capitals, and gives an added line its neighbour's", () => {
    type Operation = "after" | "before" | "lengthened";
    const counts = Object.fromEntries(
      (["after", "before", "lengthened"] as const).map((op) => [op, { tried: 0, refused: 0, kept: 0 }])
    ) as Record<Operation, { tried: number; refused: number; kept: number }>;
    const failures: string[] = [];
    let boxes = 0;
    let filesWritten = 0;

    for (const { file, bytes } of files) {
      const opened = openPresentation(bytes);
      if (opened.problem === "notPresentation" || opened.problem === "empty") continue;
      if (opened.problem) {
        failures.push(`${file}: ${opened.problem}`);
        continue;
      }
      const { doc, raw } = opened;
      const all = textBoxRanges(raw);
      const written: LineChange[] = [];
      for (const box of doc.textBoxes) {
        const present: AttributeRange[] = all.get(box.boxIndex) ?? [];
        if (present.length === 0) continue;
        boxes++;
        const lines = box.lines.map((l) => l.text);
        const was = capsOnLines(lines, present);
        let added = false;
        for (const [index, text] of lines.entries()) {
          const tries: [Operation, LineChange, string[], boolean[]][] = [];
          for (const side of ["after", "before"] as const) {
            const at = side === "after" ? index + 1 : index;
            tries.push([
              side,
              { boxIndex: box.boxIndex, lineIndex: index, text: "pg added", insert: side },
              lines.toSpliced(at, 0, "pg added"),
              was.toSpliced(at, 0, was[index]),
            ]);
          }
          tries.push(["lengthened", { boxIndex: box.boxIndex, lineIndex: index, text: `${text} pg` }, lines.with(index, `${text} pg`), was]);

          for (const [op, change, after, want] of tries) {
            if (failures.length >= 5) break;
            let fixes;
            try {
              fixes = planLineEdits(doc, [change]);
            } catch (e) {
              if (e instanceof EditError) continue;
              throw e;
            }
            counts[op].tried++;
            let moved;
            try {
              moved = presentationRanges(raw, doc, fixes).moved.get(box.boxIndex)!;
            } catch (e) {
              if (!(e instanceof AttributeRangeError)) throw e;
              counts[op].refused++;
              continue;
            }
            const got = capsOnLines(after, moved);
            if (got.some((c, i) => c !== want[i])) {
              failures.push(`${file} box ${box.boxIndex} ${JSON.stringify(change)}: ${JSON.stringify(got)} for ${JSON.stringify(want)}`);
              continue;
            }
            counts[op].kept++;
            if (change.insert && !added) {
              written.push(change);
              added = true;
            }
          }
        }
      }
      if (written.length === 0) continue;
      try {
        applyFixes(bytes, planLineEdits(doc, written));
        filesWritten++;
      } catch (e) {
        failures.push(`${file}: ${(e as Error).message}`);
      }
    }

    expect(failures).toEqual([]);
    expect(boxes).toBeGreaterThan(100);
    expect(filesWritten).toBeGreaterThan(100);
    // Counted for each operation, so a rule that refuses one of them
    // wholesale shows here even while the others carry the total.
    for (const [op, { tried, refused, kept }] of Object.entries(counts)) {
      expect(kept + refused, op).toBe(tried);
      expect(tried, op).toBeGreaterThan(1000);
      expect(refused, op).toBeLessThan(tried / 10);
    }
  }, 300_000);
});
