import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { version } from "../package.json";
import { answer, READ_ONLY } from "./answer";
import { registerEditTools } from "./edits";
import type { ReviewOptions } from "./review-tools";
import { Library, type LibraryOptions, type OpenLibrary } from "./library";
import { registerLibraryTools } from "./library-tools";
import { checkToOut, OUT, registerOutTools, type SourcesDirs } from "./out-tools";
export { toJson } from "./answer";

import {
  auditMediaBin,
  checkPresentations,
  listPresentations,
  listThemes,
  previewStyle,
  readMediaBin,
  readPlaylists,
  readConfiguration,
  readPresentationFile,
  readRules,
  saveRulesFile,
  searchText,
} from "./tools";

/**
 * An MCP server that reads, and edits the slide text of, one ProPresenter
 * library on disk at a time. Started by `main.ts`; built separately so tests
 * can drive it over an in-memory pipe.
 *
 * ProPresenter's own network API can show and trigger slides but cannot edit
 * them; this works on the files instead, through the same decoding, checks
 * and write path the browser app uses. Started with `readOnly`, the editing
 * tools are not offered at all, so a model never sees them; nor are they
 * while the library open has no usable backup folder.
 *
 * Which library is open is `library.ts`: the folder it was started on, the
 * client's roots when it has any, or one the person approved through
 * `use_library`.
 */

/** How long the client has to say what its roots are; every tool waits for the answer. */
const ROOTS_TIMEOUT_MS = 10 * 1000;

export interface ServerOptions extends LibraryOptions, ReviewOptions {
  /** Where the team's `RULES.md` and `rules.json` are looked for. Defaults to nowhere: a test names its own. */
  rulesDirs?: readonly string[];
  /** The team's rules as found at start-up, for the instructions to point a model at. */
  rules?: { markdown?: string; json?: string };
  /** Where find_libraries looks. Defaults to where ProPresenter keeps them on this computer. */
  sources?: SourcesDirs;
}

/**
 * Said in the tool descriptions, not only here, so a model asked "when was
 * this song created?" answers that it cannot know rather than guessing from
 * whatever date it was given. See `PresentationDetails`.
 */
const CREATION_DATE_NOTE =
  "No creation date is given: presentations do not record one, and the file system's is reset " +
  "whenever a file is copied, synced or restored from backup, so it would mislead.";

const MEDIA_BIN_INPUT = {
  path: z.string().optional().describe("The media bin file. Defaults to Playlists/Media in the library folder."),
};

/**
 * What a model is told about the team's rules before it does anything: where
 * they are, and that they are to be read before checking or proposing edits.
 * A team writes them for a person or a model to read, not for the tools, so
 * the model is the one that compiles them for the tools to run.
 */
function rulesInstruction({ rules, readOnly }: ServerOptions): string {
  if (!rules?.markdown && !rules?.json) return "";
  if (!rules.markdown) return ` The team's compiled rules are in ${rules.json}; check_presentations runs them.`;
  const compile = readOnly ? "" : rules.json ? " If it has changed since rules.json was compiled, compile it again with save_rules." : " It has not been compiled yet: compile it with save_rules so the checks can run it.";
  return ` The team's rules are in ${rules.markdown}: read them with read_rules before checking songs or proposing edits.${compile}`;
}

/** Which library the server starts on, and that it can change. */
function libraryInstruction(start: OpenLibrary | { problem: string }): string {
  return (
    "Reads one ProPresenter library at a time: a folder of ProPresenter 7 files or a ProPresenter 22 workspace. " +
    ("root" in start ? `It starts on ${start.root}` : `No library is open yet (${start.problem})`) +
    "; the client's roots, or use_library once the person approves, can open another (compare_libraries reads a " +
    "second beside it, once the person approves, without opening it), and current_library says " +
    "which is open and what to know before trusting it. Paths may be absolute or relative to the library folder. "
  );
}

/**
 * The server, starting on `start`: the library opened from the command line
 * or by default, or why none could be. See `Library` for what can change it.
 */
export function createServer(start: OpenLibrary | { problem: string }, options: ServerOptions = {}): McpServer {
  const library = new Library(start, options);
  // The editing tools are offered only while the library open can be backed up, so the instructions say so too.
  const editing = !options.readOnly && "root" in start && start.backupDir !== undefined;
  const server = new McpServer(
    { name: "presenter-garage", version },
    {
      instructions:
        libraryInstruction(start) +
        (options.readOnly
          ? "Nothing is written."
          : "For a whole library, prefer the tools that write to a folder (dump_library, compare_libraries, " +
            "check_presentations with `out`): they answer with counts and paths, and leave the lyrics on disk " +
            "until the person asks for one to be read. ") +
        (options.readOnly
          ? ""
          : editing
            ? "Slide text can be edited, a group renamed or a macro on a slide swapped, with plan_slide_edits then " +
              "apply_slide_edits; the person is asked to confirm every change before anything is written, and each " +
              "file is backed up first. For a bigger cleanup, or a client that cannot ask its user, plan with `out`: the " +
              "person chooses on a review page and can come back to it later. Their choices and notes are theirs: never " +
              "tick, untick or note anything for them, and never edit a review folder's files."
            : "Slide text cannot be edited in this library, since it cannot be backed up; the notes say why.") +
        rulesInstruction({ ...options, readOnly: !editing }) +
        ("root" in start && start.notes.length ? ` Important: ${start.notes.join(" ")}` : ""),
    }
  );
  /** A tool's answer, from the library open once any change under way is made. */
  const inLibrary = (run: (root: string) => Promise<unknown>) => answer(async () => run((await library.get()).root));

  // The client's roots, when it has them, name the library; read again whenever they change.
  const readClientRoots = () => {
    if (!server.server.getClientCapabilities()?.roots) return;
    library
      .useClientRoots(async () => (await server.server.listRoots(undefined, { timeout: ROOTS_TIMEOUT_MS })).roots)
      .catch((e) => console.error(`The client's roots could not be used: ${e instanceof Error ? e.message : e}`));
  };
  server.server.oninitialized = readClientRoots;
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, readClientRoots);

  server.registerTool(
    "list_presentations",
    {
      title: "List presentations",
      description:
        "List ProPresenter presentation (.pro) files in the library, optionally filtered by a " +
        "case- and accent-insensitive substring of the file name. Each entry has the file's size and " +
        "`fileModified` (the file system's time). " +
        "Filtering or sorting by when a presentation was last shown (`notUsedSince`, `usedSince`, " +
        "`sort: \"lastUsed\"`) also returns ProPresenter's own `lastUsed` and `lastModified`, but is much " +
        "slower: that date is stored inside each file, so every presentation the name filter leaves is " +
        "read and decoded -- about a second per 500 files on a local disk, far longer on a " +
        "network or cloud-synced folder. A plain listing only reads file names and is near-instant. " +
        "Combine with `query` to narrow the files read, and prefer one such call over several. " +
        CREATION_DATE_NOTE,
      inputSchema: {
        query: z.string().optional().describe("Part of the presentation's name, e.g. 'amazing grace'."),
        notUsedSince: z
          .string()
          .optional()
          .describe(
            "ISO date, e.g. '2025-10-24'. Only presentations not shown since then, including never shown. " +
              "Reads every file: see the description."
          ),
        usedSince: z
          .string()
          .optional()
          .describe("ISO date. Only presentations shown on or after it. Reads every file: see the description."),
        sort: z
          .enum(["name", "lastUsed"])
          .optional()
          .describe("'lastUsed' lists the most recently shown first. Reads every file: see the description."),
        limit: z.number().int().min(1).max(2000).optional().describe("Maximum results (default 200)."),
      },
      annotations: READ_ONLY,
    },
    (args) => inLibrary((root) => listPresentations(root, args))
  );

  server.registerTool(
    "read_presentation",
    {
      title: "Read a presentation",
      description:
        "Read a presentation's slides: label, arrangement group, the macros each triggers (`name` as the " +
        "slide records it, `uuid`, and `disabled` for one switched off) and the text of every text box, line " +
        "by line, and every group in stored order with the `groupIndex` a rename names it by. Names and text are exact; an invisible character such as a non-breaking space is written " +
        "as its escape, e.g. `\\u00a0`. Also reports `fidelity` (whether the file would survive being " +
        "written back; always 'lossy' in a ProPresenter 22 workspace, which has no files, though its slide " +
        "text can still be edited with plan_slide_edits) and what the file records about itself: ProPresenter's `lastModified` and `lastUsed` (when it was last " +
        "shown; absent if never), category, notes, CCLI details, music key, arrangements, and the " +
        "ProPresenter version that saved it. Prefer `lastModified` for when it was last edited: it is " +
        "ProPresenter's own record, kept inside the file, so copies, syncs and backups keep it. " +
        "`fileModified` is the file system's time, which a copy or download resets. " +
        CREATION_DATE_NOTE,
      inputSchema: { path: z.string().describe("Path of the .pro file.") },
      annotations: READ_ONLY,
    },
    ({ path: file }) => inLibrary((root) => readPresentationFile(root, file))
  );

  server.registerTool(
    "read_groups_and_macros",
    {
      title: "Read the configured groups and macros",
      description:
        "Read ProPresenter's own configured lists: the groups a slide can be put in (name, uuid, colour) and " +
        "the macros a slide can trigger (name, uuid, the collections listing it), each in ProPresenter's order. " +
        "A presentation's group matches a configured one by name alone, never by uuid, so names are given " +
        "exactly as stored: a non-breaking space is written `\\u00a0`, so `Couplet\\u00a01` and `Couplet 1` " +
        "are different names. A slide's macro matches by uuid, compared without regard to case; the name a " +
        "slide records is the macro's name when the slide was given it. `unreadable` says why a list is empty.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => inLibrary((root) => readConfiguration(root))
  );

  server.registerTool(
    "search_text",
    {
      title: "Search slide text",
      description:
        "Find a phrase in the slide text of every presentation, ignoring case and accents. Returns the " +
        "file, slide, group and line of each match.",
      inputSchema: {
        query: z.string().describe("Text to find, e.g. a lyric."),
        folder: z.string().optional().describe("Search only this folder, e.g. one library inside `Libraries`."),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum matches (default 50)."),
      },
      annotations: READ_ONLY,
    },
    (args) => inLibrary((root) => searchText(root, args))
  );

  server.registerTool(
    "check_presentations",
    {
      title: "Check presentation text",
      description:
        "Run the team's rules (their rules.json, compiled from RULES.md) on one .pro file or a folder; with neither, " +
        "on the whole library. With no rules.json, runs the default text checks: leading/trailing/repeated spaces, blank " +
        "lines inside a slide, and lines ending in a comma, semicolon or full stop. Each finding gives its rule, tier, " +
        "slide, group and line, and a message. Lists only files with findings; `notes` says what to know before trusting them." +
        (options.readOnly
          ? ""
          : " With `out`, nothing of the songs is answered: every break, with its line and two slides either side, is " +
            "written to check.json and check.txt in a new folder inside it, and the answer is counts and paths. Prefer it for a whole library."),
      inputSchema: {
        path: z.string().optional().describe("A .pro file or a folder."),
        limit: z.number().int().min(1).max(1000).optional().describe("Maximum files listed (default 100)."),
        rules: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Rules to run instead of the team's rules.json, in the same shape: to try a rule before saving it."),
        lang: z.enum(["en", "fr"]).optional().describe("The language of each finding's message (default en)."),
        // Read only writes nothing, so it is not even offered.
        ...(options.readOnly ? {} : { out: OUT.optional() }),
      },
      annotations: options.readOnly ? READ_ONLY : { ...READ_ONLY, readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ out, ...args }: { out?: string } & Parameters<typeof checkPresentations>[1]) =>
      inLibrary((root) => (out === undefined ? checkPresentations(root, args, options.rulesDirs) : checkToOut(root, { ...args, out }, options.rulesDirs)))
  );

  server.registerTool(
    "read_rules",
    {
      title: "Read the team's rules",
      description:
        "Read the team's RULES.md, written in their own words and language, and the rules.json compiled from it, " +
        "with every check a compiled rule can use and what it takes. `stale` is true when RULES.md has changed since " +
        "rules.json was compiled. To compile: one rule per rule the prose states, each { id (ASCII, the team's own " +
        "name), check, tier (1: fixes safe in bulk, 2: reviewed case by case, 3: last, or \"off\"), libraries? " +
        "(names of the libraries it applies to), and the check's parameters }; every exception the prose grants as " +
        "{ rule, song?, library?, value?, reason }. Show the person the compiled rules before saving them, and hand " +
          "save_rules the `markdown.sha256` given here as `compiledFrom`.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => answer(() => readRules(options.rulesDirs ?? []))
  );

  server.registerTool(
    "read_media_bin",
    {
      title: "Read the media bin",
      description:
        "Read ProPresenter's media bin: every playlist and the media items in it, with any mirroring, " +
        "rotation, crop or effects applied to each.",
      inputSchema: MEDIA_BIN_INPUT,
      annotations: READ_ONLY,
    },
    ({ path: file }) => inLibrary((root) => readMediaBin(root, file))
  );

  server.registerTool(
    "audit_media_bin",
    {
      title: "Audit the media bin",
      description:
        "Audit the media bin: duplicates within and across playlists, deliberate variants of one file, " +
        "empty playlists, hidden items, items on external volumes and names that do not match their file.",
      inputSchema: MEDIA_BIN_INPUT,
      annotations: READ_ONLY,
    },
    ({ path: file }) => inLibrary((root) => auditMediaBin(root, file))
  );

  server.registerTool(
    "read_playlists",
    {
      title: "Read the presentation playlists",
      description:
        "Read ProPresenter's presentation playlists (the services built from songs, headers and media, as " +
        "opposed to the media bin): every playlist and its entries in order. A presentation or media entry's " +
        "`file` is an absolute path wherever one can be worked out, and a presentation's can be " +
        "passed to read_presentation; `arrangement` is the arrangement it plays, when it names one.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe("The presentation playlists file. Defaults to Playlists/Library in the library folder."),
      },
      annotations: READ_ONLY,
    },
    ({ path: file }) => inLibrary((root) => readPlaylists(root, file))
  );

  server.registerTool(
    "list_themes",
    {
      title: "List themes",
      description:
        "List ProPresenter's themes and the slide styles each offers, in the theme's own order, with how " +
        "many text boxes each style has. A theme that cannot be read is listed under `unreadable` with why.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => inLibrary((root) => listThemes(root))
  );

  server.registerTool(
    "preview_style",
    {
      title: "Preview applying a style",
      description:
        "Preview giving a presentation's slides the look of a theme's slide style or of another " +
        "presentation's slide, as ProPresenter's 'apply theme slide' does, without changing anything: " +
        "nothing is written. For each slide: whether it would be restyled, and the lines each text box would " +
        "carry afterwards; or `skip`, why it would be left alone. `listed`: in skipSlides. `macro`: " +
        "triggers a macro in skipMacros. `distinctMacro`: carries a different macro from most slides, " +
        "usually a title slide. `otherElements`: holds an image or shape restyling would remove (set " +
        "replaceOtherElements to include it). `moreTextThanStyle`: has more text boxes than the style. " +
        "`notASlide`: not a slide. `fidelity` 'lossy' means applying would be refused.",
      inputSchema: {
        path: z.string().describe("The presentation to restyle."),
        theme: z.string().optional().describe("Take the style from this theme, by name as list_themes gives it."),
        fromPresentation: z.string().optional().describe("Or take it from a slide of this presentation."),
        style: z
          .union([z.string(), z.number().int().min(0)])
          .optional()
          .describe(
            "With theme: the style's name or styleIndex (optional when the theme has one). With " +
              "fromPresentation: the slideIndex of the slide to copy, as read_presentation gives it."
          ),
        skipSlides: z.array(z.number().int().min(0)).optional().describe("slideIndexes to leave alone."),
        skipMacros: z.array(z.string()).optional().describe("Leave alone any slide triggering one of these macros."),
        skipDistinctMacro: z
          .boolean()
          .optional()
          .describe("Leave alone slides carrying a different macro from most (default true)."),
        replaceOtherElements: z
          .boolean()
          .optional()
          .describe("Restyle slides holding images or shapes too, which removes them (default false)."),
      },
      annotations: READ_ONLY,
    },
    (args) => inLibrary((root) => previewStyle(root, args))
  );

  registerLibraryTools(server, library);

  if (!options.readOnly) {
    registerOutTools(server, library, options);
    const editing = [
      ...registerEditTools(server, library, options),
      server.registerTool(
        "save_rules",
        {
          title: "Save the team's compiled rules",
          description:
            "Write rules.json beside the team's RULES.md, compiled from it as read_rules describes, after checking " +
            "it: every problem is listed and nothing is written until there are none. Stamps RULES.md's current hash, " +
            "so a later change to it shows as stale. Writes no ProPresenter file. Show the person the rules first.",
          inputSchema: {
            rules: z.record(z.string(), z.unknown()).describe("The whole rules.json: { version: 1, rules: [...], exceptions: [...] }."),
            compiledFrom: z
              .string()
              .describe("The sha256 read_rules gave with RULES.md: the rules are refused if the file has changed since."),
          },
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        ({ rules, compiledFrom }) => inLibrary((root) => saveRulesFile(options.rulesDirs ?? [], rules, root, compiledFrom))
      ),
    ];
    // Offered only while the library open can be backed up: no backup, no write.
    const offer = (open: OpenLibrary | undefined) => {
      for (const tool of editing) {
        if (open?.backupDir) tool.enable();
        else tool.disable();
      }
    };
    offer(library.peek());
    library.onChange(offer);
  }

  return server;
}
