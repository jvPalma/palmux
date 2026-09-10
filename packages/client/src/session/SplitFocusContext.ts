// ── Split focus registry ──────────────────────────────────────────────────────
//
// Panes register their API here; App-owned shared surfaces (the soft keyboard,
// extra-keys bar, upload picker, and the Ctrl+Shift+C/V dispatcher) read the
// FOCUSED pane at call time. Ref-held (not React state) so the send closures
// stay stable and never force a re-bind. In single-slot mode there is one slot
// ('a'), always focused; split (stage 2) adds slot 'b'. Only terminal panes
// register — a focused non-terminal slot yields a null focused API.

import type { Terminal } from '@xterm/xterm';

export type SlotId = 'a' | 'b';

/** What a TerminalPane exposes to the shared input surfaces. */
export interface PaneApi {
  /** Raw bytes to this pane's PTY (false = socket not open, frame dropped). */
  sendInput(text: string): boolean;
  /** Paste text into this pane's PTY (bracketed-paste aware).
   *  False = data socket down, the text was DROPPED. */
  paste(text: string): boolean;
  /** Upload an image file and inject its path (the mobile clipboard/paste path). */
  pasteImage(file: File): void;
  /** Open this pane's any-file picker (upload targets THIS session). */
  openPicker(): void;
  /** Open this pane's image-only picker — on Android that is the gallery
   *  directly, with no "photo / video / file?" chooser in the way. */
  openImagePicker(): void;
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
  focusedSlot(): SlotId;
  setFocusedSlot(slot: SlotId): void;
  /** The focused pane's api, or null when the focused slot has no terminal pane. */
  focusedApi(): PaneApi | null;
  apiFor(slot: SlotId): PaneApi | null;
}

export function createSplitRegistry(): SplitRegistry {
  const panes: { a: PaneApi | null; b: PaneApi | null } = { a: null, b: null };
  let focused: SlotId = 'a';
  return {
    register(slot, api) {
      panes[slot] = api;
      return () => {
        if (panes[slot] === api) panes[slot] = null;
      };
    },
    focusedSlot: () => focused,
    setFocusedSlot: (slot) => {
      focused = slot;
    },
    focusedApi: () => panes[focused],
    apiFor: (slot) => panes[slot],
  };
}
