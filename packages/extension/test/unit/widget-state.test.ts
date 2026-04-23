/**
 * Unit tests for `WidgetStateMachine` (CP07).
 *
 * The machine models the four states the Dock/Card widget cycles through:
 *     dock → expanding → card → collapsing → dock
 *
 * It is the **lock** that the spec's "mashing ⇱/⇲ rapidly does not leave
 * both states visible simultaneously" acceptance criterion relies on:
 * transitions from non-resting states are rejected and the caller skips
 * the DOM swap. All DOM work happens outside this module — these unit
 * tests therefore never touch the DOM and run under the default Node
 * environment for Vitest.
 *
 * Why an explicit state machine instead of a boolean flag?
 *   The four-state split (two resting + two animating) lets us assert
 *   "no double-mount during a transition" without racing the browser's
 *   transitionend event. A boolean "isAnimating" would not differentiate
 *   "animating toward card" from "animating toward dock", meaning a
 *   bouncing ⇱/⇲ sequence could dispatch an expand while a collapse is
 *   in flight — exactly the regression this machine prevents.
 */
import { describe, expect, it, vi } from "vitest";
import {
  WidgetStateMachine,
  type WidgetState,
} from "../../src/content/widget-state.js";

describe("WidgetStateMachine", () => {
  it("starts in the resting 'dock' state", () => {
    const sm = new WidgetStateMachine(() => {});
    expect(sm.current()).toBe<WidgetState>("dock");
  });

  describe("requestExpand()", () => {
    it("from 'dock' transitions to 'expanding' and returns true", () => {
      const sm = new WidgetStateMachine(() => {});
      expect(sm.requestExpand()).toBe(true);
      expect(sm.current()).toBe<WidgetState>("expanding");
    });

    it("from 'expanding' returns false and does not change state", () => {
      const sm = new WidgetStateMachine(() => {});
      sm.requestExpand();
      expect(sm.current()).toBe<WidgetState>("expanding");
      expect(sm.requestExpand()).toBe(false);
      expect(sm.current()).toBe<WidgetState>("expanding");
    });

    it("from 'card' returns false and does not change state", () => {
      const sm = new WidgetStateMachine(() => {});
      sm.requestExpand();
      sm.finishExpand();
      expect(sm.current()).toBe<WidgetState>("card");
      expect(sm.requestExpand()).toBe(false);
      expect(sm.current()).toBe<WidgetState>("card");
    });

    it("from 'collapsing' returns false and does not change state", () => {
      const sm = new WidgetStateMachine(() => {});
      sm.requestExpand();
      sm.finishExpand();
      sm.requestCollapse();
      expect(sm.current()).toBe<WidgetState>("collapsing");
      expect(sm.requestExpand()).toBe(false);
      expect(sm.current()).toBe<WidgetState>("collapsing");
    });
  });

  describe("finishExpand()", () => {
    it("from 'expanding' transitions to 'card'", () => {
      const sm = new WidgetStateMachine(() => {});
      sm.requestExpand();
      sm.finishExpand();
      expect(sm.current()).toBe<WidgetState>("card");
    });

    it("is a no-op when state is not 'expanding'", () => {
      const sm = new WidgetStateMachine(() => {});
      // dock → finishExpand should not jump to card.
      sm.finishExpand();
      expect(sm.current()).toBe<WidgetState>("dock");

      // card → finishExpand should not stay in card via a spurious
      // transition (the machine simply ignores it).
      sm.requestExpand();
      sm.finishExpand(); // → card
      sm.finishExpand(); // no-op
      expect(sm.current()).toBe<WidgetState>("card");
    });
  });

  describe("requestCollapse()", () => {
    it("from 'card' transitions to 'collapsing' and returns true", () => {
      const sm = new WidgetStateMachine(() => {});
      sm.requestExpand();
      sm.finishExpand();
      expect(sm.requestCollapse()).toBe(true);
      expect(sm.current()).toBe<WidgetState>("collapsing");
    });

    it("from 'collapsing' returns false and does not change state", () => {
      const sm = new WidgetStateMachine(() => {});
      sm.requestExpand();
      sm.finishExpand();
      sm.requestCollapse();
      expect(sm.requestCollapse()).toBe(false);
      expect(sm.current()).toBe<WidgetState>("collapsing");
    });

    it("from 'dock' returns false (nothing to collapse)", () => {
      const sm = new WidgetStateMachine(() => {});
      expect(sm.requestCollapse()).toBe(false);
      expect(sm.current()).toBe<WidgetState>("dock");
    });

    it("from 'expanding' returns false (no mid-animation flip)", () => {
      const sm = new WidgetStateMachine(() => {});
      sm.requestExpand();
      // This is the canonical "mashing" mid-transition case.
      expect(sm.requestCollapse()).toBe(false);
      expect(sm.current()).toBe<WidgetState>("expanding");
    });
  });

  describe("finishCollapse()", () => {
    it("from 'collapsing' transitions back to 'dock'", () => {
      const sm = new WidgetStateMachine(() => {});
      sm.requestExpand();
      sm.finishExpand();
      sm.requestCollapse();
      sm.finishCollapse();
      expect(sm.current()).toBe<WidgetState>("dock");
    });

    it("is a no-op when state is not 'collapsing'", () => {
      const sm = new WidgetStateMachine(() => {});
      sm.finishCollapse();
      expect(sm.current()).toBe<WidgetState>("dock");

      sm.requestExpand();
      sm.finishCollapse(); // expanding → no-op
      expect(sm.current()).toBe<WidgetState>("expanding");
    });
  });

  describe("onChange callback", () => {
    it("fires exactly once per real transition, with the new state", () => {
      const onChange = vi.fn<(s: WidgetState) => void>();
      const sm = new WidgetStateMachine(onChange);

      sm.requestExpand(); // dock → expanding
      sm.finishExpand(); // expanding → card
      sm.requestCollapse(); // card → collapsing
      sm.finishCollapse(); // collapsing → dock

      expect(onChange).toHaveBeenCalledTimes(4);
      expect(onChange.mock.calls.map((c) => c[0])).toEqual<WidgetState[]>([
        "expanding",
        "card",
        "collapsing",
        "dock",
      ]);
    });

    it("does not fire on rejected transitions", () => {
      const onChange = vi.fn<(s: WidgetState) => void>();
      const sm = new WidgetStateMachine(onChange);

      sm.requestExpand(); // 1 call (dock → expanding)
      sm.requestExpand(); // rejected
      sm.requestCollapse(); // rejected mid-expand
      sm.finishCollapse(); // rejected (not in 'collapsing')
      sm.finishExpand(); // 2 calls (expanding → card)

      expect(onChange).toHaveBeenCalledTimes(2);
      expect(onChange.mock.calls.map((c) => c[0])).toEqual<WidgetState[]>([
        "expanding",
        "card",
      ]);
    });
  });

  describe("rapid mashing simulation", () => {
    it("does not leave the machine in 'expanding' AND 'collapsing' at once", () => {
      // Mashing: expand, expand, collapse, expand, collapse. Every
      // transition request is logged; only the ones the machine accepts
      // change `current()`. After finishExpand + finishCollapse, the
      // machine must return to dock — never to a hybrid.
      const transitions: WidgetState[] = [];
      const sm = new WidgetStateMachine((s) => transitions.push(s));

      sm.requestExpand(); // accept → expanding
      sm.requestExpand(); // reject
      sm.requestCollapse(); // reject (still expanding)
      sm.requestExpand(); // reject
      sm.requestCollapse(); // reject
      sm.finishExpand(); // accept → card
      sm.requestCollapse(); // accept → collapsing
      sm.requestExpand(); // reject
      sm.requestCollapse(); // reject
      sm.finishCollapse(); // accept → dock

      expect(transitions).toEqual<WidgetState[]>([
        "expanding",
        "card",
        "collapsing",
        "dock",
      ]);
      expect(sm.current()).toBe<WidgetState>("dock");
    });
  });
});
