// ── External theme hook ───────────────────────────────────────────────────────
//
// Everything palmux derives from the active theme is also written to
// `<configDir>/theme.json`, and if `<configDir>/theme-hook.mjs` exists it is run
// with that file as its input — REPLACING the built-in Claude Code theme export.
//
// The point is iteration. The service runs `tsx` over the source, so touching
// anything in this repo means a restart, and a restart means every live terminal
// session takes the hit. A hook is re-read from disk on every invocation, so the
// mapping can be rewritten and re-tested without palmux noticing.
//
// The hook runs under palmux's OWN node (`process.execPath`) rather than a
// shebang: the systemd user unit has a bare PATH with no nvm on it, so
// `#!/usr/bin/env node` would not resolve there.

import { execFile } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Where a user hook lives. Absent = palmux does the Claude export itself. */
export function themeHookPath(configDir: string): string {
  return join(configDir, 'theme-hook.mjs');
}

/** Where the hook's stdout/stderr goes — a hook that fails must not be silent. */
export function themeHookLogPath(configDir: string): string {
  return join(configDir, 'theme-hook.log');
}

/**
 * Run the hook if there is one. Returns whether it took over — the caller skips
 * its built-in export when true, so the two can never both write the same file.
 * Fire-and-forget: a theme repaint must not block the settings round-trip, and a
 * broken hook must not break palmux.
 */
export function runThemeHook(configDir: string): boolean {
  const hook = themeHookPath(configDir);
  if (!existsSync(hook)) return false;
  const log = themeHookLogPath(configDir);
  execFile(
    process.execPath,
    [hook],
    {
      cwd: configDir,
      timeout: 15000,
      env: { ...process.env, PALMUX_CONFIG_DIR: configDir },
    },
    (err, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ?? ''}`.trim();
      if (!err && !out) return; // clean run, nothing to say
      try {
        appendFileSync(
          log,
          `[${new Date().toISOString()}] ${err ? `FAILED: ${err.message}` : 'ok'}\n${out}\n`,
          'utf8',
        );
      } catch {
        /* log unwritable — the hook still ran */
      }
    },
  );
  return true;
}
