// App-level split model integration: the Chrome-like display scoping wired
// through the REAL App (selectTab / doDropSlot / eject / tabCreated / [+]),
// with the heavy leaves mocked at their seams — WsClient (we play the server),
// TerminalPane (a stub div carrying slot/session/focus), PaneHost. These pin
// the change's headline invariants: selection/creation NEVER replaces a slot,
// exactly two slots ever, eject keeps the other tab, hidden pairings stay put.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRef, useEffect, type ComponentProps } from 'react';
import { flushSync } from 'react-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { App, shouldRestoreKeyboard, type DrawerCloseOptions } from './App';
import { GROUP_DND_TYPE, TAB_DND_TYPE } from './session/SessionTabs';
import type { SessionDrawer as SessionDrawerComponent } from './session/SessionDrawer';
import type { DrawerDrop } from './session/drawer-tree';
import type { PaneApi, SlotId, SplitRegistry } from './session/SplitFocusContext';
import { useFileUpload } from './terminal/useFileUpload';
import { Icon } from './ui/icons';
import { DEFAULTS } from './settings/settings';
import { allProfiles, deriveUiTokens, hex } from './settings/themes';

// The chooser's controls activate on pointer UP (with a movement check) so a
// finger can scroll past them; a press is therefore down THEN up.
const tapPress = (el: Element) => {
  fireEvent.pointerDown(el, { button: 0 });
  fireEvent.pointerUp(el, { button: 0 });
};

/** Press Tab (or Shift+Tab) until `el` holds focus: the keyboard's own way there. */
const tabTo = async (el: HTMLElement, shift = false): Promise<void> => {
  const user = userEvent.setup();
  // oxlint-disable-next-line no-await-in-loop -- each Tab starts where the last one left focus
  for (let i = 0; i < 200 && document.activeElement !== el; i++) await user.tab({ shift });
  expect(document.activeElement).toBe(el);
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

// A pane that registers a PaneApi whose pickers are the REAL `useFileUpload` ones, so
// a test drives the picker's hidden input and the window's focus exactly as the
// browser would. Off by default: the registry then holds no pane, as it always did.
const paneApiFake = vi.hoisted(() => ({
  enabled: false,
  /** What the pickers reported launching: false plays an input that is unavailable. */
  launches: true,
  /** How many times the layout asked the pane to re-fit: each one is a SIGWINCH risk. */
  refits: 0,
}));
const UploadingPaneApi = (p: { registry: SplitRegistry; slot: SlotId; sessionId: string }) => {
  const { openPicker, openImagePicker } = useFileUpload({
    sendToPty: () => true,
    sessionId: p.sessionId,
    maxBytes: 0,
    wrapRef: createRef<HTMLElement>(),
  });
  useEffect(() => {
    const noop = () => {};
    const api: PaneApi = {
      sendInput: () => true,
      paste: () => true,
      pasteImage: noop,
      openPicker: (onReturn) => (paneApiFake.launches ? openPicker(onReturn) : false),
      openImagePicker: (onReturn) => (paneApiFake.launches ? openImagePicker(onReturn) : false),
      focus: noop,
      blur: noop,
      refit: () => void paneApiFake.refits++,
      refreshFont: noop,
      refreshTheme: noop,
      exportScrollback: () => null,
      copyLastOutput: () => null,
      openSearch: noop,
      term: () => null,
      container: () => null,
    };
    return p.registry.register(p.slot, api);
  }, [p.registry, p.slot, openPicker, openImagePicker]);
  return null;
};

// TerminalPane stub: enough surface for the layout/focus assertions, plus the
// real pane's mousedown→onFocusRequest wiring (pins the hidden-pairing guard).
vi.mock('./terminal/TerminalPane', () => ({
  TerminalPane: (p: {
    slot: SlotId;
    sessionId: string;
    focused: boolean;
    inSplit: boolean;
    registry: SplitRegistry;
    onFocusRequest: (slot: string) => void;
  }) => (
    <div
      data-testid={`term-pane-${p.slot}`}
      data-session={p.sessionId}
      className={p.inSplit ? `slot${p.focused ? ' focused' : ''}` : ''}
      onMouseDown={() => p.onFocusRequest(p.slot as never)}
    >
      {paneApiFake.enabled && (
        <UploadingPaneApi registry={p.registry} slot={p.slot} sessionId={p.sessionId} />
      )}
    </div>
  ),
}));

// The real drawer, with its props kept so a test can press what the drawer's UI
// would: `onClose({holdUntil: 'picker'})`, the footer actions, the tree drops.
type DrawerProps = Omit<ComponentProps<typeof SessionDrawerComponent>, 'onClose'> & {
  onClose: (opts?: DrawerCloseOptions) => void;
  onMoveTab?: (id: string, drop: DrawerDrop) => void;
  onMoveGroup?: (gid: string, drop: DrawerDrop) => void;
};
const drawerSpy = vi.hoisted(() => ({ props: null as unknown }));
vi.mock('./session/SessionDrawer', async (orig) => {
  const real = await orig<typeof import('./session/SessionDrawer')>();
  return {
    ...real,
    SessionDrawer: (p: ComponentProps<typeof real.SessionDrawer>) => {
      drawerSpy.props = p;
      return <real.SessionDrawer {...p} />;
    },
  };
});
/** The height the app is pinned to, as the viewport effect last wrote it. */
const appHeight = () => document.documentElement.style.getPropertyValue('--app-height');
const keyboardTextarea = () => document.getElementById('mobile-kbd') as HTMLTextAreaElement;
const drawerIsOpen = () => screen.getByTestId('drawer').classList.contains('open');
const setVisibility = (state: 'visible' | 'hidden') =>
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
const pickerInput = (testId = 'upload-input') =>
  document.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement;
/** The drawer's props as of the last render. */
const drawer = (): DrawerProps => {
  if (!drawerSpy.props) throw new Error('the drawer has not rendered');
  return drawerSpy.props as DrawerProps;
};

const nativeSel = vi.hoisted(() => ({ live: false }));
vi.mock('./mobile/native-selection', async (orig) => ({
  ...(await orig<typeof import('./mobile/native-selection')>()),
  hasNativeSelection: () => nativeSel.live,
}));
// PaneHost reports an editor's dirty state through `onDirtyChange`; the stub keeps
// the latest one so a test can play the pane that has unsaved text.
const paneHost = vi.hoisted(() => ({
  onDirtyChange: null as null | ((id: string, dirty: boolean) => void),
  /** The ☰ the web/editor/markdown panes show on a phone, where there is no strip. */
  onMenu: undefined as undefined | (() => void),
}));
vi.mock('./panes/PaneHost', () => ({
  PaneHost: (p: { onDirtyChange: (id: string, dirty: boolean) => void; onMenu?: () => void }) => {
    paneHost.onDirtyChange = p.onDirtyChange;
    paneHost.onMenu = p.onMenu;
    return <div data-testid="pane-host" />;
  },
}));

// Settings' raw config.json editor is Monaco, behind the lazy loader. The fake
// keeps the content listeners so a test can play someone typing into it — the
// real chunk is 3.7 MB and has no business in a happy-dom run.
const monacoFake = vi.hoisted(() => {
  const state = { value: '', listeners: [] as Array<() => void> };
  const model = {
    onDidChangeContent: (cb: () => void) => state.listeners.push(cb),
    getLineMaxColumn: () => 1,
    getLineCount: () => 1,
  };
  const editor = {
    getModel: () => model,
    getValue: () => state.value,
    updateOptions: () => {},
    onDidFocusEditorText: () => {},
    trigger: () => {},
    focus: () => {},
    layout: () => {},
    dispose: () => {},
  };
  const monaco = {
    editor: {
      create: (_host: unknown, opts: { value: string }) => {
        state.value = opts.value;
        state.listeners = [];
        return editor;
      },
      setModelMarkers: () => {},
    },
    languages: {
      register: () => {},
      setMonarchTokensProvider: () => {},
      setLanguageConfiguration: () => {},
    },
    MarkerSeverity: { Error: 8 },
  };
  const type = (text: string) => {
    state.value = text;
    state.listeners.forEach((cb) => cb());
  };
  return { monaco, type };
});
vi.mock('./panes/monaco-loader', () => ({ getMonaco: () => monacoFake.monaco }));

// Reload is the one thing here that would navigate the test page away.
const { reloadApp } = vi.hoisted(() => ({ reloadApp: vi.fn(() => Promise.resolve()) }));
vi.mock('./settings/app-reload', async (orig) => ({
  ...(await orig<typeof import('./settings/app-reload')>()),
  reloadApp,
}));

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

/** The drawn shapes of a registered icon, to compare against what a control
 *  rendered. Rendered into a detached node so `screen` never sees it. */
const iconPaths = (name: string): string | undefined => {
  const host = document.createElement('div');
  render(<Icon name={name} />, { container: host });
  return host.querySelector('svg')?.innerHTML;
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

  // The ⏏ character is the eject icon now. The icon is aria-hidden and the button
  // has no text, so its aria-label is the whole accessible name.
  it('draws the eject control as the eject icon and keeps it named', () => {
    setup();
    openSplitVia('1');
    for (const [slot, name] of [
      ['a', 'Remove the first tab from the split'],
      ['b', 'Remove the second tab from the split'],
    ] as const) {
      const eject = screen.getByTestId(`slot-eject-${slot}`);
      expect(eject.textContent).toBe('');
      expect(eject.querySelectorAll('svg')).toHaveLength(1);
      expect(eject.querySelector('svg')?.innerHTML).toBe(iconPaths('eject'));
      expect(eject).toHaveAttribute('aria-label', name);
      expect(eject).toHaveAttribute('title', 'Remove from split');
    }
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

  // A broadcast only queues its list. A drop landing before it renders used to
  // rebuild the strip from the list on screen, so the tab it brought vanished.
  it('keeps the tab a broadcast brought when a drop lands before it renders', () => {
    setup();
    const t = dt();
    fireEvent.dragStart(screen.getByTestId('session-tab-2'), { dataTransfer: t });
    t.setData(TAB_DND_TYPE, '2');
    fireEvent.dragOver(screen.getByTestId('session-tab-0'), { dataTransfer: t });
    act(() => {
      server().handler!({
        type: 'sessions',
        tabs: ['0', '1', '2', '3'].map((id) => ({ id, kind: 'terminal' })),
      });
      fireEvent.drop(screen.getByTestId('session-tabs'), { dataTransfer: t });
    });
    expect(server().reorders.at(-1)).toEqual(['0', '2', '1', '3']);
    expect(stripOrder()).toEqual(['0', '2', '1', '3']);
  });

  // A split's partner is moved next to its anchor with no broadcast to follow
  // until the server answers, and a drop in that gap is resolved against the
  // order the move made, not the one before it.
  it('a drop after a split moved its partner is resolved against the moved order', () => {
    setup(['0', '1', '2', '3']);
    openSplitVia('2'); // (0|2): 2 moves next to 0
    expect(server().reorders.at(-1)).toEqual(['0', '2', '1', '3']);
    const t = dt();
    fireEvent.dragStart(screen.getByTestId('session-tab-3'), { dataTransfer: t });
    t.setData(TAB_DND_TYPE, '3');
    fireEvent.dragOver(screen.getByTestId('fused-tab-0-2'), { dataTransfer: t }); // → after the pair
    fireEvent.drop(screen.getByTestId('session-tabs'), { dataTransfer: t });
    expect(server().reorders.at(-1)).toEqual(['0', '2', '3', '1']);
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

  // A broadcast moves the tab snapshot at once, but its navigation only QUEUES
  // `setSessionId`. A second broadcast before that renders used to read the closed
  // tab against a list that no longer held it, and the neighbour rule's fallback
  // for a missing id sent the window to the FIRST tab instead.
  describe('two broadcasts before the close-navigation renders', () => {
    const terms = (ids: string[]) => ids.map((id) => ({ id, kind: 'terminal' }));

    it('the second one decides from the tab the first one chose', () => {
      setup(['0', '1', '2']);
      clickTab('2');
      expect(active()).toBe('2');
      act(() => {
        server().handler!({ type: 'sessions', tabs: terms(['0', '1']) }); // 2 closed → 1
        server().handler!({ type: 'sessions', tabs: terms(['0', '1']) });
      });
      expect(active()).toBe('1');
    });

    // A click renders ahead of a socket message, so a render can run that leaves
    // the queued navigation out. That render must not hand the next broadcast the
    // selection it drew: the snapshot is written by what navigates, never by a
    // render. `flushSync` is that render; opening a dock view is App state.
    it('a render that left the navigation out does not move the selection back', () => {
      setup(['0', '1', '2']);
      clickTab('2');
      act(() => {
        server().handler!({ type: 'sessions', tabs: terms(['0', '1']) });
        flushSync(() => fireEvent.click(screen.getByTestId('dock-rail-newtab')));
        server().handler!({ type: 'sessions', tabs: terms(['0', '1']) });
      });
      expect(active()).toBe('1');
    });
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

// Which elements carry the strip's insertion marker right now, as `testid:side`.
const marked = () =>
  [...document.querySelectorAll('.drop-before, .drop-after')].map(
    (e) =>
      `${(e as HTMLElement).dataset['testid']}:${e.classList.contains('drop-before') ? 'before' : 'after'}`,
  );
// The tab pills a group's frame encloses, in strip order.
const framed = (gid: string) =>
  [
    ...screen.getByTestId(`group-cluster-${gid}`).querySelectorAll('[data-testid^="session-tab-"]'),
  ].map((e) => (e as HTMLElement).dataset['testid']!.replace('session-tab-', ''));

// ── Where a drop lands around groups and in the strip's gaps (R1 + R3) ──────────
//
// Through the REAL App: SessionTabs resolves the boundary from pointer x and
// doReorder/moveGroup turn it into an order. happy-dom has no layout, so each
// strip unit (pill, fused pill, chip — in strip order) is handed a rect.
describe('strip drops around groups and in gaps', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const layout = (spans: [number, number][]) => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        const [left, right] = spans[
          [...document.querySelectorAll('.ctab, .group-chip')].indexOf(this)
        ] ?? [0, 0];
        return {
          left,
          right,
          width: right - left,
          top: 0,
          bottom: 28,
          height: 28,
          x: left,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      },
    );
  };
  const dtOf = (type: string) => {
    let data = '';
    return {
      types: [type],
      setData: (_t: string, v: string) => {
        data = v;
      },
      getData: () => data,
      effectAllowed: '',
      dropEffect: '',
    };
  };
  const overAt = (el: Element, dataTransfer: unknown, clientX: number) => {
    const ev = new Event('dragover', { bubbles: true, cancelable: true });
    Object.assign(ev, { dataTransfer, clientX });
    fireEvent(el, ev);
  };
  /** Drag tab `id` over `over` at x, then drop it on the strip. */
  const dropTab = (id: string, over: Element, x: number) => {
    const t = dtOf(TAB_DND_TYPE);
    fireEvent.dragStart(screen.getByTestId(`session-tab-${id}`), { dataTransfer: t });
    overAt(over, t, x);
    fireEvent.drop(screen.getByTestId('session-tabs'), { dataTransfer: t });
  };
  const dropGroup = (gid: string, over: Element, x: number) => {
    const t = dtOf(GROUP_DND_TYPE);
    fireEvent.dragStart(screen.getByTestId(`group-chip-${gid}`), { dataTransfer: t });
    overAt(over, t, x);
    fireEvent.drop(screen.getByTestId('session-tabs'), { dataTransfer: t });
  };
  const lastOrder = () => server().reorders.at(-1);
  const chip = (gid: string) => screen.getByTestId(`group-chip-${gid}`);
  const strip = () => screen.getByTestId('session-tabs');
  const noGroupOps = () => expect(server().groupUpdates).toEqual([]);

  const G = { id: 'gaa111', color: 'blue', name: 'g' };
  const H = { id: 'gbb222', color: 'green', name: 'h' };
  const collapse = (...gids: string[]) => {
    for (const gid of gids) fireEvent.click(chip(gid)); // the active tab '0' is outside
  };
  // `[a, g1, g2, b, c]` = ids 0..4 with {1,2} grouped.
  const fiveWithGroup = () => {
    setup(['0', '1', '2', '3', '4']);
    sendGroups(
      [
        { id: '0' },
        { id: '1', groupId: G.id },
        { id: '2', groupId: G.id },
        { id: '3' },
        { id: '4' },
      ],
      [G],
    );
  };

  describe('a COLLAPSED group', () => {
    // strip: a [0,100] | chip [108,170] | b [178,278] | c [286,386]
    const spans: [number, number][] = [
      [0, 100],
      [108, 170],
      [178, 278],
      [286, 386],
    ];

    it('c dropped before the chip lands before the group, joining nothing', () => {
      fiveWithGroup();
      collapse(G.id);
      layout(spans);
      dropTab('4', chip(G.id), 120);
      expect(lastOrder()).toEqual(['0', '4', '1', '2', '3']);
      noGroupOps();
    });

    it('c dropped just after the chip lands after the group', () => {
      fiveWithGroup();
      collapse(G.id);
      layout(spans);
      dropTab('4', chip(G.id), 160);
      expect(lastOrder()).toEqual(['0', '1', '2', '4', '3']);
      noGroupOps();
    });

    it('previews the edge it commits to', () => {
      fiveWithGroup();
      collapse(G.id);
      layout(spans);
      const t = dtOf(TAB_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId('session-tab-4'), { dataTransfer: t });
      overAt(chip(G.id), t, 120);
      expect(screen.getByTestId(`group-cluster-${G.id}`).className).toContain('drop-before');
      expect(screen.getByTestId('session-tab-3').className).not.toContain('drop-before');
      overAt(chip(G.id), t, 160);
      expect(screen.getByTestId(`group-cluster-${G.id}`).className).not.toContain('drop-before');
      expect(screen.getByTestId('session-tab-3').className).toContain('drop-before');
    });

    // The pill just before a collapsed group had the same defect: its right half
    // is "before the group" but the index named the entry after it.
    it('the right half of the pill before the group is before the group too', () => {
      fiveWithGroup();
      collapse(G.id);
      layout(spans);
      dropTab('4', screen.getByTestId('session-tab-0'), 90);
      expect(lastOrder()).toEqual(['0', '4', '1', '2', '3']);
    });

    // A fused pairing moves as ONE block, and doReorder bails on a drop "onto
    // itself". With the group collapsed the entry index after "before the chip"
    // names the pairing's own first member, so without the anchor this drop was
    // swallowed as a no-op and the pair never moved.
    it('a fused pair dropped before the chip moves past the group, split intact', () => {
      // order [4, g1, g2, 0, 1, 5] with {2,3} grouped; (0|1) split → fused in the strip
      setup(['4', '2', '3', '0', '1', '5']);
      sendGroups(
        [
          { id: '4' },
          { id: '2', groupId: G.id },
          { id: '3', groupId: G.id },
          { id: '0' },
          { id: '1' },
          { id: '5' },
        ],
        [G],
      );
      openSplitVia('1');
      collapse(G.id);
      expect(screen.getByTestId('fused-tab-0-1')).toBeTruthy();
      // strip: 4 [0,100] | chip G [108,170] | fused(0,1) [178,478] | 5 [486,586]
      layout([
        [0, 100],
        [108, 170],
        [178, 478],
        [486, 586],
      ]);
      const t = dtOf(TAB_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId('fused-tab-0-1'), { dataTransfer: t });
      overAt(chip(G.id), t, 120); // left half: before the group
      expect(screen.getByTestId(`group-cluster-${G.id}`).className).toContain('drop-before');
      fireEvent.drop(strip(), { dataTransfer: t });
      expect(lastOrder()).toEqual(['4', '0', '1', '2', '3', '5']);
      noGroupOps();
      expect(screen.getByTestId('fused-tab-0-1')).toBeTruthy();
      expect(panes()).toHaveLength(2); // still tiled
    });

    describe('two adjacent', () => {
      // ids 0..5 = [a, g1, g2, h1, h2, b]; strip: a | chip G | chip H | b
      const sixWithTwoGroups = () => {
        setup(['0', '1', '2', '3', '4', '5']);
        sendGroups(
          [
            { id: '0' },
            { id: '1', groupId: G.id },
            { id: '2', groupId: G.id },
            { id: '3', groupId: H.id },
            { id: '4', groupId: H.id },
            { id: '5' },
          ],
          [G, H],
        );
        collapse(G.id, H.id);
        layout([
          [0, 100],
          [108, 170],
          [178, 240],
          [248, 348],
        ]);
      };

      it('b dropped between them lands between them', () => {
        sixWithTwoGroups();
        dropTab('5', chip(H.id), 190);
        expect(lastOrder()).toEqual(['0', '1', '2', '5', '3', '4']);
        noGroupOps();
      });

      it('b dropped before the first lands before it; after the last stays after', () => {
        sixWithTwoGroups();
        dropTab('5', chip(G.id), 120);
        expect(lastOrder()).toEqual(['0', '5', '1', '2', '3', '4']);
        noGroupOps();
      });
    });
  });

  describe('an EXPANDED group', () => {
    // strip: a | chip | g1 | g2 | b | c
    const spans: [number, number][] = [
      [0, 100],
      [108, 170],
      [178, 278],
      [286, 386],
      [400, 500],
      [508, 608],
    ];

    it('c dropped before the chip lands before the group, joining nothing', () => {
      fiveWithGroup();
      layout(spans);
      dropTab('4', chip(G.id), 120);
      expect(lastOrder()).toEqual(['0', '4', '1', '2', '3']);
      noGroupOps();
    });

    it('c dropped just after the last member lands after the group', () => {
      fiveWithGroup();
      layout(spans);
      dropTab('4', screen.getByTestId('session-tab-2'), 380);
      expect(lastOrder()).toEqual(['0', '1', '2', '4', '3']);
      noGroupOps();
    });

    it('b dropped between two adjacent groups lands between them', () => {
      setup(['0', '1', '2', '3', '4', '5']);
      sendGroups(
        [
          { id: '0' },
          { id: '1', groupId: G.id },
          { id: '2', groupId: G.id },
          { id: '3', groupId: H.id },
          { id: '4', groupId: H.id },
          { id: '5' },
        ],
        [G, H],
      );
      // a | chip G | g1 | g2 | chip H | h1 | h2 | b
      layout([
        [0, 100],
        [108, 170],
        [178, 278],
        [286, 386],
        [400, 462],
        [470, 570],
        [578, 678],
        [690, 790],
      ]);
      dropTab('5', chip(H.id), 410);
      expect(lastOrder()).toEqual(['0', '1', '2', '5', '3', '4']);
      noGroupOps();
    });
  });

  describe('moving a whole group', () => {
    // ids 0..5 with G={1,2} and H={3,4}, both collapsed: a | chip G | chip H | b
    const bothCollapsed = () => {
      setup(['0', '1', '2', '3', '4', '5']);
      sendGroups(
        [
          { id: '0' },
          { id: '1', groupId: G.id },
          { id: '2', groupId: G.id },
          { id: '3', groupId: H.id },
          { id: '4', groupId: H.id },
          { id: '5' },
        ],
        [G, H],
      );
      collapse(G.id, H.id);
      layout([
        [0, 100],
        [108, 170],
        [178, 240],
        [248, 348],
      ]);
    };

    it('dropped before a collapsed group lands before it', () => {
      bothCollapsed();
      dropGroup(H.id, chip(G.id), 120);
      expect(lastOrder()).toEqual(['0', '3', '4', '1', '2', '5']);
    });

    it('dropped after a collapsed group lands after it', () => {
      bothCollapsed();
      dropGroup(G.id, chip(H.id), 235);
      expect(lastOrder()).toEqual(['0', '3', '4', '1', '2', '5']);
    });

    it('dropped right where it already is sends nothing', () => {
      bothCollapsed();
      dropGroup(G.id, chip(H.id), 190); // before H, and G already is
      expect(server().reorders).toHaveLength(0);
    });

    // The same race as a tab's: a broadcast queued with a new tab, then the drop.
    it('keeps the tab a broadcast brought when the drop lands before it renders', () => {
      bothCollapsed();
      const t = dtOf(GROUP_DND_TYPE);
      fireEvent.dragStart(chip(G.id), { dataTransfer: t });
      overAt(chip(H.id), t, 235); // after H
      act(() => {
        server().handler!({
          type: 'sessions',
          tabs: [
            { id: '0' },
            { id: '1', groupId: G.id },
            { id: '2', groupId: G.id },
            { id: '3', groupId: H.id },
            { id: '4', groupId: H.id },
            { id: '5' },
            { id: '6' },
          ].map((tab) => ({ kind: 'terminal', ...tab })),
          groups: [G, H],
        });
        fireEvent.drop(strip(), { dataTransfer: t });
      });
      expect(lastOrder()).toEqual(['0', '3', '4', '1', '2', '5', '6']);
      expect(screen.getByTestId('session-tab-6')).toBeInTheDocument();
    });

    // R1 for a chip drag: a gap between two plain pills is a boundary between them.
    it('dropped in a gap between two pills lands there, not at the end', () => {
      fiveWithGroup();
      collapse(G.id);
      // strip: a [0,100] | chip G [108,170] | b [178,278] | c [286,386]
      layout([
        [0, 100],
        [108, 170],
        [178, 278],
        [286, 386],
      ]);
      dropGroup(G.id, strip(), 282); // between b and c
      expect(lastOrder()).toEqual(['0', '3', '1', '2', '4']);
    });
  });

  // "Before the group" is anchored to the GROUP, not to a tab. It used to be the
  // tab id of the group's first member, captured at hover time and checked only
  // for existence — so when another window moved that tab OUT of the group, the
  // drop followed the tab to wherever it went, and the preview vanished because
  // no cluster's first member matched it any more. Both the marker and the
  // commit re-resolve the group's CURRENT first member; a group that no longer
  // exists falls back to the numeric index the hover was computed from.
  describe('an anchor whose group changed mid-drag', () => {
    // [a, g1, g2, b, c] with G collapsed: a | chip G | b | c
    const fiveCollapsed = () => {
      fiveWithGroup();
      collapse(G.id);
      layout([
        [0, 100],
        [108, 170],
        [178, 278],
        [286, 386],
      ]);
    };
    // Hover tab 4 (c) over the chip's left half: before the group.
    const hoverBeforeG = () => {
      const t = dtOf(TAB_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId('session-tab-4'), { dataTransfer: t });
      overAt(chip(G.id), t, 120);
      expect(marked()).toEqual([`group-cluster-${G.id}:before`]);
      return t;
    };

    it('its first member moved out: still lands before the group, preview kept', () => {
      fiveCollapsed();
      const t = hoverBeforeG();
      // Elsewhere: g1 leaves G and moves past b → [a, g2, b, g1, c].
      sendGroups(
        [{ id: '0' }, { id: '2', groupId: G.id }, { id: '3' }, { id: '1' }, { id: '4' }],
        [G],
      );
      expect(marked()).toEqual([`group-cluster-${G.id}:before`]);
      fireEvent.drop(strip(), { dataTransfer: t });
      expect(lastOrder()).toEqual(['0', '4', '2', '3', '1']);
      noGroupOps();
    });

    // A closed first member is the same case: the group survives, so the drop
    // still lands before it — and never at position -1 (the front).
    it('its first member closed: lands before what is left of the group', () => {
      fiveCollapsed();
      const t = hoverBeforeG();
      sendGroups([{ id: '0' }, { id: '2', groupId: G.id }, { id: '3' }, { id: '4' }], [G]);
      expect(marked()).toEqual([`group-cluster-${G.id}:before`]);
      fireEvent.drop(strip(), { dataTransfer: t });
      expect(lastOrder()).toEqual(['0', '4', '2', '3']);
      noGroupOps();
    });

    it('the group dissolved: the numeric index, previewed and committed', () => {
      fiveCollapsed();
      const t = hoverBeforeG();
      // Elsewhere: G is ungrouped and g1 moves past b → [a, g2, b, g1, c].
      sendGroups([{ id: '0' }, { id: '2' }, { id: '3' }, { id: '1' }, { id: '4' }], []);
      expect(marked()).toEqual(['session-tab-2:before']); // index 1
      fireEvent.drop(strip(), { dataTransfer: t });
      expect(lastOrder()).toEqual(['0', '4', '2', '3', '1']);
      noGroupOps();
    });

    describe('for a whole group', () => {
      // ids 0..5 with G={1,2} and H={3,4}, both collapsed: a | chip G | chip H | b
      const bothCollapsed = () => {
        setup(['0', '1', '2', '3', '4', '5']);
        sendGroups(
          [
            { id: '0' },
            { id: '1', groupId: G.id },
            { id: '2', groupId: G.id },
            { id: '3', groupId: H.id },
            { id: '4', groupId: H.id },
            { id: '5' },
          ],
          [G, H],
        );
        collapse(G.id, H.id);
        layout([
          [0, 100],
          [108, 170],
          [178, 240],
          [248, 348],
        ]);
      };
      const hoverHBeforeG = () => {
        const t = dtOf(GROUP_DND_TYPE);
        fireEvent.dragStart(chip(H.id), { dataTransfer: t });
        overAt(chip(G.id), t, 120);
        expect(marked()).toEqual([`group-cluster-${G.id}:before`]);
        return t;
      };

      it('its first member moved out: H still lands before G', () => {
        bothCollapsed();
        const t = hoverHBeforeG();
        // Elsewhere: g1 leaves G for the end → [a, g2, h1, h2, b, g1].
        sendGroups(
          [
            { id: '0' },
            { id: '2', groupId: G.id },
            { id: '3', groupId: H.id },
            { id: '4', groupId: H.id },
            { id: '5' },
            { id: '1' },
          ],
          [G, H],
        );
        expect(marked()).toEqual([`group-cluster-${G.id}:before`]);
        fireEvent.drop(strip(), { dataTransfer: t });
        expect(lastOrder()).toEqual(['0', '3', '4', '2', '5', '1']);
      });

      it('its first member closed: H lands before what is left of G', () => {
        bothCollapsed();
        const t = hoverHBeforeG();
        sendGroups(
          [
            { id: '0' },
            { id: '2', groupId: G.id },
            { id: '3', groupId: H.id },
            { id: '4', groupId: H.id },
            { id: '5' },
          ],
          [G, H],
        );
        fireEvent.drop(strip(), { dataTransfer: t });
        expect(lastOrder()).toEqual(['0', '3', '4', '2', '5']);
      });

      it('G dissolved: the numeric index, previewed and committed', () => {
        bothCollapsed();
        const t = hoverHBeforeG();
        // Elsewhere: G is ungrouped and g1 moves past g2 → [a, g2, g1, h1, h2, b].
        sendGroups(
          [
            { id: '0' },
            { id: '2' },
            { id: '1' },
            { id: '3', groupId: H.id },
            { id: '4', groupId: H.id },
            { id: '5' },
          ],
          [H],
        );
        expect(marked()).toEqual(['session-tab-2:before']); // index 1
        fireEvent.drop(strip(), { dataTransfer: t });
        expect(lastOrder()).toEqual(['0', '3', '4', '2', '1', '5']);
      });
    });
  });

  // Review R1: the gaps are empty strip space and used to read as "the end".
  describe('in the gaps between pills', () => {
    it('a tab dropped in a gap lands there, not at the end', () => {
      setup(['0', '1', '2']);
      layout([
        [0, 100],
        [108, 208],
        [216, 316],
      ]);
      dropTab('2', strip(), 104); // between 0 and 1
      expect(lastOrder()).toEqual(['0', '2', '1']);
    });

    it('a grouped tab dropped in a gap INSIDE its cluster keeps its membership', () => {
      setup(['0', '1', '2', '3']);
      sendGroups(
        [
          { id: '0', groupId: G.id },
          { id: '1', groupId: G.id },
          { id: '2', groupId: G.id },
          { id: '3' },
        ],
        [G],
      );
      // chip | 0 | 1 | 2 | 3; the gap is between 1 and 2, inside the frame
      layout([
        [10, 50],
        [58, 158],
        [166, 266],
        [274, 374],
        [390, 490],
      ]);
      dropTab('0', screen.getByTestId(`group-cluster-${G.id}`), 270);
      expect(lastOrder()).toEqual(['1', '0', '2', '3']);
      expect(server().groupUpdates.filter((u) => 'removeIds' in u)).toEqual([]);
    });

    it('past the last pill still appends (and a grouped tab leaves, as before)', () => {
      setup(['0', '1', '2']);
      sendGroups([{ id: '0', groupId: G.id }, { id: '1', groupId: G.id }, { id: '2' }], [G]);
      layout([
        [10, 50],
        [58, 158],
        [166, 266],
        [280, 380],
      ]);
      dropTab('0', strip(), 500);
      expect(server().groupUpdates).toContainEqual({
        id: G.id,
        removeIds: ['0'],
        order: ['1', '2', '0'],
      });
    });
  });

  // The gaps inside an expanded group's frame are new empty space. A boundary
  // there, for a tab that is NOT a member, used to be the plain index between the
  // two members — and decideGroupDrop reads "between two members" as a JOIN, so
  // a drop that previewed as a reorder quietly changed membership on the server.
  // A boundary never joins: it resolves to the group's nearer outer edge.
  describe('a boundary inside a group the tab is not in', () => {
    it('lands after the group when its right edge is nearer, joining nothing', () => {
      fiveWithGroup(); // a | chip | g1 | g2 | b | c
      layout([
        [0, 100],
        [108, 170],
        [178, 278],
        [286, 386],
        [400, 500],
        [508, 608],
      ]);
      const t = dtOf(TAB_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId('session-tab-4'), { dataTransfer: t });
      overAt(screen.getByTestId(`group-cluster-${G.id}`), t, 282); // the g1|g2 gap
      expect(marked()).toEqual(['session-tab-3:before']); // the edge after the group
      fireEvent.drop(strip(), { dataTransfer: t });
      expect(lastOrder()).toEqual(['0', '1', '2', '4', '3']);
      noGroupOps();
      expect(framed(G.id)).toEqual(['1', '2']);
    });

    it('lands before the group when its left edge is nearer, joining nothing', () => {
      setup(['0', '1', '2', '3', '4']);
      sendGroups(
        [
          { id: '0' },
          { id: '1', groupId: G.id },
          { id: '2', groupId: G.id },
          { id: '3', groupId: G.id },
          { id: '4' },
        ],
        [G],
      );
      // a | chip | g1 | g2 | g3 | c
      layout([
        [0, 100],
        [108, 170],
        [178, 278],
        [286, 386],
        [394, 494],
        [508, 608],
      ]);
      const t = dtOf(TAB_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId('session-tab-4'), { dataTransfer: t });
      overAt(screen.getByTestId(`group-cluster-${G.id}`), t, 282); // the g1|g2 gap
      expect(marked()).toEqual([`group-cluster-${G.id}:before`]);
      fireEvent.drop(strip(), { dataTransfer: t });
      expect(lastOrder()).toEqual(['0', '4', '1', '2', '3']);
      noGroupOps();
    });

    it("a member in its own group's gap is a plain reorder inside the group", () => {
      setup(['0', '1', '2', '3', '4']);
      sendGroups(
        [
          { id: '0' },
          { id: '1', groupId: G.id },
          { id: '2', groupId: G.id },
          { id: '3', groupId: G.id },
          { id: '4' },
        ],
        [G],
      );
      layout([
        [0, 100],
        [108, 170],
        [178, 278],
        [286, 386],
        [394, 494],
        [508, 608],
      ]);
      const t = dtOf(TAB_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId('session-tab-1'), { dataTransfer: t });
      overAt(screen.getByTestId(`group-cluster-${G.id}`), t, 390); // the g2|g3 gap
      expect(marked()).toEqual(['session-tab-3:before']);
      fireEvent.drop(strip(), { dataTransfer: t });
      expect(lastOrder()).toEqual(['0', '2', '1', '3', '4']);
      noGroupOps();
      expect(framed(G.id)).toEqual(['2', '1', '3']);
    });

    // The boundary is resolved at hover time, and another window can group the
    // two tabs either side of it before the drop lands. App knows the drop was a
    // boundary, so it moves it to the edge itself rather than read it as a join.
    it('a boundary that went stale into a group still joins nothing', () => {
      setup(['0', '1', '2', '3']);
      layout([
        [0, 100],
        [108, 208],
        [216, 316],
        [324, 424],
      ]);
      const t = dtOf(TAB_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId('session-tab-3'), { dataTransfer: t });
      overAt(strip(), t, 212); // the 1|2 gap, nothing grouped yet
      sendGroups(
        [{ id: '0' }, { id: '1', groupId: G.id }, { id: '2', groupId: G.id }, { id: '3' }],
        [G],
      );
      fireEvent.drop(strip(), { dataTransfer: t });
      expect(server().groupUpdates.filter((u) => 'addIds' in u)).toEqual([]);
      expect(lastOrder()).toEqual(['0', '3', '1', '2']);
    });

    // INTENTIONAL behaviour change (batch-2 plan: "a boundary drop never joins a
    // group — joining stays the centre-of-a-grouped-tab gesture"). This drop used
    // to JOIN: the pill half kept its index between g1 and g2, decideGroupDrop
    // read "between two members" as a join and App sent a persisted groupUpdate
    // — while the strip previewed nothing but an insertion bar. A pill half is a
    // boundary like a gap, so it lands on the group's nearer outer edge instead.
    it("a member pill's half is a boundary: the group's nearer edge, never a join", () => {
      fiveWithGroup();
      layout([
        [0, 100],
        [108, 170],
        [178, 278],
        [286, 386],
        [400, 500],
        [508, 608],
      ]);
      const t = dtOf(TAB_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId('session-tab-4'), { dataTransfer: t });
      overAt(screen.getByTestId('session-tab-2'), t, 290); // left half of g2
      expect(marked()).toEqual(['session-tab-3:before']); // right edge is nearer
      fireEvent.drop(strip(), { dataTransfer: t });
      expect(server().groupUpdates.filter((u) => 'addIds' in u)).toEqual([]);
      expect(lastOrder()).toEqual(['0', '1', '2', '4', '3']);
      expect(framed(G.id)).toEqual(['1', '2']);
    });

    it("a member pill's right half nearer the left edge lands before the group", () => {
      setup(['0', '1', '2', '3', '4']);
      sendGroups(
        [
          { id: '0' },
          { id: '1', groupId: G.id },
          { id: '2', groupId: G.id },
          { id: '3', groupId: G.id },
          { id: '4' },
        ],
        [G],
      );
      // a | chip | g1 | g2 | g3 | c
      layout([
        [0, 100],
        [108, 170],
        [178, 278],
        [286, 386],
        [394, 494],
        [508, 608],
      ]);
      const t = dtOf(TAB_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId('session-tab-4'), { dataTransfer: t });
      overAt(screen.getByTestId('session-tab-1'), t, 260); // right third of g1
      expect(marked()).toEqual([`group-cluster-${G.id}:before`]);
      fireEvent.drop(strip(), { dataTransfer: t });
      expect(server().groupUpdates.filter((u) => 'addIds' in u)).toEqual([]);
      expect(lastOrder()).toEqual(['0', '4', '1', '2', '3']);
      expect(framed(G.id)).toEqual(['1', '2', '3']);
    });

    // The centre third is the one gesture that joins, and it still does.
    it("a member pill's centre still joins", () => {
      fiveWithGroup();
      layout([
        [0, 100],
        [108, 170],
        [178, 278],
        [286, 386],
        [400, 500],
        [508, 608],
      ]);
      dropTab('4', screen.getByTestId('session-tab-2'), 336); // centre of g2
      expect(server().groupUpdates).toContainEqual({
        id: G.id,
        addIds: ['4'],
        order: ['0', '1', '4', '2', '3'],
      });
    });

    // Inside the dragged tab's OWN group a pill half is a plain reorder: it
    // moves within the frame and keeps its membership.
    it("a member on a fellow member's half reorders inside its own group", () => {
      setup(['0', '1', '2', '3', '4']);
      sendGroups(
        [
          { id: '0' },
          { id: '1', groupId: G.id },
          { id: '2', groupId: G.id },
          { id: '3', groupId: G.id },
          { id: '4' },
        ],
        [G],
      );
      // a | chip | g1 | g2 | g3 | c
      layout([
        [0, 100],
        [108, 170],
        [178, 278],
        [286, 386],
        [394, 494],
        [508, 608],
      ]);
      dropTab('1', screen.getByTestId('session-tab-3'), 410); // left half of g3
      expect(lastOrder()).toEqual(['0', '2', '1', '3', '4']);
      noGroupOps();
      expect(framed(G.id)).toEqual(['2', '1', '3']);
    });

    it("a member on its own group's left edge stays a member", () => {
      fiveWithGroup();
      layout([
        [0, 100],
        [108, 170],
        [178, 278],
        [286, 386],
        [400, 500],
        [508, 608],
      ]);
      dropTab('2', screen.getByTestId('session-tab-1'), 190); // left half of g1
      expect(lastOrder()).toEqual(['0', '2', '1', '3', '4']);
      noGroupOps();
      expect(framed(G.id)).toEqual(['2', '1']);
    });

    // A fused pill has no centre gesture at all, so both its halves are
    // boundaries. Inside a group the dragged tab is not in, each resolves to that
    // group's nearer edge — never the join the bare index between members read as.
    describe('a fused pill inside the group', () => {
      // [a, g1, g2, g3, g4, b] with (g2|g3) split: a | chip | g1 | fused | g4 | b
      const fusedInGroup = () => {
        setup(['0', '1', '2', '3', '4', '5']);
        sendGroups(
          [
            { id: '0' },
            { id: '1', groupId: G.id },
            { id: '2', groupId: G.id },
            { id: '3', groupId: G.id },
            { id: '4', groupId: G.id },
            { id: '5' },
          ],
          [G],
        );
        clickTab('2');
        openSplitVia('3');
        expect(screen.getByTestId('fused-tab-2-3')).toBeTruthy();
        // Opening the split sends its own fuse-time groupUpdate (the partner
        // adopts the anchor's membership); only what the DROP sends is asserted.
        server().groupUpdates.length = 0;
        layout([
          [0, 100],
          [108, 170],
          [178, 278],
          [286, 586],
          [594, 694],
          [708, 808],
        ]);
      };
      const joins = () => server().groupUpdates.filter((u) => 'addIds' in u);

      it('its left half nearer the left edge lands before the group', () => {
        fusedInGroup();
        const t = dtOf(TAB_DND_TYPE);
        fireEvent.dragStart(screen.getByTestId('session-tab-5'), { dataTransfer: t });
        overAt(screen.getByTestId('fused-tab-2-3'), t, 300);
        expect(marked()).toEqual([`group-cluster-${G.id}:before`]);
        fireEvent.drop(strip(), { dataTransfer: t });
        expect(joins()).toEqual([]);
        expect(lastOrder()).toEqual(['0', '5', '1', '2', '3', '4']);
      });

      it('its right half nearer the right edge lands after the group', () => {
        fusedInGroup();
        const t = dtOf(TAB_DND_TYPE);
        fireEvent.dragStart(screen.getByTestId('session-tab-0'), { dataTransfer: t });
        overAt(screen.getByTestId('fused-tab-2-3'), t, 570);
        expect(marked()).toEqual(['session-tab-5:before']);
        fireEvent.drop(strip(), { dataTransfer: t });
        expect(joins()).toEqual([]);
        expect(lastOrder()).toEqual(['1', '2', '3', '4', '0', '5']);
      });
    });
  });

  // A group dropped inside another expanded group used to send that split order
  // as-is: [g1, h1, h2, g2]. The server normalizes it straight back and, with
  // nothing changed, broadcasts nothing — so the client stayed fragmented (g2
  // drawn outside G's frame) until some unrelated broadcast arrived.
  describe('a group dropped inside another group', () => {
    // [g1, g2, h1, h2]: chip G | g1 | g2 | chip H | h1 | h2
    const twoExpanded = () => {
      setup(['0', '1', '2', '3']);
      sendGroups(
        [
          { id: '0', groupId: G.id },
          { id: '1', groupId: G.id },
          { id: '2', groupId: H.id },
          { id: '3', groupId: H.id },
        ],
        [G, H],
      );
      layout([
        [0, 62],
        [70, 170],
        [178, 278],
        [292, 354],
        [362, 462],
        [470, 570],
      ]);
    };
    // [g1, g2, g3, h1, h2]: chip G | g1 | g2 | g3 | chip H | h1 | h2
    const threeAndTwo = () => {
      setup(['0', '1', '2', '3', '4']);
      sendGroups(
        [
          { id: '0', groupId: G.id },
          { id: '1', groupId: G.id },
          { id: '2', groupId: G.id },
          { id: '3', groupId: H.id },
          { id: '4', groupId: H.id },
        ],
        [G, H],
      );
      layout([
        [0, 62],
        [70, 170],
        [178, 278],
        [286, 386],
        [400, 462],
        [470, 570],
        [578, 678],
      ]);
    };

    it('in the gap nearer its right edge: already there, sends nothing, G stays whole', () => {
      twoExpanded();
      const t = dtOf(GROUP_DND_TYPE);
      fireEvent.dragStart(chip(H.id), { dataTransfer: t });
      overAt(screen.getByTestId(`group-cluster-${G.id}`), t, 174); // the g1|g2 gap
      expect(marked()).toEqual([`group-cluster-${H.id}:before`]);
      fireEvent.drop(strip(), { dataTransfer: t });
      expect(server().reorders).toEqual([]);
      expect(framed(G.id)).toEqual(['0', '1']);
      expect(framed(H.id)).toEqual(['2', '3']);
    });

    it('in the gap nearer its left edge: lands before it, G stays whole', () => {
      threeAndTwo();
      const t = dtOf(GROUP_DND_TYPE);
      fireEvent.dragStart(chip(H.id), { dataTransfer: t });
      overAt(screen.getByTestId(`group-cluster-${G.id}`), t, 174); // the g1|g2 gap
      expect(marked()).toEqual([`group-cluster-${G.id}:before`]);
      fireEvent.drop(strip(), { dataTransfer: t });
      expect(lastOrder()).toEqual(['3', '4', '0', '1', '2']);
      expect(framed(G.id)).toEqual(['0', '1', '2']);
    });

    it("on a member pill's inner half: the nearer edge of that group", () => {
      threeAndTwo();
      const t = dtOf(GROUP_DND_TYPE);
      fireEvent.dragStart(chip(H.id), { dataTransfer: t });
      overAt(screen.getByTestId('session-tab-0'), t, 150); // right half of g1
      expect(marked()).toEqual([`group-cluster-${G.id}:before`]);
      fireEvent.drop(strip(), { dataTransfer: t });
      expect(lastOrder()).toEqual(['3', '4', '0', '1', '2']);
      expect(framed(G.id)).toEqual(['0', '1', '2']);
    });

    it('before and after another expanded group lands at its edge', () => {
      twoExpanded();
      dropGroup(H.id, chip(G.id), 10); // left half of G's chip
      expect(lastOrder()).toEqual(['2', '3', '0', '1']);
      // Now [h1, h2, g1, g2]: chip H | h1 | h2 | chip G | g1 | g2, so g2 is [470,570].
      dropGroup(H.id, screen.getByTestId('session-tab-1'), 550); // right half of G's last member
      expect(lastOrder()).toEqual(['0', '1', '2', '3']);
      expect(framed(G.id)).toEqual(['0', '1']);
      expect(framed(H.id)).toEqual(['2', '3']);
    });

    // The hover resolved a plain boundary; another window grouped the two tabs
    // either side of it before the drop. The order moveGroup builds would split
    // that group, and the server would normalize it back to exactly what we
    // have — so the client must normalize first, find nothing to do, and stay
    // in step instead of drawing an order the server never broadcasts.
    it('a move the server would normalize back to the current order changes nothing', () => {
      setup(['0', '1', '2', '3']);
      sendGroups(
        [{ id: '0' }, { id: '1' }, { id: '2', groupId: H.id }, { id: '3', groupId: H.id }],
        [H],
      );
      // 0 | 1 | chip H | h1 | h2
      layout([
        [0, 100],
        [108, 208],
        [216, 278],
        [286, 386],
        [394, 494],
      ]);
      const t = dtOf(GROUP_DND_TYPE);
      fireEvent.dragStart(chip(H.id), { dataTransfer: t });
      overAt(strip(), t, 104); // the 0|1 gap
      sendGroups(
        [
          { id: '0', groupId: G.id },
          { id: '1', groupId: G.id },
          { id: '2', groupId: H.id },
          { id: '3', groupId: H.id },
        ],
        [G, H],
      );
      fireEvent.drop(strip(), { dataTransfer: t });
      expect(server().reorders).toEqual([]);
      expect(framed(G.id)).toEqual(['0', '1']);
      expect(framed(H.id)).toEqual(['2', '3']);
    });
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

// Measured on a Galaxy S26 (2026-10-24): ending a selection pinned the app to
// the grown, keyboard-less viewport FIRST and re-raised the IME after, so every
// shell got `resize rows 63` and then `rows 33` ~100ms later — two SIGWINCHs
// that jumped the terminal by a few lines. The grown height must never land
// while the keyboard is on its way back.
describe('ending a selection with the keyboard up does not resize twice', () => {
  const UP = 466;
  const DOWN = 833;
  let frames: FrameRequestCallback[] = [];
  const flushFrames = () => {
    const run = frames;
    frames = [];
    for (const cb of run) cb(0);
  };
  let vv: EventTarget & { height: number; offsetTop: number };
  const pinned = () => document.documentElement.style.getPropertyValue('--app-height');

  const mountMobile = () => {
    localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'on' }));
    vv = Object.assign(new EventTarget(), { height: UP, offsetTop: 0 });
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
    setup();
  };
  const step = (fn: () => void) =>
    act(() => {
      fn();
      flushFrames();
    });
  const viewport = (h: number) =>
    step(() => {
      vv.height = h;
      vv.dispatchEvent(new Event('resize'));
    });
  const selection = (live: boolean) =>
    step(() => {
      nativeSel.live = live;
      document.dispatchEvent(new Event('selectionchange'));
    });
  const withFakeTimers = (fn: () => void) => () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fn();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      nativeSel.live = false;
    }
  };

  it(
    'holds the keyboard-up height while the keyboard comes back',
    withFakeTimers(() => {
      mountMobile();
      expect(pinned()).toBe(`${UP}px`);
      selection(true);
      viewport(DOWN); // the selection blurred #mobile-kbd; the IME left
      expect(pinned()).toBe(`${UP}px`); // deferred, as before
      selection(false);
      expect(pinned()).toBe(`${UP}px`); // was 833px: the first of two resizes
      viewport(UP); // the re-raised IME is back
      step(() => vi.advanceTimersByTime(1000));
      expect(pinned()).toBe(`${UP}px`);
    }),
  );

  it(
    'pins the grown height when the keyboard does not come back',
    withFakeTimers(() => {
      mountMobile();
      selection(true);
      viewport(DOWN);
      selection(false);
      expect(pinned()).toBe(`${UP}px`);
      step(() => vi.advanceTimersByTime(1000));
      expect(pinned()).toBe(`${DOWN}px`);
    }),
  );

  // The IME's viewport event is read one frame later. A selection that ends inside
  // that frame still held the layout when the keyboard left, so its frame is the
  // selection's release, not an ordinary resize to pin.
  it(
    'restores the keyboard when the selection ends before the viewport frame runs',
    withFakeTimers(() => {
      mountMobile();
      const raise = vi.spyOn(keyboardTextarea(), 'focus');
      selection(true);
      act(() => {
        vv.height = DOWN;
        vv.dispatchEvent(new Event('resize'));
      }); // asked for a frame; it has not run
      selection(false);
      expect(raise).toHaveBeenCalledTimes(1);
      expect(pinned()).toBe(`${UP}px`);
      step(() => vi.advanceTimersByTime(1000));
      expect(pinned()).toBe(`${DOWN}px`);
    }),
  );
});

// The drawer is the second thing that holds the layout still. Opening it over a raised
// keyboard and then touching it can take the IME away (Android dismisses it when the
// focus moves), and re-fitting every shell behind a panel that covers them is all
// cost. So the drawer defers viewport changes the way a selection does, and its close
// runs the SAME release: raise the keyboard first when it was up, then re-pin.
describe('the drawer holds the layout until it closes', () => {
  const SCREEN = 900;
  const UP = 466; // 434px below the screen: a keyboard
  const DOWN = 833; // 67px below it: system bars, no keyboard
  let frames: FrameRequestCallback[] = [];
  const flushFrames = () => {
    const run = frames;
    frames = [];
    for (const cb of run) cb(0);
  };
  let vv: EventTarget & { height: number; offsetTop: number };
  let setProperty: MockInstance<CSSStyleDeclaration['setProperty']>;
  const heightWrites = () =>
    setProperty.mock.calls.filter(([name]) => name === '--app-height').length;

  const step = (fn: () => void) =>
    act(() => {
      fn();
      flushFrames();
    });
  const viewport = (h: number) =>
    step(() => {
      vv.height = h;
      vv.dispatchEvent(new Event('resize'));
    });
  /** A viewport change whose frame has been asked for but has NOT run yet. */
  const queueViewport = (h: number) =>
    act(() => {
      vv.height = h;
      vv.dispatchEvent(new Event('resize'));
    });
  const selection = (live: boolean) =>
    step(() => {
      nativeSel.live = live;
      document.dispatchEvent(new Event('selectionchange'));
    });
  const advance = (ms: number) => step(() => void vi.advanceTimersByTime(ms));

  const mountMobile = (height: number) => {
    localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'on' }));
    Object.defineProperty(window.screen, 'height', { value: SCREEN, configurable: true });
    vv = Object.assign(new EventTarget(), { height, offsetTop: 0 });
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
    setProperty = vi.spyOn(document.documentElement.style, 'setProperty');
    setup();
  };
  /** Put the cursor in the keyboard's textarea, the way tapping the terminal does. */
  const focusKeyboard = () => act(() => keyboardTextarea().focus());
  /** Record the height the app was pinned to each time the keyboard is re-raised. */
  const trackRaises = () => {
    const raised: string[] = [];
    vi.spyOn(keyboardTextarea(), 'focus').mockImplementation(() => void raised.push(appHeight()));
    return raised;
  };
  /** Settings is the one keybinding that opens the drawer without touching its UI. */
  const openDrawer = () => step(() => void fireEvent.keyDown(window, { key: ',', ctrlKey: true }));
  const closeDrawer = (opts?: DrawerCloseOptions) => step(() => drawer().onClose(opts));
  /** Press a drawer footer action; what it answered is whether a picker opened. */
  const launch = (action: 'uploadFile' | 'uploadImages'): unknown => {
    let launched: unknown;
    act(() => {
      launched = drawer().actions[action]();
    });
    return launched;
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The drawer's Settings view mounts nothing that fetches; the chooser does.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 503 })),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window.screen, 'height');
    paneApiFake.enabled = false;
    paneApiFake.launches = true;
    nativeSel.live = false;
  });

  it('keeps --app-height still while the drawer is open and the viewport changes', () => {
    mountMobile(UP);
    focusKeyboard();
    openDrawer();
    expect(drawerIsOpen()).toBe(true);

    viewport(DOWN); // the IME left under the drawer
    expect(appHeight()).toBe(`${UP}px`);
    viewport(DOWN + 20);
    advance(5000);
    expect(appHeight()).toBe(`${UP}px`);
  });

  it('on close with the keyboard up, raises it BEFORE re-pinning and writes the height once', () => {
    mountMobile(UP);
    focusKeyboard();
    openDrawer();
    viewport(DOWN);
    const raised = trackRaises();
    const before = heightWrites();

    closeDrawer();
    expect(raised).toEqual([`${UP}px`]); // raised while still pinned to the keyboard-up height
    expect(appHeight()).toBe(`${UP}px`);
    expect(heightWrites() - before).toBe(0);

    advance(1000); // the IME never came back: the fallback pins the real height
    expect(appHeight()).toBe(`${DOWN}px`);
    expect(heightWrites() - before).toBe(1);
    expect(raised).toHaveLength(1);
  });

  // The IME coming back to the height the app is already pinned to changes nothing,
  // so it writes nothing: a same-size write still re-fits every attached pane.
  it('on close with the keyboard up, the IME coming back writes nothing, then or after', () => {
    mountMobile(UP);
    focusKeyboard();
    openDrawer();
    viewport(DOWN);
    const raised = trackRaises();
    const before = heightWrites();

    closeDrawer();
    viewport(UP); // the re-raised IME is back
    advance(1000);
    expect(appHeight()).toBe(`${UP}px`);
    expect(heightWrites() - before).toBe(0);
    expect(raised).toHaveLength(1);
  });

  it('on close with the keyboard down, raises nothing and re-pins at once', () => {
    mountMobile(DOWN);
    openDrawer();
    viewport(UP); // something inside the drawer raised an IME
    expect(appHeight()).toBe(`${DOWN}px`);
    const raised = trackRaises();

    closeDrawer();
    expect(appHeight()).toBe(`${UP}px`); // no timer, no wait
    expect(raised).toEqual([]);
  });

  // Focus alone proves nothing: Android dismisses the IME without blurring the
  // textarea, so a focused textarea over a full-height viewport is a keyboard that
  // is already gone. Raising it on close would hand back one nobody asked for.
  it('does not take a focused textarea over a full-height viewport for a raised keyboard', () => {
    mountMobile(DOWN);
    focusKeyboard();
    openDrawer();
    viewport(UP);
    const raised = trackRaises();

    closeDrawer();
    expect(raised).toEqual([]);
    expect(appHeight()).toBe(`${UP}px`);
  });

  // The IME can be up for ANOTHER input (a settings field, the rename sheet). Raising
  // the terminal's keyboard over it when the drawer closes would hand back one that
  // was never this app's to restore.
  it('does not raise a keyboard that belonged to another input', () => {
    mountMobile(UP); // a keyboard is up, but #mobile-kbd does not hold the focus
    openDrawer();
    viewport(DOWN);
    const raised = trackRaises();

    closeDrawer();
    expect(raised).toEqual([]);
    expect(appHeight()).toBe(`${DOWN}px`); // re-pinned at once, no fallback wait
  });

  it('re-pins a viewport change too small to be the IME leaving, with no raise', () => {
    mountMobile(UP);
    focusKeyboard();
    openDrawer();
    viewport(UP + 50); // a browser bar sliding, not a keyboard going
    const raised = trackRaises();

    closeDrawer();
    expect(raised).toEqual([]);
    expect(appHeight()).toBe(`${UP + 50}px`);
  });

  // Focus is not proof either: with the viewport already within a keyboard's height
  // of the screen there is nothing to bring back, whatever holds the focus.
  it('does not count a focused textarea over a near-full viewport as a raised keyboard', () => {
    mountMobile(DOWN);
    focusKeyboard();
    openDrawer();
    viewport(SCREEN + 60); // taller than the screen: an emulated or zoomed viewport
    const raised = trackRaises();

    closeDrawer();
    expect(raised).toEqual([]);
    expect(appHeight()).toBe(`${SCREEN + 60}px`);
  });

  // The fallback only ever fires the SAME apply, which defers while a hold is on, so a
  // timer left over from one close cannot pin the grown height under the next open.
  it('does not let a fallback pending from one close pin under the next open', () => {
    mountMobile(UP);
    focusKeyboard();
    openDrawer();
    viewport(DOWN);
    closeDrawer(); // raises and arms the 600ms fallback
    openDrawer();
    advance(1000);
    expect(appHeight()).toBe(`${UP}px`);
  });

  it('does not raise a keyboard that never left', () => {
    mountMobile(UP);
    focusKeyboard();
    openDrawer();
    const raised = trackRaises();

    closeDrawer(); // the viewport never moved: nothing was held, nothing to restore
    expect(raised).toEqual([]);
    expect(appHeight()).toBe(`${UP}px`);
  });

  // The product's real way in is a right-to-left swipe on the extra-keys bar, not the
  // Settings keybinding the rest of this suite borrows. It must take the same hold, and
  // the swipe's own pointer gesture must not cost the keyboard it is about to protect.
  it('opened by the extra-keys swipe, holds and restores the same way', () => {
    mountMobile(UP);
    focusKeyboard();
    const key = screen.getAllByTestId(/^extra-key-/)[0]!;
    step(() => {
      fireEvent.pointerDown(key, { clientX: 200, clientY: 0 });
      fireEvent.pointerMove(key, { clientX: 100, clientY: 0 });
      fireEvent.pointerUp(key, { clientX: 100, clientY: 0 });
    });
    expect(drawerIsOpen()).toBe(true);

    viewport(DOWN);
    expect(appHeight()).toBe(`${UP}px`);
    const raised = trackRaises();
    closeDrawer();
    expect(raised).toEqual([`${UP}px`]);
  });

  // The New-tab page is the one place a phone has a menu button instead of a strip, and
  // it opens the drawer through its own handler. Every way in takes the hold. There is no
  // terminal behind it to type into, so nothing is raised on the way out: just the re-pin.
  it('opened from the New-tab page menu, holds the layout and re-pins on close', () => {
    mountMobile(UP);
    broadcast([]); // the last tab closed: the chooser is the page
    step(() => void fireEvent.pointerDown(screen.getByLabelText('Open drawer')));
    expect(drawerIsOpen()).toBe(true);

    viewport(DOWN);
    expect(appHeight()).toBe(`${UP}px`);
    const raised = trackRaises();
    closeDrawer();
    expect(raised).toEqual([]);
    expect(appHeight()).toBe(`${DOWN}px`);
  });

  // A web, editor or markdown pane has a ☰ of its own on a phone. It opens the drawer too.
  it('opened from a pane menu, holds and restores the same way', () => {
    mountMobile(UP);
    focusKeyboard();
    send({
      type: 'sessions',
      tabs: [
        { id: '0', kind: 'terminal' },
        { id: '1', kind: 'web', url: 'https://example.com' },
      ],
    });
    send({ type: 'tabCreated', id: '1' });
    expect(paneHost.onMenu).toBeTypeOf('function');
    step(() => paneHost.onMenu!());
    expect(drawerIsOpen()).toBe(true);

    viewport(DOWN);
    expect(appHeight()).toBe(`${UP}px`);
    const raised = trackRaises();
    closeDrawer();
    expect(raised).toEqual([`${UP}px`]);
  });

  // The effect reads the hold through a ref. Opening the drawer must not RE-RUN it: its
  // cleanup drops `--app-height` and every listener, and a layout that re-pins under the
  // drawer is exactly the resize the hold exists to prevent (a re-run also re-measures,
  // so the pinned-height assertions above cannot tell it from a hold).
  it('holds without re-subscribing: the listeners and the pinned height are left alone', () => {
    mountMobile(UP);
    focusKeyboard();
    const subscribe = vi.spyOn(vv, 'addEventListener');
    const unpin = vi.spyOn(document.documentElement.style, 'removeProperty');

    openDrawer();
    viewport(DOWN);
    closeDrawer();
    advance(1000);
    expect(appHeight()).toBe(`${DOWN}px`);
    expect(subscribe).not.toHaveBeenCalled();
    expect(unpin).not.toHaveBeenCalledWith('--app-height');
  });

  // Only the OS may take the IME away. A drawer that blurred `#mobile-kbd` itself would
  // dismiss the keyboard on every open, which is the cost the whole hold exists to avoid.
  it('never blurs the keyboard textarea itself', () => {
    mountMobile(UP);
    focusKeyboard();
    const blur = vi.spyOn(keyboardTextarea(), 'blur');

    openDrawer();
    viewport(DOWN);
    expect(drawerIsOpen()).toBe(true);
    expect(blur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(keyboardTextarea());
  });

  // A pinned height that did not move is not the whole claim: a re-fit is what sends the
  // SIGWINCH, so nothing may re-fit a pane while held, and the release costs ONE.
  it('re-fits no pane while held, and one when the drawer closes', () => {
    paneApiFake.enabled = true;
    mountMobile(UP);
    focusKeyboard();
    openDrawer();
    const before = paneApiFake.refits;

    viewport(DOWN);
    viewport(DOWN + 20);
    advance(5000);
    expect(paneApiFake.refits).toBe(before);

    trackRaises();
    closeDrawer(); // raised first: nothing is re-fitted yet
    expect(paneApiFake.refits).toBe(before);
    advance(1000); // the IME never came back: the real height is pinned
    expect(paneApiFake.refits).toBe(before + 1);
  });

  // Every way out of the drawer is the same release. One that skipped it would leave
  // the terminal pinned at the keyboard-up height with dead space under it.
  describe('every close path runs the release', () => {
    const holdThenGone = () => {
      mountMobile(UP);
      focusKeyboard();
      openDrawer();
      viewport(DOWN);
      return trackRaises();
    };

    it('the scrim', () => {
      const raised = holdThenGone();
      step(() => void fireEvent.pointerDown(screen.getByTestId('drawer-scrim')));
      expect(drawerIsOpen()).toBe(false);
      expect(raised).toEqual([`${UP}px`]);
    });

    it('choosing a tab', () => {
      const raised = holdThenGone();
      broadcast(['0', '1']);
      step(() => {
        fireEvent.pointerDown(screen.getByTestId('drawer-session-1'), { pointerType: 'mouse' });
        fireEvent.pointerUp(screen.getByTestId('drawer-session-1'), { pointerType: 'mouse' });
      });
      expect(drawerIsOpen()).toBe(false);
      expect(raised).toEqual([`${UP}px`]);
    });

    it('creating a tab', () => {
      const raised = holdThenGone();
      step(() => tapPress(screen.getByTestId('drawer-new')));
      step(() => tapPress(screen.getByTestId('dash-new-terminal')));
      expect(drawerIsOpen()).toBe(false);
      expect(raised).toEqual([`${UP}px`]);
    });

    it('opening a file from the Explorer', async () => {
      const raised = holdThenGone();
      step(() => void drawer().onView?.('files'));
      const content = drawer().viewContent as { props: { onOpenFile: (path: string) => void } };
      step(() => content.props.onOpenFile('/tmp/notes.md'));
      expect(drawerIsOpen()).toBe(false);
      expect(raised).toEqual([`${UP}px`]);
      await act(async () => {}); // the tree's listing fetch settles
    });

    it('inserting a dictation', async () => {
      const raised = holdThenGone();
      step(() => void drawer().onView?.('dictation'));
      const content = drawer().viewContent as { props: { onInsert: (text: string) => void } };
      step(() => content.props.onInsert('hello'));
      expect(drawerIsOpen()).toBe(false);
      expect(raised).toEqual([`${UP}px`]);
      await act(async () => {}); // the history's fetch settles
    });

    it('a footer action that opened no picker', () => {
      const raised = holdThenGone();
      // No terminal pane is registered: the picker toasts instead of opening.
      expect(launch('uploadFile')).toBe(false);
      closeDrawer();
      expect(raised).toEqual([`${UP}px`]);
    });
  });

  // The IME leaving fires a viewport event, but the app reads it one animation frame
  // later. A release in between (a tap on the scrim lands there easily) used to find
  // nothing deferred yet and drop the hold's record, so the queued frame pinned the
  // grown viewport and the keyboard stayed down. What the hold recorded is handed to
  // the release itself, whether or not a frame ran while it held.
  describe('a viewport frame still queued at release', () => {
    it('restores the keyboard when the drawer closes, then re-pins once', () => {
      mountMobile(UP);
      focusKeyboard();
      openDrawer();
      const raised = trackRaises();
      const before = heightWrites();

      queueViewport(DOWN);
      closeDrawer(); // the queued frame runs after the hold is gone
      expect(raised).toEqual([`${UP}px`]); // raised while still pinned to the keyboard-up height
      expect(heightWrites() - before).toBe(0);

      advance(1000); // the IME never came back: the fallback pins the real height
      expect(appHeight()).toBe(`${DOWN}px`);
      expect(heightWrites() - before).toBe(1);
      expect(raised).toHaveLength(1);
    });

    it('restores the keyboard when the picker returns, then re-pins once', () => {
      paneApiFake.enabled = true;
      mountMobile(UP);
      focusKeyboard();
      openDrawer();
      const raised = trackRaises();
      expect(launch('uploadFile')).toBe(true);
      closeDrawer({ holdUntil: 'picker' });
      const before = heightWrites();

      queueViewport(DOWN);
      step(() => void pickerInput().dispatchEvent(new Event('change')));
      expect(raised).toEqual([`${UP}px`]);
      expect(heightWrites() - before).toBe(0);

      advance(1000);
      expect(appHeight()).toBe(`${DOWN}px`);
      expect(heightWrites() - before).toBe(1);
      expect(raised).toHaveLength(1);
    });

    it('raises nothing for a drawer that opened over a keyboard that was down', () => {
      mountMobile(UP); // an IME is up for another input: #mobile-kbd holds no focus
      openDrawer();
      const raised = trackRaises();
      queueViewport(DOWN);
      closeDrawer();
      expect(raised).toEqual([]);
      expect(appHeight()).toBe(`${DOWN}px`); // re-pinned at once, no fallback wait
    });
  });

  // A selection and the drawer can hold the layout at the same time, and each knows
  // something the other cannot. A selection blurs #mobile-kbd, so a drawer opened after
  // it records the keyboard as down although the selection began with it UP. Each hold
  // keeps its own record, and the release waits for the last of them.
  describe('overlapping holds', () => {
    it('a selection begun with the keyboard up still restores it when the drawer closes last', () => {
      mountMobile(UP);
      focusKeyboard();
      selection(true);
      act(() => keyboardTextarea().blur()); // the selection takes the focus from #mobile-kbd
      viewport(DOWN); // ...and the IME goes: the selection holds the layout
      expect(appHeight()).toBe(`${UP}px`);
      openDrawer(); // #mobile-kbd has no focus now: the drawer records the keyboard down
      selection(false); // cleared under the drawer, which still holds
      expect(appHeight()).toBe(`${UP}px`);
      const raised = trackRaises();
      const before = heightWrites();

      closeDrawer();
      expect(raised).toEqual([`${UP}px`]);
      expect(heightWrites() - before).toBe(0);
      advance(1000);
      expect(appHeight()).toBe(`${DOWN}px`);
      expect(heightWrites() - before).toBe(1);
      expect(raised).toHaveLength(1);
    });

    it('releases only when the last hold ends, whichever ends first', () => {
      mountMobile(UP);
      focusKeyboard();
      openDrawer();
      selection(true);
      viewport(DOWN);
      const raised = trackRaises();
      const before = heightWrites();

      closeDrawer(); // the selection still holds
      advance(1000);
      expect(raised).toEqual([]);
      expect(heightWrites() - before).toBe(0);

      selection(false);
      expect(raised).toEqual([`${UP}px`]);
      advance(1000);
      expect(appHeight()).toBe(`${DOWN}px`);
      expect(heightWrites() - before).toBe(1);
      expect(raised).toHaveLength(1);
    });
  });

  // The release raises the keyboard and keeps the keyboard-up height while it comes
  // back. Any viewport event in that window (a scroll, the IME animating in) used to
  // pin the CURRENT, keyboard-less height at once and cancel the fallback, and the
  // IME's arrival then changed it again: two writes and two resizes per shell.
  // Restoring is a state of its own now. It writes nothing until the viewport has
  // come back within a keyboard of the pinned height and stayed there for
  // RESTORE_SETTLE_MS, then commits once; the fallback is the upper bound.
  describe('a viewport event while the keyboard is coming back', () => {
    const SETTLE_MS = 150;
    const RETURN_MS = 600;
    // The measured shape, on a 900px screen: pinned 500 with the keyboard up, the
    // drawer closed over a viewport grown to 844.
    const PIN = 500;
    const OPEN = 844;
    let refitsBefore = 0;
    /** Keyboard up, drawer open, IME gone under it, drawer closed: the restore is pending. */
    const restoring = () => {
      paneApiFake.enabled = true;
      mountMobile(PIN);
      focusKeyboard();
      openDrawer();
      viewport(OPEN);
      const raised = trackRaises();
      closeDrawer();
      expect(raised).toEqual([`${PIN}px`]);
      refitsBefore = paneApiFake.refits;
      return heightWrites();
    };
    const scroll = () => step(() => void vv.dispatchEvent(new Event('scroll')));

    it('a scroll before the keyboard is back writes nothing, and its return costs at most one', () => {
      const before = restoring();
      scroll();
      expect(heightWrites() - before).toBe(0);
      viewport(PIN); // the keyboard is back
      advance(1000);
      expect(heightWrites() - before).toBeLessThanOrEqual(1);
      expect(paneApiFake.refits - refitsBefore).toBeLessThanOrEqual(1);
      expect(appHeight()).toBe(`${PIN}px`);
    });

    // The sequence ends where it started, and a restore that ends on the geometry
    // already pinned has nothing to write: not one write, not one refit.
    it('pinned 500, closed at 844, scrolled at 844, keyboard back at 500: no write at all', () => {
      const before = restoring();
      scroll();
      viewport(OPEN); // another event at the grown height
      scroll();
      viewport(PIN);
      advance(1000);
      expect(heightWrites() - before).toBe(0);
      expect(paneApiFake.refits).toBe(refitsBefore);
      expect(appHeight()).toBe(`${PIN}px`);
    });

    // The pinned geometry is the height AND the top. A restore that ends at the same
    // height on a scrolled viewport has something to apply, and applies it once.
    it('a keyboard back at the pinned height on a scrolled viewport commits once, for the top', () => {
      const before = restoring();
      step(() => {
        vv.offsetTop = 40;
        vv.dispatchEvent(new Event('scroll'));
      });
      expect(heightWrites() - before).toBe(0);
      viewport(PIN);
      advance(1000);
      expect(heightWrites() - before).toBe(1);
      expect(document.documentElement.style.getPropertyValue('--app-top')).toBe('40px');
      expect(paneApiFake.refits - refitsBefore).toBe(1);
    });

    // An IME animates in through heights between the two. Crossing back under the
    // keyboard threshold is not arrival.
    it('an IME animating back to the pinned height writes nothing at all', () => {
      const before = restoring();
      viewport(580);
      viewport(PIN);
      advance(1000);
      expect(heightWrites() - before).toBe(0);
      expect(paneApiFake.refits).toBe(refitsBefore);
      expect(appHeight()).toBe(`${PIN}px`);
    });

    it('a keyboard of another height is committed once, at its final height', () => {
      const before = restoring();
      viewport(580);
      viewport(480);
      advance(1000);
      expect(heightWrites() - before).toBe(1);
      expect(appHeight()).toBe('480px');
      expect(paneApiFake.refits - refitsBefore).toBe(1);
    });

    it('waits until the viewport has held still, restarting with every event', () => {
      const before = restoring();
      viewport(580);
      advance(SETTLE_MS - 50);
      viewport(530);
      advance(SETTLE_MS - 50);
      viewport(480);
      advance(SETTLE_MS - 1);
      expect(heightWrites() - before).toBe(0);
      advance(1);
      expect(heightWrites() - before).toBe(1);
      expect(appHeight()).toBe('480px');
    });

    it('the fallback is the upper bound for a viewport that never holds still', () => {
      const before = restoring();
      for (let h = 590; h > 470; h -= 10) {
        viewport(h);
        advance(SETTLE_MS - 100);
      }
      // Twelve events, 50ms apart: the settle timer never got to fire, and the
      // fallback, 600ms after the release, committed where the viewport was then.
      expect(heightWrites() - before).toBe(1);
      expect(appHeight()).toBe('480px');
    });

    it('a scroll does not cancel the fallback when the keyboard never comes back', () => {
      const before = restoring();
      scroll();
      advance(RETURN_MS - 1);
      expect(heightWrites() - before).toBe(0);
      advance(1);
      expect(heightWrites() - before).toBe(1);
      expect(appHeight()).toBe(`${OPEN}px`);
    });

    it('a hold taken mid-restore takes over: nothing is committed under it', () => {
      const before = restoring();
      viewport(580); // the settle timer is running
      openDrawer();
      advance(1000);
      expect(heightWrites() - before).toBe(0);
      expect(appHeight()).toBe(`${PIN}px`);

      closeDrawer(); // its own release decides afresh: 580 is no keyboard's absence
      expect(appHeight()).toBe('580px');
    });

    it('so does a selection begun mid-restore', () => {
      const before = restoring();
      viewport(580);
      selection(true);
      advance(1000);
      expect(heightWrites() - before).toBe(0);
      expect(appHeight()).toBe(`${PIN}px`);
    });
  });

  // Mobile mode can come back on while the drawer's state still says open (it was
  // switched off from the drawer's own Settings). The hold defers an UPDATE to a
  // layout that is pinned, never the first pin, or the app would sit unpinned until
  // the drawer closed.
  it('pins the first height even when the drawer was already open', () => {
    mountMobile(UP);
    openDrawer(); // Settings, in the drawer
    fireEvent.click(screen.getByTestId('set-mobile-off'));
    expect(appHeight()).toBe('');

    fireEvent.keyDown(window, { key: ',', ctrlKey: true }); // Settings, in the dock
    step(() => void fireEvent.click(screen.getByTestId('set-mobile-on')));
    expect(drawerIsOpen()).toBe(true);
    expect(appHeight()).toBe(`${UP}px`);
  });

  // The long-press sheet opens OVER the drawer, so a rename or a colour change leaves
  // you in the drawer you pressed in. Closing the drawer under it would also have
  // released the hold while the sheet's own input was raising an IME.
  it('opens the row menu over the drawer without closing it', () => {
    mountMobile(UP);
    focusKeyboard();
    openDrawer();
    broadcast(['0', '1']);

    step(() => drawer().onTabMenu('1'));
    expect(screen.getByTestId('tab-sheet')).toBeInTheDocument();
    expect(drawerIsOpen()).toBe(true);

    viewport(DOWN); // the sheet's input took the IME; the layout is still held
    expect(appHeight()).toBe(`${UP}px`);
  });

  // "After a rename or colour change you are back in the drawer": every way out of the
  // sheet (the scrim, Done) leaves the drawer open, and its hold with it.
  it.each([
    ['the scrim', 'sheet-scrim'],
    ['Done', 'sheet-done'],
  ])('lands back in the drawer when the row menu is dismissed by %s', (_how, testId) => {
    mountMobile(UP);
    focusKeyboard();
    openDrawer();
    broadcast(['0', '1']);
    step(() => drawer().onTabMenu('1'));
    expect(screen.getByTestId('tab-sheet')).toBeInTheDocument();

    step(() => void fireEvent.pointerDown(screen.getByTestId(testId)));
    expect(screen.queryByTestId('tab-sheet')).toBeNull();
    expect(drawerIsOpen()).toBe(true);

    const raised = trackRaises();
    viewport(DOWN);
    expect(appHeight()).toBe(`${UP}px`); // still held: only the drawer's own close lets go
    closeDrawer();
    expect(raised).toEqual([`${UP}px`]);
  });

  // A native picker covers the app and may take the IME with it, and the page is
  // told nothing. The drawer is gone from view but the layout stays held until the
  // picker reports back: the spec's "its row count does not change while the picker
  // is open".
  describe('a native picker keeps the hold until it returns', () => {
    const GRACE_MS = 300;

    /** Keyboard up, drawer open, Upload pressed, the picker took the IME. */
    const pickerUp = (action: 'uploadFile' | 'uploadImages' = 'uploadFile') => {
      paneApiFake.enabled = true;
      mountMobile(UP);
      focusKeyboard();
      openDrawer();
      const raised = trackRaises();
      // What the drawer does: act FIRST, close with the hold only if it launched.
      expect(launch(action)).toBe(true);
      closeDrawer({ holdUntil: 'picker' });
      expect(drawerIsOpen()).toBe(false);
      viewport(DOWN);
      return raised;
    };
    afterEach(() => {
      Reflect.deleteProperty(document, 'visibilityState');
    });

    it('stays held past the keyboard fallback and past a minute, until change', () => {
      const raised = pickerUp();

      advance(700); // longer than KEYBOARD_RETURN_MS
      expect(appHeight()).toBe(`${UP}px`);
      advance(61 * 1000);
      expect(appHeight()).toBe(`${UP}px`);
      expect(raised).toEqual([]);

      step(() => void pickerInput().dispatchEvent(new Event('change')));
      expect(raised).toEqual([`${UP}px`]); // raised first, still pinned
      advance(1000);
      expect(appHeight()).toBe(`${DOWN}px`);
    });

    it('holds for the image picker the same way', () => {
      const raised = pickerUp('uploadImages');
      advance(61 * 1000);
      expect(appHeight()).toBe(`${UP}px`);

      step(() => void pickerInput('upload-image-input').dispatchEvent(new Event('change')));
      expect(raised).toEqual([`${UP}px`]);
    });

    it('a cancel releases once', () => {
      const raised = pickerUp();

      step(() => void pickerInput().dispatchEvent(new Event('cancel')));
      step(() => void pickerInput().dispatchEvent(new Event('cancel')));
      advance(1000);
      expect(raised).toHaveLength(1);
      expect(appHeight()).toBe(`${DOWN}px`);
    });

    it('a confirmed return with no change releases once, after the grace', () => {
      setVisibility('visible');
      const raised = pickerUp();

      step(() => void window.dispatchEvent(new Event('focus')));
      expect(raised).toEqual([]);
      advance(GRACE_MS - 1);
      expect(raised).toEqual([]);
      advance(1);
      expect(raised).toEqual([`${UP}px`]);

      step(() => void window.dispatchEvent(new Event('focus')));
      advance(60 * 1000);
      expect(raised).toHaveLength(1);
    });

    it('a focus while the page is hidden does not release', () => {
      const raised = pickerUp();

      setVisibility('hidden');
      step(() => void window.dispatchEvent(new Event('focus')));
      advance(60 * 1000);
      expect(raised).toEqual([]);
      expect(appHeight()).toBe(`${UP}px`);
    });

    // The picker's return only ever lets go of a hold that is waiting for it. One that
    // came back while the drawer was still open must not take the drawer's layout.
    it('a picker returning under an open drawer does not release the drawer hold', () => {
      paneApiFake.enabled = true;
      mountMobile(UP);
      focusKeyboard();
      openDrawer();
      viewport(DOWN);
      const raised = trackRaises();

      expect(launch('uploadFile')).toBe(true); // opened, but the drawer was never closed
      step(() => void pickerInput().dispatchEvent(new Event('change')));
      advance(1000);
      expect(raised).toEqual([]);
      expect(appHeight()).toBe(`${UP}px`);
    });

    it('reopening the drawer takes the hold back from a pending picker', () => {
      const raised = pickerUp();

      openDrawer();
      step(() => void pickerInput().dispatchEvent(new Event('change')));
      advance(1000);
      expect(raised).toEqual([]); // the drawer is open again: it owns the hold now
      expect(appHeight()).toBe(`${UP}px`);

      closeDrawer(); // and its close restores what was found when it FIRST opened
      expect(raised).toEqual([`${UP}px`]);
    });

    // The hold was taken with what the drawer found at OPEN. A picker that follows a
    // keyboard that was down must not hand one back on return, whatever the viewport did.
    it('a picker opened over a keyboard that was down raises nothing when it returns', () => {
      paneApiFake.enabled = true;
      mountMobile(UP); // an IME is up for another input: #mobile-kbd holds no focus
      openDrawer();
      const raised = trackRaises();
      expect(launch('uploadFile')).toBe(true);
      closeDrawer({ holdUntil: 'picker' });

      viewport(DOWN); // the viewport GREW under the hold
      advance(61 * 1000);
      expect(appHeight()).toBe(`${UP}px`);
      step(() => void pickerInput().dispatchEvent(new Event('change')));
      expect(raised).toEqual([]);
      expect(appHeight()).toBe(`${DOWN}px`); // re-pinned at once, no fallback wait
    });

    // Spec: the terminal receives no resize until the picker is over. A pinned height that
    // stays put is only half of that; a re-fit is the resize.
    it('re-fits no pane while the picker is up, and one when it returns', () => {
      pickerUp();
      const before = paneApiFake.refits;

      viewport(DOWN + 10);
      advance(61 * 1000);
      expect(paneApiFake.refits).toBe(before);

      step(() => void pickerInput().dispatchEvent(new Event('change')));
      advance(1000);
      expect(paneApiFake.refits).toBe(before + 1);
    });

    it('follows the viewport again once the picker has returned', () => {
      pickerUp();
      step(() => void pickerInput().dispatchEvent(new Event('change')));
      advance(1000);
      expect(appHeight()).toBe(`${DOWN}px`);

      viewport(UP + 30);
      expect(appHeight()).toBe(`${UP + 30}px`);
    });

    // The drawer acts FIRST and closes with the hold only once a picker is up. Starting
    // the second picker settles the first, and that must not let go of a hold the second
    // is about to need: only the picker that is actually up gets to release it.
    it('a second picker from the reopened drawer takes the hold over', () => {
      const raised = pickerUp();

      openDrawer(); // back in the drawer while the first picker still listens
      expect(launch('uploadImages')).toBe(true); // settles the first one
      closeDrawer({ holdUntil: 'picker' });
      advance(61 * 1000);
      expect(raised).toEqual([]);
      expect(appHeight()).toBe(`${UP}px`);

      step(() => void pickerInput().dispatchEvent(new Event('change'))); // the first: spent
      expect(raised).toEqual([]);
      step(() => void pickerInput('upload-image-input').dispatchEvent(new Event('change')));
      expect(raised).toEqual([`${UP}px`]);
    });

    it('a plain close while the drawer is open releases without waiting for a picker', () => {
      paneApiFake.enabled = true;
      mountMobile(UP);
      focusKeyboard();
      openDrawer();
      viewport(DOWN);
      const raised = trackRaises();

      closeDrawer();
      expect(raised).toEqual([`${UP}px`]);
      advance(1000);
      expect(appHeight()).toBe(`${DOWN}px`);
    });
  });

  // The hold is for a picker that is UP. A toast is not one, and a drawer that held
  // the layout for it would wait for a return signal that is never coming.
  describe('acquires no picker hold when no picker opens', () => {
    const attempt = (action: 'uploadFile' | 'uploadImages') => {
      focusKeyboard();
      openDrawer();
      viewport(DOWN);
      const raised = trackRaises();
      expect(launch(action)).toBe(false);
      // What the drawer does on `false`: a plain close.
      closeDrawer();
      expect(raised).toEqual([`${UP}px`]);
      advance(1000);
      expect(appHeight()).toBe(`${DOWN}px`); // released: nothing is waiting on a picker
    };

    // A toast is the whole outcome of a press on a tab with no terminal pane, for BOTH
    // footer actions: nothing opens, so nothing may hold the layout.
    it.each(
      (['editor', 'markdown', 'web'] as const).flatMap((kind) =>
        (['uploadFile', 'uploadImages'] as const).map((action) => [kind, action] as const),
      ),
    )('with a %s tab showing (%s)', (kind, action) => {
      paneApiFake.enabled = true;
      mountMobile(UP);
      send({
        type: 'sessions',
        tabs: [
          { id: '0', kind: 'terminal' },
          { id: '1', kind, url: kind === 'web' ? 'https://example.com' : '/tmp/a.md' },
        ],
      });
      send({ type: 'tabCreated', id: '1' }); // the window is now showing that tab
      expect(screen.queryByTestId('term-pane-a')).toBeNull();
      attempt(action);
      expect(document.querySelector('.toast.show')?.textContent).toBe(
        'Open a terminal tab to upload',
      );
    });

    it.each(['uploadFile', 'uploadImages'] as const)(
      'with an input that is unavailable (%s)',
      (action) => {
        paneApiFake.enabled = true;
        paneApiFake.launches = false;
        mountMobile(UP);
        attempt(action);
      },
    );
  });
});

// The drawer drags a row to a PLACE in a two-level tree, and App turns the drop into
// what the server already speaks: one `groupUpdate` when membership changes (it moves
// the tab and its group in one atomic message), one `reorderTabs` otherwise, and the
// list updated optimistically with the same order the server will broadcast.
describe('the drawer tree commits drops through moveTabInTree / moveGroupInTree', () => {
  const G = { id: 'gaa111', color: 'blue', name: 'g' };
  // Strip: 0 · [G: 1 2] · 3
  const mountTree = () => {
    localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'on' }));
    render(<App />);
    sendGroups(
      [{ id: '0' }, { id: '1', groupId: G.id }, { id: '2', groupId: G.id }, { id: '3' }],
      [G],
    );
  };
  const rows = () =>
    screen.getAllByTestId(/^drawer-session-/).map((r) => r.dataset['testid']!.slice(15));
  const moveTab = (id: string, drop: DrawerDrop) => act(() => drawer().onMoveTab?.(id, drop));
  const moveGroup = (gid: string, drop: DrawerDrop) => act(() => drawer().onMoveGroup?.(gid, drop));
  const nothingSent = () => {
    expect(server().reorders).toEqual([]);
    expect(server().groupUpdates).toEqual([]);
  };

  it('a tab dropped inside a group header joins it as the last member', () => {
    mountTree();
    moveTab('3', { target: `g:${G.id}`, position: 'inside' });
    expect(server().groupUpdates).toEqual([
      { id: G.id, addIds: ['3'], order: ['0', '1', '2', '3'] },
    ]);
    expect(server().reorders).toEqual([]);
  });

  // The optimistic list carries the membership too, not just the order: the NEXT
  // drop is resolved against it before any broadcast arrives.
  it('applies the join optimistically, so the next drop sees the tab as a member', () => {
    mountTree();
    moveTab('3', { target: `g:${G.id}`, position: 'inside' });
    moveTab('3', { target: 't:0', position: 'before' }); // out of the group again
    expect(server().groupUpdates).toEqual([
      { id: G.id, addIds: ['3'], order: ['0', '1', '2', '3'] },
      { id: G.id, removeIds: ['3'], order: ['3', '0', '1', '2'] },
    ]);
  });

  it('applies a leave optimistically, so the tab can rejoin at once', () => {
    mountTree();
    moveTab('1', { target: 't:3', position: 'before' });
    moveTab('1', { target: `g:${G.id}`, position: 'inside' });
    expect(server().groupUpdates).toEqual([
      { id: G.id, removeIds: ['1'], order: ['0', '2', '1', '3'] },
      { id: G.id, addIds: ['1'], order: ['0', '2', '1', '3'] },
    ]);
  });

  it('a tab dropped between two members joins at that spot', () => {
    mountTree();
    moveTab('0', { target: 't:2', position: 'before' });
    expect(server().groupUpdates).toEqual([
      { id: G.id, addIds: ['0'], order: ['1', '0', '2', '3'] },
    ]);
    expect(rows()).toEqual(['1', '0', '2', '3']); // optimistic, before any broadcast
  });

  it('a tab dropped among the top-level rows leaves its group', () => {
    mountTree();
    moveTab('1', { target: 't:3', position: 'before' });
    expect(server().groupUpdates).toEqual([
      { id: G.id, removeIds: ['1'], order: ['0', '2', '1', '3'] },
    ]);
    expect(rows()).toEqual(['0', '2', '1', '3']);
  });

  it('a tab dropped on the root area leaves its group for the end of the top level', () => {
    mountTree();
    moveTab('1', { target: null, position: 'inside' });
    expect(server().groupUpdates).toEqual([
      { id: G.id, removeIds: ['1'], order: ['0', '2', '3', '1'] },
    ]);
  });

  it('moving between groups sends only the join: the server takes it out of the old one', () => {
    localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'on' }));
    const H = { id: 'gbb222', color: 'green', name: 'h' };
    render(<App />);
    sendGroups([{ id: '0', groupId: G.id }, { id: '1', groupId: H.id }, { id: '2' }], [G, H]);
    moveTab('0', { target: `g:${H.id}`, position: 'inside' });
    expect(server().groupUpdates).toEqual([{ id: H.id, addIds: ['0'], order: ['1', '0', '2'] }]);
  });

  it('a plain move is one reorderTabs and no group message', () => {
    mountTree();
    moveTab('3', { target: 't:0', position: 'before' });
    expect(server().reorders).toEqual([['3', '0', '1', '2']]);
    expect(server().groupUpdates).toEqual([]);
    expect(rows()).toEqual(['3', '0', '1', '2']);
  });

  it('a tab dropped before a group header lands outside the group, before the whole block', () => {
    mountTree();
    moveTab('3', { target: `g:${G.id}`, position: 'before' });
    expect(server().reorders).toEqual([['0', '3', '1', '2']]);
  });

  it('a group header moves as a block, in one reorderTabs', () => {
    mountTree();
    moveGroup(G.id, { target: 't:3', position: 'after' });
    expect(server().reorders).toEqual([['0', '3', '1', '2']]);
    expect(server().groupUpdates).toEqual([]);
    expect(rows()).toEqual(['0', '3', '1', '2']);
  });

  it('sends nothing for a drop that changes nothing', () => {
    mountTree();
    moveTab('0', { target: `g:${G.id}`, position: 'before' }); // where it already is
    moveTab('3', { target: 't:3', position: 'after' }); // onto itself
    moveTab('2', { target: `g:${G.id}`, position: 'inside' }); // already its group's last member
    moveTab('3', { target: null, position: 'inside' }); // already last at the top level
    moveGroup(G.id, { target: 't:0', position: 'after' }); // where the block already is
    moveGroup(G.id, { target: 't:2', position: 'before' }); // into itself
    nothingSent();
    expect(rows()).toEqual(['0', '1', '2', '3']);
  });

  // Inside a header is "as the group's LAST member" and the root is "the END of the top
  // level", so either is a move for a node not already there — even within the parent
  // it already has. The DGSL tree refused both; the palmux contract does not.
  it('moves a member to the end of its own group, and a top-level tab to the end of the list', () => {
    mountTree(); // 0 · [G: 1 2] · 3
    moveTab('1', { target: `g:${G.id}`, position: 'inside' });
    expect(server().reorders).toEqual([['0', '2', '1', '3']]);
    moveTab('0', { target: null, position: 'inside' });
    expect(server().reorders).toEqual([
      ['0', '2', '1', '3'],
      ['2', '1', '3', '0'],
    ]);
    expect(server().groupUpdates).toEqual([]);
    expect(rows()).toEqual(['2', '1', '3', '0']);
  });

  // A drag outlives other windows' edits: by the time it lands, the tab or the group
  // it names may be gone.
  it('ignores a drop that names a tab or group the broadcast no longer has', () => {
    mountTree();
    moveTab('9', { target: 't:0', position: 'before' });
    moveTab('3', { target: 't:9', position: 'before' });
    moveTab('3', { target: 'g:gzz999', position: 'inside' });
    moveGroup('gzz999', { target: 't:0', position: 'before' });
    nothingSent();
  });

  it('refuses a group inside a group and a tab inside a tab', () => {
    mountTree();
    moveGroup(G.id, { target: `g:${G.id}`, position: 'inside' });
    moveTab('3', { target: 't:0', position: 'inside' });
    nothingSent();
  });

  // The cases below are where a tree with ONE level of nesting is easy to get wrong:
  // the header is a place beside a whole block, and the root is a place only a list
  // with no top-level row left still has.
  describe('against headers and the root', () => {
    const H = { id: 'gbb222', color: 'green', name: 'h' };
    const mountWith = (
      tabs: Array<{ id: string; groupId?: string }>,
      groups: Array<{ id: string; color: string; name?: string }>,
    ) => {
      localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'on' }));
      render(<App />);
      sendGroups(tabs, groups);
    };

    it('a top-level tab dropped after a group header lands after the whole block', () => {
      mountTree(); // 0 · [G: 1 2] · 3
      moveTab('0', { target: `g:${G.id}`, position: 'after' });
      expect(server().reorders).toEqual([['1', '2', '0', '3']]);
      expect(server().groupUpdates).toEqual([]);
    });

    it('a member dropped beside its own header leaves its group, wherever the order lands', () => {
      mountTree();
      // 1 is the first member: before the header it is already first, so only the
      // membership moves. A drop that changes membership is never a no-op.
      moveTab('1', { target: `g:${G.id}`, position: 'before' });
      expect(server().groupUpdates).toEqual([
        { id: G.id, removeIds: ['1'], order: ['0', '1', '2', '3'] },
      ]);
      expect(server().reorders).toEqual([]);
      expect(rows()).toEqual(['0', '1', '2', '3']);
    });

    it('a member dropped after its own header lands after the block, outside it', () => {
      mountTree();
      moveTab('1', { target: `g:${G.id}`, position: 'after' });
      expect(server().groupUpdates).toEqual([
        { id: G.id, removeIds: ['1'], order: ['0', '2', '1', '3'] },
      ]);
    });

    it('a member of one group dropped beside another group header leaves for the top level', () => {
      mountWith(
        [
          { id: '0' },
          { id: '1', groupId: G.id },
          { id: '2', groupId: G.id },
          { id: '3', groupId: H.id },
          { id: '4', groupId: H.id },
          { id: '5' },
        ],
        [G, H],
      );
      moveTab('1', { target: `g:${H.id}`, position: 'before' });
      expect(server().groupUpdates).toEqual([
        { id: G.id, removeIds: ['1'], order: ['0', '2', '1', '3', '4', '5'] },
      ]);
    });

    // Every tab is a member, so no top-level row exists to drop beside: the root area
    // is the only way out, and the DGSL tree keeps it for exactly this list.
    it('ungroups through the root when EVERY tab is grouped', () => {
      mountWith(
        [
          { id: '0', groupId: G.id },
          { id: '1', groupId: G.id },
          { id: '2', groupId: G.id },
        ],
        [G],
      );
      moveTab('1', { target: null, position: 'inside' });
      expect(server().groupUpdates).toEqual([
        { id: G.id, removeIds: ['1'], order: ['0', '2', '1'] },
      ]);
      expect(server().reorders).toEqual([]);
    });

    it('leaves the only group: its last member dropped on the root', () => {
      mountWith([{ id: '0' }, { id: '1', groupId: G.id }, { id: '2' }, { id: '3' }], [G]);
      moveTab('1', { target: null, position: 'inside' });
      expect(server().groupUpdates).toEqual([
        { id: G.id, removeIds: ['1'], order: ['0', '2', '3', '1'] },
      ]);
    });

    // With the only member gone from the order, its group has no span left: its header
    // sat where the tab was, and a drop beside that header ungroups it right there.
    it.each(['before', 'after'] as const)(
      'ungroups the only member dropped %s its own group header, in place',
      (position) => {
        mountWith([{ id: '0' }, { id: '1', groupId: G.id }, { id: '2' }, { id: '3' }], [G]);
        moveTab('1', { target: `g:${G.id}`, position });
        expect(server().groupUpdates).toEqual([
          { id: G.id, removeIds: ['1'], order: ['0', '1', '2', '3'] },
        ]);
        expect(server().reorders).toEqual([]);
      },
    );

    it('refuses a drop inside the group the only member already holds', () => {
      mountWith([{ id: '0' }, { id: '1', groupId: G.id }, { id: '2' }], [G]);
      moveTab('1', { target: `g:${G.id}`, position: 'inside' });
      nothingSent();
    });

    describe('a group block', () => {
      // 0 · [G: 1 2] · [H: 3 4] · 5
      const mountBlocks = () =>
        mountWith(
          [
            { id: '0' },
            { id: '1', groupId: G.id },
            { id: '2', groupId: G.id },
            { id: '3', groupId: H.id },
            { id: '4', groupId: H.id },
            { id: '5' },
          ],
          [G, H],
        );

      it('moves before another group as a whole, in one reorderTabs', () => {
        mountBlocks();
        moveGroup(H.id, { target: `g:${G.id}`, position: 'before' });
        expect(server().reorders).toEqual([['0', '3', '4', '1', '2', '5']]);
        expect(server().groupUpdates).toEqual([]);
        expect(rows()).toEqual(['0', '3', '4', '1', '2', '5']);
      });

      it('moves after another group as a whole', () => {
        mountBlocks();
        moveGroup(G.id, { target: `g:${H.id}`, position: 'after' });
        expect(server().reorders).toEqual([['0', '3', '4', '1', '2', '5']]);
      });

      // The root is the END of the top level, for a block as for a tab: it moves a block
      // that is not last there yet, and refuses one that already is. (The DGSL tree
      // refused every top-level node on the root; the palmux contract gives it a place.)
      it('goes to the end through the root area, and stays put once it is last', () => {
        mountBlocks();
        moveGroup(G.id, { target: null, position: 'inside' });
        expect(server().reorders).toEqual([['0', '3', '4', '5', '1', '2']]);
        expect(rows()).toEqual(['0', '3', '4', '5', '1', '2']);
        moveGroup(G.id, { target: null, position: 'inside' }); // now the last node
        expect(server().reorders).toHaveLength(1);
        expect(server().groupUpdates).toEqual([]);
      });

      it('is refused beside a member of another group: a group cannot nest', () => {
        mountBlocks();
        moveGroup(G.id, { target: 't:3', position: 'before' });
        moveGroup(G.id, { target: 't:4', position: 'after' });
        nothingSent();
      });
    });
  });

  // A `sessions` broadcast only queues its list; React draws it later. A drop that
  // lands in between used to be resolved against the list on screen and then
  // REBUILT the newer one from that answer alone, so a tab the broadcast brought
  // vanished, and a membership the broadcast changed was overwritten, with nothing
  // from the server to put either back (it already holds the order it was sent).
  describe('against a broadcast that has not rendered yet', () => {
    const H = { id: 'gbb222', color: 'green', name: 'h' };
    /** What App holds: each tab with its group, in order. */
    const held = () => drawer().tabs.map((t) => [t.id, t.groupId ?? null]);
    const tabsOf = (spec: Array<[string, string?]>) =>
      spec.map(([id, groupId]) => ({ id, kind: 'terminal', ...(groupId ? { groupId } : {}) }));

    it('a tab the broadcast brought survives a drop, in the order the server makes', () => {
      mountTree(); // 0 · [G: 1 2] · 3
      act(() => {
        server().handler!({
          type: 'sessions',
          tabs: tabsOf([['0'], ['1', G.id], ['2', G.id], ['3'], ['4']]),
          groups: [G],
        });
        drawer().onMoveTab?.('3', { target: 't:0', position: 'before' });
      });
      expect(server().reorders).toEqual([['3', '0', '1', '2', '4']]);
      expect(rows()).toEqual(['3', '0', '1', '2', '4']);
    });

    it('a second drop before the next render is resolved against the first', () => {
      mountTree();
      act(() => {
        drawer().onMoveTab?.('3', { target: `g:${G.id}`, position: 'inside' });
        drawer().onMoveTab?.('3', { target: 't:0', position: 'before' }); // straight out again
      });
      expect(server().groupUpdates).toEqual([
        { id: G.id, addIds: ['3'], order: ['0', '1', '2', '3'] },
        { id: G.id, removeIds: ['3'], order: ['3', '0', '1', '2'] },
      ]);
      expect(held()).toEqual([
        ['3', null],
        ['0', null],
        ['1', G.id],
        ['2', G.id],
      ]);
    });

    // The groups travel in the same broadcast as the tabs, and a drop is checked
    // against both: a group the broadcast made is a place to drop before it renders,
    // and one it removed is not.
    it('a group the broadcast brought is a valid target before it renders', () => {
      mountTree(); // 0 · [G: 1 2] · 3
      act(() => {
        server().handler!({
          type: 'sessions',
          tabs: tabsOf([['0'], ['1', G.id], ['2', G.id], ['3'], ['4', H.id], ['5', H.id]]),
          groups: [G, H],
        });
        drawer().onMoveTab?.('3', { target: `g:${H.id}`, position: 'inside' });
      });
      expect(server().groupUpdates).toEqual([
        { id: H.id, addIds: ['3'], order: ['0', '1', '2', '4', '5', '3'] },
      ]);
      expect(held()).toEqual([
        ['0', null],
        ['1', G.id],
        ['2', G.id],
        ['4', H.id],
        ['5', H.id],
        ['3', H.id],
      ]);
    });

    it('a group the broadcast removed is refused before it renders, and nothing is sent', () => {
      mountTree(); // 0 · [G: 1 2] · 3
      act(() => {
        server().handler!({
          type: 'sessions',
          tabs: tabsOf([['0'], ['1'], ['2'], ['3']]),
          groups: [],
        });
        drawer().onMoveTab?.('3', { target: `g:${G.id}`, position: 'inside' });
      });
      nothingSent();
      expect(held()).toEqual([
        ['0', null],
        ['1', null],
        ['2', null],
        ['3', null],
      ]);
    });

    it('a tab another window closed is refused before it renders, and nothing is sent', () => {
      mountTree();
      act(() => {
        server().handler!({
          type: 'sessions',
          tabs: tabsOf([['0'], ['1', G.id], ['2', G.id]]),
          groups: [G],
        });
        drawer().onMoveTab?.('3', { target: 't:0', position: 'before' });
      });
      nothingSent();
    });

    describe('moving a whole group', () => {
      it('keeps the tab the broadcast brought, in the order the server makes', () => {
        mountTree(); // 0 · [G: 1 2] · 3
        act(() => {
          server().handler!({
            type: 'sessions',
            tabs: tabsOf([['0'], ['1', G.id], ['2', G.id], ['3'], ['4']]),
            groups: [G],
          });
          drawer().onMoveGroup?.(G.id, { target: 't:0', position: 'before' });
        });
        expect(server().reorders).toEqual([['1', '2', '0', '3', '4']]);
        expect(held().map(([id]) => id)).toEqual(['1', '2', '0', '3', '4']);
      });

      it('resolves against the broadcast even when a render ran without it', () => {
        mountTree();
        act(() => {
          server().handler!({
            type: 'sessions',
            tabs: tabsOf([['0'], ['1', G.id], ['2', G.id], ['3'], ['4']]),
            groups: [G],
          });
          flushSync(() => drawer().onTabMenu('0'));
          drawer().onMoveGroup?.(G.id, { target: 't:0', position: 'before' });
        });
        expect(server().reorders).toEqual([['1', '2', '0', '3', '4']]);
        expect(held().map(([id]) => id)).toEqual(['1', '2', '0', '3', '4']);
      });

      it('a second block drop before the next render is resolved against the first', () => {
        mountTree();
        act(() => {
          drawer().onMoveGroup?.(G.id, { target: null, position: 'inside' }); // to the end
          drawer().onMoveGroup?.(G.id, { target: 't:0', position: 'before' }); // and back
        });
        expect(server().reorders).toEqual([
          ['0', '3', '1', '2'],
          ['1', '2', '0', '3'],
        ]);
        expect(held().map(([id]) => id)).toEqual(['1', '2', '0', '3']);
      });
    });

    // A pointer event renders at a higher priority than a socket message, so a
    // render can run that leaves the queued broadcast out. That render must not
    // hand the drop the list it drew: the snapshot is written by what changes the
    // list (a broadcast, a drop), never by a render, so it cannot move back to an
    // older one. `flushSync` is that render; any App state would do, and opening a
    // row's menu fetches nothing.
    describe('when a render ran without it', () => {
      it('still resolves the drop against the broadcast, the tab it brought included', () => {
        mountTree();
        act(() => {
          server().handler!({
            type: 'sessions',
            tabs: tabsOf([['0'], ['1', G.id], ['2', G.id], ['3'], ['4']]),
            groups: [G],
          });
          flushSync(() => drawer().onTabMenu('0'));
          drawer().onMoveTab?.('3', { target: 't:0', position: 'before' });
        });
        expect(server().reorders).toEqual([['3', '0', '1', '2', '4']]);
        expect(held().map(([id]) => id)).toEqual(['3', '0', '1', '2', '4']);
      });

      it('resolves a membership change against the group the broadcast moved the tab into', () => {
        localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'on' }));
        render(<App />);
        sendGroups(
          [
            { id: '0' },
            { id: '1', groupId: G.id },
            { id: '2', groupId: G.id },
            { id: '3', groupId: H.id },
          ],
          [G, H],
        );
        act(() => {
          // Another window moved 2 from G into H.
          server().handler!({
            type: 'sessions',
            tabs: tabsOf([['0'], ['1', G.id], ['3', H.id], ['2', H.id]]),
            groups: [G, H],
          });
          flushSync(() => drawer().onTabMenu('0'));
          // To the top level: out of H, where 2 now is, not out of G.
          drawer().onMoveTab?.('2', { target: null, position: 'inside' });
        });
        expect(server().groupUpdates).toEqual([
          { id: H.id, removeIds: ['2'], order: ['0', '1', '3', '2'] },
        ]);
        expect(held()).toEqual([
          ['0', null],
          ['1', G.id],
          ['3', H.id],
          ['2', null],
        ]);
      });

      it('a group the broadcast brought is still a target', () => {
        mountTree(); // 0 · [G: 1 2] · 3
        act(() => {
          server().handler!({
            type: 'sessions',
            tabs: tabsOf([['0'], ['1', G.id], ['2', G.id], ['3'], ['4', H.id]]),
            groups: [G, H],
          });
          flushSync(() => drawer().onTabMenu('0'));
          drawer().onMoveTab?.('3', { target: `g:${H.id}`, position: 'inside' });
        });
        expect(server().groupUpdates).toEqual([
          { id: H.id, addIds: ['3'], order: ['0', '1', '2', '4', '3'] },
        ]);
      });
    });

    // The close-navigation decision needs the list as it was BEFORE the
    // broadcast, so the snapshot moves only after it has run.
    it('still navigates a closed active tab to its left neighbour', () => {
      mountTree();
      act(() => drawer().onSwitch('2'));
      sendGroups([{ id: '0' }, { id: '1', groupId: G.id }, { id: '3' }], [G]);
      expect(drawer().current).toBe('1');
    });
  });
});

// `--ctl-h` grows under `:root[data-mobile='true']`, and the attribute has to come
// from the SAME resolved value as `.app.mobile`: the scale cannot use a media query
// because auto mode reads `maxTouchPoints`, not the pointer type. It lives on <html>
// so Radix content portalled outside `.app` inherits it.
describe('data-mobile on the document root', () => {
  const root = () => document.documentElement;
  const mount = (mobileMode: 'on' | 'off') => {
    localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode }));
    const view = render(<App />);
    broadcast(['0']);
    return view;
  };

  it("is set while mobileMode is 'on', beside the .app.mobile class", () => {
    mount('on');
    expect(root().dataset.mobile).toBe('true');
    expect(document.querySelector('.app')).toHaveClass('mobile');
  });

  it("is absent while mobileMode is 'off'", () => {
    mount('off');
    expect(root().dataset.mobile).toBeUndefined();
    expect(document.querySelector('.app')).not.toHaveClass('mobile');
  });

  it('is removed when the app unmounts', () => {
    const { unmount } = mount('on');
    expect(root().dataset.mobile).toBe('true');
    unmount();
    expect(root().dataset.mobile).toBeUndefined();
  });
});

// The same attribute has to follow what actually decides the layout. `auto` is
// the case a media query could not serve: it resolves from `maxTouchPoints`, not
// from the pointer type, so a touch laptop with a fine pointer is a mobile layout.
describe('data-mobile follows the resolved mobile mode', () => {
  const root = () => document.documentElement;
  const touchPoints = (n: number) =>
    Object.defineProperty(navigator, 'maxTouchPoints', { value: n, configurable: true });
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'maxTouchPoints');
  });

  it("'auto' on a touch device sets it, beside the .app.mobile class", () => {
    touchPoints(5);
    localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'auto' }));
    render(<App />);
    broadcast(['0']);
    expect(document.querySelector('.app')).toHaveClass('mobile');
    expect(root().dataset.mobile).toBe('true');
  });

  it("'auto' on a device with no touch points leaves it off", () => {
    touchPoints(0);
    localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'auto' }));
    render(<App />);
    broadcast(['0']);
    expect(document.querySelector('.app')).not.toHaveClass('mobile');
    expect(root().dataset.mobile).toBeUndefined();
  });

  // The effect depends on the resolved value, so a change made while the app is
  // mounted has to add AND remove the attribute, not just set it at boot. Both
  // ways go through the real Settings field: the dock on desktop, the drawer
  // once the layout is mobile.
  it('is added and removed live when the setting changes under a mounted app', () => {
    localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'off' }));
    render(<App />);
    broadcast(['0']);
    expect(root().dataset.mobile).toBeUndefined();

    fireEvent.keyDown(window, { key: ',', ctrlKey: true }); // Settings, in the dock
    fireEvent.click(screen.getByTestId('set-mobile-on'));
    expect(document.querySelector('.app')).toHaveClass('mobile');
    expect(root().dataset.mobile).toBe('true');

    fireEvent.keyDown(window, { key: ',', ctrlKey: true }); // Settings, in the drawer
    fireEvent.click(screen.getByTestId('set-mobile-off'));
    expect(document.querySelector('.app')).not.toHaveClass('mobile');
    expect(root().dataset.mobile).toBeUndefined();
  });
});

// The pop-out's only control. The ⇱ character is the external icon now, the label
// stays beside it, and the dead-opener state still reads as plain text.
describe('pop-out return button', () => {
  const openerAlive = (alive: boolean) =>
    Object.defineProperty(window, 'opener', {
      value: alive ? { closed: false, postMessage: vi.fn() } : null,
      configurable: true,
    });
  afterEach(() => {
    Reflect.deleteProperty(window, 'opener');
  });

  it('wears the external icon beside its label while the main window is open', () => {
    openerAlive(true);
    history.replaceState(null, '', '/popout/0');
    render(<App />);
    const button = screen.getByTestId('popout-return');
    expect(button).not.toBeDisabled();
    expect(button).toHaveTextContent(/^return to main$/);
    expect(button.querySelectorAll('svg')).toHaveLength(1);
    expect(button.querySelector('svg')?.innerHTML).toBe(iconPaths('external'));
    expect(button).toHaveAttribute('title', 'Return this tab to the main window');
  });

  it('is plain disabled text once the main window is gone', () => {
    openerAlive(false);
    history.replaceState(null, '', '/popout/0');
    render(<App />);
    const button = screen.getByTestId('popout-return');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('main window closed');
    expect(button.querySelector('svg')).toBeNull();
  });
});

// The topbar leads with an app menu, not the wordmark. It is the pointer route to
// Settings once the rail is hidden, and the one place Reload app can be reached
// without opening a panel — so it carries the same discard guard Settings does.
const openMenu = () => userEvent.click(screen.getByTestId('app-menu-button'));
/** The dock's Settings view, and the Reload row inside it. */
const openSettingsRow = async () => {
  fireEvent.click(screen.getByTestId('dock-rail-settings'));
  return screen.findByTestId('reload-app');
};

describe('app menu', () => {
  const EDITOR_TABS = [
    { id: '0', kind: 'terminal' },
    { id: '3', kind: 'editor', url: '/tmp/notes.md' },
  ];
  /** A broadcast holding an editor tab that reports unsaved text. */
  const withDirtyEditor = () => {
    render(<App />);
    send({ type: 'sessions', tabs: EDITOR_TABS });
    act(() => paneHost.onDirtyChange?.('3', true));
  };
  let confirm: MockInstance<typeof window.confirm>;
  beforeEach(() => {
    reloadApp.mockClear();
    confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    // Opening the dock's Settings view mounts ConfigEditor, which fetches
    // `/config-file`. Unstubbed, happy-dom sends that to a real localhost port.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 503 })),
    );
  });
  afterEach(() => {
    confirm.mockRestore();
    vi.unstubAllGlobals();
  });

  it('replaces the palmux wordmark in the topbar', () => {
    setup();
    const topbar = document.querySelector('.topbar');
    expect(topbar?.querySelector('.topbar-brand')).toBeNull();
    expect(topbar?.textContent).not.toMatch(/^palmux/);
    const button = screen.getByTestId('app-menu-button');
    expect(button).toHaveAttribute('aria-label', 'palmux menu');
    expect(button.querySelector('svg')?.innerHTML).toBe(iconPaths('menu'));
    expect(topbar?.firstElementChild).toBe(button);
  });

  it('offers Settings, Tips and Reload app', async () => {
    setup();
    await openMenu();
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Settings',
      'Tips',
      'Reload app',
    ]);
  });

  it('opens Settings with the rail hidden', async () => {
    localStorage.setItem(
      'palmux-settings',
      JSON.stringify({ mobileMode: 'off', sidebarRail: 'hidden' }),
    );
    setup();
    expect(screen.queryByTestId('dock-rail')).toBeNull();
    expect(screen.queryByTestId('dock')).toBeNull();

    await openMenu();
    await userEvent.click(screen.getByTestId('app-menu-settings'));

    expect(screen.getByTestId('dock')).toHaveAttribute('data-view', 'settings');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens the tips panel', async () => {
    setup();
    await openMenu();
    await userEvent.click(screen.getByTestId('app-menu-tips'));
    expect(screen.getByRole('dialog', { name: 'Shortcuts & tips' })).toBeInTheDocument();
  });

  // With the rail showing, Settings from the menu must land where the keybinding
  // does: the dock on the settings view, replacing whatever view it held.
  it('switches the dock to Settings from another view, as the keybinding does', async () => {
    setup();
    fireEvent.click(screen.getByTestId('dock-rail-files'));
    expect(screen.getByTestId('dock')).toHaveAttribute('data-view', 'files');
    await openMenu();
    await userEvent.click(screen.getByTestId('app-menu-settings'));
    expect(screen.getByTestId('dock')).toHaveAttribute('data-view', 'settings');

    fireEvent.click(screen.getByTestId('dock-rail-files'));
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    expect(screen.getByTestId('dock')).toHaveAttribute('data-view', 'settings');
  });

  // The strip scrolls horizontally when tabs overflow. A menu button inside it
  // would scroll away with the first pills, and the spec keeps it reachable.
  it('sits outside the scrolling tab strip', () => {
    setup(['0', '1', '2', '3', '4', '5', '6', '7', '8']);
    expect(screen.getByTestId('session-tabs')).not.toContainElement(
      screen.getByTestId('app-menu-button'),
    );
  });

  // The menu is the desktop window's control. The pop-out is chrome-less on
  // purpose and keeps its brand; the mobile layer has no topbar at all (its route
  // to Settings is the drawer).
  it('is absent from the pop-out bar, which keeps its brand', () => {
    history.replaceState(null, '', '/popout/0');
    render(<App />);
    expect(screen.queryByTestId('app-menu-button')).toBeNull();
    expect(document.querySelector('.popout-bar .topbar-brand')).toHaveTextContent(/^palmux$/);
    expect(document.querySelector('.topbar')).toBeNull();
  });

  it('is absent on the mobile layer, which has no desktop topbar', () => {
    localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'on' }));
    setup();
    expect(document.querySelector('.app')).toHaveClass('mobile');
    expect(screen.queryByTestId('app-menu-button')).toBeNull();
    expect(document.querySelector('.topbar')).toBeNull();
  });

  describe('Reload app', () => {
    it('reloads without asking when no editor has unsaved text', async () => {
      setup(['0', '1']);
      await openMenu();
      await userEvent.click(screen.getByTestId('app-menu-reload'));
      expect(confirm).not.toHaveBeenCalled();
      expect(reloadApp).toHaveBeenCalledTimes(1);
    });

    it('does not count a dirty flag on a tab that is not an editor', async () => {
      render(<App />);
      send({
        type: 'sessions',
        tabs: [
          { id: '0', kind: 'terminal' },
          { id: '4', kind: 'web' },
        ],
      });
      act(() => paneHost.onDirtyChange?.('4', true));
      await openMenu();
      await userEvent.click(screen.getByTestId('app-menu-reload'));
      expect(confirm).not.toHaveBeenCalled();
      expect(reloadApp).toHaveBeenCalledTimes(1);
    });

    it('asks first when an editor tab has unsaved changes, and cancel keeps the page', async () => {
      withDirtyEditor();
      confirm.mockReturnValue(false);
      await openMenu();
      await userEvent.click(screen.getByTestId('app-menu-reload'));
      expect(confirm).toHaveBeenCalledWith(
        '1 editor tab has unsaved changes. Reload and discard them?',
      );
      expect(reloadApp).not.toHaveBeenCalled();
    });

    it('reloads once the discard is accepted', async () => {
      withDirtyEditor();
      await openMenu();
      await userEvent.click(screen.getByTestId('app-menu-reload'));
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(reloadApp).toHaveBeenCalledTimes(1);
    });

    it('counts every dirty editor tab, and forgets one that was saved', async () => {
      render(<App />);
      send({
        type: 'sessions',
        tabs: [
          { id: '0', kind: 'terminal' },
          { id: '3', kind: 'editor', url: '/tmp/a.md' },
          { id: '5', kind: 'editor', url: '/tmp/b.md' },
        ],
      });
      act(() => {
        paneHost.onDirtyChange?.('3', true);
        paneHost.onDirtyChange?.('5', true);
      });
      confirm.mockReturnValue(false);
      await openMenu();
      await userEvent.click(screen.getByTestId('app-menu-reload'));
      expect(confirm).toHaveBeenLastCalledWith(
        '2 editor tabs have unsaved changes. Reload and discard them?',
      );

      act(() => {
        paneHost.onDirtyChange?.('3', false);
        paneHost.onDirtyChange?.('5', false);
      });
      await openMenu();
      await userEvent.click(screen.getByTestId('app-menu-reload'));
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(reloadApp).toHaveBeenCalledTimes(1);
    });

    // A dirty flag outlives its tab unless something prunes it, and ids are
    // recycled lowest-free: a closed editor's flag must not make a reload ask about
    // text that no longer exists, nor follow the id onto a brand-new tab.
    it('forgets an editor that was closed elsewhere, even when its id comes back', async () => {
      withDirtyEditor();
      send({ type: 'sessions', tabs: [{ id: '0', kind: 'terminal' }] });
      await openMenu();
      await userEvent.click(screen.getByTestId('app-menu-reload'));
      expect(confirm).not.toHaveBeenCalled();
      expect(reloadApp).toHaveBeenCalledTimes(1);

      send({ type: 'sessions', tabs: EDITOR_TABS }); // id 3 is an editor again, clean
      await openMenu();
      await userEvent.click(screen.getByTestId('app-menu-reload'));
      expect(confirm).not.toHaveBeenCalled();
      expect(reloadApp).toHaveBeenCalledTimes(2);
    });

    // The guard is about EDITORS: the menu must not ask about a kind that cannot
    // hold unsaved text even while a real dirty editor sits beside it.
    it('counts only the editors when other kinds are flagged dirty beside them', async () => {
      render(<App />);
      send({
        type: 'sessions',
        tabs: [
          { id: '0', kind: 'terminal' },
          { id: '3', kind: 'editor', url: '/tmp/notes.md' },
          { id: '4', kind: 'web' },
        ],
      });
      act(() => {
        paneHost.onDirtyChange?.('3', true);
        paneHost.onDirtyChange?.('4', true);
      });
      confirm.mockReturnValue(false);
      await openMenu();
      await userEvent.click(screen.getByTestId('app-menu-reload'));
      expect(confirm).toHaveBeenCalledWith(
        '1 editor tab has unsaved changes. Reload and discard them?',
      );
    });

    // The Settings row had no guard at all: it called reloadApp() itself.
    describe('from the Settings row', () => {
      it('asks first, and a cancel leaves the row usable for a retry without a remount', async () => {
        withDirtyEditor();
        const row = await openSettingsRow();
        confirm.mockReturnValueOnce(false);

        await userEvent.click(row);
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(confirm).toHaveBeenCalledWith(
          '1 editor tab has unsaved changes. Reload and discard them?',
        );
        expect(reloadApp).not.toHaveBeenCalled();
        expect(screen.getByTestId('reload-app')).toBe(row);
        expect(row).not.toBeDisabled();
        expect(row).toHaveTextContent('Reload');

        await userEvent.click(row);
        expect(confirm).toHaveBeenCalledTimes(2);
        expect(reloadApp).toHaveBeenCalledTimes(1);
        expect(row).toBeDisabled();
        expect(row).toHaveTextContent('Reloading…');
      });

      it('reloads without asking when nothing is unsaved', async () => {
        setup(['0', '1']);
        const row = await openSettingsRow();
        await userEvent.click(row);
        expect(confirm).not.toHaveBeenCalled();
        expect(reloadApp).toHaveBeenCalledTimes(1);
        expect(row).toHaveTextContent('Reloading…');
      });

      // Settings has two hosts, and the phone's is the drawer. Editor tabs are
      // first-class there, so a row that fell back to the unguarded reload would
      // discard the same unsaved text the dock's row protects.
      it('asks first from the mobile drawer too', async () => {
        localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'on' }));
        withDirtyEditor();
        fireEvent.keyDown(window, { key: ',', ctrlKey: true }); // Settings, in the drawer
        const row = await screen.findByTestId('reload-app');
        expect(screen.getByTestId('drawer-settings-body')).toContainElement(row);
        confirm.mockReturnValueOnce(false);

        await userEvent.click(row);
        expect(confirm).toHaveBeenCalledWith(
          '1 editor tab has unsaved changes. Reload and discard them?',
        );
        expect(reloadApp).not.toHaveBeenCalled();

        await userEvent.click(row);
        expect(reloadApp).toHaveBeenCalledTimes(1);
      });
    });

    // Settings' Raw view holds its own buffer: config.json text that exists
    // nowhere else until a Save succeeds, and that stays alive hidden behind Form.
    // The guard counted editor TABS only, so a reload discarded it without a word.
    describe('with an unsaved raw config.json', () => {
      const STORED = '{"port": 44040}';
      const CONFIG_ONLY = 'config.json has unsaved changes. Reload and discard them?';
      let putStatus = 200;
      beforeEach(() => {
        putStatus = 200;
        vi.stubGlobal(
          'fetch',
          vi.fn((url: string, init?: RequestInit) => {
            if (url !== '/config-file') return Promise.resolve({ ok: false, status: 503 });
            if (init?.method === 'PUT') {
              return Promise.resolve({
                ok: putStatus < 400,
                status: putStatus,
                json: () => Promise.resolve({ error: 'unknown key "prot"', line: 1 }),
              });
            }
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve({ text: STORED, path: '/cfg/config.json' }),
            });
          }),
        );
      });
      /** Open Settings, open Raw, wait for the file, then type `text` into it. */
      const editConfig = async (text = '{"port": 44041}') => {
        fireEvent.click(screen.getByTestId('dock-rail-settings'));
        await userEvent.click(screen.getByTestId('edit-config'));
        await screen.findByText(/^Valid JSON/);
        act(() => monacoFake.type(text));
      };
      const reloadFromMenu = async () => {
        await openMenu();
        await userEvent.click(screen.getByTestId('app-menu-reload'));
      };

      it('the app menu asks first, and a cancel keeps the page', async () => {
        setup(['0', '1']);
        await editConfig();
        confirm.mockReturnValue(false);
        await reloadFromMenu();
        expect(confirm).toHaveBeenCalledWith(CONFIG_ONLY);
        expect(reloadApp).not.toHaveBeenCalled();
      });

      it('the Settings row asks too, after Form hides the buffer, and stays usable', async () => {
        setup(['0', '1']);
        await editConfig();
        await userEvent.click(screen.getByTestId('config-back'));
        const row = await screen.findByTestId('reload-app');
        confirm.mockReturnValueOnce(false);

        await userEvent.click(row);
        expect(confirm).toHaveBeenCalledWith(CONFIG_ONLY);
        expect(reloadApp).not.toHaveBeenCalled();
        expect(row).not.toBeDisabled();
        expect(row).toHaveTextContent('Reload');

        await userEvent.click(row);
        expect(confirm).toHaveBeenCalledTimes(2);
        expect(reloadApp).toHaveBeenCalledTimes(1);
      });

      it('names it beside the dirty editor tabs in one confirm', async () => {
        withDirtyEditor();
        await editConfig();
        confirm.mockReturnValue(false);
        await reloadFromMenu();
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(confirm).toHaveBeenCalledWith(
          '1 editor tab and config.json have unsaved changes. Reload and discard them?',
        );
      });

      // The server refuses anything its boot parser would drop, and the text is
      // still only in the buffer — exactly the case the guard exists for.
      it('a rejected save leaves it unsaved', async () => {
        setup(['0', '1']);
        await editConfig();
        putStatus = 400;
        await userEvent.click(screen.getByTestId('config-save'));
        await screen.findByText(/unknown key "prot"/);
        confirm.mockReturnValue(false);
        await reloadFromMenu();
        expect(confirm).toHaveBeenCalledWith(CONFIG_ONLY);
        expect(reloadApp).not.toHaveBeenCalled();
      });

      it('a successful save makes it clean again', async () => {
        setup(['0', '1']);
        await editConfig();
        await userEvent.click(screen.getByTestId('config-save'));
        await screen.findByText('Saved · restart palmux to apply');
        await reloadFromMenu();
        expect(confirm).not.toHaveBeenCalled();
        expect(reloadApp).toHaveBeenCalledTimes(1);
      });

      it('text typed back to what the file holds is not unsaved', async () => {
        setup(['0', '1']);
        await editConfig();
        act(() => monacoFake.type(STORED));
        await reloadFromMenu();
        expect(confirm).not.toHaveBeenCalled();
        expect(reloadApp).toHaveBeenCalledTimes(1);
      });

      // Leaving Settings unmounts the editor, and its text goes with it: a flag
      // left behind would make the reload ask about a buffer that no longer exists.
      // Leaving asks once itself (the discard was accepted here); the reload does not.
      it('is forgotten once the Settings view closes', async () => {
        setup(['0', '1']);
        await editConfig();
        fireEvent.click(screen.getByTestId('dock-rail-files'));
        expect(screen.queryByTestId('config-editor')).toBeNull();
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(confirm).toHaveBeenCalledWith('Discard unsaved changes to config.json?');
        await reloadFromMenu();
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(reloadApp).toHaveBeenCalledTimes(1);
      });
    });
  });
});

// ── Settings in the app: the wiring around SettingsFields ─────────────────────
//
// SettingsFields, ConfigEditor and SessionDrawer are each tested alone. What only
// App can get wrong is the seam between them: the dock must hand the form an
// Edit config.json row and keep ONE editor behind it, hidden in Form and shown in
// Raw; the drawer must not offer that row; and a theme picked in either host must
// reach the real settings (persisted, and skinning the app) rather than a spy.
describe('Settings in the app', () => {
  const STORED = '{"port": 44040}';
  let configReads = 0;
  beforeEach(() => {
    configReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url !== '/config-file') return Promise.resolve({ ok: false, status: 503 });
        if (init?.method !== 'PUT') configReads += 1;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ text: STORED, path: '/cfg/config.json' }),
        });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    // applyThemeTokens writes the palette onto :root; leave nothing for the next file.
    document.documentElement.removeAttribute('style');
  });

  const openDockSettings = () => fireEvent.click(screen.getByTestId('dock-rail-settings'));

  describe('Edit config.json in the dock', () => {
    it('offers the row, with the editor already loaded behind the form and hidden', async () => {
      setup(['0', '1']);
      openDockSettings();
      expect(await screen.findByTestId('edit-config')).toHaveTextContent('Edit config.json');
      // The editor is created while the form shows: it needs its host to exist.
      await screen.findByText(/^Valid JSON/);
      expect(screen.getByTestId('config-editor')).toHaveAttribute('hidden');
      expect(screen.queryByTestId('config-mode')).toBeNull();
      expect(configReads).toBe(1);
    });

    it('opens Raw from the row: the form steps aside, the file is already there', async () => {
      setup(['0', '1']);
      openDockSettings();
      await screen.findByText(/^Valid JSON/);
      await userEvent.click(screen.getByTestId('edit-config'));

      expect(screen.getByTestId('config-editor')).not.toHaveAttribute('hidden');
      expect(screen.getByTestId('config-status')).toHaveTextContent('Valid JSON · 1 keys');
      expect(screen.getByTestId('config-back')).toHaveTextContent('Settings');
      expect(screen.queryByTestId('settings-section-appearance')).toBeNull();
      expect(screen.queryByTestId('edit-config')).toBeNull();
    });

    it('goes back to the form, and Raw comes back onto the same editor and the same text', async () => {
      setup(['0', '1']);
      openDockSettings();
      await screen.findByText(/^Valid JSON/);
      await userEvent.click(screen.getByTestId('edit-config'));
      const host = screen.getByTestId('config-editor-host');
      act(() => monacoFake.type('{"port": 1, "host": "x"}'));
      expect(screen.getByTestId('config-status')).toHaveTextContent('Valid JSON · 2 keys');

      await userEvent.click(screen.getByTestId('config-back'));
      expect(screen.getByTestId('set-theme')).toBeInTheDocument();
      expect(screen.getByTestId('config-editor')).toHaveAttribute('hidden');

      await userEvent.click(screen.getByTestId('edit-config'));
      expect(screen.getByTestId('config-editor-host')).toBe(host);
      expect(screen.getByTestId('config-status')).toHaveTextContent('Valid JSON · 2 keys');
      // One read for the whole visit: the editor was never rebuilt.
      expect(configReads).toBe(1);
    });

    it('is not offered by the mobile drawer, which has no room for an editor', async () => {
      localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'on' }));
      setup(['0', '1']);
      fireEvent.keyDown(window, { key: ',', ctrlKey: true });
      await screen.findByTestId('drawer-settings-body');
      expect(screen.queryByTestId('edit-config')).toBeNull();
      expect(screen.queryByTestId('config-editor')).toBeNull();
    });

    // The row goes with the form as Raw opens, and the form comes back NEW as Raw
    // closes, so focus fell on the body both ways and a keyboard user started
    // again from the top of the page.
    it('carries keyboard focus in to ‹ Settings, and back out to the row', async () => {
      setup(['0', '1']);
      openDockSettings();
      await screen.findByText(/^Valid JSON/);
      await tabTo(screen.getByTestId('edit-config'));

      await userEvent.keyboard('{Enter}');
      expect(screen.getByTestId('config-editor')).not.toHaveAttribute('hidden');
      expect(document.activeElement).toBe(screen.getByTestId('config-back'));

      await userEvent.keyboard('{Enter}');
      expect(screen.getByTestId('config-editor')).toHaveAttribute('hidden');
      expect(document.activeElement).toBe(screen.getByTestId('edit-config'));
    });

    // A mouse press focuses the button it lands on first, as Chrome does, and
    // that button goes away all the same.
    it('carries it for a mouse too', async () => {
      setup(['0', '1']);
      openDockSettings();
      await screen.findByText(/^Valid JSON/);
      await userEvent.click(screen.getByTestId('edit-config'));
      expect(document.activeElement).toBe(screen.getByTestId('config-back'));
      await userEvent.click(screen.getByTestId('config-back'));
      expect(document.activeElement).toBe(screen.getByTestId('edit-config'));
    });

    it('never takes focus from a text field, either way', async () => {
      setup(['0', '1']);
      openDockSettings();
      await screen.findByText(/^Valid JSON/);
      const field = document.createElement('textarea');
      document.body.append(field);
      try {
        field.focus();
        fireEvent.click(screen.getByTestId('edit-config'));
        expect(screen.getByTestId('config-editor')).not.toHaveAttribute('hidden');
        expect(document.activeElement).toBe(field);
        fireEvent.click(screen.getByTestId('config-back'));
        expect(screen.getByTestId('set-theme')).toBeInTheDocument();
        expect(document.activeElement).toBe(field);
      } finally {
        field.remove();
      }
    });
  });

  // ConfigEditor renders only while the dock shows Settings, so leaving Settings
  // unmounts it, and its buffer is text that exists nowhere else until a Save.
  // Keeping it mounted across views would load Monaco for every desktop session.
  describe('leaving Settings with an unsaved config.json', () => {
    const DISCARD = 'Discard unsaved changes to config.json?';
    const EDITED = '{"port": 1, "host": "x"}';
    let confirm: MockInstance<typeof window.confirm>;
    beforeEach(() => {
      confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    });
    afterEach(() => confirm.mockRestore());

    /** Settings → Raw → an edit, with `then` choosing where it is left: Raw or Form. */
    const dirtyConfig = async (then: 'raw' | 'form' = 'raw') => {
      setup(['0', '1']);
      openDockSettings();
      await screen.findByText(/^Valid JSON/);
      await userEvent.click(screen.getByTestId('edit-config'));
      act(() => monacoFake.type(EDITED));
      if (then === 'form') await userEvent.click(screen.getByTestId('config-back'));
    };
    const dockView = () => screen.getByTestId('dock').getAttribute('data-view');
    /** Still on Settings, in Raw, with the edit on screen. */
    const keptInRaw = () => {
      expect(dockView()).toBe('settings');
      expect(screen.getByTestId('config-editor')).not.toHaveAttribute('hidden');
      expect(screen.getByTestId('config-status')).toHaveTextContent('Valid JSON · 2 keys');
    };

    it.each([
      ['another rail view', () => fireEvent.click(screen.getByTestId('dock-rail-files'))],
      ['the rail toggle', () => fireEvent.click(screen.getByTestId('dock-rail-settings'))],
      ['the dock’s close button', () => fireEvent.click(screen.getByTestId('dock-close'))],
      [
        'the New-tab keybinding',
        () => fireEvent.keyDown(window, { key: 't', ctrlKey: true, shiftKey: true }),
      ],
    ])('%s asks first, and Cancel keeps Raw with the text', async (_, leave) => {
      await dirtyConfig();
      leave();
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledWith(DISCARD);
      keptInRaw();
    });

    it('the strip’s [+] button asks too, and Cancel keeps Raw with the text', async () => {
      await dirtyConfig();
      fireEvent.pointerDown(screen.getByTestId('session-new'), { button: 0 });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledWith(DISCARD);
      keptInRaw();
    });

    // Cancel is a refusal, not a decision: the buffer is as unsaved as before, so
    // the next way out asks again, and only an OK lets the dock go.
    it('Cancel does not clear the flag: the next attempt asks again, and OK then leaves', async () => {
      await dirtyConfig();
      fireEvent.click(screen.getByTestId('dock-rail-files'));
      fireEvent.click(screen.getByTestId('dock-rail-files'));
      expect(confirm).toHaveBeenCalledTimes(2);
      keptInRaw();

      confirm.mockReturnValue(true);
      fireEvent.click(screen.getByTestId('dock-rail-files'));
      expect(confirm).toHaveBeenCalledTimes(3);
      expect(dockView()).toBe('files');
      await act(async () => {}); // the Explorer's listing settles inside the test
    });

    // The one route that names Settings is not a way OUT of it.
    it('opening Settings while on Settings asks nothing and keeps the text', async () => {
      await dirtyConfig();
      fireEvent.keyDown(window, { key: ',', ctrlKey: true });
      expect(confirm).not.toHaveBeenCalled();
      keptInRaw();
    });

    // Form hides the buffer, so Cancel brings it back into view rather than leave
    // the user wondering what was about to be lost.
    it('Cancel from Form shows the buffer in Raw', async () => {
      await dirtyConfig('form');
      fireEvent.click(screen.getByTestId('dock-rail-files'));
      expect(confirm).toHaveBeenCalledWith(DISCARD);
      keptInRaw();
    });

    it('a row of the form that leaves Settings asks too', async () => {
      await dirtyConfig('form');
      fireEvent.click(screen.getByTestId('open-dictation-history'));
      expect(confirm).toHaveBeenCalledWith(DISCARD);
      keptInRaw();
    });

    it('OK lets the dock go, and a reload no longer asks about the buffer', async () => {
      reloadApp.mockClear();
      await dirtyConfig();
      confirm.mockReturnValue(true);
      fireEvent.click(screen.getByTestId('dock-rail-files'));
      expect(dockView()).toBe('files');
      expect(screen.queryByTestId('config-editor')).toBeNull();

      await openMenu();
      await userEvent.click(screen.getByTestId('app-menu-reload'));
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(reloadApp).toHaveBeenCalledTimes(1);
    });

    it('a clean editor switches silently', async () => {
      setup(['0', '1']);
      openDockSettings();
      await screen.findByText(/^Valid JSON/);
      await userEvent.click(screen.getByTestId('edit-config'));
      fireEvent.click(screen.getByTestId('dock-rail-files'));
      expect(confirm).not.toHaveBeenCalled();
      expect(dockView()).toBe('files');
    });

    // The mobile layer drops the whole dock, editor included, so switching it on
    // from Settings is the same loss. The buffer is hidden behind Form here: the
    // Mobile mode row lives in the form.
    describe('switching Mobile mode on', () => {
      const storedMobileMode = () =>
        (JSON.parse(localStorage.getItem('palmux-settings') ?? '{}') as { mobileMode?: string })
          .mobileMode;

      it('asks first, and Cancel leaves the setting and the editor alone', async () => {
        await dirtyConfig('form');
        fireEvent.click(screen.getByTestId('set-mobile-on'));
        expect(confirm).toHaveBeenCalledWith(DISCARD);
        expect(document.querySelector('.app')).not.toHaveClass('mobile');
        expect(storedMobileMode()).toBe('off');
        expect(screen.getByTestId('config-editor')).toHaveAttribute('hidden');
        await userEvent.click(screen.getByTestId('edit-config'));
        keptInRaw();
      });

      it('OK switches it on', async () => {
        await dirtyConfig('form');
        confirm.mockReturnValue(true);
        fireEvent.click(screen.getByTestId('set-mobile-on'));
        expect(document.querySelector('.app')).toHaveClass('mobile');
        expect(storedMobileMode()).toBe('on');
        expect(screen.queryByTestId('config-editor')).toBeNull();
      });

      // 'auto' is a way into the mobile layer too, wherever the device says touch.
      describe("'auto' on a touch device", () => {
        beforeEach(() => {
          Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
        });
        afterEach(() => {
          Reflect.deleteProperty(navigator, 'maxTouchPoints');
        });

        it('asks first, and Cancel leaves the setting and the editor alone', async () => {
          await dirtyConfig('form');
          fireEvent.click(screen.getByTestId('set-mobile-auto'));
          expect(confirm).toHaveBeenCalledWith(DISCARD);
          expect(document.querySelector('.app')).not.toHaveClass('mobile');
          expect(storedMobileMode()).toBe('off');
          await userEvent.click(screen.getByTestId('edit-config'));
          keptInRaw();
        });

        it('OK switches it on, and the dock with its editor goes', async () => {
          await dirtyConfig('form');
          confirm.mockReturnValue(true);
          fireEvent.click(screen.getByTestId('set-mobile-auto'));
          expect(document.querySelector('.app')).toHaveClass('mobile');
          expect(screen.queryByTestId('config-editor')).toBeNull();
        });
      });

      it('Cancel is not a decision: the next switch asks again', async () => {
        await dirtyConfig('form');
        fireEvent.click(screen.getByTestId('set-mobile-on'));
        fireEvent.click(screen.getByTestId('set-mobile-on'));
        expect(confirm).toHaveBeenCalledTimes(2);
        expect(storedMobileMode()).toBe('off');
      });

      it('asks nothing for a mode that keeps the dock, or for a clean editor', async () => {
        await dirtyConfig('form');
        fireEvent.click(screen.getByTestId('set-mobile-auto')); // no touch here: still desktop
        expect(confirm).not.toHaveBeenCalled();
        expect(document.querySelector('.app')).not.toHaveClass('mobile');

        act(() => monacoFake.type(STORED)); // back to what the file holds
        fireEvent.click(screen.getByTestId('set-mobile-on'));
        expect(confirm).not.toHaveBeenCalled();
        expect(document.querySelector('.app')).toHaveClass('mobile');
      });
    });
  });

  describe('the theme browser', () => {
    // Two themes whose derived UI base differs, so a re-skin shows up in --t-base.
    const [A, B] = (() => {
      const others = allProfiles().filter((p) => p.id !== DEFAULTS.themeId);
      const a = others[0];
      const b = others.find(
        (p) => a && hex(deriveUiTokens(p).base) !== hex(deriveUiTokens(a).base),
      );
      if (!a || !b) throw new Error('the registry needs two visibly different themes');
      return [a, b] as const;
    })();
    const base = () => document.documentElement.style.getPropertyValue('--t-base');
    const stored = () =>
      (JSON.parse(localStorage.getItem('palmux-settings') ?? '{}') as { themeId?: string }).themeId;

    it('opens in the dock, applies and persists each pick, and keeps the list for the next', async () => {
      setup(['0', '1']);
      openDockSettings();
      await userEvent.click(await screen.findByTestId('set-theme'));
      expect(screen.getByTestId('dock')).toContainElement(screen.getByTestId('theme-browser'));

      fireEvent.click(screen.getByTestId(`theme-opt-${A.id}`));
      expect(stored()).toBe(A.id);
      expect(base()).toBe(hex(deriveUiTokens(A).base));
      expect(screen.getByTestId('theme-browser')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId(`theme-opt-${B.id}`));
      expect(stored()).toBe(B.id);
      expect(base()).toBe(hex(deriveUiTokens(B).base));
      expect(screen.getByTestId('theme-browser')).toBeInTheDocument();
      expect(document.querySelectorAll('.tb-check')).toHaveLength(1);

      fireEvent.click(screen.getByTestId('settings-themes-back'));
      expect(screen.getByTestId('set-theme')).toHaveTextContent(B.name);
      expect(stored()).toBe(B.id);
    });

    it('opens in the mobile drawer, whose own header pops it before it leaves Settings', async () => {
      localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'on' }));
      setup(['0', '1']);
      fireEvent.keyDown(window, { key: ',', ctrlKey: true });
      await userEvent.click(await screen.findByTestId('set-theme'));
      const body = screen.getByTestId('drawer-settings-body');
      expect(body).toContainElement(screen.getByTestId('theme-browser'));

      fireEvent.click(screen.getByTestId(`theme-opt-${A.id}`));
      expect(stored()).toBe(A.id);
      expect(base()).toBe(hex(deriveUiTokens(A).base));
      expect(screen.getByTestId('theme-browser')).toBeInTheDocument();

      // The header pops the browser: still in Settings, the Theme row shows the pick.
      fireEvent.pointerDown(screen.getByTestId('drawer-settings-back'));
      expect(screen.queryByTestId('theme-browser')).toBeNull();
      expect(screen.getByTestId('drawer-settings-body')).toBeInTheDocument();
      expect(screen.getByTestId('set-theme')).toHaveTextContent(A.name);

      // And only a second press leaves Settings.
      fireEvent.pointerDown(screen.getByTestId('drawer-settings-back'));
      expect(screen.queryByTestId('drawer-settings-body')).toBeNull();
    });

    // Every step in the two tests below is a key (`tabTo`): a focus() call would
    // hide exactly the defect they exist to catch, focus dropped on the body when
    // the view swaps.
    it('in the dock, the keyboard alone goes in to ‹ Settings and back out to the Theme row', async () => {
      setup(['0', '1']);
      openDockSettings();
      await tabTo(await screen.findByTestId('set-theme'));
      await userEvent.keyboard('{Enter}');
      expect(screen.getByTestId('dock')).toContainElement(screen.getByTestId('theme-browser'));
      expect(document.activeElement).toBe(screen.getByTestId('settings-themes-back'));

      await userEvent.keyboard('{Enter}');
      expect(screen.queryByTestId('theme-browser')).toBeNull();
      expect(document.activeElement).toBe(screen.getByTestId('set-theme'));
    });

    // The drawer hides the form's own `‹ Settings`, so its header is the only way
    // back from the browser. A keyboard opens the browser; it has to close it too.
    it('in the mobile drawer, the keyboard alone opens the browser and backs out of it', async () => {
      // happy-dom loads no imported CSS. This sheet is what hides the form's own
      // back control in the drawer, so without it Tab would stop on a control a
      // browser never shows.
      const sheet = document.createElement('style');
      sheet.textContent = readFileSync(join(__dirname, 'settings/settings-view.css'), 'utf8');
      document.head.append(sheet);
      try {
        localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'on' }));
        setup(['0', '1']);
        fireEvent.keyDown(window, { key: ',', ctrlKey: true });
        await tabTo(await screen.findByTestId('set-theme'));
        await userEvent.keyboard('{Enter}');
        expect(screen.getByTestId('drawer-settings-body')).toContainElement(
          screen.getByTestId('theme-browser'),
        );
        // The first control the sub-view draws here is a theme.
        expect(document.activeElement).toBe(document.querySelector("[data-testid^='theme-opt-']"));

        await tabTo(screen.getByTestId('drawer-settings-back'), true);
        await userEvent.keyboard('{Enter}');
        expect(screen.queryByTestId('theme-browser')).toBeNull();
        expect(screen.getByTestId('drawer-settings-body')).toBeInTheDocument();
        expect(document.activeElement).toBe(screen.getByTestId('set-theme'));

        await tabTo(screen.getByTestId('drawer-settings-back'), true);
        await userEvent.keyboard(' ');
        expect(screen.queryByTestId('drawer-settings-body')).toBeNull();
      } finally {
        sheet.remove();
      }
    });
  });
});
