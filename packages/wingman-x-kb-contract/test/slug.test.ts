import { describe, expect, it } from "vitest";

import * as kbContract from "../src/index.js";

const exported = kbContract as Record<string, unknown>;

describe("slugify", () => {
  it("derives lowercase kebab-case ASCII ids without stripping file extensions", () => {
    expect(exported).toHaveProperty("slugify");
    const slugify = exported.slugify as (input: string) => string;

    expect(slugify("My Reply Library.md")).toBe("my-reply-library-md");
    expect(slugify("already-kebab-123")).toBe("already-kebab-123");
    expect(slugify("hello__world...again")).toBe("hello-world-again");
    expect(slugify("  Leading / trailing  ")).toBe("leading-trailing");
  });

  it("returns an empty id for empty, hyphen-only, or all non-ASCII inputs", () => {
    const slugify = exported.slugify as (input: string) => string;

    expect(slugify("")).toBe("");
    expect(slugify("!!!")).toBe("");
    expect(slugify("你好世界")).toBe("");
    expect(slugify("東京.md")).toBe("md");
  });
});
