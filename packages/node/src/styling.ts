import type { LineFix } from "@presenter-garage/core/lib/fixes";
import { FixError } from "@presenter-garage/core/lib/fixes";
import {
  AttributeRangeError,
  planWorkspaceEdit,
  type LineStyling,
  type WorkspaceEdit,
} from "@presenter-garage/core/lib/workspace-edit";

/**
 * What an edit to a ProPresenter 22 workspace document does to the styling
 * on its lines, in words a person reads before choosing them, or why it
 * cannot be made at all.
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
    if (range.after === null) return `${name} on ${quote(range.before)} goes with the line`;
    if (range.before === fix.before && range.after === fix.after) return `${name} on the whole line, as before`;
    return `${name} on ${quote(range.before)} → on ${quote(range.after)}`;
  });
  if (cutBack) said.push("formatting that ran past the end of the text box is cut back to its end, which changes nothing visible");
  return said;
}

/** Each fix's styling in words, from the plan of its whole document. */
function stylingOf(edit: WorkspaceEdit, fixes: readonly LineFix[]): string[][] {
  return fixes.map((fix, i) => {
    const box = edit.boxes.find((b) => b.boxIndex === fix.boxIndex);
    return describeStyling(fix, edit.styling[i], (box?.cutBack.length ?? 0) > 0);
  });
}

/**
 * For a workspace document, what each fix does to its styling, or why the
 * edit cannot be made: ranges that cannot be moved without a guess, or a
 * document the edit cannot be planned in. Each surface says the refusal its
 * own way; both refuse for exactly these.
 */
export function planStyling(
  root: unknown,
  fixes: readonly LineFix[]
): { styling?: string[][]; refusal?: AttributeRangeError | FixError } {
  if (root === undefined) return {};
  try {
    return { styling: stylingOf(planWorkspaceEdit(root, fixes), fixes) };
  } catch (e) {
    if (e instanceof AttributeRangeError || e instanceof FixError) return { refusal: e };
    throw e;
  }
}
