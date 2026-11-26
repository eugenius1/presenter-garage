import { parseArgs } from "node:util";
import { createI18n, detectLanguage, isLang, type I18n } from "@presenter-garage/core/i18n/core";
import { LibraryError } from "@presenter-garage/node/library";
import { findRules, loadRules, type LoadedRules } from "@presenter-garage/node/rules";
import { checkJson, checkText, rulesMeta, rulesText } from "@presenter-garage/node/commands/check";
import { summaryText } from "@presenter-garage/node/commands/compare";
import { discover, foundText } from "@presenter-garage/node/commands/discover";
import { knownLibraries, labelKey, writeCheck, writeCompare, writeDump, writeRulesCheck, writeSources } from "@presenter-garage/node/commands/output";
import { songText } from "@presenter-garage/node/commands/song";
import {
  failuresText,
  parseSource,
  readSource,
  sourceMeta,
  type ReadOptions,
  type Source,
  type SourceSpec,
} from "@presenter-garage/node/commands/source";

/**
 * `presenter-garage`: read-only commands over ProPresenter libraries.
 *
 * What goes to the terminal is counts and paths, never lyrics unless asked
 * for: an agent running this over a thousand songs should not have them
 * poured into its context. The words go into files under `--out`, written
 * by `packages/node/src/commands/output.ts`, which the MCP server's tools
 * write through too, so either leaves the same files.
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
  check <source>                Every rule break, with two slides either side
                                (with --json: where each is and what it says)
  rules check [<file>]          Read the rules, and say whether they are older than RULES.md

With --out, sources, check and rules check write what they would print to
files there too, and print only counts and paths.

Each run makes a new folder of its own inside the --out folder, such as
dump-2026-11-26T10-12-02Z, and writes only there: nothing already in the
--out folder is ever replaced or removed.

A source is a folder of .pro files, a ProPresenter 22 workspace folder, or
"active" (the workspace ProPresenter has open), with a label in front:
  bas=private/machines/bas   haut=active

Options:
  --out <dir>             Where each run makes a new folder for its files, never inside a
                          library
  --json                  Print JSON instead of text, for scripts and agents
  --prefer <label>        The main library, kept when nothing else decides (default: haut)
  --legacy <label>=<dir>  The .pro folder a workspace was made from, for edit dates before
                          the upgrade (default: what ProPresenter's registry says, if present)
  --rules <file>          A rules.json or RULES.md, or a folder holding them (default: the
                          current folder's, then Documents/ProPresenter's, then the text checks)
  --lang <en|fr>          The language rule breaks are reported in (default: the system's)
  --lyrics                With check --json, include each broken line
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
        rules: { type: "string" },
        lang: { type: "string" },
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
    if (values.lang !== undefined && !isLang(values.lang)) throw new UsageError(`--lang takes en or fr, not ${values.lang}`);
    const legacy = legacyFolders(values.legacy);
    const rules = async () => loadRules(await findRules(values.rules));
    const i18n = createI18n(isLang(values.lang) ? values.lang : systemLanguage());
    switch (command) {
      case "sources":
        if (args.length) throw new UsageError("sources takes no source.");
        return await sources(values.out, values.json, io);
      case "dump":
        if (args.length !== 1) throw new UsageError("dump takes one source.");
        return await dump(parseSource(args[0]), { out: values.out, json: values.json, lyrics: values.lyrics, legacy }, io);
      case "compare":
        if (args.length !== 2) throw new UsageError("compare takes two sources.");
        if (!values.out) throw new UsageError("compare needs --out <dir>.");
        return await compare(args.map(parseSource) as [SourceSpec, SourceSpec], { out: values.out, json: values.json, prefer: values.prefer, legacy, rules: await rules() }, io);
      case "check":
        if (args.length !== 1) throw new UsageError("check takes one source.");
        return await check(parseSource(args[0]), { out: values.out, json: values.json, lyrics: values.lyrics, legacy, rules: await rules(), i18n }, io);
      case "rules": {
        if (args[0] !== "check" || args.length > 2) throw new UsageError("rules takes check, and a file if it is not the one found.");
        const loaded = await loadRules(await findRules(args[1] ?? values.rules));
        if (values.out) {
          // No library is read here, so the ones on this computer are what the folder is kept out of.
          const written = await writeRulesCheck(values.out, loaded, knownLibraries(await discover()));
          io.out(values.json ? JSON.stringify(written, null, 2) : [rulesText(loaded), `Written to ${written.out}`].join("\n"));
        } else io.out(values.json ? JSON.stringify(rulesMeta(loaded), null, 2) : rulesText(loaded));
        return 0;
      }
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

async function sources(out: string | undefined, json: boolean, io: Io): Promise<number> {
  const found = await discover();
  if (out) {
    const written = await writeSources(out, found);
    io.out(
      json
        ? JSON.stringify(written, null, 2)
        : `${written.workspaces} ProPresenter 22 workspaces, ${written.folderWorkspaces} older workspaces` +
            `${written.documents ? ", Documents/ProPresenter" : ""} written to ${written.out}`
    );
  } else io.out(json ? JSON.stringify(found, null, 2) : foundText(found));
  return 0;
}

/** The language of the person running the command, from the locale the shell gives. */
function systemLanguage() {
  const env = process.env;
  const tags = [env.LC_ALL, env.LC_MESSAGES, env.LANG, Intl.DateTimeFormat().resolvedOptions().locale];
  // `fr_FR.UTF-8` is how a shell writes what a browser writes `fr-FR`.
  return detectLanguage(tags.filter((t): t is string => !!t && t !== "C" && t !== "POSIX").map((t) => t.replace("_", "-")));
}

async function read(spec: SourceSpec, legacy: Map<string, string>, io: Io, rules?: LoadedRules): Promise<Source> {
  const options: ReadOptions = { legacy: legacy.get(spec.label), rules: rules?.set };
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
    const written = await writeDump(options.out, source);
    if (options.json) io.out(JSON.stringify(written, null, 2));
    else io.out(`${source.label}: ${source.songs.length} songs written to ${written.out}${failuresText(source)}`);
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
  options: { out: string; json: boolean; prefer: string; legacy: Map<string, string>; rules: LoadedRules },
  io: Io
): Promise<number> {
  if (labelKey(specs[0].label) === labelKey(specs[1].label)) {
    throw new UsageError(
      `The sources are labelled ${specs[0].label} and ${specs[1].label}, one name to the file system: give each its own label, as bas=… haut=…`
    );
  }
  const a = await read(specs[0], options.legacy, io, options.rules);
  const b = await read(specs[1], options.legacy, io, options.rules);
  const written = await writeCompare(options.out, a, b, { prefer: options.prefer, rules: options.rules });
  // Counts and paths only: every pair, without its words, is in compare.json.
  if (options.json) io.out(JSON.stringify(written, null, 2));
  else {
    io.out(
      [
        summaryText(written.summary) + failuresText(a) + failuresText(b),
        ...written.notes,
        `Folder: ${written.out}`,
        `Report: ${written.files.report}`,
        `Data:   ${written.files.json}`,
        `Text:   git diff --no-index --word-diff ${shellQuote(written.files.text.a)} ${shellQuote(written.files.text.b)}`,
      ].join("\n")
    );
  }
  return 0;
}

async function check(
  spec: SourceSpec,
  options: { out?: string; json: boolean; lyrics: boolean; legacy: Map<string, string>; rules: LoadedRules; i18n: I18n },
  io: Io
): Promise<number> {
  const source = await read(spec, options.legacy, io, options.rules);
  if (options.out) {
    const written = await writeCheck(options.out, source, options.rules, options.i18n);
    const { breaks } = written;
    io.out(
      options.json
        ? JSON.stringify(written, null, 2)
        : [
            `${source.label}: ${breaks.total} rule breaks in ${breaks.songs} of ${source.songs.length} songs` +
              (breaks.excepted ? `, ${breaks.excepted} more excepted` : "") +
              failuresText(source),
            ...written.notes,
            `Folder: ${written.out}`,
            `Text: ${written.files.text}`,
            `Data: ${written.files.json}`,
          ].join("\n")
    );
  } else if (options.json) io.out(JSON.stringify(checkJson(source, options.rules, options.i18n, options.lyrics), null, 2));
  else io.out(checkText(source, options.rules, options.i18n) + failuresText(source));
  return 0;
}

/** A path as a POSIX shell reads it back, whatever spaces or quotes it holds. */
const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
