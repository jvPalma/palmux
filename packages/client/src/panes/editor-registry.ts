// ── Which editor the extra-keys bar is talking to ─────────────────────────────
//
// On mobile the extra-keys bar is the only keyboard a phone does not give you:
// ESC, the arrows, HOME/END, PGUP/PGDN, TAB. Those matter in an EDITOR at least
// as much as in a terminal, and until now the bar could only reach a PTY — the
// keys were dead on every editor tab.
//
// The obvious route does not work, and this was measured before the registry was
// built rather than after: a synthetic `KeyboardEvent` does NOT move Monaco.
// Real keys moved the cursor 408px → 448px; dispatching the same key with the
// right `key`, `code` and `keyCode` moved it nowhere. Monaco 0.55 takes input
// through the **EditContext API** (`div.native-edit-context`, not a textarea),
// so keyboard events it did not receive from the browser are ignored by design.
// The supported path is `editor.trigger(source, handlerId, payload)`, which
// needs the editor INSTANCE — hence this registry, mirroring the shape of
// `session/SplitFocusContext` for the same reason: ref-held, read at call time,
// so a send closure never has to re-bind.

/** What an editor pane exposes to the shared input surfaces. */
export interface EditorApi {
  /** Run a Monaco command id (`cursorDown`, `cursorHome`, …). */
  run(handlerId: string): void;
  /** Type text at the cursor, honouring the current selection. */
  type(text: string): void;
  /** Put DOM focus back in the editor after a bar press stole it. */
  focus(): void;
}

const editors = new Map<string, EditorApi>();
let focusedId: string | null = null;

export function registerEditor(id: string, api: EditorApi): void {
  editors.set(id, api);
  // First editor in wins the focus by default: a pane that has just mounted is
  // the one the user is looking at, and nothing else would claim it until they
  // touch the editor — which on a phone they may never do before reaching for
  // the bar.
  focusedId ??= id;
}

export function unregisterEditor(id: string): void {
  editors.delete(id);
  if (focusedId === id) focusedId = editors.keys().next().value ?? null;
}

/** Called when an editor takes DOM focus, and on pane activation. */
export function focusEditor(id: string): void {
  if (editors.has(id)) focusedId = id;
}

/** The editor the bar should talk to, or null when no editor is mounted. */
export function focusedEditor(): EditorApi | null {
  return (focusedId && editors.get(focusedId)) || null;
}

/** Test seam — the module holds process-wide state by design. */
export function resetEditorRegistry(): void {
  editors.clear();
  focusedId = null;
}
