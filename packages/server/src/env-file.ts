// ── The env file: palmux's own environment ───────────────────────────────────
//
// `~/.config/palmux/env` is loaded INTO the process at boot, before the config
// resolves. It exists because the process environment is not portable: a unit
// under systemd never sees the keys a shell launcher (dotrun, direnv, zshrc)
// exports, and `dictation.apiKey: "$OPEN_ROUTER_API_KEY"` would 503 on every
// install. With the file, one place feeds every run mode — tsx, the bundle,
// the systemd unit — and the config never carries a literal secret.

import { readFileSync } from 'node:fs';

/**
 * Parse KEY=VALUE lines. `#` starts a comment, blank lines are skipped, and
 * matching surrounding quotes are stripped. Existing process env WINS — the
 * file is the fallback, never an override of what launched the process.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cut = line.indexOf('=');
    if (cut <= 0) continue; // no name, or a bare '='
    const name = line.slice(0, cut).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let value = line.slice(cut + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[name] = value;
  }
  return out;
}

/** Load the env file into the process (existing env wins). Missing file = no-op. */
export function loadEnvFile(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return; // no env file — the process environment still applies
  }
  for (const [name, value] of Object.entries(parseEnvFile(text))) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
}
