import { createI18n } from "@presenter-garage/core/i18n/core";
import type { LineFix } from "@presenter-garage/core/lib/fixes";
import { canonical, colorName, type MacroRef, type StructureChange } from "@presenter-garage/core/lib/structure";
import type { PlannedFile } from "@presenter-garage/node/edits";

/**
 * How a change is said to the person choosing it, wherever they choose: the
 * confirmation form, the review page, and the notes a model reads back. One
 * place, so a change never reads one way in a form and another on the page.
 */

const { t } = createI18n("en");

/** Where a structural change is, for its tick box's title. */
export function changeWhere(change: StructureChange): string {
  if (change.kind === "swapMacro") return [`slide ${change.slideIndex + 1}`, change.groupName].filter(Boolean).join(", ");
  const slides = change.slides.map((i) => i + 1);
  const held = slides.length === 0 ? "no slides" : slides.length === 1 ? `slide ${slides[0]}` : `slides ${slides.join(", ")}`;
  return `group ${change.groupIndex + 1}, ${held}`;
}

/**
 * A structural change as it is and as it would be, every part of it that
 * changes said: a group's name, its colour and the configured group it is
 * tied to; a macro, and the collection the slide records it in.
 */
export function describeChange(change: StructureChange): string {
  if (change.kind === "swapMacro") {
    const { before, after } = change;
    // Names alone where they differ; with uuids where they do not, so nothing written goes unsaid.
    const sameName = before.name === after.name;
    const macro = (ref: MacroRef) => (sameName ? `“${ref.name}” (${ref.uuid ?? "no uuid"})` : `“${ref.name}”`);
    const said = [`Macro swapped: ${macro(before)} → ${macro(after)}.`];
    if (after.collection && canonical(after.collection) !== canonical(before.collection)) {
      const sameCollection = before.collection?.name === after.collection.name;
      const collection = (c: MacroRef["collection"]) => (c ? `“${c.name}”${sameCollection ? ` (${c.uuid ?? "no uuid"})` : ""}` : "none");
      said.push(`The slide records it in collection ${collection(after.collection)} instead of ${collection(before.collection)}.`);
    }
    if (after.actionName !== before.actionName) said.push(`Its action is renamed to match: “${before.actionName}” → “${after.actionName}”.`);
    return said.join(" ");
  }
  const { before, after } = change;
  const said = [`Group renamed: “${before.name}” → “${after.name}”.`];
  // Compared exactly, not as shown: a difference too small to show is still written, and still said.
  if (canonical(before.color) !== canonical(after.color)) {
    const shown = colorName(before.color) === colorName(after.color) ? " (the same to the eye, set exactly)" : "";
    said.push(`Colour: ${colorName(before.color)} → ${colorName(after.color)}, as the configured group has it${shown}.`);
  }
  if (before.link && !after.link) said.push(`No longer tied to configured group “${before.link.name ?? before.link.uuid}”, which it would no longer be.`);
  else if (after.link && canonical(after.link) !== canonical(before.link)) {
    said.push(`Tied to configured group “${after.link.name}” (${after.link.uuid}) instead of “${before.link?.name ?? ""}” (${before.link?.uuid ?? "no uuid"}).`);
  }
  said.push("Arrangements name groups by uuid, which does not change, so each keeps the group where it was.");
  return said.join(" ");
}

/**
 * Where a line is, for its tick box's title. Box and line too: a slide can
 * hold the same line twice, and a person choosing one of them has to be able
 * to tell which.
 */
export function lineWhere(fix: LineFix): string {
  return [
    `slide ${fix.slideIndex + 1}`,
    fix.groupName,
    `text box ${fix.boxIndex + 1}, ${fix.insert ? `new line ${fix.insert} line` : "line"} ${fix.lineIndex + 1}`,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * A line as it is and as it would read. An added line as it would read, and
 * the line it goes beside as it reads now, so it can be placed without the
 * slide in front of them.
 */
export function lineSaid(fix: LineFix, styling?: string[]): string {
  return (
    (fix.insert
      ? `Added ${fix.insert} ${fix.before ? `“${fix.before}”` : "an empty line"}: “${fix.after}”`
      : `“${fix.before}” → ${fix.after === null ? "line removed" : `“${fix.after}”`}`) +
    (styling ? `. Styling: ${styling.join("; ")}.` : "")
  );
}

/** What a person is told before anything in these files is written: a Cloud workspace's warning, and to close ProPresenter. */
export function beforeWriting(files: readonly PlannedFile[]): { cloud: string; closed: string } {
  return {
    cloud: files.some((file) => file.workspace?.cloud) ? `${t.tools.presentations.cloudWrite} ` : "",
    closed: files.some((file) => file.workspace)
      ? "Quit ProPresenter first: while it has the workspace open, nothing is written."
      : "If ProPresenter has one of these open, close it first: ProPresenter may save its own copy over the change.",
  };
}

/** `3 lines`, `1 line`. */
export const count = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;

