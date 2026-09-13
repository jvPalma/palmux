#!/usr/bin/env bash
# ── palmux — restart ──────────────────────────────────────────────────────────
# systemd restart where it owns palmux; otherwise stop + start the supervised
# runtime (a short pause lets the port free before scripts/start.sh's serving check).
set -euo pipefail

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
cd "$REPO"
# shellcheck source=scripts/palmux-env.sh
. "$REPO/scripts/palmux-env.sh"

if palmux_systemd_managed; then
  echo "palmux: restarting systemd unit"
  systemctl --user restart palmux.service
  exit 0
fi

"$REPO/scripts/stop.sh"
sleep 1
"$REPO/scripts/start.sh"
