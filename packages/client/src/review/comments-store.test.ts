// The store's promises are about ORDER and TIME, so the tests run a fake server
// that applies each request the moment it is made (the server's mutex order) and
// lets every window's answers and frames arrive late, early or out of order. All
// timing is on fake timers: nothing here touches the network.
// The scenario names follow the `review-comments` spec ("Two windows at once",
// "An unsaved draft survives scrolling away").

import type { ScmComment, ScmCommentInput, ScmCommentList, ScmCommentPatch } from '@palmux/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScmFetchResult } from '../scm/scm-api';
import {
  createCommentsStore,
  draftKey,
  type CommentsStore,
  type DraftTarget,
} from './comments-store';

const REPO = '/work/a';
const OTHER = '/work/b';

const input = (body: string, over: Partial<ScmCommentInput> = {}): ScmCommentInput => ({
  path: 'a.ts',
  version: 'worktree',
  side: 'new',
  start: 1,
  end: 1,
  lines: ['x'],
  before: [],
  after: [],
  body,
  ...over,
});

const bodies = (store: CommentsStore): string[] =>
  store.getSnapshot().comments.map((comment) => comment.body);

/** A link that delivers late, in a hand-picked order, or at once. */
class Wire {
  mode: 'now' | 'hold' = 'now';
  delay = 0;
  held: Array<() => void> = [];

  /** An answer reaching the window. */
  send<T>(value: T): Promise<T> {
    return new Promise((resolve) => this.post(() => resolve(value)));
  }

  /** A frame reaching the window. */
  post(deliver: () => void): void {
    if (this.mode === 'hold') this.held.push(deliver);
    else if (this.delay > 0) setTimeout(deliver, this.delay);
    else deliver();
  }

  /** Deliver the held items, the given one first. */
  release(first?: number): void {
    const items = this.held.splice(0);
    if (first !== undefined) items.unshift(...items.splice(first, 1));
    for (const deliver of items) deliver();
  }
}

interface Window {
  store: CommentsStore;
  http: Wire;
  frames: Wire;
  requests: string[];
}

/** The server: one comment file per project, one rev, requests applied in call order. */
function createServer() {
  let rev = 0;
  let comments: ScmComment[] = [];
  let nextId = 1;
  const windows: Window[] = [];

  const list = (): ScmCommentList => ({ rev, comments: [...comments] });
  const wrote = (): void => {
    rev += 1;
    for (const window of windows) {
      const at = rev;
      window.frames.post(() => window.store.observeRev(REPO, at));
    }
  };

  return {
    get rev() {
      return rev;
    },
    seed(...bodiesToSeed: string[]): void {
      for (const body of bodiesToSeed) {
        const id = `c${nextId++}`;
        comments.push({ id, ...input(body), createdAt: nextId, updatedAt: nextId });
      }
      rev += 1;
    },
    open(): Window {
      const http = new Wire();
      const frames = new Wire();
      const requests: string[] = [];
      const answer = (
        note: string,
        value: ScmCommentList,
      ): Promise<ScmFetchResult<ScmCommentList>> => {
        requests.push(note);
        return http.send({ ok: true, value });
      };
      const store = createCommentsStore({
        list: (repo) => answer(`list ${repo}`, list()),
        create: (repo, created: ScmCommentInput) => {
          const id = `c${nextId++}`;
          comments = [...comments, { id, ...created, createdAt: nextId, updatedAt: nextId }];
          wrote();
          return answer(`create ${repo}`, list());
        },
        update: (repo, id, patch: ScmCommentPatch) => {
          comments = comments.map((c) => (c.id === id ? { ...c, ...patch } : c));
          wrote();
          return answer(`update ${repo}`, list());
        },
        remove: (repo, id) => {
          if (comments.some((c) => c.id === id)) {
            comments = comments.filter((c) => c.id !== id);
            wrote();
          }
          return answer(`remove ${repo}`, list());
        },
      });
      const window = { store, http, frames, requests };
      windows.push(window);
      return window;
    },
    idOf: (body: string): string => comments.find((c) => c.body === body)?.id ?? '',
  };
}

/** Make `repo` the active project and join as a visible subscriber. */
function show(store: CommentsStore, repo = REPO, visible = true) {
  store.setActiveRepo(repo);
  const subscription = store.register();
  subscription.set(repo, visible);
  return subscription;
}

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

/** Deliver what the wires hold until they hold nothing: a delivery can start the next read. */
async function drain(...wires: Wire[]): Promise<void> {
  if (!wires.some((wire) => wire.held.length > 0)) return;
  for (const wire of wires) wire.release();
  await settle();
  await drain(...wires);
}

/** A window that can write: it has an active project and nothing else. */
function writer(server: ReturnType<typeof createServer>): CommentsStore {
  const { store } = server.open();
  store.setActiveRepo(REPO);
  return store;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reading', () => {
  it('loads the active project when a visible subscriber appears', async () => {
    const server = createServer();
    server.seed('first');
    const { store, requests } = server.open();
    show(store);
    await settle();
    expect(requests).toEqual([`list ${REPO}`]);
    expect(store.getSnapshot()).toMatchObject({ repo: REPO, loaded: true, rev: 1, error: null });
    expect(bodies(store)).toEqual(['first']);
  });

  it('reads nothing while no subscriber is visible, and catches up when one is', async () => {
    const server = createServer();
    server.seed('first');
    const { store, requests } = server.open();
    const subscription = show(store, REPO, false);
    await settle();
    expect(requests).toEqual([]);
    subscription.set(REPO, true);
    await settle();
    expect(requests).toEqual([`list ${REPO}`]);
  });

  it('reads nothing for a subscriber showing a project that is not the active one', async () => {
    const server = createServer();
    const { store, requests } = server.open();
    store.setActiveRepo(REPO);
    store.register().set(OTHER, true);
    await settle();
    expect(requests).toEqual([]);
  });

  it('reads nothing once the last subscriber has gone', async () => {
    const server = createServer();
    const { store, requests } = server.open();
    const subscription = show(store);
    await settle();
    subscription.release();
    store.observeRev(REPO, 5);
    await settle();
    expect(requests).toHaveLength(1);
  });

  it('keeps its snapshot identity until something changes', async () => {
    const server = createServer();
    server.seed('first');
    const { store } = server.open();
    show(store);
    await settle();
    const before = store.getSnapshot();
    store.observeRev(REPO, 1);
    store.observeRev(OTHER, 9);
    await settle();
    expect(store.getSnapshot()).toBe(before);
  });

  it('tells subscribers when the snapshot changes', async () => {
    const server = createServer();
    const { store } = server.open();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    show(store);
    await settle();
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    unsubscribe();
    await store.add(input('after'));
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('writing', () => {
  it('replaces the state with every answer', async () => {
    const server = createServer();
    server.seed('one');
    const { store } = server.open();
    show(store);
    await settle();

    expect(await store.add(input('two'))).toEqual({ ok: true });
    expect(bodies(store)).toEqual(['one', 'two']);
    expect(store.getSnapshot().rev).toBe(2);

    expect(await store.edit(server.idOf('two'), { body: 'two!' })).toEqual({ ok: true });
    expect(bodies(store)).toEqual(['one', 'two!']);

    expect(await store.remove(server.idOf('one'))).toEqual({ ok: true });
    expect(bodies(store)).toEqual(['two!']);
    expect(store.getSnapshot().rev).toBe(4);
  });

  it('answers the failure and leaves the state alone', async () => {
    const store = createCommentsStore({
      list: () => Promise.resolve({ ok: true, value: { rev: 3, comments: [] } }),
      create: () => Promise.resolve({ ok: false, message: 'body is too large', httpStatus: 400 }),
      update: () => Promise.resolve({ ok: false, message: 'comment not found', httpStatus: 404 }),
      remove: () => Promise.resolve({ ok: false, message: 'Cannot reach palmux', httpStatus: 0 }),
    });
    show(store);
    await settle();
    const before = store.getSnapshot();
    expect(await store.add(input('big'))).toEqual({
      ok: false,
      message: 'body is too large',
      httpStatus: 400,
    });
    expect(await store.edit('gone', { body: 'x' })).toMatchObject({ ok: false, httpStatus: 404 });
    expect(await store.remove('x')).toMatchObject({ ok: false, httpStatus: 0 });
    expect(store.getSnapshot()).toBe(before);
  });

  it('refuses a write while no project is active, without a request', async () => {
    const server = createServer();
    const { store, requests } = server.open();
    expect(await store.add(input('x'))).toMatchObject({ ok: false });
    expect(requests).toEqual([]);
  });

  it('applies a write that lands before the first read, and counts it as loaded', async () => {
    const server = createServer();
    const { store } = server.open();
    store.setActiveRepo(REPO);
    await store.add(input('first'));
    expect(store.getSnapshot()).toMatchObject({ loaded: true, rev: 1 });
    expect(bodies(store)).toEqual(['first']);
  });

  it('does not apply an answer that arrives after the project changed, and still reports it saved', async () => {
    const server = createServer();
    const { store, http } = (() => {
      const window = server.open();
      window.http.mode = 'hold';
      return window;
    })();
    store.setActiveRepo(REPO);
    const saved = store.add(input('x'));
    store.setActiveRepo(OTHER);
    http.release();
    expect(await saved).toEqual({ ok: true });
    expect(store.getSnapshot()).toMatchObject({ repo: OTHER, loaded: false, comments: [] });
  });
});

describe('Two windows at once', () => {
  it('keeps an add in one window and a delete in the other, and both windows show both', async () => {
    const server = createServer();
    server.seed('old');
    const desktop = server.open();
    const phone = server.open();
    show(desktop.store);
    show(phone.store);
    await settle();

    // Both writes are in flight before either answer or frame is seen. The server
    // runs the add (rev 2), then the delete (rev 3).
    for (const window of [desktop, phone]) {
      window.http.mode = 'hold';
      window.frames.mode = 'hold';
    }
    const added = desktop.store.add(input('new from desktop'));
    const deleted = phone.store.remove(server.idOf('old'));
    expect(server.rev).toBe(3);

    // The phone's answer (rev 3) lands first, then the desktop's older one (rev 2),
    // which carries a list the delete has not touched.
    phone.http.release();
    await settle();
    desktop.http.release();
    await Promise.all([added, deleted]);
    expect(bodies(phone.store)).toEqual(['new from desktop']);
    expect(bodies(desktop.store)).toEqual(['old', 'new from desktop']);

    // The frames tell the desktop what its own answer could not.
    for (const window of [desktop, phone]) {
      window.http.mode = 'now';
      window.frames.release();
    }
    await settle();

    expect(bodies(desktop.store)).toEqual(['new from desktop']);
    expect(bodies(phone.store)).toEqual(['new from desktop']);
    expect(desktop.store.getSnapshot().rev).toBe(3);
    expect(phone.store.getSnapshot().rev).toBe(3);
  });

  it('converges whichever order the answers and frames arrive in', async () => {
    const server = createServer();
    server.seed('one', 'two');
    const desktop = server.open();
    const phone = server.open();
    show(desktop.store);
    show(phone.store);
    await settle();

    for (const window of [desktop, phone]) {
      window.http.mode = 'hold';
      window.frames.mode = 'hold';
    }
    const a = desktop.store.add(input('three'));
    const b = phone.store.remove(server.idOf('one'));
    const c = desktop.store.edit(server.idOf('two'), { body: 'two!' });
    expect(server.rev).toBe(4);

    // Frames first, then the answers backwards, and whatever reads those start.
    for (const window of [desktop, phone]) window.frames.release();
    await settle();
    desktop.http.release(1);
    phone.http.release();
    await drain(desktop.http, phone.http);
    await Promise.all([a, b, c]);

    for (const window of [desktop, phone]) {
      expect(bodies(window.store)).toEqual(['two!', 'three']);
      expect(window.store.getSnapshot().rev).toBe(4);
    }
  });

  describe('a slow repository', () => {
    // A 900 ms repository is polled every 2.7 s, so the status backstop is too
    // slow to carry the "within 2 seconds" promise. The frame, sent on every
    // write, carries it.
    async function twoWindows(frameArrives: boolean) {
      const server = createServer();
      server.seed('old');
      const desktop = server.open();
      const phone = server.open();
      for (const window of [desktop, phone]) {
        window.http.delay = 100;
        window.frames.delay = 50;
      }
      if (!frameArrives) phone.frames.mode = 'hold';
      show(desktop.store);
      show(phone.store);
      await vi.advanceTimersByTimeAsync(200);
      expect(bodies(phone.store)).toEqual(['old']);

      // What a 900 ms repository's status answers do for the phone: one every 2.7 s.
      const poll = setInterval(() => phone.store.observeRev(REPO, server.rev), 2700);
      const added = desktop.store.add(input('from desktop'));
      return { phone, added, poll };
    }

    it('shows a write from another window within 2 seconds, through the frame', async () => {
      const { phone, added, poll } = await twoWindows(true);
      await vi.advanceTimersByTimeAsync(2000);
      clearInterval(poll);
      await added;
      expect(bodies(phone.store)).toEqual(['old', 'from desktop']);
      expect(phone.store.getSnapshot().rev).toBe(2);
    });

    it('would not have, through the status answer alone', async () => {
      const { phone, added, poll } = await twoWindows(false);
      await vi.advanceTimersByTimeAsync(2000);
      expect(bodies(phone.store)).toEqual(['old']);
      await vi.advanceTimersByTimeAsync(800);
      clearInterval(poll);
      await added;
      expect(bodies(phone.store)).toEqual(['old', 'from desktop']);
    });
  });

  it('still converges through the status answer when a frame is missed', async () => {
    const server = createServer();
    const desktop = server.open();
    const phone = server.open();
    phone.frames.mode = 'hold';
    show(desktop.store);
    show(phone.store);
    await settle();

    await desktop.store.add(input('missed frame'));
    await settle();
    expect(bodies(phone.store)).toEqual([]);

    phone.store.observeRev(REPO, server.rev);
    await settle();
    expect(bodies(phone.store)).toEqual(['missed frame']);
  });

  it('reads again on reconnect even when no rev was heard of', async () => {
    const server = createServer();
    const desktop = server.open();
    const phone = server.open();
    phone.frames.mode = 'hold';
    show(desktop.store);
    show(phone.store);
    await settle();
    await desktop.store.add(input('while the socket was down'));
    await settle();
    expect(bodies(phone.store)).toEqual([]);

    phone.store.refresh();
    await settle();
    expect(bodies(phone.store)).toEqual(['while the socket was down']);
  });
});

describe('frames', () => {
  it('refetches only for a rev newer than the one applied', async () => {
    const server = createServer();
    server.seed('one');
    const { store, requests } = server.open();
    show(store);
    await settle();
    requests.length = 0;

    store.observeRev(REPO, 1);
    store.observeRev(REPO, 0);
    await settle();
    expect(requests).toEqual([]);

    store.observeRev(REPO, 2);
    await settle();
    expect(requests).toEqual([`list ${REPO}`]);
  });

  it('ignores a frame for another project', async () => {
    const server = createServer();
    const { store, requests } = server.open();
    show(store);
    await settle();
    requests.length = 0;
    store.observeRev(OTHER, 7);
    await settle();
    expect(requests).toEqual([]);
  });

  it('is remembered while the view is hidden and read when it shows', async () => {
    const server = createServer();
    const { store, requests } = server.open();
    const subscription = show(store);
    await settle();
    subscription.set(REPO, false);
    requests.length = 0;

    await writer(server).add(input('x'));
    store.observeRev(REPO, server.rev);
    await settle();
    expect(requests).toEqual([]);

    subscription.set(REPO, true);
    await settle();
    expect(requests).toEqual([`list ${REPO}`]);
  });

  it('does not stack reads: one in flight, and one more only for news that arrived meanwhile', async () => {
    const server = createServer();
    const { store, http, requests } = server.open();
    show(store);
    await settle();
    requests.length = 0;

    http.mode = 'hold';
    store.observeRev(REPO, 1);
    store.observeRev(REPO, 2);
    store.observeRev(REPO, 3);
    await settle();
    expect(requests).toHaveLength(1);

    http.mode = 'now';
    http.release();
    await settle();
    expect(requests).toHaveLength(2);
  });

  it('does not read for ever from a server that answers older than a frame said', async () => {
    let calls = 0;
    const store = createCommentsStore({
      list: () => {
        calls += 1;
        return Promise.resolve({ ok: true, value: { rev: 1, comments: [] } });
      },
      create: () => Promise.reject(new Error('unused')),
      update: () => Promise.reject(new Error('unused')),
      remove: () => Promise.reject(new Error('unused')),
    });
    show(store);
    await settle();
    store.observeRev(REPO, 12);
    await settle();
    store.observeRev(REPO, 12);
    store.observeRev(REPO, 12);
    await settle();
    expect(calls).toBe(2);
  });
});

describe('stale answers', () => {
  it('drops a write answer older than the applied rev', async () => {
    const server = createServer();
    server.seed('one');
    const desktop = server.open();
    show(desktop.store);
    await settle();
    desktop.frames.mode = 'hold';

    // The desktop's add runs first (rev 2) but its answer is slow. Another window
    // then deletes (rev 3), and the desktop reads that before the answer arrives.
    desktop.http.mode = 'hold';
    const added = desktop.store.add(input('added'));
    await writer(server).remove(server.idOf('one'));
    desktop.store.observeRev(REPO, server.rev);
    expect(desktop.http.held).toHaveLength(2);

    desktop.http.release(1);
    await settle();
    expect(desktop.store.getSnapshot().rev).toBe(3);
    expect(bodies(desktop.store)).toEqual(['added']);

    const applied = desktop.store.getSnapshot();
    desktop.http.release();
    expect(await added).toEqual({ ok: true });
    expect(desktop.store.getSnapshot()).toBe(applied);
  });

  it('drops a read answer older than the applied rev', async () => {
    const server = createServer();
    const window = server.open();
    show(window.store);
    await settle();
    window.frames.mode = 'hold';

    // A read begins after another window's write (rev 1) and is slow. The window's
    // own write follows (rev 2) and is answered first.
    window.http.mode = 'hold';
    await writer(server).add(input('one'));
    window.store.observeRev(REPO, 1);
    const added = window.store.add(input('two'));
    expect(window.http.held).toHaveLength(2);

    window.http.release(1);
    await added;
    expect(window.store.getSnapshot().rev).toBe(2);

    const applied = window.store.getSnapshot();
    window.http.release();
    await settle();
    expect(window.store.getSnapshot()).toBe(applied);
    expect(bodies(window.store)).toEqual(['one', 'two']);
  });

  it('ignores a read that answers after the project changed', async () => {
    const server = createServer();
    server.seed('in a');
    const { store, http } = server.open();
    http.mode = 'hold';
    show(store, REPO);
    store.setActiveRepo(OTHER);
    http.release();
    await settle();
    expect(store.getSnapshot()).toMatchObject({ repo: OTHER, loaded: false, comments: [] });
  });
});

describe('failures', () => {
  it('keeps the comments, reports the error, and retries on the next news without looping', async () => {
    let failing = false;
    let calls = 0;
    const store = createCommentsStore({
      list: () => {
        calls += 1;
        return Promise.resolve(
          failing
            ? { ok: false, message: 'Cannot reach palmux', httpStatus: 0 }
            : { ok: true, value: { rev: calls, comments: [] } },
        );
      },
      create: () => Promise.reject(new Error('unused')),
      update: () => Promise.reject(new Error('unused')),
      remove: () => Promise.reject(new Error('unused')),
    });
    show(store);
    await settle();
    const first = store.getSnapshot().rev;

    failing = true;
    store.observeRev(REPO, first + 1);
    await settle();
    expect(store.getSnapshot().error).toBe('Cannot reach palmux');
    expect(store.getSnapshot().loaded).toBe(true);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(2);

    // The status answer repeats the same rev; that alone retries the read.
    failing = false;
    store.observeRev(REPO, first + 1);
    await settle();
    expect(calls).toBe(3);
    expect(store.getSnapshot().error).toBeNull();
  });
});

describe('switching project', () => {
  it('drops the old project comments and loads the new one', async () => {
    const server = createServer();
    server.seed('in a');
    const { store, requests } = server.open();
    show(store, REPO);
    await settle();
    expect(bodies(store)).toEqual(['in a']);

    store.setActiveRepo(OTHER);
    expect(store.getSnapshot()).toMatchObject({ repo: OTHER, loaded: false, comments: [] });
    store.register().set(OTHER, true);
    await settle();
    expect(requests.at(-1)).toBe(`list ${OTHER}`);
  });
});

describe('An unsaved draft survives scrolling away', () => {
  const target: DraftTarget = { path: 'a.ts', side: 'new', start: 10, end: 14 };

  it('outlives every subscriber', async () => {
    const server = createServer();
    const { store } = server.open();
    const first = show(store);
    store.setDraft(REPO, target, 'half a thought');
    first.release();

    const second = store.register();
    second.set(REPO, true);
    expect(store.draftText(REPO, target)).toBe('half a thought');
    expect(store.getSnapshot().drafts).toEqual([target]);
  });

  it('is keyed by path, side and range', () => {
    const { store } = createServer().open();
    store.setDraft(REPO, target, 'one');
    store.setDraft(REPO, { ...target, side: 'old' }, 'two');
    store.setDraft(REPO, { ...target, end: 15 }, 'three');
    store.setDraft(REPO, { ...target, path: 'b.ts' }, 'four');
    store.setDraft(REPO, target, 'one, later');
    expect(store.draftText(REPO, target)).toBe('one, later');
    expect(store.draftText(REPO, { ...target, side: 'old' })).toBe('two');
    expect(store.draftText(REPO, { ...target, end: 15 })).toBe('three');
    expect(store.draftText(REPO, { ...target, path: 'b.ts' })).toBe('four');
  });

  it('keeps an edit of a stored comment apart from a new comment on the same lines', () => {
    const { store } = createServer().open();
    const edit: DraftTarget = { ...target, commentId: 'c1' };
    store.setDraft(REPO, target, 'new one');
    store.setDraft(REPO, edit, 'edited body');
    store.setDraft(REPO, { ...target, commentId: 'c2' }, 'another edit');
    expect(store.draftText(REPO, target)).toBe('new one');
    expect(store.draftText(REPO, edit)).toBe('edited body');
    expect(store.draftText(REPO, { ...target, commentId: 'c2' })).toBe('another edit');
    expect(draftKey(edit)).not.toBe(draftKey(target));
  });

  it('keeps the drafts of two scopes apart: two reviews can show the same lines', () => {
    const { store } = createServer().open();
    store.setDraft(REPO, { ...target, scope: 'changes' }, 'in changes');
    store.setDraft(REPO, { ...target, scope: 'staged' }, 'in staged');
    expect(store.draftText(REPO, { ...target, scope: 'changes' })).toBe('in changes');
    expect(store.draftText(REPO, { ...target, scope: 'staged' })).toBe('in staged');
    expect(store.draftText(REPO, target)).toBeUndefined();
  });

  it('cannot be confused by a path that looks like the rest of a key', () => {
    const tricky = draftKey({ path: 'a.ts', side: 'new', start: 1, end: 2 });
    expect(draftKey({ path: 'a.ts\0new\0', side: 'new', start: 1, end: 2 })).not.toBe(tricky);
    expect(draftKey({ path: 'a.ts', side: 'new', start: 12, end: 2 })).not.toBe(
      draftKey({ path: 'a.ts', side: 'new', start: 1, end: 22 }),
    );
  });

  it('keeps an empty draft open: an editor opened and not yet typed in is still an editor', () => {
    const { store } = createServer().open();
    store.setActiveRepo(REPO);
    store.setDraft(REPO, target, '');
    expect(store.getSnapshot().drafts).toEqual([target]);
    expect(store.draftText(REPO, target)).toBe('');
  });

  it('changes the snapshot when a draft opens or closes, not as it is typed into', () => {
    const { store } = createServer().open();
    store.setActiveRepo(REPO);
    const listener = vi.fn();
    store.subscribe(listener);

    store.setDraft(REPO, target, '');
    expect(listener).toHaveBeenCalledTimes(1);
    const open = store.getSnapshot();

    store.setDraft(REPO, target, 'a');
    store.setDraft(REPO, target, 'ab');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe(open);
    expect(store.draftText(REPO, target)).toBe('ab');

    store.clearDraft(REPO, target);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().drafts).toEqual([]);
    expect(store.draftText(REPO, target)).toBeUndefined();

    store.clearDraft(REPO, target);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('lists drafts in the order they were opened', () => {
    const { store } = createServer().open();
    store.setActiveRepo(REPO);
    const later = { ...target, start: 3, end: 3 };
    store.setDraft(REPO, target, '');
    store.setDraft(REPO, later, '');
    expect(store.getSnapshot().drafts).toEqual([target, later]);
  });

  it('survives a refetch, a write and a project round trip', async () => {
    const server = createServer();
    const { store } = server.open();
    show(store, REPO);
    store.setDraft(REPO, target, 'keep me');
    await store.add(input('someone else'));
    store.observeRev(REPO, 99);
    await settle();
    expect(store.getSnapshot().drafts).toEqual([target]);

    store.setActiveRepo(OTHER);
    expect(store.getSnapshot().drafts).toEqual([]);
    store.setActiveRepo(REPO);
    expect(store.getSnapshot().drafts).toEqual([target]);
    expect(store.draftText(REPO, target)).toBe('keep me');
  });

  it('belongs to its project: a draft for another one never shows in the active one', () => {
    const { store } = createServer().open();
    store.setActiveRepo(REPO);
    store.setDraft(OTHER, target, 'elsewhere');
    expect(store.getSnapshot().drafts).toEqual([]);
    expect(store.draftText(REPO, target)).toBeUndefined();
    expect(store.draftText(OTHER, target)).toBe('elsewhere');
  });
});
