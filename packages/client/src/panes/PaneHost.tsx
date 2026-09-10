// ── Pane host ─────────────────────────────────────────────────────────────────
//
// The persistent content layer for NON-terminal tabs: one element per open
// non-terminal tab, all kept mounted (iframes keep navigation state, Monaco
// keeps undo history) and positioned by rect. A pane shown in a slot gets that
// slot's rect; a pane in no slot is display:none. NEVER reparented — layout
// changes are style updates, so iframes/editors never reload. The
// host is pointer-events:none so the terminal in the other slot stays clickable;
// each visible pane re-enables pointer events over its own rect.

import { memo, type CSSProperties } from 'react';
import type { TabMeta } from '@palmux/shared';
import { WebPane } from './WebPane';
import { DashboardTab } from './DashboardTab';
import type { CreateSpec, QuickLink } from './DashboardBody';
import { EditorPane } from './EditorPane';
import { MarkdownPane } from './MarkdownPane';
import { FileTabPane } from './FileTabPane';
import type { WebAppLink } from '@palmux/shared';
import type { Rect } from '../session/useSplit';

interface PaneHostProps {
  /** All live tabs; the host renders the non-terminal ones. */
  tabs: TabMeta[];
  /** tabId → rect (%) for panes currently shown in a slot; absent = hidden. */
  rects: { [tabId: string]: Rect };
  /** The focused pane's tab id (drives editor keyboard capture + focus ring). */
  focusedId: string | null;
  /** True when a split is active (renders the slot focus ring). */
  inSplit: boolean;
  webApps: WebAppLink[];
  quickLinks: QuickLink[];
  onCreate: (spec: CreateSpec) => void;
  onUpdateQuickLinks: (links: QuickLink[]) => void;
  onChangeUrl: (id: string, url: string) => void;
  onDirtyChange: (id: string, dirty: boolean) => void;
  /** Focus this pane's slot on click. */
  onFocus: (id: string) => void;
  /** Set on mobile: pane headers get a ☰ that opens the session drawer. */
  onMenu?: (() => void) | undefined;
}

const rectStyle = (r: Rect): CSSProperties => ({
  position: 'absolute',
  left: `${r.left}%`,
  top: `${r.top}%`,
  width: `${r.width}%`,
  height: `${r.height}%`,
  pointerEvents: 'auto',
});

export const PaneHost = memo(function PaneHost({
  tabs,
  rects,
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
            style={shown && rect ? rectStyle(rect) : undefined}
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
          </div>
        );
      })}
    </div>
  );
});
