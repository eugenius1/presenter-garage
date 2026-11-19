import { LoroDoc } from "loro-crdt/base64";
import { describe, expect, it } from "vitest";
import { EditError, planLineEdits, type LineFix } from "@presenter-garage/core/lib/fixes";
import { readPresentation, textBoxAddresses } from "@presenter-garage/core/lib/presentation";
import { presentationFromWorkspace } from "@presenter-garage/core/lib/workspace";
import {
  AttributeRangeError,
  checkWorkspaceEdit,
  editedRoot,
  loroPathOf,
  moveRanges,
  planWorkspaceEdit,
  stableJson,
  valueAt,
} from "@presenter-garage/core/lib/workspace-edit";
import { openDatabase } from "../workspace";
import { storeOf } from "./workspace-db";

/**
 * How many of a real workspace's boxes with styling ranges an edit can now
 * be planned for, and how many are still refused and why. Read-only: the
 * store is opened through `openDatabase()`, and every edit is made to the
 * document's JSON in memory.
 *
 * PP_WORKSPACE_DIR=/path/to/Workspaces/<uuid> npm test -- workspace-ranges-survey
 */

const REAL_WORKSPACE = process.env.PP_WORKSPACE_DIR;

type Json = any;
type Range = { start: number; end: number };

/** The edits tried on every line of every box with ranges. */
const EDITS: Record<string, (text: string, last: boolean) => string | null | undefined> = {
  lengthen: (text) => `${text} x`,
  shorten: (text) => (text.length > 0 ? text.slice(0, -1) : undefined),
  prepend: (text) => `x ${text}`,
  rewrite: (text) => (text === "Changed line" ? undefined : "Changed line"),
  remove: (_text, last) => (last ? undefined : null),
};

/** The rule this replaced: both ends of every range on a line's start or end, within the text. */
function lineBoundaryRuleAccepts(lines: readonly string[], ranges: readonly Range[]): boolean {
  const boundaries = new Set<number>();
  let at = 0;
  for (const text of lines) {
    boundaries.add(at).add(at + text.length);
    at += text.length + 1;
  }
  return ranges.every(({ start, end }) => start <= end && boundaries.has(start) && boundaries.has(end));
}

/** A box's ranges, and which are the same styling, as `planWorkspaceEdit` reads them. */
function rangesOf(text: Json): { ranges: Range[]; styles: string[] } {
  const attributes: Json[] = Array.isArray(text?.attributes?.custom_attributes) ? text.attributes.custom_attributes : [];
  const ranged = attributes.filter((a) => a?.range && typeof a.range === "object");
  return {
    ranges: ranged.map((a) => ({ start: a.range.start ?? 0, end: a.range.end ?? 0 })),
    styles: ranged.map((a) => stableJson({ ...a, range: null })),
  };
}

describe.skipIf(!REAL_WORKSPACE)("styling ranges in a real workspace", () => {
  it("are mapped through every edit tried, or refused for a reason, and read back as mapped", { timeout: 600_000 }, async () => {
    const db = await openDatabase(storeOf(REAL_WORKSPACE!));
    const rows = db.prepare("SELECT snapshot FROM workspace_streams WHERE kind = 'Presentation' AND scope = 0").all();
    db.close();

    const tally = {
      presentations: rows.length,
      boxesWithRanges: 0,
      ranges: 0,
      rangesOffLines: 0,
      rangesPastEnd: 0,
      refusedByLineBoundaryRule: 0,
      planned: 0,
      refused: 0,
      verified: 0,
    };
    const edits: Record<string, { planned: number; refused: number }> = {};
    const reasons: Record<string, number> = {};
    // Boxes the rule this replaced would plan and this refuses: there should be none.
    const regressions: string[] = [];

    for (const row of rows) {
      const loro = new LoroDoc();
      loro.import(row.snapshot as Uint8Array);
      const root = (loro.toJSON() as { root: Json }).root;
      loro.free();
      const { message } = presentationFromWorkspace(root);
      const doc = readPresentation(message);
      const addresses = new Map(textBoxAddresses(message).map((a) => [a.boxIndex, a]));
      // One lengthened line per box this plans for, written in one edit to prove the read-back.
      const fixes: LineFix[] = [];

      for (const box of doc.textBoxes) {
        const path = loroPathOf(root, addresses.get(box.boxIndex));
        const { ranges, styles } = path ? rangesOf(valueAt(root, path)) : { ranges: [], styles: [] };
        if (ranges.length === 0) continue;
        tally.boxesWithRanges++;
        const lines = box.lines.map((line) => line.text);
        const length = lines.join("\n").length;
        tally.ranges += ranges.length;
        tally.rangesPastEnd += ranges.filter((r) => r.end > length).length;
        tally.rangesOffLines += ranges.filter((r) => !lineBoundaryRuleAccepts(lines, [r])).length;
        const oldRule = lineBoundaryRuleAccepts(lines, ranges);
        if (!oldRule) tally.refusedByLineBoundaryRule++;

        let refused = false;
        for (const [name, make] of Object.entries(EDITS)) {
          edits[name] ??= { planned: 0, refused: 0 };
          for (const [i, text] of lines.entries()) {
            const changed = make(text, i === lines.length - 1);
            if (changed === undefined || changed === text) continue;
            const after = lines.map((t, k) => (k === i ? changed : t));
            try {
              moveRanges(box.boxIndex, lines, after, ranges, styles);
              edits[name].planned++;
            } catch (e) {
              if (!(e instanceof AttributeRangeError)) throw e;
              edits[name].refused++;
              reasons[e.reason] = (reasons[e.reason] ?? 0) + 1;
              refused = true;
              if (oldRule) regressions.push(`${doc.name} box ${box.boxIndex} line ${i} ${name}: ${e.reason}`);
            }
          }
        }
        if (refused) tally.refused++;
        else tally.planned++;

        if (!refused) {
          try {
            fixes.push(...planLineEdits(doc, [{ boxIndex: box.boxIndex, lineIndex: 0, text: `${lines[0]} x` }]));
          } catch (e) {
            // A line the text path cannot edit, which has nothing to do with ranges.
            if (!(e instanceof EditError)) throw e;
          }
        }
      }

      if (fixes.length > 0) {
        const edit = planWorkspaceEdit(root, fixes);
        checkWorkspaceEdit(root, editedRoot(root, edit.boxes), edit, fixes);
        tally.verified += fixes.length;
      }
    }

    // On stderr, which vitest passes through for a passing test.
    process.stderr.write(`Styling ranges in the workspace: ${JSON.stringify({ ...tally, edits, reasons }, null, 2)}\n`);
    expect(regressions).toEqual([]);
    expect(tally.planned).toBeGreaterThan(0);
    expect(tally.planned + tally.refused).toBe(tally.boxesWithRanges);
  });
});
