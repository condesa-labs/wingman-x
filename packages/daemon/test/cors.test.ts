import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer, DAEMON_HEADER } from "../src/server.js";
import { setupTempStateDir } from "./helpers/tmpState.js";

// Chrome extension IDs are 32 lowercase characters in [a-p] (derived
// from a SHA-256 hash of the extension's public key, folded to 4 bits
// per char). Production, unpacked-dev, and test-harness IDs ALL use
// this format.
const REAL_EXT_ID = "abcdefghijklmnopabcdefghijklmnop"; // 32 chars, [a-p]
const REAL_EXT_ORIGIN = `chrome-extension://${REAL_EXT_ID}`;

describe("CORS preflight", () => {
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

  it("returns 204 for OPTIONS from a valid chrome-extension origin with expected headers", async () => {
    app = await buildServer();

    const res = await app.inject({
      method: "OPTIONS",
      url: "/candidates",
      headers: {
        origin: REAL_EXT_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(REAL_EXT_ORIGIN);

    const methods = String(res.headers["access-control-allow-methods"] ?? "");
    for (const m of ["GET", "POST", "PUT", "OPTIONS"]) {
      expect(methods.toUpperCase()).toContain(m);
    }

    const allowHeaders = String(
      res.headers["access-control-allow-headers"] ?? "",
    );
    expect(allowHeaders.toLowerCase()).toContain("content-type");

    // `x-twitter-helper-daemon` must be exposed so browser JS can read
    // it from `res.headers.get()` across origins (review-loop f14).
    const exposed = String(res.headers["access-control-expose-headers"] ?? "");
    expect(exposed.toLowerCase()).toContain(DAEMON_HEADER);
  });

  it("echoes any canonical 32-char [a-p] chrome-extension id", async () => {
    app = await buildServer();
    const origin = `chrome-extension://bcdefghijklmnopabcdefghijklmnoab`;

    const res = await app.inject({
      method: "OPTIONS",
      url: "/candidates",
      headers: {
        origin,
        "access-control-request-method": "POST",
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(origin);
  });

  it("rejects chrome-extension IDs that don't match the [a-p]{32} format (f4)", async () => {
    app = await buildServer();

    for (const badOrigin of [
      "chrome-extension://test", // too short — old test fixture value
      "chrome-extension://abc123", // includes digit + short
      `chrome-extension://${"q".repeat(32)}`, // 32 chars but outside [a-p]
      `chrome-extension://${"a".repeat(33)}`, // 33 chars
      "chrome-extension://ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP", // uppercase
    ]) {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/candidates",
        headers: {
          origin: badOrigin,
          "access-control-request-method": "POST",
        },
      });
      expect(
        res.headers["access-control-allow-origin"],
        `expected ACAO absent for ${badOrigin}`,
      ).toBeUndefined();
    }
  });

  it("allows the content-script page origins (twitter.com, x.com, localhost test fixtures)", async () => {
    // Content-scripts run in the host page's origin, so CORS applies
    // when they fetch localhost:daemon. The daemon allows exactly the
    // origins the extension is active on per its manifest
    // host_permissions (review-loop f4).
    app = await buildServer();
    for (const origin of [
      "https://twitter.com",
      "https://www.twitter.com",
      "https://x.com",
      "https://www.x.com",
      "http://localhost",
      "http://localhost:5173",
      "http://localhost:38917",
    ]) {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/candidates",
        headers: {
          origin,
          "access-control-request-method": "GET",
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-origin"], `origin=${origin}`).toBe(
        origin,
      );
    }
  });

  it("rejects origins that are not chrome-extension, twitter/x, or localhost (f4)", async () => {
    app = await buildServer();
    for (const badOrigin of [
      "https://evil.example.com",
      "https://twitter.com.evil.com", // subdomain attack
      "http://localhost.evil.com", // subdomain attack
      "ftp://localhost", // wrong protocol
      "http://127.0.0.1", // not localhost hostname
    ]) {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/candidates",
        headers: {
          origin: badOrigin,
          "access-control-request-method": "GET",
        },
      });
      expect(
        res.headers["access-control-allow-origin"],
        `expected ACAO absent for ${badOrigin}`,
      ).toBeUndefined();
    }
  });

  it("does not echo ACAO for disallowed origins (evil.example.com)", async () => {
    app = await buildServer();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/candidates",
      headers: {
        origin: "https://evil.example.com",
        "access-control-request-method": "POST",
      },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("OPTIONS preflight works on every major route", async () => {
    app = await buildServer();
    const origin = REAL_EXT_ORIGIN;
    for (const url of [
      "/candidates",
      "/suggestion",
      "/candidates/x/action",
      "/config",
    ]) {
      const res = await app.inject({
        method: "OPTIONS",
        url,
        headers: {
          origin,
          "access-control-request-method": "POST",
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
    }
  });

  describe("WINGMAN_X_EXT_ALLOWED_IDS (f4 defense-in-depth)", () => {
    afterEach(() => {
      delete process.env.WINGMAN_X_EXT_ALLOWED_IDS;
    });

    it("when unset, accepts any canonical extension ID (dev default)", async () => {
      app = await buildServer();
      const res = await app.inject({
        method: "OPTIONS",
        url: "/candidates",
        headers: {
          origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
          "access-control-request-method": "POST",
        },
      });
      expect(res.headers["access-control-allow-origin"]).toBe(
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
      );
    });

    it("when set to a single ID, rejects other canonical IDs", async () => {
      const allowed = "abcdefghijklmnopabcdefghijklmnop";
      const rejected = "bcdefghijklmnopabcdefghijklmnopa";
      process.env.WINGMAN_X_EXT_ALLOWED_IDS = allowed;
      app = await buildServer();

      const okRes = await app.inject({
        method: "OPTIONS",
        url: "/candidates",
        headers: {
          origin: `chrome-extension://${allowed}`,
          "access-control-request-method": "POST",
        },
      });
      expect(okRes.headers["access-control-allow-origin"]).toBe(
        `chrome-extension://${allowed}`,
      );

      const badRes = await app.inject({
        method: "OPTIONS",
        url: "/candidates",
        headers: {
          origin: `chrome-extension://${rejected}`,
          "access-control-request-method": "POST",
        },
      });
      expect(badRes.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("supports a comma-separated allowlist", async () => {
      const idA = "abcdefghijklmnopabcdefghijklmnop";
      const idB = "bcdefghijklmnopabcdefghijklmnopa";
      const idC = "cdefghijklmnopabcdefghijklmnopab";
      process.env.WINGMAN_X_EXT_ALLOWED_IDS = `${idA}, ${idB}`;
      app = await buildServer();

      for (const ok of [idA, idB]) {
        const res = await app.inject({
          method: "OPTIONS",
          url: "/candidates",
          headers: {
            origin: `chrome-extension://${ok}`,
            "access-control-request-method": "POST",
          },
        });
        expect(
          res.headers["access-control-allow-origin"],
          `allowed id=${ok}`,
        ).toBe(`chrome-extension://${ok}`);
      }

      const res = await app.inject({
        method: "OPTIONS",
        url: "/candidates",
        headers: {
          origin: `chrome-extension://${idC}`,
          "access-control-request-method": "POST",
        },
      });
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("fails closed on set-but-empty env var (defensive against config mistakes)", async () => {
      // Final-consensus-v5 finding: an empty/whitespace value should
      // NOT degrade to the dev-default "accept any canonical ID"
      // path; that would silently disable pinning if a secret expands
      // to "" or a template fails to render. Instead, reject all
      // chrome-extension origins.
      for (const emptyValue of ["", "   ", ",  ,", ","]) {
        process.env.WINGMAN_X_EXT_ALLOWED_IDS = emptyValue;
        app = await buildServer();
        const res = await app.inject({
          method: "OPTIONS",
          url: "/candidates",
          headers: {
            origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
            "access-control-request-method": "POST",
          },
        });
        expect(
          res.headers["access-control-allow-origin"],
          `emptyValue=${JSON.stringify(emptyValue)}`,
        ).toBeUndefined();
        await app.close();
        app = undefined;
      }
    });

    it("still honors twitter.com / x.com / localhost content-script origins regardless of pinning", async () => {
      process.env.WINGMAN_X_EXT_ALLOWED_IDS = "abcdefghijklmnopabcdefghijklmnop";
      app = await buildServer();
      for (const origin of [
        "https://twitter.com",
        "https://x.com",
        "http://localhost:5173",
      ]) {
        const res = await app.inject({
          method: "OPTIONS",
          url: "/candidates",
          headers: {
            origin,
            "access-control-request-method": "GET",
          },
        });
        expect(res.headers["access-control-allow-origin"], `origin=${origin}`).toBe(
          origin,
        );
      }
    });
  });
});

describe("daemon identity header", () => {
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

  it("stamps x-twitter-helper-daemon on 200 responses (review-loop f14)", async () => {
    app = await buildServer();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const header = res.headers[DAEMON_HEADER];
    expect(typeof header).toBe("string");
    expect(header).toMatch(/^\d+\.\d+\.\d+/); // semver-ish
  });

  it("stamps the header on 404 responses too", async () => {
    app = await buildServer();
    const res = await app.inject({
      method: "GET",
      url: "/suggestion?tweet_id=does-not-exist",
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers[DAEMON_HEADER]).toBeDefined();
  });

  it("stamps the header on 400 responses (validation error)", async () => {
    app = await buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/candidates",
      payload: { candidates: [{ foo: "bar" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers[DAEMON_HEADER]).toBeDefined();
  });
});
