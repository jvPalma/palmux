// Pointer/keyboard activation shared by the dashboard and the mobile drawer.
//
// `press` fires on POINTERDOWN and preventDefaults it. That is the drawer's
// original convention and it exists for one reason: preventing the default of
// the event that moves focus keeps the hidden `#mobile-kbd` textarea focused, so
// using a control does not dismiss the soft keyboard.
//
// It is also unusable on anything that SCROLLS, in two separate ways:
//
//   * the action runs the moment the finger lands, before the user has decided
//     whether this is a tap or the start of a swipe — touching a tmux row to
//     scroll the list opened that session and closed the drawer; and
//   * `preventDefault()` on a touch pointerdown cancels the browser's pan, so
//     the list could not have scrolled even if nothing had fired.
//
// `pressMove` is the version for a scrollable surface: it activates on pointer
// UP, and only if the finger stayed within SLOP_PX of where it landed. It does
// NOT preventDefault a touch pointerdown — that is what lets the browser pan —
// and restores `#mobile-kbd` focus itself on activation, so the soft keyboard
// survives a tap exactly as it did before. A mouse never pans, so there
// preventDefault stays and focus is preserved the original way.
//
// Use `press` for fixed chrome nothing can focus (the drawer's scrim) and
// `pressMove` for anything inside a list. `pressClick` is `press` for a fixed
// control that must ALSO work without a pointer — keyboard, assistive tech —
// which is every focusable fixed button (the drawer's back headers and footer).
// `pressMove` answers a click too, for the same users.
//
// Every helper here that acts on a pointer marks that GESTURE first
// (`consumeGesture`), so the gesture's own trailing mousedown, mouseup and click
// reach nothing. An action usually redraws the spot under the finger, and the
// browser delivers the rest of the tap to whatever is there by then.

import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';

/**
 * How long a gesture's own click may still arrive. The window opens at the LATER
 * of the release and the action's return, so neither a long hold nor an action
 * that blocks lets the click through.
 */
const CLICK_TAIL_MS = 1000;

/**
 * The pointer gesture a control already acted on, whose own trailing events are
 * still to come. It marks the GESTURE, not the control. The action usually
 * redraws the spot under the finger: Settings puts its back header exactly where
 * the ⚙ was, the back header puts the ⚙ back, a footer cell or the scrim closes
 * the drawer over the terminal, and a chooser row swaps the whole view. The
 * browser hit-tests the click only after the release, so the click lands on
 * whatever the action put there, and that control took it as a tap of its own.
 * Measured with emulated touch (Playwright's touchscreen and raw CDP touch
 * events): Settings opened and popped back shut in one tap, 4 times out of 4. So
 * the mark is checked on the document, in the capture phase, ahead of every
 * handler, and the click is swallowed wherever it lands.
 *
 * It takes the gesture's compatibility mousedown and mouseup as well. A touch can
 * deliver its mousedown AFTER pointerup, and a mousedown moves focus, so putting
 * `#mobile-kbd` back at pointerup was undone a moment later; and a terminal under
 * the finger turns that mousedown and mouseup into a click report to tmux.
 * preventDefault on the mousedown cancels its focus move. A pointerdown is never
 * touched, so the mark cannot stop a list from panning.
 *
 * `released` and `acting` hold the window shut: the mark is armed BEFORE the
 * action runs, so whatever the action redraws is covered, and it stays live until
 * the pointer has been released AND the action has returned. A pointerdown action
 * returns long before a held finger lifts; a pointerup action can block on
 * `window.confirm` for as long as the user takes to answer, and the click it held
 * back is dispatched after.
 */
interface Mark {
  pointerId: number;
  released: boolean;
  acting: boolean;
  /** When the later of the release and the action's return happened. */
  at: number;
}

let consumed: Mark | null = null;

const live = (mark: Mark): boolean =>
  !mark.released || mark.acting || Date.now() - mark.at < CLICK_TAIL_MS;

const onTailPointerUp = (e: PointerEvent): void => {
  if (consumed?.pointerId !== e.pointerId) return;
  consumed.released = true;
  if (!consumed.acting) consumed.at = Date.now();
};

// A mouse event with no count did not come from a pointer. A click like that
// comes from Enter, Space, assistive tech or `element.click()`, and the upload
// and download actions call `click()` on a file input or a link inside this very
// gesture. So it is never this gesture's tail: it passes, and the mark stays
// armed for the events that are.

const onTailMouse = (e: MouseEvent): void => {
  if (e.detail === 0 || !consumed || !live(consumed)) return;
  if (e.type === 'mousedown') e.preventDefault();
  e.stopPropagation();
};

const onTailClick = (e: MouseEvent): void => {
  if (e.detail === 0) return;
  const tail = consumed;
  forgetGesture();
  if (!tail || !live(tail)) return;
  e.preventDefault();
  e.stopPropagation();
};

/**
 * A press whose click never comes (the finger slid off, or the browser dropped
 * the click) must not swallow some later, unrelated activation. So the mark
 * expires after CLICK_TAIL_MS, and these events clear it at once: a new
 * pointerdown anywhere, because the next click is that press's; a pointercancel,
 * because no click follows one; and a keydown, because a key's click is never a
 * pointer's tail.
 */
function forgetGesture(): void {
  consumed = null;
  document.removeEventListener('pointerup', onTailPointerUp, true);
  document.removeEventListener('mousedown', onTailMouse, true);
  document.removeEventListener('mouseup', onTailMouse, true);
  document.removeEventListener('click', onTailClick, true);
  document.removeEventListener('pointerdown', forgetGesture, true);
  document.removeEventListener('pointercancel', forgetGesture, true);
  document.removeEventListener('keydown', forgetGesture, true);
}

/** What `consumeGesture` reads off a pointer event; React's and the DOM's both fit. */
interface GestureEvent {
  readonly pointerId: number;
  readonly type: string;
}

/**
 * Mark the gesture `e` belongs to, then run `action`, so the gesture's own
 * trailing mousedown, mouseup and click reach nothing, wherever they land.
 *
 * Call it from the pointerdown or pointerup handler that ACTS, in place of
 * calling the action, and only on the path that acts: a scroll, a cancel or a
 * drag acted on nothing, so it must swallow nothing either. `e.type` tells it
 * whether the release has already happened. Every helper below goes through it,
 * and so does anything that runs its own pointer state machine (the drawer's
 * rows: a tap, or a hold released in place that opens the row menu).
 */
export function consumeGesture(e: GestureEvent, action: () => void): void {
  forgetGesture();
  const mark: Mark = {
    pointerId: e.pointerId,
    released: e.type === 'pointerup',
    acting: true,
    at: 0,
  };
  consumed = mark;
  // Capture listeners added while this event is dispatched do not run for it,
  // so the press that arms the mark cannot clear it.
  document.addEventListener('pointerup', onTailPointerUp, true);
  document.addEventListener('mousedown', onTailMouse, true);
  document.addEventListener('mouseup', onTailMouse, true);
  document.addEventListener('click', onTailClick, true);
  document.addEventListener('pointerdown', forgetGesture, true);
  document.addEventListener('pointercancel', forgetGesture, true);
  document.addEventListener('keydown', forgetGesture, true);
  try {
    action();
  } finally {
    mark.acting = false;
    if (mark.released) mark.at = Date.now();
  }
}

export const press = (action: () => void) => (e: ReactPointerEvent) => {
  e.preventDefault();
  consumeGesture(e, action);
};

const onKeys = (action: () => void) => (e: ReactKeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    action();
  }
};

export const pressKbd = (action: () => void) => ({
  onPointerDown: press(action),
  onKeyDown: onKeys(action),
});

/** Finger travel that turns a tap into a scroll. Roughly a fingertip's wobble. */
const SLOP_PX = 10;

/**
 * The live gesture and the control it began on. Module-level and single: these
 * are one-finger surfaces, and a second pointer landing mid-scroll should not
 * arm a second activation.
 */
let gesture: {
  id: number;
  el: EventTarget;
  x: number;
  y: number;
  moved: boolean;
  hadKbd: boolean;
} | null = null;

/**
 * The control a press began on and was released on without acting, because it
 * travelled past the slop or left the control on the way. A mouse cannot pan, so
 * a drag like that still ends in a click on the control, and that click is the
 * one counted click reaching `pressMove`'s handler that is not an activation.
 */
let draggedOn: { el: EventTarget; at: number } | null = null;

/**
 * A moved release need not be followed by a click at all (a touch that wobbled
 * past the slop without the browser cancelling it), and then nothing consumes
 * the exception. So it ends on the signals that end a press's mark: a keydown,
 * whose click is never a drag's, and a pointerdown anywhere, whose click is that
 * press's. Otherwise an Enter on the control a second later was ignored.
 */
function forgetDrag(): void {
  draggedOn = null;
  document.removeEventListener('pointerdown', forgetDrag, true);
  document.removeEventListener('keydown', forgetDrag, true);
}

function rememberDrag(el: EventTarget): void {
  draggedOn = { el, at: Date.now() };
  document.addEventListener('pointerdown', forgetDrag, true);
  document.addEventListener('keydown', forgetDrag, true);
}

const KBD_ID = 'mobile-kbd';

const kbdFocused = (): boolean =>
  typeof document !== 'undefined' && document.activeElement?.id === KBD_ID;

/** Tap-to-activate that survives being inside a scroller. */
export const pressMove = (action: () => void) => ({
  onPointerDown: (e: ReactPointerEvent) => {
    // A mouse cannot pan, so keep the original focus-preserving preventDefault
    // there; a touch must be left alone or the surface stops scrolling.
    if (e.pointerType !== 'touch') e.preventDefault();
    forgetDrag();
    gesture = {
      id: e.pointerId,
      el: e.currentTarget,
      x: e.clientX,
      y: e.clientY,
      moved: false,
      hadKbd: kbdFocused(),
    };
  },
  onPointerMove: (e: ReactPointerEvent) => {
    if (!gesture || gesture.id !== e.pointerId || gesture.moved) return;
    if (Math.abs(e.clientX - gesture.x) > SLOP_PX || Math.abs(e.clientY - gesture.y) > SLOP_PX) {
      gesture.moved = true;
    }
  },
  onPointerUp: (e: ReactPointerEvent) => {
    const g = gesture;
    gesture = null;
    // A press that began on another control is not this one's, whatever it is
    // released on: a mouse's click then lands on an ancestor of both.
    if (!g || g.id !== e.pointerId || g.el !== e.currentTarget) return;
    if (g.moved) {
      // That was a scroll, or a drag that ends in a click on this very control.
      rememberDrag(e.currentTarget);
      return;
    }
    e.preventDefault();
    // The touch path let focus move to this control; put it back BEFORE acting,
    // so an action that focuses something itself still wins.
    if (g.hadKbd && !kbdFocused()) document.getElementById(KBD_ID)?.focus();
    consumeGesture(e, action);
  },
  // Every click that gets here is an activation but one: a pointer press's own
  // click never does, because the press marked its gesture. What is left is
  // Enter, Space, assistive tech, `element.click()`, the click a <label>
  // forwards, and the click that ends a press this control refused. A count does
  // not make a click a pointer's (a label forwards one with its count), so it
  // never rejects a click on its own. It only exempts one: a click with no count
  // never came from a pointer, so it cannot be the refused press's, however
  // soon after that press it arrives.
  onClick: (e: ReactMouseEvent) => {
    if (e.detail !== 0) {
      const drag = draggedOn;
      forgetDrag();
      if (drag?.el === e.currentTarget && Date.now() - drag.at < CLICK_TAIL_MS) {
        // Cancelled as well as ignored: a <label> forwards an uncancelled click
        // to its control, which has no refused press to recognise it by.
        e.preventDefault();
        return;
      }
    }
    // This handler IS the activation. The element's own default would be a
    // second one: a <label> that uses pressMove forwards its click to its control.
    e.preventDefault();
    action();
  },
  onPointerCancel: () => {
    gesture = null;
  },
  // Leaving ends the tap but not the gesture: a mouse can come back and be
  // released on the control, and the click that follows lands on it. Forgetting
  // the press here let that click through as an activation.
  onPointerLeave: (e: ReactPointerEvent) => {
    if (gesture?.id === e.pointerId && gesture.el === e.currentTarget) gesture.moved = true;
  },
});

/**
 * `press` for a native <button> that keyboard and assistive tech must reach too.
 * The pointer still acts on pointerdown with preventDefault, so `#mobile-kbd`
 * keeps focus. Enter, Space and an AT or `element.click()` activation reach a
 * <button> only as a `click`, so `click` acts too. A real pointer press is down →
 * up → click, and that trailing click must not act a second time. The pointerdown
 * therefore marks its gesture (`consumeGesture`), and the gesture's own click
 * never reaches this handler, or any other.
 */
export const pressClick = (action: () => void) => ({
  onPointerDown: (e: ReactPointerEvent) => {
    e.preventDefault();
    consumeGesture(e, action);
  },
  onClick: () => {
    action();
  },
});

/**
 * `pressMove` plus Enter/Space for an element that is not a <button> (a mouse
 * never fires onKeyDown). A <button> turns Enter and Space into a click of its
 * own, which `pressMove` already answers: acting on the keydown too would be a
 * second activation, and whether preventDefault on that keydown cancels the
 * button's click differs by engine, so a <button> is left to its click.
 */
export const pressKbdMove = (action: () => void) => {
  const keys = onKeys(action);
  return {
    ...pressMove(action),
    onKeyDown: (e: ReactKeyboardEvent) => {
      if (!(e.currentTarget instanceof HTMLButtonElement)) keys(e);
    },
  };
};
