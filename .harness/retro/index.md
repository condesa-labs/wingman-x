# Retro Index — chrome-twitter-helper

Last updated: 2026-05-25

Retros tracked: 2026-04-22 twitter-helper, 2026-04-26 twitter-helper-watcher, 2026-05-09 twitter-helper-viral-pool, 2026-05-25 wingmanx-kb-contract-v1.

---

## Frequency Table

Tracks error pattern frequency across tasks in **this project**. Patterns with 3+ occurrences in the last 10 tasks escalate to draft rules.

| Pattern Tag | Description | Occurrences (last 10 tasks) | Total Findings | Trend | Status |
|-------------|-------------|:---------------------------:|:--------------:|-------|--------|
| build: bundler-contract-drift | Hand-rolled bundler (CONTENT_BUNDLE_ORDER) misses imports added from outside the bundler's known file set; `tsc` + vitest blind because they operate on module graph, not bundler output | 1 (2026-04-22) | 1 | Honored in 2026-05-09 spec; zero recurrence | **Proposed** (active rule; severity high; reinforced) |
| e2e: stale-dist | Extension's `test:e2e` script loads `dist/` without re-building; intermediate E2E runs pass against stale `dist/` producing false confidence; only fresh build catches runtime regressions | 1 (2026-04-22) | 1 | Honored in 2026-05-09 spec; zero recurrence | **Proposed** (active rule; severity high; reinforced) |
| review-loop: asymptote | Multiple consecutive Phase 3 passes iterate on narrow fixes before the architectural reframe emerges; review-loop converges but could be faster with theme coalescing | 1 (2026-04-22) | 3 (f12 + f13 + f14) | No recurrence in 2026-04-26 or 2026-05-09 | Monitoring (promote on one more observation) |
| engine: invocation-vs-config-precedence | `.harness/config.json` auto-default `cross_model_review: false` risks silent skip of review-loop when user instruction is less explicit | 1 (2026-04-22) | 1 (near-miss) | No recurrence | Monitoring (promote on one concrete skip-regret) |
| project: test-pyramid | Claiming "done" after tsc + unit tests, without the full build + E2E layer, produces false confidence on any change affecting the content-script bundler or popup flattened imports | 1 (2026-04-22) | 1 | Honored in 2026-05-09 spec; zero recurrence | Proposed (active rule; preventative) |
| build: scripts-untyped | `agent-kit/scripts/*.ts` excluded from `npm run typecheck`; CP05 type bug at `scripts/watcher.ts:195` escaped this gate | 1 (2026-04-26) | 1 | Honored in 2026-05-09 spec via runtime-smoke deferral; structural fix still pending | **Proposed** (severity medium; structural fix deferred) |
| verify: fallback-masks-quality | "Loop ran end-to-end, all 8 drafts died" PASSed because verifier accepted "scraper found tweets" rather than "tweets actually drafted"; three sub-issues (timeout, zod_issues observability, pending-signal replay) | 1 (2026-04-26) | 3 sub-issues | No recurrence in 2026-05-09; viral pool wiring smokes assert end-state, not intermediate handles | **Proposed** (severity high) |
| generator: scope-expansion-for-test-suite-unblock | CP02 4th commit was a documented out-of-band alignment hunk; rule-conflict protocol worked as designed | 1 (2026-04-26) | 1 (positive) | Re-observed in 2026-05-09 CP03 (vitest discovery convention beats spec test path) | Positive pattern; reinforce |
| spec: ambiguous-counting-semantic | Acceptance criteria declaring a cap/limit invariant ("hard cap on N") leave the quantifier under-specified; Evaluator surfaces stricter readings each iteration | 1 (2026-05-09) | 1 (CP06 4-iter ratchet) | NEW | **Proposed** (severity high; first observation but high-cost — 3 wasted iterations) |
| evidence: artifact-shape-mismatch | Generator captures a credible *proxy* (POST body, fixture page) instead of the *named artifact* (state.json, popup) — implementation is correct, evidence shape is wrong | 1 (2026-05-09) | 1 (CP04 iter-1) | NEW | **Proposed** (severity medium) |
| spec: artifact-path-overload | Same artifact path named by two distinct contracts in the same spec (e.g. SC1 + CP07 acceptance #8 both target `docs/manual-qa/<date>-viral-pool.png`); related to existing protocol pattern `cross-CP artifact ownership conflict` but extends it to SC↔CP collisions | 1 (2026-05-09) | 1 (zero iter cost — user-deferred) | NEW | **Proposed** (severity medium; structural risk) |
| host: build-bumps-package-json | `npm run build` runs `npm run bump:patch` first, modifying 5 `package.json` files; intentional but undocumented in CLAUDE.md, risk of future Generator "fixing" the dirty tree | 2 (2026-05-09, 2026-05-25) | 2 (handled correctly by full-verify both times) | Reinforced — 2026-05-25 spec adopted `build:no-bump` as binding SC#2 | **Proposed** (severity low→med; CLAUDE.md note still pending for non-harness use) |
| harness: evaluator-session-id-handoff-race | Evaluator writes `evaluator_session_id` into evaluation.md frontmatter before the wrapper writes the canonical `evaluator-session-id.txt` (written post-completion); forces an orchestrator same-session LLM resume repair | 1 (2026-05-25; 2× in-task: CP08 iter-2 + CP09 iter-1) | 2 | NEW (first formal capture; orchestrator reports prior-handoff recurrence) | **Proposed** (severity medium; issue-ready harness) |
| spec: coverage-criterion-scope-underspecified | A per-file coverage criterion omits the lines/stmts/funcs/branches enumeration its siblings carry and/or scopes to a function-subset vs whole-file, creating a strict-vs-lenient reading split (CP09 `migrate-core.ts` branch 80%) | 1 (2026-05-25) | 1 (zero iter cost — both evaluators read lenient + documented strict) | NEW; same family as `spec: ambiguous-counting-semantic` (2026-05-09) | **Proposed** (severity medium; latent FAIL-risk on correct code) |
| harness: shared-gate-flake-escalation | A checkpoint's required shared test gate is broken by a pre-existing defect in peer-owned code it didn't introduce; no first-class verdict exists, so the evaluator encodes it via REVIEW + `requires_human_judgment` | 1 (2026-05-25 CP08) | 1 (escalation worked; auto_resolvable:false correctly blocked cross-CP scope expansion) | NEW | Monitoring (promote on recurrence) |

---

## Pending Rule Proposals

| Proposal | Pattern | Status | Issue-ready | Target |
|----------|---------|--------|-------------|--------|
| Manifest-Aware Generator Scan for Hand-Rolled Bundlers | build: bundler-contract-drift | **Proposed** (carry-over) | true | host (CLAUDE.md invariant) |
| Force Fresh Build Before E2E in Extension Workspace | e2e: stale-dist | **Proposed** (carry-over) | true | host (`pretest:e2e` hook) |
| CLAUDE.md Test-Pyramid Completeness Statement | project: test-pyramid | **Proposed** (carry-over) | true | host |
| `tsconfig.scripts.json` to wire scripts/ into typecheck | build: scripts-untyped | **Proposed** (from 2026-04-26) | true | host |
| Raise default `WATCHER_DRAFT_TIMEOUT_MS` to 90s | verify: fallback-masks-quality (sub 1) | **Proposed** (from 2026-04-26) | true | host |
| Fix `zod_issues` observability in `draftReply` error path | verify: fallback-masks-quality (sub 2) | **Proposed** (from 2026-04-26) | true | host |
| Resolve pre-existing pending-signal replay design ambiguity | verify: fallback-masks-quality (sub 3) | **Proposed** (from 2026-04-26) | true | host |
| Carve out infrastructure-CP "pre-existing tests stand in for TDD" pattern in protocol | harness: infrastructure-cp-tdd-loophole | **Proposed** (from 2026-04-26) | true | harness |
| Spec Evaluator pre-execution warning for ambiguous quantifier on cap/limit invariants | spec: ambiguous-counting-semantic | **Proposed** (NEW 2026-05-09) | true | harness |
| Generator/Evaluator discipline rule on evidence-artifact shape | evidence: artifact-shape-mismatch | **Proposed** (NEW 2026-05-09) | true | harness |
| Extend Spec Evaluator `cross-CP artifact ownership conflict` to cover SC↔CP path conflicts | spec: artifact-path-overload | **Proposed** (NEW 2026-05-09) | true | harness |
| Host CLAUDE.md note on intentional `npm run build` version bump | host: build-bumps-package-json | **Proposed** (2026-05-09; reinforced 2026-05-25) | true | host |
| Deterministic wrapper-side `evaluator_session_id` stamp (kill the LLM resume repair) | harness: evaluator-session-id-handoff-race | **Proposed** (NEW 2026-05-25) | true | harness |
| Spec-Evaluator coverage-criterion dimension/scope lint | spec: coverage-criterion-scope-underspecified | **Proposed** (NEW 2026-05-25; filed #57) | true | harness |
| Formalize a `BLOCKED_BY_PEER_GATE` evaluator sub-verdict for pre-existing shared-gate defects | harness: shared-gate-flake-escalation | Monitoring (NEW 2026-05-25) | false | (harness) |
| `migrate-core.ts` negative-path tests to reach ≥85 branch (follow-on hygiene) | spec: coverage-criterion-scope-underspecified (host side) | Monitoring (NEW 2026-05-25) | false | (host) |
| Track LSP-vs-tsc divergence | tooling: lsp-vs-tsc-divergence | Monitoring (from 2026-04-26) | false | (n/a) |
| Review-Loop Theme Coalescing Heuristic | review-loop: asymptote | Monitoring (from 2026-04-22) | false | (n/a) |
| Prompt on Skip When Config Declines Review-Loop | engine: invocation-vs-config-precedence | Monitoring (from 2026-04-22) | false | (n/a) |
| Validate spec-named test paths against host vitest `include` glob | (project: test-discovery-convention-drift) | Monitoring (NEW 2026-05-09) | false | (n/a) |

---

## Positive Patterns (Reinforce)

| Pattern | Description | Occurrences |
|---------|-------------|:-----------:|
| Zero-revert workflow | 29 commits / 11 iters / 9 CPs (2026-05-25); 28 commits / 11 iters / 7 CPs (2026-05-09); 10 commits / 6 CPs (2026-04-26); 54 commits / 10 CPs (2026-04-22) | 4 |
| Cross-model review-loop as structural necessity | Codex peer caught critical persistence-invariant violation in 2026-04-22; ran clean in 2026-04-26 and 2026-05-09; skipped by config in 2026-05-25 with no concrete harm found (monitoring) | 3 |
| Full-verify mandatory fresh build | Caught 2026-04-22 bundler regression; classified 2026-05-09 version bump as soft warning; used `build:no-bump` correctly in 2026-05-25 (clean `git status`) | 3 |
| `auto_resolvable:false` correctly blocks autonomous cross-CP scope expansion | 2026-05-25 CP08 iter-1 refused to auto-edit CP07-owned test code to fix a pre-existing flake; routed to human approval | 1 |
| Magnitude Size Waiver (Outcome A) prevents false-positive scope flag | 2026-05-25 CP09 551-ins overrun → goal-relevance audit → PASS with `magnitude_advisory:true`, every file mapped to scope | 1 |
| Atomic-publish / single-source-of-truth in one-shot scripts | 2026-05-25 CP09 migration builds full plan in memory before any temp dir; sibling-tmp + `rename`; shared `serializeHandles` not a bespoke writer | 1 |
| Contract-as-sole-shape-authority across checkpoints | 2026-05-25 CP02 contract is the single Zod authority; 8 traced E2E flows, zero schema forks, compile+runtime enforcement | 1 |
| Carry-over retro→spec→generator loop closes | 2026-04-22 patterns cited in 2026-05-09 spec, honored with zero recurrence; 2026-05-09 `build:no-bump` finding became binding SC#2 in the 2026-05-25 spec, honored by full-verify | 2 |
| Harness handshake on user-accepted manual deferral | 2026-05-09 SC1 deferral propagated cleanly through E2E iter-2 → full-verify → PR body without losing the obligation | 1 |
| Cold-start migration smoke as fault-path probe | 2026-05-09 CP07 boots daemon against pre-CP01 state.json to exercise schema `.default({})` defense in integration | 1 |
| Cross-CP lifecycle-split language in spec | 2026-05-09 CP03/CP04 partitioned `MAIN_WORLD_BUNDLE_ORDER` vs `CONTENT_BUNDLE_ORDER` ownership; zero drift events | 1 |
| Rule-conflict protocol working as designed | 2026-04-26 CP02 out-of-band alignment hunk; 2026-05-09 CP03 vitest discovery convention beats spec test path; 2026-05-25 CP08 surfaced peer-ownership vs shared-gate conflict for human approval (no silent blend) | 3 |
| Wiring matrix with file:line + mock-boundary discipline | 2026-05-09 CP07 caller-to-primitive matrix re-verifiable by Tier 2 reviewer via direct code reading | 1 |
| TDD commit pattern with per-checkpoint test-first | Red-green-refactor commits visible across all three retros | 3 |
| Evidence files point directly at the fix | 2026-04-22 evaluator's `content-bundle-diagnosis.txt` provided exact diagnosis; 2026-05-09 evaluator iter-1 evidence on CP04 named the exact shape mismatch | 2 |

---

## Skill Defect Watch

| Observation | Skill | Status | Source |
|-------------|-------|--------|--------|
| `validate-transition` CLI reports stale phase label (cosmetic, misleading) | harness-engine | **Actionable defect** | 2026-04-22 retro |
| `.harness/config.json` auto-default `cross_model_review: false` risks silent review-loop skip | harness-engine | **Observation** → actionable on next occurrence | 2026-04-22 retro |
| Review-loop Phase 3 lacks theme-coalescing heuristic between narrow-fix passes | review-loop | **Observation** → actionable on next occurrence | 2026-04-22 retro |
| `packages/extension/package.json` has no `pretest:e2e: "npm run build"` hook | project (not harness) | **Actionable project-level defect** | 2026-04-22 retro |
| `agent-kit/tsconfig.json` excludes `scripts/` from `npm run typecheck`; structural fix deferred | project (not harness) | **Actionable project-level defect** | 2026-04-26 retro |
| Spec Evaluator does not warn on ambiguous quantifier semantics on cap/limit invariants | harness-spec-evaluator | **Actionable defect** (high — caused 3 wasted iterations) | 2026-05-09 retro |
| Spec Evaluator's `cross-CP artifact ownership conflict` warning does not cover SC↔CP path collisions | harness-spec-evaluator | **Actionable defect** (medium — structural risk) | 2026-05-09 retro |
| Host CLAUDE.md missing note on intentional `npm run build` version bump | project (not harness) | **Actionable project-level defect** (reinforced; spec mitigates via `build:no-bump`, CLAUDE.md note still pending) | 2026-05-09 retro |
| Evaluator must self-author `evaluator_session_id` before the wrapper's proof file exists → forces an LLM same-session resume repair (CP08 iter-2, CP09 iter-1) | harness-engine (evaluator wrapper / orchestrator handoff) | **Actionable defect** (medium — recurring; deterministic stamp would remove the repair pass) | 2026-05-25 retro |
| Spec Evaluator does not flag per-file coverage criteria that diverge in dimension enumeration or scope (whole-file vs function-subset) from sibling criteria | harness-spec-evaluator | **Actionable defect** (medium — latent FAIL-risk; filed #57; related to closed ambiguous-quantifier issue #44) | 2026-05-25 retro |
| No first-class evaluator verdict for "shared gate broken by pre-existing peer-owned defect"; encoded via REVIEW + requires_human_judgment | harness-engine (verdict taxonomy) | **Observation** → actionable on recurrence (escalation currently works correctly) | 2026-05-25 retro |

---

## Retro History

| Date | Task ID | Retro File | CPs | First-pass | Avg Iter | Reverts | Key Signal |
|------|---------|------------|-----|-----------|----------|---------|------------|
| 2026-04-22 | twitter-helper | [retro](2026-04-22-twitter-helper.md) | 10 | n/a | n/a | 0 | `[build: bundler-contract-drift]` (new, high, caused iter-1 full-verify fail); `[e2e: stale-dist]` (new, high); review-loop asymptote; 14 findings all resolved |
| 2026-04-26 | twitter-helper-watcher | [retro](2026-04-26-twitter-helper-watcher.md) | 6 | 6 | 1.0 | 0 | `[build: scripts-untyped]` (new, medium); `[verify: fallback-masks-quality]` (new, high — three sub-issues); 5 issue-ready proposals |
| 2026-05-09 | twitter-helper-viral-pool | [retro](2026-05-09-twitter-helper-viral-pool.md) | 7 | 5 | 1.57 | 0 | `[spec: ambiguous-counting-semantic]` (new, high — CP06 4-iter ratchet); `[evidence: artifact-shape-mismatch]` (new, medium); `[spec: artifact-path-overload]` (new, medium); carry-over rules from 2026-04-22/26 honored; user-accepted manual deferral propagated cleanly |
| 2026-05-25 | wingmanx-kb-contract-v1 | [retro](2026-05-25-wingmanx-kb-contract-v1.md) | 9 | 7 | 1.2 | 0 | `[harness: evaluator-session-id-handoff-race]` (new, medium — 2× in-task, issue-ready); `[spec: coverage-criterion-scope-underspecified]` (new, medium — `migrate-core.ts` branch 80%, zero iter cost); CP08 `auto_resolvable:false` correctly blocked cross-CP scope expansion (positive); `build:no-bump` carry-over honored as binding SC#2; cross-model review skipped by config with no harm |

---

## Notes

- Both repos now have GitHub remotes — host repo `stone16/twitter-chrome-extension`, harness target `stone16/harness-engineering-skills`. Issue-ready proposals can be auto-filed by the Orchestrator per the §issue-routing protocol.
- Retro protocol reference: `plugins/harness-engineering-skills/skills/harness/references/protocol-quick-ref.md §retro format`.
- Cross-repo learning: the `stometa-skillset` project's `.harness/retro/index.md` tracks related-in-spirit patterns (`review-loop: contradiction-propagation`, `rules: default-vs-spec`); the new 2026-05-09 patterns `[spec: ambiguous-counting-semantic]` and `[evidence: artifact-shape-mismatch]` are both "Generator+Evaluator settle on stricter readings across iterations" flavors that may be worth promoting cross-repo.

## Filed Issues

### 2026-05-09 and earlier
- Proposal 4 (host): https://github.com/stone16/twitter-chrome-extension/issues/9
- Proposal 3 (harness, label not applied): https://github.com/stone16/harness-engineering-skills/issues/42 — `spec: artifact-path-overload`
- Proposal 1 (harness, label not applied): https://github.com/stone16/harness-engineering-skills/issues/44 — `spec: ambiguous-counting-semantic`
- Proposal 2 (harness, label not applied): https://github.com/stone16/harness-engineering-skills/issues/43 — `evidence: artifact-shape-mismatch`

### 2026-05-25 wingmanx-kb-contract-v1
- Proposal 2026-05-25-1 (harness, label not applied): https://github.com/stone16/harness-engineering-skills/issues/56 — `harness: evaluator-session-id-handoff-race`
- Proposal 2026-05-25-2 (harness, label not applied): https://github.com/stone16/harness-engineering-skills/issues/57 — `spec: coverage-criterion-scope-underspecified`
- Carry-over host proposal already filed: https://github.com/stone16/twitter-chrome-extension/issues/9 — `host: build-bumps-package-json`
