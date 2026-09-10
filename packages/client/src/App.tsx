import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { JsonObject, TabMeta, WebAppLink } from '@palmux/shared';
import { DEFAULT_MAX_UPLOAD_BYTES, normalizeOrder } from '@palmux/shared';
import { WsClient } from './lib/ws';
import { Toast, type ToastAction, type ToastHandle } from './Toast';
import { useSettings } from './settings/useSettings';
import { DEFAULTS, resolveMobileMode } from './settings/settings';
import { useKeybindings } from './keybindings/useKeybindings';
import {
  ACTION_LABELS,
  ACTIONS,
  type Action,
  formatChord,
  loadBindings,
} from './keybindings/keybindings';
import { CommandPalette } from './command-palette/CommandPalette';
import { SettingsFields } from './settings/SettingsFields';
import { ConfigEditor, type ConfigEditorMode } from './settings/ConfigEditor';
import { FileTree } from './panes/FileTree';
import { DictationView } from './dictation/DictationView';
import { RecordingToast } from './dictation/RecordingToast';
import { KeybindingsPanel } from './settings/KeybindingsPanel';
import { SettingsEditor } from './settings/SettingsEditor';
import { buildDiagnosticsReport } from './diagnostics/diagnostics-report';
import { copyText } from './mobile/clipboard';
import { hasNativeSelection } from './mobile/native-selection';
import { TipsPanel } from './tips/TipsPanel';
import { registerFonts } from './settings/fonts';
import {
  allProfiles,
  applyThemeTokens,
  getProfile,
  registerDynamicThemes,
} from './settings/themes';
import { useExtraKeys } from './mobile/useExtraKeys';
import { ExtraKeysBar, type ExtraKeysBarHandle } from './mobile/ExtraKeysBar';
import { useSoftKeyboard } from './mobile/useSoftKeyboard';
import { NO_MODS } from './mobile/key-encoder';
import { SessionTabs, type TabGrouping } from './session/SessionTabs';
import { pruneRecord, reorderIds } from './session/tab-meta';
import { decideGroupDrop, groupIdMap } from './session/tab-groups';
import { useTabGroups } from './session/useTabGroups';
import { SessionDrawer, type DrawerActions, type DrawerView } from './session/SessionDrawer';
import {
  DockPanel,
  DOCK_SETTLE_MS,
  readDockView,
  writeDockView,
  type DockView,
} from './session/DockPanel';
import { TabSheet } from './session/TabSheet';
import {
  nextFreeId,
  wsControlUrl,
  readBootIntent,
  openPopout,
  postReturnToMain,
  POPOUT_RETURN,
} from './session/session-url';
import {
  readSelection,
  resolveSelection,
  selectionFor,
  writeSelection,
} from './session/window-selection';
import { createSplitRegistry } from './session/SplitFocusContext';
import { useDictation } from './dictation/useDictation';
import { DictationHistory } from './dictation/DictationHistory';
import {
  useSplit,
  reconcilePairings,
  pairingOf,
  memberSlot,
  type Orientation,
  type SlotId,
  type SplitState,
} from './session/useSplit';
import { decide, type WorkspaceEffect, type WorkspaceEvent } from './session/workspaceController';
import { SplitView } from './session/SplitView';
import { type MobileGestures } from './terminal/TerminalPane';
import { downloadFromServer } from './terminal/download';
import { NewTabChooser } from './panes/NewTabChooser';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { closeManyMessage } from './session/close-many';
import { DashboardBody, type CreateSpec } from './panes/DashboardBody';

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** The drawer views App supplies a body for (the dock's Explorer and Dictation). */
const DRAWER_HOSTED_VIEWS: readonly DrawerView[] = ['files', 'dictation'];

/**
 * How much the visual viewport must GROW for the soft keyboard to count as
 * gone. Same threshold as `ExtraKeysBar`'s `keyboardVanished` — the two are the
 * only places that have to tell "the IME left" from "the page reflowed a bit",
 * and they should not disagree.
 */
const KEYBOARD_GONE_PX = 100;

/**
 * Whether the end of a native text selection should put the soft keyboard back.
 *
 * Both gates carry weight. `deferred` says a selection is what held the layout
 * still, so an ordinary keyboard dismissal never triggers a re-raise and fights
 * the user. The growth test says the keyboard was actually UP when the
 * selection began — someone selecting text while merely READING must not be
 * handed a keyboard they never asked for, and focus alone cannot tell the two
 * apart because a selection blurs the textarea either way.
 */
export function shouldRestoreKeyboard(
  deferred: boolean,
  height: number,
  pinnedHeight: number,
): boolean {
  return deferred && height > pinnedHeight + KEYBOARD_GONE_PX;
}

// No 'settings' member: settings have TWO hosts now, the dock on desktop and
// the drawer on mobile, and neither is a modal. The third one was the modal.
type Panel =
  | 'none'
  | 'tips'
  | 'keybindings'
  | 'commandPalette'
  | 'settingsJson'
  | 'dictationHistory';

/**
 * The strip's VISIBLE entries in display order, each a 1- or 2-id array: a tab,
 * or a fused pairing (its two members, in strip order) collapsed to ONE entry.
 * Mirrors buildStrip's fusion so a reorder insertion index (entry space) maps
 * back to a full-order anchor. Collapsed-group members are excluded.
 */
function visibleEntries(
  tabs: TabMeta[],
  collapsed: ReadonlySet<string>,
  pairings: SplitState[],
): string[][] {
  const pairByTab = new Map<string, { a: string; b: string }>();
  for (const p of pairings) {
    pairByTab.set(p.a.tabId, { a: p.a.tabId, b: p.b.tabId });
    pairByTab.set(p.b.tabId, { a: p.a.tabId, b: p.b.tabId });
  }
  const visibleIds = tabs.filter((t) => !(t.groupId && collapsed.has(t.groupId))).map((t) => t.id);
  const entries: string[][] = [];
  let i = 0;
  while (i < visibleIds.length) {
    const x = visibleIds[i]!;
    const y = visibleIds[i + 1];
    const p = pairByTab.get(x);
    if (y !== undefined && p && ((p.a === x && p.b === y) || (p.a === y && p.b === x))) {
      entries.push([x, y]);
      i += 2;
    } else {
      entries.push([x]);
      i += 1;
    }
  }
  return entries;
}

export function App() {
  // The control socket carries the app's tab-list / settings / fonts / control
  // channel — independent of any terminal. TerminalPanes own their own data
  // sockets. The focus registry routes the shared mobile/desktop input surfaces
  // to the focused terminal pane.
  const wsControlRef = useRef<WsClient | null>(null);
  const registry = useMemo(() => createSplitRegistry(), []);
  // What this window was OPENED as. Read ONCE — after boot the address is `/`
  // and this window's own state is the answer. See session-url's readBootIntent.
  const boot = useRef(readBootIntent()).current;
  // A popped-out window shows a single tab with no strip/drawer/split.
  const popout = boot.kind === 'popout';
  const [openerGone, setOpenerGone] = useState(() => !window.opener || window.opener.closed);

  /**
   * The tab this window is showing. EMPTY means "not resolved yet".
   *
   * An id from the ADDRESS (a pop-out, or a legacy `/<id>`) is trusted
   * immediately — that is the pre-existing contract, where attaching to an
   * unknown id spawns a terminal there. A REMEMBERED id is not: the tab may have
   * been closed since, and mounting a pane on it would attach to `/ws?session=`
   * that id and spawn a ghost terminal before the first broadcast could say
   * otherwise. So a remembered selection waits for the tab list, which costs one
   * round trip and cannot invent a session.
   */
  const [sessionId, setSessionId] = useState(() =>
    boot.kind === 'popout' || boot.kind === 'legacy' ? boot.id : '',
  );
  /**
   * The window cannot decide what to show until the tab list arrives.
   *
   * True for a plain `/` boot, which has no instruction and must consult what it
   * remembered — and ALSO for `?new=1`, which does. A new terminal's id comes
   * from `nextFreeId` over the live tabs, and running that against an empty list
   * hands back an id that already exists: measured, `/new` "created" a terminal
   * and silently selected tab 0 instead.
   *
   * A popout or a legacy `/<id>` names its tab outright and waits for nothing.
   */
  const [awaitingResolve, setAwaitingResolve] = useState(
    () => boot.kind === 'app' || boot.kind === 'new',
  );
  const awaitingResolveRef = useRef(awaitingResolve);
  awaitingResolveRef.current = awaitingResolve;
  const [tabs, setTabs] = useState<TabMeta[]>([]);
  const [webApps, setWebApps] = useState<WebAppLink[]>([]);
  const [maxUploadBytes, setMaxUploadBytes] = useState(DEFAULT_MAX_UPLOAD_BYTES);
  // A self-update is running server-side. Held in state (not a toast) because the
  // socket is about to drop: the banner must survive the disconnect so the outage
  // reads as INTENTIONAL rather than "connection lost".
  const [updating, setUpdating] = useState<{ stage: string; version?: string } | null>(null);
  // ── Side dock ───────────────────────────────────────────────────────────
  // Which view is open (null = closed), remembered per device and read lazily so
  // a corrupt value can never take the app down at boot.
  const [dockView, setDockView] = useState<DockView | null>(() => readDockView());
  // True across a dock transition. TerminalPane buffers the PTY resize while a
  // resize is paused and flushes exactly ONE on release, so a toggle costs each
  // attached shell one SIGWINCH instead of one per animation frame.
  const [dockBusy, setDockBusy] = useState(false);
  const openDockView = useCallback((next: DockView | null) => {
    setDockBusy(true);
    setDockView(next);
    writeDockView(next);
  }, []);
  useEffect(() => {
    if (!dockBusy) return;
    const t = setTimeout(() => setDockBusy(false), DOCK_SETTLE_MS);
    return () => clearTimeout(t);
  }, [dockBusy, dockView]);

  // Settings' Raw/Form toggle, and the file the browser opened into the content
  // area. Both are view state, not app state — neither persists.
  const [cfgMode, setCfgMode] = useState<ConfigEditorMode>('form');
  // The mobile drawer hosts the SAME views as the desktop dock. Its own state,
  // not dockView: the dock never renders on mobile, and sharing one value would
  // make a phone's choice follow you to a desktop.
  const [drawerView, setDrawerView] = useState<DrawerView>('sessions');
  // Elapsed time for the recording toast. `deadline` counts DOWN to the auto-stop
  // and the toast counts UP, so the start is derived once per recording rather
  // than re-derived per frame.
  const [recStart, setRecStart] = useState(0);
  const [recNow, setRecNow] = useState(0);

  const [newTabOpen, setNewTabOpen] = useState(false);
  // Where the [+] popover anchors (viewport coords, captured at open).
  // The last tab was closed: the New-tab page IS the content (no dead pane, no
  // auto-respawn). Cleared by any navigation or creation.
  const [chooserPage, setChooserPage] = useState(false);
  const chooserPageRef = useRef(chooserPage);
  chooserPageRef.current = chooserPage;
  const [dirtyTabs, setDirtyTabs] = useState<{ [id: string]: boolean }>({});
  const [sheetTabId, setSheetTabId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [fontFamilies, setFontFamilies] = useState<string[]>([]);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  // Terminal tabs chosen "open in tmux <name>": id → session name, or null for a
  // new unnamed one. Read-and-cleared by the pane that mounts on that id, so a
  // recycled id can never inherit a previous tab's target.
  const pendingTmuxRef = useRef(new Map<string, string | null>());
  const takeSpawnTmux = useCallback((id: string): string | null | undefined => {
    const map = pendingTmuxRef.current;
    if (!map.has(id)) return undefined;
    const target = map.get(id);
    map.delete(id);
    return target;
  }, []);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const dirtyRef = useRef(dirtyTabs);
  dirtyRef.current = dirtyTabs;
  const newTabOpenRef = useRef(newTabOpen);
  newTabOpenRef.current = newTabOpen;

  // The active tab drives what the content area shows. A freshly navigated id
  // that hasn't been broadcast yet is a terminal (spawn-on-attach semantics).
  const activeTab: TabMeta = tabs.find((t) => t.id === sessionId) ?? {
    id: sessionId,
    kind: 'terminal',
  };
  const activeKind = activeTab.kind;
  const activeKindRef = useRef(activeKind);
  activeKindRef.current = activeKind;

  const sendSettings = useCallback((j: JsonObject) => wsControlRef.current?.sendSettings(j), []);
  const sendExtra = useCallback((j: JsonObject) => wsControlRef.current?.sendExtraKeys(j), []);
  const {
    settings,
    update: updateSettings,
    applyServer: applySettings,
  } = useSettings(sendSettings);
  const { config: extraKeys, applyServer: applyExtraKeys } = useExtraKeys(sendExtra);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const mobileActive = resolveMobileMode(settings.mobileMode);
  const mobileActiveRef = useRef(mobileActive);
  mobileActiveRef.current = mobileActive;

  // Re-skin the whole app when the theme changes (boot is handled pre-paint in
  // main.tsx). useLayoutEffect so tokens land before the browser paints the new
  // frame — themes a panes-only workspace too, independent of any terminal.
  useLayoutEffect(() => {
    applyThemeTokens(getProfile(settings.themeId));
  }, [settings.themeId]);

  // Split is a desktop-only feature: the hook forces zero pairings
  // while the mobile layer is active. Any number of pairings coexist; a tab is
  // in at most one. The ACTIVE pairing is the one holding the current tab — it
  // is on screen (tiled); every other pairing stays fused in the strip but off
  // screen until one of its members is selected.
  const {
    pairings,
    openSplit,
    dissolve,
    setRatio,
    toggleOrientation,
    focusSlot,
    swapSlots,
    setSlotTab,
    setPairings,
  } = useSplit(!mobileActive && !popout);
  const pairingsRef = useRef(pairings);
  pairingsRef.current = pairings;
  const activePairing = pairingOf(pairings, sessionId);
  const activeKey = activePairing?.a.tabId;
  // Stable pairing summary for the strip — a fresh object each render would
  // defeat `SessionTabs`'s memo, re-rendering the strip on every App update.
  const stripPairings = useMemo(
    () => pairings.map((p) => ({ a: p.a.tabId, b: p.b.tabId, focusedId: p[p.focused].tabId })),
    [pairings],
  );
  // Terminal ids ever seen in a broadcast — lets reconcile tell a killed
  // split-slot terminal (was seen, now gone) from a fresh one (never seen yet).
  const seenTermIdsRef = useRef<Set<string>>(new Set());
  // Pairings created with a not-yet-broadcast member (self-split spawns a fresh
  // terminal): key → the fresh tab id, cleared once adjacency is established.
  const pendingFreshRef = useRef<Map<string, string>>(new Map());
  const contentRef = useRef<HTMLDivElement>(null);

  // Normalise the address to `/` and spend the boot intent — ONCE.
  //
  // `replaceState`, never `pushState`: normalising must not leave a history
  // entry, or ← would take the user back to an address that no longer means
  // anything. A pop-out keeps its address, which is the whole point of it having
  // one. The `new` intent creates exactly one terminal and is cleared with the
  // query, so a reload cannot create a second.
  const bootSpent = useRef(false);
  // `createTab` is defined further down; a ref lets the first-broadcast handler
  // reach it without hoisting the whole callback above the state it closes over.
  const createTabRef = useRef<((spec: CreateSpec) => void) | null>(null);
  useEffect(() => {
    if (bootSpent.current || popout) return;
    bootSpent.current = true;
    if (location.pathname !== '/' || location.search) {
      history.replaceState(null, '', '/');
    }
  }, [popout]);

  // Remember what this window is showing, from ONE place.
  //
  // Every navigation path ends at `setSessionId` — selectTab, the controller's
  // navigate effect, the split reconcile, the close-nav, the first-broadcast
  // resolve — so hooking any single one of them would miss the rest. That is the
  // same reason the group auto-expand is one centralized effect and not a line
  // inside selectTab.
  //
  // A popped-out window writes nothing: it is a single-tab window whose address
  // already says what it is, and it shares an origin with the main window, so
  // storing would let it overwrite the main window's selection on reload.
  useEffect(() => {
    if (popout || !sessionId) return;
    writeSelection(selectionFor(tabs, sessionId));
  }, [popout, sessionId, tabs]);

  // Deep link into a pairing: the address's member takes focus over the persisted
  // slot (the focused-slot URL rule, applied once at boot — popstate and
  // segment clicks route through selectTab and need no help).
  const bootFocusDone = useRef(false);
  useEffect(() => {
    if (bootFocusDone.current) return;
    bootFocusDone.current = true;
    const p = pairingOf(pairingsRef.current, sessionIdRef.current);
    const slot = p ? memberSlot(p, sessionIdRef.current) : null;
    if (p && slot && p.focused !== slot) focusSlot(p.a.tabId, slot);
  }, [focusSlot]);

  // Keep the registry's focused slot in sync with the on-screen state: with no
  // active pairing the single full-width pane registers as slot 'a', so pointing
  // at an off-screen pairing's focused slot would strand the shared input
  // surfaces (soft keyboard / extra keys / paste) on an unmounted pane.
  useEffect(() => {
    registry.setFocusedSlot(activePairing?.focused ?? 'a');
  }, [activePairing, registry]);

  // Toast owns its own state (imperative handle) so firing one re-renders only
  // that leaf, never the whole App tree (copy-on-select fires it constantly).
  const toastRef = useRef<ToastHandle>(null);
  const showToast = useCallback(
    (msg: string, action?: ToastAction) => toastRef.current?.show(msg, action),
    [],
  );
  // Server build version last seen on `ready`; a change across a reconnect means
  // the server was redeployed and this client is now stale.
  const knownVersionRef = useRef<string>('');
  // Bumped when server-discovered themes arrive, to re-render the theme picker.
  const [, setThemesNonce] = useState(0);
  const [importingTheme, setImportingTheme] = useState(false);
  const onImportTheme = useCallback((source: string) => {
    if (wsControlRef.current?.sendImportTheme(source)) setImportingTheme(true);
  }, []);

  const copyDiagnostics = useCallback(() => {
    const term = registry.apiFor('a')?.term() ?? registry.apiFor('b')?.term();
    const id = settingsRef.current.themeId;
    const resolved = getProfile(id);
    const themeDiagnostics = () => ({
      id,
      resolvedId: resolved.id,
      resolvedName: resolved.name,
      registered: allProfiles()
        .map((p) => p.id)
        .filter((x) => x.includes(':') || x === 'kitty' || x === 'termux'),
      canvasBg: term?.options.theme?.background ?? null,
      uiBase: getComputedStyle(document.documentElement).getPropertyValue('--t-base').trim(),
    });
    const report = buildDiagnosticsReport({
      version: knownVersionRef.current,
      userAgent: navigator.userAgent,
      url: location.href,
      tabs: tabsRef.current.map((t) => ({ id: t.id, kind: t.kind })),
      swControlled: !!navigator.serviceWorker?.controller,
      theme: themeDiagnostics(),
    });
    void copyText(report)
      .then(() => showToast('Diagnostics copied'))
      .catch(() => showToast('Copy failed — see console'));
  }, [showToast, registry]);
  const onAutoCopy = useCallback(() => showToast('Copied'), [showToast]);
  const onUploadError = useCallback((msg: string) => showToast(msg), [showToast]);

  // Every "the words are still there" message needs a way to REACH them, and
  // the history lives in two different hosts: a dock view on desktop, a panel
  // on mobile. One action, resolved here, so no caller has to know which.
  const historyAction = useMemo<ToastAction>(
    () => ({
      label: 'Open history',
      onClick: () =>
        mobileActiveRef.current ? setPanel('dictationHistory') : openDockView('dictation'),
    }),
    [openDockView],
  );

  // Dictated text goes in through `paste`, never `sendInput`: paste is
  // bracketed-paste aware, so even if a line break survived the server's
  // sanitiser the shell would insert it rather than RUN the line.
  const dictation = useDictation({
    onText: (text) => {
      const api = registry.focusedApi();
      // Either failure leaves the text ONLY in the server-side history — say
      // so, or a 5-minute dictation silently evaporates.
      if (!api) showToast('No focused terminal — saved to dictation history', historyAction);
      else if (!api.paste(text)) {
        showToast('Terminal not connected — saved to dictation history', historyAction);
      }
    },
    // A failed transcription KEPT the clip, so the toast offers the way back to
    // it — the message alone was unusable at 1.4s (the action holds it for 6).
    onError: (msg, recoverable) => showToast(msg, recoverable ? historyAction : undefined),
    onAutoStop: () => showToast('Time limit reached — transcribing what was recorded'),
    maxBytes: maxUploadBytes,
  });

  // The dictation notification pins to the FOCUSED pane's corner — in split
  // mode it must identify which terminal the text will land in.
  // The recording indicator no longer anchors to the focused pane — it is
  // bottom-centre of the window — so the anchor callback went with the old pill.
  useEffect(() => {
    if (dictation.state !== 'recording') return;
    const start = Date.now();
    setRecStart(start);
    setRecNow(start);
    // 1s, not rAF: the toast shows whole seconds, and a per-frame setState beside
    // a WebGL terminal is exactly the cost the motion contract forbids.
    const t = setInterval(() => setRecNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [dictation.state]);

  const [panel, setPanel] = useState<Panel>('none');
  const panelRef = useRef(panel);
  panelRef.current = panel;

  // A pane's terminal input is blocked while a panel/chooser is up.
  const paneBlocked = useCallback(
    () => panelRef.current !== 'none' || newTabOpenRef.current || chooserPageRef.current,
    [],
  );
  // The mobile input surfaces are additionally blocked when no terminal is on
  // screen (the focused slot's kind isn't terminal).
  const kbdBlocked = useCallback(
    () =>
      panelRef.current !== 'none' ||
      newTabOpenRef.current ||
      chooserPageRef.current ||
      activeKindRef.current !== 'terminal',
    [],
  );

  // Shared input surfaces (soft keyboard, extra-keys bar) route to the focused
  // terminal pane. Reading the registry at call time keeps these stable.
  const sendInput = useCallback(
    (t: string) => registry.focusedApi()?.sendInput(t) ?? false,
    [registry],
  );
  const onPasteImage = useCallback(
    (file: File) => registry.focusedApi()?.pasteImage(file),
    [registry],
  );
  const pasteText = useCallback(
    (t: string) => registry.focusedApi()?.paste(t) ?? false,
    [registry],
  );

  // Soft keyboard + extra-keys sticky modifiers.
  const taRef = useRef<HTMLTextAreaElement>(null);
  const barRef = useRef<ExtraKeysBarHandle>(null);
  const getMods = useCallback(() => barRef.current?.takeMods() ?? { ...NO_MODS }, []);
  const kbd = useSoftKeyboard({
    taRef,
    active: mobileActive,
    sendInput,
    getMods,
    isBlocked: kbdBlocked,
    pasteText,
    onImage: onPasteImage,
  });
  // `useSoftKeyboard` returns a fresh object every render, so the visualViewport
  // effect cannot depend on it — doing so would tear down and re-add the vv
  // listeners (and drop `--app-height`) on every render. It reads `raise`
  // through this ref instead.
  const kbdRaiseRef = useRef(kbd.raise);
  kbdRaiseRef.current = kbd.raise;

  // Upload picker / clipboard-paste target the focused terminal pane; guard the
  // entry points so a non-terminal tab shows a toast instead of a silent drop.
  const guardedOpenPicker = useCallback(() => {
    const api = registry.focusedApi();
    if (!api) return showToast('Open a terminal tab to upload');
    api.openPicker();
  }, [registry, showToast]);
  const guardedOpenImagePicker = useCallback(() => {
    const api = registry.focusedApi();
    if (!api) return showToast('Open a terminal tab to upload');
    api.openImagePicker();
  }, [registry, showToast]);
  // Download a file (or glob → ZIP) OFF the server machine. The path prompt is
  // deliberately plain — paths are usually copied straight out of the terminal.
  const doDownload = useCallback(() => {
    const p = window.prompt(
      'Download from server — absolute path, glob, or directory\n(e.g. /home/user/notes/report.md or /home/user/notes/*.md)',
    );
    if (!p?.trim()) return;
    void downloadFromServer(p.trim()).then((error) => {
      if (error) showToast(error);
    });
  }, [showToast]);

  // Per-pane mobile gesture callbacks, bundled as one stable object shared by
  // every TerminalPane (font zoom, keyboard raise, drawer toggle).
  const terminalGestures = useMemo<MobileGestures>(
    () => ({
      getFontSize: () => settingsRef.current.fontSize,
      setFontSize: (px: number) => updateSettings({ fontSize: px }),
      focusKeyboard: () => kbd.focus(),
    }),
    [kbd, updateSettings],
  );

  // The mobile drawer's footer toolbar, bundled as one stable object. Settings
  // are NOT here: on mobile they are a view inside the drawer, not a modal.
  const drawerActions = useMemo<DrawerActions>(
    () => ({
      uploadFile: guardedOpenPicker,
      uploadImages: guardedOpenImagePicker,
      downloadFile: doDownload,
      dictate: dictation.toggle,
    }),
    [guardedOpenPicker, guardedOpenImagePicker, doDownload, dictation.toggle],
  );

  /**
   * Show `id` in this window.
   *
   * It used to `pushState('/<id>')`, which made a tab switch a browser
   * NAVIGATION — so a web pane's ← walked the same stack and could undo a tab
   * switch instead of moving the framed page, with nothing on screen to say
   * which. Nothing writes the address any more; the window remembers instead
   * (the persist effect below), and back belongs to web panes alone.
   */
  const switchSession = useCallback((id: string) => {
    if (id === sessionIdRef.current) return;
    setSessionId(id);
  }, []);

  // A fuse-sync effect: relocate `moveId` immediately after `keepId` and patch
  // its group membership to the target's — optimistically (byte-identical to the
  // server's next broadcast via the shared normalize) with ONE wire message. A
  // fresh terminal the server has never seen is skipped (no order to sync); its
  // membership follows once it is broadcast.
  const applyFuseSync = useCallback(
    (e: { keepId: string; moveId: string; moveGid: string | null; targetGid: string | null }) => {
      const src = tabsRef.current;
      if (!src.some((t) => t.id === e.moveId)) return;
      const ids = src.map((t) => t.id);
      const without = ids.filter((x) => x !== e.moveId);
      const ki = without.indexOf(e.keepId);
      const insertAt = ki === -1 ? without.length : ki + 1;
      const next = [...without.slice(0, insertAt), e.moveId, ...without.slice(insertAt)];
      const baseGof = groupIdMap(src);
      const postGof = (x: string): string | undefined =>
        x === e.moveId ? (e.targetGid ?? undefined) : baseGof(x);
      const patch = (t: TabMeta): TabMeta => {
        if (t.id !== e.moveId) return t;
        if (e.targetGid === null) {
          const copy = { ...t };
          delete copy.groupId;
          return copy;
        }
        return { ...t, groupId: e.targetGid };
      };
      const order = normalizeOrder(next, postGof);
      const byId = new Map(src.map((t) => [t.id, t]));
      setTabs(order.flatMap((i) => (byId.has(i) ? [patch(byId.get(i)!)] : [])));
      if (e.targetGid) {
        wsControlRef.current?.sendGroupUpdate({ id: e.targetGid, addIds: [e.moveId], order });
      } else if (e.moveGid) {
        wsControlRef.current?.sendGroupUpdate({ id: e.moveGid, removeIds: [e.moveId], order });
      } else {
        wsControlRef.current?.sendReorderTabs(order);
      }
    },
    [],
  );

  // Apply one declarative effect from the workspace controller.
  const applyEffect = useCallback(
    (e: WorkspaceEffect) => {
      switch (e.type) {
        case 'navigate':
          // One mode now. `push` / `replace` / `set` existed only to say what to
          // do with the URL, and nothing writes the URL.
          setSessionId(e.id);
          break;
        case 'chooserPage':
          setChooserPage(e.value);
          break;
        case 'openSplit': {
          // A member the server hasn't broadcast yet (self-split fresh terminal)
          // needs its adjacency established when it first appears — mark it.
          const fresh = [e.a, e.b].find((r) => !tabsRef.current.some((t) => t.id === r.tabId));
          if (fresh) pendingFreshRef.current.set(e.a.tabId, fresh.tabId);
          openSplit(e.a, e.b, e.orientation, e.focused);
          break;
        }
        case 'dissolveP':
          dissolve(e.key);
          break;
        case 'setSlot':
          setSlotTab(e.key, e.slot, e.ref);
          break;
        case 'focusSlotP':
          focusSlot(e.key, e.slot);
          break;
        case 'fuseSync':
          applyFuseSync(e);
          break;
        case 'unsee':
          seenTermIdsRef.current.delete(e.id);
          break;
      }
    },
    [openSplit, dissolve, setSlotTab, focusSlot, applyFuseSync],
  );

  // Translate a navigation gesture/socket event into effects (pure decision) and
  // apply them. The decision logic is unit-tested in workspaceController.test.ts.
  const dispatch = useCallback(
    (event: WorkspaceEvent) => {
      const effects = decide(event, {
        sessionId: sessionIdRef.current,
        pairings: pairingsRef.current,
        tabs: tabsRef.current,
        mobileActive: mobileActiveRef.current,
        activeKind: activeKindRef.current,
        seenTermIds: seenTermIdsRef.current,
        popout,
        groupOf: groupIdMap(tabsRef.current),
      });
      for (const e of effects) applyEffect(e);
    },
    [applyEffect, popout],
  );

  // Tab-group model + collapse view state (state, effects, and the group ops all
  // colocated). App keeps only the optimistic strip-reorder handlers below, which
  // read `tabGroups.collapsedRef`.
  const tabGroups = useTabGroups({
    tabs,
    sessionId,
    tabsRef,
    sessionIdRef,
    dirtyRef,
    wsRef: wsControlRef,
    switchSession,
    showToast,
  });
  const {
    groups,
    collapsed: collapsedGroups,
    collapsedRef,
    applyBroadcast: applyGroupBroadcast,
    toggleGroup,
    newGroup,
    addToGroup,
    removeFromGroup,
    groupRename,
    groupRecolor,
    groupDissolve,
    groupCloseAll,
  } = tabGroups;

  // Select a tab (Chrome-like split model): a split MEMBER re-tiles the split
  // focused on its slot; any other tab shows full-width with the pairing kept.
  // Selection NEVER replaces a slot — that is the explicit drop-onto-slot
  // gesture (doDropSlot). Every selection is an ordinary navigation.
  const selectTab = useCallback((id: string) => dispatch({ type: 'selectTab', id }), [dispatch]);

  const focusSlotHandler = useCallback(
    (slot: SlotId) => dispatch({ type: 'focusSlot', slot }),
    [dispatch],
  );

  // Open a split via the tab menu — the current tab in slot A, `otherId` in B
  // (splitting with the active/only tab spawns a fresh terminal). Blocked while
  // the current tab is already a member (a pairing on screen) or on mobile. The
  // controller fuses `otherId` next to the current tab (order + membership).
  const doSplit = useCallback(
    (otherId: string, orientation: Orientation) =>
      dispatch({ type: 'menuSplit', otherId, orientation }),
    [dispatch],
  );

  const doCollapse = useCallback((keep?: SlotId) => dispatch({ type: 'eject', keep }), [dispatch]);

  // Drag-to-split: a strip tab dragged to a content edge opens a split with that
  // tab in that position (left/top → slot A, right/bottom → slot B).
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const doDropSplit = useCallback(
    (id: string, side: 'left' | 'right' | 'top' | 'bottom') => {
      setDragTabId(null);
      dispatch({ type: 'dropSplit', id, side });
    },
    [dispatch],
  );

  // Chrome-like strip reorder: apply optimistically (no flash while the round
  // trip completes), send the full desired order; the server's next `sessions`
  // broadcast is authoritative (an old server just snaps the order back).
  // Ids/URLs never change — only display order. Split pairings are order-blind.
  // Group-aware: the resulting order decides plain reorder vs JOIN (interior /
  // center-drop) vs LEAVE (dragged fully out of its own group). Join/leave send
  // a `groupUpdate{addIds|removeIds, order}` (membership + position atomically —
  // a bare reorder would be bounced back to contiguity by normalizeOrder); a
  // plain move sends `reorderTabs`. Optimistic in all three so there's no flash.
  const doReorder = useCallback(
    (id: string, index: number, joinGid?: string) => {
      setDragTabId(null);
      const src = tabsRef.current;
      const ids = src.map((t) => t.id);
      // A not-yet-broadcast tab can't be reordered (the server doesn't know it
      // yet); it becomes draggable one broadcast later.
      if (!ids.includes(id)) return;
      // `index` is an insertion index into the VISIBLE ENTRY list (a fused pairing
      // is ONE entry, collapsed members hidden). The entry's strip-first id anchors
      // the drop; map it to a FULL-order position.
      const entries = visibleEntries(src, collapsedRef.current, pairingsRef.current);
      const beforeId = entries[index]?.[0];

      // A dragged pairing member moves the WHOLE block (slot order preserved) so
      // the two stay fused-adjacent; a plain tab moves alone.
      const p = pairingOf(pairingsRef.current, id);
      const block = p ? [p.a.tabId, p.b.tabId].filter((x) => ids.includes(x)) : [id];
      const isBlock = block.length > 1;
      if (isBlock && beforeId !== undefined && block.includes(beforeId)) return; // onto itself

      let next: string[];
      if (isBlock) {
        const set = new Set(block);
        const rest = ids.filter((x) => !set.has(x));
        const at = beforeId === undefined ? rest.length : Math.max(0, rest.indexOf(beforeId));
        next = [...rest.slice(0, at), ...block, ...rest.slice(at)];
      } else {
        const fullIndex = beforeId === undefined ? ids.length : ids.indexOf(beforeId);
        next = reorderIds(ids, id, fullIndex);
      }

      const baseGof = groupIdMap(src);
      // Group decision. A two-tab block collapses to its dragged representative so
      // decideGroupDrop sees the block's TRUE left/right neighbors (not the partner).
      const virtual = isBlock ? next.filter((x) => x === id || !block.includes(x)) : next;
      const decision = decideGroupDrop(virtual, baseGof, id, joinGid);

      // Run the SHARED contiguity model over the POST-mutation membership so the
      // optimistic order is byte-identical to what the server will broadcast (no
      // flash, no drift) — and send that already-normalized order.
      const set = new Set(block);
      let patch: (t: TabMeta) => TabMeta = (t) => t;
      let postGof = baseGof;
      let send: (order: string[]) => void;
      if (decision.join) {
        const join = decision.join;
        patch = (t) => (set.has(t.id) ? { ...t, groupId: join } : t);
        postGof = (x) => (set.has(x) ? join : baseGof(x));
        send = (order) => wsControlRef.current?.sendGroupUpdate({ id: join, addIds: block, order });
      } else if (decision.leave) {
        const leave = decision.leave;
        patch = (t) => {
          if (!set.has(t.id)) return t;
          const copy = { ...t };
          delete copy.groupId;
          return copy;
        };
        postGof = (x) => (set.has(x) ? undefined : baseGof(x));
        send = (order) =>
          wsControlRef.current?.sendGroupUpdate({ id: leave, removeIds: block, order });
      } else {
        if (next.every((v, i) => v === ids[i])) return; // plain no-op move
        send = (order) => wsControlRef.current?.sendReorderTabs(order);
      }
      const order = normalizeOrder(next, postGof);
      const byId = new Map(src.map((t) => [t.id, t]));
      setTabs(() => order.flatMap((i) => (byId.has(i) ? [patch(byId.get(i)!)] : [])));
      send(order);
    },
    [collapsedRef],
  );

  // Chip block move: relocate the whole (contiguous) member block to the visible
  // insertion index, preserving inner order. One `reorderTabs`, applied optimistically.
  const moveGroup = useCallback(
    (gid: string, index: number) => {
      const src = tabsRef.current;
      const ids = src.map((t) => t.id);
      const memberSet = new Set(src.filter((t) => t.groupId === gid).map((t) => t.id));
      if (memberSet.size === 0) return;
      const rest = ids.filter((x) => !memberSet.has(x));
      const members = ids.filter((x) => memberSet.has(x));
      const entries = visibleEntries(src, collapsedRef.current, pairingsRef.current);
      const beforeId = entries[index]?.[0];
      if (beforeId !== undefined && memberSet.has(beforeId)) return; // dropped on itself
      const at = beforeId === undefined ? rest.length : Math.max(0, rest.indexOf(beforeId));
      const nextOrder = [...rest.slice(0, at), ...members, ...rest.slice(at)];
      if (nextOrder.every((v, i) => v === ids[i])) return;
      setTabs((prev) => {
        const byId = new Map(prev.map((t) => [t.id, t]));
        return nextOrder.flatMap((i) => byId.get(i) ?? []);
      });
      wsControlRef.current?.sendReorderTabs(nextOrder);
    },
    [collapsedRef],
  );

  // The whole tab-group concern bundled for SessionTabs/SessionDrawer — one
  // interface instead of eleven drilled props (the hook's ops + App's moveGroup).
  const tabGrouping = useMemo<TabGrouping>(
    () => ({
      groups,
      collapsed: collapsedGroups,
      onToggleGroup: toggleGroup,
      onNewGroup: newGroup,
      onAddToGroup: addToGroup,
      onRemoveFromGroup: removeFromGroup,
      onGroupRename: groupRename,
      onGroupRecolor: groupRecolor,
      onGroupDissolve: groupDissolve,
      onGroupCloseAll: groupCloseAll,
      onMoveGroup: moveGroup,
    }),
    [
      groups,
      collapsedGroups,
      toggleGroup,
      newGroup,
      addToGroup,
      removeFromGroup,
      groupRename,
      groupRecolor,
      groupDissolve,
      groupCloseAll,
      moveGroup,
    ],
  );

  // Drag-onto-slot (split on screen): dropping a strip tab on a slot REPLACES
  // that slot's content — always exactly two slots, and dropping a member is a
  // no-op (a tab is never duplicated into both slots). The replaced tab stays
  // in the strip.
  const doDropSlot = useCallback(
    (id: string, slot: SlotId) => {
      setDragTabId(null);
      dispatch({ type: 'dropSlot', id, slot });
    },
    [dispatch],
  );

  // The always-on control socket: tab list, settings, fonts, control acks. It
  // owns app state; TerminalPane sockets ignore these broadcasts.
  useEffect(() => {
    const ws = new WsClient(wsControlUrl());
    wsControlRef.current = ws;
    ws.onMessage((msg) => {
      if (msg.type === 'ready') {
        setMaxUploadBytes(msg.maxUploadBytes);
        setWebApps(msg.webApps);
        if (msg.version) {
          if (knownVersionRef.current && knownVersionRef.current !== msg.version) {
            showToast('Server updated — reload to get the latest');
          }
          knownVersionRef.current = msg.version;
        }
        // A `ready` means a server is serving us again — the update finished.
        setUpdating(null);
      } else if (msg.type === 'updating') {
        if (msg.stage === 'failed') {
          setUpdating(null);
          showToast('Update failed — still on the current version');
        } else {
          setUpdating({ stage: msg.stage, ...(msg.version ? { version: msg.version } : {}) });
        }
      } else if (msg.type === 'tabCreated') {
        dispatch({ type: 'tabCreated', id: msg.id });
      } else if (msg.type === 'sessions') {
        // Accumulate seen-terminals + prune BEFORE deciding close-nav (the
        // controller reads seenTermIds); `setTabs` is async so `tabsRef.current`
        // is still the OLD list the close-nav decision needs.
        for (const t of msg.tabs) if (t.kind === 'terminal') seenTermIdsRef.current.add(t.id);
        // Group model + collapse pruning is owned by useTabGroups. An older server
        // (or a pre-groups broadcast) omits `groups` → treat as none (the parse
        // layer defaults it; this also guards direct injection in tests).
        applyGroupBroadcast(msg.groups ?? []);
        setDirtyTabs((prev) => pruneRecord(prev, new Set(msg.tabs.map((t) => t.id))));
        // FIRST broadcast: this window has no tab yet (it was opened at `/`, so
        // its only clue was what it remembered) and now the list has arrived.
        // Resolving here rather than at boot is what stops a remembered id that
        // has since been closed from mounting a pane and SPAWNING a terminal on
        // it — an attach to an unknown id creates one.
        if (awaitingResolveRef.current) {
          awaitingResolveRef.current = false;
          setAwaitingResolve(false);
          if (boot.kind === 'new') {
            // The list is here, so `nextFreeId` can finally pick an id that is
            // actually free. setTabs below has not run yet, and createTab reads
            // tabsRef — so seed it first or the allocation is still blind.
            tabsRef.current = msg.tabs;
            createTabRef.current?.({ kind: 'terminal' });
          } else {
            const target = resolveSelection({ stored: readSelection(), tabs: msg.tabs });
            if (target) setSessionId(target);
            else setChooserPage(true);
          }
        } else {
          // Close-navigation (active tab gone → neighbor / New-tab page) is a
          // pure controller decision, and it OWNS the neighbour rule: it is the
          // only place holding the previous strip order needed to compute it.
          // On-screen splits reconcile in their own effect.
          dispatch({ type: 'sessionsBroadcast', tabs: msg.tabs });
        }
        setTabs(msg.tabs);
      } else if (msg.type === 'settings') applySettings(msg.settings);
      else if (msg.type === 'extraKeys') applyExtraKeys(msg.extraKeys);
      else if (msg.type === 'fonts') {
        const { families, loaded } = registerFonts(msg.fonts);
        setFontFamilies(families);
        // Re-rasterize BOTH split panes (not just the focused one).
        void loaded.then(() => {
          registry.apiFor('a')?.refreshFont();
          registry.apiFor('b')?.refreshFont();
        });
      } else if (msg.type === 'themes') {
        registerDynamicThemes(msg.themes);
        // The active theme may be a user theme that just arrived / changed.
        applyThemeTokens(getProfile(settingsRef.current.themeId));
        // The xterm canvas needs the same nudge, and does NOT get it for free:
        // themeId hasn't changed, only what it RESOLVES to, so useTerminal's
        // settings effect won't re-run. Boot hits this every time — the control
        // socket lands after the terminal is built, so a `user:` theme rendered
        // as the default (dark) palette while the rest of the UI was correct.
        registry.apiFor('a')?.refreshTheme();
        registry.apiFor('b')?.refreshTheme();
        setThemesNonce((n) => n + 1);
      } else if (msg.type === 'themeImported') {
        setImportingTheme(false);
        if (!msg.ok) {
          showToast(`Import failed — ${msg.detail ?? 'unknown error'}`);
        } else if (msg.id) {
          // Select it right away. The profile itself lands a moment later on the
          // themes broadcast (the server watches the dir), and THAT handler
          // re-applies the tokens — so a brief fallback paint self-heals.
          updateSettings({ themeId: msg.id });
          showToast(`Imported ${msg.detail ?? 'theme'}`);
        }
      }
    });
    ws.connect();
    return () => {
      if (wsControlRef.current === ws) wsControlRef.current = null;
      ws.destroy();
    };
  }, [
    applySettings,
    updateSettings,
    applyExtraKeys,
    registry,
    applyGroupBroadcast,
    dispatch,
    showToast,
    boot.kind,
  ]);

  // The chooser is never a floating box: it opens in whichever CONTAINER this
  // device has — the dock on desktop, the drawer on mobile. It used to be a
  // popover anchored at [+], which on mobile anchored to a button that does not
  // exist (there is no strip) and fell back to a box floating over the corner.
  // While the New-tab PAGE is up (last tab closed) the page IS the chooser.
  const openNewTab = useCallback(() => {
    if (chooserPageRef.current) return;
    if (!mobileActiveRef.current) {
      openDockView('newtab');
      return;
    }
    // The drawer is the container, so it has to be open to hold anything —
    // the keybinding can fire with it closed.
    setDrawerView('sessions');
    setDrawerOpen(true);
    setNewTabOpen(true);
  }, [openDockView]);

  // Rebindable desktop keybindings, wired to the actions that currently have a
  // target. Unbound / unwired chords fall through to the terminal untouched.
  const actionHandlers: Partial<Record<Action, () => void>> = {
    commandPalette: () => setPanel('commandPalette'),
    search: () => registry.focusedApi()?.openSearch(),
    newTab: openNewTab,
    // Two hosts, no modal: the dock on desktop, the drawer's own settings view
    // on mobile (where the dock is forced off and the drawer IS the container).
    settings: () => {
      if (!mobileActiveRef.current) return openDockView('settings');
      setDrawerView('settings');
      setDrawerOpen(true);
    },
    openSettingsJson: () => setPanel('settingsJson'),
    tips: () => setPanel('tips'),
    diagnostics: copyDiagnostics,
    exportScrollback: () => {
      const text = registry.focusedApi()?.exportScrollback() ?? null;
      if (text) downloadText('palmux-scrollback.txt', text);
      else showToast('Focus a terminal to export');
    },
    copyLastOutput: () => {
      const text = registry.focusedApi()?.copyLastOutput() ?? null;
      if (text) void copyText(text).then(() => showToast('Copied last output'));
      else showToast('No command output (needs shell integration)');
    },
    dictate: dictation.toggle,
    dictationHistory: () => setPanel('dictationHistory'),
    // Upload and download are RAIL actions, and the rail is a per-device
    // preference — `sidebarRail: 'hidden'` used to leave them with no route at
    // all once the desktop action cluster was retired. These are that route,
    // and they put both in the command palette, where every other action is.
    uploadFile: guardedOpenPicker,
    downloadFile: doDownload,
    increaseFontSize: () => updateSettings({ fontSize: settingsRef.current.fontSize + 1 }),
    decreaseFontSize: () => updateSettings({ fontSize: settingsRef.current.fontSize - 1 }),
    resetFontSize: () => updateSettings({ fontSize: DEFAULTS.fontSize }),
  };
  useKeybindings(actionHandlers);

  const createTab = useCallback(
    (spec: CreateSpec) => {
      setNewTabOpen(false);
      if (spec.kind === 'terminal') {
        // Always created OUTSIDE every pairing: exclude the current id and every
        // pairing member (any may not be broadcast yet) so the fresh id can never
        // collide with an existing tab and read as a member.
        const exclude = [...tabsRef.current.map((t) => t.id), sessionIdRef.current];
        for (const p of pairingsRef.current) exclude.push(p.a.tabId, p.b.tabId);
        const id = nextFreeId(exclude);
        // A terminal is not created through the server at all — the client picks
        // a free id and the PTY spawns on the first /ws attach. So a tmux target
        // cannot be sent with a create message; it waits here for the pane that
        // is about to mount on this id to collect it.
        if (spec.tmux !== undefined) pendingTmuxRef.current.set(id, spec.tmux);
        selectTab(id);
        return;
      }
      // The server acks with `tabCreated` carrying the assigned id (deterministic).
      if (!wsControlRef.current?.sendCreateTab(spec)) showToast('Not connected — try again');
    },
    [selectTab, showToast],
  );
  createTabRef.current = createTab;

  // Reconcile every pairing against the live tabs: a pairing dissolves when a
  // member dies / changes kind (recycled id), or (both alive) when the two are
  // no longer strip-adjacent or no longer share group membership. Depends on
  // `pairings` too (not just broadcasts): a set restored by the mobile→desktop
  // toggle arrives with NO tabs change and must still reconcile. Safe — reconcile
  // returns the SAME array reference when nothing changed, so the effect no-ops.
  //
  // A newborn self-split's fresh terminal materializes at the strip END when its
  // first broadcast lands — pendingFreshRef (key → fresh member id) shields it
  // from the adjacency dissolve until the repair fuseSync below moves it next to
  // its anchor (one wire message, same as any fuse).
  useEffect(() => {
    const pendingKeys = new Set(pendingFreshRef.current.keys());
    const res = reconcilePairings(
      pairings,
      tabs,
      seenTermIdsRef.current,
      groupIdMap(tabs),
      pendingKeys,
    );
    // Establish or repair pending adjacencies now that positions are known.
    const gof = groupIdMap(tabs);
    for (const [key, moveId] of pendingFreshRef.current) {
      const p = res.pairings.find((x) => x.a.tabId === key);
      if (!p) {
        pendingFreshRef.current.delete(key); // pairing gone — nothing to establish
        continue;
      }
      const im = tabs.findIndex((t) => t.id === moveId);
      if (im === -1) continue; // fresh member not broadcast yet — keep waiting
      const keepId = p.a.tabId === moveId ? p.b.tabId : p.a.tabId;
      const ik = tabs.findIndex((t) => t.id === keepId);
      if (ik !== -1 && Math.abs(ik - im) === 1 && gof(keepId) === gof(moveId)) {
        pendingFreshRef.current.delete(key); // established
      } else if (ik !== -1) {
        applyFuseSync({
          keepId,
          moveId,
          moveGid: gof(moveId) ?? null,
          targetGid: gof(keepId) ?? null,
        });
      }
    }
    if (res.pairings === pairings) return;
    setPairings(res.pairings);
    // Navigate only when the ACTIVE tab's pairing dissolved (an off-screen one
    // collapses silently under whatever tab the user is viewing).
    const active = sessionIdRef.current;
    const activeDissolved = res.dissolved.find((d) => {
      const p = pairings.find((x) => x.a.tabId === d.key);
      return !!p && (p.a.tabId === active || p.b.tabId === active);
    });
    if (!activeDissolved) return;
    const fallback =
      activeDissolved.survivor ?? tabs.find((t) => t.kind === 'terminal')?.id ?? tabs[0]?.id ?? '0';
    if (fallback !== active) setSessionId(fallback);
  }, [pairings, tabs, setPairings, applyFuseSync]);

  // Close = kill, with kind-appropriate confirmation owned here.
  const closeTab = useCallback((id: string) => {
    const kind = tabsRef.current.find((t) => t.id === id)?.kind ?? 'terminal';
    if (kind === 'terminal') {
      if (
        !window.confirm(
          `Kill terminal ${id}? The shell and everything running in it will be terminated.`,
        )
      ) {
        return;
      }
    } else if (kind === 'editor' && dirtyRef.current[id]) {
      if (!window.confirm('This editor tab has unsaved changes. Close and discard them?')) return;
    }
    wsControlRef.current?.sendKill(id);
  }, []);

  // Chrome's "Close other tabs" / "Close tabs to the right", behind ONE
  // kind-aware confirm — the same shape a group's Close all uses, because a
  // bulk close is the only action here that can destroy work, and a bare count
  // hides which of it is a running shell and which is unsaved text.
  //
  // All kills go out in ONE pass rather than through `closeTab`: that would ask
  // per tab, and each close would navigate to a neighbour that is itself about
  // to close.
  const closeMany = useCallback((ids: string[]) => {
    const set = new Set(ids);
    const victims = tabsRef.current.filter((t) => set.has(t.id));
    const message = closeManyMessage(
      victims,
      dirtyRef.current,
      `Close ${victims.length} tab${victims.length > 1 ? 's' : ''}?`,
    );
    if (!message || !window.confirm(message)) return;
    for (const t of victims) wsControlRef.current?.sendKill(t.id);
  }, []);

  const renameTab = useCallback(
    (id: string, name: string) => wsControlRef.current?.sendUpdateTab({ id, name }),
    [],
  );
  const recolorTab = useCallback(
    (id: string, color: string) => wsControlRef.current?.sendUpdateTab({ id, color }),
    [],
  );
  const changeTabUrl = useCallback(
    (id: string, url: string) => wsControlRef.current?.sendUpdateTab({ id, url }),
    [],
  );
  const onPaneDirty = useCallback((id: string, dirty: boolean) => {
    setDirtyTabs((prev) => (prev[id] === dirty ? prev : { ...prev, [id]: dirty }));
  }, []);
  /**
   * Open a server file as a TAB, or focus the tab already showing it.
   *
   * A file used to render into a full-width overlay across the content area,
   * which made it modal: it covered whatever terminal was running and the only
   * way back was to close it. As a tab it sits in the strip beside the
   * terminals and several can be open at once.
   *
   * Focus-if-open is the VS Code behaviour and it matters more here than there:
   * two tabs on one path would be two editors over one file, and whichever
   * saved last would silently win.
   */
  const openFileTab = useCallback(
    (path: string) => {
      const existing = tabsRef.current.find((t) => t.kind === 'editor' && t.url === path);
      if (existing) {
        selectTab(existing.id);
        return;
      }
      createTab({ kind: 'editor', url: path });
    },
    [createTab, selectTab],
  );

  const updateQuickLinks = useCallback(
    (quickLinks: { name: string; url: string }[]) => updateSettings({ quickLinks }),
    [updateSettings],
  );

  // Main window: accept "return to main" from a popped-out window (origin-locked).
  useEffect(() => {
    if (popout) return;
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== location.origin) return;
      const d = e.data as { type?: string; tabId?: string };
      if (d?.type === POPOUT_RETURN && typeof d.tabId === 'string') {
        window.focus();
        selectTab(d.tabId);
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [popout, selectTab]);

  const doPopout = useCallback(
    (id: string) => {
      if (!openPopout(id)) showToast('Pop-out blocked — allow popups for this site');
    },
    [showToast],
  );

  // Popout: the return button posts to the opener and closes; if the opener is
  // gone the button disables with a hint.
  const returnToMain = useCallback(() => {
    if (postReturnToMain(sessionIdRef.current)) window.close();
    else setOpenerGone(true);
  }, []);

  // Escape dismisses the new-tab chooser without creating anything.
  useEffect(() => {
    if (!newTabOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNewTabOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newTabOpen]);

  // The extra-keys bar reserves its own flex space; refit the focused terminal
  // when it appears or changes height.
  const onBarHeight = useCallback(() => registry.focusedApi()?.refit(), [registry]);

  // visualViewport: pin the app to the visible viewport so the terminal + bar
  // stay above the soft keyboard, and re-fit the focused terminal (preserving
  // its selection). App owns the CSS vars; the terminal owns the fit.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !mobileActive) return;
    const root = document.documentElement.style;
    let raf = 0;
    let deferred = false;
    // The height the app is currently PINNED to. While a selection defers the
    // replay this stays at the keyboard-up height, which is what makes the
    // dead space below the terminal, and what the restore below compares to.
    let pinnedH = vv.height;
    const apply = () => {
      raf = 0;
      // Starting a native text selection BLURS the hidden keyboard textarea (a
      // page selection and a focused editable cannot coexist), so Android
      // dismisses the IME — which fires this handler. Re-fitting the terminal
      // here reflows the buffer out from under the selection and the user's
      // selection vanishes mid-gesture. Hold the layout still until they let
      // go; the keyboard is on its way out either way.
      if (hasNativeSelection()) {
        deferred = true;
        return;
      }
      // …and nothing was bringing it BACK. The blur is unavoidable, but once
      // the selection is gone the user is left looking at their terminal unable
      // to type, with no hint that the keyboard is what went missing — reported
      // as the terminal itself closing. Restore it, but ONLY when it was really
      // up when the selection started: the viewport growing past the height we
      // were pinned to is what says so (the same test `ExtraKeysBar` uses after
      // a long press), so someone who merely selects text while reading does
      // not get a keyboard they never asked for.
      const restore = shouldRestoreKeyboard(deferred, vv.height, pinnedH);
      deferred = false;
      pinnedH = vv.height;
      root.setProperty('--app-height', `${vv.height}px`);
      root.setProperty('--app-top', `${vv.offsetTop}px`);
      registry.focusedApi()?.refit();
      // Best-effort: Android only raises the IME for a focus() that carries user
      // activation. The tap that dismisses a selection provides it; the OS Copy
      // callout may not, and then the next tap on the terminal raises it as it
      // always has.
      if (restore) kbdRaiseRef.current();
    };
    const onVV = () => {
      if (raf) return;
      raf = requestAnimationFrame(apply);
    };
    // The selection ending is the only signal that a deferred resize can run —
    // no further viewport event is guaranteed once the keyboard has gone.
    const onSelectionChange = () => {
      if (deferred && !hasNativeSelection()) onVV();
    };
    document.addEventListener('selectionchange', onSelectionChange);
    apply();
    // Passive: the handler only reads geometry + schedules a rAF, never
    // preventDefault — lets the browser scroll without waiting on JS.
    vv.addEventListener('resize', onVV, { passive: true });
    vv.addEventListener('scroll', onVV, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('selectionchange', onSelectionChange);
      vv.removeEventListener('resize', onVV);
      vv.removeEventListener('scroll', onVV);
      root.removeProperty('--app-height');
      root.removeProperty('--app-top');
    };
  }, [mobileActive, registry]);

  const onPaneFocus = useCallback(
    (id: string) => {
      const p = pairingOf(pairingsRef.current, sessionIdRef.current);
      if (!p) return;
      const slot = memberSlot(p, id);
      if (slot) focusSlotHandler(slot);
    },
    [focusSlotHandler],
  );

  // The mobile drawer opener, stable — passed to panes on mobile.
  const openDrawerMenu = useCallback(() => setDrawerOpen(true), []);

  // Upload and download are rail ACTIONS, not dock views. The desktop topbar
  // that used to hold them is gone — the app had two action bars, one above the
  // terminal and one beside it — and putting them in a panel would turn a
  // one-click action into three. Memoized: a new array every render remounts nothing
  // but does churn DockPanel's props for no reason.
  const railActions = useMemo(
    () => [
      { id: 'upload' as const, label: 'Upload a file', onRun: guardedOpenPicker },
      {
        id: 'download' as const,
        label: 'Download from the server (path or glob)',
        onRun: doDownload,
      },
    ],
    [guardedOpenPicker, doDownload],
  );

  return (
    <div className={`app${popout ? ' popout' : ''}${mobileActive ? ' mobile' : ''}`}>
      {popout && (
        <div className="popout-bar">
          <span className="topbar-brand">palmux</span>
          <span className="spacer" />
          <button
            className="icon-btn"
            style={{ width: 'auto', padding: '0 10px' }}
            title="Return this tab to the main window"
            data-testid="popout-return"
            disabled={openerGone}
            onClick={returnToMain}
          >
            {openerGone ? 'main window closed' : '⇱ return to main'}
          </button>
        </div>
      )}
      {!mobileActive && !popout && (
        <div className="topbar">
          <span className="topbar-brand">palmux</span>
          {/* The strip derives a lot from broadcasts (fusion, groups, drop
              marks). A throw in that derivation used to grey the whole app;
              scoped here it costs the strip and leaves the terminals attached,
              which is the difference between "navigate with the URL" and
              "reopen and lose everything". */}
          <ErrorBoundary label="Tab strip">
          <SessionTabs
            tabs={tabs}
            current={chooserPage ? '' : sessionId}
            dirty={dirtyTabs}
            pairings={stripPairings}
            onSwitch={selectTab}
            onNewTab={openNewTab}
            onClose={closeTab}
            onCloseMany={closeMany}
            onRename={renameTab}
            onRecolor={recolorTab}
            onSplit={activePairing ? undefined : doSplit}
            onPopout={doPopout}
            onDrag={setDragTabId}
            onReorder={doReorder}
            grouping={tabGrouping}
          />
          </ErrorBoundary>
          <span className="spacer" />
        </div>
      )}

      <div className="content-row">
        <div className="content-area" ref={contentRef}>
          {/* All split geometry + the terminal/pane/divider/eject/dropzone
            rendering lives in SplitView (it owns the live divider ratio). */}
          <SplitView
            pairing={activePairing}
            sessionId={sessionId}
            activeKind={activeKind}
            // No tab id yet ⇒ no panes, and no chooser either: the window is
            // between boot and its first answer. A pane mounted on an empty id
            // would open `/ws?session=` — and on a REMEMBERED id that has since
            // been closed it would spawn a terminal there, which is why the
            // remembered case waits for the tab list rather than guessing.
            chooserPage={chooserPage || !sessionId}
            // The ACTIVE tab shows no edge zones: it is already the pane being
            // dropped onto, and splitting a tab with itself is refused (a pane
            // cannot mirror itself). Hiding the zones makes the refusal visible
            // instead of silent — see `dropSplit` in workspaceController.
            showEdgeZones={
              dragTabId !== null &&
              dragTabId !== sessionId &&
              !activePairing &&
              !pairingOf(pairings, dragTabId)
            }
            showSlotZones={dragTabId !== null && !!activePairing && !pairingOf(pairings, dragTabId)}
            containerRef={contentRef}
            registry={registry}
            settings={settings}
            mobileActive={mobileActive}
            maxUploadBytes={maxUploadBytes}
            paneBlocked={paneBlocked}
            takeSpawnTmux={takeSpawnTmux}
            resizeBusy={dockBusy}
            onAutoCopy={onAutoCopy}
            onUploadError={onUploadError}
            onFocusRequest={focusSlotHandler}
            terminalGestures={terminalGestures}
            tabs={tabs}
            webApps={webApps}
            quickLinks={settings.quickLinks}
            onCreate={createTab}
            onUpdateQuickLinks={updateQuickLinks}
            onChangeUrl={changeTabUrl}
            onPaneDirty={onPaneDirty}
            onPaneFocus={onPaneFocus}
            paneMenu={mobileActive ? openDrawerMenu : undefined}
            onRatioCommit={(r) => {
              if (activeKey) setRatio(activeKey, r);
            }}
            onSwapSlots={activeKey ? () => swapSlots(activeKey) : undefined}
            onRotateSplit={activeKey ? () => toggleOrientation(activeKey) : undefined}
            onEject={doCollapse}
            onDropSplit={doDropSplit}
            onDropSlot={doDropSlot}
          />

          {/* Closing the last tab lands here: the chooser as an ACTUAL page. */}
          {chooserPage && (
            <div className="newtab-page" data-testid="newtab-page">
              <NewTabChooser
                webApps={webApps}
                quickLinks={settings.quickLinks}
                onCreate={createTab}
                onUpdateQuickLinks={updateQuickLinks}
                onPin={() => createTab({ kind: 'dashboard' })}
                onMenu={mobileActive ? () => setDrawerOpen(true) : undefined}
              />
            </div>
          )}

          {/* A file opened from the tree takes the content area. It sits OVER SplitView rather than inside it: SplitView owns
              pane geometry by rect, and threading a non-tab pane through it
              would make every split calculation carry a case that is not a tab.
              It belongs INSIDE .content-area, not beside it: `inset: 0` against
              the row covered the dock, hiding the very tree that opened it. */}
          {/* Floating bottom-centre, the same
              anchor on desktop and mobile, compacting in place on a narrow
              viewport rather than moving. It replaces the old anchored pill.

              It lives INSIDE .content-area so "bottom" means the bottom of the
              terminal. Fixed to the viewport it sat ON TOP of the mobile
              extra-keys bar, which is in normal flow and has no height this
              stylesheet could subtract. */}
          {/* Shown through 'working' too, not just 'recording': stopping hands
              off to a paid round-trip that can take seconds and can fail, and
              unmounting on Stop left no way to tell "still going" from "failed
              silently". The clock freezes at the clip's length, which is the
              useful number while you wait. */}
          {(dictation.state === 'recording' || dictation.state === 'working') && (
            <RecordingToast
              {...(dictation.analyser ? { analyser: dictation.analyser } : {})}
              elapsedMs={Math.max(0, recNow - recStart)}
              narrow={mobileActive}
              phase={dictation.state === 'working' ? 'transcribing' : 'recording'}
              onStop={dictation.toggle}
            />
          )}

        </div>

        {/* Desktop only: on mobile the drawer is the view container and the rail
            is forced off, so the terminal keeps the whole screen. */}
        {!mobileActive && !popout && (
          <DockPanel
            view={dockView}
            rail={settings.sidebarRail === 'always'}
            onView={openDockView}
            actions={railActions}
          >
            {dockView === 'settings' && <ConfigEditor mode={cfgMode} onMode={setCfgMode} />}
            {dockView === 'settings' && cfgMode === 'form' && (
              <SettingsFields
                settings={settings}
                onChange={updateSettings}
                fontFamilies={fontFamilies}
                onOpenKeybindings={() => setPanel('keybindings')}
                onOpenTips={() => setPanel('tips')}
                onOpenDictationHistory={() => openDockView('dictation')}
                onImportTheme={onImportTheme}
                importingTheme={importingTheme}
                appVersion={knownVersionRef.current}
              />
            )}
            {dockView === 'newtab' && (
              <DashboardBody
                webApps={webApps}
                quickLinks={settings.quickLinks}
                onCreate={(spec) => {
                  createTab(spec);
                  // Creating navigates away; leaving the panel on New tab would
                  // greet the next open with a chooser nobody asked for.
                  openDockView(null);
                }}
                onUpdateQuickLinks={updateQuickLinks}
              />
            )}
            {dockView === 'files' && (
              <FileTree
                onOpenFile={openFileTab}
                pins={settings.explorerPins}
                onPinsChange={(explorerPins) => updateSettings({ explorerPins })}
                onNotice={showToast}
              />
            )}
            {dockView === 'dictation' && (
              <DictationView
                onCopy={(text) => void copyText(text).then(() => showToast('Copied'))}
                onInsert={(text) => {
                  const api = registry.focusedApi();
                  if (!api) showToast('Focus a terminal to insert into');
                  else if (!api.paste(text)) showToast('Terminal not connected');
                }}
              />
            )}
          </DockPanel>
        )}
      </div>

      {mobileActive && !popout && (
        <SessionDrawer
          open={drawerOpen}
          tabs={tabs}
          current={sessionId}
          groups={groups}
          collapsed={collapsedGroups}
          onToggleGroup={toggleGroup}
          onSwitch={switchSession}
          onCreate={openNewTab}
          onKill={closeTab}
          onClose={() => setDrawerOpen(false)}
          onTabMenu={(id) => {
            setDrawerOpen(false);
            setSheetTabId(id);
          }}
          view={drawerView}
          onView={setDrawerView}
          // Declared once, so the segments are selectable. `viewContent` below
          // can only ever be the ACTIVE view's body, so it cannot double as the
          // availability signal.
          hostedViews={DRAWER_HOSTED_VIEWS}
          // The chooser IN the drawer, replacing the session list — the mobile
          // half of "[+] opens the container, never a floating box".
          {...(newTabOpen && !chooserPage
            ? {
                newTabContent: (
                  <DashboardBody
                    webApps={webApps}
                    quickLinks={settings.quickLinks}
                    onCreate={(spec) => {
                      createTab(spec);
                      setDrawerOpen(false); // creating navigates; get out of the way
                    }}
                    onUpdateQuickLinks={updateQuickLinks}
                  />
                ),
              }
            : {})}
          onNewTabBack={() => setNewTabOpen(false)}
          {...(drawerView === 'files'
            ? {
                viewContent: (
                  <FileTree
                    onOpenFile={(path) => {
                      openFileTab(path);
                      setDrawerOpen(false);
                    }}
                    pins={settings.explorerPins}
                    onPinsChange={(explorerPins) => updateSettings({ explorerPins })}
                    onNotice={showToast}
                  />
                ),
              }
            : drawerView === 'dictation'
              ? {
                  viewContent: (
                    <DictationView
                      onCopy={(text) => void copyText(text).then(() => showToast('Copied'))}
                      onInsert={(text) => {
                        setDrawerOpen(false);
                        const api = registry.focusedApi();
                        if (!api) showToast('Focus a terminal to insert into');
                        else if (!api.paste(text)) showToast('Terminal not connected');
                      }}
                    />
                  ),
                }
              : {})}
          actions={drawerActions}
          settings={settings}
          onChangeSettings={updateSettings}
          fontFamilies={fontFamilies}
          onOpenKeybindings={() => setPanel('keybindings')}
          onOpenTips={() => setPanel('tips')}
          onOpenDictationHistory={() => setPanel('dictationHistory')}
          onImportTheme={onImportTheme}
          importingTheme={importingTheme}
          appVersion={knownVersionRef.current}
        />
      )}

      {sheetTabId !== null && !popout && (
        <TabSheet
          tab={tabs.find((t) => t.id === sheetTabId) ?? { id: sheetTabId, kind: 'terminal' }}
          onRename={renameTab}
          onRecolor={recolorTab}
          groups={groups}
          onNewGroup={newGroup}
          onAddToGroup={addToGroup}
          onRemoveFromGroup={removeFromGroup}
          onCloseTab={closeTab}
          onDismiss={() => setSheetTabId(null)}
        />
      )}

      {mobileActive && !popout && (
        <ExtraKeysBar
          ref={barRef}
          config={extraKeys}
          visible={extraKeys.enabled && activeKind === 'terminal'}
          send={sendInput}
          isBlocked={kbdBlocked}
          onHeightChange={onBarHeight}
          onAction={(a) => {
            if (a === 'keyboard') kbd.toggle();
            else if (a === 'dictate') dictation.toggle();
          }}
          // Swipe LEFT→RIGHT always raises the keyboard (never toggles — "open
          // it, no matter what"); RIGHT→LEFT pulls in the drawer from the
          // right edge, matching the direction of travel.
          onSwipe={(dir) => (dir === 'right' ? kbd.raise() : setDrawerOpen(true))}
          onRaiseKeyboard={kbd.raise}
        />
      )}

      {/* Hidden input that captures soft-keyboard keystrokes on mobile. */}
      <textarea
        ref={taRef}
        id="mobile-kbd"
        name="palmux-kbd"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        aria-hidden="true"
        tabIndex={-1}
        data-form-type="other"
        data-lpignore="true"
        data-1p-ignore="true"
        data-gramm="false"
      />

      <Toast ref={toastRef} />

      {updating && (
        <div className="update-banner" role="status" data-testid="update-banner">
          {updating.stage === 'restarting'
            ? 'Updating — reconnecting…'
            : `Updating${updating.version ? ` to ${updating.version}` : ''}…`}
          <span className="update-banner-sub">your sessions are preserved</span>
        </div>
      )}

      {panel === 'tips' && <TipsPanel onClose={() => setPanel('none')} />}
      {panel === 'keybindings' && <KeybindingsPanel onClose={() => setPanel('none')} />}
      {panel === 'dictationHistory' && (
        <DictationHistory
          onClose={() => setPanel('none')}
          onCopy={(text) => void copyText(text).then(() => showToast('Copied'))}
          onInsert={(text) => {
            setPanel('none');
            const api = registry.focusedApi();
            if (!api) showToast('Focus a terminal to insert into');
            else if (!api.paste(text)) showToast('Terminal not connected');
          }}
        />
      )}
      {panel === 'settingsJson' && (
        <SettingsEditor onApply={updateSettings} onClose={() => setPanel('none')} />
      )}
      {panel === 'commandPalette' && (
        <CommandPalette
          items={ACTIONS.filter((a) => a !== 'commandPalette' && actionHandlers[a]).map((a) => ({
            key: a,
            label: ACTION_LABELS[a],
            hint: formatChord(loadBindings()[a]),
            run: actionHandlers[a]!,
          }))}
          vimMode={settings.vimInputMode}
          onClose={() => setPanel('none')}
        />
      )}
    </div>
  );
}
