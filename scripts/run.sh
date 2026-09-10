#!/usr/bin/env sh
# ── palmux — systemd-less supervised launcher ─────────────────────────────────
#
# For machines WITHOUT systemctl (containers, minimal images, chroots …) that
# only give you a boot hook like onBoot.sh. Call this IN THE BACKGROUND from
# that hook:
#
#     nohup /path/to/palmux/scripts/run.sh >/dev/null 2>&1 &
#
# It runs the server in a restart loop (crash → relaunch), logging to
# $PALMUX_LOG. Runtime needs only Node (>= 22).
#
# If the committed self-contained bundle (bin/palmux.mjs, built with
# `yarn bundle`) is present it uses that — zero node_modules, zero build on the
# target. Otherwise it falls back to running the source via tsx, which needs
# `yarn install` + `yarn build` to have been run once.
#
# Env knobs (all optional):
#   PALMUX_NODE        absolute path to the node binary (if not on PATH at boot)
#   PALMUX_LOG         log file (default: <repo>/palmux.log)
#   PALMUX_CONFIG_DIR  where the token + config.json live (default ~/.config/palmux);
#                      set this to a PERSISTENT path if $HOME is ephemeral, or the
#                      auth token regenerates every boot
#   PALMUX_PORT / PALMUX_HOST / PALMUX_NO_AUTH  as documented in the README
set -eu

REPO="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
LOG="${PALMUX_LOG:-$REPO/palmux.log}"
ENTRY="$REPO/packages/server/src/index.ts"
TSX="$REPO/node_modules/tsx/dist/cli.mjs"

log() { echo "[palmux $(date '+%Y-%m-%dT%H:%M:%S')] $*" >>"$LOG"; }

# A bare boot shell often lacks nvm's node on PATH — try to load it.
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi
NODE="${PALMUX_NODE:-node}"

if ! command -v "$NODE" >/dev/null 2>&1; then
  log "FATAL: node not found — set PALMUX_NODE=/abs/path/to/node in onBoot.sh"
  exit 1
fi

# Prefer the self-contained bundle; fall back to the tsx source path.
BUNDLE="$REPO/bin/palmux.mjs"
if [ -f "$BUNDLE" ]; then
  export PALMUX_CLIENT_DIR="${PALMUX_CLIENT_DIR:-$REPO/bin/client}"
  set -- "$BUNDLE"
  MODE="bundle"
elif [ -f "$TSX" ] && [ -e "$REPO/packages/client/dist/index.html" ]; then
  set -- "$TSX" "$ENTRY"
  MODE="tsx"
else
  log "FATAL: no runtime — run 'yarn bundle' (preferred) or 'yarn install && yarn build'"
  exit 1
fi

log "supervisor up ($MODE); repo=$REPO node=$("$NODE" -v)"
while :; do
  log "starting server"
  "$NODE" "$@" >>"$LOG" 2>&1 || true
  log "server exited; restarting in 2s"
  sleep 2
done
