import { describe, expect, it } from "vitest";
import { encodeDocument } from "../decode";
import { buildLibrary, decodeMediaDocument, rawChildren, rawItems } from "../model";
import { decodePlaylistsDocument } from "../playlists";
import { encodePresentation, readPresentation, slidesInOrder } from "../presentation";
import { playlistDocumentFromWorkspace, presentationFromWorkspace, themeFromWorkspace } from "../workspace";
import {
  rtfWithHeader,
  SYNTHETIC,
  syntheticMediaFile,
  syntheticPresentationFile,
  syntheticTextPresentation,
  textLines,
} from "./synthetic";
import { localUrl, treeNode, workspacePlaylists, workspacePresentation } from "./workspace-fixtures";

/**
 * A ProPresenter 22 workspace's documents, read back into the old messages.
 *
 * The documents written out by hand below are the shape a real workspace was
 * seen to hold, cut down to what each test is about. The rest are synthetic
 * files turned into that shape, to check that nothing a whole document holds
 * is dropped on the way back.
 */

const rtf = (text: string) => new TextEncoder().encode(rtfWithHeader(`\\cb3 ${text}`));

/** A slide's cue as a workspace stores it: every oneof wrapped, every UUID a bare string. */
const cue = (uuid: string, name: string, text: string) => ({
  uuid,
  name,
  isEnabled: true,
  hot_key: { code: 0 },
  actions: [
    {
      uuid: `${uuid}-action`,
      isEnabled: true,
      type: 11,
      label: { text: null, color: null },
      ActionTypeData: {
        __tag: "slide",
        slide: {
          Slide: {
            __tag: "presentation",
            presentation: {
              base_slide: {
                uuid: `${uuid}-slide`,
                element_build_order_v2: [`${uuid}-element`],
                elements: [{ element: { uuid: `${uuid}-element`, text: { rtf_data: rtf(text) } } }],
              },
              notes: null,
            },
          },
        },
      },
    },
  ],
});

const placement = (uuid: string, name: string, cues: string[]) => ({
  id: `${uuid}@1`,
  parent: null,
  index: 0,
  fractional_index: "80",
  meta: { uuid, Kind: { __tag: "group", group: { name, application_group_identifier: `${uuid}-app`, hot_key: { code: 0 } } } },
  children: cues.map((c, index) => ({
    id: `${c}@1`,
    parent: `${uuid}@1`,
    index,
    fractional_index: "80",
    meta: { uuid: c, Kind: { __tag: "cue", cue: {} } },
    children: [],
  })),
});

const PRESENTATION = {
  uuid: "aaaa",
  name: "Song",
  selected_arrangement: "arr-1",
  SlideShow: { __tag: null },
  chord_chart: null,
  background: { is_enabled: false, Fill: { __tag: "color", color: { red: 0, green: 0, blue: 0, alpha: 1 } } },
  ccli: { song_title: "Song", author: null, song_number: 0 },
  arrangements: [{ uuid: "arr-1", name: "Short", group_identifiers_v2: ["g-chorus", "g-verse"] }],
  value_array_migration_version: "1",
  // Keyed by uuid, in an order that is not the order of the slides.
  cues: {
    "c-3": cue("c-3", "Three", "third"),
    "c-1": cue("c-1", "One", "first"),
    "c-2": cue("c-2", "Two", "second"),
  },
  cue_group_placements: [placement("g-verse", "Verse", ["c-1", "c-2"]), placement("g-chorus", "Chorus", ["c-3"])],
};

describe("a presentation from a workspace", () => {
  it("puts the slides in the order of the placements, not of the map", () => {
    const { message } = presentationFromWorkspace(PRESENTATION);
    expect(message.cues.map((c: any) => c.name)).toEqual(["One", "Two", "Three"]);
    expect(readPresentation(message).textBoxes.map((box) => [box.groupName, box.lines[0].text])).toEqual([
      ["Verse", "first"],
      ["Verse", "second"],
      ["Chorus", "third"],
    ]);
  });

  it("rebuilds the groups, each naming its cues", () => {
    const { message } = presentationFromWorkspace(PRESENTATION);
    expect(
      message.cue_groups.map((g: any) => [g.group.name, g.group.uuid.string, g.cue_identifiers.map((id: any) => id.string)])
    ).toEqual([
      ["Verse", "g-verse", ["c-1", "c-2"]],
      ["Chorus", "g-chorus", ["c-3"]],
    ]);
    expect(message.cue_groups[0].group.application_group_identifier.string).toBe("g-verse-app");
  });

  it("wraps a bare uuid and sets a oneof's chosen field", () => {
    const { message } = presentationFromWorkspace(PRESENTATION);
    expect(message.uuid.string).toBe("aaaa");
    expect(message.selected_arrangement.string).toBe("arr-1");
    expect(message.background.color.alpha).toBe(1);
    // Two levels of oneof down, and the field reached is the slide's own.
    expect(message.cues[0].actions[0].slide.presentation.base_slide.uuid.string).toBe("c-1-slide");
  });

  it("reads a `_v2` list as the list it replaced", () => {
    const { message } = presentationFromWorkspace(PRESENTATION);
    expect(message.arrangements[0].group_identifiers.map((id: any) => id.string)).toEqual(["g-chorus", "g-verse"]);
    expect(message.cues[0].actions[0].slide.presentation.base_slide.element_build_order[0].string).toBe("c-1-element");
  });

  it("carries everything the schema has a field for", () => {
    expect(presentationFromWorkspace(PRESENTATION).unmapped).toEqual([]);
  });

  it("names what the schema has no field for, once each", () => {
    const withNew = {
      ...PRESENTATION,
      shiny_new_thing: 1,
      cues: Object.fromEntries(Object.entries(PRESENTATION.cues).map(([k, c]) => [k, { ...c, per_cue_thing: true }])),
    };
    expect(presentationFromWorkspace(withNew).unmapped).toEqual(["rv.data.Cue.per_cue_thing", "rv.data.Presentation.shiny_new_thing"]);
  });

  it("names a oneof choice the schema does not have, and passes over an unset one", () => {
    const { message, unmapped } = presentationFromWorkspace({
      ...PRESENTATION,
      background: { is_enabled: true, Fill: { __tag: "hologram", hologram: {} } },
    });
    expect(unmapped).toEqual(["rv.data.Background.Fill.hologram"]);
    expect(message.background.is_enabled).toBe(true);
    // `SlideShow: { __tag: null }` in the fixture is a oneof nothing was chosen for.
    expect(presentationFromWorkspace(PRESENTATION).unmapped).toEqual([]);
  });

  it("names a placement that is not a group rather than guessing where its cues go", () => {
    const stray = { ...placement("x", "X", []), meta: { uuid: "x", Kind: { __tag: "section", section: {} } } };
    const { message, unmapped } = presentationFromWorkspace({
      ...PRESENTATION,
      cue_group_placements: [stray, placement("g-verse", "Verse", ["c-1"])],
    });
    expect(unmapped).toEqual(["rv.data.Presentation.cue_group_placements.section"]);
    expect(message.cue_groups).toHaveLength(1);
    // Every cue is still there: the stray placement cost the order, not the slides.
    expect(message.cues).toHaveLength(3);
  });

  it("reads a list that is not a list as empty, and a placement of a cue that is gone as no slide", () => {
    const { message } = presentationFromWorkspace({
      ...PRESENTATION,
      arrangements: { not: "a list" },
      cue_group_placements: [placement("g-verse", "Verse", ["c-1", "c-deleted"])],
    });
    expect(message.arrangements).toEqual([]);
    expect(message.cues.map((c: any) => c.name)).toEqual(["One", "Three", "Two"]);
    expect(message.cue_groups[0].cue_identifiers.map((id: any) => id.string)).toEqual(["c-1", "c-deleted"]);
  });

  it("keeps a cue no group places, after the ones that are placed", () => {
    const { message } = presentationFromWorkspace({
      ...PRESENTATION,
      cue_group_placements: [placement("g-verse", "Verse", ["c-2"])],
    });
    expect(message.cues.map((c: any) => c.name)).toEqual(["Two", "Three", "One"]);
    expect(slidesInOrder(message).map((s) => s.cue.name)).toContain("Three");
  });

  it("stores a cue placed twice once", () => {
    const { message } = presentationFromWorkspace({
      ...PRESENTATION,
      cue_group_placements: [placement("g-verse", "Verse", ["c-1", "c-1"])],
    });
    expect(message.cues.filter((c: any) => c.name === "One")).toHaveLength(1);
    expect(message.cue_groups[0].cue_identifiers).toHaveLength(2);
  });

  it("reads nothing at all as an empty presentation rather than throwing", () => {
    expect(presentationFromWorkspace(null).message.cues).toEqual([]);
    expect(presentationFromWorkspace({}).unmapped).toEqual([]);
  });

  it("gives the same text as the file it replaced, for a whole presentation", () => {
    const bytes = syntheticTextPresentation();
    const { message, unmapped } = presentationFromWorkspace(workspacePresentation(bytes));
    expect(unmapped).toEqual([]);
    expect(textLines(encodePresentation(message))).toEqual(textLines(bytes));
  });
});

const PLAYLISTS = {
  type: 1,
  live_video_playlist_nodes: [],
  playlists: [
    treeNode("group", "PLAYLIST", {}, [
      treeNode("group", "Services", {}, [
        treeNode("playlist", "Sunday", { LinkData: { __tag: null } }, [
          treeNode("item", "Welcome", { is_hidden: false, ItemType: { __tag: "header", header: { actions: [], color: { red: 1 } } } }),
          treeNode("item", "Song", {
            is_hidden: false,
            ItemType: {
              __tag: "presentation",
              presentation: { document_path: localUrl("Libraries/Default/Song.pro"), arrangement_name: "Short", arrangement: null },
            },
          }),
        ]),
      ]),
      treeNode("playlist", "Empty", { LinkData: { __tag: null } }),
    ]),
  ],
};

describe("a playlist document from a workspace", () => {
  it("makes the tree's one top node the root", () => {
    const { message, unmapped } = playlistDocumentFromWorkspace(PLAYLISTS);
    expect(unmapped).toEqual([]);
    expect(message.root_node.name).toBe("PLAYLIST");
    expect(rawChildren(message.root_node).map((p: any) => p.name)).toEqual(["Services", "Empty"]);
  });

  it("is a presentation playlist document the old reader accepts", () => {
    const decoded = decodePlaylistsDocument(encodeDocument(playlistDocumentFromWorkspace(PLAYLISTS).message));
    const sunday = rawChildren(rawChildren(decoded.root_node)[0])[0];
    expect(sunday.uuid.string).toBe("u-Sunday");
    expect(rawItems(sunday).map((i: any) => [i.name, i.uuid.string, Boolean(i.header), Boolean(i.presentation)])).toEqual([
      ["Welcome", "u-Welcome", true, false],
      ["Song", "u-Song", false, true],
    ]);
    const entry = rawItems(sunday)[1].presentation;
    expect(entry.document_path.local.path).toBe("Libraries/Default/Song.pro");
    expect(entry.document_path.absolute_string).toBe("file:///ws/Libraries/Default/Song.pro");
    expect(entry.arrangement_name).toBe("Short");
  });

  it("keeps a playlist with nothing in it as a playlist", () => {
    const empty = rawChildren(playlistDocumentFromWorkspace(PLAYLISTS).message.root_node)[1];
    expect(empty.items.items).toEqual([]);
    expect(empty.playlists ?? undefined).toBeUndefined();
  });

  it("makes a root for a tree that does not start with one group", () => {
    const { message } = playlistDocumentFromWorkspace({
      type: 1,
      playlists: [treeNode("playlist", "A", {}), treeNode("playlist", "B", {})],
    });
    expect(rawChildren(message.root_node).map((p: any) => p.name)).toEqual(["A", "B"]);
  });

  it("keeps the live-video playlist, and says so if there is ever more than one", () => {
    const live = (name: string) => treeNode("playlist", name, { LinkData: { __tag: null } });
    const one = playlistDocumentFromWorkspace({ ...PLAYLISTS, type: 2, live_video_playlist_nodes: [live("Live Video")] });
    expect(one.unmapped).toEqual([]);
    expect(one.message.live_video_playlist.name).toBe("Live Video");

    const two = playlistDocumentFromWorkspace({ ...PLAYLISTS, type: 2, live_video_playlist_nodes: [live("A"), live("B")] });
    expect(two.message.live_video_playlist.name).toBe("A");
    expect(two.unmapped).toEqual(["rv.data.PlaylistDocument.live_video_playlist_nodes[1+]"]);
  });

  it("reads nothing at all as an empty document rather than throwing", () => {
    const { message, unmapped } = playlistDocumentFromWorkspace(null);
    expect(unmapped).toEqual([]);
    expect(rawChildren(message.root_node)).toEqual([]);
  });

  it("leaves a url that is already there alone", () => {
    const { message } = playlistDocumentFromWorkspace({
      type: 2,
      playlists: [
        treeNode("group", "", {}, [
          treeNode("playlist", "Loops", {}, [
            treeNode("item", "Loop", {
              ItemType: {
                __tag: "cue",
                cue: {
                  actions: [
                    {
                      ActionTypeData: {
                        __tag: "media",
                        media: {
                          element: {
                            url: localUrl("Media/kept.mov"),
                            TypeProperties: { __tag: "video", video: { file: { local_url: localUrl("Media/other.mov") } } },
                          },
                        },
                      },
                    },
                  ],
                },
              },
            }),
          ]),
        ]),
      ],
    });
    const element = rawItems(rawChildren(message.root_node)[0])[0].cue.actions[0].media.element;
    expect(element.url.local.path).toBe("Media/kept.mov");
  });

  it("puts back the url a media element no longer carries", () => {
    const media = (properties: object) => ({
      uuid: "m-1",
      asset_id: "asset-1",
      identity_schema_version: "1",
      TypeProperties: properties,
    });
    const item = (name: string, properties: object) =>
      treeNode("item", name, {
        ItemType: {
          __tag: "cue",
          cue: { uuid: `cue-${name}`, name, actions: [{ type: 2, ActionTypeData: { __tag: "media", media: { element: media(properties) } } }] },
        },
      });
    const { message, unmapped } = playlistDocumentFromWorkspace({
      type: 2,
      playlists: [
        treeNode("group", "", {}, [
          treeNode("playlist", "Loops", {}, [
            item("Loop", { __tag: "video", video: { file: { local_url: localUrl("Media/Assets/loop.mov") } } }),
            item("Still", { __tag: "image", image: { file: { local_url: localUrl("Media/Assets/still.jpg") } } }),
          ]),
        ]),
      ],
    });
    // New in version 22, and reported rather than passed over in silence.
    expect(unmapped).toEqual(["rv.data.Media.asset_id", "rv.data.Media.identity_schema_version"]);
    const library = buildLibrary(decodeMediaDocument(encodeDocument(message)));
    expect(library.items.map((i) => [i.name, i.relativePath, i.kind])).toEqual([
      ["Loop", "Media/Assets/loop.mov", "video"],
      ["Still", "Media/Assets/still.jpg", "image"],
    ]);
  });

  it("gives the same media bin as the file it replaced", () => {
    const bytes = syntheticMediaFile();
    const { message } = playlistDocumentFromWorkspace(workspacePlaylists(bytes));
    const before = buildLibrary(decodeMediaDocument(bytes));
    const after = buildLibrary(decodeMediaDocument(encodeDocument(message)));
    expect(after.items).toHaveLength(SYNTHETIC.items);
    expect(after.playlists.map((p) => [p.path, p.items.map((i) => i.name)])).toEqual(
      before.playlists.map((p) => [p.path, p.items.map((i) => i.name)])
    );
    expect(after.items.map((i) => [i.relativePath, i.modifications.descriptors])).toEqual(
      before.items.map((i) => [i.relativePath, i.modifications.descriptors])
    );
  });

  it("gives the same presentation playlists as the file it replaced", () => {
    const bytes = syntheticPresentationFile();
    const names = (node: any): unknown => [node.name, rawChildren(node).map(names), rawItems(node).map((i: any) => i.name)];
    const { message } = playlistDocumentFromWorkspace(workspacePlaylists(bytes));
    expect(names(decodePlaylistsDocument(encodeDocument(message)).root_node)).toEqual(
      names(decodePlaylistsDocument(bytes).root_node)
    );
  });
});

describe("a theme from a workspace", () => {
  it("is the same document under the same names", () => {
    const { message, unmapped } = themeFromWorkspace({
      value_array_migration_version: "1",
      slides: [{ name: "Lyrics", base_slide: { uuid: "s-1", element_build_order_v2: [], elements: [] } }],
    });
    expect(unmapped).toEqual([]);
    expect(message.slides[0].name).toBe("Lyrics");
    expect(message.slides[0].base_slide.uuid.string).toBe("s-1");
  });
});
