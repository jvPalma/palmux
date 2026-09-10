// Every workspace navigation invariant as a direct `decide()` unit test —
// member focus, split-outside, fuse ordering, eject-to-survivor, recycled-id,
// close-nav — instead of full-<App>-render DOM assertions.

import { describe, expect, it } from 'vitest';
import type { TabMeta } from '@palmux/shared';
import { decide, type WorkspaceCtx, type WorkspaceEvent } from './workspaceController';
import type { SplitState } from './useSplit';

const tab = (id: string, kind: TabMeta['kind'] = 'terminal'): TabMeta => ({ id, kind });
const split = (a: string, b: string, focused: 'a' | 'b' = 'b'): SplitState => ({
  a: { tabId: a, kind: 'terminal' },
  b: { tabId: b, kind: 'terminal' },
  orientation: 'row',
  ratio: 0.5,
  focused,
});

const ctx = (over: Partial<WorkspaceCtx> = {}): WorkspaceCtx => ({
  sessionId: '0',
  pairings: [],
  tabs: [tab('0'), tab('1'), tab('2')],
  mobileActive: false,
  activeKind: 'terminal',
  seenTermIds: new Set(['0', '1', '2']),
  popout: false,
  groupOf: () => undefined,
  ...over,
});

const run = (event: WorkspaceEvent, over: Partial<WorkspaceCtx> = {}) => decide(event, ctx(over));

describe('selectTab', () => {
  it('a non-member selection navigates (push) and clears the chooser page', () => {
    expect(run({ type: 'selectTab', id: '2' })).toEqual([
      { type: 'chooserPage', value: false },
      { type: 'navigate', id: '2' },
    ]);
  });

  it('a pairing MEMBER focuses its slot then navigates (even from outside)', () => {
    // active session '2' is full-width; selecting member '1' of the 0/1 pairing.
    const out = run(
      { type: 'selectTab', id: '1' },
      { sessionId: '2', pairings: [split('0', '1')] },
    );
    expect(out).toEqual([
      { type: 'chooserPage', value: false },
      { type: 'focusSlotP', key: '0', slot: 'b' },
      { type: 'navigate', id: '1' },
    ]);
  });

  it('selecting the OTHER member of the ACTIVE pairing is a focus flip (replace)', () => {
    // active session '0' — the 0/1 pairing is on screen; a segment click on '1'
    // must not grow browser history (the focused-slot URL rule).
    const out = run({ type: 'selectTab', id: '1' }, { pairings: [split('0', '1')] });
    expect(out).toEqual([
      { type: 'chooserPage', value: false },
      { type: 'focusSlotP', key: '0', slot: 'b' },
      { type: 'navigate', id: '1' },
    ]);
  });

  // `mode` is gone with the URL it described. push / replace / set said what to
  // do with the address bar; nothing writes the address bar, so there is one way
  // to navigate and the modes had nothing left to distinguish.
  it('emits one plain navigate, whatever the selection was', () => {
    for (const id of ['1', '2']) {
      const nav = run({ type: 'selectTab', id }).find((e) => e.type === 'navigate');
      expect(nav).toEqual({ type: 'navigate', id });
    }
  });
});

describe('focusSlot', () => {
  it('the active pairing focuses the other slot and navigates (replace)', () => {
    const out = run(
      { type: 'focusSlot', slot: 'a' },
      { sessionId: '0', pairings: [split('0', '1', 'b')] },
    );
    expect(out).toEqual([
      { type: 'focusSlotP', key: '0', slot: 'a' },
      { type: 'navigate', id: '0' },
    ]);
  });

  it('no-ops without an active pairing (session is a full-width non-member)', () => {
    expect(
      run({ type: 'focusSlot', slot: 'a' }, { sessionId: '0', pairings: [split('1', '2')] }),
    ).toEqual([]);
  });

  it('no-ops on the already-focused slot', () => {
    expect(
      run({ type: 'focusSlot', slot: 'b' }, { sessionId: '0', pairings: [split('0', '1', 'b')] }),
    ).toEqual([]);
  });
});

describe('menuSplit', () => {
  it('is blocked while this tab is already paired or mobile is active', () => {
    expect(
      run({ type: 'menuSplit', otherId: '2', orientation: 'row' }, { pairings: [split('0', '1')] }),
    ).toEqual([]);
    expect(
      run({ type: 'menuSplit', otherId: '1', orientation: 'row' }, { mobileActive: true }),
    ).toEqual([]);
  });

  it('splits the current tab with another tab in slot B (fuse then open then nav)', () => {
    const out = run({ type: 'menuSplit', otherId: '1', orientation: 'column' });
    expect(out).toEqual([
      { type: 'fuseSync', keepId: '0', moveId: '1', moveGid: null, targetGid: null },
      {
        type: 'openSplit',
        a: { tabId: '0', kind: 'terminal' },
        b: { tabId: '1', kind: 'terminal' },
        orientation: 'column',
        focused: 'b',
      },
      { type: 'navigate', id: '1' },
    ]);
  });

  it('splitting with the active/only tab spawns a fresh terminal (unsee BEFORE fuseSync)', () => {
    // tabs 0,1,2 + sessionId 0 → lowest free is 3; moveId 3 is fresh (App skips fuseSync)
    const out = run({ type: 'menuSplit', otherId: '0', orientation: 'row' });
    expect(out).toEqual([
      { type: 'unsee', id: '3' },
      { type: 'fuseSync', keepId: '0', moveId: '3', moveGid: null, targetGid: null },
      {
        type: 'openSplit',
        a: { tabId: '0', kind: 'terminal' },
        b: { tabId: '3', kind: 'terminal' },
        orientation: 'row',
        focused: 'b',
      },
      { type: 'navigate', id: '3' },
    ]);
  });

  it('fusing across groups carries both group ids into fuseSync', () => {
    const groupOf = (id: string): string | undefined =>
      id === '0' ? 'gA' : id === '1' ? 'gB' : undefined;
    const out = run({ type: 'menuSplit', otherId: '1', orientation: 'row' }, { groupOf });
    expect(out).toContainEqual({
      type: 'fuseSync',
      keepId: '0',
      moveId: '1',
      moveGid: 'gB',
      targetGid: 'gA',
    });
  });

  it('fuses independently while ANOTHER (non-active) pairing exists', () => {
    // session '0' is not a member of the 3/4 pairing → not blocked; it fuses with '1'.
    const out = run(
      { type: 'menuSplit', otherId: '1', orientation: 'row' },
      {
        pairings: [split('3', '4')],
      },
    );
    expect(out).toEqual([
      { type: 'fuseSync', keepId: '0', moveId: '1', moveGid: null, targetGid: null },
      {
        type: 'openSplit',
        a: { tabId: '0', kind: 'terminal' },
        b: { tabId: '1', kind: 'terminal' },
        orientation: 'row',
        focused: 'b',
      },
      { type: 'navigate', id: '1' },
    ]);
  });
});

describe('dropSplit', () => {
  it('a right-edge drop puts the dragged tab in slot B (row) after fuseSync', () => {
    const out = run({ type: 'dropSplit', id: '1', side: 'right' });
    expect(out).toEqual([
      { type: 'fuseSync', keepId: '0', moveId: '1', moveGid: null, targetGid: null },
      {
        type: 'openSplit',
        a: { tabId: '0', kind: 'terminal' },
        b: { tabId: '1', kind: 'terminal' },
        orientation: 'row',
        focused: 'b',
      },
      { type: 'navigate', id: '1' },
    ]);
  });

  it('a top-edge drop puts the dragged tab in slot A (column, before)', () => {
    const out = run({ type: 'dropSplit', id: '1', side: 'top' });
    expect(out).toContainEqual({
      type: 'openSplit',
      a: { tabId: '1', kind: 'terminal' },
      b: { tabId: '0', kind: 'terminal' },
      orientation: 'column',
      focused: 'a',
    });
  });

  // Behaviour CHANGED deliberately (owner report): this used to spawn a fresh
  // terminal, which is not what dropping a tab means anywhere else and read as
  // a bug — "it creates a new shell tab instead of mirroring". A pane cannot
  // mirror itself (one PTY, one attachment), so the gesture is refused outright.
  it('refuses to split the active tab with itself', () => {
    expect(run({ type: 'dropSplit', id: '0', side: 'right' })).toEqual([]);
    expect(run({ type: 'dropSplit', id: '0', side: 'bottom' })).toEqual([]);
  });

  // The MENU path keeps the spawn: "Split with… (this tab)" is an explicit
  // request for a second terminal, not a misfired drag.
  it('still spawns a fresh terminal from the menu, not the drag', () => {
    const out = run({ type: 'menuSplit', otherId: '0', orientation: 'row' });
    expect(out[0]).toEqual({ type: 'unsee', id: '3' });
    expect(out).toContainEqual({ type: 'navigate', id: '3' });
  });

  it('fusing across groups carries both group ids into fuseSync', () => {
    const groupOf = (id: string): string | undefined =>
      id === '0' ? 'gA' : id === '1' ? 'gB' : undefined;
    const out = run({ type: 'dropSplit', id: '1', side: 'right' }, { groupOf });
    expect(out).toContainEqual({
      type: 'fuseSync',
      keepId: '0',
      moveId: '1',
      moveGid: 'gB',
      targetGid: 'gA',
    });
  });

  it('is blocked while paired or mobile is active', () => {
    expect(
      run({ type: 'dropSplit', id: '2', side: 'right' }, { pairings: [split('0', '1')] }),
    ).toEqual([]);
    expect(run({ type: 'dropSplit', id: '1', side: 'right' }, { mobileActive: true })).toEqual([]);
  });
});

describe('dropSlot', () => {
  it('replaces the targeted slot, syncing the REMAINING member as fuse anchor', () => {
    // pairing 0/1, replace slot A with '2' → remaining member is slot B (id 1).
    const out = run(
      { type: 'dropSlot', id: '2', slot: 'a' },
      { sessionId: '0', pairings: [split('0', '1')] },
    );
    expect(out).toEqual([
      { type: 'fuseSync', keepId: '1', moveId: '2', moveGid: null, targetGid: null },
      { type: 'setSlot', key: '0', slot: 'a', ref: { tabId: '2', kind: 'terminal' } },
      { type: 'navigate', id: '2' },
    ]);
  });

  it('no-ops when the dropped tab is already a member', () => {
    expect(
      run(
        { type: 'dropSlot', id: '1', slot: 'a' },
        { sessionId: '0', pairings: [split('0', '1')] },
      ),
    ).toEqual([]);
  });

  it('no-ops without an active pairing', () => {
    expect(run({ type: 'dropSlot', id: '2', slot: 'a' })).toEqual([]);
  });
});

describe('eject', () => {
  it('dissolves the active pairing and navigates to the KEPT slot', () => {
    const out = run({ type: 'eject', keep: 'b' }, { sessionId: '0', pairings: [split('0', '1')] });
    expect(out).toEqual([
      { type: 'dissolveP', key: '0' },
      { type: 'navigate', id: '1' },
    ]);
  });

  it('with no keep, survives on the focused slot', () => {
    const out = run({ type: 'eject' }, { sessionId: '0', pairings: [split('0', '1', 'a')] });
    expect(out).toContainEqual({ type: 'navigate', id: '0' });
  });

  it('no-ops without an active pairing', () => {
    expect(run({ type: 'eject', keep: 'a' })).toEqual([]);
  });
});

describe('tabCreated', () => {
  it('a non-colliding id navigates (push), no pairing touched', () => {
    expect(run({ type: 'tabCreated', id: '7' }, { pairings: [split('0', '1')] })).toEqual([
      { type: 'chooserPage', value: false },
      { type: 'navigate', id: '7' },
    ]);
  });

  it('an id colliding with a stale member dissolves that pairing first', () => {
    const out = run({ type: 'tabCreated', id: '1' }, { pairings: [split('0', '1')] });
    expect(out).toEqual([
      { type: 'dissolveP', key: '0' },
      { type: 'chooserPage', value: false },
      { type: 'navigate', id: '1' },
    ]);
  });
});

describe('sessionsBroadcast (close-navigation)', () => {
  it('the active tab closed → navigate to its LEFT neighbor', () => {
    // old tabs [0,1,2], active 1 closed → left neighbor 0
    const out = decide(
      { type: 'sessionsBroadcast', tabs: [tab('0'), tab('2')] },
      ctx({ sessionId: '1' }),
    );
    expect(out).toEqual([{ type: 'navigate', id: '0' }]);
  });

  it('nothing survives → the New-tab PAGE', () => {
    const out = decide(
      { type: 'sessionsBroadcast', tabs: [] },
      ctx({ sessionId: '0', tabs: [tab('0')] }),
    );
    expect(out).toEqual([{ type: 'chooserPage', value: true }]);
  });

  it('a FRESH (never-seen) active terminal missing from the broadcast is NOT closed', () => {
    const out = decide(
      { type: 'sessionsBroadcast', tabs: [tab('0')] },
      ctx({ sessionId: '9', tabs: [tab('0')], seenTermIds: new Set(['0']) }),
    );
    expect(out).toEqual([]);
  });

  it('no-ops while an active pairing exists or in a popout', () => {
    // session '1' is a member of the 0/1 pairing → active pairing → skip close-nav.
    expect(
      decide(
        { type: 'sessionsBroadcast', tabs: [tab('0')] },
        ctx({ sessionId: '1', pairings: [split('0', '1')] }),
      ),
    ).toEqual([]);
    expect(
      decide(
        { type: 'sessionsBroadcast', tabs: [tab('0')] },
        ctx({ sessionId: '1', popout: true }),
      ),
    ).toEqual([]);
  });

  it('the active tab still present → no navigation', () => {
    expect(
      decide({ type: 'sessionsBroadcast', tabs: [tab('0'), tab('1')] }, ctx({ sessionId: '0' })),
    ).toEqual([]);
  });
});
