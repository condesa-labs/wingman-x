import { getPortFromWorker } from "../popup/daemon-client.js";
import { DAEMON_IDENTITY_HEADER } from "../daemon-shape.js";
import type { ObservedTweetInput } from "./viral-hook-extract.js";

const MESSAGE_TYPE = "TH_VIRAL_OBSERVED";
const DEBOUNCE_MS = 1000;
const MAX_BATCH_SIZE = 50;

let queued: ObservedTweetInput[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isViralMessage(event.data)) return;
  queued.push(...event.data.tweets);
  if (timer === null) {
    timer = setTimeout(() => void flush(), DEBOUNCE_MS);
  }
});

async function flush(): Promise<void> {
  timer = null;
  const batch = queued.slice(0, MAX_BATCH_SIZE);
  const dropped = Math.max(queued.length - MAX_BATCH_SIZE, 0);
  queued = [];
  if (dropped > 0) {
    console.info(`viral-bridge: batch capped at 50 — ${dropped} events dropped`);
  }
  if (batch.length === 0) return;

  const portResult = (await getPortFromWorker(1000)) as unknown;
  const port =
    typeof portResult === "number"
      ? portResult
      : typeof portResult === "object" &&
          portResult !== null &&
          typeof (portResult as { port?: unknown }).port === "number"
        ? (portResult as { port: number }).port
        : null;
  if (port === null) {
    console.warn("viral-bridge: daemon port unavailable");
    return;
  }

  try {
    const res = await fetch(`http://localhost:${port}/tweets/observed`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [DAEMON_IDENTITY_HEADER]: "required",
      },
      body: JSON.stringify({ tweets: batch }),
    });
    if (!res.ok || res.headers.get(DAEMON_IDENTITY_HEADER) === null) {
      console.warn(`viral-bridge: POST /tweets/observed failed (${res.status})`);
    }
  } catch (err) {
    console.warn(
      `viral-bridge: POST /tweets/observed failed (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
}

function isViralMessage(
  value: unknown,
): value is { type: typeof MESSAGE_TYPE; tweets: ObservedTweetInput[] } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { type?: unknown; tweets?: unknown };
  return v.type === MESSAGE_TYPE && Array.isArray(v.tweets);
}
