// ── The review model: snapshots, colours and the flat list of rows ─────────────
//
// Everything the review pane keeps that is not React state. It owns the file queue
// (what is fetched, what is kept), the colourer, each file's snapshot, which files
// are collapsed and how far each gap is expanded, and turns them into the one flat
// array of rows the virtual list draws. React sees a version number and the rows.
//
// Rows are built per file and cached under a signature of everything that shapes
// them, so a snapshot landing for one file rebuilds that file's rows and leaves the
// other 399 as they were; the arrays are then concatenated.

import type { ScmAlgorithm, ScmComment, ScmEntry, ScmFileSnapshot } from '@palmux/shared';
import { withNotes, type FileNotes } from './annotations';
import { Colorizer, type ColorizerOptions } from './colorize';
import { placeInSnapshot, type SnapshotPlacement } from './comment-placement';
import { draftKey, type DraftTarget } from './comments-store';
import { FileQueue, snapshotKey, type EvictReason, type FetchSnapshot } from './file-queue';
import {
  buildFileRows,
  expandGap,
  type DiffSide,
  type GapDirection,
  type GapReveals,
  type GapRow,
  type Row,
  type RowsLayout,
} from './rows';

/** The comments and open drafts of the active project, for the model to draw in the files it holds. */
export interface ReviewNotes {
  comments: readonly ScmComment[];
  drafts: readonly DraftTarget[];
}

/** The lines picked for a comment: highlighted, but they change no row. */
export interface LineMarks {
  path: string;
  side: DiffSide;
  start: number;
  end: number;
}

export type LineMark = 'selected' | 'commented';

export interface AssembledRows {
  rows: readonly Row[];
  /** `fileStart[i]` is the row index of file i's header. */
  fileStart: readonly number[];
}

export interface ReviewModelOptions {
  fetch: FetchSnapshot;
  algorithm: ScmAlgorithm;
  layout: RowsLayout;
  /**
   * The pixel height of a file's rows as they are drawn now. An evicted file's
   * placeholder holds it, so the rows below do not move.
   */
  measureRows: (rows: readonly Row[]) => number;
  /**
   * A different snapshot is about to replace a file's. The pane relocates its scroll
   * anchor here, while both texts are still at hand.
   */
  onReplace?: (path: string, previous: ScmFileSnapshot, next: ScmFileSnapshot) => void;
  /** Overrides for the colourer: tests schedule its work by hand. */
  colorizer?: Partial<ColorizerOptions>;
}

interface CachedRows {
  sig: string;
  rows: readonly Row[];
}

const entrySig = (entry: ScmEntry): string =>
  [
    entry.fp,
    entry.kind,
    entry.status,
    entry.added ?? '',
    entry.removed ?? '',
    entry.binary === true ? 'b' : '',
    entry.oldPath ?? '',
  ].join('\u0001');

const NO_NOTES: ReviewNotes = { comments: [], drafts: [] };

/** What one file's rows depend on in its comments and drafts. */
const notesSig = (comments: readonly ScmComment[], drafts: readonly DraftTarget[]): string =>
  [...comments.map((c) => `${c.id}:${c.updatedAt}`), '|', ...drafts.map((d) => draftKey(d))].join(
    '\u0003',
  );

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'Could not load this file';

export class ReviewModel {
  private readonly options: ReviewModelOptions;
  private readonly queue: FileQueue;
  private readonly colorizer: Colorizer;
  private readonly listeners = new Set<() => void>();

  private entries: ScmEntry[] = [];
  private readonly snapshots = new Map<string, ScmFileSnapshot>();
  private readonly collapsed = new Set<string>();
  private readonly reveals = new Map<string, GapReveals>();
  private readonly placeholderHeights = new Map<string, number>();
  private readonly errors = new Map<string, string>();
  private readonly rowCache = new Map<string, CachedRows>();
  // Comments and drafts by file, from the last `setNotes`.
  private commentsByPath = new Map<string, ScmComment[]>();
  private draftsByPath = new Map<string, DraftTarget[]>();
  private readonly placements = new Map<string, { sig: string; placement: SnapshotPlacement }>();
  // The lines drawn as commented, per file, as `side:no`; written as a file's rows are built.
  private readonly commented = new Map<string, Set<string>>();
  private marks: LineMarks | null = null;
  /** The layout `getRows` was last asked for: what `refreshVisible` assembles with. */
  private layout: RowsLayout;
  /** Whether it was last asked for merged dividers (`RowsOptions.merged`), kept the same way. */
  private merged = false;
  private visibleRows: { start: number; stop: number } | undefined;

  private version = 0;
  private assembled:
    | { version: number; layout: RowsLayout; merged: boolean; value: AssembledRows }
    | undefined;

  constructor(options: ReviewModelOptions) {
    this.options = options;
    this.layout = options.layout;
    // Nothing is fetched until the pane says it is shown and its project is read.
    this.queue = new FileQueue({
      fetch: options.fetch,
      algorithm: options.algorithm,
      onLoad: (path, snapshot, changed) => this.landed(path, snapshot, changed),
      onEvict: (path, reason) => this.evicted(path, reason),
      onError: (path, error) => {
        this.errors.set(path, messageOf(error));
        this.bump();
      },
    });
    this.queue.setEnabled(false);
    this.colorizer = new Colorizer({
      onColored: () => this.bump(),
      ...options.colorizer,
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Changes whenever anything the pane draws changed. */
  readonly getVersion = (): number => this.version;

  private bump(): void {
    this.version++;
    for (const listener of [...this.listeners]) listener();
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  /** The group's files in list order, with the attribute epoch of the status they came from. */
  setEntries(entries: readonly ScmEntry[], attrEpoch: string): void {
    const seen = new Set<string>();
    this.entries = entries.filter((entry) => {
      if (seen.has(entry.path)) return false;
      seen.add(entry.path);
      return true;
    });
    this.queue.setFiles(this.entries, attrEpoch);
    for (const cache of [
      this.rowCache,
      this.reveals,
      this.errors,
      this.placeholderHeights,
      this.placements,
      this.commented,
    ]) {
      for (const path of cache.keys()) if (!seen.has(path)) cache.delete(path);
    }
    for (const path of this.collapsed) if (!seen.has(path)) this.collapsed.delete(path);
    this.bump();
    // Files were added or removed, so the same rows may now belong to other files.
    this.refreshVisible();
  }

  setAlgorithm(algorithm: ScmAlgorithm): void {
    this.queue.setAlgorithm(algorithm);
  }

  /**
   * The comments and drafts to draw. A file whose own comments and drafts did not
   * change keeps its rows; the others are rebuilt when the rows are next asked for.
   */
  setNotes(notes: ReviewNotes = NO_NOTES): void {
    this.commentsByPath = new Map();
    for (const comment of notes.comments) {
      const held = this.commentsByPath.get(comment.path);
      if (held) held.push(comment);
      else this.commentsByPath.set(comment.path, [comment]);
    }
    this.draftsByPath = new Map();
    for (const draft of notes.drafts) {
      const held = this.draftsByPath.get(draft.path);
      if (held) held.push(draft);
      else this.draftsByPath.set(draft.path, [draft]);
    }
    for (const path of this.placements.keys()) {
      if (!this.commentsByPath.has(path)) this.placements.delete(path);
    }
    this.bump();
  }

  /** The lines picked right now, or null. Redraws the marks; no row is rebuilt. */
  setMarks(marks: LineMarks | null): void {
    this.marks = marks;
    this.bump();
  }

  /** A hidden review, or one of a project that is not being read, starts no request. */
  setEnabled(enabled: boolean): void {
    this.queue.setEnabled(enabled);
  }

  /** The rows on screen, by index into `getRows().rows`. */
  setVisibleRows(start: number, stop: number): void {
    this.visibleRows = { start, stop };
    this.refreshVisible();
  }

  toggleCollapsed(path: string): void {
    if (!this.collapsed.delete(path)) this.collapsed.add(path);
    this.bump();
  }

  expand(
    path: string,
    gap: Pick<GapRow, 'gapIndex' | 'position' | 'size'>,
    direction: GapDirection,
  ): void {
    const next = expandGap(this.reveals.get(path) ?? {}, gap, direction);
    this.reveals.set(path, next);
    this.bump();
  }

  /** Fetch a file now, though it is not near the view: the next change may be in it. */
  load(path: string): Promise<ScmFileSnapshot | null> {
    return this.queue.load(path);
  }

  /** Fetch a file again now, for a staging token that expired. The answer lands as any other. */
  reload(path: string): Promise<ScmFileSnapshot | null> {
    return this.queue.reload(path);
  }

  isCollapsed(path: string): boolean {
    return this.collapsed.has(path);
  }

  retry(path: string): void {
    this.errors.delete(path);
    this.queue.retry(path);
    this.bump();
  }

  /** The palette changed: every colour is stale. Lines go plain, then are coloured again. */
  recolor(): void {
    this.colorizer.clear();
    for (const snapshot of this.snapshots.values()) this.colorizer.request(snapshot);
    this.bump();
  }

  dispose(): void {
    this.queue.dispose();
    this.colorizer.clear();
    this.listeners.clear();
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  /**
   * The flat list in `layout`, with one divider row per hunk when `merged` (a phone). The
   * layout and the merge are arguments and not state so that a render can ask for them:
   * a state change here would notify subscribers mid-render.
   */
  getRows(layout: RowsLayout = this.layout, merged: boolean = this.merged): AssembledRows {
    this.layout = layout;
    this.merged = merged;
    if (
      this.assembled?.version === this.version &&
      this.assembled.layout === layout &&
      this.assembled.merged === merged
    ) {
      return this.assembled.value;
    }
    const rows: Row[] = [];
    const fileStart: number[] = [];
    for (const entry of this.entries) {
      const rowsOfFile = this.rowsOf(entry, layout, merged);
      fileStart.push(rows.length);
      for (const row of rowsOfFile) rows.push(row);
    }
    const value: AssembledRows = { rows, fileStart };
    this.assembled = { version: this.version, layout, merged, value };
    return value;
  }

  getEntries(): readonly ScmEntry[] {
    return this.entries;
  }

  getSnapshot(path: string): ScmFileSnapshot | undefined {
    return this.snapshots.get(path);
  }

  /** The file's error, while it has no snapshot to show. */
  errorOf(path: string): string | undefined {
    return this.snapshots.has(path) ? undefined : this.errors.get(path);
  }

  /** Whether a line is picked for a comment, or already carries one. */
  markOf(path: string, side: DiffSide, no: number | undefined): LineMark | undefined {
    if (no === undefined) return undefined;
    // The commented lines are written as a file's rows are built, so ask for them first
    // (a no-op while nothing changed): a mark must never lag the comments it marks.
    this.getRows();
    const picked = this.marks;
    if (picked?.path === path && picked.side === side && no >= picked.start && no <= picked.end) {
      return 'selected';
    }
    return this.commented.get(path)?.has(`${side}:${no}`) ? 'commented' : undefined;
  }

  /** Monaco's coloured markup of one line, or undefined while it renders plain. */
  htmlOf(path: string, side: DiffSide, no: number): string | undefined {
    const snapshot = this.snapshots.get(path);
    if (!snapshot) return undefined;
    return this.colorizer.get(snapshot.path, snapshot.version, side)?.[no - 1];
  }

  stats(): { files: number; bytes: number; active: number } {
    return this.queue.stats();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private rowsOf(entry: ScmEntry, layout: RowsLayout, merged: boolean): readonly Row[] {
    const snapshot = this.snapshots.get(entry.path);
    const collapsed = this.collapsed.has(entry.path);
    const reveals = this.reveals.get(entry.path);
    const placeholderHeight = this.placeholderHeights.get(entry.path);
    const failed = snapshot === undefined && this.errors.has(entry.path);
    const comments = this.commentsByPath.get(entry.path) ?? [];
    const drafts = this.draftsByPath.get(entry.path) ?? [];
    // Notes are drawn in a file that is open and loaded; a collapsed file shows
    // its header alone and a placeholder has no lines to hang them from.
    const noted =
      snapshot !== undefined && !collapsed && (comments.length > 0 || drafts.length > 0);
    const sig = [
      snapshot ? snapshotKey(snapshot) : '-',
      layout,
      merged ? 'm' : '',
      collapsed ? 'c' : '',
      reveals ? JSON.stringify(reveals) : '',
      placeholderHeight ?? '',
      failed ? 'f' : '',
      noted ? notesSig(comments, drafts) : '',
      entrySig(entry),
    ].join('\u0002');
    const cached = this.rowCache.get(entry.path);
    if (cached?.sig === sig) return cached.rows;
    const built = buildFileRows(
      { entry, snapshot },
      {
        layout,
        merged,
        collapsed,
        ...(reveals ? { reveals } : {}),
        ...(placeholderHeight !== undefined ? { placeholderHeight } : {}),
        ...(failed ? { failed } : {}),
      },
    );
    let rows: readonly Row[] = built;
    if (noted && snapshot) {
      rows = this.drawNotes(entry.path, snapshot, built, comments, drafts);
    } else {
      this.commented.delete(entry.path);
    }
    this.rowCache.set(entry.path, { sig, rows });
    return rows;
  }

  private drawNotes(
    path: string,
    snapshot: ScmFileSnapshot,
    built: readonly Row[],
    comments: readonly ScmComment[],
    drafts: readonly DraftTarget[],
  ): readonly Row[] {
    const sig = `${snapshotKey(snapshot)}|${notesSig(comments, [])}`;
    let held = this.placements.get(path);
    if (held?.sig !== sig) {
      held = { sig, placement: placeInSnapshot(comments, snapshot) };
      this.placements.set(path, held);
    }
    const lines = new Set<string>();
    for (const { side, start, end } of held.placement.placed) {
      for (let no = start; no <= end; no++) lines.add(`${side}:${no}`);
    }
    this.commented.set(path, lines);
    const notes: FileNotes = {
      placed: held.placement.placed,
      outdated: held.placement.outdated,
      unread: held.placement.unread,
      drafts,
    };
    return withNotes(path, built, notes);
  }

  private refreshVisible(): void {
    if (!this.visibleRows) return;
    const { fileStart } = this.getRows();
    if (fileStart.length === 0) return;
    this.queue.setVisible(
      this.fileIndexOfRow(fileStart, this.visibleRows.start),
      this.fileIndexOfRow(fileStart, this.visibleRows.stop),
    );
  }

  private fileIndexOfRow(fileStart: readonly number[], row: number): number {
    let low = 0;
    let high = fileStart.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((fileStart[mid] ?? 0) <= row) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  private landed(path: string, snapshot: ScmFileSnapshot, changed: boolean): void {
    const previous = this.snapshots.get(path);
    this.snapshots.set(path, snapshot);
    this.errors.delete(path);
    this.placeholderHeights.delete(path);
    // A renewed token (same file, same version, same algorithm) changes nothing drawn.
    if (!changed) return;
    if (previous) {
      this.options.onReplace?.(path, previous, snapshot);
      // The version is algorithm-free, so an algorithm switch keeps its colours.
      if (previous.version !== snapshot.version) {
        this.colorizer.forget(previous.path, previous.version);
      }
    }
    this.colorizer.request(snapshot);
    this.bump();
  }

  private evicted(path: string, reason: EvictReason): void {
    const snapshot = this.snapshots.get(path);
    if (snapshot) {
      if (reason !== 'removed') {
        const cached = this.rowCache.get(path);
        if (cached) this.placeholderHeights.set(path, this.options.measureRows(cached.rows));
      }
      this.colorizer.forget(snapshot.path, snapshot.version);
      this.snapshots.delete(path);
    }
    this.bump();
  }
}
