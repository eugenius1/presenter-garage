import { randomUUID } from "node:crypto";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_REVIEW_LINES, newPlan, planFiles, planView, type RequestedChange, type RequestedEdit } from "@presenter-garage/node/edits";
import { absoluteFolder } from "@presenter-garage/node/commands/out-folder";
import { LibraryError } from "@presenter-garage/node/library";
import {
  changeNumbers,
  chosenNow,
  createReview,
  defaultReviewsDir,
  needNewPlan,
  readReview,
  recordRun,
  writeSnapshot,
  writtenIn,
  type Review,
} from "@presenter-garage/node/review";
import { answer, CONFIRM_TIMEOUT_MS, READ_ONLY } from "./answer";
import type { ApplyResult } from "./edits";
import { refuseUnlessOpen, type Library, type OpenLibrary } from "./library";
import { snapshotHtml } from "./review-page";
import { openInBrowser, reviewHost } from "./review-server";
import { beforeWriting, count } from "./wording";

/**
 * Choosing slide edits on a review page rather than in a form: a plan made
 * into a folder inside `out`, the page served on loopback, and an apply that
 * writes what the person left ticked there. Planning and applying go through
 * `packages/node` as the form's do, so there is still one write path. See
 * docs/design/guard3-review-file.md, and AGENTS.md for the four guards.
 */

export interface ReviewOptions {
  /** Where plans' hashes are recorded. Defaults to the app's own `Reviews` folder; a test names its own. */
  reviewsDir?: string;
  /** Open the page in the system's browser. A test records the URL instead. */
  openUrl?: (url: string) => Promise<boolean>;
}

/** How the page reached the person: through their client, in the browser, or not at all. */
type Shown = "client" | "browser" | "declined" | "notOpened";

/** What applying a review answers: `ApplyResult`, and the person's notes, which say why they unticked what they did. */
export interface ReviewApplyResult extends Omit<ApplyResult, "answer"> {
  /** `notAsked` where the client cannot ask: the saved choices were taken as the person's. */
  answer: ApplyResult["answer"] | "notAsked" | "nothingChosen";
  review: string;
  notes: ReturnType<typeof reviewNotes>;
  /** Why the outcome is missing from `runs.json`, when it is. */
  unrecorded?: string;
}

/** The changes numbered `wanted`, as plan_slide_edits described them, each with whether it was left ticked. */
function described(review: Review, wanted: ReadonlySet<number>) {
  return planView(review.plan).flatMap((file) =>
    [...file.lines, ...file.changes]
      .filter(({ n }) => wanted.has(n))
      .map((change) => ({ path: file.path, presentation: file.name, ...change, ticked: review.choices.changes[change.n]?.ticked === true }))
  );
}

/** Every change the person left a note on, as plan_slide_edits described it, with whether it was left ticked. */
export function reviewNotes(review: Review) {
  const noted = new Set(changeNumbers(review.plan).filter((n) => review.choices.changes[n]?.note));
  return described(review, noted).map((change) => ({ ...change, note: review.choices.changes[change.n].note! }));
}

/** A review in counts, for a model: never its lines, which stay on disk. */
function summary(review: Review) {
  const lines = review.plan.files.reduce((sum, f) => sum + f.lines.length, 0);
  const structural = review.plan.files.reduce((sum, f) => sum + f.changes.length, 0);
  return {
    review: review.folder,
    presentations: review.plan.files.length,
    changes: { lines, structural },
    chosen: chosenNow(review).size,
    written: writtenIn(review).size,
    /** Whether the page has ever shown it to the person; nothing is applied until it has. */
    shown: review.choices.shown !== undefined,
  };
}

/** The one question asked before a review is applied, where the client can ask: the chosen set, presentation by presentation. */
export function summaryRequest(review: Review, chosen: ReadonlySet<number>) {
  const written = writtenIn(review);
  const open = changeNumbers(review.plan).filter((n) => !written.has(n)).length;
  const touched = review.plan.files.filter((f) => [...f.lines, ...f.changes].some(({ n }) => chosen.has(n)));
  const each = touched.map((f) => {
    const all = [...f.lines, ...f.changes].filter(({ n }) => !written.has(n));
    return `${f.name}: ${all.filter(({ n }) => chosen.has(n)).length} of ${all.length}`;
  });
  const { cloud, closed } = beforeWriting(touched);
  return {
    message:
      cloud +
      `Write ${chosen.size} of the ${count(open, "change")} you chose from, in ${count(touched.length, "presentation")} (${each.join("; ")})? ` +
      (written.size > 0 ? `${count(written.size, "change")} of this review were written by an earlier run, and are not written again. ` : "") +
      `Each presentation is backed up to ${review.backupDir} before it is changed. ${closed}`,
    requestedSchema: { type: "object" as const, properties: {} },
  };
}

export interface ReviewTools {
  /** The tools only reviews have, offered and withdrawn with the other editing tools. */
  tools: RegisteredTool[];
  plan(open: OpenLibrary & { backupDir: string }, edits: RequestedEdit[], structural: RequestedChange[], out: string, signal: AbortSignal): Promise<unknown>;
  apply(folder: string, signal: AbortSignal): Promise<ReviewApplyResult>;
}

export function registerReviewTools(
  server: McpServer,
  library: Library,
  applyPlan: (root: string, plan: Review["plan"], ticked: ReadonlySet<number>, backupDir: string, signal?: AbortSignal) => Promise<Omit<ApplyResult, "answer">>,
  options: ReviewOptions = {}
): ReviewTools {
  const reviewsDir = options.reviewsDir ?? defaultReviewsDir();
  const host = reviewHost(reviewsDir);
  const openUrl = options.openUrl ?? openInBrowser;
  const closed = server.server.onclose;
  server.server.onclose = () => {
    closed?.();
    void host.close();
  };

  /** Put the page in front of the person: their client's way where it has one, else the system's browser. */
  const show = async (url: string, signal: AbortSignal): Promise<Shown> => {
    if (server.server.getClientCapabilities()?.elicitation?.url) {
      try {
        const reply = await server.server.elicitInput(
          {
            mode: "url",
            message: "Open the page to choose which slide edits to make. Your choices are saved as you go.",
            url,
            elicitationId: randomUUID(),
          },
          { timeout: CONFIRM_TIMEOUT_MS, signal }
        );
        return reply.action === "accept" ? "client" : "declined";
      } catch (e) {
        // A client that gave up on the call wants nothing opened behind it.
        if (signal.aborted) throw e;
        // A client that says it can and then cannot: the browser, as for one that never said.
      }
    }
    return (await openUrl(url)) ? "browser" : "notOpened";
  };

  const opened = (shown: Shown) =>
    shown === "declined"
      ? "The person declined to open the page; it is at `url` whenever they want it."
      : shown === "notOpened"
        ? "The page could not be opened here: give the person `url` to open in their browser."
        : "The page is open for the person. Tell them to choose there, and to tell you when they are done.";

  /** The read-only snapshot, written beside the review; a snapshot that cannot be written costs nothing but itself. */
  const snapshot = (folder: string) => writeSnapshot(folder, reviewsDir, snapshotHtml).catch(() => undefined);

  const tools = [
    server.registerTool(
      "export_review",
      {
        title: "Save a read-only copy of a review",
        description:
          "Write review.html into the review folder: one page, opened from the disk with no server, showing every " +
          "change, the person's ticks and notes as they stand, and what each apply did. For the person to look at " +
          "during a break, or to send to someone. Replaces the copy there before; changes no choice.",
        inputSchema: { review: z.string().describe("The review folder plan_slide_edits made, as an absolute path.") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      ({ review }) => answer(async () => ({ file: await writeSnapshot(review, reviewsDir, snapshotHtml) }))
    ),
    server.registerTool(
      "open_review",
      {
        title: "Open a review of slide edits",
        description:
          "Show the person a review folder's page again -- after a break, or in a new session -- with their choices " +
          "as they left them. Writes nothing. Never tick, untick or note anything for the person, and never edit the " +
          "review folder's files: the choices are theirs.",
        inputSchema: { review: z.string().describe("The review folder plan_slide_edits made, as an absolute path.") },
        annotations: READ_ONLY,
      },
      ({ review }, { signal }) =>
        answer(async () => {
          const url = await host.serve(review);
          const shown = await show(url, signal);
          return { ...summary(await readReview(review, reviewsDir)), url, opened: shown, next: opened(shown) };
        })
    ),
    server.registerTool(
      "read_review",
      {
        title: "Read a review's choices and notes",
        description:
          "Read where a review stands, writing nothing: how many changes are chosen and written, what each apply " +
          "did, and every note the person left, with the change it is on as plan_slide_edits described it and " +
          "whether they left it ticked. Read the notes before planning again: they say why a change was unticked, " +
          "or what else to change, and may say a rule is wrong.",
        inputSchema: { review: z.string().describe("The review folder plan_slide_edits made, as an absolute path.") },
        annotations: READ_ONLY,
      },
      ({ review: folder }) =>
        answer(async () => {
          const review = await readReview(folder, reviewsDir);
          return {
            ...summary(review),
            notes: reviewNotes(review),
            // In a presentation an earlier apply wrote: plan these again to make them.
            needNewPlan: described(review, new Set(needNewPlan(review))),
            runs: review.runs.map((run) => ({
              at: run.at,
              written: run.written.length,
              files: run.files.map(({ name, written, reason, detail }) => ({ name, written, reason, detail })),
            })),
          };
        })
    ),
  ];

  return {
    tools,
    async plan(open, edits, structural, out, signal) {
      const files = await planFiles([open.root], edits, structural, MAX_REVIEW_LINES);
      const review = await createReview(absoluteFolder(out, "the review"), [open.root], newPlan(files), { root: open.root, backupDir: open.backupDir }, reviewsDir);
      const file = await snapshot(review.folder);
      const url = await host.serve(review.folder);
      const shown = await show(url, signal);
      return { ...summary(review), url, opened: shown, next: opened(shown), ...(file && { snapshot: file }) };
    },

    async apply(folder, signal) {
      const review = await readReview(folder, reviewsDir);
      const made = { root: review.root, backupDir: review.backupDir };
      // Refused before the person is asked anything when another library is open already.
      refuseUnlessOpen(made, await library.get().catch(() => undefined));
      // Every change starts ticked: a review nobody has opened would otherwise be applied whole, unseen.
      if (!review.choices.shown) {
        throw new LibraryError(
          "The person has not opened this review's page yet, so nothing was written. Open it with open_review, " +
            "and apply once they say they are done."
        );
      }
      const chosen = chosenNow(review);
      const notes = reviewNotes(review);
      if (chosen.size === 0) return { answer: "nothingChosen", review: review.folder, files: [], notes };

      let asked = false;
      if (server.server.getClientCapabilities()?.elicitation?.form) {
        let reply;
        try {
          reply = await server.server.elicitInput(summaryRequest(review, chosen), { timeout: CONFIRM_TIMEOUT_MS, signal });
        } catch (e) {
          throw new LibraryError(`No answer came back from the confirmation (${(e as Error).message}), so nothing was written.`);
        }
        if (reply.action !== "accept") return { answer: reply.action, review: review.folder, files: [], notes };
        asked = true;
      }
      if (signal.aborted) throw new LibraryError("The call was cancelled before anything was written, so nothing was.");

      const run = await library.whileOpen(made, () => applyPlan(review.root, review.plan, chosen, review.backupDir, signal));
      // Each change of a file that was written, so a later apply never writes it again.
      const byPath = new Map(review.plan.files.map((file) => [file.path, file]));
      const written = run.files
        .filter((file) => file.written)
        .flatMap((file) => [...byPath.get(file.path)!.lines, ...byPath.get(file.path)!.changes].map(({ n }) => n))
        .filter((n) => chosen.has(n));
      let unrecorded: string | undefined;
      try {
        await recordRun(review.folder, reviewsDir, { at: new Date().toISOString(), written, files: run.files });
      } catch (e) {
        // Written all the same, and said so. A file written has a new hash, so applying again cannot write it twice.
        unrecorded = `The outcome could not be saved in the review (${(e as Error).message}): its page will not show it.`;
      }
      await snapshot(review.folder);
      return { answer: asked ? "accept" : "notAsked", review: review.folder, ...run, notes, ...(unrecorded && { unrecorded }) };
    },
  };
}
