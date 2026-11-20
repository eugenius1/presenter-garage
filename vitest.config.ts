import { defineConfig } from "vitest/config";

/**
 * One run over every package, each with its own environment and setup.
 *
 * Coverage is measured here rather than per package, so CI uploads a single
 * report covering all three to Codecov.
 */
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
    // Only CI measures coverage, for the Codecov upload; locally it would slow
    // every `npm test` for a number nobody reads. `npm run coverage` forces it.
    coverage: {
      enabled: !!process.env.CI,
      include: ["{packages,apps}/*/src/**"],
      exclude: [
        "{packages,apps}/*/src/**/__tests__/**",
        "{packages,apps}/*/src/**/*.test.{ts,tsx}",
        "packages/core/src/generated/**",
        // Only starts the MCP server on stdio; the suite drives the server
        // itself in-process, and a child process would not be measured.
        "packages/mcp/src/main.ts",
        // Electron's entry points, which need Electron itself: CI's desktop
        // job launches them on macOS and Windows (npm run smoke), and the
        // suite drives what they call -- handlers.ts, serve.ts -- directly.
        "apps/desktop/src/main.ts",
        "apps/desktop/src/preload.ts",
      ],
      reporter: ["lcov", "text-summary"],
    },
  },
});
