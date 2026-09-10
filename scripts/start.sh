#!/usr/bin/env bash
# ── palmux — idempotent start ─────────────────────────────────────────────────
# Safe to call blindly at boot; all the "should I even start, and how?" logic
# lives here so a boot hook stays a dumb one-liner:
#
#     cd "$HOME/palmux" && ./scripts/start.sh >/dev/null 2>&1 &
#
# Decision tree:
#   1. systemd owns palmux here  → ensure the unit is up (idempotent), done.
#   2. something already serving → nothing to do.
#   3. otherwise                 → launch the supervised runtime (scripts/run.sh,
#                                  which prefers the bin/ bundle, falls back to tsx)
#                                  detached, so it outlives this shell.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
# shellcheck source=scripts/palmux-env.sh
. "$REPO/scripts/palmux-env.sh"

if palmux_systemd_managed; then
  echo "palmux: managed by systemd — ensuring the unit is up"
  systemctl --user start palmux.service
  exit 0
fi

if palmux_serving; then
  echo "palmux: already serving on :$PALMUX_PORT — nothing to do"
  exit 0
fi

NODE="$(palmux_node)"
if [ -z "$NODE" ]; then
  echo "palmux: node not found — install node (>=22) or set PATH/nvm" >&2
  exit 1
fi

PIDFILE="$REPO/palmux.pid"
echo "palmux: starting supervised runtime (node=$NODE)"
# setsid puts the supervisor in its own session/group so ./scripts/stop.sh can take the
# whole tree down cleanly; fall back to nohup where setsid is unavailable.
if command -v setsid >/dev/null 2>&1; then
  PALMUX_NODE="$NODE" setsid "$REPO/scripts/run.sh" >/dev/null 2>&1 </dev/null &
else
  PALMUX_NODE="$NODE" nohup "$REPO/scripts/run.sh" >/dev/null 2>&1 </dev/null &
fi
echo "$!" >"$PIDFILE"
echo "palmux: started (pid $(cat "$PIDFILE"), log $REPO/palmux.log)"
