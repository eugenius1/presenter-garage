import path from "node:path";
import { type Fidelity } from "@presenter-garage/core/lib/decode";
import {
  checkPresentationFidelity,
  hasText,
  decodePresentation,
  readDetails,
  type PresentationDetails,
  type PresentationDoc,
  type SlideMacro,
} from "@presenter-garage/core/lib/presentation";
import { fold } from "@presenter-garage/core/lib/search";
import {
  findPresentations,
  LibraryError,
  readFoundFile,
  readLibraryFile,
  resolveFolder,
  statFoundFile,
} from "@presenter-garage/node/library";
import { open, presentationName } from "@presenter-garage/node/presentations";
import { isInWorkspace } from "@presenter-garage/node/workspace";
import { fidelityOf } from "./fidelity";

/**
 * Listing, reading and searching presentations: `list_presentations`,
 * `read_presentation` and `search_text`.
 */

/**
 * A listing entry. No creation date, on purpose: see `PresentationDetails`.
 *
 * `fileModified` is the file system's, and is free to read. `lastUsed` and
 * `lastModified` are ProPresenter's own and live inside the file, so they are
 * only present when the call asked for them by filtering or sorting on use.
 */
export interface ListedPresentation {
  path: string;
  name: string;
  library: string;
  sizeBytes: number;
  fileModified: string;
  lastUsed?: string | null;
  lastModified?: string;
}

export interface PresentationListing {
  total: number;
  truncated: boolean;
  /** Files that could not be decoded when dates were needed, so they are not silently dropped. */
  unreadable?: string[];
  presentations: ListedPresentation[];
}

export interface ListOptions {
  query?: string;
  limit?: number;
  /** ISO date: only presentations not shown since then, including never shown. */
  notUsedSince?: string;
  /** ISO date: only presentations shown on or after it. */
  usedSince?: string;
  sort?: "name" | "lastUsed";
}

function parseDate(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new LibraryError(`${name} is not a date: ${value}. Use ISO 8601, e.g. 2025-10-24.`);
  return ms;
}

/** How many files the date filters read at once: overlaps the wait on a slow folder. */
const READ_CONCURRENCY = 8;

/** `fn` over `items`, at most `limit` at a time, results in the order of `items`. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

type Dated = ListedPresentation & { lastUsed: string | null; usedAt: number };

/** A listing entry, from the bytes' own handle when they were read anyway. */
function listed(file: string, size: number, modified: Date): ListedPresentation {
  return {
    path: file,
    name: presentationName(file),
    // ProPresenter keeps one folder per library, so the parent is its name.
    library: path.basename(path.dirname(file)),
    sizeBytes: size,
    fileModified: modified.toISOString(),
  };
}

/** Read when each file was last shown and edited; a file that will not decode is named, not guessed at. */
async function readDates(files: readonly string[]): Promise<{ dated: Dated[]; unreadable: string[] }> {
  const read = await mapLimit(files, READ_CONCURRENCY, async (file): Promise<Dated | string> => {
    try {
      const { bytes, size, modified } = await readFoundFile(file);
      const { lastUsed, lastModified } = readDetails(decodePresentation(bytes));
      return {
        ...listed(file, size, modified),
        lastUsed: lastUsed ?? null,
        lastModified,
        // Parsed once here, for both the filter and the sort.
        usedAt: lastUsed ? Date.parse(lastUsed) : -Infinity,
      };
    } catch {
      return file;
    }
  });
  return {
    dated: read.filter((r): r is Dated => typeof r !== "string"),
    unreadable: read.filter((r): r is string => typeof r === "string"),
  };
}

/**
 * List presentations, by name alone or by when they were last shown.
 *
 * The two cost very differently. A name is the file's name, so a plain listing
 * never opens a file. When a song was last shown is recorded only inside it,
 * so filtering or sorting on use reads and decodes every file the name filter
 * left -- the whole library, unless `query` narrowed it first. The tool
 * description says so, so the calling model can choose.
 */
export async function listPresentations(
  root: string,
  { query, limit = 200, notUsedSince, usedSince, sort = "name" }: ListOptions = {}
): Promise<PresentationListing> {
  const before = parseDate(notUsedSince, "notUsedSince");
  const since = parseDate(usedSince, "usedSince");

  const { files, truncated } = await findPresentations([root]);
  const wanted = query ? fold(query) : undefined;
  const named = files.filter((file) => !wanted || fold(presentationName(file)).includes(wanted));

  if (before === undefined && since === undefined && sort !== "lastUsed") {
    const presentations = await Promise.all(
      named.slice(0, limit).map(async (file) => {
        const stat = await statFoundFile(file);
        return stat && listed(file, stat.size, stat.modified);
      })
    );
    return {
      total: named.length,
      truncated: truncated || named.length > limit,
      presentations: presentations.filter((entry) => entry !== undefined),
    };
  }

  // A v22 workspace does not keep these dates in the presentation, and
  // nowhere else they might be has been found. Answering from their absence
  // would report every song as never shown.
  for (const file of named) {
    if (await isInWorkspace(file)) {
      throw new LibraryError(
        "A ProPresenter 22 workspace does not record in a presentation when it was last shown, " +
          "so presentations cannot be filtered or sorted by use. List them without `notUsedSince`, `usedSince` or `sort`."
      );
    }
  }

  const { dated, unreadable } = await readDates(named);
  const matching = dated.filter(
    ({ usedAt }) => (before === undefined || usedAt < before) && (since === undefined || usedAt >= since)
  );
  // Most recent first; never shown last.
  if (sort === "lastUsed") matching.sort((a, b) => b.usedAt - a.usedAt);

  return {
    total: matching.length,
    truncated: truncated || matching.length > limit,
    unreadable,
    presentations: matching.slice(0, limit).map(({ usedAt: _sortKey, ...entry }) => entry),
  };
}

export interface PresentationContent extends PresentationDetails {
  path: string;
  name: string;
  /** The file system's modification time. `lastModified` is ProPresenter's own. */
  fileModified: string;
  slideCount: number;
  /** Whether writing this file back would keep everything in it. See CONTRIBUTING.md. */
  fidelity: Fidelity;
  /** Theme placeholders with no text in them, left out of their slides' `textBoxes`. */
  emptyTextBoxes: number;
  /** Every slide, in ProPresenter's order; one with no text has empty `textBoxes`. */
  slides: {
    slideIndex: number;
    label: string;
    group?: string;
    /** Every macro the slide triggers; empty for none. */
    macros: SlideMacroEntry[];
    textBoxes: { boxIndex: number; lines: string[] }[];
  }[];
}

/** A slide's macro, with `disabled` only for one switched off on the slide. */
export interface SlideMacroEntry {
  name: string;
  uuid?: string;
  disabled?: true;
}

const macroEntry = ({ name, uuid, enabled }: SlideMacro): SlideMacroEntry => ({
  name,
  uuid,
  ...(enabled ? {} : { disabled: true as const }),
});

export async function readPresentationFile(root: string, file: string): Promise<PresentationContent> {
  const { path: real, bytes, modified, converted } = await readLibraryFile([root], file);
  const { doc, raw } = open(file, bytes);

  // Every slide, not only those with words: a blank or image-only slide is
  // still one ProPresenter shows, and leaving it out read as a gap in the
  // numbering with nothing to say why.
  const slides: PresentationContent["slides"] = doc.slides.map(({ slideIndex, cueName, groupName, macros }) => ({
    slideIndex,
    label: cueName,
    group: groupName,
    macros: macros.map(macroEntry),
    textBoxes: [],
  }));
  let emptyTextBoxes = 0;
  for (const box of doc.textBoxes) {
    if (!hasText(box)) {
      emptyTextBoxes++;
      continue;
    }
    slides[box.slideIndex].textBoxes.push({ boxIndex: box.boxIndex, lines: box.lines.map((line) => line.text) });
  }

  return {
    path: real,
    name: doc.name || presentationName(real),
    fileModified: modified.toISOString(),
    ...readDetails(raw),
    slideCount: doc.slideCount,
    fidelity: fidelityOf(converted, checkPresentationFidelity(bytes).fidelity),
    emptyTextBoxes,
    slides,
  };
}

export interface TextMatch {
  path: string;
  name: string;
  slideIndex: number;
  group?: string;
  boxIndex: number;
  lineIndex: number;
  text: string;
}

export interface SearchResult {
  filesSearched: number;
  /** Files that could not be read as presentations, so a miss is not mistaken for absence. */
  unreadable: string[];
  truncated: boolean;
  matches: TextMatch[];
}

/**
 * Find a phrase in the text of every presentation.
 *
 * Accent- and case-insensitive through the same `fold` the app's search uses,
 * so "cene" finds "Cène" here exactly as it does in the browser.
 */
export async function searchText(
  root: string,
  { query, folder, limit = 50 }: { query: string; folder?: string; limit?: number }
): Promise<SearchResult> {
  const wanted = fold(query.trim());
  if (!wanted) throw new LibraryError("Search for at least one visible character.");

  const dirs = folder ? [await resolveFolder([root], folder)] : [root];
  const { files, truncated } = await findPresentations(dirs);
  const matches: TextMatch[] = [];
  const unreadable: string[] = [];

  let searched = 0;
  for (const file of files) {
    searched++;
    let doc: PresentationDoc;
    try {
      doc = open(file, (await readFoundFile(file)).bytes).doc;
    } catch {
      unreadable.push(file);
      continue;
    }
    for (const box of doc.textBoxes) {
      for (const line of box.lines) {
        if (!fold(line.text).includes(wanted)) continue;
        if (matches.length === limit) return { filesSearched: searched, unreadable, truncated: true, matches };
        matches.push({
          path: file,
          name: doc.name || presentationName(file),
          slideIndex: box.slideIndex,
          group: box.groupName,
          boxIndex: box.boxIndex,
          lineIndex: line.index,
          text: line.text,
        });
      }
    }
  }

  return { filesSearched: searched, unreadable, truncated, matches };
}
