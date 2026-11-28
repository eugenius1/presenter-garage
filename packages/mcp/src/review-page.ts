import { MAX_NOTE } from "@presenter-garage/node/review";

/**
 * The review page as the loopback server sends it: one HTML document with
 * its style and script inline, fetching the review from beside itself.
 *
 * Every element is built with `textContent`, never `innerHTML`: the data is
 * lyrics, and a note is whatever the person typed. Choices are sent whole,
 * half a second after the last change, so a burst of clicks is one save; a
 * save that fails stops the page taking more, so nothing the person does
 * afterwards is silently lost.
 */

const STYLE = `
:root { color-scheme: light dark; --line: #8884; --muted: #888; --warn: #b00020; }
body { font: 15px/1.45 system-ui, sans-serif; margin: 0 auto; max-width: 60rem; padding: 1rem; }
header { position: sticky; top: 0; background: Canvas; padding: .5rem 0; border-bottom: 1px solid var(--line); z-index: 1; }
h1 { font-size: 1.2rem; margin: 0 0 .3rem; }
h2 { font-size: 1.05rem; margin: 1.5rem 0 .3rem; }
button { font: inherit; margin-right: .4rem; }
.change { display: grid; grid-template-columns: auto 1fr; gap: .2rem .6rem; padding: .5rem 0; border-bottom: 1px solid var(--line); }
.change input[type=text] { grid-column: 2; font: inherit; padding: .2rem .3rem; }
.where { color: var(--muted); font-size: .9em; }
.written { opacity: .6; }
#problem { color: var(--warn); font-weight: 600; }
#problem:empty { display: none; }
.run { color: var(--muted); }
`;

const SCRIPT = `
const base = location.pathname.replace(/\\/?$/, "/");
const MAX_NOTE = ${MAX_NOTE};
let state = {}, written = new Set(), total = 0, timer, stopped = false;
const boxes = [];

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props || {});
  for (const child of children) node.append(child);
  return node;
}

function stop(message) {
  stopped = true;
  clearTimeout(timer);
  document.getElementById("problem").textContent = message;
  for (const input of document.querySelectorAll("input, button")) input.disabled = true;
}

function counted() {
  const open = Object.keys(state).filter((n) => !written.has(Number(n)));
  const chosen = open.filter((n) => state[n].ticked).length;
  document.getElementById("count").textContent =
    chosen + " of " + open.length + " changes chosen" + (written.size ? ", " + written.size + " written already" : "");
}

function changed() {
  counted();
  if (stopped) return;
  clearTimeout(timer);
  timer = setTimeout(save, 500);
}

async function save() {
  try {
    const response = await fetch(base + "choices", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changes: state }),
    });
    if (!response.ok) throw new Error(await response.text());
  } catch (e) {
    stop("Not saved: ask Claude to reopen this review. " + (e && e.message ? e.message : ""));
  }
}

function setAll(list, ticked) {
  for (const { n, box } of list) {
    if (written.has(n)) continue;
    state[n].ticked = ticked;
    box.checked = ticked;
  }
  changed();
}

function render(data) {
  state = data.choices;
  written = new Set(data.written);
  document.title = data.title;
  const main = document.getElementById("changes");
  for (const file of data.files) {
    const mine = [];
    main.append(
      el("h2", { textContent: file.name }),
      el("div", {},
        el("button", { type: "button", textContent: "Select all in this presentation", onclick: () => setAll(mine, true) }),
        el("button", { type: "button", textContent: "Deselect all in this presentation", onclick: () => setAll(mine, false) })
      )
    );
    for (const item of file.items) {
      total++;
      const done = written.has(item.n);
      const box = el("input", { type: "checkbox", checked: state[item.n].ticked, disabled: done, id: "c" + item.n });
      box.addEventListener("change", () => { state[item.n].ticked = box.checked; changed(); });
      const note = el("input", { type: "text", value: state[item.n].note || "", maxLength: MAX_NOTE, placeholder: "Note (why, or what else)" });
      note.setAttribute("aria-label", "Note on change " + item.n);
      note.addEventListener("input", () => { state[item.n].note = note.value; changed(); });
      const label = el("label", { htmlFor: box.id },
        el("div", { className: "where", textContent: item.n + ". " + item.where + (done ? " (written)" : "") }),
        el("div", { textContent: item.said })
      );
      main.append(el("div", { className: "change" + (done ? " written" : "") }, box, label, note));
      mine.push({ n: item.n, box });
      boxes.push({ n: item.n, box });
    }
  }
  const runs = document.getElementById("runs");
  for (const run of data.runs) {
    const wrote = run.files.filter((f) => f.written).length;
    runs.append(el("div", { className: "run", textContent: run.at + ": " + wrote + " of " + run.files.length + " presentations written" }));
    for (const f of run.files.filter((f) => !f.written)) {
      runs.append(el("div", { className: "run", textContent: "  " + f.name + ": not written (" + (f.detail || f.reason || "") + ")" }));
    }
  }
  counted();
}

document.getElementById("all").onclick = () => setAll(boxes, true);
document.getElementById("none").onclick = () => setAll(boxes, false);
fetch(base + "review.json")
  .then((response) => (response.ok ? response.json() : response.text().then((t) => Promise.reject(new Error(t)))))
  .then(render)
  .catch((e) => stop("This review cannot be shown: " + e.message));
`;

/** The page, its inline style and script allowed by `nonce` alone, as the server's Content-Security-Policy names it. */
export function reviewPage(nonce: string): string {
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
<h1>Choose the slide edits to make</h1>
<p>Every change is shown as the line reads now and as it would read. Untick any to leave it as it is, and say why in its note if you like: Claude reads the notes. Your choices are saved as you go. When you are done, tell Claude to apply them.</p>
<div><button type="button" id="all">Select all</button><button type="button" id="none">Deselect all</button> <span id="count"></span></div>
<p id="problem"></p>
</header>
<div id="runs"></div>
<main id="changes"></main>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}
