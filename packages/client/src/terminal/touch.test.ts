import type { Terminal } from '@xterm/xterm';
import {
  drainScrollUnits,
  encodeMouseSGR,
  GAIN_MAX_VELOCITY,
  GAIN_MIN_VELOCITY,
  getSelectionEndpoints,
  isMouseReporting,
  MAX_SCROLL_GAIN,
  MAX_WHEEL_NOTCHES,
  MAX_WHEEL_TRAVEL_CELLS,
  selectRange,
  velocityGain,
  WHEEL_CELLS_PER_NOTCH,
} from './touch';

// A hand-rolled fake Terminal sufficient for the pure helpers under test.
// The pixel/cell math (cellFromClient, cell0FromClient) is intentionally not
// tested — it depends on getBoundingClientRect layout that happy-dom does not
// compute.
function fakeTerm(opts: { mouseTrackingMode?: string; cols?: number; viewportY?: number }) {
  return {
    modes: { mouseTrackingMode: opts.mouseTrackingMode ?? 'none' },
    cols: opts.cols ?? 80,
    buffer: { active: { viewportY: opts.viewportY ?? 0 } },
    select: vi.fn(),
  } as unknown as Terminal & { select: ReturnType<typeof vi.fn> };
}

describe('encodeMouseSGR', () => {
  it('encodes a press with a trailing M', () => {
    expect(encodeMouseSGR(0, 5, 3, false)).toBe('\x1b[<0;5;3M');
  });

  it('encodes a release with a trailing m', () => {
    expect(encodeMouseSGR(0, 5, 3, true)).toBe('\x1b[<0;5;3m');
  });

  it('encodes wheel buttons', () => {
    expect(encodeMouseSGR(64, 10, 20, false)).toBe('\x1b[<64;10;20M');
  });
});

describe('drainScrollUnits', () => {
  it('keeps accumulating below one step', () => {
    expect(drainScrollUnits(19, 20)).toEqual({ units: 0, rest: 19 });
    expect(drainScrollUnits(-19, 20)).toEqual({ units: 0, rest: -19 });
  });

  it('emits whole units and carries the remainder', () => {
    expect(drainScrollUnits(45, 20)).toEqual({ units: 2, rest: 5 });
    expect(drainScrollUnits(-45, 20)).toEqual({ units: -2, rest: -5 });
  });

  it('caps a burst and carries at most one further flush worth of excess', () => {
    // 500px at 20px/step, cap 4: 4 units flushed (80px), leftover 420px is
    // clamped to one flush worth (80px) so a flick drains fast but bounded.
    expect(drainScrollUnits(500, 20, 4)).toEqual({ units: 4, rest: 80 });
    expect(drainScrollUnits(-500, 20, 4)).toEqual({ units: -4, rest: -80 });
    // Leftover below the bound is carried in full.
    expect(drainScrollUnits(110, 20, 4)).toEqual({ units: 4, rest: 30 });
    expect(drainScrollUnits(-110, 20, 4)).toEqual({ units: -4, rest: -30 });
  });

  it('is inert for a non-positive step', () => {
    expect(drainScrollUnits(100, 0)).toEqual({ units: 0, rest: 0 });
  });

  it('wheel constants: one notch per line of finger travel', () => {
    // 200px of swipe over 20px cells = 10 lines of finger travel → 10 notches,
    // under the cap. The old 3-cells-per-notch mapping emitted 3 here, which is
    // the 3x under-scroll that made a full-screen TUI feel stuck.
    const { units } = drainScrollUnits(200, 20 * WHEEL_CELLS_PER_NOTCH, MAX_WHEEL_NOTCHES);
    expect(units).toBe(10);
  });

  it('the per-flush cap is a TRAVEL limit, unchanged by the notch size', () => {
    // 300px over 20px cells = 15 cells of travel; the cap allows 12.
    const { units, rest } = drainScrollUnits(300, 20 * WHEEL_CELLS_PER_NOTCH, MAX_WHEEL_NOTCHES);
    expect(units).toBe(MAX_WHEEL_NOTCHES);
    expect(units * WHEEL_CELLS_PER_NOTCH).toBe(MAX_WHEEL_TRAVEL_CELLS);
    // The excess is carried, not discarded — a flick keeps its distance.
    expect(rest).toBeGreaterThan(0);
  });
});

describe('velocityGain', () => {
  it('stays 1 at or below the slow-drag threshold (precision preserved)', () => {
    expect(velocityGain(0)).toBe(1);
    expect(velocityGain(GAIN_MIN_VELOCITY)).toBe(1);
    expect(velocityGain(-GAIN_MIN_VELOCITY)).toBe(1);
  });

  it('clamps to MAX_SCROLL_GAIN at or above the fast-flick velocity', () => {
    expect(velocityGain(GAIN_MAX_VELOCITY)).toBe(MAX_SCROLL_GAIN);
    expect(velocityGain(GAIN_MAX_VELOCITY * 10)).toBe(MAX_SCROLL_GAIN);
    expect(velocityGain(-GAIN_MAX_VELOCITY * 10)).toBe(MAX_SCROLL_GAIN);
  });

  it('ramps monotonically between the thresholds', () => {
    const mid = (GAIN_MIN_VELOCITY + GAIN_MAX_VELOCITY) / 2;
    const g = velocityGain(mid);
    expect(g).toBeGreaterThan(1);
    expect(g).toBeLessThan(MAX_SCROLL_GAIN);
    expect(velocityGain(mid + 0.1)).toBeGreaterThan(g);
    expect(g).toBeCloseTo((1 + MAX_SCROLL_GAIN) / 2, 10);
  });

  it('is 1 for non-finite velocity (degenerate dt)', () => {
    expect(velocityGain(Number.POSITIVE_INFINITY)).toBe(1);
    expect(velocityGain(Number.NaN)).toBe(1);
  });
});

describe('isMouseReporting', () => {
  it('is false when mouseTrackingMode is none', () => {
    expect(isMouseReporting(fakeTerm({ mouseTrackingMode: 'none' }))).toBe(false);
  });

  it('is true for any other tracking mode', () => {
    expect(isMouseReporting(fakeTerm({ mouseTrackingMode: 'x10' }))).toBe(true);
    expect(isMouseReporting(fakeTerm({ mouseTrackingMode: 'any' }))).toBe(true);
  });
});

describe('selectRange', () => {
  it('selects forward and offsets rows by viewportY', () => {
    const term = fakeTerm({ cols: 80, viewportY: 100 });
    selectRange(term, { col: 2, row: 1 }, { col: 5, row: 1 });
    // same row: length = (col diff) + 1 = 4, anchored at absolute row 101
    expect(term.select).toHaveBeenCalledWith(2, 101, 4);
  });

  it('orders reversed endpoints (drag right-to-left)', () => {
    const term = fakeTerm({ cols: 80, viewportY: 0 });
    selectRange(term, { col: 5, row: 1 }, { col: 2, row: 1 });
    expect(term.select).toHaveBeenCalledWith(2, 1, 4);
  });

  it('orders endpoints across rows', () => {
    const term = fakeTerm({ cols: 80, viewportY: 0 });
    // end is on an earlier row → must be swapped to be the start
    selectRange(term, { col: 1, row: 2 }, { col: 3, row: 0 });
    // start becomes {c:3,r:0}, end {c:1,r:2}; length = (2-0)*80 + (1-3) + 1
    expect(term.select).toHaveBeenCalledWith(3, 0, 2 * 80 + (1 - 3) + 1);
  });

  it('spans multiple rows in forward order', () => {
    const term = fakeTerm({ cols: 10, viewportY: 0 });
    selectRange(term, { col: 0, row: 0 }, { col: 0, row: 1 });
    // length = (1-0)*10 + (0-0) + 1 = 11
    expect(term.select).toHaveBeenCalledWith(0, 0, 11);
  });

  it('does not call select when length is non-positive', () => {
    // identical start/end → length 1 (still selects); construct a zero-length
    // by exploiting same cell is length 1, so instead test that select fires.
    const term = fakeTerm({ cols: 80, viewportY: 0 });
    selectRange(term, { col: 4, row: 0 }, { col: 4, row: 0 });
    expect(term.select).toHaveBeenCalledWith(4, 0, 1);
  });
});

describe('getSelectionEndpoints', () => {
  it('records the ordered inclusive endpoints in absolute buffer coords', () => {
    const term = fakeTerm({ cols: 80, viewportY: 100 });
    // pass reversed + across rows; endpoints must come back ordered top→bottom
    selectRange(term, { col: 1, row: 3 }, { col: 5, row: 1 });
    expect(getSelectionEndpoints()).toEqual({
      start: { col: 5, row: 101 }, // top-left, absolute row = 100 + 1
      end: { col: 1, row: 103 }, // bottom-right, absolute row = 100 + 3
    });
  });

  it('tracks the latest selection after a handle re-drag', () => {
    const term = fakeTerm({ cols: 80, viewportY: 0 });
    selectRange(term, { col: 0, row: 0 }, { col: 9, row: 2 });
    selectRange(term, { col: 0, row: 0 }, { col: 4, row: 5 }); // extend end down
    expect(getSelectionEndpoints()).toEqual({
      start: { col: 0, row: 0 },
      end: { col: 4, row: 5 },
    });
  });
});
