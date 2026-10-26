// ── One row of the review list ─────────────────────────────────────────────────
//
// react-window hands every row an absolutely positioned `style` that must land on
// the row's root, and a row that wraps must not fix its height: the root takes
// `height: auto` and the pane measures what the browser laid out. Everything a row
// does (collapse, expand a gap, open the file) goes back to the pane through
// props; rows are in a scroller, so every control here is `pressMove`, which acts
// on release inside the slop and never on the touch that starts a pan.

import {
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { ScmEntry, ScmGroup } from '@palmux/shared';
import { pressMove } from '../panes/press';
import { Button, IconButton, type RowComponentProps } from '../ui';
import { Icon } from '../ui/icons';
import type { CommentActions } from './comment-actions';
import { CommentCard } from './CommentCard';
import { CommentEditor } from './CommentEditor';
import { draftKey } from './comments-store';
import { innerDiff, type TextRange } from './inner-diff';
import {
  displayText,
  expandTabs,
  markColored,
  normalizeColored,
  plainSegments,
  toVisualRanges,
} from './line-html';
import type { LineGestures, LineTarget } from './line-selection';
import { isMeasuredRow } from './review-metrics';
import type { LineMark, ReviewModel } from './review-model';
import {
  GAP_STEP,
  type DiffSide,
  type FileHeaderRow,
  type GapDirection,
  type GapRow,
  type HunkHeaderRow,
  type LineCell,
  type LineRow,
  type NoticeRow,
  type PlaceholderRow,
  type Row,
  type RowsLayout,
  type SplitRow,
} from './rows';

/** Reviewed (Changes) and Unstage (Staged) on a file header. */
export interface ReviewWrites {
  group: ScmGroup;
  /** Whether a file's button can be pressed now and, when it cannot, why. */
  stateOf: (path: string) => { blocker: string | null; busy: boolean };
  run: (path: string) => void;
}

export interface ReviewRowProps {
  rows: readonly Row[];
  model: ReviewModel;
  /** Changes when colours, errors or marks changed, so a memoised row draws them. */
  revision: number;
  repo: string;
  wrap: boolean;
  layout: RowsLayout;
  /** A phone: a gap's controls are drawn small enough for its shorter row. Absent is false. */
  compact?: boolean | undefined;
  writes: ReviewWrites;
  comments: CommentActions;
  /** Picking lines for a comment; null when the review cannot be written to. */
  lines: LineGestures | null;
  onToggle: (path: string) => void;
  onExpand: (path: string, gap: GapRow, direction: GapDirection) => void;
  onOpenFile: (path: string) => void;
  onRetry: (path: string) => void;
  /** Report a row's laid-out height; returns the way to stop. */
  observe: (element: HTMLElement) => () => void;
}

const STATUS_LABEL: Record<ScmEntry['status'], string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  T: 'Type changed',
  U: 'Conflicted',
  '?': 'Untracked',
};

const splitPath = (path: string): { dir: string; name: string } => {
  const cut = path.lastIndexOf('/');
  return cut < 0
    ? { dir: '', name: path }
    : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
};

/** The hunk heading as drawn: the range, then the context git found (if it sent only that). */
const hunkText = (row: HunkHeaderRow): string => {
  if (row.header.startsWith('@@')) return row.header;
  return row.header === '' ? row.range : `${row.range} ${row.header}`;
};

const SIGN: Record<LineCell['kind'], string> = { add: '+', del: '-', ctx: ' ' };

// ── A line of code ──────────────────────────────────────────────────────────

interface CodeProps {
  text: string;
  /** Source ranges of the changed characters, from the paired line. */
  marks: readonly TextRange[];
  /** Monaco's coloured markup for this line, once it has rendered. */
  html: string | undefined;
}

const Code = ({ text, marks, html }: CodeProps) => {
  const shown = displayText(text);
  const expanded = useMemo(() => expandTabs(shown), [shown]);
  const visual = useMemo(() => toVisualRanges(expanded.map, marks), [expanded, marks]);
  const colored = useMemo(
    () =>
      html === undefined ? undefined : markColored(normalizeColored(html), expanded.text, visual),
    [html, expanded, visual],
  );
  if (colored !== undefined) {
    // Monaco's own escaped output; `markColored` only wraps characters of it.
    return <span className="rv-code" dangerouslySetInnerHTML={{ __html: colored }} />;
  }
  return (
    <span className="rv-code">
      {plainSegments(expanded.text, visual).map((segment) =>
        segment.marked ? (
          <span key={segment.start} className="rv-mark">
            {segment.text}
          </span>
        ) : (
          segment.text
        ),
      )}
    </span>
  );
};

const NO_MARKS: readonly TextRange[] = [];

/** The inner marks of one side of a paired line. */
function marksFor(
  kind: LineCell['kind'],
  text: string,
  mate: string | undefined,
): readonly TextRange[] {
  if (mate === undefined || kind === 'ctx') return NO_MARKS;
  const mine = displayText(text);
  const theirs = displayText(mate);
  const diff = kind === 'del' ? innerDiff(mine, theirs) : innerDiff(theirs, mine);
  if (!diff) return NO_MARKS;
  return kind === 'del' ? diff.old : diff.new;
}

interface LineBodyProps {
  path: string;
  side: DiffSide;
  cell: LineCell;
  mate: string | undefined;
  model: ReviewModel;
}

const LineBody = ({ path, side, cell, mate, model }: LineBodyProps) => {
  const marks = useMemo(() => marksFor(cell.kind, cell.text, mate), [cell.kind, cell.text, mate]);
  const html = model.htmlOf(path, side, cell.no);
  return (
    <>
      <Code text={cell.text} marks={marks} html={html} />
      {cell.noEol && (
        <span className="rv-noeol" title="No newline at end of file">
          no newline
        </span>
      )}
    </>
  );
};

// ── Row kinds ───────────────────────────────────────────────────────────────

const ReviewButton = ({ path, writes }: { path: string; writes: ReviewWrites }) => {
  const { blocker, busy } = writes.stateOf(path);
  const staged = writes.group === 'staged';
  return (
    <Button
      size="sm"
      variant={staged ? 'ghost' : 'primary'}
      disabled={blocker !== null || busy}
      title={
        blocker ??
        (staged
          ? 'Take this file out of the staged changes'
          : 'Stage this file as you saw it, and go to the next')
      }
      data-reason={blocker ?? undefined}
      data-testid={staged ? 'review-file-unstage' : 'review-file-reviewed'}
      {...pressMove(() => writes.run(path))}
    >
      <Icon name={staged ? 'undo' : 'check'} size={14} />
      {staged ? 'Unstage' : 'Reviewed'}
    </Button>
  );
};

const FileHeader = ({
  row,
  repo,
  writes,
  onToggle,
  onOpenFile,
}: {
  row: FileHeaderRow;
  repo: string;
  writes: ReviewWrites;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
}) => {
  const { dir, name } = splitPath(row.path);
  const renamed = row.oldPath !== undefined && row.oldPath !== row.path;
  const label = STATUS_LABEL[row.status];
  return (
    <div className="rv-sticky rv-head-inner">
      <button
        type="button"
        className="rv-head-toggle"
        aria-expanded={!row.collapsed}
        aria-label={`${row.collapsed ? 'Expand' : 'Collapse'} ${row.path}`}
        data-testid="review-file-toggle"
        {...pressMove(() => onToggle(row.path))}
      >
        <Icon name={row.collapsed ? 'chevron-right' : 'chevron-down'} size={14} />
        <span className="rv-status" data-status={row.status} title={label}>
          {row.status === '?' ? 'U' : row.status}
        </span>
        <span className="rv-path" title={renamed ? `${row.oldPath} → ${row.path}` : row.path}>
          {renamed && (
            <span className="rv-path-old" data-testid="review-file-old">
              {row.oldPath} →{' '}
            </span>
          )}
          <span className="rv-path-dir">{dir}</span>
          <b className="rv-path-name">{name}</b>
        </span>
      </button>
      <span className="rv-state" data-testid="review-file-state">
        {label}
        {row.binary ? ' · binary' : ''}
      </span>
      {(row.added !== undefined || row.removed !== undefined) && (
        <span className="rv-counts" data-testid="review-file-counts">
          <span className="rv-count-add">+{row.added ?? 0}</span>
          <span className="rv-count-del">−{row.removed ?? 0}</span>
        </span>
      )}
      <ReviewButton path={row.path} writes={writes} />
      <IconButton
        label="Open file"
        size="sm"
        data-testid="review-file-open"
        disabled={row.status === 'D'}
        {...pressMove(() => onOpenFile(repo === '/' ? `/${row.path}` : `${repo}/${row.path}`))}
      >
        <Icon name="external" size={14} />
      </IconButton>
    </div>
  );
};

const Notice = ({
  row,
  repo,
  onOpenFile,
}: {
  row: NoticeRow;
  repo: string;
  onOpenFile: (path: string) => void;
}) => {
  return (
    <>
      <span className="rv-notice-text">{row.text}</span>
      {row.notice === 'unmerged' && (
        <Button
          size="sm"
          data-testid="review-notice-open"
          {...pressMove(() => onOpenFile(repo === '/' ? `/${row.path}` : `${repo}/${row.path}`))}
        >
          Open file
        </Button>
      )}
    </>
  );
};

/**
 * One of a gap's controls. The kit's small button is `--ctl-h` less a step (32px under
 * the mobile class), which does not fit the 28px row a phone gets, so there it is a plain
 * button on the row's own scale (`.rv-chip`) and the kit's button stays everywhere else.
 */
const GapControl = ({
  compact,
  row,
  direction,
  onExpand,
  testId,
  label,
  children,
}: {
  compact: boolean;
  row: GapRow;
  direction: GapDirection;
  onExpand: (path: string, gap: GapRow, direction: GapDirection) => void;
  testId: string;
  label?: string;
  children: ReactNode;
}) => {
  const props = {
    'data-testid': testId,
    ...(label === undefined ? {} : { 'aria-label': label }),
    ...pressMove(() => onExpand(row.path, row, direction)),
  };
  return compact ? (
    <button type="button" className="rv-chip" {...props}>
      {children}
    </button>
  ) : (
    <Button size="sm" {...props}>
      {children}
    </Button>
  );
};

const Gap = ({
  row,
  compact,
  onExpand,
}: {
  row: GapRow;
  compact: boolean;
  onExpand: (path: string, gap: GapRow, direction: GapDirection) => void;
}) => {
  const step = Math.min(GAP_STEP, row.hidden);
  const control = { compact, row, onExpand };
  return (
    <>
      <span className="rv-gap-text" data-testid="review-gap-hidden">
        {row.hidden} hidden {row.hidden === 1 ? 'line' : 'lines'}
      </span>
      {row.canUp && (
        <GapControl
          {...control}
          direction="up"
          testId="review-gap-up"
          label={`Show ${step} more lines above`}
        >
          <Icon name="arrow-up" size={12} />
          {step}
        </GapControl>
      )}
      {row.canDown && (
        <GapControl
          {...control}
          direction="down"
          testId="review-gap-down"
          label={`Show ${step} more lines below`}
        >
          <Icon name="arrow-down" size={12} />
          {step}
        </GapControl>
      )}
      <GapControl {...control} direction="all" testId="review-gap-all">
        Show all
      </GapControl>
    </>
  );
};

const Placeholder = ({
  row,
  error,
  onRetry,
}: {
  row: PlaceholderRow;
  error: string | undefined;
  onRetry: (path: string) => void;
}) => {
  if (error === undefined) return null;
  return (
    <span className="rv-error" role="alert">
      <Icon name="warning" size={12} />
      <span data-testid="review-placeholder-error">{error}</span>
      <Button size="sm" data-testid="review-retry" {...pressMove(() => onRetry(row.path))}>
        Retry
      </Button>
    </span>
  );
};

const isTouch = (e: { pointerType: string }): boolean =>
  e.pointerType === 'touch' || e.pointerType === 'pen';

/**
 * The gestures of one line number. A mouse picks on pointer DOWN (a drag has to
 * start somewhere) and a touch on a release inside the slop, through `pressMove`,
 * so a finger that arrived to scroll never picks a line. A keyboard reaches it too:
 * the number is a button in the tab order, Enter or Space picks it, and Shift extends
 * the range already picked. The key path is separate from the pointer one, which is
 * left as it was.
 */
function numberHandlers(target: LineTarget | undefined, lines: LineGestures | null) {
  if (!lines || !target) return {};
  const tap = pressMove(() => lines.tap(target));
  return {
    role: 'button' as const,
    tabIndex: 0,
    'aria-label': `Line ${target.no}, ${target.side} side`,
    onKeyDown: (e: ReactKeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      lines.pick(target, e.shiftKey);
    },
    onPointerDown: (e: ReactPointerEvent) => {
      if (isTouch(e)) {
        tap.onPointerDown(e);
        return;
      }
      if (e.button !== 0) return;
      e.preventDefault();
      lines.begin(target, e.shiftKey);
    },
    onPointerMove: (e: ReactPointerEvent) => {
      if (isTouch(e)) tap.onPointerMove(e);
    },
    onPointerUp: (e: ReactPointerEvent) => {
      if (isTouch(e)) tap.onPointerUp(e);
    },
    onPointerCancel: tap.onPointerCancel,
    onPointerLeave: (e: ReactPointerEvent) => {
      if (isTouch(e)) tap.onPointerLeave(e);
    },
    onPointerEnter: (e: ReactPointerEvent) => {
      if (!isTouch(e)) lines.enter(target);
    },
  };
}

const markClass = (mark: LineMark | undefined): string => (mark ? ` rv-${mark}` : '');

const UnifiedLine = ({
  row,
  model,
  lines,
}: {
  row: LineRow;
  model: ReviewModel;
  lines: LineGestures | null;
}) => {
  const old =
    row.old === undefined ? undefined : { path: row.path, side: 'old' as const, no: row.old };
  const now =
    row.new === undefined ? undefined : { path: row.path, side: 'new' as const, no: row.new };
  return (
    <>
      <span
        className={`rv-no${markClass(model.markOf(row.path, 'old', row.old))}`}
        data-testid="review-no-old"
        {...numberHandlers(old, lines)}
      >
        {row.old ?? ''}
      </span>
      <span
        className={`rv-no${markClass(model.markOf(row.path, 'new', row.new))}`}
        data-testid="review-no-new"
        {...numberHandlers(now, lines)}
      >
        {row.new ?? ''}
      </span>
      <span className="rv-sign" aria-hidden="true">
        {SIGN[row.kind]}
      </span>
      <LineBody path={row.path} side={row.side} cell={row} mate={row.mate} model={model} />
    </>
  );
};

const SplitCell = ({
  cell,
  mate,
  paired,
  position,
  path,
  model,
  lines,
}: {
  cell: LineCell | undefined;
  mate: string | undefined;
  paired: boolean;
  position: 'left' | 'right';
  path: string;
  model: ReviewModel;
  lines: LineGestures | null;
}) => {
  if (!cell) {
    return (
      <div className="rv-cell rv-empty" data-testid={`review-cell-${position}`} data-kind="empty" />
    );
  }
  return (
    <div
      className={`rv-cell rv-${cell.kind}${markClass(model.markOf(path, cell.side, cell.no))}`}
      data-testid={`review-cell-${position}`}
      data-kind={cell.kind}
    >
      <span
        className="rv-no"
        data-testid={`review-no-${position}`}
        {...numberHandlers({ path, side: cell.side, no: cell.no }, lines)}
      >
        {cell.no}
      </span>
      <span className="rv-sign" aria-hidden="true">
        {SIGN[cell.kind]}
      </span>
      <LineBody
        path={path}
        side={cell.side}
        cell={cell}
        mate={paired ? mate : undefined}
        model={model}
      />
    </div>
  );
};

const Split = ({
  row,
  model,
  lines,
}: {
  row: SplitRow;
  model: ReviewModel;
  lines: LineGestures | null;
}) => {
  return (
    <>
      <SplitCell
        cell={row.left}
        mate={row.right?.text}
        paired={row.paired}
        position="left"
        path={row.path}
        model={model}
        lines={lines}
      />
      <SplitCell
        cell={row.right}
        mate={row.left?.text}
        paired={row.paired}
        position="right"
        path={row.path}
        model={model}
        lines={lines}
      />
    </>
  );
};

// ── The row ─────────────────────────────────────────────────────────────────

const CLASS: Record<Row['type'], string> = {
  fileHeader: 'rv-head',
  notice: 'rv-notice',
  placeholder: 'rv-placeholder',
  hunkHeader: 'rv-hunk',
  gap: 'rv-gap',
  line: 'rv-line',
  split: 'rv-split',
  comment: 'rv-note',
  editor: 'rv-note',
  unplaced: 'rv-note',
};

const TESTID: Record<Row['type'], string> = {
  fileHeader: 'review-file',
  notice: 'review-notice',
  placeholder: 'review-placeholder',
  hunkHeader: 'review-hunk',
  gap: 'review-gap',
  line: 'review-line',
  split: 'review-split',
  comment: 'review-comment-row',
  editor: 'review-editor-row',
  unplaced: 'review-unplaced',
};

// react-window already memoises its row component, so this is not wrapped again.
export const ReviewRow = ({
  index,
  style,
  ariaAttributes,
  rows,
  model,
  repo,
  wrap,
  layout,
  compact = false,
  writes,
  comments,
  lines,
  onToggle,
  onExpand,
  onOpenFile,
  onRetry,
  observe,
}: RowComponentProps<ReviewRowProps>) => {
  const row = rows[index];
  const root = useRef<HTMLDivElement>(null);
  const measured = row !== undefined && isMeasuredRow(row, wrap, layout);
  useLayoutEffect(() => {
    const element = root.current;
    if (!measured || !element) return undefined;
    return observe(element);
  }, [measured, observe]);
  if (!row) return null;

  // A row that wraps lets its content set its height; the pane measures it.
  let rowStyle: CSSProperties = measured ? { ...style, height: 'auto' } : style;
  if (!wrap && layout === 'unified') {
    // Sideways scrolling: a line is as wide as its text, and every other row is as
    // wide as the scroller's content so its controls (inside `.rv-sticky`) have
    // room to stay at the left edge.
    rowStyle =
      row.type === 'line'
        ? { ...rowStyle, width: 'max-content', minWidth: '100%' }
        : { ...rowStyle, minWidth: 'var(--rv-scroll-w, 100%)' };
  }
  const kind = row.type === 'line' ? row.kind : row.type === 'notice' ? row.notice : undefined;
  // A unified line is one row for both its numbers, so either one picks or marks it.
  const mark =
    row.type === 'line'
      ? model.markOf(row.path, 'old', row.old) === 'selected' ||
        model.markOf(row.path, 'new', row.new) === 'selected'
        ? 'selected'
        : (model.markOf(row.path, 'old', row.old) ?? model.markOf(row.path, 'new', row.new))
      : undefined;
  return (
    <div
      ref={root}
      {...ariaAttributes}
      className={`rv-row ${CLASS[row.type]}${kind ? ` rv-${kind}` : ''}${markClass(mark)}${wrap ? ' rv-wrap' : ''}`}
      style={rowStyle}
      data-testid={TESTID[row.type]}
      data-rv-key={row.key}
      data-path={row.path}
      {...(row.type === 'line' ? { 'data-kind': row.kind } : {})}
      {...(row.type === 'notice' ? { 'data-notice': row.notice } : {})}
      {...(row.type === 'gap' ? { 'data-gap-index': row.gapIndex } : {})}
    >
      {row.type === 'fileHeader' && (
        <FileHeader
          row={row}
          repo={repo}
          writes={writes}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
        />
      )}
      {row.type === 'notice' && (
        <div className="rv-sticky">
          <Notice row={row} repo={repo} onOpenFile={onOpenFile} />
        </div>
      )}
      {row.type === 'placeholder' && (
        <div className="rv-sticky">
          <Placeholder row={row} error={model.errorOf(row.path)} onRetry={onRetry} />
        </div>
      )}
      {row.type === 'hunkHeader' && (
        <div className="rv-sticky">
          <span className="rv-hunk-text">{hunkText(row)}</span>
        </div>
      )}
      {row.type === 'gap' && (
        <div className="rv-sticky">
          <Gap row={row} compact={compact} onExpand={onExpand} />
        </div>
      )}
      {row.type === 'line' && <UnifiedLine row={row} model={model} lines={lines} />}
      {row.type === 'split' && <Split row={row} model={model} lines={lines} />}
      {row.type === 'comment' && (
        <div className="rv-sticky rv-note-body">
          <CommentCard
            comment={row.comment}
            side={row.side}
            start={row.start}
            end={row.end}
            actions={comments}
          />
        </div>
      )}
      {row.type === 'editor' && (
        <div className="rv-sticky rv-note-body">
          <CommentEditor target={row.target} actions={comments} orphaned={row.orphaned === true} />
        </div>
      )}
      {row.type === 'unplaced' && (
        <div className="rv-sticky rv-note-body" data-testid="review-unplaced-list">
          {row.items.map((item) =>
            item.draft ? (
              <CommentEditor key={draftKey(item.draft)} target={item.draft} actions={comments} />
            ) : (
              <CommentCard
                key={item.comment.id}
                comment={item.comment}
                side={item.at?.side ?? item.comment.side}
                start={item.at?.start ?? item.comment.start}
                end={item.at?.end ?? item.comment.end}
                unplaced={item.reason}
                actions={comments}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
};
