// ── Explorer actions ──────────────────────────────────────────────────────────
//
// The two context-menu actions that talk to the server, plus the wording of the
// confirmation that guards the destructive one.
//
// The confirm text is here, and pure, for the same reason the bulk tab close's
// is: a delete has no undo, so what the dialog SAYS is load-bearing, and a
// string built inline in a component is a string nobody ever tests.

import type { DeleteResult } from '@palmux/shared';

export interface DeleteTarget {
  path: string;
  dir: boolean;
}

/** Last path segment, for naming a target in a sentence. */
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1) || path;

/**
 * The confirmation for deleting `targets`, or null when there is nothing to do.
 *
 * It names the single case outright and counts the bulk one, and it always says
 * that folders go with their contents — "delete 3 items?" hides the difference
 * between three files and three project trees.
 */
export function deleteConfirmMessage(targets: DeleteTarget[]): string | null {
  if (targets.length === 0) return null;
  const dirs = targets.filter((t) => t.dir).length;
  const files = targets.length - dirs;

  const head =
    targets.length === 1
      ? `Delete ${targets[0]!.dir ? 'folder' : 'file'} “${nameOf(targets[0]!.path)}”?`
      : `Delete ${targets.length} items?`;

  const lines = [head];
  if (targets.length > 1) {
    const parts: string[] = [];
    if (files) parts.push(`${files} file${files > 1 ? 's' : ''}`);
    if (dirs) parts.push(`${dirs} folder${dirs > 1 ? 's' : ''}`);
    lines.push(parts.join(' and ') + '.');
  }
  if (dirs > 0) {
    lines.push(
      dirs === 1 && targets.length === 1
        ? 'Everything inside it is deleted too.'
        : 'Folders are deleted with everything inside them.',
    );
  }
  lines.push('This cannot be undone — there is no trash.');
  return lines.join('\n');
}

/** A one-line summary of what a delete request actually did. */
export function deleteSummary(results: DeleteResult[]): string {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  if (failed === 0) return `Deleted ${ok} item${ok === 1 ? '' : 's'}`;
  if (ok === 0) {
    // One failure is worth quoting; several are not, and the reasons differ.
    const first = results.find((r) => !r.ok);
    return failed === 1 && first && !first.ok ? `Delete failed: ${first.message}` : 'Delete failed';
  }
  return `Deleted ${ok}, ${failed} failed`;
}

/** POST the delete. Throws only on a malformed REQUEST; per-path failures come
 *  back in the results, because a partial failure is normal here. */
export async function deletePaths(paths: string[]): Promise<DeleteResult[]> {
  const res = await fetch('/files/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ paths }),
  });
  const body = (await res.json().catch(() => null)) as
    | { results?: DeleteResult[]; error?: string }
    | null;
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body?.results ?? [];
}

/**
 * The directories a delete invalidated: each target's PARENT, deduped.
 *
 * The deleted path itself does not need refreshing — it is gone — but the
 * listing that showed it does, and a bulk delete across several folders
 * invalidates all of them.
 */
export function affectedDirs(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const cut = p.lastIndexOf('/');
    if (cut > 0) out.add(p.slice(0, cut));
    else if (cut === 0) out.add('/');
  }
  return [...out];
}
