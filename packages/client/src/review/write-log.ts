// ── The index writes still inside their Undo window ───────────────────────────
//
// Each Reviewed or Unstage answers with a receipt and offers Undo for 6 seconds. The
// app has ONE toast, and a second write used to replace the first one's: its Undo
// was silently gone while the file it staged was still staged. So the writes of the
// last 6 seconds are kept here, the toast names all of them, and its one Undo takes
// them all back (`undoWrites`, newest first).
//
// Module state on purpose: two reviews of one window (a project's Changes and its
// Staged, or two projects) share the window's one toast, so they share this list.
// It holds receipt ids and names only; the receipts themselves are the server's.

/** How long a write stays undoable from the toast that offered it. */
export const UNDO_WINDOW_MS = 6000;

export interface LoggedWrite {
  /** The project the write was made in: a receipt is restored in the project that issued it. */
  repo: string;
  receiptId: string;
  action: 'stage' | 'unstage';
  /** The file's name, for the toast. */
  name: string;
  /** When it was made, in `Date.now()` milliseconds. */
  at: number;
}

let recent: LoggedWrite[] = [];

/** Add a write; answers every write still inside its window, oldest first, this one last. */
export function recordWrite(write: LoggedWrite): LoggedWrite[] {
  recent = [...recent.filter((held) => write.at - held.at < UNDO_WINDOW_MS), write];
  return [...recent];
}

/** Drop writes that were undone (or can no longer be), so a later toast does not offer them again. */
export function forgetWrites(gone: readonly LoggedWrite[]): void {
  const receipts = new Set(gone.map((write) => write.receiptId));
  recent = recent.filter((write) => !receipts.has(write.receiptId));
}

/** Test seam: the list is process-wide by design. */
export function resetWriteLog(): void {
  recent = [];
}
