import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditLibrary } from "@presenter-garage/core/lib/audit";
import { checkFidelity, DecodeError, enumLabel } from "@presenter-garage/core/lib/decode";
import { loadMediaBytes } from "@presenter-garage/core/lib/loadFile";
import {
  applicationInfo,
  itemLabel,
  itemPath,
  LOCAL_ROOT,
  rawChildren,
  rawItems,
  type MediaItem,
} from "@presenter-garage/core/lib/model";
import { decodePlaylistsDocument } from "@presenter-garage/core/lib/playlists";
import { findMediaBin, findPlaylists, LibraryError, readLibraryFile } from "@presenter-garage/node/library";
import { fidelityOf } from "./fidelity";

/**
 * ProPresenter's playlists: the media bin (`read_media_bin`,
 * `audit_media_bin`) and the presentation playlists (`read_playlists`).
 */

/**
 * A playlist document of the show folder, found where ProPresenter keeps it
 * unless the caller names one, and decoded.
 *
 * `bytes` is handed back as well, for the fidelity check that is made on the
 * file as it was read, and `target`, the path before symlinks were resolved.
 */
async function loadPlaylistFile<T>(
  roots: readonly string[],
  file: string | undefined,
  find: (roots: readonly string[]) => Promise<string | undefined>,
  missing: string,
  what: string,
  decode: (name: string, bytes: Uint8Array) => T
) {
  const target = file ?? (await find(roots));
  if (!target) throw new LibraryError(missing);
  const { path: real, bytes, converted } = await readLibraryFile(roots, target);
  try {
    return { path: real, target, bytes, converted, decoded: decode(path.basename(real), bytes) };
  } catch (e) {
    if (e instanceof DecodeError) {
      throw new LibraryError(`${target}: not ${what} (${e.code}).`);
    }
    throw e;
  }
}

async function loadMediaBin(roots: readonly string[], file: string | undefined) {
  const { path: real, converted, decoded } = await loadPlaylistFile(
    roots,
    file,
    findMediaBin,
    "No media bin found. Pass the path of the `Media` file inside ProPresenter's `Playlists` folder.",
    "a ProPresenter media bin",
    loadMediaBytes
  );
  return { path: real, converted, loaded: decoded };
}

function compactItem(item: MediaItem) {
  return {
    name: itemLabel(item),
    file: itemPath(item),
    kind: item.kind,
    hidden: item.hidden || undefined,
    modifications: item.modifications.descriptors.length ? item.modifications.descriptors : undefined,
  };
}

export async function readMediaBin(roots: readonly string[], file?: string) {
  const { path: real, converted, loaded } = await loadMediaBin(roots, file);
  const { library } = loaded;
  return {
    path: real,
    appVersion: library.appVersion,
    platform: library.platform,
    fidelity: fidelityOf(converted, loaded.fidelity),
    itemCount: library.items.length,
    playlists: library.playlists.map((playlist) => ({
      path: playlist.path,
      items: playlist.items.map(compactItem),
    })),
  };
}

/**
 * The Media Bin tool's audit, with each item cut down to what identifies it.
 *
 * The full `MediaItem` carries playback settings, fingerprints and both paths;
 * a model asking "what is duplicated" needs the name, the file and where it is.
 */
export async function auditMediaBin(roots: readonly string[], file?: string) {
  const { path: real, loaded } = await loadMediaBin(roots, file);
  const audit = auditLibrary(loaded.library);
  const located = (item: MediaItem) => ({ ...compactItem(item), playlist: item.playlistPath });

  return {
    path: real,
    totals: audit.totals,
    withinPlaylistDuplicates: audit.withinPlaylistDuplicates.map((g) => ({
      file: g.filename,
      copies: g.items.length,
      repeatedWithin: g.repeatedWithin,
      labels: g.labels,
    })),
    crossPlaylistDuplicates: audit.crossPlaylistDuplicates.map((g) => ({
      file: g.filename,
      copies: g.items.length,
      playlists: g.playlists,
      layoutDiffers: g.layoutDiffers || undefined,
    })),
    variantGroups: audit.variantGroups,
    emptyPlaylists: audit.emptyPlaylists,
    externalVolumeItems: audit.externalVolumeItems.map(located),
    absolutePathRoots: audit.absolutePathRoots,
    hiddenItems: audit.hiddenItems.map(located),
    nameMismatches: audit.nameMismatches.map((m) => ({ ...located(m.item), filename: m.filename })),
  };
}

/** One entry of a presentation playlist, cut down to what says what it plays. */
export interface PlaylistEntry {
  kind: "presentation" | "header" | "media" | "cue" | "placeholder" | "planningCenter" | "other";
  name: string;
  /** Absolute where the entry says where it is; else as stored. */
  file?: string;
  /** The arrangement a presentation entry plays, when it names one. */
  arrangement?: string;
}

/**
 * The path a URL's `absolute_string` names: a Mac's file URL decoded, a
 * Windows path as it is. Nothing for a URL that does not parse, so the
 * stored relative path is used instead.
 */
function absolutePathOf(url: any): string | undefined {
  const absolute: string | undefined = url?.absolute_string || undefined;
  if (!absolute?.startsWith("file:")) return absolute;
  try {
    return fileURLToPath(absolute);
  } catch {
    return undefined;
  }
}

/**
 * One entry, its file made a path `read_presentation` can open.
 *
 * A path relative to the show folder is joined to it when that folder is
 * known. Any other entry, or one read from a playlists file whose show folder
 * is not, gives the absolute path ProPresenter recorded beside it: a path
 * relative to Documents, say, would otherwise be looked up under the library
 * folders and miss, or find another file of the same name.
 */
function playlistEntry(item: any, showFolder: string | undefined): PlaylistEntry {
  const name: string = item.name ?? "";
  const fileOf = (url: any): string | undefined => {
    const local = url?.local;
    if (showFolder && local?.path && enumLabel(LOCAL_ROOT, local.root) === "SHOW") {
      return path.join(showFolder, local.path);
    }
    return absolutePathOf(url) ?? (local?.path || undefined);
  };
  if (item.presentation) {
    return {
      kind: "presentation",
      name,
      file: fileOf(item.presentation.document_path),
      arrangement: item.presentation.arrangement_name || undefined,
    };
  }
  if (item.header) return { kind: "header", name };
  if (item.cue) {
    const url = item.cue.actions?.find((a: any) => a.media)?.media?.element?.url;
    return url ? { kind: "media", name, file: fileOf(url) } : { kind: "cue", name };
  }
  if (item.placeholder) return { kind: "placeholder", name };
  if (item.planning_center) return { kind: "planningCenter", name };
  return { kind: "other", name };
}

/** Every playlist under `node`, folders flattened into ` / ` paths as the media bin's are. */
function playlistTree(
  node: any,
  showFolder: string | undefined,
  ancestry: string[],
  out: { path: string; items: PlaylistEntry[] }[]
) {
  for (const child of rawChildren(node)) {
    const trail = [...ancestry, child.name ?? ""];
    // A folder holds playlists, not entries; an empty playlist is still listed.
    if (rawChildren(child).length === 0 || rawItems(child).length > 0) {
      out.push({ path: trail.join(" / "), items: rawItems(child).map((item) => playlistEntry(item, showFolder)) });
    }
    playlistTree(child, showFolder, trail, out);
  }
  return out;
}

/**
 * ProPresenter's presentation playlists: the services built from songs,
 * headers and media, as opposed to the media bin.
 *
 * ProPresenter stores a presentation entry's file relative to its own folder,
 * the one holding `Playlists/Library`. That is resolved here, so `file` can be
 * handed straight back to `read_presentation` wherever the server was pointed:
 * at the ProPresenter folder, or at the folder above it.
 *
 * The show folder is known when the file was found where ProPresenter keeps
 * it, or a file the caller named sits in a `Playlists` folder. A copy kept
 * anywhere else says nothing about where the show folder is, and its entries
 * give the absolute paths ProPresenter recorded instead.
 */
export async function readPlaylists(roots: readonly string[], file?: string) {
  const { path: real, target, bytes, converted, decoded } = await loadPlaylistFile(
    roots,
    file,
    findPlaylists,
    "No presentation playlists found. Pass the path of the `Library` file inside ProPresenter's `Playlists` folder.",
    "ProPresenter's presentation playlists",
    (_name, bytes) => decodePlaylistsDocument(bytes)
  );
  // Found, `target` is `<show folder>/Playlists/Library` as built from a root.
  const showFolder =
    file === undefined
      ? path.dirname(path.dirname(target))
      : path.basename(path.dirname(real)) === "Playlists"
        ? path.dirname(path.dirname(real))
        : undefined;
  return {
    path: real,
    ...applicationInfo(decoded.application_info),
    fidelity: fidelityOf(converted, checkFidelity(bytes).fidelity),
    playlists: playlistTree(decoded.root_node, showFolder, [], []),
  };
}
