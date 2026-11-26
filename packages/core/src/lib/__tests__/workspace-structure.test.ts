import { describe, expect, it } from "vitest";
import { decodeGroupsDocument, decodeMacrosDocument, readGroups, readMacros } from "../configuration";
import { FixError } from "../fixes";
import { decodePresentation, encodePresentation } from "../presentation";
import { planStructure, readStructure, type StructureConfiguration, type StructureRequest } from "../structure";
import { presentationFromWorkspace } from "../workspace";
import { checkWorkspaceEdit, editedRoot, planWorkspaceEdit, valueAt } from "../workspace-edit";
import { MACROS, syntheticGroupsFile, syntheticMacroSong, syntheticMacrosFile } from "./synthetic";
import { workspacePresentation } from "./workspace-fixtures";

/**
 * Structural changes said in a ProPresenter 22 document's own terms: values
 * set in maps it already has, a group reached through the tree of groups and
 * slides by its node's id. The Loro half is tested in `packages/node`.
 */

type Json = any;

const config: StructureConfiguration = {
  groups: readGroups(decodeGroupsDocument(syntheticGroupsFile())),
  macros: readMacros(decodeMacrosDocument(syntheticMacrosFile())),
};

/** The macro song as a workspace document, with what a test needs done to its message first. */
function document(edit?: (doc: Json) => void): Json {
  const doc = decodePresentation(syntheticMacroSong()) as Json;
  edit?.(doc);
  return workspacePresentation(encodePresentation(doc));
}

const plan = (root: Json, requests: StructureRequest[]) => planStructure(presentationFromWorkspace(root).message, requests, config);
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof FixError) return e.reason;
    throw e;
  }
  return undefined;
};

describe("a structural change in a workspace document", () => {
  it("renames a group by setting values on its node's map, and reads back as promised", () => {
    const root = document((doc) => (doc.cue_groups[1].group.color = { red: 0.5, green: 0.5, blue: 0.5, alpha: 1 }));
    const changes = plan(root, [{ kind: "renameGroup", groupIndex: 1, name: "Refrain" }]);
    const edit = planWorkspaceEdit(root, [], changes);
    const node = root.cue_group_placements[1];
    const group = ["cue_group_placements", { node: node.id }, "Kind", "group"];
    expect(edit.values).toEqual([
      { path: group, key: "name", value: "Refrain" },
      { path: [...group, "color"], key: "red", value: 1 },
      { path: [...group, "color"], key: "green", value: config.groups![2].rgba!.green },
      { path: [...group, "color"], key: "blue", value: 0 },
      { path: [...group, "color"], key: "alpha", value: 0.5 },
    ]);
    expect(valueAt(root, group)).toBe(node.meta.Kind.group);

    const after = editedRoot(root, edit.boxes, edit.values);
    expect(() => checkWorkspaceEdit(root, after, edit, [])).not.toThrow();
    expect(readStructure(presentationFromWorkspace(after).message).groups[1].name).toBe("Refrain");
  });

  it("refuses a colour for a group that stores none, which would need a new map", () => {
    const root = document();
    const changes = plan(root, [{ kind: "renameGroup", groupIndex: 1, name: "Refrain" }]);
    expect(refusal(() => planWorkspaceEdit(root, [], changes))).toBe("newContainer");
    // A name no configured group has brings no colour, so needs none.
    expect(planWorkspaceEdit(root, [], plan(root, [{ kind: "renameGroup", groupIndex: 1, name: "Pont" }])).values).toHaveLength(1);
  });

  it("renames a name kept on the node itself too, and refuses one that disagrees with the group's", () => {
    const root = document();
    root.cue_group_placements[1].meta.name = "Chorus";
    const changes = plan(root, [{ kind: "renameGroup", groupIndex: 1, name: "Pont" }]);
    expect(planWorkspaceEdit(root, [], changes).values.map((v) => v.key)).toEqual(["name", "name"]);
    root.cue_group_placements[1].meta.name = "Something else";
    expect(refusal(() => planWorkspaceEdit(root, [], changes))).toBe("lossy");
  });

  it("cuts a tie to a configured group by clearing it", () => {
    const root = document((doc) => {
      doc.cue_groups[1].group.application_group_identifier = { string: "c3fdfda2-0000-4000-8000-000000000002" };
      doc.cue_groups[1].group.application_group_name = "Couplet 4";
    });
    const changes = plan(root, [{ kind: "renameGroup", groupIndex: 1, name: "Pont" }]);
    const edit = planWorkspaceEdit(root, [], changes);
    expect(edit.values.slice(1).map(({ key, value }) => [key, value])).toEqual([
      ["application_group_identifier", null],
      ["application_group_name", ""],
    ]);
    const after = editedRoot(root, edit.boxes, edit.values);
    expect(() => checkWorkspaceEdit(root, after, edit, [])).not.toThrow();
    expect(readStructure(presentationFromWorkspace(after).message).groups[1].link).toBeUndefined();
  });

  it("swaps a macro by setting its identification's values and the action's name", () => {
    const root = document();
    const changes = plan(root, [{ kind: "swapMacro", slideIndex: 2, from: "Louange", to: "Bienvenue" }]);
    const edit = planWorkspaceEdit(root, [], changes);
    const change = changes[0] as { cueUuid: string; actionIndex: number };
    const action = ["cues", change.cueUuid, "actions", change.actionIndex];
    expect(edit.values).toEqual([
      { path: [...action, "ActionTypeData", "macro", "identification"], key: "parameter_uuid", value: MACROS.bienvenue.uuid },
      { path: [...action, "ActionTypeData", "macro", "identification"], key: "parameter_name", value: "Bienvenue" },
      { path: action, key: "name", value: "Bienvenue" },
    ]);
    const after = editedRoot(root, edit.boxes, edit.values);
    expect(() => checkWorkspaceEdit(root, after, edit, [])).not.toThrow();
  });

  it("swaps a macro whose identification leaves its name out, which reads as the empty default", () => {
    const root = document();
    const [planned] = plan(root, [{ kind: "swapMacro", slideIndex: 2, from: "Louange", to: "Bienvenue" }]) as { cueUuid: string; actionIndex: number }[];
    const id = ["cues", planned.cueUuid, "actions", planned.actionIndex, "ActionTypeData", "macro", "identification"];
    delete valueAt(root, id).parameter_name;
    // Found by its action's name, as read_presentation lists it.
    const changes = plan(root, [{ kind: "swapMacro", slideIndex: 2, from: "Louange", to: "Bienvenue" }]);
    expect(changes[0].kind === "swapMacro" && changes[0].before.name).toBe("");
    const edit = planWorkspaceEdit(root, [], changes);
    expect(edit.values.find((v) => v.key === "parameter_name")).toEqual({ path: id, key: "parameter_name", value: "Bienvenue" });
    expect(() => checkWorkspaceEdit(root, editedRoot(root, edit.boxes, edit.values), edit, [])).not.toThrow();
    // Only the empty default stands in for a field left out: a name the plan did not read is still refused.
    valueAt(root, id).parameter_name = "Other";
    expect(refusal(() => planWorkspaceEdit(root, [], changes))).toBe("stale");
  });

  it("swaps a macro the workspace way: upper-case uuids, the collection the slide records moved with it", () => {
    const root = document();
    const [planned] = plan(root, [{ kind: "swapMacro", slideIndex: 2, from: "Louange", to: "Bienvenue" }]) as { cueUuid: string; actionIndex: number }[];
    const id = ["cues", planned.cueUuid, "actions", planned.actionIndex, "ActionTypeData", "macro", "identification"];
    const identification = valueAt(root, id);
    identification.parameter_uuid = MACROS.louange.uuid.toUpperCase();
    identification.parent_collection = { parameter_uuid: "00000000-0000-4000-8000-000000006979".toUpperCase(), parameter_name: "Louange", parent_collection: null };
    const changes = plan(root, [{ kind: "swapMacro", slideIndex: 2, from: "Louange", to: "Bienvenue" }]);
    const edit = planWorkspaceEdit(root, [], changes);
    expect(edit.values.map(({ key, value }) => [key, value])).toEqual([
      ["parameter_uuid", MACROS.bienvenue.uuid.toUpperCase()],
      ["parameter_name", "Bienvenue"],
      ["parameter_uuid", "00000000-0000-4000-8000-000000006978".toUpperCase()],
      ["parameter_name", "Default Collection"],
      ["name", "Bienvenue"],
    ]);
    expect(() => checkWorkspaceEdit(root, editedRoot(root, edit.boxes, edit.values), edit, [])).not.toThrow();
  });

  it("re-ties a group tied to a configured group to the one of its new name", () => {
    const root = document((doc) => {
      doc.cue_groups[1].group.color = { red: 0.5, green: 0.5, blue: 0.5, alpha: 1 };
      doc.cue_groups[1].group.application_group_identifier = { string: "c3fdfda2-0000-4000-8000-000000000002" };
      doc.cue_groups[1].group.application_group_name = "Couplet 4";
    });
    const edit = planWorkspaceEdit(root, [], plan(root, [{ kind: "renameGroup", groupIndex: 1, name: "Refrain" }]));
    expect(edit.values.filter((v) => v.key.startsWith("application")).map(({ key, value }) => [key, value])).toEqual([
      ["application_group_identifier", "143b5f28-0000-4000-8000-000000000003"],
      ["application_group_name", "Refrain"],
    ]);
    expect(() => checkWorkspaceEdit(root, editedRoot(root, edit.boxes, edit.values), edit, [])).not.toThrow();
  });

  it("refuses a document that also changed anything else, the structure included", () => {
    const root = document();
    const changes = plan(root, [{ kind: "swapMacro", slideIndex: 2, from: "Louange", to: "Bienvenue" }]);
    const edit = planWorkspaceEdit(root, [], changes);
    const elsewhere = editedRoot(root, edit.boxes, edit.values);
    elsewhere.cue_group_placements[0].meta.Kind.group.name = "Other";
    expect(refusal(() => checkWorkspaceEdit(root, elsewhere, edit, []))).toBe("verifyFailed");
    // And a structure promised otherwise than the document reads.
    const promised = { ...edit, structure: { ...edit.structure, arrangements: [{ name: "x", groups: [] }] } };
    expect(refusal(() => checkWorkspaceEdit(root, editedRoot(root, edit.boxes, edit.values), promised, []))).toBe("verifyFailed");
  });

  it("refuses a change the document no longer holds", () => {
    const root = document();
    const changes = plan(root, [{ kind: "renameGroup", groupIndex: 1, name: "Pont" }]);
    root.cue_group_placements[1].meta.Kind.group.name = "Moved on";
    expect(refusal(() => planWorkspaceEdit(root, [], changes))).toBe("stale");
  });
});
