// Behavior tests for the sticky-modifier states of the extra-keys bar:
// tap = one-shot ('armed', cleared after the next key), long-press = 'locked'
// (applies to every key until tapped off), each with its own visual class.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { ExtraKeysBar, type ExtraKeysBarHandle } from './ExtraKeysBar';
import type { ExtraKeysConfig } from './extra-keys';

const CONFIG: ExtraKeysConfig = { enabled: true, layout: [['CTRL', 'b']] };

const tap = (el: HTMLElement) => {
  fireEvent.pointerDown(el, { clientX: 0, clientY: 0 });
  fireEvent.pointerUp(el, { clientX: 0, clientY: 0 });
};

const longPress = (el: HTMLElement) => {
  fireEvent.pointerDown(el, { clientX: 0, clientY: 0 });
  act(() => {
    vi.advanceTimersByTime(400); // past LONG_PRESS_MS
  });
  fireEvent.pointerUp(el, { clientX: 0, clientY: 0 });
};

/** A horizontal swipe across a key (drawer gesture): down → move → up. */
const swipe = (el: HTMLElement, dx: number) => {
  fireEvent.pointerDown(el, { clientX: 100, clientY: 0 });
  fireEvent.pointerMove(el, { clientX: 100 + dx, clientY: 0 });
  fireEvent.pointerUp(el, { clientX: 100 + dx, clientY: 0 });
};

describe('ExtraKeysBar sticky modifiers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = () => {
    const send = vi.fn();
    render(<ExtraKeysBar config={CONFIG} visible send={send} onHeightChange={() => {}} />);
    return {
      send,
      ctrl: screen.getByTestId('extra-key-CTRL'),
      b: screen.getByTestId('extra-key-b'),
    };
  };

  it('tap arms a one-shot modifier: applied to the next key, then cleared', () => {
    const { send, ctrl, b } = setup();

    tap(ctrl);
    expect(ctrl.className).toContain('armed');
    expect(ctrl.className).not.toContain('locked');

    tap(b);
    expect(send).toHaveBeenNthCalledWith(1, '\x02'); // Ctrl+B
    expect(ctrl.className).not.toContain('armed');

    tap(b);
    expect(send).toHaveBeenNthCalledWith(2, 'b'); // modifier was one-shot
  });

  it('tap again disarms without sending anything', () => {
    const { send, ctrl } = setup();
    tap(ctrl);
    tap(ctrl);
    expect(ctrl.className).not.toContain('armed');
    expect(send).not.toHaveBeenCalled();
  });

  it('a thumb that drifts a few px while holding still locks the modifier', () => {
    // The hold used to die at 10px of travel — the same threshold that cancels
    // a keystroke — so a resting thumb silently lost the lock.
    const { ctrl } = setup();
    fireEvent.pointerDown(ctrl, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(ctrl, { clientX: 14, clientY: 4 });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    fireEvent.pointerUp(ctrl, { clientX: 14, clientY: 4 });
    expect(ctrl.className).toContain('locked');
  });

  it('a real swipe past the hold slop cancels the lock', () => {
    const { ctrl } = setup();
    fireEvent.pointerDown(ctrl, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(ctrl, { clientX: 40, clientY: 0 });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    fireEvent.pointerUp(ctrl, { clientX: 40, clientY: 0 });
    expect(ctrl.className).not.toContain('locked');
  });

  it('suppresses the OS context menu (it steals soft-keyboard focus)', () => {
    setup();
    const bar = document.getElementById('extra-keys-bar')!;
    const ev = new Event('contextmenu', { bubbles: true, cancelable: true });
    bar.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('long-press locks the modifier until it is tapped off', () => {
    const { send, ctrl, b } = setup();

    longPress(ctrl);
    expect(ctrl.className).toContain('locked');

    tap(b);
    tap(b);
    expect(send).toHaveBeenNthCalledWith(1, '\x02');
    expect(send).toHaveBeenNthCalledWith(2, '\x02'); // still applied
    expect(ctrl.className).toContain('locked');

    tap(ctrl); // unlock
    expect(ctrl.className).not.toContain('locked');
    tap(b);
    expect(send).toHaveBeenNthCalledWith(3, 'b');
  });

  it('a quick tap never locks (timer cancelled on release)', () => {
    const { ctrl } = setup();
    tap(ctrl);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(ctrl.className).toContain('armed');
    expect(ctrl.className).not.toContain('locked');
  });
});

describe('ExtraKeysBar long-press actions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const ACTION_CONFIG: ExtraKeysConfig = {
    enabled: true,
    layout: [[{ key: 'ESC', action: 'keyboard' }]],
  };

  const setup = () => {
    const send = vi.fn();
    const onAction = vi.fn();
    render(
      <ExtraKeysBar
        config={ACTION_CONFIG}
        visible
        send={send}
        onAction={onAction}
        onHeightChange={() => {}}
      />,
    );
    return { send, onAction, esc: screen.getByTestId('extra-key-ESC') };
  };

  it('a tap sends the key, not the action', () => {
    const { send, onAction, esc } = setup();
    tap(esc);
    expect(send).toHaveBeenCalledWith('\x1b'); // ESC byte
    expect(onAction).not.toHaveBeenCalled();
  });

  it('a long-press fires the action and suppresses the key', () => {
    const { send, onAction, esc } = setup();
    longPress(esc);
    expect(onAction).toHaveBeenCalledWith('keyboard');
    expect(send).not.toHaveBeenCalled();
  });

  // The real-world shape: a macro key that ALSO carries an action, so a tap
  // still types and only the hold reaches the app (dictation).
  it('a macro key with an action taps its macro and holds for the action', () => {
    const send = vi.fn();
    const onAction = vi.fn();
    render(
      <ExtraKeysBar
        config={{
          enabled: true,
          layout: [[{ macro: 'ALT ENTER', display: '🔵', action: 'dictate' }]],
        }}
        visible
        send={send}
        onAction={onAction}
        onHeightChange={() => {}}
      />,
    );
    const key = screen.getByTestId('extra-key-ALT ENTER');
    expect(key.textContent).toContain('🔉'); // long-press hint

    tap(key);
    expect(send).toHaveBeenCalledWith('\x1b\r');
    expect(onAction).not.toHaveBeenCalled();

    send.mockClear();
    longPress(key);
    expect(onAction).toHaveBeenCalledWith('dictate');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('ExtraKeysBar gestures & repeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const ARROWS: ExtraKeysConfig = { enabled: true, layout: [['ALT', 'LEFT']] };
  const setup = (onSwipe = vi.fn()) => {
    const send = vi.fn();
    render(
      <ExtraKeysBar
        config={ARROWS}
        visible
        send={send}
        onSwipe={onSwipe}
        onHeightChange={() => {}}
      />,
    );
    return {
      send,
      onSwipe,
      left: screen.getByTestId('extra-key-LEFT'),
      alt: screen.getByTestId('extra-key-ALT'),
    };
  };

  it('a tapped (armed) modifier applies to the very next key — the lost race', () => {
    // Regression: tap ALT then tap LEFT must send Alt+Left, not a bare Left. The
    // armed state is read from a synchronous ref, so it lands even one event later.
    const { send, alt, left } = setup();
    tap(alt);
    tap(left);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('\x1b[1;3D'); // CSI Alt+Left
  });

  it('holding a plain key auto-repeats it', () => {
    const { send, left } = setup();
    fireEvent.pointerDown(left, { clientX: 0, clientY: 0 });
    act(() => vi.advanceTimersByTime(400 + 60 * 3)); // delay + 3 intervals
    fireEvent.pointerUp(left, { clientX: 0, clientY: 0 });
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(send).toHaveBeenLastCalledWith('\x1b[D');
  });

  it('a quick tap emits exactly once (no repeat)', () => {
    const { send, left } = setup();
    tap(left);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('\x1b[D');
  });

  it('a horizontal swipe reports its DIRECTION and never sends a key', () => {
    const { send, onSwipe, left } = setup();
    swipe(left, 80);
    expect(onSwipe).toHaveBeenCalledWith('right');
    expect(send).not.toHaveBeenCalled();
    swipe(left, -80);
    expect(onSwipe).toHaveBeenLastCalledWith('left');
  });

  it('a moved press (edge gesture) cancels the key — no phantom keystroke', () => {
    const { send, onSwipe, left } = setup();
    // Small drift past the cancel threshold but under the drawer distance.
    swipe(left, 20);
    expect(send).not.toHaveBeenCalled();
    expect(onSwipe).not.toHaveBeenCalled();
  });
});

// Holding a modifier while pressing another key is how a keyboard works, and it
// was silently dropped: the bar kept ONE gesture slot, so the second finger's
// press returned at the guard. Reported from a phone as "long-press CTRL + ←
// does nothing", while tap-CTRL + ← worked.
describe('a held modifier does not block the next key', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const CFG: ExtraKeysConfig = { enabled: true, layout: [['CTRL', 'ALT', 'LEFT', 'b']] };
  const setup = () => {
    const send = vi.fn();
    render(<ExtraKeysBar config={CFG} visible send={send} onHeightChange={() => {}} />);
    const keys = [...document.querySelectorAll('.ek-key')] as HTMLElement[];
    return { send, ctrl: keys[0]!, alt: keys[1]!, left: keys[2]!, b: keys[3]! };
  };
  const down = (el: HTMLElement, pointerId: number) =>
    fireEvent.pointerDown(el, { clientX: 0, clientY: 0, pointerId });
  const up = (el: HTMLElement, pointerId: number) =>
    fireEvent.pointerUp(el, { clientX: 0, clientY: 0, pointerId });

  it('CTRL held down (never released) + ← still sends Ctrl+Left', () => {
    const { send, ctrl, left } = setup();
    down(ctrl, 1);
    act(() => {
      vi.advanceTimersByTime(400); // the hold locks it
    });
    down(left, 2); // second finger, CTRL still down
    up(left, 2);
    expect(send).toHaveBeenCalledWith('\x1b[1;5D');
  });

  it('releasing the modifier afterwards does not emit a key of its own', () => {
    const { send, ctrl, left } = setup();
    down(ctrl, 1);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    down(left, 2);
    up(left, 2);
    send.mockClear();
    up(ctrl, 1); // the hold already fired, so the release is not a tap
    expect(send).not.toHaveBeenCalled();
  });

  // The guard still has a job: two ordinary keys must not interleave.
  it('a second ORDINARY key while one is held is still ignored', () => {
    const { send, left, b } = setup();
    down(left, 1);
    down(b, 2);
    up(b, 2);
    expect(send).not.toHaveBeenCalled();
  });

  it('each pointer ends its own gesture — no cross-cancellation', () => {
    const { send, alt, b } = setup();
    down(alt, 1);
    up(alt, 1); // ALT armed
    down(b, 2);
    up(b, 2);
    expect(send).toHaveBeenCalledWith('\x1bb'); // ESC-prefixed = Meta+b
  });
});

// One physical key can produce several input events — GBoard sends a
// composition shrink where another IME sends deleteContentBackward — and
// useSoftKeyboard reads the modifiers on every path. Consuming on the first
// read left the rest of the burst bare: ^H and then a stray DEL.
describe('an armed modifier survives one key’s whole event burst', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const CFG: ExtraKeysConfig = { enabled: true, layout: [['CTRL']] };
  const setup = () => {
    const ref = createRef<ExtraKeysBarHandle>();
    render(
      <ExtraKeysBar ref={ref} config={CFG} visible send={vi.fn()} onHeightChange={() => {}} />,
    );
    return { ref, ctrl: document.querySelector('.ek-key') as HTMLElement };
  };
  const armCtrl = (ctrl: HTMLElement) => {
    fireEvent.pointerDown(ctrl, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(ctrl, { clientX: 0, clientY: 0, pointerId: 1 });
  };

  it('every read inside the burst sees the same armed modifier', () => {
    const { ref, ctrl } = setup();
    armCtrl(ctrl);
    expect(ref.current!.takeMods().ctrl).toBe(true);
    expect(ref.current!.takeMods().ctrl).toBe(true); // 2nd event, same keypress
    expect(ref.current!.takeMods().ctrl).toBe(true);
  });

  it('but it IS consumed — the next key press is unmodified', () => {
    const { ref, ctrl } = setup();
    armCtrl(ctrl);
    expect(ref.current!.takeMods().ctrl).toBe(true);
    act(() => {
      vi.advanceTimersByTime(50); // past BURST_MS: a new key
    });
    expect(ref.current!.takeMods().ctrl).toBe(false);
  });

  it('a LOCKED modifier is never consumed, burst or not', () => {
    const { ref, ctrl } = setup();
    fireEvent.pointerDown(ctrl, { clientX: 0, clientY: 0, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    fireEvent.pointerUp(ctrl, { clientX: 0, clientY: 0, pointerId: 1 });
    expect(ref.current!.takeMods().ctrl).toBe(true);
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(ref.current!.takeMods().ctrl).toBe(true);
  });
});
