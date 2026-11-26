import { rgbaOf, type ConfiguredGroup, type ConfiguredMacro, type Rgba } from "./configuration";
import { messageType, type RawDoc } from "./decode";
import { formatColor } from "./model";
import { slidesInOrder } from "./presentation";
import { hasLineControl } from "./rtf-edit";

/**
 * A presentation's structure, and the changes to it that are not slide text:
 * a group renamed, one macro on a slide swapped for another.
 *
 * Text is lines in boxes; structure is everything a person arranging a song
 * sees around them -- its groups, the order of its slides, its arrangements,
 * and the macros each slide triggers. A structural change is planned here
 * from the decoded message, as a text fix is, and carried out by the same
 * writers: `applyFixes()` for a `.pro` file, and the workspace staging for a
 * ProPresenter 22 document, which says each change again in the Loro
 * document's terms (`workspace-edit.ts`).
 *
 * Guard 4 reads the *whole* structure back, not the changed part: every
 * group, every slide in order, every arrangement and every macro on every
 * slide must come back as the plan promised, and the untouched ones as they
 * were. `readStructure()` is what is compared, so whatever it holds is held
 * to account by every write, a text-only one included.
 *
 * Every structural change here sets values on messages that are already
 * there: none creates a message, so none would create a container in a
 * workspace document. Where one would have to, it is refused.
 */

/** Which configured group a song's group is tied to: `application_group_identifier` and `application_group_name`. */
export interface GroupLink {
  uuid?: string;
  name?: string;
}

/** What renaming a group can change about it. */
export interface GroupLook {
  name: string;
  /** Unset for a group that stores no colour. */
  color?: Rgba;
  /** Unset for a group tied to no configured group. */
  link?: GroupLink;
}

export interface StructureGroup extends GroupLook {
  uuid?: string;
  /** The slides it holds, by cue uuid, in its own order. */
  cues: (string | undefined)[];
}

/** A macro as a slide records it: `macro.identification` on one of its actions. */
export interface MacroRef {
  uuid?: string;
  /** The name the slide recorded, which can be older than the configured one. */
  name: string;
  /** The collection the slide records the macro as being in, when it records one. */
  collection?: { uuid?: string; name: string };
  /** The action's own name, which ProPresenter sets to the macro's. */
  actionName: string;
}

export interface SlideMacroAction extends MacroRef {
  /** Position among the cue's actions. */
  actionIndex: number;
  enabled: boolean;
}

export interface StructureSlide {
  cueUuid?: string;
  /** Position of its group in the stored group order; unset for a cue no group places. */
  groupIndex?: number;
  macros: SlideMacroAction[];
}

export interface StructureArrangement {
  uuid?: string;
  name: string;
  /** Group uuids, in the arrangement's order, a group repeated as often as it is sung. */
  groups: (string | undefined)[];
}

/** Everything about a presentation that is not slide text, as guard 4 compares it. */
export interface PresentationStructure {
  /** In the stored group order. */
  groups: StructureGroup[];
  /** In ProPresenter's order, as `readPresentation` numbers them. */
  slides: StructureSlide[];
  arrangements: StructureArrangement[];
}

const uuidOf = (message: any): string | undefined => message?.string || undefined;

function lookOf(group: any): GroupLook {
  const uuid = uuidOf(group?.application_group_identifier);
  const name: string | undefined = group?.application_group_name || undefined;
  return {
    name: group?.name ?? "",
    ...(group?.color && { color: rgbaOf(group.color) }),
    ...((uuid || name) && { link: { uuid, name } }),
  };
}

/** Every macro a cue triggers, with where it sits among the cue's actions. */
function macroActions(cue: any): SlideMacroAction[] {
  return (cue.actions ?? []).flatMap((action: any, actionIndex: number) => {
    if (!action?.macro) return [];
    const id = action.macro.identification;
    const parent = id?.parent_collection;
    return [
      {
        actionIndex,
        uuid: uuidOf(id?.parameter_uuid),
        name: id?.parameter_name ?? "",
        ...(parent && { collection: { uuid: uuidOf(parent.parameter_uuid), name: parent.parameter_name ?? "" } }),
        actionName: action.name ?? "",
        enabled: action.isEnabled === true,
      },
    ];
  });
}

/** A presentation's structure, from its decoded message (or a workspace document converted to one). */
export function readStructure(raw: RawDoc): PresentationStructure {
  const doc = raw as any;
  return {
    groups: (doc.cue_groups ?? []).map((entry: any) => ({
      uuid: uuidOf(entry?.group?.uuid),
      ...lookOf(entry?.group),
      cues: (entry?.cue_identifiers ?? []).map(uuidOf),
    })),
    slides: slidesInOrder(raw).map(({ cue, groupIndex }) => ({
      cueUuid: uuidOf(cue.uuid),
      ...(groupIndex !== undefined && { groupIndex }),
      macros: macroActions(cue),
    })),
    arrangements: (doc.arrangements ?? []).map((arrangement: any) => ({
      uuid: uuidOf(arrangement?.uuid),
      name: arrangement?.name ?? "",
      groups: (arrangement?.group_identifiers ?? []).map(uuidOf),
    })),
  };
}

export interface GroupRename {
  kind: "renameGroup";
  /** In the stored group order. */
  groupIndex: number;
  groupUuid?: string;
  /** The slides the group holds, for showing the change among them. */
  slides: number[];
  before: GroupLook;
  after: GroupLook;
}

export interface MacroSwap {
  kind: "swapMacro";
  slideIndex: number;
  cueUuid: string;
  /** Position among the cue's actions. */
  actionIndex: number;
  /** Position among the slide's macros, as a slide's macros are listed. */
  macroIndex: number;
  groupName?: string;
  before: MacroRef;
  after: MacroRef;
}

/** A change to a presentation that is not slide text. */
export type StructureChange = GroupRename | MacroSwap;

/** A structural change as asked for, by a model or a person, before it is planned. */
export type StructureRequest =
  | { kind: "renameGroup"; groupIndex: number; name: string }
  /** `from` names a macro on the slide, `to` a configured macro, each by name or uuid. */
  | { kind: "swapMacro"; slideIndex: number; from: string; to: string };

/**
 * Why a structural change could not be planned.
 *
 * - `noSuchGroup`, `noSuchSlide`: the presentation has no such group or slide.
 * - `duplicate`: two changes name the same group, or the same macro on a slide.
 * - `unchanged`: the group or the macro is already what was asked for.
 * - `badName`: an empty name, or one holding a line break or another control character.
 * - `noSuchMacro`: the slide triggers no macro by that name or uuid.
 * - `ambiguousMacro`: the slide triggers it twice, or two configured macros go by that name.
 * - `noGroupList`: ProPresenter's configured groups could not be read, so whether the new name brings a colour or a tie cannot be told.
 * - `ambiguousGroup`: two configured groups go by the new name.
 * - `groupTie`: the group is tied to a configured group, and the configured group of the new name has no uuid to tie it to.
 * - `noMacroList`: ProPresenter's configured macros could not be read, so no macro can be put on a slide.
 * - `noIdentification`: the slide's macro records no uuid or name of its own to replace.
 * - `unknownMacro`: no configured macro has that name or uuid.
 * - `macroCollection`: the slide records which collection its macro is in, and the new macro is in none that has a uuid.
 */
export type StructureRefusal =
  | "noSuchGroup"
  | "noSuchSlide"
  | "duplicate"
  | "unchanged"
  | "badName"
  | "noSuchMacro"
  | "ambiguousMacro"
  | "noMacroList"
  | "noGroupList"
  | "ambiguousGroup"
  | "groupTie"
  | "noIdentification"
  | "unknownMacro"
  | "macroCollection";

export class StructureError extends Error {
  readonly reason: StructureRefusal;
  readonly request: StructureRequest;

  constructor(reason: StructureRefusal, request: StructureRequest) {
    super(`${reason}: ${JSON.stringify(request)}`);
    this.name = "StructureError";
    this.reason = reason;
    this.request = request;
  }
}

/** The configured lists a structural change is planned against. */
export interface StructureConfiguration {
  groups?: readonly ConfiguredGroup[];
  macros?: readonly ConfiguredMacro[];
}

const sameUuid = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * `value` in the case `model` is written in. A `.pro` file writes uuids
 * lower-case and a workspace upper-case, so a uuid copied in follows the one
 * it replaces; with nothing to follow, the configured list's own spelling,
 * which is the same format's.
 */
function caseLike(model: string | undefined, value: string): string {
  if (!model || model.toLowerCase() === model.toUpperCase()) return value;
  if (model === model.toUpperCase()) return value.toUpperCase();
  if (model === model.toLowerCase()) return value.toLowerCase();
  return value;
}

/**
 * Plan structural changes, all or nothing, as `planLineEdits` plans text:
 * one change that cannot be planned refuses the lot. Throws `StructureError`.
 *
 * A group is renamed to exactly the name given, a non-breaking space kept.
 * When that is the name of a configured group, the group takes that group's
 * colour, and if it was tied to a configured group it is tied to that one
 * instead; when it is not, a tie it had is cut, since it would name a group
 * this one no longer is. A group's uuid never changes, so the arrangements,
 * which name groups by uuid, keep it wherever it was.
 *
 * A macro is swapped for a configured one: the slide records the new
 * macro's uuid and name, and the collection the configured list has it in
 * where the slide recorded one for the old macro.
 */
export function planStructure(
  raw: RawDoc,
  requests: readonly StructureRequest[],
  config: StructureConfiguration
): StructureChange[] {
  const structure = readStructure(raw);
  const seen = new Set<string>();
  const once = (key: string, request: StructureRequest) => {
    if (seen.has(key)) throw new StructureError("duplicate", request);
    seen.add(key);
  };
  const doc = raw as any;

  return requests.map((request): StructureChange => {
    if (request.kind === "renameGroup") {
      const group = structure.groups[request.groupIndex];
      if (!group || !doc.cue_groups?.[request.groupIndex]?.group) throw new StructureError("noSuchGroup", request);
      once(`group:${request.groupIndex}`, request);
      if (request.name.trim() === "" || hasLineControl(request.name)) throw new StructureError("badName", request);
      // Without the list, a rename cannot know whether the name brings a colour or a tie, and would cut a tie it should move.
      if (!config.groups?.length) throw new StructureError("noGroupList", request);
      const named = config.groups.filter((g) => g.name === request.name);
      if (named.length > 1) throw new StructureError("ambiguousGroup", request);
      const configured = named[0];
      const before: GroupLook = lookOf(doc.cue_groups[request.groupIndex].group);
      if (before.link && configured && !configured.uuid) throw new StructureError("groupTie", request);
      const color = configured?.rgba ?? before.color;
      const link = before.link && configured?.uuid ? { uuid: caseLike(before.link.uuid, configured.uuid), name: configured.name } : undefined;
      const after: GroupLook = { name: request.name, ...(color && { color }), ...(link && { link }) };
      if (canonical(before) === canonical(after)) throw new StructureError("unchanged", request);
      return {
        kind: "renameGroup",
        groupIndex: request.groupIndex,
        groupUuid: group.uuid,
        slides: groupSlides(structure, request.groupIndex),
        before,
        after,
      };
    }

    const slide = structure.slides[request.slideIndex];
    if (!slide?.cueUuid) throw new StructureError("noSuchSlide", request);
    // By the name a slide's macros are listed under, which falls back to the action's own as `readPresentation` does.
    const matching = slide.macros.filter((m) => (m.name || m.actionName) === request.from || sameUuid(m.uuid, request.from));
    if (matching.length === 0) throw new StructureError("noSuchMacro", request);
    if (matching.length > 1) throw new StructureError("ambiguousMacro", request);
    const old = matching[0];
    const cue = doc.cues?.find((c: any) => uuidOf(c?.uuid) === slide.cueUuid);
    if (!cue?.actions?.[old.actionIndex]?.macro?.identification) throw new StructureError("noIdentification", request);
    once(`macro:${request.slideIndex}:${old.actionIndex}`, request);
    if (!config.macros?.length) throw new StructureError("noMacroList", request);
    const targets = config.macros.filter((m) => m.name === request.to || sameUuid(m.uuid, request.to));
    if (targets.length > 1) throw new StructureError("ambiguousMacro", request);
    const target = targets[0];
    if (!target?.uuid) throw new StructureError("unknownMacro", request);
    if (sameUuid(target.uuid, old.uuid) && target.name === old.name) throw new StructureError("unchanged", request);

    let collection: MacroRef["collection"];
    if (old.collection) {
      // The one it was in, if the new macro is in it too; otherwise the first it is in.
      const ref = target.collectionRefs?.find((c) => sameUuid(c.uuid, old.collection!.uuid)) ?? target.collectionRefs?.find((c) => c.uuid);
      if (!ref?.uuid) throw new StructureError("macroCollection", request);
      collection = { uuid: caseLike(old.collection.uuid, ref.uuid), name: ref.name };
    }
    const { actionIndex, enabled: _enabled, ...before } = old;
    return {
      kind: "swapMacro",
      slideIndex: request.slideIndex,
      cueUuid: slide.cueUuid,
      actionIndex,
      macroIndex: slide.macros.indexOf(old),
      groupName: slide.groupIndex === undefined ? undefined : structure.groups[slide.groupIndex]?.name || undefined,
      before,
      after: {
        uuid: caseLike(old.uuid, target.uuid),
        name: target.name,
        ...(collection && { collection }),
        // ProPresenter names a macro's action after the macro; one renamed by hand keeps its own name.
        actionName: old.actionName === old.name ? target.name : old.actionName,
      },
    };
  });
}

/** The slides a group holds, by their place in ProPresenter's order. */
export const groupSlides = (structure: PresentationStructure, groupIndex: number) =>
  structure.slides.flatMap((slide, i) => (slide.groupIndex === groupIndex ? [i] : []));

/** Whether the change still describes the presentation as it reads now. */
export function isCurrent(structure: PresentationStructure, change: StructureChange): boolean {
  if (change.kind === "renameGroup") {
    const group = structure.groups[change.groupIndex];
    if (!group || group.uuid !== change.groupUuid) return false;
    const { uuid: _uuid, cues: _cues, ...look } = group;
    return canonical(look) === canonical(change.before);
  }
  const slide = structure.slides[change.slideIndex];
  const macro = slide?.cueUuid === change.cueUuid ? slide.macros.find((m) => m.actionIndex === change.actionIndex) : undefined;
  if (!macro) return false;
  const { actionIndex: _actionIndex, enabled: _enabled, ...ref } = macro;
  return canonical(ref) === canonical(change.before);
}

/** The structure as it should read once the changes are in, everything else exactly as it was. */
export function expectStructure(structure: PresentationStructure, changes: readonly StructureChange[]): PresentationStructure {
  const out: PresentationStructure = structuredClone(structure);
  for (const change of changes) {
    if (change.kind === "renameGroup") {
      const { uuid, cues } = out.groups[change.groupIndex];
      out.groups[change.groupIndex] = { uuid, ...structuredClone(change.after), cues };
      continue;
    }
    const macros = out.slides[change.slideIndex].macros;
    const at = macros.findIndex((m) => m.actionIndex === change.actionIndex);
    macros[at] = { actionIndex: change.actionIndex, ...structuredClone(change.after), enabled: macros[at].enabled };
  }
  return out;
}

/** Whether two structures are the same, whatever order their objects' keys were written in. */
export function sameStructure(a: PresentationStructure, b: PresentationStructure): boolean {
  return canonical(a) === canonical(b);
}

/**
 * One spelling of a value, keys in order and unset fields left out, to
 * compare two by. Not `stableJson()` in `workspace-edit.ts`, which spells
 * bytes too: that file imports this one, and a structure holds no bytes.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v
  );
}

const sameColor = (a: Rgba | undefined, b: Rgba | undefined) => canonical(a) === canonical(b);

/**
 * Make the changes in a decoded message, leaving every other field as it
 * is. The caller has checked each is current (`isCurrent`), and reads the
 * result back against `expectStructure`.
 */
export function applyStructure(raw: RawDoc, changes: readonly StructureChange[]): void {
  const doc = raw as any;
  const Color = messageType("rv.data.Color");
  const UUID = messageType("rv.data.UUID");
  for (const change of changes) {
    if (change.kind === "renameGroup") {
      const group = doc.cue_groups[change.groupIndex].group;
      group.name = change.after.name;
      if (change.after.color && !sameColor(change.after.color, change.before.color)) group.color = Color.fromObject(change.after.color);
      if (change.after.link) {
        group.application_group_identifier = change.after.link.uuid ? UUID.fromObject({ string: change.after.link.uuid }) : null;
        group.application_group_name = change.after.link.name ?? "";
      } else if (change.before.link) {
        delete group.application_group_identifier;
        delete group.application_group_name;
      }
      continue;
    }
    const cue = doc.cues.find((c: any) => uuidOf(c?.uuid) === change.cueUuid);
    const action = cue.actions[change.actionIndex];
    const id = action.macro.identification;
    id.parameter_uuid = UUID.fromObject({ string: change.after.uuid });
    id.parameter_name = change.after.name;
    if (change.after.collection) {
      id.parent_collection.parameter_uuid = UUID.fromObject({ string: change.after.collection.uuid });
      id.parent_collection.parameter_name = change.after.collection.name;
    }
    action.name = change.after.actionName;
  }
}

/** A colour in words, as the configured list's is shown. */
export const colorName = (color: Rgba | undefined) => (color ? formatColor(color) : "none");
