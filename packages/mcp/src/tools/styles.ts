import { type Fidelity } from "@presenter-garage/core/lib/decode";
import {
  planStyle,
  presentationStyle,
  StyleError,
  styleSlots,
  themeStyles,
  type SkipReason,
  type SlideStyle,
  type StyleOptions,
} from "@presenter-garage/core/lib/style";
import { checkPresentationFidelity } from "@presenter-garage/core/lib/presentation";
import { fold } from "@presenter-garage/core/lib/search";
import { findThemes, LibraryError, readFoundFile, readLibraryFile } from "@presenter-garage/node/library";
import { open } from "@presenter-garage/node/presentations";
import { fidelityOf } from "./fidelity";

/** Themes and slide styles: `list_themes` and `preview_style`. */

/** A `StyleError` in words a model can act on; anything else is not ours to explain. */
function styleProblem(e: unknown, source: string): unknown {
  if (!(e instanceof StyleError)) return e;
  switch (e.code) {
    case "lossy":
      return new LibraryError(`${source}: would not survive being written back, so its look is not copied.`);
    case "noSuchSlide":
      return new LibraryError(`${source} has no slide ${e.params.slide} (slideIndex ${Number(e.params.slide) - 1}).`);
    case "noTextBox":
      return new LibraryError(`The style "${e.params.style}" has no text box to put words in.`);
    default:
      return new LibraryError(`${source}: ${e.message}`);
  }
}

/** A theme's styles, or why they cannot be read, as a `LibraryError` naming `source`. */
function readThemeStyles(bytes: Uint8Array, source: string): SlideStyle[] {
  try {
    return themeStyles(bytes);
  } catch (e) {
    if (e instanceof StyleError) throw styleProblem(e, source);
    throw new LibraryError(`${source}: not a ProPresenter theme (${(e as Error).message}).`);
  }
}

/**
 * The slide styles each theme offers, in the theme's own order.
 *
 * A theme that cannot be read is named with why rather than left out, so an
 * absent theme is never mistaken for one that is not there.
 */
export async function listThemes(roots: readonly string[]) {
  const themes: { name: string; path: string; styles: { styleIndex: number; name: string; textBoxes: number }[] }[] = [];
  const unreadable: { path: string; reason: string }[] = [];
  for (const { name, file } of await findThemes(roots)) {
    try {
      const styles = readThemeStyles((await readFoundFile(file)).bytes, name);
      themes.push({
        name,
        path: file,
        styles: styles.map((style, styleIndex) => ({ styleIndex, name: style.name, textBoxes: styleSlots(style) })),
      });
    } catch (e) {
      unreadable.push({ path: file, reason: (e as Error).message });
    }
  }
  return { themes, unreadable };
}

export interface StyleSource {
  /** A theme's name, as `list_themes` gives it, or the path of its `Theme` file. */
  theme?: string;
  /** A presentation whose slide's look is copied. */
  fromPresentation?: string;
  /** With `theme`: the style's name or `styleIndex`. With `fromPresentation`: the slide's `slideIndex`. */
  style?: string | number;
}

async function loadThemeStyle(roots: readonly string[], theme: string, style: string | number | undefined) {
  const wanted = fold(theme);
  const named = (await findThemes(roots)).find((t) => fold(t.name) === wanted);
  let bytes: Uint8Array;
  try {
    ({ bytes } = await readLibraryFile(roots, named?.file ?? theme));
  } catch (e) {
    if (named || !(e instanceof LibraryError)) throw e;
    throw new LibraryError(`No theme named "${theme}". \`list_themes\` lists the themes there are.`);
  }

  const styles = readThemeStyles(bytes, theme);
  const names = styles.map((s, i) => `${i}: ${s.name}`).join(", ");
  if (style === undefined) {
    if (styles.length === 1) return styles[0];
    throw new LibraryError(`Theme "${theme}" has ${styles.length} styles; pass \`style\` as a name or styleIndex: ${names}.`);
  }
  const found = typeof style === "number" ? styles[style] : styles.find((s) => fold(s.name) === fold(style));
  if (!found) throw new LibraryError(`No style ${JSON.stringify(style)} in theme "${theme}". It has: ${names}.`);
  return found;
}

async function loadStyle(roots: readonly string[], { theme, fromPresentation, style }: StyleSource): Promise<SlideStyle> {
  if (!theme === !fromPresentation) throw new LibraryError("Give exactly one of `theme` and `fromPresentation`.");
  if (theme) return loadThemeStyle(roots, theme, style);

  if (typeof style !== "number") {
    throw new LibraryError("With `fromPresentation`, `style` is the slideIndex of the slide to copy, as read_presentation gives it.");
  }
  const { bytes } = await readLibraryFile(roots, fromPresentation!);
  open(fromPresentation!, bytes);
  try {
    return presentationStyle(bytes, style);
  } catch (e) {
    throw styleProblem(e, fromPresentation!);
  }
}

export interface StylePreview {
  path: string;
  style: string;
  /** Whether the presentation would survive being written back. Applying is refused when it would not. */
  fidelity: Fidelity;
  restyled: number;
  leftAlone: number;
  slides: {
    slideIndex: number;
    label: string;
    group?: string;
    macros?: string[];
    /** Why the slide would be left alone, when it would. */
    skip?: SkipReason;
    /**
     * The text each of the style's boxes would carry afterwards, filled in
     * order. No `boxIndex`: the boxes are the style's, not the slide's own.
     */
    textBoxes: { lines: string[] }[];
  }[];
}

/**
 * What giving a presentation's slides another slide's look would do, without
 * doing it: which slides would change, which would be left alone and why, and
 * the text each would carry.
 *
 * The plan `applyStyle` itself follows and then checks its result against, so
 * the preview and a later write cannot disagree. There is no write here: that
 * would be a fifth write path, and AGENTS.md says what one has to keep.
 */
export async function previewStyle(
  roots: readonly string[],
  { path: file, theme, fromPresentation, style, ...options }: StyleSource & StyleOptions & { path: string }
): Promise<StylePreview> {
  const { path: real, bytes, converted } = await readLibraryFile(roots, file);
  const { raw } = open(file, bytes);
  const slideStyle = await loadStyle(roots, { theme, fromPresentation, style });

  let plan;
  try {
    plan = planStyle(raw, slideStyle, options);
  } catch (e) {
    throw styleProblem(e, file);
  }
  const restyled = plan.filter((slide) => !slide.skip).length;
  return {
    path: real,
    style: slideStyle.name,
    fidelity: fidelityOf(converted, checkPresentationFidelity(bytes).fidelity),
    restyled,
    leftAlone: plan.length - restyled,
    slides: plan.map((slide) => ({
      slideIndex: slide.slideIndex,
      label: slide.cueName,
      group: slide.groupName,
      macros: slide.macros.length ? slide.macros : undefined,
      skip: slide.skip,
      textBoxes: slide.textBoxes.map((lines) => ({ lines })),
    })),
  };
}
