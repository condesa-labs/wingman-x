---
task_id: twitter-helper-viral-pool
task_title: "Twitter Helper — viral GraphQL hook + tweet pool, augmenting handle scraper"
date: 2026-05-09
checkpoints_total: 7
checkpoints_passed_first_try: 5
total_eval_iterations: 11
total_commits: 28
reverts: 0
avg_iterations_per_checkpoint: 1.57
---

## Summary

Seven checkpoints, five first-pass PASS, two multi-iteration (CP04=2, CP06=4). 28 commits, zero reverts. Pre-PR gate clean at HEAD `538c3b8` post-rebase; daemon coverage 95.14%, agent-kit `src/` 98.31%, both well above the 85% gate. E2E iter-2 PASS, full-verify PASS_WITH_WARNINGS (two intentional/accepted soft warnings, zero hard failures).

The task succeeded structurally — every named primitive shipped, every cross-CP contract held — but the iteration cost was concentrated in two places worth investigating: CP06 took four iterations on a single ambiguous "hard cap on file count" semantic (Generator and Evaluator settled on increasingly strict readings of "what counts as a file"), and CP04 took two iterations because the Generator captured the wrong shape of evidence artifact (POST request body instead of daemon `state.json`).

Three positive workflow patterns deserve reinforcement: (a) the carry-over rules from 2026-04-22 (`[build: bundler-contract-drift]`, `[e2e: stale-dist]`) were cited directly in the spec and honored by Generators with zero recurrence — proof that the retro→spec loop closes; (b) the harness handshake around the user-accepted manual SC1 deferral preserved the obligation through E2E iter-2 → full-verify → PR body without losing it; (c) the intentional `npm run build → npm run bump:patch` working-tree-dirty contract was correctly classified as a soft warning, not a hard fail, by full-verify.

## Observations

### Error Patterns

#### `[spec: ambiguous-counting-semantic]` — HIGH severity, NEW

CP06's acceptance criterion declared:

> Walker safety: hard cap on file count (≤10,000), per-file size (≤1 MB), `.md` files only, skip symlinks, skip files larger than the cap with a structured log line.

The phrase "hard cap on file count" admitted four progressively-stricter readings, and the Evaluator surfaced a stricter one at each iteration:

| Iter | Generator counted | Evaluator's blocker probe | Verdict |
|------|-------------------|---------------------------|---------|
| 1 | accepted `.md` files only (`found.length` after size + extension filter) | "what about non-md or oversized markdown? a vault with >10k oversized .md files traverses without tripping the cap" | FAIL |
| 2 | every regular file before extension/size filter (still missing hidden direct files) | "hidden regular files like `.foo.md` bypass the cap because `shouldSkipPath` runs before `seenFiles++`" | FAIL |
| 3 | + hidden direct files (still missing files inside skipped dirs) | "regular files under `01_skip/` are never traversed, so they bypass the cap" | FAIL |
| 4 | every regular file before any filter; traverse skipped dirs to count contents | passed | PASS |

This is the **most expensive class of multi-iteration in this task** — three wasted Generator+Evaluator round-trips on a single semantic. The cost is hidden in `total_iterations` because the work-product (the cap implementation) was correct in concept from iter-1; only the *quantifier* over what counts as "a file" was contested.

The spec author intended the cap as a defense against OOM/freeze on a pathological vault. From that intent, "every regular file the walker can see, including ones the walker chose not to traverse" is the correct reading — but a Generator reading "hard cap on file count, .md files only, skip symlinks" can plausibly read "file" as "the .md files we are about to accept." The acceptance criterion should have enumerated the counting semantics directly, e.g.:

> "Hard cap on regular-file count (≤10,000) — count every regular file the walker traverses or would traverse, INCLUDING non-`.md` files, hidden files, oversized files, and files under skipped top-level directories. The cap is a walker-safety invariant, not an output-quality invariant."

This pattern is structurally adjacent to the existing protocol-level Spec Evaluator warning `cross-CP artifact ownership conflict` (which detects shared resource paths) — both are "the spec used a phrase that mechanically admits multiple readings the Spec Evaluator should have flagged before execution."

#### `[evidence: artifact-shape-mismatch]` — MEDIUM severity, NEW

CP04 iter-1 acceptance bullet:

> Before/After screenshot showing daemon `state.json` `tweet_pool` empty before / populated after the E2E run. Saved to evidence/.

The Generator produced:

- `tweet-pool-before.json` = `{"tweet_pool": {}}` ✓
- `tweet-pool-after.json` = `{"tweets": [...]}` (a POST request body, not the state file) ✗
- `viral-bridge-before.png` / `viral-bridge-after.png` = screenshots of the fixture HTML page text "bridge fixture" ✗

The Evaluator caught it on iter-1 with the diagnosis: "the after JSON is a request body under `tweets`, and the screenshots only show the HTML fixture page." iter-2 fixed both: the mock daemon now maintains a `{tweet_pool: {...}}` state shape, the after-file is the post-mutation state, and screenshots show the JSON state views.

This is a literal-reading failure: "showing daemon state.json" was read as "showing whatever JSON crossed the wire during the test." The Generator chose the POST body because it was the available artifact in a hermetic test that didn't actually have a daemon state file. The fix was to make the mock daemon model a state file, not to question the spec.

The pattern is generalizable: **evidence shape MUST match the named artifact, not its proxies.** A spec that asks for `state.json` excerpts means the file `state.json` (or a credible facsimile in the test rig), not "any JSON that proves the same property."

#### `[spec: artifact-path-overload]` — MEDIUM severity, NEW (related to existing `cross-CP artifact ownership conflict`)

The single artifact path `docs/manual-qa/<date>-viral-pool.png` is named by **two distinct contracts** in spec.md:

1. **SC1**: "screenshot of `state.json` excerpt saved to `docs/manual-qa/<date>-viral-pool.png`" — captured manually against real twitter.com.
2. **CP07 acceptance #8**: "Manual QA capture per README §Manual QA: a screenshot saved to `docs/manual-qa/<date>-viral-pool.png` showing popup with candidates from both sources."

CP07's hermetic Playwright wrote the popup variant; SC1's real-twitter.com capture has nowhere to land without overwrite. The E2E iter-1 evaluator caught this and downgraded the verdict to REVIEW; iter-2 documented it as user-accepted deferred and added a PR-body note recommending a distinct path (`-viral-pool-state.png`) for the live capture.

The spec actually contains a note disambiguating this path from the **standard daily** `<YYYY-MM-DD>.png` Manual QA capture ("The `-viral-pool` suffix is intentional...") — but did not disambiguate **within** the task between SC1 and CP07. The protocol's Spec Evaluator already has a `cross-CP artifact ownership conflict` Phase pre-execution warning; it should be extended to also fire on **SC↔CP** path conflicts (Success Criterion claiming the same path as a Checkpoint acceptance).

This pattern carried zero iteration cost in this task because Stometa accepted the deferral, but it is structural risk that will cost iterations under a stricter operator.

#### Carry-over patterns from 2026-04-22 — WORKED, zero recurrence

| Pattern | How it appeared in this task | Outcome |
|---------|------------------------------|---------|
| `[build: bundler-contract-drift]` | CP03 added new `MAIN_WORLD_BUNDLE_ORDER` array; CP04 added `viral-bridge.js` to existing `CONTENT_BUNDLE_ORDER`. Spec explicitly cited the retro pattern in Technical Approach §"Carry-over retro patterns directly relevant" and split lifecycle ownership between the two CPs. | Both CPs PASS with bundler registrations honored. No recurrence. |
| `[e2e: stale-dist]` | CP04 acceptance bullet 6: "Before E2E run: `npm --workspace @twitter-helper/extension run build` produces fresh `dist/content.js` containing the new bridge handler (grep for `TH_VIRAL_OBSERVED`). Per Card P2 + retro `[build: bundler-contract-drift]`, E2E against a stale `dist/` is invalid." | Honored. No recurrence. |
| `[project: test-pyramid]` | Spec called out README §Contributing as the canonical pre-PR gate per host-conventions card P2; CP07 acceptance bullet 7 enforces `build && test && typecheck` clean. Full-verify confirmed all three exit 0. | Honored. No recurrence. |
| `[build: scripts-untyped]` (from 2026-04-26) | Out-of-Scope §"Structural fix of `[build: scripts-untyped]`" explicitly defers; CP07 acceptance bullet 5 mandates runtime exercise of `scripts/watcher.ts` and `scripts/seed-kb-from-obsidian.ts` as the type-safety net. | Deferral honored; runtime smoke caught no script-level type issues. No new structural fix needed in this task. |

### Rule Conflict Observations

CP03 noted exactly one rule-conflict-class observation in `output-summary.md` ("Rule Conflict Notes" section): the spec named `packages/extension/test/viral-hook-extract.test.ts` but the repo's Vitest include glob is `test/unit/**/*.test.ts`, so the test was placed at `packages/extension/test/unit/viral-hook-extract.test.ts` for discovery. This was a **silent project convention** the spec didn't honor — the Generator made the right call (file the test where vitest can discover it) and recorded the divergence.

This is a clean instance of the rule-conflict protocol: Generator acted on the host convention (which has higher discoverability evidence — the running vitest config) over the spec's directive, and surfaced the conflict in the output-summary so the Spec Evaluator can revise on next pass. Worth reinforcing as a positive pattern. **Action**: feed back into spec authoring — Spec Evaluator should validate test paths against the host's vitest `include` glob during Phase 1.

No other rule-conflict notes across the seven CPs.

### What Worked Well

- **Zero reverts across 28 commits, 11 evaluator iterations, 7 checkpoints.** Checkpoint gating remained a stable invariant.
- **Carry-over retro→spec→generator loop closed.** Three patterns from 2026-04-22 and one from 2026-04-26 were cited directly in the spec, and Generators honored every one of them. Zero regression on prior retro findings.
- **User-accepted manual deferral preserved through three layers.** Stometa's "没事，我这个可以等会自己来测试" propagated from E2E iter-2 (Residual Risks #1) → full-verify (Soft Warning #2) → eventual PR-body note. The harness has a clean mechanism for "manual gate deferred by user" without losing the obligation.
- **Intentional build-bump dirty-tree contract correctly classified.** `npm run build` runs `npm run bump:patch` first, modifying 5 `package.json` files. The full-verify report classified this as Soft Warning #1 (intentional, orchestrator-committed post-verify) rather than treating it as a hard fail or as evidence of Generator scope creep. The discovery+verify protocol handles this cleanly.
- **CP07 wiring matrix unusually well-structured.** Each row carries (file:line) for both the test and the production caller plus an explicit mock-boundary statement. Tier 2 reviewer was able to re-verify each row by direct code reading.
- **Cold-start migration smoke as fault-path probe.** CP07's "boot daemon against pre-CP01 state.json lacking `tweet_pool`" test exercises the schema's `.default({})` defense in an integration setting. This is a high-leverage test pattern worth replicating: any new top-level state field should ship with a "boot against legacy state" test.
- **Cross-CP lifecycle split language in spec.** CP03 and CP04 both touch `copy-assets.ts`, but the spec explicitly partitioned their surfaces (`MAIN_WORLD_BUNDLE_ORDER` vs. `CONTENT_BUNDLE_ORDER`) and the CPs honored the split with no drift events.

## Recommendations

### Proposal 1: Add Spec Evaluator pre-execution warning for ambiguous quantifier semantics on cap/limit invariants — `[spec: ambiguous-counting-semantic]`

- **Pattern**: `[spec: ambiguous-counting-semantic]`
- **Severity**: high
- **Status**: Proposed
- **target_repo**: harness
- **Root cause**: Spec acceptance criteria that declare a cap or limit invariant ("hard cap on N", "max M items", "evict when size > X") frequently leave the **quantifier** over what is counted under-specified. CP06 took four iterations to converge on "every regular file the walker traverses, including ones it would have skipped" because the spec said only "hard cap on file count, `.md` files only, skip symlinks." Each iteration the Evaluator surfaced a stricter reading (accepted-files → all-regular-files → +hidden → +files-under-skipped-dirs); each Generator iteration was correct against the prior reading and incorrect against the new one. The semantic is decidable in advance; the spec just didn't decide.
- **Drafted protocol-quick-ref.md addition** (under "Spec Evaluator pre-execution warnings"):

  ```markdown
  - `ambiguous quantifier on cap/limit invariant` flags acceptance criteria
    declaring a cap, limit, max-count, or eviction threshold whose subject
    admits more than one reading — for example "hard cap on file count"
    where "file" could mean accepted outputs, all regular files, traversed
    entries, or the union including skipped paths. The spec MUST disambiguate
    the counting set explicitly (which entries are counted, when they are
    counted, and whether filtered/skipped/oversized entries still count) or
    the warning fires. Common phrasing tells: "hard cap on N",
    "max M items", "evict when size > X", "skip files larger than Y".
    Source: 2026-05-09 twitter-helper-viral-pool retro, CP06 four-iteration
    ratchet.
  ```
- **Issue-ready**: true

### Proposal 2: Add Generator/Evaluator discipline rule on evidence-artifact shape — `[evidence: artifact-shape-mismatch]`

- **Pattern**: `[evidence: artifact-shape-mismatch]`
- **Severity**: medium
- **Status**: Proposed
- **target_repo**: harness
- **Root cause**: When a spec acceptance criterion names a specific artifact (e.g. `state.json` excerpt, `dist/<name>.js` grep output, `coverage/index.html` table), the Generator can satisfy the *property* the artifact would prove using a credible proxy (the POST body that was about to write to `state.json`, the unbundled source file, etc.). The proxy may exhibit the same property but is not the named artifact, and the Evaluator correctly rejects on shape mismatch. This costs at minimum one iteration even when the implementation is correct.

  CP04 iter-1 captured `tweet-pool-after.json` as a POST request body `{"tweets": [...]}` rather than a daemon `state.json` excerpt `{"tweet_pool": {...}}`. The implementation was correct; the evidence shape was a proxy. iter-2 made the hermetic mock daemon model a `tweet_pool` state file, satisfying the spec.
- **Drafted CLAUDE.md addition for harness skill** (in `harness-generator` agent prompt under existing evidence guidance):

  ```markdown
  ## Evidence Shape Discipline

  When a spec acceptance criterion names a specific artifact (state file
  path, bundle output path, coverage report file), the evidence MUST be
  that artifact or a credible facsimile that has the same shape — NOT a
  proxy that exhibits the same property in a different shape. Examples of
  the failure mode:

  - Spec asks for `state.json` excerpt; Generator captures the HTTP
    request body that was about to mutate `state.json`. Reject — request
    bodies and persisted state have different shapes.
  - Spec asks for `dist/<name>.js` grep output; Generator captures grep
    output from the un-bundled source file. Reject — bundle output and
    source have different shapes (bundler may strip imports, rewrite paths,
    inline modules).
  - Spec asks for "screenshot of popup with X"; Generator captures
    screenshot of the test fixture page. Reject — fixture pages and
    real popup chrome have different shapes.

  In hermetic test rigs that lack the named artifact, model a credible
  facsimile (e.g. a mock daemon that maintains a `tweet_pool` state shape)
  rather than substituting an in-flight proxy.
  ```
- **Issue-ready**: true

### Proposal 3: Extend Spec Evaluator's `cross-CP artifact ownership conflict` warning to cover SC↔CP path conflicts — `[spec: artifact-path-overload]`

- **Pattern**: `[spec: artifact-path-overload]`
- **Severity**: medium
- **Status**: Proposed
- **target_repo**: harness
- **Root cause**: The protocol's existing pre-execution warning `cross-CP artifact ownership conflict` (issue #24, captured in `protocol-quick-ref.md`) detects shared artifact paths across two or more **checkpoints**. It does not detect the case where a **Success Criterion** and a **Checkpoint acceptance** name the same artifact path with different content contracts. CP07's hermetic Playwright wrote `docs/manual-qa/2026-05-09-viral-pool.png` (popup screenshot from CP07 acceptance #8) before SC1's real-twitter.com state.json capture had a chance to land; the same filename serves two distinct deliverables.

  The spec actually contained a comment about this path's `-viral-pool` suffix disambiguating from the **standard daily** Manual QA capture, but did not disambiguate **within** the task between SC1 and CP07. The Spec Evaluator should have caught it.

  In this task the cost was zero (Stometa accepted SC1 deferral; the harness preserved the obligation cleanly through E2E + full-verify + PR body), but in the general case this would force a re-iteration of CP07 to re-run the hermetic test under a different path, or force the operator to choose which deliverable wins.
- **Drafted protocol-quick-ref.md edit** (extend existing `cross-CP artifact ownership conflict` pattern):

  ```markdown
  - `cross-CP artifact ownership conflict` flags the same artifact path,
    table, index, public symbol, or other named ownership surface
    appearing in two or more checkpoints OR ACROSS A SUCCESS CRITERION
    AND A CHECKPOINT ACCEPTANCE without an explicit lifecycle split.
    The check covers Success Criteria, Checkpoint acceptance bullets,
    and Files of Interest paths. Source: issue #24 (CP↔CP), 2026-05-09
    twitter-helper-viral-pool retro (SC↔CP).
  ```
- **Issue-ready**: true

### Proposal 4: Add host CLAUDE.md note on intentional version-bump dirty-tree behavior — `[host: build-bumps-package-json]`

- **Pattern**: `[host: build-bumps-package-json]` (positive — the harness handled this correctly, but a future Generator under tighter "leave the working tree clean" instructions might "fix" the bump)
- **Severity**: low
- **Status**: Proposed
- **target_repo**: host
- **Root cause**: This repo's root `npm run build` runs `npm run bump:patch` first, which intentionally modifies 5 `package.json` files (root + 4 workspaces) on every build. Full-verify correctly classified this as a soft warning and the orchestrator commits the bump post-verify. But a future Generator that reads "ensure the working tree is clean after CP" without context could revert the bump or skip the build step, breaking the version-tracking contract.
- **Drafted CLAUDE.md addition** (`/Users/stometa/dev/chrome-twitter-helper/CLAUDE.md`):

  ```markdown
  ## Build-time version bump (intentional dirty tree)

  `npm run build` (root) runs `npm run bump:patch` first, which modifies
  five `package.json` files (root + 4 workspaces) carrying a patch-level
  version bump. After any build, the working tree will show:

  - `package.json` (root)
  - `packages/agent-kit/package.json`
  - `packages/daemon/package.json`
  - `packages/extension/package.json`
  - `packages/sample-kb/package.json`

  This is **expected**, not a bug. Do NOT:

  - revert the version-bump diffs
  - skip `npm run build` to avoid the dirty tree
  - amend a prior commit to swallow the bump

  The orchestrator commits the bump after full-verify completes (per
  the harness `pass-full-verify` contract). Generators inside a
  checkpoint should run `npm run build` as required for evidence
  (e.g. fresh `dist/viral-hook.js`) and leave the version-bump diffs
  in the working tree.
  ```
- **Issue-ready**: true

### Proposal 5: Reinforce rule-conflict protocol — vitest discovery convention beats spec-named test path

- **Pattern**: positive — rule-conflict protocol worked
- **Severity**: low
- **Status**: Monitoring
- **target_repo**: harness
- **Note**: CP03's output-summary correctly recorded the divergence between spec-named `packages/extension/test/viral-hook-extract.test.ts` and the actual filed location `packages/extension/test/unit/viral-hook-extract.test.ts` (forced by the host vitest `include` glob). This is the rule-conflict protocol working as intended. **Optional follow-up**: extend Spec Evaluator Phase 1 to validate spec-named test paths against the host's `vitest.config.ts` `include` glob and warn pre-execution. Promote to Proposed if observed once more.
- **Issue-ready**: false (Monitoring; promote after one more occurrence)

### Skill Defect Flags

None observed in this task. Prior watch items remain at their 2026-04-22 status:

- `validate-transition` CLI stale phase label — not exercised in this task; status unchanged.
- `.harness/config.json` cross_model_review auto-default — review-loop ran cleanly this task; status unchanged.
- Review-loop Phase 3 theme-coalescing heuristic — review-loop converged to consensus this task without asymptote behavior; status unchanged.

### Issue Filing Plan

The Orchestrator can auto-create issues for:

- Proposal 1 (harness, high) — Spec Evaluator quantifier-semantic warning
- Proposal 2 (harness, medium) — Evidence shape discipline rule
- Proposal 3 (harness, medium) — Extend cross-CP path conflict to SC↔CP
- Proposal 4 (host, low — but Issue-ready=true because it's a concrete CLAUDE.md edit) — Build-bump dirty-tree note

Proposal 5 is Monitoring only; not file-ready.

Filed Issues will be recorded back into this retro and `index.md` per the §issue-routing protocol.

## Filed Issues

- Proposal 1 (harness, label not applied): https://github.com/stone16/harness-engineering-skills/issues/44
- Proposal 2 (harness, label not applied): https://github.com/stone16/harness-engineering-skills/issues/43
- Proposal 3 (harness, label not applied): https://github.com/stone16/harness-engineering-skills/issues/42
- Proposal 4 (host): https://github.com/stone16/twitter-chrome-extension/issues/9
