// The soft keyboard wired to the REAL extra-keys bar, which is the gap the
// other tests leave: useSoftKeyboard.test.tsx passes a fake `getMods: () => mods`
// that never consumes, so it proves the encoding and nothing about `takeMods` —
// the arming, the one-shot consume, or the burst latch. This file drives App's
// actual composition: barRef → getMods → useSoftKeyboard, over every route a
// backspace can take on a phone.

import { act, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtraKeysBar, type ExtraKeysBarHandle } from './ExtraKeysBar';
import { useSoftKeyboard } from './useSoftKeyboard';
import { NO_MODS } from './key-encoder';
import type { ExtraKeysConfig } from './extra-keys';

const CFG: ExtraKeysConfig = { enabled: true, layout: [['CTRL', 'ALT']] };

// Exactly App.tsx's wiring: barRef → getMods → useSoftKeyboard.
function Harness({ sendInput }: { sendInput: (s: string) => void }) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const barRef = useRef<ExtraKeysBarHandle>(null);
  const getMods = () => barRef.current?.takeMods() ?? { ...NO_MODS };
  useSoftKeyboard({ taRef, active: true, sendInput, getMods, isBlocked: () => false });
  return (
    <>
      <textarea ref={taRef} id="mobile-kbd" />
      <ExtraKeysBar ref={barRef} config={CFG} visible send={sendInput} onHeightChange={() => {}} />
    </>
  );
}

const hex = (s: string) =>
  [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');

describe('bar modifier + soft-keyboard backspace, end to end', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const sent: string[] = [];
    render(<Harness sendInput={(s) => sent.push(s)} />);
    const ta = document.getElementById('mobile-kbd') as HTMLTextAreaElement;
    const keys = [...document.querySelectorAll('.ek-key')] as HTMLElement[];
    return { sent, ta, ctrl: keys[0]!, alt: keys[1]! };
  };
  const tap = (el: HTMLElement) => {
    fireEvent.pointerDown(el, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(el, { clientX: 0, clientY: 0, pointerId: 1 });
  };
  const hold = (el: HTMLElement) => {
    fireEvent.pointerDown(el, { clientX: 0, clientY: 0, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    fireEvent.pointerUp(el, { clientX: 0, clientY: 0, pointerId: 1 });
  };
  const beforeinput = (ta: HTMLTextAreaElement, inputType: string) => {
    const ev = new Event('beforeinput', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'inputType', { value: inputType });
    Object.defineProperty(ev, 'data', { value: null });
    ta.dispatchEvent(ev);
  };

  it('armed CTRL + deleteContentBackward', () => {
    const { sent, ta, ctrl } = setup();
    tap(ctrl);
    beforeinput(ta, 'deleteContentBackward');
    expect(sent.map(hex)).toEqual([hex('\x08')]);
  });

  it('locked CTRL + deleteContentBackward', () => {
    const { sent, ta, ctrl } = setup();
    hold(ctrl);
    beforeinput(ta, 'deleteContentBackward');
    expect(sent.map(hex)).toEqual([hex('\x08')]);
  });

  it('armed ALT + deleteContentBackward', () => {
    const { sent, ta, alt } = setup();
    tap(alt);
    beforeinput(ta, 'deleteContentBackward');
    expect(sent.map(hex)).toEqual([hex('\x1b\x7f')]);
  });

  it('armed CTRL + deleteWordBackward', () => {
    const { sent, ta, ctrl } = setup();
    tap(ctrl);
    beforeinput(ta, 'deleteWordBackward');
    expect(sent.map(hex)).toEqual([hex('\x08')]);
  });

  const comp = (ta: HTMLTextAreaElement, type: string, data: string | null) => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'data', { value: data });
    ta.dispatchEvent(ev);
  };

  it("armed CTRL + a shrinking composition — GBoard's actual route", () => {
    const { sent, ta, ctrl } = setup();
    comp(ta, 'compositionstart', null);
    comp(ta, 'compositionupdate', 'ab');
    sent.length = 0;
    tap(ctrl);
    comp(ta, 'compositionupdate', 'a'); // backspace = encolher 1
    expect(sent.map(hex)).toEqual([hex('\x08')]);
  });

  it('locked ALT + a shrinking composition', () => {
    const { sent, ta, alt } = setup();
    comp(ta, 'compositionstart', null);
    comp(ta, 'compositionupdate', 'ab');
    sent.length = 0;
    hold(alt);
    comp(ta, 'compositionupdate', 'a');
    expect(sent.map(hex)).toEqual([hex('\x1b\x7f')]);
  });

  it('one key, two events: the modifier survives both', () => {
    const { sent, ta, ctrl } = setup();
    comp(ta, 'compositionstart', null);
    comp(ta, 'compositionupdate', 'ab');
    sent.length = 0;
    tap(ctrl);
    beforeinput(ta, 'deleteContentBackward'); // 1.º evento
    comp(ta, 'compositionupdate', 'a'); // 2.º evento, mesma tecla
    // Both events carry the modifier: the burst latch replays the snapshot the
    // first read consumed. Before it, the second event sent a bare 0x7f — a word
    // killed and one more character with it.
    expect(sent.map(hex)).toEqual([hex('\x08'), hex('\x08')]);
  });
});

// Two defects a raw byte capture from a real phone exposed, both in keys that
// go through the soft keyboard rather than the bar.
describe('keys that were skipping the modifier entirely', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const sent: string[] = [];
    render(<Harness sendInput={(s) => sent.push(s)} />);
    const ta = document.getElementById('mobile-kbd') as HTMLTextAreaElement;
    const keys = [...document.querySelectorAll('.ek-key')] as HTMLElement[];
    return { sent, ta, ctrl: keys[0]!, alt: keys[1]! };
  };
  const tap = (el: HTMLElement) => {
    fireEvent.pointerDown(el, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(el, { clientX: 0, clientY: 0, pointerId: 1 });
  };
  const bi = (ta: HTMLTextAreaElement, inputType: string) => {
    const ev = new Event('beforeinput', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'inputType', { value: inputType });
    Object.defineProperty(ev, 'data', { value: null });
    ta.dispatchEvent(ev);
  };
  const comp = (ta: HTMLTextAreaElement, type: string, data: string | null) => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'data', { value: data });
    ta.dispatchEvent(ev);
  };
  const gap = () =>
    act(() => {
      vi.advanceTimersByTime(300); // past BURST_MS: a genuinely new key
    });

  // Caught on the wire: with CTRL armed, Enter put a bare 0x0d on the PTY.
  it('Enter goes through the encoder, so the modifier is consumed', () => {
    const { sent, ta, ctrl } = setup();
    tap(ctrl);
    bi(ta, 'insertLineBreak');
    expect(sent.map(hex)).toEqual([hex('\r')]); // CTRL+Enter is still CR…
    gap();
    bi(ta, 'insertLineBreak');
    expect(sent).toHaveLength(2); // …but the modifier did not survive to leak
  });

  it('ALT+Enter sends ESC CR', () => {
    const { sent, ta, alt } = setup();
    tap(alt);
    bi(ta, 'insertLineBreak');
    expect(sent.map(hex)).toEqual([hex('\x1b\r')]);
  });

  // A composition delta that removes AND adds in one step: the modifier belongs
  // to the delete. It used to send a bare DEL and then hand the modifier to the
  // inserted character — measured as 7f then 18 (^X) for a CTRL-armed b→x.
  it('a remove-and-add delta modifies the DELETE, never the insert', () => {
    const { sent, ta, ctrl } = setup();
    comp(ta, 'compositionstart', null);
    comp(ta, 'compositionupdate', 'ab');
    gap();
    tap(ctrl);
    sent.length = 0;
    comp(ta, 'compositionupdate', 'ax');
    expect(sent.map(hex)).toEqual([hex('\x08'), hex('x')]);
  });

  it('a plain backspace before it does not disturb the next modified one', () => {
    const { sent, ta, ctrl } = setup();
    bi(ta, 'deleteContentBackward');
    gap();
    tap(ctrl);
    gap();
    bi(ta, 'deleteContentBackward');
    expect(sent.map(hex)).toEqual([hex('\x7f'), hex('\x08')]);
  });
});

// The one the capture finally pinned. `onKeyDown` built its modifiers from the
// PHYSICAL event only — `e.ctrlKey` is false however armed the bar's CTRL is —
// and then `preventDefault()`, so the mods-aware `beforeinput` path never ran.
// `e.isComposing` hid it: with a composition live this handler returns early and
// the composition path (which does read the bar) sends the right bytes. Hence
// the reported shape — CTRL+Backspace worked once right after typing a letter,
// then stopped, because that backspace empties the one-character composition.
describe('a soft-keyboard keydown honours the bar’s sticky modifier', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const sent: string[] = [];
    render(<Harness sendInput={(s) => sent.push(s)} />);
    const ta = document.getElementById('mobile-kbd') as HTMLTextAreaElement;
    const keys = [...document.querySelectorAll('.ek-key')] as HTMLElement[];
    return { sent, ta, ctrl: keys[0]!, alt: keys[1]! };
  };
  const tap = (el: HTMLElement) => {
    fireEvent.pointerDown(el, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(el, { clientX: 0, clientY: 0, pointerId: 1 });
  };
  // No composition, no physical ctrlKey — a phone's plain Backspace keydown.
  const key = (ta: HTMLTextAreaElement, k: string) =>
    fireEvent.keyDown(ta, { key: k, ctrlKey: false, altKey: false, shiftKey: false });

  it('CTRL armed + Backspace with NO composition still sends ^H', () => {
    const { sent, ta, ctrl } = setup();
    tap(ctrl);
    key(ta, 'Backspace');
    expect(sent.map(hex)).toEqual([hex('\x08')]);
  });

  it('ALT armed + Backspace sends ESC DEL', () => {
    const { sent, ta, alt } = setup();
    tap(alt);
    key(ta, 'Backspace');
    expect(sent.map(hex)).toEqual([hex('\x1b\x7f')]);
  });

  it('a LOCKED modifier keeps working, press after press', () => {
    const { sent, ta, ctrl } = setup();
    fireEvent.pointerDown(ctrl, { clientX: 0, clientY: 0, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    fireEvent.pointerUp(ctrl, { clientX: 0, clientY: 0, pointerId: 1 });
    for (const _ of [1, 2, 3]) {
      key(ta, 'Backspace');
      act(() => {
        vi.advanceTimersByTime(300);
      });
    }
    expect(sent.map(hex)).toEqual([hex('\x08'), hex('\x08'), hex('\x08')]);
  });

  it('unarmed, it is still a plain DEL', () => {
    const { sent, ta } = setup();
    key(ta, 'Backspace');
    expect(sent.map(hex)).toEqual([hex('\x7f')]);
  });

  it('the modifier is spent, not left to leak onto the next key', () => {
    const { sent, ta, ctrl } = setup();
    tap(ctrl);
    key(ta, 'Backspace');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    key(ta, 'Backspace');
    expect(sent.map(hex)).toEqual([hex('\x08'), hex('\x7f')]);
  });
});
