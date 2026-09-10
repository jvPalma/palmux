// The pointer conventions. `pressMove` exists because the pointerdown form is
// unusable on anything that scrolls, and this file pins BOTH halves of that:
// a swipe must not activate, and a swipe must not be preventDefaulted (which is
// what cancels the browser's pan and made the drawer unscrollable).

import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { press, pressKbdMove, pressMove } from './press';

const Row = ({ action }: { action: () => void }) => (
  <button data-testid="row" {...pressMove(action)}>
    row
  </button>
);

afterEach(() => {
  document.getElementById('mobile-kbd')?.remove();
});

const at = (x: number, y: number) => ({ pointerId: 1, clientX: x, clientY: y });

describe('pressMove', () => {
  it('activates on pointerup after a still press', () => {
    const action = vi.fn();
    render(<Row action={action} />);
    const row = screen.getByTestId('row');

    fireEvent.pointerDown(row, at(50, 50));
    expect(action).not.toHaveBeenCalled(); // NOT on down — the finger may be scrolling
    fireEvent.pointerUp(row, at(50, 52));
    expect(action).toHaveBeenCalledTimes(1);
  });

  // The reported bug: touching a tmux row to scroll the list opened that session
  // and closed the drawer.
  it('does not activate when the finger travelled past the slop', () => {
    const action = vi.fn();
    render(<Row action={action} />);
    const row = screen.getByTestId('row');

    fireEvent.pointerDown(row, at(50, 200));
    fireEvent.pointerMove(row, at(50, 160)); // a scroll
    fireEvent.pointerUp(row, at(50, 160));
    expect(action).not.toHaveBeenCalled();
  });

  // The other half: a preventDefaulted touch pointerdown cancels the pan, so the
  // list could not scroll even if nothing fired.
  it('leaves a TOUCH pointerdown alone so the browser can pan', () => {
    render(<Row action={vi.fn()} />);
    const row = screen.getByTestId('row');

    const touch = createEvent.pointerDown(row, {
      ...at(50, 50),
      pointerType: 'touch',
      cancelable: true,
    });
    fireEvent(row, touch);
    expect(touch.defaultPrevented).toBe(false);
  });

  it('still preventDefaults a MOUSE pointerdown, which cannot pan', () => {
    render(<Row action={vi.fn()} />);
    const row = screen.getByTestId('row');

    const mouse = createEvent.pointerDown(row, {
      ...at(50, 50),
      pointerType: 'mouse',
      cancelable: true,
    });
    fireEvent(row, mouse);
    expect(mouse.defaultPrevented).toBe(true);
  });

  // The touch path lets focus move to the control, so the soft keyboard would
  // dismiss; activation puts it back.
  it('restores #mobile-kbd focus, so a tap does not dismiss the soft keyboard', () => {
    const kbd = document.createElement('textarea');
    kbd.id = 'mobile-kbd';
    document.body.append(kbd);
    kbd.focus();

    render(<Row action={vi.fn()} />);
    const row = screen.getByTestId('row');
    fireEvent.pointerDown(row, { ...at(50, 50), pointerType: 'touch' });
    row.focus(); // what the browser does on a touch it was allowed to default
    fireEvent.pointerUp(row, { ...at(50, 50), pointerType: 'touch' });

    expect(document.activeElement).toBe(kbd);
  });

  it('a cancelled pointer arms nothing', () => {
    const action = vi.fn();
    render(<Row action={action} />);
    const row = screen.getByTestId('row');

    fireEvent.pointerDown(row, at(50, 50));
    fireEvent.pointerCancel(row, at(50, 50));
    fireEvent.pointerUp(row, at(50, 50));
    expect(action).not.toHaveBeenCalled();
  });
});

describe('pressKbdMove', () => {
  it('keeps Enter/Space activation for a keyboard', () => {
    const action = vi.fn();
    render(
      <button data-testid="k" {...pressKbdMove(action)}>
        k
      </button>,
    );
    fireEvent.keyDown(screen.getByTestId('k'), { key: 'Enter' });
    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe('press', () => {
  // Unchanged, and still correct for fixed chrome: the footer and the scrim
  // never scroll, and firing on down is what preserves the soft keyboard.
  it('fires on pointerdown and preventDefaults it', () => {
    const action = vi.fn();
    render(
      <button data-testid="f" onPointerDown={press(action)}>
        f
      </button>,
    );
    const ev = createEvent.pointerDown(screen.getByTestId('f'), { ...at(1, 1), cancelable: true });
    fireEvent(screen.getByTestId('f'), ev);
    expect(action).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });
});
