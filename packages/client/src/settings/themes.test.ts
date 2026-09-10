// Theme token / accent derivation: the default stays pixel-identical, every
// built-in profile derives readable + complete tokens, light vs dark shade in
// the right direction, overrides win, and applyThemeTokens sets every var.

import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCENT_NAMES,
  applyThemeTokens,
  COLOR_PROFILES,
  deriveAccents,
  deriveUiTokens,
  getProfile,
  isLightBg,
  luminance,
  mix,
  type ColorProfile,
} from './themes';

describe('mix', () => {
  it('blends endpoints and midpoints', () => {
    expect(mix(0x000000, 0xffffff, 0)).toBe(0x000000);
    expect(mix(0x000000, 0xffffff, 1)).toBe(0xffffff);
    expect(mix(0x000000, 0xffffff, 0.5)).toBe(0x808080);
  });
});

describe('deriveUiTokens', () => {
  it('keeps Catppuccin Mocha (the default) pixel-identical to the shipped tokens', () => {
    const t = deriveUiTokens(getProfile('catppuccin-mocha'));
    expect(t).toEqual({
      base: 0x1e1e2e,
      mantle: 0x181825,
      surface: 0x313244,
      text: 0xcdd6f4,
      subtext: 0x9399b2,
      accent: 0xa6e3a1,
      accentAlt: 0xfab387,
    });
  });

  it('every profile derives readable contrast (text vs base and surface)', () => {
    for (const p of COLOR_PROFILES) {
      const t = deriveUiTokens(p);
      const tvb = Math.abs(luminance(t.text) - luminance(t.base));
      const tvs = Math.abs(luminance(t.text) - luminance(t.surface));
      expect(tvb, `${p.id}: text/base`).toBeGreaterThan(0.3);
      expect(tvs, `${p.id}: text/surface`).toBeGreaterThan(0.2);
    }
  });

  it('surface moves TOWARD the fg (dark→lighter, light→darker)', () => {
    const dark = deriveUiTokens(getProfile('dracula'));
    expect(luminance(dark.surface)).toBeGreaterThan(luminance(dark.base)); // dark bg → lighter surface
    const light = deriveUiTokens(getProfile('github-light'));
    expect(luminance(light.surface)).toBeLessThan(luminance(light.base)); // light bg → darker surface
  });

  it('subtext sits between text and base', () => {
    for (const p of COLOR_PROFILES) {
      const t = deriveUiTokens(p);
      const lo = Math.min(luminance(t.text), luminance(t.base));
      const hi = Math.max(luminance(t.text), luminance(t.base));
      expect(luminance(t.subtext)).toBeGreaterThanOrEqual(lo - 0.01);
      expect(luminance(t.subtext)).toBeLessThanOrEqual(hi + 0.01);
    }
  });

  it('explicit ui overrides win; the rest still derive', () => {
    const p: ColorProfile = {
      id: 'x',
      name: 'x',
      fg: 0xffffff,
      bg: 0x000000,
      ansi16: Array(16).fill(0x808080),
      ui: { accent: 0x123456 },
    };
    const t = deriveUiTokens(p);
    expect(t.accent).toBe(0x123456); // override
    expect(t.base).toBe(0x000000); // still derived
  });
});

describe('isLightBg', () => {
  it('classifies the light profiles', () => {
    expect(isLightBg(getProfile('catppuccin-latte'))).toBe(true);
    expect(isLightBg(getProfile('github-light'))).toBe(true);
    expect(isLightBg(getProfile('solarized-light'))).toBe(true);
    expect(isLightBg(getProfile('catppuccin-mocha'))).toBe(false);
    expect(isLightBg(getProfile('pure-black'))).toBe(false);
  });
});

describe('deriveAccents', () => {
  it('yields all twelve named accents for every profile', () => {
    for (const p of COLOR_PROFILES) {
      const a = deriveAccents(p);
      for (const name of ACCENT_NAMES) {
        expect(a[name], `${p.id}:${name}`).toBeTypeOf('number');
        expect(a[name]).toBeGreaterThanOrEqual(0);
        expect(a[name]).toBeLessThanOrEqual(0xffffff);
      }
    }
  });

  it('Mocha accents match the canonical Catppuccin names', () => {
    const a = deriveAccents(getProfile('catppuccin-mocha'));
    expect(a.red).toBe(0xf38ba8);
    expect(a.green).toBe(0xa6e3a1);
    expect(a.lavender).toBe(0xb4befe);
    expect(a.maroon).toBe(0xeba0ac);
  });

  it('derives peach/sky/lavender from the theme ansi palette when not overridden', () => {
    const a = deriveAccents(getProfile('dracula')); // no accents override
    // peach = red↔yellow midpoint; sky = lighter cyan; both distinct from base.
    expect(a.peach).not.toBe(a.red);
    expect(a.peach).not.toBe(a.yellow);
    expect(luminance(a.sky)).toBeGreaterThan(luminance(a.teal));
  });
});

describe('applyThemeTokens', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style');
  });

  it('sets all seven UI tokens + accent ink + sixteen ansi slot vars + color-scheme', () => {
    applyThemeTokens(getProfile('gruvbox-dark'));
    const s = document.documentElement.style;
    for (const v of [
      '--t-base',
      '--t-mantle',
      '--t-surface',
      '--t-text',
      '--t-subtext',
      '--t-accent',
      '--t-accent-alt',
    ]) {
      expect(s.getPropertyValue(v), v).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(s.getPropertyValue('--t-accent-ink')).toMatch(/^#[0-9a-f]{6}$/);
    for (let n = 0; n < 16; n++) {
      expect(s.getPropertyValue(`--tab-c-ansi${n}`), `ansi${n}`).toMatch(/^#[0-9a-f]{6}$/);
      expect(s.getPropertyValue(`--tab-c-ansi${n}-ink`), `ansi${n}-ink`).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(s.getPropertyValue('color-scheme')).toBe('dark');
  });

  it('a light profile sets color-scheme:light and matching tokens', () => {
    applyThemeTokens(getProfile('solarized-light'));
    const s = document.documentElement.style;
    expect(s.getPropertyValue('color-scheme')).toBe('light');
    expect(s.getPropertyValue('--t-base')).toBe('#fdf6e3');
  });

  it('applying Mocha yields the shipped default token strings', () => {
    applyThemeTokens(getProfile('catppuccin-mocha'));
    const s = document.documentElement.style;
    expect(s.getPropertyValue('--t-base')).toBe('#1e1e2e');
    expect(s.getPropertyValue('--t-surface')).toBe('#313244');
    expect(s.getPropertyValue('--t-accent')).toBe('#a6e3a1');
    expect(s.getPropertyValue('--tab-c-ansi1')).toBe('#f38ba8'); // ansi16[1] = red
    expect(s.getPropertyValue('--tab-c-ansi0-ink')).toBe('#f2f2f8'); // dark bg → light ink
  });
});
