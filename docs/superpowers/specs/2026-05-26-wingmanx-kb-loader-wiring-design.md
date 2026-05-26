# WingmanX KB Loader Wiring — Design

**Date:** 2026-05-26
**Branch:** `feat/wingmanx-kb-loader-wiring`
**Status:** Approved (awaiting spec review)

## Problem

The `wingmanx-kb-contract-v1` work (PR #14) shipped the **right half** of the
hexagonal KB architecture: the `@wingman-x/kb-contract` package, the `fs` and
`obsidian` adapters, the `agent-kit` cache loader (`createKBLoader`), and a
migration script. Per spec f10 it **deliberately did not rewire the legacy
production callers**. As a result:

- `createKBLoader` is exported from `@twitter-helper/agent-kit` but has **zero
  production consumers** (verified: only the index re-export + tests reference it).
- `scripts/watcher.ts` still reads `~/.twitter-helper/kb/` directly via an
  inline synchronous `loadKb()`, baking the KB into a single `kbSystemPrompt`
  string once at startup.
- `scripts/scrape-x-handles.ts` still reads `~/.twitter-helper/kb/selected-handles.txt`.
- `~/.wingman-x/` does not exist on disk — no migration has run.

This design wires the production path to the adapter architecture so the new
KB contract is actually used end to end.

## Goals

1. Production KB loading goes through `createKBLoader()` (default `fs` adapter
   reading `~/.wingman-x/kb/`), not the inline `loadKb()`.
2. KB is reloaded **per discovery run** (through the loader's
   stale-while-revalidate TTL cache), so editing the KB does not require
   restarting the watcher.
3. First-boot bootstrap: if `~/.wingman-x/kb/` is missing and the legacy
   `~/.twitter-helper/kb/` exists, auto-migrate before loading.
4. `scrape-x-handles.ts` sources its always-scrape list from the loader's
   handles.
5. Skill + `docs/agent-workflow.md` updated to the new KB location/format and
   the stale `chrome-devtools MCP` reference corrected to the real CDP `:9223`
   path.

## Non-Goals

- No changes to the daemon, extension, or `Candidate` schema.
- No changes to the rotation / `handle-evaluation.json` mechanism (decision 2-A).
- No changes to the CDP scraping logic itself.
- Obsidian adapter remains available but is not the default; switching to it is
  a `~/.wingman-x/config.json` edit, out of scope here.

## Key Decisions (approved)

| # | Decision | Choice |
|---|----------|--------|
| Scope | What gets wired | **Full**: watcher + handles + skill/doc |
| Bootstrap | When `~/.wingman-x/kb/` missing | **Auto-migrate on first boot** |
| Load timing | KB freshness | **Per-discovery reload** via loader TTL cache |
| 1 | Loader → `runDiscovery` seam | **1-A: inject async `loadSystemPrompt` closure** |
| 2 | Handles rotation source | **2-A: minimal — swap always-scrape source only, keep `handle-evaluation.json`** |

## Architecture

### Constraint: the deliberate `src/` vs `scripts/` coverage split

`src/watcher-core.ts` is the vitest-covered surface (pure/testable logic).
`scripts/watcher.ts` holds process lifecycle + I/O (KB read, SSE, spawn) and is
intentionally uncovered, exercised end-to-end via `--dry-run`. The loader's
adapter dynamic-import and disk cache I/O must stay on the `scripts/` side; the
covered surface only sees an injected function. This rules out decision 1-B
(moving KB load into `watcher-core`).

### Component changes

**1. `scripts/watcher.ts` — first-boot migration**

At the top of `main()`, before constructing the loader:

```
if (!exists(~/.wingman-x/kb) && exists(~/.twitter-helper/kb)) {
  await migrateTwitterHelperKB({ log, warn });   // existing, tested, idempotent
}
```

`migrateTwitterHelperKB` already skips when the target exists, builds the full
plan in memory before any temp dir, and does an atomic sibling-tmp `rename`. We
reuse it as-is. Migration failure throws → watcher exits loudly (no silent
fallback to the legacy dir).

**2. `scripts/watcher.ts` — loader-driven prompt**

- Create one loader: `const loader = createKBLoader({ log });`
- Initial `await loader.refresh()` to populate the cache and surface a
  hard-fail early if the KB is unreadable. Read `toneBytes`/`libraryFiles` for
  the banner from the loaded snapshot.
- Define `buildSystemPromptFromLoader(loader): Promise<string>` that assembles,
  **byte-for-byte aligned with the current `loadKb()` output**:

  ```
  # Tone
  {tone.markdown}
  # Library
  {libraryEntry[0].markdown}\n\n---\n\n{libraryEntry[1].markdown}…
  {SAFETY_BOUNDARY_PROMPT}
  ```

  Library entries come from `listLibrary()` then `getLibraryEntry(id).markdown`,
  ordered by the adapter's sort (filename `localeCompare`, matching the old
  `readdirSync` order closely enough; exact ordering documented as acceptable
  since the LLM consumes the concatenation, not positional).

**3. `src/watcher-core.ts` — accept an injected prompt provider**

- Replace `WatcherConfig.kbSystemPrompt: string` with an injected
  `loadSystemPrompt: () => Promise<string>` on `RunContext` (kept off
  `WatcherConfig` since it's a function, not serializable config; `toneBytes` /
  `libraryFiles` stay on config for the banner).
- `runDiscovery`: after `runScraper` returns tweets, `const systemPrompt =
  await ctx.loadSystemPrompt();` once per run; pass it into each `draftReply`.
- `draftReply` signature gains a `systemPrompt: string` param, replacing
  `config.kbSystemPrompt` in the `--append-system-prompt` arg. (Note: the
  current `draftReply` double-appends `SAFETY_BOUNDARY_PROMPT`; the new builder
  includes it once — `draftReply` will receive the fully composed prompt and
  stop re-appending. This removes an existing duplication.)
- Per-run load failure (loader throws): log `kb_load_failed`, ack the signal,
  skip the run — do not crash the SSE loop.

**4. `scripts/scrape-x-handles.ts` — loader-sourced handles**

- Replace `parseTier1Handles()` (reads `selected-handles.txt`) with
  `createKBLoader().getHandles()`, selecting handles from tiers where
  `policy === "every-run"`.
- `handle-evaluation.json` rotation pool logic is **unchanged**.
- Drop the `HANDLES_FILE` env override and the `selected-handles.txt` parser.
  Always-scrape handles now come exclusively from the loader (which reads
  `~/.wingman-x/kb/handles.md` via the fs adapter). `EVALUATION_FILE` and the
  rotation envs stay.

**5. Docs + skill**

- `docs/agent-workflow.md`: KB path → `~/.wingman-x/kb/` (`tone.md` +
  `library/*.md` + `handles.md`); correct the `chrome-devtools MCP` description
  to the real CDP `:9223` + `scrape-x-*.ts` path.
- `.claude/skills/discover-twitter-candidates/SKILL.md`: same KB location/format
  update.

## Data Flow (after wiring)

```
SSE signal_added(discovery_requested)
  → runDiscovery
      → runScraper            [spawns scrape-x-handles.ts]
            → createKBLoader().getHandles() → every-run tier  (necessary list)
            → handle-evaluation.json rotation pool            (unchanged)
            → CDP :9223 scrape → JSON tweets
      → loadSystemPrompt()    [closure over loader, per run]
            → loader.getTone / listLibrary / getLibraryEntry  (TTL cache)
            → "# Tone … # Library … SAFETY"
      → draftReply(tweet, systemPrompt) per tweet → claude --append-system-prompt
      → postCandidate → daemon
  → ackSignal
```

## Error Handling

| Failure | Behavior |
|---------|----------|
| First-boot migration throws | Watcher exits loudly; no fallback to legacy dir |
| Loader unreadable at startup (`SOURCE_UNAVAILABLE`) | Watcher exits loudly with the `KBAdapterError` |
| Per-run loader throw | Log `kb_load_failed`, ack signal, skip run; SSE loop continues |
| `scrape-x-handles` loader throw | Existing scraper failure path: log + empty stdout → `runScraper` returns null → ack |

## Testing (TDD, red first)

- **`buildSystemPromptFromLoader`**: fake loader → assert output format aligns
  with the legacy `loadKb()` concatenation (tone, library separators, single
  trailing SAFETY block).
- **`runDiscovery` with injected `loadSystemPrompt`**: stub returns a sentinel
  prompt; assert it is awaited exactly once per run and threaded into every
  `draftReply` call (spy on the spawned-claude args).
- **`draftReply`**: receives the composed prompt; assert `--append-system-prompt`
  carries it and SAFETY is not double-appended.
- **First-boot migration wiring**: target missing → migration invoked; target
  present → skipped (build on existing `migrate-core` tests with a watcher-layer
  wiring test).
- **`--dry-run` e2e path** stays green; banner `toneBytes`/`libraryFiles` now
  sourced from the loader snapshot.
- **`scrape-x-handles`**: extract the handle-selection logic into a testable
  unit (loader handles → `every-run` filter) and cover the tier filter.

## Verification Commands

- `npm run build:no-bump` (avoid the version-bump dirty tree)
- `npm test`
- `npm run typecheck`
- Manual smoke: remove/rename `~/.wingman-x`, start watcher, confirm auto-migrate
  log + a `--dry-run` banner showing loader-sourced tone bytes.

## Risks / Open Notes

- Library ordering differs subtly between `readdirSync` (old) and the adapter's
  `localeCompare` sort (new). Accepted: the LLM consumes the concatenation, not
  position. Documented, not gated.
- `selected-handles.txt` remains on disk post-migration (migration copies, does
  not delete the source). The wired scraper stops reading it; this is expected.
