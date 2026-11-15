import os from "node:os";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openRoots } from "@presenter-garage/node/library";
import { isInWorkspace, registeredWorkspaces, type RegisteredWorkspace } from "@presenter-garage/node/workspace";
import { defaultBackupDir, openBackupDir } from "@presenter-garage/node/write";
import { parseArgs } from "./args";
import { createServer } from "./server";

/**
 * Start the server on stdio.
 *
 *   node packages/mcp/dist/presenter-garage-mcp.mjs [--read-only] [--backup-dir=<folder>] [library folder...]
 *
 * With no folder named it reads the workspace ProPresenter 22 has open, and
 * where there is none, `~/Documents/ProPresenter`, the folder every version
 * before 22 keeps its libraries and playlists in on both macOS and Windows.
 */

/**
 * What to say about a folder ProPresenter 22 made a workspace from.
 *
 * The upgrade copies the folder and never touches it again, so it goes on
 * reading perfectly as the library of the day of the upgrade. Nothing in the
 * folder says so; only the registry does.
 */
function staleNotes(roots: readonly string[], workspaces: readonly RegisteredWorkspace[]): string[] {
  return workspaces
    .filter((w) => w.copiedFrom && roots.includes(path.resolve(w.copiedFrom)) && !roots.includes(w.root))
    .map(
      (w) =>
        `${w.copiedFrom} is the folder ProPresenter 22 made the workspace "${w.name}" from. ` +
        `ProPresenter no longer reads or updates it, so it shows the library as it was before the upgrade. ` +
        `The current one is ${w.root}.`
    );
}

async function main() {
  const { folders, readOnly, backupDir } = parseArgs(process.argv.slice(2));
  const workspaces = await registeredWorkspaces();
  const active = workspaces.find((w) => w.active);
  const dirs =
    folders.length > 0 ? folders : [active?.root ?? path.join(os.homedir(), "Documents", "ProPresenter")];
  const roots = await openRoots(dirs);
  const notes = staleNotes(roots, workspaces);
  for (const note of notes) console.error(note);
  // Checked now, so a backup folder inside a library is refused at start-up
  // rather than after a person has read and approved every line. A backup
  // folder that cannot be used turns editing off rather than reading: no
  // backup, no write, but nothing stops a model reading the library.
  // stdout is the protocol channel; anything for a person goes to stderr.
  let backups: string | undefined;
  // One workspace among the roots turns editing off for all of them: the
  // tools are offered or not as a set, and a set that fails on some paths is
  // worse than one that is plainly absent.
  let hasWorkspace = false;
  for (const root of roots) hasWorkspace ||= await isInWorkspace(root);
  if (hasWorkspace) console.error("Editing is off: a ProPresenter 22 workspace is read-only here.");
  if (!readOnly && !hasWorkspace) {
    try {
      backups = await openBackupDir(backupDir ?? defaultBackupDir(), roots);
    } catch (e) {
      console.error(`Editing is off: ${e instanceof Error ? e.message : e}`);
    }
  }
  const editing = backups !== undefined;
  await createServer(roots, { readOnly: !editing, backupDir: backups, notes }).connect(new StdioServerTransport());
  console.error(
    `presenter-garage MCP ${editing ? `reading and editing ${roots.join(", ")}, backing up to ${backups}` : `reading ${roots.join(", ")}`}`
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
