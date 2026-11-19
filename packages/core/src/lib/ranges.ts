import type { LineFix } from "./fixes";
import { lineSplice } from "./rtf";

/**
 * Where a text box's attribute ranges go when its lines change: the one rule
 * every writer moves them by, a `.pro` file (`applyFixes` in `fixes.ts`)
 * and a ProPresenter 22 workspace (`planWorkspaceEdit` in
 * `workspace-edit.ts`) alike.
 *
 * A text element's `attributes.custom_attributes` are ranges of character
 * offsets into the box's plain text: All Caps, nearly always, one to a line.
 * ProPresenter does not work them out again from the text when it opens a
 * file -- ProPresenter 20.0.1 was watched not to, nor to mend them at its
 * next edit -- so a writer that changes the text and leaves the ranges puts
 * the capitals on the wrong characters.
 */

/**
 * Why a box's attribute ranges cannot be moved with its text:
 *
 * - `malformed`: a range that starts after it ends, or before the text, or
 *   that its edit would leave so.
 * - `typedAtEdge`: text is added exactly at a range's start or end, on a
 *   line the range does not cover, so whether the range should take it in
 *   is a guess.
 * - `replacedAcrossEdge`: a range starts or ends inside text that is
 *   replaced with other text, on a line it does not cover, so where in the
 *   new text it should start or end is a guess.
 * - `addedLine`: a line is added beside one that styling other than All
 *   Caps covers, or inside a range that does not cover the line it is added
 *   beside, so whether the new line takes it is a guess.
 */
export type RangeRefusal = "malformed" | "typedAtEdge" | "replacedAcrossEdge" | "addedLine";

/** Thrown when a box's attribute ranges cannot be moved with its text without a guess. */
export class AttributeRangeError extends Error {
  readonly boxIndex: number;
  readonly reason: RangeRefusal;
  /** The line whose change it is, where it is one line's: for an added line, the line it is added beside. */
  readonly lineIndex?: number;

  constructor(boxIndex: number, reason: RangeRefusal, lineIndex?: number) {
    super(
      `The attribute ranges of text box ${boxIndex} cannot be moved with its text (${reason}` +
        `${lineIndex === undefined ? "" : `, line ${lineIndex}`})`
    );
    this.name = "AttributeRangeError";
    this.boxIndex = boxIndex;
    this.reason = reason;
    this.lineIndex = lineIndex;
  }
}

/** Lines added beside one line of a box, in the order they read. */
export interface AddedLines {
  before: readonly string[];
  after: readonly string[];
}

/**
 * Whether a capitalization's value is All Caps: the number protobuf.js and a
 * snapshot keep, or its name. Small caps, title case and start case are left
 * out, since what they make of an added line is not known.
 */
export function isAllCaps(value: unknown): boolean {
  return value === 1 || value === "CAPITALIZATION_ALL_CAPS";
}

/** An attribute range, and what is known of the attribute it belongs to. */
export interface Range {
  start: number;
  end: number;
  /** Set when it is All Caps, the one styling an added line beside it takes. */
  caps?: boolean;
  /** Position in the box's `custom_attributes`. */
  index?: number;
  /** The attribute's member of the `Attribute` oneof, `capitalization` say. */
  kind?: string;
  /** The member's value where it is a plain one: `1`, All Caps, for a capitalization. */
  value?: unknown;
  /** The attribute apart from its range, equal for two ranges of the same styling. */
  style?: unknown;
}

/**
 * What one changed line does to the styling on it, for the person to see
 * before choosing it: each attribute range on the line, as the text it
 * covers there now and once the line changes. Only ranges whose text on the
 * line changes are listed; for an added line, every range that covers any of
 * it. A line's own splice is all that moves the ranges on it, so this holds
 * whichever other lines the person leaves chosen.
 */
export interface LineStyling {
  boxIndex: number;
  lineIndex: number;
  ranges: {
    /** Position in the box's `custom_attributes`. */
    index: number;
    kind: string;
    value?: unknown;
    /** The part of the line the range covers now, `""` for none of it, and for an added line. */
    before: string;
    /** The part it covers once the line changes; null where the line is removed. */
    after: string | null;
  }[];
}

/**
 * One change to a box's text, in its characters as ProPresenter counts them
 * (UTF-16 code units, a line break as one): `[start, end)` of the text as it
 * reads now is replaced by `inserted` characters.
 */
interface TextSplice {
  start: number;
  end: number;
  inserted: number;
  lineIndex: number;
  /** The line as it reads now, without its break. */
  line: { start: number; end: number };
  /** The line's characters other than the spaces and tabs at either end. */
  visible: { start: number; end: number };
  /** Set for added lines, put in whole at the start or end of `line`, the line they are added beside. */
  added?: true;
  /**
   * For added lines at one edge of their line, the blanks at that edge: a
   * range of the line's that starts or ends among them (`edge`), past a tab
   * say, reaches the new lines as one at the line's very edge would.
   */
  reach?: { edge: "start" | "end"; start: number; end: number };
}

const isBlank = (c: string) => c === " " || c === "\t";

/** A line's characters other than the spaces and tabs at either end. */
function visibleOf(text: string, line: { start: number; end: number }): { start: number; end: number } {
  let lead = 0;
  while (lead < text.length && isBlank(text[lead])) lead++;
  let trail = 0;
  while (trail < text.length - lead && isBlank(text[text.length - 1 - trail])) trail++;
  return { start: line.start + lead, end: Math.max(line.end - trail, line.start + lead) };
}

/**
 * Each line's change as a splice of the whole box's text, in order. A
 * changed line is the same splice `replaceLineText` makes its RTF edit
 * from; a removed line takes its break with it, as `lineEdit` does, or the
 * break before it where it is the last.
 */
function textSplices(before: readonly string[], after: readonly (string | null)[]): TextSplice[] {
  const splices: TextSplice[] = [];
  for (const [lineIndex, line] of lineBounds(before).entries()) {
    const text = before[lineIndex];
    const next = after[lineIndex];
    const visible = visibleOf(text, line);
    if (next === null && lineIndex === before.length - 1) {
      // The last line has no break after it, so it takes the one before it
      // -- before the whole run of removed lines it ends, each of which took
      // its own break, the last of them this line's.
      let start = line.start;
      while (splices.at(-1)?.end === start && splices.at(-1)?.inserted === 0) start = splices.pop()!.start;
      splices.push({ start: Math.max(start - 1, 0), end: line.end, inserted: 0, lineIndex, line, visible });
    } else if (next === null) {
      splices.push({ start: line.start, end: line.end + 1, inserted: 0, lineIndex, line, visible });
    } else if (next !== text) {
      const { start, end: cut, inserted } = lineSplice(text, next);
      splices.push({ start: line.start + start, end: line.start + cut, inserted: inserted.length, lineIndex, line, visible });
    }
  }
  return splices;
}

/**
 * Added lines as splices of the text the line changes leave: each run put in
 * whole, with its breaks, at the start of the line it goes before or the end
 * of the line it goes after. Over an empty line those are one place, so the
 * two runs are one splice.
 */
function addedSplices(boxIndex: number, lines: readonly (string | null)[], added: ReadonlyMap<number, AddedLines>): TextSplice[] {
  const splices: TextSplice[] = [];
  const size = (texts: readonly string[] = []) => texts.reduce((sum, text) => sum + text.length + 1, 0);
  for (const [lineIndex, line] of lineBounds(lines).entries()) {
    const ahead = size(added.get(lineIndex)?.before);
    const behind = size(added.get(lineIndex)?.after);
    if (ahead + behind === 0) continue;
    // Refused when planning too: the added line would take the formatting of a line that goes.
    if (line === null) throw new AttributeRangeError(boxIndex, "addedLine", lineIndex);
    const at = { lineIndex, line, visible: visibleOf(lines[lineIndex]!, line), added: true as const };
    if (ahead > 0 && behind > 0 && line.start === line.end) {
      splices.push({ start: line.start, end: line.start, inserted: ahead + behind, ...at });
      continue;
    }
    if (ahead > 0) {
      const reach = { edge: "start" as const, start: line.start, end: at.visible.start };
      splices.push({ start: line.start, end: line.start, inserted: ahead, ...at, reach });
    }
    if (behind > 0) {
      const reach = { edge: "end" as const, start: at.visible.end, end: line.end };
      splices.push({ start: line.end, end: line.end, inserted: behind, ...at, reach });
    }
  }
  return splices;
}

/**
 * Where an attribute range's ends go when lines change, mapped through the
 * exact splice each changed line is:
 *
 * 1. An end in text no splice touches moves by the change in length before
 *    it, wherever it sits in its line.
 * 2. An end inside removed text goes to where that text was.
 * 3. A range running past the end of the text is first cut back to the end.
 *    It covers nothing visible, so nothing on screen changes.
 * 4. New text exactly at a range's start or end -- typed there, or
 *    replacing text just past it -- or replacing text the range starts or
 *    ends inside, joins the range when the range covers that whole line --
 *    all of it but spaces and tabs at either end, as an All Caps range
 *    does. Ranges of the same styling count together, since ProPresenter
 *    often splits one line's All Caps at a tab or a space; the new text then
 *    joins the first of them with characters on the line, and the rest move
 *    past it, so they still meet and never overlap. New text stays out of a
 *    range that only meets the line, ending where the line starts or
 *    starting where it ends, and out of an empty range.
 * 5. Anything else is a guess, and the box is refused (`AttributeRangeError`).
 *
 * Then lines added beside a line (`added`, by the line they go beside) are
 * put in whole at its start or end, through the same rules with one
 * difference: an added line takes the styling of the line it is added
 * beside, and only All Caps is known to carry over. So a run of added lines
 * at a range's edge joins it when the range is All Caps and covers that
 * line; stays out of a range that does not cover the line, which ends or
 * starts at the line's edge on a part of it; and any other styling over the
 * whole line, or a range the run would land inside without its covering the
 * line, is a guess, refused as `addedLine`. No range is created: that would
 * be a new container in the document, which nothing here writes.
 *
 * `after` has one entry per line of `before`: its new text, or null where
 * the line is removed. Ranges are in the box's characters as it reads now.
 * `styles` says which ranges are the same styling: those with equal
 * entries. Without it every range is a styling of its own.
 */
export function moveRanges(
  boxIndex: number,
  before: readonly string[],
  after: readonly (string | null)[],
  ranges: readonly Range[],
  styles?: readonly unknown[],
  added: ReadonlyMap<number, AddedLines> = new Map()
): { start: number; end: number }[] {
  const length = before.reduce((sum, text) => sum + text.length, Math.max(before.length - 1, 0));
  const moved = mapThrough(boxIndex, textSplices(before, after), length, ranges, styles);
  const splices = addedSplices(boxIndex, after, added);
  if (splices.length === 0) return moved;
  const kept = after.filter((text) => text !== null);
  const now = kept.reduce((sum, text) => sum + text.length, Math.max(kept.length - 1, 0));
  return mapThrough(
    boxIndex,
    splices,
    now,
    moved.map((range, i) => ({ ...range, caps: ranges[i].caps })),
    styles
  );
}

/** Each range's ends mapped through splices of a text `length` long, in order: the rules `moveRanges` gives. */
function mapThrough(
  boxIndex: number,
  splices: readonly TextSplice[],
  length: number,
  ranges: readonly Range[],
  styles?: readonly unknown[]
): { start: number; end: number }[] {
  if (ranges.some(({ start, end }) => !(start >= 0 && start <= end))) throw new AttributeRangeError(boxIndex, "malformed");
  const cut = ranges.map(({ start, end }) => ({ start: Math.min(start, length), end: Math.min(end, length) }));
  const style = (i: number) => (styles ? styles[i] : i);
  const sameStyle = (i: number) => cut.flatMap((range, k) => (style(k) === style(i) ? [{ ...range, k }] : []));

  /** Whether ranges of this one's styling, together, cover the splice's line. */
  const covers = (i: number, splice: TextSplice) => {
    let reached = splice.visible.start;
    for (const range of sameStyle(i).sort((a, b) => a.start - b.start)) {
      if (range.start <= reached) reached = Math.max(reached, range.end);
    }
    return reached >= splice.visible.end;
  };
  /**
   * Of the ranges of this one's styling that the splice's new text could
   * join, whether this is the one that does -- the first by where it starts
   * -- or one of the others, which move past the new text. Only a range
   * with characters on the line can take it, so an empty range, or one that
   * only meets the line, is neither, and keeps its own place below; unless
   * no range has any, as over an empty line, which the first of them takes.
   * Undefined when this range is not one the new text could join.
   */
  const joins = (i: number, splice: TextSplice): "first" | "other" | undefined => {
    const removes = splice.end > splice.start;
    const touching = (start: number, end: number) => sameStyle(i).filter((r) => r.end >= start && r.start <= end);
    const withText = (rs: ReturnType<typeof touching>) =>
      rs.filter((r) => r.end > r.start && r.end > splice.line.start && r.start < splice.line.end);
    let could = touching(splice.start, splice.end);
    let onLine = withText(could);
    // Added lines reach a range past the blanks at the line's edge, where none of this styling is right at it.
    if (onLine.length === 0 && splice.reach) {
      could = touching(splice.reach.start, splice.reach.end);
      onLine = withText(could);
    }
    const pool = onLine.length > 0 ? onLine : could;
    if (!pool.some((r) => r.k === i)) return undefined;
    // Where text is replaced, a range that held some of it comes before one
    // that only meets it: the new text takes the place of what it held.
    const meetsOnly = (r: { start: number; end: number }) => (removes && !(r.end > splice.start && r.start < splice.end) ? 1 : 0);
    pool.sort((a, b) => meetsOnly(a) - meetsOnly(b) || a.start - b.start || a.k - b.k);
    return pool[0].k === i ? "first" : "other";
  };

  // Added lines landing inside a range: the new lines take it only where it
  // covers the line they are added beside, and the line's own styling.
  for (const splice of splices) {
    if (!splice.added) continue;
    for (const [i, range] of cut.entries()) {
      if (range.start < splice.start && splice.start < range.end && !covers(i, splice)) {
        throw new AttributeRangeError(boxIndex, "addedLine", splice.lineIndex);
      }
    }
  }

  return cut.map((range, i) => {
    const map = (x: number, edge: "start" | "end") => {
      let shift = 0;
      for (const splice of splices) {
        const removes = splice.end > splice.start;
        // An end among the blanks at the edge of a line that lines are added
        // at: the range that takes them reaches out to them, over the blanks.
        const { reach } = splice;
        if (reach?.edge === edge && x !== splice.start && x >= reach.start && x <= reach.end) {
          const joined = covers(i, splice) ? joins(i, splice) : undefined;
          if (joined !== undefined && !ranges[i].caps) throw new AttributeRangeError(boxIndex, "addedLine", splice.lineIndex);
          if (joined === "first") return edge === "start" ? splice.start + shift : splice.start + shift + splice.inserted;
        }
        // New text replacing what lies just past this range's end, or just
        // before its start, lands right at its edge, as typed text would.
        const atEdge =
          removes &&
          splice.inserted > 0 &&
          ((edge === "end" && x === splice.start && range.start < x) || (edge === "start" && x === splice.end && range.end > x));
        // Before this splice, or where a removal begins: nothing before it moves.
        if (!atEdge && (x < splice.start || (x === splice.start && removes))) break;
        // After it, or where a removal ends: by however much it changed the length.
        if (!atEdge && (x > splice.end || (x === splice.end && removes))) {
          shift += splice.inserted - (splice.end - splice.start);
          continue;
        }
        const at = splice.start + shift;
        // Inside removed text with nothing put in its place: where it was.
        if (splice.inserted === 0) return at;
        // Lines added beside a blank line, where a range runs from text on
        // their far side up to that line: they fall inside it, whatever its
        // styling, as between any two lines it covers.
        if (splice.reach && splice.visible.start === splice.visible.end) {
          if (splice.reach.edge === "start" && edge === "end" && range.start < splice.start) return at + splice.inserted;
          if (splice.reach.edge === "end" && edge === "start" && range.end > splice.end) return at;
        }
        // New text right at this end, or in place of text this end is inside.
        // Over a whole line, the range it joins takes it in.
        const joined = covers(i, splice) ? joins(i, splice) : undefined;
        // An added line takes only All Caps from the line beside it.
        if (splice.added && joined !== undefined && !ranges[i].caps) {
          throw new AttributeRangeError(boxIndex, "addedLine", splice.lineIndex);
        }
        if (joined === "first") return edge === "start" ? at : at + splice.inserted;
        // Another range took the new text: this one ends before it, or starts after it.
        if (joined === "other") return edge === "end" && atEdge ? at : at + splice.inserted;
        // An empty range covers nothing wherever it is, and stays before the
        // new text: both its ends, so it never comes out backwards.
        if (range.start === range.end) return at;
        // A range that only meets the line -- ending where it starts, or
        // starting where it ends -- is not on it, and leaves it out; as does
        // one on part of a line that lines are added beside.
        if (edge === "end" && (x === splice.line.start || splice.added)) return at;
        if (edge === "start" && (x === splice.line.end || splice.added)) return at + splice.inserted;
        throw new AttributeRangeError(boxIndex, atEdge || !removes ? "typedAtEdge" : "replacedAcrossEdge", splice.lineIndex);
      }
      return x + shift;
    };
    const moved = { start: map(range.start, "start"), end: map(range.end, "end") };
    // Each end is mapped on its own; a range they leave backwards is never written.
    if (moved.end < moved.start) throw new AttributeRangeError(boxIndex, "malformed");
    return moved;
  });
}

/** Each line's start and end in a box's text, or null for a line that is not there. */
function lineBounds(lines: readonly string[]): { start: number; end: number }[];
function lineBounds(lines: readonly (string | null)[]): ({ start: number; end: number } | null)[];
function lineBounds(lines: readonly (string | null)[]): ({ start: number; end: number } | null)[] {
  let at = 0;
  return lines.map((text) => {
    if (text === null) return null;
    const bounds = { start: at, end: at + text.length };
    at = bounds.end + 1;
    return bounds;
  });
}

/** The part of a line a range covers, `""` for none; an empty line counts as covered by a range around it. */
function coveredOn(text: string, line: { start: number; end: number }, range: { start: number; end: number }): string {
  if (range.start > line.end || range.end < line.start) return "";
  return text.slice(Math.max(range.start, line.start) - line.start, Math.min(range.end, line.end) - line.start);
}

/** Which lines a set of fixes changes, removes and adds, as `moveRanges` takes them. */
function layout(lines: readonly string[], fixes: readonly LineFix[]) {
  const byLine = new Map(fixes.filter((fix) => !fix.insert).map((fix) => [fix.lineIndex, fix.after]));
  const after = lines.map((was, i) => (byLine.has(i) ? byLine.get(i)! : was));
  const added = new Map<number, { before: LineFix[]; after: LineFix[] }>();
  // In the order the fixes list them, which is the order the lines read.
  for (const fix of fixes) {
    if (!fix.insert) continue;
    const beside = added.get(fix.lineIndex) ?? { before: [], after: [] };
    beside[fix.insert].push(fix);
    added.set(fix.lineIndex, beside);
  }
  const texts = new Map(
    [...added].map(([i, { before, after }]) => [i, { before: before.map((f) => f.after!), after: after.map((f) => f.after!) }])
  );
  return { after, added, texts };
}

/**
 * Where a box's attribute ranges go once a set of fixes is in it, and what
 * each fix does to the styling on its line, for the person to see before
 * they choose it. `cutBack` is set when a range ran past the end of the text
 * and is cut back to it.
 *
 * Each fix is also moved on its own, as the person may untick the rest, so
 * one that only works beside another is refused before anybody is asked.
 * Throws `AttributeRangeError`.
 */
export function rangesAfter(
  box: { boxIndex: number; lines: readonly { text: string }[] },
  fixes: readonly LineFix[],
  ranges: readonly Range[]
): { moved: { start: number; end: number }[]; styling: Map<LineFix, LineStyling>; cutBack: boolean } {
  const mine = fixes.filter((fix) => fix.boxIndex === box.boxIndex);
  const lines = box.lines.map((line) => line.text);
  // Ranges of the same styling: equal `style`, or each its own without one.
  const styles = ranges.map((range, i) => range.style ?? i);
  const move = (chosen: readonly LineFix[]) => {
    const { after, texts } = layout(lines, chosen);
    return moveRanges(box.boxIndex, lines, after, ranges, styles, texts);
  };
  if (mine.length > 1) for (const fix of mine) move([fix]);
  const moved = move(mine);

  // Where every line lies once the fixes are in, added lines among them.
  const { after, added } = layout(lines, mine);
  const placed = new Map<LineFix | number, { start: number; end: number }>();
  let at = 0;
  const place = (key: LineFix | number, text: string) => {
    placed.set(key, { start: at, end: at + text.length });
    at += text.length + 1;
  };
  for (const [i, text] of after.entries()) {
    for (const fix of added.get(i)?.before ?? []) place(fix, fix.after!);
    if (text !== null) place(i, text);
    for (const fix of added.get(i)?.after ?? []) place(fix, fix.after!);
  }

  const length = lines.join("\n").length;
  const was = lineBounds(lines);
  const styling = new Map<LineFix, LineStyling>();
  for (const fix of mine) {
    const i = fix.lineIndex;
    const on = ranges.flatMap((range, k) => {
      const about = { index: range.index ?? k, kind: range.kind ?? "unknown", ...(range.value !== undefined && { value: range.value }) };
      if (fix.insert) {
        const covered = coveredOn(fix.after!, placed.get(fix)!, moved[k]);
        return covered ? [{ ...about, before: "", after: covered }] : [];
      }
      const shown = {
        before: coveredOn(lines[i], was[i], { start: Math.min(range.start, length), end: Math.min(range.end, length) }),
        after: after[i] === null ? null : coveredOn(after[i]!, placed.get(i)!, moved[k]),
      };
      return shown.before === shown.after || (shown.before === "" && !shown.after) ? [] : [{ ...about, ...shown }];
    });
    styling.set(fix, { boxIndex: box.boxIndex, lineIndex: i, ranges: on });
  }
  return { moved, styling, cutBack: ranges.some((range) => range.end > length) };
}
