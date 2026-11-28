import type { ContextSlide } from "@presenter-garage/core/lib/slide-context";
import { macroNames, shownGroupName } from "@presenter-garage/core/lib/slide-context";
import { visibleWhitespace } from "@presenter-garage/core/lib/whitespace";
import type { PlannedFile } from "@presenter-garage/node/edits";
import { needNewPlan, writtenIn, type Review } from "@presenter-garage/node/review";
import { beforeWriting, changeWhere, describeChange, lineWhere } from "./wording";

/**
 * A review as its page draws it: every change in words, each among the
 * slides around it as they read when the plan was made, with the person's
 * choices and what earlier applies did. The page and its read-only snapshot
 * draw the same data.
 *
 * Built here rather than in the page, so the page stays a few lines of DOM
 * and every word it shows comes from the code the confirmation form uses.
 */

/** One change, ready to draw. A line's text has the whitespace that matters made visible. */
export type ViewChange =
  | {
      n: number;
      kind: "line";
      where: string;
      /** Null for an added line. */
      before: string | null;
      /** Null for a line removed. */
      after: string | null;
      insert?: "before" | "after";
      /** The line an added line goes beside, as it reads now. */
      beside?: string;
      styling?: string[];
    }
  | { n: number; kind: "structure"; where: string; said: string };

/** One line of a slide around the changes, or the change that stands in its place or beside it. */
export type ViewEntry = { text: string } | { n: number };

export interface ViewSlide {
  slideIndex: number;
  group: string;
  macros: string[];
  /** Whether a change is on it. */
  holds: boolean;
  entries: ViewEntry[];
}

export interface ViewFile {
  name: string;
  path: string;
  changes: ViewChange[];
  /** Slides that follow one another, each run one stretch of context. */
  runs: ViewSlide[][];
  /** Changes with no slide around them to show them on: shown on their own, never left off. */
  stray: number[];
}

const shown = (text: string) => (text === "" ? "" : visibleWhitespace(text));

function changesOf(file: PlannedFile): ViewChange[] {
  return [
    ...file.lines.map(({ n, fix, styling }): ViewChange => ({
      n,
      kind: "line",
      where: lineWhere(fix),
      before: fix.insert ? null : shown(fix.before),
      after: fix.after === null ? null : shown(fix.after),
      ...(fix.insert && { insert: fix.insert, beside: shown(fix.before) }),
      ...(styling && { styling }),
    })),
    ...file.changes.map(({ n, change }): ViewChange => ({ n, kind: "structure", where: changeWhere(change), said: describeChange(change) })),
  ];
}

/** Slides that follow one another, in runs. */
function runsOf(slides: readonly ContextSlide[]): ContextSlide[][] {
  const out: ContextSlide[][] = [];
  for (const slide of slides) {
    const run = out.at(-1);
    if (run && run.at(-1)!.slideIndex === slide.slideIndex - 1) run.push(slide);
    else out.push([slide]);
  }
  return out;
}

/**
 * Each change on its slide: a changed line in the line's place, an added
 * line on its side of the line it goes beside, a structural change at the
 * top of the slide it is on. Every change comes back once, on a slide or in
 * `stray`, so a change that can be ticked is never left off the page.
 */
function placed(file: PlannedFile): Pick<ViewFile, "runs" | "stray"> {
  const left = new Set([...file.lines, ...file.changes].map(({ n }) => n));
  const take = (n: number) => (left.delete(n) ? [{ n }] : []);
  const runs = runsOf(file.context ?? []).map((run) =>
    run.map((slide): ViewSlide => {
      const here = file.lines.filter(({ fix }) => fix.slideIndex === slide.slideIndex);
      const structural = file.changes.filter(({ change }) =>
        change.kind === "swapMacro" ? change.slideIndex === slide.slideIndex : change.slides[0] === slide.slideIndex
      );
      const entries: ViewEntry[] = structural.flatMap(({ n }) => take(n));
      for (const line of slide.lines) {
        const at = here.filter(({ fix }) => fix.boxIndex === line.boxIndex && fix.lineIndex === line.lineIndex);
        const side = (insert: "before" | "after") => at.filter(({ fix }) => fix.insert === insert).flatMap(({ n }) => take(n));
        const changed = at.find(({ fix }) => !fix.insert);
        entries.push(...side("before"), ...(changed ? take(changed.n) : [{ text: line.text }]), ...side("after"));
      }
      // A change whose line the slide does not list still goes on its slide.
      for (const { n } of here) entries.push(...take(n));
      return {
        slideIndex: slide.slideIndex,
        group: shownGroupName(slide.groupName ?? ""),
        macros: macroNames(slide.macros),
        holds: here.length > 0 || structural.length > 0,
        entries,
      };
    })
  );
  return { runs, stray: [...left] };
}

/** What the page is sent, or the snapshot holds. */
export function reviewData(review: Review) {
  return {
    title: `Review: ${review.plan.files.length === 1 ? review.plan.files[0].name : `${review.plan.files.length} presentations`}`,
    files: review.plan.files.map((file): ViewFile => ({ name: file.name, path: file.path, changes: changesOf(file), ...placed(file) })),
    // Said on the page as in the form: where the client cannot ask, the page is all the person sees before a write.
    warning: Object.values(beforeWriting(review.plan.files)).join("").trim(),
    choices: review.choices.changes,
    written: [...writtenIn(review)],
    needNewPlan: needNewPlan(review),
    runs: review.runs.map((run) => ({
      at: run.at,
      files: run.files.map(({ name, written, reason, detail }) => ({ name, written, reason, detail })),
    })),
  };
}

export type ReviewData = ReturnType<typeof reviewData>;
