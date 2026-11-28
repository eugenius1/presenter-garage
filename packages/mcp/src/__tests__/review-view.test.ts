import { describe, expect, it } from "vitest";
import type { LineFix } from "@presenter-garage/core/lib/fixes";
import type { Review } from "@presenter-garage/node/review";
import type { PlannedFile } from "@presenter-garage/node/edits";
import { reviewData } from "../review-view";

/** A line fix as far as the page reads one. */
const fix = (slideIndex: number, boxIndex: number, lineIndex: number, before: string, after: string | null, insert?: "before" | "after") =>
  ({ slideIndex, boxIndex, lineIndex, before, after, insert, cueName: "", kinds: [], edits: [], source: "" }) as LineFix;

const slide = (slideIndex: number, lines: string[], groupName = "Verse") => ({
  slideIndex,
  groupName,
  macros: [],
  lines: lines.map((text, lineIndex) => ({ boxIndex: slideIndex, lineIndex, text })),
});

function review(file: Partial<PlannedFile>): Review {
  const planned: PlannedFile = { path: "/library/Song.pro", name: "Song", sha256: "", lines: [], changes: [], ...file };
  const ns = [...planned.lines, ...planned.changes].map(({ n }) => n);
  return {
    folder: "/out/review",
    hash: "h",
    root: "/library",
    backupDir: "/backups",
    plan: { id: "p", created: 0, files: [planned] },
    choices: { plan: "h", changes: Object.fromEntries(ns.map((n) => [n, { ticked: true }])) },
    runs: [],
  };
}

describe("where the page draws each change", () => {
  it("puts a changed line in its place and added lines on their side, several on one side in the order written", () => {
    const data = reviewData(
      review({
        lines: [
          { n: 1, fix: fix(1, 1, 0, "one", "One") },
          { n: 2, fix: fix(1, 1, 1, "two", "first", "after") },
          { n: 3, fix: fix(1, 1, 1, "two", "second", "after") },
          { n: 4, fix: fix(1, 1, 0, "one", "above", "before") },
        ],
        context: [slide(0, ["a"]), slide(1, ["one", "two"]), slide(2, ["b"])],
      })
    );
    const [file] = data.files;
    expect(file.runs[0].map((s) => [s.slideIndex, s.holds, s.entries])).toEqual([
      [0, false, [{ text: "a" }]],
      [1, true, [{ n: 4 }, { n: 1 }, { text: "two" }, { n: 2 }, { n: 3 }]],
      [2, false, [{ text: "b" }]],
    ]);
    expect(file.stray).toEqual([]);
    expect(file).not.toHaveProperty("path");
  });

  it("puts a group renamed at the top of its first slide, marking every slide it holds", () => {
    const rename = {
      kind: "renameGroup" as const,
      groupIndex: 0,
      slides: [0, 3],
      before: { name: "Verse" },
      after: { name: "Couplet" },
    };
    const data = reviewData(
      review({ changes: [{ n: 1, change: rename }], context: [slide(0, ["a"]), slide(1, ["b"]), slide(3, ["c"]), slide(4, ["d"])] })
    );
    const slides = data.files[0].runs.flat();
    expect(slides.filter((s) => s.holds).map((s) => s.slideIndex)).toEqual([0, 3]);
    expect(slides[0].entries).toEqual([{ n: 1 }, { text: "a" }]);
    expect(data.files[0].changes[0]).toMatchObject({ n: 1, kind: "structure", said: expect.stringContaining("“Verse” → “Couplet”") });
  });

  it("shows on its own a change with no slide around it, and makes the whitespace that matters visible", () => {
    const data = reviewData(review({ lines: [{ n: 1, fix: fix(5, 5, 0, " lead", "lead") }] }));
    expect(data.files[0].runs).toEqual([]);
    expect(data.files[0].stray).toEqual([1]);
    expect(data.files[0].changes[0]).toMatchObject({ before: "·lead", after: "lead" });
  });
});
