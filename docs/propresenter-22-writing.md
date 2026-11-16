# Writing to a ProPresenter 22 workspace

Nothing here writes to a workspace yet. This is what was found out about
doing it, and the design those findings lead to
([#52](https://github.com/eugenius1/presenter-garage/issues/52)). The format
itself is in [propresenter-22-workspaces.md](propresenter-22-workspaces.md).

Everything below was found on ProPresenter 22.0.1 on macOS, on a local
workspace of 474 presentations (518 documents), first on copies of its
database and then, once ProPresenter had to be driven, on the workspace
itself with a copy to restore from. Nothing has been tried on a Cloud
workspace or on Windows.

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

So an edit to a workspace has to move these ranges with the text. The same
field exists in a `.pro` file, where `applyFixes()` does not touch it either;
whether ProPresenter 7 shows the same drift there has not been checked.

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

## The design

One sentence: with ProPresenter closed and the store locked, change the
document as a single Loro change by a new peer, and replace its row in a
transaction that is rolled back unless the row reads back as promised.

A plan is made as now, by reading through the conversion to the old message.
It records the `sha256` of the row it was made from. Applying it, for every
presentation in the plan:

1. **Lock.** Open the store for writing, `locking_mode = EXCLUSIVE`, no
   waiting, `BEGIN IMMEDIATE`. Refused means something has the workspace
   open: nothing is written and the person is told to quit ProPresenter. The
   lock is held to the end of the run.
2. **Compare and swap.** The row's `sha256` must be the plan's, and must be
   the hash of the snapshot it sits beside.
3. **Gate.** See guard 1.
4. **Back up.** See guard 2.
5. **Edit** the Loro document, never the conversion: a new random peer id,
   never reused; `rtf_data` set to the bytes `applyEdits()` gives for that
   box; each `custom_attributes` range moved by the change in length of the
   lines before its ends; one commit. Only values are set. No container is
   ever created, which ProPresenter's own messages say a writer must never do
   under a key that holds one.
6. **Check** the new snapshot. See guard 4.
7. **Write** `snapshot`, `sha256`, `byte_count`, `version_vector` and
   `updated_at_ms`, `WHERE sha256 =` the plan's. Nothing else: no receipt,
   not the search index, not the media cache, not `last_shared_*`.
8. **Read the row back** on the same connection and check it again before
   `COMMIT`. Anything wrong is a `ROLLBACK`, and the store is as it was.

All the presentations of a run go in the one transaction.

### The four guards

| Guard | How it is kept |
| --- | --- |
| 1. The fidelity gate passes on that document | At apply time, on the row as read then: the snapshot imports, exports and imports again to identical JSON, version vector and frontiers; our encoding of its version vector is byte for byte the stored `version_vector`, which shows the bookkeeping is understood for this row; every text box the person was shown is found in the Loro document holding exactly the RTF the plan was made from; every `custom_attributes` range of an edited box falls on the lines as we read them. And on the workspace: `schema_version` in the registry and `user_version` of the store are ones this has been checked against (`22.9.0` and `9`). Anything else refuses that document |
| 2. A backup exists before anything changes | The rows about to change are written to the backup folder before the first `UPDATE`: the snapshot as stored, the other columns beside it, and the `.pro` file the conversion gives, for a person to read. Each is read back and compared, and the run stops if one cannot be made. They are made inside the lock, so they are the rows that get replaced |
| 3. A person saw every line and chose it | Unchanged: a plan id, and one tick box per line through MCP elicitation |
| 4. The result is read back and compared | Three times. The new snapshot, before it is written: decoded afresh, it must differ from the old document in the chosen boxes' `rtf_data` and ranges and in nothing else, its version vector must be the old one plus our one peer, and read through the conversion every line of every box must be what was promised, by the same `verify` the `.pro` path uses. The row, before `COMMIT`. And the store reopened read-only after it. A mismatch before `COMMIT` rolls back; one after it puts the backed-up rows back and says so |

### ProPresenter open, ProPresenter closed

Closed is the only case that writes. Open is refused at step 1, by the lock
and not by looking for a process. Reading stays as it is, beside a running
ProPresenter.

What is left is ProPresenter starting during a run: it waits on the lock or
fails to open the store, for the fraction of a second a run takes.

### A Cloud workspace

Refused, as now, until it has been tried: a workspace with a `cloud_uuid` in
the registry or an `imprint.cloud` in its folder is not written to.

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

### What it does not do

- Write with ProPresenter open, on any system.
- Write to a Cloud workspace.
- Anything but slide text: playlists, the media bin, restyling.
- Restore from a backup on request. Putting a row back is a write, and wants
  the same lock and the same person choosing it.
