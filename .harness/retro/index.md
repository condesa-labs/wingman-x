# Retro Index — chrome-twitter-helper

Last updated: 2026-04-22

First retro in this project's retro log. Historical cross-references to patterns first observed in the parent `stometa-skillset` retros are noted in individual retro files.

---

## Frequency Table

Tracks error pattern frequency across tasks in **this project**. Patterns with 3+ occurrences in the last 10 tasks escalate to draft rules.

| Pattern Tag | Description | Occurrences (last 10 tasks) | Total Findings | Status |
|-------------|-------------|:---------------------------:|:--------------:|--------|
| build: bundler-contract-drift | Hand-rolled bundler (CONTENT_BUNDLE_ORDER) misses imports added from outside the bundler's known file set; `tsc` + vitest blind because they operate on module graph, not bundler output | 1 | 1 | **Proposed** (severity override: high first occurrence — caused iter-1 full-verify hard-fail with 9/14 E2E specs deterministically broken) |
| e2e: stale-dist | Extension's `test:e2e` script loads `dist/` without re-building; intermediate E2E runs pass against stale `dist/` producing false confidence; only fresh build catches runtime regressions | 1 | 1 | **Proposed** (severity override: high — directly coupled with bundler-contract-drift above, same root defect manifests through two surfaces) |
| review-loop: asymptote | Multiple consecutive Phase 3 passes iterate on narrow fixes before the architectural reframe emerges; review-loop converges but could be faster with theme coalescing | 1 | 3 (f12 + f13 + f14) | Monitoring (promote at one more observation) |
| engine: invocation-vs-config-precedence | `.harness/config.json` auto-default `cross_model_review: false` risks silent skip of review-loop when user instruction is less explicit than this session's | 1 | 1 (near-miss, no concrete bug) | Monitoring (promote at one concrete skip-regret) |
| project: test-pyramid | Claiming "done" after tsc + unit tests, without the full build + E2E layer, produces false confidence on any change affecting the content-script bundler or popup flattened imports | 1 | 1 | Proposed (preventative; drawn from this task's lesson) |

---

## Pending Rule Proposals

| Proposal | Pattern | Status | Action |
|----------|---------|--------|--------|
| Manifest-Aware Generator Scan for Hand-Rolled Bundlers | build: bundler-contract-drift | **Proposed** | Issue-ready: add CLAUDE.md invariant section |
| Force Fresh Build Before E2E in Extension Workspace | e2e: stale-dist | **Proposed** | Issue-ready: CLAUDE.md rule OR `package.json` `pretest:e2e` hook |
| CLAUDE.md Test-Pyramid Completeness Statement | project: test-pyramid | **Proposed** | Issue-ready: preventative CLAUDE.md section |
| Review-Loop Theme Coalescing Heuristic | review-loop: asymptote | Monitoring | Promote after one more observation |
| Prompt on Skip When Config Declines Review-Loop | engine: invocation-vs-config-precedence | Monitoring | Promote after one concrete skip-regret |

---

## Positive Patterns (Reinforce)

| Pattern | Description | Occurrences |
|---------|-------------|:-----------:|
| Zero-revert workflow | Checkpoint gating holds across 10 checkpoints + 54 commits | 1 |
| Cross-model review-loop as structural necessity | All 14 findings raised by peer (Codex), none by host self-review; includes one critical persistence-invariant violation | 1 |
| Full-verify mandatory fresh build | Full-verify stage's `npm run build` before E2E is the single gate that caught the bundler regression; earns its place | 1 |
| Review-loop Phase 3 consensus as real stopping condition | 6 Phase 3 passes converged to zero findings from peer — not a time-boxed cutoff | 1 |
| Rejected-and-resolved-by-peer (f4) | Rejection protocol correctly re-opened f4 when subsequent Phase 3 pass surfaced a deeper framing | 1 |
| Evidence files point directly at the fix | Evaluator's iter-1 evidence file (`content-bundle-diagnosis.txt`) provided exact symbol + bundle-order diagnosis — no debugging required to apply the fix | 1 |
| TDD commit pattern with per-checkpoint test-first | Red-green-refactor commits visible throughout the commit log | 1 |

---

## Skill Defect Watch

| Observation | Skill | Status | Source |
|-------------|-------|--------|--------|
| `validate-transition` CLI reports stale phase label (cosmetic, misleading) | harness-engine | **Actionable defect** | 2026-04-22 twitter-helper retro |
| `.harness/config.json` auto-default `cross_model_review: false` risks silent review-loop skip | harness-engine | **Observation** → actionable on next occurrence | 2026-04-22 twitter-helper retro |
| Review-loop Phase 3 lacks theme-coalescing heuristic between narrow-fix passes | review-loop | **Observation** → actionable on next occurrence | 2026-04-22 twitter-helper retro |
| `packages/extension/package.json` has no `pretest:e2e: "npm run build"` hook | project (not a harness defect) | **Actionable project-level defect** | 2026-04-22 twitter-helper retro |

---

## Retro History

| Date | Task ID | Retro File | Key Signal |
|------|---------|------------|------------|
| 2026-04-22 | twitter-helper | [retro](2026-04-22-twitter-helper.md) | `[build: bundler-contract-drift]` (new, high, caused iter-1 full-verify fail); `[e2e: stale-dist]` (new, high); review-loop asymptote; zero reverts, 14 findings all resolved |

---

## Notes

- **Repo has no GitHub remote** (`origin` points to `.`). Filed issues are tracked in individual retro files' "Filed Issues" sections as `would-file` entries until the repo moves to a hosted Git service.
- Retro protocol reference: `plugins/stometa-skillset/skills/harness/references/protocol-quick-ref.md §retro format`.
- Cross-repo learning: the `stometa-skillset` project's `.harness/retro/index.md` tracks related-in-spirit patterns (`review-loop: contradiction-propagation`, `rules: default-vs-spec`) — both are "self-consistent per-file, violates cross-file contract" flavors of the bundler-contract-drift pattern observed here.
