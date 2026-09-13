#!/usr/bin/env bash
# ── palmux — stop ─────────────────────────────────────────────────────────────
# Mirror of scripts/start.sh: hand off to systemd where it owns palmux, otherwise take
# down the supervised process group started by ./scripts/start.sh (with a repo-scoped
# pkill fallback so an orphaned server/supervisor is still reaped).
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
  echo "palmux: stopping systemd unit"
  systemctl --user stop palmux.service
  exit 0
fi

PIDFILE="$REPO/palmux.pid"
stopped=0

# The pid file OUTLIVES the process it names — a crash or a power cut leaves it
# behind, and Linux hands pids out again from a low number after a reboot. So the
# recorded pid is only a CANDIDATE: confirm it is still one of ours before
# signalling it, the same repo-scoping the pkill fallback below already applies.
# Measured: without this, a stale pid file pointed at an unrelated `sleep` and
# stop.sh killed it and reported "palmux: stopped".
palmux_owns_pid() {
  [ -r "/proc/$1/cmdline" ] || return 1
  tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null | grep -qF "$REPO"
}

if [ -f "$PIDFILE" ]; then
  pgid="$(cat "$PIDFILE" 2>/dev/null || true)"
  case "${pgid:-}" in
    '' | *[!0-9]*) pgid='' ;; # empty or not a plain number: nothing to signal
  esac
  if [ -n "$pgid" ] && palmux_owns_pid "$pgid"; then
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
