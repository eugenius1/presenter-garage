import { alignGroups } from "./diff";
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

/**
 * One place the two versions differ: a pair of groups as the side-by-side
 * view lines them up, `row` being its place there. The rule breaks counted
 * are those in that group on each side, tier 1 then tier 2; tier 3 is the
 * last cleanup and is left out, or it would decide everything.
 */
export interface Difference extends Proposal {
  row: number;
  group: string;
  breaks: { a: [number, number]; b: [number, number] };
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
  /** For a pair whose words differ: each place they differ, with the version proposed there. */
  differences?: Difference[];
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

  // Then by name: every match in the same folder first, so a song matched
  // across folders never takes the one another song has in its own folder.
  const byNameB = groupBy(
    bs.filter((b) => !usedB.has(b)),
    (s) => nameKey(s.name)
  );
  const free = (a: Song) => byNameB.get(nameKey(a.name))?.filter((b) => !usedB.has(b)) ?? [];
  const matched = new Map<Song, Song>();
  for (const pass of [(a: Song, b: Song) => folderKey(b) === folderKey(a), () => true]) {
    for (const a of unmatched) {
      if (matched.has(a)) continue;
      const b = free(a).find((c) => pass(a, c));
      if (b) {
        usedB.add(b);
        matched.set(a, b);
      }
    }
  }
  for (const a of unmatched) {
    const b = matched.get(a);
    if (b) pairs.push(pairOf(a, b, "name", options));
    else pairs.push({ id: `a:${a.file}`, bucket: "onlyA", a, proposed: { pick: "a", reason: `only in ${options.labels.a}` } });
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
  const differences = content === "identical" ? undefined : differencesOf(a, b, later, options);
  return {
    id: `a:${a.file}|b:${b.file}`,
    bucket: renamed ? "renamed" : content,
    matchedBy,
    content,
    a,
    b,
    later,
    proposed: differences && propose(differences, options),
    differences,
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

/** Which side is the base, the library the merge is made into: the main one, or the first named. */
function baseOf({ labels, prefer }: CompareOptions): "a" | "b" {
  return prefer === labels.b ? "b" : "a";
}

/**
 * Each place the versions differ, and which to take there, in the order the
 * plan settles a conflict: fewer rule breaks in that group, tier 1 first,
 * then the later edit where both dates are known, then the base. Spelling is
 * not judged here: that is for a person reading the two.
 */
function differencesOf(a: Song, b: Song, later: Later, options: CompareOptions): Difference[] {
  const { labels } = options;
  const base = baseOf(options);
  const breaksIn = (song: Song, group: Group | undefined): [number, number] => {
    const index = group ? song.groups.indexOf(group) : -1;
    const counts: [number, number] = [0, 0];
    for (const f of song.findings) if (f.group === index && f.excepted === undefined && f.tier < 3) counts[f.tier - 1]++;
    return counts;
  };
  const differences: Difference[] = [];
  alignGroups(a.groups, b.groups).forEach(([ga, gb], row) => {
    if (JSON.stringify(ga) === JSON.stringify(gb)) return;
    const breaks = { a: breaksIn(a, ga), b: breaksIn(b, gb) };
    const group = (ga ?? gb)!.name;
    for (const tier of [0, 1] as const) {
      if (breaks.a[tier] !== breaks.b[tier]) {
        const pick = breaks.a[tier] < breaks.b[tier] ? "a" : "b";
        const other = pick === "a" ? "b" : "a";
        differences.push({ row, group, breaks, pick, reason: `fewer tier ${tier + 1} rule breaks: ${labels[pick]} has ${breaks[pick][tier]}, ${labels[other]} ${breaks[other][tier]}` });
        return;
      }
    }
    if (later === "a" || later === "b") {
      const date = (e: Edited) => (e.at ? e.at.slice(0, 10) : `not after ${e.notAfter?.slice(0, 10)}`);
      differences.push({
        row,
        group,
        breaks,
        pick: later,
        reason: `${labels[later]} edited later (${date(later === "a" ? a.edited : b.edited)} against ${date(later === "a" ? b.edited : a.edited)})`,
      });
      return;
    }
    const why = later === "same" ? "edited at the same time" : "no edit dates to tell them apart";
    differences.push({ row, group, breaks, pick: base, reason: `${why}; ${labels[base]} is the base` });
  });
  return differences;
}

/**
 * The song as a whole: the base, unless every difference is better taken
 * from the other side, in which case that side's version is the song.
 */
function propose(differences: readonly Difference[], options: CompareOptions): Proposal {
  const { labels } = options;
  const base = baseOf(options);
  const other = base === "a" ? "b" : "a";
  const taken = differences.filter((d) => d.pick === other);
  if (differences.length > 0 && taken.length === differences.length) {
    return { pick: other, reason: differences.length === 1 ? differences[0].reason : `${labels[other]} is better at all ${differences.length} differences` };
  }
  if (taken.length === 0) {
    return { pick: base, reason: differences.length === 1 ? differences[0].reason : `${labels[base]} is better or as good at all ${differences.length} differences` };
  }
  return { pick: base, reason: `${labels[base]} is the base; take ${labels[other]}'s version at ${taken.length} of ${differences.length} differences` };
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
