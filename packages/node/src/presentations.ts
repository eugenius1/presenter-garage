import path from "node:path";
import { createI18n } from "@presenter-garage/core/i18n/core";
import { openPresentation, type ReadProblem } from "@presenter-garage/core/lib/presentation";
import { LibraryError } from "./paths";

/**
 * Opening a presentation read from disk, for every surface that reads one:
 * the MCP server's tools and the write path in `edits.ts`.
 */

export function presentationName(file: string): string {
  return path.basename(file).replace(/\.pro$/i, "");
}

const { t, f } = createI18n("en");

/**
 * Why a file would not open, in the words the app uses.
 *
 * English, because the reader is a model rather than a person with a language
 * setting; the app's own sentence, so the two never describe one file
 * differently.
 */
export function explain(problem: ReadProblem, detail = ""): string {
  const problems = t.tools.presentations.problems;
  return problem === "unreadable" ? f(problems.unreadable, { reason: detail }) : problems[problem];
}

export function open(file: string, bytes: Uint8Array) {
  const opened = openPresentation(bytes);
  if (opened.problem) throw new LibraryError(`${file}: ${explain(opened.problem, opened.detail)}`);
  return opened;
}
