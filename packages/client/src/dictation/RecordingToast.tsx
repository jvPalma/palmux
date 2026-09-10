// ── Recording toast ───────────────────────────────────────────────────────────
//
// The "I am listening" surface. It exists because dictation can be started
// without opening any panel (a keybinding, the drawer's mic cell), so something
// has to say the mic is hot, offer a way to stop, and cover as little of the
// terminal as possible.
//
// Bottom-centre, the SAME anchor on every viewport: on a phone it COMPACTS in
// place rather than moving to a corner, because a control that relocates by
// width is a control the thumb has to hunt for. The cost, stated plainly, is
// that it covers one line of the terminal exactly where the prompt usually sits
// — which is the trade the owner picked, on the grounds that a recording
// indicator you can miss is not an indicator.
//
// COMPACTION IS ON A TIMER, NOT ON THE VIEWPORT. `narrow` says this screen will
// eventually need the room back; the toast still opens at full size so the
// waveform is seen, and shrinks after COMPACT_AFTER_MS. Keying it straight off
// the viewport meant a phone NEVER saw the meter — the one element that proves
// the microphone is live — and the spec asks for a level indicator in the
// compact form too, so compact narrows the meter to three bars instead of
// dropping it.
//
// STOPPING IS A STATE, NOT A DISAPPEARANCE. Transcription is a paid network
// round-trip that can take seconds and can fail; unmounting on Stop left no way
// to tell "still working" from "failed silently". The toast therefore stays up
// as `transcribing` — no Stop, no meter, the final duration kept — until the
// text lands or the host raises the failure toast.
//
// NON-MODAL is structural, not a nicety: the positioning wrapper is
// `pointer-events: none` so every click outside the toast still reaches the
// terminal, and the Stop button suppresses the focus grab on pointer-down so
// the hidden mobile keyboard textarea keeps focus. Dictation is something you do
// WHILE working; taking focus would stop the work.
//
// THE WAVEFORM IS MEASURED, NEVER ANIMATED. The bars are driven from the
// AnalyserNode in a rAF loop and a silent input renders FLAT. A CSS keyframe
// loop was the obvious cheap version and it is the wrong one: bars bouncing on
// their own assert that the microphone is working, so a muted/denied/dead mic
// would look identical to a live one and the user would find out only when the
// transcript came back empty. No analyser at all is the same case — flat.

import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui';
import './dictation-view.css';

/** Bars in the meter. */
const BAR_COUNT = 8;
/** Compact keeps a level indicator, just a narrower one (spec: not a static dot). */
const COMPACT_BAR_COUNT = 3;
/** Long enough to watch the meter prove the mic is live, short enough to give
 *  the prompt line back during a real dictation. */
export const COMPACT_AFTER_MS = 4000;

/** What the toast is currently reporting. */
export type RecordingPhase = 'recording' | 'transcribing';

export interface RecordingToastProps {
  /** Live analyser over the recording stream. Absent ⇒ the meter reads flat. */
  analyser?: AnalyserNode | undefined;
  /** Time since the recording started, in ms. The host owns the ticker. */
  elapsedMs: number;
  /** This viewport will want its room back: compact after the delay. */
  narrow: boolean;
  /** Recording, or handed off to the transcriber. */
  phase: RecordingPhase;
  onStop: () => void;
}

/** ms → "m:ss", floored (elapsed, not remaining) and never negative. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Byte spectrum → one 0..1 level per bar.
 *
 * Only the LOWER HALF of the spectrum is spread across the bars: speech lives
 * there, and mapping the full range leaves the right-hand bars permanently dead,
 * which reads as a broken meter rather than as an honest silent band.
 */
export function barLevels(bins: Uint8Array, count: number = BAR_COUNT): number[] {
  const usable = Math.max(count, Math.floor(bins.length / 2));
  const levels: number[] = [];
  for (let bar = 0; bar < count; bar += 1) {
    const from = Math.floor((bar * usable) / count);
    const to = Math.max(from + 1, Math.floor(((bar + 1) * usable) / count));
    let sum = 0;
    for (let bin = from; bin < to; bin += 1) sum += bins[bin] ?? 0;
    levels.push(sum / (to - from) / 255);
  }
  return levels;
}

export function RecordingToast({
  analyser,
  elapsedMs,
  narrow,
  phase,
  onStop,
}: RecordingToastProps) {
  const bars = useRef<(HTMLElement | null)[]>([]);
  const [shrunk, setShrunk] = useState(false);
  const transcribing = phase === 'transcribing';
  const compact = narrow && shrunk;
  const barCount = compact ? COMPACT_BAR_COUNT : BAR_COUNT;

  // Open full, then yield the prompt line back. Only on a narrow viewport, and
  // only once — a toast that re-expanded would move the Stop button under the
  // thumb that was reaching for it.
  useEffect(() => {
    if (!narrow || shrunk) return;
    const id = window.setTimeout(() => setShrunk(true), COMPACT_AFTER_MS);
    return () => window.clearTimeout(id);
  }, [narrow, shrunk]);

  // The level is written straight to the DOM as a custom property, never to
  // React state: a 60fps setState would re-render this subtree on every frame
  // and, in the dock's case, fight the terminal for the same main thread.
  useEffect(() => {
    if (transcribing) return; // the mic is closed; there is nothing to measure
    const write = (levels: number[]) => {
      bars.current.forEach((bar, i) =>
        bar?.style.setProperty('--rec-level', String(levels[i] ?? 0)),
      );
    };
    if (!analyser) {
      write(Array.from({ length: barCount }, () => 0));
      return;
    }
    const bins = new Uint8Array(analyser.frequencyBinCount);
    let frame = 0;
    const tick = () => {
      analyser.getByteFrequencyData(bins);
      write(barLevels(bins, barCount));
      frame = requestAnimationFrame(tick);
    };
    tick(); // paint the first measurement now, not one frame late
    return () => cancelAnimationFrame(frame);
  }, [analyser, barCount, transcribing]);

  return (
    <div className="rec-toast-anchor" data-testid="recording-toast-anchor">
      <div
        className={compact ? 'rec-toast rec-toast-compact' : 'rec-toast'}
        // Announces once on mount. The elapsed time is aria-hidden on purpose:
        // inside a live region it would re-announce every single second.
        role="status"
        data-state="open"
        data-testid="recording-toast"
      >
        <span className="rec-toast-sr">{transcribing ? 'Transcribing' : 'Recording'}</span>
        <span className="rec-toast-dot" data-phase={phase} aria-hidden="true" />

        {transcribing ? (
          // No meter and no Stop: the microphone is already closed and the
          // request is in flight, so there is nothing left to measure or cancel.
          // What the user needs to know is that it did not silently vanish.
          <span className="rec-toast-label" data-testid="recording-toast-label">
            Transcribing…
          </span>
        ) : (
          // Keyed on the count so the refs array is rebuilt when the meter
          // narrows, rather than leaving three live bars among eight stale ones.
          <div
            key={barCount}
            className="rec-toast-wave"
            aria-hidden="true"
            data-testid="recording-toast-wave"
          >
            {Array.from({ length: barCount }, (_unused, i) => (
              <i
                key={i}
                className="rec-toast-bar"
                data-testid={`recording-toast-bar-${i}`}
                ref={(el) => {
                  bars.current[i] = el;
                }}
              />
            ))}
          </div>
        )}

        <span className="rec-toast-time" aria-hidden="true" data-testid="recording-toast-time">
          {formatClock(elapsedMs)}
        </span>

        {!transcribing && (
          <Button
            variant="danger"
            size="sm"
            className="rec-toast-stop"
            data-testid="recording-toast-stop"
            // Suppressing the default on pointer-down is what keeps the caret
            // where it was: the button would otherwise take focus off the hidden
            // mobile keyboard textarea, and the next keystroke would go nowhere.
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onStop}
          >
            Stop
          </Button>
        )}
      </div>
    </div>
  );
}
