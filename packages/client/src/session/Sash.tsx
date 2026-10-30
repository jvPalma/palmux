// ── Pane sash ─────────────────────────────────────────────────────────────────
//
// The draggable boundary between two adjacent children of a branch of the pane grid
// (it generalises the old two-slot divider; no swap, no rotate handle). Positioned by
// the sash's own zero-thickness rect, with an 8px hit area centred on it. Pointer
// capture keeps the drag alive outside the element.
//
// `onDrag` reports a delta as a fraction of the BRANCH's main axis, CUMULATIVE since
// pointerdown (rAF-throttled, latest sample wins). The caller therefore applies it to
// the layout it had when the drag began and never to the live one, or the deltas would
// compound every frame. `onSettle` fires once when the gesture ends (release, cancel or
// unmount), and only for a drag that moved: settling saves the layout and refits every
// terminal, one SIGWINCH per pane for a gesture that moved nothing.
//
// While a drag lasts, the container carries `data-sash-drag="true"`: framed pages would
// otherwise take the pointer from the sash the moment it crosses an iframe.
//
// One pointer drives a drag: only a primary-button press starts one, and while it lasts every
// other pointer's down, move and end events are ignored, so a second finger can neither restart
// the cumulative delta nor end the drag early.

import { useCallback, useEffect, useRef } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type { Sash as SashGeometry } from './pane-grid';

/** Movement under this (px, both axes summed) is a tap, not a resize. */
const TAP_SLOP_PX = 4;

interface SashProps {
  sash: SashGeometry;
  /** The content-area element the sash's branch is measured against. */
  containerRef: RefObject<HTMLElement | null>;
  /** Cumulative since pointerdown, as a fraction of the sash's branch. */
  onDrag: (deltaFraction: number) => void;
  /** Once, when a drag that moved ends: released, cancelled or unmounted. */
  onSettle: () => void;
  /** True on pointerdown, false when the gesture ends (settled, cancelled or unmounted). */
  onDragging: (on: boolean) => void;
}

export const Sash = ({ sash, containerRef, onDrag, onSettle, onDragging }: SashProps) => {
  // The newest props, read by handlers that must keep a stable identity across a drag.
  const sashRef = useRef(sash);
  const onDragRef = useRef(onDrag);
  const onSettleRef = useRef(onSettle);
  const onDraggingRef = useRef(onDragging);
  useEffect(() => {
    sashRef.current = sash;
    onDragRef.current = onDrag;
    onSettleRef.current = onSettle;
    onDraggingRef.current = onDragging;
  });

  const raf = useRef(0);
  const draggingRef = useRef(false);
  const pointerRef = useRef(0); // the pointer driving the drag; read only while dragging
  const movedRef = useRef(false);
  const downRef = useRef({ x: 0, y: 0 });
  const latestRef = useRef<number | null>(null); // newest sample, applied in the rAF
  const containerElRef = useRef<HTMLElement | null>(null);

  const cancelFrame = useCallback(() => {
    if (!raf.current) return;
    cancelAnimationFrame(raf.current);
    raf.current = 0;
  }, []);

  // Takes the marker off the element it was put on, even if the ref has moved on since.
  const endGesture = useCallback(() => {
    draggingRef.current = false;
    containerElRef.current?.removeAttribute('data-sash-drag');
    containerElRef.current = null;
    onDraggingRef.current(false);
  }, []);

  useEffect(
    () => () => {
      cancelFrame();
      // Unmounted mid-drag (another window's broadcast reshaped the layout). A drag that moved
      // settles here as a release would, or the layout it resized is never saved and no terminal
      // refits. Its unreported sample is dropped: it measured a sash that no longer exists. The
      // marker and the "dragging" state must not outlive it.
      if (!draggingRef.current) return;
      if (movedRef.current) onSettleRef.current();
      endGesture();
    },
    [cancelFrame, endGesture],
  );

  const onDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // Before the guard: a press on a handle that does not start a drag (a middle or right button,
      // a second pointer) must still not move DOM focus off the terminal, which is what a default
      // pointerdown on a focusable ancestor would do.
      e.preventDefault();
      // A middle or right press is not a resize, and a second pointer must not restart the drag.
      if (e.button !== 0 || draggingRef.current) return;
      draggingRef.current = true;
      pointerRef.current = e.pointerId;
      movedRef.current = false;
      latestRef.current = null;
      downRef.current = { x: e.clientX, y: e.clientY };
      containerElRef.current = containerRef.current;
      containerElRef.current?.setAttribute('data-sash-drag', 'true');
      e.currentTarget.setPointerCapture(e.pointerId);
      onDraggingRef.current(true);
    },
    [containerRef],
  );

  const onMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current || e.pointerId !== pointerRef.current) return;
      const dx = e.clientX - downRef.current.x;
      const dy = e.clientY - downRef.current.y;
      if (!movedRef.current) {
        if (Math.abs(dx) + Math.abs(dy) <= TAP_SLOP_PX) return;
        movedRef.current = true;
      }
      const box = containerRef.current?.getBoundingClientRect();
      if (!box) return;
      const { orientation, branch } = sashRef.current;
      const row = orientation === 'row'; // children side by side: the sash is a vertical line
      // Pixels the branch spans along the axis the sash moves on.
      const branchPx =
        ((row ? branch.width : branch.height) / 100) * (row ? box.width : box.height);
      if (!(branchPx > 0)) return;
      latestRef.current = (row ? dx : dy) / branchPx; // always keep the freshest sample
      if (raf.current) return;
      raf.current = requestAnimationFrame(() => {
        raf.current = 0;
        const sample = latestRef.current;
        // Reported, so no longer pending: a release after this frame must not report it again.
        latestRef.current = null;
        if (sample !== null) onDragRef.current(sample);
      });
    },
    [containerRef],
  );

  const settle = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current || e.pointerId !== pointerRef.current) return;
      // Before anything that can fire `lostpointercapture`, which lands back here.
      const moved = movedRef.current;
      draggingRef.current = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
      cancelFrame();
      // Apply the final sample the throttle had not reported yet, before settling.
      const pending = latestRef.current;
      latestRef.current = null;
      if (pending !== null) onDragRef.current(pending);
      if (moved) onSettleRef.current();
      endGesture();
    },
    [cancelFrame, endGesture],
  );

  const { rect, orientation } = sash;
  const row = orientation === 'row';
  // Inline because the geometry is data (a percent rect from the layout), not a style choice; the
  // 8px hit area is the scale's `--sp-2`.
  const style: CSSProperties = row
    ? {
        left: `${rect.left}%`,
        top: `${rect.top}%`,
        width: 'var(--sp-2)',
        height: `${rect.height}%`,
        transform: 'translateX(-50%)',
        cursor: 'col-resize',
      }
    : {
        left: `${rect.left}%`,
        top: `${rect.top}%`,
        width: `${rect.width}%`,
        height: 'var(--sp-2)',
        transform: 'translateY(-50%)',
        cursor: 'row-resize',
      };

  return (
    <div
      className={`group-sash ${orientation}`}
      data-testid="group-sash"
      // Above `.pane-host` (20) and below the drop overlay (40), as the old divider sat.
      style={{ position: 'absolute', zIndex: 25, touchAction: 'none', ...style }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={settle}
      onPointerCancel={settle}
      onLostPointerCapture={settle}
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
    />
  );
};
