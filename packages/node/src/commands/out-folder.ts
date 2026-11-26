import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
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
 * wrote it before, which the marker file it leaves says, and then only what
 * that marker lists is removed. It is never one inside a library the run
 * reads, nor one holding it.
 *
 * Not a ProPresenter file, so AGENTS.md's write guards are not what protects
 * it; the libraries stay untouched because nothing here is let near them.
 */

/** Left in every folder a command writes, so a later run knows the folder is its own. */
export const MARKER = ".presenter-garage.json";
const FORMAT = "presenter-garage/out";

export type Command = "sources" | "dump" | "compare" | "check" | "rules-check";

/**
 * What each command writes at the top of its folder: the only places it
 * writes, and the only places the next run clears.
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
 * A file a run wrote: where, and which file it is. A name alone cannot say
 * that: a file a person puts at the same name, or at one a file system
 * holds apart only by how its accents are composed, is another file.
 */
interface Written {
  /** Relative to the folder, with `/` between its parts, as the run named it. */
  path: string;
  /** The file system's own identity for it, device and inode, taken from the file the run created. */
  id: string;
  /** Its size and modification time once written: a file changed since is no longer only the run's. */
  size?: string;
  mtime?: string;
}

/** What the marker says: the command that wrote the folder, and everything it wrote there. */
interface Marker {
  command: string;
  files: Written[];
  folders: string[];
}

/** The run writing into each folder now, by real path, which the next run there waits for. */
const busy = new Map<string, Promise<unknown>>();

/**
 * Run `write` with `out` ready for `command` to write into, refusing it if it
 * is inside any of `libraries`, or holds one, or is neither empty nor this
 * command's, or if what this command wrote there before now holds a file it
 * did not write.
 *
 * Runs into the same folder take turns: two at once would each clear what
 * the other is writing. Every file and folder the run writes is recorded in
 * the marker, even when it fails part way, so the next run removes exactly
 * those and nothing a person put beside them.
 */
export async function writeOut<T>(
  out: string,
  command: Command,
  libraries: readonly string[],
  write: (folder: OutFolder) => Promise<T>
): Promise<T> {
  const dir = path.resolve(out);
  const key = await realPath(dir);
  const before = busy.get(key) ?? Promise.resolve();
  const run = before.then(() => openAndWrite(dir, command, libraries, write));
  const settled = run.catch(() => undefined);
  busy.set(key, settled);
  try {
    return await run;
  } finally {
    if (busy.get(key) === settled) busy.delete(key);
  }
}

async function openAndWrite<T>(
  dir: string,
  command: Command,
  libraries: readonly string[],
  write: (folder: OutFolder) => Promise<T>
): Promise<T> {
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
    if (marked?.command !== command) {
      throw new LibraryError(
        marked
          ? `${dir} holds what ${marked.command} wrote. Give ${command} a folder of its own: an empty or new one.`
          : `${dir} is not empty and is not a folder this command wrote. Give an empty or new folder.`
      );
    }
    await clear(dir, command, marked);
  }
  const created = new Date().toISOString();
  const files = new Map<string, Written>();
  const folders = new Set<string>();
  const record = () =>
    mark(dir, {
      format: FORMAT,
      version: 1,
      command,
      created,
      files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      folders: [...folders].sort(),
    });
  // First, so that a run that stops part way leaves a folder the next run knows as its own.
  await record();
  const folder: OutFolder = {
    dir,
    put: async (relative, content) => {
      const file = await placed(dir, command, relative);
      const name = posix(dir, file);
      return put(file, content, (identity) => files.set(name, { path: name, ...identity }));
    },
    mkdir: async (relative) => {
      folders.add(posix(dir, await placed(dir, command, relative, true)));
    },
  };
  let result: T;
  try {
    result = await write(folder);
  } catch (e) {
    await record().catch(() => undefined);
    throw e;
  }
  await record();
  return result;
}

/** A path under `dir` as the marker records it: relative, with `/` between its parts. */
const posix = (dir: string, file: string) => path.relative(dir, file).split(path.sep).join("/");

/**
 * A path the marker may name: relative, below the folder, in plain parts.
 * Anything else, an absolute path, `..`, an empty part, is not one this
 * code wrote, and is dropped rather than walked.
 */
const isOutputPath = (p: unknown): p is string =>
  typeof p === "string" && p.length > 0 && !p.includes("\\") && !p.includes("\0") && p.split("/").every((part) => part !== "" && part !== "." && part !== "..");

/** A file's identity, and once it is written its size and time, as the marker records them. */
const identity = (stat: BigIntStats, written: boolean): Omit<Written, "path"> => ({
  id: `${stat.dev}:${stat.ino}`,
  ...(written ? { size: String(stat.size), mtime: String(stat.mtimeNs) } : {}),
});

/** The marker, if a command left one; a link where it should be is somebody else's, whatever it points at. */
async function marker(dir: string): Promise<Marker | undefined> {
  try {
    const stat = await fs.lstat(path.join(dir, MARKER));
    if (!stat.isFile()) return undefined;
    const parsed = JSON.parse(await fs.readFile(path.join(dir, MARKER), "utf8")) as { format?: unknown; command?: unknown; files?: unknown; folders?: unknown };
    if (parsed.format !== FORMAT || typeof parsed.command !== "string") return undefined;
    const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
    const optional = (value: unknown) => value === undefined || typeof value === "string";
    // Only what this code would have written: anything else owns nothing, so whatever it names is a stranger.
    const files = list(parsed.files).filter(
      (f): f is Written =>
        typeof f === "object" && f !== null && isOutputPath((f as Written).path) && typeof (f as Written).id === "string" && optional((f as Written).size) && optional((f as Written).mtime)
    );
    return { command: parsed.command, files, folders: list(parsed.folders).filter(isOutputPath) };
  } catch {
    return undefined;
  }
}

/**
 * Write the marker whole, never half: written beside it, then moved over
 * it. Beside it under a name no other run or person has, so nothing already
 * there is touched; only the marker itself is replaced.
 */
async function mark(dir: string, content: object): Promise<void> {
  const next = path.join(dir, `${MARKER}.${randomUUID()}.new`);
  await fs.writeFile(next, `${JSON.stringify(content, null, 2)}\n`, { flag: "wx" });
  try {
    await fs.rename(next, path.join(dir, MARKER));
  } catch (e) {
    await fs.rm(next, { force: true });
    throw e;
  }
}

/**
 * Remove what `command` wrote before, so a song that has gone since leaves
 * no file behind. Anything under its names the marker does not list, a file
 * a person added or one a run that stopped part way could not record, is
 * refused before a thing is removed.
 */
async function clear(dir: string, command: Command, marked: Marker): Promise<void> {
  const ours = new Set(marked.folders);
  for (const file of marked.files) {
    for (let up = path.posix.dirname(file.path); up !== "." && up !== path.posix.dirname(up); up = path.posix.dirname(up)) ours.add(up);
  }
  const byId = new Map(marked.files.map((file) => [file.id, file]));
  /**
   * Whether this entry is the very file the run wrote: the same identity,
   * unchanged since, at its name. The name is compared composed only because
   * a file system that decomposes names gives them back so; the identity is
   * what makes it the run's, and each identity is claimed once.
   */
  const owned = (relative: string, stat: BigIntStats) => {
    const file = byId.get(`${stat.dev}:${stat.ino}`);
    if (!file || !stat.isFile() || file.path.normalize("NFC") !== relative.normalize("NFC")) return false;
    if (file.size !== undefined && (file.size !== String(stat.size) || file.mtime !== String(stat.mtimeNs))) return false;
    byId.delete(file.id);
    return true;
  };
  const files: string[] = [];
  const folders: string[] = [];
  const strangers: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const stat = await fs.lstat(path.join(dir, relative), { bigint: true }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return undefined;
      throw e;
    });
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(path.join(dir, relative))) await walk(`${relative}/${name}`);
      // After what is in it, so it is removed once empty; only one named as the run named it, and only if empty by then.
      if (ours.has(relative)) folders.push(relative);
    } else if (owned(relative, stat)) {
      files.push(relative);
    } else {
      strangers.push(relative);
    }
  };
  for (const name of GENERATED[command]) await walk(name);
  if (strangers.length > 0) {
    const shown = strangers.slice(0, 3).map((s) => path.join(dir, s)).join(", ");
    const more = strangers.length > 3 ? ` and ${strangers.length - 3} more` : "";
    throw new LibraryError(
      `${shown}${more} ${strangers.length === 1 ? "was" : "were"} not written by ${command}, which would remove it to write again. ` +
        "Move what you want to keep out of the folder, or give an empty or new one."
    );
  }
  for (const file of files) await fs.rm(path.join(dir, file));
  for (const folder of folders) {
    await fs.rmdir(path.join(dir, folder)).catch((e: NodeJS.ErrnoException) => {
      // A folder a person made inside it keeps it.
      if (e.code !== "ENOTEMPTY" && e.code !== "EEXIST" && e.code !== "ENOENT") throw e;
    });
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
 * whether by its name or by a link, or anywhere but under one of the names
 * `command` writes, the only places the next run looks to clear.
 */
async function placed(dir: string, command: Command, relative: string, isFolder = false): Promise<string> {
  const file = path.resolve(dir, relative);
  if (!isInside(dir, file) || file === dir) throw new LibraryError(`Refusing to write outside ${dir}: ${relative}`);
  if (!GENERATED[command].includes(posix(dir, file).split("/")[0])) {
    throw new LibraryError(`Refusing to write ${relative}: ${command} writes only ${GENERATED[command].join(", ")}`);
  }
  const parent = isFolder ? file : path.dirname(file);
  const real = await fs.realpath(dir);
  // Asked before the folder is made, so a link in the way has nothing made through it, and again after.
  for (const when of ["before", "after"] as const) {
    if (when === "after") await fs.mkdir(parent, { recursive: true });
    if (!isInside(real, await realPath(parent))) {
      throw new LibraryError(`Refusing to write outside ${dir}: ${relative} is reached through a link`);
    }
  }
  return file;
}

/**
 * Write a new file, refusing any already there: what this command wrote
 * before is gone by now, so anything left is somebody else's. `made` is
 * told the file's identity once the file is this run's, before a byte is
 * written, so a file left half written is still known as its own, and again
 * with its size and time once it is written.
 */
async function put(file: string, content: string, made: (identity: Omit<Written, "path">) => void): Promise<string> {
  // `wx` never follows a link left where the file goes, and never replaces a file.
  const handle = await fs.open(file, "wx").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "EEXIST") throw new LibraryError(`${file} is already there, and is not this command's to replace.`);
    throw e;
  });
  try {
    made(identity(await handle.stat({ bigint: true }), false));
    await handle.writeFile(content);
    made(identity(await handle.stat({ bigint: true }), true));
  } finally {
    await handle.close();
  }
  return file;
}
