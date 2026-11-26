import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LibraryError, openRoots } from "@presenter-garage/node/library";
import { findRules, type FoundRules } from "@presenter-garage/node/rules";
import { registeredWorkspaces, staleNotes, workspaceAt, type RegisteredWorkspace } from "@presenter-garage/node/workspace";
import { defaultBackupDir, openBackupDir } from "@presenter-garage/node/write";

/**
 * The one library the server reads, and edits, at a time.
 *
 * One, because a song is checked against its own library's configured
 * groups and macros, and edits are backed up and refused by the folder they
 * were planned in: with several open at once, either could quietly go to the
 * wrong one. Which library it is can change, from the command line's folder
 * to the client's roots or to one the person approved through `use_library`,
 * and everything that depends on it is worked out again each time:
 * `openLibrary()` is that work.
 */

/** Where the library open now came from. */
export type LibrarySource =
  /** The folder the server was started on. */
  | "configured"
  /** None was configured: ProPresenter's active workspace, or `Documents/ProPresenter`. See `defaultLibrary`. */
  | "default"
  /** The client's roots. */
  | "client"
  /** `use_library`, with the person's approval. */
  | "approved";

export interface OpenLibrary {
  /** The real path, as `openRoots` resolved it. */
  root: string;
  source: LibrarySource;
  /** Whether it is a ProPresenter 22 workspace, which has no files of its own. */
  workspace: boolean;
  /** What a model must know before trusting what it reads: that the folder is a copy ProPresenter no longer updates, say. */
  notes: string[];
  /** The backup folder, as resolved against this library. Absent when nothing may be written here. */
  backupDir?: string;
}

export interface LibraryOptions {
  /** Write nothing, so no backup folder is needed. */
  readOnly?: boolean;
  /** Where backups go, before it is checked against a library. Defaults to `defaultBackupDir()`. */
  backupDir?: string;
  /** ProPresenter 22's registry, for the notes. Defaults to this computer's, keeping only the workspaces still there. */
  registered?: () => Promise<RegisteredWorkspace[]>;
}

const isFolder = (dir: string) => fs.stat(dir).then((s) => s.isDirectory(), () => false);

/** The workspaces ProPresenter 22 knows of whose folders are still there: the registry also keeps one whose folder has gone. */
export async function presentWorkspaces(): Promise<RegisteredWorkspace[]> {
  const registered = await registeredWorkspaces();
  const here = await Promise.all(registered.map((w) => isFolder(w.root)));
  return registered.filter((_, i) => here[i]);
}

/**
 * Open a library: resolve it, say what to know about it, and check the
 * backup folder against it.
 *
 * The backup folder is checked for every library and not once at start-up,
 * since one outside the first can be inside the next. One that cannot be
 * used turns editing off for this library rather than refusing it: no
 * backup, no write, but nothing stops a model reading.
 */
export async function openLibrary(dir: string, source: LibrarySource, options: LibraryOptions = {}): Promise<OpenLibrary> {
  const [root] = await openRoots([dir]);
  const notes = staleNotes(root, await (options.registered ?? presentWorkspaces)());
  const workspace = (await workspaceAt(root)) !== undefined;
  if (options.readOnly) return { root, source, workspace, notes };
  try {
    return { root, source, workspace, notes, backupDir: await openBackupDir(options.backupDir ?? defaultBackupDir(), [root]) };
  } catch (e) {
    if (!(e instanceof LibraryError)) throw e;
    return { root, source, workspace, notes: [...notes, `Editing is off for this library: ${e.message}`] };
  }
}

/**
 * Whether a folder is a ProPresenter library, for choosing among the
 * client's roots, which are usually the folders a person is working in
 * rather than ProPresenter's: a workspace, a ProPresenter folder (holding
 * `Libraries`, `Playlists` or `Configuration`), the folder above one, or one
 * library inside `Libraries`.
 */
export async function isProPresenterLibrary(dir: string): Promise<boolean> {
  if (!(await isFolder(dir))) return false;
  if (await workspaceAt(await fs.realpath(dir))) return true;
  if (path.basename(path.dirname(path.resolve(dir))) === "Libraries") return true;
  for (const folder of [dir, path.join(dir, "ProPresenter")]) {
    for (const name of ["Libraries", "Playlists", "Configuration"]) {
      if (await isFolder(path.join(folder, name))) return true;
    }
  }
  return false;
}

/** What `current_library` and `use_library` say about a library. */
export interface LibraryAnswer {
  path: string;
  source: LibrarySource;
  kind: "workspace" | "folder";
  /** Whether slide text can be edited here. */
  editing: boolean;
  backupDir?: string;
  notes: string[];
  /** The team's rules as found now, for reading with read_rules. */
  rules?: FoundRules;
}

/**
 * The library open now, and the changes to it, one at a time.
 *
 * A change -- the client's roots read, or a switch the person approved --
 * waits for the one before, and every tool waits for any under way, so no
 * tool reads one library and writes another.
 */
export class Library {
  private current: OpenLibrary | undefined;
  /** Why there is no library, when there is none. */
  private problem: string;
  /** What the client's roots came to, when that is worth saying. */
  private rootsNote: string | undefined;
  private changing: Promise<unknown> = Promise.resolve();
  private readonly listeners: ((library: OpenLibrary | undefined) => void)[] = [];

  /** The library to start on, or why there is none; also what the server falls back to when the client's roots name none. */
  private readonly start: OpenLibrary | { problem: string };
  private readonly options: LibraryOptions & { rulesDirs?: readonly string[] };

  constructor(start: OpenLibrary | { problem: string }, options: LibraryOptions & { rulesDirs?: readonly string[] } = {}) {
    this.start = start;
    this.options = options;
    this.current = "root" in start ? start : undefined;
    this.problem = "problem" in start ? start.problem : "";
  }

  /** The library open now, once any change under way has been made. */
  async get(): Promise<OpenLibrary> {
    await this.changing;
    if (!this.current) throw new LibraryError(this.problem);
    return this.current;
  }

  /** The library open now, without waiting: for saying which one a person is asked to switch from. */
  peek(): OpenLibrary | undefined {
    return this.current;
  }

  /** Called with the new library whenever it changes. */
  onChange(listener: (library: OpenLibrary | undefined) => void): void {
    this.listeners.push(listener);
  }

  /** Run a change once those before it are done. A change that fails leaves the library as it was. */
  private queue<T>(change: () => Promise<T>): Promise<T> {
    const run = this.changing.then(change);
    this.changing = run.catch(() => undefined);
    return run;
  }

  private set(library: OpenLibrary | undefined, problem = ""): void {
    const changed = library?.root !== this.current?.root || library?.backupDir !== this.current?.backupDir;
    this.current = library;
    this.problem = problem;
    if (changed) for (const listener of this.listeners) listener(library);
  }

  /** Open `dir` in place of the library open now: a switch the person has approved. */
  switchTo(dir: string): Promise<OpenLibrary> {
    return this.queue(async () => {
      const opened = await openLibrary(dir, "approved", this.options);
      this.rootsNote = undefined;
      this.set(opened);
      return opened;
    });
  }

  /**
   * Take the library from the client's roots: the first that is a
   * ProPresenter library. With none of them one, the library the server
   * started on stays or comes back, and the notes say why.
   */
  useClientRoots(list: () => Promise<{ uri: string; name?: string }[]>): Promise<void> {
    return this.queue(async () => {
      let roots: { uri: string }[];
      try {
        roots = await list();
      } catch (e) {
        this.rootsNote = `The client's folders could not be read (${(e as Error).message}), so they are not used.`;
        return;
      }
      const folders = roots.filter((r) => r.uri.startsWith("file:")).map((r) => fileFolder(r.uri)).filter((f) => f !== undefined);
      let chosen: string | undefined;
      for (const folder of folders) {
        if (await isProPresenterLibrary(folder)) {
          chosen = folder;
          break;
        }
      }
      if (chosen === undefined) {
        const fallback = await this.reopenStart();
        this.rootsNote =
          roots.length === 0
            ? undefined
            : `None of the client's folders (${folders.join(", ") || roots.map((r) => r.uri).join(", ")}) is a ProPresenter library, so ` +
              (fallback ? `${fallback.root} is read instead.` : "no library is open.");
        return;
      }
      let opened: OpenLibrary;
      try {
        opened = await openLibrary(chosen, "client", this.options);
      } catch (e) {
        this.rootsNote = `The client's folder ${chosen} could not be opened (${(e as Error).message}), so it is not read.`;
        return;
      }
      this.rootsNote =
        folders.length > 1
          ? `The client offered ${folders.length} folders; ${opened.root} is the first that is a ProPresenter library, and the only one read.`
          : undefined;
      this.set(opened);
    });
  }

  /**
   * The library the server started on, opened again: left as it is if it is
   * the one open, so a person's approved switch is not undone by roots that
   * name no library.
   */
  private async reopenStart(): Promise<OpenLibrary | undefined> {
    if (this.current && this.current.source !== "client") return this.current;
    if (!("root" in this.start)) {
      this.set(undefined, this.start.problem);
      return undefined;
    }
    try {
      const opened = await openLibrary(this.start.root, this.start.source, this.options);
      this.set(opened);
      return opened;
    } catch (e) {
      this.set(undefined, (e as Error).message);
      return undefined;
    }
  }

  /** What to say about the library open now. */
  async describe(): Promise<LibraryAnswer> {
    const library = await this.get();
    let rules: FoundRules | undefined;
    try {
      rules = await findRules(undefined, this.options.rulesDirs ?? []);
    } catch {
      rules = undefined;
    }
    return describeLibrary(library, [...library.notes, ...(this.rootsNote ? [this.rootsNote] : [])], rules);
  }
}

export function describeLibrary(library: OpenLibrary, notes: string[], rules?: FoundRules): LibraryAnswer {
  return {
    path: library.root,
    source: library.source,
    kind: library.workspace ? "workspace" : "folder",
    editing: library.backupDir !== undefined,
    ...(library.backupDir ? { backupDir: library.backupDir } : {}),
    notes,
    ...(rules ? { rules } : {}),
  };
}

/** The folder a `file:` URI names, or nothing for one that does not parse. */
function fileFolder(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}
