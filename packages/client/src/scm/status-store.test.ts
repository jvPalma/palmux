// The store's promises are all about TIME and about WHO is counted, so every test
// runs on fake timers with an injected reader: nothing here touches the network.
// The scenario names follow the `source-control` spec ("The list stays live",
// "Only the active project is read").

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScmEntry, ScmStatus } from '@palmux/shared';
import type { ScmFetchResult } from './scm-api';
import {
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  createScmStatusStore,
  nextReadDelay,
  resolveActiveRepo,
  sameStatus,
  scmStatusStore,
  useScmStatus,
  type ScmStatusStore,
} from './status-store';

const entry = (path: string, over: Partial<ScmEntry> = {}): ScmEntry => ({
  path,
  kind: 'ordinary',
  status: 'M',
  fp: `fp-${path}`,
  ...over,
});

const status = (over: Partial<ScmStatus> = {}): ScmStatus => ({
  top: '/work/a',
  branch: 'main',
  unborn: false,
  merge: [],
  staged: [],
  changes: [],
  truncated: false,
  tookMs: 10,
  commentsRev: 0,
  attrEpoch: 'e0',
  ...over,
});

const ok = (value: ScmStatus): ScmFetchResult<ScmStatus> => ({ ok: true, value });
const bad = (message: string): ScmFetchResult<ScmStatus> => ({
  ok: false,
  message,
  httpStatus: 400,
});

const A = '/work/a';
const B = '/work/b';

type Reader = (repo: string, signal: AbortSignal) => Promise<ScmFetchResult<ScmStatus>>;

let foreground = true;
const setForeground = (value: boolean): void => {
  foreground = value;
  document.dispatchEvent(new Event('visibilitychange'));
};

/** A store whose reader answers `answer(repo, n)` immediately, n counting from 1. */
function setup(
  answer: (repo: string, n: number) => ScmFetchResult<ScmStatus> = () => ok(status()),
) {
  const calls: string[] = [];
  const fetchStatus = vi.fn<Reader>((repo) => {
    calls.push(repo);
    return Promise.resolve(answer(repo, calls.length));
  });
  const store = createScmStatusStore({ fetchStatus, isForeground: () => foreground });
  return { store, fetchStatus, calls };
}

/** Register a subscriber and say what it shows. */
function join(store: ScmStatusStore, repo: string, visible: boolean) {
  const subscription = store.register();
  subscription.set(repo, visible);
  return subscription;
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  foreground = true;
});

afterEach(() => {
  cleanup();
  scmStatusStore.setActiveRepo('');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('nextReadDelay', () => {
  it('is max(1000, 3 × tookMs), capped at 10 s', () => {
    expect(nextReadDelay(0)).toBe(MIN_INTERVAL_MS);
    expect(nextReadDelay(10)).toBe(1000);
    expect(nextReadDelay(333)).toBe(1000);
    expect(nextReadDelay(900)).toBe(2700);
    expect(nextReadDelay(5000)).toBe(MAX_INTERVAL_MS);
    expect(nextReadDelay(60_000)).toBe(10_000);
  });

  // `tookMs` is off the wire. NaN would be a NaN delay, which setTimeout runs as 0,
  // so a bad value must land on the floor and never on a hot loop.
  it('treats a tookMs that is not a finite, non-negative number as 0', () => {
    for (const bad of [Number.NaN, -1, -500, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(nextReadDelay(bad), String(bad)).toBe(MIN_INTERVAL_MS);
    }
  });
});

describe('The list stays live', () => {
  it('keeps to the interval floor when an answer carries a tookMs that is not a number', async () => {
    for (const tookMs of [Number.NaN, -3]) {
      const { store, calls } = setup(() => ok(status({ tookMs })));
      store.setActiveRepo(A);
      const subscription = join(store, A, true);
      await tick(0);
      expect(calls).toHaveLength(1);
      await tick(MIN_INTERVAL_MS - 1);
      expect(calls, `tookMs ${tookMs}`).toHaveLength(1);
      await tick(1);
      expect(calls).toHaveLength(2);
      subscription.release();
      store.setActiveRepo('');
    }
  });

  it('reads at once when the first subscriber counts, then every second on a fast project', async () => {
    const { store, calls } = setup();
    store.setActiveRepo(A);
    join(store, A, true);
    await tick(0);
    expect(calls).toHaveLength(1);
    await tick(999);
    expect(calls).toHaveLength(1);
    await tick(1);
    expect(calls).toHaveLength(2);
    await tick(1000);
    expect(calls).toHaveLength(3);
  });

  it('shows an edit within 2 seconds on a project that answers in under 300 ms', async () => {
    const { store } = setup((_repo, n) =>
      ok(status({ tookMs: 200, changes: n > 1 ? [entry('saved.ts')] : [] })),
    );
    store.setActiveRepo(A);
    join(store, A, true);
    await tick(0);
    expect(store.getState().status?.changes).toEqual([]);
    // 3 × 200 ms is under the 1 s floor, so the next read is one second out.
    await tick(1000);
    expect(store.getState().status?.changes.map((e) => e.path)).toEqual(['saved.ts']);
  });

  it('a hidden view costs nothing, however long the window stays open', async () => {
    const { store, fetchStatus } = setup();
    store.setActiveRepo(A);
    join(store, A, false);
    await tick(60 * 60 * 1000);
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it('stops reading once the view is hidden, and stays stopped for an hour', async () => {
    const { store, fetchStatus } = setup();
    store.setActiveRepo(A);
    const view = join(store, A, true);
    await tick(0);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    view.set(A, false);
    await tick(60 * 60 * 1000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it('stops reading when the last subscriber leaves', async () => {
    const { store, fetchStatus } = setup();
    store.setActiveRepo(A);
    const view = join(store, A, true);
    await tick(2500);
    const before = fetchStatus.mock.calls.length;
    expect(before).toBeGreaterThan(1);
    view.release();
    await tick(60_000);
    expect(fetchStatus).toHaveBeenCalledTimes(before);
  });

  it('runs no read for a window in the background, and reads at once when it returns', async () => {
    foreground = false;
    const { store, fetchStatus } = setup();
    store.setActiveRepo(A);
    join(store, A, true);
    await tick(60_000);
    expect(fetchStatus).not.toHaveBeenCalled();

    setForeground(true);
    // No timer to wait for: the refresh is at once, not at the next interval.
    await tick(0);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it('a window sent to the background stops the running cycle and refreshes on return', async () => {
    const { store, fetchStatus } = setup();
    store.setActiveRepo(A);
    join(store, A, true);
    await tick(0);
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    setForeground(false);
    await tick(60 * 60 * 1000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    setForeground(true);
    await tick(0);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it('a slow repository waits longer between reads and never starts one while another runs', async () => {
    let release: (r: ScmFetchResult<ScmStatus>) => void = () => {};
    const fetchStatus = vi.fn<Reader>(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const store = createScmStatusStore({ fetchStatus, isForeground: () => foreground });
    store.setActiveRepo(A);
    join(store, A, true);
    await tick(0);
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    // The read is still running a minute later: nothing else starts.
    await tick(60_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    release(ok(status({ tookMs: 900 })));
    await tick(2699);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it('caps the wait at 10 s for a very slow project', async () => {
    const { store, fetchStatus } = setup(() => ok(status({ tookMs: 8000 })));
    store.setActiveRepo(A);
    join(store, A, true);
    await tick(0);
    await tick(9999);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it('two visible subscribers share one timer: one read per interval, not two', async () => {
    const { store, fetchStatus } = setup();
    store.setActiveRepo(A);
    join(store, A, true);
    join(store, A, true);
    await tick(0);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await tick(1000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await tick(1000);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it('keeps reading while one of two subscribers is still visible', async () => {
    const { store, fetchStatus } = setup();
    store.setActiveRepo(A);
    const first = join(store, A, true);
    join(store, A, true);
    await tick(0);
    first.release();
    await tick(1000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it('a subscriber joining a running cycle does not start a second one', async () => {
    const { store, fetchStatus } = setup();
    store.setActiveRepo(A);
    join(store, A, true);
    await tick(500);
    join(store, A, true);
    await tick(0);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it('backs off after a failure (1 s, 2 s, 4 s … up to 10 s) and recovers on the next answer', async () => {
    const { store, fetchStatus } = setup((_repo, n) =>
      n <= 5 ? bad('repo is gone') : ok(status({ changes: [entry('back.ts')] })),
    );
    store.setActiveRepo(A);
    join(store, A, true);
    await tick(0); // fails: wait 1 s
    expect(store.getState().error).toBe('repo is gone');
    await tick(999);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await tick(1); // fails again: wait 2 s
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await tick(2000); // 3rd, fails: wait 4 s
    expect(fetchStatus).toHaveBeenCalledTimes(3);
    await tick(4000); // 4th, fails: wait 8 s
    expect(fetchStatus).toHaveBeenCalledTimes(4);
    await tick(8000); // 5th, fails: wait 10 s (capped)
    expect(fetchStatus).toHaveBeenCalledTimes(5);
    await tick(10_000);
    expect(fetchStatus).toHaveBeenCalledTimes(6);
    expect(store.getState().error).toBeNull();
    expect(store.getState().status?.changes).toHaveLength(1);
  });

  it('keeps the last good status on screen while a later read fails', async () => {
    const { store } = setup((_repo, n) =>
      n === 1 ? ok(status({ changes: [entry('kept.ts')] })) : bad('timed out'),
    );
    store.setActiveRepo(A);
    join(store, A, true);
    await tick(1000);
    expect(store.getState().error).toBe('timed out');
    expect(store.getState().status?.changes.map((e) => e.path)).toEqual(['kept.ts']);
  });

  it('refresh() reads now, without waiting out the interval, and not for a hidden store', async () => {
    const { store, fetchStatus } = setup();
    store.setActiveRepo(A);
    const view = join(store, A, true);
    await tick(0);
    store.refresh();
    await tick(0);
    expect(fetchStatus).toHaveBeenCalledTimes(2);

    view.set(A, false);
    store.refresh();
    await tick(0);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });
});

describe('Only the active project is read', () => {
  it('a hidden subscriber and a visible one of another project trigger no request', async () => {
    const { store, fetchStatus } = setup();
    store.setActiveRepo(A);
    join(store, A, false);
    join(store, B, true);
    await tick(60_000);
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it('with nothing active, even a visible subscriber reads nothing', async () => {
    const { store, fetchStatus } = setup();
    join(store, A, true);
    join(store, '', true);
    await tick(60_000);
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it('two reviews of different projects read only the active one', async () => {
    const { store, calls } = setup();
    store.setActiveRepo(A);
    join(store, A, true);
    join(store, B, true);
    await tick(5000);
    expect(calls.length).toBeGreaterThan(1);
    expect(new Set(calls)).toEqual(new Set([A]));
  });

  it('switching the active project reads only the new one from then on', async () => {
    const { store, calls } = setup((repo) => ok(status({ top: repo })));
    store.setActiveRepo(A);
    join(store, A, true);
    join(store, B, true);
    await tick(2000);
    expect(new Set(calls)).toEqual(new Set([A]));

    calls.length = 0;
    store.setActiveRepo(B);
    await tick(5000);
    expect(calls.length).toBeGreaterThan(1);
    expect(new Set(calls)).toEqual(new Set([B]));
    expect(store.getState().repo).toBe(B);
  });

  it('drops the old project’s data on a switch, and the old answer that arrives late', async () => {
    let release: (r: ScmFetchResult<ScmStatus>) => void = () => {};
    const fetchStatus = vi.fn<Reader>((repo) =>
      repo === A
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(ok(status({ top: B, changes: [entry('b.ts')] }))),
    );
    const store = createScmStatusStore({ fetchStatus, isForeground: () => foreground });
    store.setActiveRepo(A);
    join(store, A, true);
    join(store, B, true);
    await tick(0);

    store.setActiveRepo(B);
    expect(store.getState()).toMatchObject({ repo: B, status: null });
    await tick(0);
    expect(store.getState().status?.top).toBe(B);

    release(ok(status({ top: A, changes: [entry('a.ts')] })));
    await tick(0);
    expect(store.getState().status?.top).toBe(B);
  });

  it('aborts the read of a project that stops being active', async () => {
    const signals: AbortSignal[] = [];
    const fetchStatus = vi.fn<Reader>((_repo, signal) => {
      signals.push(signal);
      return new Promise(() => {});
    });
    const store = createScmStatusStore({ fetchStatus, isForeground: () => foreground });
    store.setActiveRepo(A);
    join(store, A, true);
    await tick(0);
    store.setActiveRepo('');
    expect(signals[0]?.aborted).toBe(true);
  });

  it('a project becoming active with a visible subscriber waiting reads at once', async () => {
    const { store, calls } = setup();
    join(store, B, true);
    await tick(10_000);
    expect(calls).toEqual([]);
    store.setActiveRepo(B);
    await tick(0);
    expect(calls).toEqual([B]);
  });
});

describe('what the store exposes', () => {
  it('holds the latest status, commentsRev and attrEpoch', async () => {
    const { store } = setup((_repo, n) =>
      ok(status({ commentsRev: n, attrEpoch: `e${n}`, changes: [entry('a.ts')] })),
    );
    store.setActiveRepo(A);
    join(store, A, true);
    await tick(0);
    expect(store.getState()).toMatchObject({
      repo: A,
      commentsRev: 1,
      attrEpoch: 'e1',
      error: null,
    });
    expect(store.getState().status?.changes).toHaveLength(1);
    await tick(1000);
    expect(store.getState()).toMatchObject({ commentsRev: 2, attrEpoch: 'e2' });
  });

  it('keeps the same state object while an answer shows nothing new, so nothing re-renders', async () => {
    const { store } = setup((_repo, n) =>
      ok(status({ tookMs: n * 3, changes: [entry('same.ts')] })),
    );
    const heard = vi.fn();
    store.subscribe(heard);
    store.setActiveRepo(A);
    heard.mockClear();
    join(store, A, true);
    await tick(0);
    const first = store.getState();
    expect(heard).toHaveBeenCalledTimes(1);
    await tick(1000);
    await tick(1000);
    expect(store.getState()).toBe(first);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('announces a change in a fingerprint, a group or the truncation flag', async () => {
    const answers = [
      status({ changes: [entry('a.ts')] }),
      status({ changes: [entry('a.ts', { fp: 'other' })] }),
      status({ changes: [entry('a.ts', { fp: 'other' })], staged: [entry('b.ts')] }),
      status({
        changes: [entry('a.ts', { fp: 'other' })],
        staged: [entry('b.ts')],
        truncated: true,
      }),
    ];
    const { store } = setup((_repo, n) => ok(answers[n - 1] ?? (answers.at(-1) as ScmStatus)));
    store.setActiveRepo(A);
    join(store, A, true);
    const seen = new Set<ScmStatus | null>();
    await tick(0);
    seen.add(store.getState().status);
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- each read waits for the one before
      await tick(1000);
      seen.add(store.getState().status);
    }
    expect(seen.size).toBe(4);
  });

  it('sameStatus ignores tookMs and nothing else', () => {
    expect(sameStatus(status({ tookMs: 1 }), status({ tookMs: 99 }))).toBe(true);
    expect(sameStatus(status(), status({ branch: 'dev' }))).toBe(false);
    expect(sameStatus(status(), status({ head: 'abc' }))).toBe(false);
    expect(sameStatus(status(), status({ unborn: true }))).toBe(false);
    expect(sameStatus(status(), status({ attrEpoch: 'x' }))).toBe(false);
    expect(sameStatus(status(), status({ commentsRev: 1 }))).toBe(false);
    expect(
      sameStatus(
        status({ changes: [entry('a.ts', { added: 1 })] }),
        status({ changes: [entry('a.ts', { added: 2 })] }),
      ),
    ).toBe(false);
    expect(
      sameStatus(
        status({ merge: [entry('a.ts', { oldPath: 'x.ts' })] }),
        status({ merge: [entry('a.ts')] }),
      ),
    ).toBe(false);
  });

  it('touches the document only while someone is subscribed', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const { store } = setup();
    const visibilityCalls = (spy: typeof add) =>
      spy.mock.calls.filter(([type]) => type === 'visibilitychange').length;
    expect(visibilityCalls(add)).toBe(0);
    const one = store.register();
    const two = store.register();
    expect(visibilityCalls(add)).toBe(1);
    one.release();
    expect(visibilityCalls(remove)).toBe(0);
    two.release();
    two.release(); // releasing twice is harmless
    expect(visibilityCalls(remove)).toBe(1);
    add.mockRestore();
    remove.mockRestore();
  });
});

describe('resolveActiveRepo', () => {
  it('keeps the stored choice while it is in the list', () => {
    expect(resolveActiveRepo([A, B], B)).toBe(B);
  });

  it('falls to the first project when the stored one is gone or was never chosen', () => {
    expect(resolveActiveRepo([A, B], '/work/removed')).toBe(A);
    expect(resolveActiveRepo([A, B], '')).toBe(A);
  });

  it('is none for an empty list', () => {
    expect(resolveActiveRepo([], A)).toBe('');
  });
});

describe('useScmStatus', () => {
  const stubStatusFetch = (body: (repo: string) => ScmStatus) => {
    const fn = vi.fn((url: string) => {
      const repo = decodeURIComponent(new URL(url, 'http://x').searchParams.get('repo') ?? '');
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body(repo)) });
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  };

  it('reads the active project while visible and hands back its status', async () => {
    const fetchFn = stubStatusFetch((repo) => status({ top: repo, changes: [entry('a.ts')] }));
    scmStatusStore.setActiveRepo(A);
    const { result } = renderHook(() => useScmStatus(A, true));
    await act(() => tick(0));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[0]).toBe('/scm/status?repo=%2Fwork%2Fa');
    expect(result.current.active).toBe(true);
    expect(result.current.status?.changes.map((e) => e.path)).toEqual(['a.ts']);
  });

  it('is inert for a project that is not the active one', async () => {
    const fetchFn = stubStatusFetch((repo) => status({ top: repo }));
    scmStatusStore.setActiveRepo(A);
    const { result } = renderHook(() => useScmStatus(B, true));
    await act(() => tick(60_000));
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ active: false, repo: B, status: null });
  });

  it('is inert while not visible, and starts reading when it becomes visible', async () => {
    const fetchFn = stubStatusFetch((repo) => status({ top: repo }));
    scmStatusStore.setActiveRepo(A);
    const { rerender } = renderHook(({ visible }) => useScmStatus(A, visible), {
      initialProps: { visible: false },
    });
    await act(() => tick(60_000));
    expect(fetchFn).not.toHaveBeenCalled();
    rerender({ visible: true });
    await act(() => tick(0));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('leaves nothing running when the component unmounts', async () => {
    const fetchFn = stubStatusFetch((repo) => status({ top: repo }));
    scmStatusStore.setActiveRepo(A);
    const { unmount } = renderHook(() => useScmStatus(A, true));
    await act(() => tick(0));
    unmount();
    await act(() => tick(60_000));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('follows the project that becomes active', async () => {
    const fetchFn = stubStatusFetch((repo) => status({ top: repo }));
    const { result } = renderHook(() => useScmStatus(B, true));
    await act(() => tick(10_000));
    expect(fetchFn).not.toHaveBeenCalled();
    act(() => scmStatusStore.setActiveRepo(B));
    await act(() => tick(0));
    expect(result.current.active).toBe(true);
    expect(result.current.status?.top).toBe(B);
  });
});
