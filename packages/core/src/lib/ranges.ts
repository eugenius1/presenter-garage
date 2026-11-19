import type { LineFix } from "./fixes";

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
 * Thrown when a box has character ranges that cannot be moved with its text
 * without guessing: one that does not start and end on its lines as they
 * read, or, with `addedLine` set, one an added line could only guess
 * whether to take.
 */
export class AttributeRangeError extends Error {
  readonly boxIndex: number;
  readonly addedLine: boolean;

  constructor(boxIndex: number, addedLine = false) {
    super(
      addedLine
        ? `Whether a line added to text box ${boxIndex} takes its attribute ranges would be a guess`
        : `The attribute ranges of text box ${boxIndex} do not fall on its lines`
    );
    this.name = "AttributeRangeError";
    this.boxIndex = boxIndex;
    this.addedLine = addedLine;
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

/** An attribute range; `caps` when it is All Caps, which an added line beside it takes. */
export interface Range {
  start: number;
  end: number;
  caps?: boolean;
}

/**
 * Where an attribute range's ends go when lines change length, or lines are
 * added.
 *
 * Each end has to sit on a line's start or a line's end as the box reads
 * now -- in this box's characters, a line break counting as one, as
 * ProPresenter counts them -- and it goes to the same place on that line
 * once the lines change. A removed line's start and end both become the
 * place it was, which is where the next line now starts. An end anywhere
 * else, inside a line or beyond the text, cannot be moved without guessing
 * what it was meant to cover, so the box is refused.
 *
 * `after` has one entry per line of `before`: its new text, or null where
 * the line is removed. `added` has, by line, the lines added beside it.
 *
 * An added line takes the formatting of the line it is added beside, and so
 * its ranges: a range is to cover the new lines exactly when it covers
 * all of that line. A capitalization -- ProPresenter's All Caps, nearly
 * every range in a real library and one to a line -- that ends where that
 * line does is widened over the new lines, so they read in capitals as
 * their neighbour does. No range is created: that would be a new container
 * in the document, which nothing here writes. Any other range that would
 * come out covering the new lines and not the line, or the line and not
 * the new lines, or part of them, makes the answer a guess, and the box is
 * refused.
 */
export function moveRanges(
  boxIndex: number,
  before: readonly string[],
  after: readonly (string | null)[],
  ranges: readonly Range[],
  added: ReadonlyMap<number, AddedLines> = new Map()
): { start: number; end: number }[] {
  // Each line's old start and end, to where they go.
  const starts = new Map<number, number>();
  const ends = new Map<number, number>();
  /** Each run of added lines: where its text lies now, and where the line it was added beside lies, then and now. */
  const blocks: {
    side: keyof AddedLines;
    start: number;
    end: number;
    line: { was: { start: number; end: number }; now: { start: number; end: number } };
  }[] = [];
  let was = 0;
  let now = 0;
  /** Lay out a run of added lines from `now`, and say where its text lies. */
  const lay = (texts: readonly string[]) => {
    const start = now;
    for (const text of texts) now += text.length + 1;
    return { start, end: now - 1 };
  };
  for (const [i, text] of before.entries()) {
    const next = after[i];
    const add = added.get(i);
    // Refused when planning: the added line would take the formatting of a line that goes.
    if (next === null && (add?.before.length || add?.after.length)) throw new AttributeRangeError(boxIndex, true);
    const ahead = add?.before.length ? lay(add.before) : undefined;
    const line = {
      was: { start: was, end: was + text.length },
      now: { start: now, end: now + (next?.length ?? 0) },
    };
    // A removed line takes no room, so both its ends land where the next line now starts.
    starts.set(line.was.start, line.now.start);
    ends.set(line.was.end, line.now.end);
    was += text.length + 1;
    if (next !== null) now += next.length + 1;
    if (ahead) blocks.push({ side: "before", ...ahead, line });
    if (add?.after.length) blocks.push({ side: "after", ...lay(add.after), line });
  }
  // `now` counts a break after the last kept line that is not there. A
  // removed line with no kept line after it has nowhere to land but the end
  // of the text, and would otherwise land one past it.
  const length = Math.max(now - 1, 0);
  const place = (p: number | undefined) => (p === undefined ? undefined : Math.min(p, length));
  const covers = (r: { start: number; end: number }, span: { start: number; end: number }) =>
    r.start <= span.start && r.end >= span.end;

  // A start is matched to a line's start first, an end to a line's end, so
  // a range over an empty line keeps both its ends on that line.
  return ranges.map((range) => {
    const { start, end } = range;
    const moved = { start: place(starts.get(start) ?? ends.get(start)), end: place(ends.get(end) ?? starts.get(end)) };
    if (!(start <= end) || moved.start === undefined || moved.end === undefined) throw new AttributeRangeError(boxIndex);
    const out = moved as { start: number; end: number };

    for (const block of blocks) {
      // Whether the range covers the line, judged by where it was, so the
      // empty range a removed neighbour leaves behind is not mistaken for one.
      const owns = covers(range, block.line.was);
      if (owns && !covers(out, block)) {
        const edge = block.side === "after" ? out.end === block.line.now.end : out.start === block.line.now.start;
        if (!range.caps || !edge) throw new AttributeRangeError(boxIndex, true);
        if (block.side === "after") out.end = block.end;
        else out.start = block.start;
      } else if (!owns && Math.max(out.start, block.start) < Math.min(out.end, block.end)) {
        throw new AttributeRangeError(boxIndex, true);
      }
    }
    return out;
  });
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
 * Where a box's attribute ranges go once a set of fixes is in it, and which
 * of the lines it adds come out in capitals: those a widened capitalization
 * covers, for the person to be told before they choose them.
 *
 * Each fix is also moved on its own, as the person may untick the rest, so
 * one that only works beside another is refused before anybody is asked.
 * Throws `AttributeRangeError`.
 */
export function rangesAfter(
  box: { boxIndex: number; lines: readonly { text: string }[] },
  fixes: readonly LineFix[],
  ranges: readonly Range[]
): { moved: { start: number; end: number }[]; capitals: Set<LineFix> } {
  const mine = fixes.filter((fix) => fix.boxIndex === box.boxIndex);
  const lines = box.lines.map((line) => line.text);
  const move = (chosen: readonly LineFix[]) => {
    const { after, texts } = layout(lines, chosen);
    return moveRanges(box.boxIndex, lines, after, ranges, texts);
  };
  if (mine.length > 1) for (const fix of mine) move([fix]);
  const moved = move(mine);

  const caps = moved.filter((_, i) => ranges[i].caps);
  const capitals = new Set<LineFix>();
  const { after, added } = layout(lines, mine);
  let at = 0;
  const lay = (fixes: readonly LineFix[] = []) => {
    for (const fix of fixes) {
      const end = at + fix.after!.length;
      if (caps.some((r) => r.start <= at && r.end >= end)) capitals.add(fix);
      at = end + 1;
    }
  };
  for (const [i, text] of after.entries()) {
    lay(added.get(i)?.before);
    if (text !== null) at += text.length + 1;
    lay(added.get(i)?.after);
  }
  return { moved, capitals };
}
