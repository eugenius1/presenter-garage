import { messageType, type RawDoc } from "./decode";
import { formatColor } from "./model";

/**
 * ProPresenter's own configured lists: the groups a slide can be put in and
 * the macros a slide can trigger, as the Groups and Macros windows show them.
 *
 * Each is a document of its own: `Configuration/Groups` and
 * `Configuration/Macros` beside `Libraries` in the old layout, and the
 * `Groups` and `Macros` documents of a ProPresenter 22 workspace. Both are
 * read the same way here, from the bytes the file holds or the workspace
 * document is converted to. Read-only: nothing here writes either back.
 *
 * Names are handed over exactly as stored. A real list held `Couplet 1` to
 * `Couplet 3` with a non-breaking space and `Couplet 4` to `Couplet 6` with
 * an ordinary one, and a presentation's group matches the configured one by
 * name alone, so a name tidied on the way out would hide the very difference
 * a check is looking for.
 */

const ProGroupsDocument = messageType("rv.data.ProGroupsDocument");
const MacrosDocument = messageType("rv.data.MacrosDocument");

export interface ConfiguredGroup {
  name: string;
  uuid?: string;
  /** As `rgb(r,g,b)`, or `rgba(...)` when not opaque. */
  color?: string;
  /** The colour as stored, each channel 0 to 1, for a writer to copy exactly. */
  rgba?: Rgba;
}

/** A colour as `rv.data.Color` stores it, each channel 0 to 1. */
export interface Rgba {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

/** A colour message's channels, an unset one 0 as protobuf reads it. */
export const rgbaOf = (color: any): Rgba => ({
  red: color.red ?? 0,
  green: color.green ?? 0,
  blue: color.blue ?? 0,
  alpha: color.alpha ?? 0,
});

export interface ConfiguredMacro {
  name: string;
  /**
   * What a slide's macro names it by. Lower-case in a `.pro` era file and
   * upper-case in a ProPresenter 22 workspace: compare without regard to case.
   */
  uuid?: string;
  /** The macro collections it is listed in, by name. */
  collections: string[];
  /**
   * The same collections, each with its uuid where it has one: what a slide
   * records as the macro's `parent_collection`.
   */
  collectionRefs?: { name: string; uuid?: string }[];
}

export function decodeGroupsDocument(bytes: Uint8Array): RawDoc {
  return ProGroupsDocument.decode(bytes) as RawDoc;
}

export function decodeMacrosDocument(bytes: Uint8Array): RawDoc {
  return MacrosDocument.decode(bytes) as RawDoc;
}

const uuidOf = (message: any): string | undefined => message?.uuid?.string || undefined;

/** The configured groups, in ProPresenter's order. */
export function readGroups(doc: RawDoc): ConfiguredGroup[] {
  return ((doc as any).groups ?? []).map((group: any) => ({
    name: group.name ?? "",
    uuid: uuidOf(group),
    color: group.color ? formatColor(group.color) : undefined,
    ...(group.color && { rgba: rgbaOf(group.color) }),
  }));
}

/**
 * The configured macros, in ProPresenter's order.
 *
 * The two layouts keep them in different places. A `Configuration/Macros`
 * file lists every macro at the top and has each collection name its macros
 * by uuid; a workspace keeps none at the top and holds each macro inside its
 * collection. Both are read, and a macro found in both places, or in two
 * collections, is listed once with every collection it is in.
 */
export function readMacros(doc: RawDoc): ConfiguredMacro[] {
  const raw = doc as any;
  const byKey = new Map<string, ConfiguredMacro>();
  const ordered: ConfiguredMacro[] = [];
  // A macro with no uuid cannot be the same as another, so each is its own entry.
  const keyOf = (macro: any) => uuidOf(macro)?.toLowerCase();

  const add = (macro: any): ConfiguredMacro => {
    const key = keyOf(macro);
    const known = key ? byKey.get(key) : undefined;
    if (known) return known;
    const entry: ConfiguredMacro = { name: macro.name ?? "", uuid: uuidOf(macro), collections: [] };
    if (key) byKey.set(key, entry);
    ordered.push(entry);
    return entry;
  };
  const listIn = (entry: ConfiguredMacro | undefined, collection: any) => {
    const name: string = collection.name ?? "";
    if (!entry || entry.collections.includes(name)) return;
    entry.collections.push(name);
    (entry.collectionRefs ??= []).push({ name, uuid: uuidOf(collection) });
  };

  const collections: any[] = raw.macro_collections ?? [];
  for (const macro of raw.macros ?? []) add(macro);
  for (const collection of collections) {
    for (const macro of collection.macros ?? []) listIn(add(macro), collection);
  }
  // A second pass, so an item may name a macro held in a later collection.
  for (const collection of collections) {
    for (const item of collection.items ?? []) {
      const id: string | undefined = item?.macro_id?.string;
      if (id) listIn(byKey.get(id.toLowerCase()), collection);
    }
  }
  return ordered;
}
