import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as kbContract from "../src/index.js";
import type {
  AdapterModule,
  BootstrapOptions,
  HandleSet,
  HealthReport,
  KBAdapter,
  KBEvent,
  LibraryContent,
  LibraryEntry,
  ToneResult,
} from "../src/index.js";

const exported = kbContract as Record<string, unknown>;

describe("public barrel exports", () => {
  it("exports every CP02 public runtime symbol", () => {
    expect(Object.keys(exported).sort()).toEqual([
      "BootstrapOptionsSchema",
      "HandleSchema",
      "HandleSetSchema",
      "HandleTierSchema",
      "HealthReportSchema",
      "KBAdapterError",
      "KBEventSchema",
      "LibraryContentSchema",
      "LibraryEntrySchema",
      "ToneResultSchema",
      "WingmanXConfigSchema",
      "parseHandles",
      "serializeHandles",
      "slugify",
    ]);
  });

  it("pins KBAdapter and AdapterModule method signatures at compile time", async () => {
    const health: HealthReport = {
      ok: true,
      stats: { libraryCount: 1, handlesCount: 2, toneBytes: 3 },
      warnings: [],
      errors: [],
    };
    const tone: ToneResult = { markdown: "voice", meta: { language: "en" } };
    const entry: LibraryEntry = { id: "sample-entry", title: "Sample" };
    const content: LibraryContent = { ...entry, markdown: "# Sample" };
    const handles: HandleSet = { tiers: [] };
    const event: KBEvent = { kind: "handles-changed" };
    const opts: BootstrapOptions = { maxBytes: 100, hint: "short" };

    const adapter: KBAdapter = {
      schemaVersion: "1",
      name: "adapter-fs",
      version: "0.1.0",
      displayName: "Filesystem",
      healthCheck: async () => health,
      getTone: async () => tone,
      bootstrapTone: async (_opts = opts) => tone,
      listLibrary: async () => [entry],
      getLibraryEntry: async () => content,
      searchLibrary: async () => [entry],
      getHandles: async () => handles,
      watch: async function* () {
        yield event;
      },
    };
    const module: AdapterModule<{ root: string }> = {
      createAdapter: (_config) => adapter,
      configSchema: z.object({ root: z.string() }),
    };

    await expect(module.createAdapter({ root: "/tmp" }).healthCheck()).resolves.toEqual(health);
    await expect(adapter.bootstrapTone?.(opts)).resolves.toEqual(tone);
  });
});
