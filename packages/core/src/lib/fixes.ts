import {
  checkPresentation,
  checkPresentationFidelity,
  decodePresentation,
  encodePresentation,
  openPresentation,
  readPresentation,
  RUN_CLASS,
  textBoxRanges,
  SPACE_CLASS,
  TRAILING_PUNCTUATION,
  unreadableReport,
  writeTextBoxes,
  type AttributeRange,
  type PresentationDoc,
  type PresentationReport,
  type ReadProblem,
  type TextIssue,
  type TextIssueKind,
  type TrailingPunctuation,
} from "./presentation";
import { extractLines, type RtfLine } from "./rtf";
import {
  applyEdits,
  cutsToEdits,
  hasLineControl,
  insertLineEdit,
  lineEdit,
  replaceLineText,
  type InsertSide,
  type SourceEdit,
  type TextCut,
} from "./rtf-edit";
import { groupBy } from "./collections";
import type { RawDoc } from "./decode";
import type { Finding } from "./rules";
import { AttributeRangeError, rangesAfter, type LineStyling } from "./ranges";

/**
 * Turning findings into edits.
 *
 * Everything here is a pure function from a decoded presentation to bytes, so
 * the whole write path can be exercised without a folder, a browser or a
 * reader's library. The interface's job is only to decide which fixes are
 * ticked; nothing below this line asks a question it cannot answer from the
 * file in front of it.
 *
 * Fixes are planned per *line*, not per finding. One line can carry three
 * findings at once -- a leading space, a doubled space and a trailing comma --
 * and showing three rows for one line would ask the reader to approve edits
 * that overlap each other. One row, one before, one after, one decision.
 */

// Built from the checker's own character classes, so a fix removes exactly
// what the check reported and never a character more.
const LEADING = new RegExp(`^${SPACE_CLASS}+`);
const TRAILING = new RegExp(`${SPACE_CLASS}+$`);
/** A run of two or more, with text on both sides of it. */
const RUN = new RegExp(`(?<=\\S)${RUN_CLASS}{2,}(?=\\S)`, "g");
/**
 * The punctuation that ends a line, with whatever whitespace surrounds it.
 *
 * Built from the checker's own patterns, so the full stop that is not reported
 * at the end of "Gloire..." is not removed there either.
 */
const ENDING = Object.fromEntries(
  Object.entries(TRAILING_PUNCTUATION).map(([kind, mark]) => [
    kind,
    new RegExp(`${SPACE_CLASS}*${mark}${SPACE_CLASS}*$`),
  ])
) as Record<TrailingPunctuation, RegExp>;

export interface LineFix {
  /** Which text box, as {@link TextBox.boxIndex} numbers them. */
  boxIndex: number;
  /** Which line within that box; for an added line, the line it is added beside. */
  lineIndex: number;
  /**
   * Set for a line that is added rather than changed: it goes on this side
   * of line `lineIndex`, which itself is left as it is.
   */
  insert?: InsertSide;
  slideIndex: number;
  cueName: string;
  groupName?: string;
  /** Every kind this one edit settles, in the order they are reported. */
  kinds: TextIssueKind[];
  /**
   * The line as it stands. For an added line, the line it is added beside,
   * which is what a fix planned against a file that has moved on is caught by.
   */
  before: string;
  /** The line as it would read, or null when the line itself goes. */
  after: string | null;
  /** The splice that achieves it. */
  edits: SourceEdit[];
  /**
   * The whole box's RTF as it was scanned, which the offsets in `edits` are
   * offsets into.
   */
  source: string;
}

/** Where a change falls around its line: lines added before it, the line itself, lines added after it. */
const SIDE_RANK = { before: -1, after: 1 } as const;

/**
 * Box by box, line by line: the order a slide is read in.
 *
 * Lines added at one place keep the order they were asked for in, since
 * the sort is stable, and that order is also the order their edits are
 * written in -- they are zero-width edits at one offset, which
 * `applyEdits` writes in the order given.
 */
function byReadingOrder(a: LineFix, b: LineFix): number {
  const rank = (fix: LineFix) => (fix.insert ? SIDE_RANK[fix.insert] : 0);
  return a.boxIndex - b.boxIndex || a.lineIndex - b.lineIndex || rank(a) - rank(b);
}

/** An address that names one line, for grouping findings and ticking boxes. */
export function fixKey(fix: { boxIndex: number; lineIndex: number }): string {
  return `${fix.boxIndex}:${fix.lineIndex}`;
}

/** The cuts that settle one kind of finding on one line, in text coordinates. */
function cutsFor(kind: TextIssueKind, text: string): TextCut[] {
  switch (kind) {
    case "leadingSpace": {
      const found = LEADING.exec(text);
      return found ? [{ start: 0, end: found[0].length }] : [];
    }
    case "trailingSpace": {
      const found = TRAILING.exec(text);
      return found ? [{ start: text.length - found[0].length, end: text.length }] : [];
    }
    case "repeatedSpace":
      // All of each run but one character, so two words stay two words. The
      // survivor is an ordinary space where the run holds one: a run written
      // as tab-then-space would otherwise collapse to the tab, which is the
      // same invisible oddity in a narrower form.
      return [...text.matchAll(RUN)].flatMap((m) => {
        const keep = m[0].includes(" ") ? m[0].indexOf(" ") : 0;
        return [
          { start: m.index, end: m.index + keep },
          { start: m.index + keep + 1, end: m.index + m[0].length },
        ];
      });
    case "blankLine":
      // Handled as a whole-line removal; a blank line has no text to cut.
      return [];
    default: {
      // The whitespace around it goes too. Otherwise "nom ," becomes "nom ",
      // trading one finding for another.
      const found = ENDING[kind].exec(text);
      return found ? [{ start: text.length - found[0].length, end: text.length }] : [];
    }
  }
}

/** Apply cuts to a plain string, to show what the line would read. */
function preview(text: string, cuts: readonly TextCut[]): string {
  const ordered = [...cuts].sort((a, b) => b.start - a.start);
  let out = text;
  for (const cut of ordered) out = out.slice(0, cut.start) + out.slice(cut.end);
  return out;
}

/**
 * Work out what to do about the findings on one line.
 *
 * Returns null when the line cannot be fixed safely -- an edit that cannot be
 * expressed against the source, or a gap with no break to remove. No offsets,
 * no fix: an unfixable line stays reported and untouched rather than being
 * repaired approximately.
 */
function planLine(
  rtf: string,
  line: RtfLine,
  issues: readonly TextIssue[]
): LineFix | null {
  const first = issues[0];
  const kinds = issues.map((i) => i.kind);
  const site = {
    boxIndex: first.boxIndex,
    lineIndex: first.lineIndex,
    slideIndex: first.slideIndex,
    cueName: first.cueName,
    groupName: first.groupName,
    kinds,
    source: rtf,
  };

  if (kinds.includes("blankLine")) {
    // A blank line is removed outright: there is nothing on it to trim, and
    // leaving the paragraph behind is the problem being reported.
    const edits = lineEdit(rtf, line);
    return edits && { ...site, before: line.text, after: null, edits };
  }

  const cuts = kinds.flatMap((kind) => cutsFor(kind, line.text));
  if (cuts.length === 0) return null;

  const edits = cutsToEdits(rtf, line, cuts);
  if (edits === null) return null;

  return { ...site, before: line.text, after: preview(line.text, cuts), edits };
}

/**
 * Plan a fix for every line the given findings touch.
 *
 * Takes findings rather than re-deriving them, so the interface's filters --
 * which checks are switched on, which pills are pressed -- decide what is
 * offered without this having to know about any of that.
 */
export function planFixes(doc: PresentationDoc, issues: readonly TextIssue[]): LineFix[] {
  const boxes = new Map(doc.textBoxes.map((box) => [box.boxIndex, box]));
  const fixes: LineFix[] = [];
  for (const group of groupBy(issues, fixKey).values()) {
    const box = boxes.get(group[0].boxIndex);
    const line = box?.lines[group[0].lineIndex];
    if (!box || !line) continue;
    const fix = planLine(box.rtf, line, group);
    if (fix) fixes.push(fix);
  }

  // Back into reading order, which is the order the findings were listed in.
  return fixes.sort(byReadingOrder);
}

/** One line as somebody wants it to read, by the address `readPresentation` gives it. */
export interface LineChange {
  boxIndex: number;
  lineIndex: number;
  /** What the line should read, on one line; null removes the line. */
  text: string | null;
  /**
   * Add `text` as a new line on this side of line `lineIndex` instead,
   * leaving that line as it is. The new line takes its formatting. Several
   * added on one side of one line go in the order they are asked for.
   */
  insert?: InsertSide;
}

/**
 * Why a requested change could not be planned.
 *
 * - `noSuchLine`: the file has no such box or line.
 * - `duplicate`: two changes name the same line.
 * - `unchanged`: the line already reads that.
 * - `notOneLine`: the text holds a line break or another control character.
 * - `lastLine`: removing the last line of a box, which has no break to take with it.
 * - `emptyLine`: a line added with no text. A blank line between two others
 *   is what the blank-line check reports.
 * - `besideRemoved`: a line added beside a line the same plan removes, whose
 *   formatting it would have taken.
 * - `unsupported`: the change would not read back as asked once spliced --
 *   emptying a last line with nothing else on it, which reads as no line at
 *   all, or a box that is not an RTF document.
 */
export type EditRefusal =
  | "noSuchLine"
  | "duplicate"
  | "unchanged"
  | "notOneLine"
  | "lastLine"
  | "emptyLine"
  | "besideRemoved"
  | "unsupported";

/** Where a change is, in words: its line, or the line an added one goes beside. */
export function changeSite(change: Pick<LineChange, "lineIndex" | "insert">): string {
  return change.insert ? `a line added ${change.insert} line ${change.lineIndex}` : `line ${change.lineIndex}`;
}

export class EditError extends Error {
  readonly reason: EditRefusal;
  readonly change: LineChange;

  constructor(reason: EditRefusal, change: LineChange) {
    super(`${reason} at box ${change.boxIndex}, ${changeSite(change)}`);
    this.name = "EditError";
    this.reason = reason;
    this.change = change;
  }
}

/**
 * Plan line changes asked for in words rather than found by a check.
 *
 * The result is the same `LineFix` the checks produce, so it goes through the
 * same `applyFixes` -- the same fidelity gate, the same staleness check and
 * the same read-back of every line in the file. There is one write path, and
 * this is a second way into it rather than a second path. It carries no
 * `kinds`: nothing was found, somebody asked.
 *
 * A change can also add a line (`insert`), which is a fix of its own with a
 * tick box of its own, so the person can leave out one added line and keep
 * the rest. Its edit adds the line and touches no character already there;
 * see `insertLineEdit`.
 *
 * All or nothing: one change that cannot be planned refuses the lot, since a
 * half-applied set of edits to a song is worse than none.
 *
 * Each box is spliced and read back here too, with every planned change in
 * it and with each on its own, as the person may untick the rest, so a set
 * of edits that would only fail `applyFixes`' read-back is refused before
 * anybody is asked to approve it rather than after.
 */
export function planLineEdits(doc: PresentationDoc, changes: readonly LineChange[]): LineFix[] {
  const boxes = new Map(doc.textBoxes.map((box) => [box.boxIndex, box]));
  const seen = new Set<string>();
  const removed = new Set(changes.filter((c) => !c.insert && c.text === null).map(fixKey));
  const fixes: LineFix[] = [];

  for (const change of changes) {
    const box = boxes.get(change.boxIndex);
    const line = box?.lines[change.lineIndex];
    if (!box || !line) throw new EditError("noSuchLine", change);
    if (change.text !== null && hasLineControl(change.text)) throw new EditError("notOneLine", change);

    let edits: SourceEdit[] | null;
    if (change.insert) {
      // Not `unchanged` when it reads like its neighbour: repeating a line is
      // the commonest reason to add one.
      if (!change.text) throw new EditError("emptyLine", change);
      if (removed.has(fixKey(change))) throw new EditError("besideRemoved", change);
      const edit = insertLineEdit(box.rtf, box.lines, line.index, change.insert, change.text);
      edits = edit && [edit];
    } else {
      const key = fixKey(change);
      if (seen.has(key)) throw new EditError("duplicate", change);
      seen.add(key);
      if (change.text === line.text) throw new EditError("unchanged", change);
      edits = change.text === null ? lineEdit(box.rtf, line) : replaceLineText(box.rtf, line, change.text);
      if (edits === null && change.text === null) throw new EditError("lastLine", change);
    }
    if (edits === null) throw new EditError("unsupported", change);

    fixes.push({
      boxIndex: box.boxIndex,
      lineIndex: line.index,
      ...(change.insert && { insert: change.insert }),
      slideIndex: box.slideIndex,
      cueName: box.cueName,
      groupName: box.groupName,
      kinds: [],
      before: line.text,
      after: change.text,
      edits,
      source: box.rtf,
    });
  }

  // Into reading order before splicing: lines added at one offset are
  // written in the order their edits are listed, and `applyFixes` will list
  // them in this order too.
  fixes.sort(byReadingOrder);

  const refuse = (fix: LineFix) =>
    new EditError("unsupported", { boxIndex: fix.boxIndex, lineIndex: fix.lineIndex, text: fix.after, insert: fix.insert });
  for (const box of doc.textBoxes) {
    const mine = fixes.filter((fix) => fix.boxIndex === box.boxIndex);
    if (mine.length === 0) continue;
    // Each change alone too, since the person may untick every other one: a
    // line added before a box's one empty line reads back only while a line
    // added after it keeps that line alive.
    if (mine.length > 1) {
      const alone = mine.find((fix) => !readsBack(box, [fix]));
      if (alone) throw refuse(alone);
    }
    // Named by the box's first change: which of several broke it cannot be
    // told from the result.
    if (!readsBack(box, mine)) throw refuse(mine[0]);
  }

  return fixes;
}

/**
 * Why a file was not written. Carries a code; the interface supplies the words.
 * `attributeRanges` is an `AttributeRangeError`: a box's ranges cannot be
 * moved with its text, or a line added to it, without a guess.
 */
export type FixRefusal =
  | "lossy"
  | "unchanged"
  | "verifyFailed"
  | "unreadable"
  | "stale"
  | "attributeRanges";

export class FixError extends Error {
  readonly reason: FixRefusal;

  constructor(reason: FixRefusal) {
    super(reason);
    this.name = "FixError";
    this.reason = reason;
  }
}

/**
 * Apply fixes to a file and hand back the bytes, or refuse.
 *
 * Four things have to hold before this returns anything, and every one is
 * checked against the file itself rather than assumed from the corpus:
 *
 * - the file survives a decode and re-encode with nothing lost, because
 *   protobuf.js drops fields the reverse-engineered schema does not declare;
 * - the edits actually change something;
 * - each box still holds the source it held when the fix was planned, since
 *   the offsets a fix is built from describe the file as it was scanned and
 *   mean nothing against a file somebody has edited since;
 * - re-reading the result gives exactly the lines that were promised, every
 *   other line included.
 *
 * The last is the one that matters most. Everything upstream is tested, but a
 * file nobody has seen is still a file nobody has seen, and a wrong splice is
 * only cheap to discover here.
 */
export function applyFixes(bytes: Uint8Array, fixes: readonly LineFix[]): Uint8Array {
  if (fixes.length === 0) throw new FixError("unchanged");

  let doc;
  let before;
  try {
    if (!checkPresentationFidelity(bytes).exportSafe) throw new FixError("lossy");
    doc = decodePresentation(bytes);
    before = readPresentation(doc);
  } catch (e) {
    // A file that cannot be read cannot be repaired. It is already reported as
    // unreadable in the findings; this is the same answer on the way out.
    throw e instanceof FixError ? e : new FixError("unreadable");
  }

  const replacements = spliceBoxes(before, fixes);
  let planned;
  try {
    planned = presentationRanges(doc, before, fixes);
  } catch (e) {
    if (e instanceof AttributeRangeError) throw new FixError("attributeRanges");
    throw e;
  }

  writeTextBoxes(doc, replacements, planned.moved);
  const written = encodePresentation(doc);

  // The gate again, on the bytes handed back rather than the ones read.
  if (!checkPresentationFidelity(written).exportSafe) throw new FixError("lossy");
  const reread = decodePresentation(written);
  verifyLines(readPresentation(reread), before, fixes);
  verifyRanges(textBoxRanges(reread), planned);
  return written;
}

/** A `.pro` file's attribute ranges, as read and as the fixes will leave them. */
export interface PlannedRanges {
  /** Every box's ranges as the file holds them now. */
  before: Map<number, AttributeRange[]>;
  /** Each edited box's ranges once the fixes are in, by box. */
  moved: Map<number, AttributeRange[]>;
  /** What each fix does to the styling on its line, one per fix in the order of the fixes. */
  styling: LineStyling[];
  /** The edited boxes with a range that ran past the end of the text, cut back to it. */
  cutBack: Set<number>;
}

/**
 * Where a `.pro` file's attribute ranges go once the fixes are in, by
 * `rangesAfter`, the rule a workspace's ranges move by too. ProPresenter
 * does not move them itself on opening the file, so left alone they would
 * put the capitals on the wrong characters. `raw` is the decoded message
 * `before` was read from. Throws `AttributeRangeError`.
 */
export function presentationRanges(raw: RawDoc, before: PresentationDoc, fixes: readonly LineFix[]): PlannedRanges {
  const ranges = textBoxRanges(raw);
  const moved = new Map<number, AttributeRange[]>();
  const styling = new Map<LineFix, LineStyling>();
  const cutBack = new Set<number>();
  for (const boxIndex of new Set(fixes.map((fix) => fix.boxIndex))) {
    const box = before.textBoxes.find((b) => b.boxIndex === boxIndex)!;
    const present = ranges.get(boxIndex) ?? [];
    const after = rangesAfter(box, fixes, present);
    moved.set(boxIndex, present.map((range, i) => ({ ...range, ...after.moved[i] })));
    for (const [fix, said] of after.styling) styling.set(fix, said);
    if (after.cutBack) cutBack.add(boxIndex);
  }
  return { before: ranges, moved, styling: fixes.map((fix) => styling.get(fix)!), cutBack };
}

/**
 * Throws `verifyFailed` unless every range of every box reads back where it
 * was planned, the same styling it was: moved in the edited boxes, exactly
 * where it was in the rest.
 */
export function verifyRanges(after: ReadonlyMap<number, readonly AttributeRange[]>, planned: PlannedRanges): void {
  if (after.size !== planned.before.size) throw new FixError("verifyFailed");
  for (const [boxIndex, was] of planned.before) {
    const want = planned.moved.get(boxIndex) ?? was;
    const got = after.get(boxIndex);
    const same = (a: AttributeRange, b: AttributeRange) =>
      a.index === b.index && a.start === b.start && a.end === b.end && a.style === b.style;
    if (got?.length !== want.length || got.some((range, i) => !same(range, want[i]))) throw new FixError("verifyFailed");
  }
}

/**
 * Each edited box's new RTF, by box, from the boxes as they read now.
 *
 * Throws `stale` when a box no longer holds the source a fix was planned
 * against. Shared by every writer, so that what a box becomes is worked out
 * one way whatever it is then written into.
 */
export function spliceBoxes(before: PresentationDoc, fixes: readonly LineFix[]): Map<number, string> {
  const byBox = new Map<number, SourceEdit[]>();
  for (const fix of fixes) {
    // ProPresenter may have been open all along. A fix carries offsets into
    // the box as it was read, so a box that no longer holds that source is a
    // fix that no longer describes anything. The whole box, not just the line:
    // recolouring the line above shifts every offset below it while this
    // line's text reads exactly as it did.
    const box = before.textBoxes.find((b) => b.boxIndex === fix.boxIndex);
    if (box?.rtf !== fix.source || box.lines[fix.lineIndex]?.text !== fix.before) {
      throw new FixError("stale");
    }

    const edits = byBox.get(fix.boxIndex);
    if (edits) edits.push(...fix.edits);
    else byBox.set(fix.boxIndex, [...fix.edits]);
  }

  const replacements = new Map<number, string>();
  for (const [boxIndex, edits] of byBox) {
    const box = before.textBoxes.find((b) => b.boxIndex === boxIndex)!;
    replacements.set(boxIndex, applyEdits(box.rtf, edits));
  }

  return replacements;
}

/** Whether a box with these fixes spliced in reads exactly as `expected()` says. */
function readsBack(box: { rtf: string; lines: RtfLine[] }, fixes: readonly LineFix[]): boolean {
  const got = extractLines(applyEdits(box.rtf, fixes.flatMap((fix) => fix.edits))).map((line) => line.text);
  const want = expected(box, fixes);
  return got.length === want.length && got.every((text, i) => text === want[i]);
}

/**
 * What every line of every edited box should read once the fixes are in:
 * each line as changed or as it was, with the lines added before and after
 * it in the order the fixes list them.
 */
function expected(box: { lines: RtfLine[] }, fixes: readonly LineFix[]): string[] {
  const changed = new Map(fixes.filter((f) => !f.insert).map((f) => [f.lineIndex, f.after]));
  const added = (index: number, side: InsertSide) =>
    fixes.filter((f) => f.insert === side && f.lineIndex === index).map((f) => f.after!);
  return box.lines.flatMap((line, index) => {
    const text = changed.has(index) ? changed.get(index)! : line.text;
    return [...added(index, "before"), ...(text === null ? [] : [text]), ...added(index, "after")];
  });
}

/**
 * Throws `verifyFailed` unless every line of every box of `after` reads as
 * `before` with the fixes in: the edited lines as promised, and every other
 * line, in every box, exactly as it was.
 */
export function verifyLines(after: PresentationDoc, before: PresentationDoc, fixes: readonly LineFix[]): void {
  if (after.textBoxes.length !== before.textBoxes.length) throw new FixError("verifyFailed");

  for (const box of before.textBoxes) {
    const mine = fixes.filter((f) => f.boxIndex === box.boxIndex);
    const want = expected(box, mine);
    const got = after.textBoxes[box.boxIndex];

    // Untouched boxes are checked too: an edit must not reach past its own.
    if (got.lines.length !== want.length) throw new FixError("verifyFailed");
    if (got.lines.some((line, i) => line.text !== want[i])) throw new FixError("verifyFailed");
  }
}

/** The fixes chosen for one file, by its path within the folder. */
export interface FileFixPlan {
  path: string;
  fixes: LineFix[];
}

export interface FixOutcome {
  path: string;
  /** How many lines this file's fixes settle. */
  lines: number;
  /** The fixed file, when one could be produced. */
  bytes?: Uint8Array;
  /** Why it was refused or could not be saved, when it was. */
  reason?: FixRefusal | "writeFailed";
}

/** How a run reaches the files, and what it reports back while it works. */
export interface FixRun {
  read: (path: string) => Promise<Uint8Array>;
  /** Absent when the fixed files are not going back into the folder. */
  write?: (path: string, bytes: Uint8Array) => Promise<void>;
  /**
   * Called before each file, so a caller can say where it has got to.
   *
   * Before rather than after, because the interesting question during a long
   * run is which file is being worked on now, not which one has just finished.
   *
   * Awaited, so a caller in a browser can hand the main thread back and let
   * the report it just made actually reach the screen. Deciding what that is
   * worth is the caller's business; this only makes it possible.
   */
  onFile?: (path: string, done: number, total: number) => void | Promise<void>;
}

/**
 * Run a set of fixes over several files.
 *
 * Reading and writing are supplied rather than performed, so the whole run is
 * testable without a folder, and so the same code serves both routes: writing
 * back in Chromium, and building a zip of fixed copies everywhere else.
 *
 * One file's refusal does not stop the others. A library where a single
 * presentation cannot be read is the ordinary case, not the exceptional one,
 * and abandoning the other five hundred would be the wrong answer to it.
 */
export async function fixFiles(
  plans: readonly FileFixPlan[],
  { read, write, onFile }: FixRun
): Promise<FixOutcome[]> {
  const outcomes: FixOutcome[] = [];

  for (const [index, plan] of plans.entries()) {
    const lines = plan.fixes.length;
    let bytes: Uint8Array;

    await onFile?.(plan.path, index, plans.length);

    try {
      bytes = applyFixes(await read(plan.path), plan.fixes);
    } catch (e) {
      outcomes.push({
        path: plan.path,
        lines,
        reason: e instanceof FixError ? e.reason : "unreadable",
      });
      continue;
    }

    if (write) {
      try {
        await write(plan.path, bytes);
      } catch {
        // The bytes were good; the folder would not take them. Permission can
        // lapse mid-run, and a file can be open elsewhere.
        outcomes.push({ path: plan.path, lines, reason: "writeFailed" });
        continue;
      }
    }

    outcomes.push({ path: plan.path, lines, bytes });
  }

  return outcomes;
}

export interface Examined {
  report: PresentationReport;
  /**
   * Just the text boxes carrying findings.
   *
   * Enough to plan any fix, and a fraction of the memory: a real library of
   * 880 presentations holds ten megabytes of RTF, of which the boxes with
   * something wrong in them are two. Keeping those means the reader can switch
   * a check on or off, or press a filter, and see the fixes change instantly
   * rather than waiting for the folder to be read again.
   */
  fixable: PresentationDoc;
  /**
   * What a team's rules found, when `examine` was given them. Worked out here
   * rather than later because `fixable` keeps only the boxes with a text
   * problem, and the rules look at every slide, group and macro.
   */
  findings?: Finding[];
}

/** A file that will not open: reported, with nothing to fix. */
export function unreadable(filename: string, problem: ReadProblem, detail?: string): Examined {
  return {
    report: unreadableReport(filename, problem, detail),
    fixable: { name: filename, slideCount: 0, slides: [], textBoxes: [] },
  };
}

/** Read a file, report on it, and keep what a fix would need. */
export function examine(
  filename: string,
  bytes: Uint8Array,
  rules?: (doc: PresentationDoc) => Finding[]
): Examined {
  const opened = openPresentation(bytes);
  if (opened.problem) return unreadable(filename, opened.problem, opened.detail);

  const { doc } = opened;
  let report: PresentationReport;
  let findings: Finding[] | undefined;
  try {
    report = checkPresentation(filename, doc);
    findings = rules?.(doc);
  } catch (e) {
    // A check tripping over one file's text marks that file, not the scan.
    return unreadable(filename, "unreadable", (e as Error).message);
  }
  const wanted = new Set(report.issues.map((issue) => issue.boxIndex));
  return {
    report,
    fixable: { ...doc, textBoxes: doc.textBoxes.filter((box) => wanted.has(box.boxIndex)) },
    ...(findings ? { findings } : {}),
  };
}
