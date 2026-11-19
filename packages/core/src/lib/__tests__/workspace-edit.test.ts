import { describe, expect, it } from "vitest";
import { FixError, planLineEdits } from "../fixes";
import { readPresentation } from "../presentation";
import { presentationFromWorkspace } from "../workspace";
import {
  AttributeRangeError,
  checkWorkspaceEdit,
  editedRoot,
  encodeVersionVector,
  moveRanges,
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
    // The last two lines together: one break before them goes, not two.
    expect(moveRanges(0, lines, [lines[0], null, null], [...perLine, { start: 0, end: 42 }])).toEqual([
      { start: 0, end: 12 },
      { start: 12, end: 12 },
      { start: 12, end: 12 },
      { start: 0, end: 12 },
    ]);
    expect(moveRanges(0, lines, [null, null, null], perLine)).toEqual([
      { start: 0, end: 0 },
      { start: 0, end: 0 },
      { start: 0, end: 0 },
    ]);
  });

  it("keeps both ends of a range over an empty line on that line once it has text", () => {
    expect(moveRanges(0, ["a", "", "b"], ["a", "new", "b"], [{ start: 2, end: 2 }, { start: 3, end: 4 }])).toEqual([
      { start: 2, end: 5 },
      { start: 6, end: 7 },
    ]);
  });

  it("moves an end inside a line the edit does not touch with the lines before it", () => {
    // A range over "ton nom," and one over "toujours", inside their lines.
    const after = ["Que", lines[1], lines[2]];
    expect(moveRanges(0, lines, after, [{ start: 4, end: 12 }, { start: 18, end: 26 }])).toEqual([
      { start: 3, end: 3 },
      { start: 9, end: 17 },
    ]);
  });

  it("leaves a range inside a line alone when the change is elsewhere on the line", () => {
    // "Que" stays in capitals while "nom," becomes "Nom,".
    expect(moveRanges(0, lines, ["Que ton Nom,", lines[1], lines[2]], [{ start: 0, end: 3 }])).toEqual([{ start: 0, end: 3 }]);
    // And a range after the change moves by what it changed.
    expect(moveRanges(0, lines, ["Que grand ton nom,", lines[1], lines[2]], [{ start: 8, end: 12 }])).toEqual([
      { start: 14, end: 18 },
    ]);
  });

  describe("a line led by a tab the range leaves out", () => {
    const tabbed = ["\tQue ton nom,", "pour toujours"];
    // 1..13 is the first line without its tab, 14..27 the second.
    const ranges = [
      { start: 1, end: 13 },
      { start: 14, end: 27 },
    ];

    it("keeps the tab out when the line is shortened, lengthened or rewritten", () => {
      expect(moveRanges(0, tabbed, ["\tQue ton nom", tabbed[1]], ranges)).toEqual([
        { start: 1, end: 12 },
        { start: 13, end: 26 },
      ]);
      expect(moveRanges(0, tabbed, ["\tQue ton nom, Seigneur", tabbed[1]], ranges)).toEqual([
        { start: 1, end: 22 },
        { start: 23, end: 36 },
      ]);
      // Rewritten after the tab: nothing in common at the end, so the whole of it is replaced.
      expect(moveRanges(0, tabbed, ["\tBéni soit-il", tabbed[1]], ranges)).toEqual([
        { start: 1, end: 13 },
        { start: 14, end: 27 },
      ]);
    });

    it("takes in text typed at the start of the words, since the range covers the line", () => {
      expect(moveRanges(0, tabbed, ["\tOh Que ton nom,", tabbed[1]], ranges)).toEqual([
        { start: 1, end: 16 },
        { start: 17, end: 30 },
      ]);
    });

    it("moves with the tab removed, and covers new text that replaces the tab", () => {
      expect(moveRanges(0, tabbed, ["Que ton nom,", tabbed[1]], ranges)).toEqual([
        { start: 0, end: 12 },
        { start: 13, end: 26 },
      ]);
      // Tab and words replaced at once: the range started inside what was replaced.
      expect(moveRanges(0, tabbed, ["Béni soit-il", tabbed[1]], ranges)).toEqual([
        { start: 0, end: 12 },
        { start: 13, end: 26 },
      ]);
    });

    it("moves with the line removed", () => {
      expect(moveRanges(0, tabbed, [null, tabbed[1]], ranges)).toEqual([
        { start: 0, end: 0 },
        { start: 0, end: 13 },
      ]);
    });
  });

  it("cuts a range past the end of the text back to the end before moving it", () => {
    expect(moveRanges(0, lines, lines, [{ start: 29, end: 43 }])).toEqual([{ start: 29, end: 42 }]);
    expect(moveRanges(0, lines, lines, [{ start: 50, end: 60 }])).toEqual([{ start: 42, end: 42 }]);
    // Typed at the end of the last line, which the cut-back range covers: it takes it in.
    expect(moveRanges(0, lines, [lines[0], lines[1], "sois glorifié !"], [{ start: 29, end: 43 }])).toEqual([
      { start: 29, end: 44 },
    ]);
  });

  it("takes in text typed at either edge of a range that covers the line", () => {
    expect(moveRanges(0, lines, ["Oh Que ton nom,", lines[1], lines[2]], perLine)).toEqual([
      { start: 0, end: 15 },
      { start: 16, end: 31 },
      { start: 32, end: 45 },
    ]);
    expect(moveRanges(0, lines, ["Que ton nom, Seigneur", lines[1], lines[2]], perLine)[0]).toEqual({ start: 0, end: 21 });
  });

  it("takes in text that replaces the end of a range over the whole box", () => {
    expect(moveRanges(0, lines, [lines[0], lines[1], "sois béni"], [{ start: 0, end: 42 }])).toEqual([{ start: 0, end: 38 }]);
  });

  describe("a line's styling split into several ranges", () => {
    // All Caps on "Louons", on the tab, and on the rest of the line, as ProPresenter often stores it.
    const split = ["Louons\t le Dieu qui était", "Adorons"];
    const ranges = [
      { start: 0, end: 6 },
      { start: 6, end: 7 },
      { start: 7, end: 25 },
      { start: 26, end: 33 },
    ];
    const caps = ranges.map(() => "caps");

    it("counts them together as covering the line, and gives new text to the first that can take it", () => {
      expect(moveRanges(0, split, ["Oh Louons\t le Dieu qui était", split[1]], ranges, caps)).toEqual([
        { start: 0, end: 9 },
        { start: 9, end: 10 },
        { start: 10, end: 28 },
        { start: 29, end: 36 },
      ]);
      expect(moveRanges(0, split, ["Louons\t le Dieu qui était !", split[1]], ranges, caps).slice(2)).toEqual([
        { start: 7, end: 27 },
        { start: 28, end: 35 },
      ]);
    });

    it("keeps them meeting, never overlapping, when the whole line is rewritten", () => {
      expect(moveRanges(0, split, ["Changed line", split[1]], ranges, caps)).toEqual([
        { start: 0, end: 12 },
        { start: 12, end: 12 },
        { start: 12, end: 12 },
        { start: 13, end: 20 },
      ]);
    });

    it("refuses when they are not the same styling", () => {
      const styles = ["caps", "gradient", "gradient", "caps"];
      expect(() => moveRanges(0, split, ["Oh Louons\t le Dieu qui était", split[1]], ranges, styles)).toThrow(
        expect.objectContaining({ reason: "typedAtEdge" })
      );
      // Without saying which are the same, each range is a styling of its own.
      expect(() => moveRanges(0, split, ["Oh Louons\t le Dieu qui était", split[1]], ranges)).toThrow(AttributeRangeError);
    });
  });

  it("leaves text typed at a line's edge out of a range that only meets the line", () => {
    // The first line and its break; then the second line from its break on.
    const ranges = [
      { start: 0, end: 13 },
      { start: 12, end: 28 },
    ];
    expect(moveRanges(0, lines, [lines[0], "Oh pour toujours ,", lines[2]], ranges)[0]).toEqual({ start: 0, end: 13 });
    expect(moveRanges(0, lines, ["Que ton nom, Seigneur", lines[1], lines[2]], ranges)[1]).toEqual({ start: 21, end: 37 });
  });

  it("leaves an empty range empty, wherever text is typed", () => {
    expect(moveRanges(0, lines, ["Que grand ton nom,", lines[1], lines[2]], [{ start: 4, end: 4 }])).toEqual([{ start: 4, end: 4 }]);
    expect(moveRanges(0, lines, [lines[0], "Oh pour toujours ,", lines[2]], [{ start: 13, end: 13 }])).toEqual([
      { start: 13, end: 13 },
    ]);
  });

  it("refuses text typed at the edge of a range over part of a line", () => {
    // "ton" in capitals, and "ton" typed again right after it.
    expect(() => moveRanges(4, lines, ["Que tonton nom,", lines[1], lines[2]], [{ start: 4, end: 7 }])).toThrow(
      expect.objectContaining({ name: "AttributeRangeError", boxIndex: 4, reason: "typedAtEdge", lineIndex: 0 })
    );
    // "nom," in capitals, and "grand " typed right before it.
    expect(() => moveRanges(4, lines, ["Que ton grand nom,", lines[1], lines[2]], [{ start: 8, end: 12 }])).toThrow(
      expect.objectContaining({ reason: "typedAtEdge" })
    );
  });

  it("refuses new text replacing what a range over part of a line starts or ends inside", () => {
    // "ton" in capitals; "ton nom" becomes "notre Dieu", so where "ton" ends in it is a guess.
    const after = ["Que notre Dieu,", lines[1], lines[2]];
    expect(() => moveRanges(4, lines, after, [{ start: 4, end: 7 }])).toThrow(
      expect.objectContaining({ reason: "replacedAcrossEdge", lineIndex: 0 })
    );
  });

  it("refuses a range that is backwards or starts before the text", () => {
    expect(() => moveRanges(4, lines, lines, [{ start: 12, end: 0 }])).toThrow(expect.objectContaining({ reason: "malformed" }));
    expect(() => moveRanges(4, lines, lines, [{ start: -1, end: 3 }])).toThrow(AttributeRangeError);
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

  it("moves a range inside a line, and cuts one past the end of the text back", () => {
    const { root, doc, box } = document([
      { start: 4, end: 7 },
      { start: 29, end: 43 },
    ]);
    const fixes = planLineEdits(doc, [{ boxIndex: box.boxIndex, lineIndex: 1, text: "pour toujours" }]);
    const [planned] = planWorkspaceEdit(root, fixes).boxes;
    expect(planned.ranges).toEqual([{ index: 1, start: 27, end: 40 }]);
    expect(planned.cutBack).toEqual([1]);
  });

  it("says what each line's change does to the styling on it", () => {
    const { root, doc, box } = document([
      { start: 0, end: 12 },
      { start: 13, end: 28 },
      { start: 29, end: 43 },
      { start: 4, end: 7 },
    ]);
    const fixes = planLineEdits(doc, [
      { boxIndex: box.boxIndex, lineIndex: 0, text: "Que ton nom" },
      { boxIndex: box.boxIndex, lineIndex: 2, text: "sois glorifié" },
    ]);
    const { styling } = planWorkspaceEdit(root, fixes);
    expect(styling).toEqual([
      {
        boxIndex: box.boxIndex,
        lineIndex: 0,
        ranges: [{ index: 0, kind: "capitalization", value: 1, before: "Que ton nom,", after: "Que ton nom" }],
      },
      {
        boxIndex: box.boxIndex,
        lineIndex: 2,
        ranges: [{ index: 2, kind: "capitalization", value: 1, before: "sois glorifie", after: "sois glorifié" }],
      },
    ]);
  });

  it("counts ranges of the same attribute together, and only those", () => {
    // All Caps on "Que " and on "ton nom," apart: together they cover the line.
    const { root, doc, box } = document([
      { start: 0, end: 4 },
      { start: 4, end: 12 },
    ]);
    const fixes = planLineEdits(doc, [{ boxIndex: box.boxIndex, lineIndex: 0, text: "Oh Que ton nom," }]);
    expect(planWorkspaceEdit(root, fixes).boxes[0].ranges).toEqual([
      { index: 0, start: 0, end: 7 },
      { index: 1, start: 7, end: 15 },
    ]);
    // The same with the second a gradient instead: neither covers the line alone.
    const text = valueAt(root, planWorkspaceEdit(root, fixes).boxes[0].path);
    text.attributes.custom_attributes[1].Attribute = { __tag: "text_gradient_fill", text_gradient_fill: {} };
    expect(() => planWorkspaceEdit(root, fixes)).toThrow(AttributeRangeError);
  });

  it("refuses a box whose ranges cannot be moved without a guess", () => {
    const { root, doc, box } = document([{ start: 4, end: 7 }]);
    const fixes = planLineEdits(doc, [{ boxIndex: box.boxIndex, lineIndex: 0, text: "Que notre Dieu," }]);
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

  it("refuses a document with a range one character from where it was mapped", () => {
    const { root, doc, box } = document([{ start: 4, end: 7 }]);
    const fixes = planLineEdits(doc, [{ boxIndex: box.boxIndex, lineIndex: 0, text: "Oh Que ton nom," }]);
    const edit = planWorkspaceEdit(root, fixes);
    expect(edit.boxes[0].ranges).toEqual([{ index: 0, start: 7, end: 10 }]);
    const after = editedRoot(root, edit.boxes.map((b) => ({ ...b, ranges: [{ index: 0, start: 7, end: 11 }] })));
    expect(() => checkWorkspaceEdit(root, editedRoot(root, edit.boxes), edit, fixes)).not.toThrow();
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
