// ── Split view rendering (extracted from App) ─────────────────────────────────
//
// Owns the split GEOMETRY (slot rects), the live divider `dragRatio` (local, so
// a resize drag re-renders only this subtree, not App), and the content-area
// children: the terminal slots, the non-terminal PaneHost, the divider, the
// per-slot eject controls, and the drag drop zones. App keeps the navigation
// state + the content-area wrapper; this isolates ~230 lines of the hub.

import { useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { TabKind, TabMeta, WebAppLink } from '@palmux/shared';
import { TerminalPane, type MobileGestures } from '../terminal/TerminalPane';
import { PaneHost } from '../panes/PaneHost';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { SplitDivider } from './SplitDivider';
import { SplitDropZones } from './SplitDropZones';
import { SlotDropZones } from './SlotDropZones';
import type { CreateSpec, QuickLink } from '../panes/DashboardBody';
import type { ClientSettings } from '../settings/settings';
import type { SplitRegistry } from './SplitFocusContext';
import {
  fullRect,
  splitRects,
  type Rect,
  type SlotId,
  type SlotRef,
  type SplitState,
} from './useSplit';

interface SplitViewProps {
  /** The active pairing when it is tiled on screen, else null (single full-width). */
  pairing: SplitState | null;
  /** The active tab id, and its kind (for the single-slot full-width case). */
  sessionId: string;
  activeKind: TabKind;
  /** While the New-tab PAGE is up nothing mounts (a pane would respawn the id). */
  chooserPage: boolean;
  /** Show the edge drop zones (open a split) — App owns the drag condition. */
  showEdgeZones: boolean;
  /** Show the per-slot drop zones (replace a slot) — App owns the drag condition. */
  showSlotZones: boolean;
  /** The content-area element, measured by the divider. */
  containerRef: RefObject<HTMLDivElement | null>;
  // ── TerminalPane deps ──
  registry: SplitRegistry;
  settings: ClientSettings;
  mobileActive: boolean;
  maxUploadBytes: number;
  paneBlocked: () => boolean;
  onAutoCopy: () => void;
  onUploadError: (msg: string) => void;
  onFocusRequest: (slot: SlotId) => void;
  /** The content area is mid-transition (the dock is opening/closing), so fit
   *  visually but hold the PTY resize until it settles — the same discipline the
   *  divider drag uses, reused rather than duplicated. */
  resizeBusy?: boolean | undefined;
  takeSpawnTmux: (id: string) => string | null | undefined;
  terminalGestures: MobileGestures;
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
  // ── Split ops (App owns the split model) ──
  onRatioCommit: (ratio: number) => void;
  /** Double-click on the divider — trade the two panes' sides. */
  onSwapSlots?: (() => void) | undefined;
  /** Rotate row ↔ column, from the divider's own handle. */
  onRotateSplit?: (() => void) | undefined;
  onEject: (keep: SlotId) => void;
  onDropSplit: (id: string, side: 'left' | 'right' | 'top' | 'bottom') => void;
  onDropSlot: (id: string, slot: SlotId) => void;
}

const rectCss = (r: Rect): CSSProperties => ({
  position: 'absolute',
  left: `${r.left}%`,
  top: `${r.top}%`,
  width: `${r.width}%`,
  height: `${r.height}%`,
});

export const SplitView = ({
  pairing,
  sessionId,
  activeKind,
  chooserPage,
  showEdgeZones,
  showSlotZones,
  containerRef,
  registry,
  settings,
  mobileActive,
  maxUploadBytes,
  paneBlocked,
  onAutoCopy,
  onUploadError,
  onFocusRequest,
  resizeBusy,
  takeSpawnTmux,
  terminalGestures,
  tabs,
  webApps,
  quickLinks,
  onCreate,
  onUpdateQuickLinks,
  onChangeUrl,
  onPaneDirty,
  onPaneFocus,
  paneMenu,
  onRatioCommit,
  onSwapSlots,
  onRotateSplit,
  onEject,
  onDropSplit,
  onDropSlot,
}: SplitViewProps) => {
  // Live divider ratio during a drag — LOCAL so a resize re-renders only this
  // subtree (App and its memoized siblings skip the per-frame update).
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const dragRatioRef = useRef(dragRatio);
  dragRatioRef.current = dragRatio;

  const slots = useMemo<Array<{ slot: SlotId; ref: SlotRef; rect: Rect; focused: boolean }>>(() => {
    if (pairing) {
      const rects = splitRects(pairing.orientation, dragRatio ?? pairing.ratio);
      return [
        { slot: 'a', ref: pairing.a, rect: rects.a, focused: pairing.focused === 'a' },
        { slot: 'b', ref: pairing.b, rect: rects.b, focused: pairing.focused === 'b' },
      ];
    }
    return [
      { slot: 'a', ref: { tabId: sessionId, kind: activeKind }, rect: fullRect(), focused: true },
    ];
  }, [pairing, dragRatio, sessionId, activeKind]);

  const { paneRects, focusedPaneId } = useMemo(() => {
    const rects: { [id: string]: Rect } = {};
    for (const s of slots) if (s.ref.kind !== 'terminal') rects[s.ref.tabId] = s.rect;
    // In single-slot mode a non-terminal tab only shows when it's the active tab.
    if (!pairing && activeKind === 'terminal') delete rects[sessionId];
    const focusedSlot = slots.find((s) => s.focused) ?? slots[0]!;
    return {
      paneRects: rects,
      focusedPaneId: focusedSlot.ref.kind !== 'terminal' ? focusedSlot.ref.tabId : null,
    };
  }, [slots, pairing, activeKind, sessionId]);

  const onDividerSettle = () => {
    if (dragRatioRef.current !== null) onRatioCommit(dragRatioRef.current);
    setDragRatio(null);
    // Re-fit BOTH panes to their settled size (deferred a frame so the new rects
    // are laid out first).
    requestAnimationFrame(() => {
      registry.apiFor('a')?.refit();
      registry.apiFor('b')?.refit();
    });
  };

  return (
    <>
      {/* Each terminal slot renders its own TerminalPane (xterm + socket),
          positioned by rect. Non-terminal slots are shown by PaneHost. */}
      {!chooserPage &&
        slots.map((s) =>
          s.ref.kind === 'terminal' ? (
            // Per-SLOT boundary. A render throw used to unmount the whole React
            // root, which costs every attached terminal and every unsaved
            // buffer; scoped here, the other pane and the strip survive.
            //
            // Keyed by SLOT ALONE. It briefly included the tab id too, so that
            // switching tabs would also clear a stuck boundary — which silently
            // broke the invariant the pane is built on: "the pane is keyed by
            // SLOT, so a tab switch swaps sessionId in place" (TerminalPane's
            // socket effect takes `sessionId` as a dependency for exactly that).
            // With the id in the key, every tab switch REMOUNTED the pane, which
            // threw away its xterm instance and minted a fresh `clientKeyRef`
            // uuid — and a fresh key reads to the server as a RIVAL client, so
            // the pane evicted itself and showed "Opened somewhere else." That
            // is the reported "on mobile, switching sessions closes my terminal
            // and I have to open it again"; it surfaces on a slow link, where
            // the old socket is still attached when the new one arrives.
            // A stuck boundary is cleared by its own "Try again" instead.
            <ErrorBoundary
              key={s.slot}
              label={`Terminal ${s.ref.tabId}`}
              style={rectCss(s.rect)}
            >
            <TerminalPane
              slot={s.slot}
              sessionId={s.ref.tabId}
              registry={registry}
              settings={settings}
              mobileActive={mobileActive}
              focused={s.focused}
              inSplit={!!pairing}
              resizePaused={dragRatio !== null || !!resizeBusy}
              style={rectCss(s.rect)}
              maxUploadBytes={maxUploadBytes}
              isBlocked={paneBlocked}
              onAutoCopy={onAutoCopy}
              onUploadError={onUploadError}
              onFocusRequest={onFocusRequest}
              takeSpawnTmux={takeSpawnTmux}
              gestures={terminalGestures}
            />
            </ErrorBoundary>
          ) : null,
        )}

      {/* PaneHost owns every non-terminal pane (iframe, editor, markdown,
          dashboard) and positions them by rect itself, so the boundary needs no
          style of its own — a throw here is a Monaco or a marked failure, and it
          must not take the terminals with it. */}
      <ErrorBoundary label="Panes">
      <PaneHost
        tabs={tabs}
        rects={paneRects}
        focusedId={focusedPaneId}
        inSplit={!!pairing}
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

      {pairing && (
        <SplitDivider
          orientation={pairing.orientation}
          ratio={dragRatio ?? pairing.ratio}
          containerRef={containerRef}
          onRatio={setDragRatio}
          onSettle={onDividerSettle}
          onSwap={onSwapSlots}
          onRotate={onRotateSplit}
        />
      )}

      {/* Per-slot eject: removes that tab from the split — the OTHER slot's tab
          goes full-width; neither tab is closed. */}
      {pairing &&
        slots.length === 2 &&
        slots.map((s) => (
          <button
            key={`eject-${s.slot}`}
            className="slot-eject"
            style={{
              left: `calc(${s.rect.left + s.rect.width}% - 34px)`,
              top: `calc(${s.rect.top}% + 8px)`,
            }}
            title="Remove from split"
            aria-label={`Remove the ${s.slot === 'a' ? 'first' : 'second'} tab from the split`}
            data-testid={`slot-eject-${s.slot}`}
            onClick={() => onEject(s.slot === 'a' ? 'b' : 'a')}
          >
            ⏏
          </button>
        ))}

      {/* Tab drags: edge zones OPEN a split when none is shown; slot zones
          REPLACE a slot's content while one is. App owns the drag conditions
          (a fused-button drag lights neither). */}
      {showEdgeZones && <SplitDropZones onDropSplit={onDropSplit} />}
      {showSlotZones && pairing && (
        <SlotDropZones
          rects={splitRects(pairing.orientation, dragRatio ?? pairing.ratio)}
          onDropSlot={onDropSlot}
        />
      )}
    </>
  );
};
