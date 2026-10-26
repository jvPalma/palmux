// ── Row heights ────────────────────────────────────────────────────────────────
//
// The review list gives react-window an exact height for every row instead of
// letting it measure and average them. Measured-by-index heights go stale the
// moment a rebuild shifts the rows (a file loads above the viewport, a gap
// opens), and a placeholder of several thousand pixels would skew the average
// every unmeasured row falls back to. So a height is derived from the row itself:
// fixed for every row whose height is known, an estimate for a row that wraps
// until it has been measured, and then the measured height, keyed by the row's own
// stable `key` and not by its position.
//
// `review.css` declares the same fixed heights as custom properties (`--rv-*-h`),
// each written from the `--sp-*` scale (so none can be off it), and
// `review-css.test.ts` resolves them and holds the two together, because a row
// that is drawn taller than it was sized overlaps the next one and no type error
// says so.
//
// One height is not fixed: a LINE is as tall as the device's code font size asks
// (`codeLineHeight`). The pane writes that height and the size itself to the frame
// (`--rv-code-fs`, `--rv-code-lh`), so the CSS and this file are given one number
// and cannot disagree, and `ROW_METRICS.line` is what it comes to at the default size.
//
// A phone has a second table, `COMPACT_ROW_METRICS` (a file header, a gap and a hunk
// header are shorter, lines are not), chosen by `HeightContext.compact`. The sheet
// restates it under `.rv-frame[data-dense='true']`, and `review-css.test.ts` holds that
// block to this table the way it holds the first.

import { visualLength } from './line-html';
import { ERROR_ROW_HEIGHT, type Row, type RowsLayout } from './rows';

export const ROW_METRICS = {
  line: 20,
  header: 40,
  notice: 28,
  gap: 32,
  hunk: 24,
  error: ERROR_ROW_HEIGHT,
} as const;

export type RowMetrics = Record<keyof typeof ROW_METRICS, number>;

/**
 * The same rows on a phone, where height is the scarce thing: a gap (its text and three
 * small controls) is 28px and a hunk header one code line, 20px, where they were 32px and
 * 24px, and a file header is 36px, the kit's small button (32px under the mobile class)
 * and a pixel either side. A line is what it always was, so the code keeps its size and
 * the rows between code lines are what gives way. Everything not listed is unchanged.
 */
export const COMPACT_ROW_METRICS: RowMetrics = {
  ...ROW_METRICS,
  header: 36,
  gap: 28,
  hunk: 20,
};

/**
 * Comment rows wrap and are measured, so these only size a row until the browser
 * has: the chrome around a card's text (its header line and padding), a whole
 * editor, and how many lines of quoted code a list entry shows at most.
 */
const COMMENT_CHROME_PX = 36;
const EDITOR_PX = 132;
export const QUOTE_MAX_LINES = 8;

/**
 * The size the review draws its code at while the device has no code font size:
 * `--fs-2`, which is what it has always used. It does not follow the terminal, so
 * neither does this: a review that moved with the terminal the day the code size
 * arrived would be a jump nobody asked for.
 */
export const DEFAULT_CODE_FONT_PX = 12;

/** The code face's advance as a share of its size, for estimating how many rows a wrapped line takes. */
const CODE_ADVANCE_EM = 0.6;

/** How tall a line of code is at a font size: `ROW_METRICS.line` at the default, in proportion beside it. */
export const codeLineHeight = (fontPx: number): number =>
  Math.round((fontPx * ROW_METRICS.line) / DEFAULT_CODE_FONT_PX);

/** The advance of the code face, 7.2px at the default 12px. */
export const codeCharWidth = (fontPx: number): number => fontPx * CODE_ADVANCE_EM;

/** Columns the gutter takes: one line number plus the sign, per cell. */
const CELL_GUTTER_COLS = 7;
const MIN_TEXT_COLS = 8;

export interface HeightContext {
  /** Unified lines wrap (split always does). */
  wrap: boolean;
  layout: RowsLayout;
  /** The pane's width, for estimating a wrapped line before it is measured; 0 when unknown. */
  width: number;
  /** The code font size in px: what a line's height and a wrapped line's width follow. */
  codeFontPx: number;
  /** A phone: the structural rows (header, gap, hunk) are the compact table's. Absent is false. */
  compact?: boolean | undefined;
  /** Measured heights by row key. */
  measured: ReadonlyMap<string, number>;
}

/** A row whose height only the browser knows: it wraps. */
export function isMeasuredRow(row: Row, wrap: boolean, layout: RowsLayout): boolean {
  if (
    row.type === 'notice' ||
    row.type === 'comment' ||
    row.type === 'editor' ||
    row.type === 'unplaced'
  ) {
    return true;
  }
  return (row.type === 'line' || row.type === 'split') && (wrap || layout === 'split');
}

const textLines = (text: string): number => Math.max(1, text.split('\n').length);

function textColumns(width: number, layout: RowsLayout, codeFontPx: number): number {
  if (width <= 0) return Number.POSITIVE_INFINITY;
  const cell = layout === 'split' ? width / 2 : width;
  return Math.max(MIN_TEXT_COLS, Math.floor(cell / codeCharWidth(codeFontPx)) - CELL_GUTTER_COLS);
}

const linesFor = (text: string, columns: number): number =>
  Math.max(1, Math.ceil(visualLength(text) / columns));

export function estimateRowHeight(row: Row, ctx: HeightContext): number {
  const metrics = ctx.compact ? COMPACT_ROW_METRICS : ROW_METRICS;
  switch (row.type) {
    case 'fileHeader':
      return metrics.header;
    case 'placeholder':
      return row.height;
    case 'notice':
      return metrics.notice;
    case 'gap':
      return metrics.gap;
    case 'hunkHeader':
      return metrics.hunk;
    case 'comment':
      return COMMENT_CHROME_PX + ROW_METRICS.line * textLines(row.comment.body);
    case 'editor':
      return EDITOR_PX;
    case 'unplaced':
      return row.items.reduce(
        (total, item) =>
          total +
          COMMENT_CHROME_PX +
          ROW_METRICS.line *
            (Math.min(item.comment.lines.length, QUOTE_MAX_LINES) + textLines(item.comment.body)),
        0,
      );
    case 'line': {
      const lineHeight = codeLineHeight(ctx.codeFontPx);
      if (!ctx.wrap) return lineHeight;
      return lineHeight * linesFor(row.text, textColumns(ctx.width, 'unified', ctx.codeFontPx));
    }
    case 'split': {
      const columns = textColumns(ctx.width, 'split', ctx.codeFontPx);
      const most = Math.max(
        row.left ? linesFor(row.left.text, columns) : 1,
        row.right ? linesFor(row.right.text, columns) : 1,
      );
      return codeLineHeight(ctx.codeFontPx) * most;
    }
  }
}

/** The row's height: what the browser measured, else the estimate. */
export function rowHeightOf(row: Row, ctx: HeightContext): number {
  if (isMeasuredRow(row, ctx.wrap, ctx.layout)) {
    const measured = ctx.measured.get(row.key);
    if (measured !== undefined) return measured;
  }
  return estimateRowHeight(row, ctx);
}

export interface RowGeometry {
  /** `sizes[i]` is row i's height. */
  sizes: Float64Array;
  /** `offsets[i]` is row i's top; `offsets[rows.length]` is the list's height. */
  offsets: Float64Array;
}

export function computeGeometry(rows: readonly Row[], ctx: HeightContext): RowGeometry {
  const sizes = new Float64Array(rows.length);
  const offsets = new Float64Array(rows.length + 1);
  let top = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const size = row ? rowHeightOf(row, ctx) : ROW_METRICS.line;
    sizes[i] = size;
    offsets[i] = top;
    top += size;
  }
  offsets[rows.length] = top;
  return { sizes, offsets };
}

/** The pixel height of a run of rows (a file's), by the same rule the list uses. */
export function heightOfRows(rows: readonly Row[], ctx: HeightContext): number {
  let total = 0;
  for (const row of rows) total += rowHeightOf(row, ctx);
  return total;
}

/** The first row whose bottom is below `scrollTop`: the one at the top of the view. */
export function firstVisibleRow(offsets: Float64Array, scrollTop: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return -1;
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((offsets[mid + 1] ?? 0) > scrollTop) high = mid;
    else low = mid + 1;
  }
  return low;
}
