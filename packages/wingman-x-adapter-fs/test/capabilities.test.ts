import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createAdapter } from "../src/index.js";

describe("deferred capabilities", () => {
  it("does not implement bootstrapTone or watch", () => {
    const adapter = createAdapter({
      rootPath: resolve(import.meta.dirname, "fixtures/sample-kb"),
    });

    expect(adapter.bootstrapTone).toBeUndefined();
    expect(adapter.watch).toBeUndefined();
  });
});
