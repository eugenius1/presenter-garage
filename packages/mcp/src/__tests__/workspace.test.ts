import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Rules that span the workspace, kept with the package they protect: the MCP
 * server is the one published, and the one a stray import would bloat.
 */
const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
const manifest = (dir: string): Manifest => JSON.parse(fs.readFileSync(path.join(REPO, dir, "package.json"), "utf8"));
const PACKAGES = ["packages/core", "packages/node", "apps/web", "packages/mcp", "apps/desktop"];

describe("the workspace", () => {
  it("carries one version in every package", () => {
    // The release workflow stamps the tag's version into every package at
    // once (npm version <v> --workspaces --include-workspace-root), so the
    // server, the extension and the desktop app all ship the same number.
    // Read from the root's workspaces, so a new app is held to it too.
    const root = manifest(".") as Manifest & { workspaces: string[] };
    const dirs = root.workspaces.flatMap((glob) => {
      const parent = glob.replace(/\/\*$/, "");
      return fs
        .readdirSync(path.join(REPO, parent))
        .map((name) => `${parent}/${name}`)
        .filter((dir) => fs.existsSync(path.join(REPO, dir, "package.json")));
    });
    expect(dirs).toEqual(expect.arrayContaining(PACKAGES));
    for (const dir of dirs) expect(manifest(dir).version, dir).toBe(root.version);
  });

  it("keeps the placeholder version in the repository", () => {
    // The tag is the only place a version lives; the release run stamps it in
    // and commits nothing back. A real number here would be stale the moment
    // the next release is cut. The release run itself checks at its own
    // version, which is when RELEASE_VERSION is set.
    expect(manifest(".").version).toBe(process.env.RELEASE_VERSION ?? "0.0.0");
  });

  it("ships the repository's own licence with the npm package", () => {
    // npm packs only what is inside the package, so the licence is a copy.
    expect(fs.readFileSync(path.join(REPO, "packages/mcp/LICENSE"), "utf8")).toBe(
      fs.readFileSync(path.join(REPO, "LICENSE"), "utf8")
    );
  });

  // npm hoists every package to the root, so an import of something a package
  // never declared still resolves -- and the server's bundle, which inlines
  // everything, would quietly carry the app's React along with it. The
  // desktop app's main process is bundled the same way.
  for (const dir of ["packages/core", "packages/node", "packages/mcp", "apps/desktop"]) {
    const name = path.basename(dir);
    it(`lets ${name} import only what it declares`, () => {
      const { dependencies, devDependencies } = manifest(dir);
      const declared = new Set(Object.keys({ ...dependencies, ...devDependencies }));
      const undeclared: string[] = [];
      for (const file of sources(path.join(REPO, dir, "src"))) {
        for (const [, ...specs] of fs.readFileSync(file, "utf8").matchAll(IMPORT)) {
          const spec = specs.find((s) => s !== undefined)!;
          if (spec.startsWith(".") || spec.startsWith("node:")) continue;
          const pkg = spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
          if (!declared.has(pkg)) undeclared.push(`${path.relative(REPO, file)}: ${spec}`);
        }
      }
      expect(undeclared).toEqual([]);
    });
  }
});

/** A static import or re-export, a bare `import "x"`, or a dynamic `import("x")`. */
const IMPORT = /^\s*(?:import|export)\b[^;=]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;

/** Source files, without tests: those run under the root's tooling, not in a bundle. */
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "generated" ? [] : sources(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}
