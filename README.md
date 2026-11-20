# Presenter Garage

[![CI](https://github.com/eugenius1/presenter-garage/actions/workflows/ci.yml/badge.svg)](https://github.com/eugenius1/presenter-garage/actions/workflows/ci.yml)
[![Deploy](https://github.com/eugenius1/presenter-garage/actions/workflows/deploy.yml/badge.svg)](https://github.com/eugenius1/presenter-garage/actions/workflows/deploy.yml)
[![codecov](https://codecov.io/gh/eugenius1/presenter-garage/graph/badge.svg)](https://codecov.io/gh/eugenius1/presenter-garage)

A web app holding a suite of utilities for ProPresenter 7 files.

**<https://presenter-garage.eusebius.tech/>**

The app runs entirely in the browser. No server, no upload: your media library
never leaves the machine. The [MCP server](#for-ai-assistants-mcp) is different, because it hands
what it reads to an AI assistant.

## Tools

### Presentations

Checks the text of every presentation in a library — a whole folder of `.pro`
files at once. It finds the things nobody spots by opening thirty songs one at
a time: a space at the start of a line that shifts it right on screen, a space
at the end that spoils centring, a doubled space, and lines that show nothing
while still taking up room.

Trailing punctuation is checked too — commas, semicolons and full stops — each
switched on separately, since whether they belong on a slide is a matter of
house style and not one decision: a library of 24,000 lines ends nearly a
thousand of them with a full stop and 43 with a semicolon, so a house that
strips commas may well keep the full stop that closes a verse. A line ending
in an ellipsis is left alone either way: that is a line running on into the
next slide, which is the opposite of the problem.

It can also put them right. Every fix is shown first as the line is now and
as it would read, one row per line and a tick beside each, so nothing is
changed that you have not looked at. In Chrome and Edge the corrected files go
back into the folder — but only after you have downloaded a zip of those files
exactly as they stand, which the button insists on. Everywhere else, the
corrected presentations come as a zip for you to move into place yourself, and
your library is not touched at all.

Behind that: each file is checked against the schema before it is written, and
read back afterwards to confirm it says what was promised. Anything that fails
either check is left exactly as it was and named in the results.

### Media Bin

Compares and audits **media-bin playlists** — the file named `Media` inside
your ProPresenter folder's `Playlists` directory. (`Media` at the top level of
that folder is the media *assets*; the playlist document is the one under
`Playlists`.) Load one file to audit it; load two to see exactly what changed
between them, bring changes from one side into the other, and export the
result as a new file.

### For AI assistants (MCP)

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an
assistant such as Claude read your library from disk: list and search
presentations, read their slides line by line with each slide's group and
macros, read ProPresenter's configured groups and macros, run the
Presentations checks, read or audit the media bin, read the presentation
playlists, and preview giving a presentation a theme's look. Names come back
exactly as stored, with a non-breaking space shown as `\u00a0`, so a group
named `Couplet 1` with one can be told from the one without. It can also **edit slide text**: ask
it to fix a typo, reword a line, or add one, and before anything is written your app
shows you every line as it is and as it would read, with a tick box for each.
Every file is backed up outside your library first, and the result is read
back before it is kept. Started with `--read-only` (or the extension's *Read
only* setting), it never changes a file and does not even offer the editing
tools.

Editing needs a client that can ask you a question mid-task (MCP
*elicitation*); with one that cannot, nothing is written. Close a song in
ProPresenter before editing it: ProPresenter may save its own copy over the
change. Backups go to `~/Library/Application Support/Presenter
Garage/Backups` on macOS and `%APPDATA%\Presenter Garage\Backups` on
Windows, one dated folder per change; `--backup-dir=<folder>` puts them
elsewhere, and restoring is copying a file back.

It also reads what each presentation records about itself: when ProPresenter
last edited it and last showed it, its category, notes, CCLI details, key and
arrangements. So it can answer "which songs haven't we used this year?" —
though that question opens every file, so it takes about a second per 500
songs rather than being instant. It gives no creation date: presentations
don't record one, and the file system's is reset by every copy, sync or
restore.

ProPresenter's own network API can show and trigger slides, and there are MCP
servers for that, but it cannot read a presentation's file or edit its text.
This works on the files instead, through the same code as the app.

It reads nothing outside the folders you give it. The usual one is
`Documents/ProPresenter`, which holds `Libraries` and `Playlists` on both macOS
and Windows.

The folder has moved twice since. **ProPresenter 20** introduced workspaces,
and one made there is a folder of the same files somewhere else: under
`Library/Application Support/RenewedVision/ProPresenter/UserWorkspaces` on
macOS and `%appdata%\RenewedVision\ProPresenter\LocalWorkspaces` on Windows.
Give the server that folder and it reads it like any other.

**ProPresenter 22** changed the format as well. A workspace is now a database
under `Library/Application Support/RenewedVision/ProPresenter/Workspaces`, and
the folder it was upgraded from is left behind as it was that day. The server
reads a workspace too, and edits slide text in one kept on this computer, as
long as **ProPresenter is closed**: it refuses to write while ProPresenter
has the workspace open, because ProPresenter would save over the change. A
ProPresenter Cloud workspace is read but not written to yet. Started with
no folder it reads the workspace ProPresenter has open; pointed at the old
folder it reads that, and tells the assistant it is out of date and where the
current one is. Details are in
[docs/propresenter-22-workspaces.md](docs/propresenter-22-workspaces.md) and
[docs/propresenter-22-writing.md](docs/propresenter-22-writing.md).

Unlike the app, what it reads does not stay on the machine. The server itself
makes no network connection, but every answer it gives — slide text, notes,
file names, media-bin entries — goes into the conversation with your
assistant, and an assistant that runs on a hosted model, such as Claude, sends
the conversation to that model's provider like anything else you type.

#### Claude Desktop

The server is packaged as a desktop extension, so Claude Desktop installs it in
one click and brings its own Node; there is nothing else to install.

1. Download
   [`presenter-garage.mcpb`](https://github.com/eugenius1/presenter-garage/releases/latest/download/presenter-garage.mcpb)
   from the latest release (the app links it too, under *For AI assistants*),
   and open it with Claude Desktop: double-click it, drag it onto the window,
   or install it from **Settings → Extensions**.
2. Click **Install**, then choose your ProPresenter folder when asked. It
   suggests `Documents/ProPresenter`; add more than one folder if you keep
   libraries elsewhere.
3. Start a new chat and ask, for example, *"Which songs in my library have
   lines ending in a full stop?"* or *"Find the presentation with the lyric
   'how great thou art'."*

To change the folders, or to make it read-only, find Presenter Garage under
**Settings → Extensions**. The extension is unsigned, so Claude Desktop says so when
installing it.

#### Claude Code and other MCP clients

Any client that starts a local server over stdio — Claude Code, VS Code,
Cursor, Cline, LM Studio — can run it with `npx` and Node 20 or later. The
package is a single file with no dependencies, so there is nothing else to
install:

```bash
claude mcp add presenter-garage -- npx -y presenter-garage-mcp ~/Documents/ProPresenter
```

Other clients take the same command and arguments in their MCP settings:
command `npx`, arguments `-y presenter-garage-mcp` followed by your folders.
Pass one or more folders; with none, it reads the workspace ProPresenter 22
has open, else `~/Documents/ProPresenter`, else the one workspace ProPresenter
20 or 21 made elsewhere. Add
`--read-only` to turn editing off. Reading a ProPresenter 22 workspace needs
Node 22.13 or later.

To run it from a checkout instead, or to build the extension yourself
(`npm run mcp:pack` writes it to `packages/mcp/dist/presenter-garage.mcpb`):

```bash
npm ci && npm run mcp:build
claude mcp add presenter-garage -- node "$PWD/packages/mcp/dist/presenter-garage-mcp.mjs" ~/Documents/ProPresenter
```

### Comparing two libraries (command line)

`presenter-garage` reads two ProPresenter libraries, matches their songs and
sorts each pair by how far apart the two versions are: identical, spacing or
end punctuation only, group names only, real differences, renamed, or only
on one side. For each pair it gives both edit dates, which side was edited
later, and the version it would keep, with the reason: fewer text-check
findings, then the later edit, then the library you call the main one. It
never writes to a library.

```bash
npm ci && npm run protos
npm run cli -- sources
npm run cli -- compare bas=/path/to/ProPresenter/Libraries haut=active --out private/compare
```

A source is a folder of `.pro` files, a ProPresenter 22 workspace folder, or
`active` (the workspace ProPresenter has open), with a label in front. Songs
are matched by their internal ID, then by name, with `_` read as `'`, curly
apostrophes as straight ones and accents however they were composed.

`compare` writes `report.html`, one song to a page with the two versions side
by side, aligned by group and with every differing word marked. Filter by
bucket, by who edited later and by whether you have decided, keep one side
or the other, and download your picks as `decisions.json`. It also writes
`compare.json` and a text view of every song, so
`git diff --no-index --word-diff text/bas text/haut` works in a terminal.
`dump <source> --out <dir>` writes every song of one library as JSON and text.

ProPresenter 22 records no edit dates from before the upgrade, so a workspace
song nobody has edited since is dated from the `.pro` file it was made from,
found through ProPresenter's registry or given with
`--legacy haut=/path/to/the/old/folder`. Edits after the upgrade are dated
from the workspace's own change history. Every command takes `--json`, and
lyrics reach the terminal only with `dump --lyrics`. It needs Node 22.13 or
later.

## Why

ProPresenter gives you no way to answer "what changed in the media bin since
last week?", or "is this file in here twice?". Nothing existing fills that gap
either — the community projects around ProPresenter are either live remote
controls (ProWebRemote, ProPresenter-API) or parsers for the pre-7 XML format
(ProPresenter-Parser). This reads the actual Pro7 files.

The name is deliberate: a garage is where the tools live, so new ones can be
added without the name fighting them.

## What your browser can do

Reading works everywhere. Writing back does not: Chrome and Edge can be given
access to a folder and save fixes into it, while Safari and Firefox can only
read copies — they offer no way back to the original files, so there the fixes
arrive as a zip instead. Both routes are offered automatically; you do not
choose between them.

Permission to read a folder can lapse when you close the last tab, unless you
allowed it on every visit. Where it has lapsed, a folder chosen on an earlier
visit is offered as a button to grant it again.

## Languages

English and French. The default comes from the device — `navigator.languages`
in preference order, ignoring region subtags, so a machine configured as
`[de, fr, en]` gets French rather than falling through to English. A switcher
top right overrides it and the choice is remembered, for the case the device
cannot express: a French operator on an English-configured booth machine.

## Status

Working: the **Presentations** checker and its fixes, and the **Media Bin**
tool — diff, audit, browse, reorganise and export — with the fidelity gate
behind everything written, English and French, and light, dark or system
appearance. Also the **MCP server**, which reads everything the app does and
edits slide text line by line under the same four write guards in
[AGENTS.md](AGENTS.md), and the **command line**, which compares two libraries
and writes a report to review them in; turning that review into edits is next.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — how the files are read, the
invariants the diff depends on, the safety gate, and the traps worth knowing
before changing anything. Coding agents should start at
[AGENTS.md](AGENTS.md).

## Licence

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU General Public License for more details. You
should have received a copy of the licence along with this program — see
[LICENSE](LICENSE), or <https://www.gnu.org/licenses/>.

The vendored schema in `proto/` is a separate work, MIT-licensed by its author
and kept under its own notice at
[`proto/LICENSE-ProPresenter7-Proto`](proto/LICENSE-ProPresenter7-Proto). MIT is
GPL-compatible, so the combination distributes cleanly under the GPL.

---

Not affiliated with Renewed Vision. The proto definitions are unofficial and
unsupported; back up your ProPresenter folder before trusting any tool with it.
