// The config.json editor backend: the boot-parser reuse (both its stderr
// complaints and the silent drops it does NOT report), the refusal to write an
// invalid file at all, and the atomic 0600 write.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_APP_CONFIG, appConfigPath, type AppConfig } from './app-config';
import { readConfigText, validateConfigText, writeConfigText } from './config-file';
import { createServer, createSessionRegistry } from './server';
import { memoryTabsStore } from './tabs-store';

const secret = 'a'.repeat(64);

let configDir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'palmux-cfgfile-'));
  prevConfigDir = process.env['PALMUX_CONFIG_DIR'];
  process.env['PALMUX_CONFIG_DIR'] = configDir;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env['PALMUX_CONFIG_DIR'];
  else process.env['PALMUX_CONFIG_DIR'] = prevConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

describe('validateConfigText — syntax', () => {
  it('reports a trailing comma with its line', () => {
    const text = ['{', '  "allowedOrigins": [', '    "https://a.example",', '  ]', '}'].join('\n');
    const res = validateConfigText(text);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.line).toBe(4);
    expect(res.error).toBeTruthy();
  });

  it('rejects an empty body and a non-object document', () => {
    expect(validateConfigText('').ok).toBe(false);
    expect(validateConfigText('[]').ok).toBe(false);
    expect(validateConfigText('"nope"').ok).toBe(false);
  });
});

describe('validateConfigText — the boot parser is the authority', () => {
  it('accepts the starter config, which restates every default', () => {
    const text = `${JSON.stringify(DEFAULT_APP_CONFIG, null, 2)}\n`;
    expect(validateConfigText(text)).toEqual({ ok: true });
  });

  it('accepts an empty object and a real override', () => {
    expect(validateConfigText('{}')).toEqual({ ok: true });
    expect(validateConfigText('{"port": 5000, "restoreSessions": false}')).toEqual({ ok: true });
  });

  it('catches the SILENT drops the boot path never prints', () => {
    // A string port, an out-of-range port and a negative cookieDays are all
    // skipped by readConfigFile without a word — the exact failure this exists
    // for: saved, then ignored, indistinguishable from a broken setting.
    for (const text of [
      '{"port": "44040"}',
      '{"port": 70000}',
      '{"cookieDays": -1}',
      '{"scrollbackBytes": 100}',
      '{"restoreSessions": "true"}',
      '{"shell": ""}',
    ]) {
      const res = validateConfigText(text);
      expect(res.ok, text).toBe(false);
      if (!res.ok) expect(res.error).toContain('would be ignored');
    }
  });

  it('relays the boot parser’s own complaints', () => {
    const res = validateConfigText('{"allowedIps": ["not an ip"]}');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('allowedIps');
    expect(res.error).not.toContain('palmux config:');
  });

  it('flags an unknown setting with its line', () => {
    const res = validateConfigText('{\n  "prot": 44040\n}');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('unknown setting "prot"');
    expect(res.line).toBe(2);
  });

  it('counts extra problems without hiding the first', () => {
    const res = validateConfigText('{"port": 70000, "nope": 1}');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('(+1 more)');
  });

  it('keeps maxUploadBytes 0 valid — it is the no-limit setting, not a typo', () => {
    expect(validateConfigText('{"maxUploadBytes": 0}')).toEqual({ ok: true });
  });

  it('does not reject a PARTIAL structured object that restates a default', () => {
    expect(validateConfigText('{"dictation": {"apiKey": ""}}')).toEqual({ ok: true });
    expect(validateConfigText('{"selfUpdate": {"channel": "stable"}}')).toEqual({ ok: true });
    expect(validateConfigText('{"dictation": {"model-audio": "gemini-x"}}')).toEqual({ ok: true });
  });

  it('leaves the real environment untouched', () => {
    process.env['PALMUX_PORT'] = '1234';
    try {
      validateConfigText('{"port": 5000}');
      expect(process.env['PALMUX_PORT']).toBe('1234');
      expect(process.env['PALMUX_CONFIG_DIR']).toBe(configDir);
    } finally {
      delete process.env['PALMUX_PORT'];
    }
  });

  it('is not fooled by an env layer that would mask the file', () => {
    // PALMUX_NO_AUTH=1 resolves auth to false whatever the file says; the
    // sandbox clears it, so `"auth": true` still reads as honoured.
    process.env['PALMUX_NO_AUTH'] = '1';
    try {
      expect(validateConfigText('{"auth": true}')).toEqual({ ok: true });
    } finally {
      delete process.env['PALMUX_NO_AUTH'];
    }
  });
});

describe('readConfigText / writeConfigText', () => {
  it('reads an absent file as empty, and round-trips verbatim at 0600', () => {
    expect(readConfigText()).toEqual({ text: '', path: appConfigPath() });
    const text = '{\n  "port": 5000\n}\n';
    writeConfigText(text);
    expect(readConfigText().text).toBe(text);
    expect(statSync(appConfigPath()).mode & 0o777).toBe(0o600);
  });

  it('leaves no temp file behind', () => {
    writeConfigText('{}');
    expect(() => readFileSync(`${appConfigPath()}.${process.pid}.tmp`)).toThrow();
  });
});

describe('GET/PUT /config-file', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // The routes are registered on the shared app; the per-test config dir set
    // in beforeEach is what appConfigPath() reads, so one instance is enough.
    const cfg: AppConfig = { ...DEFAULT_APP_CONFIG, fontDirs: [], auth: false };
    app = await createServer(cfg, secret, createSessionRegistry(cfg, memoryTabsStore()));
  });
  afterAll(async () => {
    await app.close();
  });

  it('GET returns the raw text and the path', async () => {
    writeFileSync(join(configDir, 'config.json'), '{ "port": 5000 }');
    const res = await app.inject({ method: 'GET', url: '/config-file' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: '{ "port": 5000 }', path: appConfigPath() });
  });

  it('PUT writes a valid file and says a restart is needed', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/config-file',
      headers: { 'content-type': 'application/json' },
      payload: '{"port": 5001}',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ restartRequired: true });
    expect(readFileSync(appConfigPath(), 'utf8')).toBe('{"port": 5001}');
  });

  it('PUT WRITES NOTHING when the text is invalid', async () => {
    writeFileSync(join(configDir, 'config.json'), '{"port": 5000}');
    const bad = await app.inject({
      method: 'PUT',
      url: '/config-file',
      headers: { 'content-type': 'application/json' },
      payload: '{"port": 70000}',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()['error']).toContain('would be ignored');
    expect(readFileSync(appConfigPath(), 'utf8')).toBe('{"port": 5000}');
  });

  it('answers malformed JSON itself, with a line — not Fastify’s bare 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/config-file',
      // The content-type a fetch() defaults to. Fastify's own json parser would
      // have rejected this body before the route ever saw it.
      headers: { 'content-type': 'application/json' },
      payload: '{\n  "port": 5000,\n}',
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body['line']).toBe(3);
    expect(typeof body['error']).toBe('string');
  });
});
