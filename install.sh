#!/usr/bin/env bash
# ── palmux — first-time setup ─────────────────────────────────────────────────
# Installs deps and gets palmux runnable on this machine:
#   • systemd present  → install + enable the boot service (yarn service:install
#                        builds, generates the unit from THIS checkout, starts it).
#   • no systemd       → build the client so ./start.sh can run the supervised
#                        (tsx) path; add `cd <repo> && ./start.sh &` to a boot hook.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO"

echo "palmux: installing dependencies (yarn install)"
yarn install

if command -v systemctl >/dev/null 2>&1; then
  echo "palmux: installing systemd user service"
  yarn service:install
  echo "palmux: installed — manage with ./start.sh / ./stop.sh / ./restart.sh"
else
  echo "palmux: no systemd — building client for the supervised runtime"
  yarn build
  echo "palmux: built — start with ./start.sh (add it to your boot hook)"
fi
