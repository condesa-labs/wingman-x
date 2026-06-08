# Getting Started — Wingman-X

End-to-end walkthrough: from a fresh clone to your first AI-drafted,
human-reviewed reply filled into Twitter's native composer.

> Wingman-X is deliberately split into three local components:
> a **daemon** (Node service), a **Chrome extension**, and an **agent kit**
> any MCP-capable LLM host (Claude Code / Codex / Gemini CLI / …) can drive.
> Nothing talks to the cloud — the knowledge base is a local directory
> (or any other source you wire up through the adapter contract).

---

## How the pieces fit together

Before installing anything, it helps to see what each step is wiring up.
The whole system runs on your own machine; there is no Wingman-X server:

```
                           +------------------------+
                           |  Knowledge base (KB)   |
                           |  -- your voice + topics |
                           |  default: ~/.wingman-x/kb |
                           |  (an Obsidian vault, a  |
                           |   Notion mirror, a feishu|
                           |   export — anything an   |
                           |   adapter can read)      |
                           +-----------+------------+
                                       |
                                       | KBAdapter contract
                                       v
+----------------+   HTTP (53827)   +--------+   MCP / tool calls
|  Extension     | <--------------> | daemon | <-------------------+
|  (Chrome MV3,  |                  | (Node) |                     |
|   content +    |                  +--------+                     |
|   popup +      |                       ^                         |
|   service-     |                       | HTTP (agent-kit client) |
|   worker)      |                       |                         |
+-------+--------+                       |                         |
        |                          +-----+-------------+           |
        v                          |    Your agent     | <---------+
   twitter.com / x.com             |  (Claude Code,    |
   composer fill                   |   Codex CLI,      |
                                   |   Gemini CLI, …)  |
                                   +-------------------+
```

- **Daemon** — persistent local Node service; the *only* component
  that stores state (candidates, dismissed IDs, config). Listens on
  ports `53827..53836`.
- **Extension** — Chrome MV3 extension. The popup shows candidates;
  the content script docks a widget onto each tweet page and fills
  drafts into Twitter's native composer.
- **Agent** — any MCP-capable LLM host. Reads your knowledge base,
  drafts voice-matched replies, POSTs them to the daemon. Plug in
  Claude Code, Codex CLI, Gemini CLI, or any host that can call
  `@wingman-x/agent-kit`.
- **Knowledge base** — *not* a fixed directory. It is whatever an
  adapter exposes. The shipped default reads markdown from a local
  folder, so an Obsidian vault works out-of-the-box. Notion / Feishu
  / Confluence / your own CMS can plug in by implementing the
  `KBAdapter` contract — see [§3 below](#3-point-your-agent-at-the-knowledge-base).

The install steps below bring up each of these in order: daemon, then
extension, then KB, then agent.

---

## Prerequisites

Wingman-X is currently documented for **macOS**. You need four things
on the machine before cloning the repo. Install with [Homebrew](https://brew.sh):

### Required toolchain

```bash
brew install node@20                       # Node.js ≥ 20 (also brings npm ≥ 10)
xcode-select --install                     # git (and other Xcode CLT)
brew install --cask google-chrome          # or `chromium` / `brave-browser` — any MV3-capable Chromium
```

> `node@20` is keg-only; if `node --version` does not pick it up,
> follow the post-install hint Homebrew prints (`brew link node@20`
> or add it to your `PATH`). If you prefer a version manager, use
> [nvm](https://github.com/nvm-sh/nvm) (`nvm install 20 && nvm use 20`).

Sanity-check the versions:

```bash
node --version    # v20.x.x or newer
npm --version     # 10.x.x or newer
git --version
```

### MCP agent host (pick one)

The agent side is intentionally pluggable. Install **one** of:

- **[Claude Code](https://claude.com/claude-code)** *(reference host; the repo ships a slash-command for this)*
- **[OpenAI Codex CLI](https://github.com/openai/codex)**
- **[Gemini CLI](https://github.com/google-gemini/gemini-cli)**
- … or anything else that speaks MCP.

Each host needs a **browser-automation MCP** registered:
`chrome-devtools` MCP is the primary; Playwright MCP is an equivalent
fallback. Follow your host's docs to add the MCP — Wingman-X does not
care which one, only that *some* MCP can drive a Chrome window.

### Twitter / X account

A working Twitter / X account, **already logged in** inside the Chrome
profile you will hand the extension. Logging in is a one-time manual
action that sits outside the agent's scope — the agent never types
passwords.

---

## Install the workspace

Once the prerequisites above are in place, the actual install is one
command:

```bash
git clone <your-fork-of-this-repo> wingman-x
cd wingman-x
npm install
```

`npm install` bootstraps every workspace (`daemon`, `extension`,
`agent-kit`, `sample-kb`, `adapter-fs`, `adapter-obsidian`,
`kb-contract`) in one pass.

---

## 1. Start the daemon

The daemon is the only component that persists state; the extension and
the agent both talk to it over HTTP on localhost.

```bash
npm --workspace @wingman-x/daemon run dev
```

You should see a line like:

```
[daemon] listening on port 53827
```

The daemon tries `53827` first and auto-bumps to the next free port in
the range `53827..53836` (useful when multiple dev instances overlap).
The extension's background service worker discovers whichever port is
live by probing the same range.

State (candidates, dismissed IDs, daemon config) lives under
`~/.wingman-x/` by default — the same directory the knowledge-base
layer uses, so daemon state and KB cache sit side-by-side. Override
the location with the `WINGMAN_X_STATE_DIR` environment variable if
you'd rather use a scratch directory; the value is shared with the
KB layer, so a single env controls both.

Leave this process running in its own terminal.

---

## 2. Load the extension in Chrome

```bash
# In a second terminal
npm --workspace @wingman-x/extension run build
```

That compiles `packages/extension/src/**` into `packages/extension/dist/`.

Then, in Chrome:

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and pick
   `packages/extension/dist/` from this repo.
4. You should see **Wingman-X** in the list with a Service Worker
   status of "active". No icon badge appears until the daemon replies
   with at least one candidate.

Re-building the extension does not auto-reload the unpacked install —
hit the ↻ icon on the extension card after every `npm run build`.

---

## 3. Point your agent at the knowledge base

The knowledge base (KB) is *the* thing that makes the drafts sound like
**you** and not like a generic assistant. The agent reads it on every
discovery loop to learn:

- **Your voice** — a `tone.md` file with examples, phrases to avoid,
  go-to analogies, and length targets.
- **Your topics** — a `library/` of opinionated notes the agent uses
  to decide *what* to reply about and *what stance* to take.
- **Your handles** — an optional `handles.md` listing accounts the
  agent should preferentially watch.

### KB is pluggable — pick a source

Wingman-X does **not** lock you into one format. The agent talks to KB
through a small adapter contract (`KBAdapter`, defined in
[`packages/wingman-x-kb-contract`](../packages/wingman-x-kb-contract)).
The repo ships two reference adapters; community adapters are welcome:

| Adapter | Reads from | Status |
|--|--|--|
| `@wingman-x/adapter-fs` | A local directory of markdown files (`tone.md`, `library/*.md`, optional `handles.md`) | **Shipped** (default fallback) |
| `@wingman-x/adapter-obsidian` | An Obsidian vault, with configurable file/folder names and optional wiki-link following | **Shipped** |
| `@wingman-x/adapter-notion` | A Notion database / page tree | **Wanted — open for PRs** |
| `@wingman-x/adapter-feishu` | A Feishu (Lark) wiki space or document | **Wanted — open for PRs** |

Pick the option that matches where your voice notes already live:

### Option A — quickest start (FS adapter, sample content)

For your first run, copy the sample KB so you have something to edit:

```bash
mkdir -p ~/.wingman-x/kb
cp -R packages/sample-kb/* ~/.wingman-x/kb/
```

This uses every default: FS adapter, `rootPath` = `~/.wingman-x/kb`,
no `~/.wingman-x/config.json` needed. Tailor `~/.wingman-x/kb/tone.md`
to match how you actually reply. The richer this file, the less
generic the drafts will be.

### Option B — wire up your Obsidian vault (Obsidian adapter)

If you already keep voice notes / library entries inside an Obsidian
vault, use the bundled Obsidian adapter so you get vault-aware
behaviour (custom file/folder names, optional wiki-link following):

```bash
mkdir -p ~/.wingman-x
cat > ~/.wingman-x/config.json <<'JSON'
{
  "version": 1,
  "adapter": {
    "package": "@wingman-x/adapter-obsidian",
    "name": "adapter-obsidian",
    "config": {
      "vaultPath": "/Users/you/Obsidian/MyVault",
      "wingmanRoot": "WingmanX",
      "toneFile": "VOICE.md",
      "libraryFolder": "library",
      "handlesFile": "handles.md",
      "followObsidianLinks": false
    }
  },
  "cache": {
    "ttlSeconds": 900,
    "strategy": "stale-while-revalidate"
  }
}
JSON
```

Inside `<vaultPath>/<wingmanRoot>/` (e.g.
`/Users/you/Obsidian/MyVault/WingmanX/`), create:

- `VOICE.md` — your tone guide (the file name comes from `toneFile`).
- `library/` — one markdown file per topical stance you want the
  agent to draw on.
- `handles.md` — optional, the agent's preferred handles list.

`wingmanRoot`, `toneFile`, `libraryFolder`, and `handlesFile` all
have sensible defaults; you can omit them from the config if you
follow the convention above. Set `followObsidianLinks: true` if you
want the adapter to walk `[[wikilinks]]` while reading; default is
`false` to keep the read scope predictable.

> **Don't want vault-aware behaviour?** You can also point the FS
> adapter (Option A) at any subfolder of your vault by setting
> `"adapter.package": "@wingman-x/adapter-fs"` and
> `"config.rootPath": "/path/to/vault/subfolder"`. That treats the
> folder as plain markdown — wiki-links and properties are ignored
> but won't break anything.

### Option C — bring your own adapter (Notion / Feishu / Confluence / …)

The contract is small. Any package that exports:

```ts
export const configSchema: ZodType<YourConfig>;
export function createAdapter(cfg: YourConfig): KBAdapter;
```

…where `KBAdapter` implements `getTone()`, `listLibrary()`,
`getLibraryEntry(id)`, `getHandles()`, and `healthCheck()` (see
[`packages/wingman-x-kb-contract/src/index.ts`](../packages/wingman-x-kb-contract/src/index.ts))
can be slotted in by changing the `adapter.package` field in
`~/.wingman-x/config.json`. The loader resolves the package via
standard Node `import()`, so an adapter can live in this monorepo
*or* on npm *or* via `npm link`.

`packages/wingman-x-adapter-fs/` is the smallest end-to-end reference
implementation — start by reading it, then fork the layout for your
source of truth. PRs adding adapters to the table above are very
welcome.

### How the daemon and agent discover the KB

There is no hard-coded path baked into the daemon or the extension.
The chain is:

1. `~/.wingman-x/config.json` (optional) declares which adapter
   package to load and what config to hand it.
2. The agent-side `createKBLoader()` reads that file, imports the
   adapter package, validates the inner config with the adapter's
   own `configSchema`, and starts serving cached reads from
   `~/.wingman-x/cache/<adapter-name>/`.
3. The agent uses the loader (via `@wingman-x/agent-kit`) to fetch
   tone / library / handles whenever it drafts a reply.

If the config file does not exist, the loader falls back to the FS
adapter at `~/.wingman-x/kb/` — which is what Option A relies on.

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
to the daemon through the same `@wingman-x/agent-kit` TypeScript
client, so the prompt structure and tool calls are identical.

When discovery completes, the agent will have POSTed one or more
candidates to `POST /candidates`. Each candidate includes a
`tweet_id`, `tweet_url`, `match_reason`, and a drafted
`suggested_reply`. The daemon persists them under the configured
state directory.

---

## 5. Complete one reply cycle

1. **Click the Wingman-X extension icon** (or the pinned
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
