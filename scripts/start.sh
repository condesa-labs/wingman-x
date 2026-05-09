#!/usr/bin/env bash
# start.sh — one-command dev startup for the Twitter Helper stack.
#
# Behaviour (decided 2026-05-08):
#   1. Pre-flight: Node ≥ 20, npm_modules fresh.
#   2. Build the extension once (so chrome://extensions reload picks it up).
#   3. Start the daemon in the background, log to .daemon.log.
#   4. Poll /health on the spec'd port range until daemon is ready.
#   5. Print the resolved port, then tail the log in the foreground.
#   6. Ctrl+C tears down the daemon cleanly via EXIT trap.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON_LOG="${REPO_ROOT}/.daemon.log"
DAEMON_PORT_MIN=53827
DAEMON_PORT_MAX=53836
HEALTH_TIMEOUT_SEC=15
DAEMON_PID=""

log()  { printf '\033[1;34m[start.sh]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[start.sh]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[start.sh]\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [[ -n "${DAEMON_PID}" ]] && kill -0 "${DAEMON_PID}" 2>/dev/null; then
    echo
    log "Stopping daemon (PID ${DAEMON_PID})…"
    kill "${DAEMON_PID}" 2>/dev/null || true
    wait "${DAEMON_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# ─── 1. Pre-flight ────────────────────────────────────────────────────────
node_major="$(node -v 2>/dev/null | sed -E 's/v([0-9]+)\..*/\1/')" || die "node not on PATH"
[[ "${node_major}" -ge 20 ]] || die "Node ≥ 20 required (have $(node -v))"

if [[ ! -d "${REPO_ROOT}/node_modules" ]] \
   || [[ "${REPO_ROOT}/package-lock.json" -nt "${REPO_ROOT}/node_modules" ]]; then
  log "node_modules missing or stale → running npm install (one-time)…"
  (cd "${REPO_ROOT}" && npm install)
fi

# ─── 2. Build extension ───────────────────────────────────────────────────
log "Building extension…"
(cd "${REPO_ROOT}" && npm --workspace @twitter-helper/extension run build --silent) \
  || die "extension build failed"

# ─── 3. Start daemon in background, log everything ───────────────────────
log "Starting daemon…"
: > "${DAEMON_LOG}"
(cd "${REPO_ROOT}" && npm --workspace @twitter-helper/daemon run dev) \
  > "${DAEMON_LOG}" 2>&1 &
DAEMON_PID=$!

# ─── 4. Wait for daemon to come up ────────────────────────────────────────
# detect_daemon_port: poll /health on ports 53827–53836 until one returns
# {"status":"ok",…} or HEALTH_TIMEOUT_SEC elapses. Echo the port to stdout
# on success; return non-zero on timeout.
#
# TODO Stometa: implement this function. Trade-offs to think about:
#
#   (a) Iteration order — scan the whole range each tick (faster detection
#       but louder), or stay on a single port until it answers (quieter, but
#       you might miss the daemon if it auto-bumped past your guess)?
#
#   (b) Sleep cadence — 250 ms (snappy) vs 1 s (gentle on the daemon's
#       startup)? Daemon usually binds in under 1 s, so 250–500 ms is fine.
#
#   (c) Use curl, nc, or parse DAEMON_LOG for the "listening on port N"
#       line? curl is the most honest signal (proves the HTTP layer
#       responds), but parsing the log is fastest. Daemon prints
#       "[daemon] listening on port N" — see packages/daemon/src/index.ts.
#
# Suggested signature:
#   detect_daemon_port() { ... echo "$port"; return 0; }
detect_daemon_port() {
  : # TODO: replace this no-op with your implementation
  return 1
}

if DAEMON_PORT="$(detect_daemon_port)"; then
  log "daemon ready on :${DAEMON_PORT}"
else
  warn "daemon did not become healthy within ${HEALTH_TIMEOUT_SEC}s. Last log lines:"
  tail -20 "${DAEMON_LOG}" >&2 || true
  die "giving up"
fi

# ─── 5. Tail logs in foreground (Ctrl+C → trap → daemon dies) ────────────
log "Tailing ${DAEMON_LOG} — press Ctrl+C to stop the daemon."
tail -f "${DAEMON_LOG}"
