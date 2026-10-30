// ── Pane host ─────────────────────────────────────────────────────────────────
//
// The persistent content layer for NON-terminal tabs: one element per open
// non-terminal tab, all kept mounted (iframes keep navigation state, Monaco
// keeps undo history) and positioned by rect. A tab shown as a pane's active tab
// gets that pane's rect; a tab shown nowhere is display:none. NEVER reparented —
// layout changes are style updates, so iframes/editors never reload. The
// host is pointer-events:none so the terminal in another pane stays clickable;
// each visible tab re-enables pointer events over its own rect.

import { memo, type CSSProperties } from 'react';
import type { TabMeta } from '@palmux/shared';
import { WebPane } from './WebPane';
import { DashboardTab } from './DashboardTab';
import type { CreateSpec, QuickLink } from './DashboardBody';
import { EditorPane } from './EditorPane';
import { MarkdownPane } from './MarkdownPane';
import { FileTabPane } from './FileTabPane';
import { ReviewPane } from '../review/ReviewPane';
import type { WebAppLink } from '@palmux/shared';
import { rectCss, type Rect } from '../session/pane-grid';

interface PaneHostProps {
  /** All live tabs; the host renders the non-terminal ones. */
  tabs: TabMeta[];
  /** tabId → its pane's rect (%) for tabs currently shown as a pane's active tab; absent = hidden. */
  rects: { [tabId: string]: Rect };
  /**
   * True when each rect is a pane's and the body starts below that pane's strip
   * (`--group-strip-h`). False on the mobile layer, which draws no strip.
   */
  bodyOffset: boolean;
  /** The focused pane's tab id (drives editor keyboard capture + focus ring). */
  focusedId: string | null;
  /** True when there is more than one pane (marks each pane's body as a slot). */
  inSplit: boolean;
  webApps: WebAppLink[];
  quickLinks: QuickLink[];
  onCreate: (spec: CreateSpec) => void;
  onUpdateQuickLinks: (links: QuickLink[]) => void;
  onChangeUrl: (id: string, url: string) => void;
  onDirtyChange: (id: string, dirty: boolean) => void;
  /** Focus the pane showing this tab on click. */
  onFocus: (id: string) => void;
  /** Set on mobile: pane headers get a ☰ that opens the session drawer. */
  onMenu?: (() => void) | undefined;
}

const rectStyle = (r: Rect, bodyOffset: boolean): CSSProperties => ({
  position: 'absolute',
  ...rectCss(r, bodyOffset),
  pointerEvents: 'auto',
});

export const PaneHost = memo(function PaneHost({
  tabs,
  rects,
  bodyOffset,
  focusedId,
  inSplit,
  webApps,
  quickLinks,
  onCreate,
  onUpdateQuickLinks,
  onChangeUrl,
  onDirtyChange,
  onFocus,
  onMenu,
}: PaneHostProps) {
  const panes = tabs.filter((t) => t.kind !== 'terminal');
  if (panes.length === 0) return null;

  return (
    <div className="pane-host" data-testid="pane-host">
      {panes.map((tab) => {
        const rect = rects[tab.id];
        const shown = rect !== undefined;
        const focused = tab.id === focusedId;
        const cls = `pane${shown ? '' : ' hidden'}${inSplit && shown ? ' slot' : ''}${
          inSplit && focused ? ' focused' : ''
        }`;
        return (
          <div
            key={tab.id}
            className={cls}
            style={shown && rect ? rectStyle(rect, bodyOffset) : undefined}
            onMouseDown={() => onFocus(tab.id)}
          >
            {tab.kind === 'web' && (
              <WebPane tab={tab} onChangeUrl={(url) => onChangeUrl(tab.id, url)} onMenu={onMenu} />
            )}
            {tab.kind === 'dashboard' && (
              <DashboardTab
                webApps={webApps}
                quickLinks={quickLinks}
                onCreate={onCreate}
                onUpdateQuickLinks={onUpdateQuickLinks}
                onMenu={onMenu}
              />
            )}
            {/* An `editor` tab is two things, told apart by `url`: with an
                absolute path it is a FILE on disk (Read/Edit over /file?path=),
                without one it is the tab's own note at /pane-file?tab=<id>. */}
            {tab.kind === 'editor' &&
              (tab.url ? (
                <FileTabPane
                  path={tab.url}
                  onChangePath={(path) => onChangeUrl(tab.id, path)}
                  onDirtyChange={(dirty) => onDirtyChange(tab.id, dirty)}
                />
              ) : (
                <EditorPane
                  tabId={tab.id}
                  active={focused}
                  onDirtyChange={onDirtyChange}
                  onMenu={onMenu}
                />
              ))}
            {tab.kind === 'markdown' && (
              <MarkdownPane
                tab={tab}
                onChangePath={(path) => onChangeUrl(tab.id, path)}
                onMenu={onMenu}
              />
            )}
            {/* A review is told whether it is shown and whether its slot has focus, and
                nothing else: a hidden one issues no request, and only a focused one
                may make its project the active one (App does that from the tab). */}
            {tab.kind === 'review' && <ReviewPane tab={tab} visible={shown} focused={focused} />}
          </div>
        );
      })}
    </div>
  );
});
