import fs from "node:fs/promises";
import path from "node:path";
import type {
  ChosenFile,
  ChosenLine,
  DesktopBridge,
  NativeApplyResult,
  NativeFolder,
  NativeWorkspace,
} from "@presenter-garage/core/lib/desktop";
import { applyPlan, everyLine, planChosenFixes, readWithHash } from "@presenter-garage/node/edits";
import { findPresentations, LibraryError, openRoots, resolveInRoots } from "@presenter-garage/node/library";
import { WorkspaceRefused } from "@presenter-garage/node/paths";
import { hasCloudImprint, registeredWorkspaces, workspaceAt, workspacesDir } from "@presenter-garage/node/workspace";

/**
 * What the main process does for each call the page makes, apart from
 * Electron so the suite can drive it with a temporary folder.
 *
 * The page names files only by the paths these handed it, and every one is
 * resolved again inside the folder that is open before anything is read:
 * `resolveInRoots` follows symlinks first, so a path that climbs out of the
 * folder, or a link inside it that points out, is refused. Writing is
 * `applyFixes` alone, through `packages/node/src/edits.ts`, which the MCP
 * server uses too -- see AGENTS.md for the four guards.
 */

export interface ShellDeps {
  /** The system's folder dialog. Undefined when it was dismissed. */
  chooseFolder(): Promise<string | undefined>;
  /** Show a folder in Finder or Explorer. */
  showFolder(dir: string): Promise<void>;
  /** Where the folder open last time is remembered. */
  stateFile: string;
  /** Where each run's backups go, as the MCP server's default is: outside every library. */
  backupDir: string;
  /** ProPresenter 22's `Workspaces` folder, beside its registry. */
  workspacesDir?: string;
}

export function createHandlers(deps: ShellDeps): DesktopBridge {
  const registryDir = deps.workspacesDir ?? workspacesDir();
  /** The folder open now, as `openRoots` resolved it. Nothing outside it can be read or written. */
  let roots: string[] = [];
  /** The presentations its walk listed: the only paths `read` answers for. */
  let listed = new Set<string>();
  /**
   * Bumped by every open and every forget. An open that finds it moved on
   * while it walked the folder was overtaken, and leaves the state alone.
   */
  let generation = 0;
  /** Writes of the remembered folder, in the order they were asked for, so a later forget stays final. */
  let saving: Promise<unknown> = Promise.resolve();
  /** Backup folders this session's runs made, which are the only folders `showBackups` opens. */
  const backupFolders = new Set<string>();

  /** `mine` is taken by the caller before its own first wait, so a forget during that wait overtakes it too. */
  async function openFolder(dir: string, mine = ++generation): Promise<NativeFolder> {
    const opened = await openRoots([dir]);
    const root = opened[0];
    const workspace = await workspaceAt(root);
    // The registry is the one ProPresenter keeps in the folder above a workspace.
    const registered = workspace
      ? (await registeredWorkspaces(path.dirname(root))).find((w) => path.resolve(w.root) === root)
      : undefined;
    // Either says Cloud, as the write path's own check (`checkWritableWorkspace`) takes either.
    const cloud = registered?.cloud === true || (await hasCloudImprint(root));
    const { files, truncated } = await findPresentations(opened);
    if (mine !== generation) throw new LibraryError(`${root} was closed or replaced while it was opening.`);
    roots = opened;
    listed = new Set(files);
    // Remembering is a convenience: a folder that opened is open, whether or not it could be noted.
    await remember(root).catch(() => undefined);
    return {
      root,
      name: registered?.name ?? path.basename(root),
      ...(workspace && { workspace: { name: registered?.name, cloud } }),
      files: files.map((file) => ({
        path: file,
        relative: path.relative(root, file).split(path.sep).join("/"),
        name: path.basename(file),
      })),
      truncated,
    };
  }

  function remember(root: string | undefined): Promise<void> {
    const write = saving.then(async () => {
      await fs.mkdir(path.dirname(deps.stateFile), { recursive: true });
      await fs.writeFile(deps.stateFile, JSON.stringify(root ? { lastFolder: root } : {}));
    });
    saving = write.catch(() => undefined);
    return write;
  }

  async function lastFolder(): Promise<string | undefined> {
    try {
      const saved = JSON.parse(await fs.readFile(deps.stateFile, "utf8")) as { lastFolder?: unknown };
      return typeof saved.lastFolder === "string" ? saved.lastFolder : undefined;
    } catch {
      return undefined;
    }
  }

  return {
    async pickFolder() {
      // Taken before the dialog, as the page takes its own: a workspace
      // opened while the dialog is still up is the later choice, and the page
      // keeps showing it, so the folder the dialog returns must not replace it.
      const mine = ++generation;
      const dir = await deps.chooseFolder();
      return dir === undefined ? null : openFolder(dir, mine);
    },

    async reopenLast() {
      const mine = ++generation;
      const dir = await lastFolder();
      if (dir === undefined) return null;
      // Moved, renamed or on a drive not plugged in: nothing to reopen, and
      // nothing to warn about, since the person can choose it again.
      return openFolder(dir, mine).catch(() => null);
    },

    async forgetLast() {
      generation++;
      roots = [];
      listed = new Set();
      await remember(undefined);
    },

    async workspaces(): Promise<NativeWorkspace[]> {
      const listed = await registeredWorkspaces(registryDir);
      return listed
        .map(({ root, name, active, cloud }) => ({ root, name, active, cloud }))
        .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
    },

    async openWorkspace(root: string) {
      // Only one the registry lists: the page cannot open any folder by
      // naming it, only through the dialog a person answers.
      const mine = ++generation;
      const listed = await registeredWorkspaces(registryDir);
      if (typeof root !== "string" || !listed.some((w) => w.root === root)) {
        throw new LibraryError(`ProPresenter does not list a workspace at ${String(root)}.`);
      }
      return openFolder(root, mine);
    },

    async read(p: string) {
      if (typeof p !== "string") throw new LibraryError("No file named.");
      // Only what the folder's walk listed: the open folder may hold other files that are none of the page's business.
      // Checked again once links are followed: a listed file since replaced by a link to another file is not that file.
      const real = listed.has(p) ? await resolveInRoots(roots, p) : undefined;
      if (real === undefined || !listed.has(real)) throw new LibraryError(`Not a presentation in the open folder: ${p}`);
      return readWithHash(real);
    },

    async applyFixes(files: ChosenFile[]): Promise<NativeApplyResult> {
      if (!isChosenFiles(files)) throw new LibraryError("The lines to fix were not sent in a shape this understands.");
      if (roots.length === 0) throw new LibraryError("No folder is open.");
      // The folder the save was asked of, for planning and applying alike: one
      // opened meanwhile would pair this plan with another folder's roots.
      const asked = roots;
      try {
        const { plan, refused } = await planChosenFixes(asked, files);
        const run = plan.files.length > 0 ? await applyPlan(asked, plan, everyLine(plan), deps.backupDir) : { files: [] };
        if (run.backupFolder) backupFolders.add(run.backupFolder);
        // The page words each refusal itself, so the English the MCP server gives a model stays here.
        return {
          backupFolder: run.backupFolder,
          files: [...refused, ...run.files].map(({ path: p, lines, written, backup, reason, rangeReason }) => ({
            path: p,
            lines,
            written,
            ...(backup && { backup }),
            ...(reason && { reason }),
            ...(rangeReason && { rangeReason }),
          })),
        };
      } catch (e) {
        // A refusal of the whole run comes before anything is written: say
        // which, so the page can word it, rather than fail the call.
        const code = e instanceof WorkspaceRefused ? e.code : "failed";
        return { files: [], refused: { code, detail: (e as Error).message } };
      }
    },

    async showBackups(folder: string) {
      if (!backupFolders.has(folder)) throw new LibraryError("Not a backup folder made by this app.");
      await deps.showFolder(folder);
    },
  };
}

const isString = (v: unknown): v is string => typeof v === "string";
const isIndex = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function isChosenLine(v: unknown): v is ChosenLine {
  return (
    isRecord(v) && isIndex(v.boxIndex) && isIndex(v.lineIndex) && isString(v.before) && (v.after === null || isString(v.after))
  );
}

/** The page is ours, but what crosses into the main process is checked as though it were not. */
export function isChosenFiles(value: unknown): value is ChosenFile[] {
  return (
    Array.isArray(value) &&
    value.every(
      (file) =>
        isRecord(file) &&
        isString(file.path) &&
        isString(file.sha256) &&
        Array.isArray(file.kinds) &&
        file.kinds.every(isString) &&
        Array.isArray(file.lines) &&
        file.lines.every(isChosenLine)
    )
  );
}
