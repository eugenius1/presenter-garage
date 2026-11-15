import path from "node:path";

/**
 * What both halves of reading a library need: the folder of files in
 * `library.ts`, and the ProPresenter 22 workspace in `workspace.ts`, which
 * `library.ts` asks before it asks the disk. Kept apart from both so neither
 * has to import the other to get at it.
 */

/** Something a caller can act on: a wrong path, a file that will not read. Never a crash. */
export class LibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryError";
  }
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export interface FoundFile {
  bytes: Uint8Array;
  /** From the handle the bytes were read through, so they describe the same file. */
  size: number;
  modified: Date;
  /**
   * Set when the bytes are not a file's but a workspace document converted
   * into what its file would have held. They read like any other; they must
   * never be written back, and say nothing of whether the document could be.
   */
  converted?: true;
}

export interface FoundTheme {
  /** The theme's folder name, which is the name ProPresenter shows. */
  name: string;
  file: string;
}
