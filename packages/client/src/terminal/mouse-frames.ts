// ── SGR mouse-report frame gating ─────────────────────────────────────────────
//
// xterm emits SGR (1006) mouse reports (`\x1b[<b;x;yM` / `m`) as terminal INPUT
// whenever an app has requested tracking. Two failure modes turn them into the
// classic `35;94;41M` garbage typed into a shell or a TUI's input box:
//   • pure-motion frames (button 32–63, e.g. 35 = move with no button) generated
//     by hovering over an UNFOCUSED window still get forwarded — input the user
//     never intended, mirroring the DA/DSR report gate's problem;
//   • motion floods at pointer-event rate overwhelm slow TUI input parsers,
//     which mis-parse fragmented frames and print the tail as literal text.
// The gate drops motion while the document is unfocused and throttles the rest
// to one frame per interval (latest wins — only the newest position matters),
// flushing any pending motion before a click/wheel frame so ordering is
// preserved. Clicks and wheel are NEVER dropped: clicking into an unfocused
// window must still focus a tmux pane. Frames are always forwarded whole.

const CHUNK_RE = /^(?:\x1b\[<\d{1,4};\d{1,4};\d{1,4}[Mm])+$/;
const BUTTON_RE = /\x1b\[<(\d{1,4});/g;

/** True when the chunk is one or more complete SGR mouse-report frames. */
export function isMouseChunk(chunk: string): boolean {
  return CHUNK_RE.test(chunk);
}

/**
 * True when every frame in a mouse chunk is a pure motion report (button
 * 32–63: the +32 motion flag without the +64 wheel flag). Clicks (0–3) and
 * wheel (64+) chunks — or mixed chunks — are not motion.
 */
export function isMotionChunk(chunk: string): boolean {
  if (!isMouseChunk(chunk)) return false;
  BUTTON_RE.lastIndex = 0;
  for (let m = BUTTON_RE.exec(chunk); m !== null; m = BUTTON_RE.exec(chunk)) {
    const btn = Number(m[1]);
    if (btn < 32 || btn >= 64) return false;
  }
  return true;
}

export interface MouseGate {
  /**
   * Feed one onData chunk. Returns true when the chunk was consumed (motion:
   * dropped or queued for the throttle); false when the caller must forward it
   * itself (non-mouse input, clicks, wheel — pending motion is flushed first
   * so frame order is preserved).
   */
  feed: (chunk: string) => boolean;
  dispose: () => void;
}

interface MouseGateOptions {
  send: (bytes: string) => void;
  /** Throttle window for motion frames (default 33ms ≈ 30fps). */
  intervalMs?: number;
  /** Injectable for tests; defaults to document.hasFocus(). */
  hasFocus?: () => boolean;
}

export function createMouseGate({
  send,
  intervalMs = 33,
  hasFocus = () => document.hasFocus(),
}: MouseGateOptions): MouseGate {
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const onTick = () => {
    timer = null;
    if (pending === null) return;
    const frame = pending;
    pending = null;
    // Focus may have been lost while the frame waited — drop, don't inject.
    if (!hasFocus()) return;
    send(frame);
    timer = setTimeout(onTick, intervalMs);
  };

  const flushPending = () => {
    if (pending === null) return;
    const frame = pending;
    pending = null;
    send(frame);
  };

  const feed = (chunk: string): boolean => {
    if (!isMouseChunk(chunk)) {
      // Ordinary input overtaking a queued hover frame would reorder the
      // stream — release the motion first, then let the caller send.
      flushPending();
      return false;
    }
    if (!isMotionChunk(chunk)) {
      flushPending();
      return false; // click / wheel — never dropped, caller forwards
    }
    if (!hasFocus()) return true; // hover over an unfocused window — drop
    pending = chunk; // latest wins
    if (timer === null) {
      // Leading edge: first motion goes out immediately, the window begins.
      pending = null;
      send(chunk);
      timer = setTimeout(onTick, intervalMs);
    }
    return true;
  };

  return {
    feed,
    dispose: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
