// ── Where an editor opens: `palmux open file:line[:col]` ─────────────────────
//
// The CLI names a file and a position; the tab may be open already, still being created, or open
// in Read mode (a markdown file). One store keyed by the FILE PATH covers all three: App asks, the
// file's EditorPane takes the request once Monaco holds the text (now, or when it loads), and the
// file's FileTabPane switches Read to Edit, because a line only means something in the editor.
// A request is kept until an editor takes it, so a tab created later still lands on it; a newer
// request for the same path replaces it.

export interface EditorGoto {
  line: number;
  column?: number;
}

const pending = new Map<string, EditorGoto>();
const listeners = new Map<string, Set<() => void>>();

/** Ask the editor of `path` to put its cursor at `at`. */
export function requestGoto(path: string, at: EditorGoto): void {
  pending.set(path, at);
  for (const cb of listeners.get(path) ?? []) cb();
}

/** Whether a request for `path` is waiting. */
export function hasGoto(path: string): boolean {
  return pending.has(path);
}

/** Take the request for `path`, leaving none behind. */
export function takeGoto(path: string): EditorGoto | undefined {
  const at = pending.get(path);
  pending.delete(path);
  return at;
}

/** Call `cb` on every new request for `path`; returns the way to stop. */
export function onGoto(path: string, cb: () => void): () => void {
  let set = listeners.get(path);
  if (!set) {
    set = new Set();
    listeners.set(path, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) listeners.delete(path);
  };
}

/** Test seam — the module holds process-wide state by design. */
export function resetEditorGoto(): void {
  pending.clear();
  listeners.clear();
}
