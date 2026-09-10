// ── New-tab chooser ───────────────────────────────────────────────────────────
//
// The transient new-tab page: pick → create → close (dismiss → nothing). Shown as
// an anchored popover from [+] and as an ACTUAL page when the last tab closes.
// Owns the chooser chrome (pin / close / Escape); the sections live in
// `DashboardBody`.

import { DashboardBody, type DashboardBodyProps } from './DashboardBody';
import { press } from './press';

interface NewTabChooserProps extends DashboardBodyProps {
  /** Dismiss without creating anything (popover); omitted for the last-tab page. */
  onClose?: (() => void) | undefined;
  /** Keep this dashboard around as a real tab. */
  onPin?: (() => void) | undefined;
  /** Mobile: opens the session drawer. */
  onMenu?: (() => void) | undefined;
}

export const NewTabChooser = ({ onClose, onPin, onMenu, ...body }: NewTabChooserProps) => (
  <div
    className="pane-frame dashboard"
    data-testid="dashboard-pane"
    onKeyDown={(e) => {
      if (e.key === 'Escape' && onClose) onClose();
    }}
  >
    <div className="pane-header">
      {onMenu && (
        <button className="pane-btn" aria-label="Open drawer" onPointerDown={press(onMenu)}>
          ☰
        </button>
      )}
      <span className="pane-title">New tab</span>
      <span className="spacer" />
      {onPin && (
        <button
          className="pane-btn"
          title="Keep as a tab"
          data-testid="dashboard-pin"
          onPointerDown={press(onPin)}
        >
          📌
        </button>
      )}
      {onClose && (
        <button
          className="pane-btn"
          aria-label="Close"
          data-testid="dashboard-close"
          onPointerDown={press(onClose)}
        >
          ✕
        </button>
      )}
    </div>

    <DashboardBody {...body} autoFocusPrimary />
  </div>
);
