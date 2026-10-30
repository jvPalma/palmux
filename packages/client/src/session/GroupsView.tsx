// ── Editor groups rendering ───────────────────────────────────────────────────
//
// Draws the pane grid's layout. The tree is NEVER rendered as nested elements: every strip, terminal,
// the one PaneHost, every drop overlay and every sash is a flat, absolutely positioned DIRECT CHILD
// of one `.groups-view` root, placed by the percent rects `layoutRects` computed. Nesting would
// reparent a PaneHost child on every split or merge, and an iframe or a Monaco editor reloads when
// its DOM parent changes.
//
// A terminal is keyed by its PANE (`leaf.id`), and never by its tab: the pane's socket effect takes
// `sessionId` as a dependency so a tab switch swaps the session in place. A key that carried the tab
// id remounted the pane on every switch, which minted a fresh `clientKeyRef` the server reads as a
// RIVAL client: the pane evicted itself and showed "Opened somewhere else." (GroupsView.test.tsx
// holds it.)
//
// The body of a pane is its rect minus the strip above it. The strip's height is a token
// (`--group-strip-h`), so the rect maths stays percentages and the offset is a `calc`. Without strips
// (the mobile layer) the root sets the token to 0px and draws none. A detached window draws strips
// as the main window does.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import type { TabMeta, WebAppLink } from '@palmux/shared';
import { TerminalPane, type MobileGestures } from '../terminal/TerminalPane';
import { PaneHost } from '../panes/PaneHost';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import type { CreateSpec, QuickLink } from '../panes/DashboardBody';
import type { ClientSettings } from '../settings/settings';
import { GroupDropOverlay } from './GroupDropOverlay';
import { Sash } from './Sash';
import type { SplitRegistry } from './SplitFocusContext';
import {
  leaves,
  rectCss,
  type PaneLayout,
  type PaneLeaf,
  type Rect,
  type Sash as SashGeometry,
  type Side,
} from './pane-grid';

interface GroupsViewProps {
  /** Null until the first broadcast has been reconciled: nothing mounts before then. */
  layout: PaneLayout | null;
  /** Every pane's rect, in percent of the content area. */
  rects: ReadonlyMap<string, Rect>;
  sashes: SashGeometry[];
  /** Draw a strip above each pane. False on the mobile layer only: a detached window draws them. */
  strips: boolean;
  /** While the New-tab PAGE is up nothing mounts but one strip (a pane would respawn the id). */
  chooserPage: boolean;
  /** The tab being dragged, or null: while set, every pane shows its drop overlay. */
  dragTabId: string | null;
  /**
   * A tab dragged in from ANOTHER window is over this one (`dragTabId` is null then): every pane
   * shows its overlay, and a drop on any of them is meaningful because the tab is in none of them.
   */
  externalDrag?: boolean | undefined;
  /** The content of a pane's strip box (the box itself is drawn here). */
  renderStrip: (leaf: PaneLeaf, rect: Rect) => ReactNode;
  onFocusLeaf: (leafId: string) => void;
  /** `id` is the tab the drop carries (its `getData`): the only name a drag from another window has. */
  onDropEdge: (leafId: string, side: Side, id: string | null) => void;
  onDropCentre: (leafId: string, id: string | null) => void;
  /** Cumulative since the drag began; apply it to the layout the drag started from. */
  onSashDrag: (sash: SashGeometry, deltaFraction: number) => void;
  /** A drag that moved has ended: commit the layout. It also fires when the dragged sash UNMOUNTS
   *  mid-drag (another window's broadcast reshaped the layout), from inside the commit that removed
   *  it, and reaches the callback of THAT render: the caller must commit its CURRENT layout, which
   *  may no longer hold the sash, never the one it captured when the drag began. */
  onSashSettle: () => void;
  /** True when a sash drag begins, false when it ends however it ends (released, cancelled, or
   *  the sash unmounted), so the caller can capture and then drop the layout the drag started from. */
  onSashDragging?: ((on: boolean) => void) | undefined;
  /** The content area is mid-transition (the dock is opening/closing), so fit visually but hold
   *  the PTY resize until it settles; the same discipline the sash drag uses. */
  resizeBusy?: boolean | undefined;
  /** The content-area element, measured by the sashes and marked while one is dragged. */
  containerRef: RefObject<HTMLDivElement | null>;
  // ── TerminalPane deps ──
  registry: SplitRegistry;
  settings: ClientSettings;
  mobileActive: boolean;
  maxUploadBytes: number;
  paneBlocked: () => boolean;
  onAutoCopy: () => void;
  onUploadError: (msg: string) => void;
  onFocusRequest: (slot: string) => void;
  takeSpawnTmux: (id: string) => string | null | undefined;
  terminalGestures: MobileGestures;
  /** The detached window this is, handed to every terminal for its data socket. Null/absent: the main window. */
  window?: string | null | undefined;
  // ── PaneHost deps ──
  tabs: TabMeta[];
  webApps: WebAppLink[];
  quickLinks: QuickLink[];
  onCreate: (spec: CreateSpec) => void;
  onUpdateQuickLinks: (links: QuickLink[]) => void;
  onChangeUrl: (id: string, url: string) => void;
  onPaneDirty: (id: string, dirty: boolean) => void;
  onPaneFocus: (id: string) => void;
  paneMenu?: (() => void) | undefined;
}

/** A pane's active tab, with the kind the LAYOUT holds for it. */
const activeRef = (leaf: PaneLeaf) => leaf.tabs.find((t) => t.id === leaf.active) ?? null;

export const GroupsView = (props: GroupsViewProps) => {
  const {
    layout,
    rects,
    sashes,
    strips,
    chooserPage,
    dragTabId,
    externalDrag,
    renderStrip,
    onFocusLeaf,
    onDropEdge,
    onDropCentre,
    onSashDrag,
    onSashSettle,
    onSashDragging,
    resizeBusy,
    containerRef,
    registry,
    settings,
    mobileActive,
    maxUploadBytes,
    paneBlocked,
    onAutoCopy,
    onUploadError,
    onFocusRequest,
    takeSpawnTmux,
    terminalGestures,
    window: windowId,
    tabs,
    webApps,
    quickLinks,
    onCreate,
    onUpdateQuickLinks,
    onChangeUrl,
    onPaneDirty,
    onPaneFocus,
    paneMenu,
  } = props;
  // A sash is being dragged: every terminal fits visually but holds its PTY resize until release.
  const [sashDragging, setSashDragging] = useState(false);

  // The newest sash callbacks, behind STABLE handlers. A sash removed mid-drag settles from its
  // passive unmount cleanup, and it never sees the props of the render that removed it, so it held
  // the closures of the render before (stale over the caller's state). A LAYOUT effect has already
  // run for that commit when the cleanup does; a passive one here would run after it.
  const sashPropsRef = useRef({ onSashDrag, onSashSettle, onSashDragging, registry });
  useLayoutEffect(() => {
    sashPropsRef.current = { onSashDrag, onSashSettle, onSashDragging, registry };
  });
  const settleSash = useCallback(() => {
    sashPropsRef.current.onSashSettle();
    // Re-fit every pane to its settled size, a frame later so the new rects are laid out first.
    requestAnimationFrame(() => sashPropsRef.current.registry.forEachApi((api) => api.refit()));
  }, []);
  const reportSashDragging = useCallback((on: boolean) => {
    setSashDragging(on);
    sashPropsRef.current.onSashDragging?.(on);
  }, []);

  // PaneHost is memoised: its `rects` must keep their identity until a pane moves or switches.
  const { paneRects, focusedPaneId } = useMemo(() => {
    const byTab: { [tabId: string]: Rect } = {};
    let focusedId: string | null = null;
    if (layout) {
      for (const leaf of leaves(layout)) {
        const active = activeRef(leaf);
        const rect = rects.get(leaf.id);
        if (!active || active.kind === 'terminal' || !rect) continue;
        byTab[active.id] = rect;
        if (leaf.id === layout.focused) focusedId = active.id;
      }
    }
    return { paneRects: byTab, focusedPaneId: focusedId };
  }, [layout, rects]);

  if (!layout) return null;

  const panes = leaves(layout);
  const multiple = panes.length > 1;
  // With the chooser page up there is one pane (no tabs): its strip stays, so `+` is still there.
  const chooserPane = panes.find((l) => l.id === layout.focused) ?? panes[0];
  const stripPanes = chooserPage ? (chooserPane ? [chooserPane] : []) : panes;

  return (
    <div
      className="groups-view"
      data-testid="groups-view"
      // `.groups-view` is `position: absolute; inset: 0` in the stylesheet, which makes it the
      // positioned ancestor of everything below (PaneHost's own `inset: 0` included). Only the
      // per-mode token is inline: without strips the body offset collapses to nothing.
      style={strips ? undefined : ({ '--group-strip-h': '0px' } as CSSProperties)}
    >
      {strips &&
        stripPanes.map((leaf) => {
          const rect = rects.get(leaf.id);
          if (!rect) return null;
          return (
            <div
              key={leaf.id}
              className={`group-strip${leaf.id === layout.focused ? ' group-strip-focused' : ''}`}
              data-testid={`group-strip-${leaf.id}`}
              data-pane-id={leaf.id}
              // Its height is the stylesheet's (`--group-strip-h`).
              style={{
                position: 'absolute',
                left: `${rect.left}%`,
                top: `${rect.top}%`,
                width: `${rect.width}%`,
              }}
              // Capture: a click on a pill or the `+` focuses the pane whatever the strip then does.
              // The primary button only: a middle-click closes a tab and a right-click opens its
              // menu, and neither is a request to move focus to that pane.
              onPointerDownCapture={(e) => {
                if (e.button === 0) onFocusLeaf(leaf.id);
              }}
            >
              {/* A render throw here unmounts the whole React root, and with it every terminal. */}
              <ErrorBoundary label="Tabs">{renderStrip(leaf, rect)}</ErrorBoundary>
            </div>
          );
        })}

      {/* Each terminal pane renders its own TerminalPane (xterm + socket), positioned by rect.
          Non-terminal tabs are shown by PaneHost. The boundary is per PANE: a render throw used to
          unmount the whole React root, which costs every attached terminal and every unsaved buffer.
          Keyed by PANE ALONE (see the header): a boundary key that carried the tab id remounted the
          pane on every switch. A stuck boundary is cleared by its own "Try again" instead. */}
      {!chooserPage &&
        panes.map((leaf) => {
          const active = activeRef(leaf);
          const rect = rects.get(leaf.id);
          if (!active || active.kind !== 'terminal' || !rect) return null;
          const body: CSSProperties = { position: 'absolute', ...rectCss(rect, strips) };
          return (
            <ErrorBoundary key={leaf.id} label="Terminal" style={body}>
              <TerminalPane
                key={leaf.id}
                slot={leaf.id}
                sessionId={active.id}
                registry={registry}
                settings={settings}
                mobileActive={mobileActive}
                focused={leaf.id === layout.focused}
                inSplit={multiple}
                resizePaused={sashDragging || !!resizeBusy}
                style={body}
                maxUploadBytes={maxUploadBytes}
                isBlocked={paneBlocked}
                onAutoCopy={onAutoCopy}
                onUploadError={onUploadError}
                onFocusRequest={onFocusRequest}
                takeSpawnTmux={takeSpawnTmux}
                window={windowId ?? undefined}
                gestures={terminalGestures}
              />
            </ErrorBoundary>
          );
        })}

      {/* PaneHost owns every non-terminal pane (iframe, editor, markdown, dashboard) and positions
          each by its pane's rect itself, so the boundary needs no style of its own: a throw here is
          a Monaco or a marked failure, and it must not take the terminals with it. */}
      {!chooserPage && (
        <ErrorBoundary label="Panes">
          <PaneHost
            tabs={tabs}
            rects={paneRects}
            bodyOffset={strips}
            focusedId={focusedPaneId}
            inSplit={multiple}
            webApps={webApps}
            quickLinks={quickLinks}
            onCreate={onCreate}
            onUpdateQuickLinks={onUpdateQuickLinks}
            onChangeUrl={onChangeUrl}
            onDirtyChange={onPaneDirty}
            onFocus={onPaneFocus}
            onMenu={paneMenu}
          />
        </ErrorBoundary>
      )}

      {/* Tab drags: each pane's body takes a drop, where the pointer sits picking edge or centre.
          A tab already in the pane has no centre to drop on, and a pane's only tab no edge. A tab
          from another window is in no pane here, so every region of every pane is live. */}
      {!chooserPage &&
        (dragTabId !== null || externalDrag) &&
        panes.map((leaf) => {
          const rect = rects.get(leaf.id);
          if (!rect) return null;
          const canCentre = !!externalDrag || !leaf.tabs.some((t) => t.id === dragTabId);
          return (
            <GroupDropOverlay
              key={leaf.id}
              rect={rect}
              canCentre={canCentre}
              canSplit={canCentre || leaf.tabs.length > 1}
              onDropEdge={(side, id) => onDropEdge(leaf.id, side, id)}
              onDropCentre={(id) => onDropCentre(leaf.id, id)}
            />
          );
        })}

      {!chooserPage &&
        sashes.map((sash) => (
          <Sash
            key={`${sash.path.join('.')}:${sash.index}`}
            sash={sash}
            containerRef={containerRef}
            onDrag={(deltaFraction) => sashPropsRef.current.onSashDrag(sash, deltaFraction)}
            onSettle={settleSash}
            onDragging={reportSashDragging}
          />
        ))}
    </div>
  );
};
