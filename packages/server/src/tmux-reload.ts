// ── Live tmux reload ──────────────────────────────────────────────────────────
//
// Writing `theme.tmux` only changes a file; a running tmux keeps the palette it
// read at startup until something re-sources it (the usual `prefix + r`). After
// a palette change we do that reload ourselves.
//
// We re-source the USER's tmux.conf rather than just `theme.tmux`, because
// status-bar plugins (tmux2k and friends) bake our `@`-options into the bar at
// init — sourcing the export alone updates pane borders but leaves the bar
// stale. The user's conf already sources the export and re-runs its plugins, in
// that order; that is exactly what `prefix + r` does, so it is a path they
// exercise constantly.
//
// The opt-in is implicit and needs no setting: we only reload a tmux.conf that
// actually references our export. Wire the `source-file` line in and reloads
// start; take it out and palmux stops touching your tmux.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The tmux config we re-source — the same file `prefix + r` reloads. */
export function tmuxConfPath(): string {
  return join(homedir(), '.tmux.conf');
}

/**
 * Does `conf` consume our theme export? Matches the absolute path and the `~`
 * form, since a tmux.conf conventionally writes the latter.
 */
export function consumesThemeExport(conf: string, themeTmuxPath: string): boolean {
  const home = homedir();
  const abbreviated = themeTmuxPath.startsWith(`${home}/`)
    ? `~${themeTmuxPath.slice(home.length)}`
    : themeTmuxPath;
  return conf.includes(themeTmuxPath) || conf.includes(abbreviated);
}

/**
 * Re-source the user's tmux.conf so a live tmux picks up the new palette.
 * Fire-and-forget: no server running (the common case) is not an error, and a
 * colour refresh must never delay or fail the settings round-trip.
 */
export function reloadTmuxConfig(themeTmuxPath: string): void {
  const conf = tmuxConfPath();
  let body: string;
  try {
    body = readFileSync(conf, 'utf8');
  } catch {
    return; // no tmux.conf — nothing consumes the export
  }
  if (!consumesThemeExport(body, themeTmuxPath)) return;
  execFile('tmux', ['source-file', conf], { timeout: 5000 }, () => {
    /* no server running / tmux not installed — both are normal */
  });
}
