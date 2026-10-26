import { act, renderHook } from '@testing-library/react';
import {
  DEFAULTS,
  editorFontSize,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  loadSettings,
  saveSettings,
  toServerSettings,
  mergeServerSettings,
  sanitize,
  resolveMobileMode,
  isMobileDevice,
  resolveThemeId,
  systemPrefersDark,
  themeModeAfter,
  themeModeChange,
  themePick,
  type ClientSettings,
} from './settings';
import { useSettings } from './useSettings';

const STORAGE_KEY = 'palmux-settings';

function fullSettings(overrides: Partial<ClientSettings> = {}): ClientSettings {
  return { ...DEFAULTS, ...overrides };
}

describe('sanitize', () => {
  it('clamps fontSize to 6..48', () => {
    expect(sanitize(fullSettings({ fontSize: 2 })).fontSize).toBe(6);
    expect(sanitize(fullSettings({ fontSize: 999 })).fontSize).toBe(48);
    expect(sanitize(fullSettings({ fontSize: 15 })).fontSize).toBe(15);
  });

  it('rounds fontSize and falls back when it rounds to 0', () => {
    expect(sanitize(fullSettings({ fontSize: 14.6 })).fontSize).toBe(15);
    expect(sanitize(fullSettings({ fontSize: 0 })).fontSize).toBe(DEFAULTS.fontSize);
  });

  it('clamps scrollback to 0..100000', () => {
    expect(sanitize(fullSettings({ scrollback: -50 })).scrollback).toBe(0);
    expect(sanitize(fullSettings({ scrollback: 5_000_000 })).scrollback).toBe(100000);
  });

  it('falls back invalid cursorStyle to the default', () => {
    expect(
      sanitize(fullSettings({ cursorStyle: 'wavy' as ClientSettings['cursorStyle'] })).cursorStyle,
    ).toBe(DEFAULTS.cursorStyle);
    expect(sanitize(fullSettings({ cursorStyle: 'bar' })).cursorStyle).toBe('bar');
  });

  it('falls back invalid mobileMode to the default', () => {
    expect(
      sanitize(fullSettings({ mobileMode: 'maybe' as ClientSettings['mobileMode'] })).mobileMode,
    ).toBe(DEFAULTS.mobileMode);
    expect(sanitize(fullSettings({ mobileMode: 'on' })).mobileMode).toBe('on');
  });
});

// Batch 11. `report ` and `report` are two folders, so a pin that ends in whitespace is
// its own pin. The sanitiser runs on every load and every merge: whatever identity
// `normalizePin` returns is what it must keep, or an unrelated settings save would
// quietly retarget the pin to a sibling (B10-INSPECT2-01).
describe('explorerPins keep whitespace significant', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('sanitize keeps a trailing-space pin and drops one with leading whitespace', () => {
    const pins = ['/work/report ', '/work/report', ' /work/lead'];
    expect(sanitize(fullSettings({ explorerPins: pins })).explorerPins).toEqual([
      '/work/report ',
      '/work/report',
    ]);
  });

  it('survives a server round trip and a second sanitize unchanged', () => {
    const local = fullSettings({ explorerPins: ['/work/report /.'] });
    const stored = sanitize(local);
    expect(stored.explorerPins).toEqual(['/work/report ']);
    const merged = mergeServerSettings(DEFAULTS, toServerSettings(stored));
    expect(merged.explorerPins).toEqual(['/work/report ']);
    expect(sanitize(merged).explorerPins).toEqual(['/work/report ']);
  });

  it('keeps the pin through loadSettings after an unrelated save', () => {
    saveSettings(fullSettings({ explorerPins: ['/work/report '], fontSize: 17 }));
    expect(loadSettings().explorerPins).toEqual(['/work/report ']);
  });
});

// Source Control. The project list is a path on the SERVER, so it syncs like
// `explorerPins`; which project a screen reads and how it lays a diff out are the
// screen's own, so those four stay local and never reach the server.
describe('Source Control settings', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('defaults to no project, auto layout, histogram and the width rule for wrapping', () => {
    expect(DEFAULTS).toMatchObject({
      scmRepos: [],
      scmActiveRepo: '',
      scmLayout: 'auto',
      scmAlgorithm: 'histogram',
      scmWrap: null,
    });
  });

  it('syncs the project list and nothing else of the five', () => {
    const out = toServerSettings(
      fullSettings({
        scmRepos: ['/work/app'],
        scmActiveRepo: '/work/app',
        scmLayout: 'split',
        scmAlgorithm: 'myers',
        scmWrap: true,
      }),
    );
    expect(out['scmRepos']).toEqual(['/work/app']);
    for (const local of ['scmActiveRepo', 'scmLayout', 'scmAlgorithm', 'scmWrap']) {
      expect(local in out, local).toBe(false);
    }
  });

  it('a device choice never changes the synced payload', () => {
    const a = toServerSettings(fullSettings({ scmRepos: ['/work/app'], scmActiveRepo: '/a' }));
    const b = toServerSettings(
      fullSettings({
        scmRepos: ['/work/app'],
        scmActiveRepo: '/b',
        scmLayout: 'unified',
        scmAlgorithm: 'patience',
        scmWrap: false,
      }),
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('canonicalises the project list with normalizePin and drops what is not a path', () => {
    const repos = sanitize(
      fullSettings({
        scmRepos: [
          '/work/./app/',
          '/work//app', // the same project spelled again
          '/work/lib/../tools',
          'relative/path',
          ' /leading-space',
          '/',
          3 as unknown as string,
        ],
      }),
    ).scmRepos;
    expect(repos).toEqual(['/work/app', '/work/tools']);
  });

  it('keeps whitespace significant inside a project path, as the Explorer does', () => {
    expect(sanitize(fullSettings({ scmRepos: ['/work/app ', '/work/app'] })).scmRepos).toEqual([
      '/work/app ',
      '/work/app',
    ]);
  });

  it('treats a list that is not an array as empty', () => {
    expect(sanitize(fullSettings({ scmRepos: 'nope' as unknown as string[] })).scmRepos).toEqual(
      [],
    );
  });

  it('canonicalises the active project and reads a non-path as none', () => {
    expect(sanitize(fullSettings({ scmActiveRepo: '/work/./app/' })).scmActiveRepo).toBe(
      '/work/app',
    );
    expect(sanitize(fullSettings({ scmActiveRepo: 'app' })).scmActiveRepo).toBe('');
    expect(sanitize(fullSettings({ scmActiveRepo: 7 as unknown as string })).scmActiveRepo).toBe(
      '',
    );
  });

  it('falls back from a layout, an algorithm or a wrap value it does not know', () => {
    const bad = sanitize(
      fullSettings({
        scmLayout: 'grid' as ClientSettings['scmLayout'],
        scmAlgorithm: 'bogosort' as ClientSettings['scmAlgorithm'],
        scmWrap: 'yes' as unknown as boolean,
      }),
    );
    expect(bad).toMatchObject({ scmLayout: 'auto', scmAlgorithm: 'histogram', scmWrap: null });
  });

  it('keeps every value it does know', () => {
    for (const scmLayout of ['auto', 'split', 'unified'] as const) {
      expect(sanitize(fullSettings({ scmLayout })).scmLayout).toBe(scmLayout);
    }
    for (const scmAlgorithm of ['myers', 'minimal', 'patience', 'histogram'] as const) {
      expect(sanitize(fullSettings({ scmAlgorithm })).scmAlgorithm).toBe(scmAlgorithm);
    }
    for (const scmWrap of [true, false, null]) {
      expect(sanitize(fullSettings({ scmWrap })).scmWrap).toBe(scmWrap);
    }
  });

  it('takes the project list from the server and never the four local keys', () => {
    const merged = mergeServerSettings(
      fullSettings({ scmActiveRepo: '/mine', scmLayout: 'split', scmWrap: true }),
      {
        scmRepos: ['/work/app', '/work/lib'],
        scmActiveRepo: '/theirs',
        scmLayout: 'unified',
        scmAlgorithm: 'myers',
        scmWrap: false,
      },
    );
    expect(merged).toMatchObject({
      scmRepos: ['/work/app', '/work/lib'],
      scmActiveRepo: '/mine',
      scmLayout: 'split',
      scmAlgorithm: 'histogram',
      scmWrap: true,
    });
  });

  // An older bundle's save carries no project list. The server merges it (batch A);
  // this is the client half: a blob without the key leaves the local list alone, and an
  // explicit empty list still replaces it.
  it('a blob without scmRepos leaves the list, and an explicit [] clears it', () => {
    const local = fullSettings({ scmRepos: ['/work/app'] });
    expect(mergeServerSettings(local, { scrollback: 2000 }).scmRepos).toEqual(['/work/app']);
    expect(mergeServerSettings(local, { scmRepos: [] }).scmRepos).toEqual([]);
  });

  it('an old stored blob with none of the keys still parses to the defaults for them', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 16, explorerPins: ['/work'] }));
    const loaded = loadSettings();
    expect(loaded.fontSize).toBe(16);
    expect(loaded).toMatchObject({
      scmRepos: [],
      scmActiveRepo: '',
      scmLayout: 'auto',
      scmAlgorithm: 'histogram',
      scmWrap: null,
    });
  });

  it('round-trips through storage, and a second sanitize changes nothing', () => {
    const saved = sanitize(
      fullSettings({
        scmRepos: ['/work/app', '/work/lib'],
        scmActiveRepo: '/work/lib',
        scmLayout: 'split',
        scmAlgorithm: 'patience',
        scmWrap: false,
      }),
    );
    saveSettings(saved);
    const loaded = loadSettings();
    expect(loaded).toMatchObject({
      scmRepos: ['/work/app', '/work/lib'],
      scmActiveRepo: '/work/lib',
      scmLayout: 'split',
      scmAlgorithm: 'patience',
      scmWrap: false,
    });
    expect(sanitize(loaded)).toEqual(loaded);
  });
});

// The tree/list choice is how THIS screen reads a group, so like the other Source
// Control display choices it never joins SYNCED_KEYS: a synced copy would put one
// device's preference back on every other device pointed at the same palmux.
describe('Source Control tree setting', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('defaults to the tree', () => {
    expect(DEFAULTS.scmTree).toBe(true);
    expect(loadSettings().scmTree).toBe(true);
  });

  it('never reaches the server, and a server blob never sets it', () => {
    expect('scmTree' in toServerSettings(fullSettings({ scmTree: false }))).toBe(false);
    expect(JSON.stringify(toServerSettings(fullSettings({ scmTree: false })))).toBe(
      JSON.stringify(toServerSettings(fullSettings({ scmTree: true }))),
    );
    expect(mergeServerSettings(fullSettings({ scmTree: false }), { scmTree: true }).scmTree).toBe(
      false,
    );
  });

  it('keeps a boolean and falls back to the tree from anything else', () => {
    expect(sanitize(fullSettings({ scmTree: false })).scmTree).toBe(false);
    expect(sanitize(fullSettings({ scmTree: true })).scmTree).toBe(true);
    for (const bad of ['no', 0, null]) {
      expect(sanitize(fullSettings({ scmTree: bad as unknown as boolean })).scmTree).toBe(true);
    }
  });

  it('survives storage, and an older blob without the key reads as the tree', () => {
    saveSettings(sanitize(fullSettings({ scmTree: false })));
    expect(loadSettings().scmTree).toBe(false);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 16 }));
    expect(loadSettings().scmTree).toBe(true);
  });
});

// The code size is how big THIS screen reads code, which is a phone's own business: so,
// like fontSize, it is local and never reaches the server or the dotfiles-tracked
// settings.json. null is the state of a device that never chose.
describe('code font size setting', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('is unset until a device chooses one', () => {
    expect(DEFAULTS.codeFontSize).toBeNull();
    expect(loadSettings().codeFontSize).toBeNull();
  });

  it('clamps to the range the terminal font size takes, and rounds', () => {
    expect([FONT_SIZE_MIN, FONT_SIZE_MAX]).toEqual([6, 48]);
    expect(sanitize(fullSettings({ codeFontSize: 2 })).codeFontSize).toBe(6);
    expect(sanitize(fullSettings({ codeFontSize: 999 })).codeFontSize).toBe(48);
    expect(sanitize(fullSettings({ codeFontSize: 11 })).codeFontSize).toBe(11);
    expect(sanitize(fullSettings({ codeFontSize: 11.6 })).codeFontSize).toBe(12);
  });

  it('falls back to unset from anything that is not a finite number', () => {
    for (const bad of ['14', true, {}, [], Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(sanitize(fullSettings({ codeFontSize: bad as unknown as number })).codeFontSize).toBe(
        null,
      );
    }
    expect(sanitize(fullSettings({ codeFontSize: null })).codeFontSize).toBeNull();
  });

  it('is sanitised again on every load: a stored value out of range is clamped', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ codeFontSize: 500 }));
    expect(loadSettings().codeFontSize).toBe(48);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ codeFontSize: 'big' }));
    expect(loadSettings().codeFontSize).toBeNull();
  });

  it('survives storage, and an older blob without the key reads as unset', () => {
    saveSettings(sanitize(fullSettings({ codeFontSize: 11 })));
    expect(loadSettings().codeFontSize).toBe(11);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 16 }));
    expect(loadSettings().codeFontSize).toBeNull();
  });

  it('is never in the server blob, whatever its value', () => {
    for (const codeFontSize of [null, 11, 48]) {
      expect('codeFontSize' in toServerSettings(fullSettings({ codeFontSize }))).toBe(false);
    }
    // The synced payload is byte-identical across a code size change.
    expect(JSON.stringify(toServerSettings(fullSettings({ codeFontSize: 9 })))).toBe(
      JSON.stringify(toServerSettings(fullSettings({ codeFontSize: null }))),
    );
  });

  it('is never set by a server blob', () => {
    expect(
      mergeServerSettings(fullSettings({ codeFontSize: 11 }), { codeFontSize: 30 }),
    ).toMatchObject({ codeFontSize: 11 });
    expect(
      mergeServerSettings(fullSettings({ codeFontSize: null }), { codeFontSize: 30 }),
    ).toMatchObject({ codeFontSize: null });
  });

  it('is stored on this device and sent to no server when it changes', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useSettings(send));
    act(() => result.current.update({ codeFontSize: 11 }));
    expect(result.current.settings.codeFontSize).toBe(11);
    expect(loadSettings().codeFontSize).toBe(11);
    expect(send).toHaveBeenCalledTimes(1);
    expect(Object.keys(send.mock.calls[0]?.[0] as object)).not.toContain('codeFontSize');
  });

  describe('the editor size it sets', () => {
    it('is the code size once one is set, and the terminal’s plus a step before', () => {
      expect(editorFontSize({ fontSize: 14, codeFontSize: null })).toBe(15);
      expect(editorFontSize({ fontSize: 14, codeFontSize: 11 })).toBe(11);
    });

    it('stops following the terminal once it is set', () => {
      expect(editorFontSize({ fontSize: 20, codeFontSize: 11 })).toBe(11);
      expect(editorFontSize({ fontSize: 10, codeFontSize: 11 })).toBe(11);
      expect(editorFontSize({ fontSize: 20, codeFontSize: null })).toBe(21);
    });
  });
});

describe('toServerSettings', () => {
  it('includes the synced keys', () => {
    const out = toServerSettings(fullSettings({ themeId: 'x', scrollback: 1234 }));
    expect(out).toMatchObject({
      fontFamily: DEFAULTS.fontFamily,
      themeId: 'x',
      scrollback: 1234,
      cursorBlink: DEFAULTS.cursorBlink,
      cursorStyle: DEFAULTS.cursorStyle,
    });
  });

  it('excludes the per-device mobileMode and fontSize', () => {
    const out = toServerSettings(fullSettings({ mobileMode: 'on', fontSize: 20 }));
    expect('mobileMode' in out).toBe(false);
    expect('fontSize' in out).toBe(false);
  });

  // sidebarRail is 'always' on a desktop and 'hidden' on a phone — both correct,
  // so a synced value is wrong on one of them. Worse, it would put a per-machine
  // value back into the dotfiles-tracked settings.json that settings.local.json
  // exists to keep out. The payload must be byte-identical across a rail change.
  it('excludes sidebarRail, and a rail change does not alter the synced payload', () => {
    const hidden = toServerSettings(fullSettings({ sidebarRail: 'hidden' }));
    const always = toServerSettings(fullSettings({ sidebarRail: 'always' }));
    expect('sidebarRail' in hidden).toBe(false);
    expect(JSON.stringify(hidden)).toBe(JSON.stringify(always));
  });
});

describe('mergeServerSettings', () => {
  it('lets the server win for synced keys', () => {
    const merged = mergeServerSettings(fullSettings({ scrollback: 10 }), { scrollback: 2200 });
    expect(merged.scrollback).toBe(2200);
  });

  it('ignores server values of the wrong type', () => {
    const merged = mergeServerSettings(fullSettings({ scrollback: 10 }), {
      scrollback: 'big' as unknown as number,
    });
    expect(merged.scrollback).toBe(10);
  });

  it('never overrides the local mobileMode', () => {
    const merged = mergeServerSettings(fullSettings({ mobileMode: 'off' }), {
      mobileMode: 'on' as unknown as never,
    });
    expect(merged.mobileMode).toBe('off');
  });

  it('never overrides the local (per-device) fontSize', () => {
    const merged = mergeServerSettings(fullSettings({ fontSize: 12 }), {
      fontSize: 30 as unknown as never,
    });
    expect(merged.fontSize).toBe(12);
  });

  it('sanitizes the merged result', () => {
    const merged = mergeServerSettings(fullSettings(), { scrollback: 999999 });
    expect(merged.scrollback).toBe(100000);
  });
});

describe('loadSettings / saveSettings', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('returns defaults when nothing is stored', () => {
    expect(loadSettings()).toEqual(DEFAULTS);
  });

  it('round-trips saved settings (sanitized)', () => {
    saveSettings(fullSettings({ fontSize: 18 }));
    expect(loadSettings().fontSize).toBe(18);
  });

  it('merges stored partials over defaults and sanitizes', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 999 }));
    const loaded = loadSettings();
    expect(loaded.fontSize).toBe(48);
    expect(loaded.themeId).toBe(DEFAULTS.themeId);
  });

  it('returns defaults on corrupt JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(loadSettings()).toEqual(DEFAULTS);
  });
});

describe('resolveMobileMode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns true for 'on'", () => {
    expect(resolveMobileMode('on')).toBe(true);
  });

  it("returns false for 'off'", () => {
    expect(resolveMobileMode('off')).toBe(false);
  });

  it("delegates to isMobileDevice for 'auto'", () => {
    vi.stubGlobal('navigator', { maxTouchPoints: 5 });
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
    expect(resolveMobileMode('auto')).toBe(true);
  });
});

describe('isMobileDevice', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('is true when pointer is coarse', () => {
    vi.stubGlobal('navigator', { maxTouchPoints: 0 });
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    expect(isMobileDevice()).toBe(true);
  });

  it('is true when maxTouchPoints > 0', () => {
    vi.stubGlobal('navigator', { maxTouchPoints: 3 });
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
    expect(isMobileDevice()).toBe(true);
  });

  it('is false on a non-touch desktop', () => {
    vi.stubGlobal('navigator', { maxTouchPoints: 0 });
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
    expect(isMobileDevice()).toBe(false);
  });
});

// ── Theme follows the system (batch 12) ───────────────────────────────────────
//
// `themeMode` / `themeDark` / `themeLight` are synced, and everything that PAINTS
// reads the id `resolveThemeId` returns, never `themeId` directly.
describe('theme mode settings', () => {
  it('defaults to fixed, with both slots unchosen', () => {
    expect(DEFAULTS.themeMode).toBe('fixed');
    expect(DEFAULTS.themeDark).toBe('');
    expect(DEFAULTS.themeLight).toBe('');
  });

  it('syncs all three keys, so dark -> X and light -> Y roam with the user', () => {
    const out = toServerSettings(
      fullSettings({ themeMode: 'system', themeDark: 'dark-x', themeLight: 'light-y' }),
    );
    expect(out).toMatchObject({ themeMode: 'system', themeDark: 'dark-x', themeLight: 'light-y' });
  });

  it('takes all three from the server, and sanitises a mode it does not know', () => {
    const merged = mergeServerSettings(fullSettings(), {
      themeMode: 'system',
      themeDark: 'dark-x',
      themeLight: 'light-y',
    });
    expect(merged).toMatchObject({
      themeMode: 'system',
      themeDark: 'dark-x',
      themeLight: 'light-y',
    });
    expect(
      sanitize(fullSettings({ themeMode: 'auto' as ClientSettings['themeMode'] })).themeMode,
    ).toBe('fixed');
  });

  it('turns a non-string slot (a hand-edited settings.json) into "not chosen"', () => {
    const bad = fullSettings({
      themeDark: 3 as unknown as string,
      themeLight: null as unknown as string,
    });
    expect(sanitize(bad)).toMatchObject({ themeDark: '', themeLight: '' });
  });
});

describe('resolveThemeId', () => {
  const base = fullSettings({ themeId: 'picked', themeDark: 'dark-x', themeLight: 'light-y' });

  it('is themeId in fixed mode, whatever the system says', () => {
    expect(resolveThemeId({ ...base, themeMode: 'fixed' }, true)).toBe('picked');
    expect(resolveThemeId({ ...base, themeMode: 'fixed' }, false)).toBe('picked');
  });

  it('is the dark slot when the system is dark and the light slot when it is not', () => {
    expect(resolveThemeId({ ...base, themeMode: 'system' }, true)).toBe('dark-x');
    expect(resolveThemeId({ ...base, themeMode: 'system' }, false)).toBe('light-y');
  });

  it('falls back to themeId for a slot that was never chosen', () => {
    const empty = { ...base, themeMode: 'system' as const, themeDark: '', themeLight: '' };
    expect(resolveThemeId(empty, true)).toBe('picked');
    expect(resolveThemeId(empty, false)).toBe('picked');
  });
});

describe('systemPrefersDark', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads prefers-color-scheme: dark from the client itself', () => {
    const spy = vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    expect(systemPrefersDark()).toBe(true);
    expect(spy).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    spy.mockReturnValue({ matches: false } as MediaQueryList);
    expect(systemPrefersDark()).toBe(false);
  });
});

describe('themePick', () => {
  it('fixed mode: a pick is themeId', () => {
    expect(themePick({ themeMode: 'fixed' }, { mode: 'fixed' }, 'a')).toEqual({ themeId: 'a' });
  });

  it('system mode: a pick fills the targeted slot and leaves themeId alone', () => {
    const system = { themeMode: 'system' } as const;
    expect(themePick(system, { mode: 'system', slot: 'dark' }, 'a')).toEqual({ themeDark: 'a' });
    expect(themePick(system, { mode: 'system', slot: 'light' }, 'b')).toEqual({ themeLight: 'b' });
  });

  // B12-R2-02. A target is captured when a request is SUBMITTED; by the time it
  // lands the user may have changed mode. A fixed pick landing in system mode
  // would overwrite the exported themeId with no scheme change to justify it.
  it('is superseded (null) when the mode is no longer the one the target was captured in', () => {
    expect(themePick({ themeMode: 'system' }, { mode: 'fixed' }, 'a')).toBeNull();
    expect(themePick({ themeMode: 'fixed' }, { mode: 'system', slot: 'dark' }, 'a')).toBeNull();
  });
});

// B12-I01. App counts mode transitions as broadcasts ARRIVE, before React merges
// them, so it needs the mode a blob leaves it in without waiting for the merge.
describe('themeModeAfter', () => {
  it('takes the mode a blob carries', () => {
    expect(themeModeAfter('fixed', { themeMode: 'system' })).toBe('system');
    expect(themeModeAfter('system', { themeMode: 'fixed' })).toBe('fixed');
  });

  // An older bundle's save has no themeMode; the merge keeps the local one.
  it('keeps the current mode when the blob does not carry one', () => {
    expect(themeModeAfter('system', { cursorBlink: false })).toBe('system');
    expect(themeModeAfter('system', { themeMode: 1 })).toBe('system');
  });

  it('agrees with the merge on a mode it does not know', () => {
    expect(themeModeAfter('system', { themeMode: 'auto' })).toBe('fixed');
    expect(themeModeAfter('system', { themeMode: 'auto' })).toBe(
      mergeServerSettings(fullSettings({ themeMode: 'system' }), { themeMode: 'auto' }).themeMode,
    );
  });
});

describe('themeModeChange', () => {
  const s = { themeId: 'picked', themeDark: '', themeLight: '' };

  it('to system: both unchosen slots start at the current theme, so nothing changes on screen', () => {
    expect(themeModeChange(s, 'system', 'picked')).toEqual({
      themeMode: 'system',
      themeDark: 'picked',
      themeLight: 'picked',
    });
  });

  it('to system: slots already chosen are kept', () => {
    expect(themeModeChange({ ...s, themeDark: 'd', themeLight: '' }, 'system', 'picked')).toEqual({
      themeMode: 'system',
      themeDark: 'd',
      themeLight: 'picked',
    });
  });

  it('to fixed: keeps what is on screen as the fixed pick', () => {
    expect(themeModeChange({ ...s, themeDark: 'd', themeLight: 'l' }, 'fixed', 'l')).toEqual({
      themeMode: 'fixed',
      themeId: 'l',
    });
  });
});
