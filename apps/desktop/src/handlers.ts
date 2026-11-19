import fs from "node:fs/promises";
import path from "node:path";
import type {
  ChosenFile,
  DesktopBridge,
  NativeApplyResult,
  NativeFolder,
  NativeWorkspace,
} from "@presenter-garage/core/lib/desktop";
import { applyPlan, everyLine, planChosenFixes } from "@presenter-garage/node/edits";
import { findPresentations, LibraryError, openRoots, readFoundFile, resolveInRoots } from "@presenter-garage/node/library";
import { documentAt, registeredWorkspaces, workspaceAt, workspacesDir } from "@presenter-garage/node/workspace";
import { sha256 } from "@presenter-garage/node/write";

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

type Handlers = { [K in keyof DesktopBridge]: (...args: Parameters<DesktopBridge[K]>) => ReturnType<DesktopBridge[K]> };

export function createHandlers(deps: ShellDeps): Handlers {
  const registryDir = deps.workspacesDir ?? workspacesDir();
  /** The folder open now, as `openRoots` resolved it. Nothing outside it can be read or written. */
  let roots: string[] = [];
  /** Backup folders this session's runs made, which are the only folders `showBackups` opens. */
  const backupFolders = new Set<string>();

  async function openFolder(dir: string): Promise<NativeFolder> {
    const opened = await openRoots([dir]);
    const root = opened[0];
    const workspace = await workspaceAt(root);
    // The registry is the one ProPresenter keeps in the folder above a workspace.
    const registered = workspace
      ? (await registeredWorkspaces(path.dirname(root))).find((w) => path.resolve(w.root) === root)
      : undefined;
    const cloud =
      registered?.cloud ?? (await fs.stat(path.join(root, "imprint.cloud")).then(() => true, () => false));
    const { files, truncated } = await findPresentations(opened);
    roots = opened;
    await remember(root);
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

  async function remember(root: string | undefined): Promise<void> {
    await fs.mkdir(path.dirname(deps.stateFile), { recursive: true });
    await fs.writeFile(deps.stateFile, JSON.stringify(root ? { lastFolder: root } : {}));
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
      const dir = await deps.chooseFolder();
      return dir === undefined ? null : openFolder(dir);
    },

    async reopenLast() {
      const dir = await lastFolder();
      if (dir === undefined) return null;
      // Moved, renamed or on a drive not plugged in: nothing to reopen, and
      // nothing to warn about, since the person can choose it again.
      return openFolder(dir).catch(() => null);
    },

    async forgetLast() {
      roots = [];
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
      const listed = await registeredWorkspaces(registryDir);
      if (typeof root !== "string" || !listed.some((w) => w.root === root)) {
        throw new LibraryError(`ProPresenter does not list a workspace at ${String(root)}.`);
      }
      return openFolder(root);
    },

    async read(p: string) {
      if (typeof p !== "string") throw new LibraryError("No file named.");
      const real = await resolveInRoots(roots, p);
      const stored = await documentAt(real);
      const { bytes } = await readFoundFile(real);
      return { bytes, sha256: stored ? stored.document.sha256 : sha256(bytes) };
    },

    async applyFixes(files: ChosenFile[]): Promise<NativeApplyResult> {
      if (!isChosenFiles(files)) throw new LibraryError("The lines to fix were not sent in a shape this understands.");
      if (roots.length === 0) throw new LibraryError("No folder is open.");
      try {
        const { plan, refused } = await planChosenFixes(roots, files);
        const run = plan.files.length > 0 ? await applyPlan(roots, plan, everyLine(plan), deps.backupDir) : { files: [] };
        if (run.backupFolder) backupFolders.add(run.backupFolder);
        return {
          backupFolder: run.backupFolder,
          files: [...refused, ...run.files.map(({ name: _name, ...outcome }) => outcome)],
        };
      } catch (e) {
        // A refusal of the whole run comes before anything is written: say
        // which, so the page can word it, rather than fail the call.
        const code = e instanceof LibraryError && e.code !== "lossy" ? e.code : undefined;
        return { files: [], refused: { code: code ?? "failed", detail: (e as Error).message } };
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

/** The page is ours, but what crosses into the main process is checked as though it were not. */
export function isChosenFiles(value: unknown): value is ChosenFile[] {
  return (
    Array.isArray(value) &&
    value.every(
      (file) =>
        typeof file === "object" &&
        file !== null &&
        isString(file.path) &&
        isString(file.sha256) &&
        Array.isArray(file.kinds) &&
        file.kinds.every(isString) &&
        Array.isArray(file.lines) &&
        file.lines.every(
          (line: unknown) =>
            typeof line === "object" &&
            line !== null &&
            isIndex((line as Record<string, unknown>).boxIndex) &&
            isIndex((line as Record<string, unknown>).lineIndex) &&
            isString((line as Record<string, unknown>).before) &&
            ((line as Record<string, unknown>).after === null || isString((line as Record<string, unknown>).after))
        )
    )
  );
}
