import type { RawDoc } from "@presenter-garage/core/lib/decode";
import { presentationName } from "../presentations";
import { hasText, readDetails, shownBounds, type PresentationDoc } from "@presenter-garage/core/lib/presentation";
import { checkRules, countByTier, DEFAULT_RULES, type Finding, type RuleConfiguration, type RuleSet } from "@presenter-garage/core/lib/rules";

/**
 * A song as the comparison sees it: its groups in ProPresenter's order, each
 * slide's lines and macros, and what is known of when it was last edited.
 * Everything a person would notice on screen, and nothing about how the file
 * stores it, so two libraries that store one song differently compare equal.
 */

export interface Slide {
  /** Every line of every text box that shows something, padding above and below each box left out. */
  lines: string[];
  /** The macros the slide triggers, by name; one switched off on the slide is marked `(off)`. */
  macros: string[];
}

export interface Group {
  /** Exactly as the file names it, a non-breaking space included; empty for slides no group holds. */
  name: string;
  slides: Slide[];
}

/**
 * When a song was last edited, and how that is known.
 *
 * - `file`: the date a `.pro` file records inside itself, which survives
 *   copying where the file system's does not.
 * - `modified`: the file system's date, for a file that records none.
 * - `history`: the last change a person made to a ProPresenter 22 document,
 *   with the computer (`peer`) that made it.
 * - `beforeUpgrade`: a ProPresenter 22 document nobody has edited since the
 *   upgrade, dated by the `.pro` file it was made from.
 * - `none`: nothing to go by. `notAfter` is then set for a ProPresenter 22
 *   document, which cannot have been edited after the upgrade.
 */
export interface Edited {
  at?: string;
  source: "file" | "modified" | "history" | "beforeUpgrade" | "none";
  peer?: string;
  notAfter?: string;
}

export interface Song {
  /** The file's name without `.pro`, which is what ProPresenter lists. */
  name: string;
  /** Inside the source, `Libraries/` left out: `Chants/Amazing Grace.pro`. */
  file: string;
  /** The presentation's uuid, lower-case: ProPresenter writes it upper-case in a workspace. */
  id?: string;
  groups: Group[];
  edited: Edited;
  /** What the rules found, each with the group it is in. */
  findings: SongFinding[];
  /** Rule breaks by tier, 1 to 3, leaving out what a person excepted. */
  breaks: [number, number, number];
}

export interface SongFinding extends Finding {
  /** Which of the song's `groups` it is in. */
  group: number;
}

/** The rules a song is checked against, and what they need to know. */
export interface SongRules {
  set: RuleSet;
  config?: RuleConfiguration;
  /** The library the song is in, for rules kept to some libraries. */
  library?: string;
}

/** Turn a decoded presentation into a song. `edited` is the caller's: only it knows where the bytes came from. */
export function songOf(file: string, raw: RawDoc, doc: PresentationDoc, edited: Edited, rules: SongRules = { set: DEFAULT_RULES }): Song {
  const name = presentationName(file);
  const linesBySlide = new Map<number, string[]>();
  for (const box of doc.textBoxes) {
    if (!hasText(box)) continue;
    const texts = box.lines.map((line) => line.text);
    const [first, last] = shownBounds(texts);
    linesBySlide.set(box.slideIndex, [...(linesBySlide.get(box.slideIndex) ?? []), ...texts.slice(first, last + 1)]);
  }

  const groups: Group[] = [];
  const groupOfSlide: number[] = [];
  for (const slide of doc.slides) {
    const groupName = slide.groupName ?? "";
    let group = groups.at(-1);
    if (!group || group.name !== groupName) groups.push((group = { name: groupName, slides: [] }));
    groupOfSlide.push(groups.length - 1);
    group.slides.push({
      lines: linesBySlide.get(slide.slideIndex) ?? [],
      macros: slide.macros.map((m) => (m.enabled ? m.name : `${m.name} (off)`)),
    });
  }

  const findings = checkRules(doc, rules.set, { song: name, library: rules.library }, rules.config).map((f) => ({
    ...f,
    group: groupOfSlide[f.slideIndex] ?? 0,
  }));
  const id = (raw as { uuid?: { string?: string } }).uuid?.string?.toLowerCase() || undefined;
  return {
    name,
    file,
    id,
    groups,
    edited,
    findings,
    breaks: countByTier(findings),
  };
}

/** The date a `.pro` file records for its last edit, or its file system date when it records none. */
export function fileEdited(raw: RawDoc, modified: Date): Edited {
  const at = readDetails(raw).lastModified;
  return at ? { at, source: "file" } : { at: modified.toISOString(), source: "modified" };
}

/**
 * A song as plain text: `[Group]`, then each slide's lines, slides apart by
 * a blank line and macros above the slide they are on. Made for
 * `git diff --no-index --word-diff`, so it carries nothing that is not on
 * screen.
 */
export function songText(song: Song): string {
  const out: string[] = [];
  for (const group of song.groups) {
    if (out.length) out.push("");
    out.push(`[${group.name}]`);
    group.slides.forEach((slide, i) => {
      if (i > 0) out.push("");
      for (const macro of slide.macros) out.push(`(macro: ${macro})`);
      out.push(...slide.lines);
    });
  }
  return `${out.join("\n")}\n`;
}

/**
 * A name as both machines would agree on it.
 *
 * One of them wrote `'` as `_` in file names, an apostrophe can be typed
 * curly or straight, and the same accented name arrives composed from one
 * computer and decomposed from another. Case and runs of spaces are folded
 * too: neither is a different song.
 */
export function nameKey(name: string): string {
  return name
    .normalize("NFC")
    .replace(/[_’‘ʼ`´]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("fr");
}

/** What is said about a song without its words: for JSON an agent reads, and for the summary. */
export function songMeta(song: Song) {
  const { groups: _groups, findings, ...meta } = song;
  // A finding on a line carries the line; the summary carries where it is and what it says, not the words.
  return { ...meta, findings: findings.map(({ text: _text, ...finding }) => finding) };
}
