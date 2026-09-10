import { afterEach, describe, expect, it } from 'vitest';
import { ACTIONS, ACTION_LABELS, DEFAULT_BINDINGS, chordEq, chordFromEvent, findConflict, formatChord, loadBindings, matchAction, resetBindings, saveBindings } from './keybindings';

const kd = (key: string, mods: Partial<KeyboardEventInit> = {}): KeyboardEvent =>
  new KeyboardEvent('keydown', { key, ...mods });

afterEach(() => localStorage.clear());

describe('chord model', () => {
  it('chordFromEvent captures key + modifiers, lowercasing single chars', () => {
    expect(chordFromEvent(kd('P', { ctrlKey: true, shiftKey: true }))).toEqual({
      key: 'p',
      ctrl: true,
      shift: true,
    });
    expect(chordFromEvent(kd('Tab', { ctrlKey: true }))).toEqual({ key: 'Tab', ctrl: true });
  });

  it('chordEq treats missing modifiers as false and is case-insensitive on key', () => {
    expect(chordEq({ key: 'p', ctrl: true }, { key: 'P', ctrl: true })).toBe(true);
    expect(chordEq({ key: 'p', ctrl: true }, { key: 'p', ctrl: true, shift: true })).toBe(false);
  });

  it('formatChord renders a readable label', () => {
    expect(formatChord({ key: 'p', ctrl: true, shift: true })).toBe('Ctrl+Shift+P');
    expect(formatChord({ key: 'Tab', ctrl: true })).toBe('Ctrl+Tab');
  });
});

describe('matchAction', () => {
  it('resolves a bound chord to its action', () => {
    expect(matchAction(DEFAULT_BINDINGS, kd('p', { ctrlKey: true, shiftKey: true }))).toBe(
      'commandPalette',
    );
    expect(matchAction(DEFAULT_BINDINGS, kd(',', { ctrlKey: true }))).toBe('settings');
  });

  it('returns null for an unbound chord (so it falls through to xterm)', () => {
    // A plain arrow key must NOT be claimed — DECCKM/app-cursor mode is preserved.
    expect(matchAction(DEFAULT_BINDINGS, kd('ArrowUp'))).toBeNull();
    expect(matchAction(DEFAULT_BINDINGS, kd('a'))).toBeNull();
    expect(matchAction(DEFAULT_BINDINGS, kd('a', { ctrlKey: true }))).toBeNull();
  });

  it('ignores bare modifier presses', () => {
    expect(matchAction(DEFAULT_BINDINGS, kd('Control', { ctrlKey: true }))).toBeNull();
  });
});

describe('conflict detection', () => {
  it('finds an action already bound to a chord', () => {
    // settings is Ctrl+, — binding search to it should conflict.
    expect(findConflict(DEFAULT_BINDINGS, 'search', { key: ',', ctrl: true })).toBe('settings');
    expect(findConflict(DEFAULT_BINDINGS, 'settings', { key: ',', ctrl: true })).toBeNull();
  });
});

describe('persistence', () => {
  it('loads defaults when nothing stored', () => {
    expect(loadBindings()).toEqual(DEFAULT_BINDINGS);
  });

  it('round-trips a custom binding merged over defaults', () => {
    const custom = { ...DEFAULT_BINDINGS, newTab: { key: 'n', ctrl: true } };
    saveBindings(custom);
    const loaded = loadBindings();
    expect(loaded.newTab).toEqual({ key: 'n', ctrl: true });
    expect(loaded.settings).toEqual(DEFAULT_BINDINGS.settings);
  });

  it('reset clears storage and returns defaults', () => {
    saveBindings({ ...DEFAULT_BINDINGS, newTab: { key: 'n', ctrl: true } });
    expect(resetBindings()).toEqual(DEFAULT_BINDINGS);
    expect(loadBindings()).toEqual(DEFAULT_BINDINGS);
  });

  it('every action has a default binding', () => {
    for (const a of ACTIONS) expect(DEFAULT_BINDINGS[a]).toBeDefined();
  });
});

// Upload and download became RAIL actions when the desktop action cluster was
// retired, and the rail is a per-device preference — `sidebarRail: 'hidden'`
// left them with no route at all until these existed. Every action in the
// registry is in the command palette, so this IS the recovery path.
describe('upload and download are reachable without the rail', () => {
  it('are real actions with labels and default chords', () => {
    for (const a of ['uploadFile', 'downloadFile'] as const) {
      expect(ACTIONS).toContain(a);
      expect(ACTION_LABELS[a]).toBeTruthy();
      expect(DEFAULT_BINDINGS[a]).toBeTruthy();
    }
  });

  it('do not collide with an existing default chord', () => {
    const seen = new Map<string, string>();
    for (const a of ACTIONS) {
      const c = DEFAULT_BINDINGS[a];
      const key = `${c.ctrl ? 'C' : ''}${c.alt ? 'A' : ''}${c.shift ? 'S' : ''}${c.meta ? 'M' : ''}-${c.key.toLowerCase()}`;
      expect(seen.has(key), `${a} collides with ${seen.get(key)} on ${key}`).toBe(false);
      seen.set(key, a);
    }
  });
});
