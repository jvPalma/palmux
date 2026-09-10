// The bulk-close selection and its confirmation wording. Pure functions, so the
// thing that decides whether a running shell dies is testable without a socket.

import { describe, expect, it } from 'vitest';
import type { TabMeta } from '@palmux/shared';
import { closeManyMessage, tabsExcept, tabsToTheRight } from './close-many';

const TABS: TabMeta[] = [
  { id: '0', kind: 'terminal' },
  { id: '1', kind: 'web', url: 'https://x' },
  { id: '2', kind: 'editor', name: 'notes' },
  { id: '3', kind: 'terminal' },
];

describe('tabsExcept', () => {
  it('keeps strip order and drops exactly one', () => {
    expect(tabsExcept(TABS, '1').map((t) => t.id)).toEqual(['0', '2', '3']);
  });

  it('returns everything for an unknown id', () => {
    expect(tabsExcept(TABS, 'nope')).toHaveLength(4);
  });

  it('is empty for the only tab', () => {
    expect(tabsExcept([TABS[0]!], '0')).toEqual([]);
  });
});

describe('tabsToTheRight', () => {
  it('takes what follows, in order', () => {
    expect(tabsToTheRight(TABS, '1').map((t) => t.id)).toEqual(['2', '3']);
  });

  it('is empty for the last tab', () => {
    expect(tabsToTheRight(TABS, '3')).toEqual([]);
  });

  // An unknown id closing EVERYTHING would be the worst possible reading of
  // "to the right of a tab that isn't there".
  it('closes nothing for an unknown id', () => {
    expect(tabsToTheRight(TABS, 'nope')).toEqual([]);
  });
});

describe('closeManyMessage', () => {
  it('names the terminal kill count', () => {
    const msg = closeManyMessage(TABS, {}, 'Close 4 tabs?');
    expect(msg).toContain('Close 4 tabs?');
    expect(msg).toContain('2 terminals will be killed.');
  });

  it('singularises', () => {
    const msg = closeManyMessage([TABS[0]!], {}, 'Close 1 tab?');
    expect(msg).toContain('1 terminal will be killed.');
    expect(msg).not.toContain('terminals');
  });

  it('warns about unsaved editors, and only the dirty ones', () => {
    expect(closeManyMessage(TABS, { '2': true }, 'x')).toContain(
      '1 editor tab with unsaved changes will be discarded.',
    );
    expect(closeManyMessage(TABS, { '2': false }, 'x')).not.toContain('unsaved');
    // A dirty flag on a NON-editor is not an editor warning.
    expect(closeManyMessage(TABS, { '0': true }, 'x')).not.toContain('unsaved');
  });

  it('says nothing extra when nothing is at stake', () => {
    const webOnly: TabMeta[] = [{ id: '9', kind: 'web', url: 'https://x' }];
    expect(closeManyMessage(webOnly, {}, 'Close 1 tab?')).toBe('Close 1 tab?');
  });

  // Null, not an empty confirm: the caller uses it to skip the dialog entirely.
  it('is null for an empty selection', () => {
    expect(closeManyMessage([], {}, 'Close 0 tabs?')).toBeNull();
  });
});
