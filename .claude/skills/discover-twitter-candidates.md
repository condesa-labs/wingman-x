---
description: Discover Twitter candidates and draft voice-matched replies using the user's ~/.twitter-helper/kb/ tone + library, then POST them to the local daemon via @twitter-helper/agent-kit.
---

# Discover Twitter Candidates

Follow the instructions in [../../docs/agent-workflow.md](../../docs/agent-workflow.md).

## Scope

- Load `~/.twitter-helper/kb/tone.md` and `~/.twitter-helper/kb/library/**`.
- Use the `chrome-devtools` MCP (Playwright MCP is an acceptable
  alternative) to navigate an already-logged-in `x.com/home` session.
- Generate 3–10 candidate replies per invocation. Bounded scroll window.
- POST via the daemon-client exported from `@twitter-helper/agent-kit`
  (`createDaemonClient(port).postCandidates([...])`).

## Output

Each run ends with a single call to
`createDaemonClient(port).postCandidates([...])` using the exact
`Candidate` shape documented in
[`docs/agent-workflow.md#candidate-json-shape`](../../docs/agent-workflow.md#candidate-json-shape).

## Failure Handling

On login gate, rate limit, DOM churn, or unreachable daemon: follow the
recovery strategy in
[`docs/agent-workflow.md#failure-modes`](../../docs/agent-workflow.md#failure-modes)
and surface the failure class to the user. Do **not** auto-retry within a
single run.
