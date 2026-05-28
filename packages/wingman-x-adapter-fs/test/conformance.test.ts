import { resolve } from "node:path";
import { runConformanceTests } from "@winman-x/adapter-test-kit";
import { describe, expect, it } from "vitest";

import { configSchema, createAdapter, type FsConfig } from "../src/index.js";

const fixturesRoot = resolve(import.meta.dirname, "fixtures");

describe("@winman-x/adapter-fs conformance", () => {
  runConformanceTests<FsConfig>({
    createAdapter,
    configSchema,
    fixtures: {
      config: { rootPath: resolve(fixturesRoot, "sample-kb") },
    },
    suiteName: "sample KB fixture",
  });

  runConformanceTests<FsConfig>({
    createAdapter,
    configSchema,
    fixtures: {
      config: { rootPath: resolve(fixturesRoot, "no-handles-kb") },
    },
    suiteName: "no-handles KB fixture",
  });

  it("returns an empty HandleSet when handles.md is absent", async () => {
    const adapter = createAdapter({ rootPath: resolve(fixturesRoot, "no-handles-kb") });

    await expect(adapter.getHandles()).resolves.toEqual({ tiers: [] });
  });
});
