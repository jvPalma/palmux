// The terminal's palette through the REAL chain: App resolves the theme id from the
// client's colour scheme, hands it to a real TerminalPane through the `settings`
// prop, and a real xterm paints it. App.test.tsx stubs the pane (it asserts the id
// the pane is handed); useTerminal.test.tsx pins the terminal's three reads of that
// id. This one closes the gap between them: a wrong prop path in App would pass both.
//
// What is read back is xterm's own scrollable element, which xterm 6 paints with the
// theme background — the same surface the user sees behind the grid.

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { App } from './App';
import { allProfiles, hex, type ColorProfile } from './settings/themes';

const { sockets } = vi.hoisted(() => ({
  sockets: [] as Array<{ url: string; handler: ((msg: Record<string, unknown>) => void) | null }>,
}));

// One fake for the control socket and every pane's data socket alike.
vi.mock('./lib/ws', () => ({
  WsClient: class {
    handler: ((msg: Record<string, unknown>) => void) | null = null;
    constructor(public url: string) {
      sockets.push(this);
    }
    onMessage(cb: (msg: Record<string, unknown>) => void) {
      this.handler = cb;
    }
    onBinary() {}
    onOpen() {}
    onClose() {}
    connect() {}
    destroy() {}
    stopReconnect() {}
    sendSettings() {
      return true;
    }
    sendExtraKeys() {
      return true;
    }
    sendInput() {
      return true;
    }
    sendBinary() {
      return true;
    }
    sendResize() {}
  },
}));
// Monaco is not what this tests, and a terminal tab never mounts a pane.
vi.mock('./panes/PaneHost', () => ({ PaneHost: () => null }));

// Three themes with different backgrounds. OTHER is the persisted `themeId` and
// neither slot: a terminal reading it instead of the resolved id paints OTHER.
const [DARK, LIGHT, OTHER] = (() => {
  const picked: ColorProfile[] = [];
  for (const p of allProfiles()) {
    if (picked.every((q) => hex(q.bg) !== hex(p.bg))) picked.push(p);
    if (picked.length === 3) break;
  }
  if (picked.length < 3)
    throw new Error('the registry needs three themes with different backgrounds');
  return picked as [ColorProfile, ColorProfile, ColorProfile];
})();

/** How a browser spells a colour, so `#1e1e2e` and `rgb(30, 30, 46)` compare equal. */
const css = (colour: string): string => {
  const probe = document.createElement('div');
  probe.style.backgroundColor = colour;
  return probe.style.backgroundColor;
};
const terminalBackground = (): string =>
  (document.querySelector('.xterm-scrollable-element') as HTMLElement | null)?.style
    .backgroundColor ?? '';

let dark = true;
const listeners = new Set<() => void>();
let spy: MockInstance<typeof window.matchMedia>;

beforeEach(() => {
  sockets.length = 0;
  dark = true;
  listeners.clear();
  localStorage.clear();
  localStorage.setItem(
    'palmux-settings',
    JSON.stringify({
      mobileMode: 'off',
      themeMode: 'system',
      themeId: OTHER.id,
      themeDark: DARK.id,
      themeLight: LIGHT.id,
    }),
  );
  history.replaceState(null, '', '/0');
  spy = vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        media: query,
        get matches() {
          return query.includes('prefers-color-scheme: dark') ? dark : false;
        },
        addEventListener: (_: string, cb: () => void) => listeners.add(cb),
        removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
        // xterm watches the device pixel ratio through the legacy listener API.
        addListener: () => {},
        removeListener: () => {},
      }) as unknown as MediaQueryList,
  );
});
afterEach(() => {
  cleanup();
  spy.mockRestore();
  localStorage.clear();
  document.documentElement.removeAttribute('style');
});

const boot = () => {
  render(<App />);
  const control = sockets.find((s) => s.url.includes('control=1'));
  if (!control?.handler) throw new Error('control socket not connected');
  act(() => control.handler?.({ type: 'sessions', tabs: [{ id: '0', kind: 'terminal' }] }));
};
const flip = (next: boolean) => {
  dark = next;
  act(() => listeners.forEach((cb) => cb()));
};

describe('the real terminal follows the system scheme', () => {
  it('is created in the theme of the scheme the device is in', () => {
    boot();
    expect(terminalBackground()).toBe(css(hex(DARK.bg)));
  });

  it('is created in the light theme on a light device', () => {
    dark = false;
    boot();
    expect(terminalBackground()).toBe(css(hex(LIGHT.bg)));
  });

  it('repaints in place on a scheme change, in both directions', () => {
    boot();
    const terminal = document.querySelector('.xterm');
    flip(false);
    expect(terminalBackground()).toBe(css(hex(LIGHT.bg)));
    flip(true);
    expect(terminalBackground()).toBe(css(hex(DARK.bg)));
    // The same xterm throughout: a theme change is not a remount.
    expect(document.querySelector('.xterm')).toBe(terminal);
  });
});

// The same gap, for the detached-window claim: the stub pane in App.test.tsx pins that App hands a
// pane its window, and session-url.test.ts pins what `wsUrlFor` does with one. What joins them is
// the real pane building its data URL, so a pane that forgot to pass it on would pass both.
describe('the real terminal names its detached window on the data socket', () => {
  const dataUrls = () => sockets.map((s) => s.url).filter((url) => !url.includes('control=1'));
  const bootAt = (path: string, tab: Record<string, unknown>) => {
    history.replaceState(null, '', path);
    render(<App />);
    const control = sockets.find((s) => s.url.includes('control=1'));
    if (!control?.handler) throw new Error('control socket not connected');
    act(() => control.handler?.({ type: 'sessions', tabs: [tab] }));
  };

  it('claims the window in a detached window', () => {
    bootAt('/window/wq3k9x2m1ab?tab=0', { id: '0', kind: 'terminal', window: 'wq3k9x2m1ab' });
    expect(dataUrls()).toHaveLength(1);
    expect(dataUrls()[0]).toMatch(/\/ws\?session=0&kind=terminal&client=[^&]+&window=wq3k9x2m1ab$/);
  });

  it('claims nothing in the main window', () => {
    bootAt('/0', { id: '0', kind: 'terminal' });
    expect(dataUrls()).toHaveLength(1);
    expect(dataUrls()[0]).not.toContain('window=');
  });
});
