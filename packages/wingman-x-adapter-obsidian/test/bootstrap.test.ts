import * as http from "node:http";
import * as https from "node:https";
import { ToneResultSchema } from "@wingman-x/kb-contract";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bootstrapTone } from "../src/bootstrap.js";

describe("bootstrapTone", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a ToneResult-compatible offline template", () => {
    const result = bootstrapTone();

    expect(ToneResultSchema.parse(result)).toEqual(result);
    expect(result.markdown.length).toBeGreaterThan(0);
    expect(result.meta).toMatchObject({
      source: "adapter-obsidian:bootstrap",
    });
  });

  it("includes the required Voice DNA and Extraction Prompt headings", () => {
    const result = bootstrapTone();

    expect(result.markdown).toMatch(/^##\s+Voice DNA\s*$/m);
    expect(result.markdown).toMatch(/^##\s+Extraction Prompt\s*$/m);
  });

  it("does not call fetch, http.request, or https.request", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("fetch should not be called");
    }) as typeof fetch);
    const httpSpy = vi.spyOn(http, "request").mockImplementation((() => {
      throw new Error("http.request should not be called");
    }) as unknown as typeof http.request);
    const httpsSpy = vi.spyOn(https, "request").mockImplementation((() => {
      throw new Error("https.request should not be called");
    }) as unknown as typeof https.request);

    bootstrapTone({ hint: "Prefer crisp, technical writing." });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(httpSpy).not.toHaveBeenCalled();
    expect(httpsSpy).not.toHaveBeenCalled();
  });
});
