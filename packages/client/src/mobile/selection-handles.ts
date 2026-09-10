// ── Native-style selection drag handles (mobile) ──────────────────────────────
//
// The browser's own selection UI (teardrop handles + toolbar) never appears for
// xterm's canvas-drawn selection, so we recreate the essential part: a handle
// under each end of the selection that can be dragged to adjust it. Copying is
// already automatic (copy-on-select in useTerminal), so no toolbar is needed.
//
// The handles live inside .term-host as plain DOM (xterm renders into its own
// child; siblings are fine). Touch events TARGET the element where the touch
// started, so a drag that started on a handle keeps targeting it — the gesture
// state machine ignores those via isHandle().

import type { Terminal } from '@xterm/xterm';
import { cell0FromClient, getSelectionEndpoints, selectRange } from '../terminal/touch';

export interface SelectionHandles {
  /** Reposition (or hide) the handles to match the current selection. */
  update: () => void;
  /** True when the event target is one of the handles (gesture code must ignore it). */
  isHandle: (target: EventTarget | null) => boolean;
  destroy: () => void;
}

export function createSelectionHandles(term: Terminal, host: HTMLElement): SelectionHandles {
  const make = (edge: 'start' | 'end'): HTMLDivElement => {
    const el = document.createElement('div');
    el.className = 'sel-handle';
    el.dataset['selHandle'] = edge;
    el.style.display = 'none';
    host.appendChild(el);
    return el;
  };
  const startEl = make('start');
  const endEl = make('end');
  let dragging: 'start' | 'end' | null = null;

  const update = () => {
    const sel = getSelectionEndpoints();
    const screen = host.querySelector('.xterm-screen') as HTMLElement | null;
    if (!sel || !screen || !term.getSelection()) {
      startEl.style.display = 'none';
      endEl.style.display = 'none';
      return;
    }
    const hostRect = host.getBoundingClientRect();
    const rect = screen.getBoundingClientRect();
    const cellW = rect.width / Math.max(1, term.cols);
    const cellH = rect.height / Math.max(1, term.rows);
    const vy = term.buffer.active.viewportY;
    // sel endpoints are absolute-buffer inclusive cells; place() takes a
    // grid-edge column (0..cols) and an absolute buffer row.
    const place = (el: HTMLElement, edgeCol: number, bufferRow: number) => {
      const row = bufferRow - vy;
      if (row < 0 || row >= term.rows) {
        el.style.display = 'none';
        return;
      }
      el.style.left = `${rect.left - hostRect.left + edgeCol * cellW}px`;
      el.style.top = `${rect.top - hostRect.top + (row + 1) * cellH}px`;
      el.style.display = 'block';
    };
    place(startEl, sel.start.col, sel.start.row); // left edge of the first cell
    place(endEl, sel.end.col + 1, sel.end.row); // right edge of the last cell
  };

  // The non-dragged edge, captured ONCE when a drag starts (as a 0-based
  // viewport cell). Re-reading getSelectionPosition() every move breaks down the
  // moment the endpoints cross: xterm reorders start/end, the "fixed" edge
  // silently becomes the moving one, and the selection runs away.
  let fixedAnchor: { col: number; row: number } | null = null;
  // The (edge cell − finger cell) offset captured at grab time. The teardrop
  // hangs a row BELOW the cell it marks, so a raw finger→cell read lands one row
  // low; cancelling that delta means grabbing a handle never shifts the
  // selection and any drag tracks the finger 1:1 from wherever it was grabbed.
  let grabOffset: { col: number; row: number } | null = null;

  const clampCell = (col: number, row: number) => ({
    col: Math.max(0, Math.min(term.cols - 1, col)),
    row: Math.max(0, Math.min(term.rows - 1, row)),
  });

  const bind = (edge: 'start' | 'end', el: HTMLDivElement) => {
    const opts = { passive: false } as const;
    const onStart = (e: TouchEvent) => {
      const sel = getSelectionEndpoints();
      const t = e.touches[0];
      if (!sel || !t) return;
      // Use the EXACT inclusive endpoints the selection was built from (absolute
      // buffer coords → viewport cells), never getSelectionPosition() whose
      // exclusive `end` would shift the anchor a row and make the grab jump.
      const vy = term.buffer.active.viewportY;
      const startCell = clampCell(sel.start.col, sel.start.row - vy);
      const endCell = clampCell(sel.end.col, sel.end.row - vy);
      const edgeCell = edge === 'start' ? startCell : endCell;
      fixedAnchor = edge === 'start' ? endCell : startCell;
      const finger = cell0FromClient(term, host, t.clientX, t.clientY);
      grabOffset = { col: edgeCell.col - finger.col, row: edgeCell.row - finger.row };
      dragging = edge;
      e.preventDefault();
      e.stopPropagation();
    };
    const onMove = (e: TouchEvent) => {
      if (dragging !== edge || !fixedAnchor || !grabOffset) return;
      e.preventDefault();
      e.stopPropagation();
      const t = e.touches[0];
      if (!t) return;
      const finger = cell0FromClient(term, host, t.clientX, t.clientY);
      const moving = clampCell(finger.col + grabOffset.col, finger.row + grabOffset.row);
      selectRange(term, fixedAnchor, moving); // selectRange orders the endpoints itself
      update();
    };
    const onEnd = (e: TouchEvent) => {
      if (dragging !== edge) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = null;
      fixedAnchor = null;
      grabOffset = null;
    };
    el.addEventListener('touchstart', onStart, opts);
    el.addEventListener('touchmove', onMove, opts);
    el.addEventListener('touchend', onEnd, opts);
    el.addEventListener('touchcancel', onEnd, opts);
  };
  bind('start', startEl);
  bind('end', endEl);

  // Track everything that moves the selection or the viewport under it.
  const selDisp = term.onSelectionChange(update);
  const scrollDisp = term.onScroll(update);
  const resizeDisp = term.onResize(update);

  return {
    update,
    isHandle: (target) =>
      target instanceof HTMLElement && target.dataset['selHandle'] !== undefined,
    destroy: () => {
      selDisp.dispose();
      scrollDisp.dispose();
      resizeDisp.dispose();
      startEl.remove();
      endEl.remove();
    },
  };
}
