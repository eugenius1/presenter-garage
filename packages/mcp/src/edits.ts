import { createI18n } from "@presenter-garage/core/i18n/core";
import { applyPlan as applyShared, type AppliedFile, type Plan } from "@presenter-garage/node/edits";

export { MAX_PLAN_LINES, planSlideEdits, PlanStore, type Plan } from "@presenter-garage/node/edits";

/**
 * The MCP server's half of editing slide text: the confirmation it asks the
 * person through elicitation, and the outcome in a model's words. Planning
 * and applying are `packages/node/src/edits.ts`, shared with the desktop
 * app, so there is one write path. See AGENTS.md for the four guards and
 * where each is kept on this surface.
 */

const { t } = createI18n("en");
const refusals = t.tools.presentations.refusals;

/** A confirmation form: one tick box per line, all ticked, each saying what it changes. */
export function confirmationRequest(plan: Plan, backupDir: string) {
  const properties: Record<string, { type: "boolean"; title: string; description: string; default: boolean }> = {};
  for (const file of plan.files) for (const { fix, n, styling } of file.lines) {
    // Box and line too: a slide can hold the same line twice, and a person
    // choosing one of them has to be able to tell which.
    const where = [
      `slide ${fix.slideIndex + 1}`,
      fix.groupName,
      `text box ${fix.boxIndex + 1}, line ${fix.lineIndex + 1}`,
    ]
      .filter(Boolean)
      .join(", ");
    properties[`line${n}`] = {
      type: "boolean",
      title: `${n}. ${file.name} (${where})`,
      description:
        `“${fix.before}” → ${fix.after === null ? "line removed" : `“${fix.after}”`}` +
        (styling ? `. Styling: ${styling.join("; ")}.` : ""),
      default: true,
    };
  }
  const count = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  const closed = plan.files.some((file) => file.workspace)
    ? "Quit ProPresenter first: while it has the workspace open, nothing is written."
    : "If ProPresenter has one of these open, close it first: ProPresenter may save its own copy over the change.";
  return {
    message:
      `Change ${count(plan.files.reduce((sum, f) => sum + f.lines.length, 0), "line")} in ${count(plan.files.length, "presentation")}? ` +
      `Untick any line to leave it as it is. Each presentation is backed up to ${backupDir} before it is changed. ` +
      closed,
    requestedSchema: { type: "object" as const, properties },
  };
}

export interface ApplyResult {
  /** What the person answered. Nothing is written unless they accepted. */
  answer: "accept" | "decline" | "cancel";
  backupFolder?: string;
  files: Omit<AppliedFile, "rangeReason">[];
}

/** Apply what the person left ticked, each refusal said in the app's own English sentence. */
export async function applyPlan(
  roots: readonly string[],
  plan: Plan,
  ticked: ReadonlySet<number>,
  backupDir: string,
  signal?: AbortSignal
): Promise<Omit<ApplyResult, "answer">> {
  const run = await applyShared(roots, plan, ticked, backupDir, signal);
  return {
    backupFolder: run.backupFolder,
    files: run.files.map((file) =>
      file.reason ? { ...file, detail: [refusals[file.reason], file.detail].filter(Boolean).join(": ") } : file
    ),
  };
}
