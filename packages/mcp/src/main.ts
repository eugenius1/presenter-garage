import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openRoots } from "@presenter-garage/node/library";
import {
  defaultLibrary,
  folderWorkspaces,
  registeredWorkspaces,
  staleNotes,
} from "@presenter-garage/node/workspace";
import { defaultBackupDir, openBackupDir } from "@presenter-garage/node/write";
import { findRules, rulesSearchDirs } from "@presenter-garage/node/rules";
import { parseArgs } from "./args";
import { createServer } from "./server";

/**
 * Start the server on stdio.
 *
 *   node packages/mcp/dist/presenter-garage-mcp.mjs [--read-only] [--backup-dir=<folder>] [library folder...]
 *
 * With no folder named it reads the workspace ProPresenter 22 has open, and
 * where there is none, `~/Documents/ProPresenter` or the one workspace
 * ProPresenter 20 or 21 made elsewhere. `defaultLibrary` has the order.
 */

async function main() {
  const { folders, readOnly, backupDir } = parseArgs(process.argv.slice(2));
  const isFolder = (dir: string) => fs.stat(dir).then((s) => s.isDirectory(), () => false);
  // Only the ones that are here: the registry also keeps a workspace whose
  // folder has gone, and a default that does not exist reads nothing.
  const registered = await registeredWorkspaces();
  const here = await Promise.all(registered.map((w) => isFolder(w.root)));
  const workspaces = registered.filter((_, i) => here[i]);
  const documents = path.join(os.homedir(), "Documents", "ProPresenter");
  const dirs =
    folders.length > 0
      ? folders
      : [
          defaultLibrary({
            registered: workspaces,
            documents,
            documentsExists: await isFolder(documents),
            folders: await folderWorkspaces(),
          }),
        ];
  const roots = await openRoots(dirs);
  const notes = staleNotes(roots, workspaces);
  for (const note of notes) console.error(note);
  // Checked now, so a backup folder inside a library is refused at start-up
  // rather than after a person has read and approved every line. A backup
  // folder that cannot be used turns editing off rather than reading: no
  // backup, no write, but nothing stops a model reading the library.
  // stdout is the protocol channel; anything for a person goes to stderr.
  let backups: string | undefined;
  if (!readOnly) {
    try {
      backups = await openBackupDir(backupDir ?? defaultBackupDir(), roots);
    } catch (e) {
      console.error(`Editing is off: ${e instanceof Error ? e.message : e}`);
    }
  }
  const editing = backups !== undefined;
  // The folder the server is started in is the one the agent works in, which is where a team keeps its rules.
  const rulesDirs = rulesSearchDirs();
  const rules = await findRules(undefined, rulesDirs);
  await createServer(roots, { readOnly: !editing, backupDir: backups, notes, rulesDirs, rules }).connect(new StdioServerTransport());
  console.error(
    `presenter-garage MCP ${editing ? `reading and editing ${roots.join(", ")}, backing up to ${backups}` : `reading ${roots.join(", ")}`}`
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
