import type { Finding } from "../lib/rules";
import type { I18n } from "./core";

/**
 * A rule's finding as a sentence in the reader's language.
 *
 * Built from the finding's structured detail at the moment it is shown, never
 * stored, so the same findings read in French for a French team and in
 * English for anyone else. Group and macro names are quoted as stored: they
 * are ProPresenter's names, not ours to translate.
 */
export function describeFinding(i18n: I18n, finding: Finding): string {
  const { t, f, plural, quote, list } = i18n;
  const r = t.rules;
  const d = finding.detail;
  const names = (values: string[]) => list(values.map(quote));
  switch (d.kind) {
    case "text":
      return t.tools.presentations.kinds[d.issue];
    case "marker":
      return d.means === "repeat" && d.count !== undefined
        ? plural(r.repeatMarker, d.count, { marker: quote(d.marker) })
        : f(r.marker, { marker: quote(d.marker) });
    case "groupName":
      if (d.spacing !== undefined) return f(r.groupNameSpacing, { group: quote(d.group), listed: quote(d.spacing) });
      return f(r.groupName, { group: quote(d.group) });
    case "groupAfter":
      return f(r.groupAfter, { group: quote(d.group), after: quote(d.after) });
    case "firstGroup":
      return d.actual
        ? f(r.firstGroup, { actual: quote(d.actual), expected: quote(d.expected) })
        : f(r.firstGroupUnnamed, { expected: quote(d.expected) });
    case "lastGroup":
      return d.actual
        ? f(r.lastGroup, { actual: quote(d.actual), expected: quote(d.expected) })
        : f(r.lastGroupUnnamed, { expected: quote(d.expected) });
    case "repeatedGroup":
      return f(r.repeatedGroup, { group: quote(d.group), slide: d.firstSlide + 1 });
    case "slideMacros": {
      const parts: string[] = [];
      if (d.count === 0) parts.push(r.macrosNone);
      if (d.missing.length) parts.push(f(r.macrosMissing, { macros: names(d.missing) }));
      if (d.extra.length) parts.push(f(r.macrosExtra, { macros: names(d.extra) }));
      // Adding what is missing may still leave the slide short of its minimum.
      if (d.min !== undefined && d.count + d.missing.length < d.min) parts.push(plural(r.macrosTooFew, d.min));
      if (d.max !== undefined && d.count > d.max) parts.push(plural(r.macrosTooMany, d.max));
      if (d.disabled.length) parts.push(f(r.macrosDisabled, { macros: names(d.disabled) }));
      return parts.join(r.separator);
    }
    case "macroAlone":
      return f(r.macroAlone, { macro: quote(d.macro), others: names(d.others) });
  }
}

/** The finding's tier, and whether a person excepted it, as a short label. */
export function findingTags({ t, f }: I18n, finding: Finding): string {
  const tags = [f(t.rules.tier, { n: finding.tier })];
  if (finding.excepted !== undefined) {
    tags.push(finding.excepted ? f(t.rules.exceptedBecause, { reason: finding.excepted }) : t.rules.excepted);
  }
  return tags.join(", ");
}
