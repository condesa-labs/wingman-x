import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createFakeProvider } from "../src/llm/fake.js";
import { LLMError, createProvider, parseJsonLoose, toJsonSchema, validateWithSchema } from "../src/llm/provider.js";

describe("parseJsonLoose", () => {
  it("parses plain, fenced, and prose-wrapped JSON", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('Sure! Here it is: {"a":{"b":[1,2]}} hope that helps')).toEqual({ a: { b: [1, 2] } });
  });

  it("throws typed errors for empty or non-JSON output", () => {
    expect(() => parseJsonLoose("   ")).toThrow(LLMError);
    expect(() => parseJsonLoose("no braces here")).toThrow(/no JSON object/);
    expect(() => parseJsonLoose("{oops}")).toThrow(/not valid JSON/);
  });
});

describe("createProvider", () => {
  const schema = z.object({ score: z.number().int() });

  it("parses text, validates, and accounts usage", async () => {
    const p = createProvider({
      name: "t",
      models: { cheap: "a", strong: "b", draft: "c" },
      rawComplete: async () => ({ text: '{"score": 7}', costUsd: 0.01 }),
    });
    expect(await p.complete({ tier: "cheap", system: "s", prompt: "p", schema })).toEqual({ score: 7 });
    const u = p.usage();
    expect(u.calls).toBe(1);
    expect(u.byTier.cheap).toBe(1);
    expect(u.costUsd).toBeCloseTo(0.01);
    expect(p.describeModels()).toEqual({ cheap: "a", strong: "b", draft: "c" });
  });

  it("prefers structured output, retries once on schema failure with a repair hint, then throws", async () => {
    const prompts: string[] = [];
    let n = 0;
    const p = createProvider({
      name: "t",
      models: { cheap: "a", strong: "b", draft: "c" },
      rawComplete: async ({ prompt }) => {
        prompts.push(prompt);
        n += 1;
        return n === 1 ? { structured: { score: "bad" } } : { structured: { score: 3 } };
      },
    });
    expect(await p.complete({ tier: "strong", system: "s", prompt: "p", schema })).toEqual({ score: 3 });
    expect(prompts[1]).toMatch(/previous answer was not valid JSON/);
    expect(p.usage().failures).toBe(1);

    const always = createProvider({
      name: "t",
      models: { cheap: "a", strong: "b", draft: "c" },
      rawComplete: async () => ({ text: "nope" }),
    });
    await expect(always.complete({ tier: "draft", system: "s", prompt: "p", schema })).rejects.toThrow(LLMError);
    expect(always.usage().calls).toBe(2);
  });

  it("does not retry non-retryable failures (timeout/spawn)", async () => {
    let n = 0;
    const p = createProvider({
      name: "t",
      models: { cheap: "a", strong: "b", draft: "c" },
      rawComplete: async () => {
        n += 1;
        throw new LLMError("boom", "timeout");
      },
    });
    await expect(p.complete({ tier: "cheap", system: "s", prompt: "p", schema })).rejects.toThrow(/boom/);
    expect(n).toBe(1);
  });

  it("validateWithSchema and toJsonSchema", () => {
    expect(() => validateWithSchema({ score: "x" }, schema)).toThrow(/did not match schema/);
    const js = toJsonSchema(schema);
    expect(js.$schema).toBeUndefined();
    expect(js.type).toBe("object");
  });

  it("fake provider returns scripted structured objects", async () => {
    const fake = createFakeProvider(({ tier }) => ({ score: tier === "cheap" ? 1 : 2 }));
    expect(await fake.complete({ tier: "cheap", system: "", prompt: "", schema })).toEqual({ score: 1 });
    expect(await fake.complete({ tier: "draft", system: "", prompt: "", schema })).toEqual({ score: 2 });
    expect(fake.name).toBe("fake");
  });
});
