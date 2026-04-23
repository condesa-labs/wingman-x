import { defineConfig } from "vitest/config";

/**
 * Vitest runs the port-discovery unit tests only. The Playwright E2E
 * suite uses its own runner (`npm run test:e2e`) so the two test
 * pyramids don't collide on globals.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/unit/**/*.test.ts"],
    exclude: ["test/e2e/**", "node_modules/**"],
  },
});
