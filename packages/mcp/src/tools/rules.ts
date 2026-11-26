import path from "node:path";
import fs from "node:fs/promises";
import { createI18n, type Lang } from "@presenter-garage/core/i18n/core";
import { describeFinding } from "@presenter-garage/core/i18n/rules";
import { isPresentationFile } from "@presenter-garage/core/lib/folder";
import { type Fidelity } from "@presenter-garage/core/lib/decode";
import { checkPresentationFidelity, openPresentation } from "@presenter-garage/core/lib/presentation";
import {
  CHECK_GUIDE,
  checkRules,
  parseRules,
  RulesError,
  unknownMacros,
  type Finding,
  type RuleSet,
} from "@presenter-garage/core/lib/rules";
import {
  findPresentations,
  isFile,
  LibraryError,
  readFoundFile,
  resolveInRoots,
} from "@presenter-garage/node/library";
import { explain, presentationName } from "@presenter-garage/node/presentations";
import { sha256 } from "@presenter-garage/node/write";
import {
  findRules,
  libraryOf,
  loadRules,
  RULES_JSON,
  RULES_MD,
  rulesConfiguration,
  saveRules,
  type LoadedRules,
} from "@presenter-garage/node/rules";
import { fidelityOf } from "./fidelity";

/**
 * A team's rules: `check_presentations` runs them, `read_rules` and
 * `save_rules` read and compile them. `save_rules` writes only `rules.json`,
 * through `saveRules()` in `packages/node`.
 */

export interface CheckResult {
  filesChecked: number;
  /** Which rules ran, and whether they can be trusted. */
  rules: RulesInUse;
  /** What a reader must know before trusting the findings: a list that could not be read, rules out of date. */
  notes: string[];
  /** How many breaks of each rule, across every file checked, leaving out what a person excepted. */
  totals: Record<string, number>;
  /** How many findings a person has excepted. */
  excepted: number;
  truncated: boolean;
  files: {
    path: string;
    name: string;
    fidelity?: Fidelity;
    /** Set when the file could not be read; `findings` is then empty. */
    error?: string;
    findings: (Finding & { message: string })[];
  }[];
}

export interface RulesInUse {
  markdown?: string;
  json?: string;
  /** Given with the call rather than read from a file. */
  inline?: true;
  stale: boolean;
  /** No `rules.json` was found, so the default text checks ran. */
  defaulted: boolean;
  rules: number;
}

/** The rules a call names, or the team's as found, or the default text checks. */
async function rulesFor(inline: unknown, rulesDirs: readonly string[]): Promise<LoadedRules & { inline?: true }> {
  if (inline === undefined) return loadRules(await findRules(undefined, rulesDirs));
  try {
    return { set: parseRules(inline), stale: false, defaulted: false, inline: true };
  } catch (e) {
    if (e instanceof RulesError) throw new LibraryError(e.message);
    throw e;
  }
}

function rulesNotes(loaded: LoadedRules): string[] {
  if (loaded.defaulted) {
    return [
      loaded.markdown
        ? `${loaded.markdown} has not been compiled into ${RULES_JSON}: only the default text checks ran. Read it with read_rules and compile it with save_rules.`
        : `No ${RULES_MD} or ${RULES_JSON} found: only the default text checks ran.`,
    ];
  }
  return loaded.stale ? [`${loaded.markdown} has changed since ${loaded.json} was compiled from it: compile it again with read_rules and save_rules.`] : [];
}

/**
 * The team's rules, run on one file or a whole folder.
 *
 * The same checks the command line's `check` and the apps run, so a model
 * and a person looking at the same song are told the same thing. Only files
 * with something to say are listed; a clean library comes back short.
 *
 * Every song is checked against the configured groups and macros of the one
 * library the server has open, which is the library it is in.
 */
export async function checkPresentations(
  root: string,
  { path: target, limit = 100, rules: inline, lang = "en" }: { path?: string; limit?: number; rules?: unknown; lang?: Lang } = {},
  rulesDirs: readonly string[] = []
): Promise<CheckResult> {
  const resolved = target ? await resolveInRoots([root], target) : undefined;
  const single = resolved !== undefined && (await isFile(resolved));
  if (single && !isPresentationFile(path.basename(resolved))) {
    throw new LibraryError(`Not a presentation (.pro) file: ${target}`);
  }
  const loaded = await rulesFor(inline, rulesDirs);
  const { problems, ...config } = await rulesConfiguration([root]);
  const i18n = createI18n(lang);
  const { files, truncated } = single
    ? { files: [resolved], truncated: false }
    : await findPresentations([resolved ?? root]);
  // Asked only of the songs being checked, once for each library inside the
  // ProPresenter folder: a macro a rule needs is missing only where that rule runs.
  const asked = new Set<string | undefined>();
  for (const file of files) {
    const library = libraryOf(root, file);
    if (asked.has(library)) continue;
    asked.add(library);
    const unknown = unknownMacros(loaded.set, config, { library });
    if (unknown.length) throw new LibraryError(`The rules name macros ProPresenter's list in ${root} does not have: ${unknown.join(", ")}`);
  }

  // Truncated either way: a walk that hit its cap left files unchecked, and a
  // list that hit `limit` left findings unlisted. Both mean "not everything".
  const result: CheckResult = {
    filesChecked: files.length,
    rules: {
      ...(loaded.markdown ? { markdown: loaded.markdown } : {}),
      ...(loaded.json ? { json: loaded.json } : {}),
      ...(loaded.inline ? { inline: true as const } : {}),
      stale: loaded.stale,
      defaulted: loaded.defaulted,
      rules: loaded.set.rules.length,
    },
    notes: [...rulesNotes(loaded), ...(usesLists(loaded.set) ? problems : [])],
    // No inherited keys: a rule may be called `constructor`.
    totals: Object.create(null) as Record<string, number>,
    excepted: 0,
    truncated,
    files: [],
  };
  const list = (entry: CheckResult["files"][number]) => {
    if (result.files.length === limit) result.truncated = true;
    else result.files.push(entry);
  };

  for (const file of files) {
    let bytes: Uint8Array;
    let converted: true | undefined;
    try {
      ({ bytes, converted } = await readFoundFile(file));
    } catch (e) {
      // One file that will not open is a finding about that file, not a
      // reason to abandon the other eight hundred.
      if (single) throw e;
      list({ path: file, name: presentationName(file), error: (e as Error).message, findings: [] });
      continue;
    }
    const opened = openPresentation(bytes);
    if (opened.problem) {
      list({ path: file, name: presentationName(file), error: explain(opened.problem, opened.detail), findings: [] });
      continue;
    }
    const name = presentationName(file);
    const findings = checkRules(opened.doc, loaded.set, { song: name, library: libraryOf(root, file) }, config);
    if (findings.length === 0) continue;
    for (const finding of findings) {
      if (finding.excepted !== undefined) result.excepted++;
      else result.totals[finding.rule] = (result.totals[finding.rule] ?? 0) + 1;
    }
    list({
      path: file,
      name,
      fidelity: fidelityOf(converted, checkPresentationFidelity(bytes).fidelity),
      findings: findings.map((finding) => ({ ...finding, message: describeFinding(i18n, finding) })),
    });
  }
  return result;
}

/** Whether a rule set leans on ProPresenter's configured lists, so a missing one is worth saying. */
function usesLists(set: RuleSet): boolean {
  return set.rules.some((r) => r.tier !== "off" && ((r.check === "group-names" && !r.names) || r.check === "slide-macros" || r.check === "macro-alone"));
}

export interface RulesAnswer {
  /** Where `RULES.md` is, and what it says: the team's rules in their own words. */
  markdown?: { path: string; text: string };
  /** Where `rules.json` is, and the rules compiled into it. */
  json?: { path: string; rules: RuleSet };
  /** Why `rules.json` could not be used, when it is there and is not valid. */
  problems?: string[];
  stale: boolean;
  /** Where the rules were looked for. */
  searched: readonly string[];
  /** Every check a compiled rule can use, and what it takes. */
  checks: Record<string, string>;
}

/**
 * The team's rules, as written and as compiled, with everything needed to
 * compile them again. A `rules.json` that will not load is reported in
 * `problems` rather than refused: the model reading this is the one that
 * puts it right, and needs the prose to do it.
 */
export async function readRules(rulesDirs: readonly string[]): Promise<RulesAnswer> {
  const found = await findRules(undefined, rulesDirs);
  let loaded: LoadedRules | undefined;
  let problems: string[] | undefined;
  try {
    loaded = await loadRules(found);
  } catch (e) {
    if (!(e instanceof LibraryError)) throw e;
    problems = [e.message];
  }
  const markdown = loaded?.markdown ?? found?.markdown;
  const text = markdown ? await prose(markdown) : undefined;
  return {
    ...(text ? { markdown: text } : {}),
    ...(loaded?.json ? { json: { path: loaded.json, rules: loaded.set } } : {}),
    ...(problems ? { problems } : {}),
    // From the same bytes as the prose returned, so the two cannot describe different files.
    stale: text ? !loaded?.json || loaded.set.source?.sha256 !== text.sha256 : (loaded?.stale ?? true),
    searched: rulesDirs,
    checks: CHECK_GUIDE,
  };
}

/** `RULES.md` as read, with the hash `save_rules` is handed back to say this is what was compiled. */
async function prose(file: string) {
  const bytes = await fs.readFile(file);
  return { path: file, text: bytes.toString("utf8"), sha256: sha256(new Uint8Array(bytes)) };
}

/**
 * Compile the team's rules: check them, and write `rules.json` beside the
 * `RULES.md` found. `compiledFrom` is the hash `read_rules` gave with the
 * prose, so rules compiled from a file that has changed since are refused
 * rather than stamped as current.
 */
export async function saveRulesFile(rulesDirs: readonly string[], rules: unknown, root: string, compiledFrom: string) {
  const found = await findRules(undefined, rulesDirs);
  if (!found?.markdown) throw new LibraryError(`No ${RULES_MD} found in ${rulesDirs.join(" or ")}: rules are compiled from one.`);
  let set: RuleSet;
  try {
    set = parseRules(rules);
  } catch (e) {
    if (e instanceof RulesError) throw new LibraryError(e.message);
    throw e;
  }
  // Refused before writing: a name the library's list does not have would
  // make its rule find nothing, or everything. Which library a scoped rule's
  // macros must be in is not known until a song is checked, so a check asks
  // that per song.
  const { macros } = await rulesConfiguration([root]);
  const unknown = unknownMacros(set, { macros: macros ?? [] });
  if (unknown.length) throw new LibraryError(`These macros are not in ProPresenter's list: ${unknown.join(", ")}. Nothing was written.`);
  const saved = await saveRules(found.markdown, set, compiledFrom);
  return { path: saved.path, rules: saved.set.rules.length, exceptions: saved.set.exceptions.length };
}
