import path from "node:path";
import type { I18n } from "@presenter-garage/core/i18n/core";
import { LibraryError } from "../library";
import type { LoadedRules } from "../rules";
import { checkJson, checkText, notes, rulesMeta, rulesText } from "./check";
import { compareSongs, summarise, type Pair, type Summary } from "./compare";
import { foundText, type Found } from "./discover";
import { openOut } from "./out-folder";
import { reportHtml } from "./report";
import { songMeta, songText } from "./song";
import { failuresText, sourceCounts, sourceMeta, type Source, type SourceCounts } from "./source";

/**
 * What each read-only command leaves on disk, for the command line and the
 * MCP server alike, and the short answer each gives: counts and the paths it
 * wrote, never a lyric. Everything goes through `openOut()`, which decides
 * which folders may be written at all.
 *
 * `libraries` is every library the run read or knows of, beyond the sources
 * it is handed: a folder inside one is refused.
 */

/** A name as a file system that ignores case and accent composition compares it. */
export const labelKey = (name: string) => name.normalize("NFC").toLowerCase();

/** A song's own path without `.pro`, which names its files. */
const stem = (file: string) => file.replace(/\.pro$/i, "");

/** Hands out names the file system will keep apart: one that would take a name already used gets a number. */
function claimer(): (wanted: string) => string {
  const used = new Set<string>();
  return (wanted) => {
    let name = wanted;
    for (let n = 2; used.has(labelKey(name)); n++) name = `${wanted} (${n})`;
    used.add(labelKey(name));
    return name;
  };
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Every library a source was read from: a workspace's `.pro` folder, read for its older edit dates, is one too. */
const readFrom = (...sources: Source[]) => sources.flatMap((s) => [s.root, ...(s.legacy ? [s.legacy] : [])]);

export interface DumpWritten {
  out: string;
  files: { index: string; songs: string };
  source: SourceCounts;
}

/** One JSON and one text file per song, laid out as the library is, and an index without lyrics. */
export async function writeDump(out: string, source: Source, libraries: readonly string[] = []): Promise<DumpWritten> {
  const folder = await openOut(out, "dump", [...readFrom(source), ...libraries]);
  const claim = claimer();
  const entries = [];
  for (const song of source.songs) {
    const name = claim(stem(song.file));
    const files = { json: `songs/${name}.json`, text: `songs/${name}.txt` };
    await folder.put(files.json, json(song));
    await folder.put(files.text, songText(song));
    entries.push({ ...songMeta(song), ...files });
  }
  const index = await folder.put(
    "index.json",
    json({ format: "presenter-garage/dump", version: 1, created: new Date().toISOString(), source: sourceMeta(source), songs: entries })
  );
  return { out: folder.dir, files: { index, songs: path.join(folder.dir, "songs") }, source: sourceCounts(source) };
}

export interface CompareWritten {
  out: string;
  files: { json: string; report: string; text: { a: string; b: string } };
  summary: Summary;
  rules: ReturnType<typeof rulesMeta>;
  a: SourceCounts;
  b: SourceCounts;
  /** What a reader must know before trusting the result. */
  notes: string[];
}

/**
 * Match two sources song by song, and write `compare.json`, `report.html`
 * and a text view of every song.
 *
 * A pair's two text views share one name, the first side's, under each
 * side's label, so `git diff --no-index --word-diff text/bas text/haut`
 * sets each song against its match. A song only one side has keeps its own
 * name, and one that would take a name already used gets a number.
 */
export async function writeCompare(
  out: string,
  a: Source,
  b: Source,
  options: { prefer: string; rules: LoadedRules },
  libraries: readonly string[] = []
): Promise<CompareWritten> {
  if (labelKey(a.label) === labelKey(b.label)) {
    throw new LibraryError(`The sources are labelled ${a.label} and ${b.label}, one folder to the file system: give them different labels.`);
  }
  const pairs = compareSongs(a.songs, b.songs, { labels: { a: a.label, b: b.label }, prefer: options.prefer });
  const count = (s: Source) => ({ label: s.label, songs: s.songs.length, failures: s.failures.length });
  const summary = summarise(pairs, count(a), count(b));
  const folder = await openOut(out, "compare", [...readFrom(a, b), ...libraries]);
  const claim = claimer();
  const textOf = new Map<Pair, { a?: string; b?: string }>();
  for (const pair of pairs) {
    // One name for both sides, taken on both even where one is absent, so
    // it is free on each side and the pair's two files always share it.
    const name = claim(stem((pair.a ?? pair.b)!.file));
    const files: { a?: string; b?: string } = {};
    for (const side of ["a", "b"] as const) {
      const song = pair[side];
      if (!song) continue;
      files[side] = `text/${side === "a" ? a.label : b.label}/${name}.txt`;
      await folder.put(files[side], songText(song));
    }
    textOf.set(pair, files);
  }
  // Both, even where a side has no songs, so `git diff` has two folders to compare.
  const text = { a: path.join(folder.dir, "text", a.label), b: path.join(folder.dir, "text", b.label) };
  for (const label of [a.label, b.label]) await folder.mkdir(`text/${label}`);

  const created = new Date().toISOString();
  const document = {
    format: "presenter-garage/compare",
    version: 1,
    created,
    a: sourceMeta(a),
    b: sourceMeta(b),
    summary,
    pairs: pairs.map((pair) => ({
      id: pair.id,
      bucket: pair.bucket,
      matchedBy: pair.matchedBy,
      content: pair.content,
      later: pair.later,
      proposed: pair.proposed,
      differences: pair.differences,
      text: textOf.get(pair),
      a: pair.a && songMeta(pair.a),
      b: pair.b && songMeta(pair.b),
    })),
  };
  const written = await folder.put("compare.json", json(document));
  const report = await folder.put("report.html", reportHtml({ created, a, b, pairs, summary }));
  return {
    out: folder.dir,
    files: { json: written, report, text },
    summary,
    rules: rulesMeta(options.rules),
    a: sourceCounts(a),
    b: sourceCounts(b),
    notes: [...notes(a, options.rules), ...b.ruleNotes.map((note) => `${b.label}: ${note}`)],
  };
}

export interface CheckWritten {
  out: string;
  files: { json: string; text: string };
  source: SourceCounts;
  rules: ReturnType<typeof rulesMeta>;
  /** Rule breaks, leaving out what a person excepted, and how many were excepted. */
  breaks: { total: number; byTier: [number, number, number]; songs: number; excepted: number };
  notes: string[];
}

/**
 * Every rule break: `check.json`, where each is and what it says with the
 * line it is on, and `check.txt`, each with two slides either side.
 */
export async function writeCheck(
  out: string,
  source: Source,
  rules: LoadedRules,
  i18n: I18n,
  libraries: readonly string[] = []
): Promise<CheckWritten> {
  const folder = await openOut(out, "check", [...readFrom(source), ...libraries]);
  const written = await folder.put("check.json", json(checkJson(source, rules, i18n, true)));
  const text = await folder.put("check.txt", `${checkText(source, rules, i18n)}${failuresText(source)}\n`);
  const byTier: [number, number, number] = [0, 0, 0];
  let excepted = 0;
  for (const song of source.songs) {
    song.breaks.forEach((n, tier) => (byTier[tier] += n));
    excepted += song.findings.filter((f) => f.excepted !== undefined).length;
  }
  return {
    out: folder.dir,
    files: { json: written, text },
    source: sourceCounts(source),
    rules: rulesMeta(rules),
    breaks: {
      total: byTier[0] + byTier[1] + byTier[2],
      byTier,
      songs: source.songs.filter((song) => song.findings.some((f) => f.excepted === undefined)).length,
      excepted,
    },
    notes: notes(source, rules),
  };
}

export interface SourcesWritten {
  out: string;
  files: { json: string; text: string };
  /** How many of each kind of library were found. */
  workspaces: number;
  folderWorkspaces: number;
  documents: boolean;
  active: boolean;
}

/** Every library found on this computer, whose folders a run that reads none of them is still kept out of. */
export const knownLibraries = (found: Found) => [
  ...found.workspaces.filter((w) => w.present).map((w) => w.root),
  ...found.folders,
  ...(found.documents ? [found.documents] : []),
];

/** The libraries on this computer: `sources.json`, and `sources.txt` as the command line prints it. */
export async function writeSources(out: string, found: Found, libraries: readonly string[] = []): Promise<SourcesWritten> {
  const folder = await openOut(out, "sources", [...knownLibraries(found), ...libraries]);
  return {
    out: folder.dir,
    files: { json: await folder.put("sources.json", json(found)), text: await folder.put("sources.txt", `${foundText(found)}\n`) },
    workspaces: found.workspaces.length,
    folderWorkspaces: found.folders.length,
    documents: found.documents !== undefined,
    active: found.active !== undefined,
  };
}

export interface RulesCheckWritten {
  out: string;
  files: { json: string; text: string };
  rules: ReturnType<typeof rulesMeta>;
  notes: string[];
}

/** The rules as loaded: `rules-check.json` with every rule and exception, and `rules-check.txt`. */
export async function writeRulesCheck(out: string, rules: LoadedRules, libraries: readonly string[] = []): Promise<RulesCheckWritten> {
  const folder = await openOut(out, "rules-check", libraries);
  return {
    out: folder.dir,
    files: {
      json: await folder.put("rules-check.json", json({ ...rulesMeta(rules), set: rules.set })),
      text: await folder.put("rules-check.txt", `${rulesText(rules)}\n`),
    },
    rules: rulesMeta(rules),
    notes: notes(undefined, rules),
  };
}
