// ── The review bar ────────────────────────────────────────────────────────────
//
// What the extra-keys bar is for a terminal, this is for a review: it takes the
// bar's place on a phone while the ACTIVE TAB is a review. The file list (the
// drawer's Source Control view), previous file, next file, and Reviewed (Changes)
// or Unstage (Staged). There are no terminal keys on it, so nothing here can reach
// a shell. It keeps the one thing the extra-keys bar must never lose: the swipe
// that opens the drawer (right→left), plus a way back (left→right).
//
// ONE pointer machine, at release, for taps and swipes together. The buttons are
// not `press`/`pressClick`: those act on pointerdown, and a drawer swipe that began
// on ✓ would have staged the file before anyone could tell it was a swipe.
// Pointerdown only records. A release within SLOP_PX of where the finger landed
// acts on the button it landed on; travel past that is a swipe when it is
// horizontal and long enough (`onSwipe`, by gesture direction, like the extra-keys
// bar) and nothing otherwise; a `pointercancel` (the OS's own bottom-edge gesture)
// acts on nothing. The release that acts marks its gesture (`consumeGesture`),
// because Reviewed moves the view and the tap's trailing click would land on what
// it drew. A click with no count (Enter, Space, assistive tech, `element.click()`)
// is not a pointer's, and acts once.
//
// The pointerdown is prevented and the pointer captured on the bar, never on a
// button, for the extra-keys bar's reasons: a focusable capture target or a
// focus-moving mousedown dismisses the soft keyboard, and here it would also pull
// focus out of a comment being typed.

import {
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { ScmGroup } from '@palmux/shared';
import { consumeGesture } from '../panes/press';
import { Icon } from '../ui/icons';
import './review-bar.css';

// The extra-keys bar's two thresholds (`MOVE_CANCEL_PX`, `DRAWER_SWIPE_PX`), kept
// as copies so this file does not reach into that one. ReviewBar.test.tsx fails if
// they drift.
const SLOP_PX = 10;
const SWIPE_PX = 60;

type Button = 'files' | 'previous' | 'next' | 'review';

export interface ReviewBarProps {
  /** Changes offers Reviewed, Staged offers Unstage. */
  group: ScmGroup;
  /** Open the drawer on the Source Control view. */
  onFiles: () => void;
  onPreviousFile: () => void;
  onNextFile: () => void;
  /** Reviewed (Changes) or Unstage (Staged), for the file in view. */
  onReview: () => void;
  /** A horizontal swipe across the bar, by gesture direction ('right' = left→right). */
  onSwipe: (dir: 'left' | 'right') => void;
}

interface Gesture {
  pointerId: number;
  button: Button;
  startX: number;
  startY: number;
  /** Past the slop: no tap, whatever happens next. */
  moved: boolean;
  el: HTMLElement;
}

export const ReviewBar = ({
  group,
  onFiles,
  onPreviousFile,
  onNextFile,
  onReview,
  onSwipe,
}: ReviewBarProps) => {
  const bar = useRef<HTMLDivElement | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const staged = group === 'staged';

  const actions: Record<Button, () => void> = {
    files: onFiles,
    previous: onPreviousFile,
    next: onNextFile,
    review: onReview,
  };

  const end = (g: Gesture): void => {
    g.el.classList.remove('pressed');
    if (gesture.current === g) gesture.current = null;
  };

  const down = (e: ReactPointerEvent<HTMLButtonElement>, button: Button): void => {
    e.preventDefault(); // never take focus from #mobile-kbd or a comment being typed
    // One finger at a time. A second landing ends the first, which acts on nothing:
    // ignoring it instead would leave the bar dead after a release that never came.
    if (gesture.current) end(gesture.current);
    const g: Gesture = {
      pointerId: e.pointerId,
      button,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      el: e.currentTarget,
    };
    gesture.current = g;
    g.el.classList.add('pressed');
    try {
      bar.current?.setPointerCapture?.(e.pointerId);
    } catch {
      // No capture: move and up still bubble to the bar from the button.
    }
  };

  const move = (e: ReactPointerEvent): void => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId || g.moved) return;
    if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > SLOP_PX) {
      g.moved = true;
      g.el.classList.remove('pressed'); // a slide acts on nothing
    }
  };

  const up = (e: ReactPointerEvent): void => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    end(g);
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    // Judged on where the finger lifted too: a fast slide can end before a move
    // event says it left the slop.
    if (g.moved || Math.hypot(dx, dy) > SLOP_PX) {
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > SWIPE_PX)
        onSwipe(dx > 0 ? 'right' : 'left');
      return;
    }
    consumeGesture(e, actions[g.button]);
  };

  const cancel = (e: ReactPointerEvent): void => {
    const g = gesture.current;
    if (g && g.pointerId === e.pointerId) end(g);
  };

  /** Only a click no pointer made acts; a press's own click is its tail. */
  const click = (e: ReactMouseEvent, button: Button): void => {
    if (e.detail === 0) actions[button]();
  };

  const props = (button: Button) => ({
    type: 'button' as const,
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => down(e, button),
    onClick: (e: ReactMouseEvent) => click(e, button),
  });

  return (
    <div
      ref={bar}
      id="review-bar"
      className="review-bar"
      role="toolbar"
      aria-label="Review"
      data-testid="review-bar"
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
      // A held button would raise the browser's own menu, and its default handling
      // takes focus from the keyboard textarea.
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        className="rb-btn"
        aria-label="File list"
        data-testid="review-bar-files"
        {...props('files')}
      >
        <Icon name="menu" size={16} />
        Files
      </button>
      <button
        className="rb-btn"
        aria-label="Previous file"
        data-testid="review-bar-previous"
        {...props('previous')}
      >
        <Icon name="arrow-up" size={16} />
      </button>
      <button
        className="rb-btn"
        aria-label="Next file"
        data-testid="review-bar-next"
        {...props('next')}
      >
        <Icon name="arrow-down" size={16} />
      </button>
      <button
        className={`rb-btn ${staged ? 'rb-ghost' : 'rb-primary'}`}
        data-testid={staged ? 'review-bar-unstage' : 'review-bar-reviewed'}
        {...props('review')}
      >
        <Icon name={staged ? 'undo' : 'check'} size={16} />
        {staged ? 'Unstage' : 'Reviewed'}
      </button>
    </div>
  );
};
