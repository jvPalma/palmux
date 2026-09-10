import { describe, expect, it } from 'vitest';
import { createLatencyRecorder, percentile } from './latency';

describe('percentile', () => {
  it('computes nearest-rank on a known array', () => {
    const arr = [10, 20, 30, 40, 50];
    expect(percentile(arr, 0.5)).toBe(30);
    expect(percentile(arr, 0.95)).toBe(50);
  });

  it('handles a single-element array', () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 1)).toBe(42);
  });

  it('handles exact rank boundaries', () => {
    const arr = [1, 2, 3, 4];
    expect(percentile(arr, 0.25)).toBe(1);
    expect(percentile(arr, 0.5)).toBe(2);
    expect(percentile(arr, 0.75)).toBe(3);
    expect(percentile(arr, 1)).toBe(4);
  });

  it('returns 0 for p=0 and p=1 on an empty array', () => {
    expect(percentile([], 0)).toBe(0);
    expect(percentile([], 1)).toBe(0);
  });
});

describe('createLatencyRecorder', () => {
  it('reports zeroed stats when empty', () => {
    const rec = createLatencyRecorder();
    expect(rec.stats()).toEqual({ count: 0, p50: 0, p95: 0, last: 0 });
  });

  it('pairs FIFO across interleaved marks', () => {
    const rec = createLatencyRecorder();
    rec.markInput(0);
    rec.markInput(10);
    rec.markPaint(5); // pairs with input@0 -> 5
    rec.markPaint(15); // pairs with input@10 -> 5
    const stats = rec.stats();
    expect(stats.count).toBe(2);
    expect(stats.last).toBe(5);
    expect(stats.p50).toBe(5);
  });

  it('ignores a paint with no pending input', () => {
    const rec = createLatencyRecorder();
    rec.markPaint(100);
    expect(rec.stats()).toEqual({ count: 0, p50: 0, p95: 0, last: 0 });
  });

  it('drops stale pending inputs so the next paint pairs with the newer input', () => {
    const rec = createLatencyRecorder({ staleMs: 100 });
    rec.markInput(0);
    rec.markInput(200);
    rec.markPaint(250); // threshold 150: input@0 is stale and dropped, pairs with input@200
    const stats = rec.stats();
    expect(stats.count).toBe(1);
    expect(stats.last).toBe(50);
  });

  it('clamps a negative delta to 0', () => {
    const rec = createLatencyRecorder();
    rec.markInput(100);
    rec.markPaint(50); // clock skew: paint "before" input
    expect(rec.stats().last).toBe(0);
  });

  it('evicts the oldest sample once the ring exceeds capacity', () => {
    const rec = createLatencyRecorder({ capacity: 3, staleMs: 100_000 });
    for (let i = 0; i < 5; i++) {
      rec.markInput(i * 1000);
      rec.markPaint(i * 1000 + (i + 1)); // deltas: 1,2,3,4,5
    }
    const stats = rec.stats();
    expect(stats.count).toBe(3); // only newest 3 samples (3,4,5) retained
    expect(stats.last).toBe(5);
    expect(stats.p50).toBe(4);
    expect(stats.p95).toBe(5);
  });

  it('bounds the pending input queue, dropping the oldest', () => {
    const rec = createLatencyRecorder({ capacity: 3, staleMs: 100_000 });
    for (let i = 0; i < 5; i++) rec.markInput(i); // inputs 0,1,2,3,4 -> only 2,3,4 retained
    rec.markPaint(12); // pairs with oldest surviving input (2) -> delta 10
    expect(rec.stats().last).toBe(10);
  });

  it('reset clears samples and pending inputs', () => {
    const rec = createLatencyRecorder();
    rec.markInput(0);
    rec.markPaint(5);
    rec.markInput(100);
    rec.reset();
    expect(rec.stats()).toEqual({ count: 0, p50: 0, p95: 0, last: 0 });
    rec.markPaint(200); // pending was cleared too, so this is unmatched
    expect(rec.stats()).toEqual({ count: 0, p50: 0, p95: 0, last: 0 });
  });
});
