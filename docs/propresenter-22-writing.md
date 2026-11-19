# Writing to a ProPresenter 22 workspace

The MCP server writes slide text into a **local** ProPresenter 22 workspace,
while **ProPresenter is closed**. This is what was found out about doing that
and how it is done ([#52](https://github.com/eugenius1/presenter-garage/issues/52)).
The format itself is in [propresenter-22-workspaces.md](propresenter-22-workspaces.md),
and the four write guards every writing surface keeps are in
[AGENTS.md](../AGENTS.md).

Everything below was found on ProPresenter 22.0.1 on macOS, on a local
workspace of 474 presentations (518 documents), first on copies of its
database and then, once ProPresenter had to be driven, on the workspace
itself with a copy to restore from. Nothing has been tried on a Cloud
workspace or on Windows. The code that does the writing was then run on the
real workspace itself, with a backup to restore from: ProPresenter showed
its edits with their ranges moved, found them by search, kept them through
an edit of its own and a restart, and the write was refused while
ProPresenter ran. See *What has been verified* below.

## What the experiments showed

### Our Loro is ProPresenter's Loro

The binary of 22.0.1 (`ProCore.framework`) embeds `loro-internal` 1.17.1, the
version `loro-crdt` is pinned to here. ProPresenter 20 embedded 1.5.8, which
is what raised the question.

Every one of the 518 snapshots imports, exports as a snapshot and imports
again to the same JSON, the same version vector and the same frontiers. The
exported bytes are **not** the stored bytes for 510 of them, so a document can
only be compared by what it decodes to, never byte for byte.

### What a row's bookkeeping is

| Column | What it is | If we get it wrong |
| --- | --- | --- |
| `sha256` | SHA-256 of `snapshot`, nothing more. True of all 518 rows | ProPresenter checks it when it opens the store ("snapshot SHA-256 does not match"). Not tried |
| `byte_count` | `length(snapshot)` | A `CHECK` constraint: SQLite refuses the row |
| `version_vector` | The document's Loro version vector: a count, then for each peer in ascending order of id the id as a varint and its counter as a zigzag varint. This is not the order `VersionVector.encode()` gives. Reproduced for all 518 rows | ProPresenter rewrote a deliberately stale one to the right value on opening, and carried on |
| `updated_at_ms` | When the row was last written | Left at its old value on one edited row: ProPresenter did not mind |
| `last_shared_version_vector`, `…_absence_reason` | What the Cloud server is known to hold. `NULL` and `2` on every row of a local workspace | Left alone |

`workspace_operation_receipts` is not a ledger of writes. 474 presentations
had three receipts between them. ProPresenter adds one, of kind `patch`, for
each change it makes itself, keyed by an operation id; it added none for rows
changed from outside and did not look for any.

`media-projection-cache-v1.json` is ProPresenter's to keep. Its
`snapshot_sha256` is not the row's `sha256`: no entry matched any row even in
the untouched workspace. ProPresenter rewrote the file on its own after
opening the edited store.

`presentation_search` is made the first time somebody searches, not when the
workspace is. Each row carries the version of the document it was indexed
from, and ProPresenter brings the index up to date when it starts: text
written from outside while it was closed was found by search on the next
launch, both when the index did not exist yet and when it did.

### An edit made while ProPresenter is closed

Made as one Loro change under a new random peer id, setting `rtf_data` on the
text element's map, then replacing `snapshot`, `sha256`, `byte_count`,
`version_vector` and `updated_at_ms` in one transaction:

- ProPresenter opened the workspace with no dialog and no warning, and showed
  the new text on the slide.
- Editing another slide of the same presentation in ProPresenter, and then the
  same text box, kept the outside edit. ProPresenter's change went on top of
  ours as an ordinary later change by its own peer.
- Both survived quitting and starting ProPresenter again.
- A second outside edit, on top of ProPresenter's own, was shown too.

### An edit made while ProPresenter is open is lost

ProPresenter reads the store when it starts and does not look again. A row
replaced under it was not shown, and the next time ProPresenter saved that
presentation it wrote its own copy over the row: the outside change was not
merged, it was gone, peer and all. Merely opening a presentation in
ProPresenter is a save, because it records `selected_arrangement`.

So a read-back straight after such a write would pass, and the edit would
vanish minutes later. Guard 4 cannot be kept with ProPresenter running.

**Whether it is running can be asked of the database.** A connection that
sets `PRAGMA locking_mode = EXCLUSIVE` and then begins a transaction is
refused with `database is locked` whenever another connection has read from
the store, and ProPresenter's has: refused every time while it ran, granted
once it had quit. That does not depend on process names, and while we hold
it ProPresenter cannot open the store either. The two helper processes that
outlive ProPresenter hold only `MediaStore/`, so they do not get in the way.

Opening the store for writing has one side effect of its own: closing the
last connection folds the `-wal` into the database and removes it, which is
what ProPresenter on Windows does when it quits.

### Text is not only `rtf_data`

A text element carries `attributes.custom_attributes`, a list of attributes
each with a `range` of character offsets into the box's plain text, end not
included, a line break counting as one. In this library 6,713 of 8,079 text
boxes have some, nearly all of them `capitalization` (All Caps), one range to
a line.

Changing the length of a line and leaving the ranges alone shifts the text
out from under them: after four characters were added to the middle line of a
three-line box, the last four characters of the box were no longer in
capitals. ProPresenter rewrites the ranges when it edits text itself.

So an edit to a workspace moves these ranges with the text. The same field
exists in a `.pro` file, where `applyFixes()` does not touch it; whether
ProPresenter 7 shows the same drift there has not been checked, and is
[#56](https://github.com/eugenius1/presenter-garage/issues/56).

### Two computers and one text box

Not tried against Cloud; this is what Loro does with the two changes, run
here on a real document. `rtf_data` is one value in a map, so:

- changes to **different** text boxes both survive;
- changes to the **same** box do not merge. One whole box wins: the change
  with the higher Lamport clock, which in practice is whoever had made more
  changes to that document, and on a tie the higher peer id. The loser's text
  is gone from the document as shown, on both computers.

ProPresenter uses one peer id per computer, the `peer_id` in
`media-manager.toml`.

## How it is written

One sentence: with the store locked, change the document as a single Loro
change by a new peer, and replace its row in a transaction that is rolled
back unless the row reads back as promised.

The pure half is `packages/core/src/lib/workspace-edit.ts`, which needs
neither SQLite nor Loro; the half that does is
`packages/node/src/workspace-write.ts`. The MCP server's `plan_slide_edits`
and `apply_slide_edits` (`packages/mcp/src/edits.ts`) are the only callers.

### Planning

A plan is made as for a `.pro` file, from the document converted to the old
message (`readForPlanning()`), so the person sees the same slides, boxes and
lines `read_presentation` shows. It records the row's `sha256`, not a hash
of the conversion. Everything applying would refuse for the document as it
stands is refused here too, before anybody reads a line: a Cloud or
unverified workspace, a document that fails the gate, and a box whose ranges
cannot be moved.

### Applying

`writeWorkspaceEdits()`, for every presentation of the run:

1. **Lock.** The store is opened for writing with `busy_timeout = 0` and
   `locking_mode = EXCLUSIVE`, then `BEGIN IMMEDIATE`. Refused means
   something has the workspace open: nothing is written and the person is
   told to quit ProPresenter (`PROPRESENTER_OPEN`). The lock is held to the
   end of the run, so ProPresenter cannot open the store meanwhile either.
2. **Compare and swap.** The row's `sha256` must still be the plan's. One
   that is not is left alone as `stale`, and the rest go ahead.
3. **Gate** (guard 1, below), on the row as read now.
4. **Plan in the document's terms** (`planWorkspaceEdit()`): the edited
   boxes' new RTF, from the same `spliceBoxes()` the `.pro` path uses; the
   map in the Loro document that holds each box, found by the same walk that
   numbers the boxes (`textBoxAddresses()`) and proved by holding exactly the
   RTF the plan read; and where each attribute range moves.
5. **Back up** (guard 2, below), every row about to change, before any does.
6. **Edit** the Loro document, never the conversion: a new random 63-bit
   peer id that the document has never seen, `rtf_data` set on the text
   element's map, each moved range set as a new value on its attribute's
   map, and one commit with a timestamp, as ProPresenter's own carry. Only
   values are set, in containers that are already there, and no container
   is created at all, which is stricter by choice than the one rule found.
   That rule was found by running `strings` on ProPresenter 22.0.1's
   ProCore library (`ProCore.framework`), where a log message says an
   imported patch "created a container under a key that already held one"
   and that a writer at schema 22.4 or above must never do this. The same
   message says that container's edits have left the document, and the
   messages around it are ProPresenter repairing such an orphan: grafting
   its elements back into the surviving container, or else keeping its
   edits out of the document it serves. A container under a key that holds
   none, as a new slide or a new action would need, is not what the message
   forbids, but has not been tried against ProPresenter. A range is set
   from JavaScript integers, which Loro stores as its 64-bit integer type.
   That ProPresenter wrote its own the same way, rather than as floating
   point, has not been checked byte for byte: only that both read back as
   the same whole numbers.
7. **Check** the new snapshot (guard 4, below).
8. **Write** `snapshot`, `sha256`, `byte_count`, `version_vector` (as
   `encodeVersionVector()` writes it) and `updated_at_ms`,
   `WHERE sha256 =` the plan's. Nothing else: no receipt, not the search
   index, not the media cache, not `last_shared_*`.
9. **Read the row back** on the same connection and check it again.

All the presentations of a run are in the one transaction. A presentation
refused before the backup is left out and the others written, as a `.pro`
file refused would be; past the backup, one that fails rolls the whole run
back, the others reported as `rolledBack`. After `COMMIT` the connection is
closed, which folds the `-wal` into the database, and the store is opened
again read-only to check each row once more.

### Moving the attribute ranges

`moveRanges()`. Each end of a range has to sit on the start or the end of a
line as the box reads now, counted in the box's characters with a line
break as one. Characters are counted as JavaScript counts them, in UTF-16
code units. For the accented French and English of the library tried that
is the count ProPresenter's ranges use; a character outside the Basic
Multilingual Plane, an emoji say, counts two here and has not been tried
there. It goes to the same place on that line
once the lines change length, so a range over one line stays over that
line, and one over the whole box still covers the whole box. A removed
line's range becomes empty, at the place the line was.

An end anywhere else -- inside a line, or past the text -- cannot be moved
without guessing what it was meant to cover, so that box is refused
(`attributeRanges`). In the library tried that is 55 of the 6,713 boxes that
carry ranges, nearly all of them lines that start with a tab the All Caps
range leaves out. Making the rule cover them is possible, since an end
inside a line that the edit does not touch could simply move with the lines
before it, but it has not been needed yet.

### The four guards

| Guard | How it is kept |
| --- | --- |
| 1. The fidelity gate passes on that document | `gate()`, at plan time and again inside the lock at apply time: the `sha256` beside the snapshot is its hash; the snapshot imports, exports and imports again to identical JSON, version vector and frontiers; and `encodeVersionVector()` of its version vector is byte for byte the stored `version_vector`, which shows the bookkeeping is understood for this row. `checkWritableWorkspace()`: the workspace's row in the registry beside it has no `cloud_uuid` and the `schema_version` checked against (`22.9.0`), and the folder holds no `imprint.cloud`; the store's `user_version` is `9`. And every box the person was shown is found in the Loro document holding exactly the RTF the plan read, with its ranges on its lines. Anything else refuses that document |
| 2. A backup exists before anything changes | Inside the lock, before the first `UPDATE`, each row about to change is written to the backup folder as three files at the path its `.pro` file had: `<name>.pro.loro`, the snapshot as stored; `<name>.pro.row.json`, the other columns, bytes as hex; and `<name>.pro`, the conversion, for a person to read. Each is read back and compared and its folders flushed (`writeBackups()`, shared with the `.pro` path). If one cannot be made the run is rolled back and nothing is written |
| 3. A person saw every line and chose it | Unchanged: `apply_slide_edits` takes a plan id, and the server asks through MCP elicitation, one tick box per line. The confirmation says to quit ProPresenter first |
| 4. The result is read back and compared | Three times. The new snapshot, before it is written: decoded afresh, it must be the old document with exactly the planned `rtf_data` and ranges and nothing else (`checkWorkspaceEdit()`), its version vector the old one plus our one peer (`onlyPeerAdded()`), and every line of every box, read through the conversion, what was promised (`verifyLines()`, which `applyFixes()` uses too). The row, read back on the same connection before `COMMIT`, checked the same way. And the store reopened read-only after it. A mismatch before `COMMIT` rolls the run back |

One place this differs from the design the experiments led to: that design
had a mismatch found after `COMMIT` put the backed-up rows back. It is
reported instead (`readBackFailed`), with the backup's path, and nothing is
put back automatically. Putting a row back is a write of its own, which
wants the lock and a person choosing it as much as the first did, and the
`.pro` path answers the same case the same way. It would take a disk that
loses a committed write to happen at all.

### ProPresenter open, ProPresenter closed

Closed is the only case that writes. Open is refused at the lock, not by
looking for a process, so it works the same on any system and whatever the
process is called. Reading stays as it is, beside a running ProPresenter.

What is left is ProPresenter starting during a run: it waits on the lock or
fails to open the store, for the fraction of a second a run takes.

### A Cloud workspace

Refused (`CLOUD_REFUSED`), at plan time and at apply time, until it has been
tried: a workspace with a `cloud_uuid` in the registry or an
`imprint.cloud` in its folder is not written to. That work is
[#55](https://github.com/eugenius1/presenter-garage/issues/55).

What is known says it should work. ProPresenter sends the server the
operations between `last_shared_version_vector` and the document's version
vector, so a change by a peer the server has not seen looks like any local
edit waiting to go up. What has to be seen on the Windows computer first:

- the change uploads, reaches a second computer, and is not undone by the
  next sync;
- what the server does with a peer id no signed-in computer owns;
- the same text box changed on another computer meanwhile. From the Loro
  rules above one whole box replaces the other, so guard 4 holds only until
  the next sync, and the person has to be told so before they choose.

### What has been verified, and what has not

- **Against ProPresenter 22.0.1 on macOS, by hand:** that it opens a
  snapshot written by our Loro and shows the edit; which bookkeeping it
  checks; that an edit survives a restart and later edits in the app; that
  an edit made while it runs is lost; that the exclusive lock is refused
  while it runs and granted once it has quit; and that unmoved ranges drift.
  The steps were the ones the code takes, run from experiment scripts.
- **Against built and copied databases:** the tests in
  `packages/node/src/__tests__/workspace-write.test.ts` and
  `packages/core/src/lib/__tests__/workspace-edit.test.ts`, on databases
  built in the test, and the same write against a copy of the real
  workspace's database. The gate passes on all 474 of its presentations.
- **Against ProPresenter 22.0.1 on macOS, by this code:** three marked
  edits written through `plan_slide_edits`/`apply_slide_edits`'s own
  functions into the real workspace, one of them a right-to-left Hebrew
  line. ProPresenter showed each with its All Caps ranges moved, toolbar
  Search found all three, an edit made in its editor to the same box kept
  ours, both survived a restart, and a write tried while it ran was refused
  at the lock. The store was restored from its backup afterwards.
- **Not at all:** Windows; a Cloud workspace; a ProPresenter release other
  than 22.0.1. Another `schema_version` or `user_version` is refused until
  it has been checked.

### What it does not do

- Write with ProPresenter open, on any system.
- Write to a Cloud workspace.
- Anything but slide text: playlists, the media bin, restyling.
- Restore from a backup on request. Putting a row back is a write, and wants
  the same lock and the same person choosing it.
- Write from the web app, which cannot read a workspace yet
  ([#54](https://github.com/eugenius1/presenter-garage/issues/54)).
