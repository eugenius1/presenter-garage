import type protobuf from "protobufjs";
import { decodeAnyDocument, messageType, type RawDoc } from "../decode";
import { rawChildren, rawItems } from "../model";
import { decodePresentation } from "../presentation";

/**
 * Documents in the shape a ProPresenter 22 workspace stores them, made from
 * the synthetic files the rest of the suite already uses.
 *
 * A real workspace is somebody's library and is never committed, so the
 * fixtures are built by running the conversion backwards: each difference
 * `workspace.ts` undoes is applied here to a message of the old format. That
 * alone would only prove the two agree with each other, so
 * `workspace.test.ts` also holds documents written out by hand from what a
 * real workspace was seen to contain, and the comparison against a real
 * library is in `packages/node`, skipped where there is none.
 */

type Json = any;

/** Bare lower-case strings, as the new format stores every UUID. */
const bare = (uuid: Json): string | null => (uuid?.string ? String(uuid.string).toLowerCase() : null);

function toWorkspace(type: protobuf.Type, message: Json): Json {
  const out: Record<string, Json> = {};
  const inOneof = new Set<string>();
  for (const oneof of type.oneofsArray) {
    const chosen = oneof.fieldsArray.find((f) => message[f.name] !== undefined && message[f.name] !== null);
    oneof.fieldsArray.forEach((f) => inOneof.add(f.name));
    out[oneof.name] = chosen ? { __tag: chosen.name, [chosen.name]: valueOf(chosen, message[chosen.name]) } : { __tag: null };
  }
  for (const field of type.fieldsArray) {
    if (inOneof.has(field.name)) continue;
    const v = message[field.name];
    if (field.repeated) out[field.name] = (v ?? []).map((x: Json) => valueOf(field, x));
    else out[field.name] = v === undefined || v === null ? null : valueOf(field, v);
  }
  return out;
}

function valueOf(field: protobuf.Field, v: Json): Json {
  field.resolve();
  const resolved = field.resolvedType;
  if (!resolved || !("fields" in resolved)) return v;
  if (resolved.fullName === ".rv.data.UUID") return bare(v);
  return toWorkspace(resolved as protobuf.Type, v);
}

/**
 * A node of a playlist tree as a snapshot holds one, written out by hand:
 * `kind` is `group`, `playlist` or `item`, and `data` what that kind carries.
 */
export const treeNode = (kind: string, name: string, data: unknown, children: unknown[] = []) => ({
  id: `${name}@1`,
  parent: null,
  index: 0,
  fractional_index: "80",
  meta: { uuid: `u-${name}`, name, Kind: { __tag: kind, [kind]: data } },
  children,
});

/** A file's URL as a snapshot holds one, relative to the workspace (`root: 10` is `ROOT_SHOW`). */
export const localUrl = (file: string, absolute = `file:///ws/${file}`) => ({
  platform: 1,
  Storage: { __tag: "absolute_string", absolute_string: absolute },
  RelativeFilePath: { __tag: "local", local: { root: 10, path: file } },
});

let nextId = 0;
const node = (parent: string | null, index: number, meta: Json, children: (id: string) => Json[]) => {
  const id = `${nextId++}@1`;
  return { id, parent, index, fractional_index: "80", meta, children: children(id) };
};

/** The `root` of a `Presentation` snapshot holding what `bytes`, a `.pro` file, holds. */
export function workspacePresentation(bytes: Uint8Array): Json {
  const message = decodePresentation(bytes) as RawDoc;
  const Presentation = messageType("rv.data.Presentation");
  const Cue = messageType("rv.data.Cue");
  const Group = messageType("rv.data.Group");
  const { cues: _cues, cue_groups: _groups, ...root } = toWorkspace(Presentation, message);

  // Stored keyed by uuid and in no order: the order is the placements' alone.
  const cues: Record<string, Json> = {};
  for (const cue of [...(message.cues ?? [])].reverse()) cues[bare(cue.uuid)!] = toWorkspace(Cue, cue);

  const placements = (message.cue_groups ?? []).map((g: Json, i: number) => {
    const { uuid, ...group } = toWorkspace(Group, g.group ?? {});
    return node(null, i, { uuid, Kind: { __tag: "group", group } }, (id) =>
      (g.cue_identifiers ?? []).map((cue: Json, j: number) =>
        node(id, j, { uuid: bare(cue), Kind: { __tag: "cue", cue: {} } }, () => [])
      )
    );
  });
  return { ...root, cues, cue_group_placements: placements, value_array_migration_version: "1" };
}

/** The `root` of a playlist snapshot holding what `bytes`, a `Playlists/Library` or `Playlists/Media` file, holds. */
export function workspacePlaylists(bytes: Uint8Array): Json {
  const message = decodeAnyDocument(bytes);
  const Playlist = messageType("rv.data.Playlist");
  const Item = messageType("rv.data.PlaylistItem");

  const playlist = (p: Json, parent: string | null, index: number): Json => {
    const { uuid, name, ...rest } = toWorkspace(Playlist, p);
    const isGroup = rawChildren(p).length > 0 || !p.items;
    const { ChildrenType: _children, ...own } = rest;
    return node(parent, index, { uuid, name, Kind: { __tag: isGroup ? "group" : "playlist", [isGroup ? "group" : "playlist"]: own } }, (id) =>
      isGroup
        ? rawChildren(p).map((child: Json, i: number) => playlist(child, id, i))
        : rawItems(p).map((item: Json, i: number) => {
            const { uuid: itemUuid, name: itemName, ...kind } = toWorkspace(Item, item);
            return node(id, i, { uuid: itemUuid, name: itemName, Kind: { __tag: "item", item: kind } }, () => []);
          })
    );
  };
  return {
    type: message.type,
    playlists: [playlist(message.root_node, null, 0)],
    live_video_playlist_nodes: [],
  };
}

/** The `root` of a snapshot holding `message`, for a document that changed in none but the general ways. */
export function workspaceDocument(typeName: string, message: Json): Json {
  return toWorkspace(messageType(typeName), message);
}
