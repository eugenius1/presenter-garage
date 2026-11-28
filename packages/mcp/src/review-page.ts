import { MAX_NOTE } from "@presenter-garage/node/review";
import type { Review } from "@presenter-garage/node/review";
import { reviewData, type ReviewData } from "./review-view";

/**
 * The review page: one HTML document with its style and script inline, as
 * the command line's `report.html` is, served by the loopback server and
 * written into the review folder as a read-only snapshot.
 *
 * Every element is built with `textContent`, never `innerHTML`: the data is
 * lyrics, and a note is whatever the person typed. Each change is drawn as
 * the web app draws a finding -- among the slides around it, as it is, and
 * what it becomes -- from data `review-view.ts` builds.
 *
 * Served, it fetches the review from beside itself and saves the choices it
 * changed, half a second after the last change, so a burst of clicks is one save, or
 * at once when the page loses focus; one save at a time, so an older one
 * never lands after a newer. It says when everything is saved, and a save
 * that fails stops it taking more, so nothing the person does afterwards is
 * silently lost. As a snapshot, the data is inside it and nothing can be
 * changed.
 */

const STYLE = `
:root { color-scheme: light dark; --line: #8884; --muted: #888; --warn: #b00020; --accent: #3b82f6; --added: #15803d; }
@media (prefers-color-scheme: dark) { :root { --warn: #ff6b81; --added: #4ade80; } }
body { font: 15px/1.45 system-ui, sans-serif; margin: 0 auto; max-width: 62rem; padding: 0 1rem 3rem; }
header { position: sticky; top: 0; background: Canvas; padding: .6rem 0; border-bottom: 1px solid var(--line); z-index: 1; }
h1 { font-size: 1.2rem; margin: 0 0 .3rem; }
h2 { font-size: 1.05rem; margin: 1.6rem 0 .4rem; }
p { margin: .3rem 0; }
button { font: inherit; margin: .2rem .4rem .2rem 0; }
.run { margin: .6rem 0 1rem; }
.slide { border-left: 2px solid var(--line); padding-left: .7rem; margin: .5rem 0; }
.slide.holds { border-left-color: var(--accent); }
.heading { color: var(--muted); font-size: .9em; }
.context { color: var(--muted); white-space: pre-wrap; }
.change { display: grid; grid-template-columns: auto 1fr; gap: .15rem .6rem; padding: .45rem 0; }
.change > :not(input[type=checkbox]) { grid-column: 2; }
.change input[type=text] { font: inherit; padding: .2rem .3rem; }
.where { color: var(--muted); font-size: .9em; }
.text { white-space: pre-wrap; }
.becomes { color: var(--added); white-space: pre-wrap; }
.label { color: var(--muted); font-size: .85em; text-transform: uppercase; letter-spacing: .03em; margin-right: .3rem; }
.closed { opacity: .6; }
#problem, #warning { font-weight: 600; }
#problem { color: var(--warn); }
#problem:empty, #warning:empty { display: none; }
.outcome { color: var(--muted); }
`;

const SCRIPT = `
const MAX_NOTE = ${MAX_NOTE};
const base = location.protocol === "file:" ? null : location.pathname.replace(/\\/?$/, "/");
let state = {}, closed = new Set(), timer, stopped = false;
/**
 * What this page has changed and not yet saved, by change, each with the
 * fields changed: only those are sent, so a second tab on the same review
 * sends what it changed, never its stale copy of what another tab changed.
 */
const pending = new Map();
/** The save on its way, if any: one at a time, since one sent beside it could land first and be overwritten by the older. */
let inflight = null;
/** Chrome refuses a keepalive body over 64 KiB; a big review with many notes is sent without it. */
const KEEPALIVE_MAX = 60000;
const boxes = [];

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props || {});
  for (const child of children) if (child != null) node.append(child);
  return node;
}
const status = (text) => (document.getElementById("status").textContent = text);

function stop(message) {
  stopped = true;
  clearTimeout(timer);
  status("");
  document.getElementById("problem").textContent = message;
  for (const input of document.querySelectorAll("input, button")) input.disabled = true;
}

function counted() {
  const open = Object.keys(state).filter((n) => !closed.has(Number(n)));
  const chosen = open.filter((n) => state[n].ticked).length;
  document.getElementById("count").textContent = chosen + " of " + open.length + " changes chosen";
}

function changed(field, ...ns) {
  counted();
  if (stopped || ns.length === 0) return;
  for (const n of ns) pending.set(String(n), new Set([...(pending.get(String(n)) || []), field]));
  status("Saving…");
  clearTimeout(timer);
  timer = setTimeout(save, 500);
}

/** Save what has changed, resolving once it, and anything changed while it was on its way, has landed. */
function save() {
  clearTimeout(timer);
  if (inflight) return inflight; // It sends again before it resolves if anything changed meanwhile.
  if (stopped || pending.size === 0) return Promise.resolve();
  inflight = (async () => {
    while (pending.size > 0 && !stopped) {
      const sent = [...pending];
      const changes = Object.fromEntries(sent.map(([n, fields]) => [n, Object.fromEntries([...fields].map((f) => [f, state[n][f] ?? ""]))]));
      pending.clear();
      const body = JSON.stringify({ changes });
      try {
        const response = await fetch(base + "choices", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body,
          // Measured as sent: a note in Cyrillic is two bytes a character.
          keepalive: new TextEncoder().encode(body).byteLength < KEEPALIVE_MAX,
        });
        if (!response.ok) throw new Error(await response.text());
      } catch (e) {
        // Still unsaved, so closing the tab still warns.
        for (const [n, fields] of sent) pending.set(n, fields);
        stop("Not saved: ask Claude to reopen this review. " + (e && e.message ? e.message : ""));
      }
    }
    inflight = null;
    if (!stopped) status("All choices saved");
  })();
  return inflight;
}

function setAll(list, ticked) {
  for (const { n, box } of list) {
    if (closed.has(n)) continue;
    state[n].ticked = ticked;
    box.checked = ticked;
  }
  changed("ticked", ...list.filter(({ n }) => !closed.has(n)).map(({ n }) => n));
}

/** A line's text, or a dash for an empty one, which would otherwise show as nothing. */
const line = (text) => (text === "" ? "—" : text);

function changeRow(change, written, replan, readOnly, mine) {
  const done = closed.has(change.n);
  const box = el("input", { type: "checkbox", checked: state[change.n].ticked, disabled: done || readOnly, id: "c" + change.n });
  box.setAttribute("aria-label", "Change " + change.n + ": " + change.where);
  box.addEventListener("change", () => { state[change.n].ticked = box.checked; changed("ticked", change.n); });
  const after = written.has(change.n) ? " · written" : replan.has(change.n) ? " · its presentation was written since: plan it again to make it" : "";
  const parts = [el("div", { className: "where", textContent: change.n + ". " + change.where + after })];
  if (change.kind === "structure") {
    parts.push(el("div", { className: "text", textContent: change.said }));
  } else {
    if (change.insert) parts.push(el("div", { className: "text" }, el("span", { className: "label", textContent: "Added " + change.insert }), line(change.beside)));
    else parts.push(el("div", { className: "text" }, el("span", { className: "label", textContent: "Now" }), line(change.before)));
    parts.push(el("div", { className: "becomes" }, el("span", { className: "label", textContent: "Becomes" }),
      change.after === null ? el("em", { textContent: "line removed" }) : line(change.after)));
    if (change.styling) parts.push(el("div", { className: "where", textContent: "Styling: " + change.styling.join("; ") }));
  }
  if (readOnly) {
    if (state[change.n].note) parts.push(el("div", { className: "text" }, el("span", { className: "label", textContent: "Note" }), state[change.n].note));
  } else {
    const note = el("input", { type: "text", value: state[change.n].note || "", maxLength: MAX_NOTE, placeholder: "Note (why, or what else)" });
    note.setAttribute("aria-label", "Note on change " + change.n);
    note.addEventListener("input", () => { state[change.n].note = note.value; changed("note", change.n); });
    parts.push(note);
  }
  mine.push({ n: change.n, box });
  boxes.push({ n: change.n, box });
  return el("div", { className: "change" + (done ? " closed" : "") }, box, ...parts);
}

function render(data, readOnly) {
  state = data.choices;
  const written = new Set(data.written);
  const replan = new Set(data.needNewPlan);
  closed = new Set([...written, ...replan]);
  document.title = data.title;
  document.getElementById("warning").textContent = data.warning;
  const main = document.getElementById("changes");
  for (const file of data.files) {
    const mine = [];
    const byN = new Map(file.changes.map((c) => [c.n, c]));
    const row = (n) => changeRow(byN.get(n), written, replan, readOnly, mine);
    main.append(el("h2", { textContent: file.name }));
    if (!readOnly) {
      main.append(el("div", {},
        el("button", { type: "button", textContent: "Select all in this presentation", onclick: () => setAll(mine, true) }),
        el("button", { type: "button", textContent: "Deselect all in this presentation", onclick: () => setAll(mine, false) })));
    }
    for (const run of file.runs) {
      const block = el("div", { className: "run" });
      for (const slide of run) {
        const heading = "Slide " + (slide.slideIndex + 1) + (slide.group ? " · " + slide.group : "") + (slide.macros.length ? " · " + slide.macros.join(", ") : "");
        const box = el("div", { className: "slide" + (slide.holds ? " holds" : "") }, el("div", { className: "heading", textContent: heading }));
        for (const entry of slide.entries) box.append("n" in entry ? row(entry.n) : el("div", { className: "context", textContent: line(entry.text) }));
        if (slide.entries.length === 0) box.append(el("div", { className: "context", textContent: "(no text)" }));
        block.append(box);
      }
      main.append(block);
    }
    for (const n of file.stray) main.append(row(n));
  }
  const outcomes = document.getElementById("runs");
  for (const run of data.runs) {
    const wrote = run.files.filter((f) => f.written).length;
    outcomes.append(el("p", { className: "outcome", textContent: run.at + ": " + wrote + " of " + run.files.length + " presentations written" }));
    // A file can be written and still not read back as promised: that is said too, not hidden behind the count.
    for (const f of run.files.filter((f) => !f.written || f.reason)) {
      const why = f.detail || f.reason || "";
      outcomes.append(el("p", { className: "outcome", textContent: f.name + (f.written ? ": written, but " + why : ": not written (" + why + ")") }));
    }
  }
  counted();
}

const embedded = document.getElementById("data");
if (embedded) {
  const snapshot = JSON.parse(embedded.textContent);
  render(snapshot.review, true);
  status("Choices as of " + new Date(snapshot.at).toLocaleString() + ". To change them, ask Claude to open this review.");
} else {
  document.getElementById("all").onclick = () => setAll(boxes, true);
  document.getElementById("none").onclick = () => setAll(boxes, false);
  document.getElementById("copy").onclick = async () => {
    await save();
    // A copy of choices that did not save would show the person what they never kept.
    if (stopped) return;
    const response = await fetch(base + "snapshot", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    status(response.ok ? "Saved a read-only copy as " + (await response.json()).file : "No copy was saved: " + (await response.text()));
  };
  // Switching to the chat to say "done" takes the focus away: save then, not half a second later.
  window.addEventListener("blur", save);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && save());
  window.addEventListener("beforeunload", (event) => {
    if (pending.size > 0 || inflight) event.preventDefault();
  });
  fetch(base + "review.json")
    .then((response) => (response.ok ? response.json() : response.text().then((t) => Promise.reject(new Error(t)))))
    .then((data) => { render(data, false); status("All choices saved"); })
    .catch((e) => stop("This review cannot be shown: " + e.message));
}
`;

/**
 * The page. Served, its inline style and script are allowed by `nonce`
 * alone, as the server's Content-Security-Policy names it. With `snapshot`,
 * the review is inside it and it changes nothing: `review.html`.
 */
export function reviewPage(nonce: string, snapshot?: { review: ReviewData; at: string }): string {
  // `<` escaped so no lyric or note can close the script element it sits in.
  const data = snapshot ? `<script type="application/json" id="data">${JSON.stringify(snapshot).replace(/</g, "\\u003c")}</script>\n` : "";
  const controls = snapshot
    ? ""
    : `<div><button type="button" id="all">Select all</button><button type="button" id="none">Deselect all</button><button type="button" id="copy">Save a read-only copy</button></div>\n`;
  const intro = snapshot
    ? "A read-only copy of a review of slide edits: every change as the line read and as it would read, ticked or not, with the notes left on it."
    : "Every change is shown as the line reads now and as it would read, among the slides around it. Untick any to leave it as it is, and say why in its note if you like: Claude reads the notes. Your choices are saved as you go. When you are done, tell Claude to apply them.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review slide edits</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<header>
<h1>${snapshot ? "Slide edits reviewed" : "Choose the slide edits to make"}</h1>
<p>${intro}</p>
<p id="warning"></p>
${controls}<p><span id="count"></span> · <span id="status"></span></p>
<p id="problem"></p>
</header>
<div id="runs"></div>
<main id="changes"></main>
${data}<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

/** The read-only snapshot of a review as it stands now: `review.html`. */
export const snapshotHtml = (review: Review) =>
  reviewPage("", { review: reviewData(review, { portable: true }), at: new Date().toISOString() });
