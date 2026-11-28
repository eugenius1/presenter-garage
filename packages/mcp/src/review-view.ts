import { macroNames, placeAmongSlides, shownGroupName } from "@presenter-garage/core/lib/slide-context";
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

/** A presentation by name only: the snapshot is for sending to someone, and its path would say where the library is, and whose. */
export interface ViewFile {
  name: string;
  changes: ViewChange[];
  /** Slides that follow one another, each run one stretch of context. */
  runs: ViewSlide[][];
  /** Changes with no slide around them to show them on: shown on their own, never left off. */
  stray: number[];
}


function changesOf(file: PlannedFile): ViewChange[] {
  return [
    ...file.lines.map(({ n, fix, styling }): ViewChange => ({
      n,
      kind: "line",
      where: lineWhere(fix),
      before: fix.insert ? null : visibleWhitespace(fix.before),
      after: fix.after === null ? null : visibleWhitespace(fix.after),
      ...(fix.insert && { insert: fix.insert, beside: visibleWhitespace(fix.before) }),
      ...(styling && { styling }),
    })),
    ...file.changes.map(({ n, change }): ViewChange => ({ n, kind: "structure", where: changeWhere(change), said: describeChange(change) })),
  ];
}

/**
 * Each change among the slides around it, by core's rules, as the web app
 * places a finding: a changed line in the line's place, an added line on its
 * side of the line it goes beside, a structural change at the top of the
 * slide it is on, a group renamed marking every slide it holds.
 */
function placed(file: PlannedFile): Pick<ViewFile, "runs" | "stray"> {
  const items = [
    ...file.lines.map(({ n, fix }) => ({ n, slideIndex: fix.slideIndex, boxIndex: fix.boxIndex, lineIndex: fix.lineIndex, insert: fix.insert })),
    ...file.changes.map(({ n, change }) => {
      const slides = change.kind === "renameGroup" ? change.slides : [change.slideIndex];
      return { n, slideIndex: slides[0] ?? -1, slides };
    }),
  ];
  const holding = (item: (typeof items)[number]) => ("slides" in item ? item.slides : [item.slideIndex]);
  // The plan does not keep the slide count; the context it does keep was cut by the same windows.
  const { runs, stray } = placeAmongSlides(items, file.context ?? [], Number.MAX_SAFE_INTEGER, holding);
  return {
    runs: runs.map((run) =>
      run.map((slide): ViewSlide => ({
        slideIndex: slide.slideIndex,
        group: shownGroupName(slide.groupName ?? ""),
        macros: macroNames(slide.macros),
        holds: slide.holds,
        entries: slide.items.map((entry) => ("item" in entry ? { n: entry.item.n } : { text: entry.line.text })),
      }))
    ),
    stray: stray.map(({ n }) => n),
  };
}

/** What the page is sent, or the snapshot holds. */
export function reviewData(review: Review) {
  return {
    title: `Review: ${review.plan.files.length === 1 ? review.plan.files[0].name : `${review.plan.files.length} presentations`}`,
    files: review.plan.files.map((file): ViewFile => ({ name: file.name, changes: changesOf(file), ...placed(file) })),
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
