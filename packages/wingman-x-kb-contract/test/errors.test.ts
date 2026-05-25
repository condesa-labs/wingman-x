import { describe, expect, it } from "vitest";

import * as kbContract from "../src/index.js";

const exported = kbContract as Record<string, unknown>;

describe("KBAdapterError", () => {
  it("exposes stable discriminators and supports instanceof plus switch(err.name)", () => {
    expect(exported).toHaveProperty("KBAdapterError");
    const KBAdapterError = exported.KBAdapterError as new (
      code: string,
      adapter: string,
      message: string,
    ) => Error & { code: string; adapter: string };

    const err = new KBAdapterError("NOT_FOUND", "adapter-fs", "missing library entry");

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(KBAdapterError);
    expect(err.name).toBe("KBAdapterError");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.adapter).toBe("adapter-fs");
    expect(err.message).toBe("missing library entry");

    let handled = false;
    switch (err.name) {
      case "KBAdapterError":
        handled = true;
        break;
      default:
        handled = false;
    }
    expect(handled).toBe(true);
  });
});
