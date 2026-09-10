import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LatencyOverlay } from './LatencyOverlay';
import { createLatencyRecorder } from './latency';
import type { LatencyRecorder, LatencyStats } from './latency';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('LatencyOverlay', () => {
  it('renders zeros before any samples', () => {
    const recorder = createLatencyRecorder();
    render(<LatencyOverlay recorder={recorder} />);
    expect(screen.getByTestId('latency-overlay')).toBeTruthy();
    expect(screen.getByTestId('latency-p50').textContent).toBe('p50 0.0ms');
    expect(screen.getByTestId('latency-p95').textContent).toBe('p95 0.0ms');
  });

  it('reflects the recorder stats after the refresh interval elapses', () => {
    const recorder = createLatencyRecorder();
    recorder.markInput(0);
    recorder.markPaint(10);
    recorder.markInput(100);
    recorder.markPaint(120);
    render(<LatencyOverlay recorder={recorder} />);

    act(() => {
      vi.advanceTimersByTime(500);
    });

    const expected = recorder.stats();
    expect(screen.getByTestId('latency-p50').textContent).toBe(`p50 ${expected.p50.toFixed(1)}ms`);
    expect(screen.getByTestId('latency-p95').textContent).toBe(`p95 ${expected.p95.toFixed(1)}ms`);
  });

  it('clears the poll interval on unmount', () => {
    let callCount = 0;
    const stats: LatencyStats = { count: 0, p50: 0, p95: 0, last: 0 };
    const recorder: LatencyRecorder = {
      markInput: vi.fn(),
      markPaint: vi.fn(),
      reset: vi.fn(),
      stats: vi.fn(() => {
        callCount += 1;
        return stats;
      }),
    };

    const { unmount } = render(<LatencyOverlay recorder={recorder} />);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    const countAfterMount = callCount;
    expect(countAfterMount).toBeGreaterThan(0);

    unmount();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(callCount).toBe(countAfterMount);
  });
});
