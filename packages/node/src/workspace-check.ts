import fs from "node:fs/promises";
import path from "node:path";
import { LibraryError, WorkspaceRefused } from "./paths";
import { hasCloudImprint, openDatabase, REGISTRY, registryRoot, type Workspace } from "./workspace";

/**
 * Which ProPresenter 22 workspaces may be written to at all: the half of
 * guard 1 that is about the workspace rather than a document, a format this
 * was checked against. `workspace-write.ts` runs it before it reads a row,
 * at plan time and again at apply time.
 */

/** The formats this has been checked against: the registry's `schema_version`, and the store's `user_version`. */
export const VERIFIED_SCHEMA_VERSION = "22.9.0";
export const VERIFIED_USER_VERSION = 9;

export const unverified = (what: string) =>
  `This workspace's ${what}, which this has not been checked against, so it is not written to. ` +
  "Make the change in ProPresenter itself.";

interface RegistryRow {
  local_uuid: string;
  root_path: string;
  cloud_uuid: string | null;
  schema_version: unknown;
}

async function registryRows(registry: string): Promise<RegistryRow[]> {
  const db = await openDatabase(registry);
  try {
    return db.prepare("SELECT local_uuid, root_path, cloud_uuid, schema_version FROM workspaces").all() as unknown as RegistryRow[];
  } catch (e) {
    throw new LibraryError(`Could not read ${registry}: ${(e as Error).message}`);
  } finally {
    db.close();
  }
}

/**
 * Refuse a workspace whose format is not a version this was checked
 * against. Part of guard 1: the gate on a document means little if the
 * store around it is a format nobody has looked at. Says whether it is a
 * ProPresenter Cloud workspace, by its registry row or its `imprint.cloud`:
 * a Cloud document is written only once Cloud has confirmed every change
 * in it (`syncedWithCloud()` in `workspace-write.ts`), and the person is told
 * it is Cloud before they choose.
 *
 * The registry is the one in the folder above the workspace, where
 * ProPresenter keeps it, and the workspace's row is the one named by the
 * folder's own name, which is the workspace's uuid, or the one whose
 * `root_path` is the folder (`registryRoot()`, since ProPresenter writes it
 * with a trailing separator in some rows). Two different rows for one
 * folder are refused: which one holds its format is not known.
 */
export async function checkWritableWorkspace(workspace: Workspace): Promise<{ cloud: boolean }> {
  const root = workspace.root;
  const refuse = (what: string) => new WorkspaceRefused(unverified(what), "unverifiedWorkspace");
  const registry = path.join(path.dirname(root), REGISTRY);
  if (!(await fs.stat(registry).catch(() => undefined))?.isFile()) {
    throw refuse(`format version could not be read: there is no ${REGISTRY} beside it`);
  }
  const uuid = path.basename(root);
  const rows = (await registryRows(registry)).filter((row) => row.local_uuid === uuid || registryRoot(row.root_path) === root);
  if (rows.length === 0) throw refuse(`format version could not be read: ${REGISTRY} does not list it`);
  if (rows.length > 1) throw refuse(`format version could not be read: ${REGISTRY} lists it ${rows.length} times`);
  const [row] = rows;
  if (row.schema_version !== VERIFIED_SCHEMA_VERSION) throw refuse(`format is ${String(row.schema_version)}, not ${VERIFIED_SCHEMA_VERSION}`);
  return { cloud: row.cloud_uuid !== null || (await hasCloudImprint(root)) };
}
