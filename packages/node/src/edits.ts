/**
 * Editing slide text, in two steps with a person in between.
 *
 * Planning writes nothing: it works out every change and keeps the plan.
 * Applying takes the plan -- never the edits themselves, so what is applied
 * is exactly what was planned -- and the lines the person left ticked. See
 * AGENTS.md for the four guards and where each is kept.
 *
 * Planning is `planning.ts`, with the plan itself in `plans.ts` and the
 * styling of a workspace edit in `styling.ts`; applying is `apply.ts`.
 *
 * Shared by every surface that writes from Node, so there is one write path:
 * the MCP server plans from a model's edits and asks the person through MCP
 * elicitation; the desktop app plans from the lines a person ticked on
 * screen, the fixes worked out again here from what is on disk now.
 */

export { applyPlan, type AppliedFile } from "./apply";
export { planChosenFixes, planSlideEdits, readWithHash, type PlannedLine, type PlanResult, type RequestedEdit } from "./planning";
export { everyLine, MAX_PLAN_LINES, PlanStore, type Plan, type PlannedFile } from "./plans";
export { describeStyling } from "./styling";
