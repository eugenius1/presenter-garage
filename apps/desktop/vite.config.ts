import { defineConfig } from "vite";

/**
 * The main process, bundled into one file Electron runs.
 *
 * Everything but Electron itself and Node's own modules is inlined, as the
 * MCP server's bundle is: `core`, `node` and `loro-crdt`, whose `base64`
 * build carries its WebAssembly inside. The preload is built separately
 * (`vite.preload.config.ts`), since a sandboxed preload must be CommonJS.
 */
export default defineConfig({
  build: {
    ssr: "src/main.ts",
    outDir: "dist",
    emptyOutDir: true,
    copyPublicDir: false,
    target: "node22",
    rollupOptions: {
      external: ["electron"],
      output: { entryFileNames: "main.mjs", format: "es" },
    },
  },
  ssr: { noExternal: true, external: ["electron"], target: "node" },
  test: { name: "desktop" },
});
