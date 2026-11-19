import { randomUUID } from "node:crypto";
import path from "node:path";
import { createI18n } from "@presenter-garage/core/i18n/core";
import { groupBy } from "@presenter-garage/core/lib/collections";
import type { ApplyRefusal, ChosenFile, NativeFileOutcome } from "@presenter-garage/core/lib/desktop";
import { isPresentationFile } from "@presenter-garage/core/lib/folder";
import {
  EditError,
  examine,
  FixError,
  fixFiles,
  fixKey,
  planFixes,
  planLineEdits,
  type LineChange,
  type LineFix,
} from "@presenter-garage/core/lib/fixes";
import type { PresentationDoc } from "@presenter-garage/core/lib/presentation";
import { checkPresentationFidelity } from "@presenter-garage/core/lib/presentation";
import {
  AttributeRangeError,
  planWorkspaceEdit,
  type LineStyling,
  type WorkspaceEdit,
} from "@presenter-garage/core/lib/workspace-edit";
import { LibraryError, readFoundFile, resolveInRoots } from "./library";
import { LossyFile, WorkspaceRefused } from "./paths";
import { open, presentationName } from "./presentations";
import { documentAt, isInWorkspace, workspaceAt } from "./workspace";
import { readForPlanning, writeWorkspaceEdits } from "./workspace-write";
import { openBackupDir, replaceWithBackup, sha256, type Replacement } from "./write";

/**
 * Editing slide text, in two steps with a person in between.
 *
 * Planning writes nothing: it works out every change and keeps the plan.
 * Applying takes the plan -- never the edits themselves, so what is applied
 * is exactly what was planned -- and the lines the person left ticked. See
 * AGENTS.md for the four guards and where each is kept.
 *
 * Shared by every surface that writes from Node, so there is one write path:
 * the MCP server plans from a model's edits and asks the person through MCP
 * elicitation; the desktop app plans from the lines a person ticked on
 * screen, the fixes worked out again here from what is on disk now.
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
   * confirmation names it, and in a workspace what it does to the styling
   * on its line, in words.
   */
  lines: { n: number; fix: LineFix; styling?: string[] }[];
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

const newPlan = (files: PlannedFile[], now = Date.now()): Plan => ({ id: randomUUID(), created: now, files });

/** One line of a plan, as the model and the person both see it. */
export interface PlannedLine {
  /** Position in the plan, which is how the confirmation names it. */
  n: number;
  slideIndex: number;
  label: string;
  group?: string;
  boxIndex: number;
  lineIndex: number;
  before: string;
  /** Null when the line is removed. */
  after: string | null;
  /** In a ProPresenter 22 workspace, what the change does to the formatting ranges on the line, when it touches any. */
  styling?: string[];
}

export interface PlanResult {
  planId: string;
  files: { path: string; name: string; lines: PlannedLine[] }[];
}

export interface RequestedEdit extends LineChange {
  path: string;
}

/** The app's own sentences for why a file was left alone, so the two surfaces never describe one file differently. */
const { t } = createI18n("en");
const refusals = t.tools.presentations.refusals;
const rangeRefusals = t.tools.presentations.rangeRefusals;

const CAPITALIZATION = ["no capitalization", "All Caps", "Small Caps", "Title Case", "Start Case"];

/** A ProPresenter 22 attribute as its Text inspector names it, more or less. */
function attributeName({ kind, value }: { kind: string; value?: unknown }): string {
  if (kind === "capitalization") return (typeof value === "number" && CAPITALIZATION[value]) || "Capitalization";
  const names: Record<string, string> = {
    original_font_size: "Font size",
    font_scale_factor: "Font scale",
    text_gradient_fill: "Gradient fill",
    should_preserve_foreground_color: "Kept text colour",
    chord: "Chord",
    cut_out_fill: "Cut-out fill",
    media_fill: "Media fill",
    background_effect: "Background effect",
    character_size_mode: "Character size",
    original_font: "Font",
  };
  return names[kind] ?? kind;
}

/**
 * What one line's change does to the styling on it, a sentence per range,
 * so the person sees every range that moves before choosing the line.
 */
export function describeStyling(fix: LineFix, styling: LineStyling, cutBack: boolean): string[] {
  const quote = (text: string) => (text === "" ? "none of it" : `“${text}”`);
  const said = styling.ranges.map((range) => {
    const name = attributeName(range);
    if (range.after === null) return `${name} on ${quote(range.before)} goes with the line`;
    if (range.before === fix.before && range.after === fix.after) return `${name} on the whole line, as before`;
    return `${name} on ${quote(range.before)} → on ${quote(range.after)}`;
  });
  if (cutBack) said.push("formatting that ran past the end of the text box is cut back to its end, which changes nothing visible");
  return said;
}

/** Each fix's styling in words, from the plan of its whole document. */
function stylingOf(edit: WorkspaceEdit, fixes: readonly LineFix[]): string[][] {
  return fixes.map((fix, i) => {
    const box = edit.boxes.find((b) => b.boxIndex === fix.boxIndex);
    return describeStyling(fix, edit.styling[i], (box?.cutBack.length ?? 0) > 0);
  });
}

/**
 * A presentation inside the roots, as a real path, or a refusal: only a
 * presentation, since a playlist, media bin or theme in the same folders is
 * not something this path was built to write.
 */
async function resolvePresentation(roots: readonly string[], p: string): Promise<string> {
  const real = await resolveInRoots(roots, p);
  if (!isPresentationFile(path.basename(real))) throw new LibraryError(`Not a presentation (.pro) file: ${p}`);
  return real;
}

export async function planSlideEdits(
  roots: readonly string[],
  store: PlanStore,
  edits: readonly RequestedEdit[]
): Promise<PlanResult> {
  if (edits.length === 0) throw new LibraryError("No edits given.");
  if (edits.length > MAX_PLAN_LINES) {
    throw new LibraryError(`At most ${MAX_PLAN_LINES} lines in one plan; split the work into smaller plans.`);
  }

  // By the file each edit resolves to, so two spellings of one path are one
  // file, and each file is read once however many of its lines change.
  const resolved = new Map<string, string>();
  const byFile = new Map<string, LineChange[]>();
  for (const { path: p, ...change } of edits) {
    let real = resolved.get(p);
    if (real === undefined) {
      real = await resolvePresentation(roots, p);
      resolved.set(p, real);
    }
    const changes = byFile.get(real);
    if (changes) changes.push(change);
    else byFile.set(real, [change]);
  }

  let n = 0;
  const files: PlannedFile[] = [];
  for (const [real, changes] of byFile) {
    const read = await readForPlan(real);
    const { doc } = open(real, read.bytes);
    let fixes: LineFix[];
    try {
      fixes = planLineEdits(doc, changes);
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      const { boxIndex, lineIndex } = e.change;
      throw new LibraryError(`${real}, box ${boxIndex} line ${lineIndex}: ${t.tools.presentations.editRefusals[e.reason]}. Nothing was planned.`);
    }
    // A workspace document is edited as itself, and what stops that is
    // known now: refused before a person has read and approved every line.
    const { styling, refusal } = planStyling(read, fixes);
    if (refusal instanceof AttributeRangeError) {
      const where = refusal.lineIndex === undefined ? `box ${refusal.boxIndex}` : `box ${refusal.boxIndex} line ${refusal.lineIndex}`;
      throw new LibraryError(`${real}, ${where}: ${refusals.attributeRanges}: ${rangeRefusals[refusal.reason]}. Nothing was planned.`);
    }
    if (refusal) throw new LibraryError(`${real}: ${refusals[refusal.reason]}. Nothing was planned.`);
    files.push(plannedFile(real, doc, read, fixes, n, styling));
    n += fixes.length;
  }

  const plan = store.add(files);
  return {
    planId: plan.id,
    files: plan.files.map((file) => ({
      path: file.path,
      name: file.name,
      lines: file.lines.map(({ fix, n, styling }) => ({
        n,
        slideIndex: fix.slideIndex,
        label: fix.cueName,
        group: fix.groupName,
        boxIndex: fix.boxIndex,
        lineIndex: fix.lineIndex,
        before: fix.before,
        after: fix.after,
        ...(styling && { styling }),
      })),
    })),
  };
}

interface ReadForPlan {
  bytes: Uint8Array;
  sha256: string;
  workspace?: PlannedFile["workspace"];
  /** The workspace document's own content, which its edit is planned against. */
  root?: unknown;
}

/**
 * A presentation as a plan is made from it: its bytes, and what applying
 * will check it against. For a document of a workspace that is its row,
 * and the document passes the checks applying would make, or is refused.
 */
async function readForPlan(real: string): Promise<ReadForPlan> {
  const found = await documentAt(real);
  if (found) {
    const { bytes, sha256: digest, root } = await readForPlanning(found.workspace, found.document);
    return { bytes, sha256: digest, root, workspace: { root: found.workspace.root, documentId: found.document.id } };
  }
  if (await isInWorkspace(real)) throw new LibraryError(`Not a presentation in the workspace: ${real}`);
  const { bytes } = await readFoundFile(real);
  // Refused now rather than after a person has read and approved every line.
  if (!checkPresentationFidelity(bytes).exportSafe) {
    throw new LossyFile(`${real}: ${refusals.lossy}. Nothing was planned.`);
  }
  return { bytes, sha256: sha256(bytes) };
}

/**
 * For a workspace document, what each fix does to its styling, or why the
 * edit cannot be made: ranges that cannot be moved without a guess, or a
 * document the edit cannot be planned in. Each surface says the refusal its
 * own way; both refuse for exactly these.
 */
function planStyling(
  read: ReadForPlan,
  fixes: readonly LineFix[]
): { styling?: string[][]; refusal?: AttributeRangeError | FixError } {
  if (read.root === undefined) return {};
  try {
    return { styling: stylingOf(planWorkspaceEdit(read.root, fixes), fixes) };
  } catch (e) {
    if (e instanceof AttributeRangeError || e instanceof FixError) return { refusal: e };
    throw e;
  }
}

/**
 * A file the open folder holds, with the hash `planChosenFixes` will check
 * it against: of a file's bytes, or of a workspace document's stored
 * snapshot. Whoever shows a file to a person reads it here, so the hash it
 * hands back is the one the plan compares.
 */
export async function readWithHash(real: string): Promise<{ bytes: Uint8Array; sha256: string }> {
  // One read for both, so the hash is of the very snapshot the bytes were made from.
  const found = await readFoundFile(real);
  return { bytes: found.bytes, sha256: found.converted ? (found.sha256 ?? "") : sha256(found.bytes) };
}

function plannedFile(
  real: string,
  doc: PresentationDoc,
  read: ReadForPlan,
  fixes: readonly LineFix[],
  numberedFrom: number,
  styling?: string[][]
): PlannedFile {
  return {
    path: real,
    name: doc.name || presentationName(real),
    sha256: read.sha256,
    workspace: read.workspace,
    lines: fixes.map((fix, i) => ({
      n: numberedFrom + i + 1,
      fix,
      ...(styling && styling[i].length > 0 && { styling: styling[i] }),
    })),
  };
}

/**
 * Plan the lines a person ticked in the desktop app.
 *
 * The page sends what it showed, never what to write: which lines, and how
 * each read before and after. Each file is read again here, its fixes worked
 * out again from what is on disk now with the same checks the page ran, and
 * a line goes into the plan only if it comes out exactly as the person saw
 * it. A file that changed since the page read it, or a line that would now
 * read otherwise, is left alone (guard 3: what is written is what was seen).
 *
 * A file that cannot be planned is a refusal for that file, not for the run,
 * as the web app reports it. A workspace that cannot be written at all --
 * open in ProPresenter, a Cloud one, a format not checked -- refuses the run.
 */
export async function planChosenFixes(
  roots: readonly string[],
  chosen: readonly ChosenFile[]
): Promise<{ plan: Plan; refused: Omit<AppliedFile, "name">[] }> {
  const files: PlannedFile[] = [];
  const refused: Omit<AppliedFile, "name">[] = [];
  /** Each presentation once: two entries for one file would back it up, and write it, twice. */
  const seen = new Set<string>();
  let n = 0;
  for (const file of chosen) {
    const refuse = (reason: ApplyRefusal, more: Partial<AppliedFile> = {}) =>
      refused.push({ path: file.path, lines: file.lines.length, written: false, reason, ...more });

    let real: string;
    let read: ReadForPlan;
    try {
      real = await resolvePresentation(roots, file.path);
      read = await readForPlan(real);
    } catch (e) {
      // A workspace that cannot be written refuses the run; anything else is this file's.
      if (e instanceof WorkspaceRefused || !(e instanceof LibraryError)) throw e;
      refuse(e instanceof LossyFile ? "lossy" : "unreadable", { detail: e.message });
      continue;
    }
    // The page never sends one file twice; a second entry, however spelled, describes nothing it showed.
    if (seen.has(real)) {
      refuse("stale");
      continue;
    }
    seen.add(real);
    if (read.sha256 !== file.sha256) {
      refuse("stale");
      continue;
    }

    const { report, fixable } = examine(real, read.bytes);
    if (report.error) {
      refuse("unreadable");
      continue;
    }
    const kinds = new Set(file.kinds);
    const planned = new Map(planFixes(fixable, report.issues.filter((issue) => kinds.has(issue.kind))).map((fix) => [fixKey(fix), fix]));
    const fixes: LineFix[] = [];
    for (const line of file.lines) {
      const fix = planned.get(fixKey(line));
      // Taken out once used, so a line sent twice is not written twice.
      planned.delete(fixKey(line));
      if (!fix || fix.before !== line.before || fix.after !== line.after) break;
      fixes.push(fix);
    }
    if (fixes.length !== file.lines.length) {
      refuse("stale");
      continue;
    }
    if (fixes.length === 0) {
      refuse("unchanged");
      continue;
    }

    const { refusal } = planStyling(read, fixes);
    if (refusal) {
      if (refusal instanceof AttributeRangeError) refuse("attributeRanges", { rangeReason: refusal.reason });
      else refuse(refusal.reason);
      continue;
    }
    files.push(plannedFile(real, fixable, read, fixes, n));
    n += fixes.length;
  }
  return { plan: newPlan(files), refused };
}

export interface AppliedFile extends NativeFileOutcome {
  name: string;
  /** The system's own words, in English, when there are any. */
  detail?: string;
}

/** The apply in progress, if any; the next waits for it. */
let applying: Promise<unknown> = Promise.resolve();

/**
 * Apply what the person left ticked, one plan at a time.
 *
 * `fixFiles` -- the same run the web app makes -- puts every file through
 * `applyFixes` again from bytes read now: the plan was made from bytes read
 * then, and `applyFixes` is where the fidelity gate and the read-back of every
 * line live. Only files that pass are handed to `replaceWithBackup`, which
 * backs them all up before writing any.
 *
 * Two plans for the same song, confirmed at once, would otherwise both read
 * the same original and both pass the check before either renamed: the
 * second would land over the first, and both would report success. In
 * series, the second finds the file changed and is refused as stale.
 *
 * A refusal's `detail` is the system's own words, if any; each surface puts
 * its sentence for `reason` in front of them in its own language.
 */
export function applyPlan(
  roots: readonly string[],
  plan: Plan,
  ticked: ReadonlySet<number>,
  backupDir: string,
  signal?: AbortSignal
): Promise<{ backupFolder?: string; files: AppliedFile[] }> {
  const run = applying.then(() => applyPlanNow(roots, plan, ticked, backupDir, signal));
  applying = run.catch(() => undefined);
  return run;
}

/** Every line of a plan, for a surface where the person ticked them before it was made. */
export const everyLine = (plan: Plan) => new Set(plan.files.flatMap((file) => file.lines.map(({ n }) => n)));

/** The client gave up on the call; nothing may be written behind its back. */
function stopIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new LibraryError("The call was cancelled before anything was written, so nothing was.");
}

async function applyPlanNow(
  roots: readonly string[],
  plan: Plan,
  ticked: ReadonlySet<number>,
  backupDir: string,
  signal?: AbortSignal
): Promise<{ backupFolder?: string; files: AppliedFile[] }> {
  // Checked when this run's turn comes, not only when it joined the queue: a
  // client can give up while an earlier apply is still writing.
  stopIfCancelled(signal);
  const choose = (file: PlannedFile) => file.lines.filter(({ n }) => ticked.has(n)).map(({ fix }) => fix);
  const inWorkspaces: AppliedFile[] = [];
  // The first run's folder; each file's own `backup` says where its copy is.
  let backupFolder: string | undefined;

  /**
   * A step that refuses by throwing -- ProPresenter open, a workspace that
   * cannot be written, a cancelled call -- refuses the whole call only while
   * nothing has been written yet. Once something has, throwing would tell
   * the person nothing was written and lose where its backup went, so the
   * refusal becomes these files' outcome instead and the rest is reported.
   */
  const refuseOrRecord = (e: unknown, files: AppliedFile[]) => {
    if (!inWorkspaces.some((file) => file.written)) throw e;
    // A cancellation's own words say nothing at all was written, which is
    // no longer so; they are said of these files alone.
    const detail = signal?.aborted ? "the call was cancelled before these were written" : (e as Error).message;
    for (const file of files) Object.assign(file, { written: false, reason: "writeFailed", detail });
  };

  // Workspaces first: one ProPresenter has open refuses the whole call, and
  // a refusal is clearest when nothing at all has been written.
  const byWorkspace = groupBy(
    plan.files.filter((file) => file.workspace),
    (file) => file.workspace!.root
  );
  for (const [root, group] of byWorkspace) {
    const chosen = group.map(choose);
    const outcomes: AppliedFile[] = group.map((file, i) => ({
      path: file.path,
      name: file.name,
      lines: chosen[i].length,
      written: false,
    }));
    // Nothing ticked here: nothing to back up, so no backup folder is needed to say so.
    if (chosen.every((fixes) => fixes.length === 0)) {
      for (const outcome of outcomes) outcome.reason = "unchanged";
      inWorkspaces.push(...outcomes);
      continue;
    }
    try {
      const workspace = await workspaceAt(root);
      if (!workspace) throw new LibraryError(`${root} is no longer a ProPresenter workspace, so nothing in it was written.`);
      stopIfCancelled(signal);
      const run = await writeWorkspaceEdits(
        workspace,
        roots,
        await openBackupDir(backupDir, roots),
        group.map((file, i) => ({ path: file.path, documentId: file.workspace!.documentId, sha256: file.sha256, fixes: chosen[i] })),
        { signal }
      );
      backupFolder ??= run.backupFolder;
      // One outcome per replacement, in the order given.
      run.outcomes.forEach((outcome, i) => Object.assign(outcomes[i], outcome));
    } catch (e) {
      refuseOrRecord(e, outcomes);
    }
    inWorkspaces.push(...outcomes);
  }

  const onDisk = plan.files.filter((file) => !file.workspace);
  const planned = new Map(onDisk.map((file) => [file.path, file]));
  const originals = new Map<string, Uint8Array>();
  const fixed = await fixFiles(
    onDisk.map((file) => ({ path: file.path, fixes: choose(file) })),
    {
      read: async (p) => {
        const { bytes } = await readFoundFile(p);
        if (sha256(bytes) !== planned.get(p)!.sha256) throw new FixError("stale");
        originals.set(p, bytes);
        return bytes;
      },
    }
  );

  const onDiskFiles: AppliedFile[] = fixed.map(({ path: p, lines, reason }) => ({
    path: p,
    name: planned.get(p)!.name,
    lines,
    written: false,
    reason,
  }));
  const replacements: Replacement[] = fixed
    .filter((outcome) => outcome.bytes)
    .map(({ path: p, bytes }) => ({ path: p, original: originals.get(p)!, updated: bytes! }));

  if (replacements.length > 0) {
    try {
      // And once more at the last moment before anything on disk changes.
      stopIfCancelled(signal);
      // And inside, once the backups are made, right before the first original
      // changes: backing up takes time, and the client can give up during it.
      const run = await replaceWithBackup(roots, await openBackupDir(backupDir, roots), replacements, { signal });
      backupFolder ??= run.backupFolder;
      const byPath = new Map(run.outcomes.map((outcome) => [outcome.path, outcome]));
      for (const file of onDiskFiles) Object.assign(file, byPath.get(file.path));
    } catch (e) {
      const waiting = new Set(replacements.map((r) => r.path));
      refuseOrRecord(e, onDiskFiles.filter((file) => waiting.has(file.path)));
    }
  }

  return { backupFolder, files: [...inWorkspaces, ...onDiskFiles] };
}
