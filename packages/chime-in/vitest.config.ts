import { defineConfig } from "vitest/config";

/**
 * Vitest config for @wingman-x/chime-in.
 *
 * Coverage is scoped to `src/**`. The real LLM providers (claude-cli,
 * codex-cli, anthropic) spawn external binaries or call the network and
 * are exercised manually, not under coverage. Everything else — the
 * ingestion normaliser, dedupe store, scoring stages, ranking, and the
 * Wingman candidate mapping — is covered by hermetic unit tests that
 * use the fake provider and the fixture post source.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/llm/claude-cli.ts",
        "src/llm/codex-cli.ts",
        "src/llm/anthropic.ts",
        "src/llm/index.ts",
        "src/sources/apify/apify-client-runner.ts",
        "src/wingman/daemon.ts",
        "**/*.d.ts",
      ],
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 75,
      },
    },
  },
});
