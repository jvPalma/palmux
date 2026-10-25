// main.tsx paints the theme BEFORE React mounts, so a device does not flash the
// wrong palette while the bundle boots. With Match system the right palette depends
// on this client's own colour scheme, which only `matchMedia` knows at that point —
// the stored `themeId` is just what the server last exported.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allProfiles, deriveUiTokens, hex, type ColorProfile } from './settings/themes';

// The app itself is not under test: main.tsx only has to hand it to React.
vi.mock('./App', () => ({ App: () => null }));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: () => {} }) }));

const base = (p: ColorProfile) => hex(deriveUiTokens(p).base);
const [A, B, C] = (() => {
  const picked: ColorProfile[] = [];
  for (const p of allProfiles()) {
    if (picked.every((q) => base(q) !== base(p))) picked.push(p);
    if (picked.length === 3) break;
  }
  if (picked.length < 3) throw new Error('the registry needs three visibly different themes');
  return picked as [ColorProfile, ColorProfile, ColorProfile];
})();

const prePaintedBase = () => document.documentElement.style.getPropertyValue('--t-base');

/** Boot main.tsx afresh against stored settings and a system colour scheme. */
const boot = async (stored: Record<string, unknown>, dark: boolean): Promise<void> => {
  localStorage.setItem('palmux-settings', JSON.stringify(stored));
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        media: query,
        matches: query.includes('prefers-color-scheme: dark') ? dark : false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  await import('./main');
};

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="root"></div>';
  document.documentElement.removeAttribute('style');
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute('style');
});

describe('main.tsx pre-paint', () => {
  it('paints themeId in fixed mode', async () => {
    await boot({ themeMode: 'fixed', themeId: C.id, themeDark: A.id, themeLight: B.id }, true);
    expect(prePaintedBase()).toBe(base(C));
  });

  it('paints the dark theme for a dark system in Match system', async () => {
    await boot({ themeMode: 'system', themeId: C.id, themeDark: A.id, themeLight: B.id }, true);
    expect(prePaintedBase()).toBe(base(A));
  });

  // The flash this prevents: a light-scheme device painting the dark export first.
  it('paints the light theme for a light system in Match system', async () => {
    await boot({ themeMode: 'system', themeId: C.id, themeDark: A.id, themeLight: B.id }, false);
    expect(prePaintedBase()).toBe(base(B));
  });

  it('paints themeId when a slot was never chosen', async () => {
    await boot({ themeMode: 'system', themeId: C.id, themeDark: '', themeLight: '' }, true);
    expect(prePaintedBase()).toBe(base(C));
  });
});
