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

/** A slide's macros by name, as plain text shows them: one switched off on the slide marked `(off)`. */
export const macroNames = (macros: readonly SlideMacro[]) => macros.map((m) => (m.enabled ? m.name : `${m.name} (off)`));

/**
 * A slide's heading in plain text, as the command line and the MCP server's
 * confirmation both draw it: `>` where it holds what is shown around it,
 * then its number, group and macros.
 */
export const slideHeading = (slideIndex: number, groupName: string, macros: readonly string[], marked: boolean) =>
  `${marked ? ">" : " "} ${slideIndex + 1} [${shownGroupName(groupName)}]${macros.length ? ` (${macros.join(", ")})` : ""}`;

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

/** Where a change sits, as fixes, findings and planned lines all name it; a structural change names only its slide. */
export interface ChangeSite {
  slideIndex: number;
  boxIndex?: number;
  lineIndex?: number;
}

/**
 * The slides around `changes`, each with the lines it shows, in
 * ProPresenter's order. `doc` must hold every text box, not only those with
 * a change, or the neighbours would come back empty.
 */
export function contextSlides(doc: PresentationDoc, changes: readonly ChangeSite[], radius = CONTEXT_SLIDES): ContextSlide[] {
  const named = new Set(changes.filter((c) => c.boxIndex !== undefined).map(({ boxIndex, lineIndex }) => `${boxIndex}:${lineIndex}`));
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

/**
 * Something drawn among the slides around it: a changed line in its line's
 * place, an added line on its `insert` side of the line it goes beside, and
 * one that names no line -- a group renamed, a macro swapped -- at the top
 * of its slide.
 */
export interface Placeable {
  slideIndex: number;
  boxIndex?: number;
  lineIndex?: number;
  insert?: "before" | "after";
}

/** One slide of a run shown around placed things: its lines in order, with each thing in its place. */
export interface PlacedSlide<T> extends Omit<ContextSlide, "lines"> {
  items: ({ item: T } | { line: ContextLine })[];
  /** Whether something placed is on it, which sets it apart from the slides only there to read. */
  holds: boolean;
}

/**
 * `items` among the slides around them: each run of slides that overlap or
 * meet, each slide's lines in order with each item in its place. Every item
 * comes back exactly once, in a run or, for one whose slide is not in
 * `context`, in `stray`, so a thing that can be ticked is never left off the
 * screen; a line only to read is never an item. Several added on one side of
 * a line keep the order they are given in, which is the order they are
 * written. `holding` names every slide an item is on -- a group renamed is on
 * all of its slides -- for the runs and for `holds`; it is placed on the first.
 */
export function placeAmongSlides<T extends Placeable>(
  items: readonly T[],
  context: readonly ContextSlide[],
  slideCount: number,
  holding: (item: T) => readonly number[] = (item) => [item.slideIndex]
): { runs: PlacedSlide<T>[][]; stray: T[] } {
  const slides = new Map(context.map((slide) => [slide.slideIndex, slide]));
  const placed = new Set<T>();
  const take = (item: T | undefined): { item: T }[] => {
    if (!item || placed.has(item)) return [];
    placed.add(item);
    return [{ item }];
  };
  const runs = contextWindows(items.flatMap(holding), slideCount).map(({ from, to }) => {
    const run: PlacedSlide<T>[] = [];
    for (let i = from; i <= to; i++) {
      const slide = slides.get(i);
      if (!slide) continue;
      const here = items.filter((item) => item.slideIndex === i);
      const at = (line: ContextLine) => here.filter((item) => item.boxIndex === line.boxIndex && item.lineIndex === line.lineIndex);
      const placedHere: PlacedSlide<T>["items"] = here.filter((item) => item.boxIndex === undefined).flatMap(take);
      for (const line of slide.lines) {
        const side = (insert: "before" | "after") => at(line).filter((item) => item.insert === insert).flatMap(take);
        const instead = take(at(line).find((item) => !item.insert && !placed.has(item)));
        placedHere.push(...side("before"), ...(instead.length ? instead : [{ line }]), ...side("after"));
      }
      // One whose line the slide does not list still goes on its slide.
      for (const item of here) placedHere.push(...take(item));
      const holds = items.some((item) => holding(item).includes(i));
      run.push({ slideIndex: i, groupName: slide.groupName, macros: slide.macros, items: placedHere, holds });
    }
    return run;
  });
  return { runs: runs.filter((run) => run.length > 0), stray: items.filter((item) => !placed.has(item)) };
}
