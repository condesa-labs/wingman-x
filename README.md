# Chrome Twitter Helper

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
  `http://localhost:53827` (with auto-bump fallback, later). Holds the candidate
  pool and mediates all agent ↔ extension traffic.
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

## Status — Checkpoint 01

This checkpoint delivers only the **monorepo scaffold + daemon health probe**.
Everything else listed in the architecture above lands in later checkpoints
(CP02 adds the production endpoints + persistence; CP03+ adds the extension;
CP09 adds the agent kit; CP10 wires the end-to-end smoke test).

## Quickstart (CP01 scope)

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

### Repo-wide scripts

```bash
npm test         # vitest across workspaces with coverage
npm run typecheck  # tsc --noEmit across workspaces
npm run build      # per-workspace build (daemon only for now)
```

## Workspace layout

```
packages/
  daemon/       # Fastify service (CP01: /health only)
  extension/    # Chrome MV3 extension (stub; CP03+)
  agent-kit/    # Agent HTTP client + docs (stub; CP09)
  sample-kb/    # Example knowledge base (stub; CP09)
```
