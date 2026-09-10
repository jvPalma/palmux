# ── palmux lifecycle helpers (sourced, never executed) ────────────────────────
# Shared by the repo-root install/start/stop/restart/dev scripts so the node
# discovery + "is it already running here?" guards live in exactly one place.
# Sets no shell options on purpose — the caller owns `set -e` etc.

PALMUX_PORT="${PALMUX_PORT:-44040}"

# Echo a usable node binary path (empty if none): PATH first, then nvm (loaded
# on demand — a bare boot shell often lacks it), then the newest nvm install.
palmux_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  # `|| true` neutralises pipefail when the glob matches nothing.
  ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true
}

# True when a systemd user unit owns palmux on this machine (it then auto-starts
# at boot via linger, so the boot hook must NOT launch a second copy).
palmux_systemd_managed() {
  command -v systemctl >/dev/null 2>&1 &&
    systemctl --user is-enabled --quiet palmux.service 2>/dev/null
}

# True when something already answers on the palmux port.
palmux_serving() {
  command -v curl >/dev/null 2>&1 &&
    curl -sf -o /dev/null "http://127.0.0.1:${PALMUX_PORT}/ping" 2>/dev/null
}
