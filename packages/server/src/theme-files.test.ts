import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverThemes } from './theme-files';

describe('discoverThemes (user theme files)', () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'palmux-themes-'));
    prev = process.env['PALMUX_CONFIG_DIR'];
    process.env['PALMUX_CONFIG_DIR'] = dir;
    mkdirSync(join(dir, 'themes'), { recursive: true });
  });

  afterEach(() => {
    if (prev === undefined) delete process.env['PALMUX_CONFIG_DIR'];
    else process.env['PALMUX_CONFIG_DIR'] = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it('discovers an Xresources .conf user theme', () => {
    writeFileSync(
      join(dir, 'themes', 'mocha.conf'),
      '*.foreground: #cdd6f4\n*.background: #1e1e2e\n*.color1: #f38ba8\n',
    );
    const t = discoverThemes().find((p) => p.id === 'user:mocha');
    expect(t).toBeDefined();
    expect(t!.bg).toBe(0x1e1e2e);
    expect(t!.ansi16[1]).toBe(0xf38ba8);
  });

  it('discovers a Windows-Terminal .json user theme (purple→magenta slot)', () => {
    writeFileSync(
      join(dir, 'themes', 'onehalf.json'),
      JSON.stringify({
        name: 'One Half',
        foreground: '#dcdfe4',
        background: '#282c34',
        purple: '#c678dd',
      }),
    );
    const t = discoverThemes().find((p) => p.id === 'user:onehalf');
    expect(t).toBeDefined();
    expect(t!.name).toBe('One Half');
    expect(t!.ansi16[5]).toBe(0xc678dd);
  });

  it('skips a malformed theme without fg/bg', () => {
    writeFileSync(join(dir, 'themes', 'bad.conf'), '*.color0: #111111\n');
    expect(discoverThemes().find((p) => p.id === 'user:bad')).toBeUndefined();
  });

  it('never throws when the themes dir is absent', () => {
    rmSync(join(dir, 'themes'), { recursive: true, force: true });
    expect(() => discoverThemes()).not.toThrow();
  });
});

describe('discoverThemes (emulator auto-discovery)', () => {
  let home: string;
  let prevHome: string | undefined;
  let prevCfg: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'palmux-home-'));
    prevHome = process.env['HOME'];
    prevCfg = process.env['PALMUX_CONFIG_DIR'];
    process.env['HOME'] = home; // os.homedir() honors $HOME on POSIX
    // Point the user-themes dir elsewhere so only emulator sources contribute.
    process.env['PALMUX_CONFIG_DIR'] = mkdtempSync(join(tmpdir(), 'palmux-cfg-'));
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    if (prevCfg === undefined) delete process.env['PALMUX_CONFIG_DIR'];
    else process.env['PALMUX_CONFIG_DIR'] = prevCfg;
    rmSync(home, { recursive: true, force: true });
  });

  it('discovers an Alacritty TOML config at its standard location', () => {
    mkdirSync(join(home, '.config', 'alacritty'), { recursive: true });
    writeFileSync(
      join(home, '.config', 'alacritty', 'alacritty.toml'),
      [
        '[colors.primary]',
        'background = "#1d2021"',
        'foreground = "#ebdbb2"',
        '[colors.normal]',
        'red = "#cc241d"',
      ].join('\n'),
    );
    const t = discoverThemes().find((p) => p.id === 'alacritty');
    expect(t).toBeDefined();
    expect(t!.name).toBe('Alacritty');
    expect(t!.bg).toBe(0x1d2021);
    expect(t!.ansi16[1]).toBe(0xcc241d);
  });

  it('discovers a WezTerm Lua config at its standard location', () => {
    mkdirSync(join(home, '.config', 'wezterm'), { recursive: true });
    writeFileSync(
      join(home, '.config', 'wezterm', 'wezterm.lua'),
      "return { colors = { foreground = '#c0c0c0', background = '#1e1e1e' } }",
    );
    const t = discoverThemes().find((p) => p.id === 'wezterm');
    expect(t).toBeDefined();
    expect(t!.name).toBe('WezTerm');
    expect(t!.fg).toBe(0xc0c0c0);
  });
});
