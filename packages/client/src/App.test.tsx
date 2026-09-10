// App-level split model integration: the Chrome-like display scoping wired
// through the REAL App (selectTab / doDropSlot / eject / tabCreated / [+]),
// with the heavy leaves mocked at their seams — WsClient (we play the server),
// TerminalPane (a stub div carrying slot/session/focus), PaneHost. These pin
// the change's headline invariants: selection/creation NEVER replaces a slot,
// exactly two slots ever, eject keeps the other tab, hidden pairings stay put.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, shouldRestoreKeyboard } from './App';
import { TAB_DND_TYPE } from './session/SessionTabs';

// The chooser's controls activate on pointer UP (with a movement check) so a
// finger can scroll past them; a press is therefore down THEN up.
const tapPress = (el: Element) => {
  fireEvent.pointerDown(el, { button: 0 });
  fireEvent.pointerUp(el, { button: 0 });
};

// ── fake control socket (App creates exactly one; panes are mocked) ──────────
const { sockets } = vi.hoisted(() => ({
  sockets: [] as Array<{
    url: string;
    handler: ((msg: Record<string, unknown>) => void) | null;
    killed: string[];
    created: unknown[];
    reorders: string[][];
    groupCreates: unknown[];
    groupUpdates: Array<Record<string, unknown>>;
  }>,
}));

vi.mock('./lib/ws', () => ({
  WsClient: class {
    url: string;
    handler: ((msg: Record<string, unknown>) => void) | null = null;
    killed: string[] = [];
    created: unknown[] = [];
    reorders: string[][] = [];
    groupCreates: unknown[] = [];
    groupUpdates: Array<Record<string, unknown>> = [];
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }
    onMessage(cb: (msg: Record<string, unknown>) => void) {
      this.handler = cb;
    }
    onBinary() {}
    onOpen() {}
    connect() {}
    destroy() {}
    stopReconnect() {}
    sendSettings() {
      return true;
    }
    sendExtraKeys() {
      return true;
    }
    sendKill(id: string) {
      this.killed.push(id);
      return true;
    }
    sendCreateTab(spec: unknown) {
      this.created.push(spec);
      return true;
    }
    sendUpdateTab() {
      return true;
    }
    sendReorderTabs(ids: string[]) {
      this.reorders.push(ids);
      return true;
    }
    sendGroupCreate(ids: string[], meta: Record<string, unknown>) {
      this.groupCreates.push({ ids, ...meta });
      return true;
    }
    sendGroupUpdate(patch: Record<string, unknown>) {
      this.groupUpdates.push(patch);
      return true;
    }
    sendInput() {
      return true;
    }
    sendResize() {
      return true;
    }
  },
}));

// TerminalPane stub: enough surface for the layout/focus assertions, plus the
// real pane's mousedown→onFocusRequest wiring (pins the hidden-pairing guard).
vi.mock('./terminal/TerminalPane', () => ({
  TerminalPane: (p: {
    slot: string;
    sessionId: string;
    focused: boolean;
    inSplit: boolean;
    onFocusRequest: (slot: string) => void;
  }) => (
    <div
      data-testid={`term-pane-${p.slot}`}
      data-session={p.sessionId}
      className={p.inSplit ? `slot${p.focused ? ' focused' : ''}` : ''}
      onMouseDown={() => p.onFocusRequest(p.slot as never)}
    />
  ),
}));

vi.mock('./panes/PaneHost', () => ({ PaneHost: () => <div data-testid="pane-host" /> }));

const server = () => {
  const s = sockets[0];
  if (!s?.handler) throw new Error('control socket not connected');
  return s;
};
const send = (msg: Record<string, unknown>) =>
  act(() => {
    server().handler!(msg);
  });
const broadcast = (ids: string[]) =>
  send({ type: 'sessions', tabs: ids.map((id) => ({ id, kind: 'terminal' })) });

const panes = () =>
  [...document.querySelectorAll('[data-testid^="term-pane-"]')].map((e) => ({
    slot: (e as HTMLElement).dataset['testid']!.slice(-1),
    session: (e as HTMLElement).dataset['session'],
    focused: e.className.includes('focused'),
  }));

// A member of an on-screen (or fused) pairing renders as a fused SEGMENT, not a
// plain tab; click whichever surface is present.
const clickTab = (id: string) => {
  const seg = screen.queryByTestId(`fused-seg-${id}`);
  fireEvent.click(seg ?? screen.getByTestId(`session-tab-${id}`), { button: 0 });
};

/** Open a split (current tab | otherId) via the real context-menu path. */
const openSplitVia = (otherId: string) => {
  fireEvent.contextMenu(screen.getByTestId(`session-tab-${otherId}`));
  fireEvent.click(screen.getByTestId('menu-split-right'));
};

const dt = () => {
  let data = '';
  return {
    types: [TAB_DND_TYPE],
    setData: (_t: string, v: string) => {
      data = v;
    },
    getData: () => data,
    effectAllowed: '',
    dropEffect: '',
  };
};

beforeEach(() => {
  sockets.length = 0;
  localStorage.clear();
  localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'off' }));
  history.replaceState(null, '', '/0');
});

const setup = (ids: string[] = ['0', '1', '2']) => {
  render(<App />);
  broadcast(ids);
};

/**
 * The tab this window is showing.
 *
 * These assertions used to read `location.pathname`, back when the path WAS the
 * active tab. The path is `/` now and the window remembers instead, so the
 * question has to be asked of the panes — which is what it always meant.
 */
const active = (): string | null => {
  const p = panes();
  return (p.find((x) => x.focused) ?? p[0])?.session ?? null;
};

describe('split display scoping (selection never replaces a slot)', () => {
  it('member selection re-tiles; non-member shows full-width with the pairing kept', () => {
    setup();
    openSplitVia('1'); // split (0|1), navigated to 1
    expect(panes()).toEqual([
      { slot: 'a', session: '0', focused: false },
      { slot: 'b', session: '1', focused: true },
    ]);
    clickTab('2'); // non-member → full-width, split preserved
    expect(active()).toBe('2');
    expect(panes()).toEqual([{ slot: 'a', session: '2', focused: false }]);
    expect(localStorage.getItem('palmux-splits')).toContain('"tabId":"0"');
    clickTab('0'); // member → re-tile focused on its slot
    expect(active()).toBe('0');
    expect(panes()).toEqual([
      { slot: 'a', session: '0', focused: true },
      { slot: 'b', session: '1', focused: false },
    ]);
    clickTab('1'); // the other member → stays tiled, focus moves
    expect(panes()[1]).toEqual({ slot: 'b', session: '1', focused: true });
  });

  it('tabCreated activates the new tab OUTSIDE the split', () => {
    setup();
    openSplitVia('1');
    send({ type: 'tabCreated', id: '7' });
    expect(active()).toBe('7');
    expect(panes()).toEqual([{ slot: 'a', session: '7', focused: false }]);
    expect(localStorage.getItem('palmux-splits')).toContain('"tabId":"1"');
  });

  it('[+] → New terminal creates outside the split (never consumes a slot)', () => {
    setup(['0', '1']);
    openSplitVia('1');
    fireEvent.pointerDown(screen.getByTestId('session-new'), { button: 0 });
    tapPress(screen.getByTestId('dash-new-terminal'));
    expect(active()).toBe('2'); // fresh id, not a member
    expect(panes()).toEqual([{ slot: 'a', session: '2', focused: false }]);
    expect(localStorage.getItem('palmux-splits')).toContain('"tabId":"0"');
  });

  it('a mousedown inside a full-width non-member pane never yanks to the pairing', () => {
    setup();
    openSplitVia('1');
    clickTab('2'); // hidden pairing
    fireEvent.mouseDown(screen.getByTestId('term-pane-a'));
    expect(active()).toBe('2');
    expect(panes()).toEqual([{ slot: 'a', session: '2', focused: false }]);
  });
});

describe('drag-onto-slot replacement', () => {
  it('dropping a non-member on a slot replaces it; the replaced tab stays in the strip', () => {
    setup();
    openSplitVia('1'); // (0|1)
    const t = dt();
    fireEvent.dragStart(screen.getByTestId('session-tab-2'), { dataTransfer: t });
    t.setData(TAB_DND_TYPE, '2');
    fireEvent.drop(screen.getByTestId('slot-dropzone-a'), { dataTransfer: t });
    expect(panes()).toEqual([
      { slot: 'a', session: '2', focused: true },
      { slot: 'b', session: '1', focused: false },
    ]);
    expect(screen.getByTestId('session-tab-0')).toBeTruthy(); // replaced, not closed
    expect(active()).toBe('2');
  });

  it('dragging a fused member never lights the slot drop zones (no self-duplication)', () => {
    setup();
    openSplitVia('1'); // (0|1) focused b, fused in the strip
    const t = dt();
    // The fused button drags as its slot-A id — a member of the active pairing.
    fireEvent.dragStart(screen.getByTestId('fused-tab-0-1'), { dataTransfer: t });
    t.setData(TAB_DND_TYPE, '0');
    // Slot zones must stay hidden: dropping a member on a slot would duplicate it.
    expect(screen.queryByTestId('slot-dropzone-a')).toBeNull();
    expect(screen.queryByTestId('slot-dropzone-b')).toBeNull();
    expect(panes()).toEqual([
      { slot: 'a', session: '0', focused: false },
      { slot: 'b', session: '1', focused: true },
    ]);
  });
});

describe('per-slot eject', () => {
  it('ejecting slot A keeps B full-width; both tabs stay in the strip', () => {
    setup();
    openSplitVia('1'); // (0|1)
    fireEvent.click(screen.getByTestId('slot-eject-a'));
    expect(active()).toBe('1');
    expect(panes()).toEqual([{ slot: 'a', session: '1', focused: false }]);
    expect(screen.getByTestId('session-tab-0')).toBeTruthy();
    expect(screen.getByTestId('session-tab-1')).toBeTruthy();
    expect(localStorage.getItem('palmux-splits')).toBeNull();
  });

  it('ejecting slot B keeps A full-width', () => {
    setup();
    openSplitVia('1');
    fireEvent.click(screen.getByTestId('slot-eject-b'));
    expect(active()).toBe('0');
    expect(panes()).toEqual([{ slot: 'a', session: '0', focused: false }]);
  });

  // The chooser opens the DOCK, which is layout beside the split rather than
  // anything over it — both slots keep their eject control and stay usable.
  it('the [+] chooser does not disturb the split beneath it', () => {
    setup();
    openSplitVia('1');
    expect(screen.getByTestId('slot-eject-a')).toBeTruthy();
    fireEvent.pointerDown(screen.getByTestId('session-new'), { button: 0 });
    expect(screen.getByTestId('dock')).toHaveAttribute('data-view', 'newtab');
    expect(screen.getByTestId('slot-eject-a')).toBeTruthy();
    expect(screen.getByTestId('slot-eject-b')).toBeTruthy();
  });
});

describe('reconcile with the pairing (review fixes)', () => {
  it('a hidden pairing collapses silently when a member dies (no navigation)', () => {
    setup();
    openSplitVia('1'); // (0|1); both now seen
    clickTab('2'); // hidden
    broadcast(['0', '2']); // member 1 killed elsewhere
    expect(active()).toBe('2');
    expect(panes()).toEqual([{ slot: 'a', session: '2', focused: false }]);
    expect(localStorage.getItem('palmux-splits')).toBeNull();
  });

  it('a shown pairing collapses to the survivor when the active member dies', () => {
    setup();
    openSplitVia('1'); // (0|1) focused b, on /1
    broadcast(['0', '2']); // member 1 killed
    expect(active()).toBe('0');
    expect(panes()).toEqual([{ slot: 'a', session: '0', focused: false }]);
  });

  it('a fresh self-split slot survives broadcasts even when its id recycles a killed one', () => {
    setup(['0', '1', '2']);
    broadcast(['0', '2']); // terminal 1 killed → '1' is in seenTermIds
    openSplitVia('0'); // self-split → fresh terminal gets nextFreeId = '1'
    expect(panes().map((p) => p.session)).toEqual(['0', '1']);
    broadcast(['0', '2']); // title-change-style broadcast BEFORE '1' spawns
    // Without the seenTermIds.delete fix this collapsed the split instantly.
    expect(panes().map((p) => p.session)).toEqual(['0', '1']);
  });

  it('tabCreated colliding with a stale never-seen member drops the dead pairing', () => {
    // Persisted pairing (0|5) where 5 died while the browser was closed.
    localStorage.setItem(
      'palmux-split',
      JSON.stringify({
        a: { tabId: '0', kind: 'terminal' },
        b: { tabId: '5', kind: 'terminal' },
        orientation: 'row',
        ratio: 0.5,
        focused: 'a',
      }),
    );
    setup(['0', '1']); // '5' never seen this session → kept as "fresh"
    send({ type: 'tabCreated', id: '5' }); // server recycles id 5
    expect(active()).toBe('5');
    expect(panes()).toEqual([{ slot: 'a', session: '5', focused: false }]); // NOT tiled
    expect(localStorage.getItem('palmux-splits')).toBeNull();
  });
});

describe('strip reorder (Chrome-like, supersedes drop-to-strip collapse)', () => {
  const stripOrder = () =>
    [...document.querySelectorAll('[data-testid^="session-tab-"]')].map((e) =>
      (e as HTMLElement).dataset['testid']!.replace('session-tab-', ''),
    );

  it('applies the reorder optimistically and sends the full order', () => {
    setup(); // tabs 0,1,2
    const t = dt();
    fireEvent.dragStart(screen.getByTestId('session-tab-2'), { dataTransfer: t });
    t.setData(TAB_DND_TYPE, '2');
    // happy-dom rects/coords are zero → every tab dragOver lands "after" it;
    // over tab 0 that's insertion index 1. (The left-half branch is e2e-only.)
    fireEvent.dragOver(screen.getByTestId('session-tab-0'), { dataTransfer: t });
    fireEvent.drop(screen.getByTestId('session-tabs'), { dataTransfer: t });
    expect(stripOrder()).toEqual(['0', '2', '1']); // optimistic, pre-broadcast
    expect(server().reorders.at(-1)).toEqual(['0', '2', '1']);
    // The authoritative broadcast (any order) then wins:
    broadcast(['2', '0', '1']);
    expect(stripOrder()).toEqual(['2', '0', '1']);
  });

  it('reordering a fused member moves the whole block, never collapsing the split', () => {
    setup();
    openSplitVia('1'); // (0|1) shown, on /1 — fused in the strip
    const t = dt();
    // Dragging the fused button carries its slot-A id; both members move together.
    fireEvent.dragStart(screen.getByTestId('fused-tab-0-1'), { dataTransfer: t });
    t.setData(TAB_DND_TYPE, '0');
    fireEvent.dragOver(screen.getByTestId('session-tab-2'), { dataTransfer: t }); // → after 2
    fireEvent.drop(screen.getByTestId('session-tabs'), { dataTransfer: t });
    // The block [0,1] lands after 2 (still adjacent, still fused) → split intact.
    expect(server().reorders.at(-1)).toEqual(['2', '0', '1']);
    expect(screen.getByTestId('fused-tab-0-1')).toBeTruthy();
    expect(panes()).toHaveLength(2); // split still tiled
    expect(active()).toBe('1');
    expect(localStorage.getItem('palmux-splits')).toContain('"tabId":"0"');
  });

  it('a no-op drop sends nothing', () => {
    setup();
    const t = dt();
    fireEvent.dragStart(screen.getByTestId('session-tab-1'), { dataTransfer: t });
    t.setData(TAB_DND_TYPE, '1');
    // Right half of tab 1 itself → index 2 → identity for id '1'.
    fireEvent.dragOver(screen.getByTestId('session-tab-1'), { dataTransfer: t, clientX: 10 });
    fireEvent.drop(screen.getByTestId('session-tabs'), { dataTransfer: t });
    expect(server().reorders).toHaveLength(0);
    expect(stripOrder()).toEqual(['0', '1', '2']);
  });
});

describe('close-tab navigation (no Reconnect page)', () => {
  const stripIds = () =>
    [...document.querySelectorAll('[data-testid^="session-tab-"]')].map((e) =>
      (e as HTMLElement).dataset['testid']!.replace('session-tab-', ''),
    );

  it('closing the active tab goes to its LEFT strip neighbor', () => {
    setup(['0', '1', '2']);
    clickTab('1');
    expect(active()).toBe('1');
    broadcast(['0', '2']); // tab 1 killed
    expect(active()).toBe('0');
    expect(panes()).toEqual([{ slot: 'a', session: '0', focused: false }]);
  });

  it('the leftmost tab falls back to its RIGHT neighbor', () => {
    setup(['0', '1', '2']); // current '0'
    broadcast(['1', '2']);
    expect(active()).toBe('1');
  });

  it('neighbors follow DISPLAY order, not numeric ids', () => {
    setup(['2', '0', '1']); // reordered strip; current '0' (middle)
    broadcast(['2', '1']);
    expect(active()).toBe('2'); // left in the strip, not id-sorted
  });

  it('closing the LAST tab shows the New-tab page (no pane, no ghost tab)', () => {
    setup(['0']);
    broadcast([]);
    expect(screen.getByTestId('newtab-page')).toBeTruthy();
    expect(screen.getByTestId('dash-new-terminal')).toBeTruthy(); // actual page content
    expect(panes()).toEqual([]); // nothing mounted → nothing respawns
    expect(stripIds()).toEqual([]); // no ghost strip entry
    // Creating from the page leaves it:
    tapPress(screen.getByTestId('dash-new-terminal'));
    expect(screen.queryByTestId('newtab-page')).toBeNull();
    expect(panes()).toHaveLength(1);
  });

  // The chooser now has TWO hosts (the page and the dock view), and the page
  // exists precisely because a mounted pane would re-attach `/ws?session=<dead
  // id>` and spawn a fresh shell on the id that was just closed. Reaching the
  // form the other way must not undo that.
  //
  // "No shell" is asserted as: no pane mounted (a pane is the only thing that
  // opens a data socket) AND no extra WsClient constructed beyond the control
  // socket. TerminalPane is stubbed here, so the mount check is the load-bearing
  // one; the socket count catches an App-level attach.
  it('the New-tab page spawns nothing, and opening the dock view keeps it that way', () => {
    setup(['0']);
    const socketsBefore = sockets.length;

    broadcast([]); // the last tab closes
    expect(screen.getByTestId('newtab-page')).toBeTruthy();
    expect(screen.getByTestId('dash-new-terminal')).toBeTruthy(); // the form itself
    expect(panes()).toEqual([]);
    expect(sockets).toHaveLength(socketsBefore);

    fireEvent.click(screen.getByTestId('dock-rail-newtab'));
    expect(screen.getByTestId('dock')).toHaveAttribute('data-view', 'newtab'); // it opened
    expect(panes()).toEqual([]);
    expect(sockets).toHaveLength(socketsBefore);
    expect(screen.getByTestId('newtab-page')).toBeTruthy();
  });

  it('a FRESH terminal missing from a broadcast is not treated as closed', () => {
    setup(['0', '1']);
    send({ type: 'tabCreated', id: '7' }); // navigated to 7, never in a broadcast
    expect(active()).toBe('7');
    broadcast(['0', '1']); // title-debounce style broadcast without 7
    expect(active()).toBe('7'); // still there — attach will spawn it
  });
});

// The chooser opens in this device's CONTAINER, never a floating box. It was a
// popover anchored at [+], which on mobile anchored to a button that does not
// exist (there is no strip) and fell back to a box in the corner.
describe('[+] opens the container', () => {
  it('opens the dock on its New-tab view, leaving the terminal mounted', () => {
    setup();
    fireEvent.pointerDown(screen.getByTestId('session-new'), { button: 0 });

    expect(screen.getByTestId('dock')).toHaveAttribute('data-view', 'newtab');
    expect(screen.queryByTestId('newtab-popover')).toBeNull(); // the box is gone
    expect(panes()).toHaveLength(1); // the dock narrows the terminal, never covers it
  });

  // No outside-press dismissal any more: the dock is layout, so pressing the
  // terminal is just using the terminal.
  it('stays open when the terminal beside it is pressed', async () => {
    setup();
    fireEvent.pointerDown(screen.getByTestId('session-new'), { button: 0 });
    await act(() => new Promise((r) => setTimeout(r, 0)));

    fireEvent.pointerDown(screen.getByTestId('term-pane-a'));
    expect(screen.getByTestId('dock')).toHaveAttribute('data-view', 'newtab');
  });

  it('creating a terminal navigates and leaves the chooser', () => {
    setup(['0', '1']);
    fireEvent.pointerDown(screen.getByTestId('session-new'), { button: 0 });
    tapPress(screen.getByTestId('dash-new-terminal'));

    expect(active()).toBe('2');
    expect(screen.queryByTestId('dock')).toBeNull(); // the panel closed with it
  });
});

// ── Tab grouping (App wiring: group ops, collapse guard, auto-expand, drag) ──
const sendGroups = (
  tabs: Array<{ id: string; kind?: string; groupId?: string }>,
  groups: Array<{ id: string; color: string; name?: string }>,
) =>
  send({
    type: 'sessions',
    tabs: tabs.map((t) => ({ kind: 'terminal', ...t })),
    groups,
  });

describe('tab grouping', () => {
  it('menu "New group from this tab" sends groupCreate; "Add to" sends addIds', () => {
    setup(['0', '1', '2']);
    // group {1} exists; add 2 to it via the menu.
    sendGroups(
      [{ id: '0' }, { id: '1', groupId: 'gaa111' }, { id: '2' }],
      [{ id: 'gaa111', color: 'blue', name: 'proj' }],
    );
    fireEvent.contextMenu(screen.getByTestId('session-tab-0'));
    fireEvent.click(screen.getByTestId('menu-new-group'));
    expect(server().groupCreates).toContainEqual({ ids: ['0'] });

    fireEvent.contextMenu(screen.getByTestId('session-tab-2'));
    fireEvent.click(screen.getByTestId('menu-add-to-gaa111'));
    // Pull-in order: 2 lands right after the group's last member (1), so the
    // group's block stays put instead of jumping to 2's old spot.
    expect(server().groupUpdates).toContainEqual({
      id: 'gaa111',
      addIds: ['2'],
      order: ['0', '1', '2'],
    });
  });

  it('adding a tab LEFT of the group pulls it in without moving the block', () => {
    setup(['0', '1', '2', '3']);
    // Group {2,3}; add tab 0 (to the LEFT). Chrome pulls 0 to the group.
    sendGroups(
      [{ id: '0' }, { id: '1' }, { id: '2', groupId: 'gbb222' }, { id: '3', groupId: 'gbb222' }],
      [{ id: 'gbb222', color: 'teal' }],
    );
    fireEvent.contextMenu(screen.getByTestId('session-tab-0'));
    fireEvent.click(screen.getByTestId('menu-add-to-gbb222'));
    // 0 lands after the last member (3): [1,2,3,0] — group block did NOT jump to 0.
    expect(server().groupUpdates).toContainEqual({
      id: 'gbb222',
      addIds: ['0'],
      order: ['1', '2', '3', '0'],
    });
  });

  it('chip menu ungroups (dissolve) and close-all kills every member behind a confirm', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    setup(['0', '1', '2']);
    sendGroups(
      [{ id: '0', groupId: 'gaa111' }, { id: '1', groupId: 'gaa111' }, { id: '2' }],
      [{ id: 'gaa111', color: 'blue' }],
    );
    fireEvent.contextMenu(screen.getByTestId('group-chip-gaa111'));
    fireEvent.click(screen.getByTestId('group-menu-ungroup'));
    expect(server().groupUpdates).toContainEqual({ id: 'gaa111', dissolve: true });

    fireEvent.contextMenu(screen.getByTestId('group-chip-gaa111'));
    fireEvent.click(screen.getByTestId('group-menu-close-all'));
    expect(server().killed).toEqual(expect.arrayContaining(['0', '1']));
    confirm.mockRestore();
  });

  it('collapsing a group holding the active tab first navigates to an outside tab', () => {
    setup(['0', '1', '2']);
    sendGroups(
      [{ id: '0', groupId: 'gaa111' }, { id: '1', groupId: 'gaa111' }, { id: '2' }],
      [{ id: 'gaa111', color: 'blue' }],
    );
    clickTab('0'); // active tab is a member
    fireEvent.click(screen.getByTestId('group-chip-gaa111')); // collapse
    // Navigated OUT to the nearest non-member (tab 2 — the after-span neighbor).
    expect(active()).toBe('2');
    // Members are now hidden (collapsed), chip stays with a count.
    expect(screen.queryByTestId('session-tab-0')).toBeNull();
    expect(screen.getByTestId('group-count-gaa111')).toHaveTextContent('2');
  });

  it('refuses to collapse a group that IS the whole strip (toast, stays expanded)', () => {
    setup(['0', '1']);
    sendGroups(
      [
        { id: '0', groupId: 'gaa111' },
        { id: '1', groupId: 'gaa111' },
      ],
      [{ id: 'gaa111', color: 'blue' }],
    );
    fireEvent.click(screen.getByTestId('group-chip-gaa111'));
    expect(screen.getByText("Can't collapse the only group")).toBeTruthy();
    expect(screen.getByTestId('session-tab-0')).toBeTruthy(); // still visible
  });

  it('centralized auto-expand fires on a close-nav setSessionId (bypasses selectTab)', () => {
    setup(['0', '1', '2']);
    sendGroups(
      [{ id: '0', groupId: 'gaa111' }, { id: '1', groupId: 'gaa111' }, { id: '2' }],
      [{ id: 'gaa111', color: 'blue' }],
    );
    clickTab('2'); // active outside the group
    fireEvent.click(screen.getByTestId('group-chip-gaa111')); // collapse (2 is outside)
    expect(screen.queryByTestId('session-tab-1')).toBeNull(); // members hidden
    // Kill tab 2 via a broadcast omitting it → close-nav lands on member '1'
    // (setSessionId directly, NOT selectTab). Auto-expand must re-open the group.
    sendGroups(
      [
        { id: '0', groupId: 'gaa111' },
        { id: '1', groupId: 'gaa111' },
      ],
      [{ id: 'gaa111', color: 'blue' }],
    );
    expect(active()).toBe('1');
    expect(screen.getByTestId('session-tab-1')).toBeTruthy(); // re-expanded
  });

  it('dragging a member fully out of its group sends a LEAVE (removeIds + order)', () => {
    setup(['0', '1', '2']);
    sendGroups(
      [{ id: '0', groupId: 'gaa111' }, { id: '1', groupId: 'gaa111' }, { id: '2' }],
      [{ id: 'gaa111', color: 'blue' }],
    );
    const strip = screen.getByTestId('session-tabs');
    const t = dt();
    fireEvent.dragStart(screen.getByTestId('session-tab-0'), { dataTransfer: t });
    t.setData(TAB_DND_TYPE, '0');
    fireEvent.dragOver(strip, { dataTransfer: t }); // trailing → index = length
    fireEvent.drop(strip, { dataTransfer: t });
    expect(server().groupUpdates).toContainEqual({
      id: 'gaa111',
      removeIds: ['0'],
      order: ['1', '2', '0'],
    });
  });

  it('a center-drop onto a member sends a JOIN (addIds + order)', () => {
    setup(['0', '1', '2']);
    sendGroups(
      [{ id: '0', groupId: 'gaa111' }, { id: '1', groupId: 'gaa111' }, { id: '2' }],
      [{ id: 'gaa111', color: 'blue' }],
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      width: 100,
      right: 100,
      top: 0,
      bottom: 30,
      height: 30,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const strip = screen.getByTestId('session-tabs');
    const t = dt();
    fireEvent.dragStart(screen.getByTestId('session-tab-2'), { dataTransfer: t });
    t.setData(TAB_DND_TYPE, '2');
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    Object.assign(over, { dataTransfer: t, clientX: 50 }); // center of tab 0
    fireEvent(screen.getByTestId('session-tab-0'), over);
    fireEvent.drop(strip, { dataTransfer: t });
    const join = server().groupUpdates.find((u) => 'addIds' in u);
    expect(join).toMatchObject({ id: 'gaa111', addIds: ['2'] });
    vi.restoreAllMocks();
  });

  it('a drop index is resolved against the VISIBLE list when a group is collapsed', () => {
    setup(['0', '1', '2', '3']);
    // Group {0,1} at the front. Move active outside it, then collapse (hide 0,1).
    sendGroups(
      [{ id: '0', groupId: 'gaa111' }, { id: '1', groupId: 'gaa111' }, { id: '2' }, { id: '3' }],
      [{ id: 'gaa111', color: 'blue' }],
    );
    clickTab('3'); // active outside the group
    fireEvent.click(screen.getByTestId('group-chip-gaa111')); // collapse
    // Visible strip is now [chip, 2, 3]. Drag 2 to the trailing area (append).
    const t = dt();
    fireEvent.dragStart(screen.getByTestId('session-tab-2'), { dataTransfer: t });
    t.setData(TAB_DND_TYPE, '2');
    fireEvent.dragOver(screen.getByTestId('session-tabs'), { dataTransfer: t }); // trailing → end
    fireEvent.drop(screen.getByTestId('session-tabs'), { dataTransfer: t });
    // Full order must be [0,1,3,2] — 2 appended AFTER the hidden members. A raw
    // visible-index-on-full-list would have produced a no-op (index 2 == '2').
    expect(server().reorders.at(-1)).toEqual(['0', '1', '3', '2']);
  });

  it("a broadcast diverging paired members' group membership dissolves the pairing", () => {
    setup(['0', '1', '2']);
    openSplitVia('1'); // split (0|1) shown, active 1
    // A fused pair requires shared membership. A broadcast putting ONLY 0 into a
    // group breaks that → the pairing dissolves; the active member goes full-width.
    sendGroups(
      [{ id: '0', groupId: 'gaa111' }, { id: '1' }, { id: '2' }],
      [{ id: 'gaa111', color: 'blue' }],
    );
    expect(panes()).toEqual([{ slot: 'a', session: '0', focused: false }]);
    expect(active()).toBe('0');
    expect(localStorage.getItem('palmux-splits')).toBeNull();
  });
});

describe('self-update client notice', () => {
  it('shows a persistent banner while updating, and clears it when a server is ready again', () => {
    setup();
    expect(screen.queryByTestId('update-banner')).toBeNull();

    send({ type: 'updating', stage: 'staging', version: '9.9.0' });
    expect(screen.getByTestId('update-banner')).toHaveTextContent('Updating to 9.9.0');

    // The socket drops and reconnects to the SUCCESSOR — the banner must have
    // survived that gap, which is the entire point of it not being a toast.
    send({ type: 'updating', stage: 'restarting', version: '9.9.0' });
    expect(screen.getByTestId('update-banner')).toHaveTextContent('reconnecting');

    send({ type: 'ready', maxUploadBytes: 1024, webApps: [], version: '9.9.0' });
    expect(screen.queryByTestId('update-banner')).toBeNull();
  });

  it('does not leave a banner up when the update fails', () => {
    setup();
    send({ type: 'updating', stage: 'staging', version: '9.9.0' });
    send({ type: 'updating', stage: 'failed', version: '9.9.0' });
    expect(screen.queryByTestId('update-banner')).toBeNull();
  });
});

// ── The address stops being the workspace ─────────────────────────────────────
//
// Switching tabs used to `pushState('/<id>')`, which made every switch a browser
// NAVIGATION — so a web pane's ← walked the same stack the strip wrote into and
// could undo a tab switch instead of moving the framed page, with nothing on
// screen to say which. These pin the removal, because a stray pushState
// reintroduces the ambiguity silently: every other assertion still passes.
describe('the URL is not the workspace', () => {
  it('never changes the address, and never grows history', () => {
    setup();
    const before = history.length;
    clickTab('1');
    clickTab('2');
    clickTab('0');
    expect(location.pathname).toBe('/');
    expect(history.length).toBe(before);
    expect(active()).toBe('0');
  });

  it('keeps the address at / while splitting and ejecting', () => {
    setup();
    openSplitVia('1');
    expect(location.pathname).toBe('/');
    clickTab('2');
    expect(location.pathname).toBe('/');
  });
});

// Reported from a phone as "text select closes the terminal". Nothing closes:
// starting a selection blurs #mobile-kbd, Android takes the IME with it, and
// nothing brought it back — leaving a terminal you cannot type into, which is
// indistinguishable from a dead one. Measured: the pane element and its socket
// both survive; only `document.activeElement` moves to BODY.
describe('restoring the keyboard after a native text selection', () => {
  const KEYBOARD_H = 300; // roughly what an IME costs on a phone

  it('restores when the keyboard was up — the viewport springs back open', () => {
    expect(shouldRestoreKeyboard(true, 844, 844 - KEYBOARD_H)).toBe(true);
  });

  // The gate that matters most. Selecting text while READING must not hand the
  // user a keyboard they never asked for, and focus cannot tell the two cases
  // apart because a selection blurs the textarea either way.
  it('does nothing when the keyboard was never up — the viewport never moved', () => {
    expect(shouldRestoreKeyboard(true, 844, 844)).toBe(false);
  });

  // An ordinary dismissal (tapping the terminal to put the keyboard away) also
  // grows the viewport. Without `deferred` the app would fight the user and
  // re-raise it every time.
  it('does nothing for a keyboard dismissal that no selection deferred', () => {
    expect(shouldRestoreKeyboard(false, 844, 844 - KEYBOARD_H)).toBe(false);
  });

  it('ignores growth too small to be an IME', () => {
    expect(shouldRestoreKeyboard(true, 844, 844 - 100)).toBe(false);
    expect(shouldRestoreKeyboard(true, 844, 844 - 101)).toBe(true);
  });
});
