// ── Mobile session drawer ─────────────────────────────────────────────────────
//
// Replaces the desktop top bar on mobile. It lives on the RIGHT edge: a
// right→left swipe across the extra-keys bar pulls it in (the direction of
// travel), and a scrim tap returns to the terminal. Lists every workspace tab
// with its kind icon, color dot, and display title. Long-press a row to open the
// tab sheet (rename / color / close); tap switches.
//
// Settings are a VIEW of this drawer, not a modal — on a phone a dialog stacked
// over the terminal is strictly worse than a list you already have open. The
// fields come from settings/SettingsFields so this and the desktop DOCK share
// one definition.
//
// The drawer is the mobile container for the SAME four surfaces the desktop
// dock rail hosts, so a kit Segmented at the top switches between them, wearing
// the rail's own SVG icons (imported from DockPanel — one icon set, so the two
// surfaces cannot drift). The session list stays bottom-anchored and the 4-cell
// footer is untouched. The old `palmux` + ⚙ bar under it is GONE: the segmented
// header reaches settings in one tap, so that row was a second control for the
// same job plus a brand nobody needs inside their own app.
//
// `view` is optional and the control is uncontrolled without it, defaulting to
// the session list — a host that passes nothing gets exactly today's drawer.
// The two views with no built-in body (files, dictation) are rendered by the
// HOST through `viewContent`, and a host that cannot render one must not offer
// it — an enabled segment that opens an empty drawer is worse than no segment.
// Availability is therefore declared UP FRONT in `hostedViews`, not inferred
// from `viewContent`: content necessarily tracks the SELECTED view, so a host
// can only supply it once the view is already active, and inferring from it
// disabled every hosted view forever (they could never become active).
//
// Interactive elements act on POINTER events, never onClick, so using the drawer
// doesn't blur the hidden #mobile-kbd textarea and dismiss the soft keyboard.
// Which pointer event depends on whether the control can be scrolled past:
//   * fixed chrome (footer, scrim) uses `press` — pointerdown + preventDefault;
//   * anything in a LIST uses the pointerup-with-slop form (`pressMove`, and
//     rowDown/rowMove/rowUp here), because preventDefaulting a touch pointerdown
//     cancels the browser's pan and firing on pointerdown means the finger that
//     came to scroll has already picked whatever it landed on.
// The settings fields are the exception either way: native <select>/<input> must
// take focus to work at all.

import {
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { TabGroup, TabMeta } from '@palmux/shared';
import { displayTitle, kindIcon, tabColorInk, tabColorValue } from './tab-meta';
import { buildStrip, groupIdOf, NO_COLLAPSED } from './tab-groups';
import { ICONS as DOCK_ICONS, type IconName } from './DockPanel';
import { SettingsFields } from '../settings/SettingsFields';
import { ErrorBoundary, Segmented, type SegmentedOption } from '../ui';
import { pressMove } from '../panes/press';
import type { ClientSettings } from '../settings/settings';
import './drawer-views.css';

const LONG_PRESS_MS = 450;

/** Finger travel that turns a row press into a scroll (matches panes/press.ts). */
const ROW_SLOP_PX = 10;

/** Default for `hostedViews`: a stable reference, so it isn't a new array per render. */
const NO_HOSTED_VIEWS: readonly DrawerView[] = [];

/** The drawer's top-level surfaces — the dock rail's set, with the session list
 *  standing in for the dock's New-tab view. */
export type DrawerView = 'sessions' | 'settings' | 'files' | 'dictation';

/** `hosted` = the drawer has no body of its own for it, so it needs `viewContent`. */
const VIEWS: { id: DrawerView; icon: IconName; label: string; hosted: boolean }[] = [
  { id: 'sessions', icon: 'sessions', label: 'Sessions', hosted: false },
  { id: 'settings', icon: 'settings', label: 'Settings', hosted: false },
  { id: 'files', icon: 'files', label: 'Explorer', hosted: true },
  { id: 'dictation', icon: 'dictation', label: 'Dictation', hosted: true },
];

/** Human name per view, for the error boundary (the segment labels). */
const VIEW_LABEL: Record<DrawerView, string> = Object.fromEntries(
  VIEWS.map((v) => [v.id, v.label]),
) as Record<DrawerView, string>;

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
  onKill: (id: string) => void;
  onClose: () => void;
  /** Long-press on a row: open the rename/color/close sheet for that tab. */
  onTabMenu: (id: string) => void;
  /** Tap a group header to collapse/expand (shared with the desktop strip). */
  onToggleGroup?: ((gid: string) => void) | undefined;
  /** The drawer's footer toolbar — a bundle of unrelated global actions. */
  actions: DrawerActions;
  /** Live client settings, rendered as the drawer's ⚙ view. */
  settings: ClientSettings;
  onChangeSettings: (partial: Partial<ClientSettings>) => void;
  fontFamilies?: string[] | undefined;
  /** Keybindings stay a modal — the editor needs the room. */
  onOpenKeybindings?: (() => void) | undefined;
  onOpenTips?: (() => void) | undefined;
  /** Dictation history is a modal too (same precedent — the list needs room). */
  onOpenDictationHistory?: (() => void) | undefined;
  onImportTheme?: ((source: string) => void) | undefined;
  importingTheme?: boolean | undefined;
  /** Server build the client last saw, shown next to the reload control. */
  appVersion?: string | undefined;
  /** Controlled view. Omit it and the drawer keeps its own, starting on 'sessions'. */
  view?: DrawerView | undefined;
  onView?: ((view: DrawerView) => void) | undefined;
  /** Body for a view the drawer has none for, in place of the session list. */
  viewContent?: ReactNode | undefined;
  /**
   * Hosted views this host can render. Anything not listed stays disabled — the
   * default is NONE, so a host that passes no bodies gets today's two-view
   * drawer unchanged.
   */
  hostedViews?: readonly DrawerView[] | undefined;
  /**
   * The new-tab chooser, shown in place of the session list when `+ New tab` is
   * pressed. A SUB-SURFACE of the session view, not a fifth segment: the list
   * and the chooser are the same job (pick where to go), which is why the drawer
   * has four segments and the dock's New-tab rail item maps onto this list.
   * Omit it and `+ New tab` just calls `onCreate`, as before.
   */
  newTabContent?: ReactNode | undefined;
  /** Leave the chooser, back to the session list. */
  onNewTabBack?: (() => void) | undefined;
}

export interface DrawerActions {
  /** Any-file picker. On Android this is the one that asks photo/video/file. */
  uploadFile: () => void;
  /** Image-only picker — opens the gallery directly, multi-select. */
  uploadImages: () => void;
  downloadFile: () => void;
  /** Start / stop voice dictation (the recording pill stops it too). */
  dictate: () => void;
}

const press = (action: () => void) => (e: ReactPointerEvent) => {
  e.preventDefault();
  action();
};

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
  actions,
  settings,
  onChangeSettings,
  fontFamilies,
  onOpenKeybindings,
  onOpenTips,
  onOpenDictationHistory,
  onImportTheme,
  importingTheme,
  appVersion,
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

  // Settings is the one non-session view with a built-in body, so it stays
  // available whether or not the host supplies content.
  const viewOptions: SegmentedOption<DrawerView>[] = VIEWS.map((v) => ({
    value: v.id,
    label: (
      <>
        {DOCK_ICONS[v.icon]}
        <span className="drawer-view-name">{v.label}</span>
      </>
    ),
    disabled: v.hosted && !hostedViews.includes(v.id),
  }));
  // Append a not-yet-broadcast current at the END (no numeric sort — that would
  // scramble grouped members, which must stay in strip order under their header).
  const list: TabMeta[] =
    !current || tabs.some((t) => t.id === current)
      ? tabs
      : [...tabs, { id: current, kind: 'terminal' as const }];
  const strip = buildStrip(list, groups ?? [], collapsed ?? NO_COLLAPSED);
  const currentGroupId = groupIdOf(list, current);
  // Grouped rows carry their group's color so the .grouped spine renders the
  // GROUP channel, not the theme-accent fallback.
  const groupColorById = new Map((groups ?? []).map((g) => [g.id, tabColorValue(g.color)]));

  // Long-press state per pointer interaction: when the hold timer fires we open
  // the sheet and swallow the pending tap-switch.
  const holdRef = useRef<{
    timer: ReturnType<typeof setTimeout>;
    fired: boolean;
    x: number;
    y: number;
  } | null>(null);

  // A row lives in a SCROLLING list, so a touch pointerdown is not preventDefaulted
  // (that would cancel the browser's pan) and finger travel past SLOP_PX turns
  // the press into a scroll: no switch, and no long-press sheet either.
  const rowDown = (id: string) => (e: ReactPointerEvent) => {
    if (e.pointerType !== 'touch') e.preventDefault();
    clearTimeout(holdRef.current?.timer);
    const state = {
      timer: setTimeout(() => {
        state.fired = true;
        onTabMenu(id);
      }, LONG_PRESS_MS),
      fired: false,
      x: e.clientX,
      y: e.clientY,
    };
    holdRef.current = state;
  };

  const rowMove = (e: ReactPointerEvent) => {
    const state = holdRef.current;
    if (!state) return;
    if (
      Math.abs(e.clientX - state.x) > ROW_SLOP_PX ||
      Math.abs(e.clientY - state.y) > ROW_SLOP_PX
    ) {
      rowCancel();
    }
  };

  const rowUp = (id: string) => (e: ReactPointerEvent) => {
    const state = holdRef.current;
    holdRef.current = null;
    if (!state) return; // scrolled, or already cancelled
    e.preventDefault();
    clearTimeout(state.timer);
    if (state.fired) return; // the long-press already opened the sheet
    onSwitch(id);
    onClose();
  };

  const rowCancel = () => {
    clearTimeout(holdRef.current?.timer);
    holdRef.current = null;
  };

  return (
    <>
      <div
        className={`drawer-scrim${open ? '' : ' hidden'}`}
        data-testid="drawer-scrim"
        onPointerDown={press(onClose)}
      />
      <nav className={`drawer${open ? ' open' : ''}`} aria-label="Sessions" data-testid="drawer">
        <div className="drawer-views">
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
        </div>

        {view === 'settings' && viewContent === undefined && (
          <>
            <button
              className="drawer-brand drawer-back"
              data-testid="drawer-settings-back"
              onPointerDown={press(() => selectView('sessions'))}
            >
              ‹ Settings
            </button>
            <div className="drawer-settings-body" data-testid="drawer-settings-body">
              <SettingsFields
                settings={settings}
                onChange={onChangeSettings}
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
                onOpenDictationHistory={
                  onOpenDictationHistory &&
                  (() => {
                    onOpenDictationHistory();
                    onClose();
                  })
                }
              />
            </div>
          </>
        )}

        {view !== 'sessions' && viewContent !== undefined && (
          <div className="drawer-view-body" data-testid="drawer-view-body">
            {/* Same reason as the dock's: a throw in here used to unmount the
                whole app, taking every terminal with it. `resetKey` is the view,
                so switching segment and back is the retry. */}
            <ErrorBoundary key={view} label={VIEW_LABEL[view] ?? 'This view'}>
              {viewContent}
            </ErrorBoundary>
          </div>
        )}

        {view === 'sessions' && newTabContent !== undefined && (
          <>
            <button
              className="drawer-brand drawer-back"
              data-testid="drawer-newtab-back"
              onPointerDown={press(() => onNewTabBack?.())}
            >
              ‹ New tab
            </button>
            <div className="drawer-newtab-body" data-testid="drawer-newtab-body">
              <ErrorBoundary label="New tab">{newTabContent}</ErrorBoundary>
            </div>
          </>
        )}

        <div
          className="drawer-sessions"
          hidden={view !== 'sessions' || newTabContent !== undefined}
        >
          {strip.map((item) => {
            if (item.kind === 'chip') {
              const g = item.group;
              const accent = tabColorValue(g.color);
              const ink = tabColorInk(g.color);
              const memberActive = currentGroupId === g.id;
              const chipStyle: Record<string, string> = {};
              if (accent) chipStyle['--group-accent'] = accent;
              if (ink) chipStyle['--group-ink'] = ink;
              return (
                <button
                  key={`group-${g.id}`}
                  className={`drawer-group${item.collapsed ? ' collapsed' : ''}${memberActive ? ' member-active' : ''}`}
                  style={Object.keys(chipStyle).length ? chipStyle : undefined}
                  data-testid={`drawer-group-${g.id}`}
                  {...pressMove(() => onToggleGroup?.(g.id))}
                >
                  <span className="drawer-group-caret" aria-hidden="true">
                    {item.collapsed ? '▸' : '▾'}
                  </span>
                  {accent && (
                    <span
                      className="drawer-dot"
                      style={{ background: accent }}
                      aria-hidden="true"
                    />
                  )}
                  <span className="drawer-group-label">{g.name || 'group'}</span>
                  <span className="drawer-group-count">{item.memberCount}</span>
                </button>
              );
            }
            if (item.kind === 'fused') return null; // drawer lists members individually (no pairings passed)
            const tab = item.tab;
            const active = tab.id === current;
            const accent = tabColorValue(tab.color);
            const ink = tabColorInk(tab.color);
            const rowStyle: Record<string, string> = {};
            if (accent) rowStyle['--tab-accent'] = accent;
            if (ink) rowStyle['--tab-ink'] = ink;
            const groupAccent = tab.groupId ? groupColorById.get(tab.groupId) : undefined;
            if (groupAccent) rowStyle['--group-accent'] = groupAccent;
            return (
              <div
                key={tab.id}
                className={`drawer-row${active ? ' active' : ''}${tab.groupId ? ' grouped' : ''}`}
                style={Object.keys(rowStyle).length ? rowStyle : undefined}
              >
                <button
                  className="drawer-session"
                  data-testid={`drawer-session-${tab.id}`}
                  onPointerDown={rowDown(tab.id)}
                  onPointerMove={rowMove}
                  onPointerUp={rowUp(tab.id)}
                  onPointerLeave={rowCancel}
                  onPointerCancel={rowCancel}
                >
                  <span className="drawer-session-id">{kindIcon(tab.kind)}</span>
                  {/* The color chip carries the tab NUMBER — the id is the URL
                      path, so it is what you type to come back here. It is
                      rendered for every row (an uncolored tab falls back to the
                      theme accent, same as the row tint) and inverts on the
                      active row, where a chip painted in the accent would
                      vanish into the solid accent fill. */}
                  <span className="drawer-num" data-testid={`drawer-num-${tab.id}`}>
                    {tab.id}
                  </span>
                  <span className="drawer-session-title">{displayTitle(tab)}</span>
                </button>
                <button
                  className="drawer-kill"
                  aria-label={`Close tab ${tab.id}`}
                  data-testid={`drawer-kill-${tab.id}`}
                  {...pressMove(() => onKill(tab.id))}
                >
                  ✕
                </button>
              </div>
            );
          })}
          {/* Does NOT close the drawer when the host renders the chooser here:
              closing it and floating the chooser somewhere else is exactly the
              behaviour this replaced. */}
          <button
            className="drawer-new"
            data-testid="drawer-new"
            {...pressMove(() => {
              onCreate();
              if (onNewTabBack === undefined) onClose();
            })}
          >
            + New tab
          </button>
        </div>

        {/* One 2-column grid of equal, gapless cells (2 rows). Every cell acts
            and closes; ⚙ lives in the header instead. */}
        <div className="drawer-footer">
          <button
            className="drawer-action"
            data-testid="drawer-upload"
            onPointerDown={press(() => {
              onClose();
              actions.uploadFile();
            })}
          >
            ⬆ Upload
          </button>
          <button
            className="drawer-action"
            data-testid="drawer-download"
            onPointerDown={press(() => {
              onClose();
              actions.downloadFile();
            })}
          >
            ⬇ Download
          </button>
          {/* Column sides are the ones the thumb learned: 🔉 left, 🖼 right —
              dropping ⚙ and 🎤 must not shuffle the cells that stayed. */}
          <button
            className="drawer-action"
            aria-label="Dictate"
            data-testid="drawer-dictate"
            onPointerDown={press(() => {
              onClose();
              actions.dictate();
            })}
          >
            🔉 Dictate
          </button>
          {/* Replaces the old ⌨ Keyboard cell — the keyboard already has two
              reliable gestures (long-press ESC, swipe left→right on the bar),
              while picking images had none that skipped Android's chooser. */}
          <button
            className="drawer-action"
            aria-label="Upload images"
            data-testid="drawer-upload-images"
            onPointerDown={press(() => {
              onClose();
              actions.uploadImages();
            })}
          >
            🖼 Images
          </button>
        </div>
      </nav>
    </>
  );
};
