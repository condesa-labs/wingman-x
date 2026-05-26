---
date: 2026-05-25
task_id: wingmanx-kb-contract-v1
task_title: WingmanX KB Contract v1 — Hexagonal KB Adapter Architecture
checkpoints: 9
first_pass: 7
total_iterations: 11
avg_iterations: 1.2
commits: 29
reverts: 0
e2e: PASS
full_verify: PASS_WITH_WARNINGS (0 hard, 1 soft)
cross_model_review: skipped (config cross_model_review:false)
---

# Retro — WingmanX KB Contract v1

Independent post-task analysis of the hexagonal KB adapter contract build (CP01–CP09):
contract package, conformance kit, fs + obsidian adapters, the agent-kit cache loader,
wiring integration tests, and the `tsx` migration script. This ships the **rightmost half**
of the target architecture; per spec f10, v1 deliberately does **not** rewire the legacy
`~/.twitter-helper/kb/...` production callers.

---

## Task Metrics

| Metric | Value | Comparison |
|--------|-------|------------|
| Checkpoints | 9 | larger than 2026-05-09 (7), 2026-04-26 (6) |
| First-pass PASS | 7 / 9 (78%) | > 2026-05-09 (5/7 = 71%); < 2026-04-26 (6/6) |
| Total iterations | 11 | avg 1.2 |
| Avg iterations | 1.2 | best of the 4-task series |
| Commits | 29 | — |
| Reverts | **0** | zero-revert streak holds (4th task) |
| E2E | PASS | 11/11 success criteria verified |
| Full-verify | PASS_WITH_WARNINGS | 0 hard failures, 1 soft warning |
| Cross-model review-loop | skipped by config | no concrete harm found (see Finding 5) |

Only two checkpoints needed a second iteration: **CP01** (scaffold, 2 iters) and **CP08**
(user-approved shared-gate stabilization, 2 iters). The remaining seven passed first try.

---

## Per-Checkpoint Summary

| CP | Iters | Final SHA | Status | Note |
|----|:-----:|-----------|--------|------|
| 01 | 2 | dd975b4 | PASS | Scaffold; 2nd iter routine |
| 02 | 1 | 636a1cc | PASS | Contract package (sole shape authority) |
| 03 | 1 | 31fbd83 | PASS | Conformance kit (12 violation self-tests) |
| 04 | 1 | 8b60d5d | PASS | fs adapter |
| 05 | 1 | bd649a0 | PASS | obsidian adapter |
| 06 | 1 | 14dcb4e | PASS | obsidian bootstrap (pure string, no network) |
| 07 | 1 | 4ecd7ee | PASS | Cache loader + atomic CURRENT swap (Codex f4) |
| 08 | 2 | 5d3fd80 | PASS | Real-loader integration tests; iter-2 = user-approved shared-gate fix |
| 09 | 1 | 01a128f | PASS | Migration script; magnitude Size Waiver (Outcome A) |

---

## What Went Well

1. **Zero reverts across 29 commits / 11 iterations / 9 CPs.** Checkpoint gating held again —
   the fourth consecutive zero-revert task in this repo.
2. **Contract-as-sole-authority paid off.** Every consumer imports schemas/types/`KBAdapterError`/
   `slugify`/handles grammar from `@wingman-x/kb-contract`; no schema fork; both compile-time
   (typecheck) and runtime (`.parse`) enforcement on every cross-CP boundary. E2E found no
   data-shape mismatch on any of the 8 traced flows.
3. **The atomic-CURRENT cache mechanism structurally eliminated the partial-state window**
   that drove the spec to v10 (Codex f4). Generation dirs are never renamed; only the small
   `CURRENT` pointer flips. CP07 proves it with an abort-after-step-4 test.
4. **Migration script chose the strongest "no partial output" form** — full plan (incl. all
   UTF-8 validation) built in memory *before* any temp dir exists; abort path leaves zero
   `.tmp`. Atomic same-filesystem sibling-tmp + `rename` (not the naked `mktemp`/`$TMPDIR`
   cross-fs anti-pattern). `handles.md` produced by the shared `serializeHandles` (single
   source of truth), not a bespoke writer.
5. **Full-verify used `npm run build:no-bump`** — the retro→spec→generator loop closed cleanly
   (see Finding 4 / Positive Patterns).
6. **CP09 magnitude Size Waiver worked as designed.** 551 ins > 450 (3× threshold) triggered a
   goal-relevance audit; every changed file mapped to CP09 scope → Outcome A PASS with
   `magnitude_advisory: true`. The waiver protocol prevented a false-positive scope flag.

---

## Findings

### Finding 1 — CP08 `auto_resolvable: false` was a correct escalation, not a misclassification

**Pattern:** `harness: shared-gate-flake-escalation` (positive / monitoring)
**Severity:** low (escalation worked; no wasted iterations on CP08's own deliverables)

CP08 is wiring/test-only. **Every CP08-owned deliverable was correct on iter-1** — the three
real-loader integration tests passed 100% of all runs, exercised the real package-name dynamic
import (no `importModule` seam), proved generation rotation and the missing-config fallback log.
The iter-1 verdict was REVIEW (not FAIL, not PASS) for two concerns surfaced while running the
**shared** `npm test` gate, both **provably not caused by CP08**:

- (A) a pre-existing flaky CP07 unit test (`kb-loader.test.ts` background-refresh log race,
  ~25% in a clean env; reproduces with CP08 tests excluded), and
- (B) an environmental leaked-daemon port contention in `wiring.test.ts` (passes 8/8 after
  orphan cleanup).

Both review items were `requires_human_judgment: true` → cohort `auto_resolvable: false` → human
pause. **This was the right call.** Item (A)'s fix edits CP07-owned test code; item (B) needs an
operator/environment action. Auto-fixing (A) would have been an **autonomous cross-CP scope
expansion** — exactly what the harness ownership discipline exists to block. The user approved
the fix ("help me fix those issues"), and iter-2 resolved both with a tightly scoped, opt-in,
backward-compatible change (`WATCHER_DAEMON_PORT` override + moving the log assert inside the
existing `waitForAssertion`). **Verdict: useful escalation, classification correct.**

Residual structural observation (monitoring, not a defect): the harness has no first-class verdict
for *"this checkpoint's required shared gate is broken by a pre-existing defect in peer-owned code
it didn't introduce."* The evaluator had to encode this via REVIEW + `requires_human_judgment` +
a `fix_hint` warning. This worked, but a formalized sub-verdict (e.g. `BLOCKED_BY_PEER_GATE`)
would make the escalation reason machine-legible. **One occurrence → keep monitoring; promote on
recurrence.**

### Finding 2 — `migrate-core.ts` 80% branch coverage reveals a real per-file coverage-criterion ambiguity

**Pattern:** `spec: coverage-criterion-scope-underspecified` (NEW)
**Severity:** medium (latent FAIL-risk on correct code; zero cost this task because handled transparently)

CP09 and full-verify both measured `migrate-core.ts` whole-file **branch coverage = 80%** (40/50;
lines/statements 94.11%, functions 90.9%). Both evaluators treated it as **non-blocking** and both
documented the strict reading transparently. The ambiguity is genuine and lives in the spec wording,
which carries **three divergent coverage phrasings**:

| Spec location | Phrasing | Granularity |
|---|---|---|
| SC#3 (L65–69) | named-set `... ≥ 85% on lines/statements/functions/branches` | per-package + 3 named agent-kit modules; **excludes** `migrate-core.ts` |
| CP07 (L704–708) | `kb-loader/kb-paths/kb-cache ... MUST hit ≥85% ... individually` | explicit per-file, all 4 dimensions |
| CP09 (L832–834) | `coverage of the **conversion functions** in src/migrate-core.ts ≥ 85%` | **bare ≥85%, no dimension enumeration, scoped to "functions" not whole-file** |

CP09's criterion is the odd one out: it (a) omits the `lines/statements/functions/branches`
enumeration its siblings carry, and (b) scopes to "the conversion functions" rather than the whole
file. A reviewer reading it strictly as whole-file-all-dimensions **could legitimately FAIL a
correct implementation** (full-verify says so explicitly: *"a reviewer reading CP09's literal
whole-file ≥85 phrasing strictly could elect to treat it as a hard failure"*). The lenient reading
is defensible: `migrate-core.ts` is outside SC#3's binding named set, the enforced machine gate
(agent-kit aggregate, 88.34% branch) passes, and the 10 uncovered branches are predominantly
DI-default fallbacks and pure fault/error paths.

This is the **same family** as the 2026-05-09 `spec: ambiguous-counting-semantic` pattern
(under-specified threshold quantifier surfaced as stricter readings) — but a distinct flavor:
*coverage-criterion dimension/scope* rather than cap/limit quantifier. It cost **zero iterations**
this task because both evaluators converged on the lenient reading and recorded the strict one. The
fix is a cheap pre-execution spec lint (see Proposal 2), extending the existing harness Spec-Evaluator
proposal rather than duplicating it.

### Finding 3 — Evaluator wrote `evaluator_session_id` before the proof file existed; orchestrator repaired via same-session resume (recurring)

**Pattern:** `harness: evaluator-session-id-handoff-race` (NEW)
**Severity:** medium (recurring; wastes an LLM repair pass per occurrence; self-heals, no verdict corruption)

**Two occurrences this task alone:**
- **CP09 iter-1** — `repair-evaluator-session-id-prompt.md` exists: *"The proof file now exists and
  contains the session id… Repair ONLY the `evaluator_session_id` metadata… Remove or update any
  note that says the session id file was absent or that the orchestrator must reconcile it."* The
  evaluator initially wrote a sentinel/note because the canonical id wasn't yet on disk; the
  orchestrator ran a **same-session resume** (*"You are the same Harness Evaluator session that just
  evaluated CP09"*) to reconcile.
- **CP08 iter-2** — `evaluator-repair-prompt-iter-2.md` exists: *"the YAML frontmatter had the wrong
  `evaluator_session_id`… must exactly match [the proof file]."* Same repair pattern.

**Root cause — an ordering chicken-and-egg.** The evaluator agent is asked to write its own
`evaluator_session_id` into `evaluation.md` frontmatter, but the canonical id is only known to the
harness wrapper, which writes the proof file `evaluator-session-id.txt` **after** the agent's turn
completes. At artifact-write time the agent cannot know the id, so it writes a placeholder/sentinel
(or a "file absent" note) that must be reconciled afterward. The orchestrator currently reconciles
with a **full LLM same-session resume** — expensive and error-prone for a one-line metadata fix.

The focus prompt notes this "has recurred in prior checkpoint handoffs." It is not captured in the
three archived retros (2026-04-22 / 04-26 / 05-09), so this is its **first formal retro capture** —
but two occurrences in a single task is already a pattern. **Issue-ready (harness).** Cheapest fix:
the wrapper stamps a known sentinel token (e.g. `__PENDING_SESSION_ID__`) deterministically
post-completion (sed-style substitution), eliminating the LLM repair pass entirely; or the wrapper
writes the proof file *before* the agent's final artifact write so the agent can read it.

### Finding 4 — `build:no-bump` honored a prior retro pattern (carry-over closure)

**Pattern:** `host: build-bumps-package-json` (carry-over from 2026-05-09) — **reinforced / honored**
**Severity:** n/a (positive)

Full-verify ran `npm run build:no-bump` (not root `npm run build`, which runs `bump:patch` and
mutates 5 `package.json` files). This was not improvised — the **spec adopted `build:no-bump` as the
binding SC#2 command** (L62–64), so the 2026-05-09 retro finding propagated cleanly into the
2026-05-25 spec and was honored by the full-verify evaluator, which confirmed post-run `git status`
showed only `.harness/` evidence + expected `dist/`. The retro→spec→generator/verifier loop closed.
The CLAUDE.md documentation note from the 2026-05-09 proposal remains useful for *non-harness*
contexts (a human running `npm run build` directly), so that host proposal stays open as carry-over.

### Finding 5 — Cross-model review-loop skipped by config: no concrete harm this task

**Pattern:** `engine: invocation-vs-config-precedence` (carry-over from 2026-04-22) — **reinforced, still monitoring**
**Severity:** low (no harm found)

`.harness/config.json` has `cross_model_review: false`, so no Codex/peer review-loop ran. Per the
focus instruction I looked for concrete harm and found **none**: E2E PASS (11/11 criteria), full-verify
PASS_WITH_WARNINGS (0 hard), and the only residual notes are low-severity coverage/robustness items a
peer reviewer would not have escalated. The two procedural events (CP08 escalation, CP09 session-id)
are harness-mechanics, not code-correctness issues a cross-model peer catches. **No skip-regret →
keep monitoring; do not promote.** (Historical note: the cross-model peer was a *structural necessity*
on 2026-04-22 when it caught a persistence-invariant violation — so the monitoring item stays live, it
just didn't bite this task.)

---

## Rule Conflict Notes

- **CP01–CP07, CP09:** "None" across all output summaries.
- **CP08 iter-1:** "None. The checkpoint requested tests only; production loader/cache code was left
  unchanged."
- **CP08 iter-2:** The only substantive conflict of the task — *"The CP08 evaluator marked the review
  as `auto_resolvable: false` because both fixes touched peer/CP07-owned or shared test-gate behavior.
  The user explicitly approved fixing those issues."* This is the rule-conflict protocol working as
  designed (cross-CP ownership vs shared-gate stability), resolved by explicit human approval — not a
  silent blend. See Finding 1.

No silent double-bind occurred. Every conflict was surfaced and routed to human judgment.

---

## E2E / Full-Verify Result

- **E2E (iter-1): PASS.** Independent fresh review at HEAD `01a128f`. All 11 success criteria verified
  by deterministic evidence (root `build:no-bump && test && typecheck` all exit 0; live migration smoke
  test; `handles.md` `deepStrictEqual` round-trip; real dynamic-import integration tests proving the
  workspace package graph resolves at runtime). Three non-blocking hygiene notes recorded
  (`migrate-core.ts` branch 80%; loader cold-start on-disk-stale fallback nicety; cache materializes
  `.json` vs the diagram's illustrative `.md`).
- **Full-verify (iter-1): PASS_WITH_WARNINGS** (0 hard, 1 soft). All three required commands exit 0,
  independently reproduced. Every SC#3 binding coverage target ≥85 on all four metrics (conservative
  floor 85.71%). The single soft warning is the `migrate-core.ts` 80% branch (Finding 2), explicitly
  classified non-blocking with the strict reading documented.

---

## Positive Patterns

| Pattern | This task's evidence | Reinforces |
|---------|----------------------|------------|
| Zero-revert workflow | 29 commits / 11 iters / 9 CPs, 0 reverts | 4th occurrence |
| `auto_resolvable:false` correctly blocks autonomous cross-CP scope expansion | CP08 iter-1 refused to auto-edit CP07-owned test code; routed to human | NEW (escalation-gate working) |
| Rule-conflict protocol surfaces, never silently blends | CP08 iter-2 surfaced the peer-ownership vs shared-gate conflict for human approval | extends 2026-04-26/05-09 |
| Full-verify mandatory fresh build (`build:no-bump`) | Used the no-bump command; `git status` clean of version mutations | 3rd occurrence |
| Carry-over retro→spec→generator/verifier loop closes | 2026-05-09 `build:no-bump` finding became binding SC#2 in this spec, honored | 2nd explicit closure |
| Magnitude Size Waiver (Outcome A) | CP09 551-ins overrun → goal-relevance audit → PASS with `magnitude_advisory:true` | NEW (waiver protocol working) |
| Contract-as-sole-shape-authority | 8 traced data flows, zero schema forks, compile+runtime enforcement | NEW |
| Atomic-publish / single-source-of-truth in migration | in-memory plan before any temp dir; shared `serializeHandles`; sibling-tmp+`rename` | NEW |
| TDD red→green per checkpoint | red-before-green proven (`merge-base --is-ancestor`) on every CP incl. CP08/CP09 | 4th occurrence |

---

## Pending Rule Proposals

| Proposal | Pattern | Status | Issue-ready | Target |
|----------|---------|--------|:-----------:|--------|
| 1. Deterministic wrapper-side `evaluator_session_id` stamp (kill the LLM repair pass) | `harness: evaluator-session-id-handoff-race` | **Proposed** (NEW) | true | harness |
| 2. Spec-Evaluator coverage-criterion dimension/scope lint (extend ambiguous-quantifier check) | `spec: coverage-criterion-scope-underspecified` | **Proposed** (NEW) | true | harness |
| 3. Formalize a `BLOCKED_BY_PEER_GATE` evaluator sub-verdict for pre-existing shared-gate defects | `harness: shared-gate-flake-escalation` | Monitoring (NEW) | false | harness |
| 4. `migrate-core.ts` negative-path tests to reach ≥85 branch (follow-on hygiene) | `spec: coverage-criterion-scope-underspecified` (host side) | Monitoring (NEW) | false | host |
| Host CLAUDE.md note on intentional `npm run build` version bump | `host: build-bumps-package-json` | **Proposed** (carry-over 2026-05-09) | true | host |

(Carry-over harness/host proposals from 2026-04-22/26 and 2026-05-09 remain as recorded in
`index.md`; this task did not re-observe their patterns.)

---

## Draft CLAUDE.md / Protocol Rule Text

### For Proposal 1 (harness protocol — evaluator session-id handoff)

```
## Evaluator session-id metadata (handoff ordering)

The `evaluator_session_id` in an evaluation.md frontmatter MUST NOT be authored
by the evaluator agent during its own turn — the canonical id is only known to
the harness wrapper, which writes `evaluator-session-id.txt` AFTER the agent
completes. Authoring it inline forces a same-session resume repair pass.

Protocol: the evaluator writes the literal token `__PENDING_SESSION_ID__` in the
frontmatter. The wrapper performs a deterministic post-completion substitution of
that token with the proof-file id (no LLM call). Never reconcile this field with
a full LLM resume. If the proof file is absent at substitution time, fail loudly
rather than writing a guessed/sentinel id into the artifact body.
```

### For Proposal 2 (harness — Spec Evaluator pre-execution lint)

```
## Spec Evaluator: coverage-criterion dimension/scope consistency

When a spec contains multiple coverage criteria, flag any criterion that:
(a) omits the lines/statements/functions/branches dimension enumeration that a
    sibling criterion carries, OR
(b) scopes coverage to a subset ("the X functions") while a sibling scopes the
    whole file, OR
(c) names a file in a per-file ≥N criterion that is excluded from the binding
    Success-Criterion coverage set.

These create a strict-vs-lenient reading split that risks FAILing correct code.
Resolve before execution: state the binding dimensions, the binding scope
(whole-file vs named-functions), and which gate is authoritative.
```

### For carry-over (host CLAUDE.md — build version bump)

```
## Build commands

`npm run build` runs `npm run bump:patch` first, mutating version fields in 5
package.json files. For verification, CI, or any read-only build, use
`npm run build:no-bump` (root-only script) to avoid a dirty working tree.
```

---

## Issue-Ready Items

### Proposal 1: Deterministic wrapper-side `evaluator_session_id` stamp
- **Pattern**: `harness: evaluator-session-id-handoff-race`
- **Severity**: medium
- **Status**: Proposed
- **target_repo**: harness
- **Root cause**: The evaluator agent is required to write `evaluator_session_id` into
  `evaluation.md` frontmatter, but the canonical id is only written to
  `evaluator-session-id.txt` by the harness wrapper *after* the agent's turn ends. At
  artifact-write time the agent cannot know the id, so it emits a sentinel/placeholder (or a
  "file absent" note), which the orchestrator then reconciles with a full LLM same-session resume.
  Observed twice this task (CP08 iter-2, CP09 iter-1); orchestrator reports prior-handoff recurrence.
- **Drafted rule text**:
  ```
  Evaluator writes the literal token __PENDING_SESSION_ID__ in frontmatter.
  The wrapper deterministically substitutes it with the proof-file id post-completion
  (no LLM call). Never reconcile via full LLM resume. If the proof file is absent at
  substitution time, fail loudly rather than writing a guessed id.
  ```
- **Issue-ready**: true

### Proposal 2: Spec-Evaluator coverage-criterion dimension/scope lint
- **Pattern**: `spec: coverage-criterion-scope-underspecified`
- **Severity**: medium
- **Status**: Proposed
- **target_repo**: harness
- **Relationship**: Related to the closed 2026-05-09 harness proposal *"Spec Evaluator
  pre-execution warning for ambiguous quantifier on cap/limit invariants"* (issue #44), but
  filed separately as issue #57 because this is a distinct coverage dimension/scope lint.
- **Root cause**: CP09's coverage criterion (*"coverage of the conversion functions in
  src/migrate-core.ts ≥ 85%"*) omits the `lines/statements/functions/branches` enumeration that
  SC#3 and CP07 carry, and scopes to "the conversion functions" rather than the whole file. This
  produced a strict-vs-lenient reading split: whole-file branch = 80% (would FAIL a strict reader)
  while the binding named-set gate and enforced aggregate gate both pass. Both evaluators chose the
  lenient reading and documented the strict one — zero iteration cost, but a latent FAIL-risk on
  correct code.
- **Drafted rule text**:
  ```
  Spec Evaluator flags any coverage criterion that (a) omits the dimension enumeration a
  sibling criterion carries, (b) scopes to a function-subset while a sibling scopes whole-file,
  or (c) names a file in a per-file ≥N rule that is excluded from the binding SC coverage set.
  Resolve pre-execution: state binding dimensions, binding scope, and the authoritative gate.
  ```
- **Issue-ready**: true

### Carry-over (host): CLAUDE.md note on intentional `npm run build` version bump
- **Pattern**: `host: build-bumps-package-json`
- **Severity**: low→medium (preventative; reinforced this task)
- **Status**: Proposed (carry-over 2026-05-09)
- **target_repo**: host
- **Root cause**: root `npm run build` runs `bump:patch` first, mutating 5 `package.json` files.
  The spec already mitigates inside the harness by making `build:no-bump` the binding SC#2 command
  (honored by full-verify), but a human or future generator running `npm run build` directly still
  risks a dirty tree. A CLAUDE.md note closes the non-harness gap.
- **Drafted rule text**: see "Build commands" block above.
- **Issue-ready**: true (already filed as host issue #9; reinforced, not re-filed)

---

## Filed Issues

New issue-ready proposals from this retro were filed by the Orchestrator:
- **Proposal 1** (`target_repo: harness`) — evaluator-session-id handoff race:
  https://github.com/stone16/harness-engineering-skills/issues/56
- **Proposal 2** (`target_repo: harness`) — Spec-Evaluator coverage-criterion lint:
  https://github.com/stone16/harness-engineering-skills/issues/57
- **Carry-over host** — `npm run build` version-bump CLAUDE.md note already has an open host issue:
  https://github.com/stone16/twitter-chrome-extension/issues/9

Proposals 3 (BLOCKED_BY_PEER_GATE sub-verdict) and 4 (`migrate-core.ts` negative-path tests) are
**Monitoring**, not issue-ready — promote on recurrence / pick up as optional hygiene.
