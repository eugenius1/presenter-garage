import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ElicitRequestSchema, ListRootsRequestSchema, type ElicitRequest, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { syntheticTextPresentation } from "@presenter-garage/core/lib/__tests__/synthetic";
import { isProPresenterLibrary } from "../library";
import { connect } from "./connect";

/**
 * One library at a time: the folder the server starts on, the client's
 * roots, and a switch the person approves through `use_library`.
 */

let tmp: string;
let backups: string;
/** Three libraries, each a ProPresenter folder holding one song named after it, and a folder that is no library. */
let first: string;
let second: string;
let third: string;
let project: string;

/** A ProPresenter folder with one song in `Libraries/Default`. */
function library(name: string): string {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, "Libraries", "Default"), { recursive: true });
  fs.writeFileSync(path.join(root, "Libraries", "Default", `${name} Song.pro`), syntheticTextPresentation(`${name} Song`));
  return root;
}

const songFile = (root: string) => path.join(root, "Libraries", "Default", `${path.basename(root)} Song.pro`);

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pp-mcp-library-")));
  backups = path.join(tmp, "Backups");
  first = library("First");
  second = library("Second");
  third = library("Third");
  project = path.join(tmp, "Project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "notes.md"), "");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const uri = (dir: string) => pathToFileURL(dir).href;

/** A server started on `first` whose client offers `roots()` as its roots, read each time it is asked. */
async function withRoots(roots: () => string[]) {
  return connect(first, { backupDir: backups }, { roots: { listChanged: true } }, (client) =>
    client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: roots().map((dir) => ({ uri: uri(dir) })) }))
  );
}

describe("the library open", () => {
  it("is the folder the server was started on, with a client that has no roots", async () => {
    const { client, call } = await connect(first, { backupDir: backups });
    const open = (await call("current_library")).json();
    expect(open).toMatchObject({ path: first, source: "configured", kind: "folder", editing: true, backupDir: backups });
    expect((await call("list_presentations")).json().presentations.map((p: { name: string }) => p.name)).toEqual(["First Song"]);
    expect(client.getInstructions()).toContain(`It starts on ${first}`);
    await client.close();
  });

  it("is the client's root when that is a ProPresenter library", async () => {
    const { client, call } = await withRoots(() => [second]);
    expect((await call("current_library")).json()).toMatchObject({ path: second, source: "client", notes: [] });
    expect((await call("list_presentations")).json().presentations.map((p: { name: string }) => p.name)).toEqual(["Second Song"]);
    // The folder it was started on is no longer read at all.
    expect((await call("read_presentation", { path: songFile(first) })).isError).toBe(true);
    await client.close();
  });

  it("stays the folder the server was started on when no client root is a library, and says so", async () => {
    const { client, call } = await withRoots(() => [project]);
    const open = (await call("current_library")).json();
    expect(open).toMatchObject({ path: first, source: "configured" });
    expect(open.notes.join(" ")).toContain(`None of the client's folders (${project}) is a ProPresenter library`);
    await client.close();
  });

  it("is the first of several client roots that is a library, and says that it is the only one read", async () => {
    const { client, call } = await withRoots(() => [project, second, third]);
    const open = (await call("current_library")).json();
    expect(open.path).toBe(second);
    expect(open.notes.join(" ")).toContain(`The client offered 3 folders; ${second} is the first that is a ProPresenter library`);
    // A song of the other library is outside the one open.
    expect((await call("read_presentation", { path: songFile(third) })).isError).toBe(true);
    await client.close();
  });

  it("follows the client's roots when they change, and comes back to the start when they name no library", async () => {
    let roots = [second];
    const { client, call } = await withRoots(() => roots);
    expect((await call("current_library")).json().path).toBe(second);

    roots = [third];
    await client.sendRootsListChanged();
    expect((await call("current_library")).json().path).toBe(third);

    roots = [project];
    await client.sendRootsListChanged();
    expect((await call("current_library")).json()).toMatchObject({ path: first, source: "configured" });
    await client.close();
  });

  it("ignores a client root that only holds a library, and says to open the library inside with use_library", async () => {
    // As ~/Documents holds ProPresenter: read whole, it would make everything in it the library.
    const documents = path.join(tmp, "Documents");
    fs.mkdirSync(path.join(documents, "ProPresenter", "Libraries", "Default"), { recursive: true });
    const inside = path.join(documents, "ProPresenter");
    const { client, call } = await withRoots(() => [documents]);
    const open = (await call("current_library")).json();
    expect(open).toMatchObject({ path: first, source: "configured" });
    expect(open.notes.join(" ")).toContain(`None of the client's folders (${documents}) is a ProPresenter library`);
    expect(open.notes.join(" ")).toContain(`${documents} holds the ProPresenter library ${inside} but is not one itself`);
    expect(open.notes.join(" ")).toContain(`use_library with ${inside}`);
    await client.close();
  });

  it("counts as a client's library only a workspace or a ProPresenter folder itself", async () => {
    expect(await isProPresenterLibrary(first)).toBe(true);
    expect(await isProPresenterLibrary(tmp)).toBe(false);
    expect(await isProPresenterLibrary(path.join(first, "Libraries", "Default"))).toBe(false);
    expect(await isProPresenterLibrary(project)).toBe(false);
    expect(await isProPresenterLibrary(path.join(tmp, "missing"))).toBe(false);
    const above = path.join(tmp, "Above");
    fs.mkdirSync(path.join(above, "ProPresenter", "Playlists"), { recursive: true });
    expect(await isProPresenterLibrary(above)).toBe(false);
    expect(await isProPresenterLibrary(path.join(above, "ProPresenter"))).toBe(true);
  });

  it("is still the folder above a ProPresenter folder when the server is started on it", async () => {
    const above = path.join(tmp, "Started");
    fs.mkdirSync(path.join(above, "ProPresenter", "Libraries", "Default"), { recursive: true });
    fs.writeFileSync(path.join(above, "ProPresenter", "Libraries", "Default", "Above Song.pro"), syntheticTextPresentation("Above Song"));
    const { client, call } = await connect(above, { backupDir: backups });
    expect((await call("current_library")).json().path).toBe(above);
    expect((await call("list_presentations")).json().presentations.map((p: { name: string }) => p.name)).toEqual(["Above Song"]);
    await client.close();
  });
});

describe("use_library", () => {
  let asked: ElicitRequest[];
  /** What the person answers when asked; set per test. */
  let reply: (request: ElicitRequest) => ElicitResult;

  /** A server started on `first`, whose client asks its person through `reply`. */
  async function asking() {
    const connected = await connect(first, { backupDir: backups }, { elicitation: { form: {} } });
    connected.client.setRequestHandler(ElicitRequestSchema, (request) => {
      asked.push(request);
      return reply(request);
    });
    return connected;
  }

  /** Every line ticked, for a plan's confirmation; nothing to fill in for a switch. */
  const acceptAll = (request: ElicitRequest): ElicitResult => ({
    action: "accept",
    content: Object.fromEntries(
      Object.keys((request.params as { requestedSchema: { properties: object } }).requestedSchema.properties).map((k) => [k, true])
    ),
  });

  beforeEach(() => {
    asked = [];
    reply = acceptAll;
    fs.rmSync(backups, { recursive: true, force: true });
    for (const root of [first, second]) fs.writeFileSync(songFile(root), syntheticTextPresentation(`${path.basename(root)} Song`));
  });

  it("opens the library the person approves, having shown them both paths", async () => {
    const { client, call } = await asking();
    const switched = (await call("use_library", { path: second })).json();
    expect(switched).toMatchObject({ answer: "accept", library: { path: second, source: "approved", editing: true } });
    expect(asked).toHaveLength(1);
    const message = (asked[0].params as { message: string }).message;
    expect(message).toContain(first);
    expect(message).toContain(second);
    expect((await call("list_presentations")).json().presentations.map((p: { name: string }) => p.name)).toEqual(["Second Song"]);
    await client.close();
  });

  it("takes a file: URI as well as a path", async () => {
    const { client, call } = await asking();
    expect((await call("use_library", { path: uri(second) })).json().library.path).toBe(second);
    await client.close();
  });

  it("changes nothing when the person declines", async () => {
    const { client, call } = await asking();
    reply = () => ({ action: "decline" });
    const declined = (await call("use_library", { path: second })).json();
    expect(declined).toMatchObject({ answer: "decline", library: { path: first } });
    expect((await call("current_library")).json().path).toBe(first);
    await client.close();
  });

  it("changes nothing, and asks nobody, with a client that cannot ask its person", async () => {
    const { client, call } = await connect(first, { backupDir: backups });
    const refused = await call("use_library", { path: second });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/cannot ask its user to approve/);
    expect(refused.text).toContain(first);
    expect((await call("current_library")).json().path).toBe(first);
    await client.close();
  });

  it("asks nothing to reopen the library already open, and refuses a relative path or a folder that is not there", async () => {
    const { client, call } = await asking();
    expect((await call("use_library", { path: first })).json()).toMatchObject({ unchanged: true, library: { path: first } });
    expect((await call("use_library", { path: "Second" })).text).toMatch(/absolute path/);
    expect((await call("use_library", { path: path.join(tmp, "missing") })).text).toMatch(/not found/);
    expect(asked).toHaveLength(0);
    await client.close();
  });

  it("refuses a plan made before the switch, without asking or writing", async () => {
    const { client, call } = await asking();
    const before = fs.readFileSync(songFile(first));
    const { planId } = (
      await call("plan_slide_edits", { edits: [{ path: songFile(first), boxIndex: 0, lineIndex: 0, text: "Planned in the first" }] })
    ).json();
    await call("use_library", { path: second });
    expect(asked).toHaveLength(1);

    const refused = await call("apply_slide_edits", { planId });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`This plan was made in ${first}, and the library open now is ${second}`);
    // The person was asked only about the switch, never to confirm the stale plan.
    expect(asked).toHaveLength(1);
    expect(fs.readFileSync(songFile(first))).toEqual(before);
    expect(fs.readdirSync(backups)).toEqual([]);
    // Switching back does not revive it: a plan is used once.
    await call("use_library", { path: first });
    expect((await call("apply_slide_edits", { planId })).text).toMatch(/No such plan/);
    await client.close();
  });

  it("refuses a plan when the library changes while the person reads it", async () => {
    let roots = [first];
    const connected = await connect(first, { backupDir: backups }, { elicitation: { form: {} }, roots: { listChanged: true } }, (c) =>
      c.setRequestHandler(ListRootsRequestSchema, () => ({ roots: roots.map((dir) => ({ uri: uri(dir) })) }))
    );
    const { client, call } = connected;
    const before = fs.readFileSync(songFile(first));
    const { planId } = (
      await call("plan_slide_edits", { edits: [{ path: songFile(first), boxIndex: 0, lineIndex: 0, text: "Planned in the first" }] })
    ).json();
    // The client's roots change while the confirmation is on screen.
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      roots = [second];
      await client.sendRootsListChanged();
      return acceptAll(request);
    });
    const refused = await call("apply_slide_edits", { planId });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`the library open now is ${second}`);
    expect(fs.readFileSync(songFile(first))).toEqual(before);
    await client.close();
  });

  it("turns editing off for a library its backup folder is inside, and back on for one it is not", async () => {
    const inside = path.join(second, "Backups");
    const { client, call } = await connect(first, { backupDir: inside }, { elicitation: { form: {} } });
    client.setRequestHandler(ElicitRequestSchema, acceptAll);
    const offered = async () => (await client.listTools()).tools.map((t) => t.name);
    expect(await offered()).toContain("plan_slide_edits");

    await call("use_library", { path: second });
    const open = (await call("current_library")).json();
    expect(open).toMatchObject({ path: second, editing: false });
    expect(open.notes.join(" ")).toMatch(/Editing is off for this library: .*inside a library folder/);
    expect(await offered()).not.toContain("plan_slide_edits");
    expect(await offered()).not.toContain("apply_slide_edits");
    expect(await offered()).not.toContain("save_rules");

    await call("use_library", { path: first });
    expect(await offered()).toContain("apply_slide_edits");
    await client.close();
  });

  it("tells the model nothing can be written when the library it starts on cannot be backed up", async () => {
    const { client } = await connect(second, { backupDir: path.join(second, "Backups") });
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("Nothing can be written in this library");
    expect(instructions).not.toContain("plan_slide_edits");
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("plan_slide_edits");
    await client.close();
  });

  it("is offered by a read-only server too, which reads the library it opens and still writes nothing", async () => {
    const { client, call } = await connect(first, { readOnly: true }, { elicitation: { form: {} } });
    client.setRequestHandler(ElicitRequestSchema, acceptAll);
    expect((await call("use_library", { path: second })).json().library).toMatchObject({ path: second, editing: false });
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("plan_slide_edits");
    await client.close();
  });
});
