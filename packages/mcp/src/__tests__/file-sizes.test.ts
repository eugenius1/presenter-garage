import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * How long a source file may grow, kept with the other rules that span the
 * workspace (`workspace.test.ts`).
 *
 * Over 800 lines a file is split. Between 500 and 800 it is split where it
 * does two separate jobs, and otherwise says at its top why it is one: a
 * cohesive module, a parser or one state machine, is better whole than cut
 * into shallow files that call back into each other. CONTRIBUTING.md has
 * the rule under *Conventions*.
 */
const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

const SPLIT_OVER = 800;
const EXPLAIN_OVER = 500;
/** What a file between the two limits begins with, within its first few lines. */
const REASON = "Kept whole:";
const REASON_WITHIN = 3;

const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs|css)$/;
/** Flat data, tests and their fixtures, and what is generated or built: none of it is read as a module is. */
const EXEMPT = [
  /^packages\/core\/src\/i18n\/(en|fr)\.ts$/,
  /(^|\/)__tests__\//,
  /\.test\.[^/]+$/,
  /(^|\/)fixtures\//,
  /(^|\/)generated\//,
  /(^|\/)dist\//,
];

/**
 * Every source file the repository tracks. Tracked rather than found on
 * disk, so what is ignored -- `private/`, the generated descriptor, a build --
 * is never counted, as it is never committed.
 */
function sources(): string[] {
  const listed = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" });
  return listed
    .split("\0")
    .filter((file) => SOURCE.test(file) && !EXEMPT.some((rule) => rule.test(file)))
    // A file deleted in the working tree but not yet from the index has nothing to count.
    .filter((file) => fs.existsSync(path.join(REPO, file)));
}

const lines = (text: string) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

describe("file sizes", () => {
  const files = sources().map((file) => {
    const text = fs.readFileSync(path.join(REPO, file), "utf8");
    return { file, count: lines(text), explained: text.split("\n").slice(0, REASON_WITHIN).join("\n").includes(REASON) };
  });

  it("finds the source files", () => {
    // A listing that came back empty would pass everything below.
    expect(files.map(({ file }) => file)).toContain("packages/mcp/src/server.ts");
  });

  it(`splits every file over ${SPLIT_OVER} lines`, () => {
    const long = files.filter(({ count }) => count > SPLIT_OVER).map(({ file, count }) => `${file}: ${count}`);
    expect(long).toEqual([]);
  });

  it(`says why a file over ${EXPLAIN_OVER} lines is kept whole`, () => {
    const unexplained = files
      .filter(({ count, explained }) => count > EXPLAIN_OVER && count <= SPLIT_OVER && !explained)
      .map(({ file, count }) => `${file}: ${count} lines, with no "${REASON}" comment at its top`);
    expect(unexplained).toEqual([]);
  });
});
