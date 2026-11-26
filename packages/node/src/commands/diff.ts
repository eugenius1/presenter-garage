import type { Group } from "./song";

/**
 * Two versions of a song laid side by side for the report: groups aligned by
 * name, and within each pair of groups every word marked that the other side
 * does not have. Worked out here rather than in the page, so the page only
 * draws and the alignment is tested with everything else.
 */

/**
 * Text as it is drawn: a plain string, or one in a one-element array where it
 * differs from the other side. `["\n"]` ends a line the other side does not
 * break there; no line holds a line break of its own, so it cannot be text.
 */
export type Run = string | [string];

export const BREAK = "\n";

export interface SlideView {
  macros: Run[];
  lines: Run[][];
  /** Set where this slide ends and the other side's carries on: the words are split across slides differently. */
  split?: true;
}

export interface GroupView {
  name: Run;
  slides: SlideView[];
}

/** One row of the side-by-side view; a side is absent where it has no group to set against the other's. */
export interface Row {
  a?: GroupView;
  b?: GroupView;
}

/** A group name as alignment matches it: a non-breaking space is still a space, and case is not a different group. */
const groupKey = (name: string) => name.replace(/[\s   ]+/g, " ").trim().toLowerCase();

/**
 * Pair the two songs' groups. Groups with the same name are lined up in
 * order (the longest such run); the groups left between two of them are set
 * against each other in order, since a group renamed in place is still the
 * group beside it, and what is left over stands alone.
 */
export function alignGroups(a: readonly Group[], b: readonly Group[]): [Group | undefined, Group | undefined][] {
  const anchors = lcs(a.map((g) => groupKey(g.name)), b.map((g) => groupKey(g.name)));
  const rows: [Group | undefined, Group | undefined][] = [];
  let i = 0;
  let j = 0;
  for (const [ai, bj] of [...anchors, [a.length, b.length] as [number, number]]) {
    while (i < ai || j < bj) rows.push([i < ai ? a[i++] : undefined, j < bj ? b[j++] : undefined]);
    if (ai < a.length) rows.push([a[i++], b[j++]]);
  }
  return rows;
}

export function sideBySide(a: readonly Group[], b: readonly Group[]): Row[] {
  return alignGroups(a, b).map(([ga, gb]) => {
    // A group the other side has nothing beside: all of it differs.
    if (!ga) return { b: drawn(gb!, true) };
    if (!gb) return { a: drawn(ga, true) };
    const [fa, fb] = diffTokens(tokens(ga), tokens(gb));
    return { a: view(ga, gb, fa), b: view(gb, ga, fb) };
  });
}

/** A group drawn on its own, every piece of it marked or none. */
function drawn(group: Group, marked: boolean): GroupView {
  const mark = (s: string): Run => (marked ? [s] : s);
  return {
    name: mark(group.name),
    slides: group.slides.map((s) => ({ macros: s.macros.map(mark), lines: s.lines.map((l) => (l ? [mark(l)] : [])) })),
  };
}

const LINE_END = BREAK;
const SLIDE_END = "\f";

/** Words and the spaces between them, each a token, with line and slide ends as tokens of their own. */
function tokens(group: Group): string[] {
  const out: string[] = [];
  for (const slide of group.slides) {
    for (const line of slide.lines) {
      out.push(...line.split(/(\s+)/).filter(Boolean), LINE_END);
    }
    out.push(SLIDE_END);
  }
  return out;
}

/** Rebuild a group from its tokens and their marks, joining neighbouring tokens that are marked alike. */
function view(group: Group, other: Group, marks: boolean[]): GroupView {
  const list = tokens(group);
  const slides: SlideView[] = [];
  let k = 0;
  group.slides.forEach((slide, si) => {
    const theirs = new Set(other.slides[si]?.macros ?? []);
    const lines: Run[][] = [];
    for (let li = 0; li < slide.lines.length; li++) {
      const runs: Run[] = [];
      for (; k < marks.length; k++) {
        const token = list[k];
        if (token === LINE_END) break;
        const last = runs.at(-1);
        if (marks[k] && Array.isArray(last)) last[0] += token;
        else if (!marks[k] && typeof last === "string") runs[runs.length - 1] = last + token;
        else runs.push(marks[k] ? [token] : token);
      }
      if (marks[k]) runs.push([BREAK]);
      k++; // the line's end
      lines.push(runs);
    }
    const split = marks[k];
    k++; // the slide's end
    slides.push({ macros: slide.macros.map((m) => (theirs.has(m) ? m : [m])), lines, ...(split ? { split } : {}) });
  });
  return { name: group.name === other.name ? group.name : [group.name], slides };
}

/** Spaces between words; never a line or slide end, which are tokens of their own. */
const isSpace = (token: string) => token !== LINE_END && token !== SLIDE_END && /^\s+$/.test(token);

/**
 * Which tokens of each side differ from the other's.
 *
 * Words (and line and slide ends) are matched as the longest sequence the
 * two share. Spaces are not matched on their own: a space is as common as
 * any token, and matching them freely sets a space in a rewritten line
 * against one in the other version's, which splits a changed line into
 * marked words with unmarked gaps between. Instead the spaces between two
 * words that both sides share, next to each other, are compared as they
 * are, so a non-breaking or doubled space is marked; any other run of
 * spaces is marked only where the words on both sides of it are.
 *
 * Past a size no song reaches, every token is marked rather than spend
 * seconds and hundreds of megabytes on one pair.
 */
export function diffTokens(a: readonly string[], b: readonly string[]): [boolean[], boolean[]] {
  const ma = a.map(() => true);
  const mb = b.map(() => true);
  if (a.length * b.length > 25_000_000) return [ma, mb];
  const wordsA = a.flatMap((t, i) => (isSpace(t) ? [] : [i]));
  const wordsB = b.flatMap((t, j) => (isSpace(t) ? [] : [j]));
  const partnerA = new Map<number, number>();
  const partnerB = new Map<number, number>();
  for (const [x, y] of lcs(wordsA.map((i) => a[i]), wordsB.map((j) => b[j]))) {
    partnerA.set(wordsA[x], wordsB[y]);
    partnerB.set(wordsB[y], wordsA[x]);
    ma[wordsA[x]] = false;
    mb[wordsB[y]] = false;
  }
  markSpaces(a, b, ma, partnerA);
  markSpaces(b, a, mb, partnerB);
  return [ma, mb];
}

/** Decide each run of spaces on one side, as `diffTokens` describes. */
function markSpaces(mine: readonly string[], theirs: readonly string[], marks: boolean[], partner: Map<number, number>): void {
  // The edges of the group stand for matched words, so a group that opens with a space compares it.
  const partnerOf = (k: number) => (k < 0 ? -1 : k >= mine.length ? theirs.length : partner.get(k));
  const between = (tokens: readonly string[], from: number, to: number) => tokens.slice(from + 1, to).join("");
  for (let k = 0; k < mine.length; k++) {
    if (!isSpace(mine[k])) continue;
    let prev = k - 1;
    while (prev >= 0 && isSpace(mine[prev])) prev--;
    let next = k + 1;
    while (next < mine.length && isSpace(mine[next])) next++;
    const [p, n] = [partnerOf(prev), partnerOf(next)];
    const adjacent = p !== undefined && n !== undefined && theirs.slice(p + 1, n).every(isSpace);
    marks[k] = adjacent
      ? between(mine, prev, next) !== between(theirs, p, n)
      : (prev < 0 || marks[prev]) && (next >= mine.length || marks[next]);
  }
}

/** The index pairs of a longest common subsequence, in order. */
function lcs<T>(a: readonly T[], b: readonly T[]): [number, number][] {
  // Common ends first: most pairs differ in a few words, and this keeps the table small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  const table = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[at(i, j)] =
        a[start + i] === b[start + j] ? table[at(i + 1, j + 1)] + 1 : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }
  const pairs: [number, number][] = [];
  for (let k = 0; k < start; k++) pairs.push([k, k]);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[start + i] === b[start + j]) {
      pairs.push([start + i, start + j]);
      i++;
      j++;
    } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) i++;
    else j++;
  }
  for (let k = 0; k < a.length - endA; k++) pairs.push([endA + k, endB + k]);
  return pairs;
}

/** A song with nothing to set it against, drawn as it is. */
export function onItsOwn(groups: readonly Group[], side: "a" | "b"): Row[] {
  return groups.map((group) => ({ [side]: drawn(group, false) }));
}
