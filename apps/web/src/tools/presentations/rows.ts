import { fixKey, planFixes, type Examined, type LineFix } from "@presenter-garage/core/lib/fixes";
import {
  TRAILING_PUNCTUATION,
  type TextIssue,
  type TextIssueKind,
  type TrailingPunctuation,
} from "@presenter-garage/core/lib/presentation";
import { groupBy } from "@presenter-garage/core/lib/collections";
import { placeAmongSlides, type ContextLine, type ContextSlide } from "@presenter-garage/core/lib/slide-context";
import type { CheckName, RuleSet } from "@presenter-garage/core/lib/rules";

/**
 * What the list of findings is made of: which kinds of finding there are,
 * and the rows a file's findings become. Pure, so the component can work
 * them out again on every filter without reading anything.
 */

/**
 * Every kind the checker reports, and the ones shown without being asked for.
 *
 * Trailing punctuation is always detected -- it costs one test per line -- but
 * stays out of the way until it is switched on. Detecting it regardless is
 * what makes the switch instant: it filters what is already in hand rather
 * than sending the whole library back through the reader.
 *
 * One switch each rather than one for all three. They are not one decision: a
 * library of 24,181 lines ends nearly a thousand of them with a full stop and
 * 43 with a semicolon, and a house that strips commas may well keep the full
 * stop that closes a verse.
 */
export const OPTIONAL_KINDS = Object.keys(TRAILING_PUNCTUATION) as readonly TrailingPunctuation[];
export const ALL_KINDS: TextIssueKind[] = [
  "leadingSpace",
  "trailingSpace",
  "blankLine",
  "repeatedSpace",
  ...OPTIONAL_KINDS,
];
/** The same set, for asking whether a kind is one of them. */
export const OPTIONAL = new Set<TextIssueKind>(OPTIONAL_KINDS);

/** The rule that stands for each optional check, for starting the switches from a team's rules. */
const RULE_OF: Record<TrailingPunctuation, CheckName> = {
  trailingComma: "trailing-comma",
  trailingSemicolon: "trailing-semicolon",
  trailingFullStop: "trailing-full-stop",
};

/** The switches a set of rules asks for: a check is on when a rule runs it, and off when none does or it is `off`. */
export const optionalFrom = (set: RuleSet) =>
  new Set<TextIssueKind>(
    OPTIONAL_KINDS.filter((kind) => set.rules.some((r) => r.check === RULE_OF[kind] && r.tier !== "off"))
  );

/** One line of one file, as the list shows it and the fix run names it. */
export interface Row {
  key: string;
  slideIndex: number;
  boxIndex: number;
  lineIndex: number;
  groupName?: string;
  text: string;
  kinds: TextIssueKind[];
  fix?: LineFix;
}

/** Address a line uniquely across the whole library. */
const rowKey = (filename: string, line: { boxIndex: number; lineIndex: number }) =>
  `${filename} ${fixKey(line)}`;

/**
 * Gather the findings on one line into a single row.
 *
 * One line can be guilty of three things at once, and listing it three times
 * asks the reader to approve three edits to the same characters. One row, one
 * before, one after, one decision.
 */
function rowsOf(filename: string, issues: TextIssue[], fixes: LineFix[]): Row[] {
  const fixFor = new Map(fixes.map((fix) => [fixKey(fix), fix]));

  return [...groupBy(issues, fixKey)].map(([line, [first, ...rest]]) => ({
    key: rowKey(filename, first),
    slideIndex: first.slideIndex,
    boxIndex: first.boxIndex,
    lineIndex: first.lineIndex,
    groupName: first.groupName,
    text: first.text,
    kinds: [first.kind, ...rest.map((issue) => issue.kind)],
    fix: fixFor.get(line),
  }));
}

/** A file's rows for the kinds on screen. */
export function rowsFor({ report, fixable }: Examined, shown: ReadonlySet<TextIssueKind>): Row[] {
  const issues = report.issues.filter((i) => shown.has(i.kind));
  return issues.length === 0 ? [] : rowsOf(report.filename, issues, planFixes(fixable, issues));
}

/** The file a row's key belongs to: everything before its line's address. */
export const fileOfKey = (key: string) => key.slice(0, key.lastIndexOf(" "));

/**
 * A fixable line by its box and what it says rather than where it is: a line
 * a save removed above it moves it up, and its address with it. Not by what
 * it becomes, which depends on the kinds on screen.
 */
export const lineOf = (row: Row) => JSON.stringify([row.fix!.boxIndex, row.text]);

/** Every kind, for what has to hold whichever are on screen. */
export const EVERY_KIND: ReadonlySet<TextIssueKind> = new Set(ALL_KINDS);

/** One slide of a run shown around rows: its lines in order, each a row where one is on it, or a line only to read. */
export interface ReviewSlide extends Omit<ContextSlide, "lines"> {
  items: ({ row: Row } | { line: ContextLine })[];
  /** Whether a row is on it, which sets it apart from the slides only there to read. */
  holdsRow: boolean;
}

/**
 * A file's rows among the slides around them: each run of slides that
 * overlap or meet, each slide's lines in order with a row standing in for
 * the line it is about. Every row comes back exactly once, in a run or, for
 * a row whose slide is not in `context`, in `stray`, so a line that can be
 * ticked is never left off the screen; a line only to read is never a row.
 */
export function reviewRuns(
  rows: readonly Row[],
  context: readonly ContextSlide[],
  slideCount: number
): { runs: ReviewSlide[][]; stray: Row[] } {
  const { runs, stray } = placeAmongSlides(rows, context, slideCount);
  return {
    runs: runs.map((run) =>
      run.map(({ items, holds, ...slide }) => ({ ...slide, items: items.map((entry) => ("item" in entry ? { row: entry.item } : entry)), holdsRow: holds }))
    ),
    stray,
  };
}
