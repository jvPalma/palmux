// App-level integration: the pane grid (editor groups), the strips, the dock and the drawer wired
// through the REAL App (selectTab / drops on a pane / tabCreated / [+]), with the heavy leaves
// mocked at their seams — WsClient (we play the server), TerminalPane (a stub div carrying
// pane/session/focus), PaneHost. These pin the headline invariants: a tab is in one pane, a pane's
// terminal is keyed by the pane, focus is the window selection, and creation lands in a pane.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRef, useEffect, type ComponentProps } from 'react';
import { flushSync } from 'react-dom';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { App, shouldRestoreKeyboard, type DrawerCloseOptions } from './App';
import { GROUP_DND_TYPE, TAB_DIRTY_DND_TYPE, TAB_DND_TYPE } from './session/SessionTabs';
import type { SessionDrawer as SessionDrawerComponent } from './session/SessionDrawer';
import type { DrawerDrop } from './session/drawer-tree';
import type { PaneApi, SlotId, SplitRegistry } from './session/SplitFocusContext';
import { registerReview, resetReviewRegistry, type ReviewApi } from './review/review-registry';
import { commentsStore } from './review/use-comments';
import { scmStatusStore } from './scm/status-store';
import { useFileUpload } from './terminal/useFileUpload';
import { Icon } from './ui/icons';
import { DEFAULTS, type ClientSettings } from './settings/settings';
import {
  allProfiles,
  deriveUiTokens,
  hex,
  registerDynamicThemes,
  type ColorProfile,
} from './settings/themes';

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
    /** Every `moveToWindow` this client sent, in order. */
    moves: Array<{ ids: string[]; window: string | null }>;
    /** How many `windowClosing` messages this client sent. */
    closings: number;
    /** What App registered for the socket opening: a connect, and every reconnect. */
    openHandler: (() => void) | null;
    /** Every settings blob this client sent the server, in order. */
    settingsSent: Array<Record<string, unknown>>;
    /** Every theme import request, as typed. */
    imports: string[];
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
    moves: Array<{ ids: string[]; window: string | null }> = [];
    closings = 0;
    openHandler: (() => void) | null = null;
    settingsSent: Array<Record<string, unknown>> = [];
    imports: string[] = [];
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }
    onMessage(cb: (msg: Record<string, unknown>) => void) {
      this.handler = cb;
    }
    onBinary() {}
    onOpen(cb: () => void) {
      this.openHandler = cb;
    }
    connect() {}
    destroy() {}
    stopReconnect() {}
    sendSettings(j: Record<string, unknown>) {
      this.settingsSent.push(j);
      return true;
    }
    sendImportTheme(source: string) {
      this.imports.push(source);
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
    sendMoveToWindow(ids: string[], window: string | null) {
      this.moves.push({ ids, window });
      return true;
    }
    sendWindowClosing() {
      this.closings += 1;
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
  /** Every string a shared input surface sent the pane, typed or pasted: what reaches the PTY. */
  typed: [] as string[],
  /** The panes (by slot) a picker was opened on: which terminal an Upload reached. */
  pickers: [] as string[],
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
      sendInput: (t) => {
        paneApiFake.typed.push(t);
        return true;
      },
      paste: (t) => {
        paneApiFake.typed.push(t);
        return true;
      },
      pasteImage: noop,
      openPicker: (onReturn) => {
        paneApiFake.pickers.push(p.slot);
        return paneApiFake.launches ? openPicker(onReturn) : false;
      },
      openImagePicker: (onReturn) => {
        paneApiFake.pickers.push(p.slot);
        return paneApiFake.launches ? openImagePicker(onReturn) : false;
      },
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
// real pane's mousedown→onFocusRequest wiring (a click inside a pane focuses it).
vi.mock('./terminal/TerminalPane', () => ({
  TerminalPane: (p: {
    slot: SlotId;
    sessionId: string;
    focused: boolean;
    inSplit: boolean;
    registry: SplitRegistry;
    settings: { themeId: string };
    /** The detached window this pane's data socket names (absent in the main window). */
    window?: string;
    onFocusRequest: (slot: string) => void;
  }) => (
    <div
      data-testid={`term-pane-${p.slot}`}
      data-session={p.sessionId}
      data-window={p.window}
      // The theme id the pane is handed: the terminal paints exactly this one.
      data-theme={p.settings.themeId}
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
// The real strip, with the props each pane's strip was drawn with kept, so a test can ask whether a
// sash frame (which re-renders every pane's box) handed a strip anything new.
const stripSpy = vi.hoisted(() => ({ renders: [] as Array<Record<string, unknown>> }));
vi.mock('./session/SessionTabs', async (orig) => {
  const real = await orig<typeof import('./session/SessionTabs')>();
  return {
    ...real,
    SessionTabs: (p: ComponentProps<typeof real.SessionTabs>) => {
      stripSpy.renders.push({ ...p });
      return <real.SessionTabs {...p} />;
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
  /** What a review pane would read from the app around it (review/review-host.ts). */
  review: null as null | import('./review/review-host').ReviewHost,
  /** The tabs of every render, in order: the real host mounts a pane for each non-terminal one. */
  renders: [] as Array<Array<{ id: string; kind: string }>>,
  /** The latest rects: the tabs the host shows, not merely keeps mounted. */
  rects: {} as Record<string, unknown>,
}));
vi.mock('./panes/PaneHost', async () => {
  const { useReviewHost } = await import('./review/review-host');
  return {
    PaneHost: (p: {
      tabs: Array<{ id: string; kind: string }>;
      rects: Record<string, unknown>;
      onDirtyChange: (id: string, dirty: boolean) => void;
      onMenu?: () => void;
    }) => {
      paneHost.renders.push(p.tabs);
      paneHost.rects = p.rects;
      paneHost.onDirtyChange = p.onDirtyChange;
      paneHost.onMenu = p.onMenu;
      paneHost.review = useReviewHost();
      return <div data-testid="pane-host" />;
    },
  };
});

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

// The download itself is a fetch plus an anchor click; what these tests pin is the string
// the Download prompt hands to it.
const { downloadFromServer } = vi.hoisted(() => ({
  downloadFromServer: vi.fn((_pattern: string) => Promise.resolve<string | null>(null)),
}));
vi.mock('./terminal/download', async (orig) => ({
  ...(await orig<typeof import('./terminal/download')>()),
  downloadFromServer,
}));

// The real dictation hook, with the callbacks App last handed it kept, so a test can play a failed
// transcription without a microphone.
const dictationSpy = vi.hoisted(() => ({
  params: null as null | Parameters<typeof import('./dictation/useDictation').useDictation>[0],
}));
vi.mock('./dictation/useDictation', async (orig) => {
  const real = await orig<typeof import('./dictation/useDictation')>();
  return {
    ...real,
    useDictation: (params: Parameters<typeof real.useDictation>[0]) => {
      dictationSpy.params = params;
      return real.useDictation(params);
    },
  };
});

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
/** The control socket connects (or reconnects): the real client calls its open handlers, then the
 *  server speaks. A detached window reclaims its tabs on the first `sessions` after each open. */
const connect = () =>
  act(() => {
    server().openHandler?.();
  });

// The terminal panes on screen, in layout order: the pane's id, the session it shows and whether it
// is the focused one of several (a lone pane wears no focus mark, as in the real TerminalPane).
const panes = () =>
  [...document.querySelectorAll('[data-testid^="term-pane-"]')].map((e) => ({
    slot: (e as HTMLElement).dataset['testid']!.slice('term-pane-'.length),
    session: (e as HTMLElement).dataset['session'],
    focused: e.className.includes('focused'),
  }));

/** Every pane's strip: the pane, the tabs it lists in order, and whether it is the focused one. */
const strips = () =>
  [...document.querySelectorAll('.group-strip')].map((strip) => ({
    pane: strip.getAttribute('data-pane-id'),
    tabs: [...strip.querySelectorAll('[data-testid^="session-tab-"]')].map((e) =>
      (e as HTMLElement).dataset['testid']!.replace('session-tab-', ''),
    ),
    focused: strip.classList.contains('group-strip-focused'),
  }));

/** The tab a pane's strip shows as its active one. */
const shownIn = (pane: string): string | undefined =>
  document
    .querySelector(`.group-strip[data-pane-id="${pane}"] .ctab.active`)
    ?.getAttribute('data-testid')
    ?.replace('session-tab-', '');

const stripOf = (pane: string) =>
  within(document.querySelector<HTMLElement>(`.group-strip[data-pane-id="${pane}"]`)!);

const clickTab = (id: string) => {
  fireEvent.click(screen.getByTestId(`session-tab-${id}`), { button: 0 });
};

/** Split a tab into a new pane, through the real context-menu path. */
const splitVia = (id: string, direction: 'right' | 'down' = 'right') => {
  fireEvent.contextMenu(screen.getByTestId(`session-tab-${id}`));
  fireEvent.click(screen.getByTestId(`menu-split-${direction}`));
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
  paneHost.renders = [];
  paneHost.rects = {};
  localStorage.clear();
  // The window's saved pane layout (and selection) lives in sessionStorage: without this it would
  // carry from one test into the next, as one browsing context does across a reload.
  sessionStorage.clear();
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

// ── Editor groups ─────────────────────────────────────────────────────────────
//
// The content area is a grid of panes, each with its own strip, through the REAL App (the control
// socket, the layout hook, GroupsView, SessionTabs and the controller are all real; the terminal
// and the non-terminal panes are stubs). What is pinned here is what only the wiring can get wrong:
// which pane a gesture reaches, and what the strips and the focus mark then say.

/** Where in a pane's 300x300 body (happy-dom has no layout) a drop claims each region. */
const REGION_AT = {
  left: [20, 150],
  right: [280, 150],
  top: [150, 20],
  bottom: [150, 280],
  centre: [150, 150],
} as const;

/** A drag event carrying a pointer position, which `fireEvent` would drop (no DragEvent here). */
const dragAt = (
  type: 'dragover' | 'drop',
  el: Element,
  dataTransfer: unknown,
  x = 0,
  y = 0,
): void => {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, { dataTransfer, clientX: x, clientY: y });
  fireEvent(el, ev);
};

/** Drag tab `id` and drop it on the body of the `index`th pane (layout order) in `region`. */
const dropOnPane = (id: string, index: number, region: keyof typeof REGION_AT) => {
  const t = dt();
  fireEvent.dragStart(screen.getByTestId(`session-tab-${id}`), { dataTransfer: t });
  t.setData(TAB_DND_TYPE, id);
  const overlay = screen.getAllByTestId('group-drop-overlay')[index]!;
  overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 300 }) as DOMRect;
  const [x, y] = REGION_AT[region];
  dragAt('dragover', overlay, t, x, y);
  dragAt('drop', overlay, t, x, y);
};

/** Drag tab `id` and drop it on the empty space of pane `pane`'s strip. */
const dropOnStrip = (id: string, pane: string) => {
  const t = dt();
  fireEvent.dragStart(screen.getByTestId(`session-tab-${id}`), { dataTransfer: t });
  t.setData(TAB_DND_TYPE, id);
  const strip = stripOf(pane).getByTestId('session-tabs');
  dragAt('dragover', strip, t);
  fireEvent.drop(strip, { dataTransfer: t });
};

/** Two columns: p0 holds 0 and 1 (0 shown), p1 holds 2 (focused pane p0). A saved layout, as a reload finds it. */
const TWO_COLUMNS = JSON.stringify({
  v: 3,
  root: {
    type: 'branch',
    orientation: 'row',
    size: 1,
    children: [
      {
        type: 'leaf',
        id: 'p0',
        tabs: [
          { id: '0', kind: 'terminal' },
          { id: '1', kind: 'terminal' },
        ],
        active: '0',
        size: 0.5,
      },
      { type: 'leaf', id: 'p1', tabs: [{ id: '2', kind: 'terminal' }], active: '2', size: 0.5 },
    ],
  },
  focused: 'p0',
  nextId: 2,
});

describe('editor groups', () => {
  beforeEach(() => {
    paneApiFake.pickers = [];
  });
  afterEach(() => {
    paneApiFake.enabled = false;
  });

  it('starts as one pane holding every tab, showing the first', () => {
    setup();
    expect(strips()).toEqual([{ pane: 'p0', tabs: ['0', '1', '2'], focused: true }]);
    expect(panes()).toEqual([{ slot: 'p0', session: '0', focused: false }]);
  });

  describe('dropping a tab on a pane', () => {
    it('on its right edge opens a pane there, holding the tab and focused', () => {
      setup(['0', '1', '2', '3', '4']);
      dropOnPane('2', 0, 'right');
      expect(strips()).toEqual([
        { pane: 'p0', tabs: ['0', '1', '3', '4'], focused: false },
        { pane: 'p1', tabs: ['2'], focused: true },
      ]);
      expect(panes()).toEqual([
        { slot: 'p0', session: '0', focused: false },
        { slot: 'p1', session: '2', focused: true },
      ]);
    });

    it('on the bottom edge of the right column splits that column, leaving the left alone', () => {
      setup(['0', '1', '2', '3', '4']);
      dropOnPane('2', 0, 'right');
      dropOnPane('3', 1, 'bottom'); // the right column's own body
      expect(strips()).toEqual([
        { pane: 'p0', tabs: ['0', '1', '4'], focused: false },
        { pane: 'p1', tabs: ['2'], focused: false },
        { pane: 'p2', tabs: ['3'], focused: true },
      ]);
    });

    it('on its own pane’s edge, when it is that pane’s only tab, changes nothing', () => {
      setup();
      dropOnPane('2', 0, 'right'); // p1 holds 2 alone
      const before = strips();
      dropOnPane('2', 1, 'right');
      expect(strips()).toEqual(before);
      expect(panes()).toHaveLength(2);
    });

    it('in the centre of another pane moves it there, and the emptied pane goes', () => {
      setup(['0', '1', '2']);
      dropOnPane('2', 0, 'right'); // p1 = [2]
      dropOnPane('1', 1, 'centre');
      expect(strips()).toEqual([
        { pane: 'p0', tabs: ['0'], focused: false },
        { pane: 'p1', tabs: ['1', '2'], focused: true },
      ]);
      expect(shownIn('p1')).toBe('1');
      // Moving the last tab out of a pane removes it.
      dropOnPane('0', 1, 'centre');
      expect(strips()).toEqual([{ pane: 'p1', tabs: ['0', '1', '2'], focused: true }]);
      expect(panes()).toEqual([{ slot: 'p1', session: '0', focused: false }]);
    });

    it('shows no overlay and takes no drop for an OS file drag', () => {
      setup();
      dropOnPane('2', 0, 'right');
      expect(screen.queryAllByTestId('group-drop-overlay')).toHaveLength(0); // the drag ended
      const files = { ...dt(), types: ['Files'] };
      fireEvent.dragOver(document.querySelector('.groups-view')!, { dataTransfer: files });
      expect(screen.queryAllByTestId('group-drop-overlay')).toHaveLength(0);
    });

    // A pill that unmounts mid-drag (a broadcast took its tab away) fires no `dragend`, so the
    // strip never reports the end and every pane would keep its overlay. The window hears the drag
    // end (`dragend`) or land (`drop`) whatever became of the pill. It waits for the event to
    // finish: the overlay's own `drop` handler reads the id it carries.
    describe('a drag whose pill never reports its end', () => {
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      const startDrag = (id: string) => {
        const t = dt();
        fireEvent.dragStart(screen.getByTestId(`session-tab-${id}`), { dataTransfer: t });
        t.setData(TAB_DND_TYPE, id);
        expect(screen.getAllByTestId('group-drop-overlay')).toHaveLength(1);
      };

      it.each(['dragEnd', 'drop'] as const)(
        'is ended by a window-level %s, after the event has finished',
        (type) => {
          setup();
          startDrag('1');
          // Where no pane or strip claims it: the source is gone, so nothing else clears the id.
          fireEvent[type](document.body, { dataTransfer: dt() });
          expect(screen.getAllByTestId('group-drop-overlay')).toHaveLength(1); // still mid-event
          act(() => void vi.advanceTimersByTime(0));
          expect(screen.queryAllByTestId('group-drop-overlay')).toHaveLength(0);
        },
      );

      it('does not take the drop from the overlay it lands on', () => {
        setup(['0', '1', '2']);
        dropOnPane('2', 0, 'right'); // the real handler reads the id, then the window clears it
        act(() => void vi.advanceTimersByTime(0));
        expect(strips().map((x) => x.tabs)).toEqual([['0', '1'], ['2']]);
        expect(screen.queryAllByTestId('group-drop-overlay')).toHaveLength(0);
      });

      // The pill can go with no window event at all (the browser may never deliver the drag's end
      // to a source that left the DOM), so the broadcast that takes the dragged tab ends the drag.
      it('is ended by a broadcast that no longer lists the dragged tab', () => {
        setup(['0', '1', '2']);
        startDrag('1');
        broadcast(['0', '1', '2']); // still listed: the drag goes on
        expect(screen.getAllByTestId('group-drop-overlay')).toHaveLength(1);
        broadcast(['0', '2']);
        expect(screen.queryAllByTestId('group-drop-overlay')).toHaveLength(0);
      });

      // A terminal this window just created is in no list until its attach spawns it, and its pill
      // is drawn all the same. A broadcast that lacks it has not taken it away.
      it('is not ended by a broadcast that lacks a terminal this window just created', () => {
        setup(['0', '1']);
        fireEvent.pointerDown(stripOf('p0').getByTestId('session-new'), { button: 0 });
        tapPress(screen.getByTestId('dash-new-terminal'));
        expect(shownIn('p0')).toBe('2');
        startDrag('2');
        broadcast(['0', '1']);
        expect(screen.getAllByTestId('group-drop-overlay')).toHaveLength(1);
      });
    });
  });

  describe('a strip drop', () => {
    it('moves a tab from another pane without a reorder: it shows among its pane’s tabs in server order', () => {
      setup(['0', '1', '2', '3']);
      dropOnPane('1', 0, 'right'); // p1 = [1]
      dropOnStrip('0', 'p1');
      // 0 comes BEFORE 1 in the server's order, so it shows there, though it joined later.
      expect(strips()).toEqual([
        { pane: 'p0', tabs: ['2', '3'], focused: false },
        { pane: 'p1', tabs: ['0', '1'], focused: true },
      ]);
      expect(shownIn('p1')).toBe('0');
      expect(server().reorders).toEqual([]);
    });

    // The drop keeps the tab's server-order place, so its target strip is lit whole and draws no
    // insertion bar; the strip it came from, and any other, draws nothing.
    it('lights only the strip a tab from another pane hovers, with no insertion bar', () => {
      setup(['0', '1', '2']);
      dropOnPane('2', 0, 'right'); // p1 = [2]
      const t = dt();
      fireEvent.dragStart(screen.getByTestId('session-tab-0'), { dataTransfer: t });
      t.setData(TAB_DND_TYPE, '0');
      dragAt('dragover', stripOf('p1').getByTestId('session-tab-2'), t);
      expect(stripOf('p1').getByTestId('session-tabs')).toHaveClass('drop-into');
      expect(stripOf('p0').getByTestId('session-tabs')).not.toHaveClass('drop-into');
      expect(document.querySelectorAll('.drop-before, .drop-after')).toHaveLength(0);
      fireEvent.drop(stripOf('p1').getByTestId('session-tabs'), { dataTransfer: t });
      expect(strips()).toEqual([
        { pane: 'p0', tabs: ['1'], focused: false },
        { pane: 'p1', tabs: ['0', '2'], focused: true },
      ]);
      expect(stripOf('p1').getByTestId('session-tabs')).not.toHaveClass('drop-into');
    });

    it('maps a reorder inside a pane onto the full order', () => {
      setup(['0', '1', '2', '3', '4']);
      dropOnPane('1', 0, 'right'); // p0 = [0, 2, 3, 4], p1 = [1]
      const t = dt();
      fireEvent.dragStart(screen.getByTestId('session-tab-4'), { dataTransfer: t });
      t.setData(TAB_DND_TYPE, '4');
      // happy-dom has no layout, so a pill is always dropped "after": the boundary right after 0.
      fireEvent.dragOver(screen.getByTestId('session-tab-0'), { dataTransfer: t });
      fireEvent.drop(stripOf('p0').getByTestId('session-tabs'), { dataTransfer: t });
      // Before 2 in the full order, which is after the OTHER pane's 1.
      expect(server().reorders.at(-1)).toEqual(['0', '1', '4', '2', '3']);
    });

    it('lands past a pane’s last entry right after that pane’s last tab, not at the end of the list', () => {
      setup(['0', '1', '2', '3']);
      dropOnPane('2', 0, 'right'); // p1 = [2]
      dropOnStrip('3', 'p1'); // p0 = [0, 1], p1 = [2, 3]
      const t = dt();
      fireEvent.dragStart(screen.getByTestId('session-tab-0'), { dataTransfer: t });
      t.setData(TAB_DND_TYPE, '0');
      const strip = stripOf('p0').getByTestId('session-tabs');
      dragAt('dragover', strip, t); // the empty space past the last pill
      fireEvent.drop(strip, { dataTransfer: t });
      expect(server().reorders.at(-1)).toEqual(['1', '0', '2', '3']);
    });
  });

  describe('the + of a pane', () => {
    it('creates in its own pane, whichever pane was focused', () => {
      setup(['0', '1', '2']);
      dropOnPane('2', 0, 'right'); // p1 focused
      fireEvent.pointerDown(stripOf('p0').getByTestId('session-new'), { button: 0 });
      tapPress(screen.getByTestId('dash-new-terminal'));
      expect(panes()).toEqual([
        { slot: 'p0', session: '3', focused: true },
        { slot: 'p1', session: '2', focused: false },
      ]);
      expect(strips().map((x) => x.focused)).toEqual([true, false]);
    });

    it('creates in the second pane when it is that pane’s', () => {
      setup(['0', '1', '2']);
      dropOnPane('2', 0, 'right');
      fireEvent.mouseDown(screen.getByTestId('term-pane-p0')); // p0 has the focus …
      fireEvent.pointerDown(stripOf('p1').getByTestId('session-new'), { button: 0 }); // … p1's + takes it
      tapPress(screen.getByTestId('dash-new-terminal'));
      expect(panes()).toEqual([
        { slot: 'p0', session: '0', focused: false },
        { slot: 'p1', session: '3', focused: true },
      ]);
    });
  });

  describe('opening a file', () => {
    const FILE = '/work/a.txt';
    const withFile = () =>
      send({
        type: 'sessions',
        tabs: [
          { id: '0', kind: 'terminal' },
          { id: '1', kind: 'terminal' },
          { id: '3', kind: 'editor', url: FILE },
        ],
      });
    const open = (path: string) => act(() => paneHost.review!.openFile(path));

    it('opens a new file in the focused pane', async () => {
      setup(['0', '1']);
      dropOnPane('1', 0, 'right'); // p1 focused
      open(FILE);
      expect(server().created).toEqual([{ kind: 'editor', url: FILE }]);
      await withFile(); // the broadcast first: it joins the focused pane, not shown …
      expect(shownIn('p1')).toBe('1');
      await send({ type: 'tabCreated', id: '3' }); // … then the answer shows it there
      expect(strips()).toEqual([
        { pane: 'p0', tabs: ['0'], focused: false },
        { pane: 'p1', tabs: ['1', '3'], focused: true },
      ]);
      expect(shownIn('p1')).toBe('3');
    });

    it('reopening an open file selects it in its own pane and focuses that pane', async () => {
      render(<App />);
      await withFile();
      splitVia('1'); // p1 = [1], focused; the file sits in p0
      expect(strips().map((x) => x.focused)).toEqual([false, true]);
      open(FILE);
      expect(server().created).toEqual([]); // no second tab
      expect(strips()).toEqual([
        { pane: 'p0', tabs: ['0', '3'], focused: true },
        { pane: 'p1', tabs: ['1'], focused: false },
      ]);
      expect(shownIn('p0')).toBe('3');
    });
  });

  describe('closing a tab', () => {
    it('activates its left neighbour in the same pane and leaves the other pane alone', () => {
      setup(['0', '1', '2', '3']);
      splitVia('3'); // p0 = [0, 1, 2], p1 = [3]
      clickTab('2'); // p0 shows 2 and takes focus
      expect(shownIn('p0')).toBe('2');
      broadcast(['0', '1', '3']); // 2 was closed
      expect(shownIn('p0')).toBe('1');
      expect(shownIn('p1')).toBe('3');
      expect(strips()).toEqual([
        { pane: 'p0', tabs: ['0', '1'], focused: true },
        { pane: 'p1', tabs: ['3'], focused: false },
      ]);
      expect(active()).toBe('1');
    });

    it('removes a pane whose last tab closed, and its neighbour takes the space and the focus', () => {
      setup(['0', '1', '2']);
      splitVia('2'); // p1 = [2], focused
      broadcast(['0', '1']);
      expect(strips()).toEqual([{ pane: 'p0', tabs: ['0', '1'], focused: true }]);
    });
  });

  describe('clicking a pane', () => {
    it('moves the shared input surfaces to it', () => {
      paneApiFake.enabled = true;
      setup(['0', '1', '2']);
      splitVia('2'); // p1 focused
      fireEvent.click(screen.getByTestId('dock-rail-upload'));
      expect(paneApiFake.pickers).toEqual(['p1']);
      fireEvent.mouseDown(screen.getByTestId('term-pane-p0')); // a click inside p0
      expect(strips().map((x) => x.focused)).toEqual([true, false]);
      fireEvent.click(screen.getByTestId('dock-rail-upload'));
      expect(paneApiFake.pickers).toEqual(['p1', 'p0']);
    });

    // A key, assistive tech or `element.click()` reaches a pill as a click with no pointerdown, so
    // nothing in the pane's body saw a press: the click on the pane's own active tab is what focuses it.
    it('focuses a pane through a click on its active tab that no pointerdown came before', () => {
      setup(['0', '1', '2']);
      splitVia('2'); // p1 focused; p0 shows 0
      fireEvent.click(screen.getByTestId('session-tab-0'), { button: 0, detail: 0 });
      expect(strips().map((x) => x.focused)).toEqual([true, false]);
      expect(shownIn('p0')).toBe('0');
      expect(active()).toBe('0');
    });

    it('moves the window selection with it', () => {
      setup(['0', '1', '2']);
      splitVia('2');
      expect(active()).toBe('2');
      fireEvent.mouseDown(screen.getByTestId('term-pane-p0'));
      expect(active()).toBe('0');
      expect(JSON.parse(sessionStorage.getItem('palmux-window-tab')!)).toEqual({
        id: '0',
        kind: 'terminal',
      });
    });
  });

  describe('a reload', () => {
    it('comes back with the same panes, tabs and focus', () => {
      setup(['0', '1', '2']);
      splitVia('2'); // p1 focused, showing 2
      cleanup();
      history.replaceState(null, '', '/');
      sockets.length = 0;
      setup(['0', '1', '2']);
      expect(strips()).toEqual([
        { pane: 'p0', tabs: ['0', '1'], focused: false },
        { pane: 'p1', tabs: ['2'], focused: true },
      ]);
      expect(active()).toBe('2');
    });

    it('does not bring back a saved pane for a terminal that is gone, and attaches nothing for it', () => {
      setup(['0', '1', '2']);
      splitVia('2');
      cleanup();
      history.replaceState(null, '', '/');
      sockets.length = 0;
      setup(['0', '1']); // terminal 2 closed while the window was away
      expect(strips()).toEqual([{ pane: 'p0', tabs: ['0', '1'], focused: true }]);
      expect(panes().map((x) => x.session)).toEqual(['0']);
    });

    it('is per window: a window with no saved layout opens one pane', () => {
      setup(['0', '1', '2']);
      splitVia('2');
      cleanup();
      sessionStorage.clear(); // another window of the same device
      history.replaceState(null, '', '/');
      sockets.length = 0;
      setup(['0', '1', '2']);
      expect(strips()).toHaveLength(1);
    });
  });

  describe('a colour group spanning two panes', () => {
    it('draws its chip in each pane’s strip', () => {
      setup(['0', '1', '2']);
      sendGroups(
        [{ id: '0', groupId: 'gaa111' }, { id: '1', groupId: 'gaa111' }, { id: '2' }],
        [{ id: 'gaa111', color: 'blue', name: 'proj' }],
      );
      splitVia('1');
      const chips = screen.getAllByTestId('group-chip-gaa111');
      expect(chips).toHaveLength(2);
      expect(stripOf('p0').getByTestId('group-chip-gaa111')).toBe(chips[0]);
      expect(stripOf('p1').getByTestId('group-chip-gaa111')).toBe(chips[1]);
    });

    // The collapse guard switches every pane showing a member, one after the other, in one click.
    // Each switch is a layout command, and the second used to be computed from the layout of the
    // last render, which put the first pane back on its member: the auto-expand then re-opened the
    // group, and nothing collapsed.
    it('collapses after moving EVERY pane showing a member to a tab outside it', () => {
      const terms = (ids: string[]) => ids.map((id) => ({ id, kind: 'terminal' }));
      sessionStorage.setItem(
        'palmux-layout',
        JSON.stringify({
          v: 3,
          root: {
            type: 'branch',
            orientation: 'row',
            size: 1,
            children: [
              { type: 'leaf', id: 'p0', tabs: terms(['0', '1', '2']), active: '0', size: 0.5 },
              { type: 'leaf', id: 'p1', tabs: terms(['3', '4', '5']), active: '4', size: 0.5 },
            ],
          },
          focused: 'p0',
          nextId: 2,
        }),
      );
      render(<App />);
      // Members are contiguous in the server's order; each pane's strip is its own slice of it.
      sendGroups(
        [
          { id: '0', groupId: 'gaa111' },
          { id: '1', groupId: 'gaa111' },
          { id: '3', groupId: 'gaa111' },
          { id: '4', groupId: 'gaa111' },
          { id: '2' },
          { id: '5' },
        ],
        [{ id: 'gaa111', color: 'blue' }],
      );
      expect([shownIn('p0'), shownIn('p1')]).toEqual(['0', '4']);
      fireEvent.click(stripOf('p0').getByTestId('group-chip-gaa111'));
      expect([shownIn('p0'), shownIn('p1')]).toEqual(['2', '5']);
      // The members are hidden in both strips: each shows only its chip and its outside tab.
      expect(strips()).toEqual([
        { pane: 'p0', tabs: ['2'], focused: true },
        { pane: 'p1', tabs: ['5'], focused: false },
      ]);
      expect(stripOf('p0').getByTestId('group-count-gaa111')).toBeTruthy();
      expect(stripOf('p1').getByTestId('group-count-gaa111')).toBeTruthy();
      expect(JSON.parse(localStorage.getItem('palmux-collapsed-groups')!)).toEqual(['gaa111']);
    });
  });

  describe('a closed pane', () => {
    afterEach(() => {
      Reflect.deleteProperty(navigator, 'maxTouchPoints');
    });
    const touchPoints = (n: number) =>
      Object.defineProperty(navigator, 'maxTouchPoints', { value: n, configurable: true });
    const lastStripOf = (pane: string) => stripSpy.renders.findLast((r) => r['paneId'] === pane);

    // Each pane's strip callbacks are cached by pane id so a sash frame does not redraw the strips.
    // A pane that goes takes its entry with it, so the cache is as long as the layout. A layout
    // rebuilt with no saved copy (here: the phone layer came and went, and the window's storage
    // was lost) mints `p0` again and then `p1`, and that `p1` is a new pane.
    it('takes its strip handlers with it, so a pane that reuses its id gets its own', () => {
      localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'auto' }));
      setup(['0', '1', '2']);
      splitVia('2'); // p0 = [0, 1], p1 = [2], focused
      fireEvent.mouseDown(screen.getByTestId('term-pane-p0')); // the one pane the rebuild keeps
      const first = lastStripOf('p1')?.['onNewTab'];
      expect(first).toBeDefined();

      touchPoints(5); // `auto` resolves on every render: the next one is the phone layer
      broadcast(['0', '1', '2']);
      expect(document.querySelector('.app')).toHaveClass('mobile');
      sessionStorage.removeItem('palmux-layout');
      Reflect.deleteProperty(navigator, 'maxTouchPoints');
      broadcast(['0', '1', '2']);
      expect(strips().map((x) => x.pane)).toEqual(['p0']);

      splitVia('1');
      expect(strips().map((x) => x.pane)).toEqual(['p0', 'p1']);
      expect(lastStripOf('p1')?.['onNewTab']).not.toBe(first);
    });
  });

  describe('sashes', () => {
    let frames: Array<() => void> = [];
    const flushFrames = () => {
      const queued = frames;
      frames = [];
      act(() => {
        for (const run of queued) run();
      });
    };
    beforeEach(() => {
      frames = [];
      vi.stubGlobal('requestAnimationFrame', (run: () => void) => frames.push(run));
      vi.stubGlobal('cancelAnimationFrame', () => {});
      // happy-dom has no pointer capture; the sash calls it unconditionally.
      Element.prototype.setPointerCapture = vi.fn();
      Element.prototype.releasePointerCapture = vi.fn();
      // A 1000x800 content area: the sash turns pixels into a fraction of its branch.
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
        function (this: HTMLElement) {
          const area = this.classList.contains('content-area');
          return { left: 0, top: 0, width: area ? 1000 : 0, height: area ? 800 : 0 } as DOMRect;
        },
      );
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    const sashes = () => screen.getAllByTestId('group-sash');
    const press = (el: HTMLElement, x: number) =>
      fireEvent.pointerDown(el, { pointerId: 1, clientX: x, clientY: 300, button: 0 });
    const dragTo = (el: HTMLElement, x: number) => {
      fireEvent.pointerMove(el, { pointerId: 1, clientX: x, clientY: 300 });
      flushFrames();
    };
    const release = (el: HTMLElement, x: number) =>
      fireEvent.pointerUp(el, { pointerId: 1, clientX: x, clientY: 300 });
    /** A pane's width as drawn, in percent. */
    const widthOf = (pane: string) =>
      parseFloat(
        document.querySelector<HTMLElement>(`.group-strip[data-pane-id="${pane}"]`)!.style.width,
      );
    const saved = () => JSON.parse(sessionStorage.getItem('palmux-layout')!);

    it('draws every frame of a drag, and saves the layout once, on release', () => {
      setup(['0', '1', '2']);
      splitVia('2');
      expect(widthOf('p0')).toBe(50);
      const [sash] = sashes();
      press(sash!, 500);
      dragTo(sash!, 600); // 100px of a 1000px area, in one branch
      expect(widthOf('p0')).toBeCloseTo(60);
      expect(saved().root.children[0].size).toBe(0.5); // not saved while it moves
      release(sash!, 600);
      expect(saved().root.children[0].size).toBeCloseTo(0.6);
      expect(widthOf('p0')).toBeCloseTo(60);
    });

    it('refits every terminal once on release, a frame later', () => {
      paneApiFake.enabled = true;
      setup(['0', '1', '2']);
      splitVia('2');
      const [sash] = sashes();
      const before = paneApiFake.refits;
      press(sash!, 500);
      dragTo(sash!, 600);
      expect(paneApiFake.refits).toBe(before);
      release(sash!, 600);
      flushFrames();
      expect(paneApiFake.refits - before).toBe(2); // one per pane
    });

    it('refuses a layout command while a drag is on, and takes it again after', () => {
      setup(['0', '1', '2']);
      splitVia('2');
      const [sash] = sashes();
      press(sash!, 500);
      dragTo(sash!, 560);
      splitVia('1'); // the next drag frame would undo it, so it is refused
      expect(strips()).toHaveLength(2);
      release(sash!, 560);
      splitVia('1');
      expect(strips()).toHaveLength(3);
    });

    it('stops resizing once a broadcast has reshaped the layout under the drag', () => {
      setup(['0', '1', '2', '3']);
      splitVia('2'); // p0 = [0, 1, 3], p1 = [2]
      dropOnPane('3', 1, 'right'); // p2 = [3]
      const [first] = sashes();
      press(first!, 500);
      dragTo(first!, 550);
      expect(widthOf('p0')).toBeCloseTo(55);
      broadcast(['0', '1', '2']); // another window closed 3: p2 is gone, its room goes to the rest
      const reshaped = widthOf('p0');
      expect(strips().map((x) => x.pane)).toEqual(['p0', 'p1']);
      dragTo(first!, 650); // a frame measured against the shape the drag began on
      expect(widthOf('p0')).toBe(reshaped);
      release(first!, 650);
      expect(saved().root.children[0].size).toBeCloseTo(reshaped / 100);
    });

    it('settles the layout the window has now when the dragged sash is removed mid-drag', () => {
      setup(['0', '1', '2', '3']);
      splitVia('2');
      dropOnPane('3', 1, 'right'); // p0 | p1 | p2, two sashes
      const second = sashes()[1]!;
      press(second, 800);
      dragTo(second, 850);
      broadcast(['0', '1', '2']); // p2 goes, and the sash between p1 and p2 with it
      expect(sashes()).toHaveLength(1);
      expect(saved().root.children.map((c: { id: string }) => c.id)).toEqual(['p0', 'p1']);
      splitVia('1'); // the drag is over: commands work again
      expect(strips()).toHaveLength(3);
    });

    it('hands each strip the same props on every frame, so a drag does not redraw them', () => {
      setup(['0', '1', '2']);
      splitVia('2');
      const [sash] = sashes();
      press(sash!, 500);
      dragTo(sash!, 520);
      const frame = () => stripSpy.renders.filter((r) => r['paneId'] === 'p0').slice(-2);
      dragTo(sash!, 540);
      const [before, after] = frame();
      expect(before).toBeDefined();
      for (const key of Object.keys(after!)) {
        expect(Object.is(after![key], before![key]), key).toBe(true);
      }
      release(sash!, 540);
    });
  });

  describe('on a phone', () => {
    it('shows one pane and no strip, drop overlay or split item, and leaves the saved layout alone', () => {
      localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'on' }));
      sessionStorage.setItem('palmux-layout', TWO_COLUMNS);
      setup(['0', '1', '2']);
      expect(document.querySelectorAll('.group-strip')).toHaveLength(0);
      expect(panes()).toEqual([{ slot: 'p0', session: '0', focused: false }]);
      expect(sessionStorage.getItem('palmux-layout')).toBe(TWO_COLUMNS);
      // The drawer still lists every tab.
      expect(drawer().tabs.map((t) => t.id)).toEqual(['0', '1', '2']);
      expect(screen.queryAllByTestId('group-drop-overlay')).toHaveLength(0);
    });
  });
});

describe('the split chords', () => {
  const chord = (key: 'd' | 'e') =>
    fireEvent.keyDown(window, { key, ctrlKey: true, shiftKey: true });

  // Ctrl+Shift+D: the focused pane's active tab moves into a new pane to its right.
  it('Split right moves the tab', () => {
    setup(['0', '1']);
    clickTab('1');
    chord('d');
    expect(strips()).toEqual([
      { pane: 'p0', tabs: ['0'], focused: false },
      { pane: 'p1', tabs: ['1'], focused: true },
    ]);
    expect(panes()).toEqual([
      { slot: 'p0', session: '0', focused: false },
      { slot: 'p1', session: '1', focused: true },
    ]);
  });

  it('Split down on a lone tab opens a new terminal in the pane below', () => {
    setup(['0', '1']);
    chord('d'); // tab 0 moves into a new pane on the right, leaving p0 = [1]
    chord('e'); // that pane holds 0 alone, so it splits down into a NEW terminal
    expect(strips().map((x) => x.pane)).toEqual(['p0', 'p1', 'p2']);
    expect(panes()).toEqual([
      { slot: 'p0', session: '1', focused: false },
      { slot: 'p1', session: '0', focused: false },
      { slot: 'p2', session: '2', focused: true },
    ]);
    expect(shownIn('p1')).toBe('0'); // the pane it split from still shows its own tab
  });

  it('does nothing on the New-tab page', () => {
    setup(['0']);
    broadcast([]);
    chord('d');
    expect(document.querySelectorAll('.group-strip')).toHaveLength(1);
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
});

interface SavedNode {
  tabs?: { id: string }[];
  children?: SavedNode[];
}
const savedNodeIds = (node: SavedNode): string[] => [
  ...(node.tabs ?? []).map((t) => t.id),
  ...(node.children ?? []).flatMap(savedNodeIds),
];
/** Every tab id the window's saved layout holds. */
const savedIds = (): string[] => {
  const raw = sessionStorage.getItem('palmux-layout');
  return raw === null ? [] : savedNodeIds((JSON.parse(raw) as { root: SavedNode }).root);
};
/** Turn the mobile layer on or off through the real Settings field: the dock, or the drawer. */
const flipMobile = (mode: 'on' | 'off') => {
  fireEvent.keyDown(window, { key: ',', ctrlKey: true });
  fireEvent.click(screen.getByTestId(`set-mobile-${mode}`));
  expect(document.querySelector('.app')!.classList.contains('mobile')).toBe(mode === 'on');
};
/** A plain tap on a drawer row: press and release in place. */
const tapDrawerRow = (id: string) => {
  const row = screen.getByTestId(`drawer-session-${id}`);
  fireEvent.pointerDown(row, { pointerType: 'mouse' });
  fireEvent.pointerUp(row, { pointerType: 'mouse' });
};

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
    expect(panes()).toEqual([{ slot: 'p0', session: '0', focused: false }]);
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

  // The list is not empty, so no "last tab went" decision fires, but the one pane's only tab is
  // gone: its id came back as an editor, a different tab, which joins the pane without becoming
  // its selection. The pane shows nothing, and showing nothing is the New-tab page, not a blank.
  it('shows the New-tab page when the only tab’s id comes back as another kind', () => {
    setup(['0']);
    expect(panes()).toEqual([{ slot: 'p0', session: '0', focused: false }]);
    const socketsBefore = sockets.length;
    const lastTabBefore = localStorage.getItem('palmux-last-tab');
    send({ type: 'sessions', tabs: [{ id: '0', kind: 'editor' }] });
    expect(screen.getByTestId('newtab-page')).toBeTruthy();
    expect(strips()).toEqual([{ pane: 'p0', tabs: ['0'], focused: true }]);
    expect(shownIn('p0')).toBeUndefined(); // the editor is listed, not selected
    expect(panes()).toEqual([]);
    expect(screen.queryByTestId('pane-host')).toBeNull();
    expect(sockets).toHaveLength(socketsBefore);
    // Nothing was selected, so the device-wide tab is not moved onto the editor.
    expect(localStorage.getItem('palmux-last-tab')).toBe(lastTabBefore);
  });

  // The page is the content from the render that empties the pane, not from the one after: the
  // pane host mounts a pane for every non-terminal tab it is handed, and an editor's mount starts
  // loading Monaco and the file, on a window that shows only a terminal.
  it('hands the pane host nothing for the editor the id came back as, not even for one render', () => {
    setup(['0']);
    paneHost.renders = [];
    send({ type: 'sessions', tabs: [{ id: '0', kind: 'editor' }] });
    expect(screen.getByTestId('newtab-page')).toBeTruthy();
    const editorHanded = paneHost.renders.some((tabs) =>
      tabs.some((t) => t.id === '0' && t.kind === 'editor'),
    );
    expect(editorHanded).toBe(false);
  });

  // The window's own value says what a reload of this window opens. The page selects nothing, so
  // the tab the closed id came back as is not stored as its selection.
  it.each([
    ['in the broadcast that empties the pane', false],
    ['while the page is already up', true],
  ] as const)('stores no window selection for the recycled id, %s', (_name, pageFirst) => {
    setup(['0']);
    if (pageFirst) broadcast([]);
    send({ type: 'sessions', tabs: [{ id: '0', kind: 'editor' }] });
    expect(screen.getByTestId('newtab-page')).toBeTruthy();
    expect(sessionStorage.getItem('palmux-window-tab')).toBeNull();
  });

  // The phone's page keeps the closed id as `sessionId` too, so a tap is not "already there" just
  // because it names that id, and a tap on any tab leaves the page.
  describe('on the phone page, a drawer tap', () => {
    beforeEach(() => {
      localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'on' }));
    });

    /** The phone's way into the drawer: a right→left swipe across the extra-keys bar. */
    const swipeDrawerOpen = () => {
      const key = screen.getAllByTestId(/^extra-key-/)[0]!;
      const touch = { pointerId: 1, pointerType: 'touch', clientY: 100 };
      fireEvent.pointerDown(key, { ...touch, clientX: 300 });
      fireEvent.pointerMove(key, { ...touch, clientX: 100 });
      fireEvent.pointerUp(key, { ...touch, clientX: 100 });
      expect(drawerIsOpen()).toBe(true);
    };

    it('on a tab another window opened leaves the page and shows it', () => {
      setup(['0']);
      broadcast([]);
      broadcast(['5']);
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
      swipeDrawerOpen();
      tapDrawerRow('5');
      expect(drawerIsOpen()).toBe(false);
      expect(screen.queryByTestId('newtab-page')).toBeNull();
      expect(panes()).toEqual([{ slot: 'p0', session: '5', focused: false }]);
    });

    it('on the tab the closed id came back as shows it', () => {
      setup(['0']);
      broadcast([]);
      send({ type: 'sessions', tabs: [{ id: '0', kind: 'editor' }] });
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
      swipeDrawerOpen();
      tapDrawerRow('0');
      expect(drawerIsOpen()).toBe(false);
      expect(screen.queryByTestId('newtab-page')).toBeNull();
      expect(Object.keys(paneHost.rects)).toEqual(['0']);
      expect(panes()).toEqual([]);
    });

    // The drawer appends a `current` the list lacks as a terminal row (a terminal this window just
    // picked an id for). The page's `current` is the closed id, so that row would be a ghost, and
    // tapping it leaves the page onto a terminal pane that attaches and spawns a shell there.
    it('cannot be on the closed tab: the drawer lists no row for it', async () => {
      setup(['0']);
      const socketsBefore = sockets.length;
      broadcast([]);
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
      swipeDrawerOpen();
      // The row the tab had leaves on the micro tier; a row for the closed id must not stay.
      await waitFor(() => expect(screen.queryByTestId('drawer-session-0')).toBeNull());
      expect(drawer().current).toBe('');
      expect(panes()).toEqual([]);
      expect(sockets).toHaveLength(socketsBefore);
    });

    // The page selects nothing, so the closed id is no tab on screen for the groups either, even
    // once another window recycles it into a group: the group neither unfolds on its own nor takes
    // the fold guard's way out (select the nearest outside tab), which would drop the page.
    describe('on a group header, with the closed id recycled into the group', () => {
      const gid = 'gaa111';
      const header = () => screen.getByTestId(`drawer-group-${gid}`);
      const tapHeader = () => {
        fireEvent.pointerDown(header(), { pointerType: 'mouse' });
        fireEvent.pointerUp(header(), { pointerType: 'mouse' });
      };
      /** The page, with tabs 1 (in the group) and 2 another window opened, and the drawer open. */
      const pageWithGroup = () => {
        setup(['0']);
        broadcast([]);
        sendGroups([{ id: '1', groupId: gid }, { id: '2' }], [{ id: gid, color: 'blue' }]);
        expect(screen.getByTestId('newtab-page')).toBeTruthy();
        swipeDrawerOpen();
      };
      /** Another window creates a terminal in the group; it takes the lowest free id, the closed 0. */
      const recycleIntoGroup = () =>
        sendGroups(
          [{ id: '0', groupId: gid }, { id: '1', groupId: gid }, { id: '2' }],
          [{ id: gid, color: 'blue' }],
        );
      const stillOnPage = (socketsBefore: number) => {
        expect(screen.getByTestId('newtab-page')).toBeTruthy();
        expect(drawer().current).toBe('');
        expect(panes()).toEqual([]);
        expect(sockets).toHaveLength(socketsBefore);
      };

      it('a group this device folded stays folded', () => {
        pageWithGroup();
        const socketsBefore = sockets.length;
        tapHeader();
        expect(header()).toHaveAttribute('aria-expanded', 'false');
        recycleIntoGroup();
        expect(header()).toHaveAttribute('aria-expanded', 'false');
        stillOnPage(socketsBefore);
      });

      it('folding the group stays on the page', () => {
        pageWithGroup();
        const socketsBefore = sockets.length;
        recycleIntoGroup();
        expect(header()).toHaveAttribute('aria-expanded', 'true');
        tapHeader();
        expect(header()).toHaveAttribute('aria-expanded', 'false');
        stillOnPage(socketsBefore);
      });
    });
  });

  // The page keeps the closed tab's id in `sessionId`. Turning the mobile layer on or off under it
  // must not read that id as a selection: on the one-pane path it is a terminal the server does not
  // list, and a pane mounted on it attaches `/ws?session=<dead id>` and spawns a shell there.
  describe('across a mobile-layer flip', () => {
    it('from the desktop page to the phone, stays on the page and attaches nothing', () => {
      setup(['0']);
      broadcast([]);
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
      const socketsBefore = sockets.length;
      flipMobile('on');
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
      expect(panes()).toEqual([]);
      expect(sockets).toHaveLength(socketsBefore);
    });

    it('from the phone page to the desktop, stays on the page and saves no pane for the dead id', () => {
      localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'on' }));
      setup(['0']);
      broadcast([]);
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
      flipMobile('off');
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
      expect(panes()).toEqual([]);
      expect(sessionStorage.getItem('palmux-layout')).not.toBeNull();
      expect(savedIds()).not.toContain('0');
      // A terminal made and closed from here goes back to the page, and the dead id never returns.
      tapPress(screen.getByTestId('dash-new-terminal'));
      const created = active()!;
      expect(created).not.toBe('0');
      expect(panes()).toEqual([{ slot: 'p0', session: created, focused: false }]);
      broadcast([created]);
      broadcast([]);
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
      expect(panes()).toEqual([]);
      expect(savedIds()).not.toContain('0');
    });

    it.each(['off', 'on'] as const)(
      'with mobileMode %s, creating a terminal from the page mounts its pane',
      (mode) => {
        localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: mode }));
        setup(['0']);
        broadcast([]);
        tapPress(screen.getByTestId('dash-new-terminal'));
        expect(screen.queryByTestId('newtab-page')).toBeNull();
        expect(panes()).toEqual([{ slot: 'p0', session: '1', focused: false }]);
      },
    );

    // A review swaps the extra-keys bar for its own, but the page shows no review: the bar is
    // the extra-keys one, which keeps the drawer swipe.
    it('from a desktop page whose closed id came back as a review, the phone keeps the extra-keys bar', () => {
      setup(['0']);
      send({ type: 'sessions', tabs: [{ id: '0', kind: 'review', url: 'changes:/home/u/app' }] });
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
      flipMobile('on');
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
      expect(document.getElementById('extra-keys-bar')).not.toBeNull();
      expect(screen.queryByTestId('review-bar')).toBeNull();
    });
  });

  // A terminal this window creates exists on the server only once its pane attaches. An empty
  // list that lands first (from before the attach) says nothing about it: the New-tab page would
  // unmount the pane that is about to spawn it, and the window would sit on the page beside a
  // pill for a terminal that never starts.
  it('an empty list that lands before a just-created terminal is listed keeps its pane', () => {
    setup(['0']);
    broadcast([]);
    tapPress(screen.getByTestId('dash-new-terminal'));
    const created = active()!;
    expect(screen.queryByTestId('newtab-page')).toBeNull();
    broadcast([]);
    expect(screen.queryByTestId('newtab-page')).toBeNull();
    expect(panes()).toEqual([{ slot: 'p0', session: created, focused: false }]);
    broadcast([created]); // its attach spawned it
    expect(screen.queryByTestId('newtab-page')).toBeNull();
    expect(panes()).toEqual([{ slot: 'p0', session: created, focused: false }]);
    expect(strips()).toEqual([{ pane: 'p0', tabs: [created], focused: true }]);
    // Closed for real now, so the page comes back.
    broadcast([]);
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

    // A terminal this window just created is pending until a broadcast lists it, so the pane that
    // is about to spawn it is not dropped by a list that lacks it. Two frames handled before one
    // render show only the SECOND to the layout: a first that lists the terminal and a second that
    // omits it again (it was killed) used to leave the id pending for ever, and the pane for a
    // terminal the server no longer has stayed mounted, a "Session ended" pane in the real app.
    it('a terminal the first frame lists and the second omits is not left pending', () => {
      setup(['0']);
      fireEvent.pointerDown(stripOf('p0').getByTestId('session-new'), { button: 0 });
      tapPress(screen.getByTestId('dash-new-terminal'));
      expect(panes()).toEqual([{ slot: 'p0', session: '1', focused: false }]);
      act(() => {
        server().handler!({ type: 'sessions', tabs: terms(['0', '1']) });
        server().handler!({ type: 'sessions', tabs: terms(['0']) });
      });
      expect(panes()).toEqual([{ slot: 'p0', session: '0', focused: false }]);
      expect(strips()).toEqual([{ pane: 'p0', tabs: ['0'], focused: true }]);
    });

    it('and the window goes to the New-tab page when that was its only tab', () => {
      setup(['0']);
      broadcast([]);
      tapPress(screen.getByTestId('dash-new-terminal'));
      const created = active()!;
      act(() => {
        server().handler!({ type: 'sessions', tabs: terms([created]) });
        server().handler!({ type: 'sessions', tabs: [] });
      });
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
      expect(panes()).toEqual([]);
    });

    // The exception to forgetting a listed id: reconcile adopts the kind the list states only while
    // the id is still pending, so an id the layout holds as a terminal (the guess for a tab this
    // window learned of from its `tabCreated`) that the list says is an editor stays pending for the
    // render that adopts it. Forgotten at once it would be dropped as a recycled id.
    it('a guessed terminal the list states as an editor takes the listed kind', () => {
      setup(['0']);
      send({ type: 'tabCreated', id: '7' }); // shown before any list holds it
      expect(shownIn('p0')).toBe('7');
      act(() => {
        server().handler!({
          type: 'sessions',
          tabs: [...terms(['0']), { id: '7', kind: 'editor' }],
        });
      });
      expect(strips()).toEqual([{ pane: 'p0', tabs: ['0', '7'], focused: true }]);
      expect(shownIn('p0')).toBe('7');
    });

    // The other half of the rule: an id nobody has listed yet stays pending across a broadcast
    // that lacks it, even when two such frames land in one render.
    it('a terminal no frame has listed yet survives two frames that lack it', () => {
      setup(['0']);
      fireEvent.pointerDown(stripOf('p0').getByTestId('session-new'), { button: 0 });
      tapPress(screen.getByTestId('dash-new-terminal'));
      act(() => {
        server().handler!({ type: 'sessions', tabs: terms(['0']) });
        server().handler!({ type: 'sessions', tabs: terms(['0']) });
      });
      expect(panes()).toEqual([{ slot: 'p0', session: '1', focused: false }]);
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

    fireEvent.pointerDown(screen.getByTestId('term-pane-p0'));
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
// strip unit (pill, chip — in strip order) is handed a rect.
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

  it('keeps the address at / while splitting and moving tabs between panes', () => {
    setup();
    const historyLength = history.length;
    splitVia('1');
    expect(location.pathname).toBe('/');
    clickTab('2');
    expect(location.pathname).toBe('/');
    dropOnPane('2', 1, 'centre');
    expect(location.pathname).toBe('/');
    expect(history.length).toBe(historyLength);
  });
});

// An installed PWA is relaunched from nothing: Android ends its browsing context, and
// `sessionStorage` goes with it, so the window used to come back on the FIRST tab.
// The device keeps its last selected tab in `localStorage` as a fallback that a window
// reads only when it has none of its own. The risk is on the WRITE side: the persist
// effect re-runs on every tab-list broadcast, and a window that merely heard a rename
// must never overwrite the tab another window just chose.
describe('the last tab survives a relaunch', () => {
  const LAST = 'palmux-last-tab';
  const OWN = 'palmux-window-tab';
  const lastTab = (): unknown => JSON.parse(localStorage.getItem(LAST) ?? 'null');
  const ownTab = (): unknown => JSON.parse(sessionStorage.getItem(OWN) ?? 'null');
  type Spec = { id: string; kind?: string; name?: string; url?: string; window?: string };
  const DETACHED = 'wq3k9x2m1ab';
  const tabsOf = (specs: Spec[]) => specs.map((t) => ({ kind: 'terminal', ...t }));
  const sessions = (specs: Spec[]) => send({ type: 'sessions', tabs: tabsOf(specs) });
  const terms = (ids: string[]): Spec[] => ids.map((id) => ({ id }));
  /** A window opened at `/`, with whatever the two storages already hold. */
  const boot = (specs: Spec[]) => {
    const view = render(<App />);
    sessions(specs);
    return view;
  };
  /** The OS ended the window and the PWA was opened again: a new browsing context
   *  (no sessionStorage) on the same device (same localStorage), a new socket. */
  const relaunch = (view: { unmount: () => void }, specs: Spec[]) => {
    view.unmount();
    sessionStorage.clear();
    sockets.length = 0;
    return boot(specs);
  };
  /** The strip's selected tab, which also answers for tabs with no terminal pane. */
  const selectedTab = (): string | null =>
    document
      .querySelector('[data-testid^="session-tab-"][aria-selected="true"]')
      ?.getAttribute('data-testid')
      ?.replace('session-tab-', '') ?? null;

  beforeEach(() => {
    history.replaceState(null, '', '/');
    sessionStorage.clear();
  });

  it('comes back on the tab that was selected when the window was last closed', () => {
    const first = boot(terms(['0', '1', '2']));
    expect(active()).toBe('0'); // nothing remembered: the first tab
    clickTab('2');
    expect(lastTab()).toEqual({ id: '2', kind: 'terminal' });

    relaunch(first, terms(['0', '1', '2']));
    expect(active()).toBe('2');
  });

  it('never moves a window that has a selection of its own', () => {
    localStorage.setItem(LAST, JSON.stringify({ id: '2', kind: 'terminal' }));
    sessionStorage.setItem(OWN, JSON.stringify({ id: '1', kind: 'terminal' }));
    boot(terms(['0', '1', '2']));
    expect(active()).toBe('1');
  });

  it('opens the first tab when the stored tab is gone or came back as another kind', () => {
    localStorage.setItem(LAST, JSON.stringify({ id: '1', kind: 'editor' })); // 1 is a terminal now
    boot(terms(['0', '1', '2']));
    expect(active()).toBe('0');
  });

  it('opens the first tab when the stored value is unusable', () => {
    localStorage.setItem(LAST, '{oops');
    boot(terms(['0', '1', '2']));
    expect(active()).toBe('0');
  });

  // `?new=1` is an INTENT and a legacy `/<id>` names its tab outright; neither
  // consults what was remembered.
  it('lets a legacy /<id> address win over the stored tab', () => {
    localStorage.setItem(LAST, JSON.stringify({ id: '2', kind: 'terminal' }));
    history.replaceState(null, '', '/1');
    boot(terms(['0', '1', '2']));
    expect(active()).toBe('1');
  });

  // The pre-existing contract: the attach to an id the list lacks spawns a terminal there.
  it('opens a legacy /<id> the list lacks as a fresh terminal', () => {
    history.replaceState(null, '', '/5');
    boot(terms(['0', '1']));
    expect(panes()).toEqual([{ slot: 'p0', session: '5', focused: false }]);
    expect(strips().map((s) => s.tabs)).toEqual([['0', '1', '5']]);
  });

  /**
   * Put a spy between the app and `localStorage` for ONE key: every value written to
   * it is recorded, and `denied` makes any access to it throw. Everything else passes
   * through, so the rest of the app is unaffected.
   */
  const watchKey = (key: string, denied = false) => {
    const writes: string[] = [];
    let touched = 0;
    const real = localStorage;
    vi.stubGlobal(
      'localStorage',
      new Proxy(real, {
        get(target, prop) {
          if (prop === 'getItem' || prop === 'setItem') {
            return (k: string, v?: string) => {
              if (k === key) {
                touched++;
                if (denied) throw new Error('denied');
                if (prop === 'setItem') writes.push(String(v));
              }
              return prop === 'getItem' ? target.getItem(k) : target.setItem(k, String(v));
            };
          }
          const member = Reflect.get(target, prop) as unknown;
          return typeof member === 'function' ? member.bind(target) : member;
        },
      }),
    );
    return { writes, touched: () => touched };
  };
  afterEach(() => vi.unstubAllGlobals());

  it('boots when the device-wide key cannot be read or written', () => {
    const watch = watchKey(LAST, true);
    boot(terms(['0', '1']));
    expect(active()).toBe('0');
    clickTab('1');
    expect(active()).toBe('1');
    // Proof the stub was in the way: the app did reach for the key, and survived.
    expect(watch.touched()).toBeGreaterThan(0);
  });

  // Ctrl+W must never reach the browser's "close tab", which closes the whole app.
  describe('Ctrl+W', () => {
    const chord = (mods: { ctrlKey?: boolean; metaKey?: boolean; repeat?: boolean }) => {
      const e = new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', bubbles: true, cancelable: true, ...mods });
      window.dispatchEvent(e);
      return e;
    };

    it('closes the active file tab and claims the chord', () => {
      boot([{ id: '0' }, { id: '7', kind: 'editor', name: 'notes' }]);
      clickTab('7');
      expect(chord({ ctrlKey: true }).defaultPrevented).toBe(true);
      expect(server().killed).toEqual(['7']);
    });

    it('closes a web tab too, once per press however long it is held', () => {
      boot([{ id: '0' }, { id: '3', kind: 'web', url: 'https://example.com' }]);
      clickTab('3');
      chord({ ctrlKey: true });
      expect(chord({ ctrlKey: true, repeat: true }).defaultPrevented).toBe(true);
      expect(server().killed).toEqual(['3']);
    });

    it('leaves the terminal tab open and claims the chord for the shell', () => {
      const confirm = vi.spyOn(window, 'confirm');
      boot(terms(['0', '1']));
      expect(chord({ ctrlKey: true }).defaultPrevented).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
      expect(server().killed).toEqual([]);
      confirm.mockRestore();
    });

    it('closes a terminal on Cmd+W behind the kill confirm', () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      boot(terms(['0', '1']));
      expect(chord({ metaKey: true }).defaultPrevented).toBe(true);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(server().killed).toEqual(['0']);
      confirm.mockRestore();
    });

    it('swallows the chord and closes nothing on the New-tab page', () => {
      boot([]);
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
      expect(chord({ metaKey: true }).defaultPrevented).toBe(true);
      expect(server().killed).toEqual([]);
    });

    // The page keeps the closed tab's id, and that id can come back as another kind. The page does
    // not show the newcomer, so the chord is claimed and closes nothing.
    it('closes nothing on the New-tab page when the closed id came back as an editor', () => {
      boot(terms(['0']));
      sessions([{ id: '0', kind: 'editor' }]);
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
      expect(chord({ ctrlKey: true }).defaultPrevented).toBe(true);
      expect(server().killed).toEqual([]);
      expect(screen.getByTestId('session-tab-0')).toBeTruthy(); // the editor is still listed
    });

    // The pop-out used to be left alone here so the browser could close its window. A detached
    // window is the main window's twin: the chord closes the TAB, never the window.
    it('closes the active tab in a detached window, as in the main window', () => {
      history.replaceState(null, '', `/window/${DETACHED}?tab=0`);
      boot([
        { id: '0', window: DETACHED },
        { id: '7', kind: 'editor', name: 'notes', window: DETACHED },
      ]);
      expect(active()).toBe('0');
      clickTab('7');
      expect(chord({ ctrlKey: true }).defaultPrevented).toBe(true);
      expect(server().killed).toEqual(['7']);
    });
  });

  // The retired `/popout/<id>` is a detached window with an id of its own: what the pop-out wrote
  // (nothing, to either key) a detached window writes under a key of its own.
  describe('a retired pop-out address', () => {
    const widOfAddress = () => /^\/window\/(w[0-9a-z]{10})$/.exec(location.pathname)?.[1];
    /** The window connects, then the server lists the tabs: the order a real client sees. */
    const bootRetired = (specs: Spec[]) => {
      render(<App />);
      connect();
      sessions(specs);
    };

    it('boots a detached window that writes neither main key, and its own selection', () => {
      history.replaceState(null, '', '/popout/0');
      bootRetired(terms(['0', '1']));
      const wid = widOfAddress();
      expect(wid).toBeTruthy();
      expect(active()).toBe('0');
      expect(lastTab()).toBeNull();
      expect(ownTab()).toBeNull();
      expect(JSON.parse(sessionStorage.getItem(`${OWN}:${wid}`) ?? 'null')).toEqual({
        id: '0',
        kind: 'terminal',
      });
    });

    it('leaves the main window\'s remembered tab alone', () => {
      localStorage.setItem(LAST, JSON.stringify({ id: '2', kind: 'terminal' }));
      sessionStorage.setItem(OWN, JSON.stringify({ id: '2', kind: 'terminal' }));
      history.replaceState(null, '', '/popout/0');
      bootRetired(terms(['0', '1', '2']));
      sessions(terms(['0', '1', '2', '3']));
      expect(lastTab()).toEqual({ id: '2', kind: 'terminal' });
      expect(ownTab()).toEqual({ id: '2', kind: 'terminal' });
    });
  });

  describe('what writes the device-wide value', () => {
    // B9-01. Window B selected tab 2; window A, still on tab 1, hears a rename. The
    // persist effect re-runs for A because `tabs` is a new array — and must not write.
    it('is not rewritten by a tab-list broadcast', () => {
      boot(terms(['0', '1', '2']));
      clickTab('1');
      expect(lastTab()).toEqual({ id: '1', kind: 'terminal' });

      localStorage.setItem(LAST, JSON.stringify({ id: '2', kind: 'terminal' })); // window B
      sessions([{ id: '0' }, { id: '1', name: 'renamed' }, { id: '2' }]); // a title/name change
      sessions([{ id: '2' }, { id: '0' }, { id: '1', name: 'renamed' }]); // a reorder
      expect(active()).toBe('1');
      expect(lastTab()).toEqual({ id: '2', kind: 'terminal' });
      expect(ownTab()).toEqual({ id: '1', kind: 'terminal' }); // the window's own is unaffected
    });

    it('is written when the selection changes, and only then', () => {
      boot(terms(['0', '1', '2']));
      const { writes } = watchKey(LAST);
      clickTab('1');
      clickTab('2');
      clickTab('2'); // the same tab again
      expect(writes).toEqual([
        JSON.stringify({ id: '1', kind: 'terminal' }),
        JSON.stringify({ id: '2', kind: 'terminal' }),
      ]);
    });

    // A just-created tab is navigated to before any broadcast lists it, so it does
    // not resolve to a known tab yet. The write waits for it, and happens once.
    it('is written once a created tab resolves on a later broadcast', () => {
      boot(terms(['0', '1']));
      expect(lastTab()).toEqual({ id: '0', kind: 'terminal' });
      send({ type: 'tabCreated', id: '7' });
      expect(active()).toBe('7');
      expect(lastTab()).toEqual({ id: '0', kind: 'terminal' }); // not known yet: nothing stored

      sessions(terms(['0', '1'])); // a broadcast that does not list it yet
      expect(lastTab()).toEqual({ id: '0', kind: 'terminal' });

      const { writes } = watchKey(LAST);
      sessions([{ id: '0' }, { id: '1' }, { id: '7', kind: 'editor' }]);
      sessions([{ id: '0' }, { id: '1' }, { id: '7', kind: 'editor', name: 'notes' }]);
      expect(lastTab()).toEqual({ id: '7', kind: 'editor' });
      expect(writes).toEqual([JSON.stringify({ id: '7', kind: 'editor' })]);
    });

    // What this window last stored is only a fact while it holds. Once its selection
    // resolves to nothing (here, a tab no broadcast lists yet) the next selection is
    // a real choice again, and another window may have moved the shared key meanwhile.
    it('is written when a tab is re-selected after the selection resolved to nothing', () => {
      boot(terms(['0', '1']));
      expect(lastTab()).toEqual({ id: '0', kind: 'terminal' });
      send({ type: 'tabCreated', id: '9' }); // navigated to a tab no broadcast lists
      localStorage.setItem(LAST, JSON.stringify({ id: '1', kind: 'terminal' })); // another window

      clickTab('0');
      expect(lastTab()).toEqual({ id: '0', kind: 'terminal' });
    });

    // The same id as a different kind is a different tab, not the one this window was showing: the
    // layout drops the old one, as for any closed tab, and the window moves to its neighbour (the
    // recycled id joins the focused pane without taking over, like any tab another window made).
    it('moves off a selected id that comes back as another kind, to the neighbour', () => {
      boot(terms(['0', '1']));
      expect(lastTab()).toEqual({ id: '0', kind: 'terminal' });
      sessions([{ id: '0', kind: 'editor' }, { id: '1' }]);
      expect(lastTab()).toEqual({ id: '1', kind: 'terminal' });
    });

    // B9-R2-01. Closing the last terminal `0` and creating an editor that reuses id
    // `0` must not leave `{0, terminal}` stored: a relaunch rejects it on kind and
    // lands on the first tab, which is not the editor once another tab sits before it.
    it('follows an id that is closed with the last tab and reused as another kind', () => {
      const first = boot(terms(['0']));
      expect(lastTab()).toEqual({ id: '0', kind: 'terminal' });

      sessions([]); // the last tab closes: the New-tab page
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
      send({ type: 'tabCreated', id: '0' }); // the server hands the freed id to an editor
      sessions([{ id: '0', kind: 'editor' }]);
      expect(lastTab()).toEqual({ id: '0', kind: 'editor' });

      // Another tab arrives and a reorder puts it before the editor.
      sessions([{ id: '1' }, { id: '0', kind: 'editor' }]);
      expect(lastTab()).toEqual({ id: '0', kind: 'editor' });
      expect(selectedTab()).toBe('0');

      relaunch(first, [{ id: '1' }, { id: '0', kind: 'editor' }]);
      expect(selectedTab()).toBe('0'); // not the first tab, `1`
    });

    // The window on the New-tab page still holds the dead id, but it has selected
    // nothing: another window's tab that reuses that id is not this window's choice.
    it('is not written by a window sitting on the New-tab page', () => {
      boot(terms(['0']));
      sessions([]);
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
      localStorage.setItem(LAST, JSON.stringify({ id: '5', kind: 'terminal' })); // another window

      sessions([{ id: '0', kind: 'editor' }]); // that window created an editor with id 0
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
      expect(lastTab()).toEqual({ id: '5', kind: 'terminal' });
    });

    describe('at boot', () => {
      /** The SAME window reloaded: a new document and socket in the same browsing
       *  context, so its sessionStorage survives (unlike `relaunch`). */
      const reload = (view: { unmount: () => void }, specs: Spec[]) => {
        view.unmount();
        sockets.length = 0;
        return boot(specs);
      };

      // B9-CODE-01. A reload RESTORES this window's tab; it selects nothing. Window A
      // chose tab 1, then window B chose tab 2, so 2 is the device's last selection —
      // and a fresh window must open it, not the older tab A merely came back on.
      it("is not rewritten by a reload that restores the window's own tab", () => {
        const a = boot(terms(['0', '1', '2']));
        clickTab('1');
        expect(ownTab()).toEqual({ id: '1', kind: 'terminal' });
        localStorage.setItem(LAST, JSON.stringify({ id: '2', kind: 'terminal' })); // window B

        const reloaded = reload(a, terms(['0', '1', '2']));
        expect(active()).toBe('1');
        expect(lastTab()).toEqual({ id: '2', kind: 'terminal' });
        sessions([{ id: '0' }, { id: '1', name: 'renamed' }, { id: '2' }]); // nor by a later broadcast
        expect(lastTab()).toEqual({ id: '2', kind: 'terminal' });

        relaunch(reloaded, terms(['0', '1', '2'])); // a fresh window on this device
        expect(active()).toBe('2');
      });

      it('still writes a selection made after a reload, the restored tab included', () => {
        const a = boot(terms(['0', '1', '2']));
        clickTab('1');
        localStorage.setItem(LAST, JSON.stringify({ id: '2', kind: 'terminal' })); // window B
        reload(a, terms(['0', '1', '2']));

        clickTab('0');
        expect(lastTab()).toEqual({ id: '0', kind: 'terminal' });
        clickTab('1');
        expect(lastTab()).toEqual({ id: '1', kind: 'terminal' });
      });

      // Nothing stored device-wide means there is no newer choice to protect, and the
      // restored tab is the best answer a relaunch could have.
      it('is initialised by a reload when the device has no last tab yet', () => {
        sessionStorage.setItem(OWN, JSON.stringify({ id: '1', kind: 'terminal' }));
        boot(terms(['0', '1', '2']));
        expect(active()).toBe('1');
        expect(lastTab()).toEqual({ id: '1', kind: 'terminal' });
      });

      // The window's own tab came back as another kind: it lands somewhere else, and
      // that move is a change of selection like any other.
      it('is written when the restored tab is gone and the window lands elsewhere', () => {
        localStorage.setItem(LAST, JSON.stringify({ id: '2', kind: 'terminal' }));
        sessionStorage.setItem(OWN, JSON.stringify({ id: '1', kind: 'editor' }));
        boot(terms(['0', '1', '2']));
        expect(active()).toBe('0');
        expect(lastTab()).toEqual({ id: '0', kind: 'terminal' });
      });

      // `?new=1` and a legacy `/<id>` are instructions, not restores.
      it('is written by a legacy /<id> boot', () => {
        localStorage.setItem(LAST, JSON.stringify({ id: '2', kind: 'terminal' }));
        sessionStorage.setItem(OWN, JSON.stringify({ id: '2', kind: 'terminal' }));
        history.replaceState(null, '', '/1');
        boot(terms(['0', '1', '2']));
        expect(active()).toBe('1');
        expect(lastTab()).toEqual({ id: '1', kind: 'terminal' });
      });

      it('is written by a ?new=1 boot once the new terminal is listed', () => {
        localStorage.setItem(LAST, JSON.stringify({ id: '2', kind: 'terminal' }));
        sessionStorage.setItem(OWN, JSON.stringify({ id: '2', kind: 'terminal' }));
        history.replaceState(null, '', '/?new=1');
        boot(terms(['0', '1', '2']));
        expect(active()).toBe('3');
        sessions(terms(['0', '1', '2', '3']));
        expect(lastTab()).toEqual({ id: '3', kind: 'terminal' });
      });
    });
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
      expect(screen.queryByTestId('term-pane-p0')).toBeNull();
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

// The topbar ENDS with an app menu (it replaced the wordmark, then moved over the
// rail). It is a second pointer route to Settings beside the rail's, and the one
// place Reload app can be reached without opening a panel — so it carries the same discard guard Settings does.
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

  // There is no topbar: each pane draws its own tab strip, and the menu took the wordmark's
  // place at the top of the dock rail.
  it('tops the dock rail, where the wordmark and the topbar used to be', () => {
    setup();
    expect(document.querySelector('.topbar')).toBeNull();
    expect(document.querySelector('.topbar-brand')).toBeNull();
    const button = screen.getByTestId('app-menu-button');
    expect(button).toHaveAttribute('aria-label', 'palmux menu');
    expect(button.querySelector('svg')?.innerHTML).toBe(iconPaths('menu'));
    // The rail's first control, above New tab.
    expect(screen.getByTestId('dock-rail').firstElementChild).toBe(button);
    expect(
      button.compareDocumentPosition(screen.getByTestId('dock-rail-newtab')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // The panes start at the top edge. In window-controls-overlay mode the native controls lie over
  // it, so an empty drag region above the content row keeps them off the panes and the rail (the
  // stylesheet shows it only there).
  it('leaves an empty title-bar region above the content, and nothing else above the panes', () => {
    setup();
    const app = document.querySelector('.app')!;
    const titlebar = app.querySelector('.wco-titlebar')!;
    expect(titlebar).not.toBeNull();
    expect(titlebar).toBeEmptyDOMElement();
    expect(titlebar.nextElementSibling).toBe(app.querySelector('.content-row'));
    expect(app.firstElementChild).toBe(titlebar);
  });

  // The rail is at the window's right edge, so the menu opens to the LEFT of its button and lines
  // up with the button's right edge. Opened below, or left-aligned (the kit's defaults), it would
  // leave the screen.
  it('opens its menu to the left of the button, aligned to its right edge', async () => {
    setup();
    await openMenu();
    expect(screen.getByRole('menu')).toHaveAttribute('data-align', 'end');
    expect(screen.getByRole('menu')).toHaveAttribute('data-side', 'left');
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

  // Realigned (batch 12): the rail is always shown on desktop, so a stored
  // `sidebarRail: 'hidden'` no longer removes it. The menu still opens Settings,
  // now with the rail present.
  it('opens Settings with the rail present, even for a stored sidebarRail of hidden', async () => {
    localStorage.setItem(
      'palmux-settings',
      JSON.stringify({ mobileMode: 'off', sidebarRail: 'hidden' }),
    );
    setup();
    expect(screen.getByTestId('dock-rail')).toBeInTheDocument();
    expect(screen.queryByTestId('dock')).toBeNull();

    await openMenu();
    await userEvent.click(screen.getByTestId('app-menu-settings'));

    expect(screen.getByTestId('dock')).toHaveAttribute('data-view', 'settings');
    expect(screen.getByTestId('dock-rail')).toBeInTheDocument();
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

  // The menu is the main window's control. A detached window draws no rail and so no menu; the
  // mobile layer has no topbar at all (its route to Settings is the drawer).
  it('is absent from a detached window, which draws no rail', () => {
    history.replaceState(null, '', '/window/wq3k9x2m1ab');
    render(<App />);
    send({ type: 'sessions', tabs: [{ id: '1', kind: 'terminal', window: 'wq3k9x2m1ab' }] });
    expect(screen.queryByTestId('app-menu-button')).toBeNull();
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

  // One field list in both hosts, so the row has to be in both, and a change has to
  // reach the real settings: this device's, and not the terminal's or the server's.
  describe('the Code font size row', () => {
    const settingsNow = (): Record<string, unknown> =>
      JSON.parse(localStorage.getItem('palmux-settings') ?? '{}');

    it('is in the dock’s Appearance card beside Font size, empty until the device chooses', async () => {
      setup(['0', '1']);
      openDockSettings();
      const row = await screen.findByTestId('set-code-size');
      expect(screen.getByTestId('settings-section-appearance')).toContainElement(row);
      expect(row).toHaveValue(null);
      expect(row).toHaveAttribute('placeholder', 'Default');
      const [size, code] = ['set-size', 'set-code-size'].map((id) => screen.getByTestId(id));
      expect(size!.compareDocumentPosition(code!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      const sentBefore = server().settingsSent.length;
      fireEvent.change(row, { target: { value: '11' } });
      expect(settingsNow()['codeFontSize']).toBe(11);
      // Not the terminal's size, and nothing about it reaches the server, though the
      // synced settings themselves still go out.
      expect(settingsNow()['fontSize']).not.toBe(11);
      expect(server().settingsSent.length).toBeGreaterThan(sentBefore);
      for (const message of server().settingsSent)
        expect(message).not.toHaveProperty('codeFontSize');
    });

    it('is in the mobile drawer’s Settings too, and clearing it goes back to the default', async () => {
      localStorage.setItem(
        'palmux-settings',
        JSON.stringify({ mobileMode: 'on', codeFontSize: 14 }),
      );
      setup(['0', '1']);
      fireEvent.keyDown(window, { key: ',', ctrlKey: true });
      const row = await screen.findByTestId('set-code-size');
      expect(screen.getByTestId('drawer-settings-body')).toContainElement(row);
      expect(row).toHaveValue(14);

      fireEvent.change(row, { target: { value: '' } });
      fireEvent.blur(row);
      expect(settingsNow()['codeFontSize']).toBeNull();
      expect(screen.getByTestId('set-code-size')).toHaveValue(null);
      for (const message of server().settingsSent)
        expect(message).not.toHaveProperty('codeFontSize');
    });
  });

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
        // The first control the sub-view draws here is the mode switch (batch 12):
        // it now sits above Import and the list, and the drawer hides ‹ Settings.
        expect(document.activeElement).toBe(screen.getByTestId('set-theme-mode-fixed'));

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

  // ── Match system (batch 12) ─────────────────────────────────────────────────
  //
  // `themeId` is the persisted pick and, in Match system, only what the server
  // exports. What a client PAINTS is one resolved id, from its own colour scheme.
  describe('Match system', () => {
    // Four themes whose derived UI base differs, so a re-skin shows up in --t-base.
    const [A, B, C, D] = (() => {
      const base = (p: ColorProfile) => hex(deriveUiTokens(p).base);
      const picked: ColorProfile[] = [];
      for (const p of allProfiles().filter((q) => q.id !== DEFAULTS.themeId)) {
        if (picked.every((q) => base(q) !== base(p))) picked.push(p);
        if (picked.length === 4) break;
      }
      if (picked.length < 4) throw new Error('the registry needs four visibly different themes');
      return picked as [ColorProfile, ColorProfile, ColorProfile, ColorProfile];
    })();
    const baseOf = (p: ColorProfile) => hex(deriveUiTokens(p).base);
    const base = () => document.documentElement.style.getPropertyValue('--t-base');
    const SYSTEM = { themeMode: 'system', themeId: C.id, themeDark: A.id, themeLight: B.id };
    const seed = (settings: Record<string, unknown>) =>
      localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'off', ...settings }));
    const stored = () =>
      JSON.parse(localStorage.getItem('palmux-settings') ?? '{}') as ClientSettings;
    /** The theme id the terminal pane was handed: what it paints. */
    const paneTheme = () => screen.getByTestId('term-pane-p0').dataset['theme'];
    const sent = () => server().settingsSent;

    /** A `matchMedia` the test flips, as the browser would on a scheme change. */
    let flip: (dark: boolean) => void = () => {};
    let spy: MockInstance<typeof window.matchMedia>;
    const stubScheme = (initialDark: boolean) => {
      let dark = initialDark;
      const listeners = new Set<() => void>();
      spy = vi.spyOn(window, 'matchMedia').mockImplementation(
        (query: string) =>
          ({
            media: query,
            get matches() {
              return query.includes('prefers-color-scheme: dark') ? dark : false;
            },
            addEventListener: (_: string, cb: () => void) => listeners.add(cb),
            removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
          }) as unknown as MediaQueryList,
      );
      flip = (next) => {
        dark = next;
        act(() => listeners.forEach((cb) => cb()));
      };
    };
    afterEach(() => spy?.mockRestore());

    describe('what is painted', () => {
      it('fixed mode paints themeId, and a scheme change moves nothing', () => {
        stubScheme(true);
        seed({ themeMode: 'fixed', themeId: C.id, themeDark: A.id, themeLight: B.id });
        setup(['0', '1']);
        expect(base()).toBe(baseOf(C));
        expect(paneTheme()).toBe(C.id);
        flip(false);
        expect(base()).toBe(baseOf(C));
        expect(paneTheme()).toBe(C.id);
        expect(sent()).toEqual([]);
      });

      it('applies the dark theme when the system is dark, to the app AND the terminal', () => {
        stubScheme(true);
        seed(SYSTEM);
        setup(['0', '1']);
        expect(base()).toBe(baseOf(A));
        expect(paneTheme()).toBe(A.id);
      });

      it('applies the light theme when the system is not dark, to the app AND the terminal', () => {
        stubScheme(false);
        seed(SYSTEM);
        setup(['0', '1']);
        expect(base()).toBe(baseOf(B));
        expect(paneTheme()).toBe(B.id);
      });

      it('switches live on a scheme change, in both directions', () => {
        stubScheme(true);
        seed(SYSTEM);
        setup(['0', '1']);
        flip(false);
        expect(base()).toBe(baseOf(B));
        expect(paneTheme()).toBe(B.id);
        flip(true);
        expect(base()).toBe(baseOf(A));
        expect(paneTheme()).toBe(A.id);
      });

      // The `themes` broadcast re-applies the tokens. It used to read themeId, which
      // in this mode is not what the client shows.
      it('keeps painting the resolved theme when a themes broadcast re-applies it', () => {
        stubScheme(true);
        seed(SYSTEM);
        setup(['0', '1']);
        send({ type: 'themes', themes: [] });
        expect(base()).toBe(baseOf(A));
        expect(paneTheme()).toBe(A.id);
      });

      it('is not moved by another device writing themeId', () => {
        stubScheme(true);
        seed(SYSTEM);
        setup(['0', '1']);
        send({ type: 'settings', settings: { ...SYSTEM, themeId: B.id } });
        expect(base()).toBe(baseOf(A));
        expect(paneTheme()).toBe(A.id);
        expect(stored().themeId).toBe(B.id); // taken from the server, just not painted
      });

      it('stands themeId in for a slot that was never chosen', () => {
        stubScheme(true);
        seed({ ...SYSTEM, themeDark: '' });
        setup(['0', '1']);
        expect(paneTheme()).toBe(C.id);
      });
    });

    // The server exports `themeId` (tmux, delta, Claude). In Match system a client
    // writes it when ITS scheme changes, so the export follows the latest real
    // switch — and never on boot or reconnect, or two devices in different schemes
    // would fight on every load.
    describe('the exported themeId', () => {
      it('is written when the scheme actually changes', () => {
        stubScheme(true);
        seed(SYSTEM);
        setup(['0', '1']);
        flip(false);
        expect(stored().themeId).toBe(B.id);
        expect(sent().at(-1)).toMatchObject({ themeMode: 'system', themeId: B.id });
        flip(true);
        expect(stored().themeId).toBe(A.id);
        expect(sent().at(-1)).toMatchObject({ themeId: A.id });
        expect(sent()).toHaveLength(2);
      });

      it('is not written on boot, whatever the scheme resolves to', () => {
        stubScheme(true);
        seed(SYSTEM); // themeId is C, the dark slot is A: boot disagrees with the export
        setup(['0', '1']);
        expect(paneTheme()).toBe(A.id);
        expect(stored().themeId).toBe(C.id);
        expect(sent()).toEqual([]);
      });

      it('is not written on a reconnect or a settings broadcast', () => {
        stubScheme(true);
        seed(SYSTEM);
        setup(['0', '1']);
        send({ type: 'ready', maxUploadBytes: 0, webApps: [], version: 'v1' });
        send({ type: 'settings', settings: SYSTEM });
        send({ type: 'ready', maxUploadBytes: 0, webApps: [], version: 'v1' });
        expect(stored().themeId).toBe(C.id);
        expect(sent()).toEqual([]);
      });

      it('is not written in fixed mode', () => {
        stubScheme(true);
        seed({ ...SYSTEM, themeMode: 'fixed' });
        setup(['0', '1']);
        flip(false);
        expect(sent()).toEqual([]);
        expect(stored().themeId).toBe(C.id);
      });

      it('is not rewritten when it already is the new scheme’s theme', () => {
        stubScheme(true);
        seed({ ...SYSTEM, themeId: B.id });
        setup(['0', '1']);
        flip(false); // resolves to B, which is what the server already holds
        expect(sent()).toEqual([]);
      });
    });

    describe('picks and imports through the dock', () => {
      const openThemes = async () => {
        openDockSettings();
        await userEvent.click(await screen.findByTestId('set-theme'));
      };
      const importAs = (source: string) =>
        userEvent.type(screen.getByTestId('set-theme-import'), `${source}{Enter}`);
      const NORD = {
        id: 'user:nord',
        name: 'Nord',
        fg: 0xffffff,
        bg: 0x101820,
        ansi16: Array.from({ length: 16 }, (_, i) => i * 0x101010),
      };
      afterEach(() => registerDynamicThemes([]));

      it('a pick for the active slot shows at once; one for the other slot does not', async () => {
        stubScheme(true);
        seed(SYSTEM);
        setup(['0', '1']);
        await openThemes();

        fireEvent.click(screen.getByTestId(`theme-opt-${D.id}`)); // dark slot, active
        expect(stored().themeDark).toBe(D.id);
        expect(base()).toBe(baseOf(D));
        expect(paneTheme()).toBe(D.id);

        await userEvent.click(screen.getByTestId('set-theme-slot-light'));
        fireEvent.click(screen.getByTestId(`theme-opt-${A.id}`)); // light slot, inactive
        expect(stored().themeLight).toBe(A.id);
        expect(base()).toBe(baseOf(D)); // unchanged
        expect(paneTheme()).toBe(D.id);
        // The active-slot pick moved the export (it changed what this device shows); the
        // inactive-slot pick did not.
        expect(stored().themeId).toBe(D.id);
        expect(sent().at(-1)?.['themeId']).toBe(D.id);
      });

      it('an import in fixed mode becomes themeId, as it always did', async () => {
        stubScheme(true);
        seed({ ...SYSTEM, themeMode: 'fixed' });
        setup(['0', '1']);
        await openThemes();
        await importAs('Nord');
        expect(server().imports).toEqual(['Nord']);
        send({ type: 'themeImported', ok: true, id: NORD.id, detail: 'Nord' });
        expect(stored().themeId).toBe(NORD.id);
        expect(paneTheme()).toBe(NORD.id);
      });

      it('an import in Match system fills the slot being edited, and shows when it is active', async () => {
        stubScheme(true);
        seed(SYSTEM);
        setup(['0', '1']);
        await openThemes();
        await importAs('Nord'); // dark slot: the active scheme
        send({ type: 'themeImported', ok: true, id: NORD.id, detail: 'Nord' });
        // On screen now, so the export follows it, as a pick for the active slot does.
        expect(stored()).toMatchObject({ themeDark: NORD.id, themeLight: B.id, themeId: NORD.id });
        expect(paneTheme()).toBe(NORD.id);
      });

      it('an import into the inactive slot is stored and shows nothing', async () => {
        stubScheme(true);
        seed(SYSTEM);
        setup(['0', '1']);
        await openThemes();
        await userEvent.click(screen.getByTestId('set-theme-slot-light'));
        await importAs('Nord');
        send({ type: 'themeImported', ok: true, id: NORD.id, detail: 'Nord' });
        expect(stored()).toMatchObject({ themeDark: A.id, themeLight: NORD.id, themeId: C.id });
        expect(paneTheme()).toBe(A.id);
        expect(base()).toBe(baseOf(A));
      });

      // The target is the slot at SUBMIT time, not at completion time.
      it('a completion after a slot switch still lands in the slot it was submitted for', async () => {
        stubScheme(true);
        seed(SYSTEM);
        setup(['0', '1']);
        await openThemes();
        await userEvent.click(screen.getByTestId('set-theme-slot-light'));
        await importAs('Nord');
        await userEvent.click(screen.getByTestId('set-theme-slot-dark')); // moved on
        send({ type: 'themeImported', ok: true, id: NORD.id, detail: 'Nord' });
        expect(stored()).toMatchObject({ themeDark: A.id, themeLight: NORD.id });
        expect(paneTheme()).toBe(A.id);
      });

      // B12-R2-02. A fixed-target import completing in Match system must not write
      // themeId: it would overwrite the scheme export with no scheme change behind it.
      it('a fixed import completing after Fixed → Match system and a scheme change leaves themeId alone', async () => {
        stubScheme(true);
        seed({ themeMode: 'fixed', themeId: C.id });
        setup(['0', '1']);
        await openThemes();
        await importAs('Nord'); // captured as a FIXED target
        expect(server().imports).toEqual(['Nord']);

        await userEvent.click(screen.getByTestId('set-theme-mode-system'));
        fireEvent.click(screen.getByTestId(`theme-opt-${A.id}`)); // dark slot
        await userEvent.click(screen.getByTestId('set-theme-slot-light'));
        fireEvent.click(screen.getByTestId(`theme-opt-${B.id}`)); // light slot
        flip(false); // a real scheme change: the export becomes the light theme
        expect(stored().themeId).toBe(B.id);

        send({ type: 'themeImported', ok: true, id: NORD.id, detail: 'Nord' });
        expect(stored()).toMatchObject({
          themeMode: 'system',
          themeId: B.id,
          themeDark: A.id,
          themeLight: B.id,
        });
        expect(paneTheme()).toBe(B.id);
        expect(base()).toBe(baseOf(B));
        // Imported, so it is in the list — it was just not selected.
        send({ type: 'themes', themes: [NORD] });
        expect(screen.getByTestId(`theme-opt-${NORD.id}`)).toBeInTheDocument();
        expect(screen.getByText('Imported Nord')).toBeInTheDocument();
      });

      it('a slot import completing after a switch to Fixed is not auto-selected either', async () => {
        stubScheme(true);
        seed(SYSTEM);
        setup(['0', '1']);
        await openThemes();
        await userEvent.click(screen.getByTestId('set-theme-slot-light'));
        await importAs('Nord'); // captured as a LIGHT-slot target
        await userEvent.click(screen.getByTestId('set-theme-mode-fixed'));
        expect(stored()).toMatchObject({ themeMode: 'fixed', themeId: A.id });

        send({ type: 'themeImported', ok: true, id: NORD.id, detail: 'Nord' });
        expect(stored()).toMatchObject({ themeId: A.id, themeLight: B.id });
        expect(paneTheme()).toBe(A.id);
      });

      // B12-I01. Comparing modes at completion cannot see a round trip: Fixed →
      // Match system → Fixed ends where it started, and the late import then
      // overwrote the theme the user picked after coming back.
      it('a Fixed → Match system → Fixed round trip supersedes the import and keeps the newer pick', async () => {
        stubScheme(true);
        seed({ themeMode: 'fixed', themeId: C.id });
        setup(['0', '1']);
        await openThemes();
        await importAs('Nord'); // captured as a FIXED target
        await userEvent.click(screen.getByTestId('set-theme-mode-system'));
        await userEvent.click(screen.getByTestId('set-theme-mode-fixed'));
        fireEvent.click(screen.getByTestId(`theme-opt-${D.id}`)); // the newer choice
        expect(stored()).toMatchObject({ themeMode: 'fixed', themeId: D.id });

        send({ type: 'themeImported', ok: true, id: NORD.id, detail: 'Nord' });
        expect(stored()).toMatchObject({ themeMode: 'fixed', themeId: D.id });
        expect(paneTheme()).toBe(D.id);
        expect(screen.getByText('Imported Nord')).toBeInTheDocument();
      });

      it('a mode round trip from another device supersedes the import too', async () => {
        stubScheme(true);
        seed({ themeMode: 'fixed', themeId: C.id });
        setup(['0', '1']);
        await openThemes();
        await importAs('Nord');
        send({ type: 'settings', settings: { ...SYSTEM } });
        send({ type: 'settings', settings: { ...SYSTEM, themeMode: 'fixed', themeId: D.id } });

        send({ type: 'themeImported', ok: true, id: NORD.id, detail: 'Nord' });
        expect(stored()).toMatchObject({ themeMode: 'fixed', themeId: D.id });
        expect(paneTheme()).toBe(D.id);
        expect(sent()).toEqual([]);
      });

      // Two broadcasts can land before React renders either, and a transition
      // counted per RENDER would then see fixed → fixed: no change at all.
      it('counts both transitions when two broadcasts land in one render', async () => {
        stubScheme(true);
        seed({ themeMode: 'fixed', themeId: C.id });
        setup(['0', '1']);
        await openThemes();
        await importAs('Nord');
        act(() => {
          server().handler!({ type: 'settings', settings: { ...SYSTEM } });
          server().handler!({
            type: 'settings',
            settings: { ...SYSTEM, themeMode: 'fixed', themeId: D.id },
          });
        });

        send({ type: 'themeImported', ok: true, id: NORD.id, detail: 'Nord' });
        expect(stored()).toMatchObject({ themeMode: 'fixed', themeId: D.id });
      });

      // A broadcast that leaves the mode where it was is not a transition: an
      // unrelated save from another device must not cost this import its selection.
      it('a broadcast that keeps the mode still lets the import auto-select', async () => {
        stubScheme(true);
        seed({ themeMode: 'fixed', themeId: C.id });
        setup(['0', '1']);
        await openThemes();
        await importAs('Nord');
        send({
          type: 'settings',
          settings: { themeMode: 'fixed', themeId: C.id, cursorBlink: false },
        });
        send({ type: 'settings', settings: { cursorBlink: true } }); // an older bundle: no mode

        send({ type: 'themeImported', ok: true, id: NORD.id, detail: 'Nord' });
        expect(stored().themeId).toBe(NORD.id);
        expect(paneTheme()).toBe(NORD.id);
      });

      it('a failed import selects nothing and says why', async () => {
        stubScheme(true);
        seed(SYSTEM);
        setup(['0', '1']);
        await openThemes();
        await importAs('Nord');
        send({ type: 'themeImported', ok: false, detail: 'not a theme' });
        expect(stored()).toMatchObject({ themeDark: A.id, themeLight: B.id, themeId: C.id });
        expect(screen.getByText('Import failed — not a theme')).toBeInTheDocument();
      });
    });
  });

  // ── Settings › App (batch 12) ───────────────────────────────────────────────
  describe('the App section', () => {
    it('has no Sidebar rail and no Dictation history row', async () => {
      setup(['0', '1']);
      openDockSettings();
      await screen.findByTestId('reload-app');
      expect(screen.queryByTestId('set-sidebar-rail')).toBeNull();
      expect(screen.queryByTestId('open-dictation-history')).toBeNull();
    });

    it('still opens Dictation from the rail', () => {
      setup(['0', '1']);
      fireEvent.click(screen.getByTestId('dock-rail-dictation'));
      expect(screen.getByTestId('dock')).toHaveAttribute('data-view', 'dictation');
    });

    it('shows the rail for a stored sidebarRail of hidden, which nothing reads any more', () => {
      localStorage.setItem(
        'palmux-settings',
        JSON.stringify({ mobileMode: 'off', sidebarRail: 'hidden' }),
      );
      setup(['0', '1']);
      expect(screen.getByTestId('dock-rail')).toBeInTheDocument();
      expect(screen.getByTestId('dock-rail-settings')).toBeInTheDocument();
      expect(screen.getByTestId('dock-rail-dictation')).toBeInTheDocument();
    });
  });
});

// ── The Download prompt uses the path exactly as typed (batch 11) ─────────────────
//
// `report` and `report ` are two different files. The prompt's value was trimmed before
// it was sent, so asking for the second downloaded the first. `trim()` now only decides
// whether anything was entered.
describe('the Download prompt uses the path exactly as typed', () => {
  const LINE_BREAK = 'That path contains a line break — paste it without the newline';
  let prompt: MockInstance;
  beforeEach(() => {
    downloadFromServer.mockClear();
    prompt = vi.spyOn(window, 'prompt');
  });
  afterEach(() => prompt.mockRestore());

  const download = (answer: string | null) => {
    prompt.mockReturnValue(answer);
    setup(['0']);
    fireEvent.click(screen.getByTestId('dock-rail-download'));
  };

  it('hands a trailing-space path to downloadFromServer byte for byte', () => {
    download('/tmp/report ');
    expect(downloadFromServer).toHaveBeenCalledTimes(1);
    expect(downloadFromServer).toHaveBeenCalledWith('/tmp/report ');
  });

  it('does not repair a path that starts with whitespace: the server refuses it', () => {
    download(' /tmp/report');
    expect(downloadFromServer).toHaveBeenCalledWith(' /tmp/report');
  });

  it('downloads nothing for a cancelled prompt or a blank entry', () => {
    for (const answer of [null, '', '   ', '\t']) {
      downloadFromServer.mockClear();
      cleanup();
      sockets.length = 0;
      download(answer);
      expect(downloadFromServer, JSON.stringify(answer)).not.toHaveBeenCalled();
    }
  });

  // `window.prompt` removes line breaks from what it returns, so a path that carried one
  // cannot be entered here (the Explorer's own download passes a row's path unchanged and
  // covers it). Where a value does arrive with one, it is refused rather than downloaded
  // as the sibling without it.
  it('refuses a value that holds a line break, with a toast', () => {
    download('/tmp/notes.md\n');
    expect(downloadFromServer).not.toHaveBeenCalled();
    expect(document.querySelector('.toast.show')?.textContent).toBe(LINE_BREAK);
  });
});

// ── Source Control in the dock ────────────────────────────────────────────────
//
// SourceControlView and the status store are tested alone. What only App can get
// wrong is the seam: the rail must open the view, the device's selection must
// reach the store and stay LOCAL, and a row must open (or focus) the right review
// tab without ever sending a second `createTab` for one that is already live.
describe('Source Control in the dock', () => {
  const APP_REPO = '/home/u/work/app';
  const LIB_REPO = '/home/u/work/lib';

  const scmStatus = (top: string, over: Record<string, unknown> = {}) => ({
    top,
    branch: 'main',
    unborn: false,
    merge: [],
    staged: [],
    changes: [],
    truncated: false,
    tookMs: 10,
    commentsRev: 0,
    attrEpoch: 'e0',
    ...over,
  });
  const entryOf = (path: string, over: Record<string, unknown> = {}) => ({
    path,
    kind: 'ordinary',
    status: 'M',
    fp: `fp-${path}`,
    ...over,
  });

  let statusRepos: string[] = [];
  let answers: Record<string, ReturnType<typeof scmStatus>> = {};
  let repoTop: string | null = null;
  const reply = (body: unknown, status = 200) =>
    Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

  beforeEach(() => {
    statusRepos = [];
    answers = {};
    repoTop = null;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const u = new URL(url, 'http://palmux');
        if (u.pathname === '/scm/status') {
          const repo = u.searchParams.get('repo') ?? '';
          statusRepos.push(repo);
          return reply(answers[repo] ?? scmStatus(repo));
        }
        if (u.pathname === '/scm/repo') {
          return repoTop === null
            ? reply({ error: 'path is not a git repository' }, 400)
            : reply({ top: repoTop });
        }
        return reply(null, 404);
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute('style');
  });

  const storeSettings = (extra: Record<string, unknown>) =>
    localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'off', ...extra }));
  const stored = () => JSON.parse(localStorage.getItem('palmux-settings') ?? '{}');
  const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  const openScm = async () => {
    fireEvent.click(screen.getByTestId('dock-rail-scm'));
    await flush();
  };
  const boot = (tabs: Array<Record<string, unknown>>) => {
    render(<App />);
    send({ type: 'sessions', tabs });
  };
  const selected = () =>
    [...document.querySelectorAll('[data-testid^="session-tab-"][aria-selected="true"]')].map(
      (el) => el.getAttribute('data-testid')?.replace('session-tab-', ''),
    );

  it('puts Source Control on the rail, and opens the view with no project to read', async () => {
    boot([{ id: '0', kind: 'terminal' }]);
    await openScm();
    expect(screen.getByTestId('dock')).toHaveAttribute('data-view', 'scm');
    expect(screen.getByTestId('scm-empty')).toBeInTheDocument();
    expect(statusRepos).toEqual([]);
  });

  it('remembers the view per device, like the others', async () => {
    boot([{ id: '0', kind: 'terminal' }]);
    await openScm();
    expect(localStorage.getItem('palmux-dock-view')).toBe('scm');
    cleanup();
    sockets.length = 0;
    boot([{ id: '0', kind: 'terminal' }]);
    expect(screen.getByTestId('dock')).toHaveAttribute('data-view', 'scm');
  });

  it('reads the active project and lists its changes', async () => {
    storeSettings({ scmRepos: [APP_REPO, LIB_REPO], scmActiveRepo: LIB_REPO });
    answers[LIB_REPO] = scmStatus(LIB_REPO, { changes: [entryOf('lib.ts')] });
    boot([{ id: '0', kind: 'terminal' }]);
    await openScm();
    expect(await screen.findByTestId('scm-row-changes:lib.ts')).toBeInTheDocument();
    expect(new Set(statusRepos)).toEqual(new Set([LIB_REPO]));
  });

  it('falls to the first project when the stored selection is no longer in the list', async () => {
    storeSettings({ scmRepos: [APP_REPO, LIB_REPO], scmActiveRepo: '/home/u/removed' });
    boot([{ id: '0', kind: 'terminal' }]);
    await openScm();
    await screen.findByTestId('scm-branch');
    expect(new Set(statusRepos)).toEqual(new Set([APP_REPO]));
    expect(screen.getByTestId('scm-project-select')).toHaveTextContent('app');
  });

  it('reads nothing while Source Control is not the open view', async () => {
    vi.useFakeTimers();
    storeSettings({ scmRepos: [APP_REPO], scmActiveRepo: APP_REPO });
    boot([{ id: '0', kind: 'terminal' }]);
    await act(() => vi.advanceTimersByTimeAsync(60 * 60 * 1000));
    expect(statusRepos).toEqual([]);

    fireEvent.click(screen.getByTestId('dock-rail-scm'));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(statusRepos.length).toBeGreaterThan(0);

    // Leaving for Explorer unmounts the view, and with it the only counting subscriber.
    fireEvent.click(screen.getByTestId('dock-rail-files'));
    await act(() => vi.advanceTimersByTimeAsync(0));
    const afterLeaving = statusRepos.length;
    await act(() => vi.advanceTimersByTimeAsync(60 * 60 * 1000));
    expect(statusRepos).toHaveLength(afterLeaving);
  });

  describe('the project list is synced, the selection stays on the device', () => {
    it('adding a project syncs the list, stores the selection locally, and sends only the list', async () => {
      repoTop = APP_REPO;
      boot([{ id: '0', kind: 'terminal' }]);
      await openScm();
      fireEvent.click(screen.getByTestId('scm-add-project'));
      fireEvent.change(screen.getByTestId('scm-add-input'), {
        target: { value: `${APP_REPO}/src` },
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('scm-add-submit'));
      });
      expect(await screen.findByTestId('scm-branch')).toBeInTheDocument();

      expect(stored()).toMatchObject({ scmRepos: [APP_REPO], scmActiveRepo: APP_REPO });
      const sent = server().settingsSent.at(-1) ?? {};
      expect(sent['scmRepos']).toEqual([APP_REPO]);
      for (const local of ['scmActiveRepo', 'scmLayout', 'scmAlgorithm', 'scmWrap']) {
        expect(local in sent, local).toBe(false);
      }
      expect(new Set(statusRepos)).toEqual(new Set([APP_REPO]));
    });

    it('a refused path adds nothing and sends nothing', async () => {
      boot([{ id: '0', kind: 'terminal' }]);
      await openScm();
      const before = server().settingsSent.length;
      fireEvent.click(screen.getByTestId('scm-add-project'));
      fireEvent.change(screen.getByTestId('scm-add-input'), { target: { value: '/tmp' } });
      await act(async () => {
        fireEvent.click(screen.getByTestId('scm-add-submit'));
      });
      expect(screen.getByTestId('scm-add-note')).toHaveTextContent('path is not a git repository');
      expect(stored()['scmRepos']).toBeUndefined();
      expect(server().settingsSent).toHaveLength(before);
    });

    it('switching project reads the new one only, and a list change from another device is taken', async () => {
      storeSettings({ scmRepos: [APP_REPO, LIB_REPO], scmActiveRepo: APP_REPO });
      boot([{ id: '0', kind: 'terminal' }]);
      await openScm();
      await screen.findByTestId('scm-branch');
      statusRepos.length = 0;
      fireEvent.click(screen.getByTestId('scm-project-select'));
      fireEvent.click(screen.getByTestId(`scm-project-select-option-${LIB_REPO}`));
      await flush();
      expect(stored()['scmActiveRepo']).toBe(LIB_REPO);
      expect(new Set(statusRepos)).toEqual(new Set([LIB_REPO]));

      // Another window removes the project this device is showing.
      send({ type: 'settings', settings: { scmRepos: [APP_REPO] } });
      await flush();
      expect(screen.getByTestId('scm-project-select')).toHaveTextContent('app');
      expect(stored()['scmActiveRepo']).toBe(LIB_REPO); // the choice is kept, not rewritten
    });
  });

  describe('choosing a file opens its review', () => {
    const rows = () => {
      answers[APP_REPO] = scmStatus(APP_REPO, {
        staged: [entryOf('s.ts')],
        changes: [entryOf('c.ts')],
      });
      storeSettings({ scmRepos: [APP_REPO], scmActiveRepo: APP_REPO });
    };

    it('creates the Changes review for a changed file when none is open', async () => {
      rows();
      boot([{ id: '0', kind: 'terminal' }]);
      await openScm();
      fireEvent.click(await screen.findByTestId('scm-row-changes:c.ts'));
      expect(server().created).toEqual([{ kind: 'review', url: `changes:${APP_REPO}` }]);
    });

    it('creates the Staged review for a staged file', async () => {
      rows();
      boot([{ id: '0', kind: 'terminal' }]);
      await openScm();
      fireEvent.click(await screen.findByTestId('scm-row-staged:s.ts'));
      expect(server().created).toEqual([{ kind: 'review', url: `staged:${APP_REPO}` }]);
    });

    it('selects the review already open and sends no createTab', async () => {
      rows();
      boot([
        { id: '0', kind: 'terminal' },
        { id: '4', kind: 'review', url: `changes:${APP_REPO}` },
      ]);
      await openScm();
      expect(selected()).toEqual(['0']);
      fireEvent.click(await screen.findByTestId('scm-row-changes:c.ts'));
      expect(server().created).toEqual([]);
      expect(selected()).toEqual(['4']);
    });

    it('a staged file does not take the Changes review for its own', async () => {
      rows();
      boot([
        { id: '0', kind: 'terminal' },
        { id: '4', kind: 'review', url: `changes:${APP_REPO}` },
      ]);
      await openScm();
      fireEvent.click(await screen.findByTestId('scm-row-staged:s.ts'));
      expect(server().created).toEqual([{ kind: 'review', url: `staged:${APP_REPO}` }]);
      expect(selected()).toEqual(['0']);
    });

    it('a review of another project is not reused for this one', async () => {
      rows();
      boot([
        { id: '0', kind: 'terminal' },
        { id: '4', kind: 'review', url: `changes:${LIB_REPO}` },
      ]);
      await openScm();
      fireEvent.click(await screen.findByTestId('scm-row-changes:c.ts'));
      expect(server().created).toEqual([{ kind: 'review', url: `changes:${APP_REPO}` }]);
    });

    it('opens the review of the device’s active project, whatever the list holds', async () => {
      answers[LIB_REPO] = scmStatus(LIB_REPO, { changes: [entryOf('l.ts')] });
      storeSettings({ scmRepos: [APP_REPO, LIB_REPO], scmActiveRepo: LIB_REPO });
      boot([{ id: '0', kind: 'terminal' }]);
      await openScm();
      fireEvent.click(await screen.findByTestId('scm-row-changes:l.ts'));
      expect(server().created).toEqual([{ kind: 'review', url: `changes:${LIB_REPO}` }]);
    });
  });

  // ── A review in the workspace ──────────────────────────────────────────────
  //
  // Reviews are tabs like any other, so what only App can get wrong is how they
  // meet the rest of the workspace: which project a focused review makes active,
  // what a Source Control row hands the pane that shows it, and a create that is
  // answered with a tab this window already holds.

  describe('a review in its own pane', () => {
    const openRows = () => {
      answers[APP_REPO] = scmStatus(APP_REPO, {
        changes: [entryOf('c.ts'), entryOf('d.ts')],
      });
      storeSettings({ scmRepos: [APP_REPO], scmActiveRepo: APP_REPO });
    };

    it('keeps the panes when another file of the review it holds is chosen', async () => {
      openRows();
      boot([
        { id: '0', kind: 'terminal' },
        { id: '4', kind: 'review', url: `changes:${APP_REPO}` },
      ]);
      splitVia('4'); // p0 = [0], p1 = [4], the review focused
      const before = strips();
      expect(before).toEqual([
        { pane: 'p0', tabs: ['0'], focused: false },
        { pane: 'p1', tabs: ['4'], focused: true },
      ]);

      await openScm();
      fireEvent.click(await screen.findByTestId('scm-row-changes:d.ts'));
      // The review is selected where it is, not created again, and no pane moves.
      expect(server().created).toEqual([]);
      expect(strips()).toEqual(before);
      expect(panes()).toEqual([{ slot: 'p0', session: '0', focused: false }]);
    });

    it('keeps the panes when a create is answered with the review it holds', async () => {
      openRows();
      boot([{ id: '0', kind: 'terminal' }]);
      await openScm();
      fireEvent.click(await screen.findByTestId('scm-row-changes:c.ts'));
      expect(server().created).toEqual([{ kind: 'review', url: `changes:${APP_REPO}` }]);

      // Another window's create won: the tab arrives in a broadcast, and this window
      // moves it to a pane of its own before the answer to its own create (the same tab) comes.
      await send({
        type: 'sessions',
        tabs: [
          { id: '0', kind: 'terminal' },
          { id: '4', kind: 'review', url: `changes:${APP_REPO}` },
        ],
      });
      splitVia('4');
      const before = strips();
      expect(before).toEqual([
        { pane: 'p0', tabs: ['0'], focused: false },
        { pane: 'p1', tabs: ['4'], focused: true },
      ]);
      await send({ type: 'tabCreated', id: '4' });
      expect(strips()).toEqual(before);
    });
  });

  describe('creating a review', () => {
    const openRows = () => {
      answers[APP_REPO] = scmStatus(APP_REPO, {
        changes: [entryOf('c.ts'), entryOf('d.ts')],
      });
      storeSettings({ scmRepos: [APP_REPO], scmActiveRepo: APP_REPO });
    };

    it('sends one createTab for two quick opens before the tab exists', async () => {
      openRows();
      boot([{ id: '0', kind: 'terminal' }]);
      await openScm();
      fireEvent.click(await screen.findByTestId('scm-row-changes:c.ts'));
      fireEvent.click(await screen.findByTestId('scm-row-changes:d.ts'));
      expect(server().created).toEqual([{ kind: 'review', url: `changes:${APP_REPO}` }]);
      // The second open still asks the pane for ITS file.
      expect(paneHost.review?.takeScrollTarget(`changes:${APP_REPO}`)).toEqual({
        group: 'changes',
        path: 'd.ts',
      });
    });

    it('does not let an unanswered create block the url for good', async () => {
      openRows();
      boot([{ id: '0', kind: 'terminal' }]);
      await openScm();
      vi.useFakeTimers({ toFake: ['Date'] });
      fireEvent.click(await screen.findByTestId('scm-row-changes:c.ts'));
      vi.setSystemTime(Date.now() + 6000);
      fireEvent.click(screen.getByTestId('scm-row-changes:d.ts'));
      expect(server().created).toHaveLength(2);
    });

    it('creates the review again once the one it asked for has been answered and closed', async () => {
      openRows();
      boot([
        { id: '0', kind: 'terminal' },
        { id: '4', kind: 'review', url: `changes:${APP_REPO}` },
      ]);
      await openScm();
      await send({ type: 'sessions', tabs: [{ id: '0', kind: 'terminal' }] });
      fireEvent.click(await screen.findByTestId('scm-row-changes:c.ts'));
      expect(server().created).toEqual([{ kind: 'review', url: `changes:${APP_REPO}` }]);
    });
  });

  describe('the review pane’s host', () => {
    const openRows = () => {
      answers[APP_REPO] = scmStatus(APP_REPO, { changes: [entryOf('c.ts')] });
      storeSettings({ scmRepos: [APP_REPO, LIB_REPO], scmActiveRepo: APP_REPO });
    };

    it('hands a chosen file to the review once, and ticks so a shown pane looks', async () => {
      openRows();
      boot([
        { id: '0', kind: 'terminal' },
        { id: '4', kind: 'review', url: `changes:${APP_REPO}` },
      ]);
      await openScm();
      const before = paneHost.review!.openTick;
      fireEvent.click(await screen.findByTestId('scm-row-changes:c.ts'));
      expect(paneHost.review!.openTick).toBeGreaterThan(before);
      const url = `changes:${APP_REPO}`;
      expect(paneHost.review!.takeScrollTarget(url)).toEqual({ group: 'changes', path: 'c.ts' });
      expect(paneHost.review!.takeScrollTarget(url)).toBeUndefined();
    });

    it('is told the project list, and the preferences stay on the device', async () => {
      openRows();
      boot([{ id: '0', kind: 'terminal' }]);
      expect(paneHost.review!.repos).toEqual([APP_REPO, LIB_REPO]);
      await act(async () =>
        paneHost.review!.setPreferences({
          scmAlgorithm: 'patience',
          scmLayout: 'split',
          scmWrap: true,
        }),
      );
      expect(stored()).toMatchObject({
        scmAlgorithm: 'patience',
        scmLayout: 'split',
        scmWrap: true,
      });
      expect(paneHost.review!.algorithm).toBe('patience');
      const sent = server().settingsSent.at(-1) ?? {};
      for (const local of ['scmAlgorithm', 'scmLayout', 'scmWrap'])
        expect(local in sent, local).toBe(false);
    });

    it('carries the code font size, which is this device’s and moves nothing else', async () => {
      openRows();
      boot([{ id: '0', kind: 'terminal' }]);
      expect(paneHost.review!.codeFontSize).toBeNull();
      const sentBefore = server().settingsSent.length;
      await act(async () => paneHost.review!.setPreferences({ codeFontSize: 11 }));
      expect(paneHost.review!.codeFontSize).toBe(11);
      expect(stored()).toMatchObject({ codeFontSize: 11 });
      // The terminal's own size is as it was.
      expect(stored()['fontSize']).toBe(DEFAULTS.fontSize);
      // The synced settings still went out (a change always sends them), without it.
      const sentAfter = server().settingsSent.slice(sentBefore);
      expect(sentAfter.length).toBeGreaterThan(0);
      for (const message of server().settingsSent)
        expect(message).not.toHaveProperty('codeFontSize');
    });

    it('takes the stored code font size at boot, and a server broadcast never changes it', async () => {
      openRows();
      storeSettings({ codeFontSize: 13 });
      boot([{ id: '0', kind: 'terminal' }]);
      expect(paneHost.review!.codeFontSize).toBe(13);
      await send({ type: 'settings', settings: { codeFontSize: 30, scmRepos: [APP_REPO] } });
      expect(paneHost.review!.codeFontSize).toBe(13);
    });

    it('makes a project active on request, which is a local choice', async () => {
      openRows();
      boot([{ id: '0', kind: 'terminal' }]);
      await act(async () => paneHost.review!.activate(LIB_REPO));
      expect(stored()['scmActiveRepo']).toBe(LIB_REPO);
      expect(server().settingsSent.at(-1) ?? {}).not.toHaveProperty('scmActiveRepo');
    });

    it('opens a file in the editor through the same focus-if-open rule as the tree', async () => {
      openRows();
      boot([
        { id: '0', kind: 'terminal' },
        { id: '6', kind: 'editor', url: `${APP_REPO}/open.ts` },
      ]);
      act(() => paneHost.review!.openFile(`${APP_REPO}/new.ts`));
      expect(server().created).toEqual([{ kind: 'editor', url: `${APP_REPO}/new.ts` }]);
      act(() => paneHost.review!.openFile(`${APP_REPO}/open.ts`));
      expect(server().created).toHaveLength(1);
      expect(selected()).toEqual(['6']);
    });
  });

  describe('focusing a review makes its project the active one', () => {
    const tabs = [
      { id: '0', kind: 'terminal' },
      { id: '4', kind: 'review', url: `changes:${LIB_REPO}` },
    ];

    it('sets the device’s project when the review becomes the active tab, and not before', async () => {
      storeSettings({ scmRepos: [APP_REPO, LIB_REPO], scmActiveRepo: APP_REPO });
      boot(tabs);
      expect(stored()['scmActiveRepo']).toBe(APP_REPO);
      fireEvent.click(screen.getByTestId('session-tab-4'), { button: 0 });
      await flush();
      expect(stored()['scmActiveRepo']).toBe(LIB_REPO);
      expect(server().settingsSent.at(-1) ?? {}).not.toHaveProperty('scmActiveRepo');
    });

    it('lets the dock choose another project while the review stays focused, through every broadcast', async () => {
      storeSettings({ scmRepos: [APP_REPO, LIB_REPO], scmActiveRepo: APP_REPO });
      boot(tabs);
      fireEvent.click(screen.getByTestId('session-tab-4'), { button: 0 });
      await openScm();
      fireEvent.click(screen.getByTestId('scm-project-select'));
      fireEvent.click(screen.getByTestId(`scm-project-select-option-${APP_REPO}`));
      await flush();
      expect(stored()['scmActiveRepo']).toBe(APP_REPO);

      // A broadcast hands App a new tab list; the focused review has not changed.
      await send({ type: 'sessions', tabs: [...tabs] });
      await send({ type: 'sessions', tabs: [...tabs, { id: '5', kind: 'terminal' }] });
      expect(stored()['scmActiveRepo']).toBe(APP_REPO);

      // Focusing the review again is a new focus.
      fireEvent.click(screen.getByTestId('session-tab-0'), { button: 0 });
      fireEvent.click(screen.getByTestId('session-tab-4'), { button: 0 });
      await flush();
      expect(stored()['scmActiveRepo']).toBe(LIB_REPO);
    });

    it('does not make a project that was removed from the list active', async () => {
      storeSettings({ scmRepos: [APP_REPO], scmActiveRepo: APP_REPO });
      boot(tabs);
      fireEvent.click(screen.getByTestId('session-tab-4'), { button: 0 });
      await flush();
      expect(stored()['scmActiveRepo']).toBe(APP_REPO);
    });

    it('moves to the review’s project when focus moves between panes', async () => {
      storeSettings({ scmRepos: [APP_REPO, LIB_REPO], scmActiveRepo: APP_REPO });
      boot(tabs);
      splitVia('4'); // p0 = [0], p1 = [4], review focused
      await flush();
      expect(stored()['scmActiveRepo']).toBe(LIB_REPO);
      // Each pane's own tab is already ITS active one, so what moves focus is the press on the
      // strip (the pane takes focus on pointerdown), not a switch.
      fireEvent.pointerDown(screen.getByTestId('session-tab-0'), { button: 0 });
      await act(async () => paneHost.review!.activate(APP_REPO));
      fireEvent.pointerDown(screen.getByTestId('session-tab-4'), { button: 0 });
      await flush();
      expect(stored()['scmActiveRepo']).toBe(LIB_REPO);
    });
  });
});

// ── The review keys and the comments, as the app wires them ─────────────────────
//
// The pane, the registry, the keybinding table and the comments store are each
// tested alone. What only App can get wrong is the seam: a key reaches the review
// the user is looking at and no other, an unwired key is left to the terminal, the
// palette offers what is wired, and what the control socket and the status answers
// say about comments reaches the store.
describe('Source Control keys and comments in the app', () => {
  const APP = '/home/u/work/app';
  let commentFetches: string[];
  let statusRev: number;

  const reply = (body: unknown, status = 200) =>
    Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

  beforeEach(() => {
    commentFetches = [];
    statusRev = 1;
    localStorage.setItem(
      'palmux-settings',
      JSON.stringify({ mobileMode: 'off', scmRepos: [APP], scmActiveRepo: APP }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const u = new URL(url, 'http://palmux');
        if (u.pathname === '/scm/status') {
          return reply({
            top: APP,
            branch: 'main',
            unborn: false,
            merge: [],
            staged: [],
            changes: [],
            truncated: false,
            tookMs: 1,
            commentsRev: statusRev,
            attrEpoch: 'e0',
          });
        }
        if (u.pathname === '/scm/comments') {
          commentFetches.push(u.searchParams.get('repo') ?? '');
          return reply({ rev: statusRev, comments: [] });
        }
        return reply(null, 404);
      }),
    );
  });
  afterEach(() => {
    resetReviewRegistry();
    scmStatusStore.setActiveRepo('');
    commentsStore.setActiveRepo('');
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  const fakeApi = (): ReviewApi => ({
    nextChange: vi.fn(),
    prevChange: vi.fn(),
    nextFile: vi.fn(),
    prevFile: vi.fn(),
    reviewCurrent: vi.fn(),
  });
  /** Press a chord; true when the app claimed it (prevented its default). */
  const press = (init: KeyboardEventInit): boolean => !fireEvent.keyDown(window, init);
  const CTRL_ALT = { ctrlKey: true, altKey: true } as const;

  const bootReviews = (...ids: string[]) => {
    render(<App />);
    send({
      type: 'sessions',
      tabs: [
        { id: '0', kind: 'terminal' },
        ...ids.map((id) => ({ id, kind: 'review', url: `changes:${APP}` })),
      ],
    });
  };
  const select = (id: string) => fireEvent.click(screen.getByTestId(`session-tab-${id}`));

  describe('Ctrl+Alt+G', () => {
    it('opens Source Control in the dock from any tab', async () => {
      render(<App />);
      broadcast(['0']);
      expect(press({ key: 'g', ...CTRL_ALT })).toBe(true);
      await flush();
      expect(screen.getByTestId('dock')).toHaveAttribute('data-view', 'scm');
    });

    it('is not the chord that copies the last output', () => {
      render(<App />);
      broadcast(['0']);
      // Ctrl+Shift+G still belongs to Copy last output, which needs a terminal: here
      // it says so, and opens no dock.
      press({ key: 'g', ctrlKey: true, shiftKey: true });
      expect(screen.queryByTestId('dock')).toBeNull();
    });
  });

  describe('the review keys', () => {
    it('are left to the terminal when no review is the focused tab', () => {
      render(<App />);
      broadcast(['0']);
      for (const init of [
        { key: 'j', ...CTRL_ALT },
        { key: 'J', ...CTRL_ALT, shiftKey: true },
        { key: 'n', ...CTRL_ALT },
        { key: 'N', ...CTRL_ALT, shiftKey: true },
        { key: 'Enter', ...CTRL_ALT },
      ]) {
        expect(press(init), JSON.stringify(init)).toBe(false);
      }
    });

    it('reach the review that is the focused tab, each its own action', async () => {
      const api = fakeApi();
      registerReview('1', api);
      bootReviews('1');
      select('1');
      await flush();

      expect(press({ key: 'j', ...CTRL_ALT })).toBe(true);
      expect(api.nextChange).toHaveBeenCalledTimes(1);
      expect(press({ key: 'J', ...CTRL_ALT, shiftKey: true })).toBe(true);
      expect(api.prevChange).toHaveBeenCalledTimes(1);
      expect(press({ key: 'n', ...CTRL_ALT })).toBe(true);
      expect(api.nextFile).toHaveBeenCalledTimes(1);
      expect(press({ key: 'N', ...CTRL_ALT, shiftKey: true })).toBe(true);
      expect(api.prevFile).toHaveBeenCalledTimes(1);
      expect(press({ key: 'Enter', ...CTRL_ALT })).toBe(true);
      expect(api.reviewCurrent).toHaveBeenCalledTimes(1);
    });

    it('reach only the focused review when several are open', async () => {
      const first = fakeApi();
      const second = fakeApi();
      registerReview('1', first);
      registerReview('2', second);
      bootReviews('1', '2');
      select('2');
      await flush();
      press({ key: 'j', ...CTRL_ALT });
      expect(second.nextChange).toHaveBeenCalledTimes(1);
      expect(first.nextChange).not.toHaveBeenCalled();
      select('1');
      await flush();
      press({ key: 'j', ...CTRL_ALT });
      expect(first.nextChange).toHaveBeenCalledTimes(1);
    });

    it('go back to the terminal when the review is left', async () => {
      const api = fakeApi();
      registerReview('1', api);
      bootReviews('1');
      select('1');
      await flush();
      select('0');
      await flush();
      expect(press({ key: 'j', ...CTRL_ALT })).toBe(false);
      expect(api.nextChange).not.toHaveBeenCalled();
    });

    it('are offered by the command palette while a review is focused, and not otherwise', async () => {
      registerReview('1', fakeApi());
      bootReviews('1');
      fireEvent.keyDown(window, { key: 'p', ctrlKey: true, shiftKey: true });
      await flush();
      expect(screen.getByTestId('palette-item-openSourceControl')).toHaveTextContent(
        'Open Source Control',
      );
      expect(screen.queryByTestId('palette-item-scmNextChange')).toBeNull();
      fireEvent.keyDown(window, { key: 'Escape' });
      await flush();

      select('1');
      await flush();
      fireEvent.keyDown(window, { key: 'p', ctrlKey: true, shiftKey: true });
      await flush();
      for (const [action, label, chord] of [
        ['scmNextChange', 'Review: next change', 'Ctrl+Alt+J'],
        ['scmPrevChange', 'Review: previous change', 'Ctrl+Alt+Shift+J'],
        ['scmNextFile', 'Review: next file', 'Ctrl+Alt+N'],
        ['scmPrevFile', 'Review: previous file', 'Ctrl+Alt+Shift+N'],
        ['scmReviewed', 'Review: Reviewed (Unstage in Staged)', 'Ctrl+Alt+Enter'],
      ] as const) {
        const item = screen.getByTestId(`palette-item-${action}`);
        expect(item).toHaveTextContent(label);
        expect(item).toHaveTextContent(chord);
      }
    });

    it('run from the palette on the focused review', async () => {
      const api = fakeApi();
      registerReview('1', api);
      bootReviews('1');
      select('1');
      await flush();
      fireEvent.keyDown(window, { key: 'p', ctrlKey: true, shiftKey: true });
      await flush();
      fireEvent.pointerDown(screen.getByTestId('palette-item-scmNextFile'));
      expect(api.nextFile).toHaveBeenCalledTimes(1);
    });

    // The New-tab page shows no tab, though `sessionId` keeps the closed one's id. When that id
    // comes back as a review, the review is listed and not shown: its keys stay unwired, the
    // palette does not offer them, and its project is not made the one this device reads.
    it.each(['off', 'on'] as const)(
      'stay unwired on the New-tab page when the closed id comes back as a review (mobileMode %s)',
      async (mobileMode) => {
        const LIB = '/home/u/work/lib';
        localStorage.setItem(
          'palmux-settings',
          JSON.stringify({ mobileMode, scmRepos: [APP, LIB], scmActiveRepo: LIB }),
        );
        const api = fakeApi();
        registerReview('0', api);
        render(<App />);
        broadcast(['0']);
        broadcast([]); // the last tab closes
        send({ type: 'sessions', tabs: [{ id: '0', kind: 'review', url: `changes:${APP}` }] });
        await flush();
        expect(screen.getByTestId('newtab-page')).toBeTruthy();

        expect(JSON.parse(localStorage.getItem('palmux-settings')!).scmActiveRepo).toBe(LIB);
        expect(press({ key: 'j', ...CTRL_ALT })).toBe(false);
        expect(press({ key: 'Enter', ...CTRL_ALT })).toBe(false);
        expect(api.nextChange).not.toHaveBeenCalled();
        expect(api.reviewCurrent).not.toHaveBeenCalled();

        fireEvent.keyDown(window, { key: 'p', ctrlKey: true, shiftKey: true });
        await flush();
        expect(screen.getByTestId('palette-item-openSourceControl')).toBeTruthy();
        expect(screen.queryByTestId('palette-item-scmNextChange')).toBeNull();
      },
    );
  });

  describe('the Undo toast', () => {
    const toast = () => document.querySelector('.toast') as HTMLElement;

    it('holds for six seconds, as a message with an action must', async () => {
      vi.useFakeTimers();
      try {
        render(<App />);
        broadcast(['0']);
        const undo = vi.fn();
        act(() => paneHost.review?.notify('Reviewed a.ts', { label: 'Undo', onClick: undo }));
        expect(toast()).toHaveClass('show');
        expect(toast()).toHaveTextContent('Reviewed a.ts');
        act(() => void vi.advanceTimersByTime(5900));
        expect(toast()).toHaveClass('show');
        act(() => void vi.advanceTimersByTime(200));
        expect(toast()).not.toHaveClass('show');
        expect(undo).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('runs the action once from its button, and takes the toast down', () => {
      render(<App />);
      broadcast(['0']);
      const undo = vi.fn();
      act(() => paneHost.review?.notify('Reviewed a.ts', { label: 'Undo', onClick: undo }));
      fireEvent.click(screen.getByTestId('toast-action'));
      expect(undo).toHaveBeenCalledTimes(1);
      expect(toast()).not.toHaveClass('show');
    });

    it('is a plain toast, gone in a moment, without an action', () => {
      vi.useFakeTimers();
      try {
        render(<App />);
        broadcast(['0']);
        act(() => paneHost.review?.notify('Undone'));
        expect(screen.queryByTestId('toast-action')).toBeNull();
        act(() => void vi.advanceTimersByTime(1500));
        expect(toast()).not.toHaveClass('show');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('comments reach the store', () => {
    const openScm = async () => {
      render(<App />);
      broadcast(['0']);
      fireEvent.click(screen.getByTestId('dock-rail-scm'));
      await flush();
      await flush();
    };

    it('reads the project’s comments when the view is visible, and not before', async () => {
      render(<App />);
      broadcast(['0']);
      await flush();
      expect(commentFetches).toEqual([]);
      fireEvent.click(screen.getByTestId('dock-rail-scm'));
      await flush();
      await flush();
      expect(commentFetches).toEqual([APP]);
    });

    it('reads them again when an scmComments frame names a newer rev of the active project', async () => {
      await openScm();
      expect(commentFetches).toHaveLength(1);
      statusRev = 5;
      send({ type: 'scmComments', repo: APP, rev: 5 });
      await flush();
      expect(commentFetches).toHaveLength(2);
    });

    it('ignores a frame about another project, and a rev it already holds', async () => {
      await openScm();
      send({ type: 'scmComments', repo: '/home/u/work/lib', rev: 9 });
      send({ type: 'scmComments', repo: APP, rev: 1 });
      await flush();
      expect(commentFetches).toHaveLength(1);
    });

    it('reads them again after a reconnect, whatever rev it last heard', async () => {
      await openScm();
      send({ type: 'ready', maxUploadBytes: 1, webApps: [] });
      await flush();
      expect(commentFetches).toHaveLength(2);
    });

    it('reads them when a status answer carries a newer rev: the backstop for a missed frame', async () => {
      await openScm();
      expect(commentFetches).toHaveLength(1);
      statusRev = 7;
      act(() => scmStatusStore.refresh());
      await flush();
      await flush();
      expect(commentFetches).toHaveLength(2);
    });
  });
});

// ── Source Control on a phone ─────────────────────────────────────────────────
//
// The drawer's fourth view hosts the dock's Source Control body, and while a review
// is the active tab a review bar takes the extra-keys bar's slot. What only App can
// get wrong is the seam: which bar is drawn for which tab, where each button and each
// swipe goes, where "back" is, and that choosing a file leaves the drawer.
describe('Source Control on a phone', () => {
  const APP = '/home/u/work/app';
  let statusReads: number;

  const reply = (body: unknown, status = 200) =>
    Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
  const entryOf = (path: string) => ({ path, kind: 'ordinary', status: 'M', fp: `fp-${path}` });

  beforeEach(() => {
    statusReads = 0;
    localStorage.setItem(
      'palmux-settings',
      JSON.stringify({ mobileMode: 'on', scmRepos: [APP], scmActiveRepo: APP }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const u = new URL(url, 'http://palmux');
        if (u.pathname === '/scm/status') {
          statusReads += 1;
          return reply({
            top: APP,
            branch: 'main',
            unborn: false,
            merge: [],
            staged: [entryOf('b.ts')],
            changes: [entryOf('a.ts')],
            truncated: false,
            tookMs: 1,
            commentsRev: 0,
            attrEpoch: 'e0',
          });
        }
        if (u.pathname === '/scm/comments') return reply({ rev: 0, comments: [] });
        return reply(null, 404);
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    resetReviewRegistry();
    scmStatusStore.setActiveRepo('');
    commentsStore.setActiveRepo('');
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  const fakeApi = (): ReviewApi => ({
    nextChange: vi.fn(),
    prevChange: vi.fn(),
    nextFile: vi.fn(),
    prevFile: vi.fn(),
    reviewCurrent: vi.fn(),
  });
  const REVIEW = { id: '4', kind: 'review', url: `changes:${APP}` };
  const STAGED = { id: '5', kind: 'review', url: `staged:${APP}` };

  const boot = (...tabs: Array<Record<string, unknown>>) => {
    render(<App />);
    send({ type: 'sessions', tabs: tabs.length ? tabs : [{ id: '0', kind: 'terminal' }, REVIEW] });
  };
  /** The tab this window shows, which the drawer is told. */
  const shown = (): string => drawer().current;
  const goTo = (id: string) => act(() => drawer().onSwitch(id));
  const extraKeysBar = () => document.getElementById('extra-keys-bar');
  const reviewBar = () => screen.queryByTestId('review-bar');

  const at = (x: number, pointerId = 1) => ({
    pointerId,
    pointerType: 'touch',
    clientX: x,
    clientY: 100,
  });
  const tapOn = (el: Element) => {
    fireEvent.pointerDown(el, at(100));
    fireEvent.pointerUp(el, at(100));
  };
  const swipe = (el: Element, dir: 'left' | 'right') => {
    const [from, to] = dir === 'left' ? [300, 100] : [100, 300];
    fireEvent.pointerDown(el, at(from));
    fireEvent.pointerMove(el, at(to));
    fireEvent.pointerUp(el, at(to));
  };

  describe('the bar in the extra-keys bar’s slot', () => {
    it('is the extra-keys bar on a terminal, and the review bar on a review, never both', () => {
      boot();
      expect(shown()).toBe('0');
      expect(extraKeysBar()).not.toBeNull();
      expect(reviewBar()).toBeNull();

      goTo('4');
      expect(shown()).toBe('4');
      expect(reviewBar()).not.toBeNull();
      expect(extraKeysBar()).toBeNull();
      expect(screen.queryAllByTestId(/^extra-key-/)).toHaveLength(0);

      goTo('0');
      expect(extraKeysBar()).not.toBeNull();
      expect(reviewBar()).toBeNull();
    });

    it('is drawn only on a phone: the desktop has the keys and no bar at all', () => {
      localStorage.setItem(
        'palmux-settings',
        JSON.stringify({ mobileMode: 'off', scmRepos: [APP], scmActiveRepo: APP }),
      );
      boot();
      expect(reviewBar()).toBeNull();
      expect(extraKeysBar()).toBeNull();
    });

    it('returns the extra-keys bar for any tab that is not a review, an editor included', () => {
      boot({ id: '0', kind: 'terminal' }, { id: '3', kind: 'editor' }, REVIEW);
      goTo('4');
      expect(extraKeysBar()).toBeNull();
      goTo('3');
      expect(extraKeysBar()).not.toBeNull();
      expect(reviewBar()).toBeNull();
    });

    it('offers Reviewed in a Changes review and Unstage in a Staged one', () => {
      boot({ id: '0', kind: 'terminal' }, REVIEW, STAGED);
      goTo('4');
      expect(screen.getByTestId('review-bar-reviewed')).toBeInTheDocument();
      expect(screen.queryByTestId('review-bar-unstage')).toBeNull();
      goTo('5');
      expect(screen.getByTestId('review-bar-unstage')).toBeInTheDocument();
      expect(screen.queryByTestId('review-bar-reviewed')).toBeNull();
    });

    it('stays when the extra keys are switched off: a review has no other way to the drawer', () => {
      boot();
      send({ type: 'extraKeys', extraKeys: { enabled: false } });
      expect(extraKeysBar()).toHaveClass('hidden'); // the terminal's bar obeys the setting
      goTo('4');
      expect(reviewBar()).not.toBeNull();
      expect(reviewBar()).not.toHaveClass('hidden');
    });
  });

  describe('each button acts on the review that is the active tab', () => {
    it('↑ and ↓ move by file, Reviewed reviews, and none of them touches another review', () => {
      const api = fakeApi();
      const other = fakeApi();
      registerReview('4', api);
      registerReview('9', other);
      boot({ id: '0', kind: 'terminal' }, REVIEW);
      goTo('4');

      tapOn(screen.getByTestId('review-bar-next'));
      expect(api.nextFile).toHaveBeenCalledTimes(1);
      tapOn(screen.getByTestId('review-bar-previous'));
      expect(api.prevFile).toHaveBeenCalledTimes(1);
      tapOn(screen.getByTestId('review-bar-reviewed'));
      expect(api.reviewCurrent).toHaveBeenCalledTimes(1);
      expect(other.nextFile).not.toHaveBeenCalled();
      expect(other.reviewCurrent).not.toHaveBeenCalled();
      // Not a change-by-change move: that is scrolling on a phone.
      expect(api.nextChange).not.toHaveBeenCalled();
    });

    it('Unstage acts on the staged review', () => {
      const api = fakeApi();
      registerReview('5', api);
      boot({ id: '0', kind: 'terminal' }, STAGED);
      goTo('5');
      tapOn(screen.getByTestId('review-bar-unstage'));
      expect(api.reviewCurrent).toHaveBeenCalledTimes(1);
    });

    it('a button with no pane behind it does nothing, and says nothing', () => {
      boot();
      goTo('4');
      expect(() => tapOn(screen.getByTestId('review-bar-next'))).not.toThrow();
    });

    it('the file list opens the drawer on the Source Control view', async () => {
      boot();
      goTo('4');
      expect(drawerIsOpen()).toBe(false);
      tapOn(screen.getByTestId('review-bar-files'));
      await flush();
      expect(drawerIsOpen()).toBe(true);
      expect(drawer().view).toBe('scm');
      expect(screen.getByTestId('drawer-view-scm')).toHaveAttribute('data-state', 'on');
      expect(await screen.findByTestId('scm-row-changes:a.ts')).toBeInTheDocument();
    });

    it('sends no key to any terminal: the bar has none to send', () => {
      // Watched where a key travels: the focused pane's sendInput / paste, which is
      // what the extra-keys bar and the soft keyboard call to reach the PTY. On a
      // phone the review takes the terminal's slot, so no terminal pane is mounted
      // behind it today; one kept mounted would land its keys here.
      paneApiFake.enabled = true;
      paneApiFake.typed = [];
      try {
        boot();
        tapOn(screen.getByTestId('extra-key-TAB'));
        expect(paneApiFake.typed).toEqual(['\t']); // the channel is live on the terminal

        goTo('4');
        paneApiFake.typed = [];
        for (const id of ['files', 'previous', 'next', 'reviewed']) {
          tapOn(screen.getByTestId(`review-bar-${id}`));
        }
        expect(paneApiFake.typed).toEqual([]);
      } finally {
        paneApiFake.enabled = false;
        paneApiFake.typed = [];
      }
    });
  });

  describe('the bar keeps the swipes', () => {
    it('right to left opens the drawer, on the view it was on', async () => {
      boot();
      goTo('4');
      swipe(screen.getByTestId('review-bar-next'), 'left');
      await flush();
      expect(drawerIsOpen()).toBe(true);
      expect(drawer().view).toBe('sessions');
      expect(shown()).toBe('4');
    });

    it('a swipe that starts on Reviewed opens the drawer and stages nothing', async () => {
      const api = fakeApi();
      registerReview('4', api);
      boot();
      goTo('4');
      swipe(screen.getByTestId('review-bar-reviewed'), 'left');
      await flush();
      expect(drawerIsOpen()).toBe(true);
      expect(api.reviewCurrent).not.toHaveBeenCalled();
    });

    it('left to right goes back to the tab the review was opened from, and the extra keys return', () => {
      boot({ id: '0', kind: 'terminal' }, { id: '1', kind: 'terminal' }, REVIEW);
      goTo('1');
      goTo('4');
      expect(reviewBar()).not.toBeNull();
      swipe(screen.getByTestId('review-bar-previous'), 'right');
      expect(shown()).toBe('1');
      expect(extraKeysBar()).not.toBeNull();
      expect(reviewBar()).toBeNull();
    });

    it('goes back to an editor too, if that is where the review was opened from', () => {
      boot({ id: '0', kind: 'terminal' }, { id: '3', kind: 'editor' }, REVIEW);
      goTo('3');
      goTo('4');
      swipe(screen.getByTestId('review-bar-files'), 'right');
      expect(shown()).toBe('3');
    });

    it('goes to the first terminal when that tab has been closed since', () => {
      boot({ id: '0', kind: 'terminal' }, { id: '3', kind: 'editor' }, REVIEW);
      goTo('3');
      goTo('4');
      send({ type: 'sessions', tabs: [{ id: '0', kind: 'terminal' }, REVIEW] });
      swipe(screen.getByTestId('review-bar-next'), 'right');
      expect(shown()).toBe('0');
    });

    it('from one review to another still goes back to where the first was opened from', () => {
      boot({ id: '0', kind: 'terminal' }, { id: '1', kind: 'terminal' }, REVIEW, STAGED);
      goTo('1');
      goTo('4');
      goTo('5');
      swipe(screen.getByTestId('review-bar-next'), 'right');
      // Not back to review 4, which a second swipe would leave for 5 again.
      expect(shown()).toBe('1');
    });

    it('does not take a review created this moment for the tab to return to', () => {
      boot({ id: '0', kind: 'terminal' });
      // The review's id is navigated to before the server has announced the tab, when
      // it still reads as a terminal; the broadcast then brings it in as a review.
      goTo('4');
      send({ type: 'sessions', tabs: [{ id: '0', kind: 'terminal' }, REVIEW] });
      swipe(screen.getByTestId('review-bar-next'), 'right');
      expect(shown()).toBe('0');
    });

    it('stays put when there is no tab to return to', () => {
      boot(REVIEW);
      goTo('4');
      swipe(screen.getByTestId('review-bar-next'), 'right');
      expect(shown()).toBe('4');
    });
  });

  describe('the drawer’s Source Control view', () => {
    /** The way in a phone has: swipe the extra keys, then choose the segment. */
    const openDrawerOnScm = async () => {
      swipe(screen.getAllByTestId(/^extra-key-/)[0]!, 'left');
      fireEvent.click(screen.getByTestId('drawer-view-scm'));
      await flush();
    };

    it('lists the active project’s changes inside the drawer', async () => {
      boot();
      await openDrawerOnScm();
      const body = screen.getByTestId('drawer-view-body');
      expect(body).toContainElement(screen.getByTestId('scm-view'));
      expect(await screen.findByTestId('scm-row-changes:a.ts')).toBeInTheDocument();
      expect(screen.getByTestId('scm-row-staged:b.ts')).toBeInTheDocument();
    });

    it('is a segment of the drawer’s own switcher, declared so it can be chosen', () => {
      boot();
      expect(screen.getByTestId('drawer-view-scm')).not.toBeDisabled();
      expect(drawer().hostedViews).toContain('scm');
    });

    it('choosing a file leaves the drawer and opens the review for its group', async () => {
      boot({ id: '0', kind: 'terminal' });
      await openDrawerOnScm();
      expect(drawerIsOpen()).toBe(true);
      tapOn(await screen.findByTestId('scm-row-changes:a.ts'));
      await flush();
      expect(drawerIsOpen()).toBe(false);
      expect(server().created).toEqual([{ kind: 'review', url: `changes:${APP}` }]);
    });

    it('a staged file opens the staged review', async () => {
      boot({ id: '0', kind: 'terminal' });
      await openDrawerOnScm();
      tapOn(await screen.findByTestId('scm-row-staged:b.ts'));
      await flush();
      expect(drawerIsOpen()).toBe(false);
      expect(server().created).toEqual([{ kind: 'review', url: `staged:${APP}` }]);
    });

    it('a pan that starts on a file opens nothing and leaves the drawer open', async () => {
      boot({ id: '0', kind: 'terminal' });
      await openDrawerOnScm();
      const row = await screen.findByTestId('scm-row-changes:a.ts');
      fireEvent.pointerDown(row, { ...at(100), clientY: 100 });
      fireEvent.pointerMove(row, { ...at(100), clientY: 160 });
      fireEvent.pointerUp(row, { ...at(100), clientY: 160 });
      await flush();
      expect(drawerIsOpen()).toBe(true);
      expect(server().created).toEqual([]);
    });

    it('an existing review of that group is focused, not opened a second time', async () => {
      boot({ id: '0', kind: 'terminal' }, REVIEW);
      await openDrawerOnScm();
      tapOn(await screen.findByTestId('scm-row-changes:a.ts'));
      await flush();
      expect(server().created).toEqual([]);
      expect(shown()).toBe('4');
      expect(drawerIsOpen()).toBe(false);
    });

    it('reads nothing once the drawer is closed, though the view is still mounted', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      boot();
      swipe(screen.getAllByTestId(/^extra-key-/)[0]!, 'left');
      fireEvent.click(screen.getByTestId('drawer-view-scm'));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(statusReads).toBeGreaterThan(0);

      act(() => drawer().onClose());
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByTestId('scm-view')).toBeInTheDocument(); // mounted, not seen
      const settled = statusReads;
      await act(() => vi.advanceTimersByTimeAsync(60 * 60 * 1000));
      expect(statusReads).toBe(settled);
    });

    it('Ctrl+Alt+G opens it on a phone, where the dock is never drawn', async () => {
      boot();
      const claimed = !fireEvent.keyDown(window, { key: 'g', ctrlKey: true, altKey: true });
      await flush();
      expect(claimed).toBe(true);
      expect(drawerIsOpen()).toBe(true);
      expect(drawer().view).toBe('scm');
      expect(screen.queryByTestId('dock')).toBeNull();
    });
  });
});

// ── Detached windows ──────────────────────────────────────────────────────────
//
// One tab, one window: the server says which detached window holds a tab (`TabMeta.window`), and
// every window draws only the tabs it holds. What only the REAL App can get wrong is which list each
// reader takes (the filtered one for everything a window shows, the full one for ids and order), how
// a move is held until the server agrees, and that nothing is ever attached or shown from two windows.
describe('detached windows', () => {
  const WID = 'wq3k9x2m1ab';
  const OTHER = 'wother00001';
  const term = (id: string, window?: string, extra: Record<string, unknown> = {}) => ({
    id,
    kind: 'terminal',
    ...(window ? { window } : {}),
    ...extra,
  });
  const stripIds = () => strips().flatMap((s) => s.tabs);
  const bootMain = (tabs: Array<Record<string, unknown>>) => {
    history.replaceState(null, '', '/'); // the app's own address, not the legacy `/0` the suite starts at
    render(<App />);
    send({ type: 'sessions', tabs });
  };
  const bootDetached = (tabs: Array<Record<string, unknown>>, path = `/window/${WID}?tab=1`) => {
    history.replaceState(null, '', path);
    render(<App />);
    send({ type: 'sessions', tabs });
  };
  /** The server announces detached windows (it does in `ready`, on every connect). */
  const supported = (on = true) =>
    send({
      type: 'ready',
      maxUploadBytes: 1024,
      webApps: [],
      ...(on ? { detachedWindows: true } : {}),
    });
  const menuOf = (id: string) => fireEvent.contextMenu(screen.getByTestId(`session-tab-${id}`));
  /** Pick "Open in new window" on a tab and return the window id the browser was asked to open. */
  const popOut = (id: string, open: MockInstance<typeof window.open>): string | undefined => {
    menuOf(id);
    fireEvent.click(screen.getByTestId('menu-popout'));
    const url = String(open.mock.calls.at(-1)?.[0] ?? '');
    return new RegExp(`^/window/(w[0-9a-z]{10})\\?tab=${id}$`).exec(url)?.[1];
  };

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('which tabs a window shows', () => {
    it('hides, in a main window, a tab a detached window holds', () => {
      bootMain([term('0'), term('1', WID), term('2')]);
      expect(stripIds()).toEqual(['0', '2']);
      expect(active()).toBe('0');
    });

    it('shows, in a detached window, only its own tabs', () => {
      bootDetached([term('0'), term('1', WID), term('2', OTHER), term('3', WID)]);
      expect(stripIds()).toEqual(['1', '3']);
      expect(active()).toBe('1');
    });

    it('names itself on the control socket, and the main window names nothing', () => {
      bootDetached([term('1', WID)]);
      expect(server().url).toMatch(new RegExp(`/ws\\?control=1&window=${WID}$`));
      cleanup();
      sockets.length = 0;
      history.replaceState(null, '', '/0');
      bootMain([term('0')]);
      expect(server().url).toMatch(/\/ws\?control=1$/);
    });

    it('ignores the mobile layer: a detached window is always the desktop layout', () => {
      localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'on' }));
      bootDetached([term('1', WID)]);
      expect(document.querySelector('.app')!.classList.contains('mobile')).toBe(false);
      expect(stripIds()).toEqual(['1']);
    });

    it('hands its panes the window they attach for, and a main window hands none', () => {
      bootDetached([term('1', WID)]);
      expect(screen.getByTestId('term-pane-p0')).toHaveAttribute('data-window', WID);
      cleanup();
      sockets.length = 0;
      history.replaceState(null, '', '/0');
      bootMain([term('0')]);
      expect(screen.getByTestId('term-pane-p0')).not.toHaveAttribute('data-window');
    });

    // A pane for an editor another window holds would mount its own Monaco over the same file.
    it('mounts no pane, in a main window, for an editor a detached window holds', () => {
      bootMain([term('0'), term('5', OTHER, { kind: 'editor', url: '/home/u/notes.md' })]);
      expect(paneHost.renders.at(-1)!.map((t) => t.id)).toEqual(['0']);
    });

    // Attached from both windows, a terminal would show "Opened somewhere else." in one of them.
    it('does nothing when a navigation names a tab another window holds', () => {
      bootMain([term('0'), term('1', OTHER)]);
      send({ type: 'tabCreated', id: '1' });
      expect(panes().map((p) => p.session)).toEqual(['0']);
      expect(active()).toBe('0');
      expect(stripIds()).toEqual(['0']);
    });

    it('shows a window that holds nothing the New-tab page', () => {
      bootMain([term('1', OTHER), term('2', OTHER)]);
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
      expect(panes()).toEqual([]);
    });

    // The phone's page keeps the closed id as `sessionId`. A navigation refused for another
    // window's tab must not clear the page as well: the one-pane path would then draw that closed
    // id as a fresh terminal and spawn a shell on it.
    it('keeps the phone on the New-tab page when a navigation names another window’s tab', () => {
      localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'on' }));
      bootMain([term('0')]);
      send({ type: 'sessions', tabs: [term('1', OTHER)] }); // the last tab here closes
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
      const socketsBefore = sockets.length;
      send({ type: 'tabCreated', id: '1' });
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
      expect(panes()).toEqual([]);
      expect(sockets).toHaveLength(socketsBefore);
    });

    // A legacy `/<id>` used to be shown before the list could say who holds the tab: the pane
    // attached as a fresh terminal and evicted the other window's.
    it('mounts no pane for a legacy /<id> that names a tab another window holds', () => {
      history.replaceState(null, '', '/1');
      render(<App />);
      send({ type: 'sessions', tabs: [term('0'), term('1', OTHER)] });
      expect(panes().map((p) => p.session)).toEqual(['0']);
      expect(stripIds()).toEqual(['0']);
    });

    it('mounts no pane for it on the mobile layer either', () => {
      localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'on' }));
      history.replaceState(null, '', '/1');
      render(<App />);
      send({ type: 'sessions', tabs: [term('0'), term('1', OTHER)] });
      expect(panes().map((p) => p.session)).toEqual(['0']);
    });

    it('opens such a legacy /<id> as a plain boot would, on the tab this window remembers', () => {
      sessionStorage.setItem('palmux-window-tab', JSON.stringify({ id: '2', kind: 'terminal' }));
      history.replaceState(null, '', '/1');
      render(<App />);
      send({ type: 'sessions', tabs: [term('0'), term('1', OTHER), term('2')] });
      expect(panes().map((p) => p.session)).toEqual(['2']);
    });
  });

  describe('a detached boot', () => {
    it('lands on the tab it was opened for and takes ?tab= out of the address', () => {
      bootDetached([term('0'), term('1', WID), term('3', WID)], `/window/${WID}?tab=3`);
      expect(active()).toBe('3');
      expect(location.pathname).toBe(`/window/${WID}`);
      expect(location.search).toBe('');
    });

    it('keeps its address, not `/`, when it was opened without a tab', () => {
      bootDetached([term('1', WID)], `/window/${WID}`);
      expect(location.pathname).toBe(`/window/${WID}`);
    });

    it('reads its own remembered tab, and the device’s last tab is not its business', () => {
      localStorage.setItem('palmux-last-tab', JSON.stringify({ id: '3', kind: 'terminal' }));
      sessionStorage.setItem(
        `palmux-window-tab:${WID}`,
        JSON.stringify({ id: '3', kind: 'terminal' }),
      );
      bootDetached([term('1', WID), term('3', WID)], `/window/${WID}`);
      expect(active()).toBe('3');
      cleanup();
      sockets.length = 0;
      sessionStorage.clear();
      bootDetached([term('1', WID), term('3', WID)], `/window/${WID}`);
      expect(active()).toBe('1'); // no own value: the first tab, never palmux-last-tab's 3
    });

    it('never writes palmux-last-tab, and keeps selection and layout under keys of its own', () => {
      bootDetached([term('1', WID), term('3', WID)]);
      clickTab('3');
      expect(localStorage.getItem('palmux-last-tab')).toBeNull();
      expect(JSON.parse(sessionStorage.getItem(`palmux-window-tab:${WID}`)!)).toEqual({
        id: '3',
        kind: 'terminal',
      });
      expect(sessionStorage.getItem('palmux-window-tab')).toBeNull();
      expect(sessionStorage.getItem(`palmux-layout:${WID}`)).not.toBeNull();
      expect(sessionStorage.getItem('palmux-layout')).toBeNull();
    });

    // `window.open` may copy the opener's sessionStorage, panes and selection included.
    it('ignores the main window’s layout and selection that the opener copied', () => {
      sessionStorage.setItem('palmux-layout', TWO_COLUMNS);
      sessionStorage.setItem('palmux-window-tab', JSON.stringify({ id: '2', kind: 'terminal' }));
      bootDetached([term('0'), term('1', WID), term('2')]);
      expect(strips().map((x) => x.tabs)).toEqual([['1']]);
      expect(active()).toBe('1');
    });
  });

  describe('ids and order stay whole', () => {
    it('picks a fresh terminal id that skips an id another window holds', () => {
      bootMain([term('0'), term('1', OTHER)]);
      fireEvent.pointerDown(stripOf('p0').getByTestId('session-new'), { button: 0 });
      tapPress(screen.getByTestId('dash-new-terminal'));
      expect(shownIn('p0')).toBe('2');
    });

    it('sends the full order from a reorder, with the other window’s tabs in place', () => {
      bootMain([term('0'), term('1', OTHER), term('2'), term('3', OTHER), term('4')]);
      const t = dt();
      fireEvent.dragStart(screen.getByTestId('session-tab-4'), { dataTransfer: t });
      t.setData(TAB_DND_TYPE, '4');
      fireEvent.dragOver(screen.getByTestId('session-tab-0'), { dataTransfer: t });
      fireEvent.drop(screen.getByTestId('session-tabs'), { dataTransfer: t });
      // Sent as [0,4,2], the server would put 1 and 3 at the end.
      expect(server().reorders.at(-1)).toEqual(['0', '1', '4', '2', '3']);
      expect(stripIds()).toEqual(['0', '4', '2']);
    });

    it('"Close other tabs" closes only the tabs this window shows', () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      bootMain([term('0'), term('1', OTHER), term('2')]);
      menuOf('0');
      fireEvent.click(screen.getByTestId('menu-close-others'));
      expect(server().killed).toEqual(['2']);
    });

    it('a group’s Close all closes only the members this window shows', () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      history.replaceState(null, '', '/');
      render(<App />);
      send({
        type: 'sessions',
        tabs: [
          term('0', undefined, { groupId: 'gaa111' }),
          term('1', OTHER, { groupId: 'gaa111' }),
          term('2', undefined, { groupId: 'gaa111' }),
        ],
        groups: [{ id: 'gaa111', color: 'blue' }],
      });
      fireEvent.contextMenu(screen.getByTestId('group-chip-gaa111'));
      fireEvent.click(screen.getByTestId('group-menu-close-all'));
      expect(server().killed).toEqual(['0', '2']);
    });

    // The order a group join sends is the full one: sent without the hidden tab, the server
    // would append it at the end and move it out of its place.
    it('keeps the other window’s tabs in place in the order "Add to group" sends', () => {
      history.replaceState(null, '', '/');
      render(<App />);
      send({
        type: 'sessions',
        tabs: [term('0'), term('1', OTHER), term('2', undefined, { groupId: 'gaa111' })],
        groups: [{ id: 'gaa111', color: 'blue' }],
      });
      menuOf('0');
      fireEvent.click(screen.getByTestId('menu-add-to-gaa111'));
      expect(server().groupUpdates).toEqual([
        { id: 'gaa111', addIds: ['0'], order: ['1', '2', '0'] },
      ]);
    });
  });

  describe('opening a tab in a new window', () => {
    let open: MockInstance<typeof window.open>;
    beforeEach(() => {
      open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    });

    it('moves the tab: the window it leaves stops showing it, pane and all', () => {
      bootMain([term('0'), term('1'), term('2')]);
      supported();
      clickTab('1');
      const wid = popOut('1', open);
      expect(wid).toBeTruthy();
      expect(open.mock.calls[0]![1]).toBe(`palmux-${wid}`);
      expect(open.mock.calls[0]![2]).toBe('popup,width=1000,height=640');
      expect(server().moves).toEqual([{ ids: ['1'], window: wid }]);
      expect(stripIds()).toEqual(['0', '2']);
      // The pane leaves in the same render, before the new window could attach.
      expect(panes().map((p) => p.session)).toEqual(['0']);
      expect(active()).toBe('0');
    });

    it('works for every kind', () => {
      bootMain([term('0'), term('5', undefined, { kind: 'editor' })]);
      supported();
      const wid = popOut('5', open);
      expect(server().moves).toEqual([{ ids: ['5'], window: wid }]);
      expect(stripIds()).toEqual(['0']);
    });

    // A frame already on its way when the move is sent still names the old owner.
    it('holds the move against a broadcast already in flight, until the server agrees', () => {
      bootMain([term('0'), term('1'), term('2')]);
      supported();
      const wid = popOut('1', open)!;
      broadcast(['0', '1', '2']); // in flight: the old owner
      expect(stripIds()).toEqual(['0', '2']);
      send({ type: 'sessions', tabs: [term('0'), term('1', wid), term('2')] }); // the server agrees
      expect(stripIds()).toEqual(['0', '2']);
      // The agreement spent the hold: when the window releases the tab, it is back at once.
      broadcast(['0', '1', '2']);
      expect(stripIds()).toEqual(['0', '1', '2']);
    });

    it('shows a tab again after 2 s when the server never moved it', () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      bootMain([term('0'), term('1'), term('2')]);
      supported();
      popOut('1', open);
      broadcast(['0', '1', '2']); // the server refused: the old owner, for good
      act(() => void vi.advanceTimersByTime(1999));
      expect(stripIds()).toEqual(['0', '2']);
      act(() => void vi.advanceTimersByTime(1));
      expect(stripIds()).toEqual(['0', '1', '2']);
    });

    it('moves nothing, and says so, when the browser blocks the window', () => {
      open.mockReturnValue(null);
      bootMain([term('0'), term('1')]);
      supported();
      menuOf('1');
      fireEvent.click(screen.getByTestId('menu-popout'));
      expect(screen.getByText('New window blocked — allow popups for this site')).toBeTruthy();
      expect(server().moves).toEqual([]);
      expect(stripIds()).toEqual(['0', '1']);
    });

    // The window opens before the move is sent. Left open, it would hold no tab and no one would
    // ever move one into it.
    it('closes the window it opened when the move cannot be sent', () => {
      const close = vi.fn();
      open.mockReturnValue({ close } as unknown as Window);
      bootMain([term('0'), term('1')]);
      supported();
      const ws = server() as unknown as { sendMoveToWindow: () => boolean };
      vi.spyOn(ws, 'sendMoveToWindow').mockReturnValue(false);
      menuOf('1');
      fireEvent.click(screen.getByTestId('menu-popout'));
      expect(open).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Not connected — try again')).toBeTruthy();
      expect(stripIds()).toEqual(['0', '1']);
    });

    // The server only knows a terminal once its pane attaches.
    it('will not open a terminal no broadcast lists yet', () => {
      bootMain([term('0'), term('1')]);
      supported();
      fireEvent.pointerDown(stripOf('p0').getByTestId('session-new'), { button: 0 });
      tapPress(screen.getByTestId('dash-new-terminal'));
      expect(shownIn('p0')).toBe('2');
      menuOf('2');
      fireEvent.click(screen.getByTestId('menu-popout'));
      expect(screen.getByText('Wait for the terminal to start')).toBeTruthy();
      expect(open).not.toHaveBeenCalled();
      expect(server().moves).toEqual([]);
      expect(stripIds()).toContain('2');
    });

    describe('an editor with unsaved text', () => {
      const dirtyEditor = () => {
        bootMain([term('0'), term('5', undefined, { kind: 'editor', url: '/home/u/notes.md' })]);
        supported();
        act(() => paneHost.onDirtyChange?.('5', true));
      };

      it('asks first, and Cancel moves nothing and opens nothing', () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
        dirtyEditor();
        menuOf('5');
        fireEvent.click(screen.getByTestId('menu-popout'));
        expect(confirm).toHaveBeenCalledWith(
          '1 editor tab has unsaved changes. Move and discard them?',
        );
        expect(open).not.toHaveBeenCalled();
        expect(server().moves).toEqual([]);
        expect(stripIds()).toEqual(['0', '5']);
      });

      it('moves on OK, and the moved tab leaves the dirty record, so Reload no longer counts it', () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        dirtyEditor();
        expect(stripSpy.renders.at(-1)!['dirty']).toEqual({ '5': true });
        const wid = popOut('5', open);
        expect(server().moves).toEqual([{ ids: ['5'], window: wid }]);
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(stripSpy.renders.at(-1)!['dirty']).toEqual({});
      });

      it('asks nothing for a clean editor', () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
        bootMain([term('0'), term('5', undefined, { kind: 'editor' })]);
        supported();
        popOut('5', open);
        expect(confirm).not.toHaveBeenCalled();
        expect(server().moves).toHaveLength(1);
      });
    });
  });

  // A tab dragged from ANOTHER window. The receiver has no local drag, so it learns of the drag from
  // a capture `dragover` on the window and reads the id on the drop. Nothing here is the browser's:
  // the events are built by hand and carry the fields the app reads.
  describe('a tab dragged between windows', () => {
    const foreign = (id: string, dirty = false) => ({
      types: dirty ? [TAB_DND_TYPE, TAB_DIRTY_DND_TYPE] : [TAB_DND_TYPE],
      setData: () => {},
      getData: () => id,
      effectAllowed: '',
      dropEffect: '',
    });
    const fire = (
      type: 'dragover' | 'drop' | 'dragleave' | 'dragend',
      el: Element,
      dataTransfer: unknown,
      extra: Record<string, unknown> = {},
    ) => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(ev, { dataTransfer, clientX: 0, clientY: 0, relatedTarget: null, ...extra });
      fireEvent(el, ev);
    };
    /** A drag from another window passes over the window. */
    const hover = (id: string, dirty = false) =>
      fire('dragover', document.body, foreign(id, dirty), { clientX: 500, clientY: 300 });
    const overlays = () => screen.queryAllByTestId('group-drop-overlay');
    /** Release the drag on the `index`th overlay, in `region` of its 300x300 body. */
    const dropForeign = (id: string, index: number, region: keyof typeof REGION_AT) => {
      const t = foreign(id);
      const overlay = overlays()[index]!;
      overlay.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 300, height: 300 }) as DOMRect;
      const [x, y] = REGION_AT[region];
      dragAt('dragover', overlay, t, x, y);
      dragAt('drop', overlay, t, x, y);
    };
    const fromElsewhere = () => bootMain([term('0'), term('1'), term('2', OTHER)]);

    afterEach(() => vi.useRealTimers());

    describe('over the window', () => {
      it('mounts the overlays and lights the strip under the pointer, though no local drag exists', () => {
        fromElsewhere();
        expect(overlays()).toHaveLength(0);
        hover('2');
        expect(overlays()).toHaveLength(1);
        // The strip lights where the pointer is over it, as for another pane's tab.
        const strip = stripOf('p0').getByTestId('session-tabs');
        expect(strip).not.toHaveClass('drop-into');
        dragAt('dragover', strip, foreign('2'));
        expect(strip).toHaveClass('drop-into');
      });

      it('mounts an overlay on every pane', () => {
        fromElsewhere();
        dropOnPane('1', 0, 'right'); // p0 = [0], p1 = [1]
        hover('2');
        expect(overlays()).toHaveLength(2);
      });

      it('ignores a drag that carries no tab', () => {
        fromElsewhere();
        fire('dragover', document.body, { ...foreign('2'), types: ['Files'] });
        expect(overlays()).toHaveLength(0);
      });

      // The clear is by the clock: the browser tells a window nothing when a drag it was watching is
      // released over another window, so each `dragover` buys 1000 ms, and an abandoned drag goes.
      it('goes 1000 ms after the last dragover, and each dragover restarts the count', () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        fromElsewhere();
        hover('2');
        act(() => void vi.advanceTimersByTime(999));
        expect(overlays()).toHaveLength(1);
        hover('2');
        act(() => void vi.advanceTimersByTime(999));
        expect(overlays()).toHaveLength(1);
        act(() => void vi.advanceTimersByTime(1));
        expect(overlays()).toHaveLength(0);
        expect(stripOf('p0').getByTestId('session-tabs')).not.toHaveClass('drop-into');
      });

      // Measured on Chrome 156 (X11): a STILL pointer is reported by one `dragover` every ~352 ms.
      // A 300 ms clock unmounted the overlay between two repeats, the next repeat found nothing
      // there to cancel it, and a release in that gap was lost.
      it('stays through a still hold between dragover repeats, and a release then moves the tab', () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        fromElsewhere();
        for (let i = 0; i < 5; i++) {
          hover('2');
          act(() => void vi.advanceTimersByTime(351));
          expect(overlays()).toHaveLength(1);
        }
        hover('2');
        act(() => void vi.advanceTimersByTime(400)); // released with no further dragover
        expect(overlays()).toHaveLength(1);
        const overlay = overlays()[0]!;
        overlay.getBoundingClientRect = () =>
          ({ left: 0, top: 0, width: 300, height: 300 }) as DOMRect;
        dragAt('drop', overlay, foreign('2'), ...REGION_AT.centre);
        expect(server().moves).toEqual([{ ids: ['2'], window: null }]);
      });

      it('goes when the drag leaves the viewport, and stays while the pointer is inside it', () => {
        fromElsewhere();
        hover('2');
        // Browsers report a null `relatedTarget` between elements too: only the pointer says it left.
        fire('dragleave', document.body, foreign('2'), { clientX: 500, clientY: 300 });
        expect(overlays()).toHaveLength(1);
        fire('dragleave', document.body, foreign('2'), { clientX: -1, clientY: 300 });
        expect(overlays()).toHaveLength(0);
        hover('2');
        fire('dragleave', document.body, foreign('2'), {
          clientX: window.innerWidth + 1,
          clientY: 300,
        });
        expect(overlays()).toHaveLength(0);
      });

      it('goes one tick after a drop, so the overlay under the drop can still read it', () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        fromElsewhere();
        hover('2');
        fire('drop', document.body, foreign('2')); // claimed by nothing
        expect(overlays()).toHaveLength(1);
        act(() => void vi.advanceTimersByTime(0));
        expect(overlays()).toHaveLength(0);
      });
    });

    describe('dropped on a pane', () => {
      it('an edge sends moveToWindow here and splits, and the broadcast that lists the tab splits nothing more', () => {
        fromElsewhere();
        hover('2');
        dropForeign('2', 0, 'bottom');
        expect(server().moves).toEqual([{ ids: ['2'], window: null }]);
        // Held ahead of the server: the tab is here at once, in a pane of its own.
        expect(strips()).toEqual([
          { pane: 'p0', tabs: ['0', '1'], focused: false },
          { pane: 'p1', tabs: ['2'], focused: true },
        ]);
        send({ type: 'sessions', tabs: [term('0'), term('1'), term('2')] });
        expect(strips()).toEqual([
          { pane: 'p0', tabs: ['0', '1'], focused: false },
          { pane: 'p1', tabs: ['2'], focused: true },
        ]);
        expect(panes().map((p) => p.session)).toEqual(['0', '2']);
      });

      it('the centre joins that pane and shows the tab', () => {
        fromElsewhere();
        dropOnPane('1', 0, 'right'); // p0 = [0], p1 = [1]
        hover('2');
        dropForeign('2', 1, 'centre');
        expect(server().moves).toEqual([{ ids: ['2'], window: null }]);
        expect(strips()).toEqual([
          { pane: 'p0', tabs: ['0'], focused: false },
          { pane: 'p1', tabs: ['1', '2'], focused: true },
        ]);
        expect(shownIn('p1')).toBe('2');
      });

      // The pane a drop parks is for THAT move, and is spent in the render the hold first lists the
      // tab. A move that runs out unconfirmed leaves nothing parked: the tab reaching this window
      // later by any other path joins the focused pane and is not shown.
      it('forgets where a move the server never made was to land', () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        fromElsewhere();
        dropOnPane('1', 0, 'right'); // p0 = [0], p1 = [1]
        clickTab('0'); // focus p0
        hover('2');
        dropForeign('2', 1, 'centre');
        expect(server().moves).toEqual([{ ids: ['2'], window: null }]);
        act(() => void vi.advanceTimersByTime(2000)); // nobody moved it
        expect(strips().map((x) => x.tabs)).toEqual([['0'], ['1']]);
        clickTab('0'); // the focused pane is not the one the drop was on
        send({ type: 'sessions', tabs: [term('0'), term('1'), term('2')] });
        expect(strips()).toEqual([
          { pane: 'p0', tabs: ['0', '2'], focused: true },
          { pane: 'p1', tabs: ['1'], focused: false },
        ]);
        expect(shownIn('p0')).toBe('0');
        expect(shownIn('p1')).toBe('1');
      });

      it('a detached window takes it for itself', () => {
        bootDetached([term('1', WID), term('5')]);
        hover('5');
        dropForeign('5', 0, 'centre');
        expect(server().moves).toEqual([{ ids: ['5'], window: WID }]);
      });

      // The tab is not listed here until the server moves it, which a pane of its own would race.
      it('an id no list has is ignored, and takes no pane', () => {
        fromElsewhere();
        hover('9');
        dropForeign('9', 0, 'right');
        expect(server().moves).toEqual([]);
        expect(strips().map((x) => x.tabs)).toEqual([['0', '1']]);
        expect(panes()).toHaveLength(1);
      });

      it('a tab this window already shows is an ordinary local drop, and sends nothing', () => {
        fromElsewhere();
        hover('1');
        dropForeign('1', 0, 'right');
        expect(server().moves).toEqual([]);
        expect(strips().map((x) => x.tabs)).toEqual([['0'], ['1']]);
      });
    });

    describe('dropped on a strip', () => {
      it('moves the tab here and shows it in that pane', () => {
        fromElsewhere();
        dropOnPane('1', 0, 'right'); // p0 = [0], p1 = [1]
        hover('2');
        const strip = stripOf('p1').getByTestId('session-tabs');
        const t = foreign('2');
        dragAt('dragover', strip, t);
        expect(strip).toHaveClass('drop-into');
        expect(document.querySelectorAll('.drop-before, .drop-after')).toHaveLength(0);
        fireEvent.drop(strip, { dataTransfer: t });
        expect(server().moves).toEqual([{ ids: ['2'], window: null }]);
        expect(strips().map((x) => x.tabs)).toEqual([['0'], ['1', '2']]);
        expect(shownIn('p1')).toBe('2');
        expect(server().reorders).toEqual([]);
      });
    });

    describe('on the New-tab page', () => {
      const emptied = () => bootMain([term('0', OTHER)]);

      it('takes one centre overlay over the page, and a drop anywhere on it moves the tab into the one pane', () => {
        emptied();
        expect(screen.getByTestId('newtab-page')).toBeTruthy();
        hover('0');
        expect(overlays()).toHaveLength(1);
        dropForeign('0', 0, 'left'); // an edge of a page is still the centre: there is nothing to split
        expect(server().moves).toEqual([{ ids: ['0'], window: null }]);
        expect(screen.queryByTestId('newtab-page')).toBeNull();
        expect(strips()).toEqual([{ pane: 'p0', tabs: ['0'], focused: true }]);
        expect(panes()).toEqual([{ slot: 'p0', session: '0', focused: false }]);
      });

      it('shows its preview over the whole page', () => {
        emptied();
        hover('0');
        const overlay = overlays()[0]!;
        overlay.getBoundingClientRect = () =>
          ({ left: 0, top: 0, width: 300, height: 300 }) as DOMRect;
        dragAt('dragover', overlay, foreign('0'), 20, 150);
        expect(screen.getByTestId('group-drop-preview')).toHaveAttribute('data-region', 'centre');
      });

      it('mounts nothing for a drag that carries unsaved text', () => {
        emptied();
        hover('0', true);
        expect(overlays()).toHaveLength(0);
      });
    });

    describe('carrying unsaved text', () => {
      const SAVE_FIRST = 'Save the file before moving it to another window';
      beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));

      it('is no target: no overlay, no lit strip', () => {
        fromElsewhere();
        hover('2', true);
        expect(overlays()).toHaveLength(0);
        expect(stripOf('p0').getByTestId('session-tabs')).not.toHaveClass('drop-into');
        expect(screen.getByText(SAVE_FIRST)).toBeTruthy();
      });

      it('says so once while it hovers, and again on the next entry into the window', () => {
        fromElsewhere();
        // A dragover every 50 ms for 2.5 s: well past the toast's own 1.4 s.
        for (let i = 0; i < 50; i++) {
          hover('2', true);
          act(() => void vi.advanceTimersByTime(50));
          if (i === 0) expect(screen.queryByText(SAVE_FIRST)).toBeTruthy();
        }
        expect(screen.queryByText(SAVE_FIRST)).toBeNull(); // not shown a second time
        act(() => void vi.advanceTimersByTime(1000)); // the pointer left
        hover('2', true);
        expect(screen.getByText(SAVE_FIRST)).toBeTruthy();
      });

      // A still pointer is reported every ~352 ms. A clock shorter than that ended the "entry"
      // between two repeats, so the toast came back on every one of them.
      it('says so once through a still hold, reported every 352 ms', () => {
        fromElsewhere();
        hover('2', true);
        expect(screen.getByText(SAVE_FIRST)).toBeTruthy();
        for (let i = 0; i < 6; i++) {
          act(() => void vi.advanceTimersByTime(352)); // 2.1 s in all, past the toast's own 1.4 s
          hover('2', true);
        }
        expect(screen.queryByText(SAVE_FIRST)).toBeNull();
      });
    });

    // The window the drag came FROM only hears `dragend`, with what the receiver answered.
    describe('leaving this window', () => {
      const dragStart = (id: string) => {
        const t = dt();
        fireEvent.dragStart(screen.getByTestId(`session-tab-${id}`), { dataTransfer: t });
        t.setData(TAB_DND_TYPE, id);
      };
      const endWith = (dropEffect: string) =>
        fire('dragend', document.body, { ...dt(), dropEffect });
      const threeTabs = () => bootMain([term('0'), term('1'), term('2')]);

      it('drops the tab on a `move` dragend that no drop here explains, and sends nothing', () => {
        threeTabs();
        dragStart('1');
        endWith('move');
        expect(stripIds()).toEqual(['0', '2']);
        expect(panes().map((p) => p.session)).toEqual(['0']);
        expect(server().moves).toEqual([]);
      });

      it('shows it again after 2 s when the server never moved it', () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        threeTabs();
        dragStart('1');
        endWith('move');
        broadcast(['0', '1', '2']); // nobody took it
        act(() => void vi.advanceTimersByTime(1999));
        expect(stripIds()).toEqual(['0', '2']);
        act(() => void vi.advanceTimersByTime(1));
        expect(stripIds()).toEqual(['0', '1', '2']);
      });

      it.each(['none', 'copy', ''])('keeps the tab on a `%s` dragend', (dropEffect) => {
        threeTabs();
        dragStart('1');
        endWith(dropEffect);
        expect(stripIds()).toEqual(['0', '1', '2']);
      });

      // Any drop in this window is a local one, whoever took it and whatever it did.
      it('keeps the tab when a drop landed in this window first', () => {
        threeTabs();
        dragStart('1');
        fireEvent.drop(document.body, { dataTransfer: dt() });
        endWith('move');
        expect(stripIds()).toEqual(['0', '1', '2']);
      });

      it('forgets an earlier local drop when the next drag starts', () => {
        threeTabs();
        dragStart('1');
        fireEvent.drop(document.body, { dataTransfer: dt() });
        endWith('none');
        dragStart('2');
        endWith('move');
        expect(stripIds()).toEqual(['0', '1']);
      });

      it('keeps a dirty editor: only a window that refuses it could have answered `move`', () => {
        bootMain([term('0'), term('5', undefined, { kind: 'editor', url: '/home/u/notes.md' })]);
        act(() => paneHost.onDirtyChange?.('5', true));
        dragStart('5');
        endWith('move');
        expect(stripIds()).toEqual(['0', '5']);
      });

      it('keeps a terminal no broadcast lists yet', () => {
        bootMain([term('0'), term('1')]);
        fireEvent.pointerDown(stripOf('p0').getByTestId('session-new'), { button: 0 });
        tapPress(screen.getByTestId('dash-new-terminal'));
        expect(shownIn('p0')).toBe('2');
        dragStart('2');
        endWith('move');
        // Held, it would hide the terminal the moment the server lists it.
        broadcast(['0', '1', '2']);
        expect(stripIds()).toEqual(['0', '1', '2']);
      });
    });

    describe('a local drag', () => {
      it('never shows the external overlays or lights a strip on its own', () => {
        fromElsewhere();
        const t = dt();
        fireEvent.dragStart(screen.getByTestId('session-tab-1'), { dataTransfer: t });
        t.setData(TAB_DND_TYPE, '1');
        dragAt('dragover', document.body, t, 500, 300);
        expect(stripOf('p0').getByTestId('session-tabs')).not.toHaveClass('drop-into');
        // One overlay, for the local drag: p0 holds the tab, and the edges are live.
        expect(overlays()).toHaveLength(1);
        expect(server().moves).toEqual([]);
      });

      it('splits as before and sends nothing to the server', () => {
        fromElsewhere();
        dropOnPane('1', 0, 'right');
        expect(strips().map((x) => x.tabs)).toEqual([['0'], ['1']]);
        expect(server().moves).toEqual([]);
      });

      // A foreign drag stays live for 1000 ms after its last dragover. A drag of this window's own
      // that starts inside that tail must not read as foreign, or its strip resolves no boundary.
      it('started while a foreign drag is still fading out, is an ordinary reorder', () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        fromElsewhere();
        hover('2');
        act(() => void vi.advanceTimersByTime(100));
        const t = dt();
        fireEvent.dragStart(screen.getByTestId('session-tab-0'), { dataTransfer: t });
        t.setData(TAB_DND_TYPE, '0');
        // Nor does its own pane read it as foreign: a pane's centre takes no tab it already holds.
        const overlay = overlays()[0]!;
        overlay.getBoundingClientRect = () =>
          ({ left: 0, top: 0, width: 300, height: 300 }) as DOMRect;
        dragAt('dragover', overlay, t, ...REGION_AT.centre);
        expect(screen.queryByTestId('group-drop-preview')).toBeNull();
        const strip = stripOf('p0').getByTestId('session-tabs');
        fireEvent.dragOver(screen.getByTestId('session-tab-1'), { dataTransfer: t });
        expect(strip).not.toHaveClass('drop-into');
        expect(document.querySelectorAll('.drop-before, .drop-after')).toHaveLength(1);
        fireEvent.drop(strip, { dataTransfer: t });
        expect(server().reorders).toEqual([['1', '0', '2']]);
        expect(stripIds()).toEqual(['1', '0']);
        expect(server().moves).toEqual([]);
      });
    });
  });

  describe('the item in the menu', () => {
    it('is offered only once the server has said it supports detached windows', () => {
      bootMain([term('0'), term('1')]);
      menuOf('1');
      expect(screen.queryByTestId('menu-popout')).toBeNull();
      supported();
      expect(screen.getByTestId('menu-popout')).toBeTruthy();
      // The LAST `ready` decides: a rollback to an older server takes it away again.
      supported(false);
      expect(screen.queryByTestId('menu-popout')).toBeNull();
    });

    it('is not offered on the mobile layer, where the sheet has none either', () => {
      localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'on' }));
      bootMain([term('0'), term('1')]);
      supported();
      expect(screen.queryByTestId('menu-popout')).toBeNull();
      act(() => drawer().onTabMenu('1'));
      expect(screen.getByTestId('tab-sheet')).toBeTruthy();
      expect(screen.queryByText(/open in new window/i)).toBeNull();
    });

    it('offers "Move to main window" in a detached window only', () => {
      bootMain([term('0'), term('1')]);
      supported();
      menuOf('1');
      expect(screen.getByTestId('menu-popout')).toBeTruthy();
      expect(screen.queryByTestId('menu-move-main')).toBeNull();
      cleanup();
      sockets.length = 0;
      bootDetached([term('1', WID), term('2', WID)]);
      supported();
      menuOf('1');
      expect(screen.getByTestId('menu-move-main')).toBeTruthy();
      expect(screen.getByTestId('menu-popout')).toBeTruthy(); // still: another new window
    });

    it('returns the tab to the main window, and the detached window stops showing it', () => {
      bootDetached([term('1', WID), term('2', WID)]);
      menuOf('1');
      fireEvent.click(screen.getByTestId('menu-move-main'));
      expect(server().moves).toEqual([{ ids: ['1'], window: null }]);
      expect(stripIds()).toEqual(['2']);
      expect(screen.queryByTestId('tab-menu')).toBeNull();
    });

    it('asks first for an editor with unsaved text, and Cancel keeps it here', () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      bootDetached([term('1', WID), term('5', WID, { kind: 'editor' })]);
      act(() => paneHost.onDirtyChange?.('5', true));
      menuOf('5');
      fireEvent.click(screen.getByTestId('menu-move-main'));
      expect(confirm).toHaveBeenCalledWith(
        '1 editor tab has unsaved changes. Move and discard them?',
      );
      expect(server().moves).toEqual([]);
      expect(stripIds()).toEqual(['1', '5']);
    });
  });

  describe('a tab created here', () => {
    it('is created in this detached window', () => {
      bootDetached([term('1', WID)]);
      act(() => void paneHost.review!.openFile('/home/u/new.md'));
      expect(server().created).toEqual([{ kind: 'editor', url: '/home/u/new.md', window: WID }]);
    });

    it('names no window in the main window', () => {
      bootMain([term('0')]);
      act(() => void paneHost.review!.openFile('/home/u/new.md'));
      expect(server().created).toEqual([{ kind: 'editor', url: '/home/u/new.md' }]);
    });
  });

  describe('opening a file another window holds', () => {
    const notes = (window?: string) =>
      term('5', window, { kind: 'editor', url: '/home/u/notes.md' });

    it('says so and changes nothing: this window cannot see the other one’s unsaved text', () => {
      bootMain([term('0'), notes(OTHER)]);
      act(() => void paneHost.review!.openFile('/home/u/notes.md'));
      expect(screen.getByText('notes.md is open in another window')).toBeTruthy();
      expect(server().created).toEqual([]);
      expect(server().moves).toEqual([]);
      expect(stripIds()).toEqual(['0']);
    });

    it('still selects the tab when this window holds it', () => {
      bootMain([term('0'), notes()]);
      act(() => void paneHost.review!.openFile('/home/u/notes.md'));
      expect(shownIn('p0')).toBe('5');
      expect(server().created).toEqual([]);
    });
  });

  describe('opening a review another window holds', () => {
    const APP_REPO = '/home/u/work/app';
    const reply = (body: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    beforeEach(() => {
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
          const u = new URL(url, 'http://palmux');
          return reply(
            u.pathname === '/scm/status'
              ? {
                  top: APP_REPO,
                  branch: 'main',
                  unborn: false,
                  merge: [],
                  staged: [],
                  changes: [{ path: 'c.ts', kind: 'ordinary', status: 'M', fp: 'fp-c' }],
                  truncated: false,
                  tookMs: 10,
                  commentsRev: 0,
                  attrEpoch: 'e0',
                }
              : null,
          );
        }),
      );
      localStorage.setItem(
        'palmux-settings',
        JSON.stringify({ mobileMode: 'off', scmRepos: [APP_REPO], scmActiveRepo: APP_REPO }),
      );
    });
    afterEach(() => vi.unstubAllGlobals());
    const review = (window?: string) =>
      term('4', window, { kind: 'review', url: `changes:${APP_REPO}` });
    const openRow = async () => {
      fireEvent.click(screen.getByTestId('dock-rail-scm'));
      fireEvent.click(await screen.findByTestId('scm-row-changes:c.ts'));
    };

    // A detached window has no dock to list Source Control rows in, so it cannot open a review: the
    // move INTO a detached window is no longer reachable from its UI, and only the main window asks.
    it('moves it into the main window when a detached window holds it', async () => {
      bootMain([term('0'), review(OTHER)]);
      await openRow();
      expect(server().moves).toEqual([{ ids: ['4'], window: null }]);
      expect(server().created).toEqual([]);
      expect(shownIn('p0')).toBe('4');
    });
  });

  // ── Reclaim, legacy and self-close ─────────────────────────────────────────────
  // Ownership lives in the server's memory and dies with a restart or a long blip, so a detached
  // window takes back the tabs its layout holds on the first `sessions` after each connect.
  describe('reclaiming its tabs', () => {
    /** A detached window as the browser boots it: the socket opens, then the server lists the tabs. */
    const bootOnline = (tabs: Array<Record<string, unknown>>, path = `/window/${WID}`) => {
      history.replaceState(null, '', path);
      render(<App />);
      connect();
      send({ type: 'sessions', tabs });
    };

    it('takes back, after a server restart, the tabs its layout held', () => {
      bootOnline([term('0'), term('1', WID), term('3', WID)]);
      clickTab('3');
      expect(server().moves).toEqual([]);
      // The restart: the server forgot every owner, and the window reconnects.
      connect();
      send({ type: 'sessions', tabs: [term('0'), term('1'), term('3')] });
      expect(server().moves).toEqual([{ ids: ['1', '3'], window: WID }]);
      // Held while the server agrees: the window never shows an empty frame in between.
      expect(stripIds()).toEqual(['1', '3']);
      expect(active()).toBe('3');
    });

    it('claims, on its first connect, the tab it was opened for', () => {
      bootOnline([term('0'), term('1')], `/window/${WID}?tab=1`);
      expect(server().moves).toEqual([{ ids: ['1'], window: WID }]);
      expect(stripIds()).toEqual(['1']);
      expect(active()).toBe('1');
      expect(location.pathname).toBe(`/window/${WID}`);
      expect(location.search).toBe('');
      // The server agrees: nothing is claimed twice.
      send({ type: 'sessions', tabs: [term('0'), term('1', WID)] });
      expect(server().moves).toHaveLength(1);
      expect(stripIds()).toEqual(['1']);
    });

    it('takes nothing another window holds, and drops it from its layout', () => {
      bootOnline([term('1', WID), term('5', WID)]);
      expect(stripIds()).toEqual(['1', '5']);
      connect();
      send({ type: 'sessions', tabs: [term('1'), term('5', OTHER)] });
      expect(server().moves).toEqual([{ ids: ['1'], window: WID }]);
      expect(stripIds()).toEqual(['1']);
    });

    it('does not pull back a tab it sent to the main window, on a reconnect', () => {
      bootOnline([term('1', WID), term('2', WID)], `/window/${WID}?tab=1`);
      menuOf('1');
      fireEvent.click(screen.getByTestId('menu-move-main'));
      expect(server().moves).toEqual([{ ids: ['1'], window: null }]);
      send({ type: 'sessions', tabs: [term('1'), term('2', WID)] }); // the server agrees
      connect();
      send({ type: 'sessions', tabs: [term('1'), term('2', WID)] });
      expect(server().moves).toEqual([{ ids: ['1'], window: null }]);
      expect(stripIds()).toEqual(['2']);
    });

    // The tab it was opened for is claimed ONCE: a later reconnect finds it in main's hands only
    // because the user sent it there (or never, if the first claim was refused).
    it('claims the tab it was opened for on the first connect only', () => {
      bootOnline([term('0'), term('1', OTHER)], `/window/${WID}?tab=1`);
      expect(server().moves).toEqual([]);
      connect();
      send({ type: 'sessions', tabs: [term('0'), term('1')] }); // released since
      expect(server().moves).toEqual([]);
    });

    // A reclaim moves a tab INTO this window, where its editor already is: nothing unmounts, so
    // there is nothing to confirm, and the unsaved flag that Reload and Close read must stay.
    it('a reclaim of a dirty editor never asks, and keeps what it holds unsaved', () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      bootOnline([term('1', WID), term('5', WID, { kind: 'editor', url: '/home/u/notes.md' })]);
      act(() => paneHost.onDirtyChange?.('5', true));
      connect();
      send({
        type: 'sessions',
        tabs: [term('1'), term('5', undefined, { kind: 'editor', url: '/home/u/notes.md' })],
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(server().moves).toEqual([{ ids: ['1', '5'], window: WID }]);
      expect(stripIds()).toEqual(['1', '5']);
      expect(stripSpy.renders.at(-1)!['dirty']).toEqual({ '5': true });
    });

    it('does nothing in a main window', () => {
      bootMain([term('0'), term('1')]);
      connect();
      send({ type: 'sessions', tabs: [term('0'), term('1')] });
      expect(server().moves).toEqual([]);
    });

    describe('from a retired pop-out address', () => {
      it('becomes a detached window that claims the tab itself, and takes its address', () => {
        bootOnline([term('2'), term('3')], '/popout/3');
        const wid = /^\/window\/(w[0-9a-z]{10})$/.exec(location.pathname)?.[1];
        expect(wid).toBeTruthy();
        expect(server().url).toMatch(new RegExp(`/ws\\?control=1&window=${wid}$`));
        expect(server().moves).toEqual([{ ids: ['3'], window: wid }]);
        expect(stripIds()).toEqual(['3']);
        expect(active()).toBe('3');
        expect(screen.getByTestId('term-pane-p0')).toHaveAttribute('data-window', wid);
        expect(location.search).toBe('');
      });

      it('knows the other retired form, /<id>?popout=1, the same way', () => {
        bootOnline([term('2'), term('3')], '/3?popout=1');
        expect(location.pathname).toMatch(/^\/window\/w[0-9a-z]{10}$/);
        expect(server().moves).toMatchObject([{ ids: ['3'] }]);
        expect(active()).toBe('3');
      });

      // The tab may be another window's by now: the legacy address claims what is free, nothing else.
      it('claims nothing another window holds, and shows an empty window the New-tab page', () => {
        bootOnline([term('2'), term('3', OTHER)], '/popout/3');
        expect(server().moves).toEqual([]);
        expect(panes()).toEqual([]);
        expect(screen.getByTestId('newtab-page')).toBeTruthy();
      });
    });

    describe('on a server without detached windows', () => {
      it('says so, shows the New-tab page, claims nothing and never closes itself', () => {
        const close = vi.spyOn(window, 'close').mockImplementation(() => {});
        history.replaceState(null, '', `/window/${WID}?tab=1`);
        render(<App />);
        connect();
        supported(false);
        send({ type: 'sessions', tabs: [term('0'), term('1')] });
        expect(screen.getByText('This server does not support detached windows')).toBeTruthy();
        expect(screen.getByTestId('newtab-page')).toBeTruthy();
        expect(server().moves).toEqual([]);
        expect(panes()).toEqual([]);
        expect(close).not.toHaveBeenCalled();
        expect(server().closings).toBe(0);
      });

      it('says nothing on a server that supports them', () => {
        bootOnline([term('0'), term('1')], `/window/${WID}?tab=1`);
        supported();
        expect(screen.queryByText('This server does not support detached windows')).toBeNull();
      });

      // An open against a server that cannot hold the tab is not the first open that counts: the
      // window claims the tab it was opened for on the first connect to a server that can.
      it('claims the tab it was opened for once a reconnect finds a server that has them', () => {
        history.replaceState(null, '', `/window/${WID}?tab=1`);
        render(<App />);
        connect();
        supported(false);
        send({ type: 'sessions', tabs: [term('0'), term('1')] });
        expect(server().moves).toEqual([]);
        // The server is upgraded and the window reconnects.
        connect();
        supported();
        send({ type: 'sessions', tabs: [term('0'), term('1')] });
        expect(server().moves).toEqual([{ ids: ['1'], window: WID }]);
        // It opens on that tab, as a first connect to such a server would, and leaves the page.
        send({ type: 'sessions', tabs: [term('0'), term('1', WID)] });
        expect(stripIds()).toEqual(['1']);
        expect(active()).toBe('1');
        expect(screen.queryByTestId('newtab-page')).toBeNull();
      });
    });

    // A reconnect never moves the selection: the tab a claim brings back joins the strip.
    it('keeps the tab it shows when a reconnect takes back another', () => {
      bootOnline([term('1', WID), term('3', WID)]);
      clickTab('1');
      expect(active()).toBe('1');
      connect();
      send({ type: 'sessions', tabs: [term('1', WID), term('3')] });
      expect(server().moves).toEqual([{ ids: ['3'], window: WID }]);
      send({ type: 'sessions', tabs: [term('1', WID), term('3', WID)] });
      expect(stripIds()).toEqual(['1', '3']);
      expect(active()).toBe('1');
    });

    // Nor does it take a window off the New-tab page it is on: a tab its strip held there comes
    // back to the strip, still not selected.
    it('stays on the New-tab page when a later reconnect takes back a tab its strip held', () => {
      bootOnline([term('0'), term('1', OTHER)]);
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
      send({ type: 'sessions', tabs: [term('0'), term('1', OTHER), term('2', WID)] });
      expect(stripIds()).toEqual(['2']);
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
      // The server restarts and forgets every owner.
      connect();
      send({ type: 'sessions', tabs: [term('0'), term('1'), term('2')] });
      expect(server().moves).toEqual([{ ids: ['2'], window: WID }]);
      send({ type: 'sessions', tabs: [term('0'), term('1'), term('2', WID)] });
      expect(stripIds()).toEqual(['2']);
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
      expect(panes()).toEqual([]);
    });
  });

  describe('closing itself', () => {
    let close: MockInstance<typeof window.close>;
    beforeEach(() => {
      close = vi.spyOn(window, 'close').mockImplementation(() => {});
    });
    const bootOnline = (tabs: Array<Record<string, unknown>>, path = `/window/${WID}`) => {
      history.replaceState(null, '', path);
      render(<App />);
      connect();
      send({ type: 'sessions', tabs });
      supported();
    };

    it('announces and closes when its last tab leaves', () => {
      bootOnline([term('0'), term('1', WID)], `/window/${WID}?tab=1`);
      const order: string[] = [];
      const ws = server() as unknown as { sendWindowClosing: () => boolean };
      vi.spyOn(ws, 'sendWindowClosing').mockImplementation(() => !!order.push('closing'));
      close.mockImplementation(() => void order.push('close'));
      // The tab went to the main window (from here, or by a drag into it).
      send({ type: 'sessions', tabs: [term('0'), term('1')] });
      expect(order).toEqual(['closing', 'close']);
    });

    it('closes when the user moves the last tab out', () => {
      bootOnline([term('0'), term('1', WID)], `/window/${WID}?tab=1`);
      menuOf('1');
      fireEvent.click(screen.getByTestId('menu-move-main'));
      expect(server().closings).toBe(1);
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('does not close while a tab is left', () => {
      bootOnline([term('0'), term('1', WID), term('2', WID)], `/window/${WID}?tab=1`);
      send({ type: 'sessions', tabs: [term('0'), term('1'), term('2', WID)] });
      expect(close).not.toHaveBeenCalled();
      expect(server().closings).toBe(0);
    });

    // A window opened by hand with nothing to show is a window the user can still use.
    it('does not close a window that never held a tab', () => {
      bootOnline([term('0')]);
      expect(close).not.toHaveBeenCalled();
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
    });

    it('does not close on a server that has not said it supports detached windows', () => {
      history.replaceState(null, '', `/window/${WID}?tab=1`);
      render(<App />);
      connect();
      send({ type: 'sessions', tabs: [term('0'), term('1', WID)] });
      send({ type: 'sessions', tabs: [term('0'), term('1')] });
      expect(close).not.toHaveBeenCalled();
      expect(server().closings).toBe(0);
    });

    it('does not close while it reclaims, and closes when the reclaim clears', () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      bootOnline([term('1', WID)]);
      connect();
      send({ type: 'sessions', tabs: [term('1')] }); // a restart: the claim goes out
      expect(server().moves).toEqual([{ ids: ['1'], window: WID }]);
      // The server never answers: the hold on the tab runs out, and the window shows nothing, yet
      // the claim is still in flight.
      act(() => void vi.advanceTimersByTime(2000));
      expect(stripIds()).toEqual([]);
      expect(close).not.toHaveBeenCalled();
      // The next broadcast ends the claim whether or not it was granted: nothing is left.
      send({ type: 'sessions', tabs: [term('1')] });
      expect(close).toHaveBeenCalledTimes(1);
      expect(server().closings).toBe(1);
    });

    // A terminal this window just created is in no list until its pane attaches.
    it('does not close while a terminal it just created is pending', () => {
      bootOnline([term('0'), term('1', WID)], `/window/${WID}?tab=1`);
      fireEvent.pointerDown(stripOf('p0').getByTestId('session-new'), { button: 0 });
      tapPress(screen.getByTestId('dash-new-terminal'));
      expect(shownIn('p0')).toBe('2');
      menuOf('1');
      fireEvent.click(screen.getByTestId('menu-move-main'));
      expect(stripIds()).toEqual(['2']);
      expect(close).not.toHaveBeenCalled();
      send({ type: 'sessions', tabs: [term('0'), term('1'), term('2', WID)] });
      expect(stripIds()).toEqual(['2']);
      expect(close).not.toHaveBeenCalled();
    });

    // The address was opened by hand, so the browser refuses `window.close()`: the window stays.
    it('shows the New-tab page when the browser refuses to close it', async () => {
      bootOnline([term('0'), term('1', WID)], `/window/${WID}?tab=1`);
      send({ type: 'sessions', tabs: [term('0'), term('1')] });
      expect(close).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.getByTestId('newtab-page')).toBeTruthy());
      expect(panes()).toEqual([]);
    });

    // Each broadcast hands an empty window a new empty list: asking again every time would send a
    // `windowClosing` per title change for as long as the window stays open.
    it('asks the browser once, not on every broadcast that follows a refusal', () => {
      bootOnline([term('0'), term('1', WID)], `/window/${WID}?tab=1`);
      send({ type: 'sessions', tabs: [term('0'), term('1')] });
      send({ type: 'sessions', tabs: [term('0', undefined, { title: 'a' }), term('1')] });
      send({ type: 'sessions', tabs: [term('0', undefined, { title: 'b' }), term('1')] });
      expect(close).toHaveBeenCalledTimes(1);
      expect(server().closings).toBe(1);
      // A tab dragged in and out again is a new last tab.
      send({ type: 'sessions', tabs: [term('0'), term('1', WID)] });
      send({ type: 'sessions', tabs: [term('0'), term('1')] });
      expect(close).toHaveBeenCalledTimes(2);
    });

    it('never closes a main window', () => {
      bootMain([term('0')]);
      supported();
      send({ type: 'sessions', tabs: [] });
      expect(close).not.toHaveBeenCalled();
      expect(server().closings).toBe(0);
      expect(screen.getByTestId('newtab-page')).toBeTruthy();
    });

    describe('when the page is hidden', () => {
      it('tells the server a detached window is going, so its tabs return in seconds', () => {
        bootOnline([term('1', WID)], `/window/${WID}?tab=1`);
        fireEvent(window, new Event('pagehide'));
        expect(server().closings).toBe(1);
        expect(close).not.toHaveBeenCalled();
      });

      it('says nothing from a main window', () => {
        bootMain([term('0')]);
        fireEvent(window, new Event('pagehide'));
        expect(server().closings).toBe(0);
      });
    });
  });

  // ── Chrome, shortcuts and the + dialog ──────────────────────────────────────────
  describe('chrome', () => {
    it('draws the editor-groups window without the dock, the titlebar or any bar', () => {
      localStorage.setItem('palmux-settings', JSON.stringify({ mobileMode: 'on' }));
      bootDetached([
        term('1', WID),
        term('4', WID, { kind: 'review', url: 'changes:/home/u/app' }),
      ]);
      clickTab('4');
      const app = document.querySelector('.app')!;
      expect(app).toHaveClass('detached');
      expect(app).not.toHaveClass('popout');
      expect(app).not.toHaveClass('mobile');
      expect(screen.queryByTestId('dock')).toBeNull();
      expect(screen.queryByTestId('dock-rail')).toBeNull();
      expect(screen.queryByTestId('app-menu-button')).toBeNull();
      expect(document.querySelector('.wco-titlebar')).toBeNull();
      expect(screen.queryByTestId('drawer')).toBeNull();
      expect(screen.queryByTestId('tab-sheet')).toBeNull();
      expect(screen.queryByTestId('review-bar')).toBeNull();
      expect(document.getElementById('extra-keys-bar')).toBeNull();
      // The pop-out's own bar and its return button are gone for good.
      expect(document.querySelector('.popout-bar')).toBeNull();
      expect(screen.queryByTestId('popout-return')).toBeNull();
      // Strips, as in the main window.
      expect(strips().map((x) => x.tabs)).toEqual([['1', '4']]);
    });

    it('leaves the main window as it was', () => {
      bootMain([term('0')]);
      expect(document.querySelector('.app')).not.toHaveClass('detached');
      expect(document.querySelector('.wco-titlebar')).not.toBeNull();
      expect(screen.getByTestId('dock-rail')).toBeTruthy();
    });

    it('splits inside the window, as the main window does', () => {
      bootDetached([term('1', WID), term('3', WID)]);
      splitVia('3');
      expect(strips().map((x) => x.tabs)).toEqual([['1'], ['3']]);
    });
  });

  describe('the + in a detached window', () => {
    const plus = () => fireEvent.pointerDown(stripOf('p0').getByTestId('session-new'), { button: 0 });

    it('opens the New-tab chooser in a dialog, because the window has no dock', () => {
      bootDetached([term('1', WID)]);
      expect(screen.queryByTestId('newtab-dialog')).toBeNull();
      plus();
      const dialog = screen.getByTestId('newtab-dialog');
      expect(within(dialog).getByTestId('dash-new-terminal')).toBeTruthy();
      expect(screen.queryByTestId('dock')).toBeNull();
      expect(localStorage.getItem('palmux-dock-view')).toBeNull();
    });

    it('creates a terminal in this window: the dialog closes and the pane attaches with its id', () => {
      bootDetached([term('0'), term('1', WID)]);
      plus();
      expect(screen.getByTestId('newtab-dialog')).toBeTruthy();
      tapPress(screen.getByTestId('dash-new-terminal'));
      expect(screen.queryByTestId('newtab-dialog')).toBeNull();
      expect(shownIn('p0')).toBe('2'); // 0 is main's, 1 is ours: the next free id
      expect(screen.getByTestId('term-pane-p0')).toHaveAttribute('data-session', '2');
      expect(screen.getByTestId('term-pane-p0')).toHaveAttribute('data-window', WID);
    });

    it('creates the other kinds in this window too, and closes the dialog', () => {
      bootDetached([term('1', WID)]);
      plus();
      expect(screen.getByTestId('newtab-dialog')).toBeTruthy();
      tapPress(screen.getByTestId('dash-new-editor'));
      expect(screen.queryByTestId('newtab-dialog')).toBeNull();
      expect(server().created).toEqual([{ kind: 'editor', window: WID }]);
    });

    it('closes on Cancel and on Escape, creating nothing', () => {
      bootDetached([term('1', WID)]);
      plus();
      fireEvent.click(screen.getByTestId('newtab-dialog-cancel'));
      expect(screen.queryByTestId('newtab-dialog')).toBeNull();
      plus();
      expect(screen.getByTestId('newtab-dialog')).toBeTruthy();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByTestId('newtab-dialog')).toBeNull();
      expect(server().created).toEqual([]);
      expect(strips().map((x) => x.tabs)).toEqual([['1']]);
    });

    // Closing is the one thing the dialog asks for, so it has one control for it, not a Cancel and
    // a Close side by side.
    it('has one action, Close, and it closes the dialog', () => {
      bootDetached([term('1', WID)]);
      plus();
      const dialog = screen.getByTestId('newtab-dialog');
      expect(within(dialog).queryByTestId('newtab-dialog-confirm')).toBeNull();
      const close = within(dialog).getByTestId('newtab-dialog-cancel');
      expect(close).toHaveTextContent('Close');
      fireEvent.click(close);
      expect(screen.queryByTestId('newtab-dialog')).toBeNull();
      expect(server().created).toEqual([]);
    });

    it('is what the New-tab chord opens, too', () => {
      bootDetached([term('1', WID)]);
      fireEvent.keyDown(window, { key: 't', ctrlKey: true, shiftKey: true });
      expect(screen.getByTestId('newtab-dialog')).toBeTruthy();
      expect(localStorage.getItem('palmux-dock-view')).toBeNull();
    });

    it('is still the dock’s view in the main window, where there is a dock', () => {
      bootMain([term('0')]);
      fireEvent.pointerDown(stripOf('p0').getByTestId('session-new'), { button: 0 });
      expect(screen.queryByTestId('newtab-dialog')).toBeNull();
      expect(screen.getByTestId('dock')).toHaveAttribute('data-view', 'newtab');
    });
  });

  describe('dock shortcuts in a detached window', () => {
    const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    it('do nothing: the Settings chord opens nothing and writes no dock view', () => {
      bootDetached([term('1', WID)]);
      fireEvent.keyDown(window, { key: ',', ctrlKey: true });
      expect(screen.queryByTestId('dock')).toBeNull();
      expect(screen.queryByTestId('newtab-dialog')).toBeNull();
      expect(localStorage.getItem('palmux-dock-view')).toBeNull();
    });

    it('do nothing: the Source Control chord opens nothing either', () => {
      bootDetached([term('1', WID)]);
      fireEvent.keyDown(window, { key: 'g', ctrlKey: true, altKey: true });
      expect(screen.queryByTestId('dock')).toBeNull();
      expect(localStorage.getItem('palmux-dock-view')).toBeNull();
    });

    it('are not offered by the command palette, and the rest still is', async () => {
      bootDetached([term('1', WID)]);
      fireEvent.keyDown(window, { key: 'p', ctrlKey: true, shiftKey: true });
      await flush();
      expect(screen.getByTestId('palette-item-newTab')).toBeTruthy();
      expect(screen.getByTestId('palette-item-tips')).toBeTruthy();
      expect(screen.queryByTestId('palette-item-settings')).toBeNull();
      expect(screen.queryByTestId('palette-item-openSourceControl')).toBeNull();
    });

    it('are offered by the main window’s palette', async () => {
      bootMain([term('0')]);
      fireEvent.keyDown(window, { key: 'p', ctrlKey: true, shiftKey: true });
      await flush();
      expect(screen.getByTestId('palette-item-settings')).toBeTruthy();
      expect(screen.getByTestId('palette-item-openSourceControl')).toBeTruthy();
    });

    it('leave the main window’s dock view alone', () => {
      localStorage.setItem('palmux-dock-view', 'files');
      bootDetached([term('1', WID)]);
      fireEvent.keyDown(window, { key: ',', ctrlKey: true });
      expect(localStorage.getItem('palmux-dock-view')).toBe('files');
    });
  });

  describe('the dictation history in a detached window', () => {
    beforeEach(() => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve({ ok: false, status: 503 })),
      );
    });
    afterEach(() => vi.unstubAllGlobals());

    // The toast's way back to a kept recording leads to the history panel: there is no dock view.
    it('is the panel a failed transcription’s toast opens', async () => {
      bootDetached([term('1', WID)]);
      act(() => dictationSpy.params!.onError('Transcription failed — recording kept', true));
      fireEvent.click(screen.getByTestId('toast-action'));
      expect(screen.getByRole('dialog', { name: 'Dictation history' })).toBeTruthy();
      expect(screen.queryByTestId('dock')).toBeNull();
      expect(localStorage.getItem('palmux-dock-view')).toBeNull();
      await act(async () => {}); // the history's fetch settles
    });
  });
});
