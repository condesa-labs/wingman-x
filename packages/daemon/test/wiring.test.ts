import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { buildServer } from "../src/server.js";
import { setupTempStateDir } from "./helpers/tmpState.js";

describe("wiring: cold-start migration smoke", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  let ctx: ReturnType<typeof setupTempStateDir>;

  beforeEach(() => {
    ctx = setupTempStateDir();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    ctx.cleanup();
  });

  it("boots pre-tweet-pool state and persists tweet_pool default on first mutation", async () => {
    writeFileSync(
      ctx.statePath,
      JSON.stringify(
        {
          candidates: {},
          signals: {},
          config: { kb_dir: "/tmp/legacy-kb" },
        },
        null,
        2,
      ),
      "utf8",
    );

    app = await buildServer();
    const before = JSON.parse(readFileSync(ctx.statePath, "utf8")) as Record<string, unknown>;
    expect(before.tweet_pool).toBeUndefined();

    const mutation = await app.inject({
      method: "POST",
      url: "/signals",
      payload: { kind: "discovery_requested" },
    });
    expect(mutation.statusCode).toBe(200);

    const after = JSON.parse(readFileSync(ctx.statePath, "utf8")) as Record<string, unknown>;
    expect(after.tweet_pool).toEqual({});
    expect(Object.keys(after.signals as Record<string, unknown>)).toHaveLength(1);
  });
});
