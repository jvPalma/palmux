// ── Dictation status notification ─────────────────────────────────────────────
//
// The recording indicator, the stop button (on a phone there is no Ctrl+Alt+D,
// and this is always on screen), AND the visible time budget: recording is
// auto-cut at MAX_RECORDING_MS, and a limit the user can't see reads as data
// loss when it fires mid-sentence — so the countdown is on the notification.
//
// Anchored to the FOCUSED terminal pane, not the browser window: in split mode
// the dictated text lands in the focused pane, so the notification must sit on
// that pane's top-right corner to identify the target. The anchor is re-read on
// every tick — focus can move mid-recording and the notification follows.
//
// Its own component on purpose: the countdown re-renders 4×/s, and that tick
// must stay in this leaf — never in App.

import { useEffect, useState, type CSSProperties } from 'react';
import type { DictationState } from './useDictation';

/** ms → "m:ss", floored at 0:00. */
export function formatCountdown(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Under this the countdown turns urgent (class swap; styling in index.css).
const ENDING_MS = 30_000;
// Gap between the anchor's top-right corner and the notification.
const TOP_GAP = 28;
const RIGHT_GAP = 16;

export interface DictationPillProps {
  state: DictationState;
  /** Epoch ms of the auto-stop, while recording. */
  deadline: number | null;
  onStop: () => void;
  /** The focused pane's rect, read at call time; null → anchor to the window. */
  anchorRect?: () => DOMRect | null;
}

export const DictationPill = ({ state, deadline, onStop, anchorRect }: DictationPillProps) => {
  const [now, setNow] = useState(() => Date.now());
  const visible = state !== 'idle';
  // One ticker drives both the countdown and the anchor-follow.
  useEffect(() => {
    if (!visible) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [visible]);

  if (!visible) return null;
  const ticking = state === 'recording' && deadline !== null;
  const msLeft = ticking ? deadline - now : 0;

  const rect = anchorRect?.() ?? null;
  const style: CSSProperties = rect
    ? { top: rect.top + TOP_GAP, right: window.innerWidth - rect.right + RIGHT_GAP }
    : { top: TOP_GAP, right: RIGHT_GAP };

  return (
    <button
      type="button"
      className={`dictation-pill${state === 'recording' ? ' recording' : ''}${
        ticking && msLeft <= ENDING_MS ? ' ending' : ''
      }`}
      style={style}
      data-testid="dictation-pill"
      onPointerDown={(e) => {
        e.preventDefault(); // keep the hidden mobile keyboard focused
        if (state === 'recording') onStop();
      }}
    >
      {state === 'recording' ? (
        <>
          <span className="dictation-title">🔴 Recording</span>
          <span className="dictation-sub">{formatCountdown(msLeft)} left — tap to stop</span>
        </>
      ) : (
        <>
          <span className="dictation-title">⏳ Transcribing…</span>
          <span className="dictation-sub">inserts at the cursor when done</span>
        </>
      )}
    </button>
  );
};
