import { groupBy } from "@presenter-garage/core/lib/collections";
import type { NativeFileOutcome } from "@presenter-garage/core/lib/desktop";
import { FixError, fixFiles } from "@presenter-garage/core/lib/fixes";
import { LibraryError, readFoundFile } from "./library";
import type { Plan, PlannedFile } from "./plans";
import { workspaceAt } from "./workspace";
import { writeWorkspaceEdits } from "./workspace-write";
import { openBackupDir, replaceWithBackup, sha256, type Replacement } from "./write";

/**
 * Applying a plan: the only step that writes, and only the lines the person
 * left ticked. See AGENTS.md for the four guards and where each is kept.
 */

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
