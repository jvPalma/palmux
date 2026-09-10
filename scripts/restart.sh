#!/usr/bin/env bash
# ── palmux — restart ──────────────────────────────────────────────────────────
# systemd restart where it owns palmux; otherwise stop + start the supervised
# runtime (a short pause lets the port free before scripts/start.sh's serving check).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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
