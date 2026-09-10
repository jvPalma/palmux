// ── Application configuration ─────────────────────────────────────────────────
//
// ONE place for every tunable. Sources, in precedence order:
//   CLI flags  >  PALMUX_* env vars  >  ~/.config/palmux/config.json  >  defaults
//
// The config file is created with the defaults on first run so it is
// discoverable and self-documenting. Invalid entries are reported to stderr and
// ignored (the server still boots — a typo must not lock you out of the box,
// except in allowedIps, where dropping a bad rule only ever tightens access).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MAX_DOWNLOAD_BYTES,
  DEFAULT_MAX_UPLOAD_BYTES,
  parseByteSize,
  type WebAppLink,
} from '@palmux/shared';
import { configDir } from './config';
import type { DictationConfig } from './dictate';
import { isValidIpRule, isValidOriginRule } from './net-rules';

export interface AppConfig {
  /** Bind address. */
  host: string;
  /** Listening port. */
  port: number;
  /** Token-cookie auth for HTTP + WebSocket. Disable only on trusted networks. */
  auth: boolean;
  /** Shell to spawn (null → $SHELL → /bin/bash). */
  shell: string | null;
  /** Working directory for new sessions (null → home). */
  cwd: string | null;
  /** Directories scanned (recursively) for servable fonts. */
  fontDirs: string[];
  /** Exact IPs or CIDR ranges allowed to connect ("10.0.0.0/24"). Empty = all. */
  allowedIps: string[];
  /**
   * Allowed Origin values, "*." wildcards supported. Empty means all for HTTP
   * (which the same-origin policy already guards — palmux sends no CORS
   * headers) but SAME-ORIGIN for the /ws upgrade, which CORS does not cover.
   * Set this only to widen that: a reverse proxy that rewrites Host, or an
   * intentional cross-origin embed.
   */
  allowedOrigins: string[];
  /** Per-session output ring buffer replayed on reconnect, in bytes. */
  scrollbackBytes: number;
  /**
   * Rebuild terminals after a COLD start: respawn in the recorded cwd, replay
   * the previous screen, and re-run whatever command was in the foreground.
   * Off means a restart gives you empty shells, as it did before. See
   * session-restore.ts for why the command is captured rather than configured.
   */
  restoreSessions: boolean;
  /** Session-cookie lifetime in days. */
  cookieDays: number;
  /**
   * Max size of a pasted/dropped/picked upload, in bytes. **0 means no limit.**
   * Worth knowing before setting it: the body is buffered in MEMORY on its way
   * to a temp file, so "no limit" is really "bounded by the server's RAM" — a
   * single upload larger than free memory takes the process down, and with it
   * every terminal. Raise the number if you know your ceiling; use 0 when you
   * would rather manage that yourself.
   */
  maxUploadBytes: number;
  /** Cap on one /download response (bytes). 0 = no limit. */
  maxDownloadBytes: number;
  /** Web apps offered on the new-tab page (e.g. a SilverBullet instance). */
  webApps: WebAppLink[];
  /** Directories browsable by the markdown viewer (`~` expanded). Listing is
   *  confined to these; direct absolute-path opens are not. */
  markdownRoots: string[];
  /** Reap a terminal session after it has had no attached client for this many
   *  milliseconds. 0 disables eviction (never reap) — the default. */
  idleTimeoutMs: number;
  /** Opt-in self-update. Disabled unless explicitly configured. */
  selfUpdate: SelfUpdateConfig;
  /** Voice dictation. Inert until an API key is supplied. */
  dictation: DictationConfig;
}

// The audio default is deliberately NOT the newest flash: measured 2026-08-17,
// gemini-3.6/3.7-flash answer 500 INTERNAL to inline audio while serving text
// fine. Text stays on the newest.
export const DEFAULT_DICTATION: DictationConfig = {
  apiKey: '',
  modelAudio: 'gemini-3.5-flash',
  modelText: 'gemini-3.7-flash',
};

/** Self-update is OFF by design: it swaps the running bundle, so it stays
 *  something the operator turns on deliberately and points at a key they trust. */
export interface SelfUpdateConfig {
  /** Master switch. Everything below is inert while this is false. */
  enabled: boolean;
  /** GitHub repository to poll, as "owner/name". */
  repo: string;
  /** Which releases count: `stable` ignores pre-releases. */
  channel: 'stable' | 'prerelease';
  /** Poll interval in hours, clamped to MIN_UPDATE_INTERVAL_HOURS. */
  intervalHours: number;
  /** Ed25519 public key (SPKI PEM) the detached bundle signature must verify
   *  against. Empty = nothing can be verified = updates never apply. */
  publicKey: string;
}

/** Floor for the poll interval — a mistyped 0 must not hammer the API. */
export const MIN_UPDATE_INTERVAL_HOURS = 1;

export const DEFAULT_SELF_UPDATE: SelfUpdateConfig = {
  enabled: false,
  repo: '',
  channel: 'stable',
  intervalHours: 24,
  publicKey: '',
};

export const DEFAULT_APP_CONFIG: AppConfig = {
  host: '0.0.0.0',
  port: 44040,
  auth: true,
  shell: null,
  cwd: null,
  fontDirs: ['~/.fonts'],
  allowedIps: [],
  allowedOrigins: [],
  scrollbackBytes: 512 * 1024,
  restoreSessions: true,
  cookieDays: 365,
  maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
  maxDownloadBytes: DEFAULT_MAX_DOWNLOAD_BYTES,
  webApps: [],
  markdownRoots: [],
  idleTimeoutMs: 0,
  selfUpdate: { ...DEFAULT_SELF_UPDATE },
  dictation: { ...DEFAULT_DICTATION },
};

export function appConfigPath(): string {
  return join(configDir(), 'config.json');
}

/** Write a starter config.json (the defaults, pretty-printed) if none exists. */
export function ensureAppConfigFile(): void {
  const path = appConfigPath();
  if (existsSync(path)) return;
  try {
    writeFileSync(path, `${JSON.stringify(DEFAULT_APP_CONFIG, null, 2)}\n`, { mode: 0o600 });
  } catch {
    /* unwritable config dir — env/CLI/defaults still apply */
  }
}

const expandHome = (p: string): string => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringList(v: unknown, label: string, valid: (s: string) => boolean): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string' && valid(item)) out.push(item.trim());
    else console.error(`palmux config: ignoring invalid ${label} entry: ${JSON.stringify(item)}`);
  }
  return out;
}

/** Parse + validate the config file layer (missing/invalid fields → undefined). */
function readConfigFile(): Partial<AppConfig> {
  const path = appConfigPath();
  let raw: unknown;
  try {
    if (!existsSync(path)) return {};
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`palmux config: ${path} is not valid JSON — using defaults (${String(err)})`);
    return {};
  }
  if (!isRecord(raw)) return {};

  const out: Partial<AppConfig> = {};
  if (typeof raw['host'] === 'string' && raw['host']) out.host = raw['host'];
  if (typeof raw['port'] === 'number' && raw['port'] >= 1 && raw['port'] <= 65535) {
    out.port = Math.floor(raw['port']);
  }
  if (typeof raw['auth'] === 'boolean') out.auth = raw['auth'];
  if (typeof raw['shell'] === 'string' && raw['shell']) out.shell = expandHome(raw['shell']);
  if (raw['shell'] === null) out.shell = null;
  if (typeof raw['cwd'] === 'string' && raw['cwd']) out.cwd = expandHome(raw['cwd']);
  if (raw['cwd'] === null) out.cwd = null;
  const fonts = stringList(raw['fontDirs'], 'fontDirs', (s) => s.length > 0);
  if (fonts) out.fontDirs = fonts;
  const mdRoots = stringList(raw['markdownRoots'], 'markdownRoots', (s) => s.length > 0);
  if (mdRoots) out.markdownRoots = mdRoots.map(expandHome);
  const ips = stringList(raw['allowedIps'], 'allowedIps', isValidIpRule);
  if (ips) out.allowedIps = ips;
  const origins = stringList(raw['allowedOrigins'], 'allowedOrigins', isValidOriginRule);
  if (origins) out.allowedOrigins = origins;
  if (typeof raw['scrollbackBytes'] === 'number' && raw['scrollbackBytes'] >= 4096) {
    out.scrollbackBytes = Math.floor(raw['scrollbackBytes']);
  }
  if (typeof raw['restoreSessions'] === 'boolean') out.restoreSessions = raw['restoreSessions'];
  if (typeof raw['cookieDays'] === 'number' && raw['cookieDays'] > 0) {
    out.cookieDays = raw['cookieDays'];
  }
  // A number (bytes) or a "<n><KB|MB|GB>" string; 0 is the explicit "no limit"
  // setting, not a typo to reject, so the floor is >= 0 rather than >= 1.
  //
  // Raising this is not free: the upload body is accumulated IN MEMORY on its
  // way to the temp file, so "1GB" really means "one request may cost a
  // gigabyte of RSS". That is a deliberate trade the operator makes, not one
  // this parser can make for them, so it is documented rather than clamped.
  const upload = parseByteSize(raw['maxUploadBytes']);
  if (upload !== null) out.maxUploadBytes = upload;
  // The download cap is a different animal: the zip is streamed, so this bounds
  // the transfer, not memory.
  const download = parseByteSize(raw['maxDownloadBytes']);
  if (download !== null) out.maxDownloadBytes = download;
  if (typeof raw['idleTimeoutMs'] === 'number' && raw['idleTimeoutMs'] >= 0) {
    out.idleTimeoutMs = Math.floor(raw['idleTimeoutMs']);
  }
  if (isRecord(raw['selfUpdate'])) {
    const su = raw['selfUpdate'];
    const next: SelfUpdateConfig = { ...DEFAULT_SELF_UPDATE };
    if (typeof su['enabled'] === 'boolean') next.enabled = su['enabled'];
    if (typeof su['repo'] === 'string') next.repo = su['repo'].trim();
    if (su['channel'] === 'stable' || su['channel'] === 'prerelease') next.channel = su['channel'];
    if (typeof su['intervalHours'] === 'number' && Number.isFinite(su['intervalHours'])) {
      next.intervalHours = Math.max(MIN_UPDATE_INTERVAL_HOURS, su['intervalHours']);
    }
    if (typeof su['publicKey'] === 'string') next.publicKey = su['publicKey'].trim();
    if (next.enabled && (!next.repo || !next.publicKey)) {
      console.error(
        'palmux config: selfUpdate.enabled requires both repo and publicKey — keeping it disabled',
      );
      next.enabled = false;
    }
    out.selfUpdate = next;
  }
  if (isRecord(raw['dictation'])) {
    const d = raw['dictation'];
    const next: DictationConfig = { ...DEFAULT_DICTATION };
    if (typeof d['apiKey'] === 'string') next.apiKey = d['apiKey'].trim();
    // Legacy single `model` sets BOTH passes, and is read FIRST so the specific
    // keys override it. Old config files are still in the wild (each host has
    // its own), so dropping it would silently move them onto the defaults.
    const str = (k: string) => (typeof d[k] === 'string' && d[k].trim() ? d[k].trim() : null);
    const legacy = str('model');
    if (legacy) {
      next.modelAudio = legacy;
      next.modelText = legacy;
    }
    const audio = str('model-audio');
    const text = str('model-text');
    if (audio) next.modelAudio = audio;
    if (text) next.modelText = text;
    out.dictation = next;
  }
  if (Array.isArray(raw['webApps'])) {
    const apps: WebAppLink[] = [];
    for (const item of raw['webApps']) {
      if (
        isRecord(item) &&
        typeof item['name'] === 'string' &&
        item['name'] &&
        typeof item['url'] === 'string' &&
        item['url']
      ) {
        apps.push({
          name: item['name'],
          url: item['url'],
          ...(typeof item['icon'] === 'string' ? { icon: item['icon'] } : {}),
        });
      } else {
        console.error(`palmux config: ignoring invalid webApps entry: ${JSON.stringify(item)}`);
      }
    }
    out.webApps = apps;
  }
  return out;
}

/** Env-var layer (PALMUX_*). */
function readEnv(): Partial<AppConfig> {
  const out: Partial<AppConfig> = {};
  const port = Number(process.env['PALMUX_PORT']);
  if (Number.isInteger(port) && port >= 1 && port <= 65535) out.port = port;
  if (process.env['PALMUX_HOST']) out.host = process.env['PALMUX_HOST'];
  if (process.env['PALMUX_NO_AUTH'] === '1') out.auth = false;
  const dirs = process.env['PALMUX_FONT_DIRS'];
  if (dirs)
    out.fontDirs = dirs
      .split(':')
      .map((s) => s.trim())
      .filter(Boolean);
  // Same grammar as the file, so `PALMUX_MAX_UPLOAD_BYTES=1GB` works and a bare
  // byte count still does. An unparseable value leaves the file/default alone
  // rather than falling back to something arbitrary.
  const up = parseByteSize(process.env['PALMUX_MAX_UPLOAD_BYTES']?.trim());
  if (up !== null) out.maxUploadBytes = up;
  const down = parseByteSize(process.env['PALMUX_MAX_DOWNLOAD_BYTES']?.trim());
  if (down !== null) out.maxDownloadBytes = down;
  const idle = Number(process.env['PALMUX_IDLE_TIMEOUT_MS']);
  if (Number.isFinite(idle) && idle >= 0) out.idleTimeoutMs = Math.floor(idle);
  return out;
}

/**
 * The dictation env layer, per field. Kept out of readEnv because the top-level
 * merge is shallow: a whole-object override would let `PALMUX_DICTATION_API_KEY`
 * silently reset a `model` chosen in config.json.
 */
function readEnvDictation(): Partial<DictationConfig> {
  const out: Partial<DictationConfig> = {};
  // Supported so the key need not live in a file the server rewrites.
  const apiKey = process.env['PALMUX_DICTATION_API_KEY']?.trim();
  // PALMUX_DICTATION_MODEL keeps setting BOTH passes (its old meaning); the two
  // per-pass vars override it, mirroring the config file's precedence.
  const model = process.env['PALMUX_DICTATION_MODEL']?.trim();
  const audio = process.env['PALMUX_DICTATION_MODEL_AUDIO']?.trim();
  const text = process.env['PALMUX_DICTATION_MODEL_TEXT']?.trim();
  if (apiKey) out.apiKey = apiKey;
  if (model) {
    out.modelAudio = model;
    out.modelText = model;
  }
  if (audio) out.modelAudio = audio;
  if (text) out.modelText = text;
  return out;
}

/** Merge all layers. `cli` wins over env wins over the file wins over defaults. */
export function resolveAppConfig(cli: Partial<AppConfig> = {}): AppConfig {
  const file = readConfigFile();
  const merged: AppConfig = { ...DEFAULT_APP_CONFIG, ...file, ...readEnv(), ...cli };
  merged.dictation = {
    ...DEFAULT_DICTATION,
    ...file.dictation,
    ...readEnvDictation(),
    ...cli.dictation,
  };
  merged.fontDirs = merged.fontDirs.map(expandHome);
  return merged;
}
