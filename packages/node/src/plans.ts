import { randomUUID } from "node:crypto";
import type { LineFix } from "@presenter-garage/core/lib/fixes";
import type { ContextSlide } from "@presenter-garage/core/lib/slide-context";

/**
 * A plan of slide-text edits, between being made and being applied: what
 * each surface hands from `planning.ts` to `apply.ts`, and keeps in between.
 */

/** Enough lines for a whole song's worth of corrections; a stop for a model asking to rewrite a library at once. */
export const MAX_PLAN_LINES = 200;

/** A plan nobody applied within this long is forgotten: the files have probably moved on. */
const PLAN_TTL_MS = 60 * 60 * 1000;

const MAX_PLANS = 20;

export interface PlannedFile {
  path: string;
  name: string;
  /** Of the file, or for a document of a ProPresenter 22 workspace, of its row's snapshot. */
  sha256: string;
  /** Set for a document of a ProPresenter 22 workspace, which is written into its database rather than over a file. */
  workspace?: { root: string; documentId: Uint8Array };
  /**
   * Each change with its number in the whole plan, which is how the
   * confirmation names it, and what it does to the styling on its line,
   * in words.
   */
  lines: { n: number; fix: LineFix; styling?: string[] }[];
  /**
   * The slides around the changes as the file read when planned, for a
   * surface that shows them to the person approving; display only, never
   * written. Unset where the person saw them before the plan was made.
   */
  context?: ContextSlide[];
}

export interface Plan {
  id: string;
  created: number;
  files: PlannedFile[];
}

/** Plans by id, for this server's lifetime only. */
export class PlanStore {
  private readonly plans = new Map<string, Plan>();

  add(files: PlannedFile[], now = Date.now()): Plan {
    for (const [id, plan] of this.plans) if (now - plan.created > PLAN_TTL_MS) this.plans.delete(id);
    // Oldest first, as a Map iterates.
    while (this.plans.size >= MAX_PLANS) this.plans.delete(this.plans.keys().next().value!);
    const plan = newPlan(files, now);
    this.plans.set(plan.id, plan);
    return plan;
  }

  /** The plan, removed: one plan is applied, or turned down, once. */
  take(id: string, now = Date.now()): Plan | undefined {
    const plan = this.plans.get(id);
    this.plans.delete(id);
    return plan && now - plan.created <= PLAN_TTL_MS ? plan : undefined;
  }
}


export const newPlan = (files: PlannedFile[], now = Date.now()): Plan => ({ id: randomUUID(), created: now, files });

/** Every line of a plan, for a surface where the person ticked them before it was made. */
export const everyLine = (plan: Plan) => new Set(plan.files.flatMap((file) => file.lines.map(({ n }) => n)));
