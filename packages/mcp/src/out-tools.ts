import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createI18n, type Lang } from "@presenter-garage/core/i18n/core";
import { isPresentationFile } from "@presenter-garage/core/lib/folder";
import { discover } from "@presenter-garage/node/commands/discover";
import { labelKey, writeCheck, writeCompare, writeDump, writeRulesCheck, writeSources } from "@presenter-garage/node/commands/output";
import { isLabel, readSource, type Source } from "@presenter-garage/node/commands/source";
import { isFile, LibraryError, openRoots, resolveInRoots } from "@presenter-garage/node/library";
import { findRules, loadRules } from "@presenter-garage/node/rules";
import { answer } from "./answer";
import type { Library } from "./library";
import { approve, doubtAbout } from "./library-tools";
import { rulesFor } from "./tools/rules";

/**
 * The command line's commands as tools, each writing what it finds to a
 * folder on disk and answering with counts and the paths it wrote.
 *
 * An answer is read by the model and sent to its provider; a library's
 * lyrics have no reason to go there, so they stay in the folder until the
 * person asks for one to be read. The files are the ones the command line
 * writes with `--out`, written by the same code in `packages/node`, which
 * makes each call a new folder of its own inside `out`, never inside a
 * library, and never writes over or removes a file.
 *
 * Offered only when the server may write: Read only means no file at all.
 */

/** Where the libraries on this computer are looked for; a test names its own. */
export interface SourcesDirs {
  workspaces?: string;
  folders?: string;
  documents?: string;
}

/** Each call makes a folder of its own, so calling again adds one: not idempotent, though it changes nothing already there. */
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

export const OUT = z
  .string()
  .describe(
    "An absolute folder, outside the library, to put the results in. Each call makes a new folder inside it, " +
      "named for the tool and the time, and writes only there; nothing already in `out` is touched. The answer's " +
      "`out` is that new folder."
  );

/** The folder a model named, as an absolute path. */
function outFolder(given: string): string {
  const dir = given.startsWith("file:") ? fileURLToPath(given) : given;
  if (!path.isAbsolute(dir)) throw new LibraryError(`Give an absolute folder for the results, not ${given}.`);
  return dir;
}

/** A folder that cannot be made or written is the person's to put right: an answer, not a crash. */
async function writing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const errno = e as NodeJS.ErrnoException;
    if (!(e instanceof LibraryError) && typeof errno.code === "string" && errno.syscall) throw new LibraryError(errno.message);
    throw e;
  }
}

/** A library's label, which names its folder of text views: its folder's name where that can be one. */
const labelOf = (root: string, fallback: string) => (isLabel(path.basename(root)) ? path.basename(root) : fallback);

/**
 * `check_presentations` with an `out` folder: the same checks, every break
 * written to `check.json` and `check.txt` there, as the command line's
 * `check --out` writes them.
 */
export async function checkToOut(
  root: string,
  { path: target, rules: inline, lang = "en", out }: { path?: string; rules?: unknown; lang?: Lang; out: string },
  rulesDirs: readonly string[] = []
) {
  const dir = outFolder(out);
  const within = target ? await resolveInRoots([root], target) : undefined;
  if (within && (await isFile(within)) && !isPresentationFile(path.basename(within))) {
    throw new LibraryError(`Not a presentation (.pro) file: ${target}`);
  }
  const loaded = await rulesFor(inline, rulesDirs);
  const source = await readSource({ label: labelOf(root, "library"), path: root }, { rules: loaded.set, within });
  return writing(() => writeCheck(dir, source, loaded, createI18n(lang)));
}

export function registerOutTools(
  server: McpServer,
  library: Library,
  options: { rulesDirs?: readonly string[]; sources?: SourcesDirs }
): void {
  const rulesDirs = options.rulesDirs ?? [];
  /** The library open now, or none: a folder inside it is refused even by a tool that does not read it. */
  const open = async () => {
    const opened = await library.get().catch(() => undefined);
    return opened ? [opened.root] : [];
  };

  server.registerTool(
    "find_libraries",
    {
      title: "Find the libraries on this computer",
      description:
        "Find the ProPresenter libraries on this computer, where ProPresenter keeps them: the ProPresenter 22 " +
        "workspaces in its registry, the folder workspaces ProPresenter 20 and 21 made, and Documents/ProPresenter. " +
        "Writes sources.json and sources.txt to a new folder in `out` and answers with how many of each were found; read " +
        "sources.json for their paths, to hand to use_library or compare_libraries.",
      inputSchema: { out: OUT },
      annotations: WRITES,
    },
    ({ out }) =>
      answer(async () => {
        const dir = outFolder(out);
        return writing(async () => writeSources(dir, await discover(options.sources), await open()));
      })
  );

  server.registerTool(
    "dump_library",
    {
      title: "Write out every song",
      description:
        "Write every song in the library to a new folder in `out`: under songs/, one JSON file (groups, slides, lines, macros, " +
        "edit date) and one text file per song, laid out as the library is, and index.json listing them without " +
        "their words. Answers with how many songs were written and how many could not be read, and the paths: " +
        "no lyrics. Read a song's file only when the person asks for it.",
      inputSchema: { out: OUT },
      annotations: WRITES,
    },
    ({ out }) =>
      answer(async () => {
        const dir = outFolder(out);
        const { root } = await library.get();
        const source = await readSource({ label: labelOf(root, "library"), path: root });
        return writing(() => writeDump(dir, source));
      })
  );

  server.registerTool(
    "compare_libraries",
    {
      title: "Compare two libraries song by song",
      description:
        "Match the songs of the library open now with another library's, by uuid then by name, and for each " +
        "place two versions differ propose one by the team's rules, then by which was edited later, then by the " +
        "preferred library. The person is asked, by their app, to let the other library be read; nothing is read " +
        "unless they do. Writes to a new folder in `out` compare.json (every pair, where they differ and what is proposed, " +
        "without the words), report.html (both versions side by side, every differing word marked) and " +
        "text/<label>/ (a text file per song, for `git diff --no-index --word-diff`). Answers with counts and " +
        "paths: no lyrics.",
      inputSchema: {
        other: z.string().describe("The other library's absolute path: a folder of ProPresenter 7 files or a ProPresenter 22 workspace."),
        out: OUT,
        labels: z
          .object({
            open: z.string().optional().describe("The open library's label (default its folder's name)."),
            other: z.string().optional().describe("The other library's label (default its folder's name)."),
          })
          .optional()
          .describe("What to call each library in the report and its text folders: a word of letters, digits, '-', '_' or '.'."),
        prefer: z
          .enum(["open", "other"])
          .optional()
          .describe("The main library, kept where nothing else decides (default the open one)."),
      },
      annotations: WRITES,
    },
    ({ other, out, labels = {}, prefer = "open" }, { signal }) =>
      answer(async () => {
        const dir = outFolder(out);
        const opened = await library.get();
        const given = other.startsWith("file:") ? fileURLToPath(other) : other;
        if (!path.isAbsolute(given)) throw new LibraryError(`Give the other library's absolute path, not ${other}.`);
        const [root] = await openRoots([given]);
        if (root === opened.root) throw new LibraryError(`${root} is the library open now: give another to compare it with.`);
        const names = { open: labels.open ?? labelOf(opened.root, "open"), other: labels.other ?? labelOf(root, "other") };
        for (const name of Object.values(names)) {
          if (!isLabel(name)) throw new LibraryError(`${name} cannot be a label: use a word of letters, digits, '-', '_' or '.'.`);
        }
        if (labelKey(names.open) === labelKey(names.other)) {
          throw new LibraryError(`Both libraries would be labelled ${names.open}, one folder to the file system: give each its own in \`labels\`.`);
        }
        // The other library is read only once the person has let it be: it is not the one they opened.
        const reply = await approve(server, signal, {
          message:
            `Read ${root} to compare it with ${opened.root}? Nothing in either is changed; the comparison, lyrics ` +
            `included, is written to ${dir}.${await doubtAbout(root)}`,
          cannotAsk: "This MCP client cannot ask its user to approve reading another library, so nothing was compared.",
          unchanged: "nothing was compared",
        });
        if (reply.action !== "accept") return { answer: reply.action };
        if (signal.aborted) throw new LibraryError("The call was cancelled before the answer came back, so nothing was compared.");
        const rules = await loadRules(await findRules(undefined, rulesDirs));
        const read = (label: string, dir: string): Promise<Source> => readSource({ label, path: dir }, { rules: rules.set });
        const a = await read(names.open, opened.root);
        const b = await read(names.other, root);
        return {
          answer: "accept",
          ...(await writing(() => writeCompare(dir, a, b, { prefer: names[prefer], rules }))),
        };
      })
  );

  server.registerTool(
    "check_rules",
    {
      title: "Check the team's rules file",
      description:
        "Load the team's rules as check_presentations would run them, and say whether rules.json is older than " +
        "RULES.md. Writes rules-check.json (every rule and exception) and rules-check.txt to a new folder in `out`; answers with " +
        "where the rules are, how many there are, and whether they are stale.",
      inputSchema: { out: OUT },
      annotations: WRITES,
    },
    ({ out }) =>
      answer(async () => {
        const dir = outFolder(out);
        return writing(async () => writeRulesCheck(dir, await loadRules(await findRules(undefined, rulesDirs)), await open()));
      })
  );
}
