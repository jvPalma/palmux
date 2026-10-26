// ── Side dock ─────────────────────────────────────────────────────────────────
//
// One right-side panel hosting the app's surfaces as VIEWS instead of modals.
// It takes layout width, so the terminal narrows rather than being covered —
// which is the point: a modal hides the output you are reading while you change
// the setting that affects it.
//
// This component owns only the chrome (rail, header, close, view switching).
// Each view's content is passed in as children by App, so the dock knows nothing
// about settings, files or dictation.
//
// Two things it deliberately does NOT do:
//   * animate its own width — that would fire every terminal's ResizeObserver on
//     each frame of the transition. The panel animates its CONTENT in instead,
//     and App pauses the PTY resize across the toggle (see `resizeBusy`).
//   * render on mobile — there the drawer is the container, and there is no rail.
//
// The rail is ALWAYS drawn on desktop. It used to be a per-device preference
// (`sidebarRail`), which left a hidden rail with no pointer route to Explorer,
// Dictation, Upload and Download; the option is gone and the stored value, which
// old settings files still carry, is ignored.

import type { ReactNode } from 'react';
import { ErrorBoundary } from '../ui';
import { Icon } from '../ui/icons';
import './dock.css';

/** The surfaces the dock can host. Persisted per device, so it is a stable set. */
export type DockView = 'settings' | 'newtab' | 'files' | 'scm' | 'dictation';

// SVG, not emoji. The rail is the app's most permanent chrome, and the emoji set
// renders as whatever monochrome fallback the platform happens to have — measured
// here as four glyphs at three different weights, with the microphone nearly
// invisible against the rail. The glyphs come from the shared registry
// (`ui/icons.tsx`), which inherits currentColor, so the active and hover states
// come free from the button's own colour.
const RAIL_ICON_PX = 15;

/** Icon keys: the dock's five views plus `sessions`, which only the mobile
 *  drawer shows. One shared map so the two surfaces cannot drift — the drawer
 *  was rendering the `+` glyph for its Sessions tab because this map had no
 *  entry for it. */
export type IconName = DockView | 'sessions' | 'upload' | 'download';

export const ICONS: Record<IconName, ReactNode> = {
  sessions: <Icon name="sessions" size={RAIL_ICON_PX} />,
  settings: <Icon name="settings" size={RAIL_ICON_PX} />,
  newtab: <Icon name="plus" size={RAIL_ICON_PX} />,
  files: <Icon name="folder" size={RAIL_ICON_PX} />,
  scm: <Icon name="git-branch" size={RAIL_ICON_PX} />,
  dictation: <Icon name="mic" size={RAIL_ICON_PX} />,
  upload: <Icon name="upload" size={RAIL_ICON_PX} />,
  download: <Icon name="download" size={RAIL_ICON_PX} />,
};

// Rail order is frequency of use: what you open mid-session first, Settings last
// and pinned to the bottom edge (`.dock-rail-pinned`), where the thumb-and-eye
// habit of "preferences live at the bottom" already points.
export const DOCK_VIEWS: { id: DockView; label: string }[] = [
  { id: 'newtab', label: 'New tab' },
  { id: 'files', label: 'Explorer' },
  { id: 'scm', label: 'Source Control' },
  { id: 'dictation', label: 'Dictation' },
  { id: 'settings', label: 'Settings' },
];

/** The one view that leaves the flow and sits at the rail's bottom edge. */
const PINNED_VIEW: DockView = 'settings';
const FLOW_VIEWS = DOCK_VIEWS.filter((v) => v.id !== PINNED_VIEW);
const PINNED_VIEWS = DOCK_VIEWS.filter((v) => v.id === PINNED_VIEW);

/**
 * How long to hold the PTY resize after a dock toggle. Slightly longer than the
 * 240ms surface tier so the release lands after the layout has settled — the
 * flush sends the LAST buffered size, so releasing early would send a size taken
 * mid-transition and the shell would redraw at the wrong width.
 */
export const DOCK_SETTLE_MS = 280;

const VIEW_KEY = 'palmux-dock-view';
const IDS = new Set<string>(['settings', 'newtab', 'files', 'scm', 'dictation']);

/** The view this device last had open. Per-device, and never allowed to throw. */
export function readDockView(): DockView | null {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    return raw && IDS.has(raw) ? (raw as DockView) : null;
  } catch {
    return null;
  }
}

export function writeDockView(view: DockView | null): void {
  try {
    if (view) localStorage.setItem(VIEW_KEY, view);
    else localStorage.removeItem(VIEW_KEY);
  } catch {
    /* private mode / quota — the dock just forgets between reloads */
  }
}

/**
 * A rail entry that RUNS something instead of opening a view. Upload and
 * download live here: the desktop topbar that used to hold them is gone (the
 * app had two action bars, one above and one beside), and both are one-click
 * actions that must not cost three clicks through a panel. This also puts them
 * where the mobile drawer's footer already has them.
 */
export interface RailAction {
  id: 'upload' | 'download';
  label: string;
  onRun: () => void;
}

export interface DockPanelProps {
  /** The open view, or null when the dock is closed. */
  view: DockView | null;
  /** Select a view, or null to close. Selecting the open view closes it. */
  onView: (view: DockView | null) => void;
  /** Rail buttons that run an action rather than opening a view. */
  actions?: RailAction[] | undefined;
  /** Extra control rendered in the header, before the close button. */
  headerExtra?: ReactNode;
  children?: ReactNode;
}

const titleOf = (view: DockView): string => DOCK_VIEWS.find((v) => v.id === view)?.label ?? 'Panel';

export function DockPanel({ view, onView, actions, headerExtra, children }: DockPanelProps) {
  const railButton = (v: { id: DockView; label: string }) => (
    <button
      key={v.id}
      className={`dock-rail-btn${v.id === view ? ' on' : ''}${v.id === PINNED_VIEW ? ' dock-rail-pinned' : ''}`}
      title={v.label}
      aria-label={v.label}
      aria-pressed={v.id === view}
      data-testid={`dock-rail-${v.id}`}
      onClick={() => onView(v.id === view ? null : v.id)}
    >
      {ICONS[v.id]}
    </button>
  );

  return (
    <>
      {view && (
        <aside className="dock" data-view={view} data-testid="dock" aria-label={titleOf(view)}>
          {/* Keyed on the view so switching replays the entrance — the content
              changing wholesale should read as a new surface, not a repaint. */}
          <div className="dock-inner" key={view}>
            <div className="dock-head">
              <span className="dock-title">{titleOf(view)}</span>
              {headerExtra}
              <button
                className="dock-rail-btn"
                aria-label="Close panel"
                data-testid="dock-close"
                onClick={() => onView(null)}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
            <div className="dock-body" data-testid="dock-body">
              {/* One panel throwing must not cost the terminals. `resetKey` is
                  the view, so switching away and back is the retry. */}
              <ErrorBoundary key={view ?? 'none'} label={titleOf(view)}>
                {children}
              </ErrorBoundary>
            </div>
          </div>
        </aside>
      )}
      <nav className="dock-rail" data-testid="dock-rail" aria-label="Panels">
        {FLOW_VIEWS.map(railButton)}
        {actions && actions.length > 0 && (
          <>
            <span className="dock-rail-sep" aria-hidden="true" />
            {actions.map((a) => (
              <button
                key={a.id}
                className="dock-rail-btn"
                title={a.label}
                aria-label={a.label}
                data-testid={`dock-rail-${a.id}`}
                onClick={a.onRun}
              >
                {ICONS[a.id]}
              </button>
            ))}
          </>
        )}
        {PINNED_VIEWS.map(railButton)}
      </nav>
    </>
  );
}
