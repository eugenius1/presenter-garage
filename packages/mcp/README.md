# presenter-garage-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant
read a ProPresenter 7 library from disk, and edit its slide text. Part of
[Presenter Garage](https://github.com/eugenius1/presenter-garage).

- List and search presentations, and read their slides line by line, with
  each slide's group and the macros it triggers
- Read ProPresenter's configured groups and macros, names exactly as stored:
  a non-breaking space shows as `\u00a0`, so `Couplet 1` and `Couplet\u00a01`
  can be told apart
- See what each file records about itself: when ProPresenter last edited and
  last showed it, category, notes, CCLI details, key and arrangements
- Run the Presentations text checks on a file or a whole library
- Read or audit the media bin
- Read the presentation playlists: each service and the songs, headers and
  media in it
- List the themes, and preview giving a presentation the look of a theme slide
  or of another presentation's slide, slide by slide
- Edit slide text line by line -- change a line, remove one, or add one
  beside another, which takes that line's formatting: you confirm every line
  in your app before anything is written, and each file is backed up outside
  your library first
- Write a whole library, a comparison with another library, or every rule
  break to a folder you name, answering only with counts and paths, so the
  lyrics stay on your computer

### What it reads

It works in one library at a time, the one open. Another becomes the one open
in two ways: you approve the switch in your app when the assistant asks for it
(`use_library`), or, in a client that declares roots, the first of them that
is itself a ProPresenter folder or workspace is opened. Outside the library
open it reads only:

- a second library, once you approve reading it in your app, for
  `compare_libraries` to set beside the one open, which stays open
- the places ProPresenter keeps its libraries on this computer, for
  `find_libraries` to list them
- your team's `RULES.md` and `rules.json`, looked for in the folder the server
  starts in and in `~/Documents/ProPresenter`

### What it writes

Besides the slide text you confirm, it writes only:

- a backup of each file before it changes, outside your library
  (`--backup-dir=<folder>` chooses where)
- `rules.json` beside your team's `RULES.md` (`save_rules`), once it has been
  checked
- the results of the tools that write to a folder you name, `out`:
  `find_libraries`, `dump_library`, `compare_libraries`, `check_rules`, and
  `check_presentations` given `out`. Each call makes a new folder of its own
  inside `out`, never inside, nor holding, a library the call reads, and
  never writes over a file.

Editing slide text and `save_rules` are offered only while the library open
can be backed up.

### Asking you, and read-only

Whatever needs your approval is asked through MCP elicitation. In a client
that does not support it, no slide text is changed, `use_library` opens no
other library, and `compare_libraries` reads no second one. The other tools
that write to a folder ask nothing, so they work as in any client.

`--read-only` offers nothing that writes: neither editing nor `save_rules`,
and of the tools that write to a folder only `check_presentations`, without
`out`, answering with its findings instead.

## Use

```bash
claude mcp add presenter-garage -- npx -y presenter-garage-mcp ~/Documents/ProPresenter
```

Any MCP client that starts a local server over stdio takes the same command:
`npx`, then `-y presenter-garage-mcp` and one library folder. With
no folder it reads the workspace ProPresenter 22 has open; where there is
none, `~/Documents/ProPresenter`, or, where that is missing, the one workspace
ProPresenter 20 or 21 made elsewhere. Needs Node 20 or later, and
Node 22.13 or later to read a ProPresenter 22 workspace. Slide text in a
ProPresenter 22 workspace is edited only while ProPresenter is closed, and in
a Cloud workspace only a presentation whose changes Cloud has all confirmed. The package is one file with no
dependencies.

For Claude Desktop there is also a one-click extension (`.mcpb`): see the
[main README](https://github.com/eugenius1/presenter-garage#claude-desktop).

## Licence

GPL-3.0-or-later.
