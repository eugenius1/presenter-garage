import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ElicitRequestSchema, type ElicitRequest, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { syntheticTextPresentation, textLines } from "@presenter-garage/core/lib/__tests__/synthetic";
import { createI18n } from "@presenter-garage/core/i18n/core";
import { sqlite } from "@presenter-garage/node/__tests__/workspace-db";
import { createWritableWorkspace, presentationRoot, putPresentation } from "@presenter-garage/node/__tests__/workspace-writable";
import { openInBrowser } from "../review-server";
import { connect } from "./connect";

/**
 * Choosing slide edits on a review page: docs/design/guard3-review-file.md.
 * Each test has its own library, `out` and reviews folder, and servers that
 * share the reviews folder, as one computer's servers do across restarts.
 */

let dir: string;
let library: string;
let song: string;
let other: string;
let out: string;
let reviewsDir: string;
let backups: string;
/** Every URL the server opened in "the browser". */
let opened: string[];
const clients: { close(): Promise<void> }[] = [];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-review-")));
  library = path.join(dir, "ProPresenter");
  const songs = path.join(library, "Libraries", "Default");
  fs.mkdirSync(songs, { recursive: true });
  song = path.join(songs, "Song.pro");
  other = path.join(songs, "Other.pro");
  fs.writeFileSync(song, syntheticTextPresentation("Song"));
  fs.writeFileSync(other, syntheticTextPresentation("Other"));
  out = path.join(dir, "out");
  reviewsDir = path.join(dir, "Reviews");
  backups = path.join(dir, "Backups");
  opened = [];
});

afterAll(async () => {
  for (const client of clients) await client.close();
});

const lines = (file: string) => textLines(new Uint8Array(fs.readFileSync(file)));

/** A server on `folder` with a client of `capabilities`, answering any question with `reply`. */
async function server(
  capabilities: ClientCapabilities = {},
  reply: (request: ElicitRequest) => ElicitResult = () => ({ action: "accept", content: {} }),
  folder = library
) {
  const asked: ElicitRequest[] = [];
  const { client, call } = await connect(
    folder,
    { backupDir: backups, reviewsDir, openUrl: async (url) => (opened.push(url), true) },
    capabilities,
    (c) =>
      capabilities.elicitation &&
      c.setRequestHandler(ElicitRequestSchema, (request) => {
        asked.push(request);
        return reply(request);
      })
  );
  clients.push(client);
  return { call, asked };
}

const EDITS = [
  { path: "Libraries/Default/Song.pro", boxIndex: 0, lineIndex: 0, text: "A tidier line" },
  { path: "Libraries/Default/Song.pro", boxIndex: 6, lineIndex: 0, text: "Que ton nom" },
  { path: "Libraries/Default/Other.pro", boxIndex: 0, lineIndex: 0, text: "Another tidier line" },
];

/** Plan into a review, and have the page show it to the person, as their browser would, unless `shown` is false. */
async function planReview(call: Awaited<ReturnType<typeof server>>["call"], { edits = EDITS, shown = true } = {}) {
  const result = await call("plan_slide_edits", { edits, out });
  expect(result.isError, result.text).toBe(false);
  const planned = result.json() as { review: string; url: string; opened: string; chosen: number; presentations: number };
  if (shown) expect((await request(`${planned.url}review.json`)).status).toBe(200);
  return planned;
}

/** A request to the page's server, with any `Host` and headers a test wants. */
function request(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const { hostname, port, pathname } = new URL(url);
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ hostname, port, path: pathname, method: init.method ?? "GET", headers: init.headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

const put = (url: string, changes: unknown, headers: Record<string, string> = {}) =>
  request(`${url}choices`, { method: "PUT", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ changes }) });

const choicesOf = (review: string) => JSON.parse(fs.readFileSync(path.join(review, "choices.json"), "utf8"));

describe("planning into a review folder", () => {
  it("keeps the plan in a folder inside out, answers counts rather than lines, and opens the page", async () => {
    const before = [fs.readFileSync(song), fs.readFileSync(other)];
    const { call } = await server();
    const result = await call("plan_slide_edits", { edits: EDITS, out });
    expect(result.text).not.toContain("tidier");
    const planned = result.json();
    expect(planned).toMatchObject({ presentations: 2, changes: { lines: 3, structural: 0 }, chosen: 3, written: 0, shown: false, opened: "browser" });
    expect(path.dirname(planned.review)).toBe(fs.realpathSync(out));
    expect(fs.readdirSync(planned.review).sort()).toEqual(["choices.json", "plan.json", "review.html", "runs.json"]);
    expect(planned.snapshot).toBe(path.join(planned.review, "review.html"));
    expect(opened).toEqual([planned.url]);
    expect(planned.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/r\/[\w-]+\/$/);
    // The plan's hash recorded outside out, so a plan changed since is known.
    expect(fs.readdirSync(reviewsDir)).toHaveLength(1);
    expect([fs.readFileSync(song), fs.readFileSync(other)]).toEqual(before);
  });

  it("never makes the folder inside the library, nor anywhere a relative path would land", async () => {
    const { call } = await server();
    const result = await call("plan_slide_edits", { edits: EDITS, out: path.join(library, "out") });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/inside the library/);
    expect(fs.existsSync(path.join(library, "out"))).toBe(false);
    expect((await call("plan_slide_edits", { edits: EDITS, out: "out" })).text).toMatch(/Give an absolute folder for the review, not out/);
  });

  it("takes more than a form's 200 changes with out, up to 2,000", async () => {
    const { call } = await server();
    const many = (k: number) => Array.from({ length: k }, () => EDITS[0]);
    expect((await call("plan_slide_edits", { edits: many(201) })).text).toMatch(/At most 200 changes/);
    // Past the count with out: refused for what the edits say, not for how many there are.
    expect((await call("plan_slide_edits", { edits: many(201), out })).text).not.toMatch(/At most/);
    expect((await call("plan_slide_edits", { edits: many(2001), out })).isError).toBe(true);
  });

  it("shows the page through the client where it can open a URL, and not in the browser", async () => {
    const { call, asked } = await server({ elicitation: { url: {} } }, () => ({ action: "accept" }));
    const planned = await planReview(call);
    expect(planned.opened).toBe("client");
    expect(asked[0].params).toMatchObject({ mode: "url", url: planned.url });
    expect(opened).toEqual([]);
  });
});

describe("the page", () => {
  it("serves every change in words, with the person's choices, and saves what they send", async () => {
    const { call } = await server();
    const { review, url } = await planReview(call);

    const page = await request(url);
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toMatch(/script-src 'nonce-/);
    const data = JSON.parse((await request(`${url}review.json`)).body);
    expect(data.files.map((f: { name: string }) => f.name)).toEqual(["Song", "Other"]);
    expect(data.warning).toMatch(/close it first/);
    expect(data.files[0].changes[0]).toMatchObject({ n: 1, kind: "line", before: "A tidy line", after: "A tidier line" });
    // Each change in its line's place among the slides around it, as they read.
    const first = data.files[0].runs[0];
    expect(first[0]).toMatchObject({ slideIndex: 0, group: "Verse", holds: true, entries: [{ n: 1 }, { text: "And another" }] });
    expect(first.map((slide: { slideIndex: number }) => slide.slideIndex)).toEqual([0, 1, 2]);
    expect(data.files[0].stray).toEqual([]);
    expect(data.choices).toEqual({ 1: { ticked: true }, 2: { ticked: true }, 3: { ticked: true } });

    const saved = await put(url, { 2: { ticked: false, note: "Not this one,\nthe accent is right" } });
    expect(saved.status).toBe(200);
    expect(choicesOf(review).changes).toEqual({
      1: { ticked: true },
      2: { ticked: false, note: "Not this one, the accent is right" },
      3: { ticked: true },
    });
  });

  it("answers only at 127.0.0.1, only with the review's token, and saves only JSON from itself", async () => {
    const { call } = await server();
    const { review, url } = await planReview(call);
    const { port } = new URL(url);
    expect((await request(url, { headers: { Host: `evil.example:${port}` } })).status).toBe(403);
    expect((await request(url.replace(/\/r\/[\w-]+\//, "/r/guessed/"))).status).toBe(404);
    expect((await put(url, { 1: { ticked: false } }, { Origin: "https://evil.example" })).status).toBe(403);
    const form = await request(`${url}choices`, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "{}" });
    expect(form.status).toBe(415);
    expect((await request(url, { headers: { Host: `localhost:${port}` } })).status).toBe(403);
    expect((await put(url, { 1: { ticked: false } }, { Origin: "null" })).status).toBe(403);
    const unknown = await put(url, { 9: { ticked: false } });
    expect([unknown.status, unknown.body]).toEqual([409, "The plan has no change 9."]);
    const vague = await put(url, { 1: { ticked: "yes" } });
    expect([vague.status, vague.body]).toEqual([409, "Change 1 is neither ticked nor unticked."]);
    expect(choicesOf(review).changes[1]).toEqual({ ticked: true });
  });
});

describe("the read-only snapshot", () => {
  it("is written at plan time, after every apply, and when asked for, holding the choices and notes as they stand", async () => {
    const { call } = await server();
    const { review, url } = await planReview(call);
    const file = path.join(review, "review.html");
    const embedded = () => {
      const html = fs.readFileSync(file, "utf8");
      return JSON.parse(html.match(/<script type="application\/json" id="data">(.*?)<\/script>/s)![1]).review;
    };
    expect(embedded().choices[1]).toEqual({ ticked: true });

    // A note can hold anything a person types, a closing script tag included.
    await put(url, { 1: { ticked: false, note: "Not </script> this" } });
    const copied = await request(`${url}snapshot`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect([copied.status, JSON.parse(copied.body).file]).toEqual([200, file]);
    expect(fs.readFileSync(file, "utf8")).not.toContain("Not </script>");
    expect(embedded().choices[1]).toEqual({ ticked: false, note: "Not </script> this" });

    await put(url, { 1: { ticked: true } });
    expect((await call("export_review", { review })).json()).toEqual({ file });
    expect(embedded().choices[1]).toEqual({ ticked: true });

    await call("apply_slide_edits", { review });
    expect(embedded().written).toEqual([1, 2, 3]);
    expect(embedded().runs).toHaveLength(1);
  });

  it("is saved from the page only, as the choices are", async () => {
    const { call } = await server();
    const { review, url } = await planReview(call);
    const before = fs.readFileSync(path.join(review, "review.html"));
    const post = (headers: Record<string, string>) => request(`${url}snapshot`, { method: "POST", headers, body: "{}" });
    expect((await post({ "Content-Type": "application/json", Origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ "Content-Type": "text/plain" })).status).toBe(415);
    expect(fs.readFileSync(path.join(review, "review.html"))).toEqual(before);
  });

  it("is written only into a review this server made, as planned", async () => {
    const { call } = await server();
    const elsewhere = path.join(dir, "not-a-review");
    fs.mkdirSync(elsewhere);
    expect((await call("export_review", { review: elsewhere })).text).toMatch(/is not a review folder/);
    expect(fs.existsSync(path.join(elsewhere, "review.html"))).toBe(false);

    const { review } = await planReview(call);
    const planFile = path.join(review, "plan.json");
    fs.writeFileSync(planFile, fs.readFileSync(planFile, "utf8").replace("A tidier line", "Something nobody saw"));
    fs.rmSync(path.join(review, "review.html"));
    expect((await call("export_review", { review })).text).toMatch(/is not a plan this server wrote into this folder/);
    expect(fs.existsSync(path.join(review, "review.html"))).toBe(false);
  });

  it("holds a script that parses, served and as a snapshot", async () => {
    const { call } = await server();
    const { review, url } = await planReview(call);
    const scripts = (html: string) => [...html.matchAll(/<script nonce="[^"]*">(.*?)<\/script>/gs)].map((m) => m[1]);
    for (const html of [(await request(url)).body, fs.readFileSync(path.join(review, "review.html"), "utf8")]) {
      const [script] = scripts(html);
      expect(script).toContain("function save()");
      expect(() => new Function(script)).not.toThrow();
    }
  });
});

describe("reading and applying a review", () => {
  it("reads the notes back with the change each is on, and whether it was left ticked", async () => {
    const { call } = await server();
    const { review, url } = await planReview(call);
    await put(url, { 1: { ticked: false, note: "Keep the old spelling" }, 3: { ticked: true, note: "And slide 7 too" } });
    const read = (await call("read_review", { review })).json();
    expect(read).toMatchObject({ chosen: 2, written: 0 });
    expect(read.notes).toEqual([
      expect.objectContaining({ n: 1, presentation: "Song", before: "A tidy line", after: "A tidier line", ticked: false, note: "Keep the old spelling" }),
      expect.objectContaining({ n: 3, presentation: "Other", ticked: true, note: "And slide 7 too" }),
    ]);
  });

  it("asks the person once to confirm the chosen set, writes only that, backs up first, and never writes it twice", async () => {
    const original = fs.readFileSync(song);
    const { call, asked } = await server({ elicitation: { form: {} } });
    const { review, url } = await planReview(call);
    await put(url, { 2: { ticked: false, note: "Leave it" } });

    const result = (await call("apply_slide_edits", { review })).json();
    expect(asked).toHaveLength(1);
    const { message, requestedSchema } = asked[0].params as { message: string; requestedSchema: { properties: object } };
    expect(message).toContain("Write 2 of the 3 changes you chose from, in 2 presentations (Song: 1 of 2; Other: 1 of 1)?");
    expect(message).toContain(backups);
    expect(requestedSchema.properties).toEqual({});
    expect(result).toMatchObject({ answer: "accept", files: [{ written: true }, { written: true }] });
    expect(result.notes).toEqual([expect.objectContaining({ n: 2, note: "Leave it", ticked: false })]);
    expect(lines(song)[0][0]).toBe("A tidier line");
    expect(lines(song)[6][0]).not.toBe("Que ton nom");
    expect(lines(other)[0][0]).toBe("Another tidier line");
    const backup = result.files.find((f: { path: string }) => f.path === song).backup;
    expect(fs.readFileSync(backup)).toEqual(original);
    expect(JSON.parse(fs.readFileSync(path.join(review, "runs.json"), "utf8"))[0].written).toEqual([1, 3]);

    // Again: what was written is not written twice, and what stays unticked stays unwritten.
    // Nor can the change left unticked in a presentation since written: its file has moved on, and needs a new plan.
    await put(url, { 2: { ticked: true } });
    const again = (await call("apply_slide_edits", { review })).json();
    expect(again).toMatchObject({ answer: "nothingChosen", files: [] });
    expect(asked).toHaveLength(1);
    const read = (await call("read_review", { review })).json();
    expect(read.needNewPlan).toEqual([expect.objectContaining({ n: 2, presentation: "Song", after: "Que ton nom" })]);
    expect(JSON.parse((await request(`${url}review.json`)).body).needNewPlan).toEqual([2]);
  });

  it("applies nothing from a review whose page nobody has opened", async () => {
    const before = fs.readFileSync(song);
    const { call } = await server();
    const { review } = await planReview(call, { shown: false });
    const result = await call("apply_slide_edits", { review });
    expect([result.isError, result.text]).toEqual([true, expect.stringMatching(/has not opened this review's page yet/)]);
    expect(fs.readFileSync(song)).toEqual(before);
  });

  it("refuses a review's files copied into another folder", async () => {
    const { call } = await server();
    const { review } = await planReview(call);
    const copy = path.join(dir, "copy");
    fs.cpSync(review, copy, { recursive: true });
    const result = await call("apply_slide_edits", { review: copy });
    expect([result.isError, result.text]).toEqual([true, expect.stringMatching(/not a plan this server wrote into this folder/)]);
    expect((await call("apply_slide_edits", { review: "out/review" })).text).toMatch(/Give an absolute folder for the review/);
  });

  it("writes nothing when the person declines", async () => {
    const before = fs.readFileSync(song);
    const { call } = await server({ elicitation: { form: {} } }, () => ({ action: "decline" }));
    const { review } = await planReview(call);
    expect((await call("apply_slide_edits", { review })).json()).toMatchObject({ answer: "decline", files: [] });
    expect(fs.readFileSync(song)).toEqual(before);
    expect(JSON.parse(fs.readFileSync(path.join(review, "runs.json"), "utf8"))).toEqual([]);
  });

  it("takes the saved choices as the person's where the client cannot ask", async () => {
    const { call } = await server();
    const { review, url } = await planReview(call);
    await put(url, { 3: { ticked: false } });
    const result = (await call("apply_slide_edits", { review })).json();
    expect(result).toMatchObject({
      answer: "notAsked",
      files: [
        { path: song, written: true, lines: 2 },
        { path: other, written: false, reason: "unchanged" },
      ],
    });
    expect(lines(song)[0][0]).toBe("A tidier line");
    expect(lines(other)[0][0]).toBe("A tidy line");
  });

  it("skips a presentation changed since the plan, and writes the rest", async () => {
    const { call } = await server();
    const { review } = await planReview(call);
    fs.writeFileSync(other, syntheticTextPresentation("Other, edited"));
    const result = (await call("apply_slide_edits", { review })).json();
    expect(result.files).toEqual([
      expect.objectContaining({ path: song, written: true }),
      expect.objectContaining({ path: other, written: false, reason: "stale" }),
    ]);
    expect(lines(song)[0][0]).toBe("A tidier line");
  });

  it("refuses a plan changed since it was made, or choices about another plan, writing nothing", async () => {
    const before = fs.readFileSync(song);
    const { call } = await server();
    const { review, url } = await planReview(call);
    const planFile = path.join(review, "plan.json");
    const plan = fs.readFileSync(planFile, "utf8");
    fs.writeFileSync(planFile, plan.replace("A tidier line", "Something nobody saw"));
    const changed = await call("apply_slide_edits", { review });
    expect([changed.isError, changed.text]).toEqual([true, expect.stringMatching(/is not a plan this server wrote/)]);
    expect((await request(`${url}review.json`)).status).toBe(409);

    fs.writeFileSync(planFile, plan);
    const choices = path.join(review, "choices.json");
    fs.writeFileSync(choices, JSON.stringify({ ...choicesOf(review), plan: "0".repeat(64) }));
    const elsewhere = await call("apply_slide_edits", { review });
    expect([elsewhere.isError, elsewhere.text]).toEqual([true, expect.stringMatching(/not about the plan beside it/)]);
    expect(fs.readFileSync(song)).toEqual(before);
  });

  it("refuses a review made in another library", async () => {
    const { call } = await server();
    const { review } = await planReview(call);
    const elsewhere = path.join(dir, "Elsewhere");
    fs.mkdirSync(path.join(elsewhere, "Libraries", "Default"), { recursive: true });
    const second = await server({}, undefined, elsewhere);
    const result = await second.call("apply_slide_edits", { review });
    expect([result.isError, result.text]).toEqual([true, expect.stringMatching(/This plan was made in .*nothing was written/)]);
  });

  it("opens a review again from another server, as after a restart, with the choices as left", async () => {
    const first = await server();
    const { review, url } = await planReview(first.call);
    await put(url, { 1: { ticked: false, note: "Later" } });
    const second = await server();
    const reopened = (await second.call("open_review", { review })).json();
    expect(reopened).toMatchObject({ review, chosen: 2, opened: "browser" });
    expect(reopened.url).not.toBe(url);
    const data = JSON.parse((await request(`${reopened.url}review.json`)).body);
    expect(data.choices[1]).toEqual({ ticked: false, note: "Later" });
  });

  it("asks for either a planId or a review, not both", async () => {
    const { call } = await server();
    expect((await call("apply_slide_edits", {})).text).toBe("Give either planId or review.");
    expect((await call("apply_slide_edits", { planId: "x", review: "/y" })).text).toBe("Give either planId or review.");
  });
});

describe.skipIf(!sqlite)("a review of a ProPresenter 22 Cloud workspace", () => {
  it("keeps the document's id through plan.json, warns on the page that it is Cloud, and writes into the workspace", async () => {
    const root = createWritableWorkspace(path.join(dir, "cloud"), { cloud: true });
    fs.writeFileSync(path.join(root, "imprint.cloud"), "{}");
    putPresentation(root, "Song", presentationRoot(), { lastShared: "synced" });
    const { call } = await server({}, undefined, root);
    const edits = [{ path: "Libraries/Default/Song.pro", boxIndex: 6, lineIndex: 0, text: "Que ton nom" }];
    const { review, url } = await planReview(call, { edits });
    const data = JSON.parse((await request(`${url}review.json`)).body);
    expect(data.warning.startsWith(createI18n("en").t.tools.presentations.cloudWrite)).toBe(true);
    expect(data.warning).toMatch(/Quit ProPresenter first/);
    const result = (await call("apply_slide_edits", { review })).json();
    expect(result).toMatchObject({ answer: "notAsked", files: [{ written: true, lines: 1 }] });
    const read = (await call("read_presentation", { path: "Libraries/Default/Song.pro" })).json();
    expect(read.slides[6].textBoxes[0].lines[0]).toBe("Que ton nom");
  });
});

describe("opening the page in the browser", () => {
  it("opens nothing but this server's own page", async () => {
    expect(await openInBrowser("https://example.com/")).toBe(false);
    expect(await openInBrowser("http://127.0.0.1:1/r/x/; rm -rf ~")).toBe(false);
  });
});
