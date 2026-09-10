// Two claims carry this component, and both are about lying.
//
// 1. The toast must not take focus. Dictation is started mid-work, often with
//    the hidden mobile keyboard textarea focused; a toast that grabbed the caret
//    would silently swallow the next keystroke.
// 2. The waveform must be MEASURED. A CSS keyframe loop looks identical to a
//    live meter and asserts the microphone is working, so a muted or dead mic
//    would be indistinguishable from a hot one. Silence in ⇒ flat out.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPACT_AFTER_MS, formatClock, RecordingToast } from './RecordingToast';

// happy-dom applies no stylesheet, so anything that lives purely in CSS —
// pointer-events, the motion tier — has to be asserted against the source.
// Same trick as session/tab-strip-css.test.ts, and the same reason.
const css = readFileSync(join(__dirname, 'dictation-view.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const rule = (selector: string): string =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, sel, body]) => ({ sel: (sel ?? '').replace(/\s+/g, ' ').trim(), body: body ?? '' }))
    .find((block) => block.sel === selector)?.body ?? '';

/** Frequency-domain silence: the real analyser writes zeros for a quiet input. */
const analyserOf = (fill: (bins: Uint8Array) => void, bins = 64): AnalyserNode =>
  ({
    frequencyBinCount: bins,
    getByteFrequencyData: (array: Uint8Array) => fill(array),
  }) as unknown as AnalyserNode;

const SILENT = analyserOf((bins) => bins.fill(0));
const LOUD = analyserOf((bins) => bins.forEach((_v, i) => (bins[i] = i * 4)));

const levels = (): string[] =>
  Array.from(screen.getByTestId('recording-toast-wave').children).map((bar) =>
    (bar as HTMLElement).style.getPropertyValue('--rec-level'),
  );

/** rAF as a manual queue, so "a frame" is something the test can step. */
const manualFrames = () => {
  let queue: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => queue.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {
    queue = [];
  });
  return () => {
    const pending = queue;
    queue = [];
    for (const cb of pending) cb(0);
  };
};

afterEach(() => vi.unstubAllGlobals());

describe('RecordingToast', () => {
  it('does not take focus when it appears, and Stop leaves the caret where it was', async () => {
    manualFrames();
    const user = userEvent.setup();
    const typing = document.createElement('input');
    document.body.appendChild(typing);
    typing.focus();
    const onStop = vi.fn();

    render(
      <RecordingToast
        analyser={SILENT}
        elapsedMs={0}
        narrow={false}
        phase="recording"
        onStop={onStop}
      />,
    );

    // Appearing must not move the caret.
    expect(document.activeElement).toBe(typing);

    await user.click(screen.getByTestId('recording-toast-stop'));

    expect(onStop).toHaveBeenCalledTimes(1);
    // ...and neither must pressing its only button.
    expect(document.activeElement).toBe(typing);
    typing.remove();
  });

  it('lets a click through to whatever is underneath it', () => {
    // The positioning wrapper spans the viewport width; if it took pointer
    // events it would eat clicks on the terminal it floats over. Only the toast
    // itself takes them back.
    expect(rule('.rec-toast-anchor')).toMatch(/pointer-events:\s*none/);
    expect(rule('.rec-toast')).toMatch(/pointer-events:\s*auto/);
  });

  it('enters on the surface tier and leaves faster than it entered', () => {
    expect(rule('.rec-toast')).toMatch(/animation:\s*rec-toast-in var\(--mo-surface\)/);
    expect(rule(".rec-toast[data-state='closed']")).toMatch(
      /animation:\s*rec-toast-out var\(--mo-micro\)/,
    );
  });

  it('gives the meter no animation of its own — its height IS the measurement', () => {
    expect(rule('.rec-toast-bar')).not.toMatch(/animation/);
    expect(rule('.rec-toast-bar')).toMatch(/var\(--rec-level, 0\)/);
  });

  it('renders a flat waveform when the analyser hears silence', () => {
    manualFrames();
    render(
      <RecordingToast
        analyser={SILENT}
        elapsedMs={7000}
        narrow={false}
        phase="recording"
        onStop={vi.fn()}
      />,
    );

    const flat = levels();
    expect(flat).toHaveLength(8);
    expect(flat.every((level) => Number(level) === 0)).toBe(true);
  });

  it('renders flat when there is no analyser at all', () => {
    manualFrames();
    render(<RecordingToast elapsedMs={0} narrow={false} phase="recording" onStop={vi.fn()} />);

    expect(levels().every((level) => Number(level) === 0)).toBe(true);
  });

  it('is not flat for a live signal — otherwise "flat" would prove nothing', () => {
    manualFrames();
    render(
      <RecordingToast
        analyser={LOUD}
        elapsedMs={0}
        narrow={false}
        phase="recording"
        onStop={vi.fn()}
      />,
    );

    const live = levels().map(Number);
    expect(live.some((level) => level > 0)).toBe(true);
    // Rising spectrum in, rising bars out: the bars track the input, they are
    // not one shared value painted eight times.
    expect(new Set(live).size).toBeGreaterThan(1);
  });

  it('re-reads the analyser on every frame', () => {
    const step = manualFrames();
    let loud = false;
    const swinging = analyserOf((bins) => bins.fill(loud ? 255 : 0));
    render(
      <RecordingToast
        analyser={swinging}
        elapsedMs={0}
        narrow={false}
        phase="recording"
        onStop={vi.fn()}
      />,
    );

    expect(levels().every((level) => Number(level) === 0)).toBe(true);
    loud = true;
    step();
    expect(levels().every((level) => Number(level) === 1)).toBe(true);
  });

  // Compaction is on a TIMER, not on the viewport. Keying it off the breakpoint
  // meant a phone never saw the meter at all — the one element that proves the
  // microphone is live — which is what the owner reported seeing.
  it('opens at full size on a narrow viewport and shrinks only after the delay', () => {
    manualFrames();
    vi.useFakeTimers();
    try {
      render(
        <RecordingToast
          analyser={LOUD}
          elapsedMs={67_000}
          narrow
          phase="recording"
          onStop={vi.fn()}
        />,
      );

      // Full meter first — this is the whole point.
      expect(screen.getAllByTestId(/^recording-toast-bar-/)).toHaveLength(8);
      expect(screen.getByTestId('recording-toast')).not.toHaveClass('rec-toast-compact');

      act(() => {
        vi.advanceTimersByTime(COMPACT_AFTER_MS);
      });

      // Compact KEEPS a level indicator (spec), it does not drop to a static dot.
      expect(screen.getByTestId('recording-toast')).toHaveClass('rec-toast-compact');
      expect(screen.getAllByTestId(/^recording-toast-bar-/)).toHaveLength(3);
      expect(screen.getByTestId('recording-toast-anchor')).toBeTruthy();
      expect(screen.getByTestId('recording-toast-stop')).toBeTruthy();
      expect(screen.getByTestId('recording-toast-time').textContent).toBe('1:07');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a wide viewport never compacts', () => {
    manualFrames();
    vi.useFakeTimers();
    try {
      render(
        <RecordingToast
          analyser={LOUD}
          elapsedMs={0}
          narrow={false}
          phase="recording"
          onStop={vi.fn()}
        />,
      );
      act(() => {
        vi.advanceTimersByTime(COMPACT_AFTER_MS * 3);
      });
      expect(screen.getByTestId('recording-toast')).not.toHaveClass('rec-toast-compact');
      expect(screen.getAllByTestId(/^recording-toast-bar-/)).toHaveLength(8);
    } finally {
      vi.useRealTimers();
    }
  });

  // The reported bug: Stop made the toast vanish, so "still working" and
  // "failed silently" looked identical.
  it('transcribing keeps the toast up, drops Stop and the meter, holds the clock', () => {
    manualFrames();
    render(
      <RecordingToast elapsedMs={67_000} narrow={false} phase="transcribing" onStop={vi.fn()} />,
    );

    expect(screen.getByTestId('recording-toast-label').textContent).toBe('Transcribing…');
    expect(screen.queryByTestId('recording-toast-wave')).toBeNull();
    expect(screen.queryByTestId('recording-toast-stop')).toBeNull(); // nothing left to cancel
    expect(screen.getByTestId('recording-toast-time').textContent).toBe('1:07');
    expect(screen.getByTestId('recording-toast-anchor')).toBeTruthy(); // same anchor
  });

  it('formats elapsed time as m:ss, floored and never negative', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(999)).toBe('0:00');
    expect(formatClock(7_400)).toBe('0:07');
    expect(formatClock(605_000)).toBe('10:05');
    expect(formatClock(-1)).toBe('0:00');
  });
});
