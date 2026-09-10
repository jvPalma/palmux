// Which tab a window shows, once the URL stopped being the answer.
//
// The one thing here that is easy to get subtly wrong and expensive to get
// wrong is a RECYCLED id: ids are handed out lowest-free, so a stored `2` can
// come back as an entirely different kind of tab, and restoring "tab 2" would
// then open a stranger.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TabMeta } from '@palmux/shared';
import {
  parseSelection,
  readSelection,
  resolveSelection,
  selectionFor,
  writeSelection,
} from './window-selection';

const tab = (id: string, kind: TabMeta['kind'] = 'terminal'): TabMeta => ({ id, kind });
const TABS = [tab('5'), tab('0', 'web'), tab('2', 'editor')];

afterEach(() => {
  try {
    sessionStorage.clear();
  } catch {
    /* not available in this environment */
  }
  vi.unstubAllGlobals();
});

describe('parseSelection', () => {
  it('reads a well-formed value', () => {
    expect(parseSelection('{"id":"3","kind":"editor"}')).toEqual({ id: '3', kind: 'editor' });
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

describe('selectionFor', () => {
  it('captures the kind alongside the id', () => {
    expect(selectionFor(TABS, '2')).toEqual({ id: '2', kind: 'editor' });
  });

  it('is null for a tab that is not there', () => {
    expect(selectionFor(TABS, '9')).toBeNull();
  });
});
