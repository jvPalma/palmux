// Every workspace navigation invariant as a direct `decide()` unit test —
// selection, split-into-a-new-pane, recycled-id, close-nav — instead of
// full-<App>-render DOM assertions.

import { describe, expect, it } from 'vitest';
import type { TabMeta } from '@palmux/shared';
import { decide, type WorkspaceCtx, type WorkspaceEvent } from './workspaceController';

const tab = (id: string, kind: TabMeta['kind'] = 'terminal'): TabMeta => ({ id, kind });

/** `leafOf` over a fixed map: tab id → the pane that holds it and how many tabs that pane has. */
const panes =
  (held: { [tabId: string]: { id: string; count: number } }): WorkspaceCtx['leafOf'] =>
  (tabId) =>
    held[tabId] ?? null;

const ctx = (over: Partial<WorkspaceCtx> = {}): WorkspaceCtx => ({
  sessionId: '0',
  tabs: [tab('0'), tab('1'), tab('2')],
  mobileActive: false,
  seenTermIds: new Set(['0', '1', '2']),
  detached: false,
  groups: true,
  leafOf: panes({
    '0': { id: 'p0', count: 3 },
    '1': { id: 'p0', count: 3 },
    '2': { id: 'p0', count: 3 },
  }),
  holdsPending: false,
  ...over,
});

const run = (event: WorkspaceEvent, over: Partial<WorkspaceCtx> = {}) => decide(event, ctx(over));

describe('selectTab', () => {
  it('navigates and clears the chooser page', () => {
    expect(run({ type: 'selectTab', id: '2' })).toEqual([
      { type: 'chooserPage', value: false },
      { type: 'navigate', id: '2' },
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

describe('menuSplit', () => {
  it('moves a tab that shares its pane into a new pane beside it', () => {
    expect(run({ type: 'menuSplit', tabId: '1', side: 'right' })).toEqual([
      { type: 'split', leafId: 'p0', tabId: '1', side: 'right' },
    ]);
    expect(run({ type: 'menuSplit', tabId: '2', side: 'bottom' })).toEqual([
      { type: 'split', leafId: 'p0', tabId: '2', side: 'bottom' },
    ]);
  });

  it('asks for a new terminal when the tab is its pane’s only one', () => {
    const out = run(
      { type: 'menuSplit', tabId: '0', side: 'bottom' },
      { leafOf: panes({ '0': { id: 'p3', count: 1 } }) },
    );
    expect(out).toEqual([{ type: 'splitLone', leafId: 'p3', side: 'bottom' }]);
  });

  it('uses the pane the tab is in, not the one that is focused', () => {
    const out = run(
      { type: 'menuSplit', tabId: '1', side: 'right' },
      { leafOf: panes({ '1': { id: 'p2', count: 2 } }) },
    );
    expect(out).toEqual([{ type: 'split', leafId: 'p2', tabId: '1', side: 'right' }]);
  });

  it('does nothing for a tab no pane holds', () => {
    expect(run({ type: 'menuSplit', tabId: '9', side: 'right' })).toEqual([]);
  });

  it('does nothing on the mobile layer, where groups are off', () => {
    expect(
      run({ type: 'menuSplit', tabId: '1', side: 'right' }, { mobileActive: true, groups: false }),
    ).toEqual([]);
    expect(run({ type: 'menuSplit', tabId: '1', side: 'right' }, { groups: false })).toEqual([]);
  });
});

describe('tabCreated', () => {
  it('navigates to the created tab and clears the chooser page', () => {
    expect(run({ type: 'tabCreated', id: '7' })).toEqual([
      { type: 'chooserPage', value: false },
      { type: 'navigate', id: '7' },
    ]);
  });

  // A review create is idempotent in the server registry, so its answer can name a tab this
  // window already holds: it is shown where it is (the layout's `show` activates it in its pane).
  it('answers an id this window already holds with the same navigation', () => {
    const review: TabMeta = { id: '3', kind: 'review', url: 'changes:/work/app' };
    expect(run({ type: 'tabCreated', id: '3' }, { tabs: [tab('0'), review] })).toEqual([
      { type: 'chooserPage', value: false },
      { type: 'navigate', id: '3' },
    ]);
  });
});

describe('sessionsBroadcast with editor groups', () => {
  // Each pane re-picks its own active tab during reconcile (pane-grid.ts), so a closed active
  // tab needs no navigation from here.
  it('leaves a closed active tab to the panes', () => {
    const out = decide(
      { type: 'sessionsBroadcast', tabs: [tab('0'), tab('2')] },
      ctx({ sessionId: '1' }),
    );
    expect(out).toEqual([]);
  });

  it('nothing survives → the New-tab PAGE', () => {
    const out = decide(
      { type: 'sessionsBroadcast', tabs: [] },
      ctx({ sessionId: '0', tabs: [tab('0')] }),
    );
    expect(out).toEqual([{ type: 'chooserPage', value: true }]);
  });

  it('a list that still holds tabs asks for nothing', () => {
    expect(
      decide({ type: 'sessionsBroadcast', tabs: [tab('0'), tab('1')] }, ctx({ sessionId: '0' })),
    ).toEqual([]);
  });

  // A terminal this window just created is in no list until its pane attaches. An empty list that
  // lands first says nothing about it, and the page would unmount the pane that is about to spawn it.
  it('an empty list keeps a pane that holds a terminal no broadcast has listed yet', () => {
    const out = decide(
      { type: 'sessionsBroadcast', tabs: [] },
      ctx({ sessionId: '3', tabs: [], holdsPending: true }),
    );
    expect(out).toEqual([]);
  });
});

// A detached window has editor groups on, so reconcile owns the close-navigation. What it must NOT
// do is show the New-tab page for an empty list: an empty window closes itself (App's self-close),
// and the page that would appear for one render is the flash that rule exists to avoid.
describe('sessionsBroadcast in a detached window', () => {
  const detached = { detached: true } as const;

  it('an empty list asks for nothing: closing the window is App’s, not a page', () => {
    const out = decide(
      { type: 'sessionsBroadcast', tabs: [] },
      ctx({ ...detached, sessionId: '0', tabs: [tab('0')] }),
    );
    expect(out).toEqual([]);
  });

  it('leaves a closed active tab to the panes, as the main window does', () => {
    const out = decide(
      { type: 'sessionsBroadcast', tabs: [tab('0'), tab('2')] },
      ctx({ ...detached, sessionId: '1' }),
    );
    expect(out).toEqual([]);
  });

  it('still lets a split and a selection through', () => {
    expect(run({ type: 'selectTab', id: '2' }, detached)).toEqual([
      { type: 'chooserPage', value: false },
      { type: 'navigate', id: '2' },
    ]);
    expect(
      run(
        { type: 'menuSplit', tabId: '1', side: 'right' },
        { ...detached, leafOf: panes({ '1': { id: 'p0', count: 3 } }) },
      ),
    ).toEqual([{ type: 'split', leafId: 'p0', tabId: '1', side: 'right' }]);
  });
});

describe('sessionsBroadcast (close-navigation) without editor groups', () => {
  const flat = { groups: false } as const;

  it('the active tab closed → navigate to its LEFT neighbor', () => {
    // old tabs [0,1,2], active 1 closed → left neighbor 0
    const out = decide(
      { type: 'sessionsBroadcast', tabs: [tab('0'), tab('2')] },
      ctx({ ...flat, sessionId: '1' }),
    );
    expect(out).toEqual([{ type: 'navigate', id: '0' }]);
  });

  it('nothing survives → the New-tab PAGE', () => {
    const out = decide(
      { type: 'sessionsBroadcast', tabs: [] },
      ctx({ ...flat, sessionId: '0', tabs: [tab('0')] }),
    );
    expect(out).toEqual([{ type: 'chooserPage', value: true }]);
  });

  it('a FRESH (never-seen) active terminal missing from the broadcast is NOT closed', () => {
    const out = decide(
      { type: 'sessionsBroadcast', tabs: [tab('0')] },
      ctx({ ...flat, sessionId: '9', tabs: [tab('0')], seenTermIds: new Set(['0']) }),
    );
    expect(out).toEqual([]);
  });

  it('the active tab still present → no navigation', () => {
    expect(
      decide(
        { type: 'sessionsBroadcast', tabs: [tab('0'), tab('1')] },
        ctx({ ...flat, sessionId: '0' }),
      ),
    ).toEqual([]);
  });
});
