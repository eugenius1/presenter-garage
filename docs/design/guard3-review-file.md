# Choosing slide edits in a review page

A design, not yet built, for how the MCP server gets AGENTS.md's third
guard -- a person saw every change and chose it -- when a plan is too big
for a form in a chat, or the client cannot show one. Agreed on 2026-11-28.
The four guards and where each surface keeps them are in
[AGENTS.md](../../AGENTS.md).

## Why

Today `apply_slide_edits` asks the person through MCP form elicitation, one
tick box per change with the slides around it (#86), in
`packages/mcp/src/edits.ts`. That works for a few corrections to one song.
It does not work for a cleanup across a library:

- **Too big for a form.** A plan holds at most 200 changes
  (`MAX_PLAN_LINES`), and a client's form is no reading pane.
- **No break.** The form has to be answered in one sitting, within the hour
  `CONFIRM_TIMEOUT_MS` allows. Plans live in memory (`PlanStore`) for an
  hour at most, and die with the server.
- **Some clients can't ask.** A client without form elicitation gets
  nothing written at all.
- **The model reads every line.** `plan_slide_edits` returns every line as
  it is and as it would read, so a library's lyrics go to the model's
  provider, which is what the out tools (#83) avoid.
- **"No" says nothing.** An unticked box tells the model nothing about why.

## The flow

1. **Plan into a folder.** `plan_slide_edits` takes an optional `out`, as
   `check_presentations` does. With `out`, it makes a new folder inside
   `out`, named for the tool and the time. It follows #83's rules: never
   inside a library or holding one, and never writing over or removing
   anything. The plan is written there, and the model is answered with
   counts and the folder's path, not the lines. A plan with `out` holds up
   to 2,000 changes.
2. **Open the page.** The server serves the review page on `127.0.0.1` and
   opens it in one of two ways:
   - through URL elicitation where the client declares `elicitation.url`
   - in the system browser where it does not (`open`, `start`, or
     `xdg-open`)

   The answer carries the URL either way, in case nothing opened.
   `open_review(folder)` serves a review again later, possibly on another
   port, after a break or in a new session.
3. **Choose.** The person ticks and unticks changes, and can leave a note on
   any of them. Every choice is saved to the folder as it is made.
4. **Read the notes.** `read_review(folder)` returns the counts and the
   notes and writes nothing. The person can untick everything, leave notes
   and ask the model to plan again with them in mind.
5. **Apply.** When the person says they are done, the model calls
   `apply_slide_edits` with the folder.
   - **A client with form elicitation:** the server asks the person once
     to confirm the set they chose, naming each presentation with how many
     of its changes are chosen. For example: "Write 37 of the 40 changes,
     in 6 presentations (Amazing Grace: 5 of 6, …)? Each is backed up to …
     first."
   - **A client without it:** the saved choices are taken as the person's,
     and the server writes without asking.

   The answer carries the outcome per file and the notes.

Without `out`, nothing changes. The plan stays in memory, the per-change
form is asked, at most 200 changes are allowed, and a client that cannot
ask gets nothing written. The refusal suggests planning again with `out`.

## The review folder

| File | Written | Holds |
| --- | --- | --- |
| `plan.json` | Once, at plan time | The plan as `applyPlan()` takes it. That is each `PlannedFile` with its `sha256`, its numbered lines and structural changes, and the slides around them. It also holds the library root it was made in and its backup folder, which `refuseUnlessOpen()` compares. |
| `choices.json` | On every save, batched to about half a second, atomically (temp file, then rename) | The plan's hash. For each change: ticked or not, and its note. |
| `runs.json` | After every apply | Each apply's outcome: which changes were written, and why each file that was not, was not. |
| `review.html` | At plan time, after every apply, and on request (`export_review(folder)`, or the page's "Save a read-only copy") | One self-contained, read-only snapshot with the plan, choices and outcomes embedded, headed with when it was made: "Choices as of 28 Nov 2026, 14:32". |

`plan.json` and `choices.json` are the source of truth. `review.html` is for
a look during a break with no session open, or to send to someone. Opened
from disk, it says how to change the choices: ask Claude to open the review.

The plan never expires. The hash check on each file, as it is read at apply
time, is what keeps an old plan safe. A plan made 14 days ago still writes every file that has not changed
since. Every file that has is refused alone (see *Applying*).

## The page

- **Drawn like the web app's findings, built like `report.html`.** Each
  change sits in its line's place among the slides around it, as it is and
  what it becomes, as `FindingsCard.tsx` draws a finding, with the
  whitespace that matters made visible by the same `visibleWhitespace()`,
  now in core. The page itself is one file with its style and script
  inline, built with `textContent`, as the command line's `report.html`
  is, and the served page and `review.html` are the same page. The MCP
  server may import only from `packages/`, never `apps/`, and ships as one
  small file, so the web app's React components were not brought into it
  (see *Rejected options*).
- **Every change is shown.** Nothing is paginated away or collapsed behind
  a click. Each change is shown as it is and as it would read, among the
  slides around it.
- **Tick boxes.** Every box starts ticked, as in elicitation and the web
  app. Select all and deselect all work globally and per presentation, as
  the web app's per-file box does. The count that would be written is
  always visible: "37 of 40 changes chosen".
- **Notes.** Every change has a one-line note, ticked or not, saved as it
  is typed: "why I unticked this", or "fine, but slide 7 has the same
  typo".
- **What was written.** Changes a run already wrote are shown as written,
  and can no longer be ticked. Nor can the other changes in a presentation
  a run wrote: its hash changed when it was written, so they are shown as
  needing a new plan, and `read_review` lists them for the model to plan
  again.
- **Saved before handing over.** The page says "Saving…" while a change
  is not yet on disk and "All choices saved" once the server has written
  it. It saves at once, without waiting for the batch, when it loses focus
  or is hidden, which is what switching to the chat to say "done" does.
  The page and `apply_slide_edits` are one server process, which writes a
  review's files one at a time, so apply waits for every save it has
  received for that review before it reads `choices.json`. What is left is
  a save still on its way over loopback, a millisecond or so, against the
  seconds it takes the person to say "done" and the model to call the tool.
  An explicit "done" step that apply waits for would close even that, at
  the cost of a step the person must remember; that was judged not worth it.
- **Warnings.** The page says what the form says before a write: that a
  Cloud workspace is Cloud, and to close ProPresenter. Where the client
  cannot ask, the page is all the person sees before anything is written.
- **When saving fails.** If the server has gone away (its session closed),
  the page says so ("Not saved: ask Claude to reopen this review") and
  stops taking ticks, so nothing the person does is silently lost. Nothing
  is kept in browser storage to merge later.
- **Loopback.** The page is served on `127.0.0.1` itself, not `localhost`,
  which can resolve to `::1`. Each review's URL carries a random token, and
  the server checks the `Host` header. That keeps other websites in the
  same browser from posting choices to the port (cross-site requests, DNS
  rebinding). It is not a defence against the model (see *Threat model*).
  Node's `http` server bound to `127.0.0.1` works the same on Windows,
  macOS and Linux, and a loopback-only listener does not trigger Windows
  Defender Firewall's prompt.

## Notes to the model

`read_review` and `apply_slide_edits` return each note with:

- its change number
- the presentation
- where the change is (slide, group, box and line)
- the line as it is and as it would read
- whether the change was left ticked

That leaks nothing new: the model wrote the "after" itself in
`plan_slide_edits`, and read the "before". Unnoted changes stay on disk. A
note that says a rule is wrong may lead the model to propose a change to
the team's rules. Editing rules stays outside this flow.

The per-change form has no notes: a text field per change would double a
form that is already long.

## Applying

`apply_slide_edits(folder)` does the following, in order:

1. Reads `plan.json` and checks its hash against the one recorded at plan
   time in the server's own state on disk, outside `out`: a marker file
   named for the hash in a `Reviews` folder beside the default `Backups`
   one (`defaultBackupDir()`), so it survives a restart as the plan does.
   The marker names the review folder the plan was written into, and a
   plan whose marker names another folder is refused too, so the
   `plan.json` and `choices.json` of one review copied into another do not
   pass. A plan that differs is refused whole: what is applied must be what
   the page showed. A review folder moved elsewhere is refused the same
   way, and is planned again.
2. Reads `choices.json`, and refuses it unless it names that plan's hash.
3. Refuses a review whose page has never shown it. Every change starts
   ticked, so without this a model that plans and applies at once, in a
   client that cannot ask, would write everything unseen: no tampering
   needed, only haste. The page records, in `choices.json`, when it first
   loaded the review.
4. Refuses unless the plan's library is the one open, as
   `refuseUnlessOpen()` does today.
5. Asks the one summary confirmation where the client can.
6. Runs the ticked changes that are still open through `applyPlan()` in
   `packages/node/src/apply.ts`, unchanged. A change is open while no run
   of this review has written its presentation.

So guards 1, 2 and 4 run exactly as they do today:

- `applyFixes()` again on each file as read now, or `stageWorkspaceEdits()`
  for a workspace, with its lock and `syncedWithCloud()`
- every backup made before anything is written
- every file read back

A file whose hash changed since the plan is skipped as `stale`, and the rest
are written. The answer lists the skipped files, so the model can plan just
those again into a smaller review.

A review can be applied again, for example after ProPresenter was open or a
backup failed. `runs.json` records what each run wrote, and a second apply
writes only presentations no run has written. Changes left unticked in a
presentation that was written cannot be applied from this review, since its
hash has changed; the page and `read_review` say so, and the model plans
them again. A file this review wrote would be refused as stale anyway:
nothing is written twice.

## Threat model for guard 3

Guard 3 is about the model answering for the person. Two strengths were
weighed:

- **(a) Through the server's interfaces only.** Nothing the model sends or
  writes through the server could count as the person's choice.
- **(b) Against any agent.** That includes one with a full shell, which can
  edit files, call the loopback port, or read the server's state.

Nothing local can stop (b): an agent like that can rewrite a `.pro` file
directly and skip every guard, not just this one. This design deliberately
does not hold (a) either, for the review path. Friendliness for a person
doing a large cleanup was judged worth more than proof against a model
working against them.

**Holds:**

- The person is shown every change, as it is and as it would read, and
  the run writes only changes left ticked in `choices.json`.
- What is applied is the plan the page showed. `plan.json` is checked
  against its hash at plan time, that hash's record must name this review
  folder, and `choices.json` must name that plan.
- Nothing is applied from a review whose page never loaded it, so a model
  in a hurry cannot apply every change, all ticked by default, unseen.
- Where the client can ask, the server itself asks the person to confirm
  the chosen set, and the model cannot answer that.
- Other websites in the browser cannot post choices (token, `Host` check).
- The model is told, in the server's instructions and the tool
  descriptions, never to edit a review's files, and never to choose or
  confirm for the person.

**Accepted risk:** a model that edits `choices.json`, or posts to the page
itself, is taken as the person. Where the client cannot ask, nothing else
is asked. Where it can, the summary confirmation names each presentation
with how many of its changes are chosen, so a swap that keeps every count
the same would still pass. That is the price of a friendly review that does
not block clients without elicitation, and AGENTS.md's guard 3 now says so.

**Unchanged:** the per-change form without `out` keeps today's strength. The
person's answer comes from the client, and a client that cannot ask gets
nothing written.

## Rejected options

- **A static HTML file as the source of truth** (the first idea). A
  `file://` page cannot write to disk except through a download the person
  moves by hand, and browsers block `fetch` of a sibling file, so it can
  neither save choices nor read them back. A static snapshot survives as
  `review.html`, but a running server takes the choices.
- **A choices file only a person could have written.** A secret token the
  model never sees, a one-time URL exchanged for a cookie, or an HMAC with
  a key the model cannot read. Each falls to an agent with a shell, and
  each made the flow less friendly. That was rejected in favour of the
  accepted risk above.
- **Blocking clients without elicitation**, as the form path does. That
  would leave reviews unusable in exactly the clients that most need them.
- **The web app's React components in the page.** The server may import
  only what `packages/` holds, so they would have to move into a shared
  package, and React and the app's dictionaries would go into a server that
  ships as one small file with no dependencies. The page follows
  `report.html` instead, and draws a change the way the web app does.
- **A write button in the page.** It would give two ways to start a write,
  and the outcome would not reach the model on its own. Only
  `apply_slide_edits` writes. The page shows the outcome afterwards.
- **The desktop app, or a detached helper process, serving the page.** The
  desktop app has to be installed and running, and would need a way to
  receive plans. A background daemon is more to secure and explain than it
  is worth. The MCP server serves it, and the review folder does not
  depend on the server, so the desktop app can open one later (see *Open
  questions*).
- **A 14-day limit on plans.** Checking each file's hash already makes an
  old plan safe, and a limit would only throw away a person's work.
- **Failing the whole run when one file changed.** A two-week-old cleanup
  of 50 songs would become unusable because one was edited.
- **Rewriting `review.html`, or a `choices.js` beside it, on every tick.**
  That writes to disk on every click for a view rarely opened. Snapshots at
  plan time, after each apply and on request are enough.
- **A scroll-to-the-end gate before applying.** It is theatre, and would
  make this surface stricter than the others for no real gain.
- **Notes in the per-change form.** See *Notes to the model*.

## Open questions

- **A command-line `apply-review <folder>`.** AGENTS.md already allows a
  command line to take guard 3 from "a plan file a person reviewed".
- **The desktop app opening a review folder** as a second place to review.
- **WSL2 and remote SSH.** The browser may not be on the machine running
  the server. WSL2 forwards localhost by default, but that is untried.
- **Two tabs on one review.** Each page sends only the changes it
  changed, so one tab's save never undoes another's; the last change made
  to each change wins. A tab still shows what it loaded, though, so it can
  show a tick another tab has since taken away. Refresh the other tabs, or
  detect it.
- **The next MCP revision.** 2026-07-28 changes URL elicitation (no
  `elicitationId`, no completion notification, no -32042). The design uses
  URL elicitation only to hand the link over, with the system browser as
  the fallback, so it should survive the change. The SDK's support for the
  new flow is unconfirmed.

## Proposed AGENTS.md column

A new column in AGENTS.md's table, beside the MCP server's two, once this
is built (`packages/mcp/src/review.ts`, say):

| Guard | MCP server, review page (`packages/mcp/src/review.ts`) |
| --- | --- |
| 1 | As the MCP server's column: `applyFixes()` run again on each file as read at apply time, or `gate()` inside the workspace's lock, through `applyPlan()` |
| 2 | As the MCP server's column: `applyPlan()` makes every root's backups before it writes into any |
| 3 | Every change shown on a page served on `127.0.0.1` from a review folder inside `out`, with a tick box (all ticked to start, select and deselect all) and a note, saved to `choices.json` as made. `apply_slide_edits` takes only the folder, refuses a review whose page never loaded it, a `plan.json` whose hash differs from plan time or was recorded for another folder, and a `choices.json` naming another plan, and writes only ticked changes in presentations no run has written. Where the client can ask, the server asks the person to confirm the chosen set. Where it cannot, the saved choices are taken as theirs, and the model is told never to edit them |
| 4 | As the MCP server's column: `applyFixes()` and `checkWorkspaceEdit()` through `applyPlan()` |
