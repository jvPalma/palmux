import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type ConfigModule = typeof import('./config');

const created: string[] = [];

/**
 * Point PALMUX_CONFIG_DIR at a fresh temp dir derived from the test name,
 * reset the module registry, and import a clean copy of ./config so each case
 * gets isolated filesystem state.
 */
async function freshConfig(label: string): Promise<{ dir: string; mod: ConfigModule }> {
  const dir = join(
    tmpdir(),
    `palmux-test-${label.replace(/\W+/g, '-')}-${Math.random().toString(36).slice(2)}`,
  );
  process.env['PALMUX_CONFIG_DIR'] = dir;
  created.push(dir);
  vi.resetModules();
  const mod = await import('./config');
  return { dir, mod };
}

beforeEach(() => {
  delete process.env['PALMUX_CONFIG_DIR'];
});

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env['PALMUX_CONFIG_DIR'];
});

describe('configDir / ensureConfigDir', () => {
  it('honors PALMUX_CONFIG_DIR and creates the directory', async () => {
    const { dir, mod } = await freshConfig('ensure');
    expect(mod.configDir()).toBe(dir);
    expect(existsSync(dir)).toBe(false);
    expect(mod.ensureConfigDir()).toBe(dir);
    expect(existsSync(dir)).toBe(true);
  });
});

describe('loadOrCreateSecret', () => {
  it('creates a 64-char hex secret and is stable across calls', async () => {
    const { mod } = await freshConfig('secret-stable');
    const first = mod.loadOrCreateSecret();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    const second = mod.loadOrCreateSecret();
    expect(second).toBe(first);
  });
});

describe('rotateSecret', () => {
  it('replaces the existing secret with a new 64-char hex value', async () => {
    const { mod } = await freshConfig('rotate');
    const original = mod.loadOrCreateSecret();
    const rotated = mod.rotateSecret();
    expect(rotated).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated).not.toBe(original);
    // Subsequent loads see the rotated value.
    expect(mod.loadOrCreateSecret()).toBe(rotated);
  });
});

describe('settings persistence', () => {
  it('defaults to {} when absent and round-trips on save', async () => {
    const { mod } = await freshConfig('settings');
    expect(mod.loadSettings()).toEqual({});
    const value = { fontSize: 14, theme: 'dark', nested: { a: [1, 2] } };
    mod.saveSettings(value);
    expect(mod.loadSettings()).toEqual(value);
  });

  // themeId is split off so a dotfiles manager can track settings.json without
  // every machine's theme turning each pull into a conflict.
  it('writes themeId to settings.local.json, everything else to settings.json', async () => {
    const { dir, mod } = await freshConfig('split');
    mod.saveSettings({ themeId: 'gruvbox-dark', fontFamily: 'Fira Code' });

    const shared = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    const local = JSON.parse(readFileSync(join(dir, 'settings.local.json'), 'utf8'));
    expect(shared).toEqual({ fontFamily: 'Fira Code' });
    expect(local).toEqual({ themeId: 'gruvbox-dark' });
    // The split is invisible to every reader.
    expect(mod.loadSettings()).toEqual({ themeId: 'gruvbox-dark', fontFamily: 'Fira Code' });
  });

  it('the local themeId wins over one a dotfiles pull put back in the shared file', async () => {
    const { dir, mod } = await freshConfig('local-wins');
    mod.saveSettings({ themeId: 'mine' });
    // Simulate `yadm pull` bringing another machine's settings.json down.
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ themeId: 'theirs', scrollback: 99 }),
    );
    expect(mod.loadSettings()).toEqual({ themeId: 'mine', scrollback: 99 });
  });

  it('adopts a pre-split settings.json until this machine picks a theme', async () => {
    const { dir, mod } = await freshConfig('migrate');
    mod.ensureConfigDir();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ themeId: 'legacy' }));
    expect(existsSync(join(dir, 'settings.local.json'))).toBe(false);
    // Boot reads it, so theme-export still resolves the right palette.
    expect(mod.loadSettings()).toEqual({ themeId: 'legacy' });
  });

  it('boot lifts a legacy themeId out of the shared file without waiting for a change', async () => {
    const { dir, mod } = await freshConfig('split-migrate');
    mod.ensureConfigDir();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ themeId: 'legacy', scrollback: 7 }));
    mod.ensureSettingsSplit();
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ scrollback: 7 });
    expect(JSON.parse(readFileSync(join(dir, 'settings.local.json'), 'utf8'))).toEqual({
      themeId: 'legacy',
    });
  });

  it('the migration does not clobber a themeId this machine already chose', async () => {
    const { dir, mod } = await freshConfig('split-migrate-keep');
    mod.saveSettings({ themeId: 'mine' });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ themeId: 'theirs' }));
    mod.ensureSettingsSplit();
    expect(mod.loadSettings()).toEqual({ themeId: 'mine' });
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({});
  });

  it('keeps the per-device file at 0600 — it sits beside the secret', async () => {
    const { dir, mod } = await freshConfig('local-mode');
    mod.saveSettings({ themeId: 'x' });
    expect(statSync(join(dir, 'settings.local.json')).mode & 0o777).toBe(0o600);
  });
});

describe('config .gitignore', () => {
  it('is written on first run and covers the state that must not sync', async () => {
    const { dir, mod } = await freshConfig('gitignore');
    mod.ensureConfigGitignore();
    const body = readFileSync(join(dir, '.gitignore'), 'utf8');
    // The secret IS the shell, transcripts are ~100 MB of audio, and
    // settings.local.json is the whole point of the split above.
    for (const entry of ['secret', 'transcripts/', 'settings.local.json', 'sessions/', '*.log']) {
      expect(body, entry).toContain(entry);
    }
  });

  it('never overwrites one the user has edited', async () => {
    const { dir, mod } = await freshConfig('gitignore-keep');
    mod.ensureConfigGitignore();
    writeFileSync(join(dir, '.gitignore'), 'mine\n');
    mod.ensureConfigGitignore();
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('mine\n');
  });
});

describe('extra-keys persistence', () => {
  it('defaults to {} when absent and round-trips on save', async () => {
    const { mod } = await freshConfig('extra-keys');
    expect(mod.loadExtraKeys()).toEqual({});
    const value = { enabled: true, layout: [['ESC', 'TAB']] };
    mod.saveExtraKeys(value);
    expect(mod.loadExtraKeys()).toEqual(value);
  });

  it('keeps settings and extra-keys in separate files', async () => {
    const { dir, mod } = await freshConfig('separate');
    mod.saveSettings({ a: 1 });
    mod.saveExtraKeys({ b: 2 });
    expect(mod.loadSettings()).toEqual({ a: 1 });
    expect(mod.loadExtraKeys()).toEqual({ b: 2 });
    expect(existsSync(join(dir, 'settings.json'))).toBe(true);
    expect(existsSync(join(dir, 'extra-keys.json'))).toBe(true);
    expect(statSync(join(dir, 'settings.json')).isFile()).toBe(true);
  });
});
