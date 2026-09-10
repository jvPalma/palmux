// ── Dashboard tab ─────────────────────────────────────────────────────────────
//
// The pinned `dashboard` tab: the new-tab sections kept around permanently. No
// chooser chrome (no pin/close/Escape) — just the header title + the shared
// `DashboardBody`.

import { DashboardBody, type DashboardBodyProps } from './DashboardBody';
import { press } from './press';

interface DashboardTabProps extends DashboardBodyProps {
  /** Mobile: opens the session drawer. */
  onMenu?: (() => void) | undefined;
}

export const DashboardTab = ({ onMenu, ...body }: DashboardTabProps) => (
  <div className="pane-frame dashboard" data-testid="dashboard-pane">
    <div className="pane-header">
      {onMenu && (
        <button className="pane-btn" aria-label="Open drawer" onPointerDown={press(onMenu)}>
          ☰
        </button>
      )}
      <span className="pane-title">Dashboard</span>
      <span className="spacer" />
    </div>

    <DashboardBody {...body} />
  </div>
);
