/**
 * Minimal in-process event bus for SSE broadcasting.
 *
 * The daemon is single-process Fastify — no distributed pubsub needed.
 * We track a Set of subscriber callbacks (each closing over a response
 * stream) and fan out pre-formatted SSE frames on publish.
 *
 * Why callbacks, not response objects?
 *   Decouples the bus from the transport. Tests can subscribe with a
 *   plain array-push; the real route wraps stream.push. Event writers
 *   never need to know about HTTP.
 */

export interface CandidateAddedEvent {
  type: "candidate_added";
  tweet_id: string;
  author_handle: string;
  match_category: "selected" | "topic" | "trending";
}

/**
 * Extensible union — new event types should be added here and both
 * publish/subscribe sides kept in sync.
 */
export type DaemonEvent = CandidateAddedEvent;

export type EventSubscriber = (sseFrame: string) => void;

export class EventBus {
  private readonly subscribers = new Set<EventSubscriber>();

  subscribe(fn: EventSubscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  publish(event: DaemonEvent): void {
    // SSE frame: "data: <json>\n\n". Named events (event: foo) can
    // be added later; default ("message") is sufficient for now and
    // matches what EventSource's onmessage handler expects.
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const fn of this.subscribers) {
      try {
        fn(frame);
      } catch {
        // Best-effort. A thrown subscriber must not poison the loop.
      }
    }
  }

  count(): number {
    return this.subscribers.size;
  }
}
