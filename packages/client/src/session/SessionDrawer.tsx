// ── Mobile session drawer ─────────────────────────────────────────────────────
//
// Replaces the desktop top bar on mobile. It lives on the RIGHT edge: a
// right→left swipe across the extra-keys bar pulls it in (the direction of
// travel). It covers the full height and three quarters of the width (at most 340px),
// and the uncovered part is the scrim strip, never under 44px, so a thumb can always
// reach the terminal side to close it. There is no close
// button: the scrim strip, a swipe and every action that leaves the drawer close
// it, and Escape does for a keyboard or assistive tech that has focus in here.
// Lists every workspace tab as a colour dot, a title and a subdued number; a
// non-terminal tab adds its kind icon. A row is compact (`--drawer-row-h`, 28px
// under the mobile class) so more of them fit above the footer.
//
// Reach order, bottom → top: the footer, the bottom-anchored session list, and at
// the very top ONE row — the view switcher and, at its right end where Close used
// to be, a gear for Settings. The row is the root level's alone: Settings and the
// new-tab chooser sit under a back header and draw no switcher. The switcher is up
// there because the owner does not want it at the bottom. Settings is a VIEW of this drawer, not a modal (a dialog stacked
// over the terminal is strictly worse on a phone), and its fields come from
// settings/SettingsFields so this and the desktop DOCK share one definition. The
// switcher is the kit Segmented over the surfaces the dock rail also hosts, wearing
// the rail's own icons (imported from DockPanel — one icon set).
//
// `view` is optional and the control is uncontrolled without it, defaulting to
// the session list — a host that passes nothing gets exactly today's drawer.
// The three views with no built-in body (files, Source Control, dictation) are
// rendered by the HOST through `viewContent`, and a host that cannot render one
// must not offer it — an enabled segment that opens an empty drawer is worse than
// no segment.
// Availability is therefore declared UP FRONT in `hostedViews`, not inferred
// from `viewContent`: content necessarily tracks the SELECTED view, so a host
// can only supply it once the view is already active, and inferring from it
// disabled every hosted view forever (they could never become active).
//
// A pointer acts through POINTER events, never through its click, so using the
// drawer doesn't blur the hidden #mobile-kbd textarea and dismiss the soft
// keyboard. Which pointer event depends on whether the control can be scrolled
// past:
//   * fixed chrome acts on pointerdown + preventDefault. The scrim is a bare
//     <div> nothing can focus, so `press` is enough there. Every fixed BUTTON
//     (both back headers, the gear, the footer cells) uses `pressClick`,
//     which also acts on click: a focusable button that ignores Enter, Space and
//     an assistive-tech click is a control that only some users can operate;
//   * anything in a LIST uses the pointerup-with-slop form (`pressMove`, and the
//     row gestures below), because preventDefaulting a touch pointerdown cancels
//     the browser's pan and firing on pointerdown means the finger that came to
//     scroll has already picked whatever it landed on.
// Whatever a pointer press acts on, it first marks its gesture (`consumeGesture`),
// because the action redraws the spot under the finger (the scrim and a row tap
// close the drawer over the terminal, a held row opens its sheet over the list)
// and the browser delivers the rest of the tap, its compatibility mousedown and
// mouseup and then its click, to whatever is there by then. The mark swallows
// them wherever they land, so a click that does reach a `pressClick` or
// `pressMove` control is a keyboard, assistive-tech or `element.click()`
// activation, and it acts. The rows still read the click's count (`rowProps`).
// The settings fields are the exception either way: an <input> or a Select must
// take focus to work at all.
//
// ── Row gestures ──────────────────────────────────────────────────────────────
//
// One press at a time, driven by pointer events (no HTML5 `draggable`: it would
// compete with the list's pan and with the menu). The list root owns move/up/
// cancel, so the same handlers see the press whether or not a drag has taken
// pointer capture.
//
//   pressed ── held 450ms, under 10px ─▶ armed ── released ─▶ the row menu (tabs)
//      │                                   └── moved >10px ─▶ dragging ─▶ drop
//      └── moved >10px first ─▶ moved: a scroll, or a swipe (left >32px reveals
//          the row's Close) — never a menu, never a drag
//
// A row's Close hides again on any press that is not on it: a press on a row only
// puts the open one back (it does not also switch tabs or start a long-press), a
// press elsewhere in the drawer does the same, and so do a scroll and the drawer
// closing. That is what makes a swipe right, a tap elsewhere and a scroll "hide".
//
// Before arming nothing is prevented, so the browser pans as it always did. After
// arming the browser would still start a pan on the next move and cancel the
// pointer, so ONE non-passive `touchmove` listener cancels it, and only while the
// press is armed or dragging. A drag lifts the row on `transform` alone and shows
// the drop `dropAt`/`accepts` resolve (drawer-tree.ts); App turns the release into
// the existing reorder/group messages.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { TabGroup, TabMeta } from '@palmux/shared';
import { displayTitle, kindIcon, tabColorInk, tabColorValue } from './tab-meta';
import { groupIdOf, NO_COLLAPSED } from './tab-groups';
import {
  accepts,
  buildNodes,
  dropAt,
  groupValue,
  hasNode,
  isGroupValue,
  ROOT_DROP,
  tabValue,
  toRows,
  type DrawerDrop,
  type DrawerNode,
  type DrawerRow,
} from './drawer-tree';
import { ICONS as DOCK_ICONS, type IconName } from './DockPanel';
import { SettingsFields, type SettingsSubView } from '../settings/SettingsFields';
import { ErrorBoundary, IconButton, Segmented, type SegmentedOption } from '../ui';
import { Icon } from '../ui/icons';
import { useLeavingItems, type TrackedRow } from '../ui/useLeavingItems';
import { consumeGesture, press, pressClick, pressMove } from '../panes/press';
import type { ClientSettings, ThemeTarget } from '../settings/settings';
import './drawer-views.css';

const LONG_PRESS_MS = 450;

/** Finger travel that turns a row press into a scroll (matches panes/press.ts). */
const ROW_SLOP_PX = 10;

/** Leftward travel that reveals a row's Close action. */
const SWIPE_REVEAL_PX = 32;

/** How close to the list's top or bottom edge a drag starts scrolling it. */
const EDGE_SCROLL_PX = 40;

/** The fastest an edge scroll goes, per frame. */
const EDGE_SCROLL_MAX_PX = 12;

const KBD_ID = 'mobile-kbd';

/** Default for `hostedViews`: a stable reference, so it isn't a new array per render. */
const NO_HOSTED_VIEWS: readonly DrawerView[] = [];

/** The drawer's top-level surfaces — the dock rail's set, with the session list
 *  standing in for the dock's New-tab view. */
export type DrawerView = 'sessions' | 'settings' | 'files' | 'scm' | 'dictation';

/**
 * The switcher's segments. Settings is not one of them: it is the gear beside the
 * switcher in the top row, and a segment for it as well would be two entries for
 * one place. `hosted` = the drawer has no body of its own for it, so it needs
 * `viewContent`.
 */
const SWITCHER_VIEWS: { id: DrawerView; icon: IconName; label: string; hosted: boolean }[] = [
  { id: 'sessions', icon: 'sessions', label: 'Sessions', hosted: false },
  { id: 'files', icon: 'files', label: 'Explorer', hosted: true },
  { id: 'scm', icon: 'scm', label: 'Source Control', hosted: true },
  { id: 'dictation', icon: 'dictation', label: 'Dictation', hosted: true },
];

/** Human name per view, for the error boundary. */
const VIEW_LABEL: Record<DrawerView, string> = {
  sessions: 'Sessions',
  settings: 'Settings',
  files: 'Explorer',
  scm: 'Source Control',
  dictation: 'Dictation',
};

/** What the drawer can ask `onClose` for. `picker` hides it but keeps the layout hold. */
export interface DrawerCloseRequest {
  holdUntil: 'picker';
}

interface SessionDrawerProps {
  open: boolean;
  tabs: TabMeta[];
  current: string;
  /** Live tab groups (strip-ordered). */
  groups?: TabGroup[] | undefined;
  /** Collapsed group ids (shared per-device set). */
  collapsed?: ReadonlySet<string> | undefined;
  onSwitch: (id: string) => void;
  onCreate: () => void;
  /** Closes a tab — the host owns the confirmation a terminal or a dirty editor needs. */
  onKill: (id: string) => void;
  /** The one way out. Pass `{ holdUntil: 'picker' }` only when a native picker just opened. */
  onClose: (request?: DrawerCloseRequest) => void;
  /** Long-press then release on a row: open the rename/color/close sheet for that tab. */
  onTabMenu: (id: string) => void;
  /** Tap a group header to collapse/expand (shared with the desktop strip). */
  onToggleGroup?: ((gid: string) => void) | undefined;
  /** A tab dropped between rows, on a group header, or on the root area. */
  onMoveTab?: ((id: string, drop: DrawerDrop) => void) | undefined;
  /** A group header dropped, as a block, before or after a top-level row. */
  onMoveGroup?: ((gid: string, drop: DrawerDrop) => void) | undefined;
  /** The drawer's footer toolbar — a bundle of unrelated global actions. */
  actions: DrawerActions;
  /** Live client settings, rendered as the drawer's ⚙ view. */
  settings: ClientSettings;
  onChangeSettings: (partial: Partial<ClientSettings>) => void;
  fontFamilies?: string[] | undefined;
  /** Keybindings stay a modal — the editor needs the room. */
  onOpenKeybindings?: (() => void) | undefined;
  onOpenTips?: (() => void) | undefined;
  onImportTheme?: ((source: string, target: ThemeTarget) => void) | undefined;
  importingTheme?: boolean | undefined;
  /** Server build the client last saw, shown next to the reload control. */
  appVersion?: string | undefined;
  /**
   * The reload behind Settings → Reload app; resolves `false` when the user
   * cancelled. Omit it and the row reloads unguarded, as `SettingsFields` does.
   */
  onReloadApp?: (() => Promise<boolean>) | undefined;
  /** Controlled view. Omit it and the drawer keeps its own, starting on 'sessions'. */
  view?: DrawerView | undefined;
  onView?: ((view: DrawerView) => void) | undefined;
  /** Body for a view the drawer has none for, in place of the session list. */
  viewContent?: ReactNode | undefined;
  /**
   * Hosted views this host can render. Anything not listed stays disabled — the
   * default is NONE, so a host that passes no bodies gets the sessions-only
   * drawer unchanged.
   */
  hostedViews?: readonly DrawerView[] | undefined;
  /**
   * The new-tab chooser, shown in place of the session list when `+ New tab` is
   * pressed. A SUB-SURFACE of the session view, not a segment of its own: the list
   * and the chooser are the same job (pick where to go), which is why the switcher
   * has four segments and the dock's New-tab rail item maps onto this list.
   * Omit it and `+ New tab` just calls `onCreate`, as before.
   */
  newTabContent?: ReactNode | undefined;
  /** Leave the chooser, back to the session list. */
  onNewTabBack?: (() => void) | undefined;
}

export interface DrawerActions {
  /** Any-file picker. On Android this is the one that asks photo/video/file. Answers whether a picker opened. */
  uploadFile: () => boolean;
  /** Image-only picker — opens the gallery directly, multi-select. Answers whether a picker opened. */
  uploadImages: () => boolean;
  downloadFile: () => void;
  /** Start / stop voice dictation (the recording pill stops it too). */
  dictate: () => void;
}

/** One row of the list, with everything its render needs so a row that is
 *  leaving can still be drawn from the last copy the hook kept. */
type ListItem =
  | {
      kind: 'group';
      key: string;
      group: TabGroup;
      memberCount: number;
      collapsed: boolean;
      memberActive: boolean;
    }
  | {
      kind: 'tab';
      key: string;
      tab: TabMeta;
      active: boolean;
      /** The group the tab sits in, if any: its colours reach the member's leaf. */
      group: TabGroup | undefined;
    };

type Phase = 'pressed' | 'moved' | 'armed' | 'dragging';

/** The live press. Read and written from event handlers, never rendered from. */
interface Gesture {
  pointerId: number;
  /** The row's tree value: `t:<tabId>` or `g:<groupId>`. */
  key: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  /** The list's scroll position when the finger landed, so a scroll during the drag moves the lift with it. */
  scrollTop: number;
  phase: Phase;
  /** A `moved` press has been read as a scroll or a swipe; it is not read twice. */
  settled: boolean;
  /** Whether `#mobile-kbd` held focus at pointerdown, to put it back on a tap. */
  hadKbd: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  frame: number | null;
  /** The lifted `.drawer-row`, once a drag starts. */
  rowEl: HTMLElement | null;
  /** The drop under the finger that `accepts` allows; what a release commits. */
  drop: DrawerDrop | null;
}

/** The raw id behind a tree value (`t:3` → `3`, `g:g1a2b3` → `g1a2b3`). */
const idOf = (key: string): string => key.slice(2);

const kbdFocused = (): boolean => document.activeElement?.id === KBD_ID;

const sameDrop = (a: DrawerDrop | null, b: DrawerDrop | null): boolean =>
  a === b || (a !== null && b !== null && a.target === b.target && a.position === b.position);

interface Frame {
  /** The segment classes, each with its leading space. */
  classes: string;
  /** For a bridge, the live group whose frame it carries. */
  bridges: TabGroup | null;
}

const NO_FRAME: Frame = { classes: '', bridges: null };

/**
 * Where each row's leaf sits in its group's frame, as the classes the stylesheet
 * draws segments from. A group is one frame around its header and its visible
 * members, but the rows are flat leaves, so each leaf draws its own piece of it.
 *
 * Positions come from the rows that are NOT leaving: a row on its way out is still
 * drawn, and a frame edge on it would ride up with its shrinking slot, fading, while
 * the new last row draws its own. So `group-last` moves up to the surviving row above
 * at once, and a folding group's header is first AND last the moment the fold starts.
 * A leaving row then draws one of two things. With surviving rows of a group on
 * both sides of it it is a `group-bridge` of THAT group, the two sides only, so the
 * frame stays unbroken between the rows either side while its slot shrinks. That
 * group is usually its own (a first or middle member closing), but need not be: a
 * tab dropped from the group below into the group above empties its old group,
 * whose header leaves from where it sat, between the two rows of the group it
 * joined. So a bridge names the live group it holds together, and its sides take
 * that group's colour while the row fades in its own. Anywhere else (the last
 * member closing, every member of a fold) it draws nothing: the frame has already
 * closed above it.
 */
function frameClasses(rows: readonly TrackedRow<ListItem>[]): Frame[] {
  const alive = new Map<string, { group: TabGroup; first: number; last: number }>();
  rows.forEach((row, index) => {
    const group = row.item.group;
    if (group === undefined || row.phase === 'leaving') return;
    const span = alive.get(group.id);
    if (span) span.last = index;
    else alive.set(group.id, { group, first: index, last: index });
  });
  const spans = [...alive.values()];
  return rows.map((row, index): Frame => {
    if (row.phase === 'leaving') {
      // Live groups are contiguous, so at most one has survivors on both sides.
      const around = spans.find((span) => span.first < index && index < span.last);
      return around ? { classes: ' group-bridge', bridges: around.group } : NO_FRAME;
    }
    const span = row.item.group === undefined ? undefined : alive.get(row.item.group.id);
    if (span === undefined) return NO_FRAME;
    const { first, last } = span;
    if (index === first) {
      return {
        classes: index === last ? ' group-first group-last' : ' group-first',
        bridges: null,
      };
    }
    return { classes: index === last ? ' group-last' : ' group-mid', bridges: null };
  });
}

/**
 * Pixels per frame a drag scrolls the list, signed, for a finger at `y`: nothing
 * outside the list or in its middle, ramping up to the maximum at the very edge.
 */
function edgeSpeed(y: number, rect: { top: number; bottom: number }): number {
  const fromTop = y - rect.top;
  const fromBottom = rect.bottom - y;
  if (fromTop < 0 || fromBottom < 0) return 0;
  const ramp = (distance: number) =>
    Math.ceil(((EDGE_SCROLL_PX - distance) / EDGE_SCROLL_PX) * EDGE_SCROLL_MAX_PX);
  if (fromTop < EDGE_SCROLL_PX) return -ramp(fromTop);
  if (fromBottom < EDGE_SCROLL_PX) return ramp(fromBottom);
  return 0;
}

/** Whether the list can still move the way `speed` points. */
const canScroll = (list: HTMLElement, speed: number): boolean =>
  speed < 0 ? list.scrollTop > 0 : list.scrollTop + list.clientHeight < list.scrollHeight;

/** The drop under the finger, or null when it is outside the drawer's list (a cancel). */
function dropUnder(g: Gesture, list: HTMLElement): DrawerDrop | null {
  const box = list.getBoundingClientRect();
  if (g.x < box.left || g.x > box.right || g.y < box.top || g.y > box.bottom) return null;
  for (const leaf of list.querySelectorAll<HTMLElement>('[data-row-key]')) {
    if (leaf.dataset['phase'] === 'leaving') continue;
    const rect = leaf.getBoundingClientRect();
    if (g.y > rect.bottom) continue;
    const key = leaf.dataset['rowKey'] ?? '';
    return dropAt(rect, g.y, key, isGroupValue(key));
  }
  // Below the last row: the root area, which exists even when every tab is grouped.
  return ROOT_DROP;
}

/** The row `drop` points at, and which of its edges carries the mark. */
type DropMark = { key: string; position: 'before' | 'after' | 'inside' } | 'root' | null;

/**
 * Where to draw the resolved drop. A drop AFTER an open group header lands after
 * the whole block, so its line goes under the group's last visible member — a
 * line under the header would read as "first member". The dragged row is never
 * that member: it is lifted on `transform`, so a line on it would follow the
 * finger instead of marking the slot.
 */
function markFor(
  drop: DrawerDrop | null,
  rows: readonly DrawerRow[],
  dragKey: string | null,
): DropMark {
  if (drop === null) return null;
  if (drop.target === null) return 'root';
  if (drop.position === 'after' && isGroupValue(drop.target)) {
    const last = rows.findLast((row) => row.parent === drop.target && row.key !== dragKey);
    if (last) return { key: last.key, position: 'after' };
  }
  return { key: drop.target, position: drop.position };
}

export const SessionDrawer = ({
  open,
  tabs,
  current,
  groups,
  collapsed,
  onSwitch,
  onCreate,
  onKill,
  onClose,
  onTabMenu,
  onToggleGroup,
  onMoveTab,
  onMoveGroup,
  actions,
  settings,
  onChangeSettings,
  fontFamilies,
  onOpenKeybindings,
  onOpenTips,
  onImportTheme,
  importingTheme,
  appVersion,
  onReloadApp,
  view: viewProp,
  onView,
  viewContent,
  hostedViews = NO_HOSTED_VIEWS,
  newTabContent,
  onNewTabBack,
}: SessionDrawerProps) => {
  const [ownView, setOwnView] = useState<DrawerView>('sessions');
  const view = viewProp ?? ownView;
  // Reopening always lands on the session list. Done in a layout effect so the
  // switch happens before paint — resetting after the open transition started
  // would flash the settings view. A controlled host is NOT reset for it: its
  // view is its own state, and reaching into it from here would fight it.
  useLayoutEffect(() => {
    if (open) setOwnView('sessions');
  }, [open]);

  const selectView = (next: DrawerView) => {
    setOwnView(next);
    onView?.(next);
  };

  // Settings' own sub-view (the theme browser), LIFTED out of SettingsFields so
  // that this drawer's back header can pop it before it leaves Settings: with the
  // state inside the form the header could only ever leave, and a phone would
  // lose the whole panel to step back from one list. Dropped whenever Settings
  // is not the view — a layout effect, so a view changed by a controlled host
  // cannot bring a stale sub-view back with it.
  const [settingsSub, setSettingsSub] = useState<SettingsSubView>(null);
  useLayoutEffect(() => {
    if (view !== 'settings') setSettingsSub(null);
  }, [view]);

  const viewOptions: SegmentedOption<DrawerView>[] = SWITCHER_VIEWS.map((v) => ({
    value: v.id,
    label: (
      <>
        {DOCK_ICONS[v.icon]}
        <span className="drawer-view-name">{v.label}</span>
      </>
    ),
    disabled: v.hosted && !hostedViews.includes(v.id),
  }));

  // The root level is the sessions list and the hosted views, and it is where the
  // top row (switcher · gear) lives. Settings and the chooser are
  // sub-surfaces under a back header, which is the drawer's top control there: a
  // second row above it would push the way back down the screen, and the switcher
  // goes with that row, so reaching Explorer or Dictation from there is one back
  // press away, the depth the chooser already has.
  const chooserOpen = view === 'sessions' && newTabContent !== undefined;
  const atRoot = view !== 'settings' && !chooserOpen;

  // Append a not-yet-broadcast current at the END (no numeric sort — that would
  // scramble grouped members, which must stay in strip order under their header).
  const tabList: TabMeta[] =
    !current || tabs.some((t) => t.id === current)
      ? tabs
      : [...tabs, { id: current, kind: 'terminal' as const }];
  const liveGroups = groups ?? [];
  const collapsedSet = collapsed ?? NO_COLLAPSED;
  const currentGroupId = groupIdOf(tabList, current);

  // The list is the tree the drag maths runs on (drawer-tree.ts), flattened to the
  // rows that are showing: a collapsed group's members are not rows, and `expanded`
  // names node values, not bare group ids.
  const nodes = buildNodes(tabList, liveGroups);
  const expanded = new Set<string>();
  for (const g of liveGroups) if (!collapsedSet.has(g.id)) expanded.add(groupValue(g.id));
  const rows = toRows(nodes, expanded);
  const tabByValue = new Map(tabList.map((t) => [tabValue(t.id), t]));
  const groupByValue = new Map(liveGroups.map((g) => [groupValue(g.id), g]));
  // A row carries its group, so its leaf can wear the group's colours and its place
  // in the frame (frameClasses), a header and a member alike.
  const items: ListItem[] = rows.flatMap((row): ListItem[] => {
    const { key } = row;
    if (isGroupValue(key)) {
      const group = groupByValue.get(key);
      if (!group) return [];
      return [
        {
          kind: 'group',
          key,
          group,
          memberCount: row.node.children?.length ?? 0,
          collapsed: !expanded.has(key),
          memberActive: currentGroupId === group.id,
        },
      ];
    }
    const tab = tabByValue.get(key);
    if (!tab) return [];
    return [
      {
        kind: 'tab',
        key,
        tab,
        active: tab.id === current,
        group: row.parent === null ? undefined : groupByValue.get(row.parent),
      },
    ];
  });
  // A closed tab, or a collapsed group's members, stay drawn for the micro tier
  // while their own space closes, so the rows below glide up instead of jumping.
  const tracked = useLeavingItems(items, (item) => item.key);
  const frames = frameClasses(tracked);

  // ── Gesture state ──────────────────────────────────────────────────────────
  const listRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const revealedRef = useRef<string | null>(null);
  // Set by the keyboard route to a row's Close, so focus follows once it is visible.
  const focusRevealRef = useRef(false);
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ key: string; drop: DrawerDrop | null } | null>(null);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  // What the handlers read: they are bound once per press and outlive the render
  // that made them, so a closure would act on a list that has since changed.
  const latest = useRef({
    nodes,
    onSwitch,
    onClose,
    onTabMenu,
    onToggleGroup,
    onMoveTab,
    onMoveGroup,
  });
  latest.current = { nodes, onSwitch, onClose, onTabMenu, onToggleGroup, onMoveTab, onMoveGroup };

  const reveal = useCallback((key: string | null) => {
    revealedRef.current = key;
    setRevealedKey(key);
  }, []);

  const endGesture = useCallback((g: Gesture) => {
    if (g.timer !== null) clearTimeout(g.timer);
    if (g.frame !== null) cancelAnimationFrame(g.frame);
    g.timer = null;
    g.frame = null;
    if (g.rowEl) g.rowEl.style.transform = '';
    if (gestureRef.current === g) gestureRef.current = null;
    setArmedKey(null);
    setDrag(null);
  }, []);

  // A press outlives other windows' edits: the tab under the finger can be closed,
  // or its group dissolved, before the finger lifts. Acting on the saved key then
  // reaches for an id that is gone — and a tap's switch to a tab App no longer has
  // is what SPAWNS a terminal there, re-opening the tab that was just closed. So
  // the press ends with its row: its long-press timer and edge-scroll frame go with
  // it, the touchmove guard stops holding the pan (it reads the live press), and
  // pointer capture is handed back so the finger still down scrolls the list again.
  const endIfGone = useCallback(
    (g: Gesture, tree: readonly DrawerNode[]): boolean => {
      if (hasNode(tree, g.key)) return false;
      const list = listRef.current;
      // Optional: not every engine implements pointer capture (happy-dom does not).
      if (list?.hasPointerCapture?.(g.pointerId)) list.releasePointerCapture(g.pointerId);
      endGesture(g);
      return true;
    },
    [endGesture],
  );

  // Every render that can carry a new tree checks the press against it; the
  // handlers check again at the moment they act, in case a release arrives first.
  useEffect(() => {
    const g = gestureRef.current;
    if (g) endIfGone(g, nodes);
  }, [nodes, endIfGone]);

  // The drawer closing ends whatever press is in flight and puts a swiped row back.
  useEffect(() => {
    if (open) return;
    const g = gestureRef.current;
    if (g) endGesture(g);
    reveal(null);
  }, [open, endGesture, reveal]);

  useEffect(
    () => () => {
      const g = gestureRef.current;
      if (!g) return;
      if (g.timer !== null) clearTimeout(g.timer);
      if (g.frame !== null) cancelAnimationFrame(g.frame);
    },
    [],
  );

  // Pointer capture changes where events go; it does not stop the browser's own
  // pan, which would start on the first move after arming and cancel the pointer.
  // This listener is the one thing that takes the gesture from it. It is registered
  // by hand because React's `onTouchMove` is passive and cannot preventDefault, and
  // it cancels ONLY while armed or dragging: a move before that is still a scroll.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onTouchMove = (e: TouchEvent) => {
      const phase = gestureRef.current?.phase;
      if ((phase === 'armed' || phase === 'dragging') && e.cancelable) e.preventDefault();
    };
    // pointerup/pointercancel normally end the press first; these are the net for a
    // browser that only ever tells us the touch is over.
    const onTouchEnd = () => {
      const g = gestureRef.current;
      if (g) endGesture(g);
    };
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    return () => {
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [endGesture]);

  // The keyboard route to a row's Close hands focus over once it is on screen: a
  // hidden control cannot take it, and it only stops being hidden after this render.
  useEffect(() => {
    if (revealedKey === null || !focusRevealRef.current) return;
    focusRevealRef.current = false;
    listRef.current?.querySelector<HTMLElement>(`[data-swipe-close="${revealedKey}"]`)?.focus();
  }, [revealedKey]);

  /** The leaf wrapper of a row: the one element whose box does not move while it is lifted. */
  const leafOf = (key: string): HTMLElement | undefined =>
    [...(listRef.current?.querySelectorAll<HTMLElement>('[data-row-key]') ?? [])].find(
      (leaf) => leaf.dataset['rowKey'] === key,
    );

  const updateDrag = (g: Gesture) => {
    const list = listRef.current;
    if (!list) return;
    // The lift is transform-only. Scroll since the press counts, or an edge scroll
    // would leave the row behind the finger.
    if (g.rowEl) {
      const dy = g.y - g.startY + (list.scrollTop - g.scrollTop);
      g.rowEl.style.transform = `translate3d(0, ${dy}px, 0) scale(1.02)`;
    }
    const candidate = dropUnder(g, list);
    const drop = candidate && accepts(latest.current.nodes, g.key, candidate) ? candidate : null;
    g.drop = drop;
    setDrag((prev) => (prev && sameDrop(prev.drop, drop) ? prev : { key: g.key, drop }));

    const speed = edgeSpeed(g.y, list.getBoundingClientRect());
    if (speed !== 0 && g.frame === null && canScroll(list, speed)) {
      g.frame = requestAnimationFrame(() => {
        g.frame = null;
        const target = listRef.current;
        if (!target || gestureRef.current !== g || g.phase !== 'dragging') return;
        const next = edgeSpeed(g.y, target.getBoundingClientRect());
        if (next === 0 || !canScroll(target, next)) return;
        target.scrollTop += next;
        updateDrag(g);
      });
    }
  };

  const startDrag = (g: Gesture) => {
    const list = listRef.current;
    if (!list) return;
    g.phase = 'dragging';
    g.rowEl = leafOf(g.key)?.querySelector<HTMLElement>('.drawer-row') ?? null;
    list.setPointerCapture(g.pointerId);
    setArmedKey(null);
    setDrag({ key: g.key, drop: null });
    updateDrag(g);
  };

  const arm = (g: Gesture) => {
    g.timer = null;
    if (gestureRef.current !== g || g.phase !== 'pressed') return;
    if (endIfGone(g, latest.current.nodes)) return;
    g.phase = 'armed';
    navigator.vibrate?.(8);
    setArmedKey(g.key);
  };

  const down = (key: string, e: ReactPointerEvent) => {
    // A touch pointerdown must not be prevented: that cancels the list's pan.
    if (e.pointerType !== 'touch') e.preventDefault();
    const stale = gestureRef.current;
    if (stale) endGesture(stale);
    // A press while a row's Close is showing only puts that row back: it must not
    // also switch tabs, or start a long-press of its own.
    const swallowed = revealedRef.current !== null;
    if (swallowed) reveal(null);
    const g: Gesture = {
      pointerId: e.pointerId,
      key,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      scrollTop: listRef.current?.scrollTop ?? 0,
      phase: swallowed ? 'moved' : 'pressed',
      settled: swallowed,
      hadKbd: kbdFocused(),
      timer: null,
      frame: null,
      rowEl: null,
      drop: null,
    };
    if (!swallowed) g.timer = setTimeout(() => arm(g), LONG_PRESS_MS);
    gestureRef.current = g;
  };

  /**
   * Read a press that left its slop before arming. Mostly vertical is a scroll, and
   * the browser has the pan; a leftward swipe past the threshold reveals this tab's
   * Close. A swipe right needs no case of its own: the press that began it already
   * put an open Close back (see `down`).
   */
  const settle = (g: Gesture, dx: number, dy: number) => {
    if (Math.abs(dy) > Math.abs(dx)) {
      g.settled = true;
    } else if (dx <= -SWIPE_REVEAL_PX) {
      if (!isGroupValue(g.key)) reveal(g.key);
      g.settled = true;
    }
  };

  const move = (e: ReactPointerEvent) => {
    const g = gestureRef.current;
    if (!g || e.pointerId !== g.pointerId) return;
    g.x = e.clientX;
    g.y = e.clientY;
    const dx = g.x - g.startX;
    const dy = g.y - g.startY;
    const beyondSlop = Math.abs(dx) > ROW_SLOP_PX || Math.abs(dy) > ROW_SLOP_PX;
    if (g.phase === 'pressed' && beyondSlop) {
      if (g.timer !== null) clearTimeout(g.timer);
      g.timer = null;
      g.phase = 'moved';
    }
    if (g.phase === 'moved') {
      if (!g.settled) settle(g, dx, dy);
    } else if (g.phase === 'armed') {
      if (beyondSlop) startDrag(g);
    } else if (g.phase === 'dragging') {
      updateDrag(g);
    }
  };

  /** A tap: switch to the tab and leave, or fold/unfold the group. */
  const activate = (key: string) => {
    const { onSwitch: switchTo, onClose: close, onToggleGroup: toggle } = latest.current;
    if (isGroupValue(key)) {
      toggle?.(idOf(key));
    } else {
      switchTo(idOf(key));
      close();
    }
  };

  const up = (e: ReactPointerEvent) => {
    const g = gestureRef.current;
    if (!g || e.pointerId !== g.pointerId) return;
    // A tap, a menu and a drop all act on the row: none of them on a row that is gone.
    if (endIfGone(g, latest.current.nodes)) return;
    const { phase, key, drop, hadKbd } = g;
    endGesture(g);
    // A tap and a menu redraw the spot under the finger, so each marks its gesture
    // as it acts: the rest of the tap lands on what the action put there. A drop
    // happens where the finger already is, and a scroll, a swipe or a hold with no
    // menu acted on nothing, so none of them marks anything.
    if (phase === 'pressed') {
      e.preventDefault();
      // The touch path let focus reach the row; put the keyboard back BEFORE acting.
      if (hadKbd && !kbdFocused()) document.getElementById(KBD_ID)?.focus();
      consumeGesture(e, () => activate(key));
    } else if (phase === 'armed') {
      // A hold that ended without moving is the row menu. A group has none.
      if (!isGroupValue(key)) consumeGesture(e, () => latest.current.onTabMenu(idOf(key)));
    } else if (phase === 'dragging' && drop) {
      const { onMoveTab: moveTab, onMoveGroup: moveGroup } = latest.current;
      if (isGroupValue(key)) moveGroup?.(idOf(key), drop);
      else moveTab?.(idOf(key), drop);
    }
  };

  const cancel = (e: ReactPointerEvent) => {
    const g = gestureRef.current;
    if (g && e.pointerId === g.pointerId) endGesture(g);
  };

  // Leaving the list ends a press that has not taken capture (a mouse can go
  // anywhere). A drag has captured the pointer, so it never gets here.
  const leave = () => {
    const g = gestureRef.current;
    if (g && g.phase !== 'dragging') endGesture(g);
  };

  // Escape closes the drawer for a keyboard or assistive tech with focus inside it:
  // the scrim and a swipe are pointer-only, and there is no close button. It is the
  // nav's own handler and never a document one, because the drawer leaves #mobile-kbd
  // focused, so a key typed while it is open still belongs to the shell. A key that
  // something inside already took does not close the drawer as well: a Radix popup
  // closing prevents the default (and renders outside the nav, so its event only
  // reaches here through React's tree), and a field cancelling an edit is an editable
  // target.
  const closeOnEscape = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      if (!open || e.key !== 'Escape' || e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target || !e.currentTarget.contains(target)) return;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      onClose();
    },
    [open, onClose],
  );

  // A tap anywhere that is not a row or the revealed Close puts the row back.
  const hideRevealOnOutsidePress = (e: ReactPointerEvent) => {
    if (revealedRef.current === null) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('.drawer-session, .drawer-group, [data-swipe-close]')) return;
    reveal(null);
  };

  /**
   * What a row button also answers. The pointer path acts on pointerup (above); a
   * keyboard or assistive-tech activation is a click with no pointer press behind
   * it, which is the only click whose `detail` is 0. Only that click acts here; a
   * row has no drag marker of its own the way `pressMove` does, and a press that
   * acted on nothing (a mouse drag released on its row, or a press that only put
   * a revealed Close back) marks nothing, so its counted click does reach the row
   * and must not switch tabs.
   */
  const rowProps = (key: string) => ({
    onPointerDown: (e: ReactPointerEvent) => down(key, e),
    onClick: (e: ReactMouseEvent) => {
      if (e.detail === 0) activate(key);
    },
    // The long-press would otherwise raise the browser's own menu over the row.
    onContextMenu: (e: ReactMouseEvent) => e.preventDefault(),
  });

  const rowKeyDown = (key: string) => (e: ReactKeyboardEvent) => {
    // The keyboard's swipe-left: reveal this tab's Close and move focus onto it.
    if (e.key !== 'ArrowLeft' || isGroupValue(key)) return;
    e.preventDefault();
    focusRevealRef.current = true;
    reveal(key);
  };

  const closeKeyDown = (key: string) => (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowRight') return;
    e.preventDefault();
    reveal(null);
    leafOf(key)?.querySelector<HTMLElement>('.drawer-session')?.focus();
  };

  const closeRow = (id: string) => {
    // The host may ask first (a shell, unsaved text), and the answer may be no.
    reveal(null);
    onKill(id);
  };

  // A footer action that opened a native picker keeps the layout held until the
  // picker returns; one that only toasted must release like any other close.
  const closeAfterPicker = (launched: boolean) =>
    launched ? onClose({ holdUntil: 'picker' }) : onClose();

  const mark = markFor(drag?.drop ?? null, rows, drag?.key ?? null);
  const markOf = (key: string): string => {
    if (mark === null || mark === 'root' || mark.key !== key) return '';
    return ` drop-${mark.position}`;
  };

  const renderGroup = (item: Extract<ListItem, { kind: 'group' }>) => {
    const { group, key } = item;
    return (
      <div
        className={`drawer-row drawer-row-group${armedKey === key ? ' armed' : ''}${drag?.key === key ? ' lifted' : ''}${markOf(key)}`}
      >
        <button
          className={`drawer-group${item.collapsed ? ' collapsed' : ''}${item.memberActive ? ' member-active' : ''}`}
          data-testid={`drawer-group-${group.id}`}
          aria-expanded={!item.collapsed}
          {...rowProps(key)}
        >
          <span className="drawer-group-caret" aria-hidden="true">
            <Icon name={item.collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
          </span>
          <span className="drawer-group-label">{group.name || 'group'}</span>
          <span className="drawer-group-count">{item.memberCount}</span>
        </button>
      </div>
    );
  };

  const renderTab = (item: Extract<ListItem, { kind: 'tab' }>) => {
    const { tab, key } = item;
    const revealed = revealedKey === key;
    const accent = tabColorValue(tab.color);
    const rowStyle: Record<string, string> = {};
    // Only a coloured tab sets it: the dot falls back to a neutral without one.
    if (accent) rowStyle['--tab-accent'] = accent;
    return (
      <div
        className={`drawer-row${item.active ? ' active' : ''}${armedKey === key ? ' armed' : ''}${drag?.key === key ? ' lifted' : ''}${revealed ? ' revealed' : ''}${markOf(key)}`}
        style={Object.keys(rowStyle).length ? rowStyle : undefined}
      >
        <button
          className="drawer-session"
          data-testid={`drawer-session-${tab.id}`}
          aria-current={item.active ? 'true' : undefined}
          onKeyDown={rowKeyDown(key)}
          {...rowProps(key)}
        >
          <span className="drawer-dot" aria-hidden="true" />
          {/* A terminal's kind is the prompt every row would repeat; only the other
              kinds say anything. */}
          {tab.kind !== 'terminal' && (
            <span className="drawer-session-id">
              <Icon name={kindIcon(tab.kind)} size={14} />
            </span>
          )}
          <span className="drawer-session-title">{displayTitle(tab)}</span>
          {/* The tab number: the id is what the URL used to carry, so it is still
              how you name a tab. Secondary text — it is not what the row is about. */}
          <span className="drawer-num" data-testid={`drawer-num-${tab.id}`}>
            {tab.id}
          </span>
        </button>
        {/* Behind the row until a swipe-left slides it aside. Hidden, it is neither
            focusable nor read out; shown, it is a button like any other. */}
        <button
          className="drawer-row-close"
          data-swipe-close={key}
          data-testid={`drawer-row-close-${tab.id}`}
          aria-label={`Close tab ${tab.id}`}
          aria-hidden={revealed ? undefined : true}
          tabIndex={revealed ? 0 : -1}
          onKeyDown={closeKeyDown(key)}
          {...pressMove(() => closeRow(tab.id))}
        >
          <Icon name="close" size={14} /> Close
        </button>
      </div>
    );
  };

  return (
    <>
      <div
        className={`drawer-scrim${open ? ' open' : ''}`}
        data-testid="drawer-scrim"
        onPointerDown={press(() => onClose())}
      />
      <nav
        className={`drawer${open ? ' open' : ''}`}
        aria-label="Sessions"
        data-testid="drawer"
        onPointerDownCapture={hideRevealOnOutsidePress}
        onKeyDown={closeOnEscape}
      >
        {atRoot && (
          <div className="drawer-top">
            {/* Switcher · gear, one line. The switcher is first in the DOM and the tab
                order; the gear is at the row's right end, where Close used to be, and
                the drawer has no close button (see the header comment). */}
            <Segmented
              className="drawer-views-seg"
              label="Drawer view"
              value={view}
              onValueChange={selectView}
              options={viewOptions}
              data-testid="drawer-view"
              // Same rule as every other control in here: switching views must not
              // blur #mobile-kbd and dismiss the soft keyboard.
              keepFocus
            />
            <IconButton
              label="Settings"
              data-testid="drawer-settings"
              {...pressClick(() => selectView('settings'))}
            >
              <Icon name="settings" size={16} />
            </IconButton>
          </div>
        )}

        {view === 'settings' && viewContent === undefined && (
          <>
            {/* `pressClick`, not `press`: in the theme sub-view this header is the
                ONLY back control (settings-view.css hides the form's own), so
                Enter, Space and an assistive-tech click must reach it as well. */}
            <button
              className="drawer-brand drawer-back"
              data-testid="drawer-settings-back"
              {...pressClick(() => (settingsSub ? setSettingsSub(null) : selectView('sessions')))}
            >
              <Icon name="chevron-left" size={14} /> Settings
            </button>
            <div className="drawer-settings-body" data-testid="drawer-settings-body">
              <SettingsFields
                settings={settings}
                onChange={onChangeSettings}
                subView={settingsSub}
                onSubViewChange={setSettingsSub}
                fontFamilies={fontFamilies}
                onOpenKeybindings={
                  onOpenKeybindings &&
                  (() => {
                    onOpenKeybindings();
                    onClose();
                  })
                }
                onOpenTips={
                  onOpenTips &&
                  (() => {
                    onOpenTips();
                    onClose();
                  })
                }
                onImportTheme={onImportTheme}
                importingTheme={importingTheme}
                appVersion={appVersion}
                onReloadApp={onReloadApp}
              />
            </div>
          </>
        )}

        {view !== 'sessions' && viewContent !== undefined && (
          <div className="drawer-view-body" data-testid="drawer-view-body">
            {/* Same reason as the dock's: a throw in here used to unmount the
                whole app, taking every terminal with it. `resetKey` is the view,
                so switching segment and back is the retry. */}
            <ErrorBoundary key={view} label={VIEW_LABEL[view]}>
              {viewContent}
            </ErrorBoundary>
          </div>
        )}

        {chooserOpen && (
          <>
            {/* `pressClick` for the Settings header's reason: the chooser hides
                the session list, so this is the only way back to it. */}
            <button
              className="drawer-brand drawer-back"
              data-testid="drawer-newtab-back"
              {...pressClick(() => onNewTabBack?.())}
            >
              <Icon name="chevron-left" size={14} /> New tab
            </button>
            <div className="drawer-newtab-body" data-testid="drawer-newtab-body">
              <ErrorBoundary label="New tab">{newTabContent}</ErrorBoundary>
            </div>
          </>
        )}

        <div
          ref={listRef}
          className={`drawer-sessions${drag ? ' dragging' : ''}`}
          hidden={view !== 'sessions' || chooserOpen}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={cancel}
          onPointerLeave={leave}
          onScroll={() => reveal(null)}
        >
          {tracked.map((row, index) => {
            const leaving = row.phase === 'leaving';
            const leafStyle: Record<string, string> = { '--dr-i': String(index) };
            // The group's colours go on the LEAF, which holds the frame segment and the
            // chip alike, and a leaving leaf keeps them so it fades in its own colours.
            const accent = tabColorValue(row.item.group?.color);
            const ink = tabColorInk(row.item.group?.color);
            if (accent) leafStyle['--group-accent'] = accent;
            if (ink) leafStyle['--group-ink'] = ink;
            const frame = frames[index] ?? NO_FRAME;
            // A bridge's sides belong to the live group around it, which need not be the
            // row's own, so they never borrow the fading row's colour (nor its fallback).
            if (frame.bridges) {
              leafStyle['--group-frame'] = tabColorValue(frame.bridges.color) ?? 'var(--t-accent)';
            }
            return (
              <div
                key={row.key}
                className={`drawer-leaf${frame.classes}`}
                data-row-key={row.key}
                data-phase={row.phase}
                data-enter={row.enter}
                data-lifted={drag?.key === row.key ? 'true' : undefined}
                style={leafStyle}
                // A row on its way out takes no tap and no focus, as in the
                // Explorer (FileTree.tsx). `inert` rather than `aria-hidden`: a row
                // closed from its revealed Close still holds focus, and focus inside
                // an aria-hidden subtree is a violation. Not in React 18's typings,
                // so it travels in a spread.
                {...(leaving ? { inert: '' } : {})}
              >
                <div className="drawer-leaf-inner">
                  {row.item.kind === 'group' ? renderGroup(row.item) : renderTab(row.item)}
                </div>
              </div>
            );
          })}
          {/* One box serving two jobs, so a drag costs the list no height: at rest
              it is `+ New tab`; while a row is lifted it is the top level's drop
              area, which exists even when every tab is in a group. Does NOT close
              the drawer when the host renders the chooser here: closing it and
              floating the chooser somewhere else is exactly the behaviour this
              replaced. */}
          <div className="drawer-tail">
            <button
              className="drawer-new"
              data-testid="drawer-new"
              {...pressMove(() => {
                onCreate();
                if (onNewTabBack === undefined) onClose();
              })}
            >
              <Icon name="plus" size={14} /> New tab
            </button>
            <div
              className={`drawer-root-drop${mark === 'root' ? ' over' : ''}`}
              data-testid="drawer-root-drop"
              aria-hidden="true"
            >
              Drop here to ungroup
            </div>
          </div>
        </div>

        {/* One 2-column grid of equal, gapless cells (2 rows). Every cell acts
            and closes. `pressClick` so a press's trailing click is not a second
            activation — Dictate is a toggle, and acting twice would start and stop
            it in one tap. Upload and Images act FIRST: whether the drawer holds
            the layout open for a picker depends on whether one opened. */}
        <div className="drawer-footer">
          <button
            className="drawer-action"
            data-testid="drawer-upload"
            {...pressClick(() => closeAfterPicker(actions.uploadFile()))}
          >
            <Icon name="upload" size={14} /> Upload
          </button>
          <button
            className="drawer-action"
            data-testid="drawer-download"
            {...pressClick(() => {
              onClose();
              actions.downloadFile();
            })}
          >
            <Icon name="download" size={14} /> Download
          </button>
          {/* Column sides are the ones the thumb learned: Dictate left, Images
              right — dropping ⚙ and 🎤 must not shuffle the cells that stayed. */}
          <button
            className="drawer-action"
            aria-label="Dictate"
            data-testid="drawer-dictate"
            {...pressClick(() => {
              onClose();
              actions.dictate();
            })}
          >
            <Icon name="mic" size={14} /> Dictate
          </button>
          {/* Replaces the old ⌨ Keyboard cell — the keyboard already has two
              reliable gestures (long-press ESC, swipe left→right on the bar),
              while picking images had none that skipped Android's chooser. */}
          <button
            className="drawer-action"
            aria-label="Upload images"
            data-testid="drawer-upload-images"
            {...pressClick(() => closeAfterPicker(actions.uploadImages()))}
          >
            <Icon name="image" size={14} /> Images
          </button>
        </div>
      </nav>
    </>
  );
};
