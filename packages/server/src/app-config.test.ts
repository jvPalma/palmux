import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MAX_DOWNLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES } from '@palmux/shared';

const created: string[] = [];

/** Write a config.json into an isolated PALMUX_CONFIG_DIR and resolve the config. */
async function resolveWith(label: string, config: unknown) {
  const dir = join(tmpdir(), `palmux-appcfg-${label}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  process.env['PALMUX_CONFIG_DIR'] = dir;
  created.push(dir);
  vi.resetModules();
  const mod = await import('./app-config');
  return mod.resolveAppConfig();
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env['PALMUX_CONFIG_DIR'];
});

describe('config.json webApps', () => {
  it('parses valid entries and keeps optional icons', async () => {
    const cfg = await resolveWith('valid', {
      webApps: [
        { name: 'SilverBullet', url: 'https://sb.local', icon: '📓' },
        { name: 'Grafana', url: 'https://g.local' },
      ],
    });
    expect(cfg.webApps).toEqual([
      { name: 'SilverBullet', url: 'https://sb.local', icon: '📓' },
      { name: 'Grafana', url: 'https://g.local' },
    ]);
  });

  it('drops malformed entries and defaults to empty', async () => {
    const cfg = await resolveWith('invalid', {
      webApps: [{ name: 'no-url' }, { url: 'https://x' }, { name: '', url: 'https://x' }, 'junk'],
    });
    expect(cfg.webApps).toEqual([]);
    const none = await resolveWith('absent', { port: 44040 });
    expect(none.webApps).toEqual([]);
  });
});

describe('config.json dictation models', () => {
  // The two passes fail independently — a model can serve TEXT while answering
  // 500 to inline AUDIO (gemini-3.6/3.7-flash, 2026-08-17) — so they are
  // configured separately and the legacy single key must still work.
  it('reads model-audio and model-text separately', async () => {
    const cfg = await resolveWith('split', {
      dictation: { apiKey: 'k', 'model-audio': 'gemini-3.5-flash', 'model-text': 'gemini-3.7-flash' },
    });
    expect(cfg.dictation).toEqual({
      apiKey: 'k',
      modelAudio: 'gemini-3.5-flash',
      modelText: 'gemini-3.7-flash',
    });
  });

  it('a legacy single `model` still sets BOTH passes', async () => {
    // Each host has its own config.json, so old files are still in the wild;
    // ignoring the key would silently move them onto the defaults.
    const cfg = await resolveWith('legacy', { dictation: { apiKey: 'k', model: 'gemini-2.5-flash' } });
    expect(cfg.dictation.modelAudio).toBe('gemini-2.5-flash');
    expect(cfg.dictation.modelText).toBe('gemini-2.5-flash');
  });

  it('a specific key overrides the legacy one', async () => {
    const cfg = await resolveWith('mixed', {
      dictation: { apiKey: 'k', model: 'old', 'model-audio': 'gemini-3.5-flash' },
    });
    expect(cfg.dictation.modelAudio).toBe('gemini-3.5-flash');
    expect(cfg.dictation.modelText).toBe('old');
  });

  it('ignores blank/non-string values instead of blanking a model', async () => {
    const cfg = await resolveWith('junk', {
      dictation: { apiKey: 'k', 'model-audio': '  ', 'model-text': 42 },
    });
    expect(cfg.dictation.modelAudio).toBe('gemini-3.5-flash');
    expect(cfg.dictation.modelText).toBe('gemini-3.7-flash');
  });
});

describe('config.json size limits', () => {
  it('accepts the human form for both caps', async () => {
    const cfg = await resolveWith('sizes', { maxUploadBytes: '1GB', maxDownloadBytes: '512MB' });
    expect(cfg.maxUploadBytes).toBe(1024 ** 3);
    expect(cfg.maxDownloadBytes).toBe(512 * 1024 * 1024);
  });

  it('still accepts a bare byte count, so existing files keep their meaning', async () => {
    const cfg = await resolveWith('bytes', { maxUploadBytes: 52428800 });
    expect(cfg.maxUploadBytes).toBe(52428800);
  });

  // 0 is the documented "no limit" setting for both.
  it('keeps zero rather than reading it as unset', async () => {
    const cfg = await resolveWith('zero', { maxUploadBytes: 0, maxDownloadBytes: 0 });
    expect(cfg.maxUploadBytes).toBe(0);
    expect(cfg.maxDownloadBytes).toBe(0);
  });

  // A typo must not silently pick a different magnitude — it falls back to the
  // default, which is the value the operator can at least reason about.
  it('ignores a value outside the grammar and keeps the default', async () => {
    const cfg = await resolveWith('bad', { maxUploadBytes: '1 gigabyte', maxDownloadBytes: '2G' });
    expect(cfg.maxUploadBytes).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    expect(cfg.maxDownloadBytes).toBe(DEFAULT_MAX_DOWNLOAD_BYTES);
  });

  it('defaults download to 1 GB and leaves upload at 50 MB', async () => {
    const cfg = await resolveWith('defaults', {});
    expect(cfg.maxDownloadBytes).toBe(1024 ** 3);
    expect(cfg.maxUploadBytes).toBe(50 * 1024 * 1024);
  });

  it('lets the env override the file, in the same grammar', async () => {
    process.env['PALMUX_MAX_UPLOAD_BYTES'] = '2GB';
    try {
      const cfg = await resolveWith('env', { maxUploadBytes: '10MB' });
      expect(cfg.maxUploadBytes).toBe(2 * 1024 ** 3);
    } finally {
      delete process.env['PALMUX_MAX_UPLOAD_BYTES'];
    }
  });
});
