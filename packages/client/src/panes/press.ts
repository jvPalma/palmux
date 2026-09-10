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
// Use `press` for a control in fixed chrome (the footer, the scrim) and
// `pressMove` for anything inside a list.

import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

export const press = (action: () => void) => (e: ReactPointerEvent) => {
  e.preventDefault();
  action();
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
 * The live gesture. Module-level and single: these are one-finger surfaces, and
 * a second pointer landing mid-scroll should not arm a second activation.
 */
let gesture: { id: number; x: number; y: number; moved: boolean; hadKbd: boolean } | null = null;

const KBD_ID = 'mobile-kbd';

const kbdFocused = (): boolean =>
  typeof document !== 'undefined' && document.activeElement?.id === KBD_ID;

/** Tap-to-activate that survives being inside a scroller. */
export const pressMove = (action: () => void) => ({
  onPointerDown: (e: ReactPointerEvent) => {
    // A mouse cannot pan, so keep the original focus-preserving preventDefault
    // there; a touch must be left alone or the surface stops scrolling.
    if (e.pointerType !== 'touch') e.preventDefault();
    gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, hadKbd: kbdFocused() };
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
    if (!g || g.id !== e.pointerId || g.moved) return; // that was a scroll
    e.preventDefault(); // suppress the compatibility click
    // The touch path let focus move to this control; put it back BEFORE acting,
    // so an action that focuses something itself still wins.
    if (g.hadKbd && !kbdFocused()) document.getElementById(KBD_ID)?.focus();
    action();
  },
  onPointerCancel: () => {
    gesture = null;
  },
  onPointerLeave: () => {
    gesture = null;
  },
});

/** `pressMove` plus desktop Enter/Space (a mouse never fires onKeyDown). */
export const pressKbdMove = (action: () => void) => ({
  ...pressMove(action),
  onKeyDown: onKeys(action),
});
