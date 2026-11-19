import { FixError, spliceBoxes, verifyLines, type LineFix } from "./fixes";
import { readPresentation, textBoxAddresses, type PresentationDoc, type TextBoxAddress } from "./presentation";
import { decodeRtf, encodeRtf } from "./rtf";
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
}

export interface WorkspaceEdit {
  boxes: BoxEdit[];
  /** The presentation as read from the document the edit was planned on, for `checkWorkspaceEdit`. */
  before: PresentationDoc;
}

/**
 * Thrown when a box has character ranges that cannot be moved with its text
 * without guessing: one that does not start and end on its lines as they
 * read, or, with `addedLine` set, one an added line could only guess
 * whether to take.
 */
export class AttributeRangeError extends Error {
  readonly boxIndex: number;
  readonly addedLine: boolean;

  constructor(boxIndex: number, addedLine = false) {
    super(
      addedLine
        ? `Whether a line added to text box ${boxIndex} takes its attribute ranges would be a guess`
        : `The attribute ranges of text box ${boxIndex} do not fall on its lines`
    );
    this.name = "AttributeRangeError";
    this.boxIndex = boxIndex;
    this.addedLine = addedLine;
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
function loroPathOf(root: Json, address: TextBoxAddress | undefined): LoroKey[] | undefined {
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

/** Lines added beside one line of a box, in the order they read. */
export interface AddedLines {
  before: readonly string[];
  after: readonly string[];
}

/** An attribute range; `caps` when it is a capitalization, which an added line beside it takes. */
export interface Range {
  start: number;
  end: number;
  caps?: boolean;
}

/**
 * Where an attribute range's ends go when lines change length, or lines are
 * added.
 *
 * Each end has to sit on a line's start or a line's end as the box reads
 * now -- in this box's characters, a line break counting as one, as
 * ProPresenter counts them -- and it goes to the same place on that line
 * once the lines change. A removed line's start and end both become the
 * place it was, which is where the next line now starts. An end anywhere
 * else, inside a line or beyond the text, cannot be moved without guessing
 * what it was meant to cover, so the box is refused.
 *
 * `after` has one entry per line of `before`: its new text, or null where
 * the line is removed. `added` has, by line, the lines added beside it.
 *
 * An added line takes the formatting of the line it is added beside, and so
 * its ranges: a range is to cover the new lines exactly when it covers
 * all of that line. A capitalization -- ProPresenter's All Caps, nearly
 * every range in a real library and one to a line -- that ends where that
 * line does is widened over the new lines, so they read in capitals as
 * their neighbour does. No range is created: that would be a new container
 * in the document, which nothing here writes. Any other range that would
 * come out covering the new lines and not the line, or the line and not
 * the new lines, or part of them, makes the answer a guess, and the box is
 * refused.
 */
export function moveRanges(
  boxIndex: number,
  before: readonly string[],
  after: readonly (string | null)[],
  ranges: readonly Range[],
  added: ReadonlyMap<number, AddedLines> = new Map()
): { start: number; end: number }[] {
  // Each line's old start and end, to where they go.
  const starts = new Map<number, number>();
  const ends = new Map<number, number>();
  /** Each run of added lines: where its text lies now, and where the line it was added beside lies, then and now. */
  const blocks: {
    side: keyof AddedLines;
    start: number;
    end: number;
    line: { was: { start: number; end: number }; now: { start: number; end: number } };
  }[] = [];
  let was = 0;
  let now = 0;
  /** Lay out a run of added lines from `now`, and say where its text lies. */
  const lay = (texts: readonly string[]) => {
    const start = now;
    for (const text of texts) now += text.length + 1;
    return { start, end: now - 1 };
  };
  for (const [i, text] of before.entries()) {
    const next = after[i];
    const add = added.get(i);
    // Refused when planning: the added line would take the formatting of a line that goes.
    if (next === null && (add?.before.length || add?.after.length)) throw new AttributeRangeError(boxIndex, true);
    const ahead = add?.before.length ? lay(add.before) : undefined;
    const line = {
      was: { start: was, end: was + text.length },
      now: { start: now, end: now + (next?.length ?? 0) },
    };
    // A removed line takes no room, so both its ends land where the next line now starts.
    starts.set(line.was.start, line.now.start);
    ends.set(line.was.end, line.now.end);
    was += text.length + 1;
    if (next !== null) now += next.length + 1;
    if (ahead) blocks.push({ side: "before", ...ahead, line });
    if (add?.after.length) blocks.push({ side: "after", ...lay(add.after), line });
  }
  // `now` counts a break after the last kept line that is not there. A
  // removed line with no kept line after it has nowhere to land but the end
  // of the text, and would otherwise land one past it.
  const length = Math.max(now - 1, 0);
  const place = (p: number | undefined) => (p === undefined ? undefined : Math.min(p, length));
  const covers = (r: { start: number; end: number }, span: { start: number; end: number }) =>
    r.start <= span.start && r.end >= span.end;

  // A start is matched to a line's start first, an end to a line's end, so
  // a range over an empty line keeps both its ends on that line.
  return ranges.map((range) => {
    const { start, end } = range;
    const moved = { start: place(starts.get(start) ?? ends.get(start)), end: place(ends.get(end) ?? starts.get(end)) };
    if (!(start <= end) || moved.start === undefined || moved.end === undefined) throw new AttributeRangeError(boxIndex);
    const out = moved as { start: number; end: number };

    for (const block of blocks) {
      // Whether the range covers the line, judged by where it was, so the
      // empty range a removed neighbour leaves behind is not mistaken for one.
      const owns = covers(range, block.line.was);
      if (owns && !covers(out, block)) {
        const edge = block.side === "after" ? out.end === block.line.now.end : out.start === block.line.now.start;
        if (!range.caps || !edge) throw new AttributeRangeError(boxIndex, true);
        if (block.side === "after") out.end = block.end;
        else out.start = block.start;
      } else if (!owns && Math.max(out.start, block.start) < Math.min(out.end, block.end)) {
        throw new AttributeRangeError(boxIndex, true);
      }
    }
    return out;
  });
}

/** An attribute's range, or nothing for one without a range, which covers no characters to move. */
function rangeOf(attribute: Json): { start: number; end: number } | undefined {
  const range = isObject(attribute) ? attribute.range : undefined;
  if (!isObject(range)) return undefined;
  const { start = 0, end = 0 } = range;
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw new FixError("lossy");
  return { start, end };
}

/** Whether an attribute is a capitalization: its oneof, as the snapshot keeps one, tagged so. */
function isCapitalization(attribute: Json): boolean {
  return isObject(attribute) && Object.values(attribute).some((v) => isObject(v) && v.__tag === "capitalization");
}

/**
 * Say an edit planned against the message in the Loro document's terms.
 *
 * `root` is the `root` of the document as it is about to be edited. Throws
 * `FixError("stale")` when a box no longer holds what the fix was planned
 * against, `FixError("lossy")` when a box the person was shown cannot be
 * found in the document holding exactly the RTF the plan read, and
 * `AttributeRangeError` when a box's ranges cannot be moved with its text,
 * or whether a line added to it takes one would be a guess.
 */
export function planWorkspaceEdit(root: Json, fixes: readonly LineFix[]): WorkspaceEdit {
  if (fixes.length === 0) throw new FixError("unchanged");
  const { message } = presentationFromWorkspace(root);
  const before = readPresentation(message);
  const replacements = spliceBoxes(before, fixes);
  const addresses = new Map(textBoxAddresses(message).map((a) => [a.boxIndex, a]));

  const boxes: BoxEdit[] = [];
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

    const mine = fixes.filter((fix) => fix.boxIndex === boxIndex);
    const byLine = new Map(mine.filter((fix) => !fix.insert).map((fix) => [fix.lineIndex, fix.after]));
    const added = new Map<number, { before: string[]; after: string[] }>();
    // In the order the fixes list them, which is the order the lines read.
    for (const fix of mine) {
      if (!fix.insert) continue;
      const beside = added.get(fix.lineIndex) ?? { before: [], after: [] };
      beside[fix.insert].push(fix.after!);
      added.set(fix.lineIndex, beside);
    }
    const lines = box.lines.map((line) => line.text);
    const after = lines.map((was, i) => (byLine.has(i) ? byLine.get(i)! : was));
    const attributes: Json[] = Array.isArray(text.attributes?.custom_attributes) ? text.attributes.custom_attributes : [];
    const present = attributes.flatMap((attribute, index) => {
      const range = rangeOf(attribute);
      return range ? [{ index, range: { ...range, caps: isCapitalization(attribute) } }] : [];
    });
    const moved = moveRanges(boxIndex, lines, after, present.map((p) => p.range), added);
    const ranges: RangeMove[] = present.flatMap(({ index, range }, i) =>
      moved[i].start !== range.start || moved[i].end !== range.end ? [{ index, ...moved[i] }] : []
    );

    boxes.push({ boxIndex, path, rtf: encodeRtf(rtf), ranges });
  }
  return { boxes: boxes.sort((a, b) => a.boxIndex - b.boxIndex), before };
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
