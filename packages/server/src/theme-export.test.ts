// theme.sh export: the palette resolves from a theme id and serialises to shell
// exports the user's p10k/tmux/delta configs source.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nearest256, resolveThemePalette } from '@palmux/shared';
import { buildThemeSh, themeIdFrom, writeThemeExport } from './theme-export';

describe('nearest256', () => {
  it('maps the cube + grayscale corners', () => {
    expect(nearest256(0x000000)).toBe(16);
    expect(nearest256(0xffffff)).toBe(231);
    // a mid gray lands on the grayscale ramp (232..255), not the cube
    const g = nearest256(0x808080);
    expect(g).toBeGreaterThanOrEqual(232);
    expect(g).toBeLessThanOrEqual(255);
  });
  it('is stable and in-range for every accent of every profile', () => {
    for (const id of ['catppuccin-mocha', 'dracula', 'github-light']) {
      const p = resolveThemePalette(id);
      for (const col of Object.values(p.colors)) {
        expect(col.index).toBeGreaterThanOrEqual(0);
        expect(col.index).toBeLessThanOrEqual(255);
        expect(col.hex).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });
});

describe('themeIdFrom', () => {
  it('reads themeId or falls back to the default', () => {
    expect(themeIdFrom({ themeId: 'dracula' })).toBe('dracula');
    expect(themeIdFrom({})).toBe('catppuccin-mocha');
    expect(themeIdFrom(undefined)).toBe('catppuccin-mocha');
  });
});

describe('buildThemeSh', () => {
  it('emits the dark default palette as shell exports', () => {
    const sh = buildThemeSh('catppuccin-mocha');
    expect(sh).toContain("export PALMUX_THEME='catppuccin-mocha'");
    expect(sh).toContain('export PALMUX_THEME_LIGHT=0');
    expect(sh).toContain("export PALMUX_C_BG='#1e1e2e'");
    expect(sh).toContain("export PALMUX_C_RED='#f38ba8'");
    // MAGENTA→mauve etc. is the USER's mapping; palmux exports its own names:
    expect(sh).toMatch(/export PALMUX_C_MAUVE='#[0-9a-f]{6}'/);
    expect(sh).toMatch(/export PALMUX_I_RED=\d+/);
    expect(sh).toMatch(/export PALMUX_C_ANSI0='#[0-9a-f]{6}'/);
  });

  it('flags a light theme', () => {
    expect(buildThemeSh('catppuccin-latte')).toContain('export PALMUX_THEME_LIGHT=1');
    expect(buildThemeSh('github-light')).toContain('export PALMUX_THEME_LIGHT=1');
  });
});

describe('writeThemeExport (polarity of a not-yet-registered user theme)', () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'palmux-export-'));
    prev = process.env['PALMUX_CONFIG_DIR'];
    process.env['PALMUX_CONFIG_DIR'] = dir;
    mkdirSync(join(dir, 'themes'), { recursive: true });
  });

  afterEach(() => {
    if (prev === undefined) delete process.env['PALMUX_CONFIG_DIR'];
    else process.env['PALMUX_CONFIG_DIR'] = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it('discovers the theme rather than silently exporting it as the dark default', () => {
    // A LIGHT user theme on disk that nothing has registered yet. getProfile
    // answers with the (dark) default for an unknown id, which would flip the
    // whole export: PALMUX_THEME_LIGHT=0, a dark ansi base, and — worst —
    // delta's DARK diff palette dropped onto a light background.
    writeFileSync(
      join(dir, 'themes', 'cream.conf'),
      '*.foreground: #5c6a72\n*.background: #fffbef\n*.color1: #f85552\n',
    );
    writeThemeExport(dir, 'user:cream');
    const sh = readFileSync(join(dir, 'theme.sh'), 'utf8');
    expect(sh).toContain("export PALMUX_THEME='user:cream'");
    expect(sh).toContain('export PALMUX_THEME_LIGHT=1');
  });
});
