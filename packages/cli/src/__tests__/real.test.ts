import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REAL_LIBRARY, hasRealLibrary } from "@presenter-garage/core/lib/__tests__/corpus";
import { findPresentations, openRoots } from "@presenter-garage/node/library";
import { run } from "../cli";
import { compareSongs } from "../compare";
import { readSource } from "../source";

/**
 * The command over real libraries, where there are any; see *Testing against
 * real files* in CONTRIBUTING.md. Every suite skips cleanly without them,
 * and writes only into a temporary folder it removes.
 */

const REAL_WORKSPACE = process.env.PP_WORKSPACE_DIR;
const REAL_LEGACY = process.env.PP_LEGACY_LIBRARY_DIR;

const quiet = { out: () => {}, err: () => {} };

describe.skipIf(!hasRealLibrary)("dumping a real library", () => {
  it("writes a JSON and a text file for every song it can read, and names the rest", async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "pg-dump-"));
    try {
      expect(await run(["dump", `real=${REAL_LIBRARY}`, "--out", out], quiet)).toBe(0);
      const index = JSON.parse(fs.readFileSync(path.join(out, "index.json"), "utf8"));
      const { files } = await findPresentations(await openRoots([REAL_LIBRARY]));
      expect(index.songs.length + index.source.failures.length).toBe(files.length);
      for (const song of index.songs) {
        expect(fs.existsSync(path.join(out, song.json)), song.json).toBe(true);
        expect(fs.existsSync(path.join(out, song.text)), song.text).toBe(true);
      }
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 300_000);
});

describe.skipIf(!REAL_WORKSPACE || !REAL_LEGACY)("a real workspace against the library it was made from", () => {
  it("finds every song nobody has edited since the upgrade identical, and leaves the workspace alone", async () => {
    const store = path.join(REAL_WORKSPACE!, "DocumentStore");
    const before = fs.readdirSync(store).sort();
    const legacy = await readSource({ label: "legacy", path: REAL_LEGACY! });
    const workspace = await readSource({ label: "workspace", path: REAL_WORKSPACE! }, { legacy: REAL_LEGACY });
    expect(fs.readdirSync(store).sort()).toEqual(before);

    const pairs = compareSongs(legacy.songs, workspace.songs, { labels: { a: "legacy", b: "workspace" } });
    const untouched = pairs.filter((p) => p.matchedBy === "id" && p.b?.edited.source === "beforeUpgrade");
    // How many depends on the library; the rules that date them are tested on fixtures in cli.test.ts.
    expect(untouched.length).toBeGreaterThan(0);
    expect(untouched.filter((p) => p.content !== "identical").map((p) => p.b!.file)).toEqual([]);
    // Dated by the very file it was made from.
    for (const pair of untouched) expect(pair.later).toBe("same");
  }, 300_000);
});
