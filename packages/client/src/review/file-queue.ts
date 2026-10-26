// ── The file queue: which snapshots a review fetches, and how many it keeps ───
//
// A review can list hundreds of files and only the ones near the viewport matter
// (D7). This is the framework-free engine under the pane: it is told the files, the
// visible range and the algorithm, and it fetches, bounds and refreshes snapshots
// through an injected `fetch`, reporting through callbacks. No React, no timers, no
// DOM: the pane maps the callbacks onto state and the tests drive it with promises.
//
// Three rules carry the design.
//  - A file is wanted when it is within `window` files of the visible range, and a
//    file already loaded is refreshed wherever it is, because a stale snapshot that
//    scrolls into view must not show the old version.
//  - Every request belongs to a generation. Anything that changes what a file
//    should show (its fingerprint, the attribute epoch, the algorithm) starts a new
//    generation and aborts the request in flight, and an answer from an older
//    generation is dropped, so a slow response never overwrites a newer version.
//  - The cap on requests counts a superseded request until it settles, so "at most
//    four in flight" holds even for a fetch that ignores its abort signal.

import type { ScmAlgorithm, ScmEntry, ScmFileSnapshot } from '@palmux/shared';

export const FETCH_CONCURRENCY = 4;
/** Files either side of the visible range that are fetched ahead of the scroll. */
export const FETCH_WINDOW = 2;
export const MAX_LOADED_FILES = 60;
export const MAX_LOADED_BYTES = 40 * 1024 * 1024;

/** What the queue needs of a status entry; pass the entries themselves. */
export type QueueEntry = Pick<ScmEntry, 'path' | 'oldPath' | 'fp' | 'kind'>;

export interface SnapshotRequest {
  path: string;
  oldPath?: string;
  algorithm: ScmAlgorithm;
}

export type FetchSnapshot = (
  request: SnapshotRequest,
  signal: AbortSignal,
) => Promise<ScmFileSnapshot>;

export type EvictReason = 'count' | 'bytes' | 'removed';
export type FileStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * What the pane's per-file caches (rows, colours) are keyed by. `version` is
 * algorithm-free by design, so the algorithm joins it.
 */
export const snapshotKey = (snapshot: ScmFileSnapshot): string =>
  `${snapshot.version}|${snapshot.algorithm}`;

export interface FileQueueOptions {
  fetch: FetchSnapshot;
  algorithm: ScmAlgorithm;
  /**
   * A snapshot landed. `changed` is false when it carries the same `snapshotKey`
   * as the one held: the rows and colours built from that stay valid, and only the
   * snapshot itself (its staging token) was renewed.
   */
  onLoad: (path: string, snapshot: ScmFileSnapshot, changed: boolean) => void;
  /** A loaded file was dropped; the pane puts a placeholder of its measured height back. */
  onEvict: (path: string, reason: EvictReason) => void;
  onError?: (path: string, error: unknown) => void;
  concurrency?: number;
  window?: number;
  maxFiles?: number;
  maxBytes?: number;
}

interface Loaded {
  snapshot: ScmFileSnapshot;
  key: string;
  bytes: number;
  /** What the request that produced it asked for; any difference from now makes it stale. */
  fp: string;
  epoch: string;
  algorithm: ScmAlgorithm;
}

interface Slot {
  entry: QueueEntry;
  index: number;
  generation: number;
  request: { generation: number; controller: AbortController } | undefined;
  loaded: Loaded | undefined;
  failed: { error: unknown } | undefined;
}

export class FileQueue {
  private readonly options: FileQueueOptions;
  private readonly concurrency: number;
  private readonly window: number;
  private readonly maxFiles: number;
  private readonly maxBytes: number;

  private slots = new Map<string, Slot>();
  private algorithm: ScmAlgorithm;
  private epoch: string | undefined;
  private range: { first: number; last: number } | undefined;
  private enabled = true;
  private disposed = false;
  /** Requests started and not yet settled, superseded ones included. */
  private active = 0;
  private bytes = 0;
  /** Loaded paths, least recently used first. */
  private readonly lru = new Set<string>();

  constructor(options: FileQueueOptions) {
    this.options = options;
    this.algorithm = options.algorithm;
    this.concurrency = options.concurrency ?? FETCH_CONCURRENCY;
    this.window = options.window ?? FETCH_WINDOW;
    this.maxFiles = options.maxFiles ?? MAX_LOADED_FILES;
    this.maxBytes = options.maxBytes ?? MAX_LOADED_BYTES;
  }

  /** The group's files in list order, with the attribute epoch of the status they came from. */
  setFiles(entries: readonly QueueEntry[], attrEpoch: string): void {
    if (this.disposed) return;
    const epochChanged = this.epoch !== undefined && this.epoch !== attrEpoch;
    this.epoch = attrEpoch;

    const next = new Map<string, Slot>();
    entries.forEach((entry, index) => {
      const slot = this.slots.get(entry.path);
      if (slot) {
        if (slot.entry.fp !== entry.fp || slot.entry.oldPath !== entry.oldPath) {
          this.supersede(slot);
        }
        slot.entry = entry;
        slot.index = index;
        next.set(entry.path, slot);
      } else {
        next.set(entry.path, {
          entry,
          index,
          generation: 0,
          request: undefined,
          loaded: undefined,
          failed: undefined,
        });
      }
    });
    for (const [path, slot] of this.slots) {
      if (!next.has(path)) this.remove(path, slot);
    }
    this.slots = next;
    if (epochChanged) {
      for (const slot of this.slots.values()) this.supersede(slot);
    }
    this.pump();
  }

  /** The first and last file index on screen. */
  setVisible(first: number, last: number): void {
    if (this.range?.first === first && this.range.last === last) return;
    this.range = { first, last };
    for (const slot of this.slots.values()) {
      if (this.distance(slot) <= this.window) {
        if (slot.loaded) this.touch(slot.entry.path);
      } else {
        // Scrolling back to a file that failed is the retry.
        slot.failed = undefined;
      }
    }
    this.pump();
  }

  setAlgorithm(algorithm: ScmAlgorithm): void {
    if (algorithm === this.algorithm) return;
    this.algorithm = algorithm;
    for (const slot of this.slots.values()) this.supersede(slot);
    this.pump();
  }

  /** A hidden review, or one of a paused project, starts nothing; answers in flight still land. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.pump();
  }

  retry(path: string): void {
    const slot = this.slots.get(path);
    if (!slot) return;
    slot.failed = undefined;
    this.pump();
  }

  /**
   * The file's snapshot, fetched now if it is not held or is stale, whatever the
   * visible range and whether the queue is enabled: a person asked for this one
   * (the next change is in a file that is not loaded yet). Null when it cannot be
   * read, or was superseded before it landed.
   */
  load(path: string): Promise<ScmFileSnapshot | null> {
    return this.fetchNow(path, false);
  }

  /**
   * Fetch the file again whatever it holds, and land the answer like any other (a
   * renewed staging token replaces the held one; a different version replaces the
   * snapshot). Null as for `load`.
   */
  reload(path: string): Promise<ScmFileSnapshot | null> {
    return this.fetchNow(path, true);
  }

  private async fetchNow(path: string, force: boolean): Promise<ScmFileSnapshot | null> {
    const slot = this.slots.get(path);
    if (!slot || this.disposed) return null;
    if (!force && slot.loaded && !this.isStale(slot, slot.loaded)) return slot.loaded.snapshot;
    // A request in flight is replaced, not joined: the answer a person waits for must
    // be one that started after they asked.
    slot.failed = undefined;
    this.supersede(slot);
    await this.launch(slot);
    return slot.loaded?.snapshot ?? null;
  }

  get(path: string): ScmFileSnapshot | undefined {
    return this.slots.get(path)?.loaded?.snapshot;
  }

  status(path: string): FileStatus {
    const slot = this.slots.get(path);
    if (!slot) return 'idle';
    if (slot.loaded) return 'ready';
    if (slot.request) return 'loading';
    return slot.failed ? 'error' : 'idle';
  }

  errorOf(path: string): unknown {
    return this.slots.get(path)?.failed?.error;
  }

  stats(): { files: number; bytes: number; active: number } {
    return { files: this.lru.size, bytes: this.bytes, active: this.active };
  }

  /** Aborts everything and stops reporting. No eviction callbacks: the pane is going away. */
  dispose(): void {
    this.disposed = true;
    for (const slot of this.slots.values()) slot.request?.controller.abort();
    this.slots.clear();
    this.lru.clear();
    this.bytes = 0;
  }

  /** Files between the range and the slot: 0 inside the range, Infinity before any range. */
  private distance(slot: Slot): number {
    if (!this.range) return Number.POSITIVE_INFINITY;
    if (slot.index < this.range.first) return this.range.first - slot.index;
    if (slot.index > this.range.last) return slot.index - this.range.last;
    return 0;
  }

  private isStale(slot: Slot, loaded: Loaded): boolean {
    return (
      loaded.fp !== slot.entry.fp ||
      loaded.epoch !== this.epoch ||
      loaded.algorithm !== this.algorithm
    );
  }

  private needsFetch(slot: Slot): boolean {
    // A conflicted file has no stage-0 blob to ask for.
    if (slot.request || slot.failed || slot.entry.kind === 'unmerged') return false;
    if (slot.loaded) return this.isStale(slot, slot.loaded);
    return this.distance(slot) <= this.window;
  }

  private pump(): void {
    if (!this.enabled || this.disposed) return;
    const wanted: Slot[] = [];
    for (const slot of this.slots.values()) {
      if (this.needsFetch(slot)) wanted.push(slot);
    }
    wanted.sort((a, b) => this.distance(a) - this.distance(b) || a.index - b.index);
    for (const slot of wanted) {
      if (this.active >= this.concurrency) break;
      void this.launch(slot);
    }
  }

  private async launch(slot: Slot): Promise<void> {
    const controller = new AbortController();
    const generation = slot.generation;
    const want = { fp: slot.entry.fp, epoch: this.epoch ?? '', algorithm: this.algorithm };
    slot.request = { generation, controller };
    this.active++;

    const request: SnapshotRequest = { path: slot.entry.path, algorithm: want.algorithm };
    if (slot.entry.oldPath !== undefined) request.oldPath = slot.entry.oldPath;

    let outcome: { snapshot: ScmFileSnapshot } | { error: unknown };
    try {
      outcome = { snapshot: await this.options.fetch(request, controller.signal) };
    } catch (error) {
      outcome = { error };
    }
    this.active--;

    try {
      if (this.isCurrent(slot, generation)) {
        slot.request = undefined;
        if ('snapshot' in outcome) this.land(slot, want, outcome.snapshot);
        else this.fail(slot, outcome.error);
      }
    } finally {
      this.pump();
    }
  }

  private isCurrent(slot: Slot, generation: number): boolean {
    return (
      !this.disposed &&
      this.slots.get(slot.entry.path) === slot &&
      slot.generation === generation &&
      slot.request?.generation === generation
    );
  }

  private land(
    slot: Slot,
    want: { fp: string; epoch: string; algorithm: ScmAlgorithm },
    snapshot: ScmFileSnapshot,
  ): void {
    const path = slot.entry.path;
    const previous = slot.loaded;
    const key = snapshotKey(snapshot);
    const bytes = snapshot.old.text.length + snapshot.new.text.length;
    slot.loaded = { snapshot, key, bytes, ...want };
    slot.failed = undefined;
    this.bytes += bytes - (previous?.bytes ?? 0);
    // A refresh keeps its place in the order; only a newcomer counts as just used.
    if (!previous) this.lru.add(path);
    this.options.onLoad(path, snapshot, previous?.key !== key);
    this.enforceLimits(path);
  }

  private fail(slot: Slot, error: unknown): void {
    slot.failed = { error };
    this.options.onError?.(slot.entry.path, error);
  }

  /** Starts a new generation: the request in flight is aborted and its answer will be dropped. */
  private supersede(slot: Slot): void {
    slot.generation++;
    slot.request?.controller.abort();
    slot.request = undefined;
    slot.failed = undefined;
  }

  private touch(path: string): void {
    this.lru.delete(path);
    this.lru.add(path);
  }

  private enforceLimits(keep: string): void {
    while (this.lru.size > this.maxFiles || this.bytes > this.maxBytes) {
      let victim: string | undefined;
      for (const path of this.lru) {
        if (path !== keep) {
          victim = path;
          break;
        }
      }
      if (victim === undefined) return;
      this.evict(victim, this.lru.size > this.maxFiles ? 'count' : 'bytes');
    }
  }

  private evict(path: string, reason: EvictReason): void {
    const slot = this.slots.get(path);
    if (slot?.loaded) {
      this.bytes -= slot.loaded.bytes;
      slot.loaded = undefined;
      // A refresh of a file nobody is looking at would only bring it straight back.
      this.supersede(slot);
    }
    this.lru.delete(path);
    this.options.onEvict(path, reason);
  }

  private remove(path: string, slot: Slot): void {
    slot.generation++;
    slot.request?.controller.abort();
    slot.request = undefined;
    if (slot.loaded) {
      this.bytes -= slot.loaded.bytes;
      slot.loaded = undefined;
      this.lru.delete(path);
      this.options.onEvict(path, 'removed');
    }
  }
}
