import path from "node:path";
import type { WorkspaceRefusalCode } from "@presenter-garage/core/lib/desktop";

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

/**
 * A workspace that cannot be written at all, which refuses a whole run. The
 * message is English for a model; `code` is what an app words for itself.
 */
export class WorkspaceRefused extends LibraryError {
  readonly code: WorkspaceRefusalCode;

  constructor(message: string, code: WorkspaceRefusalCode) {
    super(message);
    this.name = "WorkspaceRefused";
    this.code = code;
  }
}

/** A file the fidelity gate will not let be written (guard 1): one file's refusal, not the run's. */
export class LossyFile extends LibraryError {
  constructor(message: string) {
    super(message);
    this.name = "LossyFile";
  }
}

/** A Cloud document with changes ProPresenter has not sent to Cloud yet (guard 1): one file's refusal, not the run's. */
export class UnsyncedDocument extends LibraryError {
  constructor(message: string) {
    super(message);
    this.name = "UnsyncedDocument";
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
  /**
   * For converted bytes, the hash of the stored snapshot they were made
   * from: looked up with the bytes, so the two describe the same snapshot.
   */
  sha256?: string;
}

export interface FoundTheme {
  /** The theme's folder name, which is the name ProPresenter shows. */
  name: string;
  file: string;
}
