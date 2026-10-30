import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { JsonObject, TabMeta, WebAppLink } from '@palmux/shared';
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  forgivingOrder,
  normalizeOrder,
  parseReviewUrl,
  reviewUrl,
} from '@palmux/shared';
import { WsClient } from './lib/ws';
import { Toast, type ToastAction, type ToastHandle } from './Toast';
import { useSettings } from './settings/useSettings';
import {
  DEFAULTS,
  resolveMobileMode,
  resolveThemeId,
  themeModeAfter,
  themePick,
  type ClientSettings,
  type ThemeMode,
  type ThemeTarget,
} from './settings/settings';
import { useSystemPrefersDark } from './settings/useSystemPrefersDark';
import { useKeybindings } from './keybindings/useKeybindings';
import { closeKeyIntent } from './keybindings/close-key';
import {
  ACTION_LABELS,
  ACTIONS,
  type Action,
  formatChord,
  loadBindings,
} from './keybindings/keybindings';
import { CommandPalette } from './command-palette/CommandPalette';
import { SettingsFields } from './settings/SettingsFields';
import { reloadApp } from './settings/app-reload';
import { ConfigEditor, focusLost, type ConfigEditorMode } from './settings/ConfigEditor';
import { FileTree } from './panes/FileTree';
import { DictationView } from './dictation/DictationView';
import { RecordingToast } from './dictation/RecordingToast';
import { KeybindingsPanel } from './settings/KeybindingsPanel';
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
import {
  SessionTabs,
  TAB_DIRTY_DND_TYPE,
  TAB_DND_TYPE,
  type TabGrouping,
} from './session/SessionTabs';
import { displayTitle, pruneRecord, reorderIds } from './session/tab-meta';
import {
  decideGroupDrop,
  groupEdgeTarget,
  groupIdMap,
  outsideForeignGroup,
  type GroupEdge,
} from './session/tab-groups';
import { useTabGroups } from './session/useTabGroups';
import { SessionDrawer, type DrawerActions, type DrawerView } from './session/SessionDrawer';
import {
  accepts,
  buildNodes,
  resolveDrop,
  tabValue,
  groupValue,
  type DrawerDrop,
  type DropResult,
} from './session/drawer-tree';
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
  openDetached,
  windowPath,
} from './session/session-url';
import {
  readLastTab,
  readSelection,
  resolveSelection,
  resolveStoredSelection,
  selectionFor,
  writeLastTab,
  writeSelection,
  type WindowSelection,
} from './session/window-selection';
import { createSplitRegistry } from './session/SplitFocusContext';
import { useDictation } from './dictation/useDictation';
import { DictationHistory } from './dictation/DictationHistory';
import { layoutKey, useEditorGroups, type Placement } from './session/useEditorGroups';
import {
  activate,
  focusLeaf,
  leafOf as leafHolding,
  leaves,
  moveTab,
  resizeSash,
  splitPane,
  type PaneLayout,
  type PaneLeaf,
  type Rect,
  type Side,
  type Sash as SashGeometry,
  type TabRef,
} from './session/pane-grid';
import { decide, type WorkspaceEffect, type WorkspaceEvent } from './session/workspaceController';
import { GroupDropOverlay } from './session/GroupDropOverlay';
import { GroupsView } from './session/GroupsView';
import { type MobileGestures } from './terminal/TerminalPane';
import { downloadFromServer } from './terminal/download';
import { NewTabChooser } from './panes/NewTabChooser';
import type { DropdownMenuItemSpec } from './ui';
import { Dialog } from './ui/Dialog';
import { Icon } from './ui/icons';
import { closeManyMessage } from './session/close-many';
import {
  DashboardBody,
  hasLineBreak,
  LINE_BREAK_MESSAGE,
  type CreateSpec,
} from './panes/DashboardBody';
import { focusedEditor } from './panes/editor-registry';
import { SourceControlView, type ScmOpenTarget } from './scm/SourceControlView';
import { ReviewHostContext, type ReviewHost } from './review/review-host';
import { reviewApiFor } from './review/review-registry';
import { commentsStore, connectCommentsToStatus } from './review/use-comments';
import { resolveActiveRepo, scmStatusStore } from './scm/status-store';
import { editorKeyAction } from './mobile/editor-keys';
import type { KeyMods } from './mobile/key-encoder';
import { ReviewBar } from './mobile/ReviewBar';

/** How long a `createTab` for a review url blocks a second one while it is unanswered. */
const PENDING_REVIEW_MS = 5000;

/**
 * How long a move to another window is held against the server's broadcasts. A frame already in
 * flight when `moveToWindow` is sent names the old owner and would flash the tab back; the server
 * agreeing ends the hold, and so does this, when it refuses or never answers.
 */
const OPTIMISTIC_MOVE_MS = 2000;

/**
 * A tab dragged in from another window stops being a target once no `dragover` has come for this
 * long: the browser tells a window nothing when a drag it was watching is released over another one,
 * so each `dragover` buys this long and the clock is the end. It has to outlast the repeat a STILL
 * pointer gets, measured on Chrome 156 (Linux X11) at one `dragover` every ~352 ms (351–353, n=8; the
 * HTML spec's nominal 350 ms). At 300 ms the overlay unmounted between two repeats and a release in
 * that gap was lost. A drag that leaves the viewport is cleared by its `dragleave` in ~18 ms instead,
 * so this only bounds a drag whose end the browser never reports here, and a long clock costs little there.
 */
const EXTERNAL_DRAG_IDLE_MS = 1000;

/** The whole content area, for the one drop overlay the New-tab page takes. */
const WHOLE_AREA: Rect = { left: 0, top: 0, width: 100, height: 100 };
// That overlay is centre-only, so an edge drop never reaches it.
const noopDrop = () => {};

/**
 * The owner a tab is held at after it left this window in a drag the browser reported as moved. The
 * receiving window sent the move and this one cannot name that window, so the hold names none:
 * the tab is not this window's until the server says whose it is, or the hold runs out.
 */
const OTHER_WINDOW = '?';

/** Which window each tab was moved to, ahead of the server: an id, or null for the main window. */
type WindowOverrides = ReadonlyMap<string, string | null>;
const NO_OVERRIDES: WindowOverrides = new Map();

/** The tabs a detached window asked to take back and the server has not answered yet: none. */
const NO_RECLAIM: ReadonlySet<string> = new Set();

/** A tab the full list knows and this window does not show: another window holds it. */
const heldElsewhere = (full: TabMeta[], visible: TabMeta[], id: string): boolean =>
  full.some((t) => t.id === id) && !visible.some((t) => t.id === id);

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

/** The drawer views App supplies a body for (the dock's Explorer, Source Control and Dictation). */
const DRAWER_HOSTED_VIEWS: readonly DrawerView[] = ['files', 'scm', 'dictation'];

/**
 * How much the visual viewport must GROW for the soft keyboard to count as
 * gone. Same threshold as `ExtraKeysBar`'s `keyboardVanished` — the two are the
 * only places that have to tell "the IME left" from "the page reflowed a bit",
 * and they should not disagree.
 */
const KEYBOARD_GONE_PX = 100;

/**
 * How long a re-raised keyboard gets to come back before the app gives up and
 * re-pins to the grown viewport. Measured on a Galaxy S26: the IME was back
 * 91ms after the focus().
 */
const KEYBOARD_RETURN_MS = 600;

/**
 * How long the viewport must hold still, back within a keyboard of the pinned
 * height, before a keyboard restore counts as finished. Crossing back under the
 * threshold is not arrival: an IME animates in through heights between the two
 * (844 → 580 → 500), and committing the first of them is the second resize the
 * restore exists to avoid. `KEYBOARD_RETURN_MS` stays the upper bound.
 */
const RESTORE_SETTLE_MS = 150;

/**
 * Whether the end of a hold on the layout (a native text selection, or the
 * drawer) should put the soft keyboard back.
 *
 * Both gates carry weight. `deferred` says a hold is what kept the layout
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

/** Asked before anything unmounts Settings' raw config.json editor while it holds unsaved text. */
const DISCARD_CONFIG = 'Discard unsaved changes to config.json?';

/** What `closeDrawer` can be told. `picker` hides the drawer but keeps the layout hold. */
export interface DrawerCloseOptions {
  holdUntil?: 'picker';
}

/**
 * The drawer's claim on the layout while it is open (or while a native picker it
 * launched is). `kbdWasUp` is the keyboard's state when the drawer OPENED, which
 * is the only moment it can be read: once the drawer takes focus the IME may
 * leave, and from then on "was it up?" has no answer. A drawer reopened over a
 * pending picker adds what IT found, so either opening is restored. `picker` says
 * the drawer is hidden but the hold is waiting for a file picker to come back.
 */
interface DrawerHold {
  kbdWasUp: boolean;
  picker: boolean;
}

/**
 * Whether the soft keyboard is up right now. Focus alone cannot say — Android
 * dismisses the IME without blurring the textarea — so the pinned height has to
 * sit a keyboard's worth below the screen as well.
 */
function softKeyboardUp(): boolean {
  if (document.activeElement?.id !== 'mobile-kbd') return false;
  const pinned = Number.parseFloat(document.documentElement.style.getPropertyValue('--app-height'));
  return Number.isFinite(pinned) && window.screen.height - pinned > KEYBOARD_GONE_PX;
}

// No 'settings' member: settings have TWO hosts now, the dock on desktop and
// the drawer on mobile, and neither is a modal. The third one was the modal.
type Panel =
  | 'none'
  | 'tips'
  | 'keybindings'
  | 'commandPalette'
  | 'dictationHistory';

/**
 * The ids of the strip's VISIBLE entries in display order: collapsed-group members are excluded.
 * A reorder insertion index (entry space) maps back to a full-order anchor through it. `tabs` is
 * the list the strip draws, so for a pane it is that pane's tabs alone.
 */
function visibleEntries(tabs: TabMeta[], collapsed: ReadonlySet<string>): string[] {
  return tabs.filter((t) => !(t.groupId && collapsed.has(t.groupId))).map((t) => t.id);
}

/** What a drop does to the dragged tabs' group, in the server's `groupUpdate` terms. */
interface DropMembership {
  ids: ReadonlySet<string>;
  addTo?: string | undefined;
  removeFrom?: string | undefined;
}

/**
 * A drop applied to `prev`, the tab list as it is when React gets to it.
 *
 * The drop was resolved against `tabsRef`, the latest list, and `prev` need not be
 * it. A pointer event renders before a queued `sessions` broadcast does, so React
 * first applies this update to the list WITHOUT that broadcast, then rebases it
 * onto the broadcast. Rebuilding the list from the drop's `order` alone once
 * discarded a tab a broadcast brought and overwrote a membership it changed, and
 * the server, already holding the order it was sent, sent nothing to put either
 * back. So the drop is applied to whichever list `prev` is the way the server
 * applies it
 * (`groupUpdate`, then `reorder`): membership first and conditionally (an add
 * moves the tab into the group, stealing it from any other; a removal acts only
 * on a tab still in that group), then the forgiving permutation (unknown ids
 * dropped, tabs the order never named kept in their prior relative order), then
 * the contiguity normalize.
 */
function applyDrop(prev: TabMeta[], order: string[], change?: DropMembership): TabMeta[] {
  const patch = (t: TabMeta): TabMeta => {
    if (!change?.ids.has(t.id)) return t;
    if (change.addTo !== undefined) {
      return t.groupId === change.addTo ? t : { ...t, groupId: change.addTo };
    }
    if (change.removeFrom === undefined || t.groupId !== change.removeFrom) return t;
    const copy = { ...t };
    delete copy.groupId;
    return copy;
  };
  const byId = new Map(prev.map((t) => [t.id, patch(t)]));
  const ids = forgivingOrder(
    prev.map((t) => t.id),
    order,
    (id) => byId.has(id),
  );
  return normalizeOrder(ids, (id) => byId.get(id)?.groupId).flatMap((id) => byId.get(id) ?? []);
}

/**
 * The id right after the last of `inScope` in `ids` (the full order), or undefined when that one is
 * last: where a drop past the end of a pane's strip lands, so it stays with the pane's tabs and
 * does not jump over another pane's.
 */
function afterLastOf(ids: string[], inScope: ReadonlySet<string>): string | undefined {
  const last = ids.findLastIndex((id) => inScope.has(id));
  return last === -1 ? undefined : ids[last + 1];
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
  // A detached window is an editor-groups window that holds the tabs the server gave it: its id is
  // its address, and the main window has none. The mobile layer never applies to it.
  const myWindow = boot.kind === 'detached' ? boot.wid : null;
  const detached = myWindow !== null;

  /**
   * The tab this window is showing. EMPTY means "not resolved yet".
   *
   * No id is trusted before the tab list arrives, whatever the address says: a REMEMBERED id may
   * have been closed since, and mounting a pane on it would attach to `/ws?session=` that id and
   * spawn a ghost terminal before the first broadcast could say otherwise. So a selection waits for
   * the tab list, which costs one round trip and cannot invent a session. A legacy `/<id>` waits
   * too: another window may hold that tab.
   */
  const [sessionId, setSessionIdRaw] = useState('');
  /**
   * The window cannot decide what to show until the tab list arrives.
   *
   * True for a plain `/` boot, which has no instruction and must consult what it
   * remembered — and ALSO for `?new=1`, which does. A new terminal's id comes
   * from `nextFreeId` over the live tabs, and running that against an empty list
   * hands back an id that already exists: measured, `/new` "created" a terminal
   * and silently selected tab 0 instead.
   *
   * A legacy `/<id>` names its tab outright and still waits: shown before the list, a tab a
   * detached window holds would get a pane here, and its terminal would attach and evict that
   * window's. A detached window waits like a plain `/` boot: `?tab=` names a tab, but whether it is
   * this window's is the server's to say.
   */
  const [awaitingResolve, setAwaitingResolve] = useState(true);
  const awaitingResolveRef = useRef(awaitingResolve);
  awaitingResolveRef.current = awaitingResolve;
  const [tabs, setTabs] = useState<TabMeta[]>([]);
  // The first `sessions` broadcast has landed. The pane layout does not exist before it, so no pane
  // mounts (and no terminal can be spawned for a tab that has closed) until then, on any path.
  const [sessionsReady, setSessionsReady] = useState(false);
  // The remembered selection, when it resolved to a live tab of its kind: the layout's boot choice.
  // Set in the same batch as `sessionsReady`, so the layout's first render sees it.
  const [bootSelection, setBootSelection] = useState<string | null>(null);
  const [webApps, setWebApps] = useState<WebAppLink[]>([]);
  const [maxUploadBytes, setMaxUploadBytes] = useState(DEFAULT_MAX_UPLOAD_BYTES);
  // The server announced detached windows in its last `ready`: an older one sends no flag, and a
  // client built ahead of it must not open windows that would show nothing.
  const [capDetached, setCapDetached] = useState(false);
  // The server's last `ready` said it has no detached windows. A ref beside the state: the first
  // `sessions` handler reads it in the same tick, before any render could show the state.
  const detachedUnsupportedRef = useRef(false);
  // The tabs a detached window asked to take back (design D6): the window does not close while any
  // is in flight. State, so clearing it re-runs the self-close check below.
  const [reclaiming, setReclaiming] = useState<ReadonlySet<string>>(NO_RECLAIM);
  // The first control open has not been handled yet: only then does the tab the window was opened
  // for count as one of its own, so a tab it later sent to main is never pulled back.
  const firstOpenRef = useRef(true);
  // The control socket opened and its first `sessions` has not arrived: that broadcast is the one a
  // detached window reclaims against.
  const awaitingReclaimRef = useRef(false);
  // A detached window closes itself once its last tab leaves, but not before it has held one.
  const seenOwnRef = useRef(false);
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
  const dockViewRef = useRef(dockView);
  dockViewRef.current = dockView;
  // The ONLY writer of `dockView`, so every way out of Settings comes through
  // here: another rail view, the rail toggle, the dock's close button, a
  // keybinding, a row inside the form. Leaving unmounts ConfigEditor and its
  // unsaved buffer with it (keeping it mounted would load Monaco for every
  // desktop session), so a dirty buffer asks first, the way `guardedReload` does.
  // Cancel stays on Settings and shows that buffer in Raw. The view is read from
  // a ref so this keeps its identity for everything that depends on it. A detached
  // window has no dock: nothing opens there, and no view is ever written to the
  // device-wide key the main window reads.
  const openDockView = useCallback(
    (next: DockView | null) => {
      if (detached) return;
      if (dockViewRef.current === 'settings' && next !== 'settings' && configDirtyRef.current) {
        if (!window.confirm(DISCARD_CONFIG)) {
          setCfgMode('raw');
          return;
        }
        configDirtyRef.current = false;
      }
      setDockBusy(true);
      setDockView(next);
      writeDockView(next);
    },
    [detached],
  );
  useEffect(() => {
    if (!dockBusy) return;
    const t = setTimeout(() => setDockBusy(false), DOCK_SETTLE_MS);
    return () => clearTimeout(t);
  }, [dockBusy, dockView]);

  // Whether Settings shows its form or the raw config.json editor (the "Edit
  // config.json" row opens it), and the file the browser opened into the content
  // area. Both are view state, not app state — neither persists.
  const [cfgMode, setCfgMode] = useState<ConfigEditorMode>('form');
  // Whether that editor holds text config.json does not — read only by the
  // Reload and leave-Settings guards, so a ref: nothing renders from it.
  const configDirtyRef = useRef(false);
  const onConfigDirty = useCallback((dirty: boolean) => {
    configDirtyRef.current = dirty;
  }, []);
  // The Edit config.json row goes with the form as Raw opens (ConfigEditor then
  // takes focus), and the form comes back NEW as Raw closes, with the editor's
  // `‹ Settings` hidden under the focus it held. So the way back hands focus to
  // the row that opened the editor, here, where both are in reach. Only when
  // focus was lost: never from a text field, or from anything else it still holds.
  const editConfigRef = useRef<HTMLButtonElement>(null);
  const shownCfgMode = useRef(cfgMode);
  useLayoutEffect(() => {
    if (shownCfgMode.current === cfgMode) return;
    shownCfgMode.current = cfgMode;
    if (cfgMode === 'form' && focusLost()) editConfigRef.current?.focus();
  }, [cfgMode]);
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
  // The New-tab chooser of a detached window, which has no dock to host it.
  const [newTabDialog, setNewTabDialog] = useState(false);
  // Where the [+] popover anchors (viewport coords, captured at open).
  // The last tab was closed: the New-tab page IS the content (no dead pane, no
  // auto-respawn). Cleared by any navigation or creation.
  const [chooserPage, setChooserPage] = useState(false);
  const chooserPageRef = useRef(chooserPage);
  chooserPageRef.current = chooserPage;
  const [dirtyTabs, setDirtyTabs] = useState<{ [id: string]: boolean }>({});
  const [sheetTabId, setSheetTabId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The drawer holds the viewport effect's layout still while it is open, the way
  // a native selection does. A ref, not state: the effect must not re-subscribe
  // (that drops `--app-height`), and nothing renders from it.
  const drawerHoldRef = useRef<DrawerHold | null>(null);
  // The viewport effect's release path, installed while it is subscribed. It takes
  // what the ending hold recorded, because the hold itself is gone by the time the
  // effect's next frame runs.
  const viewportReleaseRef = useRef<(kbdWasUp: boolean) => void>(() => {});
  const openDrawer = useCallback(() => {
    const hold = drawerHoldRef.current;
    // Reopening over a hold that was waiting on a picker takes it back: the
    // drawer's own close releases it now. The keyboard state recorded first is
    // still worth restoring, and so is one this opening finds up.
    if (hold) {
      hold.picker = false;
      hold.kbdWasUp ||= softKeyboardUp();
    } else drawerHoldRef.current = { kbdWasUp: softKeyboardUp(), picker: false };
    setDrawerOpen(true);
  }, []);
  const releaseDrawerHold = useCallback(() => {
    const kbdWasUp = drawerHoldRef.current?.kbdWasUp ?? false;
    drawerHoldRef.current = null;
    viewportReleaseRef.current(kbdWasUp);
  }, []);
  // The ONE way the drawer closes. A close path that skipped the release would
  // strand the terminal at the keyboard-up height.
  const closeDrawer = useCallback(
    (opts?: DrawerCloseOptions) => {
      setDrawerOpen(false);
      const hold = drawerHoldRef.current;
      if (!hold) return;
      if (opts?.holdUntil === 'picker') {
        // The native picker may take the IME with it, and the page cannot see that
        // happen, so the layout stays held until the picker reports back.
        hold.picker = true;
        return;
      }
      releaseDrawerHold();
    },
    [releaseDrawerHold],
  );
  // A picker's return: the only thing that lets go of a picker hold. No clock —
  // choosing a file or taking a photo takes as long as it takes.
  const releasePickerHold = useCallback(() => {
    if (drawerHoldRef.current?.picker) releaseDrawerHold();
  }, [releaseDrawerHold]);
  const [fontFamilies, setFontFamilies] = useState<string[]>([]);
  // The LATEST selection, ahead of React, for the reason `tabsRef` gives below: a
  // close-navigation only queues `setSessionId`, and the next broadcast must
  // decide from the tab it chose, not from the dead one against a list that no
  // longer holds it (the neighbour rule then fell back to the FIRST tab). So
  // every navigation goes through `showTab`, and a render does not write the
  // ref: a click renders ahead of a socket message and would put the old id back.
  const sessionIdRef = useRef(sessionId);
  // The ONE choke point every navigation ends at (defined once the layout hook exists, below):
  // with editor groups it shows the tab in the layout, else it sets the selection as before.
  const setSessionIdRef = useRef<(id: string) => void>(setSessionIdRaw);
  const showTab = useCallback((id: string) => {
    // Before the ref: a tab another window holds is never this window's selection (see `setSessionId`).
    if (heldElsewhere(tabsRef.current, visibleTabsRef.current, id)) return;
    sessionIdRef.current = id;
    setSessionIdRef.current(id);
  }, []);
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

  // The LATEST tab list, ahead of React: whatever changes the list (a `sessions`
  // broadcast, a drop, a split's fuse sync) writes it here first, then queues the
  // same change with `setTabs`. A render does not write it. A pointer event
  // renders before a queued broadcast does, and copying `tabs` back here then put
  // the older list in front of the next drop, which went out without the tab
  // that broadcast brought. So a new `setTabs` must write this too.
  //
  // It is the FULL list, hidden tabs included: a terminal id, a reorder and a group's order all
  // need every tab the server has. What THIS window shows is `visibleTabs` below, and
  // `visibleTabsRef` is its twin ahead of React. It is written beside every write of this one, always
  // as `visibleOf(tabsRef.current, optimisticRef.current)`, so a stale frame cannot drop a move.
  const tabsRef = useRef(tabs);
  // Moves this window made and the server has not confirmed yet. State, so the expiry re-renders;
  // `optimisticRef` is the same map ahead of React, and every writer writes the ref first.
  const [optimisticWindow, setOptimisticWindow] = useState<WindowOverrides>(NO_OVERRIDES);
  const optimisticRef = useRef(optimisticWindow);
  const optimisticTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** The tabs a window shows: the ones whose owner (the held move, else the server's) is this window. */
  const visibleOf = useCallback(
    (list: TabMeta[], overrides: WindowOverrides): TabMeta[] => {
      const shown = list.filter((t) => {
        const moved = overrides.get(t.id);
        return (moved !== undefined ? moved : (t.window ?? null)) === myWindow;
      });
      // The list itself when nothing is hidden, so a window no detached window touches renders as always.
      return shown.length === list.length ? list : shown;
    },
    [myWindow],
  );
  const visibleTabs = useMemo(
    () => visibleOf(tabs, optimisticWindow),
    [visibleOf, tabs, optimisticWindow],
  );
  const visibleTabsRef = useRef(visibleTabs);
  const syncVisible = useCallback(() => {
    visibleTabsRef.current = visibleOf(tabsRef.current, optimisticRef.current);
  }, [visibleOf]);
  const writeTabsRef = useCallback(
    (list: TabMeta[]) => {
      tabsRef.current = list;
      syncVisible();
    },
    [syncVisible],
  );
  const writeOptimistic = useCallback(
    (next: WindowOverrides) => {
      optimisticRef.current = next;
      syncVisible();
      setOptimisticWindow(next);
    },
    [syncVisible],
  );
  /** End the hold on these ids: the server agreed, or its time ran out. */
  const dropOptimistic = useCallback(
    (ids: string[]) => {
      const next = new Map(optimisticRef.current);
      for (const id of ids) {
        next.delete(id);
        clearTimeout(optimisticTimers.current.get(id));
        optimisticTimers.current.delete(id);
      }
      if (next.size !== optimisticRef.current.size) writeOptimistic(next);
    },
    [writeOptimistic],
  );
  const holdOptimistic = useCallback(
    (ids: string[], owner: string | null) => {
      const next = new Map(optimisticRef.current);
      for (const id of ids) {
        next.set(id, owner);
        clearTimeout(optimisticTimers.current.get(id));
        optimisticTimers.current.set(
          id,
          setTimeout(() => dropOptimistic([id]), OPTIMISTIC_MOVE_MS),
        );
      }
      writeOptimistic(next);
    },
    [writeOptimistic, dropOptimistic],
  );
  useEffect(() => {
    const timers = optimisticTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);
  const dirtyRef = useRef(dirtyTabs);
  dirtyRef.current = dirtyTabs;
  const newTabOpenRef = useRef(newTabOpen);
  newTabOpenRef.current = newTabOpen;

  // The active tab drives what the content area shows. A freshly navigated id
  // that hasn't been broadcast yet is a terminal (spawn-on-attach semantics).
  const activeTab: TabMeta = visibleTabs.find((t) => t.id === sessionId) ?? {
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
    update: writeSettings,
    applyServer: applyServerSettings,
  } = useSettings(sendSettings);
  const { config: extraKeys, applyServer: applyExtraKeys } = useExtraKeys(sendExtra);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // The project this device reads in Source Control: its stored choice while that
  // is still in the synced list (another device may have removed it), else the
  // first project. The status store polls THIS project only, and counts only
  // subscribers that are visible, so with the view closed nothing is read.
  const activeScmRepo = resolveActiveRepo(settings.scmRepos, settings.scmActiveRepo);
  const activeScmRepoRef = useRef(activeScmRepo);
  activeScmRepoRef.current = activeScmRepo;
  useEffect(() => {
    scmStatusStore.setActiveRepo(activeScmRepo);
    commentsStore.setActiveRepo(activeScmRepo);
  }, [activeScmRepo]);
  // Every status answer carries the comments' rev: the backstop for an `scmComments`
  // frame this window missed (the other is the refresh on every reconnect).
  useEffect(() => connectCommentsToStatus(scmStatusStore, commentsStore), []);

  // Every theme-mode TRANSITION bumps this generation. A pending import compares
  // the one it was submitted under, so any mode change in between supersedes it —
  // a round trip back to the same mode included, after which the user may already
  // have picked a newer theme the late import must not overwrite. Counted where a
  // change is REQUESTED (a local update, a broadcast as it arrives), not where it
  // renders: React can fold two broadcasts into one render, and Fixed → Match
  // system → Fixed would then render as no change at all.
  const themeModeRef = useRef(settings.themeMode);
  const themeModeGenRef = useRef(0);
  const noteThemeMode = useCallback((mode: ThemeMode) => {
    if (mode === themeModeRef.current) return;
    themeModeRef.current = mode;
    themeModeGenRef.current += 1;
  }, []);
  const updateSettings = useCallback(
    (partial: Partial<ClientSettings>) => {
      if (partial.themeMode) noteThemeMode(partial.themeMode);
      writeSettings(partial);
    },
    [noteThemeMode, writeSettings],
  );
  const applySettings = useCallback(
    (server: JsonObject) => {
      noteThemeMode(themeModeAfter(themeModeRef.current, server));
      applyServerSettings(server);
    },
    [noteThemeMode, applyServerSettings],
  );

  // What this client PAINTS, resolved from its OWN colour scheme. It is the only
  // theme id any rendering path reads — the CSS tokens below, the terminals, the
  // `themes` broadcast, main.tsx's pre-paint — and none of them reads
  // `settings.themeId`, which in Match system is only what the server exports. In
  // fixed mode the two are equal.
  const prefersDark = useSystemPrefersDark();
  const prefersDarkRef = useRef(prefersDark);
  prefersDarkRef.current = prefersDark;
  const shownThemeId = resolveThemeId(settings, prefersDark);
  const shownThemeIdRef = useRef(shownThemeId);
  shownThemeIdRef.current = shownThemeId;
  // The terminals take the id through the same `settings` prop they always read
  // it from, so this override is the whole terminal-side change. Memoized so a
  // render that changes neither does not hand every pane a new object.
  const paneSettings = useMemo(
    () => (shownThemeId === settings.themeId ? settings : { ...settings, themeId: shownThemeId }),
    [settings, shownThemeId],
  );

  // The server exports `themeId` (theme.sh, theme.tmux, the Claude theme). In
  // Match system this client writes it when ITS scheme actually changes while the
  // app is open, so the export follows the latest real switch. Never on boot or
  // on a reconnect: a device that opens in a different scheme from the last one
  // to write would otherwise overwrite the export on every load, and two devices
  // in different schemes would fight over it. Keyed on the scheme, not on the
  // resolved id, which also moves when a slot is picked or a settings broadcast
  // arrives — neither of those is a scheme change.
  const lastSchemeRef = useRef(prefersDark);
  useEffect(() => {
    if (lastSchemeRef.current === prefersDark) return;
    lastSchemeRef.current = prefersDark;
    const s = settingsRef.current;
    if (s.themeMode !== 'system') return;
    const id = resolveThemeId(s, prefersDark);
    if (id !== s.themeId) updateSettings({ themeId: id });
  }, [prefersDark, updateSettings]);

  const mobileActive = !detached && resolveMobileMode(settings.mobileMode);
  const mobileActiveRef = useRef(mobileActive);
  mobileActiveRef.current = mobileActive;

  // Switching the mobile layer ON drops the whole dock (it never renders there),
  // and Settings' raw config.json buffer goes with it: the same loss leaving
  // Settings asks about, so the same question, asked BEFORE the change is applied
  // or persisted. Cancel leaves the setting and the editor as they were.
  // Known gap, not fixed: `mobileMode: 'auto'` re-resolves on every render from
  // the device itself (`isMobileDevice`: a coarse pointer, touch points), so a
  // desktop that starts reporting one (a convertible losing its keyboard, the
  // devtools device toolbar) flips `mobileActive` with no user action to ask
  // against, and the editor still unmounts.
  const changeSettings = useCallback(
    (partial: Partial<ClientSettings>) => {
      const intoMobile =
        partial.mobileMode !== undefined &&
        !mobileActiveRef.current &&
        resolveMobileMode(partial.mobileMode);
      if (intoMobile && configDirtyRef.current) {
        if (!window.confirm(DISCARD_CONFIG)) return;
        configDirtyRef.current = false;
      }
      updateSettings(partial);
    },
    [updateSettings],
  );

  // The scale's `--ctl-h` grows under `:root[data-mobile='true']`. It is an
  // attribute rather than a media query because auto mode resolves from
  // `maxTouchPoints`, not the pointer type (`resolveMobileMode`) — only the
  // resolved value agrees with `.app.mobile`. It sits on <html>, not `.app`,
  // because Radix portals menus and popups outside `.app`.
  useEffect(() => {
    if (!mobileActive) return;
    const root = document.documentElement;
    root.dataset.mobile = 'true';
    return () => {
      delete root.dataset.mobile;
    };
  }, [mobileActive]);

  // Re-skin the whole app when the theme changes (boot is handled pre-paint in
  // main.tsx). useLayoutEffect so tokens land before the browser paints the new
  // frame — themes a panes-only workspace too, independent of any terminal.
  useLayoutEffect(() => {
    applyThemeTokens(getProfile(shownThemeId));
  }, [shownThemeId]);

  // `--font-mono` was READ in four places (markdown code blocks, the tips panel)
  // and SET in none, so all of them silently fell back to `ui-monospace` while
  // the terminal and the editor used the configured face. Same shape as the
  // editor-theme bug: a surface quietly ignoring the user's setting.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--font-mono', settings.fontFamily);
  }, [settings.fontFamily]);

  // Editor groups are a desktop feature: the content area is a grid of panes, each with its own
  // tab strip, in the main window and in a detached one (which is never on the mobile layer). With
  // the mobile layer on, the hook draws ONE virtual pane holding the window's tab and neither reads
  // nor writes the saved layout. While groups are on, the layout is the source of truth for the
  // selection: `sessionId` is read off the focused pane's active tab (the effect below), and every
  // navigation reaches the layout through `setSessionId`.
  const groupsEnabled = !mobileActive;
  const groupsEnabledRef = useRef(groupsEnabled);
  groupsEnabledRef.current = groupsEnabled;
  const {
    layout,
    rects: paneRects,
    sashes,
    focusedActive,
    hasSavedLayout,
    show: showInLayout,
    place: placeInLayout,
    commit: commitLayoutValue,
    setLive: setLiveLayout,
    heldTabIds,
    pending: pendingTabs,
    stripTabs,
  } = useEditorGroups({
    enabled: groupsEnabled,
    // Only what this window shows: a pane holds visible ids, and the visible order is a
    // subsequence of the full one (`tabOrder`, which every layout operation reads, stays full).
    tabs: visibleTabs,
    // A detached window keeps its own layout: `window.open` may have copied the opener's.
    storageKey: layoutKey(myWindow),
    ready: sessionsReady,
    bootSelection,
    // The New-tab page selects nothing, though `sessionId` keeps the closed tab's id. Handed to the
    // hook, that id would come back as a terminal the moment the mobile layer flips: the one-pane
    // path draws an unlisted id as a fresh terminal, and the restore keeps it pending, so its pane
    // would attach and spawn a shell on the id that was just closed.
    sessionId: chooserPage ? '' : sessionId,
  });
  // The layout as of the last render, for handlers that must keep their identity: a sash frame
  // changes `layout` every frame, and a strip whose props changed with it would redraw each time.
  // A layout command (`commitLayout`) and a drag frame also write it ahead of the render.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const focusedLeafId = layout?.focused ?? null;

  // The choke point (see `showTab`). A tab the client picked an id for (a new terminal) is in no
  // list yet; the layout keeps it pending so a broadcast that lacks it does not drop the pane that
  // is about to create it. Resolving the kind from `tabsRef` (ahead of the render) is what tells
  // a tab this window just learned about from one it has not.
  const setSessionId = useCallback(
    (id: string) => {
      // A tab another window holds is not shown here. Resolving its kind from the full list would
      // let `show` put it in a pane, and the terminal there would attach and evict the other
      // window's ("Opened somewhere else.").
      if (heldElsewhere(tabsRef.current, visibleTabsRef.current, id)) return;
      if (!groupsEnabled) {
        setSessionIdRaw(id);
        return;
      }
      const kind = tabsRef.current.find((t) => t.id === id)?.kind;
      showInLayout({ id, kind: kind ?? 'terminal', known: kind !== undefined });
    },
    [groupsEnabled, showInLayout],
  );
  setSessionIdRef.current = setSessionId;

  // The selection is a READING of the layout. `sessionIdRef` first: it is what the handlers read
  // (`switchSession`, `dispatch`, `createTab`'s exclude, `toggleGroup`), ahead of the render. A
  // pane showing nothing (the New-tab page) keeps the dead id, as the persist effect expects.
  useEffect(() => {
    if (!groupsEnabled || focusedActive === null) return;
    sessionIdRef.current = focusedActive;
    setSessionIdRaw(focusedActive);
  }, [groupsEnabled, focusedActive]);

  // A blank window leaves the New-tab page through a layout change alone (dragging another
  // window's tab to a pane edge): whatever shows a tab again is not the page. Only with groups on:
  // on the one-pane path the controller owns the page.
  useEffect(() => {
    if (groupsEnabled && focusedActive !== null) setChooserPage(false);
  }, [groupsEnabled, focusedActive]);

  // And the other way: with groups on, a focused pane that shows nothing IS the New-tab page. The
  // controller decides that only for an empty list, and a pane can lose its only tab while the list
  // is not empty (its id came back as another kind, which joins the pane without becoming its
  // selection). A layout effect, so the blank body is never painted.
  const layoutReady = layout !== null;
  useLayoutEffect(() => {
    if (groupsEnabled && layoutReady && focusedActive === null) setChooserPage(true);
  }, [groupsEnabled, layoutReady, focusedActive]);
  // The page as of THIS render. The layout effect above sets `chooserPage` one render late, and
  // React runs the passive effects of the render before it first, so an effect reading
  // `chooserPage` alone would take that render's dead id for a selection.
  const onChooserPage = chooserPage || (groupsEnabled && layoutReady && focusedActive === null);
  const onChooserPageRef = useRef(onChooserPage);
  onChooserPageRef.current = onChooserPage;

  // Terminal ids ever seen in a broadcast — lets the controller's flat close-navigation (the mobile
  // layer, which has no layout to reconcile) tell a killed terminal from a fresh one.
  const seenTermIdsRef = useRef<Set<string>>(new Set());
  const contentRef = useRef<HTMLDivElement>(null);

  // Normalise the address to `/` and spend the boot intent — ONCE.
  //
  // `replaceState`, never `pushState`: normalising must not leave a history
  // entry, or ← would take the user back to an address that no longer means
  // anything. A detached window keeps its own address, which is the whole point of it having
  // one (`/window/<wid>`, minus the `?tab=` that named the tab it was opened for; a retired
  // pop-out address becomes one too). The `new` intent creates exactly one terminal and
  // is cleared with the query, so a reload cannot create a second.
  const bootSpent = useRef(false);
  // `createTab` is defined further down; a ref lets the first-broadcast handler
  // reach it without hoisting the whole callback above the state it closes over.
  const createTabRef = useRef<((spec: CreateSpec) => void) | null>(null);
  // Likewise `moveTabsToWindow`, which the reclaim in that handler calls.
  const moveTabsRef = useRef<(ids: string[], target: string | null) => boolean>(() => false);
  // Review urls this window sent a `createTab` for and has no answer to yet, with
  // when it was sent. See `openReview`.
  const pendingReviewsRef = useRef(new Map<string, number>());
  useEffect(() => {
    if (bootSpent.current) return;
    bootSpent.current = true;
    const home = boot.kind === 'detached' ? windowPath(boot.wid) : '/';
    if (location.pathname !== home || location.search) {
      history.replaceState(null, '', home);
    }
  }, [boot]);

  // Remember what this window is showing, from ONE place.
  //
  // Every navigation path ends at `setSessionId` — selectTab, the controller's
  // navigate effect, the pane reconcile, the close-nav, the first-broadcast
  // resolve — so hooking any single one of them would miss the rest. That is the
  // same reason the group auto-expand is one centralized effect and not a line
  // inside selectTab.
  //
  // A detached window writes its own copy under a key of its own and never the device-wide one:
  // that is what the MAIN window chose last, and a detached window shares its origin, so it must
  // not move it.
  //
  // The window's own copy (sessionStorage) is idempotent, so this effect may
  // rewrite it on every broadcast. The DEVICE-wide copy (localStorage, read only by
  // a window with no selection of its own — a relaunched PWA) is shared by every
  // window, so it is written only when this window's selection really changes:
  // `tabs` is replaced on every `sessions` broadcast, a rename included, and a
  // window that merely heard one would overwrite the tab another window just chose.
  //
  // `lastStoredRef` is what this window last put in the shared key — or, after a
  // boot that restored its remembered tab, that tab (see the first-broadcast
  // resolve). A change is a different id OR kind — ids are recycled, and the same
  // id as another kind is another tab. It is cleared while there is nothing to
  // store, so the next selection always writes:
  //  - the selected id resolves to no tab (closed, or just created and not yet
  //    broadcast — the write then lands when the broadcast delivers it);
  //  - the window is on the New-tab page, where `sessionId` is the dead id and
  //    nothing is selected, so another window's tab reusing it is not our choice.
  const lastStoredRef = useRef<WindowSelection | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    const selection = selectionFor(visibleTabs, sessionId);
    // The page selects nothing, whatever the id it keeps has come back as.
    writeSelection(onChooserPage ? null : selection, myWindow);
    if (!selection || onChooserPage) {
      lastStoredRef.current = null;
      return;
    }
    if (detached) return;
    const last = lastStoredRef.current;
    if (last && last.id === selection.id && last.kind === selection.kind) return;
    lastStoredRef.current = selection;
    writeLastTab(selection);
  }, [sessionId, visibleTabs, onChooserPage, myWindow, detached]);

  // Keep the registry's focused slot on the focused pane: the shared input surfaces (soft keyboard,
  // extra-keys, paste, upload) route to the pane's terminal, and a pane showing no terminal has
  // none to route to.
  useEffect(() => {
    if (focusedLeafId !== null) registry.setFocusedSlot(focusedLeafId);
  }, [focusedLeafId, registry]);

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
  // What the import in flight is FOR, captured when it was submitted: the answer
  // has no correlation id and can land long after the user switched slot or mode.
  // The mode generation rides along so the answer can tell whether ANY mode change
  // happened since. One at a time — the form disables Add while `importingTheme`.
  const importTargetRef = useRef<{ target: ThemeTarget; modeGen: number }>({
    target: { mode: 'fixed' },
    modeGen: 0,
  });
  const onImportTheme = useCallback((source: string, target: ThemeTarget) => {
    if (wsControlRef.current?.sendImportTheme(source)) {
      importTargetRef.current = { target, modeGen: themeModeGenRef.current };
      setImportingTheme(true);
    }
  }, []);

  const copyDiagnostics = useCallback(() => {
    // The focused pane's terminal, else the first pane that has one.
    let term = registry.focusedApi()?.term() ?? null;
    registry.forEachApi((api) => {
      term ??= api.term();
    });
    const id = shownThemeIdRef.current;
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
  // on mobile. A detached window has no dock, so it takes the panel too. One action,
  // resolved here, so no caller has to know which.
  const historyAction = useMemo<ToastAction>(
    () => ({
      label: 'Open history',
      onClick: () =>
        mobileActiveRef.current || detached
          ? setPanel('dictationHistory')
          : openDockView('dictation'),
    }),
    [openDockView, detached],
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
  // The soft KEYBOARD is additionally blocked when no terminal is on screen: it
  // types into a PTY, and an editor tab has Monaco's own input instead.
  const kbdBlocked = useCallback(
    () =>
      panelRef.current !== 'none' ||
      newTabOpenRef.current ||
      chooserPageRef.current ||
      activeKindRef.current !== 'terminal',
    [],
  );
  // The BAR is not, and that difference is the whole point of it being always
  // present: it now has a second destination (an editor, via `sendKeyToEditor`),
  // so "this tab is not a terminal" no longer means "there is nowhere to send
  // this". It shares the panel/chooser guards, which still mean exactly that.
  const barBlocked = useCallback(
    () => panelRef.current !== 'none' || newTabOpenRef.current || chooserPageRef.current,
    [],
  );

  // Shared input surfaces (soft keyboard, extra-keys bar) route to the focused
  // terminal pane. Reading the registry at call time keeps these stable.
  const sendInput = useCallback(
    (t: string) => registry.focusedApi()?.sendInput(t) ?? false,
    [registry],
  );
  /**
   * The extra-keys bar offers every key here BEFORE encoding it to PTY bytes.
   *
   * On a terminal tab this returns false immediately and nothing changes. On an
   * editor tab it drives Monaco by COMMAND — measured: Monaco 0.55 takes input
   * through the EditContext API and ignores synthetic keyboard events entirely,
   * so there is no event to forward and `editor.trigger` is the only route.
   * The bar is present on every mobile tab but a review (it is the only way to the
   * drawer), so without this its keys would be visible and dead on half the tabs.
   */
  const sendKeyToEditor = useCallback(
    (name: string, mods: KeyMods) => {
      // The ACTIVE TAB decides, not the pane registry. Panes stay mounted while
      // their tab exists, so a terminal from another tab is still registered and
      // still "focused" — checking that sent every key to an invisible shell and
      // the editor never saw one. Measured: END did nothing on an editor tab.
      if (activeKindRef.current === 'terminal') return false;
      const editor = focusedEditor();
      if (!editor) return false;
      const action = editorKeyAction(name, mods);
      if (action.kind === 'none') return false;
      if (action.kind === 'type') editor.type(action.text);
      else editor.run(action.id);
      // The press moved DOM focus onto the bar's button; put it back or the
      // NEXT press has nothing to act on.
      editor.focus();
      return true;
    },
    [],
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
  // They answer whether a picker actually opened: the drawer holds the layout for
  // a picker, and must not hold it for a toast.
  const guardedOpenPicker = useCallback((): boolean => {
    const api = registry.focusedApi();
    if (!api) {
      showToast('Open a terminal tab to upload');
      return false;
    }
    return api.openPicker(releasePickerHold);
  }, [registry, showToast, releasePickerHold]);
  const guardedOpenImagePicker = useCallback((): boolean => {
    const api = registry.focusedApi();
    if (!api) {
      showToast('Open a terminal tab to upload');
      return false;
    }
    return api.openImagePicker(releasePickerHold);
  }, [registry, showToast, releasePickerHold]);
  // Download a file (or glob → ZIP) OFF the server machine. The path prompt is
  // deliberately plain — paths are usually copied straight out of the terminal.
  const doDownload = useCallback(() => {
    const p = window.prompt(
      'Download from server — absolute path, glob, or directory\n(e.g. /home/user/notes/report.md or /home/user/notes/*.md)',
    );
    // `trim()` only DETECTS a blank entry. The path goes out exactly as typed: a name
    // may end in a space, and trimming downloaded its sibling. A leading space is not
    // absolute, so the server refuses it and the toast says so.
    //
    // A path with a line break cannot be entered HERE: `window.prompt` sanitises the
    // value it returns before this code sees it (Chrome strips the break, Firefox turns
    // it into a space), and there is no paste event to intercept in a native dialog. The
    // Explorer's own download passes the row's path unchanged and covers that case. The
    // check below is for a value that does arrive with one, so it is never sent as the
    // sibling without it.
    if (!p?.trim()) return;
    if (hasLineBreak(p)) {
      showToast(LINE_BREAK_MESSAGE);
      return;
    }
    void downloadFromServer(p).then((error) => {
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
  const switchSession = useCallback(
    (id: string) => {
      // The page keeps the closed tab's id, so naming it there is not "already shown".
      if (id === sessionIdRef.current && !chooserPageRef.current) return;
      setChooserPage(false);
      showTab(id);
    },
    [showTab],
  );

  // ── Layout commands ─────────────────────────────────────────────────────────
  // Every change of the pane layout from a gesture goes through here: it computes from the newest
  // layout this window knows and hands the result to the hook, which reconciles it against the tab
  // list before keeping it. Refused while a sash drag owns the layout: the next drag frame
  // re-applies the drag's cumulative delta to the layout it began on, and would undo the command.
  const sashStartRef = useRef<PaneLayout | null>(null);
  // The layout the last drag frame handed over, to tell it apart from a layout a broadcast made.
  const sashFrameRef = useRef<PaneLayout | null>(null);
  const commitLayout = useCallback(
    (compute: (current: PaneLayout) => PaneLayout) => {
      const current = layoutRef.current;
      if (!current || sashStartRef.current !== null) return;
      const next = compute(current);
      if (next === current) return;
      // Ahead of the render, as a drag frame does: a second command in the same handler (the
      // collapse guard switches every pane it protects, one after another) must build on this one,
      // not on the layout of the last render, which would put the first pane back.
      layoutRef.current = next;
      commitLayoutValue(next);
    },
    [commitLayoutValue],
  );
  /** The server's tab order: what every layout operation that can change an active tab reads. */
  const tabOrder = useCallback(() => tabsRef.current.map((t) => t.id), []);
  /** The ids a pane holds, in the server's order (its strip). */
  const leafTabIds = useCallback((leafId: string): string[] => {
    const leaf = layoutRef.current && leaves(layoutRef.current).find((l) => l.id === leafId);
    if (!leaf) return [];
    const held = new Set(leaf.tabs.map((t) => t.id));
    return tabsRef.current.filter((t) => held.has(t.id)).map((t) => t.id);
  }, []);
  /** A tab as the layout holds it, else as the list does; null when neither knows it. */
  const refOfTab = useCallback((current: PaneLayout, id: string): TabRef | null => {
    const held = leafHolding(current, id)?.tabs.find((t) => t.id === id);
    if (held) return held;
    const listed = tabsRef.current.find((t) => t.id === id);
    return listed ? { id: listed.id, kind: listed.kind } : null;
  }, []);
  const focusLeafById = useCallback(
    (leafId: string) => commitLayout((current) => focusLeaf(current, leafId)),
    [commitLayout],
  );
  /** Focus the pane showing a tab (a click inside a non-terminal pane's body). */
  const focusPaneOf = useCallback(
    (tabId: string) =>
      commitLayout((current) => {
        const leaf = leafHolding(current, tabId);
        return leaf ? focusLeaf(current, leaf.id) : current;
      }),
    [commitLayout],
  );

  // A new terminal's id: the client picks one that no tab and no pane holds (any may not be
  // broadcast yet), and the PTY spawns on the first /ws attach.
  const freshTerminalId = useCallback((): string => {
    const exclude = [...tabsRef.current.map((t) => t.id), sessionIdRef.current];
    const current = layoutRef.current;
    if (current) for (const l of leaves(current)) for (const t of l.tabs) exclude.push(t.id);
    return nextFreeId(exclude);
  }, []);

  // Apply one declarative effect from the workspace controller.
  const applyEffect = useCallback(
    (e: WorkspaceEffect) => {
      switch (e.type) {
        case 'navigate':
          // One mode now. `push` / `replace` / `set` existed only to say what to
          // do with the URL, and nothing writes the URL.
          showTab(e.id);
          break;
        case 'chooserPage':
          setChooserPage(e.value);
          break;
        case 'split':
          commitLayout((current) => {
            const tab = refOfTab(current, e.tabId);
            return tab ? splitPane(current, e.leafId, e.side, tab, tabOrder()) : current;
          });
          break;
        case 'splitLone': {
          // The tab is its pane's only one, so there is nothing to move: a NEW terminal opens in
          // the new pane. Its id is picked here and the layout holds it pending until a broadcast
          // lists it (the attach is what creates it). Forgotten as "seen", so a recycled id that was
          // once killed is not read as closed by the flat close-navigation.
          const id = freshTerminalId();
          pendingTabs.add(id);
          seenTermIdsRef.current.delete(id);
          commitLayout((current) =>
            splitPane(current, e.leafId, e.side, { id, kind: 'terminal' }, tabOrder()),
          );
          break;
        }
      }
    },
    [showTab, commitLayout, refOfTab, tabOrder, freshTerminalId, pendingTabs],
  );

  // Translate a navigation gesture/socket event into effects (pure decision) and
  // apply them. The decision logic is unit-tested in workspaceController.test.ts.
  const dispatch = useCallback(
    (event: WorkspaceEvent) => {
      // `showTab` refuses another window's tab, but the decision clears the New-tab page before it
      // navigates. On the phone the page keeps the closed id, and the one-pane path draws that id
      // as a fresh terminal: refused, the navigation must leave the page alone too.
      if (
        (event.type === 'selectTab' || event.type === 'tabCreated') &&
        heldElsewhere(tabsRef.current, visibleTabsRef.current, event.id)
      ) {
        return;
      }
      const effects = decide(event, {
        sessionId: sessionIdRef.current,
        // What this window shows: close-navigation and the empty-list rule read nothing else.
        tabs: visibleTabsRef.current,
        mobileActive: mobileActiveRef.current,
        seenTermIds: seenTermIdsRef.current,
        detached,
        groups: groupsEnabledRef.current,
        leafOf: (tabId) => {
          const leaf = layoutRef.current && leafHolding(layoutRef.current, tabId);
          return leaf ? { id: leaf.id, count: leaf.tabs.length } : null;
        },
        holdsPending:
          layoutRef.current !== null &&
          leaves(layoutRef.current).some((l) => l.tabs.some((t) => pendingTabs.has(t.id))),
      });
      for (const e of effects) applyEffect(e);
    },
    [applyEffect, detached, pendingTabs],
  );

  // Select a tab: show it where it already is (its pane activates it and takes focus), else in the
  // focused pane. Every selection is an ordinary navigation.
  const selectTab = useCallback((id: string) => dispatch({ type: 'selectTab', id }), [dispatch]);

  // Collapsing a group is guarded per pane: every pane showing one of its tabs needs a way out
  // inside its own strip. With groups off (the mobile layer) there is one tab on show,
  // and none on the New-tab page, which keeps the closed tab's id in `sessionId`: another window
  // can recycle that id into a group, which must then neither unfold nor drive the guard.
  const activeKey = layout
    ? leaves(layout)
        .map((l) => l.active ?? '')
        .join('\0')
    : '';
  const activeIds = useMemo(
    () =>
      groupsEnabled
        ? activeKey.split('\0').filter((id) => id !== '')
        : sessionId && !onChooserPage
          ? [sessionId]
          : [],
    [groupsEnabled, activeKey, sessionId, onChooserPage],
  );
  const stripOf = useCallback(
    (tabId: string): string[] => {
      if (!groupsEnabledRef.current) return visibleTabsRef.current.map((t) => t.id);
      const leaf = layoutRef.current && leafHolding(layoutRef.current, tabId);
      return leaf ? leafTabIds(leaf.id) : [];
    },
    [leafTabIds],
  );
  const switchTo = useCallback(
    (fromId: string, toId: string) => {
      if (!groupsEnabledRef.current) {
        selectTab(toId);
        return;
      }
      commitLayout((current) => {
        const leaf = leafHolding(current, fromId);
        return leaf ? activate(current, leaf.id, toId) : current;
      });
    },
    [selectTab, commitLayout],
  );

  // Tab-group model + collapse view state (state, effects, and the group ops all
  // colocated). App keeps only the optimistic strip-reorder handlers below, which
  // read `tabGroups.collapsedRef`.
  const tabGroups = useTabGroups({
    // This window's tabs for collapse, switch, Close all and Remove; the full list only for the
    // order an "Add to group" sends, which must keep every other window's tabs in place.
    tabs: visibleTabs,
    activeIds,
    stripOf,
    switchTo,
    tabsRef: visibleTabsRef,
    fullTabsRef: tabsRef,
    dirtyRef,
    wsRef: wsControlRef,
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

  // Drag-to-pane: the tab being dragged by a strip, or null. While set, every pane shows its drop
  // overlay; a drop on an edge or the centre is resolved against it.
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const dragTabIdRef = useRef(dragTabId);
  dragTabIdRef.current = dragTabId;
  // A tab dragged in from ANOTHER window is over this one. This window has no local drag then
  // (`dragTabId` is null), so the overlays and the lit strips are driven by this instead.
  const [externalDrag, setExternalDrag] = useState(false);
  // Ends `externalDrag` once the foreign drag has gone quiet (see the listeners below).
  const externalIdleRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The "save first" toast was shown for the dirty drag now hovering: once per entry into the window.
  const dirtyToastRef = useRef(false);
  // A `drop` landed in THIS window since the last drag of its own began: whatever took it, the tab
  // was not handed to another window, so the source's `dragend` must not remove it.
  const localDropRef = useRef(false);
  const onDragTab = useCallback((id: string | null) => {
    if (id !== null) {
      localDropRef.current = false;
      // A drag of this window's own ends a foreign one still waiting out its idle clock: read as
      // foreign, every strip would light whole and resolve no boundary, and the reorder would be lost.
      clearTimeout(externalIdleRef.current);
      dirtyToastRef.current = false;
      setExternalDrag(false);
    }
    setDragTabId(id);
  }, []);
  // A pill that unmounts mid-drag (a broadcast removed its tab, another window moved it) fires no
  // `dragend`, so the id would stay set and every pane would keep its drop overlay. A drag also
  // ends at the window: `dragend` on its source, `drop` on its target. Capture phase, so a handler
  // that stops propagation cannot hide it. The clear WAITS for the event to finish: the overlay's
  // own `drop` handler reads the id, and a discrete event's update is rendered before the event
  // reaches its target, so clearing at once would unmount the overlay and lose the drop.
  //
  // The same listeners tell this window about a drag that is NOT its own. A `dragover` with no local
  // drag live is a tab from another window (its id is hidden until the drop, so the types are all
  // there is): a clean one makes this window a target, a dirty one (an editor with unsaved text, which
  // must not be moved by a drag) makes it none and says why. The browser reports nothing when such a
  // drag ends elsewhere, so the target goes when the drops, the leaves and the clock say so.
  // And as the SOURCE: a `dragend` that reports `move`, with no drop here to explain it, means
  // another window took the tab. It is hidden now, ahead of the server, so its pane is gone before the
  // taker's attach; the hold runs out if the server never moved it.
  useEffect(() => {
    let endTimer: ReturnType<typeof setTimeout> | undefined;
    const idle = externalIdleRef;
    const end = () => {
      clearTimeout(endTimer);
      endTimer = setTimeout(() => setDragTabId(null), 0);
    };
    const endExternal = () => {
      dirtyToastRef.current = false;
      setExternalDrag(false);
    };
    const onDragOver = (e: DragEvent) => {
      if (dragTabIdRef.current !== null) return;
      const types = new Set(e.dataTransfer?.types ?? []);
      const dirty = types.has(TAB_DIRTY_DND_TYPE);
      if (!dirty && !types.has(TAB_DND_TYPE)) return;
      clearTimeout(idle.current);
      idle.current = setTimeout(endExternal, EXTERNAL_DRAG_IDLE_MS);
      if (!dirty) {
        setExternalDrag(true);
      } else if (!dirtyToastRef.current) {
        dirtyToastRef.current = true;
        showToast('Save the file before moving it to another window');
      }
    };
    const onDragLeave = (e: DragEvent) => {
      // A null `relatedTarget` is also what a move between two elements reports, so the pointer
      // has to be outside the viewport as well. The edge counts as outside: a drag that leaves the
      // window is reported at 0,0 by some browsers.
      if (e.relatedTarget !== null) return;
      if (
        e.clientX > 0 &&
        e.clientY > 0 &&
        e.clientX < window.innerWidth &&
        e.clientY < window.innerHeight
      ) {
        return;
      }
      clearTimeout(idle.current);
      endExternal();
    };
    const onDrop = () => {
      localDropRef.current = true;
      end();
      clearTimeout(idle.current);
      idle.current = setTimeout(endExternal, 0);
    };
    const onDragEnd = (e: DragEvent) => {
      const id = dragTabIdRef.current;
      if (
        id !== null &&
        e.dataTransfer?.dropEffect === 'move' &&
        !localDropRef.current &&
        !dirtyRef.current[id] &&
        visibleTabsRef.current.some((t) => t.id === id)
      ) {
        holdOptimistic([id], OTHER_WINDOW);
      }
      end();
    };
    window.addEventListener('dragover', onDragOver, true);
    window.addEventListener('dragleave', onDragLeave, true);
    window.addEventListener('dragend', onDragEnd, true);
    window.addEventListener('drop', onDrop, true);
    return () => {
      clearTimeout(endTimer);
      clearTimeout(idle.current);
      window.removeEventListener('dragover', onDragOver, true);
      window.removeEventListener('dragleave', onDragLeave, true);
      window.removeEventListener('dragend', onDragEnd, true);
      window.removeEventListener('drop', onDrop, true);
    };
  }, [showToast, holdOptimistic]);

  // Split right / Split down on a tab, from its menu: the tab moves into a new pane beside its own.
  const doSplit = useCallback(
    (tabId: string, orientation: 'row' | 'column') =>
      dispatch({ type: 'menuSplit', tabId, side: orientation === 'row' ? 'right' : 'bottom' }),
    [dispatch],
  );

  // Chrome-like strip reorder: apply optimistically (no flash while the round
  // trip completes), send the full desired order; the server's next `sessions`
  // broadcast is authoritative (an old server just snaps the order back).
  // Ids/URLs never change — only display order, which is ONE order for every pane: a
  // pane's strip is the server's order filtered to its tabs, so a drop in a strip is
  // resolved against the pane's visible entries and sent as a move in the FULL order.
  // Group-aware: the resulting order decides plain reorder vs JOIN (interior /
  // center-drop) vs LEAVE (dragged fully out of its own group). Join/leave send
  // a `groupUpdate{addIds|removeIds, order}` (membership + position atomically —
  // a bare reorder would be bounced back to contiguity by normalizeOrder); a
  // plain move sends `reorderTabs`. Optimistic in all three so there's no flash.
  //
  // `scope` is the ids of the pane whose strip took the drop, in server order. `index` is an
  // insertion index into THAT strip's visible entries; past its last entry the tab lands right
  // after the pane's last tab in the full order (not at the end of the whole list, which another
  // pane's tabs may occupy).
  const doReorder = useCallback(
    (
      scope: string[],
      id: string,
      index: number,
      joinGid?: string,
      anchor?: GroupEdge,
      boundary?: boolean,
    ) => {
      setDragTabId(null);
      const src = tabsRef.current;
      const ids = src.map((t) => t.id);
      // A not-yet-broadcast tab can't be reordered (the server doesn't know it
      // yet); it becomes draggable one broadcast later.
      if (!ids.includes(id)) return;
      // `index` is an insertion index into the pane's VISIBLE ENTRY list
      // (collapsed members hidden). The entry's id anchors the drop; map it to a
      // FULL-order position. An explicit `anchor` (the group the drop sits right
      // before) wins: with a group collapsed, "before its chip" and "after it"
      // share one entry index. It is resolved to the group's first member NOW, not
      // at hover time — another window may have moved that tab out of the group
      // since — and a group that is gone falls back to the index.
      const inScope = new Set(scope);
      const entries = visibleEntries(
        src.filter((t) => inScope.has(t.id)),
        collapsedRef.current,
      );
      const edge = anchor ? groupEdgeTarget(src, anchor) : undefined;
      let beforeId = edge ?? entries[index];
      if (beforeId === undefined) beforeId = afterLastOf(ids, inScope);

      const baseGof = groupIdMap(src);
      // A boundary drop (resolved between pills) never joins. The strip already
      // resolves one inside a foreign group to its edge, but the boundary was
      // computed at HOVER time: another window can group the tabs either side of
      // it before the drop lands, and that order alone would read as a join. So
      // re-resolve it here against the order the drop actually applies to.
      if (boundary && beforeId !== id) {
        const rest = ids.filter((x) => x !== id);
        const at = beforeId === undefined ? rest.length : rest.indexOf(beforeId);
        beforeId = rest[outsideForeignGroup(rest, at, baseGof, baseGof(id))];
      }

      const fullIndex = beforeId === undefined ? ids.length : ids.indexOf(beforeId);
      const next = reorderIds(ids, id, fullIndex);
      const decision = decideGroupDrop(next, baseGof, id, joinGid, boundary);

      // Run the SHARED contiguity model over the POST-mutation membership so the
      // optimistic order is byte-identical to what the server will broadcast (no
      // flash, no drift) — and send that already-normalized order.
      const set = new Set([id]);
      let change: DropMembership | undefined;
      let postGof = baseGof;
      let send: (order: string[]) => void;
      if (decision.join) {
        const join = decision.join;
        change = { ids: set, addTo: join };
        postGof = (x) => (set.has(x) ? join : baseGof(x));
        send = (order) => wsControlRef.current?.sendGroupUpdate({ id: join, addIds: [id], order });
      } else if (decision.leave) {
        const leave = decision.leave;
        change = { ids: set, removeFrom: leave };
        postGof = (x) => (set.has(x) ? undefined : baseGof(x));
        send = (order) =>
          wsControlRef.current?.sendGroupUpdate({ id: leave, removeIds: [id], order });
      } else {
        if (next.every((v, i) => v === ids[i])) return; // plain no-op move
        send = (order) => wsControlRef.current?.sendReorderTabs(order);
      }
      const order = normalizeOrder(next, postGof);
      // Applied to the list React holds, not rebuilt from `src`: a broadcast may
      // be queued behind this drop (see `applyDrop`).
      writeTabsRef(applyDrop(src, order, change));
      setTabs((prev) => applyDrop(prev, order, change));
      send(order);
    },
    [collapsedRef, writeTabsRef],
  );

  // Chip block move: relocate the whole (contiguous) member block to the insertion index of the
  // pane's strip it was dropped on, preserving inner order. One `reorderTabs`, applied
  // optimistically. `scope` is that pane's ids, as for `doReorder`.
  const moveGroup = useCallback(
    (scope: string[], gid: string, index: number, anchor?: GroupEdge) => {
      const src = tabsRef.current;
      const ids = src.map((t) => t.id);
      const memberSet = new Set(src.filter((t) => t.groupId === gid).map((t) => t.id));
      if (memberSet.size === 0) return;
      const rest = ids.filter((x) => !memberSet.has(x));
      const members = ids.filter((x) => memberSet.has(x));
      const inScope = new Set(scope);
      const entries = visibleEntries(
        src.filter((t) => inScope.has(t.id)),
        collapsedRef.current,
      );
      // `anchor`: the same group edge as doReorder's, resolved the same way — to
      // that group's CURRENT first member, else the index once the group is gone.
      const edge = anchor ? groupEdgeTarget(src, anchor) : undefined;
      const beforeId = edge ?? entries[index] ?? afterLastOf(ids, inScope);
      if (beforeId !== undefined && memberSet.has(beforeId)) return; // dropped on itself
      const at = beforeId === undefined ? rest.length : Math.max(0, rest.indexOf(beforeId));
      // Normalized BEFORE the no-op check, the optimistic state and the send. Moved
      // between two members of another group, the block would split that group,
      // and the server answers a split order by normalizing it — back to the
      // order it already has, which it does not broadcast. Sent raw, the client
      // would keep drawing the split order until some unrelated broadcast.
      const nextOrder = normalizeOrder(
        [...rest.slice(0, at), ...members, ...rest.slice(at)],
        groupIdMap(src),
      );
      if (nextOrder.every((v, i) => v === ids[i])) return;
      writeTabsRef(applyDrop(src, nextOrder));
      setTabs((prev) => applyDrop(prev, nextOrder));
      wsControlRef.current?.sendReorderTabs(nextOrder);
    },
    [collapsedRef, writeTabsRef],
  );

  // ── The drawer's tree gestures ──────────────────────────────────────────────
  // The mobile drawer drags a row to a place in a two-level tree, not to a strip
  // index, so its drops go through the tree model (`session/drawer-tree.ts`) and
  // land on the same wire operations the strip already speaks. They sit BESIDE
  // doReorder/moveGroup rather than replacing them: the desktop strip resolves its
  // drops against a pane's visible entries and group edges, none of which the
  // drawer has.
  // The latest group list, written by the `sessions` handler alone (the groups'
  // only writer) the moment a broadcast arrives, and never by a render, for the
  // reason `tabsRef` gives. A drop never needs to: membership lives on the tabs,
  // and a group a drop empties has no node left to resolve against.
  const groupsRef = useRef(groups);

  // The model's answer for a drop against the order as it is NOW, or null when
  // there is nothing to do: the drop is refused, it names a node another window
  // has closed since the drag began, or it lands where the node already sits.
  // Nothing goes on the wire for those.
  const resolveTreeDrop = useCallback((dragged: string, drop: DrawerDrop): DropResult | null => {
    const src = tabsRef.current;
    if (!accepts(buildNodes(src, groupsRef.current), dragged, drop)) return null;
    const ids = src.map((t) => t.id);
    const result = resolveDrop(ids, groupIdMap(src), dragged, drop);
    if (!result) return null;
    const { addTo, removeFrom } = result.membership;
    const same = result.order.every((v, i) => v === ids[i]);
    return same && addTo === undefined && removeFrom === undefined ? null : result;
  }, []);

  // A tab dropped before/after a row, onto a group header, or on the root area:
  // a membership change goes as `groupUpdate` (membership AND position in one
  // atomic message — a bare reorder would be bounced back to contiguity), a plain
  // move as `reorderTabs`. Optimistic with the same normalized order the server
  // will broadcast, so the list does not flash back while the round trip runs.
  // The snapshot moves at once too, so a second drop before the next render is
  // resolved against this one.
  const moveTabInTree = useCallback(
    (id: string, drop: DrawerDrop) => {
      const result = resolveTreeDrop(tabValue(id), drop);
      if (!result) return;
      const { order, membership } = result;
      const { addTo, removeFrom } = membership;
      const change: DropMembership = { ids: new Set([id]), addTo, removeFrom };
      writeTabsRef(applyDrop(tabsRef.current, order, change));
      setTabs((prev) => applyDrop(prev, order, change));
      const ws = wsControlRef.current;
      if (addTo !== undefined) ws?.sendGroupUpdate({ id: addTo, addIds: [id], order });
      else if (removeFrom !== undefined) {
        ws?.sendGroupUpdate({ id: removeFrom, removeIds: [id], order });
      } else ws?.sendReorderTabs(order);
    },
    [resolveTreeDrop, writeTabsRef],
  );

  // A group header dragged as a block: membership never changes, so it is always
  // one `reorderTabs`.
  const moveGroupInTree = useCallback(
    (gid: string, drop: DrawerDrop) => {
      const result = resolveTreeDrop(groupValue(gid), drop);
      if (!result) return;
      const { order } = result;
      writeTabsRef(applyDrop(tabsRef.current, order));
      setTabs((prev) => applyDrop(prev, order));
      wsControlRef.current?.sendReorderTabs(order);
    },
    [resolveTreeDrop, writeTabsRef],
  );

  // What the drawer's tree gestures call. Spread into the drawer rather than
  // named inline so they reach it the moment it declares them.
  const drawerTreeProps = useMemo(
    () => ({ onMoveTab: moveTabInTree, onMoveGroup: moveGroupInTree }),
    [moveTabInTree, moveGroupInTree],
  );

  // The whole tab-group concern bundled for SessionTabs — one interface instead of drilled props
  // (the hook's ops). `onMoveGroup` is the one op that depends on the pane, so each pane's strip
  // adds its own (`renderStrip`).
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
    ],
  );

  // The always-on control socket: tab list, settings, fonts, control acks. It
  // owns app state; TerminalPane sockets ignore these broadcasts.
  useEffect(() => {
    // A detached window names itself, and the server ties its ownership of the tabs to this socket.
    const ws = new WsClient(wsControlUrl(myWindow ?? undefined));
    wsControlRef.current = ws;
    // The server may have forgotten which tabs this window owns (a restart) or released them (a
    // long blip), so the first `sessions` after EVERY open is the one it takes them back on.
    ws.onOpen(() => {
      awaitingReclaimRef.current = true;
    });
    // A detached window takes back the tabs its layout holds that `list` shows with no owner
    // (design D6), plus the tab it was opened for on its first open only. Always INTO this window,
    // so it never confirms: nothing unmounts here. A tab another window holds is not claimed, and
    // reconcile drops it from the layout. `onPage` is set by a reconnect whose window is on the
    // New-tab page; the first broadcast's resolve selects for itself.
    const reclaim = (list: TabMeta[], onPage = false) => {
      if (!awaitingReclaimRef.current) return;
      awaitingReclaimRef.current = false;
      // An open against a server without detached windows claims nothing and does not count as
      // the first: after an upgrade and a reconnect, the tab the window was opened for is claimed.
      if (!detached || detachedUnsupportedRef.current) return;
      const first = firstOpenRef.current;
      firstOpenRef.current = false;
      const wanted = new Set(heldTabIds());
      const named = first && boot.kind === 'detached' ? boot.tab : null;
      if (named !== null) wanted.add(named);
      const ids = list.filter((t) => t.window === undefined && wanted.has(t.id)).map((t) => t.id);
      if (ids.length === 0 || !moveTabsRef.current(ids, myWindow)) return;
      setReclaiming(new Set(ids));
      // A first counted open on a reconnect finds the window on the New-tab page its server
      // without detached windows put it on, and reconcile adds a claimed tab to that blank pane
      // without selecting it. So the claim opens it, as the first broadcast's resolve would. Any
      // later reconnect leaves the selection alone, the New-tab page included.
      if (onPage && first) showTab(named !== null && ids.includes(named) ? named : ids[0]!);
    };
    ws.onMessage((msg) => {
      if (msg.type === 'ready') {
        setMaxUploadBytes(msg.maxUploadBytes);
        setWebApps(msg.webApps);
        setCapDetached(msg.detachedWindows === true);
        // A detached window on a server that predates them (a rollback) would claim nothing and
        // show nothing: it says so and shows the New-tab page instead of an empty frame.
        detachedUnsupportedRef.current = detached && msg.detachedWindows !== true;
        if (detachedUnsupportedRef.current) {
          showToast('This server does not support detached windows');
          setChooserPage(true);
        }
        if (msg.version) {
          if (knownVersionRef.current && knownVersionRef.current !== msg.version) {
            showToast('Server updated — reload to get the latest');
          }
          knownVersionRef.current = msg.version;
        }
        // A `ready` means a server is serving us again — the update finished. It also
        // follows every reconnect, during which frames were missed: the comments
        // are read again whatever rev they were last heard to be at.
        setUpdating(null);
        commentsStore.refresh();
      } else if (msg.type === 'scmComments') {
        commentsStore.observeRev(msg.repo, msg.rev);
      } else if (msg.type === 'updating') {
        if (msg.stage === 'failed') {
          setUpdating(null);
          showToast('Update failed — still on the current version');
        } else {
          setUpdating({ stage: msg.stage, ...(msg.version ? { version: msg.version } : {}) });
        }
      } else if (msg.type === 'tabCreated') {
        // A review create is idempotent on the server, so its answer may name a tab
        // this window already holds: it is shown where it is. The create is answered
        // either way, so its url is no longer pending.
        const answered = tabsRef.current.find((t) => t.id === msg.id);
        if (answered?.kind === 'review' && answered.url !== undefined) {
          pendingReviewsRef.current.delete(answered.url);
        }
        dispatch({ type: 'tabCreated', id: msg.id });
      } else if (msg.type === 'sessions') {
        // Accumulate seen-terminals + prune BEFORE deciding close-nav (the
        // controller reads seenTermIds); `setTabs` is async so `tabsRef.current`
        // is still the OLD list the close-nav decision needs.
        for (const t of msg.tabs) if (t.kind === 'terminal') seenTermIdsRef.current.add(t.id);
        // A terminal this window picked an id for is pending until a broadcast lists it, and from
        // then on the server's list is the truth. The layout hook forgets the ids it RENDERS with
        // a list, and two frames batched into one render show only the second: one that lists a
        // new terminal and one that omits it again would leave the id pending for ever, and the
        // pane for a terminal that is gone would stay. So every listed id leaves `pending` here,
        // beside the synchronous `tabsRef` writes and ahead of the controller's decision. EXCEPT
        // an id the layout holds as ANOTHER kind than the list now states: reconcile adopts the
        // listed kind only while the id is still pending, and the hook forgets that one after the
        // render that adopted it.
        for (const t of msg.tabs) {
          const held = layoutRef.current && leafHolding(layoutRef.current, t.id);
          const heldKind = held ? held.tabs.find((r) => r.id === t.id)?.kind : undefined;
          if (heldKind === undefined || heldKind === t.kind) pendingTabs.delete(t.id);
        }
        // Group model + collapse pruning is owned by useTabGroups. An older server
        // (or a pre-groups broadcast) omits `groups` → treat as none (the parse
        // layer defaults it; this also guards direct injection in tests).
        applyGroupBroadcast(msg.groups ?? []);
        setDirtyTabs((prev) => pruneRecord(prev, new Set(msg.tabs.map((t) => t.id))));
        // A claim ends with the next broadcast, whether or not it was granted. Before the reclaim
        // below, which may start the next one.
        setReclaiming((prev) => (prev.size === 0 ? prev : NO_RECLAIM));
        // FIRST broadcast: this window has no tab yet (it was opened at `/`, so
        // its only clue was what it remembered) and now the list has arrived.
        // Resolving here rather than at boot is what stops a remembered id that
        // has since been closed from mounting a pane and SPAWNING a terminal on
        // it — an attach to an unknown id creates one.
        if (awaitingResolveRef.current) {
          awaitingResolveRef.current = false;
          setAwaitingResolve(false);
          // The refs first: `nextFreeId` and `show` read the list through them, and `setTabs`
          // below has not run yet.
          writeTabsRef(msg.tabs);
          // A detached window's reclaim of its tabs (design D6) runs HERE: after the refs it reads,
          // and before the resolve, which must see what it moved into this window.
          reclaim(msg.tabs);
          const shown = visibleTabsRef.current;
          if (boot.kind === 'new') {
            // The list is here, so `nextFreeId` can finally pick an id that is
            // actually free.
            createTabRef.current?.({ kind: 'terminal' });
          } else if (boot.kind === 'legacy' && !heldElsewhere(msg.tabs, shown, boot.id)) {
            // A legacy `/<id>` names its tab outright: nothing else tells the layout to show it.
            // An id the list lacks is a fresh terminal, as it always was. One another window holds
            // falls through to a plain `/` resolve.
            showTab(boot.id);
          } else {
            // A detached window was opened for a tab (`?tab=`), which wins when this window shows it.
            const named =
              boot.kind === 'detached' && boot.tab !== null ? selectionFor(shown, boot.tab) : null;
            const stored = named ?? readSelection(myWindow);
            const remembered = resolveStoredSelection(shown, stored);
            // With editor groups the layout owns the selection: a restored one already knows which
            // pane shows what, so a remembered tab that no longer resolves must not override it
            // (`resolveSelection` would guess the first tab). With no saved layout the pick seeds
            // the one pane, as before.
            const target =
              groupsEnabledRef.current && remembered === null && hasSavedLayout()
                ? null
                : resolveSelection({ stored, tabs: shown });
            // Coming back on the remembered tab RESTORES a selection, it does not
            // make one, so the persist effect's baseline starts at it. Without that
            // the effect read the reload as a change and copied this window's tab
            // over the device-wide key, which may hold a NEWER choice made in another
            // window since. With no usable device value there is nothing to protect,
            // and the boot choice initialises it. A detached window never writes that key.
            if (!detached && stored && target === stored.id && readLastTab()) {
              lastStoredRef.current = stored;
            }
            if (groupsEnabledRef.current) setBootSelection(remembered);
            if (target) showTab(target);
            else if (shown.length === 0) setChooserPage(true);
          }
        } else {
          // Close-navigation (active tab gone → neighbor / New-tab page) is a
          // pure controller decision, and it OWNS the neighbour rule: it is the
          // only place holding the previous strip order needed to compute it.
          // On-screen splits reconcile in their own effect. It reads the tabs THIS window shows,
          // before and after.
          dispatch({ type: 'sessionsBroadcast', tabs: visibleOf(msg.tabs, optimisticRef.current) });
        }
        // A move this window made is spent once a broadcast shows the tab with that owner. Until
        // then the hold stays, so a frame that was already in flight cannot bring the tab back.
        // After the decision above, which reads the list as it was, holds included.
        const confirmed: string[] = [];
        for (const [id, owner] of optimisticRef.current) {
          const listed = msg.tabs.find((t) => t.id === id);
          if (listed && (listed.window ?? null) === owner) confirmed.push(id);
        }
        if (confirmed.length > 0) dropOptimistic(confirmed);
        // ONE latest snapshot. `setTabs` only queues the list, and anything
        // resolved before React renders it (a drop above all) must already see
        // it. Moved only now: the close-navigation decision above is the one
        // reader that needs the list as it was.
        writeTabsRef(msg.tabs);
        // A reconnect's reclaim: the first broadcast's already ran above. After the list is
        // written, which the move reads, and before `setTabs` queues the list the claim is
        // rendered with. The page as last rendered: the decision above may have queued it, for a
        // list that lacked the tabs the claim is about to hold.
        reclaim(msg.tabs, onChooserPageRef.current);
        groupsRef.current = msg.groups ?? [];
        // The dragged tab is gone from this window, and its pill with it: nothing is left to report
        // the drag's end, and the browser need not deliver one to a source that left the DOM. A
        // pending tab (a terminal this window just created) is in no list yet and still has its pill.
        const dragged = dragTabIdRef.current;
        if (
          dragged !== null &&
          !pendingTabs.has(dragged) &&
          !visibleTabsRef.current.some((t) => t.id === dragged)
        ) {
          setDragTabId(null);
        }
        setTabs(msg.tabs);
        // After the list: the layout is built from it, with the boot choice set above.
        setSessionsReady(true);
      } else if (msg.type === 'settings') applySettings(msg.settings);
      else if (msg.type === 'extraKeys') applyExtraKeys(msg.extraKeys);
      else if (msg.type === 'fonts') {
        const { families, loaded } = registerFonts(msg.fonts);
        setFontFamilies(families);
        // Re-rasterize EVERY pane (not just the focused one).
        void loaded.then(() => registry.forEachApi((api) => api.refreshFont()));
      } else if (msg.type === 'themes') {
        registerDynamicThemes(msg.themes);
        // The active theme may be a user theme that just arrived / changed.
        applyThemeTokens(getProfile(shownThemeIdRef.current));
        // The xterm canvas needs the same nudge, and does NOT get it for free:
        // the theme id hasn't changed, only what it RESOLVES to, so useTerminal's
        // settings effect won't re-run. Boot hits this every time — the control
        // socket lands after the terminal is built, so a `user:` theme rendered
        // as the default (dark) palette while the rest of the UI was correct.
        registry.forEachApi((api) => api.refreshTheme());
        setThemesNonce((n) => n + 1);
      } else if (msg.type === 'themeImported') {
        setImportingTheme(false);
        if (!msg.ok) {
          showToast(`Import failed — ${msg.detail ?? 'unknown error'}`);
        } else if (msg.id) {
          // Select it right away — for the target it was submitted for, and only
          // if no mode change happened since: a fixed import that lands after a
          // switch to Match system must not write `themeId` (the export would
          // change with no scheme change behind it), and one that lands after a
          // round trip back to Fixed must not overwrite the newer pick. A
          // superseded import is still imported and appears in the list; it is
          // just not selected. The profile itself lands a moment later on the
          // themes broadcast (the server watches the dir), and THAT handler
          // re-applies the tokens — so a brief fallback paint self-heals.
          // An import into the slot that is ON SCREEN changes what this device shows,
          // so it moves the export too — exactly as a pick for that slot does.
          const { target, modeGen } = importTargetRef.current;
          const pick =
            modeGen === themeModeGenRef.current
              ? themePick(settingsRef.current, target, msg.id)
              : null;
          const onScreen =
            target.mode === 'system' && target.slot === (prefersDarkRef.current ? 'dark' : 'light');
          if (pick) updateSettings(onScreen ? { ...pick, themeId: msg.id } : pick);
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
    showTab,
    showToast,
    hasSavedLayout,
    pendingTabs,
    boot,
    myWindow,
    detached,
    visibleOf,
    writeTabsRef,
    dropOptimistic,
    heldTabIds,
  ]);

  // The chooser is never a floating box: it opens in whichever CONTAINER this
  // device has — the dock on desktop, the drawer on mobile. It used to be a
  // popover anchored at [+], which on mobile anchored to a button that does not
  // exist (there is no strip) and fell back to a box floating over the corner.
  // While the New-tab PAGE is up (last tab closed) the page IS the chooser.
  const openNewTab = useCallback(() => {
    if (chooserPageRef.current) return;
    // A detached window has no dock to host it, and the New-tab PAGE would unmount the panes it
    // still shows: the chooser is a dialog there.
    if (detached) {
      setNewTabDialog(true);
      return;
    }
    if (!mobileActiveRef.current) {
      openDockView('newtab');
      return;
    }
    // The drawer is the container, so it has to be open to hold anything —
    // the keybinding can fire with it closed.
    setDrawerView('sessions');
    openDrawer();
    setNewTabOpen(true);
  }, [detached, openDockView, openDrawer]);

  // Two hosts, no modal: the dock on desktop, the drawer's own settings view
  // on mobile (where the dock is forced off and the drawer IS the container).
  // One function for the `settings` keybinding and the app menu, so the
  // two routes cannot open different things.
  const openSettings = () => {
    if (!mobileActiveRef.current) return openDockView('settings');
    setDrawerView('settings');
    openDrawer();
  };

  // Source Control lives in the dock on desktop and in the drawer's own view on
  // mobile, where the dock never renders. The review bar's file list is the same
  // route, so the chord, the palette entry and that button open one thing.
  const openSourceControl = () => {
    if (!mobileActiveRef.current) return openDockView('scm');
    setDrawerView('scm');
    openDrawer();
  };

  // The review keys act on the review the user is looking at, and ONLY then: with
  // any other tab focused they are unwired, so the chord reaches the terminal and
  // the palette does not offer them. The pane is found by its tab id. The New-tab
  // page shows no tab, so a review its kept id came back as is not looked at.
  const reviewHandlers: Partial<Record<Action, () => void>> =
    activeTab.kind === 'review' && !onChooserPage
      ? {
          scmNextChange: () => reviewApiFor(activeTab.id)?.nextChange(),
          scmPrevChange: () => reviewApiFor(activeTab.id)?.prevChange(),
          scmNextFile: () => reviewApiFor(activeTab.id)?.nextFile(),
          scmPrevFile: () => reviewApiFor(activeTab.id)?.prevFile(),
          scmReviewed: () => reviewApiFor(activeTab.id)?.reviewCurrent(),
        }
      : {};

  // The focused pane's active tab, split to its `side`. Nothing to split on the New-tab page.
  const splitFocused = (side: 'right' | 'bottom') => {
    const current = layoutRef.current;
    const focused = current && leaves(current).find((l) => l.id === current.focused);
    if (focused?.active) dispatch({ type: 'menuSplit', tabId: focused.active, side });
  };

  // Rebindable desktop keybindings, wired to the actions that currently have a
  // target. Unbound / unwired chords fall through to the terminal untouched.
  const actionHandlers: Partial<Record<Action, () => void>> = {
    ...reviewHandlers,
    // The two that open a dock view are not wired in a detached window, which has no dock: the
    // chord falls through to the terminal and the palette does not offer them.
    ...(detached ? {} : { openSourceControl, settings: openSettings }),
    commandPalette: () => setPanel('commandPalette'),
    search: () => registry.focusedApi()?.openSearch(),
    newTab: openNewTab,
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
    // Split right / down move the focused pane's active tab into a new pane beside it (a lone tab
    // opens a new terminal there). Only where panes exist: no split on the mobile layer, and none
    // to offer in the command palette either.
    ...(groupsEnabled
      ? {
          splitRight: () => splitFocused('right'),
          splitDown: () => splitFocused('bottom'),
        }
      : {}),
    dictate: dictation.toggle,
    dictationHistory: () => setPanel('dictationHistory'),
    // Upload and download are RAIL actions, and the desktop action cluster that
    // used to hold them is gone. These are the keyboard route to them, and they
    // put both in the command palette, where every other action is.
    uploadFile: guardedOpenPicker,
    downloadFile: doDownload,
    increaseFontSize: () => updateSettings({ fontSize: settingsRef.current.fontSize + 1 }),
    decreaseFontSize: () => updateSettings({ fontSize: settingsRef.current.fontSize - 1 }),
    resetFontSize: () => updateSettings({ fontSize: DEFAULTS.fontSize }),
  };
  useKeybindings(actionHandlers);

  const createTab = useCallback(
    (spec: CreateSpec): boolean => {
      setNewTabOpen(false);
      setNewTabDialog(false);
      if (spec.kind === 'terminal') {
        // The id excludes every tab and every pane member (any may not be broadcast yet), so the
        // fresh one can never collide with an existing tab.
        const id = freshTerminalId();
        // A terminal is not created through the server at all — the client picks
        // a free id and the PTY spawns on the first /ws attach. So a tmux target
        // cannot be sent with a create message; it waits here for the pane that
        // is about to mount on this id to collect it.
        if (spec.tmux !== undefined) pendingTmuxRef.current.set(id, spec.tmux);
        selectTab(id);
        return true;
      }
      // The server acks with `tabCreated` carrying the assigned id (deterministic). A detached
      // window names itself, so the tab is born there and no broadcast lists it in the main window.
      const sent =
        wsControlRef.current?.sendCreateTab(myWindow ? { ...spec, window: myWindow } : spec) ??
        false;
      if (!sent) showToast('Not connected — try again');
      return sent;
    },
    [selectTab, showToast, freshTerminalId, myWindow],
  );
  createTabRef.current = createTab;

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

  // Ctrl+W / Cmd+W never closes the app window: see `close-key.ts`. Capture
  // phase on window, so it runs before Monaco, an input or xterm. Registered
  // AFTER `useKeybindings`, whose listener claims a chord the user bound to an
  // action, so `defaultPrevented` means "already an action" and is left alone.
  // The id is read from the refs at key time. On the New-tab page nothing is
  // selected, so the chord is only swallowed: the closed tab's id that the page
  // keeps can come back as another kind of tab, which the page does not show and
  // the chord must not close. A detached window is the main window's twin here: the chord
  // closes its active tab, never the window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const intent = closeKeyIntent(e, activeKindRef.current);
      if (!intent) return;
      e.preventDefault();
      if (intent === 'shell') return;
      e.stopPropagation();
      if (e.repeat || onChooserPageRef.current) return;
      const id = sessionIdRef.current;
      // The tabs this window shows: right after a move the id may be another window's already.
      if (visibleTabsRef.current.some((t) => t.id === id)) closeTab(id);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [closeTab]);

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

  // Reload app, behind the same discard confirm closing a dirty editor gets.
  // `reloadApp` reloads unconditionally, and an editor whose save was refused
  // keeps its text only in the buffer — `dirtyRef` is the one place that knows,
  // so a bare reload would destroy it without a word. Shared by the app menu
  // and Settings → Reload app in BOTH its hosts, the dock and the mobile drawer.
  //
  // Resolves `true` as soon as the reload is CONFIRMED, not when it ends:
  // `reloadApp` sweeps caches, updates the service worker and re-fetches the
  // document before it navigates, and the Settings row has to show "Reloading…"
  // during that wait. `false` means the user cancelled and nothing happened.
  //
  // Settings' raw config.json buffer counts too: it is not a tab, but its text
  // exists nowhere else until a Save succeeds, and it survives hidden behind
  // the Form view where the Reload row sits.
  const guardedReload = useCallback((): Promise<boolean> => {
    const unsaved = tabsRef.current.filter(
      (t) => t.kind === 'editor' && dirtyRef.current[t.id],
    ).length;
    const subjects = [
      ...(unsaved > 0 ? [`${unsaved} editor ${unsaved > 1 ? 'tabs' : 'tab'}`] : []),
      ...(configDirtyRef.current ? ['config.json'] : []),
    ];
    const plural = subjects.length > 1 || unsaved > 1;
    if (
      subjects.length > 0 &&
      !window.confirm(
        `${subjects.join(' and ')} ${plural ? 'have' : 'has'} unsaved changes. Reload and discard them?`,
      )
    ) {
      return Promise.resolve(false);
    }
    void reloadApp();
    return Promise.resolve(true);
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

  // ── Moving tabs between windows ───────────────────────────────────────────────
  // Whether `ids` may move at all, and, when they LEAVE this window, whether the user accepts losing
  // what an editor holds. Split from the move itself so "Open in new window" can ask before it opens
  // the window: a refusal then never leaves an empty window behind.
  const confirmMove = useCallback(
    (ids: string[], leaving: boolean): boolean => {
      const listed = tabsRef.current;
      // The server knows a terminal only once its pane attaches: a pending one has nothing to move.
      if (ids.some((id) => !listed.some((t) => t.id === id))) {
        showToast('Wait for the terminal to start');
        return false;
      }
      if (!leaving) return true;
      // The editor unmounts here and the receiving window loads the file from disk, so unsaved text
      // is lost. A move INTO this window unmounts nothing and never asks.
      const unsaved = ids.filter(
        (id) => listed.find((t) => t.id === id)?.kind === 'editor' && dirtyRef.current[id],
      ).length;
      if (unsaved === 0) return true;
      const many = unsaved > 1;
      return window.confirm(
        `${unsaved} editor ${many ? 'tabs' : 'tab'} ${many ? 'have' : 'has'} unsaved changes. Move and discard them?`,
      );
    },
    [showToast],
  );
  // Hand `ids` to `target` (a window id, or null for the main window) and show it at once: the
  // window they leave stops drawing them before the one they join could attach, so a terminal is
  // never attached from both. The hold ends when the server agrees or after `OPTIMISTIC_MOVE_MS`.
  const applyMove = useCallback(
    (ids: string[], target: string | null): boolean => {
      if (ids.length === 0) return false;
      if (!wsControlRef.current?.sendMoveToWindow(ids, target)) {
        showToast('Not connected — try again');
        return false;
      }
      // Tabs that LEAVE are no longer this window's: their unsaved flags must not count against a
      // Reload. A move into this window (a reclaim) leaves them mounted here, still unsaved.
      if (target !== myWindow) {
        const moved = new Set(ids);
        setDirtyTabs((prev) =>
          pruneRecord(prev, new Set(Object.keys(prev).filter((id) => !moved.has(id)))),
        );
      }
      holdOptimistic(ids, target);
      return true;
    },
    [showToast, holdOptimistic, myWindow],
  );
  /**
   * Move tabs to another window (`target` = its id, or null for the main window). True when it was
   * sent, false when refused or cancelled: a caller that parks a placement does so only on true.
   */
  const moveTabsToWindow = useCallback(
    (ids: string[], target: string | null): boolean =>
      confirmMove(ids, target !== myWindow) && applyMove(ids, target),
    [confirmMove, applyMove, myWindow],
  );
  moveTabsRef.current = moveTabsToWindow;
  const doMoveToMain = useCallback(
    (id: string) => void moveTabsToWindow([id], null),
    [moveTabsToWindow],
  );

  // A detached window with nothing left closes itself (design D10), once it has held a tab, the
  // server supports detached windows, and nothing is on its way in: a terminal this window just
  // created is pending, and a reclaim is in flight. `pendingTabs` is the hook's mutable `Set`: its
  // identity never changes, so listing it re-runs nothing. It is read, not watched, because every
  // pending id leaves on a broadcast that also changes `visibleTabs`. Where the browser refuses
  // (the address was opened by hand) the window stays, on the New-tab page; the attempt spends
  // `seenOwnRef`, so the broadcasts that follow (a new empty list each time) do not ask the
  // browser again until the window has held another tab.
  useEffect(() => {
    if (!detached) return;
    if (visibleTabs.length > 0) {
      seenOwnRef.current = true;
      return;
    }
    if (!seenOwnRef.current || !capDetached || pendingTabs.size > 0 || reclaiming.size > 0) return;
    seenOwnRef.current = false;
    wsControlRef.current?.sendWindowClosing();
    window.close();
    setTimeout(() => {
      if (!window.closed) setChooserPage(true);
    }, 0);
  }, [detached, visibleTabs, reclaiming, capDetached, pendingTabs]);

  // Closing the window is the last thing a detached window does that the server must hear about: it
  // starts the short grace, so the tabs return to the main window in seconds, not after the lease.
  // A reload sends it too, and comes back inside that grace.
  useEffect(() => {
    if (!detached) return;
    const onHide = () => void wsControlRef.current?.sendWindowClosing();
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [detached]);

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
        if (visibleTabsRef.current.some((t) => t.id === existing.id)) selectTab(existing.id);
        // Another window holds it. It is not moved here: this window cannot see that buffer, so
        // the discard confirm would be blind and an editor with unsaved text would lose it.
        else showToast(`${displayTitle(existing)} is open in another window`);
        return;
      }
      createTab({ kind: 'editor', url: path });
    },
    [createTab, selectTab, showToast],
  );

  // The file each review tab should scroll to once it shows, keyed by the review's
  // url. The hand-off point for the review pane: it takes the entry for its own url
  // and clears it, the way a terminal pane takes its tmux target. A later open of the
  // same url simply replaces the entry. The tick tells a pane that is already
  // mounted (and maybe already shown, so nothing else about it changes) to look.
  const reviewScrollRef = useRef(new Map<string, ScmOpenTarget>());
  const [reviewOpenTick, setReviewOpenTick] = useState(0);
  /**
   * Open the review a Source Control row belongs to, or focus the one already open.
   *
   * One review tab per (group, project), the rule `openFileTab` applies to editor
   * files: a second tab on the same url would be two panes polling one project.
   * A live tab is selected and a missing one is created. The server also answers a
   * duplicate `createTab` with the existing tab, but that is only the cross-window
   * backstop; this window never sends one for a url it can see, and never sends a
   * second while its first is still unanswered (two quick taps before the tab has
   * been broadcast). An unanswered create is forgotten after a few seconds, so a
   * refused one cannot block the url for good.
   */
  const openReview = useCallback(
    (target: ScmOpenTarget) => {
      const repo = activeScmRepoRef.current;
      if (!repo) return;
      const url = reviewUrl(target.group, repo);
      reviewScrollRef.current.set(url, target);
      setReviewOpenTick((tick) => tick + 1);
      const existing = tabsRef.current.find((t) => t.kind === 'review' && t.url === url);
      if (existing) {
        if (visibleTabsRef.current.some((t) => t.id === existing.id)) {
          selectTab(existing.id);
          return;
        }
        // Another window holds it, and the server answers a second create with that same tab, which
        // this window would never show. It moves here instead (a review holds no unsaved state), and
        // is shown only once it is ours: the move writes the refs before the navigation reads them.
        if (moveTabsToWindow([existing.id], myWindow)) selectTab(existing.id);
        return;
      }
      const sentAt = pendingReviewsRef.current.get(url);
      if (sentAt !== undefined && Date.now() - sentAt < PENDING_REVIEW_MS) return;
      pendingReviewsRef.current.set(url, Date.now());
      if (!createTab({ kind: 'review', url })) pendingReviewsRef.current.delete(url);
    },
    [createTab, selectTab, moveTabsToWindow, myWindow],
  );

  // Where the review bar's left→right swipe goes: the last tab that was NOT a review,
  // which is the tab that was active before the review opened (and, from one review
  // to another, still that tab, so swiping back twice never ping-pongs between two
  // reviews). Recorded as the selection moves, from the list as broadcast: a tab id
  // the server has not announced yet reads as a terminal, and a review just created
  // must not be taken for the tab to return to.
  const returnTabRef = useRef<string | null>(null);
  useEffect(() => {
    const shown = visibleTabs.find((t) => t.id === sessionId);
    if (shown && shown.kind !== 'review') returnTabRef.current = shown.id;
  }, [sessionId, visibleTabs]);
  // That tab, or the first terminal when it has been closed since.
  const leaveReview = useCallback(() => {
    const list = visibleTabsRef.current;
    const back =
      list.find((t) => t.id === returnTabRef.current && t.kind !== 'review') ??
      list.find((t) => t.kind === 'terminal');
    if (back) selectTab(back.id);
  }, [selectTab]);

  // What a review pane takes from the app around it (review/review-host.ts).
  const reviewHost = useMemo<ReviewHost>(
    () => ({
      repos: settings.scmRepos,
      layout: settings.scmLayout,
      algorithm: settings.scmAlgorithm,
      wrap: settings.scmWrap,
      codeFontSize: settings.codeFontSize,
      openTick: reviewOpenTick,
      setPreferences: updateSettings,
      activate: (repo) => updateSettings({ scmActiveRepo: repo }),
      openFile: openFileTab,
      takeScrollTarget: (url) => {
        const target = reviewScrollRef.current.get(url);
        reviewScrollRef.current.delete(url);
        return target;
      },
      notify: showToast,
    }),
    [
      settings.scmRepos,
      settings.scmLayout,
      settings.scmAlgorithm,
      settings.scmWrap,
      settings.codeFontSize,
      reviewOpenTick,
      updateSettings,
      openFileTab,
      showToast,
    ],
  );

  // Focusing a review makes its project the one this device reads. Keyed on the
  // focused tab and its repo and on nothing else, so choosing another project in the
  // dock while the review stays focused is not undone by the next tab broadcast: that
  // review then shows as paused until it is focused again. A project that is no
  // longer in the list (a removed one) is never made active. With several panes only
  // the focused one drives this, because `sessionId` follows focus. The New-tab page focuses
  // nothing, though `sessionId` keeps the closed tab's id, which can come back as a review.
  const focusedReviewRepo =
    !onChooserPage && activeTab.kind === 'review' && activeTab.url !== undefined
      ? (parseReviewUrl(activeTab.url)?.top ?? null)
      : null;
  useEffect(() => {
    if (focusedReviewRepo === null) return;
    if (!settingsRef.current.scmRepos.includes(focusedReviewRepo)) return;
    if (activeScmRepoRef.current === focusedReviewRepo) return;
    updateSettings({ scmActiveRepo: focusedReviewRepo });
  }, [sessionId, focusedReviewRepo, updateSettings]);

  const updateQuickLinks = useCallback(
    (quickLinks: { name: string; url: string }[]) => updateSettings({ quickLinks }),
    [updateSettings],
  );

  // Open a tab in a NEW detached window: it moves there, it is not mirrored. The window opens only
  // after every refusal, and the move is sent only once the browser has allowed the window.
  const doPopout = useCallback(
    (id: string) => {
      if (!confirmMove([id], true)) return;
      const { wid, win } = openDetached(id);
      if (!win) {
        showToast('New window blocked — allow popups for this site');
        return;
      }
      // Unsent (the control socket is down), the move would leave an empty window behind.
      if (!applyMove([id], wid)) win.close();
    },
    [confirmMove, applyMove, showToast],
  );

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
    // A hold has kept the layout still since it was last pinned, so the next
    // apply that finds no hold is that hold's RELEASE. It is set the moment a hold
    // is seen or hands itself back — not only when a viewport frame happened to
    // run under it: the IME's viewport event and a release can land in the same
    // frame, and a release that found "nothing deferred" used to pin the grown
    // viewport without the keyboard.
    let held = false;
    // What each hold recorded about the keyboard, kept per SOURCE so one ending
    // cannot overwrite another's record, and combined at the final release: raise
    // if any of them saw it up. A selection cannot tell at its start (it blurs the
    // textarea either way), so it always asks and leaves the answer to the growth
    // test below; the drawer, and a picker it launched, recorded it at open. A
    // drawer that opened over a DOWN keyboard has nothing to restore of its own,
    // however far the viewport grows.
    const intent = { selection: false, drawer: false };
    // The geometry the app is currently PINNED to. While a hold defers the
    // replay this stays at the keyboard-up height, which is what makes the
    // dead space below the terminal, and what the restore below compares to.
    let pinnedH = vv.height;
    let pinnedTop = vv.offsetTop;
    // The drawer defers an UPDATE to a layout that is already pinned, never the
    // first pin: mobile mode can come back on while the drawer is still open.
    let pinned = false;
    // A release that re-raised the keyboard leaves the layout RESTORING until the
    // keyboard is back. Meanwhile viewport events write nothing: a scroll, or the
    // IME animating in, used to pin the keyboard-less height at once and cancel
    // the fallback, and the IME's arrival then resized every shell a second time.
    // It ends ONCE, on whichever fires first: the settle timer (the viewport back
    // within a keyboard of the pinned height and still for RESTORE_SETTLE_MS) or
    // the fallback (the keyboard never came back).
    let restoring = false;
    let restoreFallback = 0;
    let restoreSettle = 0;
    // The frame a restore's end asks for commits the final geometry, and writes
    // nothing when that is the geometry already pinned.
    let restoreEnded = false;
    const stopRestore = () => {
      restoring = false;
      clearTimeout(restoreFallback);
      clearTimeout(restoreSettle);
      restoreSettle = 0;
    };
    const endRestore = () => {
      stopRestore();
      restoreEnded = true;
      onVV();
    };
    const apply = () => {
      raf = 0;
      // Starting a native text selection BLURS the hidden keyboard textarea (a
      // page selection and a focused editable cannot coexist), so Android
      // dismisses the IME — which fires this handler. Re-fitting the terminal
      // here reflows the buffer out from under the selection and the user's
      // selection vanishes mid-gesture. Hold the layout still until they let
      // go; the keyboard is on its way out either way. An open drawer holds it
      // for the same reason: the IME leaves when the drawer takes a tap, and
      // resizing every shell behind a panel that covers them is all cost.
      // Overlapping holds release only when the LAST of them has ended.
      const selecting = hasNativeSelection();
      if (selecting || (pinned && drawerHoldRef.current)) {
        held = true;
        if (selecting) intent.selection = true;
        // A hold taken while the keyboard was coming back takes over: its own
        // release decides afresh whether there is anything to restore.
        stopRestore();
        restoreEnded = false;
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
      const released = held;
      const restore =
        (intent.selection || intent.drawer) && shouldRestoreKeyboard(released, vv.height, pinnedH);
      held = false;
      intent.selection = false;
      intent.drawer = false;
      // Re-raise BEFORE re-pinning, and keep the keyboard-up height meanwhile.
      // Applying the grown height first resized every shell to the full screen
      // and back again ~100ms later when the IME returned — measured on a phone
      // as `resize rows 63` then `rows 33`, two SIGWINCHs that jumped the
      // terminal by a few lines. If the keyboard does not come back (a focus()
      // without user activation), the fallback ends the restore and pins the
      // real height.
      // Best-effort: Android only raises the IME for a focus() that carries user
      // activation. The tap that dismisses a selection provides it; the OS Copy
      // callout may not, and then the next tap on the terminal raises it as it
      // always has.
      if (restore) {
        kbdRaiseRef.current();
        stopRestore();
        restoring = true;
        restoreFallback = window.setTimeout(endRestore, KEYBOARD_RETURN_MS);
        return;
      }
      if (restoring) {
        // Once settling has begun every event restarts it, wherever it lands.
        if (restoreSettle !== 0 || Math.abs(vv.height - pinnedH) <= KEYBOARD_GONE_PX) {
          clearTimeout(restoreSettle);
          restoreSettle = window.setTimeout(endRestore, RESTORE_SETTLE_MS);
        }
        return;
      }
      const settled = released || restoreEnded;
      restoreEnded = false;
      // A release or a restore over a viewport that ended where it started has
      // nothing to apply, and a same-size write still re-fits every attached pane.
      if (settled && pinned && vv.height === pinnedH && vv.offsetTop === pinnedTop) return;
      pinnedH = vv.height;
      pinnedTop = vv.offsetTop;
      pinned = true;
      root.setProperty('--app-height', `${vv.height}px`);
      root.setProperty('--app-top', `${vv.offsetTop}px`);
      registry.focusedApi()?.refit();
    };
    const onVV = () => {
      if (raf) return;
      raf = requestAnimationFrame(apply);
    };
    // A selection holds from the moment it exists, and its end is the only signal
    // that a held resize can run — no further viewport event is guaranteed once
    // the keyboard has gone.
    const onSelectionChange = () => {
      if (hasNativeSelection()) {
        held = true;
        intent.selection = true;
      } else if (held) onVV();
    };
    document.addEventListener('selectionchange', onSelectionChange);
    // The drawer's close (and a picker's return) runs the same release, carrying
    // the drawer's record: by the time a frame queued under the hold runs, the
    // hold is gone and could no longer be asked. The frame reconciles whatever
    // the viewport is NOW.
    viewportReleaseRef.current = (kbdWasUp) => {
      held = true;
      intent.drawer ||= kbdWasUp;
      onVV();
    };
    apply();
    // Passive: the handler only reads geometry + schedules a rAF, never
    // preventDefault — lets the browser scroll without waiting on JS.
    vv.addEventListener('resize', onVV, { passive: true });
    vv.addEventListener('scroll', onVV, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      stopRestore();
      viewportReleaseRef.current = () => {};
      document.removeEventListener('selectionchange', onSelectionChange);
      vv.removeEventListener('resize', onVV);
      vv.removeEventListener('scroll', onVV);
      root.removeProperty('--app-height');
      root.removeProperty('--app-top');
    };
  }, [mobileActive, registry]);

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

  // The app menu, at the top of the dock rail: Settings, Tips and Reload app.
  const appMenuItems: DropdownMenuItemSpec[] = [
    {
      id: 'settings',
      label: 'Settings',
      icon: <Icon name="settings" size={14} />,
      onSelect: openSettings,
    },
    {
      id: 'tips',
      label: 'Tips',
      icon: <Icon name="book" size={14} />,
      onSelect: () => setPanel('tips'),
    },
    {
      id: 'reload',
      label: 'Reload app',
      icon: <Icon name="reload" size={14} />,
      separatorBefore: true,
      onSelect: () => void guardedReload(),
    },
  ];

  // ── Dropping tabs on panes, and sashes ────────────────────────────────────────
  // The tab a drag carries is the one the strip reported when it started (`dragTabId`): the
  // overlay says where it was dropped, not what. A drag from ANOTHER window has no such id here, so
  // the overlay (or the strip) hands over the one the drag itself carries.
  //
  // A tab another window holds is taken by asking the server for it, and by parking where it should
  // land: it is listed here only once the move shows (held ahead of the server, so the very next
  // render), and the layout applies the placement in the render that adds it. Answers true when the
  // drop is dealt with: taken, refused, or an id no list has (a terminal the dragging window has not
  // spawned yet) and nothing to place. False is a tab this window shows, or a drag of its own, which
  // is the ordinary local drop.
  const dropFromOtherWindow = useCallback(
    (id: string, local: boolean, leafId: string, where: Placement['where']): boolean => {
      if (visibleTabsRef.current.some((t) => t.id === id)) return false;
      if (!heldElsewhere(tabsRef.current, visibleTabsRef.current, id)) return !local;
      if (moveTabsToWindow([id], myWindow)) placeInLayout({ id, leafId, where });
      return true;
    },
    [moveTabsToWindow, myWindow, placeInLayout],
  );
  const dropOnEdge = useCallback(
    (leafId: string, side: Side, dropped: string | null) => {
      const local = dragTabIdRef.current;
      const id = local ?? dropped;
      setDragTabId(null);
      if (!id) return;
      if (dropFromOtherWindow(id, local !== null, leafId, side)) return;
      commitLayout((current) => {
        const tab = refOfTab(current, id);
        return tab ? splitPane(current, leafId, side, tab, tabOrder()) : current;
      });
    },
    [commitLayout, refOfTab, tabOrder, dropFromOtherWindow],
  );
  const moveTabInto = useCallback(
    (id: string, leafId: string) =>
      commitLayout((current) => moveTab(current, id, leafId, tabOrder())),
    [commitLayout, tabOrder],
  );
  const dropOnCentre = useCallback(
    (leafId: string, dropped: string | null) => {
      const local = dragTabIdRef.current;
      const id = local ?? dropped;
      setDragTabId(null);
      if (!id || dropFromOtherWindow(id, local !== null, leafId, 'centre')) return;
      moveTabInto(id, leafId);
    },
    [moveTabInto, dropFromOtherWindow],
  );
  // The New-tab page has no pane mounted, only the focused pane's strip, and takes an external drop
  // into that one pane. Only an external drag has an overlay there.
  const dropOnNewTabPage = useCallback(
    (id: string | null) => {
      const leafId = layoutRef.current?.focused;
      if (id && leafId) dropFromOtherWindow(id, false, leafId, 'centre');
    },
    [dropFromOtherWindow],
  );

  // A sash drag resizes the layout it BEGAN on by the drag's cumulative delta, so the deltas never
  // compound: `sashStartRef` is that layout, taken when the drag starts and dropped when it ends
  // however it ends (release, cancel, or the sash unmounting). Each frame is drawn live and saved
  // only at the end.
  const sashDragging = useCallback((on: boolean) => {
    sashStartRef.current = on ? layoutRef.current : null;
    sashFrameRef.current = sashStartRef.current;
  }, []);
  const dragSash = useCallback(
    (sash: SashGeometry, deltaFraction: number) => {
      const start = sashStartRef.current;
      if (!start) return;
      // A broadcast reshaped the layout under the drag (another window closed a pane): `start` is
      // from before it, and applying the delta to it would put the old shape back. Later frames
      // are ignored until the next drag; the release saves what the broadcast left.
      if (layoutRef.current !== sashFrameRef.current) {
        sashStartRef.current = null;
        return;
      }
      const next = resizeSash(start, sash.path, sash.index, deltaFraction);
      sashFrameRef.current = next;
      layoutRef.current = next;
      setLiveLayout(next);
    },
    [setLiveLayout],
  );
  // Reads the layout from the ref, not from state: it runs right after the final frame, before
  // React has rendered it, and also from a sash's unmount path after a broadcast reshaped the
  // layout. Whichever it is, the ref holds the layout the window now has.
  const settleSash = useCallback(() => {
    sashStartRef.current = null;
    if (layoutRef.current) commitLayoutValue(layoutRef.current);
  }, [commitLayoutValue]);

  // One pane's strip. Every callback that depends on the pane is made once per pane and keeps its
  // identity (reading the layout through refs), so a sash frame, which re-renders GroupsView, does
  // not redraw a strip: `SessionTabs` is memoized on these props.
  interface StripHandlers {
    onNewTab: () => void;
    onReorder: (
      id: string,
      index: number,
      joinGid?: string,
      anchor?: GroupEdge,
      boundary?: boolean,
    ) => void;
    onDropFromOtherPane: (id: string) => void;
    onMoveGroup: (gid: string, index: number, anchor?: GroupEdge) => void;
    base: TabGrouping;
    grouping: TabGrouping;
  }
  const stripHandlers = useRef(new Map<string, StripHandlers>());
  // A pane that is gone takes its handlers with it, so the map is as long as the layout and a pane
  // that later reuses the id (a restore with no saved layout mints `p0` again) starts with its own.
  useEffect(() => {
    const live = new Set(layout ? leaves(layout).map((l) => l.id) : []);
    for (const id of stripHandlers.current.keys()) {
      if (!live.has(id)) stripHandlers.current.delete(id);
    }
  }, [layout]);
  const handlersFor = (leafId: string): StripHandlers => {
    let handlers = stripHandlers.current.get(leafId);
    if (!handlers) {
      const created: StripHandlers = {
        // `+` focuses its pane first, so the chooser's creation lands there: every creation path
        // targets "the focused pane", and none needs to correlate a request with its answer.
        onNewTab: () => {
          focusLeafById(leafId);
          openNewTab();
        },
        onReorder: (id, index, joinGid, anchor, boundary) =>
          doReorder(leafTabIds(leafId), id, index, joinGid, anchor, boundary),
        onDropFromOtherPane: (id) => {
          const local = dragTabIdRef.current !== null;
          setDragTabId(null);
          if (!dropFromOtherWindow(id, local, leafId, 'centre')) moveTabInto(id, leafId);
        },
        onMoveGroup: (gid, index, anchor) => moveGroup(leafTabIds(leafId), gid, index, anchor),
        base: tabGrouping,
        grouping: tabGrouping,
      };
      created.grouping = { ...tabGrouping, onMoveGroup: created.onMoveGroup };
      stripHandlers.current.set(leafId, created);
      handlers = created;
    }
    if (handlers.base !== tabGrouping) {
      handlers.base = tabGrouping;
      handlers.grouping = { ...tabGrouping, onMoveGroup: handlers.onMoveGroup };
    }
    return handlers;
  };
  // No pane mounted, so there is nothing for a drop overlay to cover: the page takes one of its own.
  // `onChooserPage`, not `chooserPage`: the render that empties the focused pane is already the page,
  // or the pane host mounts a pane for the tab its id came back as.
  const newTabPageUp = onChooserPage || !sessionId;
  const renderStrip = (leaf: PaneLeaf) => {
    const handlers = handlersFor(leaf.id);
    return (
      <SessionTabs
        paneId={leaf.id}
        tabs={stripTabs(leaf.id)}
        allTabs={visibleTabs}
        current={onChooserPage ? '' : (leaf.active ?? '')}
        dirty={dirtyTabs}
        onSwitch={selectTab}
        onNewTab={handlers.onNewTab}
        onClose={closeTab}
        onCloseMany={closeMany}
        onRename={renameTab}
        onRecolor={recolorTab}
        onSplit={doSplit}
        // Only where a new window can hold the tab: the server supports it, and not on a phone.
        onPopout={capDetached && !mobileActive ? doPopout : undefined}
        onMoveToMain={detached ? doMoveToMain : undefined}
        onDrag={onDragTab}
        dragTabId={dragTabId}
        externalDrag={externalDrag}
        onReorder={handlers.onReorder}
        onDropFromOtherPane={handlers.onDropFromOtherPane}
        grouping={handlers.grouping}
      />
    );
  };

  return (
    <div className={`app${detached ? ' detached' : ''}${mobileActive ? ' mobile' : ''}`}>
      {/* An empty drag region: in window-controls-overlay mode the native controls lie over the
          top of the window, and this keeps them off the panes and the rail (CSS shows it only
          there). There is no topbar: each pane draws its own tab strip, and the app menu is the
          dock rail's first control. A detached window has no rail, and is not an installed window,
          so it draws none. */}
      {!mobileActive && !detached && <div className="wco-titlebar" />}

      <div className="content-row">
        <div className="content-area" ref={contentRef}>
          {/* The pane grid: every strip, terminal, non-terminal pane, drop overlay and sash is a flat
              child of GroupsView, placed by the rects the layout computes. */}
          <ReviewHostContext.Provider value={reviewHost}>
            <GroupsView
              layout={layout}
              rects={paneRects}
              sashes={sashes}
              strips={groupsEnabled}
              // No selection yet: the one render between the layout appearing and the
              // selection being read off it. A pane on an empty id would open `/ws?session=`.
              chooserPage={newTabPageUp}
              dragTabId={dragTabId}
              externalDrag={externalDrag}
              renderStrip={renderStrip}
              onFocusLeaf={focusLeafById}
              onDropEdge={dropOnEdge}
              onDropCentre={dropOnCentre}
              onSashDrag={dragSash}
              onSashSettle={settleSash}
              onSashDragging={sashDragging}
              resizeBusy={dockBusy}
              containerRef={contentRef}
              registry={registry}
              settings={paneSettings}
              mobileActive={mobileActive}
              maxUploadBytes={maxUploadBytes}
              paneBlocked={paneBlocked}
              onAutoCopy={onAutoCopy}
              onUploadError={onUploadError}
              onFocusRequest={focusLeafById}
              takeSpawnTmux={takeSpawnTmux}
              terminalGestures={terminalGestures}
              window={myWindow}
              tabs={visibleTabs}
              webApps={webApps}
              quickLinks={settings.quickLinks}
              onCreate={createTab}
              onUpdateQuickLinks={updateQuickLinks}
              onChangeUrl={changeTabUrl}
              onPaneDirty={onPaneDirty}
              onPaneFocus={focusPaneOf}
              paneMenu={mobileActive ? openDrawer : undefined}
            />
          </ReviewHostContext.Provider>

          {/* Closing the last tab lands here: the chooser as an ACTUAL page. */}
          {chooserPage && (
            <div className="newtab-page" data-testid="newtab-page">
              <NewTabChooser
                webApps={webApps}
                quickLinks={settings.quickLinks}
                onCreate={createTab}
                onUpdateQuickLinks={updateQuickLinks}
                onPin={() => createTab({ kind: 'dashboard' })}
                onMenu={mobileActive ? openDrawer : undefined}
              />
            </div>
          )}

          {/* A tab dragged in from another window lands anywhere on the page, in its one pane. The
              pane grid draws no overlay of its own while the page is up. */}
          {newTabPageUp && externalDrag && (
            <GroupDropOverlay
              rect={WHOLE_AREA}
              canSplit={false}
              canCentre
              centreOnly
              onDropEdge={noopDrop}
              onDropCentre={dropOnNewTabPage}
            />
          )}

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

        {/* The main window on desktop only: on mobile the drawer is the view container and the rail
            is forced off, so the terminal keeps the whole screen. A detached window has no dock. */}
        {!mobileActive && !detached && (
          <DockPanel
            view={dockView}
            onView={openDockView}
            actions={railActions}
            menu={{ items: appMenuItems }}
          >
            {dockView === 'settings' && (
              <ConfigEditor mode={cfgMode} onMode={setCfgMode} onDirtyChange={onConfigDirty} />
            )}
            {dockView === 'settings' && cfgMode === 'form' && (
              <SettingsFields
                settings={settings}
                onChange={changeSettings}
                fontFamilies={fontFamilies}
                onOpenKeybindings={() => setPanel('keybindings')}
                onOpenTips={() => setPanel('tips')}
                onImportTheme={onImportTheme}
                importingTheme={importingTheme}
                appVersion={knownVersionRef.current}
                onReloadApp={guardedReload}
                onEditConfig={() => setCfgMode('raw')}
                editConfigRef={editConfigRef}
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
            {dockView === 'scm' && (
              // Mounted only while it is the open dock view, so it is visible by
              // construction; the store adds the foreground-window check.
              <SourceControlView
                repos={settings.scmRepos}
                activeRepo={activeScmRepo}
                visible
                onChange={updateSettings}
                onOpenFile={openReview}
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

      {mobileActive && (
        <SessionDrawer
          open={drawerOpen}
          tabs={visibleTabs}
          // The page shows no tab, though `sessionId` keeps the closed one. The drawer appends a
          // `current` it does not list as a terminal row, and a tap on that row would mount a pane
          // that attaches and spawns a shell on the closed id.
          current={onChooserPage ? '' : sessionId}
          groups={groups}
          collapsed={collapsedGroups}
          onToggleGroup={toggleGroup}
          onSwitch={switchSession}
          onCreate={openNewTab}
          onKill={closeTab}
          onClose={closeDrawer}
          {...drawerTreeProps}
          // The sheet opens OVER the drawer (it stacks higher), so a rename or a
          // colour change lands you back in the list you pressed in.
          onTabMenu={setSheetTabId}
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
                      closeDrawer(); // creating navigates; get out of the way
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
                      closeDrawer();
                    }}
                    pins={settings.explorerPins}
                    onPinsChange={(explorerPins) => updateSettings({ explorerPins })}
                    onNotice={showToast}
                  />
                ),
              }
            : drawerView === 'scm'
              ? {
                  viewContent: (
                    <SourceControlView
                      repos={settings.scmRepos}
                      activeRepo={activeScmRepo}
                      // The drawer stays mounted while it is closed, so being mounted
                      // is not being seen: a closed drawer must not keep the poll alive.
                      visible={drawerOpen}
                      onChange={updateSettings}
                      onOpenFile={(target) => {
                        closeDrawer(); // opening navigates; get out of the way first
                        openReview(target);
                      }}
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
                          closeDrawer();
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
          onImportTheme={onImportTheme}
          importingTheme={importingTheme}
          appVersion={knownVersionRef.current}
          onReloadApp={guardedReload}
        />
      )}

      {sheetTabId !== null && !detached && (
        <TabSheet
          tab={visibleTabs.find((t) => t.id === sheetTabId) ?? { id: sheetTabId, kind: 'terminal' }}
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

      {/* A review has no terminal to type into, so it gets its own bar in the extra-keys
          bar's slot (the extra-keys bar is not rendered at all, and returns with the
          next tab that is not a review). Both keep the drawer swipe. */}
      {/* The New-tab page shows no review, whatever the id it keeps came back as. */}
      {mobileActive && activeTab.kind === 'review' && !onChooserPage && (
        <ReviewBar
          group={parseReviewUrl(activeTab.url ?? '')?.group ?? 'changes'}
          onFiles={openSourceControl}
          onPreviousFile={() => reviewApiFor(activeTab.id)?.prevFile()}
          onNextFile={() => reviewApiFor(activeTab.id)?.nextFile()}
          onReview={() => reviewApiFor(activeTab.id)?.reviewCurrent()}
          // Right→left pulls in the drawer, as on the extra-keys bar; left→right goes
          // back to where the review was opened from.
          onSwipe={(dir) => (dir === 'right' ? leaveReview() : openDrawer())}
        />
      )}
      {mobileActive && (activeTab.kind !== 'review' || onChooserPage) && (
        <ExtraKeysBar
          ref={barRef}
          config={extraKeys}
          // A bar with the drawer swipe is ALWAYS present on mobile, whatever the tab
          // is. The extra-keys bar used to hide on a non-terminal tab, which looked
          // tidy and was a TRAP: the bar is the only route to the drawer
          // (right→left swipe), and mobile has no tab strip, so opening a file from
          // the Explorer left no way to switch tabs, close it, or reach anything
          // else. Measured: header showed only Read/Edit, bar hidden, no exit. A
          // review swaps this bar for the review bar, which keeps that route.
          visible={extraKeys.enabled}
          send={sendInput}
          sendKey={sendKeyToEditor}
          isBlocked={barBlocked}
          onHeightChange={onBarHeight}
          onAction={(a) => {
            if (a === 'keyboard') kbd.toggle();
            else if (a === 'dictate') dictation.toggle();
          }}
          // Swipe LEFT→RIGHT always raises the keyboard (never toggles — "open
          // it, no matter what"); RIGHT→LEFT pulls in the drawer from the
          // right edge, matching the direction of travel.
          onSwipe={(dir) => (dir === 'right' ? kbd.raise() : openDrawer())}
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

      {/* A detached window has no dock to host the New-tab chooser, so it opens here. Creating a
          tab closes it (`createTab`); Radix closes it on Escape and on an overlay press. It asks
          nothing, so it has no confirm: Close is its one action. */}
      {detached && (
        <Dialog
          open={newTabDialog}
          onOpenChange={setNewTabDialog}
          title="New tab"
          cancelLabel="Close"
          data-testid="newtab-dialog"
        >
          <DashboardBody
            webApps={webApps}
            quickLinks={settings.quickLinks}
            onCreate={createTab}
            onUpdateQuickLinks={updateQuickLinks}
          />
        </Dialog>
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
