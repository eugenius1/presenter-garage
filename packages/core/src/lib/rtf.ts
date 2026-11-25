/**
 * Just enough RTF to recover the text a slide actually shows -- and to put it
 * back.
 *
 * ProPresenter stores every text box as an RTF document, so answering "does
 * this line begin with a space?" means knowing which spaces are text and which
 * are syntax. In RTF a control word is terminated by a single space that is
 * *not* content: in `\cb2 Que ton nom`, the space after `\cb2` is a delimiter.
 * Matching spaces with a regular expression reports a leading space on
 * essentially every line in every file.
 *
 * Nothing here tries to be a general RTF reader. It recovers visible characters
 * and line breaks, and deliberately ignores everything about appearance.
 *
 * Because the text it returns is a *projection*, fixing a line cannot mean
 * rewriting that string: the formatting runs around it would be lost. So every
 * visible character also carries the range of source it came from, and a fix is
 * a splice of those ranges back into the original document. Everything outside
 * the spliced ranges is passed through untouched, which is what keeps a fix
 * from disturbing fonts, colours or anything else this reader ignores.
 */

/** Groups whose contents are never shown: font tables, colour tables and so on. */
const DESTINATIONS = new Set([
  "fonttbl",
  "colortbl",
  "expandedcolortbl",
  "stylesheet",
  "listtable",
  "listoverridetable",
  "info",
  "pict",
  "object",
  "themedata",
  "colorschememapping",
  "datastore",
  "generator",
  "xmlnstbl",
]);

/** Control words that produce a character rather than affecting appearance. */
const LITERAL: Record<string, string> = {
  tab: "\t",
  emdash: "—",
  endash: "–",
  emspace: " ",
  enspace: " ",
  qmspace: " ",
  bullet: "•",
  lquote: "‘",
  rquote: "’",
  ldblquote: "“",
  rdblquote: "”",
  nbsp: " ",
};

/**
 * Windows-1252 at 0x80-0x9F, where it parts company with Latin-1.
 *
 * `\ansicpg1252` is what ProPresenter declares, and the code page nearly
 * everything else writes. Holes in the table are bytes 1252 leaves undefined,
 * which fall through to their Latin-1 reading.
 */
const CP1252: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡",
  0x88: "ˆ", 0x89: "‰", 0x8a: "Š", 0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž",
  0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—",
  0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
};

function fromCodePage(byte: number): string {
  return CP1252[byte] ?? String.fromCharCode(byte);
}

/** Control words that end the current line. */
const BREAKS = new Set(["par", "line", "sect", "page", "column"]);

/**
 * A control word with an optional signed numeric parameter, matched in place.
 * Sticky rather than run on a slice, because the scan meets one per few
 * characters of every box in a library.
 */
export const CONTROL_WORD = /\\([a-zA-Z]+)(-?\d+)?[ ]?/y;

/**
 * Where one run of visible characters came from in the source.
 *
 * `plain` runs are the source characters themselves, so a cut anywhere inside
 * one maps straight onto a source range. Everything else -- a `\tab`, an
 * `\u233 ?` escape -- is an indivisible unit: one visible character standing
 * for several source characters, which can only be removed whole.
 */
export interface RtfSpan {
  /** Offset of the run's first character within the line's text. */
  textStart: number;
  /** One past its last character within the line's text. */
  textEnd: number;
  /** The source range that produced it. */
  sourceStart: number;
  sourceEnd: number;
  /** Whether the source characters are literally the text characters. */
  plain: boolean;
}

export interface RtfLine {
  /** Zero-based position within the text box. */
  index: number;
  /**
   * The visible characters, untrimmed.
   *
   * Untrimmed on purpose -- the leading and trailing whitespace is the whole
   * point of reading this.
   */
  text: string;
  /**
   * True when the line carried formatting but renders nothing.
   *
   * A line can be non-empty in the file and invisible on screen: a paragraph
   * holding only colour and font instructions. Those are what make a slide look
   * like it has a gap in it for no reason.
   */
  markupOnly: boolean;
  /** Where each run of `text` came from, in order. */
  spans: RtfSpan[];
  /**
   * The source this line occupies, formatting included, up to but excluding
   * the break that ends it.
   *
   * Starts where the previous line's break ended, so the range covers the
   * paragraph's own instructions as well as its text -- removing a line means
   * removing both.
   */
  sourceStart: number;
  sourceEnd: number;
  /**
   * The break that ended the line, when one did.
   *
   * Absent on the last line of a document, which simply runs out.
   */
  breakStart?: number;
  breakEnd?: number;
}

interface ParseState {
  text: string;
  /** Whether anything at all appeared between this break and the last. */
  sawMarkup: boolean;
  spans: RtfSpan[];
}

/**
 * Recover the lines of text an RTF document renders.
 *
 * Returns one entry per paragraph or explicit line break, including empty ones,
 * because their emptiness is often the finding.
 */
export function extractLines(rtf: string): RtfLine[] {
  const lines: RtfLine[] = [];
  let current: ParseState = { text: "", sawMarkup: false, spans: [] };
  /** Where the line being built begins, formatting included. */
  let lineStart = 0;

  // Depth of the group stack, and the depths at which we are inside something
  // that should not contribute visible text.
  let depth = 0;
  const skipFrom: number[] = [];
  const skipping = () => skipFrom.length > 0;

  /** Unicode replacement characters still to swallow, per \ucN. */
  let skipChars = 0;
  let unicodeSkip = 1;
  // \ucN is scoped to its group, so the stack restores it on exit.
  const ucStack: number[] = [];

  const push = (s: string, start: number, end: number, plain: boolean) => {
    const last = current.spans[current.spans.length - 1];
    // Merge consecutive literal characters: a line of prose is one run, not
    // one span per letter.
    if (last && plain && last.plain && last.sourceEnd === start && last.textEnd === current.text.length) {
      last.textEnd += s.length;
      last.sourceEnd = end;
    } else {
      current.spans.push({
        textStart: current.text.length,
        textEnd: current.text.length + s.length,
        sourceStart: start,
        sourceEnd: end,
        plain,
      });
    }
    current.text += s;
  };

  const endLine = (breakStart?: number, breakEnd?: number, at = breakStart) => {
    lines.push({
      index: lines.length,
      text: current.text,
      markupOnly: current.text.trim() === "" && current.sawMarkup,
      spans: current.spans,
      sourceStart: lineStart,
      sourceEnd: at ?? rtf.length,
      breakStart,
      breakEnd,
    });
    lineStart = breakEnd ?? at ?? rtf.length;
    current = { text: "", sawMarkup: false, spans: [] };
  };

  const emit = (s: string, start: number, end: number, plain: boolean) => {
    if (skipping()) return;
    if (skipChars > 0) {
      // Characters standing in for a \u escape on readers without Unicode.
      const take = Math.min(skipChars, s.length);
      skipChars -= take;
      // They belong to that escape's source range: removing the escape without
      // them would leave its "?" fallback behind as visible text.
      const last = current.spans[current.spans.length - 1];
      if (last) last.sourceEnd = Math.max(last.sourceEnd, end);
      s = s.slice(take);
      if (!s) return;
    }
    push(s, start, end, plain);
  };

  let i = 0;
  while (i < rtf.length) {
    const ch = rtf[i];

    if (ch === "{") {
      depth++;
      ucStack.push(unicodeSkip);
      i++;
      continue;
    }

    if (ch === "}") {
      if (skipFrom.length && skipFrom[skipFrom.length - 1] === depth) skipFrom.pop();
      unicodeSkip = ucStack.pop() ?? 1;
      depth--;
      i++;
      continue;
    }

    if (ch === "\\") {
      const next = rtf[i + 1];

      // Control symbol: a single non-alphabetic character.
      if (next !== undefined && !/[a-zA-Z]/.test(next)) {
        const start = i;
        i += 2;
        if (next === "'") {
          // `\'hh` is a byte in the document's code page. ProPresenter's own
          // writer uses `\u` instead, but this is how other RTF writers spell
          // an "é" -- and how a `\u` escape's fallback is often written, which
          // is the case it matters most in: read as a bare control symbol, its
          // two hex digits would land on the slide as text.
          const hex = rtf.slice(i, i + 2);
          if (/^[0-9a-fA-F]{2}$/.test(hex)) {
            i += 2;
            emit(fromCodePage(parseInt(hex, 16)), start, i, false);
          }
        } else if (next === "\\" || next === "{" || next === "}") emit(next, start, i, false);
        else if (next === "~") emit(" ", start, i, false);
        else if (next === "_") emit("‑", start, i, false);
        else if (next === "-") {
          // Optional hyphen: invisible unless the line wraps there.
        } else if (next === "*") {
          // `{\*\foo ...}` marks a group a reader may ignore wholesale.
          if (!skipping()) skipFrom.push(depth);
        } else if (next === "\n" || next === "\r") {
          endLine(start, i);
        }
        continue;
      }

      CONTROL_WORD.lastIndex = i;
      const match = CONTROL_WORD.exec(rtf);
      if (!match) {
        i++;
        continue;
      }
      const [whole, word, rawParam] = match;
      const param = rawParam === undefined ? undefined : Number(rawParam);
      const start = i;
      i += whole.length;

      if (DESTINATIONS.has(word)) {
        if (!skipping()) skipFrom.push(depth);
        continue;
      }

      if (word === "uc") {
        unicodeSkip = param ?? 1;
        continue;
      }

      if (word === "u" && param !== undefined) {
        // Negative values are the signed-16-bit form of code points above
        // 0x7FFF, which is how RTF writes anything past the BMP midpoint.
        const code = param < 0 ? param + 65536 : param;
        if (!skipping()) {
          current.sawMarkup = true;
          push(String.fromCodePoint(code), start, i, false);
        }
        skipChars = unicodeSkip;
        continue;
      }

      if (BREAKS.has(word)) {
        if (!skipping()) endLine(start, i);
        continue;
      }

      if (word in LITERAL) {
        emit(LITERAL[word], start, i, false);
        continue;
      }

      // Any other control word is formatting. Note that the line carries
      // *something*, which is what separates a blank line from a blank line
      // full of instructions.
      if (!skipping()) current.sawMarkup = true;
      continue;
    }

    if (ch === "\n" || ch === "\r") {
      // Raw newlines are insignificant in RTF; real breaks are \par and \line.
      i++;
      continue;
    }

    emit(ch, i, i + 1, true);
    i++;
  }

  // Whatever is left is the final line, even when nothing terminated it.
  if (current.text !== "" || current.sawMarkup || lines.length === 0) {
    endLine(undefined, undefined, rtf.length);
  }

  return lines;
}

/** The visible text of an RTF document, lines joined by newlines. */
export function extractText(rtf: string): string {
  return extractLines(rtf)
    .map((line) => line.text)
    .join("\n");
}

/**
 * The RTF payload of a text box, as characters.
 *
 * Latin-1 rather than UTF-8, so that every byte maps to exactly one character
 * and back: an RTF document spliced and re-encoded is identical to the original
 * wherever it was not edited, whatever the bytes happened to be. ProPresenter
 * escapes everything above ASCII as `\uNNN` anyway -- 15,930 text boxes across
 * 880 real files carry no byte above 0x7F -- so nothing is misread by it, and
 * the guarantee holds even for a file that does.
 */
export function decodeRtf(source: ArrayBufferView): string {
  // Normalised rather than assumed: the payload can arrive as any view of the
  // buffer, including one from another realm.
  const bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  let out = "";
  // Chunked: spreading a large array into String.fromCharCode overflows the
  // argument limit on payloads a few hundred kilobytes long.
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return out;
}

/** The inverse of {@link decodeRtf}. */
export function encodeRtf(rtf: string): Uint8Array {
  const out = new Uint8Array(rtf.length);
  for (let i = 0; i < rtf.length; i++) out[i] = rtf.charCodeAt(i) & 0xff;
  return out;
}
