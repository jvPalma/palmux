// Reviewed, Unstage and Undo in the pane, scenario by scenario from `diff-review`
// ("Reviewing a file stages it and moves on", "A staged file can be unstaged"): what
// goes on the wire, where the view goes next, the toast, and each refusal. The pane
// is real; the server is `FakeServer`, which can answer a write with any refusal.

import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScmFileSnapshot } from '@palmux/shared';
import { scmStatusStore } from '../scm/status-store';
import {
  FakeServer,
  OTHER,
  REPO,
  colorize,
  entry,
  fileRow,
  mountReview,
  offsetOf,
  scroller,
  settle,
  setup,
  snapshot,
  statusBody,
  tab,
  teardown,
} from './review-test-support';
import { reviewApiFor } from './review-registry';
import { commentsStore } from './use-comments';

vi.mock('../panes/monaco-loader', () => ({
  getMonaco: () => ({ editor: { colorize: (text: string) => colorize(text) } }),
}));

let server: FakeServer;
beforeEach(() => {
  server = setup();
});
afterEach(teardown);

const FIVE = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];

/** A Changes review of `paths`, each a one-line change, loaded. */
async function openFiles(paths: string[] = FIVE, over: Parameters<typeof mountReview>[0] = {}) {
  server.status[REPO] = statusBody({ changes: paths.map((p) => entry(p)) });
  for (const p of paths) server.files[p] = snapshot(p);
  const pane = mountReview(over);
  await screen.findByTestId('review-list');
  await settle();
  return pane;
}

const reviewed = (path: string): HTMLElement =>
  within(fileRow(path)).getByTestId('review-file-reviewed');
const unstage = (path: string): HTMLElement =>
  within(fileRow(path)).getByTestId('review-file-unstage');
const press = async (button: HTMLElement) => {
  await act(async () => {
    fireEvent.click(button);
  });
  await settle();
};
const paths = (): string[] =>
  screen.queryAllByTestId('review-file').map((el) => el.getAttribute('data-path') ?? '');
const writes = (kind: 'stage' | 'unstage' | 'restore') => server.requests(`/scm/${kind}`);
const notice = () => screen.queryByTestId('review-notice');

/** The server's own bookkeeping: a staged file leaves Changes and joins Staged. */
function movesToStaged() {
  server.onWrite = (kind, body) => {
    if (kind !== 'stage') return;
    const path = String(body['path']);
    const status = server.status[REPO];
    if (!status) return;
    server.status[REPO] = {
      ...status,
      changes: status.changes.filter((e) => e.path !== path),
      staged: [...status.staged, entry(path)],
    };
  };
}

// ── Reviewing a file stages it and moves on ──────────────────────────────────

describe('Reviewing a file stages it and moves on', () => {
  it('review and move on: Reviewed on the second of five stages it, it leaves Changes, and the view moves to the third', async () => {
    movesToStaged();
    await openFiles();
    await press(reviewed('b.ts'));

    expect(writes('stage')).toHaveLength(1);
    expect(writes('stage')[0]?.query['repo']).toBe(REPO);
    expect(writes('stage')[0]?.body).toEqual({ path: 'b.ts', token: 'tok-b.ts-1' });
    expect(paths()).toEqual(['a.ts', 'c.ts', 'd.ts', 'e.ts']);
    // The third file is at the top of the view.
    expect(scroller().scrollTop).toBe(offsetOf(fileRow('c.ts')));
    expect(notice()).toBeNull();
  });

  it('offers Undo in a toast, naming the file', async () => {
    movesToStaged();
    const pane = await openFiles();
    await press(reviewed('b.ts'));
    expect(pane.toasts).toHaveLength(1);
    expect(pane.toasts[0]?.message).toBe('Reviewed b.ts');
    expect(pane.toasts[0]?.action?.label).toBe('Undo');
  });

  it('asks the status to be read at once, so the file leaves the list without a wait', async () => {
    movesToStaged();
    await openFiles();
    const reads = server.requests('/scm/status').length;
    await press(reviewed('b.ts'));
    expect(server.requests('/scm/status').length).toBeGreaterThan(reads);
  });

  it('stays where it is after the last file: there is no next to move to', async () => {
    movesToStaged();
    await openFiles(['a.ts', 'b.ts']);
    await press(reviewed('b.ts'));
    expect(paths()).toEqual(['a.ts']);
    expect(scroller().scrollTop).toBe(0);
  });

  it('an edit after it was shown: the version the reader saw is what is staged', async () => {
    movesToStaged();
    await openFiles(['a.ts']);
    // The file changes on disk; the pane has not read the status again, so what it
    // holds, and what the reader looked at, is still the first version.
    server.files['a.ts'] = snapshot('a.ts', { version: 'v-a.ts-2', token: 'tok-a.ts-2' });
    await press(reviewed('a.ts'));
    expect(writes('stage')[0]?.body).toEqual({ path: 'a.ts', token: 'tok-a.ts-1' });
  });

  it('is pressed once however many times it is pressed while the write is out', async () => {
    movesToStaged();
    await openFiles(['a.ts', 'b.ts']);
    let release!: () => void;
    server.hold = new Promise((resolve) => {
      release = resolve;
    });
    const button = reviewed('a.ts');
    fireEvent.click(button);
    fireEvent.click(button);
    await settle();
    expect(reviewed('a.ts')).toBeDisabled();
    release();
    await settle();
    expect(writes('stage')).toHaveLength(1);
  });

  it('disables the button of a file whose own write is out', async () => {
    movesToStaged();
    await openFiles(['a.ts', 'b.ts']);
    server.hold = new Promise(() => {});
    fireEvent.click(reviewed('a.ts'));
    await settle();
    expect(reviewed('a.ts')).toBeDisabled();
    expect(reviewed('b.ts')).not.toBeDisabled();
  });
});

// ── A file palmux cannot snapshot ────────────────────────────────────────────

describe('A file palmux cannot snapshot', () => {
  async function openWith(over: Parameters<typeof snapshot>[1]) {
    server.status[REPO] = statusBody({ changes: [entry('a.ts')] });
    server.files['a.ts'] = snapshot('a.ts', over);
    delete server.files['a.ts']?.token;
    mountReview();
    await screen.findByTestId('review-list');
    await settle();
  }

  it.each<[string, Partial<ScmFileSnapshot>, RegExp]>([
    ['too large', { tooLarge: true, hunks: [] }, /too large to stage/],
    ['converted by a git filter', { converted: true, hunks: [] }, /converted by git/],
  ])(
    'disables Reviewed with the reason when it is %s, and stages nothing',
    async (_n, over, reason) => {
      await openWith(over);
      const button = reviewed('a.ts');
      expect(button).toBeDisabled();
      expect(button.getAttribute('title')).toMatch(reason);
      expect(button.dataset['reason']).toMatch(reason);
      fireEvent.click(button);
      await settle();
      expect(writes('stage')).toEqual([]);
    },
  );

  it('disables Reviewed until the file has loaded, and says why', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.ts')] });
    server.files['a.ts'] = () => new Promise(() => {});
    mountReview();
    await screen.findByTestId('review-list');
    await settle();
    expect(reviewed('a.ts')).toBeDisabled();
    expect(reviewed('a.ts').getAttribute('title')).toMatch(/not loaded yet/);
  });

  it('disables Reviewed on a conflicted file', async () => {
    server.status[REPO] = statusBody({
      merge: [entry('a.ts', { kind: 'unmerged', status: 'U' })],
    });
    mountReview();
    await screen.findByTestId('review-list');
    await settle();
    expect(reviewed('a.ts')).toBeDisabled();
    expect(reviewed('a.ts').getAttribute('title')).toMatch(/conflicts/);
  });

  it('enables it for a binary file, which has a token like any other', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.bin', { binary: true })] });
    server.files['a.bin'] = snapshot('a.bin', { binary: true, hunks: [] });
    mountReview();
    await screen.findByTestId('review-list');
    await settle();
    expect(reviewed('a.bin')).not.toBeDisabled();
  });
});

// ── Reviewed after a long review ─────────────────────────────────────────────

describe('Reviewed after a long review', () => {
  beforeEach(() => movesToStaged());

  it('is staged without an error when the token has expired and the file is unchanged', async () => {
    const pane = await openFiles(['a.ts']);
    server.answers.stage.push({ status: 410, body: { error: 'expired', code: 'token' } });
    // The same version again, under a new token.
    server.files['a.ts'] = snapshot('a.ts', { token: 'tok-new' });
    const asked = server.fileRequests().length;
    await press(reviewed('a.ts'));

    expect(server.fileRequests().length).toBe(asked + 1);
    expect(writes('stage').map((r) => r.body?.['token'])).toEqual(['tok-a.ts-1', 'tok-new']);
    expect(notice()).toBeNull();
    expect(pane.toasts.map((t) => t.message)).toEqual(['Reviewed a.ts']);
  });

  it('retries once, never in a loop', async () => {
    await openFiles(['a.ts']);
    server.answers.stage.push(
      { status: 410, body: { error: 'expired', code: 'token' } },
      { status: 410, body: { error: 'expired again', code: 'token' } },
    );
    server.files['a.ts'] = snapshot('a.ts', { token: 'tok-new' });
    await press(reviewed('a.ts'));
    expect(writes('stage')).toHaveLength(2);
    expect(notice()).toHaveTextContent(/no longer held/);
  });

  it('shows the newer version, with the changed notice, and stages nothing when the file changed', async () => {
    await openFiles(['a.ts']);
    server.answers.stage.push({ status: 410, body: { error: 'expired', code: 'token' } });
    server.files['a.ts'] = snapshot('a.ts', {
      version: 'v-a.ts-2',
      token: 'tok-new',
      new: { id: 'n2', text: 'a newer line\n' },
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          oldLines: 1,
          newLines: 1,
          header: '',
          lines: [
            { kind: 'del', text: 'before', old: 1 },
            { kind: 'add', text: 'a newer line', new: 1 },
          ],
        },
      ],
    });
    await press(reviewed('a.ts'));

    expect(writes('stage')).toHaveLength(1);
    expect(notice()).toHaveTextContent(/changed since you looked/);
    // The newer version is what is on screen now.
    expect(screen.getAllByTestId('review-line').map((l) => l.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('a newer line')]),
    );
    // And it is not offered as reviewed: the next press stages the NEW version.
    server.answers.stage.length = 0;
    await press(reviewed('a.ts'));
    expect(writes('stage').at(-1)?.body).toEqual({ path: 'a.ts', token: 'tok-new' });
  });
});

// ── Undo ─────────────────────────────────────────────────────────────────────

describe('Undo', () => {
  beforeEach(() => movesToStaged());

  async function reviewedThenUndo(beforeUndo?: () => void) {
    const pane = await openFiles(['a.ts', 'b.ts']);
    await press(reviewed('a.ts'));
    beforeUndo?.();
    await act(async () => {
      pane.toasts[0]?.action?.onClick();
    });
    await settle();
    return pane;
  }

  it('restores by the receipt of the write it undoes', async () => {
    const pane = await reviewedThenUndo();
    expect(writes('restore')).toHaveLength(1);
    expect(writes('restore')[0]?.body).toEqual({
      receiptId: expect.stringMatching(/^receipt-stage-/),
    });
    expect(pane.toasts.at(-1)?.message).toBe('Undone');
    expect(notice()).toBeNull();
  });

  it('reads the status again, so the file returns to the list at once', async () => {
    const pane = await openFiles(['a.ts', 'b.ts']);
    server.onWrite = (kind) => {
      const status = server.status[REPO];
      if (!status) return;
      server.status[REPO] =
        kind === 'stage'
          ? { ...status, changes: [entry('b.ts')], staged: [entry('a.ts')] }
          : { ...status, changes: [entry('a.ts'), entry('b.ts')], staged: [] };
    };
    await press(reviewed('a.ts'));
    expect(paths()).toEqual(['b.ts']);
    await act(async () => {
      pane.toasts[0]?.action?.onClick();
    });
    await settle();
    expect(paths()).toEqual(['a.ts', 'b.ts']);
  });

  it('says the index changed since, and that nothing was undone, when another window staged', async () => {
    const pane = await reviewedThenUndo(() => {
      server.answers.restore.push({
        status: 409,
        body: { error: 'The index changed since; nothing was undone.', code: 'conflict' },
      });
    });
    expect(notice()).toHaveTextContent('The index changed since; nothing was undone.');
    // The toast says it too, for a reader who has left the review.
    expect(pane.toasts.at(-1)?.message).toBe('The index changed since; nothing was undone.');
  });

  it('says so when Undo is no longer available', async () => {
    await reviewedThenUndo(() => {
      server.answers.restore.push({ status: 410, body: { error: 'gone', code: 'token' } });
    });
    expect(notice()).toHaveTextContent('Undo is no longer available.');
  });
});

// ── Undo covers every write still inside its window ──────────────────────────

describe('Undo covers every write still inside its window', () => {
  beforeEach(() => movesToStaged());

  const restored = { status: 200, body: { receiptId: 'x', status: 'restored' } };
  const undoLast = async (pane: Awaited<ReturnType<typeof openFiles>>) => {
    await act(async () => {
      pane.toasts.at(-1)?.action?.onClick();
    });
    await settle();
  };

  it('a second Reviewed keeps the first one: the toast counts both, and one Undo takes both back, newest first', async () => {
    const pane = await openFiles(['a.ts', 'b.ts', 'c.ts']);
    await press(reviewed('a.ts'));
    await press(reviewed('b.ts'));
    expect(pane.toasts.map((t) => t.message)).toEqual(['Reviewed a.ts', 'Staged 2 files']);
    expect(pane.toasts.at(-1)?.action?.label).toBe('Undo');

    await undoLast(pane);
    // The newer write first: each restore is a compare-and-swap on its own receipt.
    expect(writes('restore').map((r) => r.body)).toEqual([
      { receiptId: 'receipt-stage-2' },
      { receiptId: 'receipt-stage-1' },
    ]);
    expect(writes('restore').every((r) => r.query['repo'] === REPO)).toBe(true);
    expect(pane.toasts.at(-1)?.message).toBe('Undid 2 files');
    expect(notice()).toBeNull();
  });

  it('a third write is counted with the other two', async () => {
    const pane = await openFiles(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    await press(reviewed('a.ts'));
    await press(reviewed('b.ts'));
    await press(reviewed('c.ts'));
    expect(pane.toasts.at(-1)?.message).toBe('Staged 3 files');
    await undoLast(pane);
    expect(writes('restore')).toHaveLength(3);
  });

  it('stops at the first conflict, leaves the older write alone and says how far it got', async () => {
    const pane = await openFiles(['a.ts', 'b.ts', 'c.ts']);
    await press(reviewed('a.ts'));
    await press(reviewed('b.ts'));
    // The newer one restores; the older one's entry was changed by another window.
    server.answers.restore.push(restored, {
      status: 409,
      body: { error: 'The index changed since; nothing was undone.', code: 'conflict' },
    });
    await undoLast(pane);
    expect(writes('restore')).toHaveLength(2);
    const said =
      'Undid 1 of 2. The index changed since for the rest, so they were left as they are.';
    expect(notice()).toHaveTextContent(said);
    expect(pane.toasts.at(-1)?.message).toBe(said);
  });

  it('a conflict on the newest write undoes nothing and tries no other', async () => {
    const pane = await openFiles(['a.ts', 'b.ts', 'c.ts']);
    await press(reviewed('a.ts'));
    await press(reviewed('b.ts'));
    server.answers.restore.push({
      status: 409,
      body: { error: 'The index changed since; nothing was undone.', code: 'conflict' },
    });
    await undoLast(pane);
    expect(writes('restore')).toHaveLength(1);
    expect(notice()).toHaveTextContent('The index changed since; nothing was undone.');
  });

  it('reads the status again after a partial undo, since the index did change', async () => {
    const pane = await openFiles(['a.ts', 'b.ts', 'c.ts']);
    await press(reviewed('a.ts'));
    await press(reviewed('b.ts'));
    server.answers.restore.push(restored, {
      status: 409,
      body: { error: 'x', code: 'conflict' },
    });
    const reads = server.requests('/scm/status').length;
    await undoLast(pane);
    expect(server.requests('/scm/status').length).toBeGreaterThan(reads);
  });

  it('does not offer a write again once it has been undone', async () => {
    const pane = await openFiles(['a.ts', 'b.ts', 'c.ts']);
    await press(reviewed('a.ts'));
    await undoLast(pane);
    await press(reviewed('b.ts'));
    // `a.ts` was undone: the toast is for `b.ts` alone, by name.
    expect(pane.toasts.at(-1)?.message).toBe('Reviewed b.ts');
  });

  it('counts a Staged review’s Unstage with the Reviewed made just before', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.ts')], staged: [entry('b.ts')] });
    server.files['a.ts'] = snapshot('a.ts');
    server.files['b.ts'] = snapshot('b.ts', { group: 'staged' });
    const changes = mountReview();
    await screen.findByTestId('review-list');
    await settle();
    await press(reviewed('a.ts'));
    changes.unmount();

    const staged = mountReview({ tab: tab(`staged:${REPO}`, '8') });
    await screen.findByTestId('review-list');
    await settle();
    await press(unstage('b.ts'));
    expect(staged.toasts.map((t) => t.message)).toEqual(['Staged 1 file, unstaged 1 file']);
  });
});

// ── A pan across a file header stages nothing ────────────────────────────────

describe('a pan that starts on Reviewed', () => {
  it('stages nothing: the button acts on release inside the slop, never on a swipe', async () => {
    await openFiles(['a.ts', 'b.ts']);
    const button = reviewed('a.ts');
    const at = { pointerType: 'touch', pointerId: 4 };
    fireEvent.pointerDown(button, { ...at, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(button, { ...at, clientX: 100, clientY: 160 });
    fireEvent.pointerUp(button, { ...at, clientX: 100, clientY: 160 });
    await settle();
    expect(writes('stage')).toEqual([]);

    // A tap in place does.
    fireEvent.pointerDown(button, { ...at, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(button, { ...at, clientX: 101, clientY: 101 });
    await settle();
    expect(writes('stage')).toHaveLength(1);
  });
});

// ── A staged file can be unstaged ────────────────────────────────────────────

describe('A staged file can be unstaged', () => {
  async function openStaged(entries = [entry('a.ts'), entry('b.ts')]) {
    server.status[REPO] = statusBody({ staged: entries });
    for (const e of entries) server.files[e.path] = snapshot(e.path, { group: 'staged' });
    const pane = mountReview({ tab: tab(`staged:${REPO}`) });
    await screen.findByTestId('review-list');
    await settle();
    return pane;
  }

  it('offers Unstage, not Reviewed, on a Staged header', async () => {
    await openStaged();
    expect(unstage('a.ts')).toHaveTextContent('Unstage');
    expect(within(fileRow('a.ts')).queryByTestId('review-file-reviewed')).toBeNull();
  });

  it('unstages the file, says so with an Undo, and moves on to the next', async () => {
    server.onWrite = (kind, body) => {
      const status = server.status[REPO];
      if (kind === 'unstage' && status) {
        server.status[REPO] = {
          ...status,
          staged: status.staged.filter((e) => e.path !== body['path']),
        };
      }
    };
    const pane = await openStaged([entry('a.ts'), entry('b.ts'), entry('c.ts')]);
    await press(unstage('a.ts'));
    expect(writes('unstage')).toHaveLength(1);
    expect(writes('unstage')[0]?.body).toEqual({ path: 'a.ts' });
    expect(pane.toasts[0]).toMatchObject({ message: 'Unstaged a.ts' });
    expect(pane.toasts[0]?.action?.label).toBe('Undo');
    expect(paths()).toEqual(['b.ts', 'c.ts']);
    expect(scroller().scrollTop).toBe(offsetOf(fileRow('b.ts')));
  });

  it('unstages both paths of a staged rename', async () => {
    await openStaged([entry('b.ts', { kind: 'rename', status: 'R', oldPath: 'a.ts' })]);
    await press(unstage('b.ts'));
    expect(writes('unstage')[0]?.body).toEqual({ path: 'b.ts', oldPath: 'a.ts' });
  });

  it('undoes an unstage by its receipt', async () => {
    const pane = await openStaged();
    await press(unstage('a.ts'));
    await act(async () => {
      pane.toasts[0]?.action?.onClick();
    });
    await settle();
    expect(writes('restore')[0]?.body).toEqual({
      receiptId: expect.stringMatching(/^receipt-unstage-/),
    });
  });

  it('is available for a file with no token: it never needs one', async () => {
    server.status[REPO] = statusBody({ staged: [entry('a.ts')] });
    server.files['a.ts'] = snapshot('a.ts', { group: 'staged', tooLarge: true, hunks: [] });
    delete server.files['a.ts']?.token;
    mountReview({ tab: tab(`staged:${REPO}`) });
    await screen.findByTestId('review-list');
    await settle();
    expect(unstage('a.ts')).not.toBeDisabled();
  });
});

// ── What each refusal says ───────────────────────────────────────────────────

describe('a refused write is explained, and changes nothing on screen', () => {
  it.each([
    ['busy', 409, /busy.*Nothing was changed/s],
    ['changed', 409, /changed since you looked.*nothing was staged/s],
    ['unsupported', 501, /cannot do this here: this repository uses a split index/],
    ['df', 409, /Git refused: .*both a file and a directory/],
  ] as const)('%s', async (code, status, text) => {
    const pane = await openFiles(['a.ts', 'b.ts']);
    const message =
      code === 'unsupported'
        ? 'this repository uses a split index'
        : code === 'df'
          ? 'cannot add: both a file and a directory'
          : 'refused';
    server.answers.stage.push({ status, body: { error: message, code } });
    await press(reviewed('a.ts'));
    expect(notice()).toHaveTextContent(text);
    expect(notice()).toHaveAttribute('role', 'alert');
    // Nothing moved on and no Undo was offered for a write that did not happen.
    expect(pane.toasts).toEqual([]);
    expect(paths()).toEqual(['a.ts', 'b.ts']);
    expect(scroller().scrollTop).toBe(0);
  });

  it('a conflicted file’s refusal, which has no code, shows the server’s words', async () => {
    await openFiles(['a.ts']);
    server.answers.stage.push({ status: 409, body: { error: 'a.ts is conflicted' } });
    await press(reviewed('a.ts'));
    expect(notice()).toHaveTextContent('a.ts is conflicted');
  });

  it('a changed attribute context reads the file again, so the reader sees the newer one', async () => {
    await openFiles(['a.ts']);
    server.answers.stage.push({ status: 409, body: { error: 'x', code: 'changed' } });
    const asked = server.fileRequests().length;
    await press(reviewed('a.ts'));
    expect(server.fileRequests().length).toBeGreaterThan(asked);
  });

  it('is dismissed with the Dismiss button, and by the next write that succeeds', async () => {
    movesToStaged();
    await openFiles(['a.ts', 'b.ts']);
    server.answers.stage.push({ status: 409, body: { error: 'x', code: 'busy' } });
    await press(reviewed('a.ts'));
    expect(notice()).not.toBeNull();
    fireEvent.click(screen.getByTestId('review-notice-dismiss'));
    expect(notice()).toBeNull();

    server.answers.stage.push({ status: 409, body: { error: 'x', code: 'busy' } });
    await press(reviewed('a.ts'));
    expect(notice()).not.toBeNull();
    await press(reviewed('a.ts'));
    expect(notice()).toBeNull();
  });

  it('says it cannot reach palmux when the network is down', async () => {
    await openFiles(['a.ts']);
    const fetchMock = vi.mocked(fetch);
    const real = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((url, init) =>
      String(url).startsWith('/scm/stage')
        ? Promise.reject(new TypeError('offline'))
        : (real?.(url, init) as Promise<Response>),
    );
    await press(reviewed('a.ts'));
    expect(notice()).toHaveTextContent('Cannot reach palmux');
  });
});

// ── A review of a project that is not the active one ─────────────────────────

describe('a paused review does not write', () => {
  it('disables Reviewed with the reason', async () => {
    movesToStaged();
    await openFiles(['a.ts']);
    // The device moved to another project.
    act(() => {
      scmStatusStore.setActiveRepo(OTHER);
      commentsStore.setActiveRepo(OTHER);
    });
    await settle();
    expect(reviewed('a.ts')).toBeDisabled();
    expect(reviewed('a.ts').getAttribute('title')).toMatch(/paused/i);
    fireEvent.click(reviewed('a.ts'));
    await settle();
    expect(writes('stage')).toEqual([]);
  });
});

// ── A comment open on the file ───────────────────────────────────────────────

describe('a file with a comment open on it is not written', () => {
  /** Pick new-side line `no` of `path` with the mouse, and open a comment on it. */
  function openComment(path: string, no = 1) {
    const cell = screen
      .getAllByTestId('review-no-new')
      .find(
        (el) =>
          el.closest('[data-path]')?.getAttribute('data-path') === path &&
          el.textContent === String(no),
      );
    if (!cell) throw new Error(`no new-side line ${no} of ${path} on screen`);
    fireEvent.pointerDown(cell, { pointerType: 'mouse', pointerId: 1, button: 0 });
    fireEvent.pointerUp(window, { pointerType: 'mouse', pointerId: 1, button: 0 });
    fireEvent.click(screen.getByTestId('review-comment-start'));
    fireEvent.change(screen.getByTestId('review-comment-input'), {
      target: { value: 'unsaved thought' },
    });
  }
  const editorText = () =>
    (screen.getByTestId('review-comment-input') as HTMLTextAreaElement).value;

  it('Reviewed is disabled with the reason, refuses from the key too, and the editor stays', async () => {
    movesToStaged();
    const pane = await openFiles(['a.ts', 'b.ts']);
    openComment('a.ts');
    await settle();

    expect(reviewed('a.ts')).toBeDisabled();
    expect(reviewed('a.ts').dataset['reason']).toBe('Save or cancel the comment on a.ts first.');
    expect(reviewed('b.ts')).not.toBeDisabled();

    fireEvent.click(reviewed('a.ts'));
    await act(async () => {
      reviewApiFor('7')?.reviewCurrent();
    });
    await settle();

    expect(writes('stage')).toEqual([]);
    expect(notice()).toHaveTextContent('Save or cancel the comment on a.ts first.');
    expect(pane.toasts).toEqual([]);
    expect(paths()).toEqual(['a.ts', 'b.ts']);
    expect(editorText()).toBe('unsaved thought');

    // Cancelled, the file can be reviewed again.
    fireEvent.click(screen.getByTestId('review-comment-cancel'));
    await settle();
    expect(reviewed('a.ts')).not.toBeDisabled();
    await press(reviewed('a.ts'));
    expect(writes('stage').map((r) => r.body?.['path'])).toEqual(['a.ts']);
  });

  it('Unstage in Staged is held the same way', async () => {
    server.status[REPO] = statusBody({ staged: [entry('a.ts'), entry('b.ts')] });
    for (const p of ['a.ts', 'b.ts']) server.files[p] = snapshot(p, { group: 'staged' });
    mountReview({ tab: tab(`staged:${REPO}`) });
    await screen.findByTestId('review-list');
    await settle();
    openComment('a.ts');
    await settle();

    expect(unstage('a.ts')).toBeDisabled();
    expect(unstage('a.ts').dataset['reason']).toBe('Save or cancel the comment on a.ts first.');
    expect(unstage('b.ts')).not.toBeDisabled();
    await act(async () => {
      reviewApiFor('7')?.reviewCurrent();
    });
    await settle();

    expect(writes('unstage')).toEqual([]);
    expect(notice()).toHaveTextContent('Save or cancel the comment on a.ts first.');
    expect(editorText()).toBe('unsaved thought');
  });
});

// ── The keys ─────────────────────────────────────────────────────────────────

describe('Reviewed from the keyboard', () => {
  it('reviews the file in view, then the next one', async () => {
    movesToStaged();
    await openFiles();
    const api = reviewApiFor('7');
    expect(api).toBeDefined();
    await act(async () => {
      api?.reviewCurrent();
    });
    await settle();
    expect(writes('stage').map((r) => r.body?.['path'])).toEqual(['a.ts']);
    // The view moved to b.ts, so the same key reviews b.ts now.
    await act(async () => {
      api?.reviewCurrent();
    });
    await settle();
    expect(writes('stage').map((r) => r.body?.['path'])).toEqual(['a.ts', 'b.ts']);
  });

  it('unstages in a Staged review', async () => {
    server.status[REPO] = statusBody({ staged: [entry('a.ts')] });
    server.files['a.ts'] = snapshot('a.ts', { group: 'staged' });
    mountReview({ tab: tab(`staged:${REPO}`) });
    await screen.findByTestId('review-list');
    await settle();
    await act(async () => {
      reviewApiFor('7')?.reviewCurrent();
    });
    await settle();
    expect(writes('unstage')).toHaveLength(1);
    expect(writes('stage')).toEqual([]);
  });

  it('does nothing in a review that is hidden', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.ts')] });
    server.files['a.ts'] = snapshot('a.ts');
    const pane = mountReview();
    await screen.findByTestId('review-list');
    await settle();
    pane.show(false);
    await act(async () => {
      reviewApiFor('7')?.reviewCurrent();
    });
    await settle();
    expect(writes('stage')).toEqual([]);
  });

  it('is not registered once the pane is gone', async () => {
    server.status[REPO] = statusBody({ changes: [entry('a.ts')] });
    const pane = mountReview();
    await settle();
    expect(reviewApiFor('7')).toBeDefined();
    pane.unmount();
    expect(reviewApiFor('7')).toBeUndefined();
  });
});
