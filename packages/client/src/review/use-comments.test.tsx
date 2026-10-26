// The window's comments store as the app wires it: the hook counts only a visible
// subscriber of the active project, and a newer rev heard of on a status answer
// makes a visible window read the list (the backstop for a missed `scmComments`
// frame, which is the other way a window hears).

import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScmStatus } from '@palmux/shared';
import {
  createScmStatusStore,
  type ScmStatusStore,
  type ScmStatusState,
} from '../scm/status-store';
import { createCommentsStore } from './comments-store';
import { commentsStore, connectCommentsToStatus, useComments } from './use-comments';

const REPO = '/work/app';
const OTHER = '/work/lib';

const comment = (id: string) => ({
  id,
  path: 'a.ts',
  version: 'worktree',
  side: 'new',
  start: 1,
  end: 1,
  lines: ['x'],
  before: [],
  after: [],
  body: id,
  createdAt: 1,
  updatedAt: 1,
});

const reply = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

let fetched: string[];
beforeEach(() => {
  fetched = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      fetched.push(url);
      return reply({ rev: 1, comments: [comment('c1')] });
    }),
  );
});
afterEach(() => {
  cleanup();
  commentsStore.setActiveRepo('');
  vi.unstubAllGlobals();
});

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

describe('useComments', () => {
  it('reads the active project’s list while a subscriber is visible, and answers it', async () => {
    commentsStore.setActiveRepo(REPO);
    const { result } = renderHook(() => useComments(REPO, true));
    await settle();
    expect(fetched).toEqual([`/scm/comments?repo=${encodeURIComponent(REPO)}`]);
    expect(result.current).toMatchObject({ active: true, loaded: true, rev: 1 });
    expect(result.current.comments.map((c) => c.id)).toEqual(['c1']);
  });

  it('reads nothing for a hidden subscriber, and reads as soon as it is shown', async () => {
    commentsStore.setActiveRepo(REPO);
    const { rerender } = renderHook(({ visible }) => useComments(REPO, visible), {
      initialProps: { visible: false },
    });
    await settle();
    expect(fetched).toEqual([]);
    rerender({ visible: true });
    await settle();
    expect(fetched).toHaveLength(1);
  });

  it('reads nothing for a visible subscriber of a project that is not the active one', async () => {
    commentsStore.setActiveRepo(REPO);
    const { result } = renderHook(() => useComments(OTHER, true));
    await settle();
    expect(fetched).toEqual([]);
    expect(result.current).toMatchObject({ active: false, loaded: false, comments: [] });
  });

  it('stops counting when the last subscriber goes away', async () => {
    commentsStore.setActiveRepo(REPO);
    const { unmount } = renderHook(() => useComments(REPO, true));
    await settle();
    unmount();
    commentsStore.observeRev(REPO, 9);
    await settle();
    expect(fetched).toHaveLength(1);
  });

  it('is empty for no project at all', () => {
    const { result } = renderHook(() => useComments('', true));
    expect(result.current).toMatchObject({ active: false, comments: [] });
  });
});

describe('connectCommentsToStatus', () => {
  const state = (over: Partial<ScmStatusState> = {}): ScmStatusState => ({
    repo: REPO,
    status: { top: REPO } as ScmStatus,
    error: null,
    commentsRev: 0,
    attrEpoch: '',
    ...over,
  });

  function fakeStatus(initial: ScmStatusState) {
    let current = initial;
    const listeners = new Set<() => void>();
    const store = {
      getState: () => current,
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    } as unknown as ScmStatusStore;
    return {
      store,
      set: (next: ScmStatusState) => {
        current = next;
        for (const l of listeners) l();
      },
      listeners,
    };
  }

  it('tells the store the rev of every status answer', () => {
    const observed: [string, number][] = [];
    const comments = {
      ...createCommentsStore({ list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() }),
    };
    comments.observeRev = (repo, rev) => observed.push([repo, rev]);
    const status = fakeStatus(state({ commentsRev: 3 }));
    connectCommentsToStatus(status.store, comments);
    status.set(state({ commentsRev: 4 }));
    expect(observed).toEqual([
      [REPO, 3],
      [REPO, 4],
    ]);
  });

  it('says nothing while there is no status yet, or no project', () => {
    const observed: unknown[] = [];
    const comments = createCommentsStore({
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    });
    comments.observeRev = (...args) => observed.push(args);
    const status = fakeStatus(state({ status: null }));
    connectCommentsToStatus(status.store, comments);
    status.set(state({ repo: '' }));
    expect(observed).toEqual([]);
  });

  it('stops when told to', () => {
    const comments = createCommentsStore({
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    });
    const status = fakeStatus(state());
    const off = connectCommentsToStatus(status.store, comments);
    expect(status.listeners.size).toBe(1);
    off();
    expect(status.listeners.size).toBe(0);
  });

  it('makes a visible window read the list when a status answer carries a newer rev', async () => {
    const list = vi.fn(() =>
      Promise.resolve({ ok: true as const, value: { rev: 1, comments: [] } }),
    );
    const comments = createCommentsStore({
      list,
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    });
    comments.setActiveRepo(REPO);
    comments.register().set(REPO, true);
    await settle();
    expect(list).toHaveBeenCalledTimes(1);

    const status = fakeStatus(state({ commentsRev: 1 }));
    connectCommentsToStatus(status.store, comments);
    await settle();
    // The same rev is no news.
    expect(list).toHaveBeenCalledTimes(1);

    list.mockResolvedValueOnce({ ok: true as const, value: { rev: 2, comments: [] } });
    status.set(state({ commentsRev: 2 }));
    await settle();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('works against the real status store too: an answer with a newer rev is heard', async () => {
    const fetchStatus = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          top: REPO,
          unborn: false,
          merge: [],
          staged: [],
          changes: [],
          truncated: false,
          tookMs: 1,
          commentsRev: 7,
          attrEpoch: 'e',
        } satisfies ScmStatus,
      }),
    );
    const status = createScmStatusStore({ fetchStatus, isForeground: () => true });
    const observed: number[] = [];
    const comments = createCommentsStore({
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    });
    comments.observeRev = (_repo, rev) => observed.push(rev);
    connectCommentsToStatus(status, comments);
    status.setActiveRepo(REPO);
    const joined = status.register();
    joined.set(REPO, true);
    await settle();
    joined.release();
    expect(observed).toContain(7);
  });
});

// A component test that the hook re-renders its owner when the store changes.
describe('useComments in a component', () => {
  it('re-renders when a comment arrives', async () => {
    commentsStore.setActiveRepo(REPO);
    const Probe = () => <p data-testid="n">{useComments(REPO, true).comments.length}</p>;
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('n').textContent).toBe('0');
    await settle();
    expect(getByTestId('n').textContent).toBe('1');
  });
});
