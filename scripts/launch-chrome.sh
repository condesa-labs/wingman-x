#!/usr/bin/env bash
# launch-chrome.sh — boot Chrome with the Twitter Helper profile + remote
# debugging port so the agent-kit CDP scripts (scrape-x-home.ts, etc.) can
# attach to a real, cookied session.
#
# Reads CHROME_EXECUTABLE / CHROME_PROFILE_DIR / CHROME_REMOTE_DEBUGGING_PORT
# from .env and .env.local (same hierarchy as scripts/load-env.mjs).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Real env > .env.local > .env. Source in lowest-priority-first order so
# later `source` calls only set vars that weren't already exported.
load_envfile() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  # shellcheck disable=SC1090
  set -a
  source "$f"
  set +a
}
load_envfile "$REPO_ROOT/.env"
load_envfile "$REPO_ROOT/.env.local"

CHROME_EXECUTABLE="${CHROME_EXECUTABLE:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
CHROME_PROFILE_DIR="${CHROME_PROFILE_DIR:-$HOME/.twitter-helper/chrome-profile}"
CHROME_REMOTE_DEBUGGING_PORT="${CHROME_REMOTE_DEBUGGING_PORT:-9223}"

# Expand $HOME in CHROME_PROFILE_DIR if the .env used $HOME literally.
CHROME_PROFILE_DIR="${CHROME_PROFILE_DIR/#\$HOME/$HOME}"
CHROME_PROFILE_DIR="${CHROME_PROFILE_DIR/#~/$HOME}"

if [[ ! -x "$CHROME_EXECUTABLE" ]]; then
  echo "error: CHROME_EXECUTABLE not executable: $CHROME_EXECUTABLE" >&2
  echo "       set CHROME_EXECUTABLE in .env to your Chrome/Chromium path" >&2
  exit 1
fi

# If something already listens on the target port, assume Chrome is up and
# exit successfully — re-launching would fail anyway with a second instance
# targeting the same user-data-dir.
if curl -s --max-time 1 "http://localhost:${CHROME_REMOTE_DEBUGGING_PORT}/json/version" >/dev/null 2>&1; then
  echo "chrome already listening on :${CHROME_REMOTE_DEBUGGING_PORT} — nothing to do"
  exit 0
fi

mkdir -p "$CHROME_PROFILE_DIR"

echo "launching Chrome"
echo "  executable: $CHROME_EXECUTABLE"
echo "  profile:    $CHROME_PROFILE_DIR"
echo "  debug port: $CHROME_REMOTE_DEBUGGING_PORT"

exec "$CHROME_EXECUTABLE" \
  --remote-debugging-port="$CHROME_REMOTE_DEBUGGING_PORT" \
  --user-data-dir="$CHROME_PROFILE_DIR" \
  "$@"
