// ── Rows that arrive and leave on the micro tier ──────────────────────────────
//
// A list that drops a row the instant its data goes cannot fade it: the node is
// already unmounted. This hook keeps a removed item rendered, marked `leaving`,
// for `--mo-micro`, then lets it go. It also says when a row has just arrived, so
// the same wrapper can animate in.
//
// Each row sits in a wrapper that animates its OWN occupied space —
// `grid-template-rows: 1fr ↔ 0fr`, the kit Collapsible's technique — together with
// opacity. That is what makes the rows below glide: fading the row alone and then
// unmounting it makes them jump by its whole height when the node finally goes.
//
// It is state a stylesheet reads, not keyframes. A transition retargets when the
// change is interrupted (a row removed mid-enter, a removal undone mid-leave), a
// keyframe restarts from its first frame.
//
// `phase` is the pre-transition state, then the destination:
//   entering   the row has just been inserted and is drawn collapsed and clear
//   present    the destination of an enter, and the rest state
//   leaving    removed from the data, drawn collapsed and clear until it is dropped
// An `entering` row becomes `present` two animation frames after it commits: a
// transition needs a frame painted in the old state, and a flip in the same frame
// would have the browser see only the new one.
//
// `enter` is the tier an entrance runs on, and it lasts as long as the row does.
// The list's FIRST fill is the staggered tier (`--mo-enter` + `--mo-stagger` per
// item); a row inserted into a list that already exists is `micro`. A transition
// takes its duration and delay from the style it ends on, so the stylesheet needs
// this on the `present` row too, not just while it is `entering`. A leave resets
// it to `micro`, so a removal undone in time does not replay the stagger.
//
// "First fill" is the first time the list holds anything, not the first render:
// on a plain boot the drawer mounts with no tabs and fills on the first
// broadcast. A legacy `/<id>` boot is the exception: the drawer draws a row for
// that `current` before any broadcast, so that row is the first fill and the
// broadcast's others are insertions. A list that empties and fills again is not
// a first fill.
//
// Under reduced motion there is no transition to wait for: a removed row goes at
// once and an inserted one is `present` from its first frame.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type RowPhase = 'entering' | 'present' | 'leaving';
export type EnterTier = 'stagger' | 'micro';

export interface TrackedRow<T> {
  key: string;
  /** The live item; for a `leaving` row, the last one the list held. */
  item: T;
  phase: RowPhase;
  enter: EnterTier;
}

export interface LeavingItemsOptions {
  /**
   * How the list's first fill arrives: `stagger` (the default) or `none`, for a
   * list restored from saved state, which should simply be there.
   */
  initial?: 'stagger' | 'none';
}

const FALLBACK_MICRO_MS = 140;

/**
 * `--mo-micro` in milliseconds, or 0 under reduced motion. The stylesheet zeroes
 * the token there too; the media query is checked first because the token is only
 * known once a stylesheet defining it has loaded.
 */
export function microDurationMs(): number {
  if (typeof window === 'undefined') return FALLBACK_MICRO_MS;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--mo-micro').trim();
  const match = /^(\d*\.?\d+)(ms|s)$/.exec(raw);
  if (match === null) return FALLBACK_MICRO_MS;
  const [, amount, unit] = match;
  return Math.round(Number(amount) * (unit === 's' ? 1000 : 1));
}

interface Context {
  /** Whether the list has held anything before. */
  seeded: boolean;
  initial: 'stagger' | 'none';
  /** Read lazily: it touches the DOM, and most renders insert and remove nothing. */
  animates: () => boolean;
}

/**
 * The rows for `items`, given the rows the DOM currently shows. Removed rows stay
 * where they were: right after the nearest row before them that is still live.
 */
function reconcile<T>(
  shown: readonly TrackedRow<T>[],
  items: readonly T[],
  keyOf: (item: T) => string,
  ctx: Context,
): TrackedRow<T>[] {
  const shownByKey = new Map<string, TrackedRow<T>>();
  for (const row of shown) shownByKey.set(row.key, row);

  const live = new Set<string>();
  const liveRows: TrackedRow<T>[] = [];
  for (const item of items) {
    const key = keyOf(item);
    live.add(key);
    const was = shownByKey.get(key);
    if (was === undefined) {
      const first = !ctx.seeded;
      const quiet = !ctx.animates() || (first && ctx.initial === 'none');
      liveRows.push({
        key,
        item,
        phase: quiet ? 'present' : 'entering',
        enter: first ? 'stagger' : 'micro',
      });
    } else {
      // A row back before it finished leaving is the same row, retargeted to rest.
      const phase = was.phase === 'leaving' ? 'present' : was.phase;
      liveRows.push({ key, item, phase, enter: was.enter });
    }
  }

  const behind = new Map<string | null, TrackedRow<T>[]>();
  let anchor: string | null = null;
  for (const row of shown) {
    if (live.has(row.key)) {
      anchor = row.key;
      continue;
    }
    if (row.phase !== 'leaving' && !ctx.animates()) continue;
    const kept: TrackedRow<T> =
      row.phase === 'leaving'
        ? row
        : { key: row.key, item: row.item, phase: 'leaving', enter: 'micro' };
    const queue = behind.get(anchor);
    if (queue === undefined) behind.set(anchor, [kept]);
    else queue.push(kept);
  }

  const rows: TrackedRow<T>[] = [...(behind.get(null) ?? [])];
  for (const row of liveRows) {
    rows.push(row);
    const trailing = behind.get(row.key);
    if (trailing !== undefined) rows.push(...trailing);
  }
  return rows;
}

/**
 * `items` as rows that can animate in and out. Render `rows` in order, wrapping
 * each in an element that carries `phase` and `enter`.
 */
export function useLeavingItems<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  { initial = 'stagger' }: LeavingItemsOptions = {},
): TrackedRow<T>[] {
  // What the DOM shows. Written on commit and by the timers below, read while
  // rendering: a removed row has to be in THIS render's output, so deriving it in
  // an effect would paint one frame without it and then bring it back.
  const shown = useRef<TrackedRow<T>[]>([]);
  const seeded = useRef(false);
  const dropTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const flipping = useRef(new Set<string>());
  const frames = useRef(new Set<number>());
  const [, setTick] = useState(0);

  let animatesNow: boolean | undefined;
  const rows = reconcile(shown.current, items, keyOf, {
    seeded: seeded.current,
    initial,
    animates: () => (animatesNow ??= microDurationMs() > 0),
  });

  useLayoutEffect(() => {
    shown.current = rows;
    if (rows.some((row) => row.phase !== 'leaving')) seeded.current = true;

    const leaving = new Set<string>();
    const arrived: string[] = [];
    for (const row of rows) {
      if (row.phase === 'leaving') leaving.add(row.key);
      else if (row.phase === 'entering' && !flipping.current.has(row.key)) arrived.push(row.key);
    }

    // A leave undone (the key is back) must not drop the row it brought back.
    for (const [key, timer] of dropTimers.current) {
      if (leaving.has(key)) continue;
      clearTimeout(timer);
      dropTimers.current.delete(key);
    }
    for (const key of leaving) {
      if (dropTimers.current.has(key)) continue;
      dropTimers.current.set(
        key,
        setTimeout(() => {
          dropTimers.current.delete(key);
          shown.current = shown.current.filter((row) => row.key !== key || row.phase !== 'leaving');
          setTick((n) => n + 1);
        }, microDurationMs()),
      );
    }

    if (arrived.length === 0) return;
    const batch = new Set(arrived);
    for (const key of arrived) flipping.current.add(key);
    const outer = requestAnimationFrame(() => {
      frames.current.delete(outer);
      const inner = requestAnimationFrame(() => {
        frames.current.delete(inner);
        for (const key of batch) flipping.current.delete(key);
        const next: TrackedRow<T>[] = [];
        for (const row of shown.current) {
          next.push(
            batch.has(row.key) && row.phase === 'entering'
              ? { key: row.key, item: row.item, phase: 'present', enter: row.enter }
              : row,
          );
        }
        shown.current = next;
        setTick((n) => n + 1);
      });
      frames.current.add(inner);
    });
    frames.current.add(outer);
  });

  // Nothing may fire into an unmounted list. Strict Mode's simulated remount runs
  // this cleanup and then the layout effect again, which re-arms what it cleared.
  useEffect(() => {
    const timers = dropTimers.current;
    const pending = flipping.current;
    const scheduled = frames.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      pending.clear();
      for (const frame of scheduled) cancelAnimationFrame(frame);
      scheduled.clear();
    };
  }, []);

  return rows;
}
