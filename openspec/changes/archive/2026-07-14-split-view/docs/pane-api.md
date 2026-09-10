# PaneApi + SplitFocusContext — concrete contracts

The single source of truth for the registration API (design D3). Reconciles the earlier
D3-vs-task-1.3 inconsistency: `term` AND `host` are both required (gestures need the host element;
the visualViewport selection-restore needs the term), `getMods` stays App-side (it belongs to the
extra-keys bar, not the pane).

```ts
import type { Terminal } from '@xterm/xterm';

/** What a TerminalPane exposes to the shared input surfaces. */
export interface PaneApi {
  /** Raw bytes to this pane's PTY (false = socket not open, frame dropped). */
  sendInput(text: string): boolean;
  /** Paste text through xterm (bracketed-paste aware). */
  paste(text: string): void;
  /** The live xterm instance (null until open). */
  term: Terminal | null;
  /** The pane's host element (gesture/selection coordinate space). */
  host: HTMLElement | null;
  /** Move DOM keyboard focus into this pane's terminal (desktop). */
  focus(): void;
  blur(): void;
  /** Open this pane's file picker / clipboard-paste (upload targets THIS session). */
  openPicker(): void;
  pasteFromClipboard(): Promise<void>;
}

export type SlotId = 'a' | 'b';

/** Ref-based so stable closures can read the focused pane at CALL time —
 *  useSoftKeyboard/ExtraKeysBar re-bind on callback identity, so the callbacks
 *  App hands them must never change identity. */
export interface SplitFocusRegistry {
  /** The focused slot ('a' in single-slot mode — the sole slot is always focused). */
  focusedSlot: SlotId;
  setFocusedSlot(slot: SlotId): void;
  /** Panes register on mount; returns an unregister fn for cleanup. */
  register(slot: SlotId, api: PaneApi): () => void;
  /** The focused pane's api, or null when the focused slot is a non-terminal pane. */
  focusedPane(): PaneApi | null;
}
```

Stage 1 (single slot): `register('a', api)` with a plain module-less ref in App — the context
provider itself can land in stage 2; the API shape is identical so nothing rewires.

Routing rules (normative summaries live in the specs). Split is DESKTOP-ONLY (S1 Q4/Q6), so the
soft keyboard, extra-keys bar, and gestures — mobile-only surfaces — never coexist with a split and
need NO registry routing; they keep their single-slot behavior:

- Desktop shared surfaces → `focusedPane()`: the hoisted Ctrl+Shift+C/V dispatcher and the
  topbar picker + clipboard-paste buttons. When `focusedPane()` is null (focused slot is a
  web/dashboard/editor pane), the picker/paste actions are the existing "open a terminal tab"
  guard; the clipboard combo is a no-op.
- Per-pane (never routed): touch selection + handles, copy-on-select, drag-drop file upload
  (targets the pane dropped on); `useMobileGestures` (mobile-only, single-slot).
