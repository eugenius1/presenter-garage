# Notes for coding agents

Deliberately short: this file is loaded into context on every session, so it
carries only attribution, and the rules whose cost is unrecoverable if missed.
Anything a test already enforces is left to [CONTRIBUTING.md](CONTRIBUTING.md)
— a failing suite catches those, nothing catches a destroyed library. Read
CONTRIBUTING.md before changing code: conventions, architecture, and the traps
that have cost real debugging time are all there.

A browser app, and its desktop app, for ProPresenter 7 files. Vite, React, TypeScript,
vitest. No server, no backend, nothing uploaded.

## Before every commit

```bash
npm run check
```

The gate CI runs; what it covers is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Before every push

Unless the change is trivial, strongly recommended: run `/code-review --fix`
(or an equivalent review-and-fix pass) over the branch's changes, using Claude
Sonnet or a model of similar strength, then commit its fixes and re-run the
pre-commit check above. It catches bugs, duplication, dead code and needless
complexity that the checks don't.

## Attribution

End every commit message with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

Use the model that actually did the work. Commit messages themselves are prose
explaining the reasoning and what went wrong — not a changelog line.

## Never commit somebody's ProPresenter library

Real `.pro` files, media-bin playlists and media folders are personal data and
stay out of the repository. Where development copies go instead, and how
tests reach real files, is under *Conventions* and *Testing against real
files* in [CONTRIBUTING.md](CONTRIBUTING.md).

## Never write over an original ProPresenter file unguarded

Writing back over the file ProPresenter owns is how a library gets destroyed.
The Media Bin tool never does it at all: its exports are a differently named
copy the user moves into place themselves — see `exportFilename()` in
`packages/core/src/lib/operations.ts`.

Presentations are written in place -- their text, and their structure (a
group renamed, a macro swapped: `packages/core/src/lib/structure.ts`) -- and
only through `applyFixes()` in
`packages/core/src/lib/fixes.ts` -- or, in a ProPresenter 22 workspace, which
has no files, only through `stageWorkspaceEdits()` and its `commit()` in
`packages/node/src/workspace-write.ts`, which edits the Loro document itself
and never writes from the converted message. Under Node both are reached only
through `applyPlan()` in `packages/node/src/apply.ts`, which the MCP server
and the desktop app share. Every surface that writes must
keep all four of these guards. Each is defined by what it protects, so a new surface keeps
it in its own form; do not add a write path that keeps fewer, and do not
quietly drop one from a path that has them:

1. **The fidelity gate passes on that file**, checked as the file is written
   rather than inferred from the corpus. The schema is reverse-engineered and
   protobuf.js silently drops fields it does not declare. See *The export
   safety gate* in CONTRIBUTING.md.
2. **A backup of exactly the files about to change exists before any of them
   changes**, and the run stops if it cannot be made.
3. **A person saw every change and chose it.** They see each line as it is
   and as it would read, and each structural change as it is and as it would
   be, one tick box to a change, before anything happens, and the run touches
   only what they left chosen. The model never answers for them.
4. **The result is read back and compared** to what was promised, for every
   line of every box including the ones no change touched, and for the whole
   structure -- every group, the order of the slides, every arrangement and
   the macros on every slide -- whether or not a change was meant to touch
   it. A file that comes back saying anything else is not written.

| Guard | Web app (`apps/web/src/tools/presentations/useFixRun.ts`) | MCP server (`packages/node/src/edits.ts`) | MCP server, ProPresenter 22 workspace (`packages/node/src/workspace-write.ts`) | Desktop app (`apps/desktop/src/handlers.ts`) |
| --- | --- | --- | --- | --- |
| 1 | `applyFixes()` | `applyFixes()`, run again on the file as read at apply time, structural changes included, each still describing the file (`isCurrent()`); a plan with structural changes is also made in memory at plan time | `gate()` on the row as read inside the exclusive lock (snapshot hash, Loro round trip, version vector encoding), the workspace's registry `schema_version` and the store's `user_version` among those verified, a Cloud workspace's document only when its `last_shared_version_vector` covers its version vector (`syncedWithCloud()`), and every edited box found in the document with exactly the RTF planned, and every one of its ranges mapped through the edit without a guess (`moveRanges()`); every structural change a value set in a map the document already holds, holding exactly what was planned, none over a container and none needing a new one (`valueEdits()` in `packages/core/src/lib/workspace-edit.ts`) | `planChosenFixes()` and `applyPlan()`, as the MCP server's two columns |
| 2 | The write button stays disabled until the user downloads a backup zip covering the selection (`backedUp`) | `backUpReplacements()` in `packages/node/src/write.ts` copies every file out of the library and reads each copy back; `applyPlan()` makes every root's backups before it writes into any, and writes nothing in any root, a workspace included, if one fails | The rows about to change (snapshot, other columns, converted `.pro`) written out inside the lock and read back before the first `UPDATE` (`stageWorkspaceEdits()`), the lock held until every other root of the call is backed up too; none written in any root if one fails | As the MCP server's two columns, into the same backup folder; no IPC call writes bytes, so there is no other way to disk |
| 3 | Every line shown with a tick box (`FindingsCard.tsx`), and a run writes only the lines left ticked; no structural change is offered | `apply_slide_edits` takes only a plan id, and the server asks the person through MCP elicitation, one tick box per line and per structural change, each as it is and as it would be (`describeChange()` in `packages/mcp/src/edits.ts`), among the slides around it; a client that cannot ask gets nothing written | The same | Every line shown with a tick box in the web app's interface, and for a Cloud workspace the Cloud warning beside the button that writes (`FixCard.tsx`); the page sends the ticked lines as shown, and `planChosenFixes()` writes a line only if the file as read now gives exactly that change; no structural change is offered |
| 4 | `applyFixes()`: every line, every attribute range where it was planned (`verifyRanges()`), and the whole structure as promised (`readStructure()` against `expectStructure()`) | `applyFixes()`, as for guard 1 | `checkWorkspaceEdit()`: the new snapshot, decoded afresh, is the old document plus exactly the planned `rtf_data`, ranges and structural values, its version vector the old one plus one new peer, every line of every box reads as promised (`verifyLines()`, as `applyFixes()` uses), the whole structure reads as promised through the conversion (`sameStructure()`), and every range of every edited box runs forwards within its text; again on the row read back before `COMMIT`, a mismatch rolling the run back, and once more from a fresh connection after | As the MCP server's two columns |

Structural changes are planned by the MCP server's `plan_slide_edits`
(`renameGroups`, `swapMacros`) and go through the same `applyPlan()`,
`applyFixes()` and `stageWorkspaceEdits()` as text, never a path beside them.

A workspace is written only while ProPresenter is closed: the store is taken
with an exclusive lock, refused while ProPresenter has it open, because a
change made under a running ProPresenter is silently lost at its next save.
Do not weaken that to a process check or a warning.

A command line, when there is one, uses `packages/node` for 2 and must get 3
from a person at a terminal, or from a plan file a person reviewed — never
from a flag a script can pass on its own.
