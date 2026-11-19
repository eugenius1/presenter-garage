import { beforeAll, describe, expect, it } from "vitest";
import { applyFixes, EditError, FixError, planLineEdits, type LineChange } from "../fixes";
import { decodePresentation, readPresentation } from "../presentation";
import {
  applyEdits,
  encodeRtfText,
  extractLines,
  insertLineEdit,
  lineEdit,
  replaceLineText,
  unicodeSkipAt,
  type InsertSide,
  type SourceEdit,
} from "../rtf";
import { hasRealLibrary, libraryFiles, readLibraryFile } from "./corpus";
import { rtfWithHeader as rtf, syntheticTextPresentation, textLines } from "./synthetic";

/**
 * Writing new text into a line, rather than only cutting characters out.
 *
 * The same contract as the deletion gate in `rtf-splice.test.ts`: the edited
 * line reads exactly what was asked for, and no other line reads any
 * differently. Checked exhaustively over hand-written documents built to hit
 * every trap the deletion side has met, and over every line of a real library
 * where there is one.
 */


/** Make one line read `after` and return every line's text. */
function edit(source: string, lineIndex: number, after: string): string[] {
  const line = extractLines(source)[lineIndex];
  const edits = replaceLineText(source, line, after);
  expect(edits, JSON.stringify(after)).not.toBeNull();
  return extractLines(applyEdits(source, edits!)).map((l) => l.text);
}

/** Every line as it was, with one replaced. */
function expected(source: string, lineIndex: number, after: string): string[] {
  const lines = extractLines(source).map((l) => l.text);
  lines[lineIndex] = after;
  return lines;
}

/**
 * Documents chosen for the traps: an escape right after a control word with no
 * delimiter, a fallback count other than one, a nested formatting group, a
 * blank line of formatting, a literal brace and backslash, a code point past
 * the BMP written as a surrogate pair, and a placeholder with no text at all.
 */
const TRICKY = [
  rtf("\\cb3 Que ton nom\\par\\pard\\cb3 pour toujours"),
  rtf("\\cb2\\u212 ? ce nom\\par\\pard\\qc\\u212 ?abc"),
  rtf("\\cb3 caf\\u233 ? cr\\u232 ?me", "\\uc0"),
  rtf("\\cb3 deux \\u233 ??x", "\\uc2"),
  rtf("\\cb3 a {\\b bold} word\\par\\pard\\li0\\qc\\fs200\\par\\pard\\cb3 Below"),
  rtf("\\cb3 \\{brace\\} and \\\\ slash\\tab end"),
  rtf("\\cb3 joy \\u-10179 ?\\u-8704 ? here"),
  rtf("\\cb3"),
  rtf("\\cb3 one\\line two\\line\\line four"),
];

/** What gets typed: plain, accented, reserved by RTF, a tab, a digit, past the BMP. */
const INSERTS = ["x", "é", "{", "}", "\\", "\t", "5", " ", "😀", "-1", "Ω ok"];

describe("applying edits", () => {
  it("never writes out again what a removal already took, with an insertion inside it", () => {
    const edits = [
      { start: 1, end: 6 },
      { start: 3, end: 3, insert: "X" },
      { start: 4, end: 5 },
    ];
    expect(applyEdits("abcdefg", edits)).toBe("aXg");
  });
});

describe("encoding plain text", () => {
  it("escapes what RTF reserves and spells a tab as a control word", () => {
    expect(encodeRtfText("a{b}c\\d\te", 1)).toBe("a\\{b\\}c\\\\d\\tab e");
  });

  it("writes everything above ASCII as \\u escapes, with the fallbacks in force", () => {
    expect(encodeRtfText("é", 1)).toBe("\\u233 ?");
    expect(encodeRtfText("é", 0)).toBe("\\u233 ");
    expect(encodeRtfText("é", 2)).toBe("\\u233 ??");
  });

  it("writes a character past the BMP as a signed surrogate pair", () => {
    expect(encodeRtfText("😀", 1)).toBe("\\u-10179 ?\\u-8704 ?");
  });

  it("refuses a line break or any other control character", () => {
    expect(encodeRtfText("two\nlines", 1)).toBeNull();
    expect(encodeRtfText("bell\u0007", 1)).toBeNull();
  });
});

describe("the \\uc in force", () => {
  it("defaults to one and follows the group stack", () => {
    const source = "{\\rtf1\\uc2 a{\\uc0 b}c}";
    expect(unicodeSkipAt(source, 1)).toBe(1);
    expect(unicodeSkipAt(source, source.indexOf("a"))).toBe(2);
    expect(unicodeSkipAt(source, source.indexOf("b"))).toBe(0);
    expect(unicodeSkipAt(source, source.indexOf("c"))).toBe(2);
  });

  it("is not fooled by an escaped brace", () => {
    const source = "{\\rtf1\\uc2 \\{ a}";
    expect(unicodeSkipAt(source, source.indexOf("a"))).toBe(2);
  });
});

describe("replacing a line's text", () => {
  it("touches only what differs, so formatting elsewhere on the line stays", () => {
    const source = rtf("\\cb3 a {\\b bold} word");
    const line = extractLines(source)[0];
    const fixed = applyEdits(source, replaceLineText(source, line, "a bold Word")!);
    expect(fixed).toContain("{\\b bold} Word");
    expect(extractLines(fixed)[0].text).toBe("a bold Word");
  });

  it("delimits a control word the new text would otherwise run into", () => {
    // `\cb2\u212 ?` shows "Ô"; replacing it with "x" must not leave `\cb2x`.
    const source = rtf("\\cb2\\u212 ? ce nom");
    expect(edit(source, 0, "x ce nom")).toEqual(["x ce nom"]);
  });

  it("fills an empty placeholder box inside the document, not after it", () => {
    const source = rtf("\\cb3");
    const fixed = applyEdits(source, replaceLineText(source, extractLines(source)[0], "Hello")!);
    expect(fixed.endsWith("Hello}")).toBe(true);
    expect(extractLines(fixed).map((l) => l.text)).toEqual(["Hello"]);
  });

  it("writes into a blank line between two others", () => {
    const source = rtf("\\cb3 Above\\par\\pard\\li0\\qc\\fs200\\par\\pard\\cb3 Below");
    expect(edit(source, 1, "Middle")).toEqual(["Above", "Middle", "Below"]);
  });

  it("refuses a document whose \\uc no writer would use, rather than writing a vast fallback", () => {
    const source = rtf("\\cb3 x", "\\uc100000000");
    expect(replaceLineText(source, extractLines(source)[0], "é")).toBeNull();
  });

  it("asks for nothing when the line already reads that", () => {
    const source = rtf("\\cb3 same");
    expect(replaceLineText(source, extractLines(source)[0], "same")).toEqual([]);
  });

  it("refuses text that would not sit on one line", () => {
    const source = rtf("\\cb3 one");
    expect(replaceLineText(source, extractLines(source)[0], "one\ntwo")).toBeNull();
  });

  it("keeps an insertion at the edge of a removed line apart from that removal", () => {
    // Removing line 0 takes its break; writing at the very start of line 1
    // lands where that removal ends. The two must not merge and lose the text.
    const source = "{\\rtf1 one\\par two}";
    const lines = extractLines(source);
    const edits = [...lineEdit(source, lines[0])!, ...replaceLineText(source, lines[1], "Xtwo")!];
    expect(extractLines(applyEdits(source, edits)).map((l) => l.text)).toEqual(["Xtwo"]);
  });

  for (const [n, source] of TRICKY.entries()) {
    it(`inserts, replaces and removes anywhere in tricky document ${n}`, () => {
      const failures: string[] = [];
      extractLines(source).forEach((line, index) => {
        const text = line.text;
        const tries: string[] = [];
        for (let at = 0; at <= text.length; at++) {
          for (const insert of INSERTS) tries.push(text.slice(0, at) + insert + text.slice(at));
          if (at < text.length) {
            tries.push(text.slice(0, at) + text.slice(at + 1));
            tries.push(text.slice(0, at) + "Z" + text.slice(at + 1));
          }
        }
        tries.push("", "Entirely new text, é {}", text.toUpperCase());

        for (const after of tries) {
          if (after === text) continue;
          const edits = replaceLineText(source, line, after);
          if (edits === null) {
            failures.push(`line ${index} refused ${JSON.stringify(after)}`);
            continue;
          }
          const got = extractLines(applyEdits(source, edits)).map((l) => l.text);
          const want = expected(source, index, after);
          // Emptying a bare last line is the one honest mismatch: it reads back
          // as no line at all, which planLineEdits refuses by reading it back.
          const vanished = after === "" && line.breakStart === undefined && got.length === want.length - 1;
          if (!vanished && (got.length !== want.length || got.some((t, i) => t !== want[i]))) {
            failures.push(`line ${index} → ${JSON.stringify(after)}: got ${JSON.stringify(got)}`);
          }
          if (failures.length >= 5) break;
        }
      });
      expect(failures).toEqual([]);
    });
  }
});

/** Add lines beside one line, in order, and return every line's text. */
function add(source: string, lineIndex: number, side: InsertSide, texts: readonly string[]): string[] {
  const lines = extractLines(source);
  const edits = texts.map((text) => insertLineEdit(source, lines, lineIndex, side, text));
  expect(edits, JSON.stringify(texts)).not.toContain(null);
  return extractLines(applyEdits(source, edits as SourceEdit[])).map((l) => l.text);
}

/** Every line as it was, with lines added beside one. */
function withAdded(source: string, lineIndex: number, side: InsertSide, texts: readonly string[]): string[] {
  const lines = extractLines(source).map((l) => l.text);
  lines.splice(side === "after" ? lineIndex + 1 : lineIndex, 0, ...texts);
  return lines;
}

describe("adding a line", () => {
  it("goes at the line's break, so neither neighbour's formatting moves", () => {
    const source = rtf("\\pard\\qc\\cb3 one\\par\\pard\\cb3 two");
    const lines = extractLines(source);
    const edit = insertLineEdit(source, lines, 0, "after", "new")!;
    // Zero-width: not one character of the document is taken.
    expect(edit).toEqual({ start: lines[0].breakStart, end: lines[0].breakStart, insert: "\\par new" });
    expect(applyEdits(source, [edit])).toContain("\\qc\\cb3 one\\par new\\par\\pard\\cb3 two");
  });

  it("goes after a line's formatting when added before it, so it starts as that line does", () => {
    const source = rtf("\\pard\\cb3 one\\par\\pard\\qc\\cb3 two");
    const fixed = applyEdits(source, [insertLineEdit(source, extractLines(source), 1, "before", "new")!]);
    expect(fixed).toContain("\\par\\pard\\qc\\cb3 new\\par two");
    expect(extractLines(fixed).map((l) => l.text)).toEqual(["one", "new", "two"]);
  });

  it("takes the break the gap already has", () => {
    const source = rtf("\\cb3 one\\\ntwo");
    expect(insertLineEdit(source, extractLines(source), 0, "after", "new")!.insert).toBe("\\\nnew");
    expect(insertLineEdit(source, extractLines(source), 1, "after", "new")!.insert).toBe("\\\nnew");
    expect(add(source, 1, "before", ["new"])).toEqual(["one", "new", "two"]);
  });

  it("uses \\par in a box with no break at all, as ProPresenter does", () => {
    const source = rtf("\\cb3 only");
    const fixed = applyEdits(source, [insertLineEdit(source, extractLines(source), 0, "after", "new")!]);
    expect(fixed.endsWith("only\\par new}")).toBe(true);
    expect(add(source, 0, "before", ["new"])).toEqual(["new", "only"]);
  });

  it("adds several at one place in the order given, and any of them alone", () => {
    const source = rtf("\\pard\\cb3 one\\par\\pard\\cb3 two");
    const texts = ["A", "B", "C"];
    for (const side of ["before", "after"] as const) {
      for (const index of [0, 1]) {
        expect(add(source, index, side, texts)).toEqual(withAdded(source, index, side, texts));
        expect(add(source, index, side, ["A", "C"])).toEqual(withAdded(source, index, side, ["A", "C"]));
      }
    }
  });

  it("before a line opening on an escape, delimits the word before it and leaves the break bare", () => {
    const source = rtf("\\cb2\\u201 ?ternel");
    const lines = extractLines(source);
    expect(insertLineEdit(source, lines, 0, "before", "Gloire")!.insert).toBe(" Gloire\\par");
    expect(insertLineEdit(source, lines, 0, "before", "À toi")!.insert).toBe("\\u192 ? toi\\par");
    for (const texts of [["Gloire"], ["Gloire", " à toi", "À lui", "5"]]) {
      expect(add(source, 0, "before", texts)).toEqual([...texts, "Éternel"]);
    }
  });

  it("keeps the line it is added beside, word for word, when that line is also rewritten", () => {
    const source = rtf("\\pard\\cb3 one\\par\\pard\\cb3 two");
    const lines = extractLines(source);
    const edits = [
      insertLineEdit(source, lines, 0, "before", "zero")!,
      ...replaceLineText(source, lines[0], "One more")!,
      insertLineEdit(source, lines, 0, "after", "between")!,
    ];
    expect(extractLines(applyEdits(source, edits)).map((l) => l.text)).toEqual(["zero", "One more", "between", "two"]);
  });

  it("before an empty last line, goes before its formatting so that the line survives", () => {
    // How ProPresenter often ends a box: a break, then a paragraph of
    // formatting with nothing in it. Added after that formatting, the text
    // would leave nothing after its break, and the empty line would vanish.
    const source = rtf("\\pard\\cb3 one\\par\\pard\\qc\\cb3 ");
    expect(add(source, 1, "before", ["x2", "x3"])).toEqual(["one", "x2", "x3", ""]);
    expect(add(source, 1, "after", ["x2"])).toEqual(["one", "", "x2"]);
  });

  it("refuses what it cannot write so that it reads back", () => {
    const source = rtf("\\cb3 one");
    const lines = extractLines(source);
    expect(insertLineEdit(source, lines, 0, "after", "")).toBeNull();
    expect(insertLineEdit(source, lines, 0, "after", "two\\nlines".replace("\\n", "\n"))).toBeNull();
    expect(insertLineEdit(source, lines, 1, "after", "x")).toBeNull();
    expect(insertLineEdit("", extractLines(""), 0, "after", "x")).toBeNull();
    // A hyphen after a bare control word could become a new break's parameter.
    const hyphen = rtf("\\cb2-5 degrees");
    expect(insertLineEdit(hyphen, extractLines(hyphen), 0, "before", "x")).toBeNull();
    // A space after a control symbol is text, so the break cannot end bare.
    const symbol = rtf("\\cb3 a\\\n\\cb2\\u201 ?ternel");
    expect(insertLineEdit(symbol, extractLines(symbol), 1, "before", "x")).toBeNull();
  });

  for (const [n, source] of TRICKY.entries()) {
    it(`adds lines beside every line of tricky document ${n}`, () => {
      const failures: string[] = [];
      const lines = extractLines(source);
      for (const index of lines.keys()) {
        for (const side of ["before", "after"] as const) {
          for (const texts of [...INSERTS.map((t) => [t]), INSERTS.slice(0, 4), [lines[index].text || "copy", "x2"]]) {
            const edits = texts.map((text) => insertLineEdit(source, lines, index, side, text));
            if (edits.includes(null)) {
              failures.push(`line ${index} ${side} refused ${JSON.stringify(texts)}`);
              continue;
            }
            const got = extractLines(applyEdits(source, edits as SourceEdit[])).map((l) => l.text);
            const want = withAdded(source, index, side, texts);
            // Before a bare last line with nothing on it, which then reads as no
            // line at all: the one honest mismatch, refused by planLineEdits.
            const vanished = side === "before" && lines.length === 1 && lines[0].text === "" && got.length === want.length - 1;
            if (!vanished && (got.length !== want.length || got.some((t, i) => t !== want[i]))) {
              failures.push(`line ${index} ${side} ${JSON.stringify(texts)}: got ${JSON.stringify(got)}`);
            }
          }
        }
      }
      expect(failures).toEqual([]);
    });
  }
});

describe("planning line edits on a presentation", () => {
  const bytes = () => syntheticTextPresentation();
  const doc = () => readPresentation(decodePresentation(bytes()));

  it("writes several lines across boxes and reads back exactly that", () => {
    const changes: LineChange[] = [
      { boxIndex: 0, lineIndex: 0, text: "A tidier line" },
      { boxIndex: 0, lineIndex: 1, text: "And one more" },
      { boxIndex: 5, lineIndex: 0, text: "Filled placeholder" },
      { boxIndex: 3, lineIndex: 1, text: null },
    ];
    const fixes = planLineEdits(doc(), changes);
    const want = textLines(bytes());
    want[0] = ["A tidier line", "And one more"];
    want[5] = ["Filled placeholder"];
    want[3] = ["Above", "Below"];
    expect(textLines(applyFixes(bytes(), fixes))).toEqual(want);
  });

  it("describes each change as the fixer does, so it can be shown before it is made", () => {
    const [fix] = planLineEdits(doc(), [{ boxIndex: 6, lineIndex: 0, text: "Que ton nom" }]);
    expect(fix).toMatchObject({ before: "Que ton nom,", after: "Que ton nom", groupName: "Chorus", kinds: [] });
  });

  it("refuses the lot when one change cannot be made", () => {
    const refuse = (changes: LineChange[]) => {
      try {
        planLineEdits(doc(), changes);
      } catch (e) {
        expect(e).toBeInstanceOf(EditError);
        return (e as EditError).reason;
      }
      return "planned";
    };
    expect(refuse([{ boxIndex: 99, lineIndex: 0, text: "x" }])).toBe("noSuchLine");
    expect(refuse([{ boxIndex: 0, lineIndex: 9, text: "x" }])).toBe("noSuchLine");
    expect(refuse([{ boxIndex: 0, lineIndex: 0, text: "A tidy line" }])).toBe("unchanged");
    expect(refuse([{ boxIndex: 0, lineIndex: 0, text: "two\nlines" }])).toBe("notOneLine");
    // The last line of a box has no break to take with it.
    expect(refuse([{ boxIndex: 0, lineIndex: 1, text: null }])).toBe("lastLine");
    expect(
      refuse([
        { boxIndex: 0, lineIndex: 0, text: "a" },
        { boxIndex: 0, lineIndex: 0, text: "b" },
      ])
    ).toBe("duplicate");
  });

  it("refuses at plan time a set that would not read back as asked", () => {
    // Removing a line whose break ends in a control word, and writing at the
    // start of the next, each put back a delimiter space: composed, the new
    // line would gain a leading space. Caught before anybody is asked.
    const rtf = "{\\rtf1 \\cf0 abc\\cf2\\par\\u233 ?xyz}";
    const one = { name: "x", slideCount: 1, textBoxes: [{ boxIndex: 0, slideIndex: 0, cueName: "1", lines: extractLines(rtf), rtf }] };
    try {
      planLineEdits(one, [
        { boxIndex: 0, lineIndex: 0, text: null },
        { boxIndex: 0, lineIndex: 1, text: "Néxyz" },
      ]);
      expect.unreachable();
    } catch (e) {
      expect((e as EditError).reason).toBe("unsupported");
    }
  });

  it("refuses at plan time to empty a last line that would then not be read as a line", () => {
    const rtf = "{\\rtf1 one\\line two}";
    const one = { name: "x", slideCount: 1, textBoxes: [{ boxIndex: 0, slideIndex: 0, cueName: "1", lines: extractLines(rtf), rtf }] };
    expect(() => planLineEdits(one, [{ boxIndex: 0, lineIndex: 1, text: "" }])).toThrow(EditError);
  });

  it("refuses to write into a box that is not an RTF document", () => {
    const rtf = "";
    const lines = extractLines(rtf);
    expect(replaceLineText(rtf, lines[0], "hi")).toBeNull();
  });

  it("adds lines through the same gate and read-back, beside the edits it is planned with", () => {
    const changes: LineChange[] = [
      { boxIndex: 6, lineIndex: 0, text: "Que ton nom" },
      { boxIndex: 6, lineIndex: 0, text: "Que ton nom", insert: "after" },
      { boxIndex: 6, lineIndex: 2, text: "sois glorifié", insert: "after" },
      { boxIndex: 6, lineIndex: 2, text: "(bis)", insert: "after" },
      { boxIndex: 6, lineIndex: 0, text: "Refrain", insert: "before" },
      { boxIndex: 5, lineIndex: 0, text: "Filled placeholder" },
      { boxIndex: 4, lineIndex: 0, text: "only line", insert: "before" },
    ];
    const fixes = planLineEdits(doc(), changes);
    const want = textLines(bytes());
    want[6] = ["Refrain", "Que ton nom", "Que ton nom", "pour toujours ,", "sois glorifie", "sois glorifié", "(bis)"];
    want[5] = ["Filled placeholder"];
    want[4] = ["only line", "two  spaces here"];
    expect(textLines(applyFixes(bytes(), fixes))).toEqual(want);
    // Each added line its own fix, in reading order, saying where it goes.
    expect(fixes.filter((fix) => fix.boxIndex === 6).map((fix) => [fix.lineIndex, fix.insert, fix.after])).toEqual([
      [0, "before", "Refrain"],
      [0, undefined, "Que ton nom"],
      [0, "after", "Que ton nom"],
      [2, "after", "sois glorifié"],
      [2, "after", "(bis)"],
    ]);
  });

  it("writes any subset of the added lines a person leaves ticked", () => {
    const fixes = planLineEdits(doc(), [
      { boxIndex: 0, lineIndex: 0, text: "one", insert: "after" },
      { boxIndex: 0, lineIndex: 0, text: "two", insert: "after" },
      { boxIndex: 0, lineIndex: 0, text: "three", insert: "after" },
    ]);
    expect(textLines(applyFixes(bytes(), [fixes[0], fixes[2]]))[0]).toEqual(["A tidy line", "one", "three", "And another"]);
    expect(textLines(applyFixes(bytes(), [fixes[1]]))[0]).toEqual(["A tidy line", "two", "And another"]);
  });

  it("refuses an added line it cannot place", () => {
    const refuse = (changes: LineChange[]) => {
      try {
        planLineEdits(doc(), changes);
      } catch (e) {
        return (e as EditError).reason;
      }
      return "planned";
    };
    expect(refuse([{ boxIndex: 0, lineIndex: 0, text: "", insert: "after" }])).toBe("emptyLine");
    expect(refuse([{ boxIndex: 0, lineIndex: 0, text: null, insert: "after" }])).toBe("emptyLine");
    expect(refuse([{ boxIndex: 0, lineIndex: 0, text: "a\nb", insert: "after" }])).toBe("notOneLine");
    expect(refuse([{ boxIndex: 0, lineIndex: 2, text: "x", insert: "before" }])).toBe("noSuchLine");
    expect(
      refuse([
        { boxIndex: 3, lineIndex: 1, text: "x", insert: "after" },
        { boxIndex: 3, lineIndex: 1, text: null },
      ])
    ).toBe("besideRemoved");
    // Before an empty placeholder, which would then read as no line at all.
    expect(refuse([{ boxIndex: 5, lineIndex: 0, text: "x", insert: "before" }])).toBe("unsupported");
    // A line that reads like its neighbour is the point, not a no-op.
    expect(refuse([{ boxIndex: 0, lineIndex: 0, text: "A tidy line", insert: "after" }])).toBe("planned");
  });

  it("keeps added lines to the same guards as any other edit", () => {
    const fixes = planLineEdits(doc(), [{ boxIndex: 0, lineIndex: 0, text: "added", insert: "after" }]);
    // Stale: the box changed since the plan, so its offsets describe nothing.
    const moved = applyFixes(bytes(), planLineEdits(doc(), [{ boxIndex: 0, lineIndex: 1, text: "Elsewhere" }]));
    expect(() => applyFixes(moved, fixes)).toThrow(new FixError("stale"));
    // Read back: a splice that does not give what was promised is not written.
    const wrong = fixes.map((fix) => ({ ...fix, edits: [{ ...fix.edits[0], insert: "\\par different" }] }));
    expect(() => applyFixes(bytes(), wrong)).toThrow(new FixError("verifyFailed"));
    const promisedElsewhere = fixes.map((fix) => ({ ...fix, insert: "before" as const }));
    expect(() => applyFixes(bytes(), promisedElsewhere)).toThrow(new FixError("verifyFailed"));
  });

  it("is refused as stale against a file that changed since it was planned", () => {
    const fixes = planLineEdits(doc(), [{ boxIndex: 0, lineIndex: 0, text: "Changed" }]);
    const moved = applyFixes(bytes(), planLineEdits(doc(), [{ boxIndex: 0, lineIndex: 1, text: "Elsewhere" }]));
    expect(() => applyFixes(moved, fixes)).toThrow(FixError);
  });
});

/**
 * The gate for writing text, over a real library: for every line of every
 * box, a character typed at the start, the middle and the end, an accented
 * word replacing the whole line, and RTF's reserved characters, each read back
 * exactly and every other line untouched. Only a machine with a library runs
 * it; CI skips.
 */
describe.skipIf(!hasRealLibrary)("writing into every line of a real library", () => {
  const sources: { file: string; rtf: string }[] = [];

  beforeAll(() => {
    if (!hasRealLibrary) return;
    for (const file of libraryFiles()) {
      for (const box of readPresentation(decodePresentation(readLibraryFile(file))).textBoxes) {
        sources.push({ file, rtf: box.rtf });
      }
    }
  });

  it("reads back exactly what was written and nothing else", () => {
    expect(sources.length).toBeGreaterThan(100);
    const failures: string[] = [];

    for (const { file, rtf: source } of sources) {
      const lines = extractLines(source);
      const before = lines.map((l) => l.text);
      lines.forEach((line, index) => {
        const t = line.text;
        const mid = Math.floor(t.length / 2);
        const tries = ["x" + t, t.slice(0, mid) + "é" + t.slice(mid), t + " {\\}", "Ça ira 😀", t.toUpperCase()];
        for (const after of tries) {
          if (after === t || failures.length >= 5) continue;
          const edits = replaceLineText(source, line, after);
          if (edits === null) {
            failures.push(`${file} line ${index}: refused ${JSON.stringify(after)}`);
            continue;
          }
          const got = extractLines(applyEdits(source, edits)).map((l) => l.text);
          const want = [...before];
          want[index] = after;
          if (got.length !== want.length || got.some((x, n) => x !== want[n])) {
            failures.push(`${file} line ${index} → ${JSON.stringify(after)}: ${JSON.stringify(got)}`);
          }
        }
      });
    }

    expect(failures).toEqual([]);
  }, 120_000);
});

/**
 * The same gate for adding lines: beside every line of every box of a real
 * library, a line added after it and one before it, each read back with
 * every line already there unchanged. Only a machine with a library runs it.
 */
describe.skipIf(!hasRealLibrary)("adding a line beside every line of a real library", () => {
  const sources: { file: string; rtf: string }[] = [];

  beforeAll(() => {
    if (!hasRealLibrary) return;
    for (const file of libraryFiles()) {
      for (const box of readPresentation(decodePresentation(readLibraryFile(file))).textBoxes) {
        sources.push({ file, rtf: box.rtf });
      }
    }
  });

  it("reads back exactly the lines added and every other line as it was", () => {
    expect(sources.length).toBeGreaterThan(100);
    const failures: string[] = [];
    let refused = 0;

    for (const { file, rtf: source } of sources) {
      const lines = extractLines(source);
      for (const [index, line] of lines.entries()) {
        for (const side of ["before", "after"] as const) {
          for (const texts of [[line.text || "x2"], ["Ça ira 😀", "(bis)"]]) {
            if (failures.length >= 5) break;
            const edits = texts.map((text) => insertLineEdit(source, lines, index, side, text));
            if (edits.includes(null)) {
              // Refused rather than written approximately; counted, so a rule
              // that refuses too much shows here.
              refused++;
              continue;
            }
            const got = extractLines(applyEdits(source, edits as SourceEdit[])).map((l) => l.text);
            const want = withAdded(source, index, side, texts);
            const vanished = side === "before" && lines.length === 1 && line.text === "" && got.length === want.length - 1;
            if (!vanished && (got.length !== want.length || got.some((x, n) => x !== want[n]))) {
              failures.push(`${file} line ${index} ${side} ${JSON.stringify(texts)}: ${JSON.stringify(got)}`);
            }
          }
        }
      }
    }

    expect(failures).toEqual([]);
    expect(refused).toBeLessThan(sources.length / 100);
  }, 120_000);
});
