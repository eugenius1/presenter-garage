import { groupBy } from "@presenter-garage/core/lib/collections";
import type { NativeFileOutcome } from "@presenter-garage/core/lib/desktop";
import { FixError, fixFiles } from "@presenter-garage/core/lib/fixes";
import { LibraryError, readFoundFile } from "./library";
import type { Plan, PlannedFile } from "./plans";
import { workspaceAt } from "./workspace";
import { stageWorkspaceEdits, type StagedWorkspaceWrite } from "./workspace-write";
import { backUpReplacements, backupFailed, openBackupDir, replaceBackedUp, sha256, type Replacement } from "./write";

/**
 * Applying a plan: the only step that writes, and only the changes the
 * person left ticked: lines of text, and structural changes. See AGENTS.md for the four guards and where each is kept.
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
 * line live. Only files that pass are backed up and written, and every
 * file of every root is backed up before any is written.
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

/**
 * The run, in two halves, so AGENTS.md's second guard holds for the whole
 * call and not only for each root by itself: a plan can span several roots,
 * a workspace and a folder of `.pro` files, or two workspaces.
 *
 * 1. Every workspace is taken and stays held, its rows checked and backed
 *    up; every `.pro` file is read, checked and backed up. Nothing changes.
 * 2. Only once every backup is made and read back, and the call is still
 *    wanted, does each group write.
 *
 * A backup that fails anywhere writes nothing anywhere. A refusal in the
 * first half -- ProPresenter open, a workspace that cannot be written --
 * refuses the whole call, which is clearest while nothing has been written.
 */
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
  const chooseChanges = (file: PlannedFile) => file.changes.filter(({ n }) => ticked.has(n)).map(({ change }) => change);
  let opened: string | undefined;
  const openBackups = async () => (opened ??= await openBackupDir(backupDir, roots));

  const inWorkspaces: AppliedFile[] = [];
  const staged: { write: StagedWorkspaceWrite; files: AppliedFile[] }[] = [];
  try {
    const byWorkspace = groupBy(
      plan.files.filter((file) => file.workspace),
      (file) => file.workspace!.root
    );
    for (const [root, group] of byWorkspace) {
      const chosen = group.map((file) => ({ fixes: choose(file), changes: chooseChanges(file) }));
      const count = ({ fixes, changes }: (typeof chosen)[number]) => fixes.length + changes.length;
      const files: AppliedFile[] = group.map((file, i) => ({ path: file.path, name: file.name, lines: count(chosen[i]), written: false }));
      inWorkspaces.push(...files);
      // Nothing ticked here: nothing to back up, so no backup folder is needed to say so.
      if (chosen.every((c) => count(c) === 0)) {
        for (const file of files) file.reason = "unchanged";
        continue;
      }
      const workspace = await workspaceAt(root);
      if (!workspace) throw new LibraryError(`${root} is no longer a ProPresenter workspace, so nothing in it was written.`);
      stopIfCancelled(signal);
      const write = await stageWorkspaceEdits(
        workspace,
        roots,
        await openBackups(),
        group.map((file, i) => ({
          path: file.path,
          documentId: file.workspace!.documentId,
          sha256: file.sha256,
          cloud: file.workspace!.cloud === true,
          ...chosen[i],
        }))
      );
      staged.push({ write, files });
    }

    const onDisk = plan.files.filter((file) => !file.workspace);
    const planned = new Map(onDisk.map((file) => [file.path, file]));
    const originals = new Map<string, Uint8Array>();
    const fixed = await fixFiles(
      onDisk.map((file) => ({ path: file.path, fixes: choose(file), changes: chooseChanges(file) })),
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
    const backedUp = replacements.length > 0 ? await backUpReplacements(roots, await openBackups(), replacements) : undefined;
    /** These files' outcomes from the writer's, matched by path. */
    const record = (files: AppliedFile[], outcomes: readonly { path: string }[]) => {
      const byPath = new Map(outcomes.map((outcome) => [outcome.path, outcome]));
      for (const file of files) Object.assign(file, byPath.get(file.path));
    };
    const waiting = new Set(replacements.map((r) => r.path));
    const onDiskWaiting = onDiskFiles.filter((file) => waiting.has(file.path));

    const folders = [...staged.map(({ write }) => write.backupFolder), backedUp?.backupFolder].filter((f): f is string => !!f);
    const backupFolder = folders[0];
    const everyFile = () => [...inWorkspaces, ...onDiskFiles];
    for (const { write, files } of staged) record(files, write.outcomes);

    // Why a backup could not be made, wherever one could not.
    const failed = [...staged.map(({ write }) => write.backupFailed), backedUp?.detail].find((detail) => detail !== undefined);
    if (failed !== undefined) {
      const elsewhere = `another file's backup could not be made (${failed}), so nothing at all was written`;
      for (const { write, files } of staged) {
        write.abandon("backupFailed", elsewhere);
        record(files, write.outcomes);
      }
      if (backedUp) record(onDiskWaiting, backupFailed(replacements, backedUp.backups ? elsewhere : backedUp.detail));
      return { backupFolder, files: everyFile() };
    }

    // The last moment nothing has changed: every backup is made and flushed,
    // which takes time, and the client can give up during it.
    if (signal?.aborted) {
      throw new LibraryError(
        `The call was cancelled before anything changed, so nothing was written.` +
          (folders.length > 0 ? ` Its backups are in ${folders.join(" and ")}.` : "")
      );
    }

    /**
     * A writer that throws once something has been written -- a commit the
     * store would not take -- would otherwise tell the person nothing was
     * written and lose where its backup went, so the refusal becomes these
     * files' outcome instead and the rest go ahead, their backups made.
     */
    const refuseOrRecord = (e: unknown, files: AppliedFile[]) => {
      if (!inWorkspaces.some((file) => file.written)) throw e;
      for (const file of files) Object.assign(file, { written: false, reason: "writeFailed", detail: (e as Error).message });
    };
    for (const { write, files } of staged) {
      try {
        await write.commit();
        record(files, write.outcomes);
      } catch (e) {
        refuseOrRecord(e, files.filter((file) => !file.reason));
      }
    }
    if (backedUp?.backups) record(onDiskWaiting, await replaceBackedUp(roots, replacements, backedUp.backups));
    return { backupFolder, files: everyFile() };
  } finally {
    // However the run ended, no workspace is kept from ProPresenter.
    for (const { write } of staged) write.abandon();
  }
}
