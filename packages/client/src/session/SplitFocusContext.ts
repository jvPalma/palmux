// ── Split focus registry ──────────────────────────────────────────────────────
//
// Panes register their API here; App-owned shared surfaces (the soft keyboard,
// extra-keys bar, upload picker, and the Ctrl+Shift+C/V dispatcher) read the
// FOCUSED pane at call time. Ref-held (not React state) so the send closures
// stay stable and never force a re-bind. A slot is a pane's id (a leaf of the
// pane grid), and any number can be registered; none is focused until App says
// which. Only terminal panes register — a focused non-terminal slot yields a
// null focused API.

import type { Terminal } from '@xterm/xterm';

export type SlotId = string;

/** What a TerminalPane exposes to the shared input surfaces. */
export interface PaneApi {
  /** Raw bytes to this pane's PTY (false = socket not open, frame dropped). */
  sendInput(text: string): boolean;
  /** Paste text into this pane's PTY (bracketed-paste aware).
   *  False = data socket down, the text was DROPPED. */
  paste(text: string): boolean;
  /** Upload an image file and inject its path (the mobile clipboard/paste path). */
  pasteImage(file: File): void;
  /** Open this pane's any-file picker (upload targets THIS session). Returns
   *  whether a picker was launched; `onReturn` fires once when it comes back
   *  (a pick, a cancel, or the app regaining focus without either). */
  openPicker(onReturn?: () => void): boolean;
  /** Open this pane's image-only picker — on Android that is the gallery
   *  directly, with no "photo / video / file?" chooser in the way. Same launch
   *  result and return signal as `openPicker`. */
  openImagePicker(onReturn?: () => void): boolean;
  /** Move DOM keyboard focus into / out of this pane's terminal (desktop). */
  focus(): void;
  blur(): void;
  /** Re-fit the terminal, preserving any active selection (keyboard/divider resize). */
  refit(): void;
  /** Re-measure + re-rasterize after a late-loading web font becomes available. */
  refreshFont(): void;
  /** Re-read the canvas palette after the theme registry gains user themes. */
  refreshTheme(): void;
  /** Serialize this pane's buffer + scrollback to text (null if unavailable). */
  exportScrollback(): string | null;
  /** The last command's output via OSC-133 shell integration (null if none). */
  copyLastOutput(): string | null;
  /** Open this pane's in-terminal search bar. */
  openSearch(): void;
  /** The live xterm instance (null until open) — for the visualViewport helper. */
  term(): Terminal | null;
  /** The pane's wrap element — overlays anchored to THIS pane (not the window)
   *  read its rect (e.g. the dictation notification in split mode). */
  container(): HTMLElement | null;
}

export interface SplitRegistry {
  /** Register a pane for a slot; returns an unregister fn. */
  register(slot: SlotId, api: PaneApi): () => void;
  /** The focused slot, or null until App sets one. */
  focusedSlot(): SlotId | null;
  setFocusedSlot(slot: SlotId): void;
  /** The focused pane's api, or null when the focused slot has no terminal pane. */
  focusedApi(): PaneApi | null;
  apiFor(slot: SlotId): PaneApi | null;
  /** Visit every registered pane (a font or theme refresh reaches all of them, not just one). */
  forEachApi(fn: (api: PaneApi, slot: SlotId) => void): void;
}

export function createSplitRegistry(): SplitRegistry {
  const panes = new Map<SlotId, PaneApi>();
  let focused: SlotId | null = null;
  return {
    register(slot, api) {
      panes.set(slot, api);
      return () => {
        if (panes.get(slot) === api) panes.delete(slot);
      };
    },
    focusedSlot: () => focused,
    setFocusedSlot: (slot) => {
      focused = slot;
    },
    focusedApi: () => (focused === null ? null : (panes.get(focused) ?? null)),
    apiFor: (slot) => panes.get(slot) ?? null,
    forEachApi: (fn) => {
      // A copy, so a visitor that registers or unregisters a pane cannot disturb the walk.
      for (const [slot, api] of Array.from(panes)) fn(api, slot);
    },
  };
}
