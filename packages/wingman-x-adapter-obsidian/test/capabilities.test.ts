import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { configSchema, createAdapter } from "../src/index.js";

describe("deferred capabilities", () => {
  it("implements bootstrapTone while keeping searchLibrary and watch deferred in CP06", () => {
    const adapter = createAdapter(
      configSchema.parse({ vaultPath: resolve(import.meta.dirname, "fixtures/sample-vault") }),
    );

    expect(adapter.bootstrapTone).toBeTypeOf("function");
    expect(adapter.searchLibrary).toBeUndefined();
    expect(adapter.watch).toBeUndefined();
  });
});
