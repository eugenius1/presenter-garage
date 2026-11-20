import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  test: {
    name: "web",
    // Node by default: most suites need no DOM. Component tests opt in with a
    // `@vitest-environment jsdom` docblock, which keeps the fast path fast.
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/__tests__/setup.ts"],
  },
});
