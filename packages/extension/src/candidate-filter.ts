/**
 * Single source of truth for "which candidates should the user still
 * see". Shared by the popup (list filter) and the background worker
 * (badge count) so the two never drift.
 *
 * A candidate is HIDDEN once the user has taken a terminal action on
 * it — `dismissed` (explicit rejection) or `filled` (reply text typed
 * into the X composer; the user may have edited/sent it, but from the
 * helper's perspective the work is done). Keeping a `filled` card in
 * the list after the user replied was confusing — spec-aligned fix.
 *
 * Non-terminal statuses (`pending`, `regen_requested`, `saved`) remain
 * visible: the user still has work to do on those, or the agent does.
 */

export const HIDDEN_STATUSES: ReadonlySet<string> = new Set([
  "dismissed",
  "filled",
]);

export function isActiveCandidate(candidate: { status: string }): boolean {
  return !HIDDEN_STATUSES.has(candidate.status);
}
