// ── Config + secret persistence ───────────────────────────────────────────────
//
// Everything lives under PALMUX_CONFIG_DIR (default ~/.config/palmux):
//   secret           — 32-byte hex auth token (chmod 600), generated on first run
//   settings.json    — opaque client settings blob, server-synced across browsers
//   extra-keys.json  — opaque Termux-style toolbar config
//
// settings/extra-keys are stored verbatim as the client sends them; the server
// never interprets their shape (see protocol.ts).

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject, JsonValue } from '@palmux/shared';

export function configDir(): string {
  return process.env['PALMUX_CONFIG_DIR'] || join(homedir(), '.config', 'palmux');
}

export function ensureConfigDir(): string {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function secretPath(): string {
  return join(configDir(), 'secret');
}

/** Read the auth secret, generating (and persisting) one on first run. */
export function loadOrCreateSecret(): string {
  ensureConfigDir();
  const path = secretPath();
  if (existsSync(path)) {
    const v = readFileSync(path, 'utf8').trim();
    if (v) return v;
  }
  const secret = randomBytes(32).toString('hex');
  writeFileSync(path, secret, { mode: 0o600 });
  chmodSync(path, 0o600);
  return secret;
}

/** Rotate the secret, invalidating every existing browser session. */
export function rotateSecret(): string {
  ensureConfigDir();
  const secret = randomBytes(32).toString('hex');
  writeFileSync(secretPath(), secret, { mode: 0o600 });
  chmodSync(secretPath(), 0o600);
  return secret;
}

function readJsonFile(path: string): JsonObject {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return {};
  }
}

function writeJsonFile(path: string, value: JsonObject): void {
  ensureConfigDir();
  // Atomic write (temp + rename) so concurrent connections can't interleave and
  // corrupt the file; chmod every write, not just on first creation.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

// Settings the client syncs but that must NOT roam between machines. The client
// already withholds the purely-local ones (fontSize, mobileMode) — they never
// reach the server at all. `themeId` cannot take that route: theme-export.ts
// reads it AT BOOT, with no browser connected, to regenerate theme.sh /
// theme.tmux / the Claude Code theme. So it stays on the wire and is split here,
// at the persistence boundary instead.
//
// The reason is a dotfiles manager: settings.json is worth tracking, and a
// per-machine theme turns every pull into a conflict. settings.local.json is
// gitignored (see CONFIG_GITIGNORE) and wins over the shared file, so a pull
// that reintroduces someone else's themeId is simply overridden rather than
// fought.
const LOCAL_SETTINGS_KEYS: readonly string[] = ['themeId'];

const sharedSettingsPath = (): string => join(configDir(), 'settings.json');
const localSettingsPath = (): string => join(configDir(), 'settings.local.json');

export function loadSettings(): JsonObject {
  // Local last: it wins. When it does not exist yet, the shared file's themeId
  // is used — which is exactly the migration path off a pre-split settings.json.
  return { ...readJsonFile(sharedSettingsPath()), ...readJsonFile(localSettingsPath()) };
}

/**
 * Move any per-device key still sitting in the shared settings.json into
 * settings.local.json. Without this the split only happens the next time some
 * setting is changed — and a machine whose settings never change would keep
 * committing its themeId forever, which is the exact problem. Idempotent, and a
 * no-op once the shared file is clean.
 */
export function ensureSettingsSplit(): void {
  const shared = readJsonFile(sharedSettingsPath());
  if (!LOCAL_SETTINGS_KEYS.some((key) => key in shared)) return;
  // Local last so this machine's own choice survives the rewrite.
  saveSettings({ ...shared, ...readJsonFile(localSettingsPath()) });
}

export function saveSettings(value: JsonObject): void {
  const shared: JsonObject = {};
  const local: JsonObject = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue;
    (LOCAL_SETTINGS_KEYS.includes(key) ? local : shared)[key] = v;
  }
  writeJsonFile(sharedSettingsPath(), shared);
  writeJsonFile(localSettingsPath(), local);
}

export function extraKeysPath(): string {
  return join(configDir(), 'extra-keys.json');
}

// The starter file written on first run, so the user has something to edit. It
// is the Termux-style default; see the README for the full schema (macros +
// long-press popups).
const DEFAULT_EXTRA_KEYS_FILE: JsonValue = {
  enabled: true,
  layout: [
    ['ESC', '/', '-', 'HOME', 'UP', 'END', 'PGUP'],
    ['TAB', 'CTRL', 'ALT', 'LEFT', 'DOWN', 'RIGHT', 'PGDN'],
  ],
};

// Palmux's config dir mixes two very different things: a handful of files worth
// tracking in a dotfiles repo (config.json, extra-keys.json, imported themes,
// whatever scripts you drop in) and a pile of per-machine runtime state that is
// actively harmful to sync. This ships the boundary as data so a `yadm add .`
// cannot get it wrong.
//
// A DENYLIST, not an allowlist: people keep their own scripts here (a theme
// hook, a pager, hooks.d) and an allowlist would silently stop tracking them.
// The cost is that a future generated file needs a line adding.
//
// Note that .gitignore only governs UNTRACKED files. Anything already committed
// stays tracked until it is explicitly removed from the index.
const CONFIG_GITIGNORE = `# Written by palmux on first run; yours to edit — it is never overwritten.
#
# Everything below is per-machine state or generated output. Tracking it in a
# dotfiles repo is at best conflict noise and at worst a credential leak.

# The auth secret IS the shell. Never sync this.
secret

# Per-device: which theme this machine uses (see LOCAL_SETTINGS_KEYS in config.ts).
settings.local.json

# Workspace state — tab ids, layout and the shells they had open.
tabs.json
groups.json
sessions/
update-stamp

# Generated from settings.themeId on every boot and every theme change.
theme.sh
theme.tmux
theme.json

# Logs.
*.log

# Dictation recordings and their transcripts. This grows without bound
# (audio has its own 100 MB budget) and is the single worst thing to sync.
transcripts/

# Served/served-from content, keyed to this machine's tabs.
artifacts/
notes/
fonts/

# Credentials that tools sometimes park here.
*-key.json
*credentials*.json
`;

/**
 * Write a .gitignore covering the per-machine half of the config dir, so a
 * dotfiles manager pointed at ~/.config can be trusted with it. Never
 * overwrites: once it exists it belongs to the user.
 */
export function ensureConfigGitignore(): void {
  const path = join(configDir(), '.gitignore');
  if (existsSync(path)) return;
  try {
    ensureConfigDir();
    writeFileSync(path, CONFIG_GITIGNORE);
  } catch {
    /* unwritable config dir — nothing here is required for the server to run */
  }
}

/** Write a starter extra-keys.json (user-editable) if the user has none yet. */
export function ensureExtraKeysFile(): void {
  const path = extraKeysPath();
  if (existsSync(path)) return;
  ensureConfigDir();
  writeFileSync(path, JSON.stringify(DEFAULT_EXTRA_KEYS_FILE, null, 2) + '\n', { mode: 0o644 });
}

/**
 * Load the user's extra-keys config. Accepts either an object
 * `{ enabled, layout }` or a bare Termux-style array-of-arrays (treated as the
 * layout). Returns {} when absent/invalid so the client falls back to defaults.
 */
export function loadExtraKeys(): JsonObject {
  try {
    const path = extraKeysPath();
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (Array.isArray(parsed)) {
      return { enabled: true, layout: parsed as unknown as JsonValue };
    }
    if (parsed && typeof parsed === 'object') return parsed as JsonObject;
    return {};
  } catch {
    return {};
  }
}

export function saveExtraKeys(value: JsonObject): void {
  writeJsonFile(extraKeysPath(), value);
}
