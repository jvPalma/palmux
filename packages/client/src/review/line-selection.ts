// ── Picking lines to comment on ───────────────────────────────────────────────
//
// A range is picked on the LINE NUMBERS of one side of one file, three ways that
// share this one small state machine:
//   - a mouse drag from one number across others (`begin`, `enter`, `release`);
//   - shift-click, which extends the range already picked (`begin` with `extend`);
//   - on a phone, tap a number, then tap the last line of the range (`tap`). There
//     is no long-press: it would fight the browser's own text selection.
//   - on a keyboard, Enter or Space on a focused number picks that line, and with
//     Shift extends the range already picked (`pick`): the mouse's press and release,
//     in one step, since a key has no drag.
// A pick never crosses a file or a side, because a comment belongs to one of each.
//
// The first tap already picks a line (so a one-line comment is one tap and the
// Comment button), and the second tap widens it. A third tap starts again.

import type { DiffSide } from './rows';

export interface LineTarget {
  path: string;
  side: DiffSide;
  no: number;
}

export interface LineSelection {
  path: string;
  side: DiffSide;
  /** Where the pick began; the range runs from here to `end`, either way round. */
  anchor: number;
  end: number;
  /**
   * `drag`: a mouse is still down and the range follows it. `start`: a tap picked
   * one line and the next tap on this file and side widens it. `range`: settled.
   */
  phase: 'drag' | 'start' | 'range';
}

/** What a line number does with a pointer; the pane builds one over its selection state. */
export interface LineGestures {
  /** A mouse went down on a number; `extend` is shift. */
  begin: (target: LineTarget, extend: boolean) => void;
  /** A mouse, still down, came over a number. */
  enter: (target: LineTarget) => void;
  /** A finger tapped a number. */
  tap: (target: LineTarget) => void;
  /** A key picked a number; `extend` is shift. */
  pick: (target: LineTarget, extend: boolean) => void;
}

export interface LineRange {
  path: string;
  side: DiffSide;
  start: number;
  end: number;
}

const sameSide = (a: LineSelection | null, b: LineTarget): a is LineSelection =>
  a !== null && a.path === b.path && a.side === b.side;

export const rangeOf = (selection: LineSelection): LineRange => ({
  path: selection.path,
  side: selection.side,
  start: Math.min(selection.anchor, selection.end),
  end: Math.max(selection.anchor, selection.end),
});

/** A mouse went down on a number. With `extend` (shift) the range already picked grows to it. */
export function beginSelection(
  previous: LineSelection | null,
  target: LineTarget,
  extend: boolean,
): LineSelection {
  if (extend && sameSide(previous, target)) return { ...previous, end: target.no, phase: 'drag' };
  return { path: target.path, side: target.side, anchor: target.no, end: target.no, phase: 'drag' };
}

/** A key picked a number: what a mouse press and release on it would settle on. */
export function pickSelection(
  previous: LineSelection | null,
  target: LineTarget,
  extend: boolean,
): LineSelection {
  return { ...beginSelection(previous, target, extend), phase: 'range' };
}

/** The mouse, still down, came over another number. */
export function extendSelection(
  previous: LineSelection | null,
  target: LineTarget,
): LineSelection | null {
  if (!sameSide(previous, target) || previous.phase !== 'drag' || previous.end === target.no) {
    return previous;
  }
  return { ...previous, end: target.no };
}

/** The mouse went up. */
export function releaseSelection(previous: LineSelection | null): LineSelection | null {
  return previous?.phase === 'drag' ? { ...previous, phase: 'range' } : previous;
}

/** A finger tapped a number. */
export function tapSelection(previous: LineSelection | null, target: LineTarget): LineSelection {
  if (sameSide(previous, target) && previous.phase === 'start') {
    return { ...previous, end: target.no, phase: 'range' };
  }
  return {
    path: target.path,
    side: target.side,
    anchor: target.no,
    end: target.no,
    phase: 'start',
  };
}
