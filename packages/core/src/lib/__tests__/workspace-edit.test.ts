import { describe, expect, it } from "vitest";
import { FixError, planLineEdits } from "../fixes";
import { readPresentation } from "../presentation";
import { presentationFromWorkspace } from "../workspace";
import { AttributeRangeError, moveRanges } from "../ranges";
import {
  checkWorkspaceEdit,
  editedRoot,
  encodeVersionVector,
  onlyPeerAdded,
  planWorkspaceEdit,
  valueAt,
} from "../workspace-edit";
import { syntheticTextPresentation } from "./synthetic";
import { workspacePresentation } from "./workspace-fixtures";

/**
 * The pure half of writing to a ProPresenter 22 workspace. The documents
 * are the synthetic presentation in the shape a workspace stores it; the
 * half that touches SQLite and Loro is tested in `packages/node`.
 */

const caps = (start: number, end: number) => ({ Attribute: { __tag: "capitalization", capitalization: 1 }, range: { start, end } });

/** The synthetic presentation as a workspace document, with All Caps ranges on each line of the three-line box. */
function document(ranges?: { start: number; end: number }[]) {
  const root = workspacePresentation(syntheticTextPresentation());
  const doc = readPresentation(presentationFromWorkspace(root).message);
  const box = doc.textBoxes.find((b) => b.lines[0].text === "Que ton nom,")!;
  const lines = box.lines.map((l) => l.text);
  let at = 0;
  const perLine = lines.map((text) => {
    const range = { start: at, end: at + text.length };
    at += text.length + 1;
    return range;
  });
  const edit = planWorkspaceEdit(root, planLineEdits(doc, [{ boxIndex: box.boxIndex, lineIndex: 0, text: "Que ton nom" }]));
  const text = valueAt(root, edit.boxes[0].path);
  text.attributes = { custom_attributes: (ranges ?? perLine).map((r) => caps(r.start, r.end)) };
  return { root, doc, box, lines };
}

describe("encodeVersionVector", () => {
  it("writes the count, then each peer as a varint and its counter zigzagged", () => {
    // 1643 zigzagged is 3286, 0xcd6.
    expect([...encodeVersionVector(new Map([["1", 1643]]))]).toEqual([0x01, 0x01, 0xd6, 0x19]);
  });

  it("puts the peers in ascending order of id, whatever order it is given them in", () => {
    const vv = new Map([
      ["300", 1],
      ["2", 5],
    ]);
    expect([...encodeVersionVector(vv)]).toEqual([0x02, 0x02, 0x0a, 0xac, 0x02, 0x02]);
  });

  it("orders peer ids as numbers, not as strings, up to 64 bits", () => {
    const big = (2n ** 63n - 1n).toString();
    const bytes = encodeVersionVector(new Map([[big, 1], ["9", 1]]));
    expect(bytes[1]).toBe(9);
    expect([...bytes.slice(3, 12)]).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]);
  });

  it("zigzags a negative counter", () => {
    expect([...encodeVersionVector(new Map([["1", -1]]))]).toEqual([0x01, 0x01, 0x01]);
    expect([...encodeVersionVector(new Map()).values()]).toEqual([0x00]);
  });
});

describe("onlyPeerAdded", () => {
  const before = new Map([["1", 10]]);
  it("accepts the old vector with one new peer", () => {
    expect(onlyPeerAdded(before, new Map([["1", 10], ["7", 2]]), "7")).toBe(true);
  });
  it("refuses a vector that moved an old peer, dropped one, or added another", () => {
    expect(onlyPeerAdded(before, new Map([["1", 11], ["7", 2]]), "7")).toBe(false);
    expect(onlyPeerAdded(before, new Map([["7", 2]]), "7")).toBe(false);
    expect(onlyPeerAdded(before, new Map([["1", 10], ["7", 2], ["8", 1]]), "7")).toBe(false);
    expect(onlyPeerAdded(before, new Map([["1", 10], ["8", 1]]), "7")).toBe(false);
  });
  it("refuses a peer the document already had", () => {
    expect(onlyPeerAdded(before, new Map([["1", 12]]), "1")).toBe(false);
  });
});

describe("moveRanges", () => {
  const lines = ["Que ton nom,", "pour toujours ,", "sois glorifie"];
  // 0..12, 13..28, 29..42
  const perLine = [
    { start: 0, end: 12 },
    { start: 13, end: 28 },
    { start: 29, end: 42 },
  ];

  it("leaves ranges where they are when no line changes length", () => {
    expect(moveRanges(0, lines, [...lines], perLine)).toEqual(perLine);
  });

  it("moves every range after a line that grows, and stretches that line's own", () => {
    const after = [lines[0], "pour toujours et à jamais ,", lines[2]];
    expect(moveRanges(0, lines, after, perLine)).toEqual([
      { start: 0, end: 12 },
      { start: 13, end: 40 },
      { start: 41, end: 54 },
    ]);
  });

  it("moves every range after a line that shrinks", () => {
    const after = ["Que ton nom", lines[1], lines[2]];
    expect(moveRanges(0, lines, after, perLine)).toEqual([
      { start: 0, end: 11 },
      { start: 12, end: 27 },
      { start: 28, end: 41 },
    ]);
  });

  it("moves a range over the whole box with it", () => {
    const after = ["Que ton nom", "pour toujours et à jamais ,", lines[2]];
    expect(moveRanges(0, lines, after, [{ start: 0, end: 42 }])).toEqual([{ start: 0, end: 53 }]);
  });

  it("shrinks a removed line's range to nothing, where the next line now starts", () => {
    const after = [lines[0], null, lines[2]];
    expect(moveRanges(0, lines, after, perLine)).toEqual([
      { start: 0, end: 12 },
      { start: 13, end: 13 },
      { start: 13, end: 26 },
    ]);
  });

  it("keeps ranges within the text when the last line goes", () => {
    // Refused when planning, since a last line has no break to take with it;
    // held here anyway, so the ranges never depend on that refusal.
    const after = [lines[0], lines[1], null];
    expect(moveRanges(0, lines, after, [...perLine, { start: 0, end: 42 }])).toEqual([
      { start: 0, end: 12 },
      { start: 13, end: 28 },
      { start: 28, end: 28 },
      { start: 0, end: 28 },
    ]);
    expect(moveRanges(0, ["only"], [null], [{ start: 0, end: 4 }])).toEqual([{ start: 0, end: 0 }]);
  });

  it("keeps both ends of a range over an empty line on that line once it has text", () => {
    expect(moveRanges(0, ["a", "", "b"], ["a", "new", "b"], [{ start: 2, end: 2 }, { start: 3, end: 4 }])).toEqual([
      { start: 2, end: 5 },
      { start: 6, end: 7 },
    ]);
  });

  it("refuses a range that starts or ends inside a line", () => {
    expect(() => moveRanges(4, lines, lines, [{ start: 1, end: 12 }])).toThrow(AttributeRangeError);
    expect(() => moveRanges(4, lines, lines, [{ start: 0, end: 5 }])).toThrow(AttributeRangeError);
  });

  it("refuses a range beyond the text, or backwards", () => {
    expect(() => moveRanges(4, lines, lines, [{ start: 29, end: 43 }])).toThrow(AttributeRangeError);
    expect(() => moveRanges(4, lines, lines, [{ start: 12, end: 0 }])).toThrow(AttributeRangeError);
  });

  it("names the box it refused", () => {
    try {
      moveRanges(4, lines, lines, [{ start: 1, end: 12 }]);
    } catch (e) {
      expect((e as AttributeRangeError).boxIndex).toBe(4);
    }
  });
});

describe("moveRanges with added lines", () => {
  const lines = ["Que ton nom,", "pour toujours ,", "sois glorifie"];
  // 0..12, 13..28, 29..42
  const perLine = [
    { start: 0, end: 12, caps: true },
    { start: 13, end: 28, caps: true },
    { start: 29, end: 42, caps: true },
  ];
  const added = (line: number, side: "before" | "after", ...texts: string[]) =>
    new Map([[line, { before: side === "before" ? texts : [], after: side === "after" ? texts : [] }]]);

  it("widens the All Caps range of the line a new line is added after over it", () => {
    // "pour toujours ," is followed by "x2" at 29..31; the last line moves by 3.
    expect(moveRanges(0, lines, lines, perLine, added(1, "after", "x2"))).toEqual([
      { start: 0, end: 12 },
      { start: 13, end: 31 },
      { start: 32, end: 45 },
    ]);
  });

  it("widens it backwards over a line added before, and over several in a row", () => {
    // Refrain 0..7, (bis) 8..13, then the old lines 14..26, 27..42, 43..56.
    expect(moveRanges(0, lines, lines, perLine, added(0, "before", "Refrain", "(bis)"))).toEqual([
      { start: 0, end: 26 },
      { start: 27, end: 42 },
      { start: 43, end: 56 },
    ]);
  });

  it("after the last line, widens to the new end of the text", () => {
    expect(moveRanges(0, lines, lines, perLine, added(2, "after", "x2"))).toEqual([
      { start: 0, end: 12 },
      { start: 13, end: 28 },
      { start: 29, end: 45 },
    ]);
  });

  it("leaves a range alone that does not cover the line, and moves it past the new one", () => {
    const two = [perLine[0], perLine[2]];
    expect(moveRanges(0, lines, lines, two, added(1, "after", "x2"))).toEqual([
      { start: 0, end: 12 },
      { start: 32, end: 45 },
    ]);
  });

  it("keeps a range over the whole box over the whole box, wherever a line is added", () => {
    const whole = [{ start: 0, end: 42, caps: true }];
    expect(moveRanges(0, lines, lines, whole, added(0, "after", "x2"))).toEqual([{ start: 0, end: 45 }]);
    expect(moveRanges(0, lines, lines, whole, added(2, "after", "x2"))).toEqual([{ start: 0, end: 45 }]);
    expect(moveRanges(0, lines, lines, whole, added(0, "before", "x2"))).toEqual([{ start: 0, end: 45 }]);
  });

  it("widens the range of an empty line a line is added after", () => {
    expect(moveRanges(0, ["a", "", "b"], ["a", "", "b"], [{ start: 2, end: 2, caps: true }], added(1, "after", "new"))).toEqual([
      { start: 2, end: 6 },
    ]);
  });

  it("moves ranges with lines that change and lines that go, beside the added ones", () => {
    const after = ["Que ton nom", lines[1], null];
    const map = new Map([[0, { before: ["Refrain"], after: ["Que ton nom"] }]]);
    // Refrain 0..7, Que ton nom 8..19, Que ton nom 20..31, pour toujours , 32..47.
    expect(moveRanges(0, lines, after, perLine, map)).toEqual([
      { start: 0, end: 31 },
      { start: 32, end: 47 },
      { start: 47, end: 47 },
    ]);
  });

  it("refuses a range other than a capitalization that ends where the line does", () => {
    const plain = perLine.map(({ start, end }) => ({ start, end }));
    try {
      moveRanges(4, lines, lines, plain, added(1, "after", "x2"));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AttributeRangeError);
      expect((e as AttributeRangeError).addedLine).toBe(true);
    }
    // One that covers both the line and the next takes the new line between them without a guess.
    expect(moveRanges(4, lines, lines, [{ start: 13, end: 42 }], added(1, "after", "x2"))).toEqual([{ start: 13, end: 45 }]);
  });

  it("refuses a range that would come to cover a new line and not the line it copies", () => {
    // Starting at the end of line 0, so over the break and the lines after:
    // the new line after line 0 would fall inside it, line 0 would not.
    expect(() => moveRanges(4, lines, lines, [{ start: 12, end: 42, caps: true }], added(0, "after", "x2"))).toThrow(
      AttributeRangeError
    );
  });

  it("does not take the empty range a removed neighbour leaves for the line's own", () => {
    // Line 1 goes; its range collapses to where line 2 starts. A line added
    // before line 2 is not covered by it, and line 2's own range widens.
    const after = [lines[0], null, lines[2]];
    expect(moveRanges(0, lines, after, perLine, added(2, "before", "x2"))).toEqual([
      { start: 0, end: 12 },
      { start: 13, end: 13 },
      { start: 13, end: 29 },
    ]);
  });

  it("refuses lines added beside a line that goes", () => {
    expect(() => moveRanges(0, lines, [lines[0], null, lines[2]], perLine, added(1, "after", "x2"))).toThrow(
      AttributeRangeError
    );
  });
});

describe("planWorkspaceEdit", () => {
  it("finds the box in the document and says what it becomes", () => {
    const { root, doc, box } = document();
    const fixes = planLineEdits(doc, [{ boxIndex: box.boxIndex, lineIndex: 1, text: "pour toujours et à jamais ," }]);
    const edit = planWorkspaceEdit(root, fixes);

    expect(edit.boxes).toHaveLength(1);
    const [planned] = edit.boxes;
    expect(planned.path.slice(0, 2)).toEqual(["cues", expect.any(String)]);
    expect(valueAt(root, planned.path).rtf_data).toBeInstanceOf(Uint8Array);
    // The second line's end and everything after it move by 12.
    expect(planned.ranges).toEqual([
      { index: 1, start: 13, end: 40 },
      { index: 2, start: 41, end: 54 },
    ]);
  });

  it("widens a line's All Caps range over the lines added beside it, and moves the rest", () => {
    const { root, doc, box } = document();
    const fixes = planLineEdits(doc, [
      { boxIndex: box.boxIndex, lineIndex: 1, text: "pour toujours ,", insert: "after" },
      { boxIndex: box.boxIndex, lineIndex: 0, text: "Refrain", insert: "before" },
    ]);
    const edit = planWorkspaceEdit(root, fixes);
    // Refrain 0..7, Que ton nom, 8..20, pour toujours , 21..36 and again 37..52, sois glorifie 53..66.
    expect(edit.boxes[0].ranges).toEqual([
      { index: 0, start: 0, end: 20 },
      { index: 1, start: 21, end: 52 },
      { index: 2, start: 53, end: 66 },
    ]);
    expect(() => checkWorkspaceEdit(root, editedRoot(root, edit.boxes), edit, fixes)).not.toThrow();
  });

  it("refuses a line added beside one whose other formatting it could only guess at", () => {
    const { root, doc, box } = document();
    const text = valueAt(root, planWorkspaceEdit(root, planLineEdits(doc, [{ boxIndex: box.boxIndex, lineIndex: 0, text: "x" }])).boxes[0].path);
    text.attributes.custom_attributes[1].Attribute = { __tag: "font_scale_factor", font_scale_factor: 0.5 };
    const fixes = planLineEdits(doc, [{ boxIndex: box.boxIndex, lineIndex: 1, text: "again", insert: "after" }]);
    expect(() => planWorkspaceEdit(root, fixes)).toThrow(new AttributeRangeError(box.boxIndex, true));
    // The same box takes a line added beside a line whose ranges are all capitals.
    const elsewhere = planLineEdits(doc, [{ boxIndex: box.boxIndex, lineIndex: 2, text: "again", insert: "after" }]);
    expect(planWorkspaceEdit(root, elsewhere).boxes[0].ranges).toEqual([{ index: 2, start: 29, end: 48 }]);
  });

  it("refuses a box whose ranges do not fall on its lines", () => {
    const { root, doc, box } = document([{ start: 1, end: 12 }]);
    const fixes = planLineEdits(doc, [{ boxIndex: box.boxIndex, lineIndex: 1, text: "pour toujours" }]);
    expect(() => planWorkspaceEdit(root, fixes)).toThrow(AttributeRangeError);
  });

  it("refuses an edit planned against a box that has changed since", () => {
    const { root, doc, box } = document();
    const fixes = planLineEdits(doc, [{ boxIndex: box.boxIndex, lineIndex: 1, text: "pour toujours" }]);
    const edit = planWorkspaceEdit(root, fixes);
    valueAt(root, edit.boxes[0].path).rtf_data = new TextEncoder().encode("{\\rtf1 something else}");
    expect(() => planWorkspaceEdit(root, fixes)).toThrow(new FixError("stale"));
  });

  it("refuses a box the document does not hold where the conversion says it is", () => {
    const { root, doc, box } = document();
    const fixes = planLineEdits(doc, [{ boxIndex: box.boxIndex, lineIndex: 1, text: "pour toujours" }]);
    // The conversion keys cues by uuid; a document that keeps one elsewhere is not one this understands.
    const cueKey = planWorkspaceEdit(root, fixes).boxes[0].path[1] as string;
    root.cues[`moved-${cueKey}`] = root.cues[cueKey];
    root.cues[cueKey] = { ...root.cues[cueKey], actions: [] };
    expect(() => planWorkspaceEdit(root, fixes)).toThrow(FixError);
  });

  it("refuses nothing to do", () => {
    expect(() => planWorkspaceEdit(document().root, [])).toThrow(new FixError("unchanged"));
  });
});

describe("checkWorkspaceEdit", () => {
  function planned() {
    const { root, doc, box } = document();
    const fixes = planLineEdits(doc, [{ boxIndex: box.boxIndex, lineIndex: 0, text: "Que ton nom" }]);
    return { root, fixes, edit: planWorkspaceEdit(root, fixes) };
  }

  it("accepts the document with exactly the edit made", () => {
    const { root, fixes, edit } = planned();
    expect(() => checkWorkspaceEdit(root, editedRoot(root, edit.boxes), edit, fixes)).not.toThrow();
  });

  it("does not change the document it is given", () => {
    const { root, edit } = planned();
    const before = JSON.stringify(valueAt(root, edit.boxes[0].path).attributes);
    editedRoot(root, edit.boxes);
    expect(JSON.stringify(valueAt(root, edit.boxes[0].path).attributes)).toBe(before);
  });

  it("refuses a document that also changed anything else", () => {
    const { root, fixes, edit } = planned();
    const after = editedRoot(root, edit.boxes);
    after.name = "Renamed";
    expect(() => checkWorkspaceEdit(root, after, edit, fixes)).toThrow(new FixError("verifyFailed"));
  });

  it("refuses a document whose ranges were left behind", () => {
    const { root, fixes, edit } = planned();
    const after = editedRoot(root, edit.boxes.map((box) => ({ ...box, ranges: [] })));
    expect(() => checkWorkspaceEdit(root, after, edit, fixes)).toThrow(new FixError("verifyFailed"));
  });

  it("refuses a document that does not read as promised, even if it is the planned one", () => {
    const { root, fixes, edit } = planned();
    const after = editedRoot(root, edit.boxes);
    const promised = fixes.map((fix) => ({ ...fix, after: "something else" }));
    expect(() => checkWorkspaceEdit(root, after, edit, promised)).toThrow(new FixError("verifyFailed"));
  });
});
