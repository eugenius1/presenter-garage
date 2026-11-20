import path from "node:path";
import { parseArgs } from "node:util";
import { LibraryError } from "@presenter-garage/node/library";
import { compareSongs, summarise, summaryText } from "./compare";
import { discover, foundText } from "./discover";
import { labelKey, writeCompare, writeDump } from "./output";
import { songText } from "./song";
import { parseSource, readSource, sourceMeta, type ReadOptions, type Source, type SourceSpec } from "./source";

/**
 * `presenter-garage`: read-only commands over ProPresenter libraries.
 *
 * What goes to the terminal is counts and paths, never lyrics unless asked
 * for: an agent running this over a thousand songs should not have them
 * poured into its context. The words go into files under `--out`.
 */

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Whether `err` is a terminal, where a progress line can be redrawn in place. */
  interactive?: boolean;
}

export const USAGE = `Usage: presenter-garage <command> [options]

Commands:
  sources                       List the ProPresenter libraries and workspaces on this computer
  dump <source> --out <dir>     Write every song as JSON and as text
  dump <source> --lyrics        Print every song's text (JSON with --json)
  compare <a> <b> --out <dir>   Match two libraries song by song; write compare.json,
                                report.html and text views, and print a summary

A source is a folder of .pro files, a ProPresenter 22 workspace folder, or
"active" (the workspace ProPresenter has open), with a label in front:
  bas=private/machines/bas   haut=active

Options:
  --out <dir>             Where files go: a new or empty folder, or one this command wrote
  --json                  Print JSON instead of text, for scripts and agents
  --prefer <label>        The main library, kept when nothing else decides (default: haut)
  --legacy <label>=<dir>  The .pro folder a workspace was made from, for edit dates before
                          the upgrade (default: what ProPresenter's registry says, if present)
  --help                  This text

Nothing is ever written to a library or workspace.`;

class UsageError extends Error {}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        out: { type: "string" },
        json: { type: "boolean", default: false },
        prefer: { type: "string", default: "haut" },
        legacy: { type: "string", multiple: true, default: [] },
        lyrics: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...args] = positionals;
  if (values.help || command === "help") {
    io.out(USAGE);
    return 0;
  }
  if (!command) {
    io.err(USAGE);
    return 2;
  }

  try {
    const legacy = legacyFolders(values.legacy);
    switch (command) {
      case "sources":
        return await sources(values.json, io);
      case "dump":
        if (args.length !== 1) throw new UsageError("dump takes one source.");
        return await dump(parseSource(args[0]), { out: values.out, json: values.json, lyrics: values.lyrics, legacy }, io);
      case "compare":
        if (args.length !== 2) throw new UsageError("compare takes two sources.");
        if (!values.out) throw new UsageError("compare needs --out <dir>.");
        return await compare(args.map(parseSource) as [SourceSpec, SourceSpec], { out: values.out, json: values.json, prefer: values.prefer, legacy }, io);
      default:
        throw new UsageError(`Unknown command: ${command}`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    // A folder that cannot be written, or a path that is a file: the person's to put right, not a crash.
    const fsError = typeof (e as NodeJS.ErrnoException).code === "string" && (e as NodeJS.ErrnoException).syscall;
    if (e instanceof LibraryError || fsError) {
      const message = (e as Error).message;
      io.err(values.json ? JSON.stringify({ error: message }) : message);
      return 1;
    }
    throw e;
  }
}

function legacyFolders(specs: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const spec of specs) {
    const at = spec.indexOf("=");
    if (at <= 0) throw new UsageError(`--legacy takes label=folder, not ${spec}`);
    map.set(spec.slice(0, at), spec.slice(at + 1));
  }
  return map;
}

async function sources(json: boolean, io: Io): Promise<number> {
  const found = await discover();
  io.out(json ? JSON.stringify(found, null, 2) : foundText(found));
  return 0;
}

async function read(spec: SourceSpec, legacy: Map<string, string>, io: Io): Promise<Source> {
  const options: ReadOptions = { legacy: legacy.get(spec.label) };
  if (io.interactive) {
    options.progress = (done, total) => {
      if (done === 0 || done === total || done % 25 === 0) io.err(`\rReading ${spec.label}: ${done} of ${total}`);
    };
  }
  const source = await readSource(spec, options);
  if (io.interactive) io.err("\r\x1b[K");
  return source;
}

async function dump(
  spec: SourceSpec,
  options: { out?: string; json: boolean; lyrics: boolean; legacy: Map<string, string> },
  io: Io
): Promise<number> {
  if (!options.out && !options.lyrics) throw new UsageError("dump needs --out <dir>, or --lyrics to print the songs.");
  const source = await read(spec, options.legacy, io);
  if (options.out) {
    const result = await writeDump(path.resolve(options.out), source);
    if (options.json) io.out(JSON.stringify({ source: sourceMeta(source), out: result.out }, null, 2));
    else io.out(`${source.label}: ${source.songs.length} songs written to ${result.out}${failuresText(source)}`);
    return 0;
  }
  if (options.json) io.out(JSON.stringify({ source: sourceMeta(source), songs: source.songs }, null, 2));
  else {
    for (const song of source.songs) io.out(`=== ${song.file}\n${songText(song)}`);
    // The songs alone on stdout; what was left out goes beside them, so it is never silent.
    const failures = failuresText(source);
    if (failures) io.err(failures.trimStart());
  }
  return 0;
}

async function compare(
  specs: [SourceSpec, SourceSpec],
  options: { out: string; json: boolean; prefer: string; legacy: Map<string, string> },
  io: Io
): Promise<number> {
  if (labelKey(specs[0].label) === labelKey(specs[1].label)) {
    throw new UsageError(
      `The sources are labelled ${specs[0].label} and ${specs[1].label}, one name to the file system: give each its own label, as bas=… haut=…`
    );
  }
  const a = await read(specs[0], options.legacy, io);
  const b = await read(specs[1], options.legacy, io);
  const pairs = compareSongs(a.songs, b.songs, { labels: { a: a.label, b: b.label }, prefer: options.prefer });
  const count = (s: Source) => ({ label: s.label, songs: s.songs.length, failures: s.failures.length });
  const summary = summarise(pairs, count(a), count(b));
  const written = await writeCompare(path.resolve(options.out), a, b, pairs, summary);
  if (options.json) {
    // Counts and paths only: every pair, without its words, is in compare.json.
    io.out(JSON.stringify({ summary, a: sourceMeta(a), b: sourceMeta(b), files: written }, null, 2));
  } else {
    io.out(
      [
        summaryText(summary) + failuresText(a) + failuresText(b),
        `Report: ${written.report}`,
        `Data:   ${written.json}`,
        `Text:   git diff --no-index --word-diff ${shellQuote(written.text.a)} ${shellQuote(written.text.b)}`,
      ].join("\n")
    );
  }
  return 0;
}

function failuresText(source: Source): string {
  if (!source.failures.length && !source.truncated) return "";
  const lines = source.failures.map((f) => `  ${f.file}: ${f.reason}`);
  if (source.truncated) lines.push("  (stopped at the walk's limit: not every file was read)");
  return `\n${source.label}: ${source.failures.length} not read\n${lines.join("\n")}`;
}

/** A path as a POSIX shell reads it back, whatever spaces or quotes it holds. */
const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
