// Live tmux reload: palmux only re-sources a tmux.conf that actually consumes
// the theme export, so wiring the source-file line in IS the opt-in.

import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { consumesThemeExport, tmuxConfPath } from './tmux-reload';

const THEME_TMUX = `${homedir()}/.config/palmux/theme.tmux`;

describe('tmuxConfPath', () => {
  it('is the file `prefix + r` reloads', () => {
    expect(tmuxConfPath()).toBe(`${homedir()}/.tmux.conf`);
  });
});

describe('consumesThemeExport', () => {
  it('matches the ~ form a tmux.conf conventionally writes', () => {
    const conf = `if-shell 'test -r ~/.config/palmux/theme.tmux' 'source-file ~/.config/palmux/theme.tmux'`;
    expect(consumesThemeExport(conf, THEME_TMUX)).toBe(true);
  });

  it('matches an absolute path', () => {
    expect(consumesThemeExport(`source-file ${THEME_TMUX}`, THEME_TMUX)).toBe(true);
  });

  it('does not match a config that ignores the export', () => {
    const conf = `set -g status-style "bg=#141b27"\nrun-shell '~/.tmux/plugins/tmux2k/2k.tmux'`;
    expect(consumesThemeExport(conf, THEME_TMUX)).toBe(false);
  });

  it('does not match a different palmux file', () => {
    expect(consumesThemeExport('source-file ~/.config/palmux/theme.sh', THEME_TMUX)).toBe(false);
  });

  it('honours a relocated config dir (PALMUX_CONFIG_DIR)', () => {
    const moved = '/srv/palmux-cfg/theme.tmux';
    expect(consumesThemeExport(`source-file ${moved}`, moved)).toBe(true);
    expect(consumesThemeExport('source-file ~/.config/palmux/theme.tmux', moved)).toBe(false);
  });
});
