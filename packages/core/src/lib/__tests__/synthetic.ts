import protobuf from "protobufjs";
import descriptor from "../../generated/pp.descriptor.json";
import { decodePresentation, encodePresentation, readPresentation, textBoxAddresses } from "../presentation";

/**
 * A synthetic media-bin document, built rather than committed.
 *
 * Real ProPresenter files cannot be committed -- they are somebody's actual
 * media library -- so without this the suites that matter most only ran on a
 * machine that happened to have one, and skipped in CI. Generating the fixture
 * keeps it auditable (it is this file, not a binary blob) and guarantees it
 * contains nobody's data.
 *
 * It is deliberately shaped to contain one of everything the analysis cares
 * about, so the same assertions hold against it and against a real library:
 *
 * - nested groups, leaf playlists, and one empty playlist
 * - image and video items, with playback settings on a video
 * - a file appearing twice in one playlist with identical modifications
 *   (a true duplicate) and another spanning two playlists
 * - two files that each back several entries with *different* modifications
 *   (mirroring, and a colour effect) -- variants, not duplicates
 * - absolute paths under two different roots, as libraries accumulate when
 *   they move between machines
 * - one item on an external volume, one hidden item, and one filename still
 *   carrying ProPresenter's import UUID prefix
 */

const root = protobuf.Root.fromJSON(descriptor as protobuf.INamespace);
const PlaylistDocument = root.lookupType("rv.data.PlaylistDocument");

/** Deterministic UUIDs, so a failure names the same item every run. */
function uuid(seed: number): { string: string } {
  const hex = seed.toString(16).padStart(12, "0");
  return { string: `00000000-0000-4000-8000-${hex}` };
}

const WINDOWS_DOCUMENTS = "C:\\Users\\Video\\Documents\\ProPresenter\\Media";
const WINDOWS_APPDATA =
  "C:\\Users\\video\\AppData\\Roaming\\RenewedVision\\ProPresenter\\LocalWorkspaces\\ProPresenter\\Media";

interface ItemSpec {
  id: number;
  name: string;
  /** Path relative to the show folder, e.g. "Media/Assets/rose.jpg". */
  file: string;
  kind: "image" | "video";
  /** Which absolute root this item records. Libraries drift between these. */
  absoluteRoot?: string;
  hidden?: boolean;
  mirrored?: boolean;
  /** A colour effect, which makes this entry a variant of the same file. */
  colourEffect?: { name: string; brightness: number };
  /** Present for a video whose playback has been tuned away from defaults. */
  playback?: { transition: number; loop: boolean };
  /** An item resolved against a named drive rather than the show folder. */
  externalVolume?: string;
}

function url(spec: ItemSpec) {
  if (spec.externalVolume) {
    return {
      platform: "PLATFORM_WIN32",
      absolute_string: `E:\\${spec.file.replace(/\//g, "\\")}`,
      external: {
        win32: { drive_letter: "E", volume_name: spec.externalVolume },
        path: spec.file,
      },
    };
  }
  const base = spec.absoluteRoot ?? WINDOWS_DOCUMENTS;
  return {
    platform: "PLATFORM_WIN32",
    // Both forms are always present in real files, and they disagree about
    // where the library lives once it has moved. The analysis keys on the
    // relative form for exactly that reason.
    absolute_string: `${base}\\${spec.file.replace(/^Media\//, "").replace(/\//g, "\\")}`,
    local: { root: "ROOT_SHOW", path: spec.file },
  };
}

function drawing(spec: ItemSpec) {
  const effects = spec.colourEffect
    ? [
        {
          uuid: uuid(9000 + spec.id),
          enabled: true,
          name: spec.colourEffect.name,
          render_id: "colour",
          variables: [
            {
              name: "Brightness",
              float: { value: spec.colourEffect.brightness, default_value: 0 },
            },
          ],
        },
      ]
    : [];

  return {
    // Set on import rather than chosen, so it must not affect duplicate
    // identity -- every item carries it, including ones that differ elsewhere.
    scale_behavior: "BEHAVIOR_FILL",
    flipped_horizontally: spec.mirrored ?? false,
    effects,
  };
}

function element(spec: ItemSpec) {
  const shared = { uuid: uuid(8000 + spec.id), url: url(spec) };
  return spec.kind === "image"
    ? { ...shared, image: { drawing: drawing(spec) } }
    : { ...shared, video: { drawing: drawing(spec) } };
}

function mediaAction(spec: ItemSpec) {
  const media: Record<string, unknown> = {
    element: element(spec),
    layer_type: "LAYER_TYPE_BACKGROUND",
  };

  if (spec.kind === "image") {
    media.image = {};
  } else {
    media.video = spec.playback
      ? {
          playback_behavior: spec.playback.loop ? "PLAYBACK_BEHAVIOR_LOOP" : "PLAYBACK_BEHAVIOR_STOP",
          end_behavior: "END_BEHAVIOR_FADE_TO_BLACK",
        }
      : {};
  }

  if (spec.playback) media.transition_duration = spec.playback.transition;

  return { uuid: uuid(7000 + spec.id), media };
}

function item(spec: ItemSpec) {
  return {
    uuid: uuid(spec.id),
    name: spec.name,
    is_hidden: spec.hidden ?? false,
    cue: {
      uuid: uuid(6000 + spec.id),
      name: spec.name,
      isEnabled: true,
      actions: [mediaAction(spec)],
    },
  };
}

function playlist(id: number, name: string, specs: ItemSpec[]) {
  return {
    uuid: uuid(1000 + id),
    name,
    items: { items: specs.map(item) },
  };
}

function group(id: number, name: string, children: unknown[]) {
  return {
    uuid: uuid(2000 + id),
    name,
    playlists: { playlists: children },
  };
}

const ROSE = "Media/Assets/rose-gradient.jpg";
const HEARTS = "Media/Assets/hearts.jpg";
const BLUE_LOOP = "Media/Assets/blue-loop.mp4";

const GRADIENTS = playlist(1, "Gradients", [
  { id: 1, name: "Rose Gradient", file: ROSE, kind: "image" },
  // Byte-for-byte the same entry as above, in the same playlist: a genuine
  // duplicate, and the one finding most likely to be an actual mistake.
  { id: 2, name: "Rose Gradient", file: ROSE, kind: "image" },
  // Same file, recoloured. Different content despite the shared source.
  {
    id: 3,
    name: "Orange Gradient",
    file: ROSE,
    kind: "image",
    colourEffect: { name: "Adjust Color", brightness: 0.42 },
  },
  { id: 4, name: "Hearts Right", file: HEARTS, kind: "image" },
]);

const MOTION = playlist(2, "Motion", [
  {
    id: 5,
    name: "Blue Loop",
    file: BLUE_LOOP,
    kind: "video",
    playback: { transition: 0.5, loop: true },
  },
  // Same photograph as "Hearts Right", flipped. The pair a path-only
  // comparison would wrongly call a duplicate.
  { id: 6, name: "Hearts Left", file: HEARTS, kind: "image", mirrored: true },
  { id: 7, name: "Sunrise", file: "Media/Assets/sunrise.mp4", kind: "video" },
]);

const SEASONAL = playlist(3, "Seasonal", []);

const ANNOUNCEMENTS = playlist(4, "Announcements", [
  {
    id: 8,
    name: "Welcome",
    // ProPresenter's importer prefixes copied files with a bare UUID.
    file: "Media/Assets/3a80d6e7-b669-4c5d-9b13-f7f079daf4f3welcome.png",
    kind: "image",
  },
  { id: 9, name: "Notices", file: "Media/Assets/notices.jpg", kind: "image", hidden: true },
  {
    id: 10,
    name: "Roadshow",
    file: "Media/roadshow.mp4",
    kind: "video",
    externalVolume: "ROADSHOW",
  },
]);

const LOGOS = playlist(5, "Logos", [
  { id: 11, name: "Logo Dark", file: "Media/Assets/logo-dark.png", kind: "image" },
  {
    id: 12,
    name: "Logo Light",
    file: "Media/Assets/logo-light.png",
    kind: "image",
    absoluteRoot: WINDOWS_APPDATA,
  },
  // The same entry as in Motion: shared across playlists, which is normally
  // deliberate categorisation rather than a mistake.
  { id: 13, name: "Blue Loop", file: BLUE_LOOP, kind: "video" },
]);

const DOCUMENT = {
  application_info: {
    platform: "PLATFORM_WINDOWS",
    application: "APPLICATION_PROPRESENTER",
    application_version: { major_version: 21, minor_version: 4, patch_version: 2, build: "synthetic" },
  },
  type: "TYPE_MEDIA",
  root_node: {
    uuid: uuid(3000),
    name: "",
    playlists: {
      playlists: [
        group(1, "Backgrounds", [GRADIENTS, MOTION, SEASONAL]),
        ANNOUNCEMENTS,
        LOGOS,
      ],
    },
  },
  // Real files carry this alongside root_node; it must survive a re-encode.
  live_video_playlist: { uuid: uuid(4000), name: "Live Video", items: { items: [] } },
};

/**
 * A document of a different playlist kind.
 *
 * Lets the wrong-kind path be exercised without needing a real Library file,
 * and stands in for the presentation tool that will eventually read these.
 */
const PRESENTATION_DOCUMENT = {
  application_info: DOCUMENT.application_info,
  type: "TYPE_PRESENTATION",
  root_node: {
    uuid: uuid(5000),
    name: "",
    playlists: { playlists: [playlist(9, "Sunday", [])] },
  },
};

/**
 * A presentation whose text carries one of each problem worth reporting.
 *
 * Built rather than committed for the same reason as the media document, and
 * shaped so the checks have something to find: a leading space, a trailing
 * space, a gap between two full lines, a doubled space, and -- deliberately --
 * an empty placeholder box, which must *not* be reported.
 */
function rtfDocument(body: string): Uint8Array {
  const header =
    "{\\rtf0\\ansi\\ansicpg1252{\\fonttbl\\f0\\fnil ArialMT;}" +
    "{\\colortbl;\\red0\\green0\\blue0;}{\\*\\listtable}\\uc1\\pard\\f0\\fs100";
  return new TextEncoder().encode(`${header}${body}}`);
}

function textSlide(id: number, cueName: string, body: string) {
  return {
    uuid: uuid(20000 + id),
    name: cueName,
    isEnabled: true,
    actions: [
      {
        uuid: uuid(21000 + id),
        type: "ACTION_TYPE_PRESENTATION_SLIDE",
        slide: {
          presentation: {
            base_slide: {
              uuid: uuid(22000 + id),
              elements: [
                {
                  element: {
                    uuid: uuid(23000 + id),
                    name: "Text",
                    text: { rtf_data: rtfDocument(body) },
                  },
                },
              ],
            },
          },
        },
      },
    ],
  };
}

const TEXT_PRESENTATION = {
  application_info: DOCUMENT.application_info,
  uuid: uuid(24000),
  name: "Checked Song",
  cues: [
    textSlide(1, "Clean", "\\cb3 A tidy line\\par\\pard\\cb3 And another"),
    textSlide(2, "Leading", "\\cb3 Fine here\\par\\pard\\cb3  leading space"),
    textSlide(3, "Trailing", "\\cb3 trailing space \\par\\pard\\cb3 Fine"),
    // A blank line with nothing but formatting, between two real lines.
    textSlide(4, "Gap", "\\cb3 Above\\par\\pard\\li0\\qc\\fs200\\par\\pard\\cb3 Below"),
    textSlide(5, "Doubled", "\\cb3 two  spaces here"),
    // An empty placeholder: must be counted, never reported as an issue.
    textSlide(6, "Empty", "\\cb3"),
    // Two ways a line can end with a comma, neither of which is also a
    // whitespace problem -- so the comma counts stay independent of them.
    textSlide(
      7,
      "Comma",
      "\\cb3 Que ton nom,\\par\\pard\\cb3 pour toujours ,\\par\\pard\\cb3 sois glorifie"
    ),
    // The other two marks a line can end with, and the two ways a line can end
    // in dots without ending in a full stop -- an ellipsis is a line running
    // on into the next slide, which is the opposite of the finding.
    textSlide(
      8,
      "Punctuation",
      "\\cb3 Tu es saint;\\par\\pard\\cb3 je te loue.\\par\\pard\\cb3 et je chanterai\\u8230 ?" +
        "\\par\\pard\\cb3 Gloire..."
    ),
  ],
  cue_groups: [
    {
      group: { uuid: uuid(25000), name: "Verse" },
      cue_identifiers: [uuid(20001), uuid(20002)],
    },
    {
      group: { uuid: uuid(25001), name: "Chorus" },
      cue_identifiers: [
        uuid(20003),
        uuid(20004),
        uuid(20005),
        uuid(20006),
        uuid(20007),
        uuid(20008),
      ],
    },
  ],
};

const cachedTextPresentations = new Map<string, Uint8Array>();

/**
 * A presentation with known text problems, for the checker's tests.
 *
 * Takes a name because a presentation's own name is not its filename, and
 * anything that orders or labels a list of them needs two files that differ by
 * one and not the other.
 */
export function syntheticTextPresentation(name = "Checked Song"): Uint8Array {
  const existing = cachedTextPresentations.get(name);
  if (existing) return existing;

  const Presentation = root.lookupType("rv.data.Presentation");
  const bytes = Presentation.encode(
    Presentation.fromObject({ ...TEXT_PRESENTATION, name })
  ).finish();
  cachedTextPresentations.set(name, bytes);
  return bytes;
}

let cachedPresentation: Uint8Array | undefined;

/** A presentation playlist document, for testing kind rejection. */
export function syntheticPresentationFile(): Uint8Array {
  cachedPresentation ??= PlaylistDocument.encode(
    PlaylistDocument.fromObject(PRESENTATION_DOCUMENT)
  ).finish();
  return cachedPresentation;
}

let cached: Uint8Array | undefined;

/** The synthetic document, encoded as ProPresenter would write it. */
export function syntheticMediaFile(): Uint8Array {
  cached ??= PlaylistDocument.encode(PlaylistDocument.fromObject(DOCUMENT)).finish();
  return cached;
}

/** Counts the tests assert against, kept next to the data that produces them. */
export const SYNTHETIC = {
  items: 13,
  playlistsWithItems: 4,
  emptyPlaylists: 1,
  video: 4,
  image: 9,
};

/**
 * A minimal RTF document with the header ProPresenter actually writes, for
 * tests that work on the RTF itself rather than on a presentation.
 */
export function rtfWithHeader(body: string, uc = "\\uc1"): string {
  return (
    "{\\rtf0\\ansi\\ansicpg1252{\\fonttbl\\f0\\fnil ArialMT;}" +
    "{\\colortbl;\\red0\\green0\\blue0;}" +
    "{\\*\\expandedcolortbl;\\csgenericrgb\\c0\\c0\\c0\\c100000;}" +
    `{\\*\\listtable}{\\*\\listoverridetable}${uc}\\pard\\f0\\fs100` +
    body +
    "}"
  );
}

/** Every text box's lines in a presentation, as the checker reads them. */
export function textLines(bytes: Uint8Array): string[][] {
  return readPresentation(decodePresentation(bytes)).textBoxes.map((box) => box.lines.map((line) => line.text));
}

/** Macros as ProPresenter's own list holds them: lower-case uuids in a `Configuration/Macros` file. */
export const MACROS = {
  bienvenue: { name: "Bienvenue", uuid: "9534cc41-0000-4000-8000-000000000001" },
  louange: { name: "Louange", uuid: "09ca4bc0-0000-4000-8000-000000000002" },
  lumieres: { name: "Lumières", uuid: "f94ec992-0000-4000-8000-000000000003" },
} as const;

const macroAction = (id: number, macro: { name: string; uuid: string }, enabled = true) => ({
  uuid: uuid(26000 + id),
  name: macro.name,
  isEnabled: enabled,
  type: "ACTION_TYPE_MACRO",
  macro: { identification: { parameter_uuid: { string: macro.uuid }, parameter_name: macro.name } },
});

let cachedMacroSong: Uint8Array | undefined;

/**
 * The checked song with a macro on its slides, the way a church library
 * carries them: "Bienvenue" on the first, "Louange" on the rest, one slide
 * with a second, switched-off macro and one with none. Its first group is
 * named `Couplet` + non-breaking space + `1`, which looks exactly like the
 * configured `Couplet 1` and is not it.
 */
export function syntheticMacroSong(): Uint8Array {
  if (cachedMacroSong) return cachedMacroSong;
  const doc = decodePresentation(syntheticTextPresentation("Macro Song")) as any;
  const byName = new Map(doc.cues.map((cue: any) => [cue.name, cue]));
  const add = (cueName: string, ...actions: unknown[]) => (byName.get(cueName) as any).actions.push(...actions);
  add("Clean", macroAction(1, MACROS.bienvenue));
  for (const [i, cueName] of ["Leading", "Trailing", "Gap", "Doubled", "Comma"].entries()) {
    add(cueName, macroAction(10 + i, MACROS.louange));
  }
  add("Gap", macroAction(20, MACROS.lumieres, false));
  // "Empty" and "Punctuation" have none.
  doc.cue_groups[0].group.name = "Couplet 1";
  const Presentation = root.lookupType("rv.data.Presentation");
  cachedMacroSong = Presentation.encode(doc).finish();
  return cachedMacroSong;
}

/** ProPresenter's configured groups, two of them told apart only by the kind of space. */
export const CONFIGURED_GROUPS = [
  { uuid: { string: "a7ed11a5-0000-4000-8000-000000000001" }, name: "Couplet 1", color: { red: 0, green: 0.4, blue: 0.8, alpha: 1 } },
  { uuid: { string: "c3fdfda2-0000-4000-8000-000000000002" }, name: "Couplet 4", color: { red: 0, green: 0.2, blue: 0.3, alpha: 1 } },
  { uuid: { string: "143b5f28-0000-4000-8000-000000000003" }, name: "Refrain", color: { red: 1, green: 0.27, blue: 0, alpha: 0.5 } },
];

/** A `Configuration/Groups` file. */
export function syntheticGroupsFile(): Uint8Array {
  const type = root.lookupType("rv.data.ProGroupsDocument");
  return type.encode(type.fromObject({ groups: CONFIGURED_GROUPS })).finish();
}

/**
 * A `Configuration/Macros` file, laid out as a real one: every macro at the
 * top, and each collection naming its own by uuid. "Lumières" is in no
 * collection, and "Louange" in two.
 */
export function syntheticMacrosFile(): Uint8Array {
  const type = root.lookupType("rv.data.MacrosDocument");
  const id = (macro: { uuid: string }) => ({ macro_id: { string: macro.uuid } });
  return type
    .encode(
      type.fromObject({
        macros: [MACROS.bienvenue, MACROS.louange, MACROS.lumieres].map((macro, i) => ({
          uuid: { string: macro.uuid },
          name: macro.name,
          color: { red: 0.3, green: 0.2, blue: 0.7, alpha: 1 },
          actions: [{ uuid: uuid(26030 + i), name: "Clear", isEnabled: true, type: "ACTION_TYPE_CLEAR", clear: { target_layer: 1 } }],
        })),
        macro_collections: [
          { uuid: uuid(27000), name: "Default Collection", items: [id(MACROS.bienvenue), id(MACROS.louange)] },
          // Upper-case, as a uuid can be written anywhere: still the same macro.
          { uuid: uuid(27001), name: "Louange", items: [{ macro_id: { string: MACROS.louange.uuid.toUpperCase() } }] },
        ],
      })
    )
    .finish();
}

/** All Caps over each line on its own, as ProPresenter records it: one range to a line. */
export function capsByLine(lines: readonly string[]): object[] {
  let at = 0;
  return lines.map((line) => {
    const range = { start: at, end: at + line.length };
    at = range.end + 1;
    return { range, capitalization: "CAPITALIZATION_ALL_CAPS" };
  });
}

/** A presentation with these attribute ranges on some of its text boxes, by box. */
export function withAttributes(bytes: Uint8Array, byBox: Record<number, object[]>): Uint8Array {
  const Attributes = root.lookupType("rv.data.Graphics.Text.Attributes");
  const doc = decodePresentation(bytes);
  for (const { boxIndex, cueUuid, actionIndex, elementIndex } of textBoxAddresses(doc)) {
    if (!byBox[boxIndex]) continue;
    const cue = doc.cues.find((c: any) => c.uuid?.string === cueUuid);
    const { text } = cue.actions[actionIndex].slide.presentation.base_slide.elements[elementIndex].element;
    text.attributes = Attributes.fromObject({ custom_attributes: byBox[boxIndex] });
  }
  return encodePresentation(doc);
}

/** Whether index `i` of `s` falls between the two halves of a surrogate pair. */
export function insidePair(s: string, i: number): boolean {
  return /[\uD800-\uDBFF]$/.test(s.slice(0, i)) && /^[\uDC00-\uDFFF]/.test(s.slice(i));
}
