import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isNarrowReview,
  observeReviewWidth,
  resolveReviewLayout,
  resolveWrap,
  REVIEW_SPLIT_MIN_PX,
} from './review-layout';

afterEach(() => vi.unstubAllGlobals());

describe('the layout rule', () => {
  it('is narrow below 720px of pane width, wide from it', () => {
    expect(REVIEW_SPLIT_MIN_PX).toBe(720);
    expect(isNarrowReview(390)).toBe(true);
    expect(isNarrowReview(719)).toBe(true);
    expect(isNarrowReview(720)).toBe(false);
    expect(isNarrowReview(1400)).toBe(false);
  });

  it('automatic is unified when narrow and split when wide; a choice ignores the width', () => {
    expect(resolveReviewLayout('auto', true)).toBe('unified');
    expect(resolveReviewLayout('auto', false)).toBe('split');
    expect(resolveReviewLayout('split', true)).toBe('split');
    expect(resolveReviewLayout('unified', false)).toBe('unified');
  });

  it('split always wraps; unified follows the toggle, else wraps exactly when narrow', () => {
    expect(resolveWrap(false, 'split', false)).toBe(true);
    expect(resolveWrap(null, 'unified', true)).toBe(true);
    expect(resolveWrap(null, 'unified', false)).toBe(false);
    expect(resolveWrap(false, 'unified', true)).toBe(false);
    expect(resolveWrap(true, 'unified', false)).toBe(true);
  });
});

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  disconnected = false;
  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  resize(width: number) {
    this.callback(
      [{ contentRect: { width } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

function hostOfWidth(width: number): HTMLElement {
  const host = document.createElement('div');
  host.getBoundingClientRect = () => ({ width }) as DOMRect;
  return host;
}

describe('observeReviewWidth', () => {
  const setup = (initial: number) => {
    FakeResizeObserver.instances = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const crossings: boolean[] = [];
    const widths: number[] = [];
    const stop = observeReviewWidth(
      hostOfWidth(initial),
      (narrow) => crossings.push(narrow),
      (width) => widths.push(width),
    );
    return { crossings, widths, stop, observer: FakeResizeObserver.instances[0]! };
  };

  it('reports the starting class once, then only crossings', () => {
    const { crossings, observer } = setup(390);
    expect(crossings).toEqual([true]);
    observer.resize(400);
    observer.resize(700);
    expect(crossings).toEqual([true]);
    observer.resize(720);
    expect(crossings).toEqual([true, false]);
    observer.resize(1400);
    observer.resize(900);
    expect(crossings).toEqual([true, false]);
    observer.resize(500);
    expect(crossings).toEqual([true, false, true]);
  });

  it('tells the width listener every positive width, which is not a crossing', () => {
    const { widths, observer } = setup(390);
    observer.resize(400);
    observer.resize(410);
    expect(widths).toEqual([390, 400, 410]);
  });

  // Panes stay mounted, so a hidden one measures 0 on every tab switch.
  it('ignores a hidden pane’s zero width rather than reading it as narrow', () => {
    const { crossings, widths, observer } = setup(1400);
    expect(crossings).toEqual([false]);
    observer.resize(0);
    expect(crossings).toEqual([false]);
    expect(widths).toEqual([1400]);
    observer.resize(1300);
    expect(crossings).toEqual([false]);
  });

  it('reports nothing for a host that has no width yet, until it does', () => {
    const { crossings, observer } = setup(0);
    expect(crossings).toEqual([]);
    observer.resize(390);
    expect(crossings).toEqual([true]);
  });

  it('stops observing', () => {
    const { stop, observer } = setup(390);
    stop();
    expect(observer.disconnected).toBe(true);
  });
});
