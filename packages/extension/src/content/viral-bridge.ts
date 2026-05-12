import { getPortFromWorker } from "../popup/daemon-client.js";
import { DAEMON_IDENTITY_HEADER } from "../daemon-shape.js";
import type { ObservedTweetInput } from "./viral-hook-extract.js";

const MESSAGE_TYPE = "TH_VIRAL_OBSERVED";
const DEBOUNCE_MS = 1000;
const RETRY_MS = 2000;
const MAX_BATCH_SIZE = 50;

let queued: ObservedTweetInput[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (!isViralMessage(event.data)) return;
  queued.push(...event.data.tweets);
  scheduleFlush(DEBOUNCE_MS);
});

async function flush(): Promise<void> {
  timer = null;
  const queuedAtStart = queued.length;
  const batch = queued.slice(0, MAX_BATCH_SIZE);
  if (batch.length === 0) return;

  const port = await resolveDaemonPort();
  if (port === null) {
    console.warn("viral-bridge: daemon port unavailable");
    scheduleFlush(RETRY_MS);
    return;
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/tweets/observed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tweets: batch }),
    });
    if (!res.ok || res.headers.get(DAEMON_IDENTITY_HEADER) === null) {
      console.warn(`viral-bridge: POST /tweets/observed failed (${res.status})`);
      scheduleFlush(RETRY_MS);
      return;
    }
  } catch (err) {
    console.warn(
      `viral-bridge: POST /tweets/observed failed (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    scheduleFlush(RETRY_MS);
    return;
  }

  const dropped = Math.max(queuedAtStart - MAX_BATCH_SIZE, 0);
  if (dropped > 0) {
    console.info(`viral-bridge: batch capped at 50 - ${dropped} events dropped`);
  }
  queued = queued.slice(queuedAtStart);
  if (queued.length > 0) scheduleFlush(DEBOUNCE_MS);
}

function scheduleFlush(delayMs: number): void {
  if (timer === null) {
    timer = setTimeout(() => void flush(), delayMs);
  }
}

async function resolveDaemonPort(): Promise<number | null> {
  const portResult = (await getPortFromWorker(1000)) as unknown;
  if (typeof portResult === "number") return portResult;
  if (
    isRecord(portResult) &&
    typeof portResult.port === "number" &&
    Number.isFinite(portResult.port)
  ) {
    return portResult.port;
  }
  return null;
}

function isViralMessage(
  value: unknown,
): value is { type: typeof MESSAGE_TYPE; tweets: ObservedTweetInput[] } {
  if (!isRecord(value)) return false;
  const v = value as { type?: unknown; tweets?: unknown };
  return (
    v.type === MESSAGE_TYPE &&
    Array.isArray(v.tweets) &&
    v.tweets.every(isObservedTweetInput)
  );
}

function isObservedTweetInput(value: unknown): value is ObservedTweetInput {
  if (!isRecord(value)) return false;
  return (
    typeof value.tweet_id === "string" &&
    typeof value.tweet_url === "string" &&
    typeof value.author_handle === "string" &&
    typeof value.tweet_text === "string" &&
    typeof value.created_at === "string" &&
    isNonNegativeFiniteNumber(value.views) &&
    isNonNegativeFiniteNumber(value.likes) &&
    isNonNegativeFiniteNumber(value.retweets) &&
    isNonNegativeFiniteNumber(value.replies) &&
    isNonNegativeFiniteNumber(value.bookmarks)
  );
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
