// Claude Code theme export: the palmux palette serialises to a custom theme
// Claude Code can load, for every profile and both polarities.

import { describe, expect, it } from 'vitest';
import { COLOR_PROFILES, getProfile, isLightBg } from '@palmux/shared';
import { buildClaudeTheme, claudeThemePath, pickBase } from './claude-theme';

/** The keys the user's Claude Code build reads — every one must be present. */
const REQUIRED = [
  'claude',
  'claudeShimmer',
  'text',
  'inverseText',
  'inactive',
  'inactiveShimmer',
  'subtle',
  'suggestion',
  'permission',
  'permissionShimmer',
  'remember',
  'success',
  'error',
  'warning',
  'warningShimmer',
  'merged',
  'promptBorder',
  'promptBorderShimmer',
  'planMode',
  'autoAccept',
  'bashBorder',
  'ide',
  'fastMode',
  'fastModeShimmer',
  'diffAdded',
  'diffRemoved',
  'diffAddedDimmed',
  'diffRemovedDimmed',
  'diffAddedWord',
  'diffRemovedWord',
  'userMessageBackground',
  'userMessageBackgroundHover',
  'bashMessageBackgroundColor',
  'memoryBackgroundColor',
  'selectionBg',
  'rate_limit_fill',
  'rate_limit_empty',
  'briefLabelYou',
  'briefLabelClaude',
  'red_FOR_SUBAGENTS_ONLY',
  'blue_FOR_SUBAGENTS_ONLY',
  'green_FOR_SUBAGENTS_ONLY',
  'yellow_FOR_SUBAGENTS_ONLY',
  'purple_FOR_SUBAGENTS_ONLY',
  'orange_FOR_SUBAGENTS_ONLY',
  'pink_FOR_SUBAGENTS_ONLY',
  'cyan_FOR_SUBAGENTS_ONLY',
  'rainbow_red',
  'rainbow_red_shimmer',
  'rainbow_orange',
  'rainbow_orange_shimmer',
  'rainbow_yellow',
  'rainbow_yellow_shimmer',
  'rainbow_green',
  'rainbow_green_shimmer',
  'rainbow_blue',
  'rainbow_blue_shimmer',
  'rainbow_indigo',
  'rainbow_indigo_shimmer',
  'rainbow_violet',
  'rainbow_violet_shimmer',
];

const parse = (id: string): { name: string; base: string; overrides: Record<string, string> } =>
  JSON.parse(buildClaudeTheme(id));

describe('claudeThemePath', () => {
  it('targets the Claude Code user-theme directory', () => {
    expect(claudeThemePath()).toMatch(/\.claude\/themes\/palmux\.json$/);
  });
});

describe('buildClaudeTheme', () => {
  it('emits every key Claude Code reads, as literal hex', () => {
    const t = parse('catppuccin-mocha');
    for (const key of REQUIRED) {
      expect(t.overrides[key], key).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(Object.keys(t.overrides).sort()).toEqual([...REQUIRED].sort());
  });

  it('keeps the theme name stable so a /theme selection survives a repaint', () => {
    expect(parse('catppuccin-mocha').name).toBe('Palmux');
    expect(parse('github-light').name).toBe('Palmux');
  });

  it('follows the palette: semantic colours are the theme own accents', () => {
    const t = parse('catppuccin-mocha');
    expect(t.overrides['error']).toBe('#f38ba8'); // mocha red
    expect(t.overrides['text']).toBe('#cdd6f4');
    expect(t.overrides['inverseText']).toBe('#1e1e2e'); // the bg
  });

  it('picks a base that PAINTS, matching the theme polarity', () => {
    // Never the `-ansi` variants: they render diffs with no background fill, so
    // every diff override here would be silently discarded.
    expect(parse('catppuccin-mocha').base).toBe('dark');
    expect(parse('catppuccin-latte').base).toBe('light');
    expect(parse('github-light').base).toBe('light');
    for (const p of COLOR_PROFILES) expect(parse(p.id).base).not.toMatch(/-ansi$/);
  });

  it('shimmers move away from the background in both polarities', () => {
    const lum = (h: string): number => {
      const n = parseInt(h.slice(1), 16);
      return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
    };
    const dark = parse('catppuccin-mocha').overrides;
    expect(lum(dark['warningShimmer']!)).toBeGreaterThan(lum(dark['warning']!));
    const light = parse('github-light').overrides;
    expect(lum(light['warningShimmer']!)).toBeLessThan(lum(light['warning']!));
  });

  it('renders valid hex for every shipped profile', () => {
    for (const profile of COLOR_PROFILES) {
      const t = parse(profile.id);
      expect(t.base).toBe(isLightBg(getProfile(profile.id)) ? 'light' : 'dark');
      for (const [key, value] of Object.entries(t.overrides)) {
        expect(value, `${profile.id}.${key}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('passes git-delta diff colours through VERBATIM', () => {
    // delta's plus here is BLUE, not green: the whole point is that palmux must
    // neither re-derive it from its own accents nor blend it toward the theme —
    // a diff has to read identically in git, lazygit and Claude.
    const t = JSON.parse(
      buildClaudeTheme('catppuccin-mocha', { added: 0x163d52, removed: 0x200202 }),
    ) as { overrides: Record<string, string> };
    expect(t.overrides['diffAdded']).toBe('#163d52');
    expect(t.overrides['diffRemoved']).toBe('#200202');
    // Keys delta does not define stay on the palette derivation.
    expect(t.overrides['diffAddedWord']).toBe(parse('catppuccin-mocha').overrides['diffAddedWord']);
  });

  it('passes them through unchanged on a LIGHT theme too', () => {
    // The theme's polarity picks WHICH delta palette applies; it never alters it.
    const t = JSON.parse(
      buildClaudeTheme('github-light', { added: 0xddf4ff, removed: 0xffebe9 }),
    ) as { base: string; overrides: Record<string, string> };
    expect(t.base).toBe('light-daltonized'); // delta's added is blue → blue base
    expect(t.overrides['diffAdded']).toBe('#ddf4ff');
    expect(t.overrides['diffRemoved']).toBe('#ffebe9');
  });

  it('falls back to the palette when the user has no delta config', () => {
    expect(buildClaudeTheme('catppuccin-mocha', {})).toBe(buildClaudeTheme('catppuccin-mocha'));
  });

  it('ends with a trailing newline', () => {
    expect(buildClaudeTheme('catppuccin-mocha').endsWith('}\n')).toBe(true);
  });

  it('inherits the base whose diff HUE matches delta (green vs blue additions)', () => {
    // Workaround for anthropics/claude-code#69445: the diff renderer reads the
    // BASE's colours and discards our overrides, so the base is the only lever.
    // Additions moved from green to blue (this user's delta) → daltonized.
    expect(pickBase(true, { added: 0xddf4ff, removed: 0xffebe9 })).toBe('light-daltonized');
    expect(pickBase(false, { added: 0x163d52, removed: 0x200202 })).toBe('dark-daltonized');
    // A conventional green delta keeps the plain base — including a PALE green,
    // which a raw colour-distance test gets wrong (it sits nearer the pale blue
    // than the saturated stock green).
    expect(pickBase(true, { added: 0xd4f7d4, removed: 0xffd7d5 })).toBe('light');
    expect(pickBase(false, { added: 0x1c3a20, removed: 0x4a1416 })).toBe('dark');
  });

  it('stays on the plain base when there is no delta palette to match', () => {
    expect(pickBase(true, {})).toBe('light');
    expect(pickBase(false, {})).toBe('dark');
  });

  it('never picks an -ansi base, whatever delta says', () => {
    for (const light of [true, false]) {
      for (const c of [0x000000, 0xffffff, 0x163d52, 0xff00ff]) {
        expect(pickBase(light, { added: c, removed: c })).not.toMatch(/-ansi$/);
      }
    }
  });
});
