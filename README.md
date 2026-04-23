# Chrome Twitter Helper

> 👉 **Start here**: [`docs/getting-started.md`](./docs/getting-started.md)
> — fresh-clone → first filled reply in ~10 minutes.

Chrome extension + local companion daemon that pairs with any MCP-capable LLM
agent to generate voice-matched Twitter replies for hand-picked candidates. The
agent discovers tweets and composes replies; the daemon brokers state between
agent and browser; the extension renders a Dock/Card widget on tweet pages and
fills Twitter's native composer on one click. The user always reviews and
presses Tweet themselves.

## Architecture — three components, agent-agnostic

```
Agent ──POST /candidates──▶ Daemon ◀──GET /suggestion── Extension (content script)
                            ▲ ▼                         ↓ (fill reply, etc.)
                            └─GET /candidates── Extension (popup)
                            ◀─POST /:id/action─ Extension
```

- **`packages/daemon`** — Node.js + TypeScript + Fastify HTTP service running on
  `http://localhost:53827` (with auto-bump fallback up to 53836). Holds the
  candidate pool and mediates all agent ↔ extension traffic.
- **`packages/extension`** — Chrome MV3 extension. Background worker discovers
  the daemon port; content script renders the widget on tweet-detail pages;
  popup lists all active candidates. Contains **no LLM logic** and no
  agent-vendor-specific code.
- **`packages/agent-kit`** (+ `packages/sample-kb`) — TypeScript helper library
  any MCP agent can call, plus plain-English workflow docs and a reference
  Claude Code skill. Swapping Claude Code for Codex / Gemini / a bespoke Node
  script requires zero changes in the daemon or extension.

All three run locally. Knowledge base is a local directory
(`~/.twitter-helper/kb/` by default). No cloud.

## Quickstart

Requires **Node.js ≥ 20** and **npm ≥ 10** (npm workspaces).

```bash
# 1. Install all workspace dependencies
npm install

# 2. Boot the daemon (Fastify 5.x, port 53827 by default; override via PORT)
npm --workspace @twitter-helper/daemon run dev

# 3. In another shell, probe health
curl -s http://localhost:53827/health
# → {"status":"ok","version":"0.1.0"}
```

For the full flow — load the extension, point your agent at a KB, run
discovery, complete a reply cycle — see
[`docs/getting-started.md`](./docs/getting-started.md).

### Repo-wide scripts

```bash
npm test           # vitest across workspaces with coverage
npm run typecheck  # tsc --noEmit across workspaces
npm run build      # per-workspace build
npm run test:e2e   # extension E2E suite (Playwright + real daemon + unpacked extension)
```

## Workspace layout

```
packages/
  daemon/       # Fastify service — /candidates, /suggestion, /action, /config
  extension/    # Chrome MV3 extension (Dock, Popup, content scripts)
  agent-kit/    # Agent HTTP client + Candidate schema (CP09)
  sample-kb/    # Example knowledge base (tone.md + library)
```

## Manual QA against real twitter.com

_This is a manual checklist — **not gated in CI**._ The automated E2E suite
runs against a localhost fixture (see `packages/extension/test/e2e/full-pipeline.spec.ts`)
so it is deterministic, hermetic, and fast. Real twitter.com / x.com DOM can
change without warning; before shipping a release, a developer should run
this short script once by hand and capture a screenshot.

Run once before shipping:

1. Start the daemon (`npm --workspace @twitter-helper/daemon run dev`).
2. Build + load the extension unpacked in Chrome
   (`npm --workspace @twitter-helper/extension run build` → `chrome://extensions`
   → *Load unpacked* → `packages/extension/dist/`).
3. Log in to **twitter.com** (or **x.com**) in that Chrome profile.
4. Run the discover skill with a small `~/.twitter-helper/kb/tone.md`.
5. Open the extension popup — assert at least one candidate is listed.
6. Click a candidate — it opens the tweet in a new tab.
7. Assert the Dock appears at the right edge of the tweet page.
8. Click ✍️ — assert the native composer fills with the suggested text **and**
   Twitter's Tweet button flips from disabled → enabled.
9. Capture a screenshot and save it as `docs/manual-qa/<YYYY-MM-DD>.png`
   (at least one screenshot per release). A reference capture from the
   automated fixture is at [`docs/manual-qa/example.png`](./docs/manual-qa/example.png).
10. Submit the reply manually.

⚠️ **Known gaps:** twitter.com's DOM can change without notice; this
checklist is intentionally lightweight. The localhost fixture E2E covers
the happy path deterministically; this script covers *only* the
real-DOM contract. A nightly smoke against real twitter.com is
deliberately out of scope for this release (tracked as future work;
see spec Open Question #4).
