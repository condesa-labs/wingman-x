import { defineConfig } from "vitest/config";

/**
 * Vitest config for @wingman-x/agent-kit.
 *
 * Coverage is scoped strictly to `src/**`. The integration test spawns a
 * real daemon child process, but the daemon's source files live in a
 * different workspace and are deliberately out-of-scope for this
 * package's coverage gate (the spec excludes markdown, sample-kb, and
 * skill files; by the same logic the daemon is out of this package's
 * coverage universe).
 *
 * The integration test has generous timeouts because it waits for the
 * child daemon to print its grep-able `[daemon] listening on port N`
 * line.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Exclude barrel file from the coverage ratio. The barrel is pure
      // re-exports; including it either inflates numbers or creates
      // uncovered-but-meaningless branches depending on how v8 measures
      // module-level exports.
      exclude: ["src/index.ts", "**/*.d.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 85,
        statements: 85,
        functions: 85,
        branches: 85,
      },
    },
  },
});
