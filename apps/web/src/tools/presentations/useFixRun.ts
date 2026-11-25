import { useState, type RefObject } from "react";
import type { FolderFile } from "@presenter-garage/core/lib/folder";
import { requestHandlePermission } from "../../lib/persistence";
import { download, stamp } from "@presenter-garage/core/lib/download";
import { fixFiles, type FileFixPlan } from "@presenter-garage/core/lib/fixes";
import type { TextIssueKind } from "@presenter-garage/core/lib/presentation";
import type { DesktopBridge, NativeFileOutcome, RunRefusal } from "@presenter-garage/core/lib/desktop";
import { zip } from "@presenter-garage/core/lib/zip";

/**
 * Writing the chosen fixes back: the web app's write path.
 *
 * Everything that turns ticked lines into changed files is here, so the
 * guards AGENTS.md asks of this surface can be read in one place. A browser
 * that can write back does nothing until `downloadBackup` has taken a zip of
 * every file about to change (`backedUp`); every run writes only the lines in
 * `chosen`, which are the ones left ticked; and each file goes through
 * `fixFiles`, so `applyFixes` checks it against the schema and reads it back
 * before it reaches the folder. In the desktop app the shell does all of
 * that itself, from the lines as they were shown.
 */

/**
 * Let the browser paint, at most once a frame.
 *
 * Reading, decoding, editing and re-encoding a file are quick enough that a
 * run of several hundred never gives the main thread back on its own: the
 * awaits inside it resolve as microtasks, so React flushes the progress state
 * and nothing is drawn. Measured on a real run of 57 files, the bar painted
 * three times -- it showed 14, then 56, then disappeared.
 *
 * Yielding on every file would cost more than it buys: `setTimeout` is clamped
 * to about four milliseconds, which on a whole library is seconds of waiting
 * added to make a bar move. So the main thread goes back only once the frame
 * it would have been drawn in has passed, and through `scheduler.yield` where
 * the browser has it, which returns without the clamp.
 */
function painter() {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  let last = performance.now();

  return async () => {
    const now = performance.now();
    if (now - last < 16) return;
    last = now;
    if (scheduler?.yield) await scheduler.yield();
    else await new Promise((resolve) => setTimeout(resolve, 0));
  };
}

/** How far a run has got, and which phase it is. */
export interface Progress {
  /**
   * Which phase: "Saving {n}…", "Backing up {n}…", "Fixing {n}…". A key into
   * the dictionary rather than its text, so a language switched mid-run is
   * the language the caption is in.
   */
  verb: "applying" | "backingUp" | "fixing";
  path: string;
  /** Files finished, and how many there are altogether. */
  done: number;
  total: number;
}

/**
 * What a run did with one file: the web app's own outcome, or the desktop
 * shell's, which can refuse for more reasons -- a backup that failed, a
 * workspace's formatting that cannot be moved.
 */
export type Outcome = Pick<NativeFileOutcome, "path" | "reason" | "rangeReason">;

interface FixRunInputs {
  /** The desktop shell, when this is the desktop app. */
  bridge: DesktopBridge | undefined;
  /** The folder's handle, in a browser that can write back. */
  handle: unknown;
  /** The files of the folder on screen, and the same by path. */
  files: FolderFile[];
  fileByPath: ReadonlyMap<string, FolderFile>;
  /** The fixes still ticked, by file. */
  chosen: FileFixPlan[];
  /** The kinds on screen, which decided what every fix shown does. */
  shown: ReadonlySet<TextIssueKind>;
  /** The open whose folder is on screen: a run that finds it moved on leaves the screen alone. */
  displayed: RefObject<number>;
  /** Read the whole folder again. */
  scan: (list: FolderFile[], mine: number) => Promise<void>;
  /** Read again only these files, keeping what is unticked. */
  rescan: (list: FolderFile[], mine: number) => Promise<void>;
}

export function useFixRun({ bridge, handle, files, fileByPath, chosen, shown, displayed, scan, rescan }: FixRunInputs) {
  /** Whether the system would not open the backup folder when asked. */
  const [backupsUnshown, setBackupsUnshown] = useState(false);
  const [backup, setBackup] = useState<{ name: string; paths: Set<string> } | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const [savedZip, setSavedZip] = useState<string | null>(null);
  // The permission refusal is ours to word, so it is kept as a fact and
  // worded at render; anything else is an error's own message.
  const [fixError, setFixError] = useState<"permissionNeeded" | { message: string } | null>(null);
  /**
   * Whether a run is under way, and how far through it is.
   *
   * A library is hundreds of files and every one is decoded, edited,
   * re-encoded and read back, so a run lasts long enough that a reader needs
   * to see it moving. Kept as a count rather than a fraction so the caption
   * can say "12 of 57" -- a bar alone shows that something is happening but
   * not how much of it is left.
   */
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  /** What the last desktop run said of itself as a whole: where its backups went, or why it wrote nothing. */
  const [nativeRun, setNativeRun] = useState<{
    backupFolder?: string;
    refused?: { code: RunRefusal; detail: string };
  } | null>(null);

  function clearRun() {
    setBackup(null);
    setOutcomes(null);
    setSavedZip(null);
    setFixError(null);
    setNativeRun(null);
    setBackupsUnshown(false);
  }

  /** Whether the backup on hand covers every file about to be written. */
  const backedUp = backup !== null && chosen.every((plan) => backup.paths.has(plan.path));

  /**
   * Run one of the long jobs below, reporting each file as it starts.
   *
   * `step` is shaped to be handed straight to `fixFiles` as `onFile`.
   */
  async function run(
    verb: Progress["verb"],
    body: (step: (path: string, done: number, total: number) => Promise<void>) => Promise<void>
  ) {
    setFixError(null);
    setRunning(true);
    const paint = painter();
    try {
      await body(async (path, done, total) => {
        setProgress({ verb, path, done, total });
        await paint();
      });
    } catch (e) {
      setFixError({ message: (e as Error).message });
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  /** The files about to change, exactly as they stand, as one archive. */
  const downloadBackup = () =>
    run("backingUp", async (step) => {
      const entries: { path: string; bytes: Uint8Array }[] = [];
      for (const [index, plan] of chosen.entries()) {
        await step(plan.path, index, chosen.length);
        const file = fileByPath.get(plan.path);
        if (file) entries.push({ path: plan.path, bytes: await file.read() });
      }
      // Compressing the lot gets no step of its own: a whole library is 37 MB
      // of presentations and deflates in under three hundred milliseconds.
      const name = `propresenter-backup-${stamp()}.zip`;
      download(name, await zip(entries), "application/zip");
      setBackup({ name, paths: new Set(entries.map((entry) => entry.path)) });
    });

  const readFile = async (path: string) => {
    const file = fileByPath.get(path);
    if (!file) throw new Error(path);
    return file.read();
  };

  /**
   * Save through the desktop shell, which does the whole of it: reads each
   * file again, works its fixes out again, and backs up, writes and reads
   * back only the lines that come out as they were shown here.
   */
  async function saveNative() {
    // The checks on screen now, which decided what every fix shown does.
    const kinds = [...shown];
    // The folder the save is for: one opened while it runs has files of its own.
    const mine = displayed.current;
    await run("applying", async (step) => {
      await step(chosen[0]?.path ?? "", 0, chosen.length);
      const result = await bridge!.applyFixes(
        chosen.map((plan) => {
          const native = fileByPath.get(plan.path)?.native;
          return {
            path: native?.path ?? plan.path,
            sha256: native?.sha256 ?? "",
            kinds,
            lines: plan.fixes.map(({ boxIndex, lineIndex, before, after }) => ({ boxIndex, lineIndex, before, after })),
          };
        })
      );
      if (mine !== displayed.current) return;
      const shownAs = new Map(files.map((file) => [file.native?.path, file.path]));
      setNativeRun({ backupFolder: result.backupFolder, refused: result.refused });
      setBackupsUnshown(false);
      // A refused run replaces the last run's outcomes too: an earlier success is not this run's.
      setOutcomes(result.refused ? null : result.files.map((file) => ({ ...file, path: shownAs.get(file.path) ?? file.path })));
      // Read again what the run may have changed, so what is on screen is what is on disk.
      await rescan(chosen.flatMap((plan) => fileByPath.get(plan.path) ?? []), mine);
    });
  }

  async function saveFixes() {
    if (bridge) return saveNative();
    setFixError(null);
    // Taken before the prompt, which waits on the person: a folder opened
    // while it is up is not the one whose handle and files this save holds.
    const mine = displayed.current;
    // Scanning only ever asked to read. Writing is a separate promise, made
    // here where the reader has just asked for it and a gesture is in hand.
    if ((await requestHandlePermission(handle, "readwrite")) !== "granted") {
      if (mine === displayed.current) setFixError("permissionNeeded");
      return;
    }
    if (mine !== displayed.current) return;

    await run("applying", async (onFile) => {
      const result = await fixFiles(chosen, {
        read: readFile,
        write: async (path, bytes) => {
          const file = fileByPath.get(path);
          if (!file?.write) throw new Error(path);
          await file.write(bytes);
        },
        onFile,
      });
      if (mine !== displayed.current) return;
      setOutcomes(result);
      // The backup describes files that no longer look like that.
      setBackup(null);
      // Read the folder again, so what is on screen is what is on disk.
      await scan(files, mine);
    });
  }

  /** The fallback where nothing can be written: hand over corrected copies. */
  const downloadFixed = () =>
    run("fixing", async (onFile) => {
      const result = await fixFiles(chosen, { read: readFile, onFile });
      const entries = result
        .filter((outcome) => outcome.bytes)
        .map((outcome) => ({ path: outcome.path, bytes: outcome.bytes! }));
      const name = `propresenter-fixed-${stamp()}.zip`;
      download(name, await zip(entries), "application/zip");
      setOutcomes(result);
      setSavedZip(name);
    });

  return {
    backup,
    backedUp,
    outcomes,
    setOutcomes,
    savedZip,
    fixError,
    running,
    progress,
    nativeRun,
    backupsUnshown,
    setBackupsUnshown,
    clearRun,
    downloadBackup,
    saveFixes,
    downloadFixed,
  };
}

export type FixRun = ReturnType<typeof useFixRun>;
