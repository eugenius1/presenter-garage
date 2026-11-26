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
  type RequestedChange,
} from "@presenter-garage/node/edits";
import { CONTEXT_SLIDES, macroNames, slideHeading, type ContextSlide } from "@presenter-garage/core/lib/slide-context";
import { colorName, type StructureChange } from "@presenter-garage/core/lib/structure";
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

/** Where a structural change is, for its tick box's title. */
function changeWhere(change: StructureChange): string {
  if (change.kind === "swapMacro") return [`slide ${change.slideIndex + 1}`, change.groupName].filter(Boolean).join(", ");
  const slides = change.slides.map((i) => i + 1);
  const held = slides.length === 0 ? "no slides" : slides.length === 1 ? `slide ${slides[0]}` : `slides ${slides.join(", ")}`;
  return `group ${change.groupIndex + 1}, ${held}`;
}

/**
 * A structural change as it is and as it would be, every part of it that
 * changes said: a group's name, its colour and the configured group it is
 * tied to; a macro, and the collection the slide records it in.
 */
export function describeChange(change: StructureChange): string {
  if (change.kind === "swapMacro") {
    const { before, after } = change;
    const collection =
      after.collection && after.collection.name !== before.collection?.name
        ? ` The slide records it in collection “${after.collection.name}” instead of “${before.collection?.name ?? ""}”.`
        : "";
    return `Macro swapped: “${before.name}” → “${after.name}”.${collection}`;
  }
  const { before, after } = change;
  const said = [`Group renamed: “${before.name}” → “${after.name}”.`];
  if (colorName(before.color) !== colorName(after.color)) said.push(`Colour: ${colorName(before.color)} → ${colorName(after.color)}, as the configured group has it.`);
  if (before.link && !after.link) said.push(`No longer tied to configured group “${before.link.name ?? before.link.uuid}”, which it would no longer be.`);
  else if (after.link && (after.link.uuid !== before.link?.uuid || after.link.name !== before.link?.name)) {
    said.push(`Tied to configured group “${after.link.name}” instead of “${before.link?.name ?? before.link?.uuid}”.`);
  }
  said.push("Arrangements name groups by uuid, which does not change, so each keeps the group where it was.");
  return said.join(" ");
}

/** A confirmation form: one tick box per change, all ticked, each saying what it changes and showing the slides around it. */
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
    for (const { change, n } of file.changes) {
      properties[`change${n}`] = {
        type: "boolean",
        title: `${n}. ${file.name} (${changeWhere(change)})`,
        description: describeChange(change) + (around.get(n) ?? ""),
        default: true,
      };
    }
  }
  const count = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  const lines = plan.files.reduce((sum, f) => sum + f.lines.length, 0);
  const changes = plan.files.reduce((sum, f) => sum + f.changes.length, 0);
  const what = [lines && count(lines, "line"), changes && count(changes, "other change")].filter(Boolean).join(" and ");
  const closed = plan.files.some((file) => file.workspace)
    ? "Quit ProPresenter first: while it has the workspace open, nothing is written."
    : "If ProPresenter has one of these open, close it first: ProPresenter may save its own copy over the change.";
  return {
    message:
      `Make ${what} in ${count(plan.files.length, "presentation")}? ` +
      `Untick any change to leave that as it is. Each presentation is backed up to ${backupDir} before it is changed. ` +
      closed +
      ` Under each change are the ${CONTEXT_SLIDES} slides either side of it as they read now, to read it by: ` +
      "⏎ between lines, ‖ between text boxes, ∅ for a blank line or a slide with no text. " +
      "Nothing there changes but the line marked ⟦n: …⟧, which change n changes, and ⟦n: added⟧, where change n adds a line; " +
      "a group name or macro marked ⟦n: …⟧ is the one change n renames or swaps. " +
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
  const slidesOf = (change: StructureChange) => (change.kind === "renameGroup" ? change.slides : [change.slideIndex]);
  const everything = [
    ...file.lines.map(({ n, fix }) => ({ n, slides: [fix.slideIndex] })),
    ...file.changes.map(({ n, change }) => ({ n, slides: slidesOf(change) })),
  ].sort((a, b) => a.n - b.n);
  for (const run of runs(file.context ?? [])) {
    const first = run[0].slideIndex;
    const last = run.at(-1)!.slideIndex;
    const inRun = everything.filter(({ slides }) => slides.some((i) => i >= first && i <= last));
    if (inRun.length === 0) continue;
    const span = first === last ? `Slide ${first + 1}` : `Slides ${first + 1}–${last + 1}`;
    out.set(inRun[0].n, `\n\n${span}:\n${run.map((slide) => slideText(slide, file)).join("\n")}`);
    for (const { n } of inRun.slice(1)) if (!out.has(n)) out.set(n, `\n\n${span}: shown under change ${inRun[0].n}.`);
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

/**
 * One slide on one line: number, group and macros, then its lines, each
 * change on it marked where it falls. The marks and separators are ones
 * lyrics do not use: French sets its quotes in « », and a line can hold a
 * slash, or read "(blank)".
 */
function slideText(slide: ContextSlide, file: PlannedFile): string {
  const here = file.lines.filter(({ fix }) => fix.slideIndex === slide.slideIndex);
  const added = (side: "before" | "after", at: PlannedFile["lines"]) =>
    at.filter(({ fix }) => fix.insert === side).map(({ n }) => `⟦${n}: added⟧`);
  const boxes: string[][] = [];
  let box: number | undefined;
  for (const line of slide.lines) {
    if (line.boxIndex !== box) boxes.push([]);
    box = line.boxIndex;
    const at = here.filter(({ fix }) => fix.boxIndex === line.boxIndex && fix.lineIndex === line.lineIndex);
    const text = line.text === "" ? "∅" : line.text;
    const changed = at.find(({ fix }) => !fix.insert);
    boxes.at(-1)!.push(...added("before", at), changed ? `⟦${changed.n}: ${text}⟧` : text, ...added("after", at));
  }
  // A group renamed, or a macro swapped, marked where the heading names it.
  let group = slide.groupName ?? "";
  const macros = macroNames(slide.macros);
  let structural = false;
  for (const { n, change } of file.changes) {
    if (change.kind === "renameGroup" && change.slides.includes(slide.slideIndex)) group = `⟦${n}: ${group}⟧`;
    else if (change.kind === "swapMacro" && change.slideIndex === slide.slideIndex && macros[change.macroIndex] !== undefined) {
      macros[change.macroIndex] = `⟦${n}: ${macros[change.macroIndex]}⟧`;
    } else continue;
    structural = true;
  }
  const head = slideHeading(slide.slideIndex, group, macros, here.length > 0 || structural);
  return `${head}: ${boxes.length ? boxes.map((lines) => lines.join(" ⏎ ")).join(" ‖ ") : "∅"}`;
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
      title: "Plan slide edits",
      description:
        "Work out changes to slides, writing nothing: their text (`edits`), and their structure -- a group renamed " +
        "(`renameGroups`), a macro on a slide swapped for another (`swapMacros`). Each text edit names a line by the `path`, " +
        "`boxIndex` and `lineIndex` read_presentation or search_text gave it, and the whole text the line " +
        "should read afterwards, or null to remove the line. Only what differs is touched, so formatting " +
        "elsewhere on the line is kept. With `insert`, the edit adds `text` as a new line after (or before) " +
        "that line instead, leaving it as it is; the new line takes its All Caps, and several added on one " +
        "side of one line read in the order given. Line indexes always name lines as they read now, before " +
        "any edit. A group is named by its `groupIndex` in read_presentation's `groups`, and renamed to exactly " +
        "the name given (a non-breaking space is a different name); a name in ProPresenter's configured groups " +
        "(read_configuration) brings that group's colour with it. A macro is named on its slide by name or uuid, " +
        "and swapped for a configured macro, named the same way. Returns a `planId`, every line as it is and as " +
        "it would read (an added line with `before` null), and every structural change as it is and as it would " +
        "be; a line's `styling` says what the change does to formatting ranges on it (All Caps, say), which the " +
        "person sees too. If any edit cannot be made, nothing is planned and the error says which. " +
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
          .max(MAX_PLAN_LINES)
          .optional(),
        renameGroups: z
          .array(
            z.object({
              path: z.string().describe("The .pro file."),
              groupIndex: z.number().int().min(0).describe("The group's `groupIndex` in read_presentation's `groups`."),
              name: z.string().describe("The group's whole new name."),
            })
          )
          .max(MAX_PLAN_LINES)
          .optional(),
        swapMacros: z
          .array(
            z.object({
              path: z.string().describe("The .pro file."),
              slideIndex: z.number().int().min(0),
              from: z.string().describe("The macro on the slide to replace, by name or uuid."),
              to: z.string().describe("The configured macro to put in its place, by name or uuid."),
            })
          )
          .max(MAX_PLAN_LINES)
          .optional(),
      },
      annotations: READ_ONLY,
    },
    ({ edits = [], renameGroups = [], swapMacros = [] }) =>
      answer(async () => {
        const open = await editable();
        const structural: RequestedChange[] = [
          ...renameGroups.map((r) => ({ kind: "renameGroup" as const, ...r })),
          ...swapMacros.map((r) => ({ kind: "swapMacro" as const, ...r })),
        ];
        const planned = await planSlideEdits([open.root], plans, edits, structural);
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
        "Apply a plan from plan_slide_edits, once the person confirms it. Their app shows them every change " +
        "as it is and as it would be, and they can untick any; only ticked changes are written. Each file is " +
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
            .map(([key]) => Number(key.replace(/^(line|change)/, "")))
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
