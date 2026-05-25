import { describe, expect, it } from "vitest";

import * as kbContract from "../src/index.js";
import type { HandleSet } from "../src/index.js";

const exported = kbContract as Record<string, unknown>;

function parseHandles(markdown: string, adapterName = "test"): HandleSet {
  expect(exported).toHaveProperty("parseHandles");
  return (exported.parseHandles as (input: string, adapter: string) => HandleSet)(
    markdown,
    adapterName,
  );
}

function serializeHandles(set: HandleSet, log?: (line: string) => void): string {
  expect(exported).toHaveProperty("serializeHandles");
  return (exported.serializeHandles as (input: HandleSet, opts?: { log?: (line: string) => void }) => string)(
    set,
    log ? { log } : undefined,
  );
}

describe("handles markdown grammar", () => {
  it("parses canonical markdown tiers, policies, handles, and notes", () => {
    const parsed = parseHandles(`# People

## Tier 1: Core voices
*Policy: every-run*
*Count: 2*
- @alice
- @bob_123 (reply sparingly)

## Tier 2: Research
*Policy: sampled*
*Count: 1*
- @charlie
`);

    expect(parsed).toEqual({
      tiers: [
        {
          tier: 1,
          label: "Core voices",
          policy: "every-run",
          handles: [
            { handle: "alice" },
            { handle: "bob_123", notes: "reply sparingly" },
          ],
        },
        {
          tier: 2,
          label: "Research",
          policy: "sampled",
          handles: [{ handle: "charlie" }],
        },
      ],
    });
  });

  it("round-trips non-empty and empty v1 handle sets", () => {
    const set: HandleSet = {
      tiers: [
        {
          tier: 3,
          label: "Manual checks",
          policy: "manual",
          handles: [{ handle: "dana", notes: "manual review" }],
        },
      ],
    };

    expect(parseHandles(serializeHandles(set))).toEqual(set);
    expect(parseHandles("")).toEqual({ tiers: [] });
    expect(parseHandles(serializeHandles({ tiers: [] }))).toEqual({ tiers: [] });
    expect(serializeHandles({ tiers: [] })).toContain("## Tier 1: (empty)");
  });

  it("logs fields that the v1 grammar must drop during serialization", () => {
    const lines: string[] = [];
    const serialized = serializeHandles(
      {
        tiers: [
          {
            tier: 1,
            label: "Core",
            handles: [{ handle: "alice", tags: ["vip"], notes: "keep" }],
          },
        ],
        meta: { sourceUser: "me", notes: "not encodable" },
      },
      (line) => lines.push(line),
    );

    expect(parseHandles(serialized)).toEqual({
      tiers: [{ tier: 1, label: "Core", handles: [{ handle: "alice", notes: "keep" }] }],
    });
    expect(lines).toEqual([
      JSON.stringify({
        event: "handles_grammar_lossy",
        dropped: ["Handle.tags", "HandleSet.meta"],
      }),
    ]);
  });

  it("throws KBAdapterError CONFIG_INVALID with adapter and source line for malformed input", () => {
    expect(exported).toHaveProperty("KBAdapterError");
    const KBAdapterError = exported.KBAdapterError as new (
      code: string,
      adapter: string,
      message: string,
    ) => Error & { code: string; adapter: string };

    expect(() => parseHandles("## Tier one: Bad\n- @alice", "adapter-fs")).toThrow(KBAdapterError);

    try {
      parseHandles("## Tier one: Bad\n- @alice", "adapter-fs");
      throw new Error("expected parseHandles to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(KBAdapterError);
      expect((err as { name: string }).name).toBe("KBAdapterError");
      expect((err as { code: string }).code).toBe("CONFIG_INVALID");
      expect((err as { adapter: string }).adapter).toBe("adapter-fs");
      expect((err as Error).message).toMatch(/line 1/);
    }
  });
});
