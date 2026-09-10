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
//   * render on mobile — there the drawer is the container, and the rail is
//     forced off.

import type { ReactNode } from 'react';
import { ErrorBoundary } from '../ui';
import './dock.css';

/** The surfaces the dock can host. Persisted per device, so it is a stable set. */
export type DockView = 'settings' | 'newtab' | 'files' | 'dictation';

// Inline SVG, not emoji. The rail is the app's most permanent chrome, and the
// emoji set renders as whatever monochrome fallback the platform happens to have
// — measured here as four glyphs at three different weights, with the microphone
// nearly invisible against the rail. SVG inherits currentColor, so the active and
// hover states come free from the button's own colour.
/** Icon keys: the dock's four views plus `sessions`, which only the mobile
 *  drawer shows. One shared map so the two surfaces cannot drift — the drawer
 *  was rendering the `+` glyph for its Sessions tab because this map had no
 *  entry for it. */
export type IconName = DockView | 'sessions' | 'upload' | 'download';

export const ICONS: Record<IconName, ReactNode> = {
  sessions: (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M2.6 4.2h10.8M2.6 8h10.8M2.6 11.8h10.8" strokeLinecap="round" />
    </svg>
  ),
  settings: (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="2.4" />
      <path
        d="M8 1.4v1.7M8 12.9v1.7M1.4 8h1.7M12.9 8h1.7M3.3 3.3l1.2 1.2M11.5 11.5l1.2 1.2M12.7 3.3l-1.2 1.2M4.5 11.5l-1.2 1.2"
        strokeLinecap="round"
      />
    </svg>
  ),
  newtab: (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path d="M8 3.2v9.6M3.2 8h9.6" strokeLinecap="round" />
    </svg>
  ),
  files: (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path
        d="M1.9 12.6V3.9c0-.4.3-.7.7-.7h3.2l1.4 1.7h6c.4 0 .7.3.7.7v7c0 .4-.3.7-.7.7H2.6a.7.7 0 0 1-.7-.7Z"
        strokeLinejoin="round"
      />
    </svg>
  ),
  dictation: (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <rect x="6" y="1.7" width="4" height="7.2" rx="2" />
      <path d="M3.6 7.4a4.4 4.4 0 0 0 8.8 0M8 11.8v2.5" strokeLinecap="round" />
    </svg>
  ),
  upload: (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path d="M8 10.6V2.4M4.9 5.5 8 2.4l3.1 3.1" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.6 11v1.9c0 .4.3.7.7.7h9.4c.4 0 .7-.3.7-.7V11" strokeLinecap="round" />
    </svg>
  ),
  download: (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path d="M8 2.4v8.2M4.9 7.5 8 10.6l3.1-3.1" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.6 11v1.9c0 .4.3.7.7.7h9.4c.4 0 .7-.3.7-.7V11" strokeLinecap="round" />
    </svg>
  ),
};

export const DOCK_VIEWS: { id: DockView; label: string }[] = [
  { id: 'settings', label: 'Settings' },
  { id: 'newtab', label: 'New tab' },
  { id: 'files', label: 'Explorer' },
  { id: 'dictation', label: 'Dictation' },
];

/**
 * How long to hold the PTY resize after a dock toggle. Slightly longer than the
 * 240ms surface tier so the release lands after the layout has settled — the
 * flush sends the LAST buffered size, so releasing early would send a size taken
 * mid-transition and the shell would redraw at the wrong width.
 */
export const DOCK_SETTLE_MS = 280;

const VIEW_KEY = 'palmux-dock-view';
const IDS = new Set<string>(['settings', 'newtab', 'files', 'dictation']);

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
  /** Whether the always-visible icon rail is shown (per-device preference). */
  rail: boolean;
  /** Select a view, or null to close. Selecting the open view closes it. */
  onView: (view: DockView | null) => void;
  /** Rail buttons that run an action rather than opening a view. */
  actions?: RailAction[] | undefined;
  /** Extra control rendered in the header, before the close button. */
  headerExtra?: ReactNode;
  children?: ReactNode;
}

const titleOf = (view: DockView): string => DOCK_VIEWS.find((v) => v.id === view)?.label ?? 'Panel';

export function DockPanel({
  view,
  rail,
  onView,
  actions,
  headerExtra,
  children,
}: DockPanelProps) {
  // Nothing to render at all when closed AND railless — the dock must cost the
  // terminal zero pixels in that state, which is what `sidebarRail: 'hidden'` is for.
  if (!view && !rail) return null;

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
                ✕
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
      {rail && (
        <nav className="dock-rail" data-testid="dock-rail" aria-label="Panels">
          {DOCK_VIEWS.map((v) => (
            <button
              key={v.id}
              className={v.id === view ? 'dock-rail-btn on' : 'dock-rail-btn'}
              title={v.label}
              aria-label={v.label}
              aria-pressed={v.id === view}
              data-testid={`dock-rail-${v.id}`}
              onClick={() => onView(v.id === view ? null : v.id)}
            >
              {ICONS[v.id]}
            </button>
          ))}
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
        </nav>
      )}
    </>
  );
}
