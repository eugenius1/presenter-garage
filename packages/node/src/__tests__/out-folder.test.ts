import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MARKER, writeOut } from "../commands/out-folder";

/**
 * What a run into a folder it wrote before may remove: exactly the files it
 * wrote, as they were written, and nothing a person put there, whatever the
 * marker claims.
 */

let tmp: string;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pg-out-folder-")));
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A `dump` run writing the songs given, relative to `songs/`. */
const dump = (out: string, songs: Record<string, string>) =>
  writeOut(out, "dump", [], async (folder) => {
    for (const [name, content] of Object.entries(songs)) await folder.put(`songs/${name}`, content);
  });

const listing = (dir: string) => (fs.readdirSync(dir, { recursive: true }) as string[]).map((f) => f.split(path.sep).join("/")).sort();

describe("writeOut", () => {
  it("removes what it wrote before, folders included, and keeps what sits beside it", async () => {
    const out = path.join(tmp, "again");
    await dump(out, { "A/One.txt": "1", "B/Two.txt": "2" });
    fs.writeFileSync(path.join(out, `${MARKER}.new`), "a person's file of that name");
    await dump(out, { "A/One.txt": "1 again" });
    expect(listing(out)).toEqual([MARKER, `${MARKER}.new`, "songs", "songs/A", "songs/A/One.txt"]);
    expect(fs.readFileSync(path.join(out, `${MARKER}.new`), "utf8")).toBe("a person's file of that name");
  });

  it("refuses a file put where one it wrote was, and one it wrote that has changed since", async () => {
    const out = path.join(tmp, "replaced");
    await dump(out, { "One.txt": "1", "Two.txt": "2" });
    fs.rmSync(path.join(out, "songs", "One.txt"));
    fs.writeFileSync(path.join(out, "songs", "One.txt"), "a person's, at the same name");
    fs.appendFileSync(path.join(out, "songs", "Two.txt"), " and a person's note");
    const before = listing(out);
    await expect(dump(out, {})).rejects.toThrow(/One\.txt, .*Two\.txt were not written by dump/);
    expect(listing(out)).toEqual(before);
    expect(fs.readFileSync(path.join(out, "songs", "One.txt"), "utf8")).toBe("a person's, at the same name");
  });

  it("owns nothing a marker names outside its folder, and never loops on one", async () => {
    const out = path.join(tmp, "forged");
    fs.mkdirSync(path.join(out, "songs"), { recursive: true });
    fs.writeFileSync(path.join(out, "songs", "Mine.txt"), "a person's");
    const id = (() => {
      const stat = fs.lstatSync(path.join(out, "songs", "Mine.txt"), { bigint: true });
      return `${stat.dev}:${stat.ino}`;
    })();
    const files = ["/", "..", "../songs/Mine.txt", "songs//Mine.txt", "/songs/Mine.txt"].map((p) => ({ path: p, id }));
    fs.writeFileSync(path.join(out, MARKER), JSON.stringify({ format: "presenter-garage/out", version: 1, command: "dump", files, folders: ["/", ".."] }));
    await expect(dump(out, {})).rejects.toThrow(/Mine\.txt was not written by dump/);
    expect(fs.readFileSync(path.join(out, "songs", "Mine.txt"), "utf8")).toBe("a person's");
  });

  it("owns only the entry it wrote where a file system keeps two spellings of one accented name apart", async () => {
    const out = path.join(tmp, "accents");
    const composed = "Gloire à Dieu.txt";
    const decomposed = "Gloire à Dieu.txt";
    await dump(out, { [composed]: "the run's" });
    fs.writeFileSync(path.join(out, "songs", decomposed), "a person's", { flag: "a" });
    if (fs.readdirSync(path.join(out, "songs")).length === 1) {
      // The two spellings are one file here: appending to it changed the run's file, which is then not the run's to remove.
      await expect(dump(out, {})).rejects.toThrow(/was not written by dump/);
      return;
    }
    await expect(dump(out, {})).rejects.toThrow(/was not written by dump/);
    expect(fs.readFileSync(path.join(out, "songs", decomposed), "utf8")).toBe("a person's");
    fs.rmSync(path.join(out, "songs", decomposed));
    await dump(out, {});
    expect(listing(out)).toEqual([MARKER]);
  });
});
