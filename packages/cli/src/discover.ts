import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  folderWorkspaces,
  folderWorkspacesDir,
  registeredWorkspaces,
  workspacesDir,
  type RegisteredWorkspace,
} from "@presenter-garage/node/workspace";

/**
 * The ProPresenter libraries on this computer, found where ProPresenter keeps
 * them: the workspaces ProPresenter 22 has registered, the folder workspaces
 * ProPresenter 20 and 21 made, and `Documents/ProPresenter`, where every
 * version before 20 keeps its library.
 */

export interface Found {
  /** Where ProPresenter 22's registry is looked for. */
  registry: string;
  workspaces: (RegisteredWorkspace & { present: boolean })[];
  /** ProPresenter 20 and 21's workspaces, each a folder of `.pro` files. */
  folders: string[];
  /** `Documents/ProPresenter`, if it is there. */
  documents?: string;
  /** The root of the workspace ProPresenter 22 opens, if there is one. */
  active?: string;
}

const isDir = (p: string) => fs.stat(p).then((s) => s.isDirectory(), () => false);

export async function discover(
  dirs: { workspaces?: string; folders?: string; documents?: string } = {}
): Promise<Found> {
  const registry = dirs.workspaces ?? workspacesDir();
  const registered = await registeredWorkspaces(registry);
  const workspaces = await Promise.all(registered.map(async (w) => ({ ...w, present: await isDir(w.root) })));
  const documents = dirs.documents ?? path.join(os.homedir(), "Documents", "ProPresenter");
  return {
    registry,
    workspaces,
    folders: await folderWorkspaces(dirs.folders ?? folderWorkspacesDir()),
    documents: (await isDir(documents)) ? documents : undefined,
    active: registered.find((w) => w.active)?.root,
  };
}

export function foundText(found: Found): string {
  const out: string[] = [];
  out.push(`ProPresenter 22 workspaces (${found.registry}):`);
  if (found.workspaces.length === 0) out.push("  none");
  for (const w of found.workspaces) {
    const notes = [w.cloud ? "Cloud" : "local", `schema ${w.schemaVersion}`, w.active ? "active" : "", w.present ? "" : "missing"];
    out.push(`  ${w.active ? "*" : " "} ${w.name}: ${w.root} (${notes.filter(Boolean).join(", ")})`);
    if (w.copiedFrom) out.push(`      made from ${w.copiedFrom}`);
  }
  out.push("ProPresenter 20 and 21 workspaces:");
  out.push(...(found.folders.length ? found.folders.map((f) => `    ${f}`) : ["  none"]));
  out.push(`Documents/ProPresenter: ${found.documents ?? "none"}`);
  out.push(found.active ? `Active: ${found.active} (use it as the source "active")` : "Active: none");
  return out.join("\n");
}
