// Moving through a review by change and by file, from `diff-review` ("The review
// is navigable by change and by file"): the keys reach the pane through the
// registry; "next change" crosses a file's last change into the next file's first,
// and fetches a file that has not loaded before it moves into it.

import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScmFileSnapshot } from '@palmux/shared';
import {
  FakeServer,
  REPO,
  colorize,
  entry,
  fileRow,
  hunk,
  lines,
  measureRow,
  mountReview,
  offsetOf,
  rowByKey,
  scroller,
  settle,
  setup,
  snapshot,
  statusBody,
  teardown,
} from './review-test-support';
import { NAV_CONTEXT_PX } from './review-nav';
import { reviewApiFor, type ReviewApi } from './review-registry';

vi.mock('../panes/monaco-loader', () => ({
  getMonaco: () => ({ editor: { colorize: (text: string) => colorize(text) } }),
}));

let server: FakeServer;
beforeEach(() => {
  server = setup();
});
afterEach(teardown);

/** A 60-line file with two changes, at lines 10 and 40, three lines of context round each. */
function twoChanges(path: string, over: Partial<ScmFileSnapshot> = {}): ScmFileSnapshot {
  const text = (replace: Record<number, string>): string => `${lines(60, replace).join('\n')}\n`;
  const around = (at: number): Parameters<typeof hunk>[0] => [
    ['ctx', `line ${at - 3}`],
    ['ctx', `line ${at - 2}`],
    ['ctx', `line ${at - 1}`],
    ['del', `line ${at}`],
    ['add', `edited ${at}`],
    ['ctx', `line ${at + 1}`],
    ['ctx', `line ${at + 2}`],
    ['ctx', `line ${at + 3}`],
  ];
  return snapshot(path, {
    old: { id: 'o', text: text({}) },
    new: { id: 'n', text: text({ 10: 'edited 10', 40: 'edited 40' }) },
    hunks: [hunk(around(10), { old: 7, new: 7 }), hunk(around(40), { old: 37, new: 37 })],
    ...over,
  });
}

async function open(paths: string[], over: Parameters<typeof mountReview>[0] = {}) {
  server.status[REPO] = statusBody({
    changes: paths.map((p) => entry(p, { added: 2, removed: 2 })),
  });
  for (const p of paths) server.files[p] = twoChanges(p);
  const pane = mountReview(over);
  await screen.findByTestId('review-list');
  await settle();
  return pane;
}

const api = (): ReviewApi => {
  const found = reviewApiFor('7');
  if (!found) throw new Error('no review registered');
  return found;
};

/** Press a key and let the browser report the scroll it caused. */
async function go(run: (api: ReviewApi) => void) {
  await act(async () => {
    run(api());
  });
  await settle();
  fireEvent.scroll(scroller());
  await settle();
}

/** Where `key` sits below the top of the view, or null when it is not drawn. */
const below = (key: string): number | null => {
  const row = [...scroller().querySelectorAll<HTMLElement>('[data-rv-key]')].find(
    (el) => el.dataset['rvKey'] === key,
  );
  return row ? offsetOf(row) - scroller().scrollTop : null;
};

/** The change the view is on: drawn, and no more than the context's height below the top. */
const expectOn = (key: string): void => {
  const at = below(key);
  expect(at, `${key} should be in view`).not.toBeNull();
  expect(at).toBeGreaterThanOrEqual(0);
  expect(at).toBeLessThanOrEqual(NAV_CONTEXT_PX);
};

describe('The review is navigable by change', () => {
  it('walks the changes of a file in order, with their context above', async () => {
    await open(['a.ts']);
    await go((a) => a.nextChange());
    expectOn('a.ts|0:3');
    await go((a) => a.nextChange());
    expectOn('a.ts|1:3');
    // Past the last change there is nowhere to go, and the view stays.
    const top = scroller().scrollTop;
    await go((a) => a.nextChange());
    expect(scroller().scrollTop).toBe(top);
  });

  it('next change at a file’s last change lands on the next file’s first change', async () => {
    await open(['a.ts', 'b.ts']);
    await go((a) => a.nextChange());
    await go((a) => a.nextChange());
    expectOn('a.ts|1:3');
    await go((a) => a.nextChange());
    expectOn('b.ts|0:3');
    await go((a) => a.nextChange());
    expectOn('b.ts|1:3');
  });

  it('previous change goes back the same way, across the file boundary', async () => {
    await open(['a.ts', 'b.ts']);
    await go((a) => a.nextChange());
    await go((a) => a.nextChange());
    await go((a) => a.nextChange());
    expectOn('b.ts|0:3');
    await go((a) => a.prevChange());
    expectOn('a.ts|1:3');
    await go((a) => a.prevChange());
    expectOn('a.ts|0:3');
    const top = scroller().scrollTop;
    await go((a) => a.prevChange());
    expect(scroller().scrollTop).toBe(top);
  });

  it('reads where the reader scrolled to, once they have, and not where it last jumped', async () => {
    await open(['a.ts', 'b.ts']);
    await go((a) => a.nextChange());
    // The reader scrolls on to the second file.
    const header = offsetOf(fileRow('b.ts'));
    act(() => {
      scroller().scrollTop = header + 5;
      fireEvent.scroll(scroller());
    });
    await settle();
    await go((a) => a.nextChange());
    expectOn('b.ts|0:3');
  });

  it('works in the side-by-side layout too', async () => {
    await open(['a.ts', 'b.ts'], { layout: 'split' });
    await go((a) => a.nextChange());
    expectOn('a.ts|0:3');
    await go((a) => a.nextChange());
    await go((a) => a.nextChange());
    expectOn('b.ts|0:3');
  });
});

describe('the next change is in a file that has not loaded', () => {
  it('fetches it before the view moves, and then lands on its first change', async () => {
    server.status[REPO] = statusBody({
      changes: [entry('a.ts', { added: 2, removed: 2 }), entry('b.ts', { added: 2, removed: 2 })],
    });
    server.files['a.ts'] = twoChanges('a.ts');
    // The first request for b.ts never comes back, as on a slow link.
    server.files['b.ts'] = () => new Promise(() => {});
    mountReview();
    await screen.findByTestId('review-list');
    await settle();
    expect(screen.queryAllByTestId('review-placeholder')).toHaveLength(1);
    const before = server.fileRequests().filter((r) => r.query['path'] === 'b.ts').length;

    server.files['b.ts'] = twoChanges('b.ts');
    await go((a) => a.nextChange());
    await go((a) => a.nextChange());
    expectOn('a.ts|1:3');
    await go((a) => a.nextChange());

    expect(server.fileRequests().filter((r) => r.query['path'] === 'b.ts').length).toBeGreaterThan(
      before,
    );
    expectOn('b.ts|0:3');
  });

  it('stops at the header of a file that cannot be loaded, instead of waiting for it', async () => {
    server.status[REPO] = statusBody({
      changes: [
        entry('a.ts', { added: 2, removed: 2 }),
        entry('b.ts', { added: 2, removed: 2 }),
        entry('c.ts', { added: 2, removed: 2 }),
      ],
    });
    server.files['a.ts'] = twoChanges('a.ts');
    server.files['b.ts'] = () =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) });
    server.files['c.ts'] = twoChanges('c.ts');
    mountReview();
    await screen.findByTestId('review-list');
    await settle();
    await go((a) => a.nextChange());
    await go((a) => a.nextChange());
    await go((a) => a.nextChange());
    // b.ts shows its error and Retry, and is where the view is.
    expect(below('b.ts|file')).toBe(0);
    await go((a) => a.nextChange());
    expectOn('c.ts|0:3');
  });

  it('counts a file with no text change to show as one change, at its header', async () => {
    server.status[REPO] = statusBody({
      changes: [
        entry('a.ts', { added: 2, removed: 2 }),
        entry('b.bin', { binary: true }),
        entry('c.ts', { added: 2, removed: 2 }),
      ],
    });
    server.files['a.ts'] = twoChanges('a.ts');
    server.files['b.bin'] = snapshot('b.bin', { binary: true, hunks: [] });
    server.files['c.ts'] = twoChanges('c.ts');
    mountReview();
    await screen.findByTestId('review-list');
    await settle();
    await go((a) => a.nextChange());
    await go((a) => a.nextChange());
    await go((a) => a.nextChange());
    expect(below('b.bin|file')).toBe(0);
    await go((a) => a.nextChange());
    expectOn('c.ts|0:3');
    await go((a) => a.prevChange());
    expect(below('b.bin|file')).toBe(0);
  });
});

describe('The review is navigable by file', () => {
  it('next file puts the next file’s header at the top, and stops at the last', async () => {
    await open(['a.ts', 'b.ts', 'c.ts']);
    await go((a) => a.nextFile());
    expect(scroller().scrollTop).toBe(offsetOf(fileRow('b.ts')));
    await go((a) => a.nextFile());
    expect(scroller().scrollTop).toBe(offsetOf(fileRow('c.ts')));
    const top = scroller().scrollTop;
    await go((a) => a.nextFile());
    expect(scroller().scrollTop).toBe(top);
  });

  it('previous file goes to the start of the file the view is inside, then to the one before', async () => {
    await open(['a.ts', 'b.ts', 'c.ts']);
    await go((a) => a.nextFile());
    await go((a) => a.nextFile());
    expect(scroller().scrollTop).toBe(offsetOf(fileRow('c.ts')));
    // Scroll a little way into c.ts.
    act(() => {
      scroller().scrollTop = offsetOf(fileRow('c.ts')) + 100;
      fireEvent.scroll(scroller());
    });
    await settle();
    await go((a) => a.prevFile());
    expect(scroller().scrollTop).toBe(offsetOf(fileRow('c.ts')));
    await go((a) => a.prevFile());
    expect(scroller().scrollTop).toBe(offsetOf(fileRow('b.ts')));
    await go((a) => a.prevFile());
    expect(scroller().scrollTop).toBe(0);
  });

  it('keeps the next file’s header at the top while a notice under it measures', async () => {
    // a.ts is long enough that b.ts is fetched (it is next) but not drawn yet, so
    // b.ts's rename notice is measured only once the jump has brought it into view.
    const added = lines(100);
    server.status[REPO] = statusBody({
      changes: [
        entry('a.ts', { added: 100, removed: 0 }),
        entry('b.ts', { kind: 'rename', status: 'R', oldPath: 'old-b.ts', added: 2, removed: 2 }),
        entry('c.ts', { added: 2, removed: 2 }),
      ],
    });
    server.files['a.ts'] = snapshot('a.ts', {
      old: { id: 'o', text: '' },
      new: { id: 'n', text: `${added.join('\n')}\n` },
      hunks: [
        hunk(
          added.map((text) => ['add', text]),
          { old: 0, new: 1 },
        ),
      ],
    });
    server.files['b.ts'] = twoChanges('b.ts');
    server.files['c.ts'] = twoChanges('c.ts');
    mountReview();
    await screen.findByTestId('review-list');
    await settle();
    expect(screen.queryByText('Renamed from old-b.ts')).toBeNull();

    await go((a) => a.nextFile());
    expect(scroller().scrollTop).toBe(offsetOf(fileRow('b.ts')));
    // The notice wraps to two lines: everything under it moves down, the header does not.
    measureRow(rowByKey('b.ts|notice:rename'), 56);
    await settle();
    expect(scroller().scrollTop).toBe(offsetOf(fileRow('b.ts')));
  });

  it('moves by file from where a change jump landed', async () => {
    await open(['a.ts', 'b.ts', 'c.ts']);
    await go((a) => a.nextChange());
    await go((a) => a.nextFile());
    expect(scroller().scrollTop).toBe(offsetOf(fileRow('b.ts')));
  });
});

describe('the keys act on a review that is shown', () => {
  it('ignores them while the review is hidden', async () => {
    const pane = await open(['a.ts', 'b.ts']);
    pane.show(false);
    await go((a) => a.nextFile());
    expect(scroller().scrollTop).toBe(0);
    pane.show(true);
    await go((a) => a.nextFile());
    expect(scroller().scrollTop).toBe(offsetOf(fileRow('b.ts')));
  });

  it('keeps the change it landed on after the file refreshes under it', async () => {
    await open(['a.ts']);
    await go((a) => a.nextChange());
    await go((a) => a.nextChange());
    expect(rowByKey('a.ts|1:3')).toBeTruthy();
  });
});
