import { FixError, spliceBoxes, verifyLines, type LineFix } from "./fixes";
import { readPresentation, textBoxAddresses, type PresentationDoc, type TextBoxAddress } from "./presentation";
import { isAllCaps, rangesAfter, type LineStyling } from "./ranges";
import { decodeRtf, encodeRtf } from "./rtf";
import {
  canonical,
  expectStructure,
  isCurrent,
  readStructure,
  sameStructure,
  type PresentationStructure,
  type StructureChange,
} from "./structure";
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

/**
 * A key into a Loro map, a position in a Loro list, or a node of a Loro
 * tree by its id: the node's own map, which `toJSON()` gives as its `meta`.
 * A presentation's groups and slides are such a tree (`cue_group_placements`).
 */
export type LoroKey = string | number | { node: string };

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
 * One value set in a map that is already there, for a structural change: a
 * group's name, a macro's uuid. Never a container, and never over one.
 */
export interface ValueEdit {
  /** From the document's `root` to the map. */
  path: LoroKey[];
  key: string;
  value: string | number | null;
}

export interface WorkspaceEdit {
  boxes: BoxEdit[];
  /** The structural changes, as values to set; in the order of the changes. */
  values: ValueEdit[];
  /** One per fix, in the order of the fixes. */
  styling: LineStyling[];
  /** The presentation as read from the document the edit was planned on, for `checkWorkspaceEdit`. */
  before: PresentationDoc;
  /** Its whole structure as it should read once the edit is in. */
  structure: PresentationStructure;
}

// Where a box's ranges go is the rule a `.pro` file's move by too, in `ranges.ts`.
export { AttributeRangeError, type LineStyling, type RangeRefusal } from "./ranges";

/**
 * The keys that reach a field of the message in the snapshot's JSON. A field
 * is either a key of its own, or the chosen member of a oneof, which the
 * snapshot keeps under the oneof's name as `{ __tag, [tag]: value }`.
 */
export function locate(json: Json, fields: readonly string[]): LoroKey[] | undefined {
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
  if (!address?.cueUuid) return undefined;
  const key = cueKey(root, address.cueUuid);
  if (key === undefined) return undefined;
  const action = root.cues[key]?.actions?.[address.actionIndex];
  const toElements = locate(action, ["slide", "presentation", "base_slide", "elements"]);
  const element = toElements && valueAt(action, toElements)?.[address.elementIndex];
  const toText = element && locate(element, ["element", "text"]);
  if (!toElements || !toText) return undefined;
  return ["cues", key, "actions", address.actionIndex, ...toElements, address.elementIndex, ...toText];
}

/**
 * A cue's key in the document's `cues` map: its uuid, or failing that the
 * key whose cue carries that uuid, should the two ever be spelled differently.
 */
function cueKey(root: Json, cueUuid: string): string | undefined {
  if (!isObject(root?.cues)) return undefined;
  return cueUuid in root.cues ? cueUuid : Object.keys(root.cues).find((k) => root.cues[k]?.uuid === cueUuid);
}

/** A node of a tree as `toJSON()` gives one, found by id at any depth. */
function treeNode(nodes: Json, id: string): Json {
  if (!Array.isArray(nodes)) return undefined;
  for (const node of nodes) {
    if (node?.id === id) return node;
    const found = treeNode(node?.children, id);
    if (found) return found;
  }
  return undefined;
}

/** The value at a path of keys, or undefined where there is none. */
export function valueAt(json: Json, path: readonly LoroKey[]): Json {
  let at = json;
  for (const key of path) {
    if (at === null || typeof at !== "object") return undefined;
    at = typeof key === "object" ? treeNode(at, key.node)?.meta : at[key];
  }
  return at;
}

/** The member of an attribute's `Attribute` oneof, and its value where that is a plain one. */
function kindOf(attribute: Json): { kind: string; value?: unknown } {
  const oneof = isObject(attribute) ? attribute.Attribute : undefined;
  const kind = isObject(oneof) && typeof oneof.__tag === "string" ? oneof.__tag : "unknown";
  const value = isObject(oneof) ? oneof[kind] : undefined;
  return value === null || typeof value !== "object" ? { kind, value } : { kind };
}

/** Whether an attribute is All Caps: its oneof, as the snapshot keeps one, tagged a capitalization of that value. */
function isCapitalization(attribute: Json): boolean {
  return isObject(attribute) && Object.values(attribute).some((v) => isObject(v) && v.__tag === "capitalization" && isAllCaps(v.capitalization));
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
 * `AttributeRangeError` when a box's ranges cannot be moved with its text,
 * or whether a line added to it takes one would be a guess (`rangesAfter`,
 * the rule a `.pro` file's ranges move by too). `changes`, the structural
 * ones, are said as values to set (`valueEdits`); one that no longer
 * describes the document is `stale` too.
 */
export function planWorkspaceEdit(root: Json, fixes: readonly LineFix[], changes: readonly StructureChange[] = []): WorkspaceEdit {
  if (fixes.length === 0 && changes.length === 0) throw new FixError("unchanged");
  const { message } = presentationFromWorkspace(root);
  const before = readPresentation(message);
  const structure = readStructure(message);
  if (changes.some((change) => !isCurrent(structure, change))) throw new FixError("stale");
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

    const attributes: Json[] = Array.isArray(text.attributes?.custom_attributes) ? text.attributes.custom_attributes : [];
    const present = attributes.flatMap((attribute, index) => {
      const range = rangeOf(attribute);
      // Ranges of the same styling: the attribute apart from its range.
      const style = stableJson({ ...attribute, range: null });
      return range ? [{ index, ...range, caps: isCapitalization(attribute), ...kindOf(attribute), style }] : [];
    });
    const moved = rangesAfter(box, fixes, present);
    for (const [fix, said] of moved.styling) styling.set(fix, said);
    const ranges: RangeMove[] = present.flatMap(({ index, start, end }, i) =>
      moved.moved[i].start !== start || moved.moved[i].end !== end ? [{ index, ...moved.moved[i] }] : []
    );
    const length = box.lines.map((line) => line.text).join("\n").length;
    const cutBack = present.filter(({ end }) => end > length).map(({ index }) => index);

    boxes.push({ boxIndex, path, rtf: encodeRtf(rtf), ranges, cutBack });
  }
  return {
    boxes: boxes.sort((a, b) => a.boxIndex - b.boxIndex),
    values: changes.flatMap((change) => valueEdits(root, change)),
    styling: fixes.map((fix) => styling.get(fix)!),
    before,
    structure: expectStructure(structure, changes),
  };
}

/**
 * A structural change in the document's own terms: the values to set, each
 * in a map the document already has, holding exactly what the change was
 * planned against. Throws `FixError("lossy")` when the document is not
 * shaped as the conversion read it, and `FixError("newContainer")` when the
 * change would need a map it does not have, such as a colour for a group
 * that stores none.
 */
function valueEdits(root: Json, change: StructureChange): ValueEdit[] {
  const edits: ValueEdit[] = [];
  /**
   * Set `key` at `path`, which must be a map holding `was` there (or nothing,
   * where `was` is undefined). A string field left out of the map reads as
   * its default, `""`, through the conversion, so a `was` of `""` is held by
   * a map without the key too -- and only that default stands in for it.
   */
  const set = (path: LoroKey[], key: string, was: unknown, value: ValueEdit["value"]) => {
    const map = valueAt(root, path);
    if (!isObject(map)) throw new FixError("lossy");
    const now = map[key];
    const empty = (v: unknown) => v === null || v === undefined || v === "";
    const holds = now === was || (was === undefined && empty(now)) || (was === "" && now === undefined);
    if (!holds || isObject(now) || Array.isArray(now)) throw new FixError("lossy");
    if (now !== value && !(empty(now) && empty(value))) edits.push({ path, key, value });
  };

  if (change.kind === "renameGroup") {
    // The conversion numbers groups as the tree holds them, leaving out anything else at its top.
    const groups = Array.isArray(root?.cue_group_placements) ? root.cue_group_placements.filter((n: Json) => n?.meta?.Kind?.__tag === "group") : [];
    const node = groups[change.groupIndex];
    if (typeof node?.id !== "string" || (node.meta.uuid || undefined) !== change.groupUuid) throw new FixError("lossy");
    const meta: LoroKey[] = ["cue_group_placements", { node: node.id }];
    const group = [...meta, "Kind", "group"];
    set(group, "name", change.before.name, change.after.name);
    // A name kept beside the kind as well, as a playlist's node keeps one, follows it.
    if (typeof node.meta.name === "string") set(meta, "name", change.before.name, change.after.name);
    if (change.after.color && canonical(change.after.color) !== canonical(change.before.color)) {
      if (!change.before.color || !isObject(valueAt(root, [...group, "color"]))) throw new FixError("newContainer");
      for (const channel of ["red", "green", "blue", "alpha"] as const) {
        set([...group, "color"], channel, valueAt(root, [...group, "color", channel]), change.after.color[channel]);
      }
    }
    if (change.before.link || change.after.link) {
      set(group, "application_group_identifier", change.before.link?.uuid, change.after.link?.uuid ?? null);
      set(group, "application_group_name", change.before.link?.name, change.after.link?.name ?? "");
    }
    return edits;
  }

  const key = cueKey(root, change.cueUuid);
  const actionPath: LoroKey[] = ["cues", key ?? "", "actions", change.actionIndex];
  const action = valueAt(root, actionPath);
  const toId = key !== undefined && locate(action, ["macro", "identification"]);
  if (!toId) throw new FixError("lossy");
  const id = [...actionPath, ...toId];
  set(id, "parameter_uuid", change.before.uuid, change.after.uuid ?? null);
  set(id, "parameter_name", change.before.name, change.after.name);
  if (change.after.collection) {
    const parent = [...id, "parent_collection"];
    set(parent, "parameter_uuid", change.before.collection?.uuid, change.after.collection.uuid ?? null);
    set(parent, "parameter_name", change.before.collection?.name, change.after.collection.name);
  }
  set(actionPath, "name", change.before.actionName, change.after.actionName);
  return edits;
}

/** The document's `root` with an edit made, as plain JSON: what the Loro document should read afterwards. */
export function editedRoot(root: Json, boxes: readonly BoxEdit[], values: readonly ValueEdit[] = []): Json {
  const copy = structuredClone(root);
  for (const { path, key, value } of values) valueAt(copy, path)[key] = value;
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
  if (stableJson(editedRoot(before, edit.boxes, edit.values)) !== stableJson(after)) throw new FixError("verifyFailed");
  let read: PresentationDoc;
  let structure: PresentationStructure;
  try {
    const { message } = presentationFromWorkspace(after);
    read = readPresentation(message);
    structure = readStructure(message);
  } catch {
    throw new FixError("verifyFailed");
  }
  verifyLines(read, edit.before, fixes);
  // The whole structure through the conversion too, every group, slide, arrangement and macro.
  if (!sameStructure(structure, edit.structure)) throw new FixError("verifyFailed");
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

/**
 * A stored version vector read back, as `encodeVersionVector` writes one, or
 * `undefined` for bytes that are not exactly one: anything left over, cut
 * short, or not in that order. Checked by encoding the result again, so
 * only bytes this would have written are taken.
 */
export function decodeVersionVector(bytes: Uint8Array): Map<string, number> | undefined {
  let at = 0;
  const read = (): bigint | undefined => {
    let n = 0n;
    for (let shift = 0n; at < bytes.length && shift < 70n; shift += 7n) {
      const byte = bytes[at++];
      n |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return n;
    }
    return undefined;
  };
  const count = read();
  if (count === undefined || count > BigInt(bytes.length)) return undefined;
  const vv = new Map<string, number>();
  for (let i = 0n; i < count; i++) {
    const peer = read();
    const zigzag = read();
    if (peer === undefined || zigzag === undefined) return undefined;
    vv.set(peer.toString(), Number(zigzag % 2n === 0n ? zigzag / 2n : -(zigzag + 1n) / 2n));
  }
  if (at !== bytes.length || vv.size !== Number(count)) return undefined;
  const again = encodeVersionVector(vv);
  return again.length === bytes.length && again.every((b, i) => b === bytes[i]) ? vv : undefined;
}

/** Whether `shared` has every change `vv` has: each peer's counter at least as far. */
export function coversVersion(shared: ReadonlyMap<string, number>, vv: ReadonlyMap<string, number>): boolean {
  return [...vv].every(([peer, counter]) => (shared.get(peer) ?? 0) >= counter);
}

/** Whether `after` is `before` with one peer more, `peer`, and every other counter as it was. */
export function onlyPeerAdded(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>, peer: string): boolean {
  if (before.has(peer) || after.size !== before.size + 1 || !((after.get(peer) ?? 0) > 0)) return false;
  return [...before].every(([p, counter]) => after.get(p) === counter);
}
