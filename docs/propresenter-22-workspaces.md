# ProPresenter 22 workspaces

ProPresenter 22 added Cloud workspaces, and with them a new on-disk format
for **every** workspace, local ones included. Renewed Vision does not document
it. This is what it was found to be, by upgrading a real library from 20.0.1
to 22.0.1 on macOS and comparing the disk before and after, and then checked
against a Cloud workspace on Windows
([#51](https://github.com/eugenius1/presenter-garage/issues/51)).

Workspaces themselves are older than this. ProPresenter 20 introduced them,
and from then a new workspace is made outside Documents, under
`UserWorkspaces` on macOS and `%appdata%\RenewedVision\ProPresenter\LocalWorkspaces`
on Windows ([Renewed Vision's note](https://support.renewedvision.com/hc/en-us/articles/360041815133-ProPresenter-Media-Management)).
Those are still folders of `.pro` files in the old layout, wherever they
sit. What version 22 changed is the format, and that is what this describes.

## What the upgrade does

On first launch a one-time dialog offers **Upgrade Workspace**. Choosing it:

- leaves the old folder (`~/Documents/ProPresenter` by default) untouched.
  Not one file changes. ProPresenter never reads it again, so it stays a
  readable copy of the library as it was that day;
- makes a new workspace at
  `~/Library/Application Support/RenewedVision/ProPresenter/Workspaces/<uuid>/`
  on macOS, `%APPDATA%\RenewedVision\ProPresenter\Workspaces\<uuid>\` on
  Windows, and copies the media into it;
- converts every document into the new format.

The `userWorkspaces` preference in `com.renewedvision.propresenter` still
names the old folder afterwards. Only the registry below says which workspace
is in use.

**File → Export → Legacy Workspace** writes the old layout back out, for
anyone who needs `.pro` files again.

## Layout

```
Workspaces/
├── registry-v1.sqlite3          which workspaces exist, and which is active
├── legacy-handoff-v1            uuid of the workspace made from the old folder
└── <workspace uuid>/
    ├── DocumentStore/
    │   ├── workspace-v1.sqlite3     every document in the workspace
    │   ├── workspace-id
    │   ├── workspace-storage-v1     contains "sqlite-v1"
    │   └── media-projection-cache-v1.json
    ├── MediaStore/                  RocksDB: media metadata, for thumbnails
    ├── Media/                       the media files, still plain files
    ├── Thumbnails/
    ├── Libraries/                   folders only
    ├── Playlists/                   empty
    ├── Themes/                      theme assets only
    └── imprint.cloud                Cloud workspaces only
```

There are no `.pro` files, and no `Playlists/Library`, `Playlists/Media` or
`Libraries/LibraryData`.

### The registry

```sql
CREATE TABLE workspaces (
  local_uuid TEXT PRIMARY KEY NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  cloud_uuid TEXT UNIQUE,          -- NULL for a local workspace
  schema_version TEXT NOT NULL,    -- "22.9.0" on ProPresenter 22.0.1
  availability TEXT NOT NULL       -- "local"
);
CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
```

`meta` holds `active_local_uuid`, and `copied_from:<uuid>` naming the old
folder a workspace was made from. There are also
`cloud_workspace_organizations` and `trashed_workspaces`.

Both databases are in WAL mode, so there can be a `-wal` and a `-shm` file
beside each. What is left when ProPresenter quits differs: on Windows
neither file was there, while on macOS both stayed, with 5 MB of the
workspace still only in the `-wal`. So the `-wal` must be read whenever it
exists, and copied along with the database.

**Opening one read-only is not enough to leave the folder untouched.** With
no `-wal`, SQLite creates both files; open it `immutable` instead, which
creates nothing. With a `-wal` and nothing else holding the database open,
a read-only connection rebuilds the `-shm`. That one cannot be avoided short
of copying the database elsewhere first: the `-shm` is only an index into the
`-wal`, rebuilt by whichever program opens the database next, and the
database and `-wal` themselves come through byte for byte.

### The document store

`workspace_streams` has one row per document:

| Column | Meaning |
| --- | --- |
| `document_id` | 16-byte id |
| `kind` | what the document is (below) |
| `scope` | `0` shared with the workspace, `1` this computer only |
| `location_type` | `0` one of its kind, `1` a document with a path |
| `core_path` | for `location_type = 1`: the old relative path without its extension, `<library>/<name>` |
| `availability` | `0` here, `1` listed but with no snapshot (expected for a Cloud document not yet downloaded) |
| `snapshot` | the document, as a [Loro](https://loro.dev) CRDT snapshot |
| `sha256`, `byte_count`, `version_vector`, `updated_at_ms` | bookkeeping: the snapshot's SHA-256 and length, the document's Loro version vector, and when the row was written |
| `last_shared_version_vector` | what the Cloud server is known to hold; `NULL` throughout a local workspace |

| `kind` | Replaces |
| --- | --- |
| `Presentation`, one per presentation | `Libraries/<library>/<name>.pro` |
| `Theme` | `Themes/<…>/Theme` |
| `PlaylistLibrary` | `Playlists/Library` |
| `PlaylistMedia` | `Playlists/Media`, the media bin |
| `PlaylistAudio` | `Playlists/Audio` |
| `PlaylistTemplates` | `Playlists/PlaylistTemplates` |
| `LibraryData` | `Libraries/LibraryData` |
| `Workspace`, `Stage`, `Groups`, `Macros`, `Props`, `Timers`, `Messages`, `Labels`, `ClearGroups`, `KeyMappings`, `TestPatterns`, `CommunicationDevices`, `Ccli`, `Calendar` | `Configuration/*` |

Some kinds have a second row with `scope = 1`. For `PlaylistLibrary` it holds
which playlist folders are expanded on this computer, and nothing else.

A workspace that has been searched in also has `presentation_search`, an FTS5
index of each presentation's name, text, notes and CCLI fields. ProPresenter
makes it the first time somebody searches, and brings it up to date with the
documents each time it starts.

### A Cloud workspace

Is the same store. Converting a workspace to Cloud does not move it or
change its documents. What differs:

- its row in the registry has a `cloud_uuid`, and a row in
  `cloud_workspace_organizations`. `availability` stays `local`;
- `imprint.cloud` in the workspace folder, JSON listing each presentation
  and theme by document id with its path and whether it is `uploaded`;
- on a computer that has everything synced, every row has its snapshot.
  A row with `availability = 1` and no snapshot has still not been seen.

### The helpers

Two helper processes outlive ProPresenter on both systems: *ProPresenter
Helper (Workspaces)* and its child *(Snapshots)*. They make media thumbnails.
The Workspaces helper holds `MediaStore/` open; neither holds the document
store or the registry, so they do not stand between a reader and the
documents. On macOS launchd keeps them alive, as
`com.renewedvision.propresenter.workspaces-helper`, and one that is killed
comes straight back.

## What a snapshot holds

Each snapshot starts with the bytes `loro` and the open-source
[`loro-crdt`](https://www.npmjs.com/package/loro-crdt) package reads it as it
is:

```js
const doc = new LoroDoc();
doc.import(row.snapshot);
doc.toJSON(); // { root: { … } }
```

`root` is the old protobuf message under the same field names, with these
differences everywhere:

- a `oneof` is an object under the oneof's own name:
  `Fill: { __tag: "color", color: { … } }`, and `{ __tag: null }` when unset;
- a UUID is a bare lower-case string, not `{ string }`;
- an absent message is `null`;
- a few lists are renamed with `_v2`: `group_identifiers_v2`,
  `element_build_order_v2`;
- slide text is still RTF, in `rtf_data`, as bytes.

And these in particular documents:

- **A presentation's slides.** `cues` is a map keyed by uuid, in no order.
  The order, and the groups, are in `cue_group_placements`: a tree of group
  nodes whose children are cue nodes. `cue_groups` is gone. The shape
  `toJSON()` gives it -- each node an `id` like `12@3456`, `parent`,
  `index`, `fractional_index`, `meta` and `children` -- is exactly what Loro
  gives for a `LoroTree`, which is taken to be what it is, `meta` being the
  node's own map (`LoroTreeNode.data`) and a group's name and colour in
  `meta.Kind.group`. That is inferred from the JSON, not yet seen in a real
  snapshot's containers; a write that finds otherwise is refused at plan
  time (*A group renamed, a macro swapped* in
  [propresenter-22-writing.md](propresenter-22-writing.md)).
- **Playlists.** One tree of nodes whose `meta.Kind` is `group`, `playlist`
  or `item`, with `meta.name` and `meta.uuid`; the one top node is the old
  root. Children are in display order.
- **Media.** An element no longer carries `url`; where the file is stays in
  `video.file.local_url` (or `image`, `audio`). New beside it: `asset_id`,
  `identity_schema_version` and `source`.
- **Dates.** `last_date_used`, `last_modified_date` and `application_info`
  are not in a presentation any more, and have not been found elsewhere.
- **The configured macros.** `Macros` holds each macro inside its
  collection, under the collection's `macros`, where the old
  `Configuration/Macros` listed every macro at the top and had each
  collection name its own by uuid. Both are fields of the old message, so
  only the reading has to know. `Groups` and `Macros` write their uuids
  upper-case, where a `.pro` file and the old `Configuration` files have
  them lower-case: compare uuids without regard to case.

`packages/core/src/lib/workspace.ts` undoes these, so a document becomes the
message its old file decoded to.

## How it was checked

Two libraries, each read from its new workspace and from the folder it was
upgraded from, and compared presentation by presentation: 474 on macOS in a
local workspace, and 1,227 on Windows in a Cloud workspace that had been in
use for a week. Every slide, its group, and every line of every text box
matched, leaving aside the 41 Windows presentations edited since the upgrade,
and so did the macros each slide triggers. So did the media bin's playlists
and items, the presentation playlists, and on Windows the configured groups
and macros, name for name and uuid for uuid. The differences that remain are ProPresenter's own:
names stored in composed rather than decomposed Unicode, media paths moved
into the workspace, and some effect defaults rewritten.

The comparison is a test, skipped without a library to run it on: see
*Testing against real files* in [CONTRIBUTING.md](../CONTRIBUTING.md).

## What is not done

- **A Cloud document that is not downloaded.** Handled as the schema
  suggests, never met.
- **Writing anything but a presentation.** Slide text, a group's name,
  colour and tie to a configured group, and which macro a slide triggers are
  written into a local workspace while ProPresenter is closed, as
  [propresenter-22-writing.md](propresenter-22-writing.md) describes.
  Nothing else is: playlists, the media bin and restyling stay read-only.
- **Writing to a Cloud workspace.** Refused until it has been tried
  ([#55](https://github.com/eugenius1/presenter-garage/issues/55)).
- **The web app.** A browser picking a v22 workspace folder finds no `.pro`
  files. Only the MCP server reads one so far.
- **When a song was last shown.** See *Dates* above.
