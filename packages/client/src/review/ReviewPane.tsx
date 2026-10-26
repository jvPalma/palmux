// ── The review pane ────────────────────────────────────────────────────────────
//
// One group of one project (`changes:<top>` or `staged:<top>`) as a single
// scrolling list: every file under a header, only the files near the viewport
// fetched and drawn. The pane owns what is on screen and where it is scrolled; the
// rows, the fetching and the colouring are `ReviewModel`'s.
//
// Three rules shape it.
//  - A hidden review costs nothing. Its status subscription does not count, its
//    queue starts no request, and it takes no new entries until it is shown.
//  - Only the device's active project is read. A review of another project (the
//    unfocused half of a split) keeps its last data under a "Paused" bar and
//    issues no request; a project removed from the list is a notice and nothing
//    else.
//  - A rebuild must not move what the reader is looking at. The first visible
//    line is remembered by file, side and number (`scroll-anchor.ts`), found again
//    after every rebuild, and, when its file's text changed, found by its text
//    and context and not by its number.
//
// On top of the reading it holds the three things a reviewer DOES: comment on lines
// (picked on their numbers; the text lives in the comments store, so a draft
// outlives the row it is typed in), Reviewed / Unstage with their Undo, and the
// keys that move by change and by file. Every write is gated on the project being
// the one this device reads: a paused review shows, and does not write. And a file
// with a comment open on it is not staged or unstaged until that comment is saved
// or cancelled, since the write takes the file, and the editor, out of the review.

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  isScmAlgorithm,
  parseReviewUrl,
  SCM_ALGORITHMS,
  SCM_COMMENT_LIMITS,
  type ColorProfile,
  type ScmComment,
  type ScmEntry,
  type ScmGroup,
  type ScmStatus,
  type TabMeta,
} from '@palmux/shared';
import { buildMonacoTheme, editorProfile, onEditorProfile } from '../panes/monaco-theme';
import { pressMove } from '../panes/press';
import {
  clampFontSize,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  type ScmLayoutPref,
} from '../settings/settings';
import { displayTitle } from '../session/tab-meta';
import { restoreScmWrite, stageScmFile, unstageScmFile } from '../scm/scm-api';
import { scmStatusStore, useScmStatus } from '../scm/status-store';
import {
  Button,
  DropdownMenu,
  IconButton,
  Segmented,
  Select,
  VirtualList,
  type DropdownMenuItemSpec,
} from '../ui';
import { Icon } from '../ui/icons';
import { splitLines } from './anchor';
import type { CommentActions } from './comment-actions';
import { captureRange, commentInput, type CapturedRange } from './comment-placement';
import { draftKey, type DraftTarget } from './comments-store';
import {
  beginSelection,
  extendSelection,
  pickSelection,
  rangeOf,
  releaseSelection,
  tapSelection,
  type LineGestures,
  type LineSelection,
} from './line-selection';
import { fetchScmFile } from './review-api';
import { useCompactReview } from './review-density';
import { useReviewHost, type ReviewScrollTarget } from './review-host';
import {
  observeReviewWidth,
  resolveReviewLayout,
  resolveWrap,
  REVIEW_COMPACT_BAR_PX,
} from './review-layout';
import {
  codeLineHeight,
  computeGeometry,
  DEFAULT_CODE_FONT_PX,
  heightOfRows,
  ROW_METRICS,
  type HeightContext,
} from './review-metrics';
import { ReviewModel } from './review-model';
import { findChange, findCurrentFile, findFile, jumpTop, type NavView } from './review-nav';
import { registerReview, type ReviewApi } from './review-registry';
import {
  describeWrites,
  draftBlocker,
  reviewBlocker,
  reviewShown,
  undoWrites,
  unstageEntry,
  type WriteDeps,
  type WriteOutcome,
} from './review-writes';
import { ReviewRow, type ReviewRowProps, type ReviewWrites } from './ReviewRow';
import { commentsStore, useComments } from './use-comments';
import { forgetWrites, recordWrite, type LoggedWrite } from './write-log';
import {
  captureAnchor,
  relocateAnchor,
  restoredScrollTop,
  type AnchorLayout,
  type ScrollAnchor,
} from './scroll-anchor';
import type { GapDirection, GapRow } from './rows';
import './review.css';

export interface ReviewPaneProps {
  tab: TabMeta;
  /** PaneHost's `shown`: the pane is in a slot. A pane that is not costs nothing. */
  visible: boolean;
  /** Its slot has focus. */
  focused: boolean;
}

/** The list's height until the browser reports one; the first paint renders a screenful. */
const DEFAULT_LIST_HEIGHT = 600;
const OVERSCAN_ROWS = 8;
/** Panes narrower or wider than this by a bucket re-measure their wrapped rows. */
const WIDTH_BUCKET_PX = 64;

const NO_DRAFTS: readonly DraftTarget[] = [];
const NO_COMMENTS: readonly ScmComment[] = [];
const NO_PATHS: ReadonlySet<string> = new Set();

const PAUSED_MESSAGE = 'This project is paused. Make it active to comment or stage.';

/** The hidden textarea that carries the soft keyboard (App.tsx). */
const KEYBOARD_ID = 'mobile-kbd';

const LAYOUT_OPTIONS: { value: ScmLayoutPref; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'split', label: 'Split' },
  { value: 'unified', label: 'Unified' },
];

const ALGORITHM_OPTIONS = SCM_ALGORITHMS.map((value) => ({
  value,
  label: value.charAt(0).toUpperCase() + value.slice(1),
}));

/**
 * File headers stick to the left edge of a sideways-scrolling list, and a sticky box
 * needs a parent as wide as the scrolled content to have room to stick in. So the
 * other rows are given the width of the widest LINE on screen (`--rv-scroll-w`) and
 * their controls the width of the view (`--rv-view-w`). It is measured from the
 * lines and not from the scroller's own `scrollWidth`, which the rows given that
 * width would hold up for ever.
 *
 * Wrapped rows are the view's width and nothing scrolls sideways, so there both are
 * removed: a width left over from no-wrap would hold every sticky box at the width
 * the view had then.
 */
function syncStickyWidth(element: HTMLElement, wrap: boolean): void {
  if (wrap) {
    element.style.removeProperty('--rv-scroll-w');
    element.style.removeProperty('--rv-view-w');
    return;
  }
  let widest = element.clientWidth;
  for (const line of element.querySelectorAll<HTMLElement>('.rv-line')) {
    widest = Math.max(widest, line.offsetWidth);
  }
  setStyleProperty(element, '--rv-scroll-w', `${widest}px`);
  setStyleProperty(element, '--rv-view-w', `${element.clientWidth}px`);
}

/** A write restyles every row that reads the property, so an unchanged value is left alone. */
function setStyleProperty(element: HTMLElement, name: string, value: string): void {
  if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
}

/**
 * What a line's colours depend on: the Monaco theme built from the profile. Two
 * profiles with the same key colour every line alike, whatever their ids.
 */
const paletteOf = (profile: ColorProfile | null): string =>
  profile ? JSON.stringify(buildMonacoTheme(profile)) : '';

const rowKey = (index: number, props: ReviewRowProps): string =>
  props.rows[index]?.key ?? `${index}`;

const nameOf = (repo: string): string => repo.split('/').findLast(Boolean) ?? repo;
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** `L42 · new` or `L10–14 · old`. */
const describeRange = ({
  start,
  end,
  side,
}: {
  start: number;
  end: number;
  side: string;
}): string => `${start === end ? `L${start}` : `L${start}–${end}`} · ${side}`;

function summarize(entries: readonly ScmEntry[]): string {
  let added = 0;
  let removed = 0;
  for (const entry of entries) {
    added += entry.added ?? 0;
    removed += entry.removed ?? 0;
  }
  const files = `${entries.length} ${entries.length === 1 ? 'file' : 'files'}`;
  return added + removed > 0 ? `${files} · +${added} −${removed}` : files;
}

/**
 * Runs `effect` as a layout effect of a CHILD of the list. React runs a child's
 * layout effects before its parent's, and react-window chooses the rows it draws in
 * one of its own, from the scroller's offset at that moment. The pane puts its
 * reader back from here, so that offset is the one it restored and not the one a
 * rebuild left behind, which would draw the wrong place for a frame and fetch the
 * files there (each of which then moves the view again as it loads).
 */
const BeforeList = ({ effect }: { effect: () => void }) => {
  useLayoutEffect(effect, [effect]);
  return null;
};

interface ReviewViewProps {
  tabId: string;
  url: string;
  repo: string;
  group: ScmGroup;
  tab: TabMeta;
  visible: boolean;
  focused: boolean;
}

const ReviewView = ({ tabId, url, repo, group, tab, visible, focused }: ReviewViewProps) => {
  const host = useReviewHost();
  const removed = !host.repos.includes(repo);
  const live = useScmStatus(repo, visible && !removed);

  // The last answer for this project. The store keeps only the active project's, so
  // a review that is paused (or about to be read again) draws from here.
  const retained = useRef<ScmStatus | null>(null);
  if (live.active && live.status) retained.current = live.status;
  const status = (live.active ? live.status : null) ?? retained.current;
  const paused = !removed && !live.active;

  const entries = useMemo<ScmEntry[]>(() => {
    if (!status) return [];
    // Conflicted files lead the Changes review, as Merge Changes leads the view.
    return group === 'staged' ? status.staged : [...status.merge, ...status.changes];
  }, [status, group]);
  const attrEpoch = status?.attrEpoch ?? '';

  // ── Width, layout, wrapping ───────────────────────────────────────────────
  const bodyRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(true);
  const [compactBar, setCompactBar] = useState(false);
  const [widthBucket, setWidthBucket] = useState(0);
  const widthRef = useRef(0);
  const layout = resolveReviewLayout(host.layout, narrow);
  const wrap = resolveWrap(host.wrap, layout, narrow);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const wrapRef = useRef(wrap);
  wrapRef.current = wrap;
  const listElement = useCallback(
    () => bodyRef.current?.querySelector<HTMLElement>('[role="list"]') ?? null,
    [],
  );
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return undefined;
    return observeReviewWidth(body, setNarrow, (width) => {
      widthRef.current = width;
      setCompactBar(width < REVIEW_COMPACT_BAR_PX);
      const bucket = Math.round(width / WIDTH_BUCKET_PX);
      setWidthBucket((previous) => (previous === bucket ? previous : bucket));
      // A resize inside one bucket rebuilds nothing, and the sticky boxes must still
      // follow the view's width.
      const list = listElement();
      if (list) syncStickyWidth(list, wrapRef.current);
    });
  }, [listElement]);

  // The code font size. The terminal's does not reach here: a review that moved with
  // it would shrink under a pinch meant for the shell.
  const { codeFontSize, setPreferences } = host;
  const codeFontPx = codeFontSize ?? DEFAULT_CODE_FONT_PX;
  // Inline because the numbers are JavaScript's: the row heights the list is given are
  // computed from them, and the sheet is handed the same two so it cannot draw a line
  // taller or shorter than the list thinks it is.
  const codeStyle = useMemo<CSSProperties>(
    () =>
      ({
        '--rv-code-fs': `${codeFontPx}px`,
        '--rv-code-lh': `${codeLineHeight(codeFontPx)}px`,
      }) as CSSProperties,
    [codeFontPx],
  );

  // Measured heights are per geometry: a different layout, wrapping, width or code
  // size wraps lines differently, so what was measured no longer holds.
  const geometryKey = `${layout}|${wrap}|${widthBucket}|${codeFontPx}`;
  const measuredStore = useRef({ key: geometryKey, map: new Map<string, number>() });
  if (measuredStore.current.key !== geometryKey) {
    measuredStore.current = { key: geometryKey, map: new Map() };
  }
  const measured = measuredStore.current.map;
  const [heightRevision, setHeightRevision] = useState(0);
  // A phone draws the structural rows shorter (review-metrics.ts), and the sheet is told
  // the same thing through `data-dense`. A change of it only changes those rows' heights,
  // which are fixed numbers, so what was measured stays valid and is not keyed by it.
  const compact = useCompactReview();
  const heightContext = useRef<HeightContext>({
    wrap,
    layout,
    width: 0,
    codeFontPx,
    compact,
    measured,
  });
  heightContext.current = {
    wrap,
    layout,
    width: widthRef.current,
    codeFontPx,
    compact,
    measured,
  };

  // ── Model ─────────────────────────────────────────────────────────────────
  const anchorRef = useRef<ScrollAnchor | null>(null);
  const [model] = useState(
    () =>
      new ReviewModel({
        fetch: (request, signal) => fetchScmFile(repo, group, request, signal),
        algorithm: host.algorithm,
        layout,
        measureRows: (rows) => heightOfRows(rows, heightContext.current),
        onReplace: (_path, previous, next) => {
          if (anchorRef.current)
            anchorRef.current = relocateAnchor(anchorRef.current, previous, next);
        },
      }),
  );
  useEffect(() => () => model.dispose(), [model]);
  const version = useSyncExternalStore(model.subscribe, model.getVersion);

  // Before the entries: enabling with nothing loaded starts nothing.
  const enabled = visible && live.active && !removed;
  useEffect(() => {
    model.setEnabled(enabled);
  }, [model, enabled]);
  useEffect(() => {
    model.setAlgorithm(host.algorithm);
  }, [model, host.algorithm]);
  const syncedEntries = useRef<ScmEntry[] | null>(null);
  useEffect(() => {
    // A hidden pane keeps what it had; it takes the news when it is shown.
    if (!visible) return;
    model.setEntries(entries, attrEpoch);
    syncedEntries.current = entries;
  }, [model, visible, entries, attrEpoch]);

  // The palette changed: Monaco's theme is defined (the loader subscribes first),
  // then this pane's colours are dropped and drawn again. App publishes the profile
  // on every `themes` message, which every reconnect brings, so a palette equal to
  // the one the colours were drawn with is no change at all. A hidden pane draws
  // nothing, so it recolours once it is shown: N hidden reviews must not each
  // colour their files at the moment a theme changes.
  const palette = useRef({ drawn: '', latest: '' });
  const recolorIfStale = useCallback(() => {
    const { drawn, latest } = palette.current;
    if (drawn === latest) return;
    palette.current.drawn = latest;
    model.recolor();
  }, [model]);
  useEffect(() => {
    const now = paletteOf(editorProfile());
    palette.current = { drawn: now, latest: now };
    return onEditorProfile((profile) => {
      palette.current.latest = paletteOf(profile);
      if (visibleRef.current) recolorIfStale();
    });
  }, [recolorIfStale]);
  // A layout effect, so the old colours never reach the screen of a pane shown again.
  useLayoutEffect(() => {
    if (visible) recolorIfStale();
  }, [visible, recolorIfStale]);

  const assembled = model.getRows(layout);
  const geometry = useMemo(
    () => computeGeometry(assembled.rows, heightContext.current),
    // `heightRevision` is the browser's report that a wrapped row measured differently.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [assembled, measured, wrap, layout, codeFontPx, compact, heightRevision],
  );
  const anchorLayout = useRef<AnchorLayout>({ rows: [], offsets: geometry.offsets, fileStart: [] });
  anchorLayout.current = {
    rows: assembled.rows,
    offsets: geometry.offsets,
    fileStart: assembled.fileStart,
  };

  // ── Measuring wrapped rows ────────────────────────────────────────────────
  // One observer per set of measurements. A new geometry starts an empty map, and an
  // observer only reports a row whose size CHANGED since it last told: a row whose
  // height is the same at the new width would never be measured again, and would be
  // laid out at its estimate under the next row. A fresh observer reports every row
  // it is given, so the rows re-observe themselves when it is replaced.
  const rowObserver = useMemo(() => {
    if (typeof ResizeObserver === 'undefined') return null;
    return new ResizeObserver((observed) => {
      let changed = false;
      for (const entry of observed) {
        const key = (entry.target as HTMLElement).dataset['rvKey'];
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        // A row in a hidden pane measures 0: that is not its height.
        if (key === undefined || height <= 0) continue;
        const known = measured.get(key);
        if (known !== undefined && Math.abs(known - height) < 0.5) continue;
        measured.set(key, height);
        changed = true;
      }
      if (changed) setHeightRevision((revision) => revision + 1);
    });
  }, [measured]);
  useEffect(() => () => rowObserver?.disconnect(), [rowObserver]);
  const observe = useCallback(
    (element: HTMLElement) => {
      if (!rowObserver) return () => {};
      rowObserver.observe(element);
      return () => rowObserver.unobserve(element);
    },
    [rowObserver],
  );

  // ── Rows ──────────────────────────────────────────────────────────────────
  const [currentFile, setCurrentFile] = useState(0);
  const onRowsRendered = useCallback(
    (range: { startIndex: number; stopIndex: number }) => {
      model.setVisibleRows(range.startIndex, range.stopIndex);
      const { fileStart } = model.getRows();
      let file = 0;
      while (file + 1 < fileStart.length && (fileStart[file + 1] ?? 0) <= range.startIndex) file++;
      setCurrentFile((previous) => (previous === file ? previous : file));
    },
    [model],
  );
  const sizes = geometry.sizes;
  const listHeight = geometry.offsets[assembled.rows.length] ?? 0;
  const extentStyle = useMemo<CSSProperties>(
    () => ({ position: 'absolute', top: 0, left: 0, width: 1, height: listHeight }),
    [listHeight],
  );
  const rowHeight = useCallback((index: number) => sizes[index] ?? ROW_METRICS.line, [sizes]);
  const onToggle = useCallback((path: string) => model.toggleCollapsed(path), [model]);
  const onExpand = useCallback(
    (path: string, gap: GapRow, direction: GapDirection) => model.expand(path, gap, direction),
    [model],
  );
  const onRetry = useCallback((path: string) => model.retry(path), [model]);

  // ── Jumping ───────────────────────────────────────────────────────────────
  // Every programmatic scroll (a Source Control row, next change, Reviewed moving on)
  // is a REQUEST: a row to bring to the top, applied by the layout effect below once
  // the rows it names are built. `landedRef` remembers where the last jump left the
  // view, which is what lets "next" tell a change it just jumped to from the one after.
  const [scrollRequest, setScrollRequest] = useState(0);
  const navTarget = useRef<{ key: string; path: string } | null>(null);
  const landedRef = useRef<NavView['landed']>(undefined);
  const requestJump = useCallback((key: string, path: string) => {
    navTarget.current = { key, path };
    setScrollRequest((count) => count + 1);
  }, []);
  const navView = useCallback((): NavView => {
    const built = model.getRows(layout);
    const { offsets } = computeGeometry(built.rows, heightContext.current);
    return {
      rows: built.rows,
      fileStart: built.fileStart,
      offsets,
      scrollTop: listElement()?.scrollTop ?? 0,
      landed: landedRef.current,
    };
  }, [model, layout, listElement]);

  // ── Comments ──────────────────────────────────────────────────────────────
  // The store holds the ACTIVE project's comments only. A paused review keeps what it
  // last had on screen and cannot write: a comment saved from it would land in the
  // other project.
  const commentState = useComments(repo, visible && !removed);
  const retainedComments = useRef<readonly ScmComment[]>(NO_COMMENTS);
  if (commentState.active && commentState.loaded) retainedComments.current = commentState.comments;
  const comments =
    commentState.active && commentState.loaded ? commentState.comments : retainedComments.current;
  // The drafts of THIS review: its Changes and its Staged can show the same lines.
  // An edit is drawn only once the comments are in: until then its comment is not
  // known to exist, and it would be shown as one that was deleted.
  const storeDrafts = commentState.active ? commentState.drafts : NO_DRAFTS;
  const commentsKnown = commentState.active && commentState.loaded;
  const drafts = useMemo(
    () =>
      storeDrafts.filter(
        (draft) => draft.scope === group && (commentsKnown || draft.commentId === undefined),
      ),
    [storeDrafts, group, commentsKnown],
  );
  const writable = live.active && !removed;
  const [notice, setNotice] = useState<string | null>(null);
  const hostRef = useRef(host);
  hostRef.current = host;
  // Before paint: a comment that arrives with its file must not show up a frame late,
  // under a view that has already been scrolled.
  useLayoutEffect(() => {
    model.setNotes({ comments, drafts });
  }, [model, comments, drafts]);

  const [selection, setSelection] = useState<LineSelection | null>(null);
  const selectionRef = useRef<LineSelection | null>(null);
  const updateSelection = useCallback((next: LineSelection | null) => {
    selectionRef.current = next;
    setSelection(next);
  }, []);
  useEffect(() => {
    model.setMarks(selection ? rangeOf(selection) : null);
  }, [model, selection]);
  // A pick belongs to one file of this review, and to a project that can be written to.
  useEffect(() => {
    const held = selectionRef.current;
    if (held && (!writable || !entries.some((entry) => entry.path === held.path))) {
      updateSelection(null);
    }
  }, [writable, entries, updateSelection]);

  // A mouse drag ends wherever the button is let go, not on the number it started on.
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  const lines = useMemo<LineGestures | null>(() => {
    if (!writable) return null;
    return {
      begin: (target, extend) => {
        updateSelection(beginSelection(selectionRef.current, target, extend));
        stopDrag.current?.();
        const end = (): void => {
          updateSelection(releaseSelection(selectionRef.current));
          stopDrag.current?.();
        };
        window.addEventListener('pointerup', end);
        window.addEventListener('pointercancel', end);
        stopDrag.current = () => {
          window.removeEventListener('pointerup', end);
          window.removeEventListener('pointercancel', end);
          stopDrag.current = null;
        };
      },
      enter: (target) => updateSelection(extendSelection(selectionRef.current, target)),
      tap: (target) => updateSelection(tapSelection(selectionRef.current, target)),
      pick: (target, extend) =>
        updateSelection(pickSelection(selectionRef.current, target, extend)),
    };
  }, [writable, updateSelection]);

  // What a comment is ABOUT is captured when its editor opens, not when it is saved: a
  // file edited while a comment is typed must not move it onto whatever now sits at
  // those numbers. (A pane that remounted reads them again, as they are then.)
  const captured = useRef(new Map<string, CapturedRange>());
  const freshDraft = useRef<string | null>(null);
  // Whether the soft keyboard (`#mobile-kbd`) held focus as each draft opened. The
  // textarea takes that focus, and the keyboard goes back to it when the draft ends,
  // but only for a draft that took it from there. Kept here, not in the editor,
  // which unmounts whenever its row scrolls out of the list.
  const keyboardHeld = useRef(new Map<string, boolean>());
  const openDraft = useCallback(
    (target: DraftTarget, text: string) => {
      const key = draftKey(target);
      freshDraft.current = key;
      // Once per draft: opening one again finds focus in its own textarea.
      if (!keyboardHeld.current.has(key)) {
        keyboardHeld.current.set(key, document.activeElement?.id === KEYBOARD_ID);
      }
      commentsStore.setDraft(repo, target, text);
    },
    [repo],
  );
  const startComment = useCallback(() => {
    const held = selectionRef.current;
    if (!held || held.phase === 'drag') return;
    const range = rangeOf(held);
    const snapshot = model.getSnapshot(range.path);
    const quoted = snapshot
      ? captureRange(splitLines(snapshot[range.side].text), range.start, range.end)
      : null;
    if (!quoted) {
      setNotice('Those lines are not in the file any more. Select them again.');
      updateSelection(null);
      return;
    }
    if (quoted.lines.length > SCM_COMMENT_LIMITS.lines) {
      setNotice(`A comment covers at most ${SCM_COMMENT_LIMITS.lines} lines.`);
      return;
    }
    const target: DraftTarget = {
      path: range.path,
      side: range.side,
      start: range.start,
      end: range.end,
      scope: group,
    };
    captured.current.set(draftKey(target), quoted);
    openDraft(target, commentsStore.draftText(repo, target) ?? '');
    updateSelection(null);
  }, [model, repo, group, openDraft, updateSelection]);

  const commentActions = useMemo<CommentActions>(() => {
    const closeDraft = (target: DraftTarget): void => {
      const key = draftKey(target);
      commentsStore.clearDraft(repo, target);
      captured.current.delete(key);
      const hadKeyboard = keyboardHeld.current.get(key) === true;
      keyboardHeld.current.delete(key);
      if (hadKeyboard) document.getElementById(KEYBOARD_ID)?.focus();
    };
    // A new comment, from the code its draft captured when it was opened.
    const addNew = async (target: DraftTarget, body: string) => {
      const snapshot = model.getSnapshot(target.path);
      const quoted =
        target.quote ??
        captured.current.get(draftKey(target)) ??
        (snapshot
          ? captureRange(splitLines(snapshot[target.side].text), target.start, target.end)
          : null);
      if (!quoted || !snapshot) {
        return {
          ok: false as const,
          message: 'The commented lines are no longer in the file. Cancel and select them again.',
          httpStatus: 0,
        };
      }
      return commentsStore.add(commentInput(snapshot.group, target, quoted, body));
    };
    return {
      readOnly: !writable,
      draftText: (target) => commentsStore.draftText(repo, target),
      setDraft: (target, text) => commentsStore.setDraft(repo, target, text),
      closeDraft,
      save: async (target, body) => {
        // The store writes to the active project; this review may have been left behind.
        if (commentsStore.getSnapshot().repo !== repo) {
          return { ok: false, message: PAUSED_MESSAGE, httpStatus: 0 };
        }
        const result =
          target.commentId !== undefined
            ? await commentsStore.edit(target.commentId, { body })
            : await addNew(target, body);
        if (result.ok) closeDraft(target);
        return result;
      },
      saveAsNew: async (target, body) => {
        if (commentsStore.getSnapshot().repo !== repo) {
          return { ok: false, message: PAUSED_MESSAGE, httpStatus: 0 };
        }
        const result = await addNew(target, body);
        if (result.ok) closeDraft(target);
        return result;
      },
      edit: (comment) =>
        openDraft(
          {
            path: comment.path,
            side: comment.side,
            start: comment.start,
            end: comment.end,
            commentId: comment.id,
            scope: group,
            quote: { lines: comment.lines, before: comment.before, after: comment.after },
          },
          comment.body,
        ),
      remove: (comment) => {
        // A comment with text asks once; an empty one is gone at the tap.
        if (comment.body.trim() !== '' && !window.confirm('Delete this comment?')) return;
        void commentsStore.remove(comment.id).then((result) => {
          if (!result.ok) setNotice(`Could not delete the comment: ${result.message}`);
        });
      },
      takeFocus: (target) => {
        if (freshDraft.current !== draftKey(target)) return false;
        freshDraft.current = null;
        return true;
      },
    };
  }, [repo, writable, model, group, openDraft]);

  // ── Reviewed, Unstage, Undo ───────────────────────────────────────────────
  const busyRef = useRef(new Set<string>());
  const [busy, setBusy] = useState<ReadonlySet<string>>(NO_PATHS);
  const setBusyPath = useCallback((path: string, on: boolean) => {
    if (on) busyRef.current.add(path);
    else busyRef.current.delete(path);
    setBusy(new Set(busyRef.current));
  }, []);
  const writeDeps = useMemo<WriteDeps>(
    () => ({
      stage: (path, token) => stageScmFile(repo, path, token),
      unstage: (path, oldPath) => unstageScmFile(repo, path, oldPath),
      reload: (path) => model.reload(path),
    }),
    [repo, model],
  );
  const refuse = useCallback((message: string) => {
    setNotice(message);
    hostRef.current.notify(message);
  }, []);
  // One Undo takes back every write the toast named (the app has one toast, and each
  // write used to replace the last one's), newest first.
  const undo = useCallback(
    async (writes: readonly LoggedWrite[]) => {
      const outcome = await undoWrites(restoreScmWrite, writes);
      // What was undone is not offered again by the next write's toast.
      forgetWrites(writes.slice(writes.length - outcome.undone));
      // A partial undo changed the index too, so the list is read again either way.
      if (outcome.undone > 0) scmStatusStore.refresh();
      if (outcome.kind === 'notice') {
        refuse(outcome.message);
        return;
      }
      setNotice(null);
      hostRef.current.notify(outcome.undone === 1 ? 'Undone' : `Undid ${outcome.undone} files`);
    },
    [refuse],
  );
  const reviewFile = useCallback(
    async (path: string): Promise<void> => {
      const all = model.getEntries();
      const at = all.findIndex((entry) => entry.path === path);
      const entry = all[at];
      if (!entry || busyRef.current.has(path)) return;
      if (!writable) {
        setNotice(PAUSED_MESSAGE);
        return;
      }
      // Read at the time of the press: the key works from inside the editor itself.
      const open = commentsStore.getSnapshot();
      const drafted = draftBlocker(open.repo === repo ? open.drafts : NO_DRAFTS, path, group);
      if (drafted !== null) {
        setNotice(drafted);
        return;
      }
      const staged = group === 'staged';
      const shown = model.getSnapshot(path);
      const blocker = staged ? null : reviewBlocker(entry, shown);
      if (blocker !== null) {
        setNotice(blocker);
        return;
      }
      setBusyPath(path, true);
      let outcome: WriteOutcome;
      try {
        outcome =
          shown && !staged
            ? await reviewShown(writeDeps, shown)
            : await unstageEntry(writeDeps, entry);
      } finally {
        setBusyPath(path, false);
      }
      if (outcome.kind === 'notice') {
        setNotice(outcome.message);
        return;
      }
      setNotice(null);
      // The file leaves this group at the next read; do not make the reader wait a second for it.
      scmStatusStore.refresh();
      const recent = recordWrite({
        repo,
        receiptId: outcome.receiptId,
        action: staged ? 'unstage' : 'stage',
        name: baseName(path),
        at: Date.now(),
      });
      hostRef.current.notify(describeWrites(recent), {
        label: 'Undo',
        onClick: () => void undo(recent),
      });
      // Then the next file, which was the next one in the list before this one left it.
      const next = all[at + 1];
      if (next) requestJump(`${next.path}|file`, next.path);
    },
    [model, repo, group, writable, writeDeps, undo, setBusyPath, requestJump],
  );
  const writes = useMemo<ReviewWrites>(
    () => ({
      group,
      stateOf: (path) => {
        const isBusy = busy.has(path);
        if (!writable) return { blocker: PAUSED_MESSAGE, busy: isBusy };
        const drafted = draftBlocker(drafts, path, group);
        if (drafted !== null) return { blocker: drafted, busy: isBusy };
        if (group === 'staged') return { blocker: null, busy: isBusy };
        const entry = model.getEntries().find((e) => e.path === path);
        return { blocker: reviewBlocker(entry, model.getSnapshot(path)), busy: isBusy };
      },
      run: (path) => void reviewFile(path),
    }),
    [group, writable, busy, drafts, model, reviewFile],
  );

  // ── Moving by change and by file ──────────────────────────────────────────
  // A file the status says has no text change to show (binary, a mode change) or that
  // could not be fetched is a stop at its header, never something to wait for.
  const unloadable = useRef(new Set<string>());
  const needsLoad = useCallback(
    (path: string): boolean => {
      if (unloadable.current.has(path) || model.getSnapshot(path) !== undefined) return false;
      const entry = model.getEntries().find((e) => e.path === path);
      if (!entry || entry.kind === 'unmerged' || entry.binary === true) return false;
      if (model.isCollapsed(path)) return false;
      return !(entry.added === 0 && entry.removed === 0);
    },
    [model],
  );
  const moveChange = useCallback(
    async (dir: 1 | -1): Promise<void> => {
      for (;;) {
        const target = findChange(navView(), dir, needsLoad);
        if (!target) return;
        if (target.kind === 'row') {
          requestJump(target.key, target.path);
          return;
        }
        // The change is in a file that is not here yet: fetch it first, then look again.
        // oxlint-disable-next-line no-await-in-loop -- each step needs the file before it
        const loaded = await model.load(target.path);
        if (!loaded || model.getSnapshot(target.path) === undefined) {
          unloadable.current.add(target.path);
        }
      }
    },
    [model, navView, needsLoad, requestJump],
  );
  const moveFile = useCallback(
    (dir: 1 | -1): void => {
      const view = navView();
      const file = findFile(view, dir);
      const row = file === null ? undefined : view.rows[view.fileStart[file] ?? 0];
      if (row) requestJump(row.key, row.path);
    },
    [navView, requestJump],
  );
  const reviewCurrent = useCallback((): void => {
    const file = findCurrentFile(navView());
    const entry = file === null ? undefined : model.getEntries()[file];
    if (entry) void reviewFile(entry.path);
  }, [model, navView, reviewFile]);

  // The keys reach this pane through the registry. The functions are read at the time
  // of the key, so the registration never has to be redone; a hidden review ignores them.
  const keyActions = useRef({ moveChange, moveFile, reviewCurrent });
  keyActions.current = { moveChange, moveFile, reviewCurrent };
  useEffect(() => {
    const whenShown =
      (run: () => void): (() => void) =>
      () => {
        if (visibleRef.current) run();
      };
    const api: ReviewApi = {
      nextChange: whenShown(() => void keyActions.current.moveChange(1)),
      prevChange: whenShown(() => void keyActions.current.moveChange(-1)),
      nextFile: whenShown(() => keyActions.current.moveFile(1)),
      prevFile: whenShown(() => keyActions.current.moveFile(-1)),
      reviewCurrent: whenShown(() => keyActions.current.reviewCurrent()),
    };
    return registerReview(tabId, api);
  }, [tabId]);

  const { openFile } = host;
  const rowProps = useMemo<ReviewRowProps>(
    () => ({
      rows: assembled.rows,
      model,
      revision: version,
      repo,
      wrap,
      layout,
      compact,
      writes,
      comments: commentActions,
      lines,
      onToggle,
      onExpand,
      onOpenFile: openFile,
      onRetry,
      observe,
    }),
    [
      assembled,
      model,
      version,
      repo,
      wrap,
      layout,
      compact,
      writes,
      commentActions,
      lines,
      onToggle,
      onExpand,
      openFile,
      onRetry,
      observe,
    ],
  );

  // ── Scrolling ─────────────────────────────────────────────────────────────
  const showList = !removed && assembled.rows.length > 0;
  // The offset this pane last put the list at. The `scroll` event a write raises is
  // the browser reporting that write, not the reader moving, so it must not replace
  // the anchor: the write may have landed a pixel beside its target, or been clamped,
  // and an anchor read back from it would carry the view off with whatever row it
  // found there as the rows above load.
  const writtenTop = useRef<number | null>(null);
  const writeScrollTop = useCallback((element: HTMLElement, top: number): void => {
    element.scrollTop = top;
    writtenTop.current = element.scrollTop;
  }, []);
  useEffect(() => {
    const element = listElement();
    if (!showList || !element) return undefined;
    let frame = 0;
    const onScroll = (): void => {
      // A hidden pane's scroller reports a zero offset that is not the reader's.
      if (!visibleRef.current) return;
      const written = writtenTop.current;
      if (written === null || Math.abs(element.scrollTop - written) >= 1) {
        writtenTop.current = null;
        anchorRef.current = captureAnchor(anchorLayout.current, element.scrollTop);
      }
      // The lines a scroll brings in can be wider than the ones it took away. Their
      // widths are read once a frame, not in every scroll event, where each read
      // would force a layout of its own.
      if (wrapRef.current || frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (visibleRef.current) syncStickyWidth(element, wrapRef.current);
      });
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      element.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [showList, listElement]);

  // A rebuild can bring wider lines, and a change of wrapping either needs the
  // widths or must drop them. A hidden scroller measures 0, which is not the view.
  useLayoutEffect(() => {
    const element = listElement();
    if (visible && element) syncStickyWidth(element, wrap);
  }, [visible, wrap, assembled, geometry, listElement]);

  // A Source Control row asked for a file: take the request once this pane is shown.
  const pendingScroll = useRef<ReviewScrollTarget | null>(null);
  const { takeScrollTarget, openTick } = host;
  useEffect(() => {
    if (!visible) return;
    const target = takeScrollTarget(url);
    if (!target) return;
    pendingScroll.current = target;
    setScrollRequest((count) => count + 1);
  }, [visible, takeScrollTarget, openTick, url]);

  // After every rebuild (and when the pane is shown again, a hidden scroller having
  // lost its offset) put the anchor back where it was, or take the pending file to
  // the top of the view. It runs inside the list (`BeforeList`), not here: see there.
  const restoreView = useCallback(() => {
    if (!visible) return;
    const element = listElement();
    if (!element) return;
    const layoutNow = anchorLayout.current;

    // A file's header lands as ITSELF at the top. The files above it are mostly
    // placeholders, each of which moves it when it loads or measures differently
    // from its estimate, and so do the notices under it, so the anchor is the header
    // and not the first line found near it.
    const land = (index: number, top: number): void => {
      const row = layoutNow.rows[index];
      if (!row) return;
      writeScrollTop(element, top);
      landedRef.current = { key: row.key, top: element.scrollTop };
      anchorRef.current =
        row.type === 'fileHeader'
          ? {
              kind: 'row',
              key: row.key,
              path: row.path,
              offset: (layoutNow.offsets[index] ?? 0) - top,
            }
          : captureAnchor(layoutNow, top);
    };

    const pending = pendingScroll.current;
    if (pending) {
      // The rows do not reflect the status yet: keep the request until they do.
      if (syncedEntries.current !== entries) return;
      pendingScroll.current = null;
      const index = layoutNow.fileStart.findIndex(
        (start) => layoutNow.rows[start]?.path === pending.path,
      );
      const start = layoutNow.fileStart[index];
      if (index >= 0 && start !== undefined) {
        land(start, layoutNow.offsets[start] ?? 0);
        return;
      }
    }

    // A jump (next change, next file, Reviewed moving on). The row it names may have
    // been rebuilt under another key since (the file reloaded): the file's header then
    // stands in, and a file that is gone drops the request.
    const jump = navTarget.current;
    if (jump) {
      navTarget.current = null;
      let index = layoutNow.rows.findIndex((row) => row.key === jump.key);
      if (index < 0) index = layoutNow.rows.findIndex((row) => row.key === `${jump.path}|file`);
      if (index >= 0) {
        land(
          index,
          jumpTop({ ...layoutNow, scrollTop: element.scrollTop, landed: undefined }, index),
        );
        return;
      }
    }

    const anchor = anchorRef.current;
    if (!anchor) return;
    const top = restoredScrollTop(layoutNow, anchor);
    if (top !== null && Math.abs(top - element.scrollTop) >= 1) writeScrollTop(element, top);
    // A new layout, request or status is what calls for this, and each is read
    // through `anchorLayout` and the request refs rather than from the values.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, assembled, geometry, scrollRequest, entries, listElement, writeScrollTop]);

  // ── Chrome ────────────────────────────────────────────────────────────────
  const stepCode = useCallback(
    (delta: number) => setPreferences({ codeFontSize: clampFontSize(codeFontPx + delta) }),
    [setPreferences, codeFontPx],
  );
  // The bar's controls as one menu, for a pane too narrow to hold them beside the
  // title. The layout and the algorithm are radio sets and Wrap a check box, so the
  // current choice of each is announced (`aria-checked`) as well as drawn. The code
  // size is a stepper that leaves the menu open: one tap is rarely the size wanted.
  const viewItems = useMemo<DropdownMenuItemSpec[]>(
    () => [
      ...LAYOUT_OPTIONS.map((option) => ({
        id: `layout-${option.value}`,
        label: `${option.label} layout`,
        checked: host.layout === option.value,
        radioGroup: 'layout',
        onSelect: () => setPreferences({ scmLayout: option.value }),
      })),
      {
        id: 'wrap',
        label: layout === 'split' ? 'Side by side always wraps' : 'Wrap long lines',
        checked: wrap,
        disabled: layout === 'split',
        separatorBefore: true,
        onSelect: () => setPreferences({ scmWrap: !wrap }),
      },
      ...ALGORITHM_OPTIONS.map((option, i) => ({
        id: `algorithm-${option.value}`,
        label: `${option.label} diff`,
        checked: host.algorithm === option.value,
        radioGroup: 'algorithm',
        separatorBefore: i === 0,
        onSelect: () => setPreferences({ scmAlgorithm: option.value }),
      })),
      {
        id: 'code-size',
        label: 'Code font size',
        value: `${codeFontPx}`,
        decrease: {
          label: 'Smaller code',
          disabled: codeFontPx <= FONT_SIZE_MIN,
          onSelect: () => stepCode(-1),
        },
        increase: {
          label: 'Larger code',
          disabled: codeFontPx >= FONT_SIZE_MAX,
          onSelect: () => stepCode(1),
        },
        separatorBefore: true,
      },
    ],
    [host.layout, host.algorithm, layout, wrap, setPreferences, codeFontPx, stepCode],
  );

  const files = assembled.fileStart.length;
  const current = model.getEntries()[Math.min(currentFile, Math.max(0, files - 1))];
  const name = nameOf(repo);

  let message: string | null = null;
  if (removed) message = `Project removed. Add ${name} back in Source Control to read it again.`;
  else if (!status) message = paused ? 'Nothing loaded yet.' : 'Loading changes…';
  else if (entries.length === 0) {
    message = group === 'staged' ? 'No staged changes.' : 'No changes.';
  }

  return (
    <div
      className="pane-frame rv-frame"
      data-testid={`review-pane-${tabId}`}
      data-group={group}
      data-layout={layout}
      data-dense={compact ? 'true' : undefined}
      data-focused={focused ? 'true' : 'false'}
      style={codeStyle}
    >
      <div className="pane-header rv-bar" data-compact={compactBar ? 'true' : undefined}>
        <span className="rv-title" data-testid="review-title" title={repo}>
          {displayTitle(tab)}
        </span>
        <span className="rv-summary" data-testid="review-summary">
          {status && !removed ? summarize(entries) : ''}
        </span>
        <span className="spacer" />
        {compactBar ? (
          <DropdownMenu items={viewItems} testidPrefix="review-view-menu" align="end">
            <IconButton label="View options" data-testid="review-view-options">
              <Icon name="settings" size={16} />
            </IconButton>
          </DropdownMenu>
        ) : (
          <>
            <Segmented<ScmLayoutPref>
              label="Review layout"
              value={host.layout}
              options={LAYOUT_OPTIONS}
              onValueChange={(scmLayout) => host.setPreferences({ scmLayout })}
              data-testid="review-layout"
            />
            <Button
              size="sm"
              aria-pressed={wrap}
              disabled={layout === 'split'}
              title={layout === 'split' ? 'Side by side always wraps' : 'Wrap long lines'}
              data-testid="review-wrap"
              onClick={() => host.setPreferences({ scmWrap: !wrap })}
            >
              Wrap
            </Button>
            <span className="rv-algorithm">
              <Select
                value={host.algorithm}
                options={ALGORITHM_OPTIONS}
                onChange={(value) => {
                  if (isScmAlgorithm(value)) host.setPreferences({ scmAlgorithm: value });
                }}
                aria-label="Diff algorithm"
                data-testid="review-algorithm"
              />
            </span>
            <span className="rv-size" role="group" aria-label="Code font size">
              <Button
                size="sm"
                aria-label="Smaller code"
                disabled={codeFontPx <= FONT_SIZE_MIN}
                data-testid="review-code-smaller"
                onClick={() => stepCode(-1)}
              >
                −
              </Button>
              <span
                className="rv-size-value"
                aria-live="polite"
                aria-atomic="true"
                data-testid="review-code-size"
              >
                {codeFontPx}
              </span>
              <Button
                size="sm"
                aria-label="Larger code"
                disabled={codeFontPx >= FONT_SIZE_MAX}
                data-testid="review-code-larger"
                onClick={() => stepCode(1)}
              >
                +
              </Button>
            </span>
          </>
        )}
      </div>

      {paused && (
        <div className="rv-banner" role="status" data-testid="review-paused">
          <span>Paused ·</span>
          <Button size="sm" data-testid="review-activate" {...pressMove(() => host.activate(repo))}>
            Make {name} active
          </Button>
        </div>
      )}
      {notice !== null && (
        <div className="rv-banner rv-banner-error" role="alert" data-testid="review-notice">
          <span className="rv-banner-text">{notice}</span>
          <Button
            size="sm"
            data-testid="review-notice-dismiss"
            {...pressMove(() => setNotice(null))}
          >
            Dismiss
          </Button>
        </div>
      )}
      {!removed && live.error && (
        <div className="rv-banner rv-banner-error" role="alert" data-testid="review-error">
          Cannot read the changes: {live.error}
        </div>
      )}
      {!removed && status?.truncated && (
        <div className="rv-banner" role="status" data-testid="review-truncated">
          The list was truncated: only the first files are shown.
        </div>
      )}
      {showList && current && (
        <div className="rv-current" data-testid="review-current" title={current.path}>
          <span className="rv-current-path">{current.path}</span>
          <span className="rv-current-pos">
            {Math.min(currentFile, files - 1) + 1} / {files}
          </span>
        </div>
      )}

      <div className="rv-body" ref={bodyRef}>
        {showList ? (
          <VirtualList
            className="rv-list"
            rowCount={assembled.rows.length}
            rowHeight={rowHeight}
            rowComponent={ReviewRow}
            rowProps={rowProps}
            rowKey={rowKey}
            overscanCount={OVERSCAN_ROWS}
            defaultHeight={DEFAULT_LIST_HEIGHT}
            onRowsRendered={onRowsRendered}
            data-testid="review-list"
          >
            <BeforeList effect={restoreView} />
            {/* react-window sizes its scroller from the AVERAGE height of the rows it
                has laid out so far, so in a review whose files are thousands of
                pixels apart it is often far shorter than the rows, and the browser
                clamps a jump to a file past that point. This box holds the scroller
                to the real total, and review.css hides react-window's own spacer, so
                an estimate TALLER than the rows leaves no blank space under the last
                file either. Inline because the height is the geometry's. */}
            <div aria-hidden="true" className="rv-extent" style={extentStyle} />
          </VirtualList>
        ) : (
          <p
            className="rv-message"
            data-testid={removed ? 'review-removed' : 'review-message'}
            role="status"
          >
            {message}
          </p>
        )}
      </div>
      {selection && selection.phase !== 'drag' && writable && (
        <div className="rv-selection" role="status" data-testid="review-selection">
          <span className="rv-selection-text" data-testid="review-selection-text">
            {baseName(selection.path)} · {describeRange(rangeOf(selection))}
          </span>
          <Button
            size="sm"
            variant="primary"
            data-testid="review-comment-start"
            {...pressMove(startComment)}
          >
            Comment
          </Button>
          <Button
            size="sm"
            data-testid="review-selection-clear"
            {...pressMove(() => updateSelection(null))}
          >
            Clear
          </Button>
        </div>
      )}
    </div>
  );
};

export const ReviewPane = ({ tab, visible, focused }: ReviewPaneProps) => {
  const parsed = tab.url === undefined ? null : parseReviewUrl(tab.url);
  if (!parsed || tab.url === undefined) {
    return (
      <div className="pane-frame rv-frame" data-testid={`review-pane-${tab.id}`}>
        <p className="rv-message" role="alert">
          This review has no valid address.
        </p>
      </div>
    );
  }
  // Keyed by the address: a tab id recycled for another review starts clean.
  return (
    <ReviewView
      key={tab.url}
      tabId={tab.id}
      url={tab.url}
      repo={parsed.top}
      group={parsed.group}
      tab={tab}
      visible={visible}
      focused={focused}
    />
  );
};
