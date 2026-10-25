// The terminal reads its palette from `settings.themeId` in THREE places — the
// options it is created with, the live-settings effect, and `refreshTheme` (what
// App calls when a `themes` broadcast registers a user theme). App feeds it the
// RESOLVED theme id through that same prop (batch 12: in Match system mode the
// persisted `themeId` is not what a client paints), so each read is pinned here at
// the terminal itself, against a real xterm, not through a stubbed pane.

import type { Ref } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { useTerminal, type UseTerminalResult } from './useTerminal';
import { DEFAULTS, type ClientSettings } from '../settings/settings';
import { allProfiles, getProfile, hex, registerDynamicThemes } from '../settings/themes';

let latest: UseTerminalResult | null = null;
const Harness = ({ settings }: { settings: ClientSettings }) => {
  const term = useTerminal({ settings, onData: () => {} });
  latest = term;
  // The same cast TerminalPane makes: useTerminal types its ref as nullable.
  return <div ref={term.ref as Ref<HTMLDivElement>} />;
};

const background = (t: Terminal | null | undefined): string | undefined =>
  t?.options.theme?.background;

// Two themes with different backgrounds, neither the default.
const [A, B] = (() => {
  const others = allProfiles().filter((p) => p.id !== DEFAULTS.themeId);
  const a = others[0];
  const b = others.find((p) => a && p.bg !== a.bg);
  if (!a || !b) throw new Error('the registry needs two themes with different backgrounds');
  return [a, b] as const;
})();

afterEach(() => {
  cleanup();
  latest = null;
  registerDynamicThemes([]);
});

describe('the terminal paints the theme id it is given', () => {
  it('is created in that theme', () => {
    render(<Harness settings={{ ...DEFAULTS, themeId: A.id }} />);
    expect(background(latest?.instance)).toBe(hex(A.bg));
  });

  it('repaints live when the id changes, without recreating the terminal', () => {
    const view = render(<Harness settings={{ ...DEFAULTS, themeId: A.id }} />);
    const created = latest?.instance;
    expect(created).toBeTruthy();
    view.rerender(<Harness settings={{ ...DEFAULTS, themeId: B.id }} />);
    expect(latest?.instance).toBe(created);
    expect(background(created)).toBe(hex(B.bg));
    expect(hex(B.bg)).not.toBe(hex(A.bg));
  });

  // The `themes` broadcast: a `user:` theme only exists after it, so until then the
  // id resolves to the DEFAULT profile and nothing about the id has changed.
  it('refreshTheme re-reads what the current id resolves to', () => {
    const ID = 'user:late-arrival';
    render(<Harness settings={{ ...DEFAULTS, themeId: ID }} />);
    expect(background(latest?.instance)).toBe(hex(getProfile(DEFAULTS.themeId).bg));

    registerDynamicThemes([{ ...B, id: ID, name: 'Late arrival' }]);
    act(() => latest?.refreshTheme());
    expect(background(latest?.instance)).toBe(hex(B.bg));
  });
});
