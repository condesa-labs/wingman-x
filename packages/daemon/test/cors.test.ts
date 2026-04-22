import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { setupTempStateDir } from "./helpers/tmpState.js";

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

  it("returns 204 for OPTIONS from chrome-extension://test with expected headers", async () => {
    app = await buildServer();

    const res = await app.inject({
      method: "OPTIONS",
      url: "/candidates",
      headers: {
        origin: "chrome-extension://test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "chrome-extension://test",
    );

    const methods = String(res.headers["access-control-allow-methods"] ?? "");
    for (const m of ["GET", "POST", "PUT", "OPTIONS"]) {
      expect(methods.toUpperCase()).toContain(m);
    }

    const allowHeaders = String(
      res.headers["access-control-allow-headers"] ?? "",
    );
    expect(allowHeaders.toLowerCase()).toContain("content-type");
  });

  it("echoes a long unpacked-extension id origin", async () => {
    app = await buildServer();
    const origin =
      "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef"; // 32-char prod id

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

  it("allows http://localhost:5173 preflight (dev harness)", async () => {
    app = await buildServer();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/candidates",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "http://localhost:5173",
    );
  });

  it("does not echo ACAO for disallowed origins", async () => {
    app = await buildServer();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/candidates",
      headers: {
        origin: "https://evil.example.com",
        "access-control-request-method": "POST",
      },
    });
    // Either 204 (preflight handled) with NO ACAO header, or a non-2xx.
    // We only insist the ACAO is absent so the browser blocks the call.
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("OPTIONS preflight works on every major route", async () => {
    app = await buildServer();
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
          origin: "chrome-extension://testid",
          "access-control-request-method": "POST",
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe(
        "chrome-extension://testid",
      );
    }
  });
});
