import type { I18n } from "@presenter-garage/core/i18n/core";
import { describeFinding, findingTags } from "@presenter-garage/core/i18n/rules";
import type { LoadedRules } from "../rules";
import type { Song, SongFinding } from "./song";
import { sourceMeta, type Source } from "./source";

/**
 * `check`: every rule break in a library, for a person at a terminal or an
 * agent reading JSON.
 *
 * A person sees each break with two slides either side, since whether a
 * repeat marker is already sung out, or a Pause belongs where it is, is
 * plain only from what is around it. An agent gets where each break is and
 * what it says, and the words only when it asks: a library's worth of lyrics
 * would fill its context and leave this computer for nothing.
 */

/** Slides shown either side of a break. */
export const CONTEXT = 2;

interface FlatSlide {
  group: string;
  lines: string[];
  macros: string[];
}

const flatSlides = (song: Song): FlatSlide[] => song.groups.flatMap((g) => g.slides.map((s) => ({ group: g.name, ...s })));

/** A group name as it is drawn: a non-breaking space shown, since ProPresenter tells it from a space. */
const shownName = (name: string) => name.replace(/ /g, "⍽");

export function checkText(source: Source, rules: LoadedRules, i18n: I18n): string {
  const out: string[] = [];
  let total = 0;
  let excepted = 0;
  for (const song of source.songs) {
    if (!song.findings.length) continue;
    const slides = flatSlides(song);
    out.push(`=== ${song.file}`);
    for (const finding of song.findings) {
      total++;
      if (finding.excepted !== undefined) excepted++;
      out.push(`  ${heading(finding, i18n)}`);
      out.push(...context(slides, finding).map((line) => `    ${line}`));
    }
    out.push("");
  }
  out.push(`${source.label}: ${total} rule breaks in ${source.songs.filter((s) => s.findings.length).length} of ${source.songs.length} songs` + (excepted ? `, ${excepted} of them excepted` : ""));
  out.push(...notes(source, rules));
  return out.join("\n");
}

function heading(finding: SongFinding, i18n: I18n): string {
  const where = `${i18n.f(i18n.t.tools.presentations.slide, { n: finding.slideIndex + 1 })}${finding.groupName ? ` [${shownName(finding.groupName)}]` : ""}`;
  return `${where}: ${describeFinding(i18n, finding)} (${finding.rule}, ${findingTags(i18n, finding)})`;
}

/** The slides around a break, the one it is on marked, and its line marked where it has one. */
function context(slides: readonly FlatSlide[], finding: SongFinding): string[] {
  const lines: string[] = [];
  const from = Math.max(0, finding.slideIndex - CONTEXT);
  const to = Math.min(slides.length - 1, finding.slideIndex + CONTEXT);
  for (let i = from; i <= to; i++) {
    const slide = slides[i];
    const here = i === finding.slideIndex;
    const macros = slide.macros.length ? ` (${slide.macros.join(", ")})` : "";
    lines.push(`${here ? ">" : " "} ${i + 1} [${shownName(slide.group)}]${macros}`);
    for (const line of slide.lines) {
      const marked = here && finding.text !== undefined && line === finding.text;
      lines.push(`${marked ? ">" : " "}   ${line}`);
    }
  }
  return lines;
}

export function checkJson(source: Source, rules: LoadedRules, i18n: I18n, lyrics: boolean) {
  return {
    source: sourceMeta(source),
    rules: rulesMeta(rules),
    songs: source.songs
      .filter((song) => song.findings.length)
      .map((song) => ({
        file: song.file,
        breaks: song.breaks,
        findings: song.findings.map(({ text, ...finding }) => ({
          ...finding,
          message: describeFinding(i18n, finding),
          ...(lyrics && text !== undefined ? { text } : {}),
        })),
      })),
  };
}

export function rulesMeta(rules: LoadedRules) {
  return {
    markdown: rules.markdown,
    json: rules.json,
    stale: rules.stale,
    defaulted: rules.defaulted,
    rules: rules.set.rules.length,
    exceptions: rules.set.exceptions.length,
  };
}

/** What a reader must know before trusting the result. */
export function notes(source: Source | undefined, rules: LoadedRules): string[] {
  const out: string[] = [];
  if (rules.defaulted) {
    out.push(
      rules.markdown
        ? `${rules.markdown} has not been compiled into rules.json yet: only the default text checks ran.`
        : "No RULES.md or rules.json found: only the default text checks ran."
    );
  } else if (rules.stale) {
    out.push(`${rules.markdown} has changed since ${rules.json} was compiled from it: compile it again.`);
  }
  for (const note of source?.ruleNotes ?? []) out.push(`${source!.label}: ${note}`);
  return out;
}

export function rulesText(rules: LoadedRules): string {
  const tiers = { 1: 0, 2: 0, 3: 0, off: 0 } as Record<string, number>;
  for (const rule of rules.set.rules) tiers[String(rule.tier)]++;
  const lines = [
    rules.defaulted ? "Rules: the default text checks" : `Rules: ${rules.json}`,
    ...(rules.markdown ? [`From:  ${rules.markdown}`] : []),
    `${rules.set.rules.length} rules (tier 1: ${tiers[1]}, tier 2: ${tiers[2]}, tier 3: ${tiers[3]}, off: ${tiers.off}), ${rules.set.exceptions.length} exceptions`,
    ...rules.set.rules.map((r) => `  ${r.id}: ${r.check}, tier ${r.tier}${r.libraries ? `, only in ${r.libraries.join(", ")}` : ""}`),
    ...notes(undefined, rules),
  ];
  return lines.join("\n");
}
