// ── Split divider ─────────────────────────────────────────────────────────────
//
// The draggable boundary between two split slots. Positioned at the ratio line;
// dragging updates the ratio live (rAF-throttled) and settles (persist + refit)
// on release. Uses pointer capture so the drag tracks outside the element.

import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { clampRatio, type Orientation } from './useSplit';

/**
 * Two taps within this window, neither of which moved, swap the panes. Not the
 * browser's own `dblclick`: this element is a drag handle whose whole job is to
 * move under the pointer, and `dblclick` fires after two mouseups regardless of
 * what happened between them — so a resize, a pause, and a second resize could
 * spend as one swap. The gesture is therefore built from the pointer stream that
 * already knows whether a drag happened.
 */
const DOUBLE_TAP_MS = 500;
/** Movement under this (px, either axis) is a tap, not a resize. */
const TAP_SLOP_PX = 4;

interface SplitDividerProps {
  orientation: Orientation;
  ratio: number;
  /** The content-area element the ratio is measured against. */
  containerRef: React.RefObject<HTMLElement | null>;
  onRatio: (ratio: number) => void;
  onSettle: () => void;
  /** Two taps within 500ms — trade the two panes' sides. */
  onSwap?: (() => void) | undefined;
  /** Rotate row ↔ column. Rendered as a handle on the divider itself: the
   *  control is contextual to a split, and the desktop topbar that used to hold
   *  it no longer exists. */
  onRotate?: (() => void) | undefined;
}

export const SplitDivider = ({
  orientation,
  ratio,
  containerRef,
  onRatio,
  onSettle,
  onSwap,
  onRotate,
}: SplitDividerProps) => {
  const raf = useRef(0);
  const draggingRef = useRef(false);
  const latestRef = useRef<number | null>(null); // newest sample, applied in the rAF
  const downAtRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(false);
  const lastTapRef = useRef(0);

  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    },
    [],
  );

  const onMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!draggingRef.current) return;
      const from = downAtRef.current;
      if (from && Math.abs(e.clientX - from.x) + Math.abs(e.clientY - from.y) > TAP_SLOP_PX) {
        movedRef.current = true;
      }
      const el = containerRef.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      const r =
        orientation === 'row'
          ? (e.clientX - box.left) / box.width
          : (e.clientY - box.top) / box.height;
      latestRef.current = clampRatio(r); // always keep the freshest sample
      if (raf.current) return;
      raf.current = requestAnimationFrame(() => {
        raf.current = 0;
        if (latestRef.current !== null) onRatio(latestRef.current);
      });
    },
    [containerRef, orientation, onRatio],
  );

  const onDown = useCallback((e: ReactPointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    latestRef.current = null;
    downAtRef.current = { x: e.clientX, y: e.clientY };
    movedRef.current = false;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const settle = useCallback(
    (e: ReactPointerEvent) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
      if (raf.current) {
        cancelAnimationFrame(raf.current);
        raf.current = 0;
      }
      // Apply the final sample the throttle may have dropped before settling.
      if (latestRef.current !== null) onRatio(latestRef.current);
      latestRef.current = null;
      // Only a real resize settles. A stationary tap changed no ratio, and
      // settling persists the split and refits every attached terminal — one
      // SIGWINCH per pane for a gesture that moved nothing.
      if (movedRef.current) onSettle();

      // A resize ends the gesture and cannot be half of a double tap; it also
      // clears any pending first tap, so resize-then-tap never swaps.
      if (movedRef.current) {
        lastTapRef.current = 0;
        return;
      }
      const now = Date.now();
      if (lastTapRef.current && now - lastTapRef.current <= DOUBLE_TAP_MS) {
        lastTapRef.current = 0; // spent — a third tap starts over, not a second swap
        onSwap?.();
      } else {
        lastTapRef.current = now;
      }
    },
    [onRatio, onSettle, onSwap],
  );

  const pct = `${clampRatio(ratio) * 100}%`;
  const style =
    orientation === 'row'
      ? {
          left: pct,
          top: 0,
          width: '10px',
          height: '100%',
          transform: 'translateX(-5px)',
          cursor: 'col-resize' as const,
        }
      : {
          top: pct,
          left: 0,
          height: '10px',
          width: '100%',
          transform: 'translateY(-5px)',
          cursor: 'row-resize' as const,
        };

  return (
    <div
      className={`split-divider ${orientation}`}
      data-testid="split-divider"
      style={{ position: 'absolute', zIndex: 25, ...style }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={settle}
      onPointerCancel={settle}
      onLostPointerCapture={settle}
      role="separator"
      aria-orientation={orientation === 'row' ? 'vertical' : 'horizontal'}
      title={onSwap ? 'Drag to resize · double-click to swap the panes' : undefined}
    >
      <span className="split-divider-line" />
      {onRotate && (
        <button
          className="split-divider-rotate"
          data-testid="split-orient"
          title={`Rotate the split (currently ${orientation === 'row' ? 'side by side' : 'stacked'})`}
          aria-label="Rotate the split"
          // The handle sits ON the drag surface, so it must not become part of
          // a drag or of the double-tap: stop the pointer stream here and act on
          // click, which a drag never produces.
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onRotate();
          }}
        >
          {orientation === 'row' ? '⬍' : '⬌'}
        </button>
      )}
    </div>
  );
};
