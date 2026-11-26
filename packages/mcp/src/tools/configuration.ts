import {
  decodeGroupsDocument,
  decodeMacrosDocument,
  readGroups,
  readMacros,
  type ConfiguredGroup,
  type ConfiguredMacro,
} from "@presenter-garage/core/lib/configuration";
import { findGroups, findMacros, LibraryError, readLibraryFile } from "@presenter-garage/node/library";

/** ProPresenter's configured groups and macros: `read_groups_and_macros`. */

export interface Configuration {
  /** The groups a slide can be put in, in ProPresenter's order. */
  groups: ConfiguredGroup[];
  groupsPath?: string;
  /** The macros a slide can trigger, in ProPresenter's order. */
  macros: ConfiguredMacro[];
  macrosPath?: string;
  /** Why a list is empty because it could not be found or read; absent when both were read. */
  unreadable?: { groups?: string; macros?: string };
}

/** One configured list, or why not. */
async function readConfigured<T>(
  root: string,
  find: (roots: readonly string[]) => Promise<string | undefined>,
  missing: string,
  read: (bytes: Uint8Array) => T[]
): Promise<{ path?: string; items: T[]; problem?: string }> {
  const file = await find([root]);
  if (!file) return { items: [], problem: missing };
  try {
    // Through the library folder, as every other read: `Configuration` can be a symlink leading out of it.
    const { path: real, bytes } = await readLibraryFile([root], file);
    return { path: real, items: read(bytes) };
  } catch (e) {
    // protobuf.js says why it could not decode; a LibraryError says why it could not read.
    return { path: file, items: [], problem: (e as Error).message };
  }
}

/**
 * ProPresenter's configured groups and macros: the lists a presentation's
 * groups and macros are meant to come from.
 *
 * Names exactly as stored. `answer()` in the server makes a non-breaking
 * space visible on the wire, which is what tells `Couplet 1` from
 * `Couplet\u00a01`.
 */
export async function readConfiguration(root: string): Promise<Configuration> {
  const [groups, macros] = await Promise.all([
    readConfigured(root, findGroups, "No `Configuration/Groups` beside `Libraries`, and no workspace `Groups` document.", (bytes) =>
      readGroups(decodeGroupsDocument(bytes))
    ),
    readConfigured(root, findMacros, "No `Configuration/Macros` beside `Libraries`, and no workspace `Macros` document.", (bytes) =>
      readMacros(decodeMacrosDocument(bytes))
    ),
  ]);
  if (!groups.path && !macros.path) {
    throw new LibraryError(
      "Found neither ProPresenter's configured groups nor its macros. Point the server at the ProPresenter " +
        "folder (the one holding `Libraries` and `Configuration`) or at a ProPresenter 22 workspace."
    );
  }
  const unreadable = groups.problem || macros.problem ? { groups: groups.problem, macros: macros.problem } : undefined;
  return {
    // What a writer copies from the lists, kept out of what the model is told.
    groups: groups.items.map(({ rgba: _rgba, ...group }) => group),
    groupsPath: groups.path,
    macros: macros.items.map(({ collectionRefs: _refs, ...macro }) => macro),
    macrosPath: macros.path,
    ...(unreadable ? { unreadable } : {}),
  };
}
