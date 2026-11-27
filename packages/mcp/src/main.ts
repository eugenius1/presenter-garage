import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LibraryError } from "@presenter-garage/node/library";
import { defaultLibrary, folderWorkspaces } from "@presenter-garage/node/workspace";
import { findRules, rulesSearchDirs } from "@presenter-garage/node/rules";
import { allowCloudWorkspace } from "@presenter-garage/node/workspace-write";
import { parseArgs } from "./args";
import { openLibrary, presentWorkspaces, type LibraryOptions, type OpenLibrary } from "./library";
import { createServer } from "./server";

/**
 * Start the server on stdio.
 *
 *   node packages/mcp/dist/presenter-garage-mcp.mjs [--read-only] [--backup-dir=<folder>]
 *     [--allow-cloud-workspace=<uuid>] [library folder]
 *
 * With no folder named it reads the workspace ProPresenter 22 has open, and
 * where there is none, `~/Documents/ProPresenter` or the one workspace
 * ProPresenter 20 or 21 made elsewhere. `defaultLibrary` has the order. A
 * client with roots names the library instead, when one of them is a
 * ProPresenter library: see `Library`.
 */

/**
 * The library read when none was named, or why there is none. Not a reason
 * to stop: the client's roots or `use_library` can still name one, and every
 * tool says why it cannot read until then.
 */
async function defaultStart(options: LibraryOptions): Promise<OpenLibrary | { problem: string }> {
  try {
    const documents = path.join(os.homedir(), "Documents", "ProPresenter");
    const dir = defaultLibrary({
      registered: await presentWorkspaces(),
      documents,
      documentsExists: await fs.stat(documents).then((s) => s.isDirectory(), () => false),
      folders: await folderWorkspaces(),
    });
    return await openLibrary(dir, "default", options);
  } catch (e) {
    if (!(e instanceof LibraryError)) throw e;
    return { problem: e.message };
  }
}

async function main() {
  const { folder, readOnly, backupDir, allowCloudWorkspace: cloud } = parseArgs(process.argv.slice(2));
  // Before anything is served, and only from the command line: a uuid that names no Cloud workspace stops the server.
  if (cloud !== undefined && !readOnly) {
    await allowCloudWorkspace(cloud);
    console.error(`presenter-garage MCP: the ProPresenter Cloud workspace ${cloud} may be written to, for #55's experiments`);
  }
  // The folder the server is started in is the one the agent works in, which is where a team keeps its rules.
  const rulesDirs = rulesSearchDirs();
  const options = { readOnly, backupDir, rulesDirs };
  // A folder named outright that cannot be read stops the server: the person who named it is told now.
  const start = folder !== undefined ? await openLibrary(folder, "configured", options) : await defaultStart(options);
  // stdout is the protocol channel; anything for a person goes to stderr.
  if ("root" in start) for (const note of start.notes) console.error(note);
  const rules = await findRules(undefined, rulesDirs);
  await createServer(start, { ...options, rules }).connect(new StdioServerTransport());
  console.error(
    "root" in start
      ? `presenter-garage MCP ${start.backupDir ? `reading and editing ${start.root}, backing up to ${start.backupDir}` : `reading ${start.root}`}`
      : `presenter-garage MCP with no library open yet: ${start.problem}`
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
