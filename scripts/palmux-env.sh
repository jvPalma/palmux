# shellcheck shell=bash
# ── palmux lifecycle helpers (sourced, never executed) ────────────────────────
# Shared by scripts/{start,stop,restart,dev}.sh so the node discovery and the
# "is it already running, and is it OURS?" guards live in exactly one place.
# Every caller sets $REPO to the repo root before sourcing this.
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

# True when a systemd user unit owns palmux FOR THIS CHECKOUT (it then auto-starts
# at boot via linger, so the boot hook must NOT launch a second copy).
#
# The checkout comparison is not pedantry. `palmux.service` is ONE machine-wide
# name, so a bare is-enabled check makes every clone on the box claim the same
# unit: a second checkout's stop.sh then stops the first one's live service, and
# its restart.sh restarts a copy of palmux the user is not even looking at.
# Measured — a throwaway `cp -a` of this repo under /tmp took down the real one.
# Comparing WorkingDirectory keeps the answer true for the checkout that owns the
# unit and false for every other, which drops them to the supervised path where
# every kill is already scoped to $REPO.
palmux_systemd_managed() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user is-enabled --quiet palmux.service 2>/dev/null || return 1
  # No $REPO means the caller did not scope itself; keep the historical answer.
  [ -n "${REPO:-}" ] || return 0
  _pmx_wd="$(systemctl --user show palmux.service -p WorkingDirectory --value 2>/dev/null)"
  # An empty value means systemd could not tell us; do not silently disown a
  # unit we cannot inspect.
  [ -z "$_pmx_wd" ] || [ "$_pmx_wd" = "$REPO/packages/server" ] || [ "$_pmx_wd" = "$REPO" ]
}

# True when something already answers on the palmux port.
palmux_serving() {
  command -v curl >/dev/null 2>&1 &&
    curl -sf -o /dev/null "http://127.0.0.1:${PALMUX_PORT}/ping" 2>/dev/null
}
