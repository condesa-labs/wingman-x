import type { AdapterModule, KBAdapter } from "@wingman-x/kb-contract";
import { describe, expect, it } from "vitest";

import * as adapterFs from "../src/index.js";
import type { FsConfig } from "../src/index.js";

describe("public entrypoint exports", () => {
  it("exports named createAdapter and configSchema without a default export", () => {
    expect(Object.keys(adapterFs).sort()).toEqual(["configSchema", "createAdapter"]);
    expect("default" in adapterFs).toBe(false);
  });

  it("satisfies AdapterModule<FsConfig> at compile time", () => {
    const module: AdapterModule<FsConfig> = adapterFs;
    const parsed = module.configSchema.parse({});
    expect(parsed).toEqual({});

    const adapter: KBAdapter = module.createAdapter({ rootPath: "/tmp/wingman-x-missing" });
    expect(adapter).toMatchObject({
      schemaVersion: "1",
      name: "adapter-fs",
      displayName: "Filesystem",
    });
  });
});
