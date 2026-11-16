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
