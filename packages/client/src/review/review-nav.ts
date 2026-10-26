// ── Moving by change and by file ──────────────────────────────────────────────
//
// Pure functions over the assembled rows: where is the next change, which file is
// next. The pane applies the answer to the scroller. A CHANGE is one block of
// changed lines (a run of removed and added lines with no unchanged line between);
// a file with no changed line to show (binary, too large, converted, conflicted,
// a mode change, a pure rename, or collapsed) counts as ONE change, at its header,
// so stepping through a review never steps silently over a file.
//
// "Where the view is" is the hard part. A jump scrolls a little ABOVE the change so
// its context shows, so the row at the top of the view afterwards is not the change.
// Reading the top row would make "next" land on the same change again. So a jump
// remembers where it landed (`landed`), and while the view has not moved since, that
// is the position. Once the reader scrolls, the position is read from the scroll
// offset instead, against the offset each change would be jumped to.

import { ROW_METRICS, firstVisibleRow } from './review-metrics';
import { fileIndexOfRow } from './scroll-anchor';
import type { Row } from './rows';

/** How far above a change a jump scrolls, so its context lines are in view. */
export const NAV_CONTEXT_PX = 3 * ROW_METRICS.line;

export interface NavView {
  rows: readonly Row[];
  /** `fileStart[i]` is the row index of file i's header. */
  fileStart: readonly number[];
  offsets: Float64Array;
  scrollTop: number;
  /** Where the last jump landed; honoured only while `scrollTop` is still where it left the view. */
  landed: { key: string; top: number } | undefined;
}

export type ChangeTarget =
  /** Scroll to this row. */
  | { kind: 'row'; key: string; path: string }
  /** The change cannot be placed until this file has loaded. */
  | { kind: 'load'; path: string };

const isChangeRow = (row: Row): boolean => {
  if (row.type === 'line') return row.kind !== 'ctx';
  if (row.type === 'split') {
    return (
      (row.left !== undefined && row.left.kind !== 'ctx') ||
      (row.right !== undefined && row.right.kind !== 'ctx')
    );
  }
  return false;
};

/** Row indexes where a change starts in the file whose rows are `[start, end)`. */
export function changeStops(rows: readonly Row[], start: number, end: number): number[] {
  const stops: number[] = [];
  let inside = false;
  for (let i = start; i < end; i++) {
    const row = rows[i];
    const change = row !== undefined && isChangeRow(row);
    if (change && !inside) stops.push(i);
    inside = change;
  }
  return stops.length > 0 ? stops : [start];
}

/** The scroll offset a jump to `row` goes to: context above a change, nothing above a header. */
export function jumpTop(view: NavView, row: number): number {
  const header = view.fileStart[fileIndexOfRow(view.fileStart, row)] ?? 0;
  const at = view.offsets[row] ?? 0;
  if (row === header) return at;
  return Math.max(at - NAV_CONTEXT_PX, view.offsets[header] ?? 0);
}

/**
 * The row the view stands on: where the last jump landed while the view has not
 * moved since (`landed`), else the row at the top of the view.
 */
function position(view: NavView): { row: number; landed: boolean } {
  const { landed, scrollTop, rows } = view;
  if (landed && Math.abs(scrollTop - landed.top) < 2) {
    const index = rows.findIndex((row) => row.key === landed.key);
    if (index >= 0) return { row: index, landed: true };
  }
  return { row: Math.max(0, firstVisibleRow(view.offsets, scrollTop)), landed: false };
}

const endOfFile = (view: NavView, file: number): number =>
  view.fileStart[file + 1] ?? view.rows.length;

/** A file that is not in yet: its rows hold a placeholder. */
const isUnloaded = (view: NavView, file: number): boolean => {
  const end = endOfFile(view, file);
  for (let i = view.fileStart[file] ?? 0; i < end; i++) {
    if (view.rows[i]?.type === 'placeholder') return true;
  }
  return false;
};

/**
 * The change `dir` steps from the view, or null when there is none. A file that
 * is not loaded cannot say where its changes are, so the answer is to load it,
 * unless `needsLoad` says it has none to show (the pane knows what the status
 * lists: a binary file, a mode change) and its header stands for it.
 */
export function findChange(
  view: NavView,
  dir: 1 | -1,
  needsLoad: (path: string) => boolean,
): ChangeTarget | null {
  const { rows, fileStart } = view;
  if (fileStart.length === 0) return null;
  const here = position(view);
  const fileHere = fileIndexOfRow(fileStart, here.row);
  const keyOf = (index: number): ChangeTarget | null => {
    const row = rows[index];
    return row ? { kind: 'row', key: row.key, path: row.path } : null;
  };

  // The rest of this file: the changes past the position, or before it.
  const inFile = changeStops(rows, fileStart[fileHere] ?? 0, endOfFile(view, fileHere));
  const top = view.scrollTop;
  const ahead = (stop: number): boolean =>
    here.landed ? stop > here.row : jumpTop(view, stop) > top + 1;
  const behind = (stop: number): boolean =>
    here.landed ? stop < here.row : jumpTop(view, stop) < top - 1;
  const near = dir === 1 ? inFile.find(ahead) : inFile.findLast(behind);
  if (near !== undefined) return keyOf(near);

  for (let file = fileHere + dir; file >= 0 && file < fileStart.length; file += dir) {
    const first = rows[fileStart[file] ?? 0];
    if (!first) return null;
    if (isUnloaded(view, file) && needsLoad(first.path)) return { kind: 'load', path: first.path };
    const stops = changeStops(rows, fileStart[file] ?? 0, endOfFile(view, file));
    const stop = dir === 1 ? stops[0] : stops[stops.length - 1];
    if (stop !== undefined) return keyOf(stop);
  }
  return null;
}

/**
 * The file `dir` steps to, as an index into `fileStart`, or null at either end.
 * Stepping back from inside a file goes to its own start first, like a media
 * player's previous: from the start of a file it goes to the file before.
 */
export function findFile(view: NavView, dir: 1 | -1): number | null {
  const { fileStart } = view;
  if (fileStart.length === 0) return null;
  const file = fileIndexOfRow(fileStart, position(view).row);
  if (dir === 1) return file + 1 < fileStart.length ? file + 1 : null;
  const headerTop = view.offsets[fileStart[file] ?? 0] ?? 0;
  if (view.scrollTop > headerTop + 1) return file;
  return file > 0 ? file - 1 : null;
}

/** The file the view stands in, as an index into `fileStart`, or null in an empty review. */
export function findCurrentFile(view: NavView): number | null {
  if (view.fileStart.length === 0) return null;
  return fileIndexOfRow(view.fileStart, position(view).row);
}
