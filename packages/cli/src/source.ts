import fs from "node:fs/promises";
import path from "node:path";
import { openPresentation } from "@presenter-garage/core/lib/presentation";
import { findPresentations, LibraryError, openRoots, readFoundFile } from "@presenter-garage/node/library";
import { explain } from "@presenter-garage/node/presentations";
import { documentAt, isEdit, registeredWorkspaces, workspaceAt } from "@presenter-garage/node/workspace";
import { fileEdited, songOf, type Edited, type Song } from "./song";

/**
 * Where songs come from: a folder of `.pro` files, a ProPresenter 22
 * workspace, or `active`, the workspace ProPresenter has open. Each is read
 * through `packages/node`, the code the MCP server and the desktop app read
 * with, so a workspace is opened only by `openDatabase()` and never written.
 */

export interface SourceSpec {
  label: string;
  /** As given; `active` until it is resolved. */
  path: string;
}

/** `bas=private/machines/bas`, a bare path (labelled by its folder's name), or `active`. */
export function parseSource(arg: string): SourceSpec {
  const at = arg.indexOf("=");
  // A Windows drive letter is not a label: `C:\…` has no `=` anyway, and a
  // label must be a plain word so it can name a folder and a column.
  if (at > 0 && LABEL.test(arg.slice(0, at))) return { label: arg.slice(0, at), path: arg.slice(at + 1) };
  const label = arg === "active" ? "active" : path.basename(path.resolve(arg));
  if (!LABEL.test(label)) {
    throw new LibraryError(`Give ${arg} a label, as label=${arg}: a word of letters, digits, '-', '_' or '.'.`);
  }
  return { label, path: arg };
}

/** A label names a folder of text views and a column of the report, so it is a plain word that cannot climb out of one. */
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u;

export interface SongFailure {
  file: string;
  reason: string;
}

export interface Source {
  label: string;
  /** The folder read, resolved. */
  root: string;
  kind: "workspace" | "folder";
  songs: Song[];
  /** Files that would not read; reported, never fatal. */
  failures: SongFailure[];
  /** The walk stopped at its limit before reading everything. */
  truncated: boolean;
  /** For a workspace: when ProPresenter 22 made it, from the earliest change any document carries. */
  upgradedAt?: string;
  /** The folder of `.pro` files the workspace was made from, when edit dates before the upgrade came from it. */
  legacy?: string;
}

/** The root of the workspace ProPresenter 22 has open, or an error saying there is none. */
export async function activeWorkspace(registry?: string): Promise<string> {
  const active = (await registeredWorkspaces(registry)).find((w) => w.active);
  if (!active) throw new LibraryError("ProPresenter 22 has no active workspace on this computer.");
  return active.root;
}

export interface ReadOptions {
  /** The folder of `.pro` files a workspace was made from, for edit dates before the upgrade. */
  legacy?: string;
  /** Told each file as it is read, for a progress line. */
  progress?: (done: number, total: number) => void;
}

export async function readSource(spec: SourceSpec, options: ReadOptions = {}): Promise<Source> {
  const given = spec.path === "active" ? await activeWorkspace() : spec.path;
  const [root] = await openRoots([given]);
  const workspace = await workspaceAt(root);
  const { files, truncated } = await findPresentations([root]);
  const songs: Song[] = [];
  const failures: SongFailure[] = [];
  let upgradedAt: string | undefined;
  const undated: Song[] = [];

  for (const [i, file] of files.entries()) {
    options.progress?.(i, files.length);
    const relative = libraryPath(path.relative(root, file));
    try {
      const found = await readFoundFile(file);
      const opened = openPresentation(found.bytes);
      if (opened.problem) {
        failures.push({ file: relative, reason: explain(opened.problem, opened.detail) });
        continue;
      }
      let edited: Edited;
      if (workspace) {
        const stored = await documentAt(file);
        const history = stored ? await stored.workspace.history(stored.document) : [];
        for (const change of history) {
          const at = change.at?.toISOString();
          if (at && (!upgradedAt || at < upgradedAt)) upgradedAt = at;
        }
        const last = history.filter(isEdit).at(-1);
        edited = last ? { at: last.at!.toISOString(), source: "history", peer: last.peer } : { source: "none" };
      } else {
        edited = fileEdited(opened.raw, found.modified);
      }
      const song = songOf(relative, opened.raw, opened.doc, edited);
      songs.push(song);
      if (edited.source === "none") undated.push(song);
    } catch (e) {
      if (!(e instanceof LibraryError)) throw e;
      failures.push({ file: relative, reason: e.message });
    }
  }
  options.progress?.(files.length, files.length);

  const legacy = workspace ? (options.legacy ?? (await madeFrom(root))) : undefined;
  if (legacy && undated.length) await dateFromLegacy(undated, legacy);
  for (const song of undated) {
    if (song.edited.source === "none" && upgradedAt) song.edited.notAfter = upgradedAt;
  }

  return {
    label: spec.label,
    root,
    kind: workspace ? "workspace" : "folder",
    songs,
    failures,
    truncated,
    upgradedAt,
    legacy,
  };
}

/** A path inside a library, `Libraries/` left out and `/` between folders on every system. */
function libraryPath(relative: string): string {
  return relative.split(path.sep).join("/").replace(/^Libraries\//, "");
}

/**
 * The folder ProPresenter 22 made this workspace from, if its registry says
 * so and the folder is still on this computer. The registry is the one
 * beside the workspace, so a copy of the `Workspaces` folder brings its own;
 * a workspace is told from the others by its folder's name, which is its
 * uuid, because a copy's recorded root is the computer it came from.
 */
async function madeFrom(root: string): Promise<string | undefined> {
  const name = path.basename(root);
  const registered = await registeredWorkspaces(path.dirname(root));
  const from = registered.find((w) => w.root.split(/[\\/]/).filter(Boolean).at(-1) === name)?.copiedFrom;
  if (!from) return undefined;
  return (await fs.stat(from).catch(() => undefined))?.isDirectory() ? from : undefined;
}

/**
 * Date the songs nobody has edited since the upgrade by the `.pro` files the
 * workspace was made from. Matched by uuid, since the upgrade keeps it,
 * and by path where a file carries none.
 */
async function dateFromLegacy(songs: Song[], legacy: string): Promise<void> {
  const before = await readSource({ label: "legacy", path: legacy });
  const byId = new Map(before.songs.filter((s) => s.id).map((s) => [s.id!, s]));
  const byFile = new Map(before.songs.map((s) => [s.file.normalize("NFC").toLowerCase(), s]));
  for (const song of songs) {
    const old = (song.id && byId.get(song.id)) || byFile.get(song.file.normalize("NFC").toLowerCase());
    if (old?.edited.at) song.edited = { at: old.edited.at, source: "beforeUpgrade" };
  }
}

/** A source without its songs' words: what JSON an agent reads says about it. */
export function sourceMeta(source: Source) {
  const { songs, ...meta } = source;
  return { ...meta, songs: songs.length };
}
