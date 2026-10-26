// ── Source Control status store ───────────────────────────────────────────────
//
// ONE store per window, holding the status of the device's ACTIVE project only.
// The Source Control view and every review pane read it through
// `useScmStatus(repo, visible)`, and a subscription COUNTS only when it is visible
// and `repo` is the active project. That one rule is what makes both promises
// true at once: a hidden view costs nothing, and an inactive project is never
// read, however many reviews of it are open.
//
// Polling, not watching (an inotify watch per directory is a firehose on build
// output — the reason the Explorer polls too). While at least one subscriber
// counts AND the window is in the foreground, one request is in flight at a time,
// and the next starts `max(1000, 3 × tookMs)` ms after the previous answer, capped
// at 10 s: palmux (10 ms) refreshes every second and a 900 ms repository every
// 2.7 s, so a slow project reads less often instead of stacking reads. Nothing
// counting, or a background window, means no timer and no request. Coming back to
// the foreground reads at once: the timer was cleared on the way out, so the next
// subscriber check finds nothing pending.
//
// `commentsRev` and `attrEpoch` ride on the status answer and are surfaced as
// state of their own so the review pane (batch C) and the comment store
// (batch D) can react to just those without diffing a whole status.

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ScmEntry, ScmStatus } from '@palmux/shared';
import { fetchScmStatus, type ScmFetchResult } from './scm-api';

/** Never poll faster than this, however fast git answers. */
export const MIN_INTERVAL_MS = 1000;
/** Never wait longer than this between reads, however slow git is. */
export const MAX_INTERVAL_MS = 10_000;

/**
 * How long to wait after an answer that took `tookMs` to produce.
 *
 * `tookMs` comes off the wire, and a NaN here would be a NaN delay, which
 * `setTimeout` runs as 0: a hot poll loop. Anything that is not a finite,
 * non-negative number counts as 0, which is the 1 s floor.
 */
export const nextReadDelay = (tookMs: number): number => {
  const took = Number.isFinite(tookMs) && tookMs >= 0 ? tookMs : 0;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, 3 * took));
};

/** After `failures` reads in a row that failed: 1 s, 2 s, 4 s … up to the cap. */
const retryDelay = (failures: number): number =>
  Math.min(MAX_INTERVAL_MS, MIN_INTERVAL_MS * 2 ** (failures - 1));

export interface ScmStatusState {
  /** The project this state belongs to: the device's active one, '' for none. */
  repo: string;
  /** The last good answer for `repo`; kept while a later read fails. */
  status: ScmStatus | null;
  /** Why the latest read failed; null once one succeeds. */
  error: string | null;
  commentsRev: number;
  attrEpoch: string;
}

const emptyState = (repo: string): ScmStatusState => ({
  repo,
  status: null,
  error: null,
  commentsRev: 0,
  attrEpoch: '',
});

const sameEntry = (a: ScmEntry, b: ScmEntry): boolean =>
  a.fp === b.fp &&
  a.path === b.path &&
  a.oldPath === b.oldPath &&
  a.kind === b.kind &&
  a.status === b.status &&
  a.added === b.added &&
  a.removed === b.removed &&
  a.binary === b.binary;

const sameEntries = (a: ScmEntry[], b: ScmEntry[]): boolean =>
  a.length === b.length && a.every((entry, i) => sameEntry(entry, b[i] as ScmEntry));

/**
 * Whether two answers show the same thing. `tookMs` is how long git took, not
 * what it said, so it is left out: without this every poll of an unchanged
 * project would hand `useSyncExternalStore` a new object and re-render the list.
 */
export function sameStatus(a: ScmStatus, b: ScmStatus): boolean {
  return (
    a.top === b.top &&
    a.branch === b.branch &&
    a.head === b.head &&
    a.unborn === b.unborn &&
    a.truncated === b.truncated &&
    a.commentsRev === b.commentsRev &&
    a.attrEpoch === b.attrEpoch &&
    sameEntries(a.merge, b.merge) &&
    sameEntries(a.staged, b.staged) &&
    sameEntries(a.changes, b.changes)
  );
}

export interface ScmSubscription {
  /** Say which project this subscriber shows and whether it is on screen. */
  set(repo: string, visible: boolean): void;
  release(): void;
}

export interface ScmStatusStore {
  getState(): ScmStatusState;
  subscribe(listener: () => void): () => void;
  /** The device's active project. Changing it drops the old project's state. */
  setActiveRepo(repo: string): void;
  /** Join as a subscriber. It counts only while `visible` and on the active project. */
  register(): ScmSubscription;
  /** Read now (a Retry, or after a write), if anything counts. */
  refresh(): void;
}

export interface ScmStatusStoreOptions {
  fetchStatus?: (repo: string, signal: AbortSignal) => Promise<ScmFetchResult<ScmStatus>>;
  /** Whether the window is in the foreground. */
  isForeground?: () => boolean;
}

const documentVisible = (): boolean => document.visibilityState === 'visible';

export function createScmStatusStore(options: ScmStatusStoreOptions = {}): ScmStatusStore {
  const fetchStatus = options.fetchStatus ?? fetchScmStatus;
  const isForeground = options.isForeground ?? documentVisible;

  interface Registration {
    repo: string;
    visible: boolean;
  }
  const registrations = new Set<Registration>();
  const listeners = new Set<() => void>();

  let activeRepo = '';
  let state = emptyState('');
  let timer: ReturnType<typeof setTimeout> | null = null;
  // A read in flight, told apart from a stale one by identity: an answer whose
  // read is no longer `inflight` was superseded or aborted and is dropped.
  let inflight: { controller: AbortController } | null = null;
  let failures = 0;

  const emit = (): void => {
    for (const listener of listeners) listener();
  };

  const counts = (r: Registration): boolean => r.visible && r.repo !== '' && r.repo === activeRepo;
  const shouldRead = (): boolean =>
    activeRepo !== '' && isForeground() && [...registrations].some(counts);

  const clearTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const stop = (): void => {
    clearTimer();
    if (!inflight) return;
    inflight.controller.abort();
    inflight = null;
  };

  const apply = (next: ScmStatus): void => {
    const same = state.status !== null && sameStatus(state.status, next);
    if (same && state.error === null) return;
    state = {
      repo: state.repo,
      status: same ? state.status : next,
      error: null,
      commentsRev: next.commentsRev,
      attrEpoch: next.attrEpoch,
    };
    emit();
  };

  const fail = (message: string): void => {
    if (state.error === message) return;
    state = { ...state, error: message };
    emit();
  };

  const read = async (): Promise<void> => {
    const mine = { controller: new AbortController() };
    inflight = mine;
    const result = await fetchStatus(activeRepo, mine.controller.signal);
    if (inflight !== mine) return;
    inflight = null;
    let delay: number;
    if (result.ok) {
      failures = 0;
      apply(result.value);
      delay = nextReadDelay(result.value.tookMs);
    } else {
      failures += 1;
      fail(result.message);
      delay = retryDelay(failures);
    }
    timer = setTimeout(() => {
      timer = null;
      pump();
    }, delay);
  };

  /** Bring the timer and the request in line with who is subscribed and visible. */
  function pump(): void {
    if (!shouldRead()) {
      stop();
      return;
    }
    if (timer !== null || inflight) return;
    void read();
  }

  const onVisibilityChange = (): void => pump();

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setActiveRepo(repo) {
      if (repo === activeRepo) return;
      activeRepo = repo;
      stop();
      failures = 0;
      state = emptyState(repo);
      emit();
      pump();
    },

    register() {
      const registration: Registration = { repo: '', visible: false };
      // The listener lives only while someone is subscribed, so importing this
      // module — or an app with the view closed — touches nothing.
      if (registrations.size === 0)
        document.addEventListener('visibilitychange', onVisibilityChange);
      registrations.add(registration);
      return {
        set(repo, visible) {
          if (registration.repo === repo && registration.visible === visible) return;
          registration.repo = repo;
          registration.visible = visible;
          pump();
        },
        release() {
          if (!registrations.delete(registration)) return;
          if (registrations.size === 0) {
            document.removeEventListener('visibilitychange', onVisibilityChange);
          }
          pump();
        },
      };
    },

    refresh() {
      if (!shouldRead()) return;
      clearTimer();
      if (!inflight) void read();
    },
  };
}

/** The window's one store. */
export const scmStatusStore: ScmStatusStore = createScmStatusStore();

/**
 * The project this device reads: its stored choice when that is still in the
 * synced list, else the first project, else none. A project another device
 * removed must not leave this one pointing at nothing.
 */
export function resolveActiveRepo(repos: readonly string[], stored: string): string {
  return repos.includes(stored) ? stored : (repos[0] ?? '');
}

export interface ScmStatusResult extends ScmStatusState {
  /** `repo` is the device's active project, the only one the store reads. */
  active: boolean;
}

/**
 * The status of `repo`, and the subscription that keeps it fresh. The subscription
 * counts only while `visible` and while `repo` is the active project; a `repo` that
 * is not active gets an empty state with `active: false` and costs nothing.
 */
export function useScmStatus(repo: string, visible: boolean): ScmStatusResult {
  const state = useSyncExternalStore(
    scmStatusStore.subscribe,
    scmStatusStore.getState,
    scmStatusStore.getState,
  );
  const subscription = useRef<ScmSubscription | null>(null);
  useEffect(() => {
    const joined = scmStatusStore.register();
    subscription.current = joined;
    return () => {
      subscription.current = null;
      joined.release();
    };
  }, []);
  // Declared after the registering effect, so on mount it runs against it.
  useEffect(() => {
    subscription.current?.set(repo, visible);
  }, [repo, visible]);
  return useMemo(
    () =>
      state.repo === repo && repo !== ''
        ? { ...state, active: true }
        : { ...emptyState(repo), active: false },
    [state, repo],
  );
}
