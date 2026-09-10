// The SGR mouse gate: motion frames are dropped while unfocused and throttled
// (latest wins) while focused; clicks/wheel always pass through with pending
// motion flushed first; frames are only ever forwarded whole.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMouseGate, isMotionChunk, isMouseChunk, type MouseGate } from './mouse-frames';

const MOTION_1 = '\x1b[<35;94;41M';
const MOTION_2 = '\x1b[<35;96;41M';
const MOTION_3 = '\x1b[<35;98;42M';
const DRAG = '\x1b[<32;10;5M';
const CLICK = '\x1b[<0;5;3M';
const RELEASE = '\x1b[<0;5;3m';
const WHEEL = '\x1b[<64;10;20M';

describe('isMouseChunk', () => {
  it('matches single and concatenated complete frames', () => {
    expect(isMouseChunk(MOTION_1)).toBe(true);
    expect(isMouseChunk(MOTION_1 + MOTION_2)).toBe(true);
    expect(isMouseChunk(CLICK + RELEASE)).toBe(true);
  });

  it('rejects fragments, reports, and plain text', () => {
    expect(isMouseChunk('\x1b[<35;94;4')).toBe(false); // truncated
    expect(isMouseChunk('35;94;41M')).toBe(false); // no ESC[< prefix
    expect(isMouseChunk('\x1b[0c')).toBe(false); // DA report
    expect(isMouseChunk('ls -la')).toBe(false);
    expect(isMouseChunk(MOTION_1 + 'x')).toBe(false); // trailing junk
  });
});

describe('isMotionChunk', () => {
  it('classifies motion (32–63) vs click/release/wheel', () => {
    expect(isMotionChunk(MOTION_1)).toBe(true); // 35 = move, no button
    expect(isMotionChunk(DRAG)).toBe(true); // 32 = drag with left button
    expect(isMotionChunk(MOTION_1 + MOTION_2)).toBe(true);
    expect(isMotionChunk(CLICK)).toBe(false);
    expect(isMotionChunk(RELEASE)).toBe(false);
    expect(isMotionChunk(WHEEL)).toBe(false); // 64 = wheel up
    expect(isMotionChunk(MOTION_1 + CLICK)).toBe(false); // mixed
    expect(isMotionChunk('not mouse')).toBe(false);
  });
});

describe('createMouseGate', () => {
  let send: ReturnType<typeof vi.fn>;
  let focused: boolean;
  let gate: MouseGate;

  beforeEach(() => {
    vi.useFakeTimers();
    send = vi.fn();
    focused = true;
    gate = createMouseGate({ send, intervalMs: 33, hasFocus: () => focused });
  });

  afterEach(() => {
    gate.dispose();
    vi.useRealTimers();
  });

  it('passes non-mouse input through untouched', () => {
    expect(gate.feed('ls\r')).toBe(false);
    expect(gate.feed('\x1b[0c')).toBe(false); // DA report: not the gate's job
    expect(send).not.toHaveBeenCalled();
  });

  it('drops motion while the document is unfocused', () => {
    focused = false;
    expect(gate.feed(MOTION_1)).toBe(true); // consumed …
    vi.advanceTimersByTime(200);
    expect(send).not.toHaveBeenCalled(); // … and never sent
  });

  it('still passes clicks and wheel while unfocused (click-to-focus a pane)', () => {
    focused = false;
    expect(gate.feed(CLICK)).toBe(false);
    expect(gate.feed(WHEEL)).toBe(false);
  });

  it('sends the first motion immediately, then throttles latest-wins', () => {
    expect(gate.feed(MOTION_1)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1); // leading edge
    expect(send).toHaveBeenCalledWith(MOTION_1);
    expect(gate.feed(MOTION_2)).toBe(true); // within the window: stashed
    expect(gate.feed(MOTION_3)).toBe(true); // newer sample replaces it
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(33);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(MOTION_3); // only the newest position
  });

  it('flushes pending motion before a click so ordering is preserved', () => {
    gate.feed(MOTION_1); // leading send
    gate.feed(MOTION_2); // pending
    expect(gate.feed(CLICK)).toBe(false); // caller forwards the click itself…
    expect(send).toHaveBeenLastCalledWith(MOTION_2); // …after the motion flushed
  });

  it('flushes pending motion before ordinary input', () => {
    gate.feed(MOTION_1);
    gate.feed(MOTION_2);
    expect(gate.feed('q')).toBe(false);
    expect(send).toHaveBeenLastCalledWith(MOTION_2);
  });

  it('drops a queued frame if focus is lost before the tick', () => {
    gate.feed(MOTION_1);
    gate.feed(MOTION_2);
    focused = false;
    vi.advanceTimersByTime(33);
    expect(send).toHaveBeenCalledTimes(1); // MOTION_2 dropped
    expect(send).toHaveBeenCalledWith(MOTION_1);
  });

  it('only ever forwards whole frames (never splits a sequence)', () => {
    gate.feed(MOTION_1);
    gate.feed(MOTION_2 + MOTION_3); // a multi-frame chunk stays one unit
    vi.advanceTimersByTime(33);
    for (const call of send.mock.calls) {
      expect(isMouseChunk(call[0] as string)).toBe(true);
    }
    expect(send).toHaveBeenLastCalledWith(MOTION_2 + MOTION_3);
  });

  it('resumes with a fresh window after the throttle goes idle', () => {
    gate.feed(MOTION_1);
    vi.advanceTimersByTime(33); // tick with nothing pending → idle
    vi.advanceTimersByTime(100);
    gate.feed(MOTION_2);
    expect(send).toHaveBeenLastCalledWith(MOTION_2); // immediate again
  });
});
