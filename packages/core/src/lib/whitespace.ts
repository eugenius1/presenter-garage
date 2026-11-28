import { SPACE_CLASS } from "./presentation";

/**
 * Show whitespace that is the finding as middle dots, so it can be seen.
 *
 * The edges of a line and any run of two or more inside it -- the three things
 * the checks report. Tabs and non-breaking spaces count: they are exactly as
 * invisible as a plain space and rather more surprising to find.
 */
// Built from the checker's own class, so whatever it reports is what shows.
const GAP = new RegExp(SPACE_CLASS, "g");
const EDGES = new RegExp(`^${SPACE_CLASS}+|${SPACE_CLASS}+$`, "g");
const INSIDE = new RegExp(`${SPACE_CLASS}{2,}`, "g");

export function visibleWhitespace(text: string): string {
  const dots = (run: string) => "\u00b7".repeat(run.length);
  return text.replace(EDGES, dots).replace(INSIDE, dots).replace(GAP, (c) => (c === " " ? c : dots(c)));
}
