import type { Pair, Summary } from "./compare";
import { onItsOwn, sideBySide } from "./diff";
import { songMeta } from "./song";
import { sourceMeta, type Source } from "./source";

/**
 * `report.html`: the comparison as a person reviews it, one song to a page.
 *
 * One file with everything inline -- data, style, script -- so it opens from
 * the disk with no server and nothing fetched, and can be copied to another
 * computer as it is. It cannot write to the disk, so the person's picks
 * leave it as a `decisions.json` they download; they are kept in the
 * browser's storage meanwhile, and a downloaded file can be loaded back.
 *
 * The page builds its elements from the data with `textContent`, never
 * `innerHTML`: the data is lyrics, and a line holding `<b>` is a line
 * holding `<b>`.
 */

export interface ReportInput {
  created: string;
  a: Source;
  b: Source;
  pairs: readonly Pair[];
  summary: Summary;
}

export function reportHtml({ created, a, b, pairs, summary }: ReportInput): string {
  const data = {
    format: "presenter-garage/compare-report",
    created,
    labels: { a: a.label, b: b.label },
    sources: { a: sourceMeta(a), b: sourceMeta(b) },
    summary,
    pairs: pairs.map((pair) => ({
      id: pair.id,
      bucket: pair.bucket,
      matchedBy: pair.matchedBy,
      content: pair.content,
      later: pair.later,
      proposed: pair.proposed,
      differences: pair.differences,
      a: pair.a && songMeta(pair.a),
      b: pair.b && songMeta(pair.b),
      rows: pair.a && pair.b ? sideBySide(pair.a.groups, pair.b.groups) : onItsOwn((pair.a ?? pair.b)!.groups, pair.a ? "a" : "b"),
    })),
  };
  // `<` escaped so no lyric can close the script element it sits in.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const title = `${a.label} and ${b.label}: song comparison`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <div class="title"><h1>${escapeHtml(a.label)} <span class="vs">and</span> ${escapeHtml(b.label)}</h1><span class="muted" id="created"></span></div>
  <div class="filters">
    <label>Bucket <select id="f-bucket"></select></label>
    <label>Edited later <select id="f-later"></select></label>
    <label>Decided <select id="f-decided"><option value="">any</option><option value="no">not yet</option><option value="yes">decided</option></select></label>
    <label>Name <input id="f-name" type="search" placeholder="Search songs"></label>
  </div>
  <div class="actions">
    <span id="progress" class="muted"></span>
    <button id="accept-shown" type="button">Accept proposed for all shown</button>
    <label class="button">Load decisions… <input id="load" type="file" accept="application/json,.json" hidden></label>
    <button id="download" type="button" class="primary">Download decisions.json</button>
  </div>
</header>
<main>
  <nav>
    <button id="prev" type="button" title="Previous (←)">←</button>
    <select id="jump" aria-label="Song"></select>
    <button id="next" type="button" title="Next (→)">→</button>
    <span id="position" class="muted"></span>
  </nav>
  <section id="song"></section>
</main>
<script type="application/json" id="data">${json}</script>
<script>${CLIENT}</script>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const STYLE = `
:root { color-scheme: light dark; --bg: #fcfcfd; --fg: #1c2024; --muted: #60646c; --line: #d9d9e0; --panel: #f0f0f3;
  --accent: #3e63dd; --accent-fg: #fff; --mark: #ffe3a3; --mark-fg: #1c2024; --ok: #2b9a66; --chip: #e8e8ec; }
@media (prefers-color-scheme: dark) { :root { --bg: #111113; --fg: #edeef0; --muted: #b0b4ba; --line: #363a3f; --panel: #18191b;
  --accent: #5472e4; --accent-fg: #fff; --mark: #6b4a00; --mark-fg: #ffefc7; --ok: #3dd68c; --chip: #272a2d; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { position: sticky; top: 0; z-index: 1; background: var(--panel); border-bottom: 1px solid var(--line); padding: 10px 16px; display: grid; gap: 8px; }
.title { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
h1 { font-size: 18px; margin: 0; } .vs { color: var(--muted); font-weight: 400; }
h2 { font-size: 20px; margin: 0 0 4px; }
.muted { color: var(--muted); font-size: 13px; }
.filters, .actions, nav { display: flex; gap: 8px 14px; flex-wrap: wrap; align-items: center; }
label { font-size: 13px; color: var(--muted); display: inline-flex; gap: 6px; align-items: center; }
select, input[type=search], button, .button { font: inherit; font-size: 14px; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; }
button, .button { cursor: pointer; } button:hover, .button:hover { border-color: var(--muted); }
button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
button.chosen { outline: 2px solid var(--accent); outline-offset: 1px; font-weight: 600; }
main { padding: 12px 16px 48px; max-width: 1400px; margin: 0 auto; }
nav { margin-bottom: 12px; } #jump { max-width: min(60vw, 520px); }
.badge { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 999px; background: var(--chip); margin-right: 6px; }
.meta { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 10px 0; }
.meta > div { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-size: 13px; }
.meta .side { font-weight: 600; font-size: 14px; }
.later { color: var(--ok); font-weight: 600; }
.sbs tr.difference td { padding: 4px 10px; border-left: 3px solid var(--accent); background: var(--panel); }
.proposal { margin: 8px 0; padding: 8px 10px; border-left: 3px solid var(--accent); background: var(--panel); }
.decide { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0 14px; }
table.sbs { width: 100%; border-collapse: collapse; table-layout: fixed; }
table.sbs th { text-align: left; font-size: 13px; color: var(--muted); padding: 4px 8px; border-bottom: 1px solid var(--line); }
table.sbs td { vertical-align: top; padding: 8px; border-bottom: 1px solid var(--line); }
.group { font-weight: 600; margin-bottom: 4px; }
.slide { border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; margin: 4px 0; }
.line { white-space: pre-wrap; overflow-wrap: anywhere; min-height: 1.45em; }
.macro { display: inline-block; font-size: 12px; background: var(--chip); border-radius: 4px; padding: 0 6px; margin: 0 4px 2px 0; }
mark { background: var(--mark); color: var(--mark-fg); border-radius: 2px; }
.slide.split { border-color: var(--mark); border-bottom-width: 3px; }
mark.break { padding: 0 3px; margin-left: 2px; }
.nbsp { text-decoration: underline dotted; background: rgba(127,127,127,.25); }
.none { color: var(--muted); font-style: italic; }
.empty { padding: 40px; text-align: center; color: var(--muted); }
@media (max-width: 700px) { header { position: static; } .meta { grid-template-columns: 1fr; } main { padding: 8px 16px 40px; } }
`;

/**
 * The page's script, as plain JavaScript: it is written into the page as it
 * stands, never bundled or compiled. Kept free of backticks and `${` for
 * that reason.
 */
const CLIENT = String.raw`
(function () {
  "use strict";
  var data = JSON.parse(document.getElementById("data").textContent);
  var L = data.labels;
  var BUCKETS = {
    identical: "identical", spacing: "spacing or end punctuation only", groups: "group names only",
    different: "real differences", renamed: "renamed", onlyA: "only in " + L.a, onlyB: "only in " + L.b
  };
  var LATER = { a: L.a + " edited later", b: L.b + " edited later", same: "same time", unknown: "no dates" };
  var SOURCES = { file: "date in the file", modified: "file's date on disk", history: "change history",
    beforeUpgrade: "before the upgrade, from the .pro file", none: "unknown" };
  // The same two libraries share one key, so a report written again keeps the picks made in the last one;
  // a pick's id names both files, and one for a song no longer there is simply not shown.
  var KEY = "presenter-garage-decisions:" + L.a + "=" + data.sources.a.root + ":" + L.b + "=" + data.sources.b.root;
  var decisions = {};
  try { decisions = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) { decisions = {}; }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(decisions)); } catch (e) { /* private window: kept for this visit only */ } }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (k === "text") node.textContent = attrs[k]; else node.setAttribute(k, attrs[k]); }
    (children || []).forEach(function (c) { if (c != null) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return node;
  }
  function $(id) { return document.getElementById(id); }

  // A non-breaking space looks like any other; drawn so that it does not.
  function textWithSpaces(text) {
    var frag = document.createDocumentFragment();
    text.split(/( | | )/).forEach(function (part) {
      if (!part) return;
      if (/^[   ]$/.test(part)) frag.appendChild(el("span", { "class": "nbsp", title: "non-breaking space", text: part }));
      else frag.appendChild(document.createTextNode(part));
    });
    return frag;
  }
  function run(r) {
    if (Array.isArray(r) && r[0] === "\n") return el("mark", { "class": "break", title: "the other side does not break the line here", text: "↵" });
    if (Array.isArray(r)) { var m = el("mark"); m.appendChild(textWithSpaces(r[0])); return m; }
    var s = el("span"); s.appendChild(textWithSpaces(r)); return s;
  }
  function groupView(g) {
    if (!g) return el("div", { "class": "none", text: "no such group" });
    var name = el("div", { "class": "group" }, ["[", run(g.name), "]"]);
    var slides = g.slides.map(function (s) {
      var macros = s.macros.length ? el("div", null, s.macros.map(function (m) {
        var chip = el("span", { "class": "macro" }); chip.appendChild(run(m)); return chip;
      })) : null;
      var lines = s.lines.map(function (line) { return el("div", { "class": "line" }, line.map(run)); });
      if (!s.lines.length) lines = [el("div", { "class": "none", text: "no text" })];
      var slide = el("div", { "class": s.split ? "slide split" : "slide" }, [macros].concat(lines));
      if (s.split) slide.title = "the other side carries on into this slide's words: they are split across slides differently";
      return slide;
    });
    return el("div", null, [name].concat(slides));
  }

  // Filters.
  function fillSelect(select, options) {
    options.forEach(function (o) { select.appendChild(el("option", { value: o[0], text: o[1] })); });
  }
  var counts = data.summary.buckets;
  fillSelect($("f-bucket"), [["open", "needs a decision (all but identical)"], ["", "all"]].concat(
    Object.keys(BUCKETS).map(function (k) { return [k, BUCKETS[k] + " (" + counts[k] + ")"]; })));
  fillSelect($("f-later"), [["", "any"]].concat(Object.keys(LATER).map(function (k) { return [k, LATER[k]]; })));
  $("created").textContent = "compared " + data.created.slice(0, 16).replace("T", " ");

  var shown = [];
  var at = 0;
  function nameOf(p) { return (p.a || p.b).name; }
  function applyFilters(keepId) {
    var bucket = $("f-bucket").value, later = $("f-later").value, decided = $("f-decided").value;
    var q = $("f-name").value.trim().toLowerCase();
    shown = data.pairs.filter(function (p) {
      if (bucket === "open" ? p.bucket === "identical" : bucket && p.bucket !== bucket) return false;
      if (later && p.later !== later) return false;
      if (decided === "yes" && !decisions[p.id]) return false;
      if (decided === "no" && decisions[p.id]) return false;
      if (q && nameOf(p).toLowerCase().indexOf(q) < 0 && (!p.b || p.b.name.toLowerCase().indexOf(q) < 0)) return false;
      return true;
    });
    var jump = $("jump");
    jump.textContent = "";
    shown.forEach(function (p, i) {
      jump.appendChild(el("option", { value: String(i), text: (decisions[p.id] ? "✓ " : "") + nameOf(p) }));
    });
    var found = keepId ? shown.findIndex(function (p) { return p.id === keepId; }) : -1;
    at = found >= 0 ? found : Math.min(at, Math.max(shown.length - 1, 0));
    draw();
  }
  ["f-bucket", "f-later", "f-decided"].forEach(function (id) { $(id).addEventListener("change", function () { at = 0; applyFilters(); }); });
  $("f-name").addEventListener("input", function () { at = 0; applyFilters(); });

  function progress() {
    var open = data.pairs.filter(function (p) { return p.bucket !== "identical"; });
    var done = open.filter(function (p) { return decisions[p.id]; }).length;
    $("progress").textContent = done + " of " + open.length + " decided";
  }

  function sideMeta(p, side) {
    var song = p[side], label = L[side];
    if (!song) return el("div", null, [el("div", { "class": "side", text: label }), el("div", { "class": "none", text: "not in " + label })]);
    var e = song.edited;
    var date = e.at ? e.at.slice(0, 16).replace("T", " ") : (e.notAfter ? "not since " + e.notAfter.slice(0, 10) : "unknown");
    var byRule = Object.create(null);
    song.findings.forEach(function (f) { if (f.excepted === undefined) byRule[f.rule] = (byRule[f.rule] || 0) + 1; });
    var rules = Object.keys(byRule).map(function (k) { return k + " " + byRule[k]; }).join(", ");
    return el("div", null, [
      el("div", { "class": "side" }, [label, p.later === side ? el("span", { "class": "later", text: " · edited later" }) : null]),
      el("div", { text: song.file }),
      el("div", { "class": "muted", text: "Edited " + date + " (" + SOURCES[e.source] + (e.peer ? ", computer " + e.peer : "") + ")" }),
      el("div", { "class": "muted", text: "Rule breaks by tier: " + song.breaks.join(" · ") + (rules ? " (" + rules + ")" : "") }),
      song.id ? el("div", { "class": "muted", text: "ID " + song.id }) : null
    ]);
  }

  function choice(p, pick, text) {
    var b = el("button", { type: "button", text: text });
    if (decisions[p.id] === pick) b.className = "chosen";
    b.addEventListener("click", function () { decide(p, pick); });
    return b;
  }

  function decide(p, pick) {
    if (pick) decisions[p.id] = pick; else delete decisions[p.id];
    save();
    // Filtered again, since a decision can take the song out of what is
    // shown; then on to the next song, or the one in its place.
    var next = pick ? shown[at + 1] : p;
    applyFilters(next && next.id);
  }

  function draw() {
    progress();
    var root = $("song");
    root.textContent = "";
    $("position").textContent = shown.length ? (at + 1) + " of " + shown.length + " shown" : "";
    $("jump").value = String(at);
    if (!shown.length) { root.appendChild(el("div", { "class": "empty", text: "No song matches these filters." })); return; }
    var p = shown[at];
    var renamed = p.bucket === "renamed" ? " → " + p.b.name : "";
    root.appendChild(el("h2", { text: nameOf(p) + renamed }));
    root.appendChild(el("div", null, [
      el("span", { "class": "badge", text: BUCKETS[p.bucket] }),
      p.content && p.bucket === "renamed" ? el("span", { "class": "badge", text: "words: " + BUCKETS[p.content] }) : null,
      p.matchedBy ? el("span", { "class": "badge", text: "matched by " + (p.matchedBy === "id" ? "ID" : "name") }) : null
    ]));
    root.appendChild(el("div", { "class": "meta" }, [sideMeta(p, "a"), sideMeta(p, "b")]));
    if (p.proposed) {
      var keep = p.proposed.pick === "a" ? L.a : L.b;
      root.appendChild(el("div", { "class": "proposal" }, [el("strong", { text: "Proposed: keep " + keep + ". " }), p.proposed.reason]));
    }
    if (p.bucket !== "identical") {
      var buttons = [];
      if (p.a) buttons.push(choice(p, "a", "Keep " + L.a + " (A)"));
      if (p.b) buttons.push(choice(p, "b", "Keep " + L.b + " (B)"));
      buttons.push(choice(p, "skip", "Skip (S)"));
      if (decisions[p.id]) { var clear = el("button", { type: "button", text: "Undecide" }); clear.addEventListener("click", function () { decide(p, null); }); buttons.push(clear); }
      root.appendChild(el("div", { "class": "decide" }, buttons));
    }
    var table = el("table", { "class": "sbs" }, [el("thead", null, [el("tr", null, [el("th", { text: L.a }), el("th", { text: L.b })])])]);
    var body = el("tbody");
    var differences = {};
    (p.differences || []).forEach(function (d) { differences[d.row] = d; });
    p.rows.forEach(function (r, row) {
      var d = differences[row];
      if (d) {
        body.appendChild(el("tr", { "class": "difference" }, [el("td", { colspan: "2" }, [
          el("strong", { text: (d.decide ? "Kept from " : "Take ") + L[d.pick] + " here. " }), d.reason
        ])]));
      }
      body.appendChild(el("tr", null, [
        el("td", null, [p.a ? groupView(r.a) : el("div", { "class": "none", text: "—" })]),
        el("td", null, [p.b ? groupView(r.b) : el("div", { "class": "none", text: "—" })])
      ]));
    });
    table.appendChild(body);
    root.appendChild(table);
  }

  $("prev").addEventListener("click", function () { if (at > 0) { at--; draw(); } });
  $("next").addEventListener("click", function () { if (at < shown.length - 1) { at++; draw(); } });
  $("jump").addEventListener("change", function () { at = Number($("jump").value); draw(); });
  document.addEventListener("keydown", function (e) {
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var p = shown[at];
    if (e.key === "ArrowLeft" || e.key === "k") { if (at > 0) { at--; draw(); } }
    else if (e.key === "ArrowRight" || e.key === "j") { if (at < shown.length - 1) { at++; draw(); } }
    else if (p && p.bucket !== "identical" && (e.key === "a" && p.a || e.key === "b" && p.b || e.key === "s")) decide(p, e.key === "s" ? "skip" : e.key);
  });

  $("accept-shown").addEventListener("click", function () {
    // A song with a group only one side has is a person's to decide, one song at a time.
    var open = shown.filter(function (p) { return p.proposed && !p.proposed.decide && p.bucket !== "identical" && !decisions[p.id]; });
    if (!open.length || !confirm("Accept the proposed pick for " + open.length + " undecided songs shown? Songs with a group only one side has are left for you.")) return;
    open.forEach(function (p) { decisions[p.id] = p.proposed.pick; });
    save();
    applyFilters(shown[at] && shown[at].id);
  });

  $("download").addEventListener("click", function () {
    var list = data.pairs.filter(function (p) { return decisions[p.id]; }).map(function (p) {
      var pick = decisions[p.id];
      return {
        id: p.id, name: nameOf(p), bucket: p.bucket, pick: pick, keep: pick === "skip" ? null : L[pick],
        proposed: p.proposed ? p.proposed.pick : null,
        a: p.a ? { file: p.a.file, id: p.a.id || null } : null,
        b: p.b ? { file: p.b.file, id: p.b.id || null } : null
      };
    });
    var file = {
      format: "presenter-garage/decisions", version: 1, decided: new Date().toISOString(),
      compare: { created: data.created, a: { label: L.a, root: data.sources.a.root }, b: { label: L.b, root: data.sources.b.root } },
      undecided: data.pairs.filter(function (p) { return p.bucket !== "identical" && !decisions[p.id]; }).length,
      decisions: list
    };
    var url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2) + "\n"], { type: "application/json" }));
    var a = el("a", { href: url, download: "decisions.json" });
    document.body.appendChild(a);
    a.click();
    // Revoked later: revoking straight after click() cancels the download in Safari.
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 1000);
  });

  $("load").addEventListener("change", function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    file.text().then(function (text) {
      var loaded = JSON.parse(text);
      if (loaded.format !== "presenter-garage/decisions") throw new Error("not a decisions.json");
      // Picks are "a" and "b", so a file from another comparison, or from
      // this one with its sides the other way round, would keep the wrong version.
      var c = loaded.compare || {}, ours = { a: { label: L.a, root: data.sources.a.root }, b: { label: L.b, root: data.sources.b.root } };
      var same = function (x, y) { return x && x.label === y.label && x.root === y.root; };
      if (!same(c.a, ours.a) || !same(c.b, ours.b)) {
        var swapped = same(c.a, ours.b) && same(c.b, ours.a);
        throw new Error(swapped
          ? "it was made with " + L.b + " and " + L.a + " the other way round"
          : "it is for another comparison (" + (c.a && c.a.label) + " against " + (c.b && c.b.label) + ")");
      }
      var known = {}; data.pairs.forEach(function (p) { known[p.id] = p; });
      var applied = 0, unknown = 0;
      loaded.decisions.forEach(function (d) {
        var p = known[d.id];
        if (p && (d.pick === "skip" || (d.pick === "a" && p.a) || (d.pick === "b" && p.b))) { decisions[d.id] = d.pick; applied++; } else unknown++;
      });
      save();
      applyFilters(shown[at] && shown[at].id);
      alert("Loaded " + applied + " decisions" + (unknown ? "; " + unknown + " name songs this comparison does not have" : "") + ".");
    }).catch(function (err) { alert("Could not load that file: " + err.message); });
    e.target.value = "";
  });

  applyFilters();
})();
`;
