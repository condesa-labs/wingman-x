import { describe, expect, it } from "vitest";
import {
  DISCOVERY_STATUS,
  computeDiscoveryOutcome,
  formatDiscoverySuccess,
  statusTestidForButton,
} from "../../src/popup/discovery-status.js";

describe("computeDiscoveryOutcome", () => {
  // A fixed clock so success messages are deterministic across the
  // test run (toLocaleTimeString depends on locale, but with a fixed
  // Date the *shape* is stable: the function just embeds whatever
  // the runtime produces).
  const fixedNow = new Date("2026-04-26T13:45:30Z");

  it("returns noPort when port is null and does NOT hold the button disabled", () => {
    const outcome = computeDiscoveryOutcome(null, true, fixedNow);
    expect(outcome.status).toBe(DISCOVERY_STATUS.noPort);
    expect(outcome.shouldHoldDisabled).toBe(false);
  });

  it("returns noPort when posted is null even if port is set", () => {
    // Defensive: if the caller didn't actually POST (because the port
    // disappeared mid-click), we treat that the same as null port.
    const outcome = computeDiscoveryOutcome(53827, null, fixedNow);
    expect(outcome.status).toBe(DISCOVERY_STATUS.noPort);
    expect(outcome.shouldHoldDisabled).toBe(false);
  });

  it("returns failed status + holds disabled when POST returned !ok", () => {
    const outcome = computeDiscoveryOutcome(53827, false, fixedNow);
    expect(outcome.status).toBe(DISCOVERY_STATUS.failed);
    expect(outcome.shouldHoldDisabled).toBe(true);
  });

  it("returns success status + holds disabled when POST returned ok", () => {
    const outcome = computeDiscoveryOutcome(53827, true, fixedNow);
    // The exact time string is locale-dependent; assert the structural
    // pieces instead so the test passes on every CI locale.
    expect(outcome.status).toMatch(/^Requested at .+ — agent will pick up/);
    expect(outcome.shouldHoldDisabled).toBe(true);
  });
});

describe("formatDiscoverySuccess", () => {
  it("embeds the locale time string of the given Date", () => {
    const now = new Date("2026-04-26T13:45:30Z");
    const out = formatDiscoverySuccess(now);
    // Assert prefix + suffix; the middle is locale-dependent.
    expect(out.startsWith("Requested at ")).toBe(true);
    expect(out.endsWith(" — agent will pick up on next run.")).toBe(true);
  });
});

describe("statusTestidForButton", () => {
  it("maps the empty-state button to its sibling status div", () => {
    expect(statusTestidForButton("twh-request-discovery-empty")).toBe(
      "twh-request-status-empty",
    );
  });

  it("maps the list-state button to its sibling status div", () => {
    expect(statusTestidForButton("twh-request-discovery-list")).toBe(
      "twh-request-status-list",
    );
  });

  it("returns null for an unrelated testid so callers can fail-soft", () => {
    expect(statusTestidForButton("twh-popup-retry")).toBeNull();
    expect(statusTestidForButton("")).toBeNull();
    expect(statusTestidForButton("twh-request-discovery-")).toBeNull();
  });
});
