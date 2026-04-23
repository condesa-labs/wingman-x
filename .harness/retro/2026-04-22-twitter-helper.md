---
task_id: twitter-helper
task_title: "Chrome Twitter Helper — agent-agnostic semi-auto reply assistant"
date: 2026-04-22
checkpoints_total: 10
checkpoints_passed_first_try: 9
total_eval_iterations: 11
total_commits: 54
reverts: 0
avg_iterations_per_checkpoint: 1.1
---

# Retro — twitter-helper

**Date**: 2026-04-22
**Task**: Chrome Twitter Helper — agent-agnostic semi-auto reply assistant
**Branch**: `harness/twitter-helper` → `main`
**Commits**: 54 | **Reverts**: 0 | **Final SHA**: `7b49ac4`
**Review-loop**: 5 Phase 2 rounds + 6 Phase 3 consensus passes | **Findings**: 14 (13 accepted-and-fixed, 1 rejected-and-resolved-by-peer, 0 escalated, 0 deferred)
**Full-verify**: iter-1 HARD FAIL → iter-2 PASS (bundler-regression caught and fixed)
**PR**: local-only repo (origin points to `.`); PR body written to `.harness/twitter-helper/pr-body.md`

Meta: this is the **first retro** recorded under this project's `.harness/retro/`. Historical frequency references below draw on the parent `stometa-skillset` retro history (shared engineering lineage — same harness engine, same agents) where relevant.

---

## Task Metrics

| Metric | Value |
|--------|-------|
| Checkpoints | 10 / 10 landed (9 passed on iter-1; CP10 needed iter-2 for a minor E2E timeout bump) |
| Total evaluator iterations | 11 (avg 1.1) |
| Implementation-phase iterations with hard failures | 0 (CP10 iter-1 was a timeout flake, not a hard fail) |
| Review-loop rounds | 5 Phase 2 + 6 Phase 3 |
| Review-loop findings | 14 (1 critical, 13 major) — 13 accepted-and-fixed, 1 rejected-and-resolved-by-peer |
| Full-verify iterations | 2 (iter-1 FAIL → iter-2 PASS) |
| Full-verify hard failures | 1 (bundler-regression introduced by review-loop fix chain) |
| Commits | 54 (implementation + review-loop fixes + full-verify fix) |
| Reverts | 0 |
| Coverage (backend aggregate) | 94.85% (daemon) — well above 85% gate |
| Unit/integration tests (final) | 164 pass (74 daemon + 16 agent-kit + 74 extension) |
| E2E tests (final) | 14/14 Playwright specs pass |

---

## Observations

### Error Patterns Identified

#### Pattern 1: Bundler-Contract Drift Caught Only by Full-Verify E2E — `[build: bundler-contract-drift]` — NEW

**Classification**: Project-level (Generator / review-loop Generator scope-awareness) + skill-level (full-verify is the only safety net; implementation-phase E2E had a stale-dist blind spot)
**Frequency**: First observation of this exact pattern across the harness retro corpus. One concrete instance this task (content-script bundler missed `daemon-shape.js`). Related-in-spirit to `[review-loop: contradiction-propagation]` from 2026-04-17 retro — both are "changes that are self-consistent per-file but violate a cross-file contract," differing in contract kind (bundler-order vs sibling-doc consistency).
**Evidence**:
- `.harness/twitter-helper/full-verify/iter-1/verification-report.md` HF-1
- `.harness/twitter-helper/full-verify/iter-1/evidence/content-bundle-diagnosis.txt`
- Commit chain: `a5de612` (review-loop f4), `6fd7166` (review-loop f14, added `hasDaemonIdentityHeader` calls into `content-script.ts`), `7b49ac4` (the fix — added `daemon-shape.js` to `CONTENT_BUNDLE_ORDER` + flattened popup import path)

Review-loop rounds f12–f14 pushed `hasDaemonIdentityHeader` and `isDaemonSuggestionResponse` imports into `packages/extension/src/content/content-script.ts` from `../daemon-shape.js`. TypeScript was happy (the module graph resolves cleanly at compile time) and `npm run test` passed (vitest operates on source files, not bundled artifacts). But `packages/extension/scripts/copy-assets.ts` maintains a hand-rolled `CONTENT_BUNDLE_ORDER` array that concatenates content-script source files into a single classic-mode JS bundle — and `daemon-shape.js` was not in the list. Result: the bundler stripped the `import { ... } from "../daemon-shape.js"` line (as intended) but never inlined the two referenced functions. At page-runtime, `dist/content.js` threw `ReferenceError: hasDaemonIdentityHeader is not defined` on every tweet-detail page load. Nine of fourteen E2E specs failed deterministically.

The fix was one-line — prepend `"daemon-shape.js"` to `CONTENT_BUNDLE_ORDER` plus flatten the popup's `../daemon-shape.js` import to `./daemon-shape.js` (sibling path inside flattened dist/).

**Why the intermediate E2E runs didn't catch it**: during the review-loop fix chain, E2E was re-run multiple times, but always against an already-loaded `dist/` from earlier runs where the content script still used the narrower in-content-bundle helpers. Only a clean fresh build (`npm run build`) surfaced the regression, because only then did the `content.js` bundle regenerate with the new import structure. The **Evaluator's full-verify stage is the first point in the pipeline that mandates a clean `npm run build` before E2E** — this is what caught it.

**Root cause**: the Generator (and the review-loop Generator during Phase 2/3) treats module imports as a TypeScript concern, but this project has a **second, hand-rolled module system** (the content-script concatenation bundler) that imposes a cross-file contract invisible to `tsc --noEmit`, `vitest`, and the module graph. Changes that add imports from outside the content/ directory silently break this second contract.

#### Pattern 2: Review-Loop Asymptote on Single Theme — `[review-loop: asymptote]` — NEW (observational)

**Classification**: Skill-level observation (review-loop Phase 3 iteration strategy)
**Frequency**: First observation. One concrete instance this task.
**Evidence**: `.review-loop/latest/summary.md` + rounds.json — f12 (v1, post-max) → f13 (v2) → f14 (v3) were three consecutive Phase 3 passes all iterating on the same underlying theme: "how does the content script / popup distinguish a real daemon response from something else on the same port?"

After Phase 2 hit `max_rounds=5`, Phase 3 opened with f12 (stale-recovery trusts 2xx responses without body-shape validation). Fix landed. v2 peer re-read caught f13 (subset validator still allows squatters — fix was too narrow). v3 peer re-read caught f14 (squatter returning 404 passes silently — body check alone is insufficient; need a daemon-identity header). Each fix was correct and valuable; each exposed a narrower-than-needed framing of the underlying problem.

The v4 fix (`x-twitter-helper-daemon` header + `hasDaemonIdentityHeader` check on every response across all status codes) was the architectural fix that should have been identified earlier — once you're in "is this response from our daemon?" territory, a header is the right layer, not a body-shape check. Three passes iterated up to that insight.

**Second-order observation**: the review-loop Phase 3 strategy is "apply max-round fix, re-scan fresh, repeat until consensus." This worked — consensus was reached at v6 with all 14 findings resolved. But the three passes on the same theme before the architectural framing emerged suggest a **theme-coalescing heuristic** could save passes: if two consecutive Phase 3 rounds flag related findings under the same anchoring concept ("daemon authenticity check"), the Generator should pause and ask "what is the actual invariant here?" before shipping a narrow fix.

No concrete defect — logged for monitoring only. Review-loop correctly converged; the question is whether it could have converged faster.

#### Pattern 3: Config-Precedence Footgun — `[engine: invocation-vs-config-precedence]` — NEW

**Classification**: Skill-level (harness engine + review-loop default) / session-level user-experience
**Frequency**: First observation. One concrete near-miss this task (no bug manifested because the user's explicit invocation overrode the config correctly).
**Evidence**: `.harness/config.json` shows `cross_model_review: false` auto-created early in the session. The user's session-start instruction ("run review-loop using codex") overrode this per the harness precedence rules, and review-loop ran as intended. But had the Generator followed the config blindly, review-loop (which surfaced 14 findings, 1 critical, 13 major, one of which — f1 — was a critical persistence-invariant violation on every POST) would have been silently skipped.

**Root cause**: the engine has a sensible precedence (explicit user invocation > config default), but the config file is human-readable JSON and the default value is `false` — which is arguably the wrong default for a harness task whose core value proposition is catching bugs the host misses. The default sets up a future session where the user doesn't give an explicit instruction, the agent reads the config, the config says "skip," and the agent skips — silently shipping whatever the host got away with.

The defensive counter-argument is: review-loop costs (model time, latency) and the default should be opt-in for tasks where the cost isn't justified. But the asymmetric consequences — skip when needed is catastrophic, run when unneeded is merely slow — argue for a safer default or a prompt-at-skip behavior when the spec declares the task as non-trivial.

Flag as **observational** pending another occurrence. If a future session ships with review-loop skipped due to config precedence, promote to actionable defect.

#### Pattern 4: Stale-Dist Blind Spot in Implementation-Phase E2E — `[e2e: stale-dist]` — NEW

**Classification**: Project-level (the project's own `test:e2e` script doesn't force a fresh build), but the pattern generalizes to any harness task with a build step before E2E.
**Frequency**: First observation. One concrete instance this task.
**Evidence**: Same as Pattern 1 — the review-loop ran E2E multiple times, all passed, because they all loaded the same stale `dist/`. Only the Evaluator's full-verify stage (which runs `npm run build` before E2E) caught the regression.

**Root cause**: `npm --workspace @twitter-helper/extension run test:e2e` loads `dist/` but doesn't re-build it first. Playwright loads the extension from `dist/` via `--load-extension`, so if nobody re-ran `npm run build` after a source change, the extension under test is the old one. During the review-loop fix chain I ran E2E without re-building, they passed (because `content.js` was still the pre-f12 version), and I gained false confidence.

Generalizing: any harness task whose E2E surface depends on a compiled/bundled artifact has this same risk. The fix is either (a) make the project's `test:e2e` script depend on `build`, or (b) make the harness engine's review-loop Generator enforce `npm run build && npm run test:e2e` for the E2E-check category. Option (a) is cleaner.

---

### Rule Conflict Observations

**No in-task rule conflicts** comparable to the 2026-04-17 `[rules: default-vs-spec]` pattern. The two Rule Conflict Notes logged in per-checkpoint `output-summary.md` files (CP02 status-enum widening, CP10 E2E-path literal vs functional intent) are **spec-interpretation ambiguities** resolved with documented rationale, not rule conflicts. The Generators correctly flagged the choice for the Evaluator rather than proceeding silently.

---

### What Worked Well

1. **Checkpoint gating held over 10 checkpoints + 54 commits.** Zero reverts. Every checkpoint landed once and stayed landed. CP10's iter-2 was a test-stability tweak (timeout bump on a popup-list E2E), not a fundamental revision. Nine of ten checkpoints passed on iter-1.

2. **Cross-model review-loop was decisive.** 14 substantive findings surfaced in a 54-commit feature, one of them critical (f1 — bound port never kept in live state; a persistence-invariant violation that would have silently corrupted `state.json` on every POST). None of these were caught by Claude Code host self-review or by the harness Evaluator. This reinforces the 2026-04-17 retro's finding that review-loop is **structurally necessary** for non-trivial features, not optional.

3. **Full-verify mandatory fresh build caught the bundler regression.** This is the single most valuable lesson from this task. Every intermediate E2E run in the review-loop phase loaded a stale `dist/` and passed. Only the Evaluator's full-verify stage — which runs `npm run build` before E2E — caught the deterministic `ReferenceError` break. The full-verify stage earns its place.

4. **Review-loop Phase 3 consensus protocol converged correctly.** Six Phase 3 passes after Phase 2 hit `max_rounds=5`. Each pass surfaced one new finding, which was fixed, and the final pass returned "no new finding" from the peer. Consensus is a real stopping condition, not a time-boxed cutoff.

5. **Rejected-and-resolved-by-peer (f4).** The one rejection was initially framed as "CORS allowlist is fine — any chrome-extension ID is acceptable for local dev." Codex peer ACCEPTED the rejection in round 2, but the v4 Phase 3 pass re-surfaced it as "the regex is cosmetic and doesn't actually constrain the set of accepted extension IDs." The rejection was reconsidered, and the final f4 fix layered three defenses: canonical-ID regex + opt-in `TWITTER_HELPER_EXT_ALLOWED_IDS` env var for production + fail-closed on set-but-empty env. This is the rejection protocol working as designed.

6. **Evidence files from Evaluator were load-bearing.** The full-verify iter-1 evidence (`content-bundle-diagnosis.txt` showing exactly which symbols were referenced but not declared in the bundle) pointed directly at the fix. No debugging required — the Evaluator did the diagnostic work. That is what evaluator evidence files are for.

7. **Zero fake assertions.** All coverage numbers match across iterations (94.85% line coverage for daemon, 100% for agent-kit) — no drift, no estimated numbers, no "looks-like" passes. Evidence trails are intact under `.harness/twitter-helper/full-verify/iter-{1,2}/evidence/`.

---

## Cross-Model Learning Analysis

**Which issues did Codex (peer) catch that Claude Code (host) missed?**

All 14 review-loop findings were raised by Codex. None by Claude Code's own scan. Three broad classes:

| Class | Count | Examples | Why host missed |
|-------|-------|----------|-----------------|
| Persistence / state-machine invariants | 4 | f1 (port never kept in live state), f9/f10/f11 (concurrent scan races, generational guard, fresh/fresh coalescing) | Host's mental model of single-flight was correct for the common case but missed the race under invalidate-while-scan and fresh-during-ordinary patterns. Peer read the code with no pre-commitment to the design intent and asked "what happens if A and B fire in this order?" |
| Trust boundaries / response authenticity | 4 | f6 (`/health` probe trusts any 2xx), f12/f13/f14 (stale-recovery trusts response content, subset validator, squatter-404-false-negative) | Host wrote the happy-path shape-check, then missed that "stale recovery" is a security-adjacent moment where a squatter on the same port can spoof responses. Peer identified this as a trust boundary, not a shape-check. |
| Input validation / attack surface | 2 | f4 (CORS allowlist overbroad), f5 (`tweet_url` accepted arbitrary URLs) | Host assumed dev-mode defaults were acceptable for shipping code. Peer pointed out that production deployment requires tighter defaults. |
| Build / packaging / deployment | 4 | f2 (dist ENOENT), f3 (`main` path mismatch), bundler-regression (iter-1 full-verify), popup flattened-import path | Host verified that unit tests pass and typecheck is clean — but did not run the built artifact against a fresh install. These are all "it compiles, but it doesn't actually run when shipped" bugs. |

**Pattern**: the host consistently passes "does the module graph resolve" and "do the unit tests pass" — and consistently misses "does the built artifact work when loaded fresh in the target runtime." The peer's scope is diff-driven and runtime-curious; the host's scope (during implementation) is intent-driven and module-graph-focused.

**Load-bearing finding**: the bundler regression at full-verify iter-1 was structurally similar to f4 post-max — both are "host self-consistent per-file, but violates a cross-file contract not visible to the type system." The 2026-04-17 retro's Proposal 2 ("cross-sibling-file consistency scan for documentation/protocol checkpoints") generalizes here: for **any** checkpoint that edits files feeding a hand-rolled bundler or a manifest list (`CONTENT_BUNDLE_ORDER` is exactly this class), the Generator must re-scan the manifest.

---

## Recommendations

### Proposal 1: Manifest-Aware Generator Scan for Hand-Rolled Bundlers — `[build: bundler-contract-drift]`

- **Pattern**: `[build: bundler-contract-drift]`
- **Severity**: high
- **Status**: Proposed
- **Root cause**: When a project maintains a hand-rolled bundler (e.g., `packages/extension/scripts/copy-assets.ts`'s `CONTENT_BUNDLE_ORDER` array), adding an import from outside the bundler's known file set silently breaks the bundle at runtime. `tsc --noEmit` and `vitest` are both blind to this because they operate on the module graph, not the bundler output. The project's `test:e2e` script is also blind because it doesn't re-build before running. Only a mandatory fresh-build gate catches it.
- **Drafted rule text** (addition to project-level `CLAUDE.md` in `/Users/stometa/dev/chrome-twitter-helper/CLAUDE.md`, under a new or existing `## Project-Specific Invariants` section):
  ```
  ### Hand-rolled content bundler

  `packages/extension/scripts/copy-assets.ts` maintains a `CONTENT_BUNDLE_ORDER`
  array that concatenates content-script source files into a single classic-mode
  JS bundle. This bundler is invisible to `tsc` and `vitest` — they operate on
  the module graph, not the bundler output.

  When modifying any file under `packages/extension/src/content/` OR adding an
  import to a file under `packages/extension/src/content/` from outside the
  content/ directory:
  1. Open `packages/extension/scripts/copy-assets.ts` and confirm every imported
     symbol's source file is declared in `CONTENT_BUNDLE_ORDER`.
  2. If the imported source file is not in the list, either add it to the
     correct position (dependencies before dependents) or copy the needed
     symbols into a content-local helper.
  3. After modifying, run `npm --workspace @twitter-helper/extension run build`
     and grep `packages/extension/dist/content.js` for each newly-imported
     symbol to confirm it is declared before first use. A missing declaration
     yields `ReferenceError` at runtime — not at typecheck, not at unit-test.

  Related: the popup's bundled ESM files are flattened into `dist/` at build
  time. Imports from siblings in `dist/` must use `./sibling.js`, not
  `../sibling.js` (the `../` escapes `dist/` and breaks at runtime).
  ```
- **Issue-ready**: true

### Proposal 2: Force Fresh Build Before E2E in Extension Workspace — `[e2e: stale-dist]`

- **Pattern**: `[e2e: stale-dist]`
- **Severity**: high
- **Status**: Proposed
- **Root cause**: `npm --workspace @twitter-helper/extension run test:e2e` runs Playwright against `dist/` without re-building first. Changes to source files that modify the built bundle's shape are invisible until the next `npm run build`. During the review-loop fix chain, every intermediate E2E run loaded stale `dist/` and passed — creating false confidence that the fix was landed. Only the Evaluator's full-verify stage (which forces a fresh build) caught the regression.
- **Drafted rule text** (addition to project-level `CLAUDE.md`, same `## Project-Specific Invariants` section):
  ```
  ### E2E runs must follow a fresh build

  Before `npm --workspace @twitter-helper/extension run test:e2e` can be
  trusted, run `npm --workspace @twitter-helper/extension run build` in the
  same shell session. The E2E script loads the unpacked extension from
  `packages/extension/dist/`, which is NOT regenerated by the test script
  itself. A stale `dist/` can pass E2E even when the source-level change
  is broken at runtime.

  Preferred: run `npm run build && npm --workspace @twitter-helper/extension
  run test:e2e` as a single chain. Alternatively, edit
  `packages/extension/package.json` to declare `pretest:e2e: "npm run build"`.

  This is load-bearing during review-loop and any refactor that touches
  `packages/extension/src/content/**`, `packages/extension/src/popup/**`,
  or `packages/extension/scripts/copy-assets.ts`.
  ```
- **Issue-ready**: true

### Proposal 3: Review-Loop Theme Coalescing Heuristic — `[review-loop: asymptote]`

- **Pattern**: `[review-loop: asymptote]`
- **Severity**: low (observational — does not block correctness, only efficiency)
- **Status**: Monitoring (promote after one more observation)
- **Root cause**: Three consecutive Phase 3 passes iterated on the same underlying problem (daemon authenticity check) at progressively narrower fix-sites. Each fix was correct; the architectural reframing ("identity header at every response, not body-shape check") emerged only on the third pass. A theme-coalescing step between passes could save rounds when findings cluster under one concept.
- **Drafted rule text** (addition to `plugins/stometa-skillset/skills/review-loop/SKILL.md` Phase 3 step, new section):
  ```
  ### Theme coalescing between Phase 3 passes

  If two consecutive Phase 3 passes surface findings that share a common
  anchor concept (e.g., "daemon authenticity", "stale state recovery",
  "CORS tightening"), the Generator should pause before applying the
  narrower fix and ask: "What is the actual invariant the peer is pointing
  at? Is there a higher-layer fix (header, contract, schema) that subsumes
  both findings?"

  Apply the higher-layer fix if it exists. Otherwise proceed with the
  narrower fix but record the theme in the round's fix notes so a future
  peer-round can re-anchor on the broader invariant.

  Not every two findings have a shared anchor. This is an opt-in
  heuristic; consensus is still the stopping condition.
  ```
- **Issue-ready**: false (Monitoring; promote after one more observation)

### Proposal 4: Prompt on Skip When Config Declines Review-Loop — `[engine: invocation-vs-config-precedence]`

- **Pattern**: `[engine: invocation-vs-config-precedence]`
- **Severity**: medium
- **Status**: Monitoring (first observation; promote after one concrete skip-regret)
- **Root cause**: The harness auto-writes `.harness/config.json` with `cross_model_review: false` as a default. The precedence rule (explicit invocation > config default) saved this task because the user explicitly instructed review-loop. But for tasks where the user is less explicit, a `false` default silently skips review-loop — asymmetric consequences (skip-when-needed is catastrophic; run-when-unneeded is merely slow).
- **Drafted rule text** (addition to harness engine pre-review-loop gate — `plugins/stometa-skillset/plugins/stometa-skillset/skills/harness/references/execution-protocol.md` or engine script):
  ```
  Before skipping review-loop due to .harness/config.json setting
  `cross_model_review: false`, the engine MUST:

  1. Report the current config value.
  2. Require an explicit session-level confirmation if the task's spec
     marks the task as non-trivial (e.g., spec has ≥5 checkpoints, ≥3
     acceptance criteria, or `review-loop: required` front-matter).
  3. Emit a prompt like: "Config has cross_model_review=false. Task
     spec is non-trivial (10 checkpoints, fullstack). Proceed WITHOUT
     peer review? [y/N]"

  Skipping silently is only acceptable when the config is explicitly set
  AND the spec does not meet any non-trivial threshold.
  ```
- **Issue-ready**: false (Monitoring)

### Proposal 5: Project-Level CLAUDE.md Assertion of Test-Pyramid Completeness — `[project: test-pyramid]`

- **Pattern**: `[project: test-pyramid]`
- **Severity**: medium
- **Status**: Proposed (as positive-pattern reinforcement, drawn from this task's lesson)
- **Root cause**: This task demonstrated that **three test layers in order are the minimum reliable pyramid for a Chrome extension + local daemon project**: (1) unit tests (vitest) catch logic bugs, (2) typecheck (tsc) catches module-graph bugs, (3) full build + E2E (Playwright against fresh `dist/`) catches runtime/packaging bugs. Skipping layer 3 produced false confidence. Absent a CLAUDE.md statement, a future session might skip layer 3 again.
- **Drafted rule text** (addition to project-level `/Users/stometa/dev/chrome-twitter-helper/CLAUDE.md` under `## Verification`):
  ```
  ### Required verification layers

  Before claiming a change to packages/extension/** is "done":
  1. `npm run typecheck` — module graph resolves.
  2. `npm run test` — unit/integration tests pass.
  3. `npm run build` — bundler (copy-assets.ts + tsc) emits `dist/` freshly.
  4. `npm --workspace @twitter-helper/extension run test:e2e` — Playwright
     runs against the freshly-built `dist/`.

  Layers 1–2 are insufficient. The content-script bundler and the popup
  flattening logic operate OUTSIDE the module graph. A change that passes
  layers 1–2 can still break at runtime — this happened during review-loop
  (commits a5de612, 6fd7166 → caught and fixed by 7b49ac4 after full-verify
  iter-1 exposed the regression).

  For changes touching only `packages/daemon/` or `packages/agent-kit/`,
  layers 1–2 are sufficient (no hand-rolled bundler, no runtime surface
  outside the Node module graph).
  ```
- **Issue-ready**: true

---

### Upgrade to Principle

None this task — Proposal 5 is borderline principle-candidate material (build-artifact runtime vs module-graph), but it is project-specific enough that CLAUDE.md is the better home. If another project hits the same pattern (source of truth diverges from build output), promote to a global principle then.

### Rule Conflict Resolution

None to resolve this task — no in-task conflicts surfaced.

### Skill / Tooling Defects

1. **Engine `validate-transition` stale-phase error message** — `harness-engine` CLI.
   - **Evidence**: at session start, the engine's `validate-transition` command reported "from phase: full-verify" while the actual state was `post-e2e`. The message is cosmetic (the actual transition logic was correct), but it misled me briefly into thinking state was already past the E2E gate.
   - **Status**: **Actionable defect** (cosmetic but misleading).
   - **Suggested remediation**: the `validate-transition` output should read the current phase from `.harness/*/state.json` or whatever the authoritative source is, not from a cached/defaulted value. Low priority; useful pickup for the next engine-maintenance pass.

2. **`.harness/config.json` auto-created with `cross_model_review: false`** — `harness-engine` initialization.
   - **Evidence**: the config was written without an explicit user decision early in the session. See Pattern 3 above.
   - **Status**: **Observation** → **Actionable defect** if another skip-regret happens.
   - **Suggested remediation**: either (a) change the default to `true`, (b) require explicit user decision on first session, or (c) add the prompt-on-skip behavior in Proposal 4.

3. **No implicit build-before-E2E in extension workspace** — `packages/extension/package.json` scripts.
   - **Evidence**: this is the root cause of Pattern 4. A `pretest:e2e: "npm run build"` hook would remove the stale-dist blind spot entirely.
   - **Status**: **Actionable project-level defect**, but the remediation is a one-line `package.json` edit, not a harness-skill change. Documented in Proposal 2 as a CLAUDE.md rule; the cleaner fix is the scripts edit.
   - **Suggested remediation**: user decides — CLAUDE.md rule is sufficient; `package.json` edit is cleaner but changes project behavior.

4. **Review-loop Phase 3 iterates on narrow fixes before broader reframe** — `review-loop` SKILL.md Phase 3 strategy.
   - **Evidence**: Pattern 2 above; f12 → f13 → f14 cluster.
   - **Status**: **Monitoring**. See Proposal 3.

---

### Filed Issues

**Repo has no GitHub remote** (`origin` points to `.`). Cannot file issues on this repo until it is pushed to a hosting service. When it is, the following issues should be created (Orchestrator or human to action):

| Proposal | Pattern | Severity | Issue title | Labels |
|----------|---------|----------|-------------|--------|
| 1. Manifest-aware Generator scan for hand-rolled bundlers | `[build: bundler-contract-drift]` | high | "Document hand-rolled content bundler invariant in CLAUDE.md" | `harness-retro`, `build`, `docs` |
| 2. Force fresh build before E2E in extension workspace | `[e2e: stale-dist]` | high | "Add pretest:e2e build dependency OR document fresh-build invariant" | `harness-retro`, `testing`, `build` |
| 3. Review-loop theme coalescing heuristic | `[review-loop: asymptote]` | low | "Review-loop: add theme-coalescing heuristic between Phase 3 passes" | `harness-retro`, `review-loop`, `monitoring` |
| 4. Prompt on skip when config declines review-loop | `[engine: invocation-vs-config-precedence]` | medium | "Harness engine: prompt on skip when config.cross_model_review=false and spec is non-trivial" | `harness-retro`, `engine`, `monitoring` |
| 5. CLAUDE.md test-pyramid completeness statement | `[project: test-pyramid]` | medium | "Document required verification layers in CLAUDE.md" | `harness-retro`, `docs` |

**Additional follow-ups (not retro-derived, but known):**

| Item | Source | Severity | Suggested issue title |
|------|--------|----------|----------------------|
| `card.spec.ts` post-collapse dock-visibility flake (~10–20%) | review-loop summary | low | "E2E: card.spec.ts post-collapse dock visibility intermittent; timeout bump or DOM-state rework" |
| Engine `validate-transition` stale-phase message | this retro §Skill Defects #1 | low | "harness-engine: validate-transition error reports stale phase label" |

---

## Summary (for index.md)

Ten checkpoints, nine passed on iter-1 (CP10 iter-2 was a timeout bump). Zero reverts across 54 commits. Review-loop surfaced 14 findings (1 critical + 13 major, all resolved in 5 Phase 2 + 6 Phase 3 rounds). Full-verify iter-1 caught a deterministic bundler regression introduced by the review-loop fix chain — the content-script's hand-rolled bundler (`CONTENT_BUNDLE_ORDER`) was not updated when review-loop added imports from outside the content/ directory. Iter-2 passed clean. Top patterns: `[build: bundler-contract-drift]` (new, high) — hand-rolled bundlers are a contract invisible to tsc + vitest; `[e2e: stale-dist]` (new, high) — extension workspace's `test:e2e` doesn't force a fresh build; `[review-loop: asymptote]` (new, low) — Phase 3 iterated three rounds on the same underlying invariant before the architectural reframing emerged. Five concrete rule proposals drafted; most impactful are #1 and #2 (both address the bundler/stale-dist blind spot).
