import fs from "node:fs/promises";
import path from "node:path";
import { isInside, LibraryError } from "@presenter-garage/node/library";
import type { Pair, Summary } from "./compare";
import { reportHtml } from "./report";
import { songMeta, songText } from "./song";
import { sourceMeta, type Source } from "./source";

/**
 * What the commands leave on disk. Only ever under `--out`, and only into a
 * folder that is empty or one this command wrote before: lyrics are somebody's
 * library, and a run pointed at the wrong folder must not scatter them through
 * it, or clear it out.
 */

const DUMP = "presenter-garage/dump";
const COMPARE = "presenter-garage/compare";

/**
 * Make `out` ready to write into. A folder this command wrote before has its
 * text views removed, so a song that has gone since leaves no file behind;
 * anything else that is not empty is refused.
 */
async function prepare(out: string, format: string, index: string, generated: readonly string[]): Promise<void> {
  const entries = await fs.readdir(out).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return undefined;
    throw e;
  });
  if (entries === undefined) {
    await fs.mkdir(out, { recursive: true });
    return;
  }
  if (entries.length === 0) return;
  const previous = await fs
    .readFile(path.join(out, index), "utf8")
    .then((text) => (JSON.parse(text) as { format?: string }).format)
    .catch(() => undefined);
  if (previous !== format) {
    throw new LibraryError(`${out} is not empty and is not a folder this command wrote. Give an empty or new folder.`);
  }
  for (const name of generated) await fs.rm(path.join(out, name), { recursive: true, force: true });
}

/**
 * Write a file under `out`, refusing any path that would land outside it,
 * whether by its name or by a link: a folder reused from an earlier run could
 * hold a link where `report.html` was, pointing anywhere. Whatever is there
 * is removed first and the file made afresh, never followed.
 */
async function put(out: string, relative: string, content: string): Promise<string> {
  const file = path.resolve(out, relative);
  if (!isInside(path.resolve(out), file)) throw new LibraryError(`Refusing to write outside ${out}: ${relative}`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (!isInside(await fs.realpath(out), await fs.realpath(path.dirname(file)))) {
    throw new LibraryError(`Refusing to write outside ${out}: ${relative} is reached through a link`);
  }
  await fs.rm(file, { force: true });
  await fs.writeFile(file, content, { flag: "wx" });
  return file;
}

/** A name as a file system that ignores case and accent composition compares it. */
export const labelKey = (name: string) => name.normalize("NFC").toLowerCase();

/** A song's own path without `.pro`, which names its files under `--out`. */
const stem = (file: string) => file.replace(/\.pro$/i, "");

export interface DumpResult {
  out: string;
  songs: number;
  failures: Source["failures"];
}

/** One JSON and one text file per song, laid out as the library is, and an index without lyrics. */
export async function writeDump(out: string, source: Source): Promise<DumpResult> {
  await prepare(out, DUMP, "index.json", ["songs"]);
  for (const song of source.songs) {
    await put(out, path.join("songs", `${stem(song.file)}.json`), `${JSON.stringify(song, null, 2)}\n`);
    await put(out, path.join("songs", `${stem(song.file)}.txt`), songText(song));
  }
  await put(
    out,
    "index.json",
    `${JSON.stringify(
      {
        format: DUMP,
        version: 1,
        created: new Date().toISOString(),
        source: sourceMeta(source),
        songs: source.songs.map((song) => ({ ...songMeta(song), json: `songs/${stem(song.file)}.json`, text: `songs/${stem(song.file)}.txt` })),
      },
      null,
      2
    )}\n`
  );
  return { out, songs: source.songs.length, failures: source.failures };
}

export interface CompareResult {
  out: string;
  report: string;
  json: string;
  text: { a: string; b: string };
}

/**
 * `compare.json`, `report.html` and a text view of every song.
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
  pairs: readonly Pair[],
  summary: Summary
): Promise<CompareResult> {
  if (labelKey(a.label) === labelKey(b.label)) {
    throw new LibraryError(`The sources are labelled ${a.label} and ${b.label}, one folder to the file system: give them different labels.`);
  }
  await prepare(out, COMPARE, "compare.json", ["text"]);
  // Both, even where a side has no songs, so the printed `git diff` has two folders to compare.
  for (const label of [a.label, b.label]) await fs.mkdir(path.join(out, "text", label), { recursive: true });
  // Names compared as the file system will: macOS and Windows ignore case, and macOS accent composition too.
  const used = new Set<string>();
  const claim = (wanted: string) => {
    let name = wanted;
    for (let n = 2; used.has(labelKey(name)); n++) name = `${wanted} (${n})`;
    used.add(labelKey(name));
    return name;
  };
  const textOf = new Map<Pair, { a?: string; b?: string }>();
  for (const pair of pairs) {
    // One name for both sides, taken on both even where one is absent, so
    // it is free on each side and the pair's two files always share it.
    const name = claim(stem((pair.a ?? pair.b)!.file));
    const files: { a?: string; b?: string } = {};
    for (const side of ["a", "b"] as const) {
      const song = pair[side];
      if (!song) continue;
      const label = side === "a" ? a.label : b.label;
      files[side] = `text/${label}/${name}.txt`;
      await put(out, files[side], songText(song));
    }
    textOf.set(pair, files);
  }

  const created = new Date().toISOString();
  const document = {
    format: COMPARE,
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
  const json = await put(out, "compare.json", `${JSON.stringify(document, null, 2)}\n`);
  const report = await put(out, "report.html", reportHtml({ created, a, b, pairs, summary }));
  return {
    out,
    report,
    json,
    text: { a: path.join(out, "text", a.label), b: path.join(out, "text", b.label) },
  };
}
