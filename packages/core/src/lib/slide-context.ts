import { shownBounds, type PresentationDoc, type SlideMacro } from "./presentation";

/**
 * The slides around a proposed change, for whoever is asked to approve it.
 *
 * Whether a line is right is often plain only from what is around it: a
 * comma that carries a line on into the next slide, a repeat already sung
 * out, a line the next slide says again. So every surface where a person
 * ticks a change shows it among its neighbours, with each slide's group and
 * macros. The neighbours are display only: nothing here is a change, can be
 * ticked, or reaches a write.
 */

/** Slides shown either side of a change; fewer at the start or end of a presentation. */
export const CONTEXT_SLIDES = 2;

/** A group name as it is drawn in plain text: a non-breaking space shown, since ProPresenter tells it from a space. */
export const shownGroupName = (name: string) => name.replace(/\u00a0/g, "⍽");

/** One line a slide shows, by the address a change to it would name. */
export interface ContextLine {
  boxIndex: number;
  lineIndex: number;
  text: string;
}

export interface ContextSlide {
  slideIndex: number;
  /** Exactly as the file names it, a non-breaking space included. */
  groupName?: string;
  macros: SlideMacro[];
  /**
   * Every line the slide shows, box by box: the padding above and below each
   * box left out, as ProPresenter shows nothing there, but any line a change
   * names kept, so the change always has a place among them.
   */
  lines: ContextLine[];
}

/** A run of slides shown together, `from` to `to` inclusive. */
export interface ContextWindow {
  from: number;
  to: number;
}

/**
 * The runs of slides to show around changes on `slides`, each change's
 * neighbours `radius` either side. Runs that overlap or meet are one, so
 * changes close together share their context and no slide is shown twice.
 */
export function contextWindows(slides: Iterable<number>, slideCount: number, radius = CONTEXT_SLIDES): ContextWindow[] {
  const sorted = [...new Set(slides)].filter((i) => i >= 0 && i < slideCount).sort((a, b) => a - b);
  const windows: ContextWindow[] = [];
  for (const i of sorted) {
    const from = Math.max(0, i - radius);
    const to = Math.min(slideCount - 1, i + radius);
    const last = windows.at(-1);
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else windows.push({ from, to });
  }
  return windows;
}

/** Where a change sits, as fixes, findings and planned lines all name it. */
export interface ChangeSite {
  slideIndex: number;
  boxIndex: number;
  lineIndex: number;
}

/**
 * The slides around `changes`, each with the lines it shows, in
 * ProPresenter's order. `doc` must hold every text box, not only those with
 * a change, or the neighbours would come back empty.
 */
export function contextSlides(doc: PresentationDoc, changes: readonly ChangeSite[], radius = CONTEXT_SLIDES): ContextSlide[] {
  const named = new Set(changes.map(({ boxIndex, lineIndex }) => `${boxIndex}:${lineIndex}`));
  const windows = contextWindows(
    changes.map((c) => c.slideIndex),
    doc.slides.length,
    radius
  );
  const wanted = (slideIndex: number) => windows.some((w) => slideIndex >= w.from && slideIndex <= w.to);

  const linesOf = new Map<number, ContextLine[]>();
  for (const box of doc.textBoxes) {
    if (!wanted(box.slideIndex)) continue;
    const [first, last] = shownBounds(box.lines.map((line) => line.text));
    const lines = linesOf.get(box.slideIndex) ?? [];
    box.lines.forEach((line, lineIndex) => {
      const shown = first !== -1 && lineIndex >= first && lineIndex <= last;
      if (shown || named.has(`${box.boxIndex}:${lineIndex}`)) lines.push({ boxIndex: box.boxIndex, lineIndex, text: line.text });
    });
    linesOf.set(box.slideIndex, lines);
  }

  return doc.slides
    .filter((slide) => wanted(slide.slideIndex))
    .map((slide) => ({
      slideIndex: slide.slideIndex,
      ...(slide.groupName !== undefined && { groupName: slide.groupName }),
      macros: slide.macros,
      lines: linesOf.get(slide.slideIndex) ?? [],
    }));
}
