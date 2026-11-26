import { beforeAll, describe, expect, it } from "vitest";
import { applyFixes, EditError, FixError, planLineEdits, presentationRanges, verifyRanges, type LineChange } from "../fixes";
import { decodePresentation, openPresentation, readPresentation, textBoxRanges, type AttributeRange } from "../presentation";
import type { LineFix } from "../fixes";
import { AttributeRangeError, rangesAfter, type Range } from "../ranges";
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

  it("says what styling each line takes, an added line in capitals among them", () => {
    const bytes = song();
    const fixes = plan(bytes, [
      { boxIndex: 0, lineIndex: 0, text: "in capitals", insert: "after" },
      { boxIndex: 1, lineIndex: 0, text: "not", insert: "after" },
      { boxIndex: 6, lineIndex: 0, text: "Que ton nom" },
    ]);
    const { styling } = presentationRanges(decodePresentation(bytes), open(bytes), fixes);
    const caps = { kind: "capitalization", value: 1 };
    expect(styling.map((s) => s.ranges)).toEqual([
      [{ index: 0, ...caps, before: "", after: "in capitals" }],
      [],
      [{ index: 0, ...caps, before: "Que ton nom,", after: "Que ton nom" }],
    ]);
  });

  it("refuses a line added beside a change it takes its capitals from only when both are chosen", () => {
    // All Caps on "A tidy" only. Cut to "A tidy", the line is all in it, and
    // a line added after takes it; added alone, it would not. Unticking the
    // change would write the new line otherwise than the person was shown.
    const bytes = withAttributes(syntheticTextPresentation(), {
      0: [{ range: { start: 0, end: 6 }, capitalization: "CAPITALIZATION_ALL_CAPS" }],
    });
    const fixes = plan(bytes, [
      { boxIndex: 0, lineIndex: 0, text: "A tidy" },
      { boxIndex: 0, lineIndex: 0, text: "new", insert: "after" },
    ]);
    expect(() => presentationRanges(decodePresentation(bytes), open(bytes), fixes)).toThrow(
      new AttributeRangeError(0, "dependsOnChoice", 0)
    );
    // Each on its own is fine, and says what it does.
    for (const fix of fixes) expect(() => presentationRanges(decodePresentation(bytes), open(bytes), [fix])).not.toThrow();
  });

  it("plans a change and a line added beside it together when each reads the same either way", () => {
    const bytes = song();
    const fixes = plan(bytes, [
      { boxIndex: 0, lineIndex: 0, text: "A tidier line" },
      { boxIndex: 0, lineIndex: 0, text: "new", insert: "after" },
      { boxIndex: 0, lineIndex: 0, text: "first", insert: "before" },
    ]);
    const { styling } = presentationRanges(decodePresentation(bytes), open(bytes), fixes);
    // Each line in capitals as a whole, whichever of the others is chosen.
    expect(fixes.map((fix, i) => [fix.after, styling[i].ranges.map((r) => r.after)])).toEqual([
      ["first", ["first"]],
      ["A tidier line", ["A tidier line"]],
      ["new", ["new"]],
    ]);
  });

  it("moves a range inside a line with its text, and refuses text typed at its edge", () => {
    // All Caps on "tidy" only, which the rule before #67 refused outright.
    const bytes = withAttributes(syntheticTextPresentation(), {
      0: [{ range: { start: 2, end: 6 }, capitalization: "CAPITALIZATION_ALL_CAPS" }],
    });
    expect(shown(write(bytes, [{ boxIndex: 0, lineIndex: 0, text: "Oh, a tidy line" }]), 0)[0]).toBe("Oh, a TIDY line");
    expect(() => write(bytes, [{ boxIndex: 0, lineIndex: 0, text: "A tidyish line" }])).toThrow(new FixError("attributeRanges"));
  });

  it("refuses an added line where whether it takes a range would be a guess", () => {
    // A font size over the first line only: the new line would show at it or not, and nobody said which.
    const bytes = withAttributes(syntheticTextPresentation(), {
      0: [{ range: { start: 0, end: 11 }, original_font_size: 120 }],
    });
    const fixes = plan(bytes, [{ boxIndex: 0, lineIndex: 0, text: "new", insert: "after" }]);
    expect(() => presentationRanges(decodePresentation(bytes), open(bytes), fixes)).toThrow(AttributeRangeError);
    expect(() => applyFixes(bytes, fixes)).toThrow(new FixError("attributeRanges"));
  });

  it("takes only All Caps for capitals, refusing a line added beside title case", () => {
    const bytes = withAttributes(syntheticTextPresentation(), {
      0: [{ range: { start: 0, end: 11 }, capitalization: "CAPITALIZATION_TITLE_CASE" }],
    });
    expect(textBoxRanges(decodePresentation(bytes)).get(0)![0].caps).toBe(false);
    const fixes = plan(bytes, [{ boxIndex: 0, lineIndex: 0, text: "new", insert: "after" }]);
    expect(() => applyFixes(bytes, fixes)).toThrow(new FixError("attributeRanges"));
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
 * `ranges`: every character but the spaces and tabs at either end, which
 * show no case. An empty line is when one reaches it -- a placeholder's All
 * Caps over no characters -- since whatever is typed there comes out in
 * capitals.
 */
function capsOnLines(lines: readonly string[], ranges: readonly { start: number; end: number; caps?: boolean }[]): boolean[] {
  const caps = [...ranges.filter((r) => r.caps)].sort((a, b) => a.start - b.start);
  let at = 0;
  return lines.map((line) => {
    const start = at;
    at += line.length + 1;
    if (line.length === 0) return caps.some((r) => r.start <= start && r.end >= start);
    const lead = line.length - line.trimStart().length;
    const trail = line.length - line.trimEnd().length;
    if (lead === line.length) return caps.some((r) => r.start <= start + line.length && r.end >= start);
    // Several ranges may meet over one line; walk them in order.
    let reached = start + lead;
    for (const r of caps) if (r.start <= reached) reached = Math.max(reached, r.end);
    return reached >= start + line.length - trail;
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
/** A fix as `rangesAfter` reads it: which line, which side, what it says. */
const fix = (lineIndex: number, after: string | null, insert?: "before" | "after"): LineFix =>
  ({ boxIndex: 0, lineIndex, ...(insert && { insert }), after, before: "", slideIndex: 0, cueName: "", kinds: [], edits: [] }) as unknown as LineFix;
const CAPS = { caps: true, kind: "capitalization", value: 1, style: "caps" };

describe("what each line shows, whichever of the others is chosen", () => {
  it("refuses a line added beside a change whose range a removal on the next line brings to it", () => {
    // RTF {\rtf1\par B\par}, All Caps on "B". With the first line changed,
    // the line added after it is not in capitals; with that change unticked,
    // removing "B" leaves its range where the new line goes, and it would be.
    const box = { boxIndex: 0, lines: [{ text: "" }, { text: "B" }] };
    const fixes = [fix(0, "A"), fix(0, "new", "after"), fix(1, null)];
    expect(() => rangesAfter(box, fixes, [{ start: 1, end: 2, ...CAPS }])).toThrow(new AttributeRangeError(0, "dependsOnChoice", 0));
    // As the person would have left it, it was refused at apply.
    expect(() => rangesAfter(box, [fixes[1], fixes[2]], [{ start: 1, end: 2, ...CAPS }])).toThrow(AttributeRangeError);
  });

  it("never moves a range's end between the halves of a pair", () => {
    // A pair only in the new text: a splice that stopped inside it moved a
    // range over the replaced "X" onto the new character's high half alone.
    const box = { boxIndex: 0, lines: [{ text: "X\uDE00" }] };
    expect(() => rangesAfter(box, [fix(0, "😀")], [{ start: 0, end: 1, ...CAPS }])).toThrow(new AttributeRangeError(0, "replacedAcrossEdge", 0));
    // A lone high half before a pair: a range over the lone half goes to the
    // character replacing it, one over the whole line stays the whole line.
    const lone = { boxIndex: 0, lines: [{ text: "\uD800😀" }] };
    expect(rangesAfter(lone, [fix(0, "A😀")], [{ start: 0, end: 1, ...CAPS }]).moved).toEqual([{ start: 0, end: 1 }]);
    expect(rangesAfter(lone, [fix(0, "A😀")], [{ start: 0, end: 3, ...CAPS }]).moved).toEqual([{ start: 0, end: 3 }]);

    const inside = (s: string, i: number) => /[\uD800-\uDBFF]$/.test(s.slice(0, i)) && /^[\uDC00-\uDFFF]/.test(s.slice(i));
    const changes = [["\uD800😀", "A😀"], ["\uD83DA", "\uD83DB"], ["X\uDE00", "😀"], ["\uD83DA", "😀"], ["😀x", "😁x"], ["a😀b", "a😁😀b"]];
    for (const [before, after] of changes) {
      for (let start = 0; start < before.length; start++) {
        for (let end = start + 1; end <= before.length; end++) {
          // A range that already ends inside a pair is no range ProPresenter writes.
          if (inside(before, start) || inside(before, end)) continue;
          let moved: { start: number; end: number }[];
          try {
            ({ moved } = rangesAfter({ boxIndex: 0, lines: [{ text: before }] }, [fix(0, after)], [{ start, end, ...CAPS }]));
          } catch (error) {
            expect(error).toBeInstanceOf(AttributeRangeError);
            continue;
          }
          const where = `${JSON.stringify(before)} → ${JSON.stringify(after)}, [${start}, ${end})`;
          expect(inside(after, moved[0].start) || inside(after, moved[0].end), where).toBe(false);
        }
      }
    }
  });

  it("plans changes on lines far apart in a box with a range over all of it", () => {
    const lines = ["one", "two", "three", "four", "five", "six", "seven"];
    const box = { boxIndex: 0, lines: lines.map((text) => ({ text })) };
    const fixes = [fix(0, "One"), fix(0, "new", "after"), fix(6, "Seven"), fix(6, "last", "after")];
    const { styling } = rangesAfter(box, fixes, [{ start: 0, end: lines.join("\n").length, ...CAPS }]);
    expect(fixes.map((f) => styling.get(f)!.ranges.map((r) => r.after))).toEqual([["One"], ["new"], ["Seven"], ["last"]]);
  });

  it("holds every line to what it was shown for every choice of the others, on small boxes at random", { timeout: 60_000 }, () => {
    // What is tried at plan time is the changes near each line; this checks
    // that against every choice there is, as an apply of it would run. It
    // fails with only the changes at the same line tried, and passes with
    // those within one line tried.
    // mulberry32, seeded, so a failure comes back the same.
    let seed = 66;
    const random = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    const texts = ["", "A", "B", "A tidy", "\tTab", "x "];
    let planned = 0;
    let checked = 0;
    for (let round = 0; round < 5000; round++) {
      const lines = Array.from({ length: 2 + random(4) }, () => texts[random(texts.length)]);
      const length = lines.join("\n").length;
      const ranges: Range[] = Array.from({ length: 1 + random(2) }, () => {
        const a = random(length + 1);
        const b = random(length + 1);
        return { start: Math.min(a, b), end: Math.max(a, b), ...(random(4) === 0 ? { caps: false, kind: "font", style: "font" } : CAPS) };
      });
      const fixes: LineFix[] = [];
      for (const [i] of lines.entries()) {
        if (random(4) === 0) fixes.push(fix(i, "first", "before"));
        if (random(2) === 0) fixes.push(fix(i, random(2) === 0 ? null : texts[random(texts.length)]));
        if (random(4) === 0) fixes.push(fix(i, "new", "after"));
      }
      if (fixes.length === 0) continue;
      const box = { boxIndex: 0, lines: lines.map((text) => ({ text })) };
      let all: ReturnType<typeof rangesAfter>;
      try {
        all = rangesAfter(box, fixes, ranges);
      } catch (e) {
        if (!(e instanceof AttributeRangeError)) throw e;
        continue;
      }
      planned++;
      // Every selection the person could leave, by the tick boxes they have.
      for (let mask = 1; mask < 1 << fixes.length; mask++) {
        const chosen = fixes.filter((_, j) => mask & (1 << j));
        const at = JSON.stringify({ lines, ranges, chosen: chosen.map((f) => [f.lineIndex, f.insert, f.after]) });
        let some: ReturnType<typeof rangesAfter>;
        try {
          some = rangesAfter(box, chosen, ranges);
        } catch (e) {
          throw new Error(`refused at apply: ${at}`, { cause: e });
        }
        for (const f of chosen) expect(some.styling.get(f), at).toEqual(all.styling.get(f));
        checked++;
      }
    }
    expect(planned).toBeGreaterThan(500);
    expect(checked).toBeGreaterThan(planned);
  });
});

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
