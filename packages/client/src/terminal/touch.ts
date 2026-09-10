// ── Touch → terminal coordinate / mouse / selection helpers ───────────────────
//
// xterm.js handles mouse reporting and selection for real pointer events, but it
// does NOT translate touch gestures. These helpers bridge that gap, driving an
// xterm Terminal from touch coordinates:
//   • cell math compensated for visualViewport (the fix for the large vertical
//     selection offset when the soft keyboard is up)
//   • SGR mouse encoding so a tap focuses a tmux pane and a swipe scrolls it
//   • linear selection so long-press-drag selects text for copy
//
// We assume SGR (1006) mouse encoding when forwarding — every modern app that
// turns on mouse reporting (tmux ≥ 2.1, vim, less) negotiates it.

import type { Terminal } from '@xterm/xterm';

/** True while the running app (tmux, vim, …) has requested mouse reporting. */
export function isMouseReporting(term: Terminal): boolean {
  return term.modes.mouseTrackingMode !== 'none';
}

// The exact grid rectangle xterm draws into (excludes our CSS padding), so
// rect.width / cols is the true cell width.
function gridRect(host: HTMLElement): DOMRect {
  const screen = host.querySelector('.xterm-screen') as HTMLElement | null;
  return (screen ?? host).getBoundingClientRect();
}

// Fractional cell position under a client point. touch clientX/Y are
// visual-viewport-relative while getBoundingClientRect is layout-relative; on
// mobile those diverge by the keyboard / dynamic-toolbar height, so we add the
// visualViewport offset back in.
function cellFraction(
  term: Terminal,
  host: HTMLElement,
  clientX: number,
  clientY: number,
): { fcol: number; frow: number } {
  const rect = gridRect(host);
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  const x = clientX + (vv?.offsetLeft ?? 0) - rect.left;
  const y = clientY + (vv?.offsetTop ?? 0) - rect.top;
  const cellW = rect.width / Math.max(1, term.cols);
  const cellH = rect.height / Math.max(1, term.rows);
  return { fcol: cellW > 0 ? x / cellW : 0, frow: cellH > 0 ? y / cellH : 0 };
}

/** 1-based viewport cell (the mouse protocol's coordinate space), clamped. */
export function cellFromClient(
  term: Terminal,
  host: HTMLElement,
  clientX: number,
  clientY: number,
): { col: number; row: number } {
  const { fcol, frow } = cellFraction(term, host, clientX, clientY);
  const col = Number.isNaN(fcol) ? 1 : Math.max(1, Math.min(Math.floor(fcol) + 1, term.cols));
  const row = Number.isNaN(frow) ? 1 : Math.max(1, Math.min(Math.floor(frow) + 1, term.rows));
  return { col, row };
}

/** 0-based viewport cell (xterm selection coordinate space), clamped. */
export function cell0FromClient(
  term: Terminal,
  host: HTMLElement,
  clientX: number,
  clientY: number,
): { col: number; row: number } {
  const { fcol, frow } = cellFraction(term, host, clientX, clientY);
  const col = Number.isNaN(fcol) ? 0 : Math.max(0, Math.min(Math.floor(fcol), term.cols - 1));
  const row = Number.isNaN(frow) ? 0 : Math.max(0, Math.min(Math.floor(frow), term.rows - 1));
  return { col, row };
}

/** Encode a mouse event as an SGR (1006) control sequence. */
export function encodeMouseSGR(btn: number, col: number, row: number, release: boolean): string {
  return `\x1b[<${btn};${col};${row}${release ? 'm' : 'M'}`;
}

/**
 * Forward a tap as a left-button click (press + release) at the tapped cell when
 * the app requests mouse reporting (tmux pane focus/select). Returns the bytes
 * to send, or null when mouse reporting is off (caller raises the keyboard).
 */
export function tapAsMouse(
  term: Terminal,
  host: HTMLElement,
  clientX: number,
  clientY: number,
): string | null {
  if (!isMouseReporting(term)) return null;
  const { col, row } = cellFromClient(term, host, clientX, clientY);
  return encodeMouseSGR(0, col, row, false) + encodeMouseSGR(0, col, row, true);
}

/**
 * Finger-travel per forwarded wheel notch, in cell heights.
 *
 * This used to be 3, on the assumption that apps multiply each notch by their
 * own lines-per-notch (~3, as tmux copy-mode and less do). Full-screen TUIs that
 * take the wheel themselves — Claude Code being the case that exposed it — scroll
 * ONE line per notch, so that assumption cost a 3× under-scroll: the content
 * crawled while the finger travelled.
 *
 * One notch per line of finger travel is the honest mapping: we emit what the
 * finger did and let the app decide what a notch means. It is exact for the
 * 1-line-per-notch apps, and the 3-line-per-notch ones now move faster than the
 * finger — the failure that is easy to notice and to flick around, rather than
 * the one that feels broken.
 */
export const WHEEL_CELLS_PER_NOTCH = 1;

/**
 * Most finger travel (in cell heights) one touchmove flush may forward. The cap
 * keeps a single burst from flooding the app's input parser — that flood is what
 * fragments frames into visible junk.
 *
 * Expressed as TRAVEL, not as a notch count, so it stays fixed when the notch
 * size changes: at 3 cells/notch the old cap of 4 notches was exactly this much
 * travel, and tying the two together keeps a fast flick from silently losing
 * distance the moment notches got finer.
 */
export const MAX_WHEEL_TRAVEL_CELLS = 12;

/** Hard cap on wheel notches per flush — MAX_WHEEL_TRAVEL_CELLS in notch units. */
export const MAX_WHEEL_NOTCHES = MAX_WHEEL_TRAVEL_CELLS / WHEEL_CELLS_PER_NOTCH;

/** Finger velocity (px/ms) at or below which swipe gain stays 1 — slow drags keep
 *  the precise ~1:1 finger-to-content mapping. */
export const GAIN_MIN_VELOCITY = 0.5;

/** Finger velocity (px/ms) at which swipe gain reaches its maximum. */
export const GAIN_MAX_VELOCITY = 2.5;

/** Maximum finger-travel multiplier for fast swipes. */
export const MAX_SCROLL_GAIN = 4;

/**
 * Finger-travel multiplier from instantaneous swipe velocity. 1 at or below
 * GAIN_MIN_VELOCITY (slow drags stay precise), ramping linearly to
 * MAX_SCROLL_GAIN at GAIN_MAX_VELOCITY — a flick travels content the way a
 * native fling would, without post-touch animation.
 */
export function velocityGain(pxPerMs: number): number {
  const v = Math.abs(pxPerMs);
  if (!Number.isFinite(v) || v <= GAIN_MIN_VELOCITY) return 1;
  if (v >= GAIN_MAX_VELOCITY) return MAX_SCROLL_GAIN;
  return (
    1 + ((v - GAIN_MIN_VELOCITY) / (GAIN_MAX_VELOCITY - GAIN_MIN_VELOCITY)) * (MAX_SCROLL_GAIN - 1)
  );
}

/**
 * Drain accumulated finger travel into whole scroll units of `stepPx`.
 * Returns the units to emit now and the leftover px to keep accumulating.
 * A capped flush carries at most one further flush worth of leftover
 * (±cap·stepPx): fast flicks aren't punished by discarding their excess, but
 * the tail is bounded and dies with the gesture (touchstart resets the accum;
 * no touchmove → no flush), so it can never scroll on after the finger lifts.
 */
export function drainScrollUnits(
  accumPx: number,
  stepPx: number,
  cap: number = Number.POSITIVE_INFINITY,
): { units: number; rest: number } {
  if (!(stepPx > 0)) return { units: 0, rest: 0 };
  let units = Math.trunc(accumPx / stepPx);
  if (units === 0) return { units: 0, rest: accumPx };
  let rest = accumPx - units * stepPx;
  if (units > cap) {
    units = cap;
    rest = Math.min(accumPx - cap * stepPx, cap * stepPx);
  } else if (units < -cap) {
    units = -cap;
    rest = Math.max(accumPx + cap * stepPx, -cap * stepPx);
  }
  return { units, rest };
}

/**
 * Encode `lines` of scroll as terminal mouse-wheel events at a point, for
 * forwarding to an app (tmux scrolls its own pane). Positive lines = toward
 * history (finger-down) → scroll-up button 64; negative → button 65.
 */
export function scrollAsWheel(
  term: Terminal,
  host: HTMLElement,
  lines: number,
  clientX: number,
  clientY: number,
): string {
  const { col, row } = cellFromClient(term, host, clientX, clientY);
  const btn = lines > 0 ? 64 : 65;
  return encodeMouseSGR(btn, col, row, false).repeat(Math.abs(lines));
}

/** A cell in absolute-buffer coordinates (row includes scrollback). */
export interface BufferCell {
  col: number;
  row: number;
}

// The endpoints of the last selection built via selectRange, ordered
// top-left → bottom-right, in ABSOLUTE buffer coordinates. The selection-handle
// drag reads these instead of term.getSelectionPosition(): the latter's `end`
// is exclusive (one cell/row past the last selected cell), so round-tripping
// through it shifts the anchor by a row and the selection jumps. These are the
// exact inclusive cells term.select() was given, so there is no ambiguity.
let lastSelection: { start: BufferCell; end: BufferCell } | null = null;

/** Ordered inclusive endpoints of the current selectRange selection, or null. */
export function getSelectionEndpoints(): { start: BufferCell; end: BufferCell } | null {
  return lastSelection;
}

/**
 * Select a linear range between two 0-based viewport cells (like a desktop
 * shift-drag). Converts viewport rows to absolute buffer lines so the selection
 * survives scrollback, and orders the endpoints so either drag direction works.
 */
export function selectRange(
  term: Terminal,
  start: { col: number; row: number },
  end: { col: number; row: number },
): void {
  const cols = term.cols;
  const base = term.buffer.active.viewportY;
  let s = { c: start.col, r: base + start.row };
  let e = { c: end.col, r: base + end.row };
  if (e.r < s.r || (e.r === s.r && e.c < s.c)) {
    const t = s;
    s = e;
    e = t;
  }
  const length = (e.r - s.r) * cols + (e.c - s.c) + 1;
  if (length > 0) {
    term.select(s.c, s.r, length);
    lastSelection = { start: { col: s.c, row: s.r }, end: { col: e.c, row: e.r } };
  }
}
