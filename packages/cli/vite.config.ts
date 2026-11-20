import { defineConfig } from "vite";

/**
 * The command, bundled into one file as the MCP server is: the schema
 * descriptor, protobuf.js and Loro inlined, Node's own modules external.
 */
export default defineConfig({
  build: {
    ssr: "src/main.ts",
    outDir: "dist",
    emptyOutDir: true,
    copyPublicDir: false,
    target: "node22",
    rollupOptions: {
      output: { entryFileNames: "presenter-garage.mjs", banner: "#!/usr/bin/env node" },
    },
  },
  ssr: { noExternal: true, target: "node" },
  test: { name: "cli" },
});
