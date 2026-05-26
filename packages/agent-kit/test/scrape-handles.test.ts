import { describe, expect, it } from "vitest";
import type { HandleSet } from "@wingman-x/kb-contract";
import { selectScrapeHandles } from "../src/scrape-handles.js";

describe("selectScrapeHandles", () => {
  it("returns normalized, deduped handles from every-run tiers", () => {
    const handleSet: HandleSet = {
      tiers: [
        {
          tier: 1,
          label: "Core",
          policy: "every-run",
          handles: [
            { handle: "alice_ai" },
            { handle: "BobAI" },
            { handle: "alice_ai" },
          ],
        },
        {
          tier: 2,
          label: "Also core",
          policy: "every-run",
          handles: [{ handle: "BobAI" }, { handle: "carol" }],
        },
      ],
    };

    expect(selectScrapeHandles(handleSet)).toEqual(["alice_ai", "BobAI", "carol"]);
  });

  it("treats undefined policy as not every-run", () => {
    const handleSet: HandleSet = {
      tiers: [
        {
          tier: 1,
          label: "Legacy",
          handles: [{ handle: "legacy_pick" }],
        },
      ],
    };

    expect(selectScrapeHandles(handleSet)).toEqual([]);
  });

  it("returns empty when no tier has every-run policy", () => {
    const handleSet: HandleSet = {
      tiers: [
        {
          tier: 2,
          label: "Sampled",
          policy: "sampled",
          handles: [{ handle: "sampled_pick" }],
        },
        {
          tier: 3,
          label: "Manual",
          policy: "manual",
          handles: [{ handle: "manual_pick" }],
        },
      ],
    };

    expect(selectScrapeHandles(handleSet)).toEqual([]);
  });

  it("returns empty for an empty handle set", () => {
    expect(selectScrapeHandles({ tiers: [] })).toEqual([]);
  });
});
