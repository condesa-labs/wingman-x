/**
 * Pure helpers for the popup's "Request discovery" UX state.
 *
 * Extracted so the click outcomes (text + disabled flag) can be unit-
 * tested in a Node environment without spinning up a DOM. The actual
 * button + status-div wiring still lives in popup.ts; this module only
 * computes what the UI should show.
 */

/**
 * Stable status strings — exported so tests can assert exact equality
 * and so the message taxonomy lives in one place.
 */
export const DISCOVERY_STATUS = {
  /** Shown briefly between click and POST resolution. */
  inFlight: "Requesting…",
  /** Shown when the click fires before runFlow() resolved a port. */
  noPort: "No daemon connection.",
  /** Shown after a non-2xx or transport failure. */
  failed: "Request failed — check daemon log.",
} as const;

export interface DiscoveryClickOutcome {
  status: string;
  /** Whether the button should be left disabled (cooldown applies only when this is true). */
  shouldHoldDisabled: boolean;
}

/**
 * Format the success status — kept here so tests can stub the clock.
 * The Date is injected so tests don't depend on Date.now / locale.
 */
export function formatDiscoverySuccess(now: Date): string {
  return `Requested at ${now.toLocaleTimeString()} — agent will pick up on next run.`;
}

/**
 * Compute the outcome of a discovery-request click given resolved
 * inputs. Pure: same args → same result.
 *
 * `posted` semantics:
 *   - `true`  → daemon returned 2xx
 *   - `false` → daemon returned non-2xx OR transport error
 *   - `null`  → POST was not attempted because `port` was null
 */
export function computeDiscoveryOutcome(
  port: number | null,
  posted: boolean | null,
  now: Date,
): DiscoveryClickOutcome {
  if (port === null || posted === null) {
    return { status: DISCOVERY_STATUS.noPort, shouldHoldDisabled: false };
  }
  if (posted) {
    return {
      status: formatDiscoverySuccess(now),
      shouldHoldDisabled: true,
    };
  }
  return { status: DISCOVERY_STATUS.failed, shouldHoldDisabled: true };
}

/**
 * Map a discovery-trigger button's testid to its status div's testid.
 *
 *   twh-request-discovery-empty → twh-request-status-empty
 *   twh-request-discovery-list  → twh-request-status-list
 *
 * Returns null for testids that don't match the expected pattern, so
 * the caller can fail soft instead of mis-targeting some unrelated
 * element.
 */
export function statusTestidForButton(buttonTestid: string): string | null {
  const m = buttonTestid.match(/^twh-request-discovery-(empty|list)$/);
  return m ? `twh-request-status-${m[1]}` : null;
}
