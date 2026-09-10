// ── config.json editor backend ────────────────────────────────────────────────
//
// GET/PUT /config-file exposes the RAW text of ~/.config/palmux/config.json to
// the settings editor. The read half is trivial; the write half is the feature.
//
// The boot path (app-config.ts `readConfigFile`) is deliberately forgiving: a
// bad value is reported to stderr, or silently skipped, and the server boots on
// the defaults so a typo cannot lock you out of the box. That is right for boot
// and wrong for an editor — a write that is accepted and then ignored looks
// exactly like a setting that does not work. So a PUT is refused unless the
// text survives the SAME parse, and nothing is written when it does not.
//
// "The same parse" is meant literally: this module never re-states a rule from
// app-config.ts. It runs `resolveAppConfig()` against the candidate text in a
// scratch config dir and reads two things back out of it:
//
//   1. Whatever the boot parser complained about on stderr (bad allowedIps
//      entries, malformed webApps, selfUpdate without a key …), captured live.
//   2. Which top-level keys the boot parser DROPPED — the silent half. A key is
//      dropped when the resolved value is what an EMPTY config would have
//      produced while the text asked for something other than the default
//      (`"port": "44040"`, `"port": 70000`, `"cookieDays": -1`). No range or
//      type rule is duplicated to find that out; the parser's own output is.
//
// The sandbox swap (PALMUX_CONFIG_DIR + every other PALMUX_* var) is safe
// because the whole validation is SYNCHRONOUS: node cannot interleave another
// request into it. The env vars are cleared, not just the config dir — an env
// layer that wins over the file would otherwise make an honoured key look
// dropped (`PALMUX_NO_AUTH=1` vs `"auth": true`).

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { appConfigPath, DEFAULT_APP_CONFIG, resolveAppConfig, type AppConfig } from './app-config';
import { ensureConfigDir } from './config';

/** A config file is a few KB. The cap only stops a runaway PUT being buffered. */
export const MAX_CONFIG_BYTES = 1024 * 1024;

export interface ConfigFileText {
  text: string;
  path: string;
}

export type ConfigValidation =
  | { ok: true }
  | { ok: false; error: string; line?: number; column?: number };

/**
 * Keys whose default is an object the user may set PARTIALLY. The dropped-key
 * probe cannot serve them: `{"dictation": {"apiKey": ""}}` resolves to the
 * default and is not deep-equal to it, which reads as "dropped" when it was
 * honoured. All three self-report through the boot parser's own stderr, so the
 * probe skips them rather than risking a false rejection. A new STRUCTURED key
 * in AppConfig belongs on this list; a new scalar or string-array one does not.
 */
const STRUCTURED_KEYS = new Set(['webApps', 'selfUpdate', 'dictation']);

const KNOWN_KEYS = new Set(Object.keys(DEFAULT_APP_CONFIG));

/** Read the config file verbatim. An absent file is '' — not an error: the
 *  editor's job is to let you create it. */
export function readConfigText(): ConfigFileText {
  const path = appConfigPath();
  try {
    return { text: existsSync(path) ? readFileSync(path, 'utf8') : '', path };
  } catch {
    return { text: '', path };
  }
}

/** Atomic write, mode 0600 — the same temp+rename+chmod pattern as
 *  config.ts `writeJsonFile`, so a concurrent read never sees a half file. */
export function writeConfigText(text: string): void {
  ensureConfigDir();
  const path = appConfigPath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

interface BootParse {
  /** The candidate text resolved through the real boot path. */
  resolved: AppConfig;
  /** The same resolution with an EMPTY config file — i.e. the defaults. */
  baseline: AppConfig;
  /** Everything the boot parser wrote to stderr while reading the candidate. */
  complaints: string[];
}

/**
 * Run app-config.ts's own parser over `text` in a scratch dir, twice: once with
 * the candidate and once with `{}`. Synchronous from the first env write to the
 * last restore — see the module header for why that matters.
 */
function runBootParse(text: string): BootParse {
  const dir = mkdtempSync(join(tmpdir(), 'palmux-cfgcheck-'));
  const saved = new Map<string, string>();
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith('PALMUX_')) continue;
    const value = process.env[key];
    if (value !== undefined) saved.set(key, value);
    delete process.env[key];
  }
  const realError = console.error;
  const complaints: string[] = [];
  try {
    process.env['PALMUX_CONFIG_DIR'] = dir;
    const file = join(dir, 'config.json');

    writeFileSync(file, text);
    console.error = (...args: unknown[]) => complaints.push(args.map(String).join(' '));
    let resolved: AppConfig;
    try {
      resolved = resolveAppConfig();
    } finally {
      console.error = realError;
    }

    writeFileSync(file, '{}');
    const baseline = resolveAppConfig();
    return { resolved, baseline, complaints };
  } finally {
    console.error = realError;
    delete process.env['PALMUX_CONFIG_DIR'];
    for (const [key, value] of saved) process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  }
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Best-effort source line for a key, so the status bar can point at it. A
 *  nested key of the same name can win; a wrong line beats no line. */
function lineOfKey(text: string, key: string): number | undefined {
  const needle = `"${key}"`;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if ((lines[i] ?? '').includes(needle)) return i + 1;
  }
  return undefined;
}

function lineColOf(text: string, position: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(position, text.length)));
  return { line: before.split('\n').length, column: position - before.lastIndexOf('\n') };
}

/**
 * Where did JSON.parse give up? V8 answers in two shapes and only one carries a
 * number:
 *
 *   Expected double-quoted property name in JSON at position 18 (line 3 column 1)
 *   Unexpected token ']', ..."ample",\n  ]\n}" is not valid JSON
 *
 * The second is the common one for a config file (a trailing comma is an
 * unexpected token), and dropping it would leave the editor's most frequent
 * error with no line at all. Its snippet is VERBATIM source, so locating it —
 * then the named token inside it — recovers the position. Both fallbacks are
 * safe: a snippet that cannot be found yields no line rather than a wrong one.
 */
function jsonErrorAt(message: string, text: string): { line?: number; column?: number } {
  const explicit = /line (\d+) column (\d+)/.exec(message);
  if (explicit) return { line: Number(explicit[1]), column: Number(explicit[2]) };
  const at = /position (\d+)/.exec(message);
  if (at) return lineColOf(text, Number(at[1]));

  // Greedy body with an anchored tail: the snippet may itself contain a quote.
  const ctx = /^.*?, (?:\.\.\.)?"([\s\S]*)"(?:\.\.\.)? is not valid JSON$/.exec(message);
  const snippet = ctx?.[1];
  if (!snippet) return {};
  const base = text.indexOf(snippet);
  if (base < 0) return {};
  const token = /Unexpected token '(.)'/.exec(message)?.[1];
  const offset = token ? snippet.indexOf(token) : -1;
  return lineColOf(text, base + (offset < 0 ? 0 : offset));
}

/**
 * Would this text load the way it reads? `{ ok: true }` only when the boot
 * parser takes every key in it.
 */
export function validateConfigText(text: string): ConfigValidation {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, ...jsonErrorAt(message, text) };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'config.json must be a JSON object' };
  }
  const candidate = raw as Record<string, unknown>;

  const problems: Array<{ message: string; line?: number }> = [];
  const { resolved, baseline, complaints } = runBootParse(text);

  // The boot parser's own voice, minus its prefix — it is already the message.
  for (const complaint of complaints) {
    problems.push({ message: complaint.replace(/^palmux config:\s*/, '') });
  }

  for (const key of Object.keys(candidate)) {
    if (!KNOWN_KEYS.has(key)) {
      const line = lineOfKey(text, key);
      problems.push({ message: `unknown setting "${key}"`, ...(line ? { line } : {}) });
      continue;
    }
    if (STRUCTURED_KEYS.has(key)) continue;
    const untouched = sameValue(resolved[key as keyof AppConfig], baseline[key as keyof AppConfig]);
    if (!untouched) continue;
    // Resolved to what an empty file gives. Fine when that IS what the text
    // asked for (the starter config restates every default); a rejection when
    // it asked for something else.
    if (sameValue(candidate[key], DEFAULT_APP_CONFIG[key as keyof AppConfig])) continue;
    const line = lineOfKey(text, key);
    problems.push({
      message: `"${key}": value rejected by the config parser — it would be ignored`,
      ...(line ? { line } : {}),
    });
  }

  const first = problems[0];
  if (!first) return { ok: true };
  const more = problems.length - 1;
  return {
    ok: false,
    error: more > 0 ? `${first.message} (+${more} more)` : first.message,
    ...(first.line ? { line: first.line } : {}),
  };
}

/**
 * GET /config-file → `{ text, path }`; PUT /config-file (raw body) → 400 with a
 * line number, or `{ restartRequired: true }`. Restart-required is stated
 * plainly because config.json is read at BOOT: nothing here applies live.
 */
export async function registerConfigFileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/config-file', async () => readConfigText());

  await app.register(async (scope) => {
    // The body is raw text and is EXPECTED to be invalid JSON sometimes — that
    // is the whole route. Fastify's built-in application/json parser would
    // answer its own 400 first, with no line number and no explanation, so
    // every parser is dropped inside this encapsulated scope and the body
    // arrives verbatim whatever content-type the browser labels it with.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser<string>('*', { parseAs: 'string' }, (_req, body, done) => {
      done(null, body);
    });

    scope.put('/config-file', { bodyLimit: MAX_CONFIG_BYTES }, async (req, reply) => {
      const text = typeof req.body === 'string' ? req.body : '';
      const check = validateConfigText(text);
      if (!check.ok) {
        return reply.code(400).send({
          error: check.error,
          ...(check.line !== undefined ? { line: check.line } : {}),
          ...(check.column !== undefined ? { column: check.column } : {}),
        });
      }
      try {
        writeConfigText(text);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: `could not write config.json: ${message}` });
      }
      return reply.send({ restartRequired: true });
    });
  });
}
