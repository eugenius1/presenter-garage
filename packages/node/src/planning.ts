import path from "node:path";
import { createI18n } from "@presenter-garage/core/i18n/core";
import type { ApplyRefusal, ChosenFile } from "@presenter-garage/core/lib/desktop";
import { isPresentationFile } from "@presenter-garage/core/lib/folder";
import { changeSite, EditError, examine, fixKey, planFixes, planLineEdits, type LineChange, type LineFix } from "@presenter-garage/core/lib/fixes";
import type { PresentationDoc } from "@presenter-garage/core/lib/presentation";
import { checkPresentationFidelity } from "@presenter-garage/core/lib/presentation";
import { AttributeRangeError } from "@presenter-garage/core/lib/ranges";
import { contextSlides } from "@presenter-garage/core/lib/slide-context";
import type { AppliedFile } from "./apply";
import { LibraryError, readFoundFile, resolveInRoots } from "./library";
import { LossyFile, WorkspaceRefused } from "./paths";
import { MAX_PLAN_LINES, newPlan, type Plan, type PlannedFile, type PlanStore } from "./plans";
import { open, presentationName } from "./presentations";
import { planStyling } from "./styling";
import { documentAt, isInWorkspace } from "./workspace";
import { readForPlanning } from "./workspace-write";
import { sha256 } from "./write";

/**
 * Making a plan, which writes nothing: from a model's edits for the MCP
 * server, or from the lines a person ticked for the desktop app, each file
 * read now and every change worked out again from what it holds.
 */

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
  /** Null when the line is removed. */
  after: string | null;
  /** What the change does to the formatting ranges on the line, when it touches any; for an added line, the formatting it takes. */
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
    const { doc, raw } = open(real, read.bytes);
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
    // What each line does to the styling on it, which the person is shown;
    // and what stops it, known now: refused before a person has read and
    // approved every line.
    const { styling, refusal } = planStyling(read.root !== undefined ? { root: read.root } : { raw, doc }, fixes);
    if (refusal instanceof AttributeRangeError) {
      const where = refusal.lineIndex === undefined ? `box ${refusal.boxIndex}` : `box ${refusal.boxIndex} line ${refusal.lineIndex}`;
      throw new LibraryError(`${real}, ${where}: ${refusals.attributeRanges}: ${rangeRefusals[refusal.reason]}. Nothing was planned.`);
    }
    if (refusal) throw new LibraryError(`${real}: ${refusals[refusal.reason]}. Nothing was planned.`);
    files.push({ ...plannedFile(real, doc, read, fixes, n, styling), context: contextSlides(doc, fixes) });
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
        ...(fix.insert && { insert: fix.insert }),
        before: fix.insert ? null : fix.before,
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
  let fidelity;
  try {
    fidelity = checkPresentationFidelity(bytes);
  } catch (e) {
    // Bytes that will not decode at all are this file's problem, not the run's.
    throw new LibraryError(`${real}: ${(e as Error).message}`);
  }
  // Refused now rather than after a person has read and approved every line.
  if (!fidelity.exportSafe) {
    throw new LossyFile(`${real}: ${refusals.lossy}. Nothing was planned.`);
  }
  return { bytes, sha256: sha256(bytes) };
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
    // The page names a file by the path it was listed at, which is where it
    // was found then; a path that now leads elsewhere -- a link put in its
    // place -- names a file nobody was shown, whatever its bytes.
    // The page never sends one file twice either; a second entry, however spelled, describes nothing it showed.
    if (real !== file.path || seen.has(real)) {
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

    // The same check the MCP server makes, so the two refuse a file alike.
    const { refusal } = planStyling(read.root !== undefined ? { root: read.root } : open(real, read.bytes), fixes);
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
