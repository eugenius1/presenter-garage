import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { version } from "../package.json";
import { LibraryError } from "@presenter-garage/node/library";
import { defaultBackupDir } from "@presenter-garage/node/write";
import { applyPlan, confirmationRequest, MAX_PLAN_LINES, planSlideEdits, PlanStore, type ApplyResult } from "./edits";
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
  searchText,
} from "./tools";

/**
 * An MCP server that reads, and edits the slide text of, a ProPresenter 7
 * library on disk. Started by `main.ts`; built separately so tests can drive
 * it over an in-memory pipe.
 *
 * ProPresenter's own network API can show and trigger slides but cannot edit
 * them; this works on the files instead, through the same decoding, checks
 * and write path the browser app uses. Started with `readOnly`, the two
 * editing tools are not offered at all, so a model never sees them.
 */

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

/** How long a person has to read and answer the confirmation: as long as a plan lives. */
const CONFIRM_TIMEOUT_MS = 60 * 60 * 1000;

export interface ServerOptions {
  /** Offer no tool that writes. */
  readOnly?: boolean;
  /** Where backups go before a file is changed. Defaults to `defaultBackupDir()`. */
  backupDir?: string;
  /**
   * Things a model must know before trusting what it reads, added to the
   * server's instructions: that a folder is a copy ProPresenter no longer
   * updates, say.
   */
  notes?: readonly string[];
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
 * Characters that show as nothing, or as an ordinary space: non-breaking and
 * other Unicode spaces, zero-width characters, bidirectional marks,
 * embeddings and isolates (U+2066-U+2069), the other invisible format
 * controls up to U+206F, the soft hyphen and the byte-order mark.
 */
const INVISIBLE = /[\u00a0\u00ad\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]/g;

/**
 * JSON with every invisible character written as its `\uXXXX` escape.
 *
 * A reader of the text sees `Couplet\u00a01` where a raw non-breaking space
 * would look exactly like `Couplet 1`, and ProPresenter treats the two as
 * different group names. Parsed, the escape is the character itself, so
 * nothing is lost: a name or a line handed back reads exactly as stored.
 * Safe to do to the whole text because those characters can only be inside
 * a JSON string, where an escape means the same thing.
 */
export function toJson(value: unknown): string {
  return JSON.stringify(value).replace(INVISIBLE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * Wrap a tool's answer for the wire.
 *
 * A `LibraryError` is something the model can act on -- a wrong path, a file
 * that is a chord chart -- so it goes back as a tool error rather than a
 * protocol failure, which a client may show to nobody.
 */
async function answer(run: () => Promise<unknown>) {
  try {
    return { content: [{ type: "text" as const, text: toJson(await run()) }] };
  } catch (e) {
    if (!(e instanceof LibraryError)) throw e;
    return { isError: true, content: [{ type: "text" as const, text: e.message }] };
  }
}

export function createServer(roots: readonly string[], options: ServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: "presenter-garage", version },
    {
      instructions:
        `Reads ProPresenter 7 files under: ${roots.join(", ")}. ` +
        "Paths may be absolute or relative to those folders. " +
        (options.readOnly
          ? "Nothing is written."
          : "Slide text can be edited with plan_slide_edits then apply_slide_edits; the person is asked to " +
            "confirm every line before anything is written, and each file is backed up first.") +
        (options.notes?.length ? ` Important: ${options.notes.join(" ")}` : ""),
    }
  );

  server.registerTool(
    "list_presentations",
    {
      title: "List presentations",
      description:
        "List ProPresenter presentation (.pro) files in the library folders, optionally filtered by a " +
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
    (args) => answer(() => listPresentations(roots, args))
  );

  server.registerTool(
    "read_presentation",
    {
      title: "Read a presentation",
      description:
        "Read a presentation's slides: label, arrangement group, the macros each triggers (`name` as the " +
        "slide records it, `uuid`, and `disabled` for one switched off) and the text of every text box, line " +
        "by line. Names and text are exact; an invisible character such as a non-breaking space is written " +
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
    ({ path: file }) => answer(() => readPresentationFile(roots, file))
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
    () => answer(() => readConfiguration(roots))
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
        folder: z.string().optional().describe("Search only this folder, e.g. one library."),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum matches (default 50)."),
      },
      annotations: READ_ONLY,
    },
    (args) => answer(() => searchText(roots, args))
  );

  server.registerTool(
    "check_presentations",
    {
      title: "Check presentation text",
      description:
        "Run the text checks from Presenter Garage's Presentations tool: leading/trailing/repeated " +
        "spaces, blank lines inside a slide, and lines ending in a comma, semicolon or full stop. " +
        "Takes one .pro file or a folder; with neither, checks every library. Lists only files with findings.",
      inputSchema: {
        path: z.string().optional().describe("A .pro file or a folder."),
        limit: z.number().int().min(1).max(1000).optional().describe("Maximum files listed (default 100)."),
      },
      annotations: READ_ONLY,
    },
    (args) => answer(() => checkPresentations(roots, args))
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
    ({ path: file }) => answer(() => readMediaBin(roots, file))
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
    ({ path: file }) => answer(() => auditMediaBin(roots, file))
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
    ({ path: file }) => answer(() => readPlaylists(roots, file))
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
    () => answer(() => listThemes(roots))
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
    (args) => answer(() => previewStyle(roots, args))
  );

  if (!options.readOnly) registerEditTools(server, roots, options.backupDir ?? defaultBackupDir());

  return server;
}

/**
 * The two tools that edit. Kept apart so a read-only server never registers
 * them, and so the person's answer is fetched here -- by the server, from the
 * client -- where the model cannot supply it.
 */
function registerEditTools(server: McpServer, roots: readonly string[], backupDir: string): void {
  const plans = new PlanStore();

  server.registerTool(
    "plan_slide_edits",
    {
      title: "Plan slide text edits",
      description:
        "Work out changes to the text of slides, writing nothing. Each edit names a line by the `path`, " +
        "`boxIndex` and `lineIndex` read_presentation or search_text gave it, and the whole text the line " +
        "should read afterwards, or null to remove the line. Only what differs is touched, so formatting " +
        "elsewhere on the line is kept. Returns a `planId` and every line as it is and as it would read; " +
        "in a ProPresenter 22 workspace a line's `styling` says what the change does to formatting ranges on it " +
        "(All Caps, say), which the person sees too. " +
        "If any edit cannot be made, nothing is planned and the error says which. " +
        "Then call apply_slide_edits with the planId: the person is asked there, by their app, to confirm.",
      inputSchema: {
        edits: z
          .array(
            z.object({
              path: z.string().describe("The .pro file."),
              boxIndex: z.number().int().min(0),
              lineIndex: z.number().int().min(0),
              text: z
                .string()
                .nullable()
                .describe("The line's whole new text, on one line; null removes the line."),
            })
          )
          .min(1)
          .max(MAX_PLAN_LINES),
      },
      annotations: READ_ONLY,
    },
    ({ edits }) => answer(() => planSlideEdits(roots, plans, edits))
  );

  server.registerTool(
    "apply_slide_edits",
    {
      title: "Apply planned slide edits",
      description:
        "Apply a plan from plan_slide_edits, once the person confirms it. Their app shows them every line " +
        "as it is and as it would read, and they can untick any; only ticked lines are written. Each file is " +
        "backed up outside the library first, checked, and read back once written; a file that changed " +
        "since the plan was made is left alone. A plan is used once, whatever the answer. Needs an MCP " +
        "client that can ask its user a question (elicitation); with one that cannot, nothing is written.",
      inputSchema: { planId: z.string().describe("The planId plan_slide_edits returned.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    ({ planId }, { signal }) =>
      answer(async (): Promise<ApplyResult> => {
        const plan = plans.take(planId);
        if (!plan) throw new LibraryError("No such plan, or it was already used or has expired. Plan the edits again.");

        // A form, specifically: a client offering only URL elicitation cannot show tick boxes.
        if (!server.server.getClientCapabilities()?.elicitation?.form) {
          throw new LibraryError(
            "This MCP client cannot ask its user to confirm a change, so nothing was written. Edit in a client " +
              "that supports elicitation, or with the Presenter Garage web app."
          );
        }
        let reply;
        try {
          // The SDK's default is a minute, which is not long enough to read a song's worth of lines.
          // The call's own signal too: a client that gives up on the tool call
          // must not have the file changed behind it by a late answer.
          reply = await server.server.elicitInput(confirmationRequest(plan, backupDir), {
            timeout: CONFIRM_TIMEOUT_MS,
            signal,
          });
        } catch (e) {
          throw new LibraryError(
            `No answer came back from the confirmation (${(e as Error).message}), so nothing was written. Plan the edits again.`
          );
        }
        if (reply.action !== "accept") return { answer: reply.action, files: [] };
        if (signal.aborted) throw new LibraryError("The call was cancelled before the answer came back, so nothing was written.");

        // Only a line the person left ticked counts; one their client did not send back does not.
        const ticked = new Set(
          Object.entries(reply.content ?? {})
            .filter(([, value]) => value === true)
            .map(([key]) => Number(key.replace(/^line/, "")))
        );
        return { answer: "accept", ...(await applyPlan(roots, plan, ticked, backupDir, signal)) };
      })
  );
}
