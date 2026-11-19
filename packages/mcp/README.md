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

It reads nothing outside the folders you give it, and writes outside them only
the backups it makes before changing a file. Editing needs a
client that supports MCP elicitation; with one that does not, nothing is
written. `--read-only` turns editing off entirely, and `--backup-dir=<folder>`
chooses where backups go.

## Use

```bash
claude mcp add presenter-garage -- npx -y presenter-garage-mcp ~/Documents/ProPresenter
```

Any MCP client that starts a local server over stdio takes the same command:
`npx`, then `-y presenter-garage-mcp` and one or more library folders. With
no folder it reads the workspace ProPresenter 22 has open, or
`~/Documents/ProPresenter` where there is none. Needs Node 20 or later, and
Node 22.13 or later to read a ProPresenter 22 workspace. Slide text in a
ProPresenter 22 workspace is edited only while ProPresenter is closed, and a
Cloud workspace is not written to yet. The package is one file with no
dependencies.

For Claude Desktop there is also a one-click extension (`.mcpb`): see the
[main README](https://github.com/eugenius1/presenter-garage#claude-desktop).

## Licence

GPL-3.0-or-later.
