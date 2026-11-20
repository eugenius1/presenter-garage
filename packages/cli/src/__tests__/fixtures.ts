import fs from "node:fs";
import path from "node:path";
import { LoroDoc } from "loro-crdt/base64";
import { messageType } from "@presenter-garage/core/lib/decode";
import { workspacePresentation } from "@presenter-garage/core/lib/__tests__/workspace-fixtures";
import { createWorkspace, putDocument, sqlite } from "@presenter-garage/node/__tests__/workspace-db";
import { REGISTRY_SCHEMA } from "@presenter-garage/node/__tests__/workspace-writable";

/**
 * Songs built for the tests: a `.pro` file from a few lines of description,
 * a folder of them, and a ProPresenter 22 workspace holding them with a
 * change history, so nothing real is needed to run the suite.
 */

export { sqlite };

export interface SlideSpec {
  lines: string[];
  macros?: string[];
}

export interface SongSpec {
  name: string;
  /** The presentation's uuid; one is made up when absent. */
  uuid?: string;
  /** ISO 8601: the edit date the file records. */
  modified?: string;
  groups: { name: string; slides: (string[] | SlideSpec)[] }[];
}

let seed = 0;
const uuid = () => ({ string: `00000000-0000-4000-8000-${(++seed).toString(16).padStart(12, "0")}` });

/** RTF as ProPresenter writes it: every character past ASCII escaped. */
function rtf(lines: readonly string[]): Uint8Array {
  // By UTF-16 unit, each past ASCII as a signed \uN with its one fallback character.
  const escape = (text: string) =>
    Array.from({ length: text.length }, (_, k) => {
      const c = text[k];
      const u = text.charCodeAt(k);
      if (c === "\\" || c === "{" || c === "}") return `\\${c}`;
      return u < 128 ? c : `\\u${u > 32767 ? u - 65536 : u} ?`;
    }).join("");
  const header =
    "{\\rtf0\\ansi\\ansicpg1252{\\fonttbl\\f0\\fnil ArialMT;}{\\colortbl;\\red0\\green0\\blue0;}{\\*\\listtable}\\uc1\\pard\\f0\\fs100";
  const body = lines.map((line) => `\\cb3 ${escape(line)}`).join("\\par\\pard");
  return new TextEncoder().encode(`${header}${body}}`);
}

/** A `.pro` file holding the song. */
export function proFile(spec: SongSpec): Uint8Array {
  const cues: object[] = [];
  const groups = spec.groups.map((group) => {
    const ids = group.slides.map((slide) => {
      const { lines, macros = [] } = Array.isArray(slide) ? { lines: slide } : slide;
      const id = uuid();
      cues.push({
        uuid: id,
        name: "",
        isEnabled: true,
        actions: [
          {
            uuid: uuid(),
            type: "ACTION_TYPE_PRESENTATION_SLIDE",
            slide: {
              presentation: {
                base_slide: { uuid: uuid(), elements: [{ element: { uuid: uuid(), name: "Text", text: { rtf_data: rtf(lines) } } }] },
              },
            },
          },
          ...macros.map((name) => ({
            uuid: uuid(),
            name,
            isEnabled: true,
            type: "ACTION_TYPE_MACRO",
            macro: { identification: { parameter_uuid: uuid(), parameter_name: name } },
          })),
        ],
      });
      return id;
    });
    return { group: { uuid: uuid(), name: group.name }, cue_identifiers: ids };
  });
  const Presentation = messageType("rv.data.Presentation");
  return Presentation.encode(
    Presentation.fromObject({
      uuid: spec.uuid ? { string: spec.uuid } : uuid(),
      name: spec.name,
      cues,
      cue_groups: groups,
      ...(spec.modified ? { last_modified_date: { seconds: Math.floor(Date.parse(spec.modified) / 1000) } } : {}),
    })
  ).finish();
}

/** A folder of `.pro` files: `files` maps a path inside it, `Chants/Song.pro`, to a song. */
export function writeLibrary(dir: string, files: Record<string, SongSpec>): void {
  for (const [file, spec] of Object.entries(files)) {
    const full = path.join(dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, proFile(spec));
  }
}

export interface WorkspaceSong {
  spec: SongSpec;
  /** When a person last edited it after the upgrade, ISO 8601, and from which computer. */
  editedAt?: string;
  peer?: string;
}

/** The upgrade's own time in these workspaces, stamped on a migration change as ProPresenter does. */
export const UPGRADE = "2026-11-07T16:50:47.000Z";

/**
 * A snapshot with the history a real one has: the import with no time
 * (peer 1), a migration that names itself, and an edit if there was one.
 */
function snapshotWithHistory(root: Record<string, unknown>, editedAt?: string, peer = "1531970598674994332"): Uint8Array {
  const doc = new LoroDoc();
  doc.setPeerId(1);
  const map = doc.getMap("root");
  for (const [key, value] of Object.entries(root)) map.set(key, value as never);
  doc.commit();
  doc.setPeerId(77);
  map.set("value_array_migration_version", "2");
  doc.commit({ timestamp: Date.parse(UPGRADE) / 1000, message: "ProCore media identity migration" });
  if (editedAt) {
    doc.setPeerId(peer as `${number}`);
    map.set("notes", "edited");
    doc.commit({ timestamp: Date.parse(editedAt) / 1000 });
  }
  const bytes = doc.export({ mode: "snapshot" });
  doc.free();
  return bytes;
}

/** A ProPresenter 22 workspace holding the songs, each under `Libraries/<file>`. */
export function writeWorkspace(dir: string, songs: Record<string, WorkspaceSong>): void {
  createWorkspace(dir);
  for (const [file, song] of Object.entries(songs)) {
    const root = workspacePresentation(proFile(song.spec)) as Record<string, unknown>;
    putDocument(dir, "Presentation", file.replace(/\.pro$/, ""), snapshotWithHistory(root, song.editedAt, song.peer));
  }
}

/** ProPresenter 22's registry, beside the workspaces, naming `root` the active one, made from `copiedFrom`. */
export function writeRegistry(dir: string, root: string, copiedFrom?: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const db = new sqlite!.DatabaseSync(path.join(dir, "registry-v1.sqlite3"));
  db.exec(REGISTRY_SCHEMA);
  const id = "1ca74a0b-0000-4000-8000-000000000009";
  db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)").run(id, root, "ProPresenter", "cloud-1", "22.9.0", "available");
  db.prepare("INSERT INTO meta VALUES (?, ?)").run("active_local_uuid", id);
  if (copiedFrom) db.prepare("INSERT INTO meta VALUES (?, ?)").run(`copied_from:${id}`, copiedFrom);
  db.close();
}
