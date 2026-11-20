import { nameKey, type Edited, type Group, type Song } from "./song";

/**
 * Two libraries, song by song: which songs are the same song, how far apart
 * each pair is, and which version to keep, with the reason.
 */

/**
 * How a pair differs, least first. A pair is put in the first bucket that
 * holds it, so `spacing` means nothing but spacing changed.
 *
 * - `spacing`: the words are the same once spaces of every kind are folded,
 *   blank lines are dropped and `.,;:` at the end of a line is ignored; the
 *   group names are exactly the same.
 * - `groups`: the words are the same in that sense, and only group names
 *   differ, a non-breaking space where the other has a space included. That
 *   is a different group to ProPresenter, which matches names exactly.
 * - `renamed`: the same song (by uuid) under another name, however the words
 *   compare; `content` says how.
 */
export type Content = "identical" | "spacing" | "groups" | "different";
export type Bucket = Content | "renamed" | "onlyA" | "onlyB";
export const BUCKETS: readonly Bucket[] = ["identical", "spacing", "groups", "different", "renamed", "onlyA", "onlyB"];

export type Later = "a" | "b" | "same" | "unknown";

export interface Proposal {
  pick: "a" | "b";
  reason: string;
}

export interface Pair {
  /** Stable across runs of the same two libraries: what a decision is filed under. */
  id: string;
  bucket: Bucket;
  matchedBy?: "id" | "name";
  content?: Content;
  a?: Song;
  b?: Song;
  later?: Later;
  /** Absent for an identical pair, where there is nothing to choose. */
  proposed?: Proposal;
}

export interface CompareOptions {
  labels: { a: string; b: string };
  /** The label whose version wins when nothing else tells two apart: the main library. */
  prefer?: string;
}

export function compareSongs(as: readonly Song[], bs: readonly Song[], options: CompareOptions): Pair[] {
  const pairs: Pair[] = [];
  const usedB = new Set<Song>();
  const unmatched: Song[] = [];

  // By uuid first. A library can hold two copies of one song, copied in
  // ProPresenter and so sharing a uuid; among several, the one with the same
  // name is the match, and with no such one the uuid alone decides nothing.
  const byIdB = groupBy(bs, (s) => s.id);
  const idCountA = countBy(as, (s) => s.id);
  for (const a of as) {
    const candidates = (a.id ? byIdB.get(a.id) : undefined)?.filter((b) => !usedB.has(b)) ?? [];
    const b =
      candidates.find((c) => nameKey(c.name) === nameKey(a.name)) ??
      (candidates.length === 1 && idCountA.get(a.id) === 1 ? candidates[0] : undefined);
    if (b) {
      usedB.add(b);
      pairs.push(pairOf(a, b, "id", options));
    } else {
      unmatched.push(a);
    }
  }

  // Then by name, the same folder first where a name is in several.
  const byNameB = groupBy(
    bs.filter((b) => !usedB.has(b)),
    (s) => nameKey(s.name)
  );
  for (const a of unmatched) {
    const candidates = byNameB.get(nameKey(a.name))?.filter((b) => !usedB.has(b)) ?? [];
    const b = candidates.find((c) => folderKey(c) === folderKey(a)) ?? candidates[0];
    if (b) {
      usedB.add(b);
      pairs.push(pairOf(a, b, "name", options));
    } else {
      pairs.push({ id: `a:${a.file}`, bucket: "onlyA", a, proposed: { pick: "a", reason: `only in ${options.labels.a}` } });
    }
  }
  for (const b of bs) {
    if (!usedB.has(b)) {
      pairs.push({ id: `b:${b.file}`, bucket: "onlyB", b, proposed: { pick: "b", reason: `only in ${options.labels.b}` } });
    }
  }

  return pairs.sort((x, y) => (x.a ?? x.b)!.name.localeCompare((y.a ?? y.b)!.name, "fr"));
}

function pairOf(a: Song, b: Song, matchedBy: "id" | "name", options: CompareOptions): Pair {
  const content = contentOf(a.groups, b.groups);
  const renamed = nameKey(a.name) !== nameKey(b.name);
  const later = laterOf(a.edited, b.edited);
  return {
    id: `a:${a.file}|b:${b.file}`,
    bucket: renamed ? "renamed" : content,
    matchedBy,
    content,
    a,
    b,
    later,
    proposed: content === "identical" ? undefined : propose(a, b, later, options),
  };
}

const SPACES = /[\s   ]+/g;

/** A line as `spacing` compares it: spaces folded and end punctuation dropped. */
export function looseLine(line: string): string {
  return line
    .replace(SPACES, " ")
    .trim()
    .replace(/[\s.,;:]+$/, "");
}

export function contentOf(a: readonly Group[], b: readonly Group[]): Content {
  const words = (groups: readonly Group[]) =>
    JSON.stringify(groups.map((g) => g.slides.map((s) => [s.macros, s.lines.map(looseLine).filter(Boolean)])));
  const names = (groups: readonly Group[]) => JSON.stringify(groups.map((g) => g.name));
  if (JSON.stringify(a) === JSON.stringify(b)) return "identical";
  if (words(a) !== words(b)) return "different";
  return names(a) === names(b) ? "spacing" : "groups";
}

/**
 * Which side was edited later. A ProPresenter 22 document no one has edited
 * since the upgrade has no date, but cannot be later than the upgrade, which
 * is enough against a `.pro` file edited after it.
 */
export function laterOf(a: Edited, b: Edited): Later {
  if (a.at && b.at) return a.at > b.at ? "a" : a.at < b.at ? "b" : "same";
  if (a.at && b.notAfter && a.at > b.notAfter) return "a";
  if (b.at && a.notAfter && b.at > a.notAfter) return "b";
  return "unknown";
}

/**
 * The version to keep, in the order the plan settles a conflict: fewer rule
 * breaks (the text checks), then the later edit where both dates are known,
 * then the main library. Spelling is not judged here: that is for a person
 * reading the two.
 */
function propose(a: Song, b: Song, later: Later, { labels, prefer }: CompareOptions): Proposal {
  if (a.ruleBreaks !== b.ruleBreaks) {
    const pick = a.ruleBreaks < b.ruleBreaks ? "a" : "b";
    return {
      pick,
      reason: `fewer rule breaks: ${labels[pick]} has ${pick === "a" ? a.ruleBreaks : b.ruleBreaks}, ${labels[pick === "a" ? "b" : "a"]} ${pick === "a" ? b.ruleBreaks : a.ruleBreaks}`,
    };
  }
  if (later === "a" || later === "b") {
    const date = (e: Edited) => (e.at ?? `before ${e.notAfter}`).slice(0, 10);
    return {
      pick: later,
      reason: `${labels[later]} edited later (${date(later === "a" ? a.edited : b.edited)} against ${date(later === "a" ? b.edited : a.edited)})`,
    };
  }
  const why = later === "same" ? "edited at the same time" : "no edit dates to tell them apart";
  if (prefer && (prefer === labels.a || prefer === labels.b)) {
    const pick = prefer === labels.a ? "a" : "b";
    return { pick, reason: `${why}; ${prefer} is the main library` };
  }
  return { pick: "a", reason: `${why}; ${labels.a} named first` };
}

export interface Summary {
  a: { label: string; songs: number; failures: number };
  b: { label: string; songs: number; failures: number };
  matched: number;
  byId: number;
  byName: number;
  buckets: Record<Bucket, number>;
  /** Over the pairs that differ (not identical, matched): who edited later. */
  later: Record<Later, number>;
}

export function summarise(pairs: readonly Pair[], a: { label: string; songs: number; failures: number }, b: typeof a): Summary {
  const buckets = Object.fromEntries(BUCKETS.map((k) => [k, 0])) as Record<Bucket, number>;
  const later: Record<Later, number> = { a: 0, b: 0, same: 0, unknown: 0 };
  let byId = 0;
  let byName = 0;
  for (const pair of pairs) {
    buckets[pair.bucket]++;
    if (pair.matchedBy === "id") byId++;
    if (pair.matchedBy === "name") byName++;
    if (pair.later && pair.content !== "identical") later[pair.later]++;
  }
  return { a, b, matched: byId + byName, byId, byName, buckets, later };
}

/** The summary as a person reads it at a terminal. No lyrics, only counts. */
export function summaryText(s: Summary): string {
  const pad = (n: number) => String(n).padStart(5);
  const { a, b } = s;
  const laterText = `${a.label} edited later: ${s.later.a}, ${b.label}: ${s.later.b}, same: ${s.later.same}, no dates: ${s.later.unknown}`;
  return [
    `${a.label}: ${a.songs} songs${a.failures ? `, ${a.failures} unreadable` : ""} · ${b.label}: ${b.songs} songs${b.failures ? `, ${b.failures} unreadable` : ""}`,
    `Matched ${s.matched} songs (by ID ${s.byId}, by name ${s.byName})`,
    `${pad(s.buckets.identical)} identical`,
    `${pad(s.buckets.spacing)} spacing or end punctuation only`,
    `${pad(s.buckets.groups)} group names only`,
    `${pad(s.buckets.different)} real differences`,
    `${pad(s.buckets.renamed)} renamed`,
    `      (of the ones that differ, ${laterText})`,
    `Only in ${a.label}: ${s.buckets.onlyA} · only in ${b.label}: ${s.buckets.onlyB}`,
  ].join("\n");
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K | undefined): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === undefined) continue;
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

function countBy<T, K>(items: readonly T[], key: (item: T) => K | undefined): Map<K | undefined, number> {
  const map = new Map<K | undefined, number>();
  for (const item of items) map.set(key(item), (map.get(key(item)) ?? 0) + 1);
  return map;
}

const folderKey = (song: Song) => nameKey(song.file.split("/").slice(0, -1).join("/"));
