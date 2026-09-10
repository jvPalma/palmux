import {
  DEFAULTS,
  loadSettings,
  saveSettings,
  toServerSettings,
  mergeServerSettings,
  sanitize,
  resolveMobileMode,
  isMobileDevice,
  type ClientSettings,
} from './settings';

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
