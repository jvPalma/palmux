// An installed PWA paints its system bars from the MANIFEST. The client keeps
// `<meta name="theme-color">` in sync on every theme change and that is simply
// not the channel Android reads once the app is installed — which is how a light
// theme ended up under a near-black status bar.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getProfile, hex } from '@palmux/shared';
import { manifestColors, themedManifest } from './manifest';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'palmux-manifest-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BASE = {
  name: 'palmux',
  start_url: '/',
  display: 'standalone',
  background_color: '#1e1e2e',
  theme_color: '#1e1e2e',
  icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
};

const withManifest = (body: unknown = BASE): string => {
  const d = tmp();
  writeFileSync(join(d, 'manifest.webmanifest'), JSON.stringify(body));
  return d;
};

describe('manifestColors', () => {
  it('uses the terminal background, so the splash matches what opens', () => {
    const profile = getProfile('catppuccin-latte');
    expect(manifestColors(profile)).toEqual({
      theme_color: hex(profile.bg),
      background_color: hex(profile.bg),
    });
  });
});

describe('themedManifest', () => {
  it('replaces both colour fields with the active theme', async () => {
    const light = getProfile('catppuccin-latte');
    const out = await themedManifest(withManifest(), 'catppuccin-latte');

    expect(out?.['theme_color']).toBe(hex(light.bg));
    expect(out?.['background_color']).toBe(hex(light.bg));
    // A light theme must NOT keep the Mocha default that shipped in the file.
    expect(out?.['theme_color']).not.toBe('#1e1e2e');
  });

  it('leaves every other field exactly as the file has it', async () => {
    const out = await themedManifest(withManifest(), 'catppuccin-latte');
    expect(out?.['name']).toBe('palmux');
    expect(out?.['display']).toBe('standalone');
    expect(out?.['start_url']).toBe('/');
    expect(out?.['icons']).toEqual(BASE.icons);
  });

  it('answers null for a missing or unparseable manifest, rather than inventing one', async () => {
    expect(await themedManifest(tmp(), 'catppuccin-mocha')).toBeNull();

    const broken = tmp();
    writeFileSync(join(broken, 'manifest.webmanifest'), '{ not json');
    expect(await themedManifest(broken, 'catppuccin-mocha')).toBeNull();
  });

  it('falls back to the default profile for an id it cannot resolve', async () => {
    const out = await themedManifest(withManifest(), 'no-such-theme');
    expect(typeof out?.['theme_color']).toBe('string');
    expect(out?.['theme_color']).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
