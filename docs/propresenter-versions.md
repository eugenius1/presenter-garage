# ProPresenter versions checked

What each ProPresenter version was checked for, and what turned up. The
procedure is the
[`validate-propresenter-version`](../.agents/skills/validate-propresenter-version/SKILL.md)
skill. Each run adds its own entry here, under the version it checked, newest
version first.

## 22.0.1

**2026-11-15, macOS.** A library upgraded from 20.0.1, compared before and
after; nothing opened in the app beyond the upgrade itself (#51).

- The workspace is no longer a folder of files but a SQLite database of [Loro](https://loro.dev)
  snapshots, in a new place. Written up in
  [propresenter-22-workspaces.md](propresenter-22-workspaces.md).
- All 474 presentations read the same from the new workspace as from the old
  folder: every slide, group and line. So did the media bin and the playlists.
- The MCP server read the old folder by default, which the upgrade leaves in
  place and never updates. It now reads the active workspace, and says so
  when pointed at a folder a workspace was made from.
- A presentation no longer records when it was last shown. Filtering by use
  is refused for a workspace rather than answered wrongly.
- Read-only: the edit tools are not offered for a workspace.
- Not checked: the web app.

**2026-11-15, Windows.** A Cloud workspace that had been in use for a week,
with the folder it was upgraded from; files only, not opened in the app (#51).

- The same store as a local workspace on macOS, under `%APPDATA%`. The
  registry marks it Cloud; nothing about its documents differs.
- All but the 41 presentations edited since the upgrade read the same from
  the workspace as from the old folder, of 1,227. Every playlist entry
  opened the presentation it names.
- Opening the database read-only left `-shm` and `-wal` files in a workspace
  ProPresenter had closed. Fixed: it is opened immutable when there is no
  write-ahead log.
- A playlist written on Windows records its entries with backslashes. Fixed:
  a document is found by either separator.

## 21.4.2

**2026-09-11, Windows.** Export safety gate over a real library; not opened
in the app. The date is when the result was recorded; the run itself was
not dated.

- Every file `identical`.

## 20.0.1

**2026-10-27, macOS.** `applyStyle` compared with ProPresenter's own Themes menu,
field by field, on one song (#36).

- The box holding the words keeps the slide's element uuid. `applyStyle`
  had given it a fresh one.
- A theme's alignment guides go to `template_guidelines`, not to the slide's
  own guides.
- The words carry an `original_font` range for the theme box's font.
- All three now match.

**2026-10-24, macOS.** The full procedure: the suite against an installation, then
slide numbering and text, media-bin kinds, a fixer run, three restyles, a
Media Bin export and a built playlist, each opened in the app (#23).

- Slides were numbered in storage order, not the group order ProPresenter
  shows. Fixed.
- Every media-bin action was typed as audio, while the media elements said
  video or image. Fixed: the element now decides.
- Every file `identical`.
