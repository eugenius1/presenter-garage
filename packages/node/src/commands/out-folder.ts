import fs from "node:fs/promises";
import path from "node:path";
import { isInside, LibraryError } from "../library";

/**
 * The folder the read-only commands leave their results in, and the one
 * thing they write: the command line's `--out`, and the MCP server's `out`.
 *
 * Results go to disk rather than into an answer because an answer is read
 * by a model and sent to its provider, and a library's lyrics have no reason
 * to go there. On disk they are only somebody's library again, so a run
 * pointed at the wrong folder must not scatter them through it, or clear it
 * out: a folder is written only when it is empty, or when the same command
 * wrote it before, which the marker file it leaves says. It is never one
 * inside a library the run reads, nor one holding it.
 *
 * Not a ProPresenter file, so AGENTS.md's write guards are not what protects
 * it; the libraries stay untouched because nothing here is let near them.
 */

/** Left in every folder a command writes, so a later run knows the folder is its own. */
export const MARKER = ".presenter-garage.json";
const FORMAT = "presenter-garage/out";

export type Command = "sources" | "dump" | "compare" | "check" | "rules-check";

/**
 * What each command writes at the top of its folder, removed before it
 * writes again, so a song that has gone since leaves no file behind.
 */
const GENERATED: Record<Command, readonly string[]> = {
  sources: ["sources.json", "sources.txt"],
  dump: ["songs", "index.json"],
  compare: ["text", "compare.json", "report.html"],
  check: ["check.json", "check.txt"],
  "rules-check": ["rules-check.json", "rules-check.txt"],
};

/** A folder ready to be written into, and the one way to write into it. */
export interface OutFolder {
  /** Resolved, absolute. */
  dir: string;
  /** Write a file under the folder; returns its absolute path. */
  put(relative: string, content: string): Promise<string>;
  /** Make a folder under it, empty if nothing goes in it. */
  mkdir(relative: string): Promise<void>;
}

/**
 * Make `out` ready for `command` to write into, refusing it if it is inside
 * any of `libraries`, or holds one, or is neither empty nor this command's.
 */
export async function openOut(out: string, command: Command, libraries: readonly string[]): Promise<OutFolder> {
  const dir = path.resolve(out);
  // Before anything is made: a folder created inside a library is already a write to it.
  await refuseLibraries(dir, libraries);
  const entries = await fs.readdir(dir).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return undefined;
    throw e;
  });
  if (entries === undefined) {
    await fs.mkdir(dir, { recursive: true });
    // Again once it is there: a link in the path, made in between, could have put it anywhere.
    await refuseLibraries(dir, libraries);
  } else if (entries.length > 0) {
    const marked = await marker(dir);
    if (marked !== command) {
      throw new LibraryError(
        marked
          ? `${dir} holds what ${marked} wrote. Give ${command} a folder of its own: an empty or new one.`
          : `${dir} is not empty and is not a folder this command wrote. Give an empty or new folder.`
      );
    }
    for (const name of GENERATED[command]) await fs.rm(path.join(dir, name), { recursive: true, force: true });
  }
  // First, so that a run that stops part way leaves a folder the next run knows as its own.
  await fs.rm(path.join(dir, MARKER), { force: true });
  await fs.writeFile(path.join(dir, MARKER), `${JSON.stringify({ format: FORMAT, version: 1, command, created: new Date().toISOString() }, null, 2)}\n`, { flag: "wx" });
  return {
    dir,
    put: (relative, content) => put(dir, relative, content),
    mkdir: async (relative) => void (await placed(dir, relative, true)),
  };
}

/** The command that marked a folder as its own, if one did. */
async function marker(dir: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(path.join(dir, MARKER));
    // A link where the marker should be is somebody else's, whatever it points at.
    if (!stat.isFile()) return undefined;
    const parsed = JSON.parse(await fs.readFile(path.join(dir, MARKER), "utf8")) as { format?: unknown; command?: unknown };
    return parsed.format === FORMAT && typeof parsed.command === "string" ? parsed.command : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Refuse a folder inside a library, or holding one, compared by real path
 * so that a link cannot hide either. A folder not made yet is compared
 * through the nearest folder above it that is there.
 */
async function refuseLibraries(dir: string, libraries: readonly string[]): Promise<void> {
  const real = await realPath(dir);
  for (const library of libraries) {
    const root = await realPath(library);
    if (isInside(root, real)) throw new LibraryError(`${dir} is inside the library ${library}: results are never written into a library. Give a folder outside it.`);
    if (isInside(real, root)) throw new LibraryError(`${dir} holds the library ${library}: give a folder outside it.`);
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
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const up = path.dirname(at);
      if (up === at) return path.join(at, rest);
      rest = path.join(path.basename(at), rest);
      at = up;
    }
  }
}

/**
 * Where `relative` is under `dir`, with the folder it goes in made, or the
 * folder itself where it is one: refused if it would land outside `dir`,
 * whether by its name or by a link.
 */
async function placed(dir: string, relative: string, isFolder = false): Promise<string> {
  const file = path.resolve(dir, relative);
  if (!isInside(dir, file) || file === dir) throw new LibraryError(`Refusing to write outside ${dir}: ${relative}`);
  const parent = isFolder ? file : path.dirname(file);
  await fs.mkdir(parent, { recursive: true });
  if (!isInside(await fs.realpath(dir), await fs.realpath(parent))) {
    throw new LibraryError(`Refusing to write outside ${dir}: ${relative} is reached through a link`);
  }
  return file;
}

/**
 * Write a file under `dir`, refusing any path that would land outside it,
 * whether by its name or by a link, and any file already there: what this
 * command wrote before is gone by now, so anything left is somebody else's.
 */
async function put(dir: string, relative: string, content: string): Promise<string> {
  const file = await placed(dir, relative);
  try {
    // `wx` never follows a link left where the file goes, and never replaces a file.
    await fs.writeFile(file, content, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new LibraryError(`${file} is already there, and is not this command's to replace.`);
    throw e;
  }
  return file;
}
