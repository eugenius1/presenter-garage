import { CONTROL_WORD, type RtfLine } from "./rtf";

/**
 * Putting a line back: every change to a text box's RTF, as a splice of the
 * source ranges `rtf.ts` recorded for its visible characters.
 *
 * The reader says where each character came from; this turns a change to a
 * line -- characters cut, the line rewritten, a line added beside it -- into
 * edits of exactly those ranges, and applies them, so everything outside them
 * reaches the file byte for byte. Kept apart from the reader because only the
 * writers call it: `fixes.ts` and `style.ts`, and through `lineSplice` the
 * attribute ranges in `ranges.ts`. The reader never imports it.
 */

/** A stretch of a line's visible text to remove, in the line's own coordinates. */
export interface TextCut {
  start: number;
  /** Exclusive. */
  end: number;
}

/** A stretch of the source document to remove. */
export interface SourceEdit {
  start: number;
  /** Exclusive. */
  end: number;
  /**
   * Text to leave in its place: a delimiter space after a removal, or the new
   * text of an insertion, which is a zero-width edit.
   *
   * See {@link endsWithControlWord}: removing a run can leave a control word
   * touching what follows it, and a control word with nothing between it and
   * the next character redefines what that character means.
   */
  insert?: string;
}

/**
 * Whether the source immediately before `index` ends a control word that has
 * not been given its delimiter.
 *
 * The reason this matters is the module's own opening paragraph, in reverse.
 * A control word is terminated by one space that is syntax, so a document
 * reading `\cb2\u212 ? ce nom` shows " ce nom" with a leading space -- the
 * escape separates `\cb2` from the text. Delete the escape and the result is
 * `\cb2 ce nom`, where that same space is now the delimiter and the leading
 * space is gone. Worse, `\qc\u212 ?abc` would become `\qcabc`, an entirely
 * different control word.
 *
 * So a cut that leaves a control word exposed puts a space back to delimit it.
 * That space is syntax, never content, and only where the word does not
 * already have one -- adding a second would be a leading space of its own.
 */
export function endsWithControlWord(rtf: string, index: number): boolean {
  let i = index - 1;

  let digits = 0;
  while (i >= 0 && rtf[i] >= "0" && rtf[i] <= "9") {
    digits++;
    i--;
  }
  if (digits > 0 && i >= 0 && rtf[i] === "-") i--;

  let letters = 0;
  while (i >= 0 && /[a-zA-Z]/.test(rtf[i])) {
    letters++;
    i--;
  }
  if (letters === 0 || i < 0 || rtf[i] !== "\\") return false;

  // An even run of backslashes means the last is an escaped one -- literal
  // content, not the start of a control word.
  let run = 0;
  while (i - run >= 0 && rtf[i - run] === "\\") run++;
  return run % 2 === 1;
}

/**
 * Map cuts on a line's visible text onto ranges of the source document.
 *
 * Returns null when a cut cannot be expressed -- it would take part of an
 * indivisible unit, such as half of the `\u233 ?` that stands for one "é".
 * The caller's answer to that is to offer no fix rather than a doubtful one:
 * no offsets, no fix.
 */
export function cutsToEdits(
  rtf: string,
  line: RtfLine,
  cuts: readonly TextCut[]
): SourceEdit[] | null {
  const edits: SourceEdit[] = [];
  // Named for what it does rather than what it is, since `cut` is taken by
  // the loop below.
  const take = (start: number, end: number) =>
    edits.push(endsWithControlWord(rtf, start) ? { start, end, insert: " " } : { start, end });

  for (const cut of cuts) {
    if (cut.end <= cut.start) continue;
    if (cut.start < 0 || cut.end > line.text.length) return null;

    for (const span of line.spans) {
      const from = Math.max(cut.start, span.textStart);
      const to = Math.min(cut.end, span.textEnd);
      if (to <= from) continue;

      if (span.plain) {
        take(
          span.sourceStart + (from - span.textStart),
          span.sourceStart + (to - span.textStart)
        );
        continue;
      }

      // Indivisible: take all of it, or none of it and give up.
      if (from !== span.textStart || to !== span.textEnd) return null;
      take(span.sourceStart, span.sourceEnd);
    }
  }

  return edits;
}

/**
 * Apply edits to a document, leaving everything else byte for byte.
 *
 * Overlapping and touching ranges are merged rather than rejected: two checks
 * can legitimately want the same characters gone -- a trailing comma and the
 * trailing space behind it -- and that is agreement, not conflict. A merged
 * range keeps the replacement of the edit that starts it, since that is the
 * one whose left-hand join it inherits.
 *
 * A zero-width edit is an insertion, and is never merged: its text is new
 * content, which no other edit can stand in for. It lands at its own offset,
 * before any removal starting there, or just after a removal it falls inside.
 */
export function applyEdits(rtf: string, edits: readonly SourceEdit[]): string {
  const ordered = edits
    .filter((e) => e.end > e.start || (e.end === e.start && e.insert))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (ordered.length === 0) return rtf;

  let out = "";
  let cursor = 0;
  /** The removal being widened, not yet written out. */
  let open: SourceEdit | undefined;
  const flush = () => {
    if (!open) return;
    out += rtf.slice(cursor, open.start) + (open.insert ?? "");
    cursor = open.end;
    open = undefined;
  };

  for (const edit of ordered) {
    if (edit.end === edit.start) {
      flush();
      const at = Math.max(cursor, edit.start);
      out += rtf.slice(cursor, at) + edit.insert;
      cursor = at;
    } else if (open && edit.start <= open.end) {
      open.end = Math.max(open.end, edit.end);
    } else if (edit.end > cursor) {
      // A removal partly behind the cursor -- inside one already written out,
      // with an insertion between -- takes only what is still ahead of it.
      flush();
      open = { ...edit, start: Math.max(edit.start, cursor) };
    }
  }

  flush();
  return out + rtf.slice(cursor);
}

/**
 * Remove a whole line: its visible characters and the break that ends it.
 *
 * The line's formatting stays. RTF character and paragraph state carries
 * forward across a break, so a `\cf2\fs60` sitting on a blank line is what
 * colours and sizes every line after it; cutting it along with the line would
 * restyle the rest of the box while the text -- the only thing verification
 * compares -- read exactly as promised. Leaving the instructions also keeps any
 * group the line opens or closes balanced. With the break gone they simply
 * join the start of the next paragraph, which they were going to govern anyway.
 *
 * Returns null for a line nothing terminated -- the last of a document, which
 * has no break to take with it, and which is never a gap between two others
 * anyway -- and for one whose characters cannot be cut whole.
 */
export function lineEdit(rtf: string, line: RtfLine): SourceEdit[] | null {
  if (line.breakStart === undefined || line.breakEnd === undefined) return null;
  const text = cutsToEdits(rtf, line, [{ start: 0, end: line.text.length }]);
  if (text === null) return null;
  const start = line.breakStart;
  const brk = endsWithControlWord(rtf, start)
    ? { start, end: line.breakEnd, insert: " " }
    : { start, end: line.breakEnd };
  return [...text, brk];
}

/**
 * The `\ucN` in force at a point in the source: how many fallback characters
 * a `\u` escape written there must carry.
 *
 * Inserted text has to match it exactly. Too few, and the reader swallows the
 * first characters of whatever follows as the escape's fallback; too many, and
 * a stray "?" shows on the slide. `\ucN` is scoped to its group, so this
 * tracks the group stack the way `extractLines` in `rtf.ts` does.
 */
export function unicodeSkipAt(rtf: string, index: number): number {
  let skip = 1;
  const stack: number[] = [];
  let i = 0;
  while (i < index) {
    const ch = rtf[i];
    if (ch === "{") {
      stack.push(skip);
      i++;
    } else if (ch === "}") {
      skip = stack.pop() ?? 1;
      i++;
    } else if (ch === "\\") {
      CONTROL_WORD.lastIndex = i;
      const match = CONTROL_WORD.exec(rtf);
      if (!match) {
        // A control symbol: two characters, never a group or a \uc.
        i += 2;
        continue;
      }
      if (match[1] === "uc") skip = match[2] === undefined ? 1 : Number(match[2]);
      i += match[0].length;
    } else {
      i++;
    }
  }
  return skip;
}

/**
 * Whether a UTF-16 code unit is a control character other than a tab, or a
 * line break by Unicode's own count -- next line, line and paragraph
 * separator -- which cannot sit on one line of a slide.
 */
function isLineControl(code: number): boolean {
  return (code < 0x20 && code !== 0x09) || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029;
}

/** Whether text holds a line break or another control character, so it cannot sit on one line. */
export function hasLineControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (isLineControl(text.charCodeAt(i))) return true;
  return false;
}

/**
 * Plain text as RTF a slide will read back exactly, or null for text that
 * cannot sit on one line: a line break, or any other control character.
 *
 * Written the way ProPresenter writes: ASCII as itself, everything above it as
 * a `\uN` escape, never a raw byte, since the payload is read as latin-1 and a
 * raw "é" would be a different character to another reader. The three
 * characters RTF reserves are escaped, and a tab is `\tab`.
 *
 * Every control word ends with its delimiter space, whatever follows it --
 * the text after an insertion is the document's, not this function's, and a
 * `\tab` meeting a letter would be a different control word.
 *
 * @param skip The `\ucN` in force where this goes; see {@link unicodeSkipAt}.
 */
export function encodeRtfText(text: string, skip: number): string | null {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (ch === "\\" || ch === "{" || ch === "}") out += "\\" + ch;
    else if (ch === "\t") out += "\\tab ";
    else if (isLineControl(code)) return null;
    else if (code < 0x7f) out += ch;
    // UTF-16 code units, so a character past the BMP is a surrogate pair of
    // escapes, which is how RTF spells one; signed, since \u takes a 16-bit
    // signed number.
    else out += `\\u${code > 0x7fff ? code - 0x10000 : code} ` + "?".repeat(skip);
  }
  return out;
}

/** Where text typed at `at` on a line goes in the source, keeping the formatting of the character before it. */
function insertionPoint(rtf: string, line: RtfLine, at: number): number {
  if (at > 0) {
    const span = line.spans.find((s) => s.textStart < at && at <= s.textEnd)!;
    return span.plain ? span.sourceStart + (at - span.textStart) : span.sourceEnd;
  }
  if (line.spans.length > 0) return line.spans[0].sourceStart;
  if (line.breakStart !== undefined) return line.breakStart;
  // The empty last line of a document, typically a theme's placeholder box:
  // before the brace that closes the document, not after it.
  const close = rtf.lastIndexOf("}", line.sourceEnd - 1);
  return Math.max(close, line.sourceStart);
}

/**
 * The one splice that turns `before` into `after`, in the line's characters:
 * `before.slice(start, end)` is replaced by `inserted`. Only what differs is
 * in it -- the characters the two share at either end are not -- and it
 * never stops between the halves of a surrogate pair. `replaceLineText`
 * makes its RTF edit from exactly this, so the attribute ranges of a
 * ProPresenter 22 box are moved through the same splice the text is.
 */
export function lineSplice(before: string, after: string): { start: number; end: number; inserted: string } {
  // Never stop between the halves of a surrogate pair. Each half is its own
  // escape, so the RTF would still read back, but the attribute ranges are
  // moved through this same splice, and a range ending at such a boundary
  // would cover half a character. Each boundary sits in both strings, so it
  // moves when it falls inside a pair in either -- and only then: a lone half
  // next to it is a character of its own, and stepping over one can carry the
  // boundary into the pair beside it. Neither step can land inside another
  // pair, since the unit it steps over is in both strings, a high half at the
  // start and a low half at the end.
  const pairAt = (s: string, i: number) =>
    i > 0 && (s.charCodeAt(i - 1) & 0xfc00) === 0xd800 && (s.charCodeAt(i) & 0xfc00) === 0xdc00;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  // Before the tail is trimmed, so that the tail can take the whole of what
  // the two share at the end: "a😀b" to "a😁😀b" adds just the "😁".
  if (pairAt(before, start) || pairAt(after, start)) start--;
  let tail = 0;
  while (
    tail < before.length - start &&
    tail < after.length - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  if (tail > 0 && (pairAt(before, before.length - tail) || pairAt(after, after.length - tail))) tail--;
  return { start, end: before.length - tail, inserted: after.slice(start, after.length - tail) };
}

/**
 * Splice that makes a line read `after`, or null when that cannot be done.
 *
 * Only what differs is touched: the characters the two share at either end
 * are left where they are, so "Amazing grace" to "Amazing Grace" replaces one
 * letter, and a bold word elsewhere on the line stays bold because its
 * formatting is never in the splice. New text takes the formatting in force
 * where it goes -- the character it replaces, or the one before it -- which
 * is what typing at that point in ProPresenter would do.
 *
 * Null for text with a line break or a control character in it, and for a
 * payload that is not an RTF document, which has nowhere to put new text. The
 * common-ends trim never stops inside a surrogate pair; see {@link lineSplice}.
 *
 * Each edit is right on its own; whether a set of them reads back as asked
 * once composed -- a removed line's break meeting new text on the next, say --
 * is for the caller to check by reading the result, as `planLineEdits` does.
 */
export function replaceLineText(rtf: string, line: RtfLine, after: string): SourceEdit[] | null {
  if (!rtf.startsWith("{\\rtf")) return null;
  const { start, end: cutEnd, inserted } = lineSplice(line.text, after);
  if (start === cutEnd && inserted === "") return [];

  const edits = start < cutEnd ? cutsToEdits(rtf, line, [{ start, end: cutEnd }]) : [];
  if (edits === null) return null;
  if (inserted === "") return edits;

  // The new text goes where the removal begins, or where it would be typed.
  const at = edits.length > 0 ? Math.min(...edits.map((e) => e.start)) : insertionPoint(rtf, line, start);
  // A \ucN no real writer uses -- negative, or large enough to make the
  // fallback run a denial of service -- is a document this does not write into.
  const skip = unicodeSkipAt(rtf, at);
  if (skip < 0 || skip > 8) return null;
  const encoded = encodeRtfText(inserted, skip);
  if (encoded === null) return null;

  // A delimiter the removal would have put back belongs before the new text,
  // not after it; and one is needed anyway where a control word ends at `at`.
  const removals = edits.map((e) => (e.start === at ? { start: e.start, end: e.end } : e));
  const delimiter = endsWithControlWord(rtf, at) ? " " : "";
  return [{ start: at, end: at, insert: delimiter + encoded }, ...removals];
}

/** Which side of an existing line a new line goes. */
export type InsertSide = "before" | "after";

/**
 * A break spelled to stand anywhere: a control word with its delimiter
 * space, a control symbol as it is, since a space after a control symbol
 * is text.
 */
function breakSource(rtf: string, line: RtfLine | undefined): string | undefined {
  if (line?.breakStart === undefined) return undefined;
  const source = rtf.slice(line.breakStart, line.breakEnd);
  const word = /^\\[a-zA-Z]+(-?\d+)?/.exec(source);
  return word ? `${word[0]} ` : source;
}

/** Whether text written straight after a control word would run into it: a letter, a digit, a hyphen, or a space it would take as its delimiter. */
function extendsControlWord(text: string): boolean {
  return /^[a-zA-Z0-9 -]/.test(text);
}

/**
 * Splice that adds a new line beside `lines[index]`, reading `text`, or null
 * when that cannot be done.
 *
 * The new line is the old one's formatting with new text, and is made
 * without touching a character of any line already there:
 *
 * - **After** a line, it goes at that line's break, as a break of the same
 *   kind followed by the text: `one\par two` becomes `one\par new\par two`.
 *   Nothing is written between the two, so the new line reads in exactly
 *   the state the old one ended in -- paragraph and character formatting
 *   alike -- and the line after it starts in exactly the state it did,
 *   which copying the old line's own instructions would not promise. After
 *   the last line, which has no break, it goes before the brace that closes
 *   the document.
 * - **Before** a line, it goes where text typed at that line's start would,
 *   after its formatting, as the text followed by a break: the state the old
 *   line starts in. Before an empty last line it goes before that line's
 *   formatting instead, which is all that keeps it a line.
 *
 * The break is the one already between the two lines the new one goes
 * between, or failing that any break in the box, or `\par` in a box that
 * has none, which is what ProPresenter writes. Every break in a real
 * library of 8,079 boxes is `\par` or a backslash and a newline, and no
 * box mixes the two.
 *
 * Several lines at one place are several of these at one offset, which
 * `applyEdits` writes in the order given, so any of them can be left out
 * and the rest still read in order. Null for text that is empty or will not
 * sit on one line, a payload that is not an RTF document, a `\ucN` no writer
 * uses, and the two cases below where a line before another cannot be
 * written so that every subset of them reads back.
 *
 * As with {@link replaceLineText}, whether a set of edits reads back once
 * composed is for the caller to check by reading the result.
 */
export function insertLineEdit(
  rtf: string,
  lines: readonly RtfLine[],
  index: number,
  side: InsertSide,
  text: string
): SourceEdit | null {
  const line = lines[index];
  if (!rtf.startsWith("{\\rtf") || !line || text === "") return null;
  const brk =
    breakSource(rtf, side === "after" ? line : lines[index - 1]) ??
    breakSource(rtf, lines.find((l) => l.breakStart !== undefined)) ??
    "\\par ";

  let at: number;
  if (side === "before") {
    // An empty last line is a line only because something follows the break
    // before it; text added after its formatting would take that away, and
    // it would read as no line at all. So before its formatting, where the
    // line before it ended. An empty box has no line before to go after.
    const trailing = index > 0 && line.spans.length === 0 && line.breakStart === undefined;
    at = trailing ? line.sourceStart : insertionPoint(rtf, line, 0);
  } else if (line.breakStart !== undefined) at = line.breakStart;
  else {
    at = rtf.lastIndexOf("}");
    if (at < (line.spans.at(-1)?.sourceEnd ?? line.sourceStart)) return null;
  }

  const skip = unicodeSkipAt(rtf, at);
  if (skip < 0 || skip > 8) return null;
  const encoded = encodeRtfText(text, skip);
  if (encoded === null) return null;

  // Starting with a backslash, the break needs nothing before it, and the
  // text after it is delimited by it.
  if (side === "after") return { start: at, end: at, insert: brk + encoded };

  // Before a line, a control word may end right where the new text goes:
  // `\cb2\u201 ?ternel`, a line opening on an escape. The new text then
  // needs a delimiter of its own exactly as the line's text did not, and
  // the break after it must end bare, as that word did, so that the next
  // new line or the old text follows it as it followed the word. A control
  // symbol cannot end bare -- a space after it is text -- and a hyphen
  // after a bare `\par` could be read as its parameter: both refused.
  if (!endsWithControlWord(rtf, at)) return { start: at, end: at, insert: encoded + brk };
  if (!brk.endsWith(" ") || rtf[at] === "-") return null;
  return { start: at, end: at, insert: (extendsControlWord(encoded) ? " " : "") + encoded + brk.trimEnd() };
}
