# Our slide rules

A sample, to copy and rewrite in your own words and language. Presenter
Garage's tools do not read this file. An assistant does: it reads these rules
and compiles them into `rules.json`, beside this file, which the checks run.
After changing this file, ask the assistant to compile it again; the tools
tell you when `rules.json` is older than this file.

Keep this file in the folder you run the assistant from, or in
`Documents/ProPresenter`. Do not put it inside a ProPresenter workspace
folder: that folder is ProPresenter's.

Tiers say when a rule is dealt with:

- **Tier 1**: fixes safe to make in bulk.
- **Tier 2**: each case reviewed by a person.
- **Tier 3**: last, once the rest is done.

## Text

Tier 1, for every song.

- No space at the start or end of a line.
- No double spaces inside a line.
- No comma, full stop or semicolon at the end of a line. An ellipsis is fine:
  it shows the line runs on into the next slide.

## Repeat markers

Tier 2. No "x2", "(x3)", "2x" or "rpt" at the end of a line. Write the lines
out as many times as they are sung, so the slides follow the singing. Show
each change with two slides either side, since the repeat may already be
written out.

## Group names

Tier 2. Every group name is one from ProPresenter's group list. A name that
differs only by a space (a non-breaking one, say) counts as a different name.
A name that is not in the list goes to a person, who either renames it or adds
it to the list.

Exception: the song "Psalm 23" keeps its group "Psalm 23:1-6", a reading
heading that is not meant to be a group in the list.

## Structure

Tier 2, for the libraries Songs and Hymns only.

- Every song starts with an Intro group.
- Every song ends with a Blank group, so the screen clears after the last
  verse.
- No Blank group straight after an Intro group: its slide belongs in the
  Intro.
- A group used more than once (a Chorus, say) has the same words each time.

## Macros

- Tier 2: the first slide carries Welcome or Song Start, and at least one
  macro.
- Tier 2: a slide carrying Song is never given another macro as well.
- Tier 3: every other slide carries Song, and only Song.
