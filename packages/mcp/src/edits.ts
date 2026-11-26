import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createI18n } from "@presenter-garage/core/i18n/core";
import {
  applyPlan as applyShared,
  MAX_PLAN_LINES,
  planSlideEdits,
  PlanStore,
  type AppliedFile,
  type Plan,
  type PlannedFile,
} from "@presenter-garage/node/edits";
import { CONTEXT_SLIDES, shownGroupName, type ContextSlide } from "@presenter-garage/core/lib/slide-context";
import { LibraryError } from "@presenter-garage/node/library";
import { answer, CONFIRM_TIMEOUT_MS, READ_ONLY } from "./answer";
import { refuseUnlessOpen, type Library, type OpenLibrary } from "./library";

export { MAX_PLAN_LINES, planSlideEdits, PlanStore, type Plan } from "@presenter-garage/node/edits";

/**
 * The MCP server's half of editing slide text: its two tools, the
 * confirmation it asks the person through elicitation, and the outcome in a
 * model's words. Planning
 * and applying are `packages/node/src/edits.ts`, shared with the desktop
 * app, so there is one write path. See AGENTS.md for the four guards and
 * where each is kept on this surface.
 */

const { t } = createI18n("en");
const refusals = t.tools.presentations.refusals;

/** A confirmation form: one tick box per line, all ticked, each saying what it changes and showing the slides around it. */
export function confirmationRequest(plan: Plan, backupDir: string) {
  const properties: Record<string, { type: "boolean"; title: string; description: string; default: boolean }> = {};
  for (const file of plan.files) {
    const around = contextOf(file);
    for (const { fix, n, styling } of file.lines) {
      // Box and line too: a slide can hold the same line twice, and a person
      // choosing one of them has to be able to tell which.
      const where = [
        `slide ${fix.slideIndex + 1}`,
        fix.groupName,
        `text box ${fix.boxIndex + 1}, ${fix.insert ? `new line ${fix.insert} line` : "line"} ${fix.lineIndex + 1}`,
      ]
        .filter(Boolean)
        .join(", ");
      properties[`line${n}`] = {
        type: "boolean",
        title: `${n}. ${file.name} (${where})`,
        // An added line as it would read, and the line it goes beside as it
        // reads now, so it can be placed without the slide in front of them.
        description:
          (fix.insert
            ? `Added ${fix.insert} ${fix.before ? `“${fix.before}”` : "an empty line"}: “${fix.after}”`
            : `“${fix.before}” → ${fix.after === null ? "line removed" : `“${fix.after}”`}`) +
          (styling ? `. Styling: ${styling.join("; ")}.` : "") +
          (around.get(n) ?? ""),
        default: true,
      };
    }
  }
  const count = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  const closed = plan.files.some((file) => file.workspace)
    ? "Quit ProPresenter first: while it has the workspace open, nothing is written."
    : "If ProPresenter has one of these open, close it first: ProPresenter may save its own copy over the change.";
  return {
    message:
      `Change ${count(plan.files.reduce((sum, f) => sum + f.lines.length, 0), "line")} in ${count(plan.files.length, "presentation")}? ` +
      `Untick any line to leave it as it is. Each presentation is backed up to ${backupDir} before it is changed. ` +
      closed +
      ` Under each change are the slides ${CONTEXT_SLIDES} either side of it as they read now, to read it by; ` +
      "nothing there changes but the lines marked «n: …» for change n, and «n: added» where line n is added. " +
      "A > marks a slide holding a change.",
    requestedSchema: { type: "object" as const, properties },
  };
}

/**
 * The slides around a file's changes, as text to put under each change:
 * the whole run under the first change in it, and a pointer to that under
 * the others, so changes close together share their context instead of
 * repeating it. Compact, since a client's form is no reading pane. Display
 * only: nothing here is a field, so nothing here can be ticked or written.
 */
function contextOf(file: PlannedFile): Map<number, string> {
  const out = new Map<number, string>();
  for (const run of runs(file.context ?? [])) {
    const first = run[0].slideIndex;
    const last = run.at(-1)!.slideIndex;
    const inRun = file.lines.filter(({ fix }) => fix.slideIndex >= first && fix.slideIndex <= last);
    if (inRun.length === 0) continue;
    const span = first === last ? `Slide ${first + 1}` : `Slides ${first + 1}–${last + 1}`;
    out.set(inRun[0].n, `\n\n${span}:\n${run.map((slide) => slideText(slide, inRun)).join("\n")}`);
    for (const { n } of inRun.slice(1)) out.set(n, `\n\n${span}: shown under change ${inRun[0].n}.`);
  }
  return out;
}

/** Slides that follow one another, each run one stretch of context. */
function runs(slides: readonly ContextSlide[]): ContextSlide[][] {
  const out: ContextSlide[][] = [];
  for (const slide of slides) {
    const run = out.at(-1);
    if (run && run.at(-1)!.slideIndex === slide.slideIndex - 1) run.push(slide);
    else out.push([slide]);
  }
  return out;
}

/** One slide on one line: number, group and macros, then its lines, each change on it marked where it falls. */
function slideText(slide: ContextSlide, changes: PlannedFile["lines"]): string {
  const here = changes.filter(({ fix }) => fix.slideIndex === slide.slideIndex);
  const macros = slide.macros.length ? ` (${slide.macros.map((m) => (m.enabled ? m.name : `${m.name}, off`)).join("; ")})` : "";
  const texts: string[] = [];
  for (const line of slide.lines) {
    const at = here.filter(({ fix }) => fix.boxIndex === line.boxIndex && fix.lineIndex === line.lineIndex);
    const text = line.text === "" ? "(blank)" : line.text;
    texts.push(...at.filter(({ fix }) => fix.insert === "before").map(({ n }) => `«${n}: added»`));
    const changed = at.find(({ fix }) => !fix.insert);
    texts.push(changed ? `«${changed.n}: ${text}»` : text);
    texts.push(...at.filter(({ fix }) => fix.insert === "after").map(({ n }) => `«${n}: added»`));
  }
  const head = `${here.length ? ">" : " "} ${slide.slideIndex + 1} [${shownGroupName(slide.groupName ?? "")}]${macros}`;
  return `${head}: ${texts.length ? texts.join(" / ") : "(no text)"}`;
}

export interface ApplyResult {
  /** What the person answered. Nothing is written unless they accepted. */
  answer: "accept" | "decline" | "cancel";
  backupFolder?: string;
  files: Omit<AppliedFile, "rangeReason">[];
}

/** Apply what the person left ticked in the one library open, each refusal said in the app's own English sentence. */
export async function applyPlan(
  root: string,
  plan: Plan,
  ticked: ReadonlySet<number>,
  backupDir: string,
  signal?: AbortSignal
): Promise<Omit<ApplyResult, "answer">> {
  const run = await applyShared([root], plan, ticked, backupDir, signal);
  return {
    backupFolder: run.backupFolder,
    files: run.files.map((file) =>
      file.reason ? { ...file, detail: [refusals[file.reason], file.detail].filter(Boolean).join(": ") } : file
    ),
  };
}

/** How many plans' libraries are remembered: more than the plan store keeps. */
const MAX_REMEMBERED_PLANS = 50;

/**
 * The two tools that edit, returned so the server can offer them only while
 * the library open can be backed up. Kept apart so a read-only server never
 * registers them, and so the person's answer is fetched here -- by the
 * server, from the client -- where the model cannot supply it.
 */
export function registerEditTools(server: McpServer, library: Library): RegisteredTool[] {
  const plans = new PlanStore();
  /** The library each plan was made in: applied anywhere else, its paths and backups would be another library's. */
  const madeIn = new Map<string, OpenLibrary & { backupDir: string }>();

  /** The library open now, if slide text can be edited in it. */
  const editable = async () => {
    const open = await library.get();
    if (!open.backupDir) throw new LibraryError(`Slide text cannot be edited in ${open.root}: ${open.notes.join(" ")}`);
    return open as OpenLibrary & { backupDir: string };
  };

  const plan = server.registerTool(
    "plan_slide_edits",
    {
      title: "Plan slide text edits",
      description:
        "Work out changes to the text of slides, writing nothing. Each edit names a line by the `path`, " +
        "`boxIndex` and `lineIndex` read_presentation or search_text gave it, and the whole text the line " +
        "should read afterwards, or null to remove the line. Only what differs is touched, so formatting " +
        "elsewhere on the line is kept. With `insert`, the edit adds `text` as a new line after (or before) " +
        "that line instead, leaving it as it is; the new line takes its All Caps, and several added on one " +
        "side of one line read in the order given. Line indexes always name lines as they read now, before " +
        "any edit. Returns a `planId` and every line as it is and as it would read (an added line with " +
        "`before` null); a line's `styling` says what the change does to formatting ranges on it " +
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
                .describe("The line's whole new text, on one line; null removes the line. With `insert`, the added line's text."),
              insert: z
                .enum(["after", "before"])
                .optional()
                .describe("Add `text` as a new line on this side of the line, instead of changing the line."),
            })
          )
          .min(1)
          .max(MAX_PLAN_LINES),
      },
      annotations: READ_ONLY,
    },
    ({ edits }) =>
      answer(async () => {
        const open = await editable();
        const planned = await planSlideEdits([open.root], plans, edits);
        madeIn.set(planned.planId, open);
        while (madeIn.size > MAX_REMEMBERED_PLANS) madeIn.delete(madeIn.keys().next().value!);
        return planned;
      })
  );

  const apply = server.registerTool(
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
        const made = madeIn.get(planId);
        madeIn.delete(planId);
        if (!plan || !made) throw new LibraryError("No such plan, or it was already used or has expired. Plan the edits again.");
        // Refused before the person is asked anything when another library is open already.
        refuseUnlessOpen(made, await library.get().catch(() => undefined));

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
          reply = await server.server.elicitInput(confirmationRequest(plan, made.backupDir), {
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
        // Asked again once this apply's turn comes -- another library can have been opened while the person
        // read the lines, or while this waited behind another apply -- and no switch lands while it writes.
        return {
          answer: "accept",
          ...(await library.whileOpen(made, () => applyPlan(made.root, plan, ticked, made.backupDir, signal))),
        };
      })
  );
  return [plan, apply];
}
