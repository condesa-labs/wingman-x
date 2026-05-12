/**
 * Shared `GET /candidates` fetch used by both popup (hot path, via the
 * worker port cache) and background (alarm-driven polling, uses the
 * same validated response contract).
 *
 * Throws on transport error, non-2xx, missing daemon identity header,
 * or shape mismatch — callers treat any throw as a stale-cache signal
 * and invalidate the port. This mirrors the popup's pre-extraction
 * behaviour so nothing regresses (review-loop f12, f13, f14).
 */
import {
  hasDaemonIdentityHeader,
  isDaemonCandidatesListResponse,
} from "./daemon-shape.js";

export interface RawCandidate {
  id: string;
  tweet_id: string;
  tweet_url: string;
  author_handle: string;
  tweet_text: string;
  suggested_reply: string;
  /**
   * Status is widened to string at the wire boundary so the daemon can
   * introduce new values without the extension requiring a coordinated
   * bump. The status filter logic lives in `./candidate-filter.ts`.
   */
  status: string;
}

interface CandidatesResponseBody {
  candidates: RawCandidate[];
}

export async function fetchCandidatesByPort(
  port: number,
): Promise<RawCandidate[]> {
  const res = await fetch(`http://127.0.0.1:${port}/candidates`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!hasDaemonIdentityHeader(res)) {
    throw new Error(
      `GET /candidates missing daemon identity header — cached port ${port} likely stale`,
    );
  }
  if (!res.ok) {
    throw new Error(`GET /candidates returned ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  if (!isDaemonCandidatesListResponse(body)) {
    throw new Error(
      `GET /candidates response shape mismatch — cached port ${port} likely stale`,
    );
  }
  return (body as CandidatesResponseBody).candidates;
}
