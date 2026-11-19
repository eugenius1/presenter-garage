import type protobuf from "protobufjs";
import { messageType, type RawDoc } from "./decode";

/**
 * Reading a ProPresenter 22 workspace's documents into the messages the rest
 * of the core already understands.
 *
 * From version 22 a workspace keeps no `.pro` files and no `Playlists/Library`.
 * Every document is a Loro CRDT snapshot in one SQLite database, and what a
 * snapshot holds, read out as JSON, is the old protobuf message under the
 * same field names with a handful of systematic differences. This undoes
 * those differences, so a presentation from a v22 workspace becomes the same
 * `rv.data.Presentation` a `.pro` file decodes to and every check, search and
 * listing works on it unchanged.
 *
 * Pure: it takes the JSON and knows nothing of SQLite or Loro, which are
 * `packages/node`'s to deal with. The format itself is written up in
 * docs/propresenter-22-workspaces.md.
 *
 * Read-only by intent. A message built here has been through a lossy step,
 * so it must never be the source of a write. `unmapped` says how lossy, for
 * the tests that hold the conversion to a real workspace and for whoever
 * next has to work out what a new ProPresenter added; nothing shows it to a
 * person yet.
 */

/** A value as `LoroDoc.toJSON()` gives it. */
type Json = any;

export interface Converted {
  message: RawDoc;
  /**
   * Keys the snapshot held that the schema has no field for, as
   * `rv.data.Type.key`, each once. Empty means everything was carried over.
   */
  unmapped: string[];
}

export const isObject = (v: unknown): v is Record<string, Json> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v);

/** `isEnabled` and `is_enabled` are one field; the snapshots use both spellings. */
const normalise = (name: string) => name.replace(/_/g, "").toLowerCase();

const fieldIndex = new WeakMap<protobuf.Type, Map<string, protobuf.Field>>();

function findField(type: protobuf.Type, key: string): protobuf.Field | undefined {
  const exact = type.fields[key];
  if (exact) return exact;
  let index = fieldIndex.get(type);
  if (!index) {
    index = new Map(type.fieldsArray.map((field) => [normalise(field.name), field]));
    fieldIndex.set(type, index);
  }
  // `group_identifiers_v2` is `group_identifiers` with the UUIDs as bare
  // strings, which is how every UUID is stored here anyway.
  return index.get(normalise(key)) ?? index.get(normalise(key.replace(/_v2$/, "")));
}

/** Bookkeeping of the migration to the new format, with nothing of the document in it. */
const IGNORED = new Set(["value_array_migration_version"]);

/**
 * Put back the `url` every media element used to carry.
 *
 * The old file stores where a media file is twice: on the element, and again
 * inside its image, video or audio properties. The new format keeps only the
 * second, and identifies the file by an `asset_id` besides. Everything that
 * reads a media item -- the audit, the diff, a playlist's entries -- reads the
 * first, so it is restored from the second, which held the same value in
 * every item of the library this was checked against.
 */
function restoreMediaUrl(media: Record<string, Json>): void {
  if (media.url) return;
  const url = (media.video ?? media.image ?? media.audio)?.file?.local_url;
  if (url) media.url = url;
}

class Converter {
  readonly unmapped = new Set<string>();

  /**
   * One message. A snapshot differs from the protobuf in three ways that hold
   * everywhere:
   *
   * - a `oneof` is an object under the oneof's own name, `{ __tag, [tag]: value }`,
   *   where protobuf sets the chosen field directly;
   * - an `rv.data.UUID` is the bare string, not `{ string }`;
   * - an absent message is `null` rather than missing.
   */
  message(type: protobuf.Type, value: Json): Record<string, Json> {
    const out: Record<string, Json> = {};
    if (!isObject(value)) return out;
    for (const [key, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      const oneof = type.oneofs?.[key];
      if (oneof) {
        const tag = isObject(v) ? v.__tag : undefined;
        if (typeof tag !== "string") continue;
        const chosen = type.fields[tag];
        if (!chosen) this.unmapped.add(`${type.fullName.slice(1)}.${key}.${tag}`);
        else out[chosen.name] = this.field(chosen, v[tag]);
        continue;
      }
      const field = findField(type, key);
      if (!field) {
        if (!IGNORED.has(key)) this.unmapped.add(`${type.fullName.slice(1)}.${key}`);
        continue;
      }
      out[field.name] = this.field(field, v);
    }
    if (type.fullName === ".rv.data.Media") restoreMediaUrl(out);
    return out;
  }

  private field(field: protobuf.Field, v: Json): Json {
    field.resolve();
    // No field of the schema is a protobuf map, so a list is the only container.
    if (field.repeated) return Array.isArray(v) ? v.map((x) => this.value(field, x)) : [];
    return this.value(field, v);
  }

  private value(field: protobuf.Field, v: Json): Json {
    const resolved = field.resolvedType;
    if (resolved && "fields" in resolved) {
      const type = resolved as protobuf.Type;
      if (typeof v === "string" && type.fullName === ".rv.data.UUID") return { string: v };
      return this.message(type, v);
    }
    return v;
  }
}

function finish(typeName: string, converter: Converter, plain: Record<string, Json>): Converted {
  return { message: messageType(typeName).fromObject(plain) as RawDoc, unmapped: [...converter.unmapped].sort() };
}

/**
 * A node of the ordered trees the new format uses wherever order or nesting
 * can be edited from two computers at once: the playlists, and a
 * presentation's groups and slides. `children` is already in display order.
 */
interface TreeNode {
  meta?: { uuid?: string; name?: string; Kind?: Record<string, Json> & { __tag?: string } };
  children?: TreeNode[];
}

const kindOf = (node: TreeNode): string | undefined => node.meta?.Kind?.__tag ?? undefined;
const kindData = (node: TreeNode): Json => node.meta?.Kind?.[kindOf(node) ?? ""];

/**
 * A presentation, from the `root` of a `Presentation` snapshot.
 *
 * Beyond the general differences, slides are stored differently. The old
 * file has `cues` in order and `cue_groups` naming the cues each group holds.
 * The new one has `cues` as a map keyed by uuid and the order in
 * `cue_group_placements`, a tree of groups with their cues as children. The
 * old shape is rebuilt from the tree; a cue no group places is kept at the
 * end rather than dropped, since ProPresenter's own files can hold those too.
 */
export function presentationFromWorkspace(root: Json): Converted {
  const converter = new Converter();
  const { cues, cue_group_placements: placements, ...rest } = isObject(root) ? root : ({} as Record<string, Json>);
  const plain = converter.message(messageType("rv.data.Presentation"), rest);

  const byUuid: Record<string, Json> = isObject(cues) ? cues : {};
  const placed = new Set<string>();
  const cueType = messageType("rv.data.Cue");
  const groupType = messageType("rv.data.Group");
  plain.cues = [];
  plain.cue_groups = [];
  for (const node of (Array.isArray(placements) ? placements : []) as TreeNode[]) {
    if (kindOf(node) !== "group") {
      converter.unmapped.add(`rv.data.Presentation.cue_group_placements.${kindOf(node)}`);
      continue;
    }
    const identifiers: { string: string }[] = [];
    for (const child of node.children ?? []) {
      const uuid = child.meta?.uuid;
      if (kindOf(child) !== "cue" || !uuid) continue;
      identifiers.push({ string: uuid });
      // A cue placed twice is listed twice and stored once, as in the old file.
      if (byUuid[uuid] && !placed.has(uuid)) plain.cues.push(converter.message(cueType, byUuid[uuid]));
      placed.add(uuid);
    }
    plain.cue_groups.push({
      group: converter.message(groupType, { ...kindData(node), uuid: node.meta?.uuid }),
      cue_identifiers: identifiers,
    });
  }
  for (const [uuid, cue] of Object.entries(byUuid)) {
    if (!placed.has(uuid)) plain.cues.push(converter.message(cueType, cue));
  }
  return finish("rv.data.Presentation", converter, plain);
}

/**
 * A playlist document, from the `root` of a `PlaylistLibrary`, `PlaylistMedia`
 * or `PlaylistAudio` snapshot: the presentation playlists, the media bin and
 * the audio bin, which are one message distinguished by `type` as before.
 *
 * The old file is a tree of `Playlist` messages, each holding either more
 * playlists or items. The new one is a single tree of nodes whose kind is
 * `group`, `playlist` or `item`, and its one top node is the old root.
 *
 * `Playlist.type` is left unset, as ProPresenter itself leaves it: what a
 * node is has always been told by which of `playlists` and `items` it holds.
 *
 * Whether a folder is expanded is no longer part of the document: it is kept
 * per computer, in the `scope = 1` snapshot, and is not read.
 */
export function playlistDocumentFromWorkspace(root: Json): Converted {
  const converter = new Converter();
  const playlistType = messageType("rv.data.Playlist");
  const itemType = messageType("rv.data.PlaylistItem");
  // `meta` is outside the kind's own data, so the generic pass never sees it.
  const identity = (node: TreeNode) => ({
    uuid: node.meta?.uuid ? { string: node.meta.uuid } : undefined,
    name: node.meta?.name,
  });

  const playlist = (node: TreeNode): Record<string, Json> => {
    const children = node.children ?? [];
    const own = { ...converter.message(playlistType, kindData(node)), ...identity(node) };
    if (kindOf(node) === "group") return { ...own, playlists: { playlists: playlists(children) } };
    const items = children
      .filter((child) => kindOf(child) === "item")
      .map((child) => ({ ...converter.message(itemType, kindData(child)), ...identity(child) }));
    return { ...own, items: { items } };
  };
  const playlists = (nodes: Json): Record<string, Json>[] =>
    (Array.isArray(nodes) ? (nodes as TreeNode[]) : [])
      .filter((node) => kindOf(node) === "group" || kindOf(node) === "playlist")
      .map(playlist);

  const { playlists: nodes, live_video_playlist_nodes: live, ...rest } = isObject(root) ? root : ({} as Record<string, Json>);
  const plain = converter.message(messageType("rv.data.PlaylistDocument"), rest);
  // A tree that does not start with one group gets a root made for it, since
  // everything that walks a document starts from `root_node`.
  const top = playlists(nodes);
  plain.root_node = top.length === 1 && top[0].playlists ? top[0] : { playlists: { playlists: top } };
  // The old document has room for one live-video playlist, and so far so does every workspace.
  const liveNodes = playlists(live);
  if (liveNodes.length > 0) plain.live_video_playlist = liveNodes[0];
  if (liveNodes.length > 1) converter.unmapped.add("rv.data.PlaylistDocument.live_video_playlist_nodes[1+]");
  return finish("rv.data.PlaylistDocument", converter, plain);
}

/** A theme, from the `root` of a `Theme` snapshot. Nothing in it changed shape. */
export function themeFromWorkspace(root: Json): Converted {
  return plainFromWorkspace("rv.data.Template.Document", root);
}

/** A message whose snapshot differs from it in none but the general ways. */
function plainFromWorkspace(typeName: string, root: Json): Converted {
  const converter = new Converter();
  return finish(typeName, converter, converter.message(messageType(typeName), root));
}

/** ProPresenter's configured groups, from the `root` of the `Groups` snapshot. */
export function groupsFromWorkspace(root: Json): Converted {
  return plainFromWorkspace("rv.data.ProGroupsDocument", root);
}

/**
 * ProPresenter's configured macros, from the `root` of the `Macros` snapshot.
 *
 * Each macro is held inside its collection, under the collection's `macros`,
 * where the old file listed them all at the top and had each collection name
 * its own by uuid. Both are fields of the message, so the conversion is the
 * general one; `readMacros()` in `configuration.ts` reads either shape.
 */
export function macrosFromWorkspace(root: Json): Converted {
  return plainFromWorkspace("rv.data.MacrosDocument", root);
}
