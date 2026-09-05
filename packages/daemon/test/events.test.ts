import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { EventBus } from "../src/events.js";
import { sampleCandidate, setupTempStateDir } from "./helpers/tmpState.js";

describe("EventBus", () => {
  it("fans out published frames to every subscriber", () => {
    const bus = new EventBus();
    const a: string[] = [];
    const b: string[] = [];
    bus.subscribe((f) => a.push(f));
    bus.subscribe((f) => b.push(f));

    bus.publish({
      type: "candidate_added",
      tweet_id: "1",
      author_handle: "@x",
      match_category: "topic",
    });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toBe(
      'data: {"type":"candidate_added","tweet_id":"1","author_handle":"@x","match_category":"topic"}\n\n',
    );
    expect(bus.count()).toBe(2);
  });

  it("serialises candidate_updated frames", () => {
    const bus = new EventBus();
    const got: string[] = [];
    bus.subscribe((f) => got.push(f));
    bus.publish({ type: "candidate_updated", id: "chime-1", tweet_id: "1", status: "regen_requested", reason: "action" });
    expect(got[0]).toBe(
      'data: {"type":"candidate_updated","id":"chime-1","tweet_id":"1","status":"regen_requested","reason":"action"}\n\n',
    );
  });

  it("stops delivering to an unsubscribed callback", () => {
    const bus = new EventBus();
    const received: string[] = [];
    const off = bus.subscribe((f) => received.push(f));
    off();
    bus.publish({
      type: "candidate_added",
      tweet_id: "1",
      author_handle: "@x",
      match_category: "topic",
    });
    expect(received).toHaveLength(0);
    expect(bus.count()).toBe(0);
  });

  it("isolates a throwing subscriber so siblings still receive", () => {
    const bus = new EventBus();
    const received: string[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((f) => received.push(f));
    bus.publish({
      type: "candidate_added",
      tweet_id: "1",
      author_handle: "@x",
      match_category: "topic",
    });
    expect(received).toHaveLength(1);
  });
});

describe("GET /events (SSE) + POST /candidates integration", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  let ctx: ReturnType<typeof setupTempStateDir>;
  let baseUrl: string;

  beforeEach(async () => {
    ctx = setupTempStateDir();
    app = await buildServer();
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = address;
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    ctx.cleanup();
  });

  it("streams candidate_added frames on POST /candidates", async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/events`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Read one chunk — the initial ":ok\n\n" comment — to confirm open.
    const firstRead = (await Promise.race([
      reader.read(),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("open timeout")), 2000),
      ),
    ])) as { value?: Uint8Array; done: boolean };
    expect(decoder.decode(firstRead.value!)).toContain(":ok");

    // Now POST a candidate via inject and collect the next event frame.
    const framePromise = (async () => {
      let acc = "";
      while (!acc.includes('"candidate_added"')) {
        const { value, done } = (await Promise.race([
          reader.read(),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("event timeout")), 3000),
          ),
        ])) as { value?: Uint8Array; done: boolean };
        if (done) break;
        acc += decoder.decode(value!);
      }
      return acc;
    })();

    const postRes = await app!.inject({
      method: "POST",
      url: "/candidates",
      payload: { candidates: [sampleCandidate()] },
    });
    expect(postRes.statusCode).toBe(200);

    const frame = await framePromise;
    expect(frame).toMatch(/data:\s*{/);
    expect(frame).toContain('"type":"candidate_added"');
    expect(frame).toContain('"tweet_id":"1790000000000000001"');

    controller.abort();
    await reader.cancel().catch(() => {});
  });

  it("does not re-publish on re-POST of an existing tweet_id", async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/events`, {
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    // Consume the ":ok" opener.
    await reader.read();

    // First POST — triggers candidate_added.
    await app!.inject({
      method: "POST",
      url: "/candidates",
      payload: { candidates: [sampleCandidate()] },
    });

    // Wait for the event to arrive.
    let got = "";
    while (!got.includes("candidate_added")) {
      const { value, done } = await reader.read();
      if (done) break;
      got += decoder.decode(value!);
    }
    expect(got).toContain("candidate_added");

    // Second POST — same tweet_id, different suggested_reply.
    // Should NOT trigger another candidate_added (it's a redraft, not
    // a new candidate the user hasn't seen).
    const redraft = sampleCandidate();
    redraft.suggested_reply = "revised text";
    await app!.inject({
      method: "POST",
      url: "/candidates",
      payload: { candidates: [redraft] },
    });

    // Race: 800ms window. Any further data frame (not a ":heartbeat"
    // comment) would be a spurious re-publish.
    let postRedraft = "";
    const timeoutAt = Date.now() + 800;
    while (Date.now() < timeoutAt) {
      const readPromise = reader.read();
      const timer = new Promise<{ value?: Uint8Array; done: boolean }>((r) =>
        setTimeout(() => r({ value: undefined, done: false }), 200),
      );
      const { value, done } = (await Promise.race([
        readPromise,
        timer,
      ])) as { value?: Uint8Array; done: boolean };
      if (done) break;
      if (value) postRedraft += decoder.decode(value);
    }
    expect(postRedraft).not.toContain("candidate_added");

    controller.abort();
    await reader.cancel().catch(() => {});
  });
});
