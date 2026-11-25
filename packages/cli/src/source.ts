import fs from "node:fs/promises";
import path from "node:path";
import { openPresentation } from "@presenter-garage/core/lib/presentation";
import { findPresentations, LibraryError, openRoots, readFoundFile } from "@presenter-garage/node/library";
import { explain } from "@presenter-garage/node/presentations";
import { documentAt, isEdit, registeredWorkspaces, workspaceAt } from "@presenter-garage/node/workspace";
import { unknownMacros, type RuleSet } from "@presenter-garage/core/lib/rules";
import { libraryOf, rulesConfiguration } from "@presenter-garage/node/rules";
import { fileEdited, nameKey, songOf, type Edited, type Song, type SongRules } from "./song";

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
  /** What kept the rules from being checked in full here: a configured list that could not be read. */
  ruleNotes: string[];
}

/** Rules naming a macro ProPresenter's list lacks: the whole read's problem, not one song's. */
class MacrosUnknown extends LibraryError {}

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
  /** The rules to check each song against; the default text checks when absent. */
  rules?: RuleSet;
}

export async function readSource(spec: SourceSpec, options: ReadOptions = {}): Promise<Source> {
  const given = spec.path === "active" ? await activeWorkspace() : spec.path;
  const [root] = await openRoots([given]);
  const workspace = await workspaceAt(root);
  const { files, truncated } = await findPresentations([root]);
  const { problems: ruleNotes, ...config } = options.rules ? await rulesConfiguration([root]) : { problems: [] };
  // A macro name the list does not hold would make its rule find nothing, or
  // everything; asked of each song's library once a song there opens, since a
  // rule kept to one library needs its macros only where it runs, and a file
  // that will not open is reported like any other rather than stopping the rest.
  const askedLibraries = new Set<string | undefined>();
  const askMacros = (library: string | undefined) => {
    if (!options.rules || askedLibraries.has(library)) return;
    askedLibraries.add(library);
    const unknown = unknownMacros(options.rules, config, { library });
    if (unknown.length) {
      throw new MacrosUnknown(`${spec.label}: the rules name macros ProPresenter's list does not have: ${unknown.join(", ")}`);
    }
  };
  const songs: Song[] = [];
  const failures: SongFailure[] = [];
  let upgradedAt: string | undefined;
  const undated: Song[] = [];
  const paths = files.map((file) => path.relative(root, file).split(path.sep).join("/"));
  // `Libraries/` is left out only where every song is under it, as in a
  // ProPresenter folder or workspace, so no two songs can end up one path.
  const strip = paths.length > 0 && paths.every((p) => p.startsWith("Libraries/"));

  for (const [i, file] of files.entries()) {
    options.progress?.(i, files.length);
    const relative = strip ? paths[i].slice("Libraries/".length) : paths[i];
    try {
      // In a workspace the song and its history come from one read of its snapshot.
      const stored = workspace ? await documentAt(file) : undefined;
      const found = stored ? await stored.workspace.readWithHistory(stored.document) : { ...(await readFoundFile(file)), history: [] };
      const opened = openPresentation(found.bytes);
      if (opened.problem) {
        failures.push({ file: relative, reason: explain(opened.problem, opened.detail) });
        continue;
      }
      let edited: Edited;
      if (workspace) {
        const { history } = found;
        for (const change of history) {
          const at = change.at?.toISOString();
          if (at && (!upgradedAt || at < upgradedAt)) upgradedAt = at;
        }
        const last = history.filter(isEdit).at(-1);
        edited = last ? { at: last.at!.toISOString(), source: "history", peer: last.peer } : { source: "none" };
      } else {
        edited = fileEdited(opened.raw, found.modified);
      }
      const library = libraryOf(root, file);
      askMacros(library);
      const rules: SongRules | undefined = options.rules && { set: options.rules, config, library };
      const song = songOf(relative, opened.raw, opened.doc, edited, rules);
      songs.push(song);
      if (edited.source === "none") undated.push(song);
    } catch (e) {
      // Rules that name a macro the list lacks are wrong for every song, not one: the whole read stops.
      if (!(e instanceof LibraryError) || e instanceof MacrosUnknown) throw e;
      failures.push({ file: relative, reason: e.message });
    }
  }
  options.progress?.(files.length, files.length);

  const legacy = workspace ? (options.legacy ?? (await madeFrom(root))) : undefined;
  if (legacy && undated.length) await dateFromLegacy(undated, legacy, upgradedAt);
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
    ruleNotes,
  };
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
 * workspace was made from.
 */
async function dateFromLegacy(songs: Song[], legacy: string, upgradedAt?: string): Promise<void> {
  const match = legacyMatcher((await readSource({ label: "legacy", path: legacy })).songs);
  for (const song of songs) {
    const at = match(song)?.edited.at;
    if (at && (!upgradedAt || at <= upgradedAt)) song.edited = { at, source: "beforeUpgrade" };
  }
}

/**
 * Finds the file a workspace song was made from, or nothing where that is
 * not certain. Matched by uuid, since the upgrade keeps it, and by path only
 * where one side carries none: two songs whose uuids differ are not one song,
 * wherever they sit. Copies made in ProPresenter share a uuid, so among
 * several the one at the same path is the song, or else the only one of the
 * same name. A path is the same as the file system would have it, case and
 * accent composition aside, and the exact spelling decides only where a
 * case-sensitive one holds two such files.
 */
export function legacyMatcher(before: readonly Song[]): (song: Song) => Song | undefined {
  const key = (file: string) => file.normalize("NFC").toLowerCase();
  const byId = new Map<string, Song[]>();
  const byKey = new Map<string, Song[]>();
  for (const s of before) {
    if (s.id) byId.set(s.id, [...(byId.get(s.id) ?? []), s]);
    byKey.set(key(s.file), [...(byKey.get(key(s.file)) ?? []), s]);
  }
  return (song) => {
    const near = byKey.get(key(song.file)) ?? [];
    const atPath = near.find((s) => s.file.normalize("NFC") === song.file.normalize("NFC")) ?? only(near);
    const sharing = (song.id && byId.get(song.id)) || [];
    if (sharing.length === 1) return sharing[0];
    if (sharing.length > 1) {
      return (atPath && sharing.includes(atPath) ? atPath : undefined) ?? only(sharing.filter((s) => nameKey(s.name) === nameKey(song.name)));
    }
    return song.id && atPath?.id ? undefined : atPath;
  };
}

/** A source without its songs' words: what JSON an agent reads says about it. */
export function sourceMeta(source: Source) {
  const { songs, ...meta } = source;
  return { ...meta, songs: songs.length };
}

const only = <T>(list: readonly T[]): T | undefined => (list.length === 1 ? list[0] : undefined);
