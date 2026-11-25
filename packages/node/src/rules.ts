import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decodeGroupsDocument, decodeMacrosDocument, readGroups, readMacros } from "@presenter-garage/core/lib/configuration";
import { DEFAULT_RULES, libraryOfSong, parseRules, RulesError, type RuleConfiguration, type RuleSet } from "@presenter-garage/core/lib/rules";
import { findGroups, findMacros, LibraryError, readLibraryFile } from "./library";
import { isInWorkspace } from "./workspace";
import { sha256 } from "./write";

/**
 * A team's `RULES.md`, and the `rules.json` an agent compiled from it.
 *
 * Found in the folder the agent or the command runs in, then in
 * `Documents/ProPresenter`. A path given outright wins. Read from anywhere,
 * but never written inside a ProPresenter 22 workspace: that folder is
 * ProPresenter's, and what its Cloud sync makes of a file it did not write
 * is not known.
 *
 * The only file written here is `rules.json`, beside the `RULES.md` it was
 * compiled from. It is not a ProPresenter file, so AGENTS.md's write guards
 * are not what protects it; what does is that it is written nowhere else, and
 * only once it parses.
 */

export const RULES_MD = "RULES.md";
export const RULES_JSON = "rules.json";

/** Where a team's rules are looked for when no path is given, in order. */
export function rulesSearchDirs(cwd = process.cwd(), home = os.homedir()): string[] {
  return [cwd, path.join(home, "Documents", "ProPresenter")];
}

export interface FoundRules {
  /** The prose, where there is one. */
  markdown?: string;
  /** The compiled rules, where they have been compiled. */
  json?: string;
}

/**
 * Whether a file is there. Only "not there" counts as no: a folder that
 * cannot be read is said, rather than quietly passed over for the next
 * place or the default checks, which would run rules nobody chose.
 */
async function exists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new LibraryError(`Could not look for rules at ${p}: ${(e as Error).message}`);
  }
}

async function inFolder(dir: string): Promise<FoundRules | undefined> {
  const markdown = path.join(dir, RULES_MD);
  const json = path.join(dir, RULES_JSON);
  const [hasMarkdown, hasJson] = await Promise.all([exists(markdown), exists(json)]);
  if (!hasMarkdown && !hasJson) return undefined;
  return { ...(hasMarkdown ? { markdown } : {}), ...(hasJson ? { json } : {}) };
}

/**
 * The rules to use: those at `given` (a `RULES.md`, a `rules.json` or a
 * folder holding either), or the first found in `dirs`. Nothing when none is
 * found and none was named; an error when one was named and is not there.
 */
export async function findRules(given?: string, dirs: readonly string[] = rulesSearchDirs()): Promise<FoundRules | undefined> {
  if (given !== undefined) {
    const resolved = path.resolve(given);
    const stat = await fs.stat(resolved).catch(() => undefined);
    if (stat?.isDirectory()) {
      const found = await inFolder(resolved);
      if (!found) throw new LibraryError(`No ${RULES_MD} or ${RULES_JSON} in ${given}.`);
      return found;
    }
    if (!stat?.isFile()) throw new LibraryError(`Rules file not found: ${given}`);
    const sibling = await inFolder(path.dirname(resolved));
    return resolved.toLowerCase().endsWith(".json")
      ? { json: resolved, ...(sibling?.markdown ? { markdown: sibling.markdown } : {}) }
      : { markdown: resolved, ...(sibling?.json ? { json: sibling.json } : {}) };
  }
  for (const dir of dirs) {
    const found = await inFolder(dir);
    if (found) return found;
  }
  return undefined;
}

export interface LoadedRules extends FoundRules {
  set: RuleSet;
  /** `RULES.md` has changed since `rules.json` was compiled from it, or was never recorded. */
  stale: boolean;
  /** There is no `rules.json` yet, so the default text checks stand in. */
  defaulted: boolean;
}

/**
 * Read the compiled rules. With none compiled yet, the default text checks
 * stand in, and `defaulted` says so: a `RULES.md` an agent has not compiled
 * is not a reason to check nothing.
 */
export async function loadRules(found: FoundRules | undefined): Promise<LoadedRules> {
  if (!found?.json) return { ...found, set: DEFAULT_RULES, stale: found?.markdown !== undefined, defaulted: true };
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(found.json, "utf8"));
  } catch (e) {
    throw new LibraryError(`${found.json} is not JSON: ${(e as Error).message}`);
  }
  let set: RuleSet;
  try {
    set = parseRules(value);
  } catch (e) {
    if (e instanceof RulesError) throw new LibraryError(`${found.json}: ${e.message}`);
    throw e;
  }
  const stale = found.markdown ? set.source?.sha256 !== (await markdownHash(found.markdown)) : false;
  return { ...found, set, stale, defaulted: false };
}

async function markdownHash(file: string): Promise<string> {
  return sha256(new Uint8Array(await fs.readFile(file)));
}

/**
 * Write `rules.json` beside `RULES.md`, stamped with the hash `RULES.md` has
 * now, once it parses. Written to a hidden file first and renamed over, so a
 * crash leaves the old rules or the new ones, never half of either.
 */
export async function saveRules(markdown: string, value: unknown, compiledFrom?: string): Promise<{ path: string; set: RuleSet }> {
  if (path.basename(markdown) !== RULES_MD || !(await exists(markdown))) {
    throw new LibraryError(`Rules are saved beside a ${RULES_MD}, and ${markdown} is not one.`);
  }
  if (await isInWorkspace(markdown)) throw new LibraryError(`${markdown} is inside a ProPresenter workspace, which rules.json is never written into.`);
  let set: RuleSet;
  try {
    set = parseRules(value);
  } catch (e) {
    if (e instanceof RulesError) throw new LibraryError(e.message);
    throw e;
  }
  // The hash is of the prose the rules were compiled from. When the caller
  // says which that was and it has changed since, the rules describe an older
  // file, and stamping today's hash on them would call them current.
  const sha256 = await markdownHash(markdown);
  if (compiledFrom !== undefined && compiledFrom !== sha256) {
    throw new LibraryError(`${markdown} has changed since it was read: read it again and compile the rules from what it says now. Nothing was written.`);
  }
  set = { ...set, source: { file: RULES_MD, sha256 } };
  const target = path.join(path.dirname(markdown), RULES_JSON);
  const temp = path.join(path.dirname(markdown), `.${RULES_JSON}.${randomBytes(6).toString("hex")}`);
  await fs.writeFile(temp, `${JSON.stringify(set, null, 2)}\n`, { flag: "wx" });
  try {
    await fs.rename(temp, target);
  } catch (e) {
    await fs.rm(temp, { force: true });
    throw e;
  }
  return { path: target, set };
}

/**
 * ProPresenter's configured groups and macros under `roots`, as far as they
 * can be read. A list that is missing is left out rather than failing the
 * check: `group-names` then says it had nothing to check against, and macros
 * are matched by the names the slides record.
 */
export async function rulesConfiguration(roots: readonly string[]): Promise<RuleConfiguration & { problems: string[] }> {
  const problems: string[] = [];
  const read = async <T>(find: (roots: readonly string[]) => Promise<string | undefined>, decode: (bytes: Uint8Array) => T[], what: string) => {
    const file = await find(roots);
    if (!file) {
      problems.push(`No configured ${what} found.`);
      return undefined;
    }
    try {
      return decode((await readLibraryFile(roots, file)).bytes);
    } catch (e) {
      problems.push(`The configured ${what} could not be read: ${(e as Error).message}`);
      return undefined;
    }
  };
  const [groups, macros] = await Promise.all([
    read(findGroups, (bytes) => readGroups(decodeGroupsDocument(bytes)), "groups"),
    read(findMacros, (bytes) => readMacros(decodeMacrosDocument(bytes)), "macros"),
  ]);
  // An empty list is no list to check names against, and the check then says nothing: said here, so that is not mistaken for a clean library.
  if (groups?.length === 0) problems.push("The configured group list is empty, so group names were not checked against it.");
  return { ...(groups ? { groups } : {}), ...(macros ? { macros } : {}), problems };
}

/**
 * The library a song is in. Where a `Libraries` folder holds it, whichever
 * folder was read, the one directly under `Libraries`: a song in
 * `Libraries/Songs/Advent` is in Songs read from the ProPresenter folder or
 * from `Songs` itself, so rules and exceptions kept to Songs cover the same
 * songs either way. Elsewhere, as `libraryOfSong` has it.
 */
export function libraryOf(root: string, file: string): string | undefined {
  const parts = path.resolve(file).split(path.sep);
  const at = parts.lastIndexOf("Libraries");
  if (at >= 0 && at < parts.length - 2) return parts[at + 1];
  return libraryOfSong(path.basename(root), path.relative(root, file).split(path.sep));
}
