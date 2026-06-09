#!/usr/bin/env bash
# launch-chrome.sh — boot Chrome with the Wingman-X profile + remote
# debugging port so the agent-kit CDP scripts (scrape-x-home.ts, etc.) can
# attach to a real, cookied session.
#
# Reads CHROME_EXECUTABLE / CHROME_PROFILE_DIR / CHROME_REMOTE_DEBUGGING_PORT
# from .env and .env.local (same hierarchy as scripts/load-env.mjs).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Real env > .env.local > .env. Source dotenv files in
# lowest-priority-first order, then restore values that were already set by
# the caller's shell so one-off overrides keep winning.
ENV_KEYS=()

remember_env_keys() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  local line key seen set_var value_var existing
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*= ]] || continue
    key="${BASH_REMATCH[2]}"
    seen=0
    for existing in ${ENV_KEYS[@]+"${ENV_KEYS[@]}"}; do
      if [[ "$existing" == "$key" ]]; then
        seen=1
        break
      fi
    done
    [[ "$seen" == "1" ]] && continue

    ENV_KEYS+=("$key")
    set_var="__TWH_ORIG_SET_${key}"
    value_var="__TWH_ORIG_VALUE_${key}"
    if [[ -z "${!key+x}" ]]; then
      printf -v "$set_var" '%s' "0"
    else
      printf -v "$set_var" '%s' "1"
      printf -v "$value_var" '%s' "${!key}"
    fi
  done < "$f"
}

load_envfile() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  # shellcheck disable=SC1090
  set -a
  source "$f"
  set +a
}

restore_real_env_overrides() {
  local key set_var value_var
  for key in ${ENV_KEYS[@]+"${ENV_KEYS[@]}"}; do
    set_var="__TWH_ORIG_SET_${key}"
    value_var="__TWH_ORIG_VALUE_${key}"
    if [[ "${!set_var}" == "1" ]]; then
      export "$key=${!value_var}"
    fi
    unset "$set_var" "$value_var"
  done
}

remember_env_keys "$REPO_ROOT/.env"
remember_env_keys "$REPO_ROOT/.env.local"
load_envfile "$REPO_ROOT/.env"
load_envfile "$REPO_ROOT/.env.local"
restore_real_env_overrides

CHROME_EXECUTABLE="${CHROME_EXECUTABLE:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
CHROME_PROFILE_DIR="${CHROME_PROFILE_DIR:-$HOME/.wingman-x/chrome-profile}"
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
if curl -s --max-time 1 "http://127.0.0.1:${CHROME_REMOTE_DEBUGGING_PORT}/json/version" >/dev/null 2>&1; then
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
