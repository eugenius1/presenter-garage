import { chmodSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vite";

/**
 * The MCP server, bundled into one file Node can run with nothing installed.
 *
 * Everything is inlined -- the schema descriptor, protobuf.js, the MCP SDK --
 * so an MCP client can be pointed at the file without an `npm install` beside
 * it, and the npm package ships that one file with no dependencies. Node's own
 * modules stay external, as they must.
 */
export default defineConfig({
  plugins: [
    {
      // The file is the package's bin. npm marks a bin executable only when it
      // installs it, so a rebuild in this workspace -- where node_modules/.bin
      // links straight to dist -- left a file `npx presenter-garage-mcp` could
      // not run, and an MCP client started in the repo failed with
      // "Permission denied".
      name: "executable-bin",
      writeBundle(options, bundle) {
        for (const name of Object.keys(bundle)) {
          if (name.endsWith(".mjs")) chmodSync(join(options.dir ?? "dist", name), 0o755);
        }
      },
    },
  ],
  build: {
    ssr: "src/main.ts",
    outDir: "dist",
    emptyOutDir: true,
    // The app's icons have no place beside a server.
    copyPublicDir: false,
    target: "node20",
    rollupOptions: {
      output: { entryFileNames: "presenter-garage-mcp.mjs", banner: "#!/usr/bin/env node" },
    },
  },
  ssr: { noExternal: true, target: "node" },
  test: { name: "mcp" },
});
