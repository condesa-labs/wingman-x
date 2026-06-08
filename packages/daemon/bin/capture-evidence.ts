/**
 * Capture sample HTTP request/response pairs for every CP02 endpoint.
 * Output goes to the path given as argv[2] (one file per scenario).
 *
 * Usage:
 *   npx tsx bin/capture-evidence.ts <outDir>
 *
 * Not part of the shipped package — internal to the harness evaluation
 * workflow.
 */
import "../../../scripts/load-env.mjs";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/server.js";

const OUT_ARG: string | undefined = process.argv[2];
if (!OUT_ARG) {
  console.error("usage: capture-evidence.ts <outDir>");
  process.exit(2);
}
const OUT: string = OUT_ARG;
mkdirSync(OUT, { recursive: true });

const tmpStateDir = mkdtempSync(join(tmpdir(), "cp02-evidence-"));
process.env.WINGMAN_X_STATE_DIR = tmpStateDir;

const app = await buildServer({ port: 53827 });

function formatResponse(res: {
  statusCode: number;
  headers: Record<string, unknown>;
  payload: string;
}): string {
  const headerLines = Object.entries(res.headers)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join("\n");
  const reasons: Record<number, string> = {
    200: "OK",
    204: "No Content",
    400: "Bad Request",
    404: "Not Found",
    500: "Internal Server Error",
  };
  const reason = reasons[res.statusCode] ?? "";
  const body = res.payload
    ? `\n\n${tryPretty(res.payload)}`
    : "";
  return `HTTP/1.1 ${res.statusCode} ${reason}\n${headerLines}${body}\n`;
}

function tryPretty(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

function requestHeaderLines(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

async function capture(
  name: string,
  request: { method: string; url: string; headers?: Record<string, string>; payload?: unknown },
): Promise<void> {
  const payloadStr = request.payload !== undefined
    ? JSON.stringify(request.payload, null, 2)
    : "";
  const headers: Record<string, string> = {
    host: "localhost:53827",
    ...(request.payload !== undefined
      ? { "content-type": "application/json" }
      : {}),
    ...(request.headers ?? {}),
  };

  const res = await app.inject({
    method: request.method as "GET" | "POST" | "OPTIONS",
    url: request.url,
    headers,
    payload: request.payload as object | undefined,
  });

  const reqBlock = `${request.method} ${request.url} HTTP/1.1\n${requestHeaderLines(headers)}${
    payloadStr ? `\n\n${payloadStr}` : ""
  }\n`;

  const content = `### Request\n\n${reqBlock}\n### Response\n\n${formatResponse({
    statusCode: res.statusCode,
    headers: res.headers as Record<string, unknown>,
    payload: res.payload,
  })}`;

  writeFileSync(join(OUT, `${name}.http`), content, "utf8");
  console.log(`wrote ${name}.http  (status ${res.statusCode})`);
}

const goodCandidate = {
  id: "cand-uuid-001",
  tweet_id: "1790000000000000001",
  tweet_url: "https://x.com/alice_ai/status/1790000000000000001",
  author_handle: "@alice_ai",
  tweet_text: "Hot take on agent frameworks.",
  suggested_reply: "Agree — composition > monolith.",
  match_reason: "matches topic:agents in KB",
  match_category: "topic",
  kb_refs: ["library/agents.md"],
};

// 1. POST /candidates (happy)
await capture("post-candidates", {
  method: "POST",
  url: "/candidates",
  payload: { candidates: [goodCandidate] },
});

// 2. POST /candidates (malformed -> 400)
await capture("post-candidates-400", {
  method: "POST",
  url: "/candidates",
  payload: { candidates: [{ foo: "bar" }] },
});

// 3. GET /candidates
await capture("get-candidates", {
  method: "GET",
  url: "/candidates",
});

// 4. GET /suggestion known -> 200
await capture("get-suggestion-200", {
  method: "GET",
  url: "/suggestion?tweet_id=1790000000000000001",
});

// 5. GET /suggestion unknown -> 404
await capture("get-suggestion-404", {
  method: "GET",
  url: "/suggestion?tweet_id=does-not-exist",
});

// 6. POST /candidates/:id/action
await capture("post-action", {
  method: "POST",
  url: "/candidates/1790000000000000001/action",
  payload: { action: "filled" },
});

// 7. GET /config
await capture("get-config", {
  method: "GET",
  url: "/config",
});

// 8. OPTIONS preflight — uses the canonical 32-char [a-p] Chrome
//    extension ID format that the daemon accepts (review-loop f4).
await capture("options-preflight", {
  method: "OPTIONS",
  url: "/candidates",
  headers: {
    origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type",
  },
});

await app.close();
rmSync(tmpStateDir, { recursive: true, force: true });
console.log("done");
