import { defineConfig } from "vite";

/** The preload: CommonJS, because Electron loads a sandboxed preload no other way. */
export default defineConfig({
  build: {
    ssr: "src/preload.ts",
    outDir: "dist",
    emptyOutDir: false,
    copyPublicDir: false,
    target: "node22",
    rollupOptions: {
      external: ["electron"],
      output: { entryFileNames: "preload.cjs", format: "cjs" },
    },
  },
  ssr: { noExternal: true, external: ["electron"], target: "node" },
});
