# Agent Workflow

This document tells **any MCP-capable agent** (Claude Code, Codex, Gemini CLI,
another host) how to discover Twitter candidate tweets, draft voice-matched
replies using the user's knowledge base, and POST the results to the local
daemon. The reference implementation lives at
[`.claude/skills/discover-twitter-candidates/SKILL.md`](../.claude/skills/discover-twitter-candidates/SKILL.md).

The companion TypeScript HTTP client is `@twitter-helper/agent-kit`
(`packages/agent-kit`). Everything on this page describes behaviour the agent
must produce; the client handles the wire protocol.

---

## MCP Tool Requirements

The agent must run inside an MCP host that provides a browser-automation MCP.

- **Primary: `chrome-devtools` MCP** — required. The agent drives a real
  Chromium instance to open Twitter / X, scroll the feed, extract tweet cards,
  and read per-tweet text. The core tool calls used are:
  - `navigate_page` to land on `https://x.com/home`
  - `take_snapshot` / `evaluate_script` to pull tweet DOM nodes
  - `scroll` / `press_key` to advance a bounded feed window
- **Alternative: Playwright MCP** — equivalent feature set and acceptable if
  the host offers it instead. Anywhere this document mentions
  `chrome-devtools`, the Playwright MCP equivalent is a valid substitute.

The agent assumes the browser is **already logged in** to Twitter in the
controlled profile. Logging in is a one-time user action outside the agent's
scope.

Network access is also needed so the agent's HTTP client (agent-kit) can reach
`http://localhost:<daemon-port>`. The daemon binds in the 53827..53836 range;
the agent resolves the active port by calling `GET /health` on each port in
order (or, if it knows the port from an earlier run, reads it from
`GET /config`).

---

## Step Sequence (discover → generate → POST)

1. **Load the tone + KB** from `~/.twitter-helper/kb/` (see
   [Tone + KB Loading Pattern](#tone--kb-loading-pattern) below). This
   defines the voice + topical hooks the agent uses while drafting replies.
2. **Discover the daemon port.** Probe `GET http://localhost:<port>/health`
   for `port ∈ 53827..53836`. The first port returning `{status: "ok"}` is
   live. Pass that port to `createDaemonClient(port)`.
   Also fetch any pending pull-signals:
   `client.listSignals({ kind: "discovery_requested", status: "pending" })`.
   Remember the returned IDs; you'll ack them after a successful POST
   in step 7. See [Pull-signal protocol](#pull-signal-protocol) below
   for the full rules.
3. **Open the feed.** Use the browser MCP to `navigate_page` to
   `https://x.com/home` and wait for the timeline to render.
4. **Collect tweet candidates.** Run a bounded scroll window (e.g. 20 scroll
   steps max, 30 tweets max) and extract a list of
   `{tweet_id, tweet_url, author_handle, tweet_text}` tuples via
   `evaluate_script` on the tweet article DOM. Deduplicate by `tweet_id`.
5. **Score + draft replies.** For each tweet, check whether it matches any
   KB topic / selected handle / explicit trending cue. For matches, draft a
   reply using the tone guide and the most relevant `library/*.md` excerpts.
   Reject anything over 280 characters or that quotes PII.
6. **POST to the daemon.** Call
   `createDaemonClient(port).postCandidates([ ... ])` with the batch. The
   daemon returns `{ accepted: N }`. Surface the count to the user.
7. **Ack pulled signals.** For each signal id captured in step 2, call
   `client.ackSignal(id)`. This transitions the signal from `pending`
   to `acked` and leaves a timestamped audit trail in `state.json`.
   Ack every run, including zero-candidate runs and degraded scraper
   runs, so the queue does not hot-loop on the same request forever. The
   user can click **Request discovery** again to retry.
8. **Stop.** The MVP is explicit-invocation only — the agent does not idle
   or poll. The user reviews the candidates in the extension popup / Dock
   and explicitly accepts / dismisses each one.

Minimum viable run: ≥ 3, ≤ 10 candidates per invocation. Push more only if
the user explicitly asks.

---

## Pull-signal protocol

The extension's popup has a **Request discovery** button. Clicking it
POSTs a pull-signal to the daemon:

```http
POST /signals { "kind": "discovery_requested" }
→ Signal { id, kind, status: "pending", created_at }
```

Signals are **priority hints**, not gates — an agent should run discovery
on every invocation regardless, and use signal presence to decide whether
to scan wider (more Tier-2 handles, deeper scroll) when the user has
explicitly asked.

### Agent obligations

- **On start:** `client.listSignals({ kind: "discovery_requested",
  status: "pending" })`. Remember the IDs.
- **After the discovery run finishes:** ack each ID via `client.ackSignal(id)`.
  Ack is idempotent — re-acking is a no-op and returns the existing record.
- **On zero-candidate runs:** ack anyway. Leaving a degraded run
  `pending` can hot-loop the discovery queue. The user re-clicks
  **Request discovery** to retry.
- **Do not poll.** Signals are checked exactly once per invocation, in
  step 2.

### Signal lifecycle

```text
POST /signals → status="pending", created_at set
POST /signals/:id/ack → status="acked", acked_at set, permanently retained
```

Acked signals stay in `state.json` as an audit log of when a request
was made vs. when the agent serviced it. If this grows unboundedly
across long-lived installs, a future cleanup task can prune records
where `status="acked" AND acked_at < now - 30d`; not in scope for the
MVP.

### Alternative agent hosts

Any host consuming `@twitter-helper/agent-kit` gets `listSignals` /
`ackSignal` / `postSignal` from the returned `DaemonClient`. Hosts
without the client can call the endpoints directly with any HTTP
library — the schemas are documented in
`packages/daemon/src/schemas.ts` (`SignalSchema`, `SignalInputSchema`,
`SignalsQuerySchema`).

---

## Candidate JSON Shape

This matches the daemon's `Candidate` schema exactly (see
`packages/daemon/src/schemas.ts` and `packages/agent-kit/src/candidate.ts`).

```ts
interface Candidate {
  /** uuid assigned by the agent (not Twitter's id) */
  id: string;
  /** Twitter / X tweet id, used as the merge key server-side */
  tweet_id: string;
  /** canonical https://x.com/<user>/status/<id> */
  tweet_url: string;
  /** e.g. "@alice_ai" */
  author_handle: string;
  /** raw tweet body (short form) */
  tweet_text: string;
  /** ≤280 chars, voice-matched */
  suggested_reply: string;
  /** one-line why this was flagged */
  match_reason: string;
  /** how the agent decided it was worth replying to */
  match_category: "selected" | "topic" | "trending";
  /** relative paths of KB files that informed the reply */
  kb_refs: string[];
  /** ISO-8601, filled by the server if omitted on POST */
  created_at?: string;
  /** optional on POST; the server defaults to "pending" */
  status?: "pending" | "filled" | "dismissed" | "saved" | "regen_requested";
  status_updated_at?: string;
}
```

Example POST body:

```json
{
  "candidates": [
    {
      "id": "c1b2-...-9f",
      "tweet_id": "1790000000000000001",
      "tweet_url": "https://x.com/alice_ai/status/1790000000000000001",
      "author_handle": "@alice_ai",
      "tweet_text": "Hot take on agents.",
      "suggested_reply": "Agree — autonomy matters.",
      "match_reason": "matches topic:agents in KB",
      "match_category": "topic",
      "kb_refs": ["library/agents.md"]
    }
  ]
}
```

The server merges by `tweet_id` (latest-wins). Server-managed fields
(`created_at`, `status`, `status_updated_at`) are filled automatically if
omitted; supplying them is tolerated but the server will preserve the
existing `created_at` on a re-POST.

---

## Tone + KB Loading Pattern

The knowledge base lives at `~/.twitter-helper/kb/`:

```text
~/.twitter-helper/kb/
├── tone.md                   # free-form voice guide
└── library/
    ├── <topic-a>.md          # topical examples / quotes / links
    ├── <topic-b>.md
    └── …
```

- **`tone.md`** is the voice spec: diction, stance, what to avoid. The agent
  treats it as a system prompt and injects it into every drafting call.
- **`library/*.md`** are topical exemplars. Each file's first `# Heading` line
  is the topic label; the body is free-form. The agent scans all files once
  per run, indexes by heading, and retrieves the 1–3 most relevant files for
  each candidate tweet.

Loading happens via **direct filesystem reads** (no MCP needed): `readFile`
or the host's native file tool. The agent reads every file on start — these
are short (< 5 KB each typical) so there's no need for a vector DB.

If `~/.twitter-helper/kb/` is missing or empty, the agent emits a clear
user-facing message (`"KB directory missing — create ~/.twitter-helper/kb/
with tone.md + library/*.md before running discovery"`) and exits with a
non-zero status. The user bootstraps with the illustrative
`packages/sample-kb/` content.

Reference illustrative content:

- [`packages/sample-kb/tone.md`](../packages/sample-kb/tone.md)
- [`packages/sample-kb/library/topic-one.md`](../packages/sample-kb/library/topic-one.md)
- [`packages/sample-kb/library/topic-two.md`](../packages/sample-kb/library/topic-two.md)

---

## Failure Modes

Real-world runs fail. Each of the following has a concrete recovery. Agents
must surface the failure class to the user rather than silently retry.

### 1. Login gate

**Symptom.** `https://x.com/home` redirects to the login modal or to
`/i/flow/login`. The tweet article DOM never appears.

**Recovery.**
- Halt the run. Do **not** attempt to log in programmatically — the
  extension + daemon rely on the user's real, cookied session.
- Surface: `"Twitter login required — open x.com in the MCP-controlled
  browser, sign in once, then re-run discovery."`
- Exit non-zero. The user logs in manually and re-invokes the agent.

### 2. Rate limit / throttling

**Symptom.** Repeated scroll requests stop loading new tweets; Twitter's
UI shows a "Rate limit exceeded" toast, or the tweet endpoint returns
HTTP 429 in the network panel.

**Recovery.**
- Respect the bounded scroll window in step 4 — do NOT scroll indefinitely.
- On detection, the agent stops scraping, returns whatever candidates it
  has gathered so far (may be zero), and waits **at least 15 minutes**
  before the user re-invokes. The agent does not auto-retry within a run.
- Halve the per-run candidate quota on the next invocation after a
  rate-limit hit. This is purely client-side state — store a sentinel in
  `~/.twitter-helper/kb/.rate-limit-seen` (ISO-8601 timestamp) if needed.

### 3. DOM churn (Twitter changed its selectors)

**Symptom.** The tweet-extraction `evaluate_script` returns an empty list
even though the timeline clearly has tweets; or returns malformed tuples
(e.g. missing `tweet_id`).

**Recovery.**
- Have at least two fallback CSS selectors per field. Try them in order,
  record which one matched on success for the run report.
- If the extraction rate drops below 50% of the rendered tweets, halt with:
  `"Tweet extraction degraded (X/Y extracted) — Twitter likely changed its
  selectors. Update the MCP script."`
- Do NOT POST partial or malformed candidates to the daemon — an empty
  POST is better than a corrupt one (the extension will just show "no
  candidates yet").

### 4. Daemon unreachable (bonus)

**Symptom.** The agent-kit client throws `DaemonNetworkError` on every
port in `53827..53836`.

**Recovery.** Surface: `"Daemon not running — start it with
\`npm --workspace @twitter-helper/daemon run dev\`, then re-run."` Exit
non-zero.

### 5. Malformed Candidate rejected by daemon (bonus)

**Symptom.** `postCandidates` throws `DaemonHttpError` with `status === 400`.

**Recovery.** Log the `body.details` array from the 400 response (it lists
each zod violation). Fix the drafting template and retry the single run.
Do not loop.
