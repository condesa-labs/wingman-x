# Getting Started — Twitter Helper

End-to-end walkthrough: from a fresh clone to your first agent-drafted,
human-reviewed reply filled into Twitter's native composer.

> Twitter Helper is deliberately split into three local components:
> a **daemon** (Node service), a **Chrome extension**, and an **agent kit**
> any MCP-capable LLM host (Claude Code / Codex / Gemini CLI / …) can drive.
> Nothing talks to the cloud — the knowledge base is a local directory.

---

## Prerequisites

- **Node.js ≥ 20** (see `engines` in the root `package.json`).
- **npm ≥ 10** — the repo uses npm workspaces.
- **Chrome or a Chromium-based browser** (Brave / Edge / Chromium are fine).
  Manifest V3 is required; anything from late 2023 onwards qualifies.
- **An MCP-capable LLM agent host** with a browser-automation MCP:
  - Claude Code **or** OpenAI Codex CLI **or** Gemini CLI (any MCP host).
  - `chrome-devtools` MCP (primary) or Playwright MCP (equivalent fallback).
- **A Twitter / X account** logged in inside the Chrome profile you'll use
  for the extension. Logging in is a one-time manual action outside the
  agent's scope.

---

## Install

```bash
git clone <your-fork-of-this-repo> chrome-twitter-helper
cd chrome-twitter-helper
npm install
```

`npm install` bootstraps every workspace (`daemon`, `extension`,
`agent-kit`, `sample-kb`) in one pass.

---

## 1. Start the daemon

The daemon is the only component that persists state; the extension and
the agent both talk to it over HTTP on localhost.

```bash
npm --workspace @twitter-helper/daemon run dev
```

You should see a line like:

```
[daemon] listening on port 53827
```

The daemon tries `53827` first and auto-bumps to the next free port in
the range `53827..53836` (useful when multiple dev instances overlap).
The extension's background service worker discovers whichever port is
live by probing the same range.

State (candidates, dismissed IDs, config) lives under
`~/.twitter-helper/` by default. Override with the `TWITTER_HELPER_STATE_DIR`
environment variable if you'd rather use a scratch directory.

Leave this process running in its own terminal.

---

## 2. Load the extension in Chrome

```bash
# In a second terminal
npm --workspace @twitter-helper/extension run build
```

That compiles `packages/extension/src/**` into `packages/extension/dist/`.

Then, in Chrome:

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and pick
   `packages/extension/dist/` from this repo.
4. You should see **Twitter Helper** in the list with a Service Worker
   status of "active". No icon badge appears until the daemon replies
   with at least one candidate.

Re-building the extension does not auto-reload the unpacked install —
hit the ↻ icon on the extension card after every `npm run build`.

---

## 3. Point your agent at the knowledge base

The agent reads one local directory to learn your voice and reply
heuristics:

```bash
mkdir -p ~/.twitter-helper/kb
cp -R packages/sample-kb/* ~/.twitter-helper/kb/
```

Then tailor `~/.twitter-helper/kb/tone.md` to match how you actually
reply (examples, phrases to avoid, go-to analogies, length targets,
etc.). The richer this file, the less generic the drafts will be.

`packages/sample-kb/library/*.md` shows the kind of topical notes the
agent will surface when deciding *what* to reply about.

The agent discovers the KB directory via the daemon's `GET /config`
endpoint (`kb_dir` field). No hard-coded paths.

---

## 4. Run discovery

Discovery is the agent-side loop: browse the feed, pick candidates,
draft voice-matched replies, POST them to the daemon. The exact
invocation depends on which MCP host you're using.

**Claude Code (reference implementation):**

```
/discover-twitter-candidates
```

The ready-made skill is at
[`.claude/skills/discover-twitter-candidates/SKILL.md`](../.claude/skills/discover-twitter-candidates/SKILL.md).

**Codex CLI / Gemini CLI / any other MCP host:**

Follow [`docs/agent-workflow.md`](./agent-workflow.md) step-by-step.
The workflow doc is intentionally agent-agnostic — every hosts talks
to the daemon through the same `@twitter-helper/agent-kit` TypeScript
client, so the prompt structure and tool calls are identical.

When discovery completes, the agent will have POSTed one or more
candidates to `POST /candidates`. Each candidate includes a
`tweet_id`, `tweet_url`, `match_reason`, and a drafted
`suggested_reply`. The daemon persists them under the configured
state directory.

---

## 5. Complete one reply cycle

1. **Click the Twitter Helper extension icon** (or the pinned
   browser-action). The popup lists every candidate the daemon
   currently holds, with a category pill (🟩 selected, 🟥 dismissed).
2. **Click a candidate card** — the popup opens the tweet in a new
   Chrome tab.
3. **Wait for the Dock** — a thin vertical widget docks to the right
   edge of the tweet-detail page. It holds 7 icons: ✍️ (fill), ♻️
   (regenerate), 💾 (save), 🗑️ (dismiss), plus three state/info icons.
4. **Click ✍️** — the extension writes `suggested_reply` into
   Twitter's native `data-testid="tweetTextarea_0"` composer using a
   React-compatible insertion (`InputEvent` dispatch). Twitter's
   Tweet button flips from disabled → enabled, matching the
   behaviour of a human typing.
5. **Edit if you want**, then **press Twitter's Tweet button
   yourself**. The extension deliberately never submits — the human
   is always the one who decides to ship.

At any point you can:

- Click 🗑️ to dismiss a candidate — the daemon records the action
  and the popup card drops out of the "selected" list.
- Click ♻️ to ask the agent to regenerate a draft (the extension
  POSTs `action=regen_requested`; the agent notices on its next
  poll and produces a new `suggested_reply`).

---

## Troubleshooting

- **"Daemon unreachable" in the popup** — the daemon isn't listening on
  `53827..53836`. Confirm the terminal from step 1 is still running
  and no other process is holding those ports (`lsof -i :53827`).
- **Dock never appears on a tweet page** — check the extension's
  service-worker console (`chrome://extensions` → *Service Worker*)
  for errors. Confirm the URL is in the form
  `/<handle>/status/<id>`; the content script only matches
  `twitter.com/*\/status\/*`, `x.com/*\/status\/*`, and
  `localhost/*\/status\/*`.
- **✍️ fills the composer but Twitter's Tweet button stays disabled** —
  this usually means Twitter updated their composer markup. Re-run
  the manual QA checklist in the root `README.md`. The content
  script's fill helper must dispatch the same event sequence React
  observes; tweaks live in
  `packages/extension/src/content/fill-reply.ts`.
- **Agent says "no candidates matched"** — check your `tone.md` isn't
  too narrow. The agent filters aggressively on purpose; loosen the
  "avoid" list and broaden the examples.

---

## Where to go next

- [`docs/agent-workflow.md`](./agent-workflow.md) — the agent's
  side of the contract (MCP tools, prompt structure, expected
  POST shapes).
- [`packages/agent-kit/src/client.ts`](../packages/agent-kit/src/client.ts)
  — the typed HTTP client any agent uses. Read the types to
  understand the wire protocol.
- Root [`README.md`](../README.md) — includes a **Manual QA
  against real twitter.com** checklist to run once before
  shipping a release. That checklist is intentionally
  developer-driven and not gated in CI.
