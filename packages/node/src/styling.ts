import type { RawDoc } from "@presenter-garage/core/lib/decode";
import { FixError, presentationRanges, type LineFix } from "@presenter-garage/core/lib/fixes";
import type { PresentationDoc } from "@presenter-garage/core/lib/presentation";
import { AttributeRangeError, type LineStyling } from "@presenter-garage/core/lib/ranges";
import type { StructureChange } from "@presenter-garage/core/lib/structure";
import { planWorkspaceEdit } from "@presenter-garage/core/lib/workspace-edit";

/**
 * What an edit does to the styling on its lines, in words a person reads
 * before choosing them, or why it cannot be made at all: for a ProPresenter
 * 22 workspace document and for a `.pro` file alike.
 */

const CAPITALIZATION = ["no capitalization", "All Caps", "Small Caps", "Title Case", "Start Case"];

/** A ProPresenter 22 attribute as its Text inspector names it, more or less. */
function attributeName({ kind, value }: { kind: string; value?: unknown }): string {
  if (kind === "capitalization") return (typeof value === "number" && CAPITALIZATION[value]) || "Capitalization";
  const names: Record<string, string> = {
    original_font_size: "Font size",
    font_scale_factor: "Font scale",
    text_gradient_fill: "Gradient fill",
    should_preserve_foreground_color: "Kept text colour",
    chord: "Chord",
    cut_out_fill: "Cut-out fill",
    media_fill: "Media fill",
    background_effect: "Background effect",
    character_size_mode: "Character size",
    original_font: "Font",
  };
  return names[kind] ?? kind;
}

/**
 * What one line's change does to the styling on it, a sentence per range,
 * so the person sees every range that moves before choosing the line.
 */
export function describeStyling(fix: LineFix, styling: LineStyling, cutBack: boolean): string[] {
  const quote = (text: string) => (text === "" ? "none of it" : `“${text}”`);
  const said = styling.ranges.map((range) => {
    const name = attributeName(range);
    if (fix.insert) return range.after === fix.after ? `${name} on the whole line, as on the line beside it` : `${name} on ${quote(range.after ?? "")}`;
    if (range.after === null) return `${name} on ${quote(range.before)} goes with the line`;
    if (range.before === fix.before && range.after === fix.after) return `${name} on the whole line, as before`;
    return `${name} on ${quote(range.before)} → on ${quote(range.after)}`;
  });
  if (cutBack) said.push("formatting that ran past the end of the text box is cut back to its end, which changes nothing visible");
  return said;
}

/** Each fix's styling in words, from the plan of its whole document; `cutBack` the boxes with a range cut back to the text. */
function stylingOf(fixes: readonly LineFix[], styling: readonly LineStyling[], cutBack: ReadonlySet<number>): string[][] {
  return fixes.map((fix, i) => describeStyling(fix, styling[i], cutBack.has(fix.boxIndex)));
}

/**
 * Where every attribute range goes, and so what each fix does to the styling
 * on its line, or why the edit cannot be made: ranges that cannot be moved
 * without a guess, or a document the edit cannot be planned in. A workspace
 * document is planned as itself, a `.pro` file from its decoded message.
 * Each surface says the refusal its own way; both refuse for exactly these.
 * A workspace document's structural `changes` are planned with its lines,
 * so a change it cannot take -- one that would need a new container -- is
 * refused here too, before anybody is asked.
 */
export function planStyling(
  source: { root: unknown } | { raw: RawDoc; doc: PresentationDoc },
  fixes: readonly LineFix[],
  changes: readonly StructureChange[] = []
): { styling?: string[][]; refusal?: AttributeRangeError | FixError } {
  try {
    if ("root" in source) {
      const edit = planWorkspaceEdit(source.root, fixes, changes);
      return { styling: stylingOf(fixes, edit.styling, new Set(edit.boxes.filter((b) => b.cutBack.length > 0).map((b) => b.boxIndex))) };
    }
    const planned = presentationRanges(source.raw, source.doc, fixes);
    return { styling: stylingOf(fixes, planned.styling, planned.cutBack) };
  } catch (e) {
    if (e instanceof AttributeRangeError || e instanceof FixError) return { refusal: e };
    throw e;
  }
}
