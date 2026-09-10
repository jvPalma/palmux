#!/usr/bin/env bash
# ── palmux — dev (hot reload) ─────────────────────────────────────────────────
# Runs both dev servers in the foreground: server on :44040 (tsx watch) + client
# on :5173 (vite, proxies /ws,/auth,... to :44040). Ctrl+C stops both.
#
# Refuses to start if :44040 is already taken (the prod service or a supervised
# instance) — dev's tsx-watch binds the same port. Free it first: ./stop.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO"
# shellcheck source=scripts/palmux-env.sh
. "$REPO/scripts/palmux-env.sh"

if palmux_serving; then
  echo "palmux dev: :$PALMUX_PORT is already serving — run ./stop.sh first" >&2
  exit 1
fi

echo "palmux dev: server :$PALMUX_PORT (tsx watch) + client :5173 (vite) — Ctrl+C to stop"
yarn dev:server &
srv=$!
yarn dev:client &
cli=$!

# Tear both down on exit/interrupt regardless of which one dies first.
trap 'kill "$srv" "$cli" 2>/dev/null' INT TERM EXIT
wait
