// The divider's double-tap-to-swap gesture. Worth its own file because the
// gesture is built from the pointer stream rather than the browser's `dblclick`:
// this element is a drag handle, and `dblclick` fires after two mouseups
// whatever happened between them, so a resize + a resize would have spent as a
// swap. Everything below is about telling those two apart.

import type { MutableRefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SplitDivider } from './SplitDivider';

// Mutable on purpose: each test installs a box with a real bounding rect.
const containerRef: MutableRefObject<HTMLElement | null> = { current: null };

function setup(onSwap?: () => void, onRotate?: () => void) {
  const onRatio = vi.fn();
  const onSettle = vi.fn();
  render(
    <SplitDivider
      orientation="row"
      ratio={0.5}
      containerRef={containerRef}
      onRatio={onRatio}
      onSettle={onSettle}
      onSwap={onSwap}
      onRotate={onRotate}
    />,
  );
  return { el: screen.getByTestId('split-divider'), onRatio, onSettle };
}

/** One complete pointer gesture: down at (x,y), optional moves, then up. */
function gesture(el: HTMLElement, x: number, y: number, moves: [number, number][] = []) {
  fireEvent.pointerDown(el, { pointerId: 1, clientX: x, clientY: y, button: 0 });
  for (const [mx, my] of moves) {
    fireEvent.pointerMove(el, { pointerId: 1, clientX: mx, clientY: my });
  }
  fireEvent.pointerUp(el, { pointerId: 1, clientX: x, clientY: y });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-08T12:00:00Z'));
  // happy-dom has no pointer capture; the component calls it unconditionally.
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  // The ratio is measured against this; without it every move early-returns and
  // "it still resizes" would pass for the wrong reason.
  const box = document.createElement('div');
  box.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 400, height: 200 }) as DOMRect;
  containerRef.current = box;
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('SplitDivider double-tap to swap', () => {
  it('swaps on two taps inside the window', () => {
    const onSwap = vi.fn();
    const { el } = setup(onSwap);
    gesture(el, 100, 50);
    expect(onSwap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    gesture(el, 100, 50);
    expect(onSwap).toHaveBeenCalledTimes(1);
  });

  it('does not swap when the second tap is past 500ms', () => {
    const onSwap = vi.fn();
    const { el } = setup(onSwap);
    gesture(el, 100, 50);
    vi.advanceTimersByTime(501);
    gesture(el, 100, 50);
    expect(onSwap).not.toHaveBeenCalled();
  });

  it('takes the boundary itself — exactly 500ms still counts', () => {
    const onSwap = vi.fn();
    const { el } = setup(onSwap);
    gesture(el, 100, 50);
    vi.advanceTimersByTime(500);
    gesture(el, 100, 50);
    expect(onSwap).toHaveBeenCalledTimes(1);
  });

  // The one that matters: a resize is not half a gesture. Without this the
  // handle would swap the panes at the end of two ordinary drags.
  it('ignores a gesture that moved — a resize is never half a double tap', () => {
    const onSwap = vi.fn();
    const { el } = setup(onSwap);
    gesture(el, 100, 50, [[160, 50]]);
    vi.advanceTimersByTime(100);
    gesture(el, 160, 50, [[220, 50]]);
    expect(onSwap).not.toHaveBeenCalled();
  });

  it('a resize also clears a pending first tap', () => {
    const onSwap = vi.fn();
    const { el } = setup(onSwap);
    gesture(el, 100, 50); // tap 1
    vi.advanceTimersByTime(50);
    gesture(el, 100, 50, [[200, 50]]); // resize — spends nothing, clears the tap
    vi.advanceTimersByTime(50);
    gesture(el, 200, 50); // would have been "tap 2" if the resize counted
    expect(onSwap).not.toHaveBeenCalled();
  });

  it('treats sub-slop jitter as a tap, not a resize', () => {
    const onSwap = vi.fn();
    const { el } = setup(onSwap);
    gesture(el, 100, 50, [[102, 51]]); // 3px total — a finger, not a drag
    vi.advanceTimersByTime(100);
    gesture(el, 100, 50, [[101, 50]]);
    expect(onSwap).toHaveBeenCalledTimes(1);
  });

  it('spends the pair — a third tap starts over instead of swapping again', () => {
    const onSwap = vi.fn();
    const { el } = setup(onSwap);
    gesture(el, 100, 50);
    vi.advanceTimersByTime(100);
    gesture(el, 100, 50);
    vi.advanceTimersByTime(100);
    gesture(el, 100, 50);
    expect(onSwap).toHaveBeenCalledTimes(1);
  });

  it('still resizes normally, and announces the gesture only when it exists', () => {
    const withSwap = setup(vi.fn());
    expect(withSwap.el.getAttribute('title')).toMatch(/double-click to swap/i);
    cleanup();
    const { el, onRatio, onSettle } = setup(undefined);
    expect(el.getAttribute('title')).toBeNull();
    gesture(el, 100, 50, [[300, 50]]);
    expect(onRatio).toHaveBeenCalled();
    expect(onSettle).toHaveBeenCalledTimes(1);
  });
});

// ── Rotate handle ─────────────────────────────────────────────────────────────
//
// The ⬍ toggle used to sit in the desktop topbar. That bar is gone, and the
// control is contextual to a split, so it moved onto the divider next to the
// double-tap. Everything here is about the two gestures not eating each other.
describe('SplitDivider rotate handle', () => {
  it('appears only when there is something to rotate', () => {
    setup(vi.fn(), undefined);
    expect(screen.queryByTestId('split-orient')).toBeNull();
    cleanup();
    setup(vi.fn(), vi.fn());
    expect(screen.getByTestId('split-orient')).toBeTruthy();
  });

  it('rotates on click', () => {
    const onRotate = vi.fn();
    setup(vi.fn(), onRotate);
    fireEvent.click(screen.getByTestId('split-orient'));
    expect(onRotate).toHaveBeenCalledTimes(1);
  });

  // The handle sits ON the drag surface. Without stopPropagation, pressing it
  // would arm a divider drag and — worse — count as one half of the double tap,
  // so rotate-then-rotate would also swap the panes.
  it('never arms a drag or half a double tap', () => {
    const onSwap = vi.fn();
    const onRotate = vi.fn();
    const { onRatio, onSettle } = setup(onSwap, onRotate);
    const btn = screen.getByTestId('split-orient');
    for (let i = 0; i < 2; i++) {
      fireEvent.pointerDown(btn, { pointerId: 1, clientX: 100, clientY: 50, button: 0 });
      fireEvent.pointerUp(btn, { pointerId: 1, clientX: 100, clientY: 50 });
      fireEvent.click(btn);
      vi.advanceTimersByTime(100);
    }
    expect(onRotate).toHaveBeenCalledTimes(2);
    expect(onSwap).not.toHaveBeenCalled();
    expect(onRatio).not.toHaveBeenCalled();
    expect(onSettle).not.toHaveBeenCalled();
  });
});
