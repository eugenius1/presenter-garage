import type { ConfiguredGroup, ConfiguredMacro } from "./configuration";
import {
  checkPresentation,
  hasText,
  shownBounds,
  SPACE_CLASS,
  type PresentationDoc,
  type SlideMacro,
  type TextIssueKind,
} from "./presentation";

/**
 * A team's rules, as the tools run them.
 *
 * A team writes its rules in its own words, in `RULES.md`, for an agent to
 * read. The tools cannot read prose -- the command line has no model, and
 * putting 1,800 songs through one would cost and send every lyric out -- so
 * the agent compiles the prose into `rules.json`: a list of rules, each one
 * of the generic checks below with the names the team uses. Nothing here
 * knows any team's group or macro names; they all come from the file.
 *
 * Check names and parameter keys are English, since the code defines them.
 * A rule's own id is the team's, in any language, as long as it is ASCII:
 * `marqueurs-repetition` is as good as `repeat-markers`.
 */

/** The checks a rule can use. */
export const CHECKS = [
  "leading-trailing-space",
  "repeated-space",
  "blank-line",
  "trailing-comma",
  "trailing-full-stop",
  "trailing-semicolon",
  "line-marker",
  "group-names",
  "no-group-after",
  "first-group",
  "last-group",
  "repeated-group-text",
  "slide-macros",
  "macro-alone",
] as const;
export type CheckName = (typeof CHECKS)[number];

/**
 * How soon a rule is dealt with. 1: fixes safe in bulk. 2: reviewed case by
 * case. 3: last. `off` keeps a rule written down without running it.
 */
export type Tier = 1 | 2 | 3 | "off";

/** Where in a line `line-marker` looks. */
export type MarkerPosition = "end" | "start" | "whole" | "anywhere";

export interface RuleBase {
  id: string;
  tier: Tier;
  /** Run only on songs in these libraries; every library when absent. */
  libraries?: string[];
  /** What the rule is for, in the team's words, for a person reading a finding. */
  note?: string;
}

export type Rule = RuleBase &
  (
    | { check: "leading-trailing-space" | "repeated-space" | "blank-line" | "trailing-comma" | "trailing-full-stop" | "trailing-semicolon" | "repeated-group-text" }
    | {
        check: "line-marker";
        /** Literal words, or patterns where `{n}` stands for a count: `x{n}`, `({n}x)`, `bis`. */
        markers: string[];
        at?: MarkerPosition;
        /** `repeat`: the marker says to sing the lines again, which the duplicate-lines fix acts on. */
        means?: "repeat";
      }
    | {
        check: "group-names";
        /** The names allowed; ProPresenter's configured list when absent. */
        names?: string[];
      }
    | { check: "no-group-after"; group: string; after: string }
    | { check: "first-group"; group: string }
    | { check: "last-group"; group: string }
    | {
        check: "slide-macros";
        where: "first" | "rest";
        /** Every one must be on the slide. */
        required?: string[];
        /** May be on the slide as well. Once either list is given, any other macro is a finding. */
        allowed?: string[];
        min?: number;
        max?: number;
      }
    | { check: "macro-alone"; macro: string }
  );

/** A finding a person has said is fine. Every field given must match. */
export interface RuleException {
  rule: string;
  /** The song's name, as ProPresenter lists it. */
  song?: string;
  library?: string;
  /** The finding's value: the group name, the marker, the macro. */
  value?: string;
  reason?: string;
}

export interface RuleSet {
  version: 1;
  /** The `RULES.md` this was compiled from, and its SHA-256 then, to tell when it has changed since. */
  source?: { file: string; sha256: string };
  rules: Rule[];
  exceptions: RuleException[];
}

/**
 * What each check does and takes, for the agent compiling `RULES.md`: the
 * catalogue is all a compiled rule can say, so the agent has to know it
 * whole. English, like the keys it describes.
 */
export const CHECK_GUIDE: Record<CheckName, string> = {
  "leading-trailing-space": "A line that starts or ends with a space. No parameters.",
  "repeated-space": "Two or more spaces in a row inside a line. No parameters.",
  "blank-line": "An empty line between two lines of text in one box. No parameters.",
  "trailing-comma": "A line ending in a comma. No parameters.",
  "trailing-full-stop": "A line ending in a full stop; an ellipsis is not one. No parameters.",
  "trailing-semicolon": "A line ending in a semicolon. No parameters.",
  "line-marker":
    "A marker on a line. markers: literal words or patterns where {n} is a count, e.g. [\"x{n}\", \"({n}x)\", \"bis\"], " +
    "matched whole and ignoring case. at: end (default), start, whole (the line is only the marker) or anywhere. " +
    "means: \"repeat\" when the marker says to sing the lines again (a marker without {n} then counts as 2).",
  "group-names": "A group name not in the list. names: the allowed names; ProPresenter's configured groups when left out. Names match exactly, a non-breaking space being a different name.",
  "no-group-after": "Group `group` straight after group `after`, e.g. a Pause right after an Intro.",
  "first-group": "A song that does not start with group `group`.",
  "last-group": "A song that does not end in group `group`.",
  "repeated-group-text": "A group used more than once whose words differ, spacing and end punctuation aside. No parameters.",
  "slide-macros":
    "The macros switched on on a slide. where: \"first\" (the first slide) or \"rest\" (every slide no other slide-macros rule selects, " +
    "including rules that are off). required: every one must be there. allowed: may be there too; once required or allowed is given, any other macro " +
    "is a finding. min, max: how many macros the slide may carry. Macros are named as in ProPresenter's macro list.",
  "macro-alone": "A slide carrying macro `macro` together with any other macro.",
};

/** The rules used where a team has none: the text checks, all on, as the Presentations tool has always run them. */
export const DEFAULT_RULES: RuleSet = {
  version: 1,
  rules: (["leading-trailing-space", "repeated-space", "blank-line", "trailing-comma", "trailing-full-stop", "trailing-semicolon"] as const).map(
    (check) => ({ id: check, check, tier: 1 as const })
  ),
  exceptions: [],
};

export class RulesError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`rules.json is not valid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "RulesError";
    this.problems = problems;
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMON_KEYS = ["id", "check", "tier", "libraries", "note"];
const PARAMS: Record<CheckName, { required: string[]; optional: string[] }> = {
  "leading-trailing-space": { required: [], optional: [] },
  "repeated-space": { required: [], optional: [] },
  "blank-line": { required: [], optional: [] },
  "trailing-comma": { required: [], optional: [] },
  "trailing-full-stop": { required: [], optional: [] },
  "trailing-semicolon": { required: [], optional: [] },
  "repeated-group-text": { required: [], optional: [] },
  "line-marker": { required: ["markers"], optional: ["at", "means"] },
  "group-names": { required: [], optional: ["names"] },
  "no-group-after": { required: ["group", "after"], optional: [] },
  "first-group": { required: ["group"], optional: [] },
  "last-group": { required: ["group"], optional: [] },
  "slide-macros": { required: ["where"], optional: ["required", "allowed", "min", "max"] },
  "macro-alone": { required: ["macro"], optional: [] },
};

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string" && s !== "");
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/**
 * Read `rules.json`, refusing anything it does not understand.
 *
 * An unknown key is refused rather than ignored: a misspelt `alowed` passed
 * over in silence would turn a rule into a different one, and the agent that
 * wrote the file is right there to put it right. Every problem is listed at
 * once, by where it is, so one round fixes them all.
 */
export function parseRules(value: unknown): RuleSet {
  const problems: string[] = [];
  const at = (where: string, what: string) => problems.push(`${where}: ${what}`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RulesError(["the file must hold one JSON object"]);
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!["version", "source", "rules", "exceptions"].includes(key)) at(key, "unknown key");
  }
  if (raw.version !== 1) at("version", "must be 1");
  let source: RuleSet["source"];
  if (raw.source !== undefined) {
    const s = raw.source as Record<string, unknown>;
    if (typeof s !== "object" || s === null || typeof s.file !== "string" || typeof s.sha256 !== "string") {
      at("source", "must be { file, sha256 }");
    } else source = { file: s.file, sha256: s.sha256 };
  }

  const rules: Rule[] = [];
  const ids = new Set<string>();
  if (!Array.isArray(raw.rules)) at("rules", "must be a list");
  for (const [i, entry] of (Array.isArray(raw.rules) ? raw.rules : []).entries()) {
    const where = `rules[${i}]`;
    if (typeof entry !== "object" || entry === null) {
      at(where, "must be an object");
      continue;
    }
    const r = entry as Record<string, unknown>;
    const name = typeof r.id === "string" ? `${where} (${r.id})` : where;
    if (typeof r.id !== "string" || !ID.test(r.id)) at(name, "id must be ASCII letters, digits, '.', '_' or '-'");
    else if (ids.has(r.id)) at(name, "id is used twice");
    else ids.add(r.id);
    if (!(CHECKS as readonly unknown[]).includes(r.check)) {
      at(name, `check must be one of ${CHECKS.join(", ")}`);
      continue;
    }
    const check = r.check as CheckName;
    if (![1, 2, 3, "off"].includes(r.tier as never)) at(name, "tier must be 1, 2, 3 or \"off\"");
    if (r.libraries !== undefined && !isStrings(r.libraries)) at(name, "libraries must be a list of names");
    if (r.note !== undefined && typeof r.note !== "string") at(name, "note must be text");
    const { required, optional } = PARAMS[check];
    for (const key of Object.keys(r)) {
      if (!COMMON_KEYS.includes(key) && !required.includes(key) && !optional.includes(key)) at(name, `unknown key ${key} for ${check}`);
    }
    for (const key of required) if (r[key] === undefined) at(name, `${check} needs ${key}`);
    switch (check) {
      case "line-marker":
        if (r.markers !== undefined && (!isStrings(r.markers) || r.markers.length === 0)) at(name, "markers must be a list of words or patterns");
        if (r.at !== undefined && !["end", "start", "whole", "anywhere"].includes(r.at as string)) at(name, "at must be end, start, whole or anywhere");
        if (r.means !== undefined && r.means !== "repeat") at(name, "means can only be \"repeat\"");
        break;
      case "group-names":
        if (r.names !== undefined && !isStrings(r.names)) at(name, "names must be a list of group names");
        break;
      case "no-group-after":
      case "first-group":
      case "last-group":
        for (const key of ["group", "after"]) {
          if (r[key] !== undefined && (typeof r[key] !== "string" || r[key] === "")) at(name, `${key} must be a group name`);
        }
        break;
      case "slide-macros":
        if (r.where !== undefined && r.where !== "first" && r.where !== "rest") at(name, "where must be \"first\" or \"rest\"");
        for (const key of ["required", "allowed"]) {
          if (r[key] !== undefined && !isStrings(r[key])) at(name, `${key} must be a list of macro names`);
        }
        for (const key of ["min", "max"]) if (r[key] !== undefined && !isCount(r[key])) at(name, `${key} must be a whole number`);
        if (isCount(r.min) && isCount(r.max) && r.min > r.max) at(name, "min is more than max");
        break;
      case "macro-alone":
        if (r.macro !== undefined && (typeof r.macro !== "string" || r.macro === "")) at(name, "macro must be a macro name");
        break;
    }
    rules.push(r as unknown as Rule);
  }

  const exceptions: RuleException[] = [];
  if (raw.exceptions !== undefined && !Array.isArray(raw.exceptions)) at("exceptions", "must be a list");
  for (const [i, entry] of (Array.isArray(raw.exceptions) ? raw.exceptions : []).entries()) {
    const where = `exceptions[${i}]`;
    const e = entry as Record<string, unknown>;
    if (typeof e !== "object" || e === null) {
      at(where, "must be an object");
      continue;
    }
    for (const key of Object.keys(e)) {
      if (!["rule", "song", "library", "value", "reason"].includes(key)) at(where, `unknown key ${key}`);
      else if (typeof e[key] !== "string") at(where, `${key} must be text`);
    }
    if (e.rule === undefined) at(where, "needs the rule it is an exception to");
    else if (typeof e.rule === "string" && !ids.has(e.rule)) at(where, `no rule has the id ${e.rule}`);
    if (e.song === undefined && e.library === undefined && e.value === undefined) {
      at(where, "says nothing about what it covers: give a song, a library or a value");
    }
    exceptions.push(e as unknown as RuleException);
  }

  if (problems.length) throw new RulesError(problems);
  return { version: 1, ...(source ? { source } : {}), rules, exceptions };
}

/** ProPresenter's configured lists, where they could be read. */
export interface RuleConfiguration {
  groups?: readonly ConfiguredGroup[];
  macros?: readonly ConfiguredMacro[];
}

/**
 * Every macro name a rule gives that ProPresenter's list does not have.
 *
 * A name that matched nothing would make its rule find nothing, or find every
 * slide, and either way say nothing true, so a caller refuses the rules until
 * the name is put right. Without the list there is nothing to check against,
 * and names are then matched as the slides record them.
 *
 * Given a song's library (`undefined` for a song in none), only the rules
 * that apply to it count: a rule kept to another library runs nothing there,
 * and a macro it names need not be in that song's list. With no song given,
 * every rule counts. An object rather than a bare argument, so a song in no
 * library cannot be mistaken for no song at all.
 */
export function unknownMacros(set: RuleSet, config: RuleConfiguration, song?: { library: string | undefined }): string[] {
  if (!config.macros?.length) return [];
  const known = new Set(config.macros.map((m) => m.name));
  const missing = new Set<string>();
  for (const rule of set.rules) {
    // A rule that is off runs nothing, so a macro it names that has since gone stops no check.
    if (rule.tier === "off") continue;
    if (song && !appliesTo(rule, song.library)) continue;
    for (const name of macroNames(rule)) if (!known.has(name)) missing.add(name);
  }
  return [...missing];
}

/** Whether a rule runs on songs in this library: every rule does, but one kept to some libraries. */
export function appliesTo(rule: Rule, library: string | undefined): boolean {
  return !rule.libraries || (library !== undefined && rule.libraries.some((l) => looseName(l) === looseName(library)));
}

function macroNames(rule: Rule): string[] {
  if (rule.check === "slide-macros") return [...(rule.required ?? []), ...(rule.allowed ?? [])];
  if (rule.check === "macro-alone") return [rule.macro];
  return [];
}

/** What a finding is, in terms a message is built from: never a sentence, so it reads in either language. */
export type FindingDetail =
  | { kind: "text"; issue: TextIssueKind }
  | { kind: "marker"; marker: string; count?: number; means?: "repeat" }
  | { kind: "groupName"; group: string; /** A listed name this one differs from only in its spaces. */ spacing?: string }
  | { kind: "groupAfter"; group: string; after: string }
  | { kind: "firstGroup"; expected: string; actual?: string }
  | { kind: "lastGroup"; expected: string; actual?: string }
  | { kind: "repeatedGroup"; group: string; /** The slide where the group first appears. */ firstSlide: number }
  | {
      kind: "slideMacros";
      where: "first" | "rest";
      missing: string[];
      extra: string[];
      count: number;
      min?: number;
      max?: number;
      /** Macros on the slide that are switched off, which do not count. */
      disabled: string[];
    }
  | { kind: "macroAlone"; macro: string; others: string[] };

export interface Finding {
  rule: string;
  check: CheckName;
  tier: 1 | 2 | 3;
  slideIndex: number;
  groupName?: string;
  boxIndex?: number;
  lineIndex?: number;
  /** The line as it stands, for a finding on one line. */
  text?: string;
  detail: FindingDetail;
  /** What an exception would match: the group name, the marker, the macro. */
  value?: string;
  /** Set when a person has said this one is fine; the reason they gave, or empty. */
  excepted?: string;
}

export interface RuleTarget {
  /** The song's name, as ProPresenter lists it. */
  song: string;
  /** The library it is in, where that is known. */
  library?: string;
}

const TEXT_ISSUES: Partial<Record<CheckName, TextIssueKind[]>> = {
  "leading-trailing-space": ["leadingSpace", "trailingSpace"],
  "repeated-space": ["repeatedSpace"],
  "blank-line": ["blankLine"],
  "trailing-comma": ["trailingComma"],
  "trailing-full-stop": ["trailingFullStop"],
  "trailing-semicolon": ["trailingSemicolon"],
};

/** A name as a person would say it: case, accents' composition and outer spaces aside. */
const looseName = (name: string) => name.normalize("NFC").trim().toLocaleLowerCase("fr");
const SPACES = new RegExp(`${SPACE_CLASS}+`, "g");
/** A group name with every kind of space made the plain one: what tells a space-only difference. */
const spacedName = (name: string) => name.replace(SPACES, " ").trim();

/**
 * Run the rules on one presentation.
 *
 * Slides are taken in the order the groups are stored, which is how
 * ProPresenter numbers them, never an arrangement's. Every finding says where
 * it is down to the line where it has one, so a comparison of two versions
 * can tell which difference fixed it.
 */
export function checkRules(doc: PresentationDoc, set: RuleSet, target: RuleTarget, config: RuleConfiguration = {}): Finding[] {
  const findings: Finding[] = [];
  const macroKey = macroIdentity(config);
  const slideGroups = doc.slides.map((s) => s.groupName ?? "");
  const runs = groupRuns(slideGroups);
  const inScope = (rule: Rule) => appliesTo(rule, target.library);
  // A first-slide rule keeps the first slide from "rest" only where it applies, but even when it is off.
  const selectedFirst = set.rules.some((r) => r.check === "slide-macros" && r.where === "first" && inScope(r));

  let textIssues: ReturnType<typeof checkPresentation>["issues"] | undefined;
  for (const rule of set.rules) {
    if (rule.tier === "off") continue;
    if (!inScope(rule)) continue;
    const tier = rule.tier;
    const add = (slideIndex: number, detail: FindingDetail, extra: Partial<Finding> = {}) =>
      findings.push({ rule: rule.id, check: rule.check, tier, slideIndex, groupName: doc.slides[slideIndex]?.groupName, detail, ...extra });

    const kinds = TEXT_ISSUES[rule.check];
    if (kinds) {
      textIssues ??= checkPresentation(target.song, doc).issues;
      for (const issue of textIssues) {
        if (!kinds.includes(issue.kind)) continue;
        add(
          issue.slideIndex,
          { kind: "text", issue: issue.kind },
          { boxIndex: issue.boxIndex, lineIndex: issue.lineIndex, text: issue.text }
        );
      }
      continue;
    }

    switch (rule.check) {
      case "line-marker": {
        const pattern = markerPattern(rule.markers, rule.at ?? "end");
        for (const box of doc.textBoxes) {
          if (!hasText(box)) continue;
          for (const line of box.lines) {
            const match = pattern.exec(line.text);
            if (!match) continue;
            const marker = match.groups!.marker;
            const digits = Object.entries(match.groups!).find(([key, v]) => key.startsWith("n") && v !== undefined)?.[1];
            const count = digits ? Number(digits) : rule.means === "repeat" ? 2 : undefined;
            add(
              box.slideIndex,
              { kind: "marker", marker: marker.trim(), ...(count !== undefined ? { count } : {}), ...(rule.means ? { means: rule.means } : {}) },
              { boxIndex: box.boxIndex, lineIndex: line.index, text: line.text, value: marker.trim() }
            );
          }
        }
        break;
      }
      case "group-names": {
        // With no list to go by there is nothing to say about any name; the
        // caller says the list was missing, once, rather than once a song.
        // An empty configured list is a list that could not be read, not a
        // team with no groups: every name would be flagged, and none truly.
        const listed = rule.names ?? (config.groups?.length ? config.groups.map((g) => g.name) : undefined);
        if (!listed) break;
        const seen = new Set<string>();
        for (const run of runs) {
          const group = run.name;
          if (group === "" || seen.has(group) || listed.includes(group)) continue;
          seen.add(group);
          const spacing = listed.find((name) => spacedName(name) === spacedName(group));
          add(run.start, { kind: "groupName", group, ...(spacing ? { spacing } : {}) }, { value: group });
        }
        break;
      }
      case "no-group-after":
        for (const [i, run] of runs.entries()) {
          if (i > 0 && run.name === rule.group && runs[i - 1].name === rule.after) {
            add(run.start, { kind: "groupAfter", group: rule.group, after: rule.after }, { value: rule.group });
          }
        }
        break;
      case "first-group": {
        const first = runs[0];
        if (first && first.name !== rule.group) {
          add(0, { kind: "firstGroup", expected: rule.group, ...(first.name ? { actual: first.name } : {}) }, { value: first.name });
        }
        break;
      }
      case "last-group": {
        const last = runs.at(-1);
        if (last && last.name !== rule.group) {
          add(doc.slides.length - 1, { kind: "lastGroup", expected: rule.group, ...(last.name ? { actual: last.name } : {}) }, { value: last.name });
        }
        break;
      }
      case "repeated-group-text": {
        const words = slideWords(doc);
        const first = new Map<string, { start: number; text: string }>();
        for (const run of runs) {
          if (run.name === "") continue;
          const text = JSON.stringify(words.slice(run.start, run.end));
          const earlier = first.get(run.name);
          if (!earlier) first.set(run.name, { start: run.start, text });
          else if (earlier.text !== text) {
            add(run.start, { kind: "repeatedGroup", group: run.name, firstSlide: earlier.start }, { value: run.name });
          }
        }
        break;
      }
      case "slide-macros": {
        const slides = rule.where === "first" ? [0] : doc.slides.map((_, i) => i).filter((i) => !(selectedFirst && i === 0));
        const required = rule.required ?? [];
        const permitted = rule.required !== undefined || rule.allowed !== undefined ? new Set([...required, ...(rule.allowed ?? [])].map((n) => macroKey.byName(n))) : undefined;
        for (const i of slides) {
          const slide = doc.slides[i];
          if (!slide) continue;
          const on = slide.macros.filter((m) => m.enabled);
          const keys = new Set(on.map((m) => macroKey.of(m)));
          const missing = required.filter((name) => !keys.has(macroKey.byName(name)));
          const extra = permitted ? on.filter((m) => !permitted.has(macroKey.of(m))).map((m) => m.name) : [];
          const tooFew = rule.min !== undefined && on.length < rule.min;
          const tooMany = rule.max !== undefined && on.length > rule.max;
          if (!missing.length && !extra.length && !tooFew && !tooMany) continue;
          add(
            i,
            {
              kind: "slideMacros",
              where: rule.where,
              missing,
              extra,
              count: on.length,
              ...(rule.min !== undefined ? { min: rule.min } : {}),
              ...(rule.max !== undefined ? { max: rule.max } : {}),
              disabled: slide.macros.filter((m) => !m.enabled).map((m) => m.name),
            },
            { value: missing[0] ?? extra[0] }
          );
        }
        break;
      }
      case "macro-alone": {
        const key = macroKey.byName(rule.macro);
        for (const slide of doc.slides) {
          const on = slide.macros.filter((m) => m.enabled);
          if (!on.some((m) => macroKey.of(m) === key)) continue;
          const others = on.filter((m) => macroKey.of(m) !== key).map((m) => m.name);
          if (others.length) add(slide.slideIndex, { kind: "macroAlone", macro: rule.macro, others }, { value: rule.macro });
        }
        break;
      }
    }
  }

  for (const finding of findings) {
    const exception = set.exceptions.find((e) => covers(e, finding, target));
    if (exception) finding.excepted = exception.reason ?? "";
  }
  return findings.sort((a, b) => a.slideIndex - b.slideIndex || (a.boxIndex ?? -1) - (b.boxIndex ?? -1) || (a.lineIndex ?? -1) - (b.lineIndex ?? -1));
}

function covers(e: RuleException, finding: Finding, target: RuleTarget): boolean {
  if (e.rule !== finding.rule) return false;
  if (e.song !== undefined && looseName(e.song) !== looseName(target.song)) return false;
  if (e.library !== undefined && (!target.library || looseName(e.library) !== looseName(target.library))) return false;
  // A value is matched exactly: `Couplet 1` and `Couplet\u00a01` are two group names to ProPresenter.
  if (e.value !== undefined && e.value !== finding.value) return false;
  return true;
}

/**
 * The library a song is in, from the folder read and the song's path inside
 * it: the folder under `Libraries` that holds it, or the first folder under
 * the one read. A song straight inside the folder read is in that folder's
 * library, so a library gets its own name whether it or a folder above it is
 * the one read, and rules kept to it run either way. Only a caller that knows
 * the folders above the one read can also place a song in a folder inside a
 * library, as `libraryOf` in `packages/node` does; the browser is told the
 * chosen folder's name and no more.
 */
export function libraryOfSong(folder: string, relative: readonly string[]): string | undefined {
  const at = relative.lastIndexOf("Libraries");
  const parts = at >= 0 ? relative.slice(at + 1) : relative;
  if (parts.length > 1) return parts[0];
  return folder && folder !== "Libraries" ? folder : undefined;
}

/** How many of each tier, leaving out what a person has excepted. */
export function countByTier(findings: readonly Finding[]): [number, number, number] {
  const counts: [number, number, number] = [0, 0, 0];
  for (const f of findings) if (f.excepted === undefined) counts[f.tier - 1]++;
  return counts;
}

/** Consecutive slides in one group: a group as it stands in the song. */
export interface GroupRun {
  name: string;
  start: number;
  /** One past the last slide. */
  end: number;
}

export function groupRuns(groupNames: readonly string[]): GroupRun[] {
  const runs: GroupRun[] = [];
  groupNames.forEach((name, i) => {
    const last = runs.at(-1);
    if (last && last.name === name) last.end = i + 1;
    else runs.push({ name, start: i, end: i + 1 });
  });
  return runs;
}

/**
 * Each slide's shown words, compared loosely: spacing and end punctuation are
 * the text checks' business, and where a line breaks is layout, so the same
 * words broken over two lines on one slide are still the same words.
 */
function slideWords(doc: PresentationDoc): string[] {
  const words: string[][] = doc.slides.map(() => []);
  for (const box of doc.textBoxes) {
    if (!hasText(box)) continue;
    const texts = box.lines.map((l) => l.text);
    const [first, last] = shownBounds(texts);
    for (const text of texts.slice(first, last + 1)) {
      const loose = text.replace(SPACES, " ").trim().replace(/[\s.,;:]+$/, "");
      if (loose) words[box.slideIndex]?.push(loose);
    }
  }
  return words.map((slide) => slide.join(" "));
}

/**
 * How a slide's macro is told from another: by uuid through ProPresenter's
 * list, so a macro renamed since it was put on a slide is still itself, and
 * by name where the list or the uuid is missing.
 */
function macroIdentity(config: RuleConfiguration) {
  const uuidByName = new Map<string, string>();
  for (const m of config.macros ?? []) {
    if (m.uuid && !uuidByName.has(m.name)) uuidByName.set(m.name, m.uuid.toLowerCase());
  }
  return {
    byName: (name: string) => {
      const uuid = uuidByName.get(name);
      return uuid ? `uuid:${uuid}` : `name:${name}`;
    },
    of: (macro: SlideMacro) => {
      const uuid = macro.uuid?.toLowerCase();
      // A uuid the list does not hold is a macro since deleted, whatever its
      // name: a new macro of the same name is another macro.
      if (uuid && uuidByName.size > 0) return `uuid:${uuid}`;
      // No uuid, or no list to look it up in: its name is all there is to go by.
      const known = uuidByName.get(macro.name);
      return known ? `uuid:${known}` : `name:${macro.name}`;
    },
  };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One expression for a rule's markers.
 *
 * A marker is matched whole: not inside a word, so `x{n}` finds "x2" but
 * never the end of "six2", and a marker at the end may still have spaces or
 * a full stop after it. Case does not matter. `{n}` is a count of one to
 * three digits; each marker's count lands in its own group, `n0`, `n1`...
 */
export function markerPattern(markers: readonly string[], at: MarkerPosition): RegExp {
  const alternatives = markers.map((marker, i) => {
    // A marker may hold `{n}` twice; a group name may be used only once, so
    // only the first is captured and the count is read from that.
    let seen = 0;
    return marker
      .split("{n}")
      .map(escape)
      .reduce((out, part) => `${out}${seen++ === 0 ? `(?<n${i}>\\d{1,3})` : "\\d{1,3}"}${part}`);
  });
  const body = `(?<marker>${alternatives.join("|")})`;
  const before = "(?<![\\p{L}\\p{N}])";
  const after = "(?![\\p{L}\\p{N}])";
  const space = `${SPACE_CLASS}*`;
  const tail = `[${SPACE_CLASS.slice(1, -1)}.,;:!]*`;
  switch (at) {
    case "end":
      return new RegExp(`${before}${body}${after}${tail}$`, "iu");
    case "start":
      return new RegExp(`^${space}${body}${after}`, "iu");
    case "whole":
      return new RegExp(`^${space}${body}${tail}$`, "iu");
    case "anywhere":
      return new RegExp(`${before}${body}${after}`, "iu");
  }
}
