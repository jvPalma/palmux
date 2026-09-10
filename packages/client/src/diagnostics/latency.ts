// ── Keydown-to-paint latency instrumentation ──────────────────────────────────
//
// Pure recorder: FIFO-pairs `markInput`/`markPaint` timestamps into a bounded
// ring of samples and exposes rolling p50/p95. No wiring to the terminal or a
// debug overlay lives here (that's someone else's job) — this module only
// measures. Off by default: nothing calls markInput/markPaint until wired.

export interface LatencyStats {
  count: number;
  p50: number;
  p95: number;
  last: number;
}

/**
 * Percentile over an ASCENDING-sorted array; p in 0..1. Returns 0 for an
 * empty array. Uses nearest-rank (rank = ceil(p * n), 1-indexed) rather than
 * interpolation — simpler, and adequate for a rough latency readout.
 */
export function percentile(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const rank = Math.ceil(p * n);
  const index = Math.min(Math.max(rank - 1, 0), n - 1);
  return sortedAsc[index]!;
}

export interface LatencyRecorder {
  /** A keystroke left the client at `at` (performance.now()-style ms). */
  markInput(at: number): void;
  /** A paint completed at `at`; pairs with the OLDEST unpaired input. */
  markPaint(at: number): void;
  stats(): LatencyStats;
  reset(): void;
}

export function createLatencyRecorder(opts?: {
  capacity?: number;
  staleMs?: number;
}): LatencyRecorder {
  const capacity = opts?.capacity ?? 200;
  const staleMs = opts?.staleMs ?? 2000;
  const pending: number[] = [];
  const samples: number[] = [];
  let last = 0;

  const markInput = (at: number): void => {
    pending.push(at);
    if (pending.length > capacity) pending.shift();
  };

  const markPaint = (at: number): void => {
    // Stale pending inputs never got a paint — drop them so they don't poison
    // a later pairing.
    while (pending.length > 0 && pending[0]! < at - staleMs) pending.shift();
    if (pending.length === 0) return;
    const inputAt = pending.shift()!;
    const delta = Math.max(0, at - inputAt);
    samples.push(delta);
    if (samples.length > capacity) samples.shift();
    last = delta;
  };

  const stats = (): LatencyStats => {
    if (samples.length === 0) return { count: 0, p50: 0, p95: 0, last: 0 };
    const sorted = [...samples].sort((a, b) => a - b);
    return {
      count: samples.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      last,
    };
  };

  const reset = (): void => {
    pending.length = 0;
    samples.length = 0;
    last = 0;
  };

  return { markInput, markPaint, stats, reset };
}
