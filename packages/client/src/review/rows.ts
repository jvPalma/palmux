// ── The rows model: one file of a review as a flat list of rows ───────────────
//
// The review is one virtualized list (D6), so everything it draws is a row with a
// `type`. This module turns a file's status entry and, once fetched, its snapshot
// into those rows. Pure functions, no React: the pane caches the arrays per file,
// concatenates them and renders by index.
//
// Every row carries the file's `path` and a `key` that is unique across the whole
// list, which is what lets the pane map a visible row back to its file and
// recognise the same row after a rebuild.

import type { ScmComment, ScmEntry, ScmFileSnapshot, ScmHunk, ScmHunkLine } from '@palmux/shared';
import { splitLines } from './anchor';
import type { DraftTarget } from './comments-store';

export type RowsLayout = 'unified' | 'split';
export type DiffSide = 'old' | 'new';
export type LineKind = ScmHunkLine['kind'];

export type NoticeKind =
  | 'binary'
  | 'tooLarge'
  | 'converted'
  | 'unmerged'
  | 'rename'
  | 'mode'
  | 'symlink';

export type GapPosition = 'start' | 'between' | 'end';
export type GapDirection = 'up' | 'down' | 'all';

/** Unchanged lines one expansion step reveals. */
export const GAP_STEP = 20;
export const DEFAULT_LINE_HEIGHT = 20;
/**
 * A placeholder that failed to load draws its message and a Retry button, which is
 * taller than the one-line row a binary or mode-only file is estimated at, so it
 * holds at least this much. `--rv-error-h` in review.css is the same number.
 */
export const ERROR_ROW_HEIGHT = 40;

const PLACEHOLDER_CONTEXT_LINES = 6;
const PLACEHOLDER_UNKNOWN_LINES = 20;

/**
 * How much of one hidden gap is shown. `fromPrev` lines hang under the hunk above
 * the gap, `fromNext` lines sit over the hunk below it; the gap row stays between
 * them for as long as anything is left hidden.
 */
export interface GapReveal {
  fromPrev: number;
  fromNext: number;
}

/** Per gap, by `gapIndex` (0 = before the first hunk, `hunks.length` = after the last). */
export type GapReveals = Readonly<Record<number, GapReveal>>;

interface RowBase {
  /** Unique across the whole review list. */
  key: string;
  path: string;
}

export interface FileHeaderRow extends RowBase {
  type: 'fileHeader';
  oldPath: string | undefined;
  status: ScmEntry['status'];
  added: number | undefined;
  removed: number | undefined;
  binary: boolean;
  collapsed: boolean;
  /** The snapshot is in; false while the file is a placeholder. */
  loaded: boolean;
}

export interface NoticeRow extends RowBase {
  type: 'notice';
  notice: NoticeKind;
  text: string;
}

export interface PlaceholderRow extends RowBase {
  type: 'placeholder';
  /** Pixels: the measured height of the file when it was last shown, else an estimate. */
  height: number;
}

export interface HunkHeaderRow extends RowBase {
  type: 'hunkHeader';
  hunkIndex: number;
  /**
   * Git's hunk heading: the `@@ -a,b +c,d @@ context` line, or, from the server,
   * just the context after the second `@@` (empty when git found none).
   */
  header: string;
  /** The `@@ -a,b +c,d @@` part, built from the hunk's own numbers. */
  range: string;
}

export interface GapRow extends RowBase {
  type: 'gap';
  gapIndex: number;
  position: GapPosition;
  /** All unchanged lines in the gap, shown or not. */
  size: number;
  /** Still hidden. */
  hidden: number;
  /** Lines can be revealed above the hunk below the gap. */
  canUp: boolean;
  /** Lines can be revealed below the hunk above the gap. */
  canDown: boolean;
}

/** One side's cell of a line. `no` is the line number on `side`. */
export interface LineCell {
  kind: LineKind;
  side: DiffSide;
  no: number;
  text: string;
  noEol: boolean;
}

/** A unified row: one line. Unchanged lines take the new side. */
export interface LineRow extends RowBase, LineCell {
  type: 'line';
  old: number | undefined;
  new: number | undefined;
  /** The text of the line this one is paired with, for inner marks. */
  mate: string | undefined;
}

/** A split row: old on the left, new on the right; one side may be empty. */
export interface SplitRow extends RowBase {
  type: 'split';
  left: LineCell | undefined;
  right: LineCell | undefined;
  /** Both cells are changed lines, so inner marks apply between them. */
  paired: boolean;
}

/** A stored comment, drawn under the last line of its range. */
export interface CommentRow extends RowBase {
  type: 'comment';
  comment: ScmComment;
  /** The side of this review it was found on, which need not be the side it was made on. */
  side: DiffSide;
  start: number;
  end: number;
}

/** The editor of an unsaved comment, or of an edit to a stored one (`comment`). */
export interface EditorRow extends RowBase {
  type: 'editor';
  target: DraftTarget;
  comment: ScmComment | undefined;
  /**
   * An edit whose comment is gone (deleted in another window): its text is still
   * here, and it can be discarded or saved as a new comment.
   */
  orphaned?: boolean;
}

/** Where a comment drawn in the list is found in this review's text. */
export interface UnplacedAt {
  side: DiffSide;
  start: number;
  end: number;
}

/** A comment drawn in the list because it cannot be drawn on a line. */
export interface UnplacedItem {
  comment: ScmComment;
  /**
   * `outdated`: its code is no longer in the file. `hidden`: its lines sit in a gap
   * nobody expanded. `unread`: palmux never read the file (too large, converted).
   */
  reason: 'outdated' | 'hidden' | 'unread';
  /** For `hidden`: where the anchor found it now, which need not be where it was stored. */
  at?: UnplacedAt;
  /** Set while the comment is being edited. */
  draft: DraftTarget | undefined;
}

/** The comments of one file that have no line to hang from, at the end of the file. */
export interface UnplacedRow extends RowBase {
  type: 'unplaced';
  items: readonly UnplacedItem[];
}

export type Row =
  | FileHeaderRow
  | NoticeRow
  | PlaceholderRow
  | HunkHeaderRow
  | GapRow
  | LineRow
  | SplitRow
  | CommentRow
  | EditorRow
  | UnplacedRow;

export interface FileModel {
  entry: ScmEntry;
  snapshot?: ScmFileSnapshot | undefined;
}

export interface RowsOptions {
  layout: RowsLayout;
  collapsed?: boolean;
  reveals?: GapReveals;
  lineHeight?: number;
  /** Measured height to hold for a file that went back to a placeholder. */
  placeholderHeight?: number;
  /** The file's fetch failed: its placeholder has to hold the message and Retry. */
  failed?: boolean;
}

const hunkOldBegin = (h: ScmHunk): number => (h.oldLines === 0 ? h.oldStart + 1 : h.oldStart);
const hunkNewBegin = (h: ScmHunk): number => (h.newLines === 0 ? h.newStart + 1 : h.newStart);
const hunkOldEnd = (h: ScmHunk): number => hunkOldBegin(h) + h.oldLines;
const hunkNewEnd = (h: ScmHunk): number => hunkNewBegin(h) + h.newLines;

export function estimatePlaceholderHeight(
  entry: ScmEntry,
  lineHeight = DEFAULT_LINE_HEIGHT,
): number {
  if (entry.binary) return lineHeight;
  if (entry.added === undefined && entry.removed === undefined) {
    return (PLACEHOLDER_UNKNOWN_LINES + PLACEHOLDER_CONTEXT_LINES) * lineHeight;
  }
  const changed = (entry.added ?? 0) + (entry.removed ?? 0);
  // Nothing changed in the text: a mode change or a pure rename, one notice row.
  if (changed === 0) return lineHeight;
  return (changed + PLACEHOLDER_CONTEXT_LINES) * lineHeight;
}

function countChanges(snapshot: ScmFileSnapshot): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of snapshot.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') added++;
      else if (line.kind === 'del') removed++;
    }
  }
  return { added, removed };
}

function fileHeader(file: FileModel, collapsed: boolean): FileHeaderRow {
  const { entry, snapshot } = file;
  const counts = snapshot && entry.added === undefined ? countChanges(snapshot) : undefined;
  return {
    type: 'fileHeader',
    key: `${entry.path}|file`,
    path: entry.path,
    oldPath: entry.oldPath ?? snapshot?.oldPath,
    status: entry.status,
    added: entry.added ?? counts?.added,
    removed: entry.removed ?? counts?.removed,
    binary: snapshot?.binary ?? entry.binary ?? false,
    collapsed,
    loaded: snapshot !== undefined,
  };
}

function notice(path: string, kind: NoticeKind, text: string): NoticeRow {
  return { type: 'notice', key: `${path}|notice:${kind}`, path, notice: kind, text };
}

/** The one reason no lines are shown, if any. */
function blockingNotice(file: FileModel): NoticeRow | null {
  const { entry, snapshot } = file;
  const path = entry.path;
  if (entry.kind === 'unmerged' || snapshot?.unmerged) {
    return notice(path, 'unmerged', 'This file has conflicts. Resolve them in your editor.');
  }
  if (snapshot?.converted) {
    return notice(path, 'converted', 'This file is converted by git and cannot be shown here.');
  }
  if (snapshot?.binary) return notice(path, 'binary', 'Binary file not shown.');
  if (snapshot?.tooLarge) return notice(path, 'tooLarge', 'File too large to show.');
  return null;
}

function symlinkText(snapshot: ScmFileSnapshot): string | null {
  const oldLink = snapshot.symlink?.old === true;
  const newLink = snapshot.symlink?.new === true;
  if (!oldLink && !newLink) return null;
  if (oldLink && newLink) return 'Symbolic link.';
  if (newLink) return snapshot.old.id === 'absent' ? 'Symbolic link.' : 'Became a symbolic link.';
  return snapshot.new.id === 'absent' ? 'Symbolic link.' : 'No longer a symbolic link.';
}

/** Rename, symlink and mode notices: they sit above the lines rather than replace them. */
function detailNotices(file: FileModel, snapshot: ScmFileSnapshot): NoticeRow[] {
  const { entry } = file;
  const rows: NoticeRow[] = [];
  const from = entry.oldPath ?? snapshot.oldPath;
  if (from !== undefined && from !== entry.path) {
    rows.push(notice(entry.path, 'rename', `Renamed from ${from}`));
  }
  const link = symlinkText(snapshot);
  if (link) rows.push(notice(entry.path, 'symlink', link));
  const { old: oldMode, new: newMode } = snapshot.modes;
  const sameKind = (snapshot.symlink?.old === true) === (snapshot.symlink?.new === true);
  if (oldMode !== undefined && newMode !== undefined && oldMode !== newMode && sameKind) {
    rows.push(notice(entry.path, 'mode', `Mode changed from ${oldMode} to ${newMode}`));
  }
  return rows;
}

interface Numbered {
  line: ScmHunkLine;
  old: number;
  new: number;
}

/** Each line with its old and new number, from git's where it gave them. */
function numberLines(hunk: ScmHunk): Numbered[] {
  let nextOld = hunkOldBegin(hunk);
  let nextNew = hunkNewBegin(hunk);
  return hunk.lines.map((line) => {
    const old = line.old ?? nextOld;
    const now = line.new ?? nextNew;
    if (line.kind !== 'add') nextOld = old + 1;
    if (line.kind !== 'del') nextNew = now + 1;
    return { line, old, new: now };
  });
}

function cellOf(item: Numbered, side: DiffSide): LineCell {
  return {
    kind: item.line.kind,
    side,
    no: side === 'old' ? item.old : item.new,
    text: item.line.text,
    noEol: item.line.noEol === true,
  };
}

/** Each change block pairs its i-th deletion with its i-th addition; the rest stay alone. */
function pairMates(items: readonly Numbered[]): (string | undefined)[] {
  const mates = Array.from({ length: items.length }, (): string | undefined => undefined);
  let i = 0;
  while (i < items.length) {
    if (items[i]?.line.kind === 'ctx') {
      i++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (i < items.length && items[i]?.line.kind !== 'ctx') {
      (items[i]?.line.kind === 'del' ? dels : adds).push(i);
      i++;
    }
    const pairs = Math.min(dels.length, adds.length);
    for (let p = 0; p < pairs; p++) {
      const del = dels[p] ?? 0;
      const add = adds[p] ?? 0;
      mates[del] = items[add]?.line.text;
      mates[add] = items[del]?.line.text;
    }
  }
  return mates;
}

function unifiedRows(path: string, hunkIndex: number, items: readonly Numbered[]): LineRow[] {
  const mates = pairMates(items);
  return items.map((item, index) => {
    const side: DiffSide = item.line.kind === 'del' ? 'old' : 'new';
    return {
      type: 'line',
      key: `${path}|${hunkIndex}:${index}`,
      path,
      ...cellOf(item, side),
      old: item.line.kind === 'add' ? undefined : item.old,
      new: item.line.kind === 'del' ? undefined : item.new,
      mate: mates[index],
    };
  });
}

function splitRows(path: string, hunkIndex: number, items: readonly Numbered[]): SplitRow[] {
  const rows: SplitRow[] = [];
  const push = (left: LineCell | undefined, right: LineCell | undefined, paired: boolean): void => {
    rows.push({
      type: 'split',
      key: `${path}|${hunkIndex}:${rows.length}`,
      path,
      left,
      right,
      paired,
    });
  };
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    if (!item) break;
    if (item.line.kind === 'ctx') {
      push(cellOf(item, 'old'), cellOf(item, 'new'), false);
      i++;
      continue;
    }
    const dels: Numbered[] = [];
    const adds: Numbered[] = [];
    while (i < items.length) {
      const next = items[i];
      if (!next || next.line.kind === 'ctx') break;
      (next.line.kind === 'del' ? dels : adds).push(next);
      i++;
    }
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const del = dels[k];
      const add = adds[k];
      push(
        del && cellOf(del, 'old'),
        add && cellOf(add, 'new'),
        del !== undefined && add !== undefined,
      );
    }
  }
  return rows;
}

interface GapPlan {
  index: number;
  position: GapPosition;
  size: number;
  /** Old and new number of the gap's first line. */
  oldStart: number;
  newStart: number;
  /** Lines shown under the hunk above, and over the hunk below. */
  prev: number;
  next: number;
}

function planGap(
  hunks: readonly ScmHunk[],
  index: number,
  newTotal: number,
  reveals: GapReveals | undefined,
): GapPlan | null {
  const above = hunks[index - 1];
  const below = hunks[index];
  const oldStart = above ? hunkOldEnd(above) : 1;
  const newStart = above ? hunkNewEnd(above) : 1;
  const newStop = below ? hunkNewBegin(below) : newTotal + 1;
  const size = Math.max(0, newStop - newStart);
  if (size === 0) return null;
  const position: GapPosition = !above ? 'start' : !below ? 'end' : 'between';
  const asked = reveals?.[index];
  const prev = position === 'start' ? 0 : Math.min(asked?.fromPrev ?? 0, size);
  const next = position === 'end' ? 0 : Math.min(asked?.fromNext ?? 0, size - prev);
  return { index, position, size, oldStart, newStart, prev, next };
}

/**
 * Reveal more of a gap. `up` grows the hunk below the gap upward, `down` grows the
 * hunk above it downward, `all` shows everything; a direction a gap has no hunk
 * for (`up` on the trailing gap) changes nothing.
 */
export function expandGap(
  reveals: GapReveals,
  gap: Pick<GapRow, 'gapIndex' | 'position' | 'size'>,
  direction: GapDirection,
  step = GAP_STEP,
): GapReveals {
  const current = reveals[gap.gapIndex] ?? { fromPrev: 0, fromNext: 0 };
  let { fromPrev, fromNext } = current;
  if (direction === 'up') {
    if (gap.position === 'end') return reveals;
    fromNext += step;
  } else if (direction === 'down') {
    if (gap.position === 'start') return reveals;
    fromPrev += step;
  } else if (gap.position === 'start') {
    fromNext = gap.size;
  } else {
    fromPrev = gap.size;
    fromNext = 0;
  }
  fromPrev = Math.min(fromPrev, gap.size);
  fromNext = Math.min(fromNext, gap.size - fromPrev);
  return { ...reveals, [gap.gapIndex]: { fromPrev, fromNext } };
}

interface Sides {
  newLines: readonly string[];
  /** The last line has no newline, so a revealed last line must say so. */
  lastNoEol: boolean;
}

function revealedRows(
  path: string,
  plan: GapPlan,
  from: number,
  count: number,
  layout: RowsLayout,
  sides: Sides,
): Row[] {
  const rows: Row[] = [];
  for (let k = from; k < from + count; k++) {
    const oldNo = plan.oldStart + k;
    const newNo = plan.newStart + k;
    const text = sides.newLines[newNo - 1] ?? '';
    const noEol = sides.lastNoEol && newNo === sides.newLines.length;
    const key = `${path}|c${newNo}`;
    if (layout === 'unified') {
      rows.push({
        type: 'line',
        key,
        path,
        kind: 'ctx',
        side: 'new',
        no: newNo,
        text,
        noEol,
        old: oldNo,
        new: newNo,
        mate: undefined,
      });
    } else {
      rows.push({
        type: 'split',
        key,
        path,
        left: { kind: 'ctx', side: 'old', no: oldNo, text, noEol },
        right: { kind: 'ctx', side: 'new', no: newNo, text, noEol },
        paired: false,
      });
    }
  }
  return rows;
}

function gapRow(path: string, plan: GapPlan): GapRow | null {
  const hidden = plan.size - plan.prev - plan.next;
  if (hidden <= 0) return null;
  return {
    type: 'gap',
    key: `${path}|gap:${plan.index}`,
    path,
    gapIndex: plan.index,
    position: plan.position,
    size: plan.size,
    hidden,
    canUp: plan.position !== 'end',
    canDown: plan.position !== 'start',
  };
}

function hunkBodyRows(snapshot: ScmFileSnapshot, path: string, options: RowsOptions): Row[] {
  const { hunks } = snapshot;
  if (hunks.length === 0) return [];
  const newLines = splitLines(snapshot.new.text);
  const sides: Sides = {
    newLines,
    lastNoEol: snapshot.new.text !== '' && !snapshot.new.text.endsWith('\n'),
  };
  const rows: Row[] = [];
  hunks.forEach((hunk, hunkIndex) => {
    const plan = planGap(hunks, hunkIndex, newLines.length, options.reveals);
    if (plan) {
      rows.push(...revealedRows(path, plan, 0, plan.prev, options.layout, sides));
      const gap = gapRow(path, plan);
      if (gap) rows.push(gap);
    }
    rows.push({
      type: 'hunkHeader',
      key: `${path}|hunk:${hunkIndex}`,
      path,
      hunkIndex,
      header: hunk.header,
      range: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    });
    if (plan) {
      rows.push(
        ...revealedRows(path, plan, plan.size - plan.next, plan.next, options.layout, sides),
      );
    }
    const items = numberLines(hunk);
    rows.push(
      ...(options.layout === 'unified'
        ? unifiedRows(path, hunkIndex, items)
        : splitRows(path, hunkIndex, items)),
    );
  });
  const tail = planGap(hunks, hunks.length, newLines.length, options.reveals);
  if (tail) {
    rows.push(...revealedRows(path, tail, 0, tail.prev, options.layout, sides));
    const gap = gapRow(path, tail);
    if (gap) rows.push(gap);
  }
  return rows;
}

/**
 * The rows of one file: its header, then (unless collapsed) a placeholder while the
 * snapshot is not in, or its notices, gaps, hunks and lines.
 */
export function buildFileRows(file: FileModel, options: RowsOptions): Row[] {
  const { entry, snapshot } = file;
  const rows: Row[] = [fileHeader(file, options.collapsed === true)];
  if (options.collapsed === true) return rows;

  if (!snapshot) {
    // A conflicted file is never fetched (no stage-0 blob), so its notice is final.
    const blocking = entry.kind === 'unmerged' ? blockingNotice(file) : null;
    if (blocking) {
      rows.push(blocking);
    } else {
      const height =
        options.placeholderHeight ??
        estimatePlaceholderHeight(entry, options.lineHeight ?? DEFAULT_LINE_HEIGHT);
      rows.push({
        type: 'placeholder',
        key: `${entry.path}|placeholder`,
        path: entry.path,
        height: options.failed === true ? Math.max(height, ERROR_ROW_HEIGHT) : height,
      });
    }
    return rows;
  }

  const blocking = blockingNotice(file);
  if (blocking) rows.push(blocking);
  rows.push(...detailNotices(file, snapshot));
  if (!blocking) rows.push(...hunkBodyRows(snapshot, entry.path, options));
  return rows;
}

/** The side, number and text a row stands for, or null for a row that is not a line. */
export function rowLine(row: Row): { side: DiffSide; no: number; text: string } | null {
  if (row.type === 'line') return { side: row.side, no: row.no, text: row.text };
  if (row.type === 'split') {
    const cell = row.right ?? row.left;
    return cell ? { side: cell.side, no: cell.no, text: cell.text } : null;
  }
  return null;
}
