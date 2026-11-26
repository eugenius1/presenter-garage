import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeOut, type OutFolder } from "../commands/out-folder";

/**
 * Where a run writes: a new folder of its own inside the one it is given,
 * and nowhere else, over nothing, and never through a link out of it.
 */

let tmp: string;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pg-out-folder-")));
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A `dump` run writing the songs given, relative to `songs/`; answers with its folder. */
const dump = (out: string, songs: Record<string, string>, libraries: string[] = []) =>
  writeOut(out, "dump", libraries, async (folder) => {
    for (const [name, content] of Object.entries(songs)) await folder.put(`songs/${name}`, content);
    return folder.dir;
  });

const listing = (dir: string) => (fs.readdirSync(dir, { recursive: true }) as string[]).map((f) => f.split(path.sep).join("/")).sort();

describe("writeOut", () => {
  it("makes a new folder for every run, and leaves what is already there as it was", async () => {
    const out = path.join(tmp, "runs");
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, "notes.txt"), "mine");
    const first = await dump(out, { "A.txt": "one" });
    fs.writeFileSync(path.join(first, "songs", "A.txt"), "edited by a person");
    const second = await dump(out, { "A.txt": "two" });
    expect(path.dirname(first)).toBe(out);
    expect(path.basename(first)).toMatch(/^dump-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ(-\d+)?$/);
    expect(second).not.toBe(first);
    expect(fs.readFileSync(path.join(out, "notes.txt"), "utf8")).toBe("mine");
    expect(fs.readFileSync(path.join(first, "songs", "A.txt"), "utf8")).toBe("edited by a person");
    expect(fs.readFileSync(path.join(second, "songs", "A.txt"), "utf8")).toBe("two");
    expect(fs.readdirSync(out).sort()).toEqual([path.basename(first), path.basename(second), "notes.txt"].sort());
  });

  it("gives runs at once a folder each, numbering those of the same second", async () => {
    const out = path.join(tmp, "together");
    const folders = await Promise.all([1, 2, 3, 4].map((n) => dump(out, { "A.txt": String(n) })));
    expect(new Set(folders).size).toBe(4);
    expect(folders.map((f) => fs.readFileSync(path.join(f, "songs", "A.txt"), "utf8"))).toEqual(["1", "2", "3", "4"]);
  });

  it("makes its folder where it is given one that is not there yet", async () => {
    const out = path.join(tmp, "new", "deeper");
    const dir = await dump(out, { "A.txt": "one" });
    expect(listing(dir)).toEqual(["songs", "songs/A.txt"]);
  });

  it("refuses a folder inside a library, and makes nothing there", async () => {
    const library = path.join(tmp, "library");
    fs.mkdirSync(library);
    await expect(dump(path.join(library, "results"), { "A.txt": "one" }, [library])).rejects.toThrow("is inside the library");
    await expect(dump(library, { "A.txt": "one" }, [library])).rejects.toThrow("is inside the library");
    expect(fs.readdirSync(library)).toEqual([]);
  });

  it("refuses an `out` that is a link into a library, before making anything", async () => {
    const library = path.join(tmp, "linked-library");
    fs.mkdirSync(library);
    const out = path.join(tmp, "link-to-library");
    fs.symlinkSync(library, out);
    await expect(dump(out, { "A.txt": "one" }, [library])).rejects.toThrow("is inside the library");
    expect(fs.readdirSync(library)).toEqual([]);
  });

  it("refuses a name outside its folder, and a file it already wrote", async () => {
    const out = path.join(tmp, "names");
    let dir = "";
    const attempt = (write: (folder: OutFolder) => Promise<unknown>) =>
      writeOut(out, "dump", [], async (folder) => {
        dir = folder.dir;
        await write(folder);
      });
    await expect(attempt((folder) => folder.put("../escaped.txt", "x"))).rejects.toThrow("Refusing to write outside");
    await expect(attempt((folder) => folder.put("index.json", "x").then(() => folder.put("index.json", "y")))).rejects.toThrow(
      "a run never writes over a file"
    );
    expect(fs.readFileSync(path.join(dir, "index.json"), "utf8")).toBe("x");
    expect(fs.existsSync(path.join(tmp, "escaped.txt"))).toBe(false);
  });

  it("refuses to write through a folder swapped for a link out of its folder", async () => {
    const elsewhere = path.join(tmp, "elsewhere");
    fs.mkdirSync(elsewhere);
    const out = path.join(tmp, "swapped");
    await expect(
      writeOut(out, "dump", [], async (folder) => {
        await folder.put("songs/A.txt", "one");
        // What somebody racing the run would do: its folder moved aside and a link left in its place.
        fs.renameSync(path.join(folder.dir, "songs"), path.join(folder.dir, "moved"));
        fs.symlinkSync(elsewhere, path.join(folder.dir, "songs"));
        await folder.put("songs/B.txt", "two");
      })
    ).rejects.toThrow("replaced by a link");
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it("refuses a folder under its own that it did not make", async () => {
    const out = path.join(tmp, "foreign-folder");
    await expect(
      writeOut(out, "compare", [], async (folder) => {
        fs.mkdirSync(path.join(folder.dir, "text"));
        await folder.mkdir("text/a");
      })
    ).rejects.toThrow("this run did not make it");
  });
});
