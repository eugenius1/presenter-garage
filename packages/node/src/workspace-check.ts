import fs from "node:fs/promises";
import path from "node:path";
import { LibraryError, WorkspaceRefused } from "./paths";
import { hasCloudImprint, openDatabase, REGISTRY, registryRoot, workspacesDir, type Workspace } from "./workspace";

/**
 * Which ProPresenter 22 workspaces may be written to at all: the half of
 * guard 1 that is about the workspace rather than a document (a format this
 * was checked against, and not Cloud), and the one Cloud workspace a person
 * can name for #55's experiments. `workspace-write.ts` runs these before it
 * reads a row, at plan time and again at apply time.
 */

/** The formats this has been checked against: the registry's `schema_version`, and the store's `user_version`. */
export const VERIFIED_SCHEMA_VERSION = "22.9.0";
export const VERIFIED_USER_VERSION = 9;

export const CLOUD_REFUSED =
  "This is a ProPresenter Cloud workspace, which is not written to yet: what Cloud does with a change made " +
  "outside ProPresenter has been tried on one computer only (https://github.com/eugenius1/presenter-garage/issues/55). " +
  "Make the change in ProPresenter itself.";

export const unverified = (what: string) =>
  `This workspace's ${what}, which this has not been checked against, so it is not written to. ` +
  "Make the change in ProPresenter itself.";

/**
 * The one Cloud workspace this process may write to, for #55's experiments,
 * by its Cloud uuid (`cloud_uuid` in the registry).
 *
 * Its Cloud uuid and not its local one, since ProPresenter gives a Cloud
 * workspace a new `local_uuid`, and a new folder, each time it is
 * downloaded again, and keeps its `cloud_uuid`.
 *
 * Set once, by the person starting the MCP server (`--allow-cloud-workspace`),
 * before it serves anything: no tool takes it, and no environment variable
 * sets it, so a model cannot. Everything else about a write stays as it is:
 * guard 1's other checks, the backup, the person's choice, the read-back and
 * the exclusive lock.
 */
let allowedCloud: string | undefined;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Let the Cloud workspace with this Cloud uuid be written to, or none again.
 * Checks first that exactly one workspace in the registry has it, so a
 * mistyped uuid stops the server at start instead of doing nothing quietly.
 * Returns the workspace's name, to say which it is.
 */
export async function allowCloudWorkspace(
  cloudUuid: string | undefined,
  registry = path.join(workspacesDir(), REGISTRY)
): Promise<string | undefined> {
  if (cloudUuid === undefined) {
    allowedCloud = undefined;
    return undefined;
  }
  const option = `--allow-cloud-workspace=${cloudUuid}`;
  if (!UUID_SHAPE.test(cloudUuid)) throw new LibraryError(`--allow-cloud-workspace takes a Cloud workspace's uuid, not ${cloudUuid}`);
  if (!(await fs.stat(registry).catch(() => undefined))?.isFile()) {
    throw new LibraryError(`${option}: there is no ProPresenter 22 registry at ${registry}`);
  }
  const wanted = cloudUuid.toLowerCase();
  const rows = (await registryRows(registry)).filter((row) => row.cloud_uuid?.toLowerCase() === wanted);
  if (rows.length === 0) throw new LibraryError(`${option}: ${registry} lists no Cloud workspace with that uuid (its cloud_uuid)`);
  if (rows.length > 1) throw new LibraryError(`${option}: ${registry} lists ${rows.length} workspaces with that Cloud uuid, so which one is meant is not known`);
  allowedCloud = wanted;
  return String(rows[0].display_name);
}

/** The Cloud uuid `allowCloudWorkspace` named, if any. */
export const allowedCloudWorkspace = (): string | undefined => allowedCloud;

interface RegistryRow {
  local_uuid: string;
  root_path: string;
  display_name: unknown;
  cloud_uuid: string | null;
  schema_version: unknown;
}

async function registryRows(registry: string): Promise<RegistryRow[]> {
  const db = await openDatabase(registry);
  try {
    return db.prepare("SELECT local_uuid, root_path, display_name, cloud_uuid, schema_version FROM workspaces").all() as unknown as RegistryRow[];
  } catch (e) {
    throw new LibraryError(`Could not read ${registry}: ${(e as Error).message}`);
  } finally {
    db.close();
  }
}

/**
 * Refuse a workspace this cannot write to: one synced through ProPresenter
 * Cloud, unless it is the one `allowCloudWorkspace` named, or one whose
 * format is not a version this was checked against. Part of guard 1: the
 * gate on a document means little if the store around it is a format
 * nobody has looked at. Says whether the workspace is a Cloud one, so the
 * person can be told before they choose.
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
  const imprint = await hasCloudImprint(root);
  // Without the opt-in, refused before anything else is read, as before it.
  if (imprint && allowedCloud === undefined) throw new WorkspaceRefused(CLOUD_REFUSED, "cloudWorkspace");
  // With it, a workspace with an imprint is Cloud whatever else turns out to be wrong.
  const refuse = (what: string) =>
    imprint ? new WorkspaceRefused(CLOUD_REFUSED, "cloudWorkspace") : new WorkspaceRefused(unverified(what), "unverifiedWorkspace");
  const registry = path.join(path.dirname(root), REGISTRY);
  if (!(await fs.stat(registry).catch(() => undefined))?.isFile()) {
    throw refuse(`format version could not be read: there is no ${REGISTRY} beside it`);
  }
  const uuid = path.basename(root);
  const rows = (await registryRows(registry)).filter((row) => row.local_uuid === uuid || registryRoot(row.root_path) === root);
  if (rows.length === 0) throw refuse(`format version could not be read: ${REGISTRY} does not list it`);
  if (rows.length > 1) throw refuse(`format version could not be read: ${REGISTRY} lists it ${rows.length} times`);
  const [row] = rows;
  const cloud = imprint || row.cloud_uuid !== null;
  // The named one only, by its own row's Cloud uuid.
  const named = allowedCloud !== undefined && row.cloud_uuid?.toLowerCase() === allowedCloud;
  if (cloud && !named) throw new WorkspaceRefused(CLOUD_REFUSED, "cloudWorkspace");
  if (row.schema_version !== VERIFIED_SCHEMA_VERSION) {
    throw new WorkspaceRefused(unverified(`format is ${String(row.schema_version)}, not ${VERIFIED_SCHEMA_VERSION}`), "unverifiedWorkspace");
  }
  return { cloud };
}

