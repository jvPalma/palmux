#!/usr/bin/env bash
# ── palmux — stop ─────────────────────────────────────────────────────────────
# Mirror of scripts/start.sh: hand off to systemd where it owns palmux, otherwise take
# down the supervised process group started by ./scripts/start.sh (with a repo-scoped
# pkill fallback so an orphaned server/supervisor is still reaped).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
# shellcheck source=scripts/palmux-env.sh
. "$REPO/scripts/palmux-env.sh"

if palmux_systemd_managed; then
  echo "palmux: stopping systemd unit"
  systemctl --user stop palmux.service
  exit 0
fi

PIDFILE="$REPO/palmux.pid"
stopped=0

if [ -f "$PIDFILE" ]; then
  pgid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "${pgid:-}" ]; then
    # Negative PID = signal the whole process group (supervisor + server).
    if kill -TERM -- "-$pgid" 2>/dev/null; then stopped=1; fi
    if kill -TERM "$pgid" 2>/dev/null; then stopped=1; fi
  fi
  rm -f "$PIDFILE"
fi

# Fallback: reap anything from THIS checkout the pidfile missed.
for pat in \
  "$REPO/scripts/run.sh" \
  "$REPO/packages/server/src/index.ts" \
  "$REPO/bin/palmux.mjs"; do
  if pkill -f "$pat" 2>/dev/null; then stopped=1; fi
done

if [ "$stopped" -eq 1 ]; then
  echo "palmux: stopped"
else
  echo "palmux: nothing running (supervised) on this checkout"
fi
