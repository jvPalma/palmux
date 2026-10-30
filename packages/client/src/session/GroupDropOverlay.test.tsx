// The overlay's whole job is to name a region from a pointer position and to refuse the ones that
// would change nothing. happy-dom has no layout, so each test gives the overlay a 300x300 box and
// drives it with `dragover` coordinates: thirds at 100 and 200. happy-dom has no DragEvent either,
// so `fireEvent.dragOver` would build a plain Event and drop `clientX`; the helper below builds the
// event itself and defines the fields the component reads.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GroupDropOverlay } from './GroupDropOverlay';
import { TAB_DND_TYPE } from './SessionTabs';

/** A DataTransfer stub: `getData` answers `id` for the tab type, as a browser does on a drop. */
const dt = (types: string[], id = '') => ({
  types,
  setData: () => {},
  getData: (type: string) => (type === TAB_DND_TYPE ? id : ''),
  effectAllowed: '',
  dropEffect: '',
});

const RECT = { left: 0, top: 0, width: 50, height: 100 };

function setup(over: Partial<React.ComponentProps<typeof GroupDropOverlay>> = {}) {
  const onDropEdge = vi.fn();
  const onDropCentre = vi.fn();
  render(
    <GroupDropOverlay
      rect={RECT}
      canSplit
      canCentre
      onDropEdge={onDropEdge}
      onDropCentre={onDropCentre}
      {...over}
    />,
  );
  const el = screen.getByTestId('group-drop-overlay');
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 300 }) as DOMRect;
  return { el, onDropEdge, onDropCentre };
}

const preview = () => screen.queryByTestId('group-drop-preview');

/** Dispatch a drag event; answers false when a handler called `preventDefault`, like `fireEvent`. */
function drag(
  type: 'dragenter' | 'dragover' | 'drop' | 'dragleave',
  el: HTMLElement,
  x: number,
  y: number,
  types: string[],
  relatedTarget: EventTarget | null = null,
  id = '',
): boolean {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(ev, {
    clientX: { value: x },
    clientY: { value: y },
    dataTransfer: { value: dt(types, id) },
    relatedTarget: { value: relatedTarget },
  });
  return fireEvent(el, ev);
}
const over = (el: HTMLElement, x: number, y: number, types = [TAB_DND_TYPE]) =>
  drag('dragover', el, x, y, types);
const enter = (el: HTMLElement, x: number, y: number, types = [TAB_DND_TYPE]) =>
  drag('dragenter', el, x, y, types);
const drop = (el: HTMLElement, x: number, y: number, types = [TAB_DND_TYPE], id = '') =>
  drag('drop', el, x, y, types, null, id);

describe('GroupDropOverlay regions', () => {
  it.each([
    ['left', 50, 150],
    ['right', 250, 150],
    ['top', 150, 50],
    ['bottom', 150, 250],
    ['centre', 150, 150],
  ])('names %s from the pointer position', (region, x, y) => {
    const { el } = setup();
    expect(preview()).toBeNull();
    over(el, x as number, y as number);
    expect(preview()?.getAttribute('data-region')).toBe(region);
  });

  it('prefers the horizontal thirds: a corner is left or right, never top or bottom', () => {
    const { el } = setup();
    over(el, 20, 20);
    expect(preview()?.getAttribute('data-region')).toBe('left');
    over(el, 280, 280);
    expect(preview()?.getAttribute('data-region')).toBe('right');
  });

  it('takes the third boundaries themselves for the centre cell', () => {
    const { el } = setup();
    over(el, 100, 100);
    expect(preview()?.getAttribute('data-region')).toBe('centre');
    over(el, 200, 200);
    expect(preview()?.getAttribute('data-region')).toBe('centre');
  });

  it('moves the preview as the pointer moves between regions', () => {
    const { el } = setup();
    over(el, 250, 150);
    expect(preview()?.getAttribute('data-region')).toBe('right');
    over(el, 150, 50);
    expect(preview()?.getAttribute('data-region')).toBe('top');
  });
});

describe('GroupDropOverlay preview', () => {
  it.each([
    ['left', { left: '0px', top: '0px', width: '50%', height: '100%' }],
    ['right', { left: '50%', top: '0px', width: '50%', height: '100%' }],
    ['top', { left: '0px', top: '0px', width: '100%', height: '50%' }],
    ['bottom', { left: '0px', top: '50%', width: '100%', height: '50%' }],
    ['centre', { left: '0px', top: '0px', width: '100%', height: '100%' }],
  ])('covers the %s half, or the whole box for the centre', (region, box) => {
    const { el } = setup();
    const at: Record<string, [number, number]> = {
      left: [50, 150],
      right: [250, 150],
      top: [150, 50],
      bottom: [150, 250],
      centre: [150, 150],
    };
    over(el, ...at[region as string]!);
    const p = preview()!;
    expect(p.style.left).toBe(box.left);
    expect(p.style.top).toBe(box.top);
    expect(p.style.width).toBe(box.width);
    expect(p.style.height).toBe(box.height);
  });

  it('never takes pointer events and never animates', () => {
    const { el } = setup();
    over(el, 250, 150);
    expect(preview()!.style.pointerEvents).toBe('none');
    expect(preview()!.style.transition).toBe('');
  });

  // The body's top and height are `calc(... var(--group-strip-h))`, which happy-dom drops, so only
  // the horizontal placement and the positioning are observable here.
  it('is positioned absolutely at the left edge and width of the pane rect', () => {
    const { el } = setup();
    expect(el.style.left).toBe('0%');
    expect(el.style.width).toBe('50%');
    expect(el.style.position).toBe('absolute');
  });
});

describe('GroupDropOverlay file drags', () => {
  it('shows nothing and does not cancel the event, so the upload drop handles it', () => {
    const { el, onDropEdge, onDropCentre } = setup();
    const notCancelled = over(el, 250, 150, ['Files']);
    expect(notCancelled).toBe(true); // `fireEvent` answers false when preventDefault ran
    expect(preview()).toBeNull();
    const dropNotCancelled = drop(el, 250, 150, ['Files']);
    expect(dropNotCancelled).toBe(true);
    expect(onDropEdge).not.toHaveBeenCalled();
    expect(onDropCentre).not.toHaveBeenCalled();
  });

  it('does not cancel its dragenter either', () => {
    const { el } = setup();
    expect(enter(el, 250, 150, ['Files'])).toBe(true);
    expect(preview()).toBeNull();
  });

  it('ignores a group-chip drag as well', () => {
    const { el } = setup();
    over(el, 250, 150, ['application/x-palmux-group']);
    expect(preview()).toBeNull();
  });
});

describe('GroupDropOverlay drops', () => {
  it('an edge drop reports the side and clears the preview', () => {
    const { el, onDropEdge, onDropCentre } = setup();
    over(el, 250, 150);
    drop(el, 250, 150);
    expect(onDropEdge).toHaveBeenCalledTimes(1);
    expect(onDropEdge).toHaveBeenCalledWith('right', null);
    expect(onDropCentre).not.toHaveBeenCalled();
    expect(preview()).toBeNull();
  });

  it('a centre drop reports the centre and clears the preview', () => {
    const { el, onDropEdge, onDropCentre } = setup();
    over(el, 150, 150);
    drop(el, 150, 150);
    expect(onDropCentre).toHaveBeenCalledTimes(1);
    expect(onDropCentre).toHaveBeenCalledWith(null);
    expect(onDropEdge).not.toHaveBeenCalled();
    expect(preview()).toBeNull();
  });

  // A drag from another window has no local id in App, so the overlay reads the one the drag carries.
  it('reports the id the drag carries, read with the tab type on the drop', () => {
    const { el, onDropEdge, onDropCentre } = setup();
    drop(el, 250, 150, [TAB_DND_TYPE], '7');
    expect(onDropEdge).toHaveBeenCalledWith('right', '7');
    drop(el, 150, 150, [TAB_DND_TYPE], '8');
    expect(onDropCentre).toHaveBeenCalledWith('8');
  });

  it('reads the region from the drop itself, not from the last dragover', () => {
    const { el, onDropEdge } = setup();
    over(el, 150, 150); // centre
    drop(el, 50, 150); // …released over the left third
    expect(onDropEdge).toHaveBeenCalledWith('left', null);
  });

  it('cancels dragover on a region it will accept, so the browser allows the drop', () => {
    const { el } = setup();
    expect(over(el, 250, 150)).toBe(false);
  });

  // Chromium fires only `dragenter` on the element a drag has just moved onto, and its answer is
  // the drop operation until the next `dragover`, which a still pointer gets ~352 ms later. The
  // overlay mounting under a still pointer is such a move too.
  it('cancels dragenter on a region it will accept and previews it, so a release right after is allowed', () => {
    const { el, onDropEdge } = setup();
    expect(enter(el, 250, 150)).toBe(false);
    expect(preview()?.getAttribute('data-region')).toBe('right');
    drop(el, 250, 150, [TAB_DND_TYPE], '7');
    expect(onDropEdge).toHaveBeenCalledWith('right', '7');
  });
});

describe('GroupDropOverlay refusals', () => {
  it('canSplit=false: no edge preview, no edge drop, and dragover is left uncancelled', () => {
    const { el, onDropEdge, onDropCentre } = setup({ canSplit: false });
    expect(enter(el, 250, 150)).toBe(true);
    expect(over(el, 250, 150)).toBe(true);
    expect(preview()).toBeNull();
    drop(el, 250, 150);
    expect(onDropEdge).not.toHaveBeenCalled();
    // the centre is a separate switch and stays live
    over(el, 150, 150);
    expect(preview()?.getAttribute('data-region')).toBe('centre');
    drop(el, 150, 150);
    expect(onDropCentre).toHaveBeenCalledTimes(1);
  });

  it('canCentre=false: no centre preview or drop, edges still work', () => {
    const { el, onDropEdge, onDropCentre } = setup({ canCentre: false });
    expect(over(el, 150, 150)).toBe(true);
    expect(preview()).toBeNull();
    drop(el, 150, 150);
    expect(onDropCentre).not.toHaveBeenCalled();
    over(el, 50, 150);
    expect(preview()?.getAttribute('data-region')).toBe('left');
    drop(el, 50, 150);
    expect(onDropEdge).toHaveBeenCalledWith('left', null);
  });

  it('a lone tab on its own pane previews and accepts nothing anywhere', () => {
    const { el, onDropEdge, onDropCentre } = setup({ canSplit: false, canCentre: false });
    for (const [x, y] of [
      [50, 150],
      [250, 150],
      [150, 50],
      [150, 250],
      [150, 150],
    ] as const) {
      over(el, x, y);
      expect(preview()).toBeNull();
      drop(el, x, y);
    }
    expect(onDropEdge).not.toHaveBeenCalled();
    expect(onDropCentre).not.toHaveBeenCalled();
  });

  it('moving from a live region into a refused one clears the preview', () => {
    const { el } = setup({ canCentre: false });
    over(el, 50, 150);
    expect(preview()).not.toBeNull();
    over(el, 150, 150);
    expect(preview()).toBeNull();
  });
});

// The New-tab page has one empty pane and nothing to split: a drop anywhere over it goes into that
// pane, so every region is the centre.
describe('GroupDropOverlay centre only', () => {
  it.each([
    ['left', 20, 150],
    ['right', 280, 150],
    ['top', 150, 20],
    ['bottom', 150, 280],
  ])('reads the %s third as the centre: previewed whole, dropped as a centre', (_r, x, y) => {
    const { el, onDropEdge, onDropCentre } = setup({ centreOnly: true });
    expect(over(el, x as number, y as number)).toBe(false);
    expect(preview()?.getAttribute('data-region')).toBe('centre');
    drop(el, x as number, y as number, [TAB_DND_TYPE], '4');
    expect(onDropCentre).toHaveBeenCalledWith('4');
    expect(onDropEdge).not.toHaveBeenCalled();
  });
});

describe('GroupDropOverlay leaving', () => {
  it('dragleave out of the box clears the preview', () => {
    const { el } = setup();
    over(el, 250, 150);
    expect(preview()).not.toBeNull();
    drag('dragleave', el, 0, 0, [TAB_DND_TYPE], null);
    expect(preview()).toBeNull();
  });

  it('dragleave into the preview child (still inside the overlay) keeps it', () => {
    const { el } = setup();
    over(el, 250, 150);
    drag('dragleave', el, 0, 0, [TAB_DND_TYPE], preview());
    expect(preview()).not.toBeNull();
  });
});
