import { describe, expect, it, vi } from 'vitest';
import type { ScmAlgorithm, ScmFileSnapshot } from '@palmux/shared';
import {
  FETCH_CONCURRENCY,
  FileQueue,
  MAX_LOADED_BYTES,
  MAX_LOADED_FILES,
  snapshotKey,
  type EvictReason,
  type FileQueueOptions,
  type QueueEntry,
  type SnapshotRequest,
} from './file-queue';

// ── harness ───────────────────────────────────────────────────────────────────

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

interface Pending {
  request: SnapshotRequest;
  signal: AbortSignal;
  settled: boolean;
  resolve: (snapshot: ScmFileSnapshot) => void;
  reject: (error: unknown) => void;
}

interface SnapOptions {
  version?: string;
  algorithm?: ScmAlgorithm;
  size?: number;
}

function snap(request: SnapshotRequest, options: SnapOptions = {}): ScmFileSnapshot {
  const size = options.size ?? 10;
  return {
    path: request.path,
    group: 'changes',
    algorithm: options.algorithm ?? request.algorithm,
    old: { id: 'old', text: 'o'.repeat(size) },
    new: { id: 'new', text: 'n'.repeat(size) },
    hunks: [],
    binary: false,
    tooLarge: false,
    converted: false,
    unmerged: false,
    modes: {},
    attrs: {},
    version: options.version ?? `v-${request.path}`,
  };
}

const entries = (count: number, fp = (i: number) => `fp${i}`): QueueEntry[] =>
  Array.from({ length: count }, (_, i) => ({
    path: `f${i}.ts`,
    fp: fp(i),
    kind: 'ordinary' as const,
  }));

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function harness(
  overrides: Partial<FileQueueOptions> = {},
  behaviour: { ignoreAbort?: boolean } = {},
) {
  const pending: Pending[] = [];
  const loads: { path: string; snapshot: ScmFileSnapshot; changed: boolean }[] = [];
  const evictions: { path: string; reason: EvictReason }[] = [];
  const errors: { path: string; error: unknown }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const queue = new FileQueue({
    algorithm: 'histogram',
    fetch: (request, signal) =>
      new Promise<ScmFileSnapshot>((resolve, reject) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const entry: Pending = {
          request,
          signal,
          settled: false,
          resolve: (snapshot) => {
            if (entry.settled) return;
            entry.settled = true;
            inFlight--;
            resolve(snapshot);
          },
          reject: (error) => {
            if (entry.settled) return;
            entry.settled = true;
            inFlight--;
            reject(error);
          },
        };
        pending.push(entry);
        if (!behaviour.ignoreAbort) {
          signal.addEventListener('abort', () => entry.reject(new Error('aborted')));
        }
      }),
    onLoad: (path, snapshot, changed) => loads.push({ path, snapshot, changed }),
    onEvict: (path, reason) => evictions.push({ path, reason }),
    onError: (path, error) => errors.push({ path, error }),
    ...overrides,
  });

  const open = () => pending.filter((p) => !p.settled);
  const paths = () => open().map((p) => p.request.path);
  /** Answer the open request for `path` and let the queue react. */
  const answer = async (path: string, options?: SnapOptions): Promise<void> => {
    const target = must(open().find((p) => p.request.path === path));
    target.resolve(snap(target.request, options));
    await flush();
  };
  /** Answer every open request, then whatever those started, until nothing is open. */
  const drain = async (): Promise<void> => {
    for (let round = 0; round < 100 && open().length > 0; round++) {
      for (const target of open()) target.resolve(snap(target.request));
      // oxlint-disable-next-line no-await-in-loop -- each round's answers start the next round's requests
      await flush();
    }
  };
  return {
    queue,
    pending,
    loads,
    evictions,
    errors,
    open,
    paths,
    answer,
    drain,
    maxInFlight: () => maxInFlight,
    requestedPaths: () => pending.map((p) => p.request.path),
  };
}

// ── what is fetched ───────────────────────────────────────────────────────────

describe('FileQueue fetching', () => {
  it('uses the limits the design names', () => {
    expect(FETCH_CONCURRENCY).toBe(4);
    expect(MAX_LOADED_FILES).toBe(60);
    expect(MAX_LOADED_BYTES).toBe(40 * 1024 * 1024);
  });

  it('fetches nothing until a range is visible', () => {
    const h = harness();
    h.queue.setFiles(entries(400), 'e1');
    expect(h.pending).toHaveLength(0);
  });

  it('fetches only files within two of the visible range, however many files there are', async () => {
    const h = harness();
    h.queue.setFiles(entries(400), 'e1');
    h.queue.setVisible(100, 102);

    // Seven files are in reach (98..104); four start now, the rest as those answer.
    expect(h.pending).toHaveLength(4);
    await h.drain();
    await flush();

    expect(new Set(h.requestedPaths())).toEqual(
      new Set(['f98.ts', 'f99.ts', 'f100.ts', 'f101.ts', 'f102.ts', 'f103.ts', 'f104.ts']),
    );
    expect(h.pending).toHaveLength(7);
  });

  it('starts the visible files first, then the nearest neighbours', () => {
    const h = harness();
    h.queue.setFiles(entries(50), 'e1');
    h.queue.setVisible(10, 12);
    expect(h.paths()).toEqual(['f10.ts', 'f11.ts', 'f12.ts', 'f9.ts']);
  });

  it('never has more than four requests in flight', async () => {
    const h = harness();
    h.queue.setFiles(entries(100), 'e1');
    h.queue.setVisible(20, 40);
    expect(h.open()).toHaveLength(4);

    // Answer them in a scrambled order, as a real network would.
    for (let round = 0; round < 30 && h.open().length > 0; round++) {
      const open = h.open();
      // oxlint-disable-next-line no-await-in-loop -- each answer starts the next request
      await h.answer(must(open[open.length - 1]).request.path);
    }
    expect(h.maxInFlight()).toBe(4);
    expect(new Set(h.requestedPaths()).size).toBe(25);
  });

  it('honours a different concurrency', () => {
    const h = harness({ concurrency: 2 });
    h.queue.setFiles(entries(20), 'e1');
    h.queue.setVisible(5, 8);
    expect(h.open()).toHaveLength(2);
  });

  it('starts the next file when one answers', async () => {
    const h = harness();
    h.queue.setFiles(entries(20), 'e1');
    h.queue.setVisible(0, 1);
    expect(h.open()).toHaveLength(4);
    await h.answer('f0.ts');
    expect(h.open().map((p) => p.request.path)).toContain('f3.ts');
    expect(h.open()).toHaveLength(3);
  });

  it('asks again for a fetched file only when something it shows changed', async () => {
    const h = harness();
    h.queue.setFiles(entries(3), 'e1');
    h.queue.setVisible(0, 2);
    await h.drain();
    expect(h.pending).toHaveLength(3);

    h.queue.setFiles(entries(3), 'e1');
    h.queue.setVisible(0, 1);
    expect(h.pending).toHaveLength(3);
  });

  it('delivers the snapshot and reports it as new', async () => {
    const h = harness();
    h.queue.setFiles(entries(2), 'e1');
    h.queue.setVisible(0, 0);
    await h.answer('f0.ts');
    expect(h.loads).toHaveLength(1);
    expect(h.loads[0]).toMatchObject({ path: 'f0.ts', changed: true });
    expect(h.queue.get('f0.ts')).toBe(h.loads[0]?.snapshot);
    expect(h.queue.status('f0.ts')).toBe('ready');
    expect(h.queue.status('f1.ts')).toBe('loading');
    expect(h.queue.status('missing.ts')).toBe('idle');
  });

  it('passes the algorithm and a rename’s old path to the fetch', () => {
    const h = harness({ algorithm: 'patience' });
    const rename: QueueEntry = { path: 'b.ts', oldPath: 'a.ts', fp: 'x', kind: 'rename' };
    h.queue.setFiles([rename, ...entries(1)], 'e1');
    h.queue.setVisible(0, 0);
    expect(h.pending[0]?.request).toEqual({ path: 'b.ts', oldPath: 'a.ts', algorithm: 'patience' });
    expect(h.pending[1]?.request).toEqual({ path: 'f0.ts', algorithm: 'patience' });
  });

  it('never asks for a conflicted file', () => {
    const h = harness();
    const conflicted: QueueEntry = { path: 'c.ts', fp: 'x', kind: 'unmerged' };
    h.queue.setFiles([conflicted, ...entries(2)], 'e1');
    h.queue.setVisible(0, 2);
    expect(h.requestedPaths()).toEqual(['f0.ts', 'f1.ts']);
  });

  it('fetches a file that joins the group when it is within reach', async () => {
    const h = harness();
    h.queue.setFiles(entries(3), 'e1');
    h.queue.setVisible(0, 2);
    await h.drain();

    const grown = [...entries(3), { path: 'new.ts', fp: 'n', kind: 'ordinary' as const }];
    h.queue.setFiles(grown, 'e1');
    expect(h.paths()).toEqual(['new.ts']);
  });

  it('waits to fetch a file that joins out of reach until it is scrolled to', async () => {
    const h = harness({ window: 0 });
    h.queue.setFiles(entries(3), 'e1');
    h.queue.setVisible(0, 2);
    await h.drain();

    const grown = [...entries(3), { path: 'new.ts', fp: 'n', kind: 'ordinary' as const }];
    h.queue.setFiles(grown, 'e1');
    expect(h.paths()).toEqual([]);
    h.queue.setVisible(1, 3);
    expect(h.paths()).toEqual(['new.ts']);
  });
});

// ── freshness ─────────────────────────────────────────────────────────────────

describe('FileQueue refetching', () => {
  it('refetches only the file whose fingerprint changed', async () => {
    const h = harness();
    h.queue.setFiles(entries(3), 'e1');
    h.queue.setVisible(0, 2);
    await h.drain();

    h.queue.setFiles(
      entries(3, (i) => (i === 1 ? 'changed' : `fp${i}`)),
      'e1',
    );
    expect(h.paths()).toEqual(['f1.ts']);
  });

  it('keeps showing the old snapshot while the refetch is out', async () => {
    const h = harness();
    h.queue.setFiles(entries(1), 'e1');
    h.queue.setVisible(0, 0);
    await h.answer('f0.ts');
    const before = h.queue.get('f0.ts');

    h.queue.setFiles(
      entries(1, () => 'changed'),
      'e1',
    );
    expect(h.queue.get('f0.ts')).toBe(before);
    expect(h.queue.status('f0.ts')).toBe('ready');
  });

  it('refetches a loaded file outside the window too, so it is current when scrolled to', async () => {
    const h = harness();
    h.queue.setFiles(entries(30), 'e1');
    h.queue.setVisible(0, 0);
    await h.drain();
    h.queue.setVisible(20, 20);
    await h.drain();
    const before = h.pending.length;

    h.queue.setFiles(
      entries(30, (i) => (i === 0 ? 'edited' : `fp${i}`)),
      'e1',
    );
    expect(h.pending.length).toBe(before + 1);
    expect(h.pending[before]?.request.path).toBe('f0.ts');
  });

  it('serves nearby changed files before far ones', async () => {
    const h = harness({ concurrency: 1 });
    h.queue.setFiles(entries(30), 'e1');
    h.queue.setVisible(0, 0);
    await h.drain();
    h.queue.setVisible(20, 20);
    await h.drain();

    const before = h.pending.length;
    h.queue.setFiles(
      entries(30, (i) => (i === 0 || i === 19 ? 'edited' : `fp${i}`)),
      'e1',
    );
    expect(h.pending[before]?.request.path).toBe('f19.ts');
  });

  it('refetches every loaded file when the attribute epoch changes', async () => {
    const h = harness();
    h.queue.setFiles(entries(3), 'e1');
    h.queue.setVisible(0, 2);
    await h.drain();

    h.queue.setFiles(entries(3), 'e2');
    expect(h.paths().toSorted()).toEqual(['f0.ts', 'f1.ts', 'f2.ts']);
  });

  it('does not treat the first epoch it hears as a change', async () => {
    const h = harness();
    h.queue.setFiles(entries(2), 'e1');
    h.queue.setVisible(0, 1);
    await h.drain();
    h.queue.setFiles(entries(2), 'e1');
    expect(h.paths()).toEqual([]);
  });

  it('refetches loaded files with the new algorithm and keeps the old snapshot until it lands', async () => {
    const h = harness();
    h.queue.setFiles(entries(2), 'e1');
    h.queue.setVisible(0, 1);
    await h.drain();
    const old = h.queue.get('f0.ts');

    h.queue.setAlgorithm('myers');
    expect(h.paths().toSorted()).toEqual(['f0.ts', 'f1.ts']);
    expect(h.open().every((p) => p.request.algorithm === 'myers')).toBe(true);
    expect(h.queue.get('f0.ts')).toBe(old);

    await h.answer('f0.ts');
    expect(h.queue.get('f0.ts')?.algorithm).toBe('myers');
  });

  it('does nothing for the algorithm it already has', async () => {
    const h = harness();
    h.queue.setFiles(entries(1), 'e1');
    h.queue.setVisible(0, 0);
    await h.answer('f0.ts');
    h.queue.setAlgorithm('histogram');
    expect(h.paths()).toEqual([]);
  });

  describe('the cache key', () => {
    it('is the version plus the algorithm', () => {
      const request: SnapshotRequest = { path: 'a', algorithm: 'myers' };
      expect(snapshotKey(snap(request, { version: 'v1' }))).toBe('v1|myers');
      expect(snapshotKey(snap(request, { version: 'v1', algorithm: 'patience' }))).toBe(
        'v1|patience',
      );
    });

    it('reports a refetch that brings the same key as unchanged, and still renews the snapshot', async () => {
      const h = harness();
      h.queue.setFiles(entries(1), 'e1');
      h.queue.setVisible(0, 0);
      await h.answer('f0.ts', { version: 'same' });
      const first = h.queue.get('f0.ts');

      // Touched on disk but not changed in content: the fingerprint moved, the version did not.
      h.queue.setFiles(
        entries(1, () => 'touched'),
        'e1',
      );
      await h.answer('f0.ts', { version: 'same' });

      expect(h.loads.map((l) => l.changed)).toEqual([true, false]);
      expect(h.queue.get('f0.ts')).not.toBe(first);
    });

    it('reports a new version as changed', async () => {
      const h = harness();
      h.queue.setFiles(entries(1), 'e1');
      h.queue.setVisible(0, 0);
      await h.answer('f0.ts', { version: 'one' });
      h.queue.setFiles(
        entries(1, () => 'edited'),
        'e1',
      );
      await h.answer('f0.ts', { version: 'two' });
      expect(h.loads.map((l) => l.changed)).toEqual([true, true]);
    });

    it('reports the same version under another algorithm as changed', async () => {
      const h = harness();
      h.queue.setFiles(entries(1), 'e1');
      h.queue.setVisible(0, 0);
      await h.answer('f0.ts', { version: 'same' });
      h.queue.setAlgorithm('myers');
      await h.answer('f0.ts', { version: 'same' });
      expect(h.loads.map((l) => l.changed)).toEqual([true, true]);
    });
  });
});

// ── generations ───────────────────────────────────────────────────────────────

describe('FileQueue generations', () => {
  it('aborts the request in flight when the file changes, and starts a new one', () => {
    const h = harness();
    h.queue.setFiles(entries(1), 'e1');
    h.queue.setVisible(0, 0);
    const first = must(h.pending[0]);

    h.queue.setFiles(
      entries(1, () => 'edited'),
      'e1',
    );
    expect(first.signal.aborted).toBe(true);
    expect(h.pending).toHaveLength(2);
    expect(h.open().map((p) => p.request.path)).toEqual(['f0.ts']);
  });

  it('drops an older answer that arrives after a newer one', async () => {
    const h = harness({}, { ignoreAbort: true });
    h.queue.setFiles(entries(1), 'e1');
    h.queue.setVisible(0, 0);
    const older = must(h.pending[0]);

    h.queue.setFiles(
      entries(1, () => 'edited'),
      'e1',
    );
    const newer = must(h.pending[1]);
    newer.resolve(snap(newer.request, { version: 'new' }));
    await flush();
    older.resolve(snap(older.request, { version: 'old' }));
    await flush();

    expect(h.loads.map((l) => l.snapshot.version)).toEqual(['new']);
    expect(h.queue.get('f0.ts')?.version).toBe('new');
  });

  it('drops an older answer that arrives before the newer one is even started', async () => {
    const h = harness({ concurrency: 1 }, { ignoreAbort: true });
    h.queue.setFiles(entries(1), 'e1');
    h.queue.setVisible(0, 0);
    const older = must(h.pending[0]);

    // The only slot is still held by the superseded request, so the new one waits.
    h.queue.setFiles(
      entries(1, () => 'edited'),
      'e1',
    );
    expect(h.pending).toHaveLength(1);

    older.resolve(snap(older.request, { version: 'old' }));
    await flush();
    expect(h.loads).toEqual([]);
    expect(h.queue.get('f0.ts')).toBeUndefined();
    // Settling freed the slot, and the new request started.
    expect(h.pending).toHaveLength(2);
  });

  it('counts a superseded request against the cap until it settles', () => {
    const h = harness({ concurrency: 4 }, { ignoreAbort: true });
    h.queue.setFiles(entries(10), 'e1');
    h.queue.setVisible(0, 9);
    expect(h.pending).toHaveLength(4);

    h.queue.setFiles(
      entries(10, () => 'edited'),
      'e1',
    );
    // All four were superseded but are still in flight: nothing new may start.
    expect(h.pending).toHaveLength(4);
    expect(h.queue.stats().active).toBe(4);
  });

  it('ignores the failure of a superseded request', async () => {
    const h = harness();
    h.queue.setFiles(entries(1), 'e1');
    h.queue.setVisible(0, 0);
    h.queue.setFiles(
      entries(1, () => 'edited'),
      'e1',
    );
    await flush();
    expect(h.errors).toEqual([]);
    expect(h.queue.status('f0.ts')).toBe('loading');
  });

  it('drops an answer for a file that has left the group', async () => {
    const h = harness({}, { ignoreAbort: true });
    h.queue.setFiles(entries(2), 'e1');
    h.queue.setVisible(0, 1);
    const gone = must(h.pending.find((p) => p.request.path === 'f1.ts'));

    h.queue.setFiles(entries(1), 'e1');
    gone.resolve(snap(gone.request));
    await flush();
    expect(h.loads.map((l) => l.path)).not.toContain('f1.ts');
    expect(h.queue.get('f1.ts')).toBeUndefined();
  });

  it('drops an answer from before the algorithm changed', async () => {
    const h = harness({}, { ignoreAbort: true });
    h.queue.setFiles(entries(1), 'e1');
    h.queue.setVisible(0, 0);
    const older = must(h.pending[0]);
    h.queue.setAlgorithm('myers');
    older.resolve(snap(older.request));
    await flush();
    expect(h.loads).toEqual([]);
  });
});

/** Load files 0..count-1 one after another, scrolling to each. */
async function loadInOrder(h: ReturnType<typeof harness>, count: number, size?: number) {
  for (let i = 0; i < count; i++) {
    h.queue.setVisible(i, i);
    // oxlint-disable-next-line no-await-in-loop -- the next file is only wanted once this one is in
    await h.answer(`f${i}.ts`, size === undefined ? undefined : { size });
  }
}

// ── memory ────────────────────────────────────────────────────────────────────

describe('FileQueue memory', () => {
  it('keeps at most the file limit and evicts the least recently used', async () => {
    const h = harness({ maxFiles: 3, window: 0 });
    h.queue.setFiles(entries(10), 'e1');
    await loadInOrder(h, 5);

    expect(h.evictions).toEqual([
      { path: 'f0.ts', reason: 'count' },
      { path: 'f1.ts', reason: 'count' },
    ]);
    expect(h.queue.stats().files).toBe(3);
    expect(h.queue.get('f0.ts')).toBeUndefined();
    expect(h.queue.get('f4.ts')).toBeDefined();
  });

  it('treats scrolling back to a file as using it', async () => {
    const h = harness({ maxFiles: 3, window: 0 });
    h.queue.setFiles(entries(10), 'e1');
    await loadInOrder(h, 3);
    h.queue.setVisible(0, 0);

    h.queue.setVisible(3, 3);
    await h.answer('f3.ts');
    // f0 was touched by the scroll back, so f1 is the oldest.
    expect(h.evictions).toEqual([{ path: 'f1.ts', reason: 'count' }]);
  });

  it('evicts by the bytes of text it holds', async () => {
    const h = harness({ maxBytes: 100, window: 0 });
    h.queue.setFiles(entries(10), 'e1');
    // 20 + 20 characters a file: the third file takes the total to 120.
    await loadInOrder(h, 3, 20);

    expect(h.evictions).toEqual([{ path: 'f0.ts', reason: 'bytes' }]);
    expect(h.queue.stats().bytes).toBe(80);
  });

  it('keeps the file that just landed even when it alone is over the budget', async () => {
    const h = harness({ maxBytes: 100, window: 0 });
    h.queue.setFiles(entries(3), 'e1');
    await loadInOrder(h, 1, 20);
    h.queue.setVisible(1, 1);
    await h.answer('f1.ts', { size: 500 });

    expect(h.evictions).toEqual([{ path: 'f0.ts', reason: 'bytes' }]);
    expect(h.queue.get('f1.ts')).toBeDefined();
    expect(h.queue.stats().files).toBe(1);
  });

  it('accounts a refreshed file by its new size, not both', async () => {
    const h = harness({ window: 0 });
    h.queue.setFiles(entries(1), 'e1');
    await loadInOrder(h, 1, 20);
    expect(h.queue.stats().bytes).toBe(40);

    h.queue.setFiles(
      entries(1, () => 'edited'),
      'e1',
    );
    await h.answer('f0.ts', { size: 30, version: 'two' });
    expect(h.queue.stats().bytes).toBe(60);
    expect(h.queue.stats().files).toBe(1);
  });

  it('does not refetch an evicted file that is out of reach', async () => {
    const h = harness({ maxFiles: 2, window: 0 });
    h.queue.setFiles(entries(10), 'e1');
    await loadInOrder(h, 3);
    const before = h.pending.length;
    h.queue.setFiles(
      entries(10, (i) => (i === 0 ? 'edited' : `fp${i}`)),
      'e1',
    );
    expect(h.pending.length).toBe(before);
    expect(h.queue.status('f0.ts')).toBe('idle');
  });

  it('fetches an evicted file again when it is scrolled back to', async () => {
    const h = harness({ maxFiles: 2, window: 0 });
    h.queue.setFiles(entries(10), 'e1');
    await loadInOrder(h, 3);
    h.queue.setVisible(0, 0);
    expect(h.paths()).toEqual(['f0.ts']);
  });

  it('aborts a refresh of a file it evicts, so it does not come straight back', async () => {
    const h = harness({ maxFiles: 2, window: 0 });
    h.queue.setFiles(entries(10), 'e1');
    await loadInOrder(h, 2);
    h.queue.setFiles(
      entries(10, (i) => (i === 0 ? 'edited' : `fp${i}`)),
      'e1',
    );
    const refresh = must(h.open().find((p) => p.request.path === 'f0.ts'));

    h.queue.setVisible(2, 2);
    await h.answer('f2.ts');
    expect(h.evictions.map((e) => e.path)).toEqual(['f0.ts']);
    expect(refresh.signal.aborted).toBe(true);
    expect(h.queue.get('f0.ts')).toBeUndefined();
  });

  it('reports a file that left the group as removed, and aborts its request', async () => {
    const h = harness();
    h.queue.setFiles(entries(3), 'e1');
    h.queue.setVisible(0, 2);
    await h.answer('f0.ts');
    const inFlight = must(h.open().find((p) => p.request.path === 'f1.ts'));

    h.queue.setFiles(entries(3).slice(2), 'e1');
    expect(h.evictions).toEqual([{ path: 'f0.ts', reason: 'removed' }]);
    expect(inFlight.signal.aborted).toBe(true);
    expect(h.queue.stats().files).toBe(0);
    expect(h.queue.stats().bytes).toBe(0);
  });
});

// ── pausing, failing, ending ──────────────────────────────────────────────────

describe('FileQueue control', () => {
  it('starts nothing while disabled, and starts what is wanted when enabled', () => {
    const h = harness();
    h.queue.setEnabled(false);
    h.queue.setFiles(entries(5), 'e1');
    h.queue.setVisible(0, 1);
    expect(h.pending).toHaveLength(0);

    h.queue.setEnabled(true);
    // The two visible files and the two beyond them.
    expect(h.paths()).toEqual(['f0.ts', 'f1.ts', 'f2.ts', 'f3.ts']);
  });

  it('starts no refresh while disabled, but lets an answer in flight land', async () => {
    const h = harness();
    h.queue.setFiles(entries(2), 'e1');
    h.queue.setVisible(0, 1);
    h.queue.setEnabled(false);
    await h.answer('f0.ts');
    expect(h.loads).toHaveLength(1);

    // Both files are now stale and the request for f1 is superseded: nothing restarts.
    h.queue.setFiles(
      entries(2, () => 'edited'),
      'e1',
    );
    expect(h.paths()).toEqual([]);

    h.queue.setEnabled(true);
    expect(h.paths().toSorted()).toEqual(['f0.ts', 'f1.ts']);
  });

  describe('failure', () => {
    it('reports it once and does not retry on its own', async () => {
      const h = harness();
      h.queue.setFiles(entries(1), 'e1');
      h.queue.setVisible(0, 0);
      const boom = new Error('boom');
      must(h.pending[0]).reject(boom);
      await flush();
      h.queue.setFiles(entries(1), 'e1');
      h.queue.setVisible(0, 0);

      expect(h.errors).toEqual([{ path: 'f0.ts', error: boom }]);
      expect(h.pending).toHaveLength(1);
      expect(h.queue.status('f0.ts')).toBe('error');
      expect(h.queue.errorOf('f0.ts')).toBe(boom);
    });

    it('retries on request', async () => {
      const h = harness();
      h.queue.setFiles(entries(1), 'e1');
      h.queue.setVisible(0, 0);
      must(h.pending[0]).reject(new Error('boom'));
      await flush();
      h.queue.retry('f0.ts');
      expect(h.pending).toHaveLength(2);
      expect(h.queue.status('f0.ts')).toBe('loading');
      h.queue.retry('missing.ts');
    });

    it('retries when the file changes', async () => {
      const h = harness();
      h.queue.setFiles(entries(1), 'e1');
      h.queue.setVisible(0, 0);
      must(h.pending[0]).reject(new Error('boom'));
      await flush();
      h.queue.setFiles(
        entries(1, () => 'edited'),
        'e1',
      );
      expect(h.pending).toHaveLength(2);
    });

    it('retries when the file is scrolled away from and back to', async () => {
      const h = harness({ window: 0 });
      h.queue.setFiles(entries(10), 'e1');
      h.queue.setVisible(0, 0);
      must(h.pending[0]).reject(new Error('boom'));
      await flush();

      h.queue.setVisible(5, 5);
      await h.answer('f5.ts');
      h.queue.setVisible(0, 0);
      expect(h.open().map((p) => p.request.path)).toEqual(['f0.ts']);
    });

    it('keeps the stale snapshot on screen when its refresh fails', async () => {
      const h = harness();
      h.queue.setFiles(entries(1), 'e1');
      h.queue.setVisible(0, 0);
      await h.answer('f0.ts');
      const shown = h.queue.get('f0.ts');
      h.queue.setFiles(
        entries(1, () => 'edited'),
        'e1',
      );
      must(h.open()[0]).reject(new Error('boom'));
      await flush();
      expect(h.queue.get('f0.ts')).toBe(shown);
      expect(h.queue.status('f0.ts')).toBe('ready');
      expect(h.errors).toHaveLength(1);
    });
  });

  it('stops everything on dispose', async () => {
    const h = harness({}, { ignoreAbort: true });
    h.queue.setFiles(entries(2), 'e1');
    h.queue.setVisible(0, 1);
    const open = h.open();
    h.queue.dispose();

    expect(open.every((p) => p.signal.aborted)).toBe(true);
    for (const p of open) p.resolve(snap(p.request));
    await flush();
    expect(h.loads).toEqual([]);
    expect(h.evictions).toEqual([]);

    const before = h.pending.length;
    h.queue.setFiles(entries(5), 'e1');
    h.queue.setVisible(0, 4);
    expect(h.pending.length).toBe(before);
  });

  it('does not throw when answers arrive after dispose', async () => {
    const spy = vi.fn();
    const h = harness({ onLoad: spy });
    h.queue.setFiles(entries(1), 'e1');
    h.queue.setVisible(0, 0);
    const pending = must(h.pending[0]);
    h.queue.dispose();
    pending.resolve(snap(pending.request));
    await flush();
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── a person asked for this file ──────────────────────────────────────────────

describe('FileQueue load and reload', () => {
  it('fetches a file far from the visible range, and resolves with its snapshot', async () => {
    const h = harness();
    h.queue.setFiles(entries(30), 'e1');
    h.queue.setVisible(0, 0);
    await h.drain();
    expect(h.requestedPaths()).not.toContain('f25.ts');

    const loading = h.queue.load('f25.ts');
    expect(h.paths()).toEqual(['f25.ts']);
    await h.answer('f25.ts');
    const snapshot = await loading;
    expect(snapshot?.path).toBe('f25.ts');
    expect(h.queue.get('f25.ts')).toBe(snapshot);
    expect(h.loads.at(-1)).toMatchObject({ path: 'f25.ts', changed: true });
  });

  it('fetches although the queue is disabled: a hidden review starts nothing by itself, not for a person', async () => {
    const h = harness();
    h.queue.setFiles(entries(3), 'e1');
    h.queue.setEnabled(false);
    const loading = h.queue.load('f1.ts');
    expect(h.paths()).toEqual(['f1.ts']);
    await h.answer('f1.ts');
    expect(await loading).not.toBeNull();
  });

  it('does not fetch what it already holds', async () => {
    const h = harness();
    h.queue.setFiles(entries(1), 'e1');
    h.queue.setVisible(0, 0);
    await h.drain();
    const before = h.requestedPaths().length;
    const held = h.queue.get('f0.ts');
    expect(await h.queue.load('f0.ts')).toBe(held);
    expect(h.requestedPaths()).toHaveLength(before);
  });

  it('fetches a held file that is stale, and one that failed', async () => {
    const h = harness();
    h.queue.setFiles(entries(1), 'e1');
    h.queue.setVisible(0, 0);
    await h.drain();
    h.queue.setFiles(
      entries(1, () => 'changed'),
      'e1',
    );
    h.queue.setEnabled(false);
    h.pending.at(-1)?.reject(new Error('aborted'));
    const loading = h.queue.load('f0.ts');
    await h.answer('f0.ts');
    expect(await loading).not.toBeNull();
  });

  it('answers null for a file that is not in the group, and for one that cannot be read', async () => {
    const h = harness();
    h.queue.setFiles(entries(1), 'e1');
    expect(await h.queue.load('nope.ts')).toBeNull();
    const loading = h.queue.load('f0.ts');
    h.open()[0]?.reject(new Error('boom'));
    expect(await loading).toBeNull();
    expect(h.errors).toHaveLength(1);
  });

  it('reloads a file it holds, and lands a renewed token without a change', async () => {
    const h = harness();
    h.queue.setFiles(entries(1), 'e1');
    h.queue.setVisible(0, 0);
    await h.answer('f0.ts');

    const reloading = h.queue.reload('f0.ts');
    expect(h.paths()).toEqual(['f0.ts']);
    await h.answer('f0.ts');
    expect(await reloading).not.toBeNull();
    // The same version, the same algorithm: the rows built from it stay valid.
    expect(h.loads.at(-1)?.changed).toBe(false);
  });

  it('lands another version as a change', async () => {
    const h = harness();
    h.queue.setFiles(entries(1), 'e1');
    h.queue.setVisible(0, 0);
    await h.answer('f0.ts');
    const reloading = h.queue.reload('f0.ts');
    await h.answer('f0.ts', { version: 'v2' });
    expect((await reloading)?.version).toBe('v2');
    expect(h.loads.at(-1)?.changed).toBe(true);
  });

  it('replaces a request in flight instead of waiting on an older one', async () => {
    const h = harness();
    h.queue.setFiles(entries(1), 'e1');
    h.queue.setVisible(0, 0);
    expect(h.paths()).toEqual(['f0.ts']);
    const first = h.open()[0];
    const reloading = h.queue.reload('f0.ts');
    expect(first?.signal.aborted).toBe(true);
    await h.answer('f0.ts');
    expect(await reloading).not.toBeNull();
    // Only the answer that started after the ask landed.
    expect(h.loads).toHaveLength(1);
  });
});
