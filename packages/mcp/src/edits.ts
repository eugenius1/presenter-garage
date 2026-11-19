import { randomUUID } from "node:crypto";
import path from "node:path";
import { createI18n } from "@presenter-garage/core/i18n/core";
import { groupBy } from "@presenter-garage/core/lib/collections";
import { isPresentationFile } from "@presenter-garage/core/lib/folder";
import {
  changeSite,
  EditError,
  FixError,
  fixFiles,
  planLineEdits,
  presentationRanges,
  type FixRefusal,
  type LineChange,
  type LineFix,
} from "@presenter-garage/core/lib/fixes";
import { checkPresentationFidelity } from "@presenter-garage/core/lib/presentation";
import { AttributeRangeError } from "@presenter-garage/core/lib/ranges";
import { planWorkspaceEdit } from "@presenter-garage/core/lib/workspace-edit";
import { LibraryError, readFoundFile, resolveInRoots } from "@presenter-garage/node/library";
import { documentAt, isInWorkspace, workspaceAt } from "@presenter-garage/node/workspace";
import {
  readForPlanning,
  writeWorkspaceEdits,
  type WorkspaceRefusal,
} from "@presenter-garage/node/workspace-write";
import {
  openBackupDir,
  replaceWithBackup,
  sha256,
  type Replacement,
  type WriteRefusal,
} from "@presenter-garage/node/write";
import { open, presentationName } from "./tools";

/**
 * Editing slide text, in two calls with a person in between.
 *
 * `planSlideEdits` writes nothing: it works out every change, refuses the lot
 * if any one cannot be made, and keeps the plan under an id. `applySlideEdits`
 * takes that id -- never the edits themselves, so what is applied is exactly
 * what was planned -- and is handed the person's answer by the server, which
 * asks them directly and never the model. See AGENTS.md for the four guards
 * and where each is kept on this surface.
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
   * confirmation names it. `capitals` is set for an added line that reads in
   * capitals, because the All Caps range of the line beside it is widened
   * over it.
   */
  lines: { n: number; fix: LineFix; capitals?: true }[];
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
    const plan = { id: randomUUID(), created: now, files };
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

/** One line of a plan, as the model and the person both see it. */
export interface PlannedLine {
  /** Position in the plan, which is how the confirmation names it. */
  n: number;
  slideIndex: number;
  label: string;
  group?: string;
  boxIndex: number;
  /** The line changed, or for an added line, the line it is added beside. */
  lineIndex: number;
  /** Set for an added line: which side of line `lineIndex` it goes. */
  insert?: "before" | "after";
  /** Null for an added line, which was not there before. */
  before: string | null;
  /** Set for an added line that shows in capitals: the line beside it is All Caps, and the new line takes it. */
  capitals?: true;
  /** Null when the line is removed. */
  after: string | null;
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
      real = await resolveInRoots(roots, p);
      // Only a presentation: a playlist, media bin or theme in the same
      // folders is not something this path was built to write.
      if (!isPresentationFile(path.basename(real))) throw new LibraryError(`Not a presentation (.pro) file: ${p}`);
      resolved.set(p, real);
    }
    const changes = byFile.get(real);
    if (changes) changes.push(change);
    else byFile.set(real, [change]);
  }

  let n = 0;
  const files: PlannedFile[] = [];
  for (const [real, changes] of byFile) {
    const { bytes, sha256: digest, workspace, root } = await readForPlan(real);
    const { doc, raw } = open(real, bytes);
    let fixes: LineFix[];
    try {
      fixes = planLineEdits(doc, changes);
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      const { boxIndex, insert } = e.change;
      // "box 0 line 1" as before for a changed line; an added one reads as a clause.
      const where = `${insert ? ", " : " "}${changeSite(e.change)}`;
      throw new LibraryError(`${real}, box ${boxIndex}${where}: ${t.tools.presentations.editRefusals[e.reason]}. Nothing was planned.`);
    }
    // Where every attribute range goes, which the person is shown, and what
    // stops it, known now: refused before a person has read and approved
    // every line. A workspace document is edited as itself.
    let capitals: Set<LineFix>;
    try {
      capitals =
        root !== undefined
          ? planWorkspaceEdit(root, fixes).capitals
          : presentationRanges(raw, doc, fixes).capitals;
    } catch (e) {
      if (e instanceof AttributeRangeError) {
        const why = e.addedLine ? refusals.addedLineRanges : refusals.attributeRanges;
        throw new LibraryError(`${real}, box ${e.boxIndex}: ${why}. Nothing was planned.`);
      }
      if (e instanceof FixError) throw new LibraryError(`${real}: ${refusals[e.reason]}. Nothing was planned.`);
      throw e;
    }
    files.push({
      path: real,
      name: doc.name || presentationName(real),
      sha256: digest,
      workspace,
      lines: fixes.map((fix) => ({ n: ++n, fix, ...(capitals.has(fix) && { capitals: true as const }) })),
    });
  }

  const plan = store.add(files);
  return {
    planId: plan.id,
    files: plan.files.map((file) => ({
      path: file.path,
      name: file.name,
      lines: file.lines.map(({ fix, n, capitals }) => ({
        n,
        slideIndex: fix.slideIndex,
        label: fix.cueName,
        group: fix.groupName,
        boxIndex: fix.boxIndex,
        lineIndex: fix.lineIndex,
        ...(fix.insert && { insert: fix.insert }),
        before: fix.insert ? null : fix.before,
        after: fix.after,
        ...(capitals && { capitals }),
      })),
    })),
  };
}

/**
 * A presentation as a plan is made from it: its bytes, and what applying
 * will check it against. For a document of a workspace that is its row,
 * and the document passes the checks applying would make, or is refused.
 */
async function readForPlan(
  real: string
): Promise<{ bytes: Uint8Array; sha256: string; workspace?: PlannedFile["workspace"]; root?: unknown }> {
  const found = await documentAt(real);
  if (found) {
    const { bytes, sha256: digest, root } = await readForPlanning(found.workspace, found.document);
    return { bytes, sha256: digest, root, workspace: { root: found.workspace.root, documentId: found.document.id } };
  }
  if (await isInWorkspace(real)) throw new LibraryError(`Not a presentation in the workspace: ${real}`);
  const { bytes } = await readFoundFile(real);
  // Refused now rather than after a person has read and approved every line.
  if (!checkPresentationFidelity(bytes).exportSafe) {
    throw new LibraryError(`${real}: ${refusals.lossy}. Nothing was planned.`);
  }
  return { bytes, sha256: sha256(bytes) };
}

/** A confirmation form: one tick box per line, all ticked, each saying what it changes. */
export function confirmationRequest(plan: Plan, backupDir: string) {
  const properties: Record<string, { type: "boolean"; title: string; description: string; default: boolean }> = {};
  for (const file of plan.files) for (const { fix, n, capitals } of file.lines) {
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
      // reads now, so it can be placed without the slide in front of them;
      // and in capitals where it takes the All Caps of that line.
      description: fix.insert
        ? `Added ${fix.insert} ${fix.before ? `“${fix.before}”` : "an empty line"}: “${fix.after}”` +
          (capitals ? ", in capitals as the line beside it is" : "")
        : `“${fix.before}” → ${fix.after === null ? "line removed" : `“${fix.after}”`}`,
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

export type ApplyRefusal = FixRefusal | WriteRefusal | WorkspaceRefusal;

export interface ApplyResult {
  /** What the person answered. Nothing is written unless they accepted. */
  answer: "accept" | "decline" | "cancel";
  backupFolder?: string;
  files: {
    path: string;
    name: string;
    /** Lines the person left ticked. */
    lines: number;
    written: boolean;
    backup?: string;
    reason?: ApplyRefusal;
    detail?: string;
  }[];
}

/**
 * Apply what the person left ticked.
 *
 * `fixFiles` -- the same run the web app makes -- puts every file through
 * `applyFixes` again from bytes read now: the plan was made from bytes read
 * then, and `applyFixes` is where the fidelity gate and the read-back of every
 * line live. Only files that pass are handed to `replaceWithBackup`, which
 * backs them all up before writing any.
 */
/** The apply in progress, if any; the next waits for it. */
let applying: Promise<unknown> = Promise.resolve();

/**
 * Apply what the person left ticked, one plan at a time.
 *
 * Two plans for the same song, confirmed at once, would otherwise both read
 * the same original and both pass the check before either renamed: the
 * second would land over the first, and both would report success. In
 * series, the second finds the file changed and is refused as stale.
 */
export function applyPlan(
  roots: readonly string[],
  plan: Plan,
  ticked: ReadonlySet<number>,
  backupDir: string,
  signal?: AbortSignal
): Promise<Omit<ApplyResult, "answer">> {
  const run = applying.then(() => applyPlanNow(roots, plan, ticked, backupDir, signal));
  applying = run.catch(() => undefined);
  return run;
}

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
): Promise<Omit<ApplyResult, "answer">> {
  // Checked when this run's turn comes, not only when it joined the queue: a
  // client can give up while an earlier apply is still writing.
  stopIfCancelled(signal);
  const choose = (file: PlannedFile) => file.lines.filter(({ n }) => ticked.has(n)).map(({ fix }) => fix);
  const inWorkspaces: ApplyResult["files"] = [];
  // The first run's folder; each file's own `backup` says where its copy is.
  let backupFolder: string | undefined;

  /**
   * A step that refuses by throwing -- ProPresenter open, a workspace that
   * cannot be written, a cancelled call -- refuses the whole call only while
   * nothing has been written yet. Once something has, throwing would tell
   * the person nothing was written and lose where its backup went, so the
   * refusal becomes these files' outcome instead and the rest is reported.
   */
  const refuseOrRecord = (e: unknown, files: ApplyResult["files"]) => {
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
    const outcomes: ApplyResult["files"] = group.map((file, i) => ({
      path: file.path,
      name: file.name,
      lines: chosen[i].length,
      written: false,
    }));
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

  const onDiskFiles: ApplyResult["files"] = fixed.map(({ path: p, lines, reason }) => ({
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

  return {
    backupFolder,
    files: [...inWorkspaces, ...onDiskFiles].map((file) =>
      file.reason ? { ...file, detail: [refusals[file.reason], file.detail].filter(Boolean).join(": ") } : file
    ),
  };
}
