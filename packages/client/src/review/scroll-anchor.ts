// ── Scroll anchoring: keep the same code under the reader's eye ────────────────
//
// A review rebuilds while it is read: a file loads above the viewport, an edit on
// disk replaces a snapshot, the layout switches. Row INDICES mean nothing across a
// rebuild, so the pane records what the first visible row stands for (a file, a
// side and a line number, and how far from the top of the view it sat) and finds
// that again afterwards. When the file's text changed, the line is found by its
// text and context with the same function that anchors a comment (`anchor.ts`),
// not by its number: ten lines inserted above must leave the same code in view.
//
// Pure functions over the assembled rows and their offsets; the pane applies the
// result to the scroller.

import type { ScmFileSnapshot } from '@palmux/shared';
import { relocateLine } from './anchor';
import { firstVisibleRow } from './review-metrics';
import { rowLine, type DiffSide, type Row } from './rows';

export type ScrollAnchor =
  | {
      kind: 'line';
      path: string;
      side: DiffSide;
      no: number;
      /** The line row's top minus the scroll offset: how far into the view it sat. */
      offset: number;
    }
  | {
      kind: 'row';
      /** A row that is not a line: a header, a notice. */
      key: string;
      path: string;
      offset: number;
    };

export interface AnchorLayout {
  rows: readonly Row[];
  offsets: Float64Array;
  /** `fileStart[i]` is the row index of file i's header. */
  fileStart: readonly number[];
}

/** How far below the top row the search for a line to anchor on goes (headers and gaps come first). */
const SCAN_ROWS = 12;

const headerKey = (path: string): string => `${path}|file`;

export function fileIndexOfRow(fileStart: readonly number[], row: number): number {
  let low = 0;
  let high = fileStart.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((fileStart[mid] ?? 0) <= row) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** The anchor for the view at `scrollTop`, or null for an empty list. */
export function captureAnchor(layout: AnchorLayout, scrollTop: number): ScrollAnchor | null {
  const { rows, offsets, fileStart } = layout;
  const top = firstVisibleRow(offsets, scrollTop);
  const first = rows[top];
  if (!first) return null;

  // A placeholder is about to be replaced by rows: hold its file's header instead,
  // which stays, so the view opens onto the first lines of what loaded.
  if (first.type === 'placeholder') {
    const header = fileStart[fileIndexOfRow(fileStart, top)];
    const headerRow = header === undefined ? undefined : rows[header];
    if (header !== undefined && headerRow) {
      return {
        kind: 'row',
        key: headerRow.key,
        path: first.path,
        offset: (offsets[header] ?? 0) - scrollTop,
      };
    }
  }

  const file = fileIndexOfRow(fileStart, top);
  const end = fileStart[file + 1] ?? rows.length;
  for (let i = top; i < end && i < top + SCAN_ROWS; i++) {
    const row = rows[i];
    const line = row ? rowLine(row) : null;
    if (row && line) {
      return {
        kind: 'line',
        path: row.path,
        side: line.side,
        no: line.no,
        offset: (offsets[i] ?? 0) - scrollTop,
      };
    }
  }
  return { kind: 'row', key: first.key, path: first.path, offset: (offsets[top] ?? 0) - scrollTop };
}

function cellMatches(row: Row, side: DiffSide, no: number): boolean {
  if (row.type === 'line') return row.side === side && row.no === no;
  if (row.type === 'split') {
    return (
      (row.left?.side === side && row.left.no === no) ||
      (row.right?.side === side && row.right.no === no)
    );
  }
  return false;
}

/** The row an anchor stands for now, or null when its file is gone. */
export function locateAnchor(layout: AnchorLayout, anchor: ScrollAnchor): number | null {
  const { rows, fileStart } = layout;
  const headerIndex = fileStart.findIndex((start) => rows[start]?.path === anchor.path);
  if (headerIndex < 0) return null;
  const start = fileStart[headerIndex] ?? 0;
  const end = fileStart[headerIndex + 1] ?? rows.length;

  if (anchor.kind === 'row') {
    for (let i = start; i < end; i++) if (rows[i]?.key === anchor.key) return i;
    return start;
  }

  let nearest: { index: number; distance: number } | undefined;
  for (let i = start; i < end; i++) {
    const row = rows[i];
    if (!row) continue;
    if (cellMatches(row, anchor.side, anchor.no)) return i;
    // The line itself may sit in a gap now: settle for the closest line on its side.
    const line = rowLine(row);
    if (line?.side === anchor.side) {
      const distance = Math.abs(line.no - anchor.no);
      if (!nearest || distance < nearest.distance) nearest = { index: i, distance };
    }
  }
  return nearest?.index ?? start;
}

/** The scroll offset that puts the anchor back where it was, or null when it cannot be found. */
export function restoredScrollTop(layout: AnchorLayout, anchor: ScrollAnchor): number | null {
  const index = locateAnchor(layout, anchor);
  if (index === null) return null;
  return Math.max(0, (layout.offsets[index] ?? 0) - anchor.offset);
}

/** The hunk of `snapshot` holding line `no` of `side`, as the bounds `relocateLine` searches within. */
function hunkBounds(
  snapshot: ScmFileSnapshot,
  side: DiffSide,
  no: number,
): { from: number; to: number } | undefined {
  for (const hunk of snapshot.hunks) {
    const lines = side === 'old' ? hunk.oldLines : hunk.newLines;
    const begin = side === 'old' ? hunk.oldStart : hunk.newStart;
    const from = lines === 0 ? begin + 1 : begin;
    if (lines > 0 && no >= from && no < from + lines) return { from, to: from + lines - 1 };
  }
  return undefined;
}

/**
 * The anchor after `previous` was replaced by `next`. A line anchor follows its
 * text; when neither the line nor a neighbour of its hunk survived, the file's
 * header stands in for it.
 */
export function relocateAnchor(
  anchor: ScrollAnchor,
  previous: ScmFileSnapshot,
  next: ScmFileSnapshot,
): ScrollAnchor {
  if (anchor.kind !== 'line' || anchor.path !== next.path) return anchor;
  const within = hunkBounds(previous, anchor.side, anchor.no);
  const found = relocateLine(
    previous[anchor.side].text,
    next[anchor.side].text,
    anchor.no,
    within ? { within } : {},
  );
  if (found) return { ...anchor, no: found.line };
  return { kind: 'row', key: headerKey(anchor.path), path: anchor.path, offset: anchor.offset };
}
