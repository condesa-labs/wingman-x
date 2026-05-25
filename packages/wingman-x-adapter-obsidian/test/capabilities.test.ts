import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { configSchema, createAdapter } from "../src/index.js";

describe("deferred capabilities", () => {
  it("does not implement bootstrapTone, searchLibrary, or watch in CP05", () => {
    const adapter = createAdapter(
      configSchema.parse({ vaultPath: resolve(import.meta.dirname, "fixtures/sample-vault") }),
    );

    expect(adapter.bootstrapTone).toBeUndefined();
    expect(adapter.searchLibrary).toBeUndefined();
    expect(adapter.watch).toBeUndefined();
  });
});
