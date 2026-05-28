import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as kbContract from "../src/index.js";

const exported = kbContract as Record<string, unknown>;

function schema(name: string): z.ZodType {
  expect(exported).toHaveProperty(name);
  return exported[name] as z.ZodType;
}

describe("CP02 Zod schemas", () => {
  it("accepts and rejects the canonical wire shapes", () => {
    const health = schema("HealthReportSchema");
    expect(
      health.parse({
        ok: true,
        stats: { libraryCount: 1, handlesCount: 2, toneBytes: 3 },
        warnings: [],
        errors: [],
      }),
    ).toMatchObject({ ok: true });
    expect(() =>
      health.parse({
        ok: true,
        stats: { libraryCount: -1, handlesCount: 0, toneBytes: 0 },
        warnings: [],
        errors: [],
      }),
    ).toThrow();

    const tone = schema("ToneResultSchema");
    expect(
      tone.parse({
        markdown: "voice",
        meta: {
          version: "1",
          language: "en",
          updatedAt: "2026-05-25T00:00:00.000Z",
          source: "test",
          tags: ["reply"],
        },
      }),
    ).toMatchObject({ meta: { updatedAt: "2026-05-25T00:00:00.000Z" } });
    expect(() => tone.parse({ markdown: "voice", meta: { updatedAt: "not-a-date" } })).toThrow();

    const libraryEntry = schema("LibraryEntrySchema");
    expect(libraryEntry.parse({ id: "valid-id-1", title: "Valid" })).toMatchObject({
      id: "valid-id-1",
    });
    expect(() => libraryEntry.parse({ id: "Invalid_Id", title: "Bad" })).toThrow(
      /kebab-case ASCII/,
    );
    expect(() => libraryEntry.parse({ id: "a".repeat(65), title: "Too long" })).toThrow();

    const libraryContent = schema("LibraryContentSchema");
    expect(
      libraryContent.parse({
        id: "valid-id",
        title: "Valid",
        markdown: "# Valid",
        frontmatter: { pinned: true },
      }),
    ).toMatchObject({ frontmatter: { pinned: true } });

    const handle = schema("HandleSchema");
    expect(handle.parse({ handle: "User_123", tags: ["vip"], notes: "watch" })).toMatchObject({
      handle: "User_123",
    });
    expect(() => handle.parse({ handle: "@bad" })).toThrow(/no @ prefix/);

    const handleTier = schema("HandleTierSchema");
    expect(
      handleTier.parse({ tier: 2, label: "Watch", policy: "sampled", handles: [] }),
    ).toMatchObject({ tier: 2 });
    expect(() => handleTier.parse({ tier: 4, label: "Bad", handles: [] })).toThrow();

    const handleSet = schema("HandleSetSchema");
    expect(
      handleSet.parse({
        tiers: [{ tier: 1, label: "Core", handles: [{ handle: "alice" }] }],
        meta: { sourceUser: "me", scrapedAt: "2026-05-25T00:00:00.000Z", notes: "seed" },
      }),
    ).toMatchObject({ meta: { sourceUser: "me" } });
    expect(() => handleSet.parse({ tiers: [], meta: { scrapedAt: "not-a-date" } })).toThrow();

    const event = schema("KBEventSchema");
    expect(event.parse({ kind: "library-changed", ids: ["valid-id"] })).toEqual({
      kind: "library-changed",
      ids: ["valid-id"],
    });
    expect(() => event.parse({ kind: "library-changed" })).toThrow();

    const bootstrapOptions = schema("BootstrapOptionsSchema");
    expect(bootstrapOptions.parse(undefined)).toBeUndefined();
    expect(bootstrapOptions.parse({ maxBytes: 1, hint: "short" })).toEqual({
      maxBytes: 1,
      hint: "short",
    });
    expect(() => bootstrapOptions.parse({ maxBytes: 0 })).toThrow();
  });

  it("validates WingmanX loader config including defaults and package regex", () => {
    const config = schema("WingmanXConfigSchema");

    expect(
      config.parse({
        version: 1,
        adapter: {
          package: "@winman-x/adapter.fs_1",
          name: "adapter-fs",
          config: { root: "/tmp/kb" },
        },
        cache: {},
      }),
    ).toMatchObject({
      cache: { ttlSeconds: 900, strategy: "stale-while-revalidate" },
    });
    expect(
      config.parse({
        version: 1,
        adapter: { package: "adapter.fs_1", name: "adapter-fs", config: {} },
      }),
    ).toMatchObject({ adapter: { package: "adapter.fs_1" } });

    expect(() => config.parse({ adapter: { package: "adapter", name: "adapter", config: {} } }))
      .toThrow();
    expect(() =>
      config.parse({
        version: 1,
        adapter: { package: "Adapter", name: "adapter", config: {} },
      }),
    ).toThrow(/valid npm package specifier/);
    expect(() =>
      config.parse({
        version: 1,
        adapter: { package: "adapter", name: "Adapter_Fs", config: {} },
      }),
    ).toThrow(/kebab-case ASCII/);
    expect(() =>
      config.parse({ version: 1, adapter: { package: "adapter", name: "adapter" } }),
    ).toThrow();
  });
});
