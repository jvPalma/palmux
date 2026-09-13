#!/usr/bin/env bash
# ── palmux — dev (hot reload) ─────────────────────────────────────────────────
# Runs both dev servers in the foreground: server on :44040 (tsx watch) + client
# on :5173 (vite, proxies /ws,/auth,... to :44040). Ctrl+C stops both.
#
# Refuses to start if :44040 is already taken (the prod service or a supervised
# instance) — dev's tsx-watch binds the same port. Free it first: ./scripts/stop.sh
set -uo pipefail

# Resolve through symlinks: a script linked into ~/.local/bin would
# otherwise take that directory as the repo and look for the repo's
# files one level above it.
_pmx_self="${BASH_SOURCE[0]}"
while [ -L "$_pmx_self" ]; do
  _pmx_dir="$(cd "$(dirname "$_pmx_self")" && pwd)"
  _pmx_self="$(readlink "$_pmx_self")"
  case "$_pmx_self" in /*) ;; *) _pmx_self="$_pmx_dir/$_pmx_self" ;; esac
done
REPO="$(cd "$(dirname "$_pmx_self")/.." && pwd)"
# This is the one script without `set -e` — it must reach its trap — so the cd
# is checked by hand. Without it a failed cd runs both dev servers in whatever
# directory the caller happened to be in.
cd "$REPO" || exit 1
# shellcheck source=scripts/palmux-env.sh
. "$REPO/scripts/palmux-env.sh"

if palmux_serving; then
  echo "palmux dev: :$PALMUX_PORT is already serving — run ./scripts/stop.sh first" >&2
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
