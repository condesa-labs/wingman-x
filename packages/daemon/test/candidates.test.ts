import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { sampleCandidate, setupTempStateDir } from "./helpers/tmpState.js";

describe("POST /candidates", () => {
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

  it("accepts a valid batch and stores candidates keyed by tweet_id", async () => {
    app = await buildServer();

    const res = await app.inject({
      method: "POST",
      url: "/candidates",
      payload: { candidates: [sampleCandidate()] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stored).toBe(1);

    const getRes = await app.inject({ method: "GET", url: "/candidates" });
    expect(getRes.statusCode).toBe(200);
    const list = getRes.json().candidates as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]!.tweet_id).toBe("1790000000000000001");
    expect(list[0]!.status).toBe("pending");
    expect(typeof list[0]!.status_updated_at).toBe("string");
    expect(typeof list[0]!.created_at).toBe("string");
  });

  it("merges by tweet_id with latest-wins but preserves created_at", async () => {
    app = await buildServer();

    const first = sampleCandidate({
      suggested_reply: "v1",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const firstPost = await app.inject({
      method: "POST",
      url: "/candidates",
      payload: { candidates: [first] },
    });
    expect(firstPost.statusCode).toBe(200);

    const second = sampleCandidate({
      suggested_reply: "v2",
      created_at: "2030-01-01T00:00:00.000Z", // attempt to overwrite
    });
    const secondPost = await app.inject({
      method: "POST",
      url: "/candidates",
      payload: { candidates: [second] },
    });
    expect(secondPost.statusCode).toBe(200);

    const getRes = await app.inject({ method: "GET", url: "/candidates" });
    const list = getRes.json().candidates as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]!.suggested_reply).toBe("v2");
    expect(list[0]!.created_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("rejects malformed body with 400 and details", async () => {
    app = await buildServer();

    const res = await app.inject({
      method: "POST",
      url: "/candidates",
      payload: { candidates: [{ foo: "bar" }] },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("invalid_request");
    expect(Array.isArray(body.details)).toBe(true);
  });

  it("rejects non-object body with 400", async () => {
    app = await buildServer();

    const res = await app.inject({
      method: "POST",
      url: "/candidates",
      payload: "not-json-object" as unknown as object,
      headers: { "content-type": "application/json" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects tweet_url that is not a twitter.com/x.com /status/<id> URL", async () => {
    // Security: tweet_url is later passed to chrome.tabs.create({url}),
    // so a malicious local agent could turn "Open" into navigation to
    // any origin unless the schema pins host+path.
    app = await buildServer();

    const badUrls = [
      "https://evil.com/alice/status/1",
      "https://twitter.com.evil.com/alice/status/1",
      "http://twitter.com/alice/status/1", // http, not https
      "https://twitter.com/alice/statuses/1", // wrong path prefix
      "https://twitter.com/alice/status/abc", // non-numeric id
    ];

    for (const url of badUrls) {
      const res = await app.inject({
        method: "POST",
        url: "/candidates",
        payload: {
          candidates: [sampleCandidate({ tweet_url: url })],
        },
      });
      expect(res.statusCode, `expected 400 for ${url}`).toBe(400);
      expect(res.json().error).toBe("invalid_request");
    }
  });

  it("accepts canonical twitter.com and x.com /status/<id> URLs", async () => {
    app = await buildServer();

    const goodUrls = [
      "https://twitter.com/alice/status/1",
      "https://www.twitter.com/alice/status/1",
      "https://x.com/alice_ai/status/1790000000000000001",
      "https://www.x.com/alice/status/1",
      "https://twitter.com/alice/status/1?src=share",
      "https://twitter.com/alice/status/1/photo/1",
    ];

    for (const url of goodUrls) {
      const res = await app.inject({
        method: "POST",
        url: "/candidates",
        payload: {
          candidates: [sampleCandidate({ tweet_id: `id-${url}`, tweet_url: url })],
        },
      });
      expect(res.statusCode, `expected 200 for ${url}`).toBe(200);
    }
  });
});

describe("GET /suggestion", () => {
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

  it("returns 200 + candidate body for a known tweet_id", async () => {
    app = await buildServer();
    await app.inject({
      method: "POST",
      url: "/candidates",
      payload: { candidates: [sampleCandidate({ tweet_id: "t-known" })] },
    });

    const res = await app.inject({
      method: "GET",
      url: "/suggestion?tweet_id=t-known",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tweet_id).toBe("t-known");
    expect(body.status).toBe("pending");
  });

  it("returns 404 for an unknown tweet_id", async () => {
    app = await buildServer();

    const res = await app.inject({
      method: "GET",
      url: "/suggestion?tweet_id=does-not-exist",
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toBe("not_found");
  });

  it("returns 400 when tweet_id query param is missing", async () => {
    app = await buildServer();

    const res = await app.inject({ method: "GET", url: "/suggestion" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });
});

describe("POST /candidates/:id/action", () => {
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

  it("updates status and status_updated_at for a known candidate", async () => {
    app = await buildServer();
    await app.inject({
      method: "POST",
      url: "/candidates",
      payload: { candidates: [sampleCandidate({ tweet_id: "act-1" })] },
    });

    const before = await app.inject({
      method: "GET",
      url: "/suggestion?tweet_id=act-1",
    });
    const beforeStamp = before.json().status_updated_at as string;

    // Ensure at least 1 ms passes so the timestamp differs.
    await new Promise((r) => setTimeout(r, 5));

    const res = await app.inject({
      method: "POST",
      url: "/candidates/act-1/action",
      payload: { action: "filled" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tweet_id).toBe("act-1");
    expect(body.status).toBe("filled");
    expect(body.status_updated_at).not.toBe(beforeStamp);
  });

  it("returns 404 for unknown candidate id", async () => {
    app = await buildServer();

    const res = await app.inject({
      method: "POST",
      url: "/candidates/missing/action",
      payload: { action: "dismissed" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("rejects invalid action value with 400", async () => {
    app = await buildServer();
    await app.inject({
      method: "POST",
      url: "/candidates",
      payload: { candidates: [sampleCandidate({ tweet_id: "bad-action" })] },
    });

    const res = await app.inject({
      method: "POST",
      url: "/candidates/bad-action/action",
      payload: { action: "bogus" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("GET /config", () => {
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

  it("returns current port + kb_dir", async () => {
    app = await buildServer({ port: 53831 });

    const res = await app.inject({ method: "GET", url: "/config" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.port).toBe(53831);
    expect(typeof body.kb_dir).toBe("string");
    expect(body.kb_dir.length).toBeGreaterThan(0);
  });
});
