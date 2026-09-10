import { describe, it, expect } from 'vitest';
import {
  parseAlacrittyTheme,
  parseGoghTheme,
  parseHexColor,
  parseKeyValueTheme,
  parseWezTermTheme,
  parseWindowsTerminalScheme,
} from './theme-parse';

describe('parseHexColor', () => {
  it('parses #rrggbb, rrggbb, 0x, and #rgb', () => {
    expect(parseHexColor('#1e1e2e')).toBe(0x1e1e2e);
    expect(parseHexColor('1E1E2E')).toBe(0x1e1e2e);
    expect(parseHexColor('0x1e1e2e')).toBe(0x1e1e2e);
    expect(parseHexColor('  "#abc" ')).toBe(0xaabbcc);
  });
  it('rejects junk', () => {
    expect(parseHexColor('nope')).toBeNull();
    expect(parseHexColor('#12345')).toBeNull();
    expect(parseHexColor('')).toBeNull();
  });
});

describe('parseKeyValueTheme', () => {
  it('parses Xresources (colon separator, *.colorN)', () => {
    const text = [
      '! a comment',
      '*.foreground: #cdd6f4',
      '*.background: #1e1e2e',
      '*.color0: #45475a',
      '*.color15: #b4befe',
    ].join('\n');
    const p = parseKeyValueTheme(text, 'user:mocha', 'Mocha')!;
    expect(p).not.toBeNull();
    expect(p.fg).toBe(0xcdd6f4);
    expect(p.bg).toBe(0x1e1e2e);
    expect(p.ansi16).toHaveLength(16);
    expect(p.ansi16[0]).toBe(0x45475a);
    expect(p.ansi16[15]).toBe(0xb4befe);
    // Unspecified slots backfill from fg.
    expect(p.ansi16[7]).toBe(0xcdd6f4);
  });

  it('parses Termux properties (= separator)', () => {
    const text = 'foreground=#ffffff\nbackground=#000000\ncolor1=#ff0000';
    const p = parseKeyValueTheme(text, 'termux', 'Termux')!;
    expect(p.fg).toBe(0xffffff);
    expect(p.bg).toBe(0x000000);
    expect(p.ansi16[1]).toBe(0xff0000);
  });

  it('parses Kitty (space separator, color0 form)', () => {
    const text = 'foreground #dcdfe4\nbackground #282c34\ncolor2 #98c379';
    const p = parseKeyValueTheme(text, 'kitty', 'Kitty')!;
    expect(p.fg).toBe(0xdcdfe4);
    expect(p.bg).toBe(0x282c34);
    expect(p.ansi16[2]).toBe(0x98c379);
  });

  it('parses Ghostty palette lines', () => {
    const text = 'foreground = #ffffff\nbackground = #101010\npalette = 3=#f9e2af';
    const p = parseKeyValueTheme(text, 'ghostty', 'Ghostty')!;
    expect(p.fg).toBe(0xffffff);
    expect(p.ansi16[3]).toBe(0xf9e2af);
  });

  it('returns null without both fg and bg', () => {
    expect(parseKeyValueTheme('color0: #111111', 'x', 'x')).toBeNull();
    expect(parseKeyValueTheme('foreground: #ffffff', 'x', 'x')).toBeNull();
  });
});

describe('parseAlacrittyTheme', () => {
  const toml = [
    '# Gruvbox',
    '[colors.primary]',
    'background = "#1d2021"',
    'foreground = "#ebdbb2"  # inline comment',
    '',
    '[colors.normal]',
    'black   = "#282828"',
    'red     = "0xcc241d"',
    'magenta = "#b16286"',
    '',
    '[colors.bright]',
    'black   = "#928374"',
    'white   = "#ebdbb2"',
  ].join('\n');

  it('parses primary/normal/bright tables into slots (magenta → 5)', () => {
    const p = parseAlacrittyTheme(toml, 'alacritty', 'Alacritty')!;
    expect(p).not.toBeNull();
    expect(p.fg).toBe(0xebdbb2);
    expect(p.bg).toBe(0x1d2021);
    expect(p.ansi16).toHaveLength(16);
    expect(p.ansi16[0]).toBe(0x282828); // normal black
    expect(p.ansi16[1]).toBe(0xcc241d); // 0x-prefixed value
    expect(p.ansi16[5]).toBe(0xb16286); // normal magenta → slot 5
    expect(p.ansi16[8]).toBe(0x928374); // bright black → slot 8
    // Unspecified slot backfills from fg.
    expect(p.ansi16[3]).toBe(0xebdbb2);
  });

  it('returns null without primary fg + bg', () => {
    expect(parseAlacrittyTheme('[colors.normal]\nred = "#ff0000"', 'x', 'x')).toBeNull();
  });
});

describe('parseWezTermTheme', () => {
  const lua = [
    'local wezterm = require("wezterm")',
    'local config = {}',
    'config.window_background_opacity = 0.9 -- not a color',
    'config.colors = {',
    "  foreground = '#c0c0c0',",
    "  background = '#1e1e1e', -- dark",
    "  ansi = { '#000000', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff' },",
    "  brights = { '#808080', '#ff8080' },",
    '}',
    'return config',
  ].join('\n');

  it('parses foreground/background + ansi/brights arrays', () => {
    const p = parseWezTermTheme(lua, 'wezterm', 'WezTerm')!;
    expect(p).not.toBeNull();
    expect(p.fg).toBe(0xc0c0c0);
    expect(p.bg).toBe(0x1e1e1e);
    expect(p.ansi16[0]).toBe(0x000000);
    expect(p.ansi16[5]).toBe(0xff00ff); // ansi[5]
    expect(p.ansi16[8]).toBe(0x808080); // brights[0] → slot 8
    expect(p.ansi16[9]).toBe(0xff8080); // brights[1] → slot 9
    // brights only supplied 2 → slot 15 backfills from fg.
    expect(p.ansi16[15]).toBe(0xc0c0c0);
  });

  it('returns null without fg + bg (e.g. named color_scheme only)', () => {
    expect(parseWezTermTheme("config.color_scheme = 'Batman'", 'x', 'x')).toBeNull();
  });
});

describe('parseWindowsTerminalScheme', () => {
  it('maps WT keys to ANSI slots (purple → magenta)', () => {
    const scheme = {
      name: 'One Half Dark',
      foreground: '#DCDFE4',
      background: '#282C34',
      black: '#282C34',
      red: '#E06C75',
      green: '#98C379',
      yellow: '#E5C07B',
      blue: '#61AFEF',
      purple: '#C678DD',
      cyan: '#56B6C2',
      white: '#DCDFE4',
      brightBlack: '#5A6374',
      brightPurple: '#C678DD',
    };
    const p = parseWindowsTerminalScheme(scheme, 'user:onehalf')!;
    expect(p.name).toBe('One Half Dark');
    expect(p.fg).toBe(0xdcdfe4);
    expect(p.bg).toBe(0x282c34);
    expect(p.ansi16[5]).toBe(0xc678dd); // purple → slot 5 (magenta)
    expect(p.ansi16[13]).toBe(0xc678dd); // brightPurple → slot 13
    expect(p.ansi16).toHaveLength(16);
  });

  it('returns null without fg/bg, uses id as name fallback', () => {
    expect(parseWindowsTerminalScheme({ black: '#000000' }, 'x')).toBeNull();
    const p = parseWindowsTerminalScheme({ foreground: '#fff', background: '#000' }, 'noname')!;
    expect(p.name).toBe('noname');
  });
});

describe('parseGoghTheme', () => {
  // The real Gogh Dracula.yml, abridged — inline comments and all.
  const YML = `---
name: 'Dracula'
author: 'Dracula (https://draculatheme.com)'
variant: 'dark'            # dark or light

color_01: '#262626'    # Black (Host)
color_02: '#E64747'    # Red (Syntax string)
color_16: '#F9F9FB'    # Bright White

background: '#282A36'  # Background
foreground: '#F8F8F2'  # Foreground (Text)

cursor: '#F8F8F2'      # Cursor`;

  const SH = `#!/usr/bin/env bash
export PROFILE_NAME="Dracula"
export COLOR_01="#262626"           # Black (Host)
export COLOR_02="#E64747"           # Red (Syntax string)
export COLOR_16="#F9F9FB"           # Bright White
export BACKGROUND_COLOR="#282A36"   # Background
export FOREGROUND_COLOR="#F8F8F2"   # Foreground (Text)`;

  it('maps Gogh 1-indexed slots onto 0-indexed ANSI', () => {
    const p = parseGoghTheme(YML, 'user:dracula', 'fallback')!;
    // color_01 is BLACK — off by one and the whole palette shifts.
    expect(p.ansi16[0]).toBe(0x262626);
    expect(p.ansi16[1]).toBe(0xe64747);
    expect(p.ansi16[15]).toBe(0xf9f9fb);
  });

  it('reads fg/bg/cursor and prefers the theme own name', () => {
    const p = parseGoghTheme(YML, 'user:dracula', 'fallback')!;
    expect(p.bg).toBe(0x282a36);
    expect(p.fg).toBe(0xf8f8f2);
    expect(p.cursor).toBe(0xf8f8f2);
    expect(p.name).toBe('Dracula');
  });

  it('reads the install script the same way', () => {
    const p = parseGoghTheme(SH, 'user:dracula', 'fallback')!;
    expect(p.name).toBe('Dracula');
    expect(p.ansi16[0]).toBe(0x262626);
    expect(p.bg).toBe(0x282a36);
  });

  it('is not fooled by a hex-looking token inside a comment', () => {
    const p = parseGoghTheme(
      "background: '#282A36'  # was #ffffff\nforeground: '#F8F8F2'",
      'x',
      'x',
    )!;
    expect(p.bg).toBe(0x282a36);
  });

  it('backfills missing slots from the foreground', () => {
    const p = parseGoghTheme("background: '#000000'\nforeground: '#abcdef'", 'x', 'x')!;
    expect(p.ansi16).toHaveLength(16);
    expect(new Set(p.ansi16)).toEqual(new Set([0xabcdef]));
  });

  it('returns null without both fg and bg', () => {
    expect(parseGoghTheme("color_01: '#262626'", 'x', 'x')).toBeNull();
    expect(parseGoghTheme("background: '#000000'", 'x', 'x')).toBeNull();
  });

  it('falls back to the given name when the file has none', () => {
    const p = parseGoghTheme("background: '#000000'\nforeground: '#ffffff'", 'x', 'My Theme')!;
    expect(p.name).toBe('My Theme');
  });
});
