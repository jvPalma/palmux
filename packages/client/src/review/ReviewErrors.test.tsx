// A file that failed to load draws its message and a Retry button in the row where
// its diff would go. A binary or mode-only file's row is estimated at one line, and
// a button taller than that overlapped the next file's header.

import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeServer,
  REPO,
  colorize,
  entry,
  fileRow,
  mountReview,
  offsetOf,
  rowByKey,
  settle,
  setup,
  snapshot,
  statusBody,
  teardown,
} from './review-test-support';
import { ROW_METRICS } from './review-metrics';

vi.mock('../panes/monaco-loader', () => ({
  getMonaco: () => ({ editor: { colorize: (text: string) => colorize(text) } }),
}));

let server: FakeServer;
beforeEach(() => {
  server = setup();
});
afterEach(teardown);

const refuses = () =>
  Promise.resolve({
    ok: false,
    status: 500,
    json: () => Promise.resolve({ error: 'git said no' }),
  });

describe('an errored placeholder', () => {
  async function open() {
    server.status[REPO] = statusBody({
      changes: [entry('a.bin', { binary: true }), entry('b.ts')],
    });
    server.files['a.bin'] = refuses;
    server.files['b.ts'] = snapshot('b.ts');
    mountReview();
    await screen.findByTestId('review-list');
    await settle();
  }

  it('is as tall as its message and Retry need, so the next header is not overlapped', async () => {
    await open();
    const placeholder = rowByKey('a.bin|placeholder');
    expect(within(placeholder).getByTestId('review-retry')).toBeInTheDocument();
    const gap = offsetOf(fileRow('b.ts')) - offsetOf(fileRow('a.bin'));
    expect(gap).toBe(ROW_METRICS.header + ROW_METRICS.error);
    // The row's own height holds the button: a small kit button is under it, on a phone too.
    expect(placeholder.style.height).toBe(`${ROW_METRICS.error}px`);
  });

  it('goes back to its small height once Retry loads the file', async () => {
    await open();
    server.files['a.bin'] = snapshot('a.bin', { binary: true, hunks: [] });
    fireEvent.click(screen.getByTestId('review-retry'));
    await settle();
    expect(screen.queryByTestId('review-retry')).toBeNull();
    expect(screen.queryByTestId('review-placeholder-error')).toBeNull();
    // The binary notice replaced it; the next header sits right under.
    expect(offsetOf(fileRow('b.ts')) - offsetOf(fileRow('a.bin'))).toBe(
      ROW_METRICS.header + ROW_METRICS.notice,
    );
  });
});
