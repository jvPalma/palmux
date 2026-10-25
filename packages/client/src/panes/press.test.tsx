// The pointer conventions. `pressMove` exists because the pointerdown form is
// unusable on anything that scrolls, and this file pins BOTH halves of that:
// a swipe must not activate, and a swipe must not be preventDefaulted (which is
// what cancels the browser's pan and made the drawer unscrollable).

import { act, createEvent, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ButtonHTMLAttributes, PointerEvent as ReactPointerEvent } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeGesture, press, pressClick, pressKbdMove, pressMove } from './press';

const Btn = ({ id, action }: { id: string; action: () => void }) => (
  <button data-testid={id} {...pressClick(action)}>
    {id}
  </button>
);

const Row = ({ action }: { action: () => void }) => (
  <button data-testid="row" {...pressMove(action)}>
    row
  </button>
);

/** A, and once pressed, B in its place: another pressClick control, or a
 *  plain onClick button standing in for anything else that could be there.
 *  Keyed, so B is a new element rather than A's node reused. */
const Swap = ({ a, b, plain }: { a: () => void; b: () => void; plain: boolean }) => {
  const [pressed, setPressed] = useState(false);
  if (!pressed) {
    return (
      <Btn
        key="a"
        id="a"
        action={() => {
          a();
          setPressed(true);
        }}
      />
    );
  }
  return plain ? (
    <button key="b" data-testid="b" onClick={b}>
      b
    </button>
  ) : (
    <Btn key="b" id="b" action={b} />
  );
};

afterEach(() => {
  document.getElementById('mobile-kbd')?.remove();
  // A press whose click a test never sent leaves its mark armed for up to a
  // second of real time. A key ends it, as it would in a browser, so it cannot
  // swallow the first click of the next test.
  fireEvent.keyDown(document);
});

const at = (x: number, y: number) => ({ pointerId: 1, clientX: x, clientY: y });

const touchAt = (x: number, y: number, pointerId = 1) => ({
  pointerId,
  clientX: x,
  clientY: y,
  pointerType: 'touch',
});

const boom = (): never => {
  throw new Error('boom');
};

const focusKbd = (): HTMLTextAreaElement => {
  const kbd = document.createElement('textarea');
  kbd.id = 'mobile-kbd';
  document.body.append(kbd);
  kbd.focus();
  return kbd;
};

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

  // Enter, Space, assistive tech and `element.click()` reach a <button> only as a
  // click, and a list control that ignored them worked for pointer users only.
  it('acts on a click with no pointer press before it (keyboard, assistive tech, click())', () => {
    const action = vi.fn();
    render(<Row action={action} />);
    const row = screen.getByTestId('row');

    fireEvent.click(row);
    expect(action).toHaveBeenCalledTimes(1);
    act(() => row.click());
    expect(action).toHaveBeenCalledTimes(2);
  });

  // Chrome forwards a <label>'s click to its control WITH the label click's count,
  // so the count cannot be what tells a pointer's own click from another one.
  it('acts on a click that carries a count when no press of its own came before it', () => {
    const action = vi.fn();
    render(
      <>
        <label htmlFor="labelled" data-testid="label">
          name
        </label>
        <button id="labelled" data-testid="row" {...pressMove(action)}>
          row
        </button>
      </>,
    );
    fireEvent.click(screen.getByTestId('row'), { detail: 1 }); // the click a label forwards
    expect(action).toHaveBeenCalledTimes(1);
  });

  it.each(['touch', 'mouse'])('a %s press acts once: its own click does not act again', (type) => {
    const action = vi.fn();
    render(<Row action={action} />);
    const row = screen.getByTestId('row');

    fireEvent.pointerDown(row, { ...at(50, 50), pointerType: type });
    fireEvent.pointerUp(row, { ...at(50, 50), pointerType: type });
    fireEvent.mouseDown(row, { detail: 1 });
    fireEvent.mouseUp(row, { detail: 1 });
    fireEvent.click(row, { detail: 1 });
    expect(action).toHaveBeenCalledTimes(1);
  });

  // A mouse cannot pan, so a drag released on the control is the one pointer
  // gesture that ends in a click on it without having acted.
  it('a mouse drag released on the control does not act on its click, and only that click', () => {
    const action = vi.fn();
    render(<Row action={action} />);
    const row = screen.getByTestId('row');
    const mouse = (x: number, y: number) => ({ ...at(x, y), pointerType: 'mouse' });

    fireEvent.pointerDown(row, mouse(50, 50));
    fireEvent.pointerMove(row, mouse(50, 90));
    fireEvent.pointerUp(row, mouse(50, 90));
    fireEvent.click(row, { detail: 1 });
    expect(action).not.toHaveBeenCalled();

    fireEvent.click(row); // Enter, afterwards
    expect(action).toHaveBeenCalledTimes(1);
  });

  // The drag's click is an exception for ONE click on ONE control, for as long as
  // a click can still be on its way. Beyond that it would swallow a keyboard
  // activation of a control the user never dragged.
  it('a drag’s swallowed click expires with the window, and is for that control only', () => {
    vi.useFakeTimers();
    try {
      const action = vi.fn();
      const other = vi.fn();
      render(
        <>
          <Row action={action} />
          <button data-testid="other" {...pressMove(other)}>
            other
          </button>
        </>,
      );
      const row = screen.getByTestId('row');
      const mouse = (x: number, y: number) => ({ ...at(x, y), pointerType: 'mouse' });

      fireEvent.pointerDown(row, mouse(50, 50));
      fireEvent.pointerMove(row, mouse(50, 90));
      fireEvent.pointerUp(row, mouse(50, 90));
      fireEvent.click(screen.getByTestId('other'), { detail: 1 });
      expect(other).toHaveBeenCalledTimes(1); // not the control that was dragged on

      fireEvent.pointerDown(row, mouse(50, 50));
      fireEvent.pointerMove(row, mouse(50, 90));
      fireEvent.pointerUp(row, mouse(50, 90));
      vi.advanceTimersByTime(1_500);
      fireEvent.click(row, { detail: 1 });
      expect(action).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // A mouse that leaves the control mid-press and comes back is released on it, so
  // its click still lands on it. Leaving cancelled the press, and it has to stay
  // cancelled through that release and that click: dropping the gesture at the
  // leave let the click through as an activation (a quick link's ✕ removed by a
  // drag that wandered off it and back).
  describe('a mouse press that leaves the control and is released back on it', () => {
    const mouse = (x: number, y: number) => ({ ...at(x, y), pointerType: 'mouse' });
    const leaveAndReturn = (row: HTMLElement, travel: number) => {
      fireEvent.pointerDown(row, mouse(50, 50));
      fireEvent.pointerMove(row, mouse(50, 50 + travel));
      fireEvent.pointerLeave(row, mouse(50, 200));
      fireEvent.pointerEnter(row, mouse(50, 52));
      fireEvent.pointerMove(row, mouse(50, 52));
      fireEvent.pointerUp(row, mouse(50, 52));
    };

    it.each([
      ['past the slop first', 40],
      ['within the slop', 4],
    ])('acts on nothing, moved %s, and its click does nothing either', (_, travel) => {
      const action = vi.fn();
      render(<Row action={action} />);
      const row = screen.getByTestId('row');
      leaveAndReturn(row, travel);
      expect(action).not.toHaveBeenCalled();

      const click = createEvent.click(row, { detail: 1, cancelable: true });
      fireEvent(row, click);
      expect(action).not.toHaveBeenCalled();
      expect(click.defaultPrevented).toBe(true);
    });

    it('does not swallow a keyboard or assistive-tech activation after it', () => {
      const action = vi.fn();
      render(<Row action={action} />);
      const row = screen.getByTestId('row');
      leaveAndReturn(row, 40);
      fireEvent.click(row, { detail: 1 }); // the drag's own click
      act(() => row.click()); // assistive tech
      expect(action).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(row, { key: 'Enter' });
      fireEvent.click(row); // the click a <button> makes of that Enter
      expect(action).toHaveBeenCalledTimes(2);
    });
  });

  // A press of its own ends the drag, so a key right after it is an activation,
  // not the tail of a drag the user has already left behind.
  it('a fresh press after a drag clears the drag’s exception, so a key right after acts', () => {
    const action = vi.fn();
    render(<Row action={action} />);
    const row = screen.getByTestId('row');
    const mouse = (x: number, y: number) => ({ ...at(x, y), pointerType: 'mouse' });

    fireEvent.pointerDown(row, mouse(50, 50));
    fireEvent.pointerMove(row, mouse(50, 90));
    fireEvent.pointerUp(row, mouse(50, 90));

    fireEvent.pointerDown(row, mouse(50, 50));
    fireEvent.pointerUp(row, mouse(50, 50));
    expect(action).toHaveBeenCalledTimes(1);

    fireEvent.click(row); // Enter, within the window of the drag
    expect(action).toHaveBeenCalledTimes(2);
  });

  // A touch that moved can end with no click at all (a wobble the browser did not
  // cancel), so nothing consumes the drag's exception. A key's click is never a
  // drag's, and neither is the click of a press that came after it, so either one
  // ends the exception at once, the way they end a press's mark.
  describe('a moved release that no click follows', () => {
    const wobble = (row: HTMLElement) => {
      fireEvent.pointerDown(row, touchAt(50, 50));
      fireEvent.pointerMove(row, touchAt(80, 50));
      fireEvent.pointerUp(row, touchAt(80, 50));
    };

    it('does not swallow Enter right after', () => {
      const action = vi.fn();
      render(<Row action={action} />);
      const row = screen.getByTestId('row');
      wobble(row);
      fireEvent.keyDown(row, { key: 'Enter' });
      fireEvent.click(row); // the click a <button> makes of that Enter
      expect(action).toHaveBeenCalledTimes(1);
    });

    // Neither of these needs a key or a pointerdown first, so nothing else ends
    // the exception before them, and a click with no count is never a pointer's.
    it.each([
      ['click(), as assistive tech makes it', (row: HTMLElement) => act(() => row.click())],
      ['a click with no count', (row: HTMLElement) => fireEvent.click(row, { detail: 0 })],
    ])('does not swallow %s right after', (_, activate) => {
      const action = vi.fn();
      render(<Row action={action} />);
      const row = screen.getByTestId('row');
      wobble(row);
      activate(row);
      expect(action).toHaveBeenCalledTimes(1);
    });

    it('does not swallow a click after a press somewhere else', () => {
      const action = vi.fn();
      render(
        <>
          <Row action={action} />
          <div data-testid="elsewhere" />
        </>,
      );
      const row = screen.getByTestId('row');
      wobble(row);
      fireEvent.pointerDown(screen.getByTestId('elsewhere'), touchAt(5, 5, 2));
      fireEvent.pointerUp(screen.getByTestId('elsewhere'), touchAt(5, 5, 2));
      fireEvent.click(row); // assistive tech, no key before it
      expect(action).toHaveBeenCalledTimes(1);
    });
  });

  // A swipe, a cancel, a slide off the control and a release by some other finger
  // each acted on nothing, so each must swallow nothing: the next click anywhere
  // is somebody else's.
  describe('a gesture that does not act arms nothing', () => {
    const GESTURES: [string, (row: HTMLElement) => void][] = [
      [
        'a swipe past the slop',
        (row) => {
          fireEvent.pointerDown(row, touchAt(50, 200));
          fireEvent.pointerMove(row, touchAt(50, 150));
          fireEvent.pointerUp(row, touchAt(50, 150));
        },
      ],
      [
        'a cancelled pointer',
        (row) => {
          fireEvent.pointerDown(row, touchAt(50, 50));
          fireEvent.pointerCancel(row, touchAt(50, 50));
          fireEvent.pointerUp(row, touchAt(50, 50));
        },
      ],
      [
        'a finger that slid off the control',
        (row) => {
          fireEvent.pointerDown(row, touchAt(50, 50));
          fireEvent.pointerLeave(row, touchAt(50, 50));
          fireEvent.pointerUp(row, touchAt(50, 50));
        },
      ],
      [
        'a release by another pointer',
        (row) => {
          fireEvent.pointerDown(row, touchAt(50, 50, 1));
          fireEvent.pointerUp(row, touchAt(50, 50, 2));
        },
      ],
    ];

    it.each(GESTURES)('%s activates nothing and swallows no click', (_, run) => {
      const action = vi.fn();
      const other = vi.fn();
      render(
        <>
          <Row action={action} />
          <button data-testid="other" onClick={other}>
            other
          </button>
        </>,
      );
      run(screen.getByTestId('row'));
      expect(action).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId('other'), { detail: 1 });
      expect(other).toHaveBeenCalledTimes(1);
    });
  });

  // The mark swallows a gesture's mouse events and click. A pointerdown is where
  // the browser decides whether a touch pans, so the mark must never touch one,
  // even while it is armed, or the next swipe over a list would not scroll.
  it('leaves a touch pointerdown alone while another gesture’s mark is armed', () => {
    const rowAction = vi.fn();
    render(
      <>
        <Btn id="arm" action={vi.fn()} />
        <Row action={rowAction} />
      </>,
    );
    fireEvent.pointerDown(screen.getByTestId('arm'), { ...at(1, 1), pointerType: 'touch' });

    const row = screen.getByTestId('row');
    const down = createEvent.pointerDown(row, {
      ...at(50, 50),
      pointerType: 'touch',
      cancelable: true,
    });
    fireEvent(row, down);
    expect(down.defaultPrevented).toBe(false);

    // And it reached the row's own handler: the tap still activates.
    fireEvent.pointerUp(row, { ...at(50, 50), pointerType: 'touch' });
    expect(rowAction).toHaveBeenCalledTimes(1);
  });

  describe('#mobile-kbd', () => {
    // A touch that was allowed its default moves focus onto the control, at the
    // pointerdown or later, with the compatibility mousedown. Both have to end
    // with the keyboard's textarea focused again.
    it.each(['touch', 'mouse'])(
      'a %s tap keeps it focused through the focus move and the late mousedown',
      (pointerType) => {
        const kbd = focusKbd();
        render(<Row action={vi.fn()} />);
        const row = screen.getByTestId('row');
        const pointer = { ...at(50, 50), pointerType };

        fireEvent.pointerDown(row, pointer);
        row.focus(); // the browser's own focus move, at the press
        fireEvent.pointerUp(row, pointer);
        expect(document.activeElement).toBe(kbd);

        const down = createEvent.mouseDown(row, { detail: 1, cancelable: true });
        fireEvent(row, down);
        if (!down.defaultPrevented) row.focus(); // the late compatibility mousedown
        fireEvent.mouseUp(row, { detail: 1 });
        fireEvent.click(row, { detail: 1 });
        expect(down.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(kbd);
      },
    );

    // The restore is for a keyboard that was up. Handing it focus otherwise would
    // raise an IME nobody asked for.
    it('is not given focus by a tap it was not focused for', () => {
      const kbd = document.createElement('textarea');
      kbd.id = 'mobile-kbd';
      document.body.append(kbd);
      const field = document.createElement('input');
      document.body.append(field);
      field.focus();
      render(<Row action={vi.fn()} />);
      const row = screen.getByTestId('row');

      fireEvent.pointerDown(row, { ...at(50, 50), pointerType: 'touch' });
      row.focus();
      fireEvent.pointerUp(row, { ...at(50, 50), pointerType: 'touch' });
      expect(document.activeElement).not.toBe(kbd);
      field.remove();
    });

    // The restore runs BEFORE the action, so an action that focuses something
    // itself (the theme browser's first button) is not undone by it.
    it('is put back before the action runs, so an action that moves focus wins', () => {
      focusKbd();
      const target = document.createElement('input');
      document.body.append(target);
      render(<Row action={() => target.focus()} />);
      const row = screen.getByTestId('row');

      fireEvent.pointerDown(row, { ...at(50, 50), pointerType: 'touch' });
      row.focus();
      fireEvent.pointerUp(row, { ...at(50, 50), pointerType: 'touch' });
      expect(document.activeElement).toBe(target);
      target.remove();
    });
  });
});

// A <label for> forwards its click to the control it names, and the browser gives
// that click the label click's count. The Theme row in Settings is this pair, and
// both of them open the theme browser. One tap, one Enter or one assistive-tech
// click must open it once, not once for the label and once for its control.
const setupLabel = () => {
  const action = vi.fn();
  render(
    <>
      <label htmlFor="theme" data-testid="label" {...pressMove(action)}>
        Theme
      </label>
      <button id="theme" data-testid="control" {...pressMove(action)}>
        Dark
      </button>
    </>,
  );
  return { action, label: screen.getByTestId('label'), control: screen.getByTestId('control') };
};

describe('a <label> that uses pressMove, beside a control that does', () => {
  it.each(['touch', 'mouse'])(
    'a %s tap on the label acts once: the click the label would forward is swallowed',
    (pointerType) => {
      const { action, label } = setupLabel();
      const pointer = { ...at(50, 50), pointerType };

      fireEvent.pointerDown(label, pointer);
      fireEvent.pointerUp(label, pointer);
      fireEvent.mouseDown(label, { detail: 1 });
      fireEvent.mouseUp(label, { detail: 1 });
      fireEvent.click(label, { detail: 1 });
      expect(action).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['carrying a count', { detail: 1 }],
    ['with no count', { detail: 0 }],
  ])('a click on the label %s and no press before it acts once', (_, init) => {
    const { action, label } = setupLabel();
    fireEvent.click(label, init);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('click() on the label, as assistive tech makes it, acts once', () => {
    const { action, label } = setupLabel();
    act(() => label.click());
    expect(action).toHaveBeenCalledTimes(1);
  });

  it.each(['touch', 'mouse'])('a %s tap on the control acts once', (pointerType) => {
    const { action, control } = setupLabel();
    const pointer = { ...at(50, 50), pointerType };

    fireEvent.pointerDown(control, pointer);
    fireEvent.pointerUp(control, pointer);
    fireEvent.mouseDown(control, { detail: 1 });
    fireEvent.mouseUp(control, { detail: 1 });
    fireEvent.click(control, { detail: 1 });
    expect(action).toHaveBeenCalledTimes(1);
  });

  // A mouse drag released on the label still ends in a click on it, and that click
  // is not an activation. Ignoring it is not enough: left uncancelled, the label
  // forwards it to its control, which has no drag of its own to recognise it by.
  it('a mouse drag released on the label acts on nothing, and forwards nothing', () => {
    const { action, label } = setupLabel();
    const mouse = (x: number, y: number) => ({ ...at(x, y), pointerType: 'mouse' });

    fireEvent.pointerDown(label, mouse(50, 50));
    fireEvent.pointerMove(label, mouse(90, 50));
    fireEvent.pointerUp(label, mouse(90, 50));
    const click = createEvent.click(label, { detail: 1, cancelable: true });
    fireEvent(label, click);
    expect(click.defaultPrevented).toBe(true);
    expect(action).not.toHaveBeenCalled();
  });

  // Tapping the label twice is two openings, each its own gesture: the second
  // press clears the first one's mark, and the label's pointer events carry on.
  it('two separate taps on the label act twice', () => {
    const { action, label } = setupLabel();
    for (let tap = 0; tap < 2; tap += 1) {
      fireEvent.pointerDown(label, { ...at(50, 50), pointerType: 'touch' });
      fireEvent.pointerUp(label, { ...at(50, 50), pointerType: 'touch' });
      fireEvent.click(label, { detail: 1 });
    }
    expect(action).toHaveBeenCalledTimes(2);
  });
});

describe('pressKbdMove', () => {
  const KEYS = [
    ['Enter', '{Enter}'],
    ['Space', ' '],
  ] as const;

  // A native <button> turns Enter and Space into a click of its own, which
  // pressMove's onClick answers. A keydown that also acted would be a second
  // activation, and one that preventDefaulted would cancel the button's click on
  // some engines and not others.
  it.each(KEYS)('%s on a <button> acts once, through the button’s own click', (key) => {
    const action = vi.fn();
    render(
      <button data-testid="k" {...pressKbdMove(action)}>
        k
      </button>,
    );
    const k = screen.getByTestId('k');

    const down = createEvent.keyDown(k, { key: key === 'Space' ? ' ' : key, cancelable: true });
    fireEvent(k, down);
    expect(down.defaultPrevented).toBe(false);
    expect(action).not.toHaveBeenCalled();
    fireEvent.click(k); // what the browser makes of that key on a <button>
    expect(action).toHaveBeenCalledTimes(1);
  });

  it.each(KEYS)('%s on a focused <button> acts once, end to end', async (_, keys) => {
    const action = vi.fn();
    render(
      <button data-testid="k" {...pressKbdMove(action)}>
        k
      </button>,
    );
    screen.getByTestId('k').focus();
    await userEvent.setup().keyboard(keys);
    expect(action).toHaveBeenCalledTimes(1);
  });

  // An element that is not a <button> gets no click from a key, so its keydown is
  // the activation, and Space must not also scroll the page.
  it.each(KEYS)('%s on a role="button" element acts once, on keydown', async (key, keys) => {
    const action = vi.fn();
    render(
      <div role="button" tabIndex={0} data-testid="k" {...pressKbdMove(action)}>
        k
      </div>,
    );
    const k = screen.getByTestId('k');
    const down = createEvent.keyDown(k, { key: key === 'Space' ? ' ' : key, cancelable: true });
    fireEvent(k, down);
    expect(down.defaultPrevented).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);

    k.focus();
    await userEvent.setup().keyboard(keys);
    expect(action).toHaveBeenCalledTimes(2);
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

// Enter and Space reach a <button> as a click of its own. Whichever helper binds
// it, one key press is one activation, however the helper treats a pointer.
describe.each([
  ['pressClick', pressClick],
  ['pressMove', pressMove],
] as const)('%s on a focused <button>', (_, bind) => {
  it.each([
    ['Enter', '{Enter}'],
    ['Space', ' '],
  ])('%s acts once', async (_key, keys) => {
    const action = vi.fn();
    render(
      <button data-testid="k" {...bind(action)}>
        k
      </button>,
    );
    screen.getByTestId('k').focus();
    await userEvent.setup().keyboard(keys);
    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe('pressClick', () => {
  it('acts on pointerdown, preventDefaulted, and not again on that press’s click', () => {
    const action = vi.fn();
    render(<Btn id="b" action={action} />);
    const b = screen.getByTestId('b');
    const down = createEvent.pointerDown(b, { ...at(1, 1), cancelable: true });
    fireEvent(b, down);
    expect(action).toHaveBeenCalledTimes(1);
    expect(down.defaultPrevented).toBe(true); // #mobile-kbd keeps focus
    fireEvent.pointerUp(b, at(1, 1));
    fireEvent.click(b, { detail: 1 });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('acts on a click with no press before it (keyboard, assistive tech)', () => {
    const action = vi.fn();
    render(<Btn id="b" action={action} />);
    fireEvent.click(screen.getByTestId('b'));
    fireEvent.click(screen.getByTestId('b'));
    expect(action).toHaveBeenCalledTimes(2);
  });

  // A click with no count (a key, assistive tech) that lands on another control is
  // that control's own activation, never this press's tail.
  it('a press on one control does not swallow a click on another', () => {
    const a = vi.fn();
    const b = vi.fn();
    render(
      <>
        <Btn id="a" action={a} />
        <Btn id="b" action={b} />
      </>,
    );
    fireEvent.pointerDown(screen.getByTestId('a'), at(1, 1));
    fireEvent.pointerUp(screen.getByTestId('a'), at(1, 1));
    fireEvent.click(screen.getByTestId('b'));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('a press whose click never came expires, and a key clears it at once', () => {
    vi.useFakeTimers();
    try {
      const action = vi.fn();
      render(<Btn id="b" action={action} />);
      const b = screen.getByTestId('b');

      fireEvent.pointerDown(b, at(1, 1));
      fireEvent.pointerUp(b, at(1, 1));
      vi.advanceTimersByTime(1_500);
      fireEvent.click(b);
      expect(action).toHaveBeenCalledTimes(2);

      fireEvent.pointerDown(b, at(1, 1));
      fireEvent.pointerUp(b, at(1, 1));
      fireEvent.keyDown(b, { key: 'Enter' });
      fireEvent.click(b); // the click Enter produces on a native button
      expect(action).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  // The action runs on pointerdown and here redraws the spot under the finger:
  // pressing A puts B where A was. The browser hit-tests the press's click only
  // after the release, so the click lands on B, but it is still A's tail. In the
  // drawer, the ⚙ opened Settings, its click hit the back header that took the ⚙'s
  // place, and Settings shut again in the same tap.
  describe('when the action puts another control under the finger', () => {
    const touch = { ...at(1, 1), pointerType: 'touch' };

    /** Presses A and returns both spies and B, which now sits under the finger. */
    const pressA = (plain = false) => {
      const a = vi.fn();
      const b = vi.fn();
      render(<Swap a={a} b={b} plain={plain} />);
      fireEvent.pointerDown(screen.getByTestId('a'), touch);
      expect(a).toHaveBeenCalledTimes(1);
      return { a, b, next: screen.getByTestId('b') };
    };

    it('does not hand the press’s click to the control that took its place', () => {
      const { a, b, next } = pressA();
      fireEvent.pointerUp(next, touch);
      fireEvent.click(next, { detail: 1 });
      expect(b).not.toHaveBeenCalled();
      expect(a).toHaveBeenCalledTimes(1);
    });

    it('swallows that click on a control that is not pressClick too', () => {
      const { b, next } = pressA(true);
      fireEvent.pointerUp(next, touch);
      fireEvent.click(next, { detail: 1 });
      expect(b).not.toHaveBeenCalled();
    });

    it('a held press still loses its click: the window runs from the release', () => {
      vi.useFakeTimers();
      try {
        const { b, next } = pressA();
        vi.advanceTimersByTime(5_000);
        fireEvent.pointerUp(next, touch); // released on B, not on A
        fireEvent.click(next, { detail: 1 });
        expect(b).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a new tap on the newcomer is a press of its own, and acts once', () => {
      const { b, next } = pressA();
      fireEvent.pointerUp(next, touch);
      fireEvent.click(next, { detail: 1 });
      fireEvent.pointerDown(next, touch);
      expect(b).toHaveBeenCalledTimes(1);
      fireEvent.pointerUp(next, touch);
      fireEvent.click(next, { detail: 1 });
      expect(b).toHaveBeenCalledTimes(1);
    });

    // detail 1 on these clicks, so that the key, the cancel or the expiry is what
    // lets them through, not the missing count.
    it('a key right after clears the mark, so the newcomer acts', () => {
      const { b, next } = pressA();
      fireEvent.pointerUp(next, touch);
      fireEvent.keyDown(next, { key: 'Enter' });
      fireEvent.click(next, { detail: 1 });
      expect(b).toHaveBeenCalledTimes(1);
    });

    it('a cancelled pointer clears the mark: no click follows a cancel', () => {
      const { b, next } = pressA();
      fireEvent.pointerCancel(next, touch);
      fireEvent.click(next, { detail: 1 });
      expect(b).toHaveBeenCalledTimes(1);
    });

    it('a mark whose click never came expires', () => {
      vi.useFakeTimers();
      try {
        const { b, next } = pressA();
        fireEvent.pointerUp(next, touch);
        vi.advanceTimersByTime(1_500);
        fireEvent.click(next, { detail: 1 });
        expect(b).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // Upload and download call `click()` on a file input or a link from inside the
  // press. That click has no count, so it is not the press's tail: it must get
  // through, and the press's own click must still be swallowed after it.
  it('lets a click() the action makes through, and still swallows the press’s own click', () => {
    const picked = vi.fn();
    const action = vi.fn(() => screen.getByTestId('picker').click());
    render(
      <>
        <button data-testid="picker" onClick={picked}>
          picker
        </button>
        <Btn id="b" action={action} />
      </>,
    );
    const b = screen.getByTestId('b');
    fireEvent.pointerDown(b, at(1, 1));
    expect(picked).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(b, at(1, 1));
    fireEvent.click(b, { detail: 1 });
    expect(action).toHaveBeenCalledTimes(1);
  });
});

// ── The tail mark, on every helper that acts on a pointer ─────────────────────
//
// `pressClick` was the first to mark its gesture, but the scrim's `press` and a
// `pressMove` activation redraw the spot under the finger just as often: the
// scrim closes the drawer over a terminal whose mouse reporting turns a stray
// mousedown into a click report to tmux, and a chooser row swaps the whole view.
// So each of them marks its gesture, and the mark takes the gesture's
// compatibility mousedown and mouseup as well as its click: on a touch, Chrome
// delivers the mousedown AFTER pointerup, and a mousedown moves focus.

type Bind = (action: () => void) => ButtonHTMLAttributes<HTMLButtonElement>;

const HELPERS: [string, Bind, 'down' | 'up'][] = [
  ['press', (action) => ({ onPointerDown: press(action) }), 'down'],
  ['pressClick', pressClick, 'down'],
  ['pressMove', pressMove, 'up'],
];

const touch = { pointerId: 1, pointerType: 'touch' };

interface Newcomer {
  click: () => void;
  mouseDown: () => void;
  mouseUp: () => void;
}

/** A; once A acts, a plain button B in its place, recording what reaches it. */
const Replaces = ({ bind, action, b }: { bind: Bind; action: () => void; b: Newcomer }) => {
  const [acted, setActed] = useState(false);
  return acted ? (
    <button
      key="b"
      data-testid="b"
      onClick={b.click}
      onMouseDown={b.mouseDown}
      onMouseUp={b.mouseUp}
    >
      b
    </button>
  ) : (
    <button
      key="a"
      data-testid="a"
      {...bind(() => {
        action();
        setActed(true);
      })}
    >
      a
    </button>
  );
};

/**
 * The rest of a touch tap after its pointerdown, in Chrome's order and each event
 * hit-tested where the finger is now: the release, then the compatibility
 * mousedown (with the focus move it makes unless prevented), mouseup and click.
 */
const finishTap = (actsOn: 'down' | 'up', a: HTMLElement, pointer = touch): void => {
  fireEvent.pointerUp(actsOn === 'up' ? a : screen.getByTestId('b'), pointer);
  const b = screen.getByTestId('b');
  const down = createEvent.mouseDown(b, { detail: 1, cancelable: true });
  fireEvent(b, down);
  if (!down.defaultPrevented) b.focus();
  fireEvent.mouseUp(b, { detail: 1 });
  fireEvent.click(b, { detail: 1 });
};

const setupReplaces = (bind: Bind, action: () => void = vi.fn()) => {
  const b = { click: vi.fn(), mouseDown: vi.fn(), mouseUp: vi.fn() };
  render(<Replaces bind={bind} action={action} b={b} />);
  return { b, a: screen.getByTestId('a') };
};

describe.each(HELPERS)('%s marks its gesture', (_, bind, actsOn) => {
  const setup = (action?: () => void) => setupReplaces(bind, action);

  it('the tap’s mouse events and click do not reach what the action put there', () => {
    const action = vi.fn();
    const { b, a } = setup(action);
    fireEvent.pointerDown(a, touch);
    finishTap(actsOn, a);
    expect(action).toHaveBeenCalledTimes(1);
    expect(b.mouseDown).not.toHaveBeenCalled();
    expect(b.mouseUp).not.toHaveBeenCalled();
    expect(b.click).not.toHaveBeenCalled();
  });

  it('#mobile-kbd keeps focus through the whole tap, its compatibility mousedown included', () => {
    const kbd = focusKbd();
    const { a } = setup();
    fireEvent.pointerDown(a, touch);
    finishTap(actsOn, a);
    expect(document.activeElement).toBe(kbd);
  });

  it('a later, separate tap on the newcomer reaches it', () => {
    const { b, a } = setup();
    fireEvent.pointerDown(a, touch);
    finishTap(actsOn, a);
    const next = screen.getByTestId('b');
    fireEvent.pointerDown(next, touch);
    fireEvent.pointerUp(next, touch);
    fireEvent.mouseDown(next, { detail: 1 });
    fireEvent.mouseUp(next, { detail: 1 });
    fireEvent.click(next, { detail: 1 });
    expect(b.mouseDown).toHaveBeenCalledTimes(1);
    expect(b.mouseUp).toHaveBeenCalledTimes(1);
    expect(b.click).toHaveBeenCalledTimes(1);
  });

  // Upload and download call `click()` from inside the action.
  it('lets a click() the action makes through, and still swallows the tap’s own', () => {
    const picked = vi.fn();
    render(
      <button data-testid="picker" onClick={picked}>
        picker
      </button>,
    );
    const { b, a } = setup(() => screen.getByTestId('picker').click());
    fireEvent.pointerDown(a, touch);
    finishTap(actsOn, a);
    expect(picked).toHaveBeenCalledTimes(1);
    expect(b.click).not.toHaveBeenCalled();
  });

  // The swipe Close asks `window.confirm` from inside its action, which blocks for
  // as long as the user takes to answer. The click it held back arrives after.
  it('an action that blocks still loses its click: the window opens when it returns', () => {
    vi.useFakeTimers();
    try {
      const { b, a } = setup(() => vi.setSystemTime(Date.now() + 1_500));
      fireEvent.pointerDown(a, touch);
      finishTap(actsOn, a);
      expect(b.click).not.toHaveBeenCalled();

      const next = screen.getByTestId('b');
      fireEvent.pointerDown(next, touch);
      fireEvent.pointerUp(next, touch);
      fireEvent.click(next, { detail: 1 });
      expect(b.click).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a mark whose click never came expires', () => {
    vi.useFakeTimers();
    try {
      const { b, a } = setup();
      fireEvent.pointerDown(a, touch);
      fireEvent.pointerUp(actsOn === 'up' ? a : screen.getByTestId('b'), touch);
      vi.advanceTimersByTime(1_500);
      fireEvent.click(screen.getByTestId('b'), { detail: 1 });
      expect(b.click).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // The mouse events end with the window as the click does: they are the same
  // gesture's, and a mark that outlived its click would eat a later, real press.
  it('a mark whose click never came lets a later mousedown and mouseup through', () => {
    vi.useFakeTimers();
    try {
      const { b, a } = setup();
      fireEvent.pointerDown(a, touch);
      fireEvent.pointerUp(actsOn === 'up' ? a : screen.getByTestId('b'), touch);
      vi.advanceTimersByTime(1_500);
      const next = screen.getByTestId('b');
      fireEvent.mouseDown(next, { detail: 1 });
      fireEvent.mouseUp(next, { detail: 1 });
      expect(b.mouseDown).toHaveBeenCalledTimes(1);
      expect(b.mouseUp).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // The window runs from the release, not from the press: a finger held for longer
  // than CLICK_TAIL_MS still has its own mouse events and click swallowed.
  it('a long hold before the release still loses the tap’s mouse events and click', () => {
    vi.useFakeTimers();
    try {
      const { b, a } = setup();
      fireEvent.pointerDown(a, touch);
      vi.advanceTimersByTime(5_000);
      finishTap(actsOn, a);
      expect(b.mouseDown).not.toHaveBeenCalled();
      expect(b.mouseUp).not.toHaveBeenCalled();
      expect(b.click).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // The compatibility mousedown is what moves focus, and it is the mark's to
  // cancel, not just to hide from the handlers.
  it('cancels the tap’s compatibility mousedown, so its focus move never happens', () => {
    const { a } = setup();
    fireEvent.pointerDown(a, touch);
    fireEvent.pointerUp(actsOn === 'up' ? a : screen.getByTestId('b'), touch);
    const down = createEvent.mouseDown(screen.getByTestId('b'), { detail: 1, cancelable: true });
    fireEvent(screen.getByTestId('b'), down);
    expect(down.defaultPrevented).toBe(true);
  });

  // The same keyboard guarantee on a mouse, whose pointerdown a browser may or may
  // not follow with a mousedown.
  it('a mouse tap keeps #mobile-kbd focused through the whole sequence too', () => {
    const kbd = focusKbd();
    const { a } = setup();
    const mouse = { pointerId: 1, pointerType: 'mouse' };
    fireEvent.pointerDown(a, mouse);
    finishTap(actsOn, a, mouse);
    expect(document.activeElement).toBe(kbd);
  });

  // A press whose click never came (the finger slid off, the browser dropped it)
  // must not eat the next, separate tap, which starts with a pointerdown of its own.
  it('a gesture whose click never came does not swallow the next, separate tap', () => {
    const { b, a } = setup();
    fireEvent.pointerDown(a, touch);
    fireEvent.pointerUp(actsOn === 'up' ? a : screen.getByTestId('b'), touch);

    const next = screen.getByTestId('b');
    fireEvent.pointerDown(next, touch);
    fireEvent.pointerUp(next, touch);
    fireEvent.mouseDown(next, { detail: 1 });
    fireEvent.mouseUp(next, { detail: 1 });
    fireEvent.click(next, { detail: 1 });
    expect(b.mouseDown).toHaveBeenCalledTimes(1);
    expect(b.mouseUp).toHaveBeenCalledTimes(1);
    expect(b.click).toHaveBeenCalledTimes(1);
  });

  // A mouse event with no count did not come from a pointer (a synthetic one, or
  // assistive tech), so it is nobody's tail: it passes, and the tap's own events,
  // which carry a count, are still swallowed after it.
  it('mouse events with no count pass while the mark is live, the tap’s own do not', () => {
    const { b, a } = setup();
    fireEvent.pointerDown(a, touch);
    fireEvent.pointerUp(actsOn === 'up' ? a : screen.getByTestId('b'), touch);

    const next = screen.getByTestId('b');
    fireEvent.mouseDown(next, { detail: 0 });
    fireEvent.mouseUp(next, { detail: 0 });
    expect(b.mouseDown).toHaveBeenCalledTimes(1);
    expect(b.mouseUp).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(next, { detail: 1 });
    fireEvent.mouseUp(next, { detail: 1 });
    fireEvent.click(next, { detail: 1 });
    expect(b.mouseDown).toHaveBeenCalledTimes(1);
    expect(b.mouseUp).toHaveBeenCalledTimes(1);
    expect(b.click).not.toHaveBeenCalled();
  });

  // One gesture owns one click. A later click with a count and no press before it
  // is somebody else's, so the mark spends itself on the first one.
  it('swallows the tap’s one click and nothing after it', () => {
    const { b, a } = setup();
    fireEvent.pointerDown(a, touch);
    finishTap(actsOn, a);
    expect(b.click).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('b'), { detail: 1 });
    expect(b.click).toHaveBeenCalledTimes(1);
  });
});

// A mouse sends its mousedown straight after the pointerdown, before any release,
// and an action on pointerdown has already redrawn the spot by then. So a helper
// that acts on pointerdown has a mark that is live from the moment it is armed,
// not from the release.
describe.each(HELPERS.filter(([, , actsOn]) => actsOn === 'down'))(
  '%s, which acts on pointerdown',
  (_, bind) => {
    it('a mousedown before the release is the gesture’s too', () => {
      const kbd = focusKbd();
      const { b, a } = setupReplaces(bind);
      fireEvent.pointerDown(a, { pointerId: 1, pointerType: 'mouse' });

      const next = screen.getByTestId('b');
      const down = createEvent.mouseDown(next, { detail: 1, cancelable: true });
      fireEvent(next, down);
      if (!down.defaultPrevented) next.focus();
      expect(down.defaultPrevented).toBe(true);
      expect(b.mouseDown).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(kbd);
    });
  },
);

// The drawer's rows run their own pointer state machine and act from its
// handlers, so they arm the mark directly. Which event they arm it from decides
// when the window opens.
const Surface = ({ on, action }: { on: 'down' | 'up'; action: () => void }) => {
  const arm = (e: ReactPointerEvent) => consumeGesture(e, action);
  return on === 'down' ? (
    <div data-testid="s" onPointerDown={arm} />
  ) : (
    <div data-testid="s" onPointerUp={arm} />
  );
};

describe('consumeGesture', () => {
  it('runs the action once, armed first, so what the action redraws is covered', () => {
    const action = vi.fn();
    const after = vi.fn();
    render(
      <div onClick={after}>
        <Surface on="up" action={action} />
      </div>,
    );
    const s = screen.getByTestId('s');
    fireEvent.pointerDown(s, touch);
    fireEvent.pointerUp(s, touch);
    expect(action).toHaveBeenCalledTimes(1);
    fireEvent.click(s, { detail: 1 });
    expect(after).not.toHaveBeenCalled();
  });

  // A pointerup IS the release, so the window cannot wait for another one.
  it('armed from a pointerup, its window opens as the action returns', () => {
    vi.useFakeTimers();
    try {
      const after = vi.fn();
      render(
        <div onClick={after}>
          <Surface on="up" action={vi.fn()} />
        </div>,
      );
      const s = screen.getByTestId('s');
      fireEvent.pointerDown(s, touch);
      fireEvent.pointerUp(s, touch);
      vi.advanceTimersByTime(1_500);
      fireEvent.click(s, { detail: 1 });
      expect(after).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('armed from a pointerdown, it waits for the release however long the hold', () => {
    vi.useFakeTimers();
    try {
      const after = vi.fn();
      render(
        <div onClick={after}>
          <Surface on="down" action={vi.fn()} />
        </div>,
      );
      const s = screen.getByTestId('s');
      fireEvent.pointerDown(s, touch);
      vi.advanceTimersByTime(5_000);
      fireEvent.pointerUp(s, touch);
      fireEvent.click(s, { detail: 1 });
      expect(after).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // An action that throws still ran armed, so the window must still close. A mark
  // left "acting" for good would swallow the first click of an unrelated tap.
  it('an action that throws does not leave the mark armed for good', () => {
    vi.useFakeTimers();
    try {
      const after = vi.fn();
      render(<button data-testid="x" onClick={after} />);
      expect(() => consumeGesture({ pointerId: 1, type: 'pointerup' }, boom)).toThrow('boom');

      vi.advanceTimersByTime(1_500);
      fireEvent.click(screen.getByTestId('x'), { detail: 1 });
      expect(after).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an action that throws was still armed first: its click is swallowed', () => {
    const after = vi.fn();
    render(<button data-testid="x" onClick={after} />);
    expect(() => consumeGesture({ pointerId: 1, type: 'pointerup' }, boom)).toThrow('boom');
    fireEvent.click(screen.getByTestId('x'), { detail: 1 });
    expect(after).not.toHaveBeenCalled();
  });
});
