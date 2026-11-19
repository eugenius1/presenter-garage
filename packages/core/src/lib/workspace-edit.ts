import { FixError, spliceBoxes, verifyLines, type LineFix } from "./fixes";
import { readPresentation, textBoxAddresses, type PresentationDoc, type TextBoxAddress } from "./presentation";
import { decodeRtf, encodeRtf, lineSplice } from "./rtf";
import { isObject, presentationFromWorkspace } from "./workspace";

/**
 * Writing slide text into a ProPresenter 22 workspace document: the parts
 * that need neither SQLite nor Loro, so they can be held to account here
 * with nothing but JSON.
 *
 * A workspace document is edited in its own form, never by converting back
 * from the message `workspace.ts` makes of it, which is a projection with
 * fields dropped. So the plan is made here as for a `.pro` file -- the same
 * `LineFix`es, the same `spliceBoxes` -- and then said again in the Loro
 * document's terms: which map holds each edited box, the bytes its
 * `rtf_data` becomes, and where each of its attribute ranges moves to.
 * `packages/node/src/workspace-write.ts` carries that out on the document
 * and hands the result back to `checkWorkspaceEdit` here.
 *
 * docs/propresenter-22-writing.md has why each step is there.
 */

/** A value as `LoroDoc.toJSON()` gives it. */
type Json = any;

/** A key into a Loro map, or a position in a Loro list. */
export type LoroKey = string | number;

/** One attribute range as it should be once the text moves. */
interface RangeMove {
  /** Position in the box's `attributes.custom_attributes`. */
  index: number;
  start: number;
  end: number;
}

/** What one text box becomes, in the Loro document's own terms. */
export interface BoxEdit {
  boxIndex: number;
  /** From the document's `root` map down to the text element's map, the one holding `rtf_data`. */
  path: LoroKey[];
  rtf: Uint8Array;
  /** Only the ranges that move. */
  ranges: RangeMove[];
  /** Attributes whose range ran past the end of the text and is cut back to it, by position in `custom_attributes`. */
  cutBack: number[];
}

/**
 * What one changed line does to the styling on it, for the person to see
 * before choosing it: each attribute range on the line, as the text it
 * covers there now and once the line changes. Only ranges whose text on the
 * line changes are listed. A line's own splice is all that moves the ranges
 * on it, so this holds whichever other lines the person leaves chosen.
 */
export interface LineStyling {
  boxIndex: number;
  lineIndex: number;
  ranges: {
    /** Position in the box's `custom_attributes`. */
    index: number;
    /** The attribute's member of the `Attribute` oneof, `capitalization` say. */
    kind: string;
    /** The member's value where it is a plain one: `1`, All Caps, for a capitalization. */
    value?: unknown;
    /** The part of the line the range covers now, `""` for none of it. */
    before: string;
    /** The part it covers once the line changes; null where the line is removed. */
    after: string | null;
  }[];
}

export interface WorkspaceEdit {
  boxes: BoxEdit[];
  /** One per fix, in the order of the fixes. */
  styling: LineStyling[];
  /** The presentation as read from the document the edit was planned on, for `checkWorkspaceEdit`. */
  before: PresentationDoc;
}

/**
 * Why a box's attribute ranges cannot be moved with its text:
 *
 * - `malformed`: a range that starts after it ends, or before the text, or
 *   that its edit would leave so.
 * - `typedAtEdge`: text is added exactly at a range's start or end, on a
 *   line the range does not cover, so whether the range should take it in
 *   is a guess.
 * - `replacedAcrossEdge`: a range starts or ends inside text that is
 *   replaced with other text, on a line it does not cover, so where in the
 *   new text it should start or end is a guess.
 */
export type RangeRefusal = "malformed" | "typedAtEdge" | "replacedAcrossEdge";

/** Thrown when a box's attribute ranges cannot be moved with its text without a guess. */
export class AttributeRangeError extends Error {
  readonly boxIndex: number;
  readonly reason: RangeRefusal;
  /** The line whose change it is, where it is one line's. */
  readonly lineIndex?: number;

  constructor(boxIndex: number, reason: RangeRefusal, lineIndex?: number) {
    super(
      `The attribute ranges of text box ${boxIndex} cannot be moved with its text (${reason}` +
        `${lineIndex === undefined ? "" : `, line ${lineIndex}`})`
    );
    this.name = "AttributeRangeError";
    this.boxIndex = boxIndex;
    this.reason = reason;
    this.lineIndex = lineIndex;
  }
}

/**
 * The keys that reach a field of the message in the snapshot's JSON. A field
 * is either a key of its own, or the chosen member of a oneof, which the
 * snapshot keeps under the oneof's name as `{ __tag, [tag]: value }`.
 */
function locate(json: Json, fields: readonly string[]): LoroKey[] | undefined {
  const keys: LoroKey[] = [];
  let at = json;
  for (const field of fields) {
    if (!isObject(at)) return undefined;
    if (field in at) {
      keys.push(field);
      at = at[field];
      continue;
    }
    const oneof = Object.keys(at).find((key) => isObject(at[key]) && at[key].__tag === field && field in at[key]);
    if (oneof === undefined) return undefined;
    keys.push(oneof, field);
    at = at[oneof][field];
  }
  return keys;
}

/**
 * The keys from `root` to the text element's map at an address, by the
 * walk `textBoxAddresses` makes of the message: the cue, its action, the
 * slide's element, its text.
 */
export function loroPathOf(root: Json, address: TextBoxAddress | undefined): LoroKey[] | undefined {
  if (!address?.cueUuid || !isObject(root?.cues)) return undefined;
  // Keyed by the cue's uuid. Looked for by the uuid it carries as well,
  // should the two ever be spelled differently.
  const key =
    address.cueUuid in root.cues
      ? address.cueUuid
      : Object.keys(root.cues).find((k) => root.cues[k]?.uuid === address.cueUuid);
  if (key === undefined) return undefined;
  const action = root.cues[key]?.actions?.[address.actionIndex];
  const toElements = locate(action, ["slide", "presentation", "base_slide", "elements"]);
  const element = toElements && valueAt(action, toElements)?.[address.elementIndex];
  const toText = element && locate(element, ["element", "text"]);
  if (!toElements || !toText) return undefined;
  return ["cues", key, "actions", address.actionIndex, ...toElements, address.elementIndex, ...toText];
}

/** The value at a path of keys, or undefined where there is none. */
export function valueAt(json: Json, path: readonly LoroKey[]): Json {
  let at = json;
  for (const key of path) {
    if (at === null || typeof at !== "object") return undefined;
    at = at[key];
  }
  return at;
}

/**
 * One change to a box's text, in its characters as ProPresenter counts them
 * (UTF-16 code units, a line break as one): `[start, end)` of the text as it
 * reads now is replaced by `inserted` characters.
 */
interface TextSplice {
  start: number;
  end: number;
  inserted: number;
  lineIndex: number;
  /** The line as it reads now, without its break. */
  line: { start: number; end: number };
  /** The line's characters other than the spaces and tabs at either end. */
  visible: { start: number; end: number };
}

const isBlank = (c: string) => c === " " || c === "\t";

/**
 * Each line's change as a splice of the whole box's text, in order. A
 * changed line is the same splice `replaceLineText` makes its RTF edit
 * from; a removed line takes its break with it, as `lineEdit` does, or the
 * break before it where it is the last.
 */
function textSplices(before: readonly string[], after: readonly (string | null)[]): TextSplice[] {
  const splices: TextSplice[] = [];
  for (const [lineIndex, line] of lineBounds(before).entries()) {
    const text = before[lineIndex];
    const next = after[lineIndex];
    let lead = 0;
    while (lead < text.length && isBlank(text[lead])) lead++;
    let trail = 0;
    while (trail < text.length - lead && isBlank(text[text.length - 1 - trail])) trail++;
    const visible = { start: line.start + lead, end: Math.max(line.end - trail, line.start + lead) };
    if (next === null && lineIndex === before.length - 1) {
      // The last line has no break after it, so it takes the one before it
      // -- before the whole run of removed lines it ends, each of which took
      // its own break, the last of them this line's.
      let start = line.start;
      while (splices.at(-1)?.end === start && splices.at(-1)?.inserted === 0) start = splices.pop()!.start;
      splices.push({ start: Math.max(start - 1, 0), end: line.end, inserted: 0, lineIndex, line, visible });
    } else if (next === null) {
      splices.push({ start: line.start, end: line.end + 1, inserted: 0, lineIndex, line, visible });
    } else if (next !== text) {
      const { start, end: cut, inserted } = lineSplice(text, next);
      splices.push({ start: line.start + start, end: line.start + cut, inserted: inserted.length, lineIndex, line, visible });
    }
  }
  return splices;
}

/**
 * Where an attribute range's ends go when lines change, mapped through the
 * exact splice each changed line is:
 *
 * 1. An end in text no splice touches moves by the change in length before
 *    it, wherever it sits in its line.
 * 2. An end inside removed text goes to where that text was.
 * 3. A range running past the end of the text is first cut back to the end.
 *    It covers nothing visible, so nothing on screen changes.
 * 4. New text exactly at a range's start or end -- typed there, or
 *    replacing text just past it -- or replacing text the range starts or
 *    ends inside, joins the range when the range covers
 *    that whole line -- all of it but spaces and tabs at either end, as an
 *    All Caps range does. Ranges of the same styling count together, since
 *    ProPresenter often splits one line's All Caps at a tab or a space; the
 *    new text then joins the first of them with characters on the line, and
 *    the rest move past it, so they still meet and never overlap. New text stays out of a range that
 *    only meets the line, ending where the line starts or starting where it
 *    ends, and out of an empty range.
 * 5. Anything else is a guess, and the box is refused (`AttributeRangeError`).
 *
 * Every range a line-boundary rule could move is moved the same way here:
 * an end on a line's start or end is in text no splice touches, or is a
 * case of 2 or 4.
 *
 * `after` has one entry per line of `before`: its new text, or null where
 * the line is removed. Ranges are in the box's characters as it reads now.
 * `styles` says which ranges are the same styling: those with equal
 * entries. Without it every range is a styling of its own.
 */
export function moveRanges(
  boxIndex: number,
  before: readonly string[],
  after: readonly (string | null)[],
  ranges: readonly { start: number; end: number }[],
  styles?: readonly unknown[]
): { start: number; end: number }[] {
  const splices = textSplices(before, after);
  const length = before.reduce((sum, text) => sum + text.length, Math.max(before.length - 1, 0));
  if (ranges.some(({ start, end }) => !(start >= 0 && start <= end))) throw new AttributeRangeError(boxIndex, "malformed");
  const cut = ranges.map(({ start, end }) => ({ start: Math.min(start, length), end: Math.min(end, length) }));
  const style = (i: number) => (styles ? styles[i] : i);
  const sameStyle = (i: number) => cut.flatMap((range, k) => (style(k) === style(i) ? [{ ...range, k }] : []));

  /** Whether ranges of this one's styling, together, cover the splice's line. */
  const covers = (i: number, splice: TextSplice) => {
    let reached = splice.visible.start;
    for (const range of sameStyle(i).sort((a, b) => a.start - b.start)) {
      if (range.start <= reached) reached = Math.max(reached, range.end);
    }
    return reached >= splice.visible.end;
  };
  /**
   * Of the ranges of this one's styling that the splice's new text could
   * join, whether this is the one that does -- the first by where it starts
   * -- or one of the others, which move past the new text. Only a range
   * with characters on the line can take it, so an empty range, or one that
   * only meets the line, is neither, and keeps its own place below; unless
   * no range has any, as over an empty line, which the first of them takes.
   * Undefined when this range is not one the new text could join.
   */
  const joins = (i: number, splice: TextSplice): "first" | "other" | undefined => {
    const removes = splice.end > splice.start;
    const could = sameStyle(i).filter((r) => r.end >= splice.start && r.start <= splice.end);
    const onLine = could.filter((r) => r.end > r.start && r.end > splice.line.start && r.start < splice.line.end);
    const pool = onLine.length > 0 ? onLine : could;
    if (!pool.some((r) => r.k === i)) return undefined;
    // Where text is replaced, a range that held some of it comes before one
    // that only meets it: the new text takes the place of what it held.
    const meetsOnly = (r: { start: number; end: number }) => (removes && !(r.end > splice.start && r.start < splice.end) ? 1 : 0);
    pool.sort((a, b) => meetsOnly(a) - meetsOnly(b) || a.start - b.start || a.k - b.k);
    return pool[0].k === i ? "first" : "other";
  };

  return cut.map((range, i) => {
    const map = (x: number, edge: "start" | "end") => {
      let shift = 0;
      for (const splice of splices) {
        const removes = splice.end > splice.start;
        // New text replacing what lies just past this range's end, or just
        // before its start, lands right at its edge, as typed text would.
        const atEdge =
          removes &&
          splice.inserted > 0 &&
          ((edge === "end" && x === splice.start && range.start < x) || (edge === "start" && x === splice.end && range.end > x));
        // Before this splice, or where a removal begins: nothing before it moves.
        if (!atEdge && (x < splice.start || (x === splice.start && removes))) break;
        // After it, or where a removal ends: by however much it changed the length.
        if (!atEdge && (x > splice.end || (x === splice.end && removes))) {
          shift += splice.inserted - (splice.end - splice.start);
          continue;
        }
        const at = splice.start + shift;
        // Inside removed text with nothing put in its place: where it was.
        if (splice.inserted === 0) return at;
        // New text right at this end, or in place of text this end is inside.
        // Over a whole line, the range it joins takes it in.
        const joined = covers(i, splice) ? joins(i, splice) : undefined;
        if (joined === "first") return edge === "start" ? at : at + splice.inserted;
        // Another range took the new text: this one ends before it, or starts after it.
        if (joined === "other") return edge === "end" && atEdge ? at : at + splice.inserted;
        // An empty range covers nothing wherever it is, and stays before the
        // new text: both its ends, so it never comes out backwards.
        if (range.start === range.end) return at;
        // A range that only meets the line -- ending where it starts, or
        // starting where it ends -- is not on it, and leaves it out.
        if (edge === "end" && x === splice.line.start) return at;
        if (edge === "start" && x === splice.line.end) return at + splice.inserted;
        throw new AttributeRangeError(boxIndex, atEdge || !removes ? "typedAtEdge" : "replacedAcrossEdge", splice.lineIndex);
      }
      return x + shift;
    };
    const moved = { start: map(range.start, "start"), end: map(range.end, "end") };
    // Each end is mapped on its own; a range they leave backwards is never written.
    if (moved.end < moved.start) throw new AttributeRangeError(boxIndex, "malformed");
    return moved;
  });
}

/** Each line's start and end in a box's text, or null for a line that is not there. */
function lineBounds(lines: readonly string[]): { start: number; end: number }[];
function lineBounds(lines: readonly (string | null)[]): ({ start: number; end: number } | null)[];
function lineBounds(lines: readonly (string | null)[]): ({ start: number; end: number } | null)[] {
  let at = 0;
  return lines.map((text) => {
    if (text === null) return null;
    const bounds = { start: at, end: at + text.length };
    at = bounds.end + 1;
    return bounds;
  });
}

/** The part of a line a range covers, `""` for none; an empty line counts as covered by a range around it. */
function coveredOn(text: string, line: { start: number; end: number }, range: { start: number; end: number }): string {
  if (range.start > line.end || range.end < line.start) return "";
  return text.slice(Math.max(range.start, line.start) - line.start, Math.min(range.end, line.end) - line.start);
}

/** The member of an attribute's `Attribute` oneof, and its value where that is a plain one. */
function kindOf(attribute: Json): { kind: string; value?: unknown } {
  const oneof = isObject(attribute) ? attribute.Attribute : undefined;
  const kind = isObject(oneof) && typeof oneof.__tag === "string" ? oneof.__tag : "unknown";
  const value = isObject(oneof) ? oneof[kind] : undefined;
  return value === null || typeof value !== "object" ? { kind, value } : { kind };
}

/** An attribute's range, or nothing for one without a range, which covers no characters to move. */
function rangeOf(attribute: Json): { start: number; end: number } | undefined {
  const range = isObject(attribute) ? attribute.range : undefined;
  if (!isObject(range)) return undefined;
  const { start = 0, end = 0 } = range;
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw new FixError("lossy");
  return { start, end };
}

/**
 * Say an edit planned against the message in the Loro document's terms.
 *
 * `root` is the `root` of the document as it is about to be edited. Throws
 * `FixError("stale")` when a box no longer holds what the fix was planned
 * against, `FixError("lossy")` when a box the person was shown cannot be
 * found in the document holding exactly the RTF the plan read, and
 * `AttributeRangeError` when a box's ranges cannot be moved with its text.
 */
export function planWorkspaceEdit(root: Json, fixes: readonly LineFix[]): WorkspaceEdit {
  if (fixes.length === 0) throw new FixError("unchanged");
  const { message } = presentationFromWorkspace(root);
  const before = readPresentation(message);
  const replacements = spliceBoxes(before, fixes);
  const addresses = new Map(textBoxAddresses(message).map((a) => [a.boxIndex, a]));

  const boxes: BoxEdit[] = [];
  const styling = new Map<LineFix, LineStyling>();
  for (const [boxIndex, rtf] of replacements) {
    const box = before.textBoxes.find((b) => b.boxIndex === boxIndex)!;
    const path = loroPathOf(root, addresses.get(boxIndex));
    if (!path) throw new FixError("lossy");
    // The conversion and the document have to agree about which box this
    // is, and the only proof is the box itself: the RTF the person was
    // shown, byte for byte, in the map about to be changed.
    const text = valueAt(root, path);
    if (!isObject(text) || !ArrayBuffer.isView(text.rtf_data) || decodeRtf(text.rtf_data) !== box.rtf) {
      throw new FixError("lossy");
    }

    const byLine = new Map(fixes.filter((fix) => fix.boxIndex === boxIndex).map((fix) => [fix.lineIndex, fix.after]));
    const lines = box.lines.map((line) => line.text);
    const after = lines.map((was, i) => (byLine.has(i) ? byLine.get(i)! : was));
    const attributes: Json[] = Array.isArray(text.attributes?.custom_attributes) ? text.attributes.custom_attributes : [];
    const present = attributes.flatMap((attribute, index) => {
      const range = rangeOf(attribute);
      return range ? [{ index, range }] : [];
    });
    // Ranges of the same styling: the attribute apart from its range.
    const styles = present.map(({ index }) => stableJson({ ...attributes[index], range: null }));
    const moved = moveRanges(boxIndex, lines, after, present.map((p) => p.range), styles);
    const ranges: RangeMove[] = present.flatMap(({ index, range }, i) =>
      moved[i].start !== range.start || moved[i].end !== range.end ? [{ index, ...moved[i] }] : []
    );
    const length = lines.join("\n").length;
    const cutBack = present.filter(({ range }) => range.end > length).map(({ index }) => index);

    const was = lineBounds(lines);
    const now = lineBounds(after);
    for (const fix of fixes.filter((f) => f.boxIndex === boxIndex)) {
      const i = fix.lineIndex;
      const on = present.flatMap(({ index, range }, k) => {
        const shown = {
          ...kindOf(attributes[index]),
          before: coveredOn(lines[i], was[i]!, { start: Math.min(range.start, length), end: Math.min(range.end, length) }),
          after: now[i] && coveredOn(after[i]!, now[i]!, moved[k]),
        };
        return shown.before === shown.after || (shown.before === "" && !shown.after) ? [] : [{ index, ...shown }];
      });
      styling.set(fix, { boxIndex, lineIndex: i, ranges: on });
    }

    boxes.push({ boxIndex, path, rtf: encodeRtf(rtf), ranges, cutBack });
  }
  return {
    boxes: boxes.sort((a, b) => a.boxIndex - b.boxIndex),
    styling: fixes.map((fix) => styling.get(fix)!),
    before,
  };
}

/** The document's `root` with an edit made, as plain JSON: what the Loro document should read afterwards. */
export function editedRoot(root: Json, boxes: readonly BoxEdit[]): Json {
  const copy = structuredClone(root);
  for (const box of boxes) {
    const text = valueAt(copy, box.path);
    text.rtf_data = box.rtf;
    for (const { index, start, end } of box.ranges) {
      const attribute = text.attributes.custom_attributes[index];
      attribute.range = { ...attribute.range, start, end };
    }
  }
  return copy;
}

/**
 * One spelling of a Loro document's JSON, so two can be compared: keys in
 * order, bytes as hex. Maps are unordered in Loro, and `toJSON` gives their
 * keys in whatever order it holds them.
 */
export function stableJson(value: Json): string {
  return JSON.stringify(value, (_key, v) => {
    if (ArrayBuffer.isView(v)) {
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      return `bytes:${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    }
    if (typeof v === "bigint") return `bigint:${v}`;
    if (isObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
    return v;
  });
}

/**
 * Guard 4 on the document itself: throws `FixError("verifyFailed")` unless
 * `after`, the `root` of the edited document decoded afresh, is `before`
 * with exactly the planned edit and nothing else, and every line of every
 * box reads as promised through the same conversion the plan was read with.
 */
export function checkWorkspaceEdit(before: Json, after: Json, edit: WorkspaceEdit, fixes: readonly LineFix[]): void {
  if (stableJson(editedRoot(before, edit.boxes)) !== stableJson(after)) throw new FixError("verifyFailed");
  let read: PresentationDoc;
  try {
    read = readPresentation(presentationFromWorkspace(after).message);
  } catch {
    throw new FixError("verifyFailed");
  }
  verifyLines(read, edit.before, fixes);
  // Every range of every edited box within its text and the right way round,
  // whatever the plan said: a backwards range matches a plan that has one.
  for (const box of edit.boxes) {
    const lines = read.textBoxes.find((b) => b.boxIndex === box.boxIndex)?.lines ?? [];
    const length = lines.map((line) => line.text).join("\n").length;
    const attributes = valueAt(after, box.path)?.attributes?.custom_attributes;
    for (const attribute of Array.isArray(attributes) ? attributes : []) {
      const range = rangeOf(attribute);
      if (range && !(range.start >= 0 && range.start <= range.end && range.end <= length)) throw new FixError("verifyFailed");
    }
  }
}

/** Unsigned LEB128. */
function varint(n: bigint, out: number[]): void {
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
}

/**
 * A version vector as ProPresenter stores it in `version_vector`: the number
 * of peers, then for each peer in ascending order of id the id as a varint
 * and its counter as a zigzag varint. Not what Loro's own `encode()` gives,
 * which is in no particular order. Reproduced for every row of a real
 * workspace.
 *
 * Keys are peer ids in decimal, as `VersionVector.toJSON()` gives them.
 */
export function encodeVersionVector(vv: ReadonlyMap<string, number>): Uint8Array {
  const entries = [...vv].map(([peer, counter]) => [BigInt(peer), counter] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const out: number[] = [];
  varint(BigInt(entries.length), out);
  for (const [peer, counter] of entries) {
    varint(peer, out);
    // Zigzag, since a counter is signed: 0, -1, 1, -2 ... as 0, 1, 2, 3 ...
    const c = BigInt(counter);
    varint(c >= 0n ? c * 2n : -c * 2n - 1n, out);
  }
  return Uint8Array.from(out);
}

/** Whether `after` is `before` with one peer more, `peer`, and every other counter as it was. */
export function onlyPeerAdded(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>, peer: string): boolean {
  if (before.has(peer) || after.size !== before.size + 1 || !((after.get(peer) ?? 0) > 0)) return false;
  return [...before].every(([p, counter]) => after.get(p) === counter);
}
