// A sash turns pointer pixels into a fraction of ITS BRANCH, cumulative from pointerdown, so the
// caller can apply it to the layout it captured at the start of the drag. Everything here pins
// that arithmetic against a branch that is NOT the whole content area (a half-width column), plus
// the gesture rules the old divider had: one settle per moved drag on every way it can end
// (release, cancel, unmount), none for a tap, each sample reported once, and a marker on the
// container for as long as the drag lasts (so an iframe cannot steal the pointer).

import type { MutableRefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Sash } from './Sash';
import type { Sash as SashGeometry } from './pane-grid';

// The branch is HALF the content area's width, so a 100px drag in a 1000px area is 100 / 500.
const rowSash: SashGeometry = {
  path: [1],
  index: 0,
  orientation: 'row',
  rect: { left: 75, top: 0, width: 0, height: 100 },
  branch: { left: 50, top: 0, width: 50, height: 100 },
};
// And half the height here: 800px area, 400px branch.
const columnSash: SashGeometry = {
  path: [],
  index: 0,
  orientation: 'column',
  rect: { left: 0, top: 25, width: 100, height: 0 },
  branch: { left: 0, top: 0, width: 100, height: 50 },
};

const container: MutableRefObject<HTMLElement | null> = { current: null };

let frames: Array<() => void> = [];
/** Run every queued animation frame once (a frame that queues another waits for the next call). */
const flushFrames = () => {
  const queued = frames;
  frames = [];
  for (const run of queued) run();
};

function setup(sash: SashGeometry = rowSash) {
  const calls: string[] = [];
  const onDrag = vi.fn((d: number) => void calls.push(`drag:${d}`));
  const onSettle = vi.fn(() => void calls.push('settle'));
  const onDragging = vi.fn((on: boolean) => void calls.push(`dragging:${on}`));
  const view = render(
    <Sash
      sash={sash}
      containerRef={container}
      onDrag={onDrag}
      onSettle={onSettle}
      onDragging={onDragging}
    />,
  );
  return { el: screen.getByTestId('group-sash'), onDrag, onSettle, onDragging, calls, view };
}

const down = (el: HTMLElement, x: number, y: number) =>
  fireEvent.pointerDown(el, { pointerId: 1, clientX: x, clientY: y, button: 0 });
const move = (el: HTMLElement, x: number, y: number) =>
  fireEvent.pointerMove(el, { pointerId: 1, clientX: x, clientY: y });
const up = (el: HTMLElement, x: number, y: number) =>
  fireEvent.pointerUp(el, { pointerId: 1, clientX: x, clientY: y });

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => frames.push(run));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames[id - 1] = () => {};
  });
  // happy-dom has no pointer capture; the component calls it unconditionally.
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  // Without a real box every move would early-return and "it still drags" would pass for the
  // wrong reason.
  const box = document.createElement('div');
  box.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 800 }) as DOMRect;
  container.current = box;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Sash delta', () => {
  it('reports a row drag as a fraction of the branch width, not of the content area', () => {
    const { el, onDrag } = setup();
    down(el, 400, 300);
    move(el, 500, 300);
    flushFrames();
    expect(onDrag).toHaveBeenLastCalledWith(0.2); // 100px / (50% of 1000px)
    move(el, 300, 300);
    flushFrames();
    expect(onDrag).toHaveBeenLastCalledWith(-0.2);
  });

  it('is cumulative from pointerdown: the second sample is the whole distance, not the step', () => {
    const { el, onDrag } = setup();
    down(el, 400, 300);
    move(el, 450, 300);
    flushFrames();
    move(el, 550, 300);
    flushFrames();
    expect(onDrag.mock.calls.map((c) => c[0])).toEqual([0.1, 0.3]);
  });

  it('measures a column sash on the vertical axis and the branch height', () => {
    const { el, onDrag } = setup(columnSash);
    down(el, 100, 200);
    move(el, 700, 240); // a big sideways move is irrelevant to a horizontal sash
    flushFrames();
    expect(onDrag).toHaveBeenLastCalledWith(0.1); // 40px / (50% of 800px)
  });

  it('throttles to one report per frame, carrying the newest sample', () => {
    const { el, onDrag } = setup();
    down(el, 400, 300);
    move(el, 450, 300);
    move(el, 500, 300);
    move(el, 600, 300);
    expect(onDrag).not.toHaveBeenCalled();
    flushFrames();
    expect(onDrag).toHaveBeenCalledTimes(1);
    expect(onDrag).toHaveBeenCalledWith(0.4);
  });

  it('reports nothing while the container has no size', () => {
    container.current!.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 0, height: 0 }) as DOMRect;
    const { el, onDrag, onSettle } = setup();
    down(el, 400, 300);
    move(el, 500, 300);
    flushFrames();
    up(el, 500, 300);
    expect(onDrag).not.toHaveBeenCalled();
    // The drag still moved, and a moved drag still settles: nothing was applied, so it is a no-op.
    expect(onSettle).toHaveBeenCalledTimes(1);
  });
});

describe('Sash gesture', () => {
  it('settles once per drag, after the final sample the throttle had not yet reported', () => {
    const { el, onDrag, onSettle, calls } = setup();
    down(el, 400, 300);
    move(el, 500, 300);
    up(el, 500, 300); // released before the frame ran
    expect(onDrag).toHaveBeenCalledTimes(1);
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['dragging:true', 'drag:0.2', 'settle', 'dragging:false']);
    // the frame that was queued is gone: a late flush reports nothing
    flushFrames();
    expect(onDrag).toHaveBeenCalledTimes(1);
  });

  it('release after the frame ran reports no duplicate delta', () => {
    const { el, onDrag, calls } = setup();
    down(el, 400, 300);
    move(el, 500, 300);
    flushFrames(); // the frame reports 0.2 and nothing is pending any more
    up(el, 500, 300);
    expect(onDrag).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['dragging:true', 'drag:0.2', 'settle', 'dragging:false']);
  });

  it('flushes on release only the sample that came after the last frame', () => {
    const { el, onDrag, calls } = setup();
    down(el, 400, 300);
    move(el, 500, 300);
    flushFrames();
    move(el, 550, 300); // newer than the frame, not reported yet
    up(el, 550, 300);
    expect(onDrag.mock.calls.map((c) => c[0])).toEqual([0.2, 0.3]);
    expect(calls.at(-2)).toBe('settle');
  });

  it('settles a moved drag once when it is cancelled, however many end events follow', () => {
    const { el, onSettle, calls } = setup();
    down(el, 400, 300);
    move(el, 500, 300);
    fireEvent.pointerCancel(el, { pointerId: 1 });
    fireEvent.lostPointerCapture(el, { pointerId: 1 });
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['dragging:true', 'drag:0.2', 'settle', 'dragging:false']);
  });

  it('settles a moved drag once when the sash unmounts mid-drag, dropping the unreported sample', () => {
    const { el, onDrag, onSettle, calls, view } = setup();
    down(el, 400, 300);
    move(el, 500, 300);
    flushFrames();
    move(el, 600, 300); // still pending when the layout reshapes under it
    view.unmount();
    expect(onSettle).toHaveBeenCalledTimes(1);
    // the sash it measured is gone, so its last sample is never reported
    expect(calls).toEqual(['dragging:true', 'drag:0.2', 'settle', 'dragging:false']);
    flushFrames();
    expect(onDrag).toHaveBeenCalledTimes(1);
  });

  it('does not settle when an unmoved press unmounts', () => {
    const { el, onSettle, onDragging, view } = setup();
    down(el, 400, 300);
    move(el, 402, 301); // under the slop: a tap
    view.unmount();
    expect(onSettle).not.toHaveBeenCalled();
    expect(onDragging.mock.calls).toEqual([[true], [false]]);
  });

  it('does not settle again when a sash that already settled unmounts', () => {
    const { el, onSettle, onDragging, view } = setup();
    down(el, 400, 300);
    move(el, 500, 300);
    up(el, 500, 300);
    view.unmount();
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onDragging.mock.calls).toEqual([[true], [false]]);
  });

  it('does not settle on a stationary tap, and still reports the drag state both ways', () => {
    const { el, onDrag, onSettle, onDragging } = setup();
    down(el, 400, 300);
    up(el, 400, 300);
    expect(onDrag).not.toHaveBeenCalled();
    expect(onSettle).not.toHaveBeenCalled();
    expect(onDragging.mock.calls).toEqual([[true], [false]]);
  });

  it('treats sub-slop jitter as a tap, not a resize', () => {
    const { el, onDrag, onSettle } = setup();
    down(el, 400, 300);
    move(el, 402, 301); // 3px in total: a finger, not a drag
    flushFrames();
    up(el, 402, 301);
    expect(onDrag).not.toHaveBeenCalled();
    expect(onSettle).not.toHaveBeenCalled();
  });

  it('a second drag starts from its own pointerdown', () => {
    const { el, onDrag, onSettle } = setup();
    down(el, 400, 300);
    move(el, 500, 300);
    up(el, 500, 300);
    down(el, 500, 300);
    move(el, 550, 300);
    up(el, 550, 300);
    expect(onDrag.mock.calls.map((c) => c[0])).toEqual([0.2, 0.1]);
    expect(onSettle).toHaveBeenCalledTimes(2);
  });

  it('ignores movement with no button down', () => {
    const { el, onDrag } = setup();
    move(el, 500, 300);
    flushFrames();
    expect(onDrag).not.toHaveBeenCalled();
  });
});

describe('Sash pointer guard', () => {
  // The press starts no drag, but it still must not take focus off the terminal: the default of a
  // pointerdown on the handle would, so it is prevented before the button is looked at.
  it('starts nothing on a middle or a right press, and still keeps focus where it was', () => {
    const { el, onDrag, onSettle, onDragging } = setup();
    for (const button of [1, 2]) {
      // `fireEvent` answers false when the handler called preventDefault.
      expect(fireEvent.pointerDown(el, { pointerId: 1, clientX: 400, clientY: 300, button })).toBe(
        false,
      );
      expect(container.current!.hasAttribute('data-sash-drag')).toBe(false);
      move(el, 500, 300);
      flushFrames();
      up(el, 500, 300);
    }
    expect(Element.prototype.setPointerCapture).not.toHaveBeenCalled();
    expect(onDragging).not.toHaveBeenCalled();
    expect(onDrag).not.toHaveBeenCalled();
    expect(onSettle).not.toHaveBeenCalled();

    // A primary press right after still drags, and settles exactly once.
    down(el, 400, 300);
    move(el, 500, 300);
    flushFrames();
    up(el, 500, 300);
    expect(onDragging.mock.calls).toEqual([[true], [false]]);
    expect(onDrag).toHaveBeenLastCalledWith(0.2);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it('ignores a second pointer mid-drag: no second start, no reset of the delta, no early end', () => {
    const { el, onDrag, onSettle, onDragging, calls } = setup();
    down(el, 400, 300);
    move(el, 500, 300);
    flushFrames();
    // a second finger lands on the sash and moves while the first still drags
    fireEvent.pointerDown(el, { pointerId: 2, clientX: 700, clientY: 300, button: 0 });
    fireEvent.pointerMove(el, { pointerId: 2, clientX: 900, clientY: 300 });
    flushFrames();
    expect(onDragging.mock.calls).toEqual([[true]]);
    expect(onDrag.mock.calls.map((c) => c[0])).toEqual([0.2]);
    // the first pointer is still measured from ITS pointerdown, not from the second one's
    move(el, 550, 300);
    flushFrames();
    expect(onDrag).toHaveBeenLastCalledWith(0.3);
    // and the second pointer's end events do not end the first pointer's drag
    fireEvent.pointerUp(el, { pointerId: 2, clientX: 900, clientY: 300 });
    fireEvent.pointerCancel(el, { pointerId: 2 });
    fireEvent.lostPointerCapture(el, { pointerId: 2 });
    expect(onSettle).not.toHaveBeenCalled();
    expect(container.current!.getAttribute('data-sash-drag')).toBe('true');
    up(el, 550, 300);
    expect(calls).toEqual(['dragging:true', 'drag:0.2', 'drag:0.3', 'settle', 'dragging:false']);
  });
});

describe('Sash container marker', () => {
  it('sets data-sash-drag on pointerdown and clears it on release', () => {
    const { el } = setup();
    expect(container.current!.hasAttribute('data-sash-drag')).toBe(false);
    down(el, 400, 300);
    expect(container.current!.getAttribute('data-sash-drag')).toBe('true');
    move(el, 500, 300);
    up(el, 500, 300);
    expect(container.current!.hasAttribute('data-sash-drag')).toBe(false);
  });

  it('clears it on a cancelled gesture too', () => {
    const { el, onDragging } = setup();
    down(el, 400, 300);
    fireEvent.pointerCancel(el, { pointerId: 1 });
    expect(container.current!.hasAttribute('data-sash-drag')).toBe(false);
    expect(onDragging).toHaveBeenLastCalledWith(false);
  });

  it('clears it, and the drag state, when the sash unmounts mid-drag', () => {
    const { el, onDragging, view } = setup();
    down(el, 400, 300);
    view.unmount();
    expect(container.current!.hasAttribute('data-sash-drag')).toBe(false);
    expect(onDragging).toHaveBeenLastCalledWith(false);
  });
});

describe('Sash geometry', () => {
  it('sits on the boundary, with the cursor the axis implies', () => {
    const { el } = setup();
    expect(el.style.left).toBe('75%');
    expect(el.style.height).toBe('100%');
    expect(el.style.cursor).toBe('col-resize');
    expect(el).toHaveAttribute('aria-orientation', 'vertical');
    cleanup();
    const { el: stacked } = setup(columnSash);
    expect(stacked.style.top).toBe('25%');
    expect(stacked.style.width).toBe('100%');
    expect(stacked.style.cursor).toBe('row-resize');
    expect(stacked).toHaveAttribute('aria-orientation', 'horizontal');
  });

  it('animates nothing', () => {
    const { el } = setup();
    expect(el.style.transition).toBe('');
  });
});
