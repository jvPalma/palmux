// ── Touch gestures ────────────────────────────────────────────────────────────
//
// One finger: tap → tmux click / raise keyboard, vertical drag → scroll
// (forwarded to the app as mouse-wheel under mouse reporting, else local
// scrollback), long-press + drag → text selection with native-style drag
// handles (the text is auto-copied by copy-on-select). Horizontal swipes are
// inert here — the session-drawer swipe lives on the extra-keys bar.
// Two fingers: pinch → font-size zoom.
//
// Ported from the original mobile.ts state machine, driving an xterm Terminal
// through the touch.ts coordinate/mouse/selection helpers.

import { useEffect, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import {
  cell0FromClient,
  drainScrollUnits,
  velocityGain,
  isMouseReporting,
  MAX_WHEEL_NOTCHES,
  scrollAsWheel,
  selectRange,
  tapAsMouse,
  WHEEL_CELLS_PER_NOTCH,
} from '../terminal/touch';
import { createSelectionHandles } from './selection-handles';
import { resolveTap, tapActionBytes } from './tap-resolver';
import { createNativeSelectionLayer } from './native-selection';
import { openLink } from '../terminal/useTerminal';

const TAP_MOVE_PX = 12;
const TAP_MAX_MS = 600;
const LONG_PRESS_MS = 450;

export interface MobileGesturesParams {
  host: HTMLElement | null;
  term: Terminal | null;
  active: boolean;
  sendInput: (text: string) => void;
  getFontSize: () => number;
  setFontSize: (px: number) => void;
  /** Raise the soft keyboard (tap when the app isn't capturing the mouse). */
  focusKeyboard: () => void;
  isBlocked: () => boolean;
  /** Link (OSC-8 or regex) at an absolute buffer cell — drives link taps. */
  linkAt?: (col: number, absRow: number) => string | null;
  /** Active OSC-133 output zone in absolute rows — drives menu-row taps. */
  outputZone?: () => { start: number; end: number } | null;
  /**
   * Hand text selection to the browser (its own handles + the OS Copy/Share
   * callout) instead of palmux's custom long-press + drag handles. The default
   * on mobile; the custom path stays available as the fallback.
   */
  nativeSelection?: boolean;
}

/** The soft keyboard is up iff App's hidden textarea holds focus. */
const keyboardUp = (): boolean =>
  typeof document !== 'undefined' && document.activeElement?.id === 'mobile-kbd';

export function useMobileGestures(params: MobileGesturesParams): void {
  const p = useRef(params);
  p.current = params;

  const { host, term, active } = params;

  useEffect(() => {
    if (!host || !term || !active) return;

    const nativeSelection = !!p.current.nativeSelection;

    const handles = createSelectionHandles(term, host);
    // With palmux's own selection, the browser's context menu has nothing useful
    // for a canvas terminal and fights the long-press gesture — suppress it.
    // With NATIVE selection it is the opposite: that callout ("Copy / Share…")
    // IS the feature, so the suppression must be lifted.
    const onContextMenu = (e: Event) => {
      if (!nativeSelection) e.preventDefault();
    };
    host.addEventListener('contextmenu', onContextMenu);

    let pinching = false;
    let pinchBaseDist = 0;
    let pinchBaseSize = 0;
    let tapStartX = 0;
    let tapStartY = 0;
    let tapStartT = 0;
    let tapMoved = false;
    let tapActive = false;
    let dragAxis: 'v' | 'h' | null = null;
    let lastTouchY = 0;
    let lastMoveT = 0;
    let selecting = false;
    let anchor = { col: 0, row: 0 };
    let longPressTimer = 0;
    let scrollAccum = 0;

    const dist = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const cancelLongPress = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = 0;
      }
    };

    const cellHeight = () => {
      const screen = host.querySelector('.xterm-screen') as HTMLElement | null;
      const h = (screen ?? host).getBoundingClientRect().height;
      return h / Math.max(1, term.rows) || 20;
    };

    // EXPERIMENTAL native selection: an invisible, selectable text layer over the
    // canvas so the BROWSER supplies the selection UI. While it is on, palmux's
    // own long-press selection stands down — two selection models fighting over
    // one gesture would be worse than either alone.
    const native = nativeSelection
      ? createNativeSelectionLayer(term, host, () => {
          const screen = host.querySelector('.xterm-screen') as HTMLElement | null;
          const rect = (screen ?? host).getBoundingClientRect();
          const hostRect = host.getBoundingClientRect();
          return {
            rows: term.rows,
            cols: term.cols,
            cellWidth: rect.width / Math.max(1, term.cols) || 9,
            cellHeight: cellHeight(),
            // Register on the GRID, not the host: xterm pads by 2px and the
            // mobile layer bottom-aligns .xterm-screen inside the wrap.
            left: rect.left - hostRect.left,
            top: rect.top - hostRect.top,
          };
        })
      : null;
    native?.setEnabled(true);
    // onRender alone is not enough: a resize that prints nothing (the soft
    // keyboard opening/closing) fires no render, and the layer would keep the
    // old grid's geometry over the new one. Track scroll and resize too.
    const nativeDisps = native
      ? [
          term.onRender(() => native.update()),
          term.onResize(() => native.update()),
          term.onScroll(() => native.update()),
        ]
      : [];

    // anchorX/Y is the GESTURE-START point, not the live finger position: the
    // pane under the initial touch receives every wheel frame of the gesture,
    // so a swipe crossing a tmux pane border can't start scrolling a neighbour.
    const scrollByPixels = (px: number, anchorX: number, anchorY: number) => {
      const cellH = cellHeight();
      scrollAccum += px;
      const buf = term.buffer.active;
      const atBottom = buf.viewportY === buf.baseY;
      if (isMouseReporting(term) && atBottom) {
        // Forward to the app (tmux scrolls its own pane) as wheel NOTCHES: one
        // per line of finger travel, capped per flush so a flick can't flood the
        // app's parser. What a notch scrolls is the app's call. finger-down =
        // history.
        const { units, rest } = drainScrollUnits(
          scrollAccum,
          cellH * WHEEL_CELLS_PER_NOTCH,
          MAX_WHEEL_NOTCHES,
        );
        scrollAccum = rest;
        if (units !== 0) p.current.sendInput(scrollAsWheel(term, host, units, anchorX, anchorY));
        return;
      }
      // Local scrollback tracks the finger 1:1 — one line per cell height.
      // finger-down (units > 0) reveals older lines (scroll up).
      const { units, rest } = drainScrollUnits(scrollAccum, cellH);
      scrollAccum = rest;
      if (units !== 0) term.scrollLines(-units);
    };

    // Context-aware tap. The caret/menu-row walks only engage once the keyboard
    // is ALREADY up: the first tap must keep doing what it has always done —
    // raise the keyboard — or the primary mobile gesture would regress.
    const handleTap = () => {
      const buf = term.buffer.active;
      const cell = cell0FromClient(term, host, tapStartX, tapStartY);
      const absRow = buf.viewportY + cell.row;
      const typing = keyboardUp();
      const action = resolveTap({
        mouseReporting: isMouseReporting(term),
        linkUrl: p.current.linkAt?.(cell.col, absRow) ?? null,
        tapped: { col: cell.col, row: absRow },
        cursor: { col: buf.cursorX, row: buf.baseY + buf.cursorY },
        outputZone: typing ? (p.current.outputZone?.() ?? null) : null,
        promptRow: typing ? buf.baseY + buf.cursorY : null,
      });

      if (action.kind === 'mouse') {
        const bytes = tapAsMouse(term, host, tapStartX, tapStartY);
        if (bytes) p.current.sendInput(bytes);
        else p.current.focusKeyboard();
        return;
      }
      if (action.kind === 'link') {
        openLink(action.url);
        return;
      }
      if (action.kind === 'keyboard') {
        p.current.focusKeyboard();
        return;
      }
      p.current.sendInput(tapActionBytes(action));
    };

    const onTouchStart = (e: TouchEvent) => {
      if (!p.current.active) return;
      if (e.touches.length === 2) {
        pinching = true;
        tapActive = false;
        cancelLongPress();
        if (selecting) {
          selecting = false;
          term.clearSelection();
        }
        pinchBaseDist = dist(e.touches[0]!, e.touches[1]!);
        pinchBaseSize = p.current.getFontSize();
        e.preventDefault();
      } else if (e.touches.length === 1) {
        // A lone touch can NEVER be a pinch. Clear the flag unconditionally so a
        // dropped final touchend (mobile browsers routinely swallow it when they
        // interrupt a gesture) can't leave `pinching` stuck true and silently
        // freeze every subsequent tap/scroll.
        pinching = false;
        if (handles.isHandle(e.target)) return; // handle drags manage themselves
        const t = e.touches[0]!;
        term.clearSelection();
        tapActive = true;
        tapMoved = false;
        dragAxis = null;
        selecting = false;
        scrollAccum = 0;
        tapStartX = t.clientX;
        tapStartY = t.clientY;
        lastTouchY = t.clientY;
        lastMoveT = e.timeStamp;
        tapStartT = e.timeStamp;
        cancelLongPress();
        longPressTimer = window.setTimeout(() => {
          longPressTimer = 0;
          if (native) return; // the browser owns long-press when native is on
          if (!tapActive || tapMoved || pinching) return;
          selecting = true;
          anchor = cell0FromClient(term, host, tapStartX, tapStartY);
          selectRange(term, anchor, anchor);
          navigator.vibrate?.(10);
        }, LONG_PRESS_MS) as unknown as number;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!p.current.active || handles.isHandle(e.target)) return;
      if (pinching && e.touches.length === 2) {
        e.preventDefault();
        if (pinchBaseDist > 0) {
          const scale = dist(e.touches[0]!, e.touches[1]!) / pinchBaseDist;
          p.current.setFontSize(Math.round(pinchBaseSize * scale));
        }
      } else if (e.touches.length === 1) {
        const t = e.touches[0]!;
        if (selecting) {
          e.preventDefault();
          selectRange(term, anchor, cell0FromClient(term, host, t.clientX, t.clientY));
          return;
        }
        if (!tapActive) return;
        // A live native selection means the browser is dragging a handle — our
        // scroll handling would preventDefault it out of existence.
        if (native?.selectedText()) return;
        if (!tapMoved && Math.hypot(t.clientX - tapStartX, t.clientY - tapStartY) > TAP_MOVE_PX) {
          tapMoved = true;
          // Lock the gesture to its dominant axis at the moment it becomes a drag.
          dragAxis = Math.abs(t.clientX - tapStartX) > Math.abs(t.clientY - tapStartY) ? 'h' : 'v';
          cancelLongPress();
        }
        if (tapMoved) {
          e.preventDefault();
          if (dragAxis === 'v') {
            // Fast swipes multiply finger travel (native-fling distance without
            // post-touch animation); slow drags keep the precise 1:1 mapping.
            const dy = t.clientY - lastTouchY;
            const dt = e.timeStamp - lastMoveT;
            scrollByPixels(dy * velocityGain(dt > 0 ? dy / dt : 0), tapStartX, tapStartY);
            lastTouchY = t.clientY;
            lastMoveT = e.timeStamp;
          }
        }
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!p.current.active || handles.isHandle(e.target)) return;
      cancelLongPress();
      // The platform long-press (~500ms) lands inside TAP_MAX_MS, so a release
      // right after the OS raised its selection would otherwise still count as a
      // tap: we would preventDefault the touchend (killing the fresh callout)
      // and forward a mouse click under tmux. Leave the gesture to the browser.
      if (native?.selectedText()) {
        tapActive = false;
        return;
      }
      if (pinching && e.touches.length < 2) pinching = false;
      if (selecting && e.touches.length === 0) {
        e.preventDefault();
        selecting = false;
        // Selection stays live; the drag handles (already positioned via
        // onSelectionChange) let the user adjust it. Copy already happened.
        return;
      }
      if (tapActive && e.touches.length === 0) {
        if (tapMoved && dragAxis === 'h') {
          // Horizontal swipes on the TERMINAL are intentionally inert — the
          // drawer-open/close swipe now lives on the extra-keys bar (onSwipe).
          // Still swallow it so the browser doesn't fire back/forward nav.
          tapActive = false;
          e.preventDefault();
          return;
        }
        const wasTap = !tapMoved && e.timeStamp - tapStartT < TAP_MAX_MS;
        tapActive = false;
        if (wasTap && !pinching) {
          // Suppress the synthetic mouse/click that would blur the keyboard textarea.
          e.preventDefault();
          if (p.current.isBlocked()) return;
          handleTap();
        }
      }
    };

    const onTouchCancel = () => {
      cancelLongPress();
      if (selecting) {
        selecting = false;
        term.clearSelection();
      }
      pinching = false;
      tapActive = false;
    };

    // Capture phase so our gesture handling runs before xterm's own touch
    // handling on its inner elements; preventDefault suppresses the rest.
    const optsCapture = { passive: false, capture: true } as const;
    host.addEventListener('touchstart', onTouchStart, optsCapture);
    host.addEventListener('touchmove', onTouchMove, optsCapture);
    host.addEventListener('touchend', onTouchEnd, optsCapture);
    host.addEventListener('touchcancel', onTouchCancel, optsCapture);
    return () => {
      cancelLongPress();
      nativeDisps.forEach((d) => d.dispose());
      native?.destroy();
      handles.destroy();
      host.removeEventListener('contextmenu', onContextMenu);
      host.removeEventListener('touchstart', onTouchStart, optsCapture);
      host.removeEventListener('touchmove', onTouchMove, optsCapture);
      host.removeEventListener('touchend', onTouchEnd, optsCapture);
      host.removeEventListener('touchcancel', onTouchCancel, optsCapture);
    };
    // nativeSelection is read once when the effect runs (it decides whether the
    // layer exists at all), so it MUST be a dependency — without it, toggling
    // the setting did nothing until the pane remounted.
  }, [host, term, active, params.nativeSelection]);
}
