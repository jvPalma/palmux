// The Toast owns its own state via an imperative handle, so firing it never
// re-renders the caller. These pin show + auto-dismiss.

import { act, render } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toast, type ToastHandle } from './Toast';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Toast', () => {
  it('shows a message via the imperative handle and auto-dismisses', () => {
    const ref = createRef<ToastHandle>();
    const { container } = render(<Toast ref={ref} />);
    const el = () => container.querySelector('.toast')!;

    expect(el().textContent).toBe('');
    expect(el().className).not.toContain('show');

    act(() => ref.current!.show('Copied'));
    expect(el().textContent).toBe('Copied');
    expect(el().className).toContain('show');

    act(() => vi.advanceTimersByTime(1400));
    expect(el().textContent).toBe('');
    expect(el().className).not.toContain('show');
  });

  // An actionable toast is a decision point, not a confirmation: 1.4s is not
  // enough to read a sentence and reach a button, so it holds for 6s.
  it('holds an actionable toast far longer, and the action dismisses it', () => {
    const ref = createRef<ToastHandle>();
    const onClick = vi.fn();
    const { container } = render(<Toast ref={ref} />);
    const el = () => container.querySelector('.toast')!;

    act(() => ref.current!.show('recording kept', { label: 'Open history', onClick }));
    act(() => vi.advanceTimersByTime(1400));
    expect(el().textContent).toContain('recording kept'); // the plain window is over

    const button = container.querySelector<HTMLButtonElement>('[data-testid="toast-action"]')!;
    expect(button.textContent).toBe('Open history');
    act(() => button.click());

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(el().textContent).toBe(''); // navigating away leaves nothing hanging
    expect(el().className).not.toContain('show');
  });

  it('auto-dismisses an actionable toast at 6s', () => {
    const ref = createRef<ToastHandle>();
    const { container } = render(<Toast ref={ref} />);
    const el = () => container.querySelector('.toast')!;

    act(() => ref.current!.show('kept', { label: 'Open history', onClick: vi.fn() }));
    act(() => vi.advanceTimersByTime(5999));
    expect(el().textContent).toContain('kept');
    act(() => vi.advanceTimersByTime(1));
    expect(el().textContent).toBe('');
  });

  // A plain toast floats over the terminal and must not eat a tap; an
  // actionable one has to be clickable. The button's presence is the switch.
  it('drops the action when the next toast has none', () => {
    const ref = createRef<ToastHandle>();
    const { container } = render(<Toast ref={ref} />);
    const action = () => container.querySelector('[data-testid="toast-action"]');

    act(() => ref.current!.show('kept', { label: 'Open history', onClick: vi.fn() }));
    expect(action()).toBeTruthy();
    act(() => ref.current!.show('Copied'));
    expect(action()).toBeNull();
    act(() => vi.advanceTimersByTime(1400));
    expect(container.querySelector('.toast')!.textContent).toBe('');
  });

  it('a second show resets the dismiss timer', () => {
    const ref = createRef<ToastHandle>();
    const { container } = render(<Toast ref={ref} />);
    const el = () => container.querySelector('.toast')!;

    act(() => ref.current!.show('one'));
    act(() => vi.advanceTimersByTime(1000));
    act(() => ref.current!.show('two')); // resets the 1400ms window
    act(() => vi.advanceTimersByTime(1000));
    expect(el().textContent).toBe('two'); // not dismissed yet
    act(() => vi.advanceTimersByTime(400));
    expect(el().textContent).toBe('');
  });
});
