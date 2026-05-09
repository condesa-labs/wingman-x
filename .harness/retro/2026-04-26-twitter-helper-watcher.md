---
task_id: twitter-helper-watcher
task_title: "Twitter Helper — pull-signals plumbing, popup polish, signal watcher loop"
date: 2026-04-26
checkpoints_total: 6
checkpoints_passed_first_try: 6
total_eval_iterations: 6
total_commits: 10
reverts: 0
avg_iterations_per_checkpoint: 1.0
---

# Retro — twitter-helper-watcher

**Date**: 2026-04-26
**Task**: Twitter Helper — pull-signals plumbing, popup polish, signal watcher loop
**Branch**: `harness/twitter-helper-gh`
**Commits**: 10 | **Reverts**: 0 | **Final SHA**: `a7e909e`
**Eval iterations**: 6 (one per CP, all PASS first try) | **Findings**: 0 cross-model review-loop findings (review-loop not invoked this task — six small CPs)
**Full-verify**: `PASS_WITH_WARNINGS` (warnings are operational LLM-output quality, not correctness)
**PR**: [#3](https://github.com/stone16/twitter-chrome-extension/pull/3) opened

Second retro under this project's `.harness/retro/`. Cross-references the 2026-04-22 twitter-helper retro where patterns recur.

---

## Task Metrics

| Metric | Value |
|--------|-------|
| Checkpoints | 6 / 6 PASS on iter-1 (zero FAIL/REVIEW) |
| Total evaluator iterations | 6 (avg 1.0) |
| Commits | 10 (CP01: 1, CP02: 4 incl. justified out-of-band, CP03: 1, CP04: 1, CP05: 3 incl. orchestrator-fix, CP06: 0) |
| Reverts | 0 |
| Coverage (daemon) | 94.94% (above 85% gate) |
| Coverage (agent-kit) | 99.64% (well above gate) |
| Full-verify | PASS_WITH_WARNINGS — E2E pipeline ran end-to-end; 8/8 attempted drafts failed (3 timeout / 5 zod) |

---

## Observations

### Error Patterns Identified

#### Pattern 1: Script entry-points excluded from `npm run typecheck` — `[build: scripts-untyped]` — NEW

**Classification**: Project-level (host repo `tsconfig.json` `include` array) with retro-relevant generalization (any project that excludes `scripts/` from production tsc has the same blind spot).

**Frequency**: First observation. One concrete instance this task — but the structural cause (production-clean `tsconfig.json` excluding `scripts/`) is shared across all four workspaces in this monorepo and is the kind of thing that recurs silently until a script grows non-trivial logic.

**Evidence**: CP05 Generator's Green commit at `46f3af7` introduced `packages/agent-kit/scripts/watcher.ts` with a real bug at `scripts/watcher.ts:195` — `Type 'boolean' is not assignable to type 'void'` (a logger arrow returned `process.stdout.write`'s boolean through a `void` annotation). The `npm --workspace @twitter-helper/agent-kit run typecheck` script passed clean — because that workspace's `tsconfig.json` `include` is `["src/**/*.ts", "test/**/*.ts"]`. Caught only via a stale-LSP error that the orchestrator opted to verify with a direct `tsc scripts/watcher.ts` invocation. Fixed in `a7e909e`.

**Root cause**: the agent-kit (and likely other workspace) tsconfigs intentionally exclude `scripts/` so the production build artifact doesn't ship dev tooling. As a side effect, `npm run typecheck` is structurally blind to any code under `scripts/`. CP05 introduced the watcher entrypoint there — the testable core lives in `src/watcher-core.ts` (covered) but the launcher in `scripts/watcher.ts` is not in any tsc `include` set.

**Generalizes to**: this is a sibling pattern to 2026-04-22's `[build: bundler-contract-drift]` and `[e2e: stale-dist]` — all three are "the local checkpoint passed because the verification tool's scope did not include the file that broke." Type-graph-based scope (tsconfig include), bundler-graph-based scope (CONTENT_BUNDLE_ORDER), and runtime-artifact scope (stale dist/) all share the family pattern.

#### Pattern 2: LLM-output quality blind spot in fallback-PASS criterion — `[verify: fallback-masks-quality]` — NEW

**Classification**: Project-level (CP06 acceptance text) + skill-level observation (this is the kind of "loop-ran-but-world-had-nothing" PASS criterion that recurs in any task verifying a long-running consumer-of-events).

**Frequency**: First observation.

**Evidence**: CP06 PASSed under fallback path B per spec ("PASSes if watcher stdout shows EITHER `signal_added` reception OR an attempted draft (loop ran, world had nothing)"). Operationally this means the watcher loop fired correctly, but **0/8 drafts produced a candidate**: 3 timed out at the 60s default (`WATCHER_DRAFT_TIMEOUT_MS`) and 5 failed Zod validation. The user clicking "Request discovery" gets nothing visible despite the system being structurally healthy.

**Root cause**: the spec deliberately allows fallback-B because outcome A (a candidate appears) requires the LLM to produce shape-conformant output, which is non-deterministic. But the fallback PASS criterion conflates two failure modes:
- (a) "scraper found no fresh tweets" — genuinely "world had nothing"
- (b) "scraper found tweets, scheduler scheduled drafts, but every draft was malformed" — operational failure

Both pass the spec. (b) is the actual case here, and three concrete defects underlie it:

1. **Default `WATCHER_DRAFT_TIMEOUT_MS=60_000` is at the cold-start edge** — `claude --print` cold-start + 6kB system prompt + reasoning lands routinely in 50–65s. Three of eight attempts exhausted exactly 60s, suggesting genuine work was happening and was killed at the budget.

2. **`zod_issues` field is stringified to `[""]` on every Zod failure** — observability bug in `watcher-core.ts` `draftReply` error path. Without correct `path`/`message`/`code` from the Zod issue, we can't tell whether the model returned the wrong wrapper shape (claude `result`/`messages` envelope) or wrong field types or wrong field names.

3. **Pre-existing pending signals are not replayed on watcher startup** — the SSE `/events` endpoint only emits `signal_added` for new POSTs. Pending signals from a prior session are silently orphaned. Whether this is intended (signals ephemeral across watcher restarts) or a bug is a design ambiguity — the spec does not specify.

**Why this matters as a pattern**: when a verification CP's PASS criterion accepts "loop ran, even if every iteration produced nothing useful," the harness can ship a feature that is structurally correct but operationally broken. The CP06 evaluator correctly applied the spec; the spec correctly anticipated non-determinism. The gap is that fallback-B does not distinguish "scraper had nothing fresh" from "every draft died." A future iteration of the spec template for this kind of CP could require both (i) loop fired AND (ii) at least one of {happy-path success, scraper-empty-confirmed} — splitting case (a) from case (b).

#### Pattern 3: Justified out-of-band scope expansion at CP boundary — `[generator: scope-expansion-for-test-suite-unblock]` — NEW

**Classification**: Process-level (Generator scope discipline) — not a defect; this is **positive pattern documentation** that the harness handled correctly, worth recording for future Generators.

**Frequency**: First observation. One concrete instance this task (CP02 4th commit `3806160`).

**Evidence**: CP02 committed three pre-existing-work-curation commits per spec, then a fourth: `3806160 chore(daemon): align state.ts with signals schema`. Without it the daemon test suite would fail 9/64 — an unrelated `packages/daemon/src/state.ts` hunk in the working tree depended on schema fields the curation commits introduced. The CP02 evaluator approved the scope expansion.

**Pattern to recognize**: when a CP's pre-existing test suite fails because of incomplete code in the working tree (NOT the CP's authored code, but adjacent work in flight), the Generator should be empowered to add the minimal aligning fix to unblock the test gate — and document why in `output-summary.md`'s Rule Conflict Notes. Strict spec compliance ("don't touch files outside the path list") would have made the CP fail-by-construction with no useful diagnostic.

**Why log as positive**: the CP02 Generator's note ("daemon tests would FAIL 9/64 without `state.ts` change — minimal alignment hunk added with chore: prefix to keep curation chain visible") is exactly the right shape: name the conflict, state the choice, justify with an evidence trail. The evaluator approved. The history is reviewable. This is the rule-conflict protocol working as designed.

#### Pattern 4: Stale LSP diagnostics that diverge from real `tsc` — `[tooling: lsp-vs-tsc-divergence]` — NEW (observational)

**Classification**: Skill-level / tooling-level observation (not a project defect). Recurring at multiple points: post-CP03 popup.ts, post-CP05 watcher.test.ts had this manifest.

**Frequency**: First explicit retro observation; was implicitly present in 2026-04-22 task too but not logged. Promote to monitoring with explicit watch.

**Evidence**: CP05 post-Green LSP showed 11 errors. 10 were stale-cache false positives (cleared when `npm run typecheck` was run). 1 was real (the `scripts/watcher.ts:195` from Pattern 1). Orchestrator's correct decision: don't trust LSP diagnostics blindly — verify with `tsc` before acting.

**Root cause**: LSP diagnostic state can lag actual file state when a flurry of edits land or when typescript-language-server's incremental compile cache holds onto a previous error set. This is a known TypeScript ecosystem quirk; not a harness defect.

**Worth tracking because**: the orchestrator's mitigation ("verify LSP errors against `npm run typecheck` reality before fixing") is a learned skill. If the orchestrator ever trusts LSP blindly, false-positive churn results. Worth documenting once.

#### Pattern 5: Zero-iteration cybernetic loop on a 6-CP task — `[positive: front-loaded-planning]` — NEW (positive)

**Classification**: Positive pattern — every CP passed iter-1, no FAIL or REVIEW verdicts surfaced.

**Frequency**: First observation in this corpus. The 2026-04-22 task hit 9/10 first-try (one timeout-flake iter-2). This task hit 6/6 first-try.

**Evidence**: per-CP status table — all six checkpoints PASS on iter-1. Zero re-evaluations.

**Hypothesis**: either (a) the planning-phase rounds (3 spec-review iterations on this task per the CP02 history) front-loaded discovery and the spec was tight, or (b) the work was naturally well-scoped (curation-heavy CPs are mechanical; the watcher CP05 was Red-Green-Refactor canonical), or (c) sample size of two retros is too small to draw signal.

**Implication for retro corpus**: this is healthy data. Worth tracking the iter-1 PASS rate across the next 5-10 tasks to see if 6/6 is a fluke or a trend. If trend, consider whether the 1.0 avg-iterations metric suggests the harness is over-engineered for these task sizes (could a leaner cybernetic loop with only one CP-eval round work? — out of scope for this retro to answer).

---

### Rule Conflict Observations

**No in-task rule conflicts of the `[rules: default-vs-spec]` flavor.** Two `Rule Conflict Notes` were logged in per-CP `output-summary.md`:

- **CP01**: Frontmatter said `checkpoint_type: unknown`; body said `Type: infrastructure`. Generator followed the authoritative task prompt (infrastructure). FYI-only — Evaluator may want to normalize the frontmatter.
- **CP02 Conflict A**: `package.json` / `package-lock.json` (dotenv dep + launch-chrome script) belonged logically with Commit 2 of CP02 but the spec's per-commit path lists fenced them out. Generator chose strict spec compliance; both files left uncommitted in working tree.
- **CP02 Conflict B**: `state.ts` curation choice (Pattern 3 above) — alignment hunk landed as a chore: 4th commit with documented rationale.

All three are spec-interpretation choices, not rule conflicts. Generator correctly flagged the choice and documented rationale. Same shape as 2026-04-22's CP02/CP10 notes — pattern continuing to work as designed.

---

### What Worked Well

1. **Six-of-six iter-1 PASS over 10 commits.** Zero re-iterations. Avg 1.0 iters/CP.

2. **CP02 four-commit chain with documented out-of-band curation alignment.** Generator flagged the conflict, justified the chore-prefix 4th commit, evaluator approved. Rule-conflict protocol working as designed (positive sibling to 2026-04-22's positive-pattern observations).

3. **Coverage well above gate.** Daemon 94.94%, agent-kit 99.64% — both above the 85% threshold by ≥10pp. Reinforces the 2026-04-22 retro's positive observation of consistent test-discipline above bar.

4. **TDD discipline visible in CP05 Red→Green commits.** `d647567` (Red) landed with failing tests (`Failed to load url ../src/sse-parser.js`); `46f3af7` (Green) made them pass. Same pattern as 2026-04-22's per-CP test-first commits.

5. **CP05/CP06 split between `src/watcher-core.ts` (testable) and `scripts/watcher.ts` (I/O launcher) is honest.** Coverage stays meaningful (it's measuring real logic) and the launcher is a thin shim. The orchestrator-fix in `a7e909e` revealed the cost of this split (Pattern 1) but the architectural choice is still correct.

6. **CP06 fallback-B documented every seam.** Even though outcome A wasn't achieved, the seam-by-seam table in CP06 output-summary.md is the kind of evidence trail a future Evaluator can audit. The follow-ups (timeout, zod_issues, signal-replay) are pre-classified for issue-creation.

7. **No reverts. No revisions.** 10 commits forward. Same zero-revert pattern as 2026-04-22 (54 commits, 0 reverts).

---

## Recommendations

### Proposal 1: Add `tsconfig.scripts.json` and wire into `npm run typecheck` — `[build: scripts-untyped]`

- **Pattern**: `[build: scripts-untyped]`
- **Severity**: medium
- **Status**: Proposed
- **Root cause**: workspace tsconfigs intentionally exclude `scripts/` from production typecheck (so build artifact stays clean), but as a side effect `npm run typecheck` is blind to code in `scripts/`. CP05 introduced a real type bug at `scripts/watcher.ts:195` that the typecheck script missed; only stale-LSP + manual `tsc scripts/watcher.ts` caught it.
- **target_repo**: host (chrome-twitter-helper)
- **Drafted rule text** (addition to project-level `/Users/stometa/dev/chrome-twitter-helper/CLAUDE.md` under `## Project-Specific Invariants` or a new `## Verification` section):
  ```
  ### Script entry-points must be type-checked

  The workspace `tsconfig.json` `include` arrays exclude `scripts/` so the
  production build doesn't ship dev tooling. As a result, `npm run typecheck`
  in any workspace will NOT typecheck files under `packages/*/scripts/**/*.ts`.

  Each workspace that has `scripts/*.ts` files (currently `agent-kit`, future
  workspaces likely too) MUST maintain `packages/<workspace>/tsconfig.scripts.json`
  with `include: ["scripts/**/*.ts"]` and `extends: "./tsconfig.json"`. The
  workspace's `npm run typecheck` script MUST chain: `tsc -p tsconfig.json
  --noEmit && tsc -p tsconfig.scripts.json --noEmit`.

  Without this, type bugs in script entry-points (logger return types, env-var
  parsing, child-process spawn signatures) escape every CI gate and surface
  only at runtime when an operator runs `npm run watcher` (or similar).

  Verified failure mode: CP05 commit 46f3af7 introduced
  `process.stdout.write`-returns-boolean-through-void-annotation at
  `scripts/watcher.ts:195`. `npm --workspace @twitter-helper/agent-kit run
  typecheck` exited clean. Caught only by direct `tsc scripts/watcher.ts`.
  ```
- **Issue-ready**: true

### Proposal 2: Raise default `WATCHER_DRAFT_TIMEOUT_MS` to 90s — `[verify: fallback-masks-quality]` (sub-issue 1)

- **Pattern**: `[verify: fallback-masks-quality]`
- **Severity**: medium
- **Status**: Proposed
- **Root cause**: `DEFAULT_DRAFT_TIMEOUT_MS = 60_000` in `packages/agent-kit/scripts/watcher.ts` is at the edge of `claude --print` cold-start + 6kB system prompt + reasoning latency. Three of eight CP06 attempts exhausted exactly 60s. Production-realistic timeout is 90s.
- **target_repo**: host
- **Drafted rule text** (NOT a CLAUDE.md rule — this is a one-line code change tracked as an issue):
  ```
  packages/agent-kit/scripts/watcher.ts:
    -const DEFAULT_DRAFT_TIMEOUT_MS = 60_000;
    +const DEFAULT_DRAFT_TIMEOUT_MS = 90_000;

  Add CHANGELOG entry under "agent-kit" — "Watcher: raise default draft
  timeout from 60s to 90s to accommodate claude --print cold-start +
  large KB system prompt latency."

  Operators can still override via `WATCHER_DRAFT_TIMEOUT_MS` env var.
  ```
- **Issue-ready**: true

### Proposal 3: Fix `zod_issues` observability bug in `draftReply` error path — `[verify: fallback-masks-quality]` (sub-issue 2)

- **Pattern**: `[verify: fallback-masks-quality]`
- **Severity**: high (this is currently blocking diagnosis of the larger LLM-output-shape mismatch)
- **Status**: Proposed
- **Root cause**: in `packages/agent-kit/src/watcher-core.ts` the Zod-error logging path stringifies `error.issues` to `[""]` instead of the `[{path, message, code}, ...]` shape Zod actually emits. Without correct issue shape, an operator cannot tell whether the model returned the claude envelope (`{result, messages}`) instead of the bare Candidate JSON, OR returned a markdown-fenced block, OR a JSON object with the wrong field types — all three are common LLM failure modes with very different remediations.
- **target_repo**: host
- **Drafted rule text** (code-level fix, not a CLAUDE.md rule):
  ```
  In packages/agent-kit/src/watcher-core.ts draftReply error path:

  When zod parse fails, the structured log MUST include each ZodIssue's
  full shape:
    {
      event: "draft_failed",
      reason: "zod_validation",
      tweet_id,
      zod_issues: parseResult.error.issues.map(i => ({
        path: i.path,
        code: i.code,
        message: i.message,
        ...(i.expected !== undefined && { expected: i.expected }),
        ...(i.received !== undefined && { received: i.received }),
      })),
      elapsed_ms,
    }

  Add a unit test in watcher.test.ts that triggers a known zod failure
  (e.g. missing required field) and asserts the resulting log line's
  zod_issues array length matches the number of validation errors AND
  contains a non-empty `message` per element.
  ```
- **Issue-ready**: true

### Proposal 4: Resolve pre-existing pending-signal replay design ambiguity — `[verify: fallback-masks-quality]` (sub-issue 3)

- **Pattern**: `[verify: fallback-masks-quality]`
- **Severity**: medium
- **Status**: Proposed (design question, not a code bug per se)
- **Root cause**: the daemon's `/events` SSE endpoint only emits `signal_added` for new POSTs. Pending signals from a prior session (e.g. user clicked Request discovery, watcher was offline, signal sat pending) are never replayed when the watcher reconnects. Whether this is intentional (ephemeral across watcher restarts) or a defect is undocumented. CP06 hit this concretely: signal `09cb22b5...` from the prior session was orphaned.
- **target_repo**: host
- **Drafted rule text** (this is a brainstorm prompt, not a CLAUDE.md rule — the right artifact is a design decision in the daemon's contract docs):
  ```
  Open question requiring brainstorm + design decision (not a code patch
  yet):

  When a watcher process subscribes to GET /events, should the daemon:
    A. Stream only NEW signal_added events from connection time forward
       (current behaviour) — pending signals from prior watcher sessions
       are orphaned.
    B. On subscribe, replay all signals currently in `status="pending"`
       state, then continue with the live stream — guarantees no dropped
       signal across watcher restarts.
    C. Hybrid: client-driven — the watcher SHOULD GET /signals?status=pending
       on connect, drain those, then subscribe — keeps the SSE contract
       simple but moves the responsibility into the watcher.

  Recommend (C) for minimum change to the daemon contract and explicit
  semantics. Document the chosen behaviour in `packages/daemon/README.md`
  contract section AND in the watcher's startup banner ("draining N pending
  signals before subscribing to /events").

  Add a test in `packages/agent-kit/test/watcher.test.ts` that simulates
  the prior-session-pending case.
  ```
- **Issue-ready**: true

### Proposal 5: Carve out infrastructure-CP "pre-existing tests stand in for TDD" pattern in protocol — `[harness: infrastructure-cp-tdd-loophole]`

- **Pattern**: `[harness: infrastructure-cp-tdd-loophole]`
- **Severity**: low
- **Status**: Proposed
- **Root cause**: this task's CP01 (and CP02 partially) had `Type: infrastructure` because the work was curation of pre-existing code with pre-existing test coverage — no new authored code, hence no Red→Green TDD applies. The CP01 frontmatter even has `checkpoint_type: unknown` (mismatched with body `Type: infrastructure`). The protocol could explicitly carve out an infrastructure-curation CP type with TDD-N/A justified by "pre-existing test coverage validates the committed code." Currently this is implicit; making it explicit reduces ambiguity for future Generators and Evaluators.
- **target_repo**: harness (harness-engineering-skills protocol)
- **Drafted rule text** (addition to `protocol-quick-ref.md` under `### CP types` or equivalent section):
  ```
  ### Infrastructure-curation CP type

  When a CP's purpose is to land pre-existing-but-uncommitted work (working
  tree carries authored code from prior sessions; tests for that code are
  also in working tree or committed), the CP type SHOULD be `infrastructure`
  with explicit `tdd: N/A — pre-existing test coverage validates committed
  code` in the spec frontmatter or first paragraph.

  In this case:
  - The Red→Green discipline does not apply.
  - The Evaluator MUST verify pre-existing tests pass at HEAD post-commit
    (proves the curation didn't drop hunks).
  - The Generator MAY add minimal alignment commits (chore: prefix) for
    files outside the per-commit path list IF and ONLY IF the pre-existing
    test suite fails without them. Such alignment commits MUST be flagged
    in output-summary.md "Rule Conflict Notes" with rationale + diff stats.

  This carve-out is consistent with the project-level CP02 of the
  twitter-helper-watcher task (2026-04-26), where the daemon `state.ts`
  alignment hunk was added as a chore: 4th commit; daemon tests would
  have failed 9/64 without it.
  ```
- **Issue-ready**: true

### Proposal 6: Track LSP-vs-tsc divergence as monitoring-only — `[tooling: lsp-vs-tsc-divergence]`

- **Pattern**: `[tooling: lsp-vs-tsc-divergence]`
- **Severity**: low (observational — does not block correctness)
- **Status**: Monitoring (promote after one more concrete instance where blindly trusting LSP would have produced a real defect)
- **Root cause**: typescript-language-server LSP diagnostic state can lag actual file state when many edits land in quick succession, producing false-positive errors. The orchestrator's mitigation — verify LSP errors against `npm run typecheck` reality — is a learned skill, not a documented rule.
- **target_repo**: host (CLAUDE.md note) and possibly harness (orchestrator agent guidance)
- **Drafted rule text** (small note for `/Users/stometa/dev/chrome-twitter-helper/CLAUDE.md` under `## Verification`):
  ```
  ### LSP diagnostics are not authoritative

  When LSP shows TypeScript errors that don't match `npm run typecheck`
  output, run the workspace's `npm run typecheck` (and if needed `tsc -p
  tsconfig.scripts.json --noEmit`) before acting. LSP diagnostic state
  can lag actual file state, especially after a flurry of edits.

  Rule of thumb: tsc reality > LSP diagnostic. If they disagree, tsc
  wins.
  ```
- **Issue-ready**: false (Monitoring; promote after one more occurrence)

---

### Upgrade to Principle

None this task. Proposals 1 and 5 are good candidates for "principles" if they recur in the parent stometa-skillset corpus, but for now they are project-specific (Proposal 1) and harness-specific (Proposal 5).

### Rule Conflict Resolution

None to resolve this task. Three Rule Conflict Notes logged across CPs are all spec-interpretation choices documented per protocol — pattern continuing to work as designed.

### Skill / Tooling Defects

1. **Workspace `tsconfig.json` excludes `scripts/`** — `chrome-twitter-helper` host project, `packages/agent-kit/tsconfig.json` (and likely siblings).
   - **Evidence**: Pattern 1 above.
   - **Status**: **Actionable project-level defect**. See Proposal 1.
   - **Suggested remediation**: add `tsconfig.scripts.json` per workspace + chain into `npm run typecheck`.

2. **Default 60s draft timeout is too tight** — `packages/agent-kit/scripts/watcher.ts`.
   - **Evidence**: Pattern 2 above; Proposal 2.
   - **Status**: **Actionable project-level defect**.

3. **`zod_issues` observability bug in `draftReply` error path** — `packages/agent-kit/src/watcher-core.ts`.
   - **Evidence**: Pattern 2 above; Proposal 3.
   - **Status**: **Actionable project-level defect (high)**.

4. **Pending-signal replay design ambiguity** — daemon `/events` contract + watcher startup behaviour.
   - **Evidence**: Pattern 2 above; Proposal 4.
   - **Status**: **Actionable design question**.

5. **Harness protocol does not explicitly carve out infrastructure-curation CP type** — `protocol-quick-ref.md`.
   - **Evidence**: Pattern from CP01/CP02 plus 2026-04-22 corpus.
   - **Status**: **Actionable harness-skill enhancement**. See Proposal 5.

6. **LSP-vs-tsc divergence (observational)** — typescript-language-server, ecosystem-level.
   - **Evidence**: Pattern 4 above; multiple sub-occurrences in this run.
   - **Status**: **Monitoring**. See Proposal 6.

---

### Filed Issues (issue-ready summary)

The Orchestrator can auto-create GitHub issues for the following (Proposal status=Proposed, severity≥medium, Issue-ready=true):

| # | Title | Pattern | Severity | target_repo | Labels |
|---|-------|---------|----------|-------------|--------|
| 1 | Add tsconfig.scripts.json per workspace and wire into npm run typecheck | `[build: scripts-untyped]` | medium | host | `harness-retro`, `build`, `typescript` |
| 2 | Watcher: raise DEFAULT_DRAFT_TIMEOUT_MS from 60s to 90s | `[verify: fallback-masks-quality]` | medium | host | `harness-retro`, `agent-kit`, `bug` |
| 3 | watcher-core: fix zod_issues empty-array observability bug in draftReply error path | `[verify: fallback-masks-quality]` | high | host | `harness-retro`, `agent-kit`, `observability`, `bug` |
| 4 | Daemon /events: decide pending-signal replay semantics on subscribe | `[verify: fallback-masks-quality]` | medium | host | `harness-retro`, `daemon`, `design`, `discussion` |
| 5 | protocol-quick-ref: carve out infrastructure-curation CP type with TDD-N/A explicit | `[harness: infrastructure-cp-tdd-loophole]` | low (but Proposed; promote to medium if it recurs) | harness | `harness-retro`, `protocol`, `enhancement` |

Note: PR #3 has been opened against the host repo; these issues should be filed there for items 1-4 and against the harness-engineering-skills repo for item 5.

---

## Summary (for index.md)

Six checkpoints, six iter-1 PASS, zero re-iterations, 10 commits, zero reverts. CP06 PASSed under fallback-B (loop ran end-to-end, but 8/8 attempted drafts failed: 3 timeout / 5 zod-validation). Top patterns: `[build: scripts-untyped]` (new, medium) — `tsconfig.json` excludes `scripts/` so `npm run typecheck` is blind to script entry-points; CP05 introduced a real type bug at `scripts/watcher.ts:195` that escaped this gate. `[verify: fallback-masks-quality]` (new, high overall — three sub-issues: timeout, zod_issues observability, pending-signal replay) — CP06's "loop-ran-but-world-had-nothing" PASS criterion accepted "scraper found tweets, all 8 drafts died" as PASS, masking three real product defects. `[generator: scope-expansion-for-test-suite-unblock]` (new, positive) — CP02 4th commit `3806160` was a documented out-of-band alignment hunk; rule-conflict protocol worked as designed. Five concrete issue-ready proposals drafted, four target host repo, one targets harness protocol.
