// Which tab a window shows, once the URL stopped being the answer.
//
// The one thing here that is easy to get subtly wrong and expensive to get
// wrong is a RECYCLED id: ids are handed out lowest-free, so a stored `2` can
// come back as an entirely different kind of tab, and restoring "tab 2" would
// then open a stranger.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TabMeta } from '@palmux/shared';
import {
  LAST_TAB_KEY,
  parseSelection,
  readSelection,
  resolveSelection,
  resolveStoredSelection,
  selectionFor,
  writeLastTab,
  writeSelection,
} from './window-selection';

const tab = (id: string, kind: TabMeta['kind'] = 'terminal'): TabMeta => ({ id, kind });
const TABS = [tab('5'), tab('0', 'web'), tab('2', 'editor')];

afterEach(() => {
  vi.unstubAllGlobals();
  try {
    sessionStorage.clear();
    localStorage.clear();
  } catch {
    /* not available in this environment */
  }
});

/** A Storage whose every call throws, the way private mode and a full quota do. */
const denied = () => {
  const fail = () => {
    throw new Error('denied');
  };
  return { getItem: fail, setItem: fail, removeItem: fail, clear: fail };
};

describe('parseSelection', () => {
  it('reads a well-formed value', () => {
    expect(parseSelection('{"id":"3","kind":"editor"}')).toEqual({ id: '3', kind: 'editor' });
  });

  // `review` was missing from a private copy of the kind list, so a window focused on a review
  // read back as unusable and always reloaded onto the first tab.
  it('reads a review selection', () => {
    expect(parseSelection('{"id":"4","kind":"review"}')).toEqual({ id: '4', kind: 'review' });
  });

  it('refuses anything else instead of throwing', () => {
    for (const raw of [null, '', 'not json', '{}', '{"id":"3"}', '{"kind":"editor"}', '[]', '{"id":"","kind":"web"}', '{"id":"3","kind":"nope"}']) {
      expect(parseSelection(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

describe('readSelection / writeSelection', () => {
  it('round-trips through sessionStorage', () => {
    writeSelection({ id: '7', kind: 'markdown' });
    expect(readSelection()).toEqual({ id: '7', kind: 'markdown' });
  });

  it('clears on null', () => {
    writeSelection({ id: '7', kind: 'terminal' });
    writeSelection(null);
    expect(readSelection()).toBeNull();
  });

  // A terminal that refused to load because it could not remember a tab number
  // would be a poor trade for the feature.
  it('survives storage that throws on read', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    });
    expect(readSelection()).toBeNull();
  });

  it('survives storage that throws on write', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {},
      clear: () => {},
    });
    expect(() => writeSelection({ id: '1', kind: 'terminal' })).not.toThrow();
  });
});

// An installed PWA's window is a browsing context the OS ends whenever it likes, so
// `sessionStorage` alone forgot the tab on every relaunch. The device-wide copy is
// read ONLY when the window has no selection of its own, which is what keeps the
// two-window rule the module exists for: an open window is never yanked by another.
describe('the device-wide last tab', () => {
  const stored = (): unknown => JSON.parse(localStorage.getItem('palmux-last-tab') ?? 'null');

  it('is read by a window with no selection of its own', () => {
    writeLastTab({ id: '2', kind: 'editor' });
    expect(readSelection()).toEqual({ id: '2', kind: 'editor' });
  });

  it('never beats the window\'s own selection', () => {
    writeLastTab({ id: '2', kind: 'editor' });
    writeSelection({ id: '5', kind: 'terminal' });
    expect(readSelection()).toEqual({ id: '5', kind: 'terminal' });
  });

  it('is used when the window\'s own value is unusable', () => {
    writeLastTab({ id: '2', kind: 'editor' });
    sessionStorage.setItem('palmux-window-tab', '{oops');
    expect(readSelection()).toEqual({ id: '2', kind: 'editor' });
  });

  it('is null when neither storage holds anything usable', () => {
    expect(readSelection()).toBeNull();
    localStorage.setItem(LAST_TAB_KEY, '{"id":"2","kind":"nope"}');
    expect(readSelection()).toBeNull();
  });

  it('lives under palmux-last-tab in the same {id, kind} shape', () => {
    writeLastTab({ id: '7', kind: 'markdown' });
    expect(LAST_TAB_KEY).toBe('palmux-last-tab');
    expect(stored()).toEqual({ id: '7', kind: 'markdown' });
  });

  // The window's own writer and the shared writer are two functions on purpose:
  // App decides WHEN the shared one runs (on a real change, never on a broadcast).
  it('is not written by writeSelection', () => {
    writeSelection({ id: '7', kind: 'terminal' });
    expect(localStorage.getItem('palmux-last-tab')).toBeNull();
  });

  // The kind rides along for the reason it always did: ids are recycled, and a
  // stored `2` of the wrong kind must resolve to the first tab, not a stranger.
  it('still goes through the kind check: a recycled id is gone', () => {
    writeLastTab({ id: '2', kind: 'terminal' });
    expect(resolveSelection({ stored: readSelection(), tabs: TABS })).toBe('5');
    writeLastTab({ id: '2', kind: 'editor' });
    expect(resolveSelection({ stored: readSelection(), tabs: TABS })).toBe('2');
  });

  it('survives localStorage that throws on read and on write', () => {
    vi.stubGlobal('localStorage', denied());
    expect(readSelection()).toBeNull();
    expect(() => writeLastTab({ id: '1', kind: 'terminal' })).not.toThrow();
  });

  it('survives sessionStorage that throws while localStorage still answers', () => {
    writeLastTab({ id: '2', kind: 'editor' });
    vi.stubGlobal('sessionStorage', denied());
    expect(readSelection()).toEqual({ id: '2', kind: 'editor' });
  });

  it('survives both storages missing altogether', () => {
    vi.stubGlobal('sessionStorage', undefined);
    vi.stubGlobal('localStorage', undefined);
    expect(readSelection()).toBeNull();
    expect(() => writeLastTab({ id: '1', kind: 'terminal' })).not.toThrow();
    expect(() => writeSelection({ id: '1', kind: 'terminal' })).not.toThrow();
  });
});

// A detached window is its own browsing context, but `window.open` may copy the opener's
// `sessionStorage` into it, and the device-wide copy is whatever any main window chose last. Either
// would put another window's tab under it, so a detached window reads and writes ONLY its own key.
describe('a detached window', () => {
  const WID = 'wq3k9x2m1a';
  const OWN = `palmux-window-tab:${WID}`;
  const raw = (key: string): unknown => JSON.parse(sessionStorage.getItem(key) ?? 'null');

  it('round-trips through its own sessionStorage key', () => {
    writeSelection({ id: '7', kind: 'markdown' }, WID);
    expect(readSelection(WID)).toEqual({ id: '7', kind: 'markdown' });
    expect(raw(OWN)).toEqual({ id: '7', kind: 'markdown' });
  });

  it("never touches the main window's key when it writes", () => {
    writeSelection({ id: '5', kind: 'terminal' }); // the main window's
    writeSelection({ id: '7', kind: 'markdown' }, WID);
    expect(raw('palmux-window-tab')).toEqual({ id: '5', kind: 'terminal' });
    writeSelection(null, WID);
    expect(raw('palmux-window-tab')).toEqual({ id: '5', kind: 'terminal' });
  });

  // The copy `window.open` may have made of the opener's storage.
  it("never reads the main window's key", () => {
    writeSelection({ id: '5', kind: 'terminal' });
    expect(readSelection(WID)).toBeNull();
  });

  it('never falls back to the device-wide last tab', () => {
    writeLastTab({ id: '2', kind: 'editor' });
    expect(readSelection(WID)).toBeNull();
    // ...not even when its own value is unusable.
    sessionStorage.setItem(OWN, '{oops');
    expect(readSelection(WID)).toBeNull();
  });

  it('writes nothing to the device-wide key', () => {
    writeSelection({ id: '7', kind: 'terminal' }, WID);
    expect(localStorage.getItem(LAST_TAB_KEY)).toBeNull();
  });

  it('clears only its own key on null', () => {
    writeSelection({ id: '7', kind: 'terminal' }, WID);
    writeSelection({ id: '8', kind: 'terminal' }, 'wother00001');
    writeSelection(null, WID);
    expect(readSelection(WID)).toBeNull();
    expect(readSelection('wother00001')).toEqual({ id: '8', kind: 'terminal' });
  });

  it('keeps two detached windows apart', () => {
    writeSelection({ id: '1', kind: 'terminal' }, 'wfirst00001');
    writeSelection({ id: '2', kind: 'editor' }, 'wsecond0001');
    expect(readSelection('wfirst00001')).toEqual({ id: '1', kind: 'terminal' });
    expect(readSelection('wsecond0001')).toEqual({ id: '2', kind: 'editor' });
    expect(readSelection()).toBeNull();
  });

  it("leaves the main window's reads alone: null is the main window", () => {
    writeSelection({ id: '7', kind: 'terminal' }, WID);
    expect(readSelection()).toBeNull();
    expect(readSelection(null)).toBeNull();
    writeLastTab({ id: '2', kind: 'editor' });
    expect(readSelection(null)).toEqual({ id: '2', kind: 'editor' });
  });

  it('survives storage that throws, on read and on write', () => {
    vi.stubGlobal('sessionStorage', denied());
    expect(readSelection(WID)).toBeNull();
    expect(() => writeSelection({ id: '1', kind: 'terminal' }, WID)).not.toThrow();
    expect(() => writeSelection(null, WID)).not.toThrow();
  });

  it('still resolves through the kind check: a recycled id is gone', () => {
    writeSelection({ id: '2', kind: 'terminal' }, WID);
    expect(resolveSelection({ stored: readSelection(WID), tabs: TABS })).toBe('5');
    writeSelection({ id: '2', kind: 'editor' }, WID);
    expect(resolveSelection({ stored: readSelection(WID), tabs: TABS })).toBe('2');
  });
});

describe('resolveSelection', () => {
  it('keeps a remembered tab that is still there', () => {
    expect(resolveSelection({ stored: { id: '0', kind: 'web' }, tabs: TABS })).toBe('0');
  });

  // NOT the lowest id: tab-reorder decoupled display order from id, so "tab 0"
  // can sit anywhere in the strip or not exist at all.
  it('opens the FIRST tab in strip order when nothing is remembered', () => {
    expect(resolveSelection({ stored: null, tabs: TABS })).toBe('5');
  });

  it('renders the chooser when there are no tabs', () => {
    expect(resolveSelection({ stored: { id: '0', kind: 'web' }, tabs: [] })).toBeNull();
    expect(resolveSelection({ stored: null, tabs: [] })).toBeNull();
  });

  // Ids are recycled lowest-free. Restoring "tab 2" when 2 came back as
  // something else entirely would open a stranger.
  it('treats a recycled id as gone, not as a match', () => {
    expect(resolveSelection({ stored: { id: '2', kind: 'terminal' }, tabs: TABS })).toBe('5');
  });

  // The neighbour rule ("the tab I was on was closed from another window") is
  // NOT here. It lives in workspaceController's `sessionsBroadcast`, which is the
  // one place that holds the PREVIOUS strip order needed to compute it — this
  // resolver only ever sees the list as it is now, and at boot there is no
  // "before" for a dead id to be a neighbour of. Two owners for one rule would
  // be worse than the duplication it saves.
  it('sends a dead stored id to the first tab, leaving the neighbour rule to its owner', () => {
    expect(resolveSelection({ stored: { id: '9', kind: 'terminal' }, tabs: TABS })).toBe('5');
  });
});

describe('a review selection', () => {
  const withReview = [...TABS, tab('4', 'review')];

  it('survives a reload: stored, read back and resolved to itself', () => {
    writeSelection({ id: '4', kind: 'review' });
    expect(resolveSelection({ stored: readSelection(), tabs: withReview })).toBe('4');
  });

  it('survives through the device-wide copy as well', () => {
    writeLastTab({ id: '4', kind: 'review' });
    expect(resolveSelection({ stored: readSelection(), tabs: withReview })).toBe('4');
  });
});

describe('resolveStoredSelection', () => {
  it('answers the stored id when it is live with the stored kind', () => {
    expect(resolveStoredSelection(TABS, { id: '0', kind: 'web' })).toBe('0');
    expect(resolveStoredSelection([...TABS, tab('4', 'review')], { id: '4', kind: 'review' })).toBe(
      '4',
    );
  });

  // The whole point of the helper: no `tabs[0]` guess, so a caller can tell "remembered" from
  // "nothing usable" and leave a better answer (a restored layout's own focus) alone.
  it('answers null for a stale stored value, where resolveSelection guesses the first tab', () => {
    const stale = { id: '9', kind: 'terminal' } as const;
    expect(resolveStoredSelection(TABS, stale)).toBeNull();
    expect(resolveSelection({ stored: stale, tabs: TABS })).toBe('5');
  });

  it('treats a recycled id as gone', () => {
    expect(resolveStoredSelection(TABS, { id: '2', kind: 'terminal' })).toBeNull();
  });

  it('answers null for nothing stored and for no tabs', () => {
    expect(resolveStoredSelection(TABS, null)).toBeNull();
    expect(resolveStoredSelection([], { id: '0', kind: 'web' })).toBeNull();
  });
});

describe('selectionFor', () => {
  it('captures the kind alongside the id', () => {
    expect(selectionFor(TABS, '2')).toEqual({ id: '2', kind: 'editor' });
  });

  it('is null for a tab that is not there', () => {
    expect(selectionFor(TABS, '9')).toBeNull();
  });
});
