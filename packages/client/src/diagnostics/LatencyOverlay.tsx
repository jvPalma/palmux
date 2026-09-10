// ── Keydown→paint latency debug view ──────────────────────────────────────────
//
// Off by default (the `latencyOverlay` setting). Polls rather than re-rendering
// per sample: the whole point is to measure input latency, so the instrument
// must not add render pressure to the thing it measures.

import { useEffect, useState } from 'react';
import type { LatencyRecorder, LatencyStats } from './latency';

const EMPTY: LatencyStats = { count: 0, p50: 0, p95: 0, last: 0 };
const REFRESH_MS = 500;

export interface LatencyOverlayProps {
  recorder: LatencyRecorder;
}

export const LatencyOverlay = ({ recorder }: LatencyOverlayProps) => {
  const [stats, setStats] = useState<LatencyStats>(EMPTY);

  useEffect(() => {
    const id = setInterval(() => setStats(recorder.stats()), REFRESH_MS);
    return () => clearInterval(id);
  }, [recorder]);

  const ms = (n: number) => `${n.toFixed(1)}ms`;

  return (
    <div className="latency-overlay" data-testid="latency-overlay">
      <span className="latency-label">input→paint</span>
      <span data-testid="latency-p50">p50 {ms(stats.p50)}</span>
      <span data-testid="latency-p95">p95 {ms(stats.p95)}</span>
      <span className="latency-count">n={stats.count}</span>
    </div>
  );
};
