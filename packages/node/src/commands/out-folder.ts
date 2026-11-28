import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isInside, LibraryError } from "../library";

/**
 * Where the read-only commands leave their results, and the one thing they
 * write: the command line's `--out`, and the MCP server's `out`.
 *
 * Results go to disk rather than into an answer because an answer is read
 * by a model and sent to its provider, and a library's lyrics have no reason
 * to go there. On disk they are only somebody's library again, so nothing
 * here ever removes or replaces a file. `out` names a parent folder; each run
 * makes a new folder of its own inside it, named for the command and the
 * time, and writes only there. What is already in `out` is never touched.
 * The run's folder is never inside a library the run reads. A run that
 * fails part way leaves its folder as far as it got, for the person to
 * delete.
 *
 * Not a ProPresenter file, so AGENTS.md's write guards are not what protects
 * it; the libraries stay untouched because nothing here is let near them.
 */

export type Command = "sources" | "dump" | "compare" | "check" | "rules-check" | "review";

/** A run's own folder, and the one way to write into it. */
export interface OutFolder {
  /** The run's folder: new, made for this run, absolute. */
  dir: string;
  /** Write a new file under the folder; returns its absolute path. */
  put(relative: string, content: string): Promise<string>;
  /** Make a folder under it, empty if nothing goes in it. */
  mkdir(relative: string): Promise<void>;
}

/**
 * A folder a model or a person named, as an absolute path: a `file:` URL
 * converted, a relative path refused, since it would resolve against
 * wherever the server happened to start.
 */
export function absoluteFolder(given: string, what: string): string {
  const dir = given.startsWith("file:") ? fileURLToPath(given) : given;
  if (!path.isAbsolute(dir)) throw new LibraryError(`Give an absolute folder for ${what}, not ${given}.`);
  return dir;
}

/** How many names a run tries before giving up: the same second, many runs over. */
const ATTEMPTS = 100;

/**
 * Run `write` with a new folder made for `command` inside `out`, refusing it
 * if it would be inside any of `libraries`, or hold one.
 *
 * Every folder and file under `out` is made with an exclusive call, which
 * fails rather than use one already there, so two runs into one `out` at
 * once, as the MCP server runs calls, each get their own folder, and a run
 * never writes over anything.
 */
export async function writeOut<T>(
  out: string,
  command: Command,
  libraries: readonly string[],
  write: (folder: OutFolder) => Promise<T>
): Promise<T> {
  const parent = path.resolve(out);
  // Before anything is made: a folder created inside a library is already a write to it.
  await refuseLibraries(parent, libraries, { holding: false });
  await fs.mkdir(parent, { recursive: true }).catch((e: NodeJS.ErrnoException) => {
    throw e.code === "EEXIST" || e.code === "ENOTDIR" ? new LibraryError(`${parent} is not a folder: give a folder for the results.`) : e;
  });
  const dir = await makeRunFolder(parent, command);
  let real: string;
  // Again where it really is: a link in `out`, made in between, could have put it anywhere.
  try {
    real = await fs.realpath(dir);
    await refuseLibraries(real, libraries, { shown: dir });
  } catch (e) {
    // Empty, and made a moment ago by this run: taken away so the library is as it was. `rmdir` removes nothing else.
    await fs.rmdir(dir).catch(() => undefined);
    throw e;
  }
  const made = new Map<string, Promise<void>>();
  return write({
    dir,
    put: async (relative, content) => {
      const file = inside(dir, relative);
      await folders(dir, real, path.dirname(file), made);
      return put(real, file, content);
    },
    mkdir: (relative) => folders(dir, real, inside(dir, relative), made),
  });
}

/** `<command>-<UTC time>`, with `-2`, `-3`… after it when that name is taken, made with an exclusive `mkdir`. */
async function makeRunFolder(parent: string, command: Command): Promise<string> {
  const stamp = `${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}Z`;
  for (let n = 1; n <= ATTEMPTS; n++) {
    const dir = path.join(parent, `${command}-${stamp}${n > 1 ? `-${n}` : ""}`);
    try {
      await fs.mkdir(dir);
      return dir;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new LibraryError(`${parent} already has ${ATTEMPTS} folders for ${command} from this second: try again in a moment.`);
}

/** `relative` under the run's folder, refused if its name would take it outside, or to the folder itself. */
function inside(dir: string, relative: string): string {
  const file = path.resolve(dir, relative);
  if (!isInside(dir, file) || file === dir) throw new LibraryError(`Refusing to write outside ${dir}: ${relative}`);
  return file;
}

/**
 * Make `folder` and every folder between it and the run's, each with an
 * exclusive `mkdir`: one already there that this run did not make is
 * somebody else's, and refused. Then check that `folder` really is inside
 * the run's folder, so a link swapped in for one of them is caught.
 */
async function folders(dir: string, real: string, folder: string, made: Map<string, Promise<void>>): Promise<void> {
  let at = dir;
  for (const part of path.relative(dir, folder).split(path.sep).filter(Boolean)) {
    at = path.join(at, part);
    let making = made.get(at);
    if (!making) {
      const target = at;
      making = fs.mkdir(target).catch((e: NodeJS.ErrnoException) => {
        // Not kept: a later write under it tries again rather than repeat this failure.
        made.delete(target);
        if (e.code === "EEXIST") throw new LibraryError(`${target} is already there, and this run did not make it.`);
        throw e;
      });
      made.set(target, making);
    }
    await making;
  }
  await refuseLinked(real, folder);
}

/** Refuse a folder whose real path is not under the run folder's: a link has been put in the way. */
async function refuseLinked(real: string, folder: string): Promise<void> {
  if (!isInside(real, await fs.realpath(folder))) {
    throw new LibraryError(`Refusing to write through ${folder}: it has been replaced by a link out of the run's folder.`);
  }
}

/**
 * Write a new file. `wx` never replaces a file, and never follows a link
 * left where the file goes.
 *
 * The window this leaves open: Node has no `openat`, so the open cannot be
 * anchored to the folder checked just before it. Between that check and the
 * open, a folder inside the run's could be swapped for a link, and the file
 * would be made where the link points. The run's folder is new and only this
 * run writes in it, so that takes somebody with the person's own access
 * racing the run on purpose. The folder is checked again once the file is
 * open, so a swap is reported and the run stops before writing a byte to
 * it; the empty file is left where it was made.
 */
async function put(real: string, file: string, content: string): Promise<string> {
  const handle = await fs.open(file, "wx").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "EEXIST") throw new LibraryError(`${file} is already there: a run never writes over a file.`);
    throw e;
  });
  try {
    await refuseLinked(real, path.dirname(file));
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  return file;
}

/**
 * Refuse a folder inside a library, or, unless `holding` is false, one
 * holding a library, compared by real path so that a link cannot hide
 * either. A folder not made yet is compared through the nearest folder
 * above it that is there.
 */
async function refuseLibraries(
  dir: string,
  libraries: readonly string[],
  { holding = true, shown = dir }: { holding?: boolean; shown?: string } = {}
): Promise<void> {
  const real = await realPath(dir);
  for (const library of libraries) {
    const root = await realPath(library);
    if (isInside(root, real)) throw new LibraryError(`${shown} is inside the library ${library}: results are never written into a library. Give a folder outside it.`);
    if (holding && isInside(real, root)) throw new LibraryError(`${shown} holds the library ${library}: give a folder outside it.`);
  }
}

/** A path's real location, through the nearest part of it that exists. */
async function realPath(p: string): Promise<string> {
  let rest = "";
  let at = path.resolve(p);
  for (;;) {
    try {
      return path.join(await fs.realpath(at), rest);
    } catch (e) {
      // A file in the way is the `mkdir` after this to report, as a folder that cannot be made.
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
      const up = path.dirname(at);
      if (up === at) return path.join(at, rest);
      rest = path.join(path.basename(at), rest);
      at = up;
    }
  }
}
