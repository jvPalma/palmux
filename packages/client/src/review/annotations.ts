// ── Comments in the rows: where each one is drawn ─────────────────────────────
//
// `buildFileRows` knows nothing about comments. This takes a file's finished rows
// and the comments already placed on them (`comment-placement.ts`) and returns the
// rows with each comment, and each open editor, inserted under the last line of its
// range. Pure: the model calls it per file and caches the result under a signature
// of everything that went in.
//
// A comment that cannot hang from a line is never dropped and never moved onto a
// neighbour. Outdated ones (their code is gone) and hidden ones (their lines sit in
// a gap nobody expanded) go in one list at the end of the file, with the code they
// were about quoted, so the reader can still find what the comment meant.

import type { ScmComment } from '@palmux/shared';
import type { PlacedComment } from './comment-placement';
import { draftKey, type DraftTarget } from './comments-store';
import type { DiffSide, EditorRow, Row, UnplacedItem } from './rows';

export interface FileNotes {
  /** Comments found on one side of this review, in the order they were made. */
  placed: readonly PlacedComment[];
  /** Comments found on neither side. */
  outdated: readonly ScmComment[];
  /** Comments on a file palmux did not read (too large, converted): not outdated, just not shown. */
  unread: readonly ScmComment[];
  /** Every open draft of this file: new comments and edits of stored ones. */
  drafts: readonly DraftTarget[];
}

export const hasNotes = (notes: FileNotes): boolean =>
  notes.placed.length > 0 ||
  notes.outdated.length > 0 ||
  notes.unread.length > 0 ||
  notes.drafts.length > 0;

const lineKey = (side: DiffSide, no: number): string => `${side}:${no}`;

/** The last row each line number of each side is drawn on. */
function lastRowOfLines(rows: readonly Row[]): Map<string, number> {
  const last = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row.type === 'line') {
      if (row.old !== undefined) last.set(lineKey('old', row.old), index);
      if (row.new !== undefined) last.set(lineKey('new', row.new), index);
    } else if (row.type === 'split') {
      if (row.left) last.set(lineKey('old', row.left.no), index);
      if (row.right) last.set(lineKey('new', row.right.no), index);
    }
  });
  return last;
}

const byCreation = (a: PlacedComment, b: PlacedComment): number =>
  a.comment.createdAt - b.comment.createdAt || (a.comment.id < b.comment.id ? -1 : 1);

/** `rows` with `notes` drawn in them; the same array when there is nothing to draw. */
export function withNotes(path: string, rows: readonly Row[], notes: FileNotes): readonly Row[] {
  if (!hasNotes(notes)) return rows;

  const lines = lastRowOfLines(rows);
  const edits = new Map<string, DraftTarget>();
  for (const draft of notes.drafts) {
    if (draft.commentId !== undefined) edits.set(draft.commentId, draft);
  }

  const inserted = new Map<number, Row[]>();
  const add = (index: number, row: Row): void => {
    const held = inserted.get(index);
    if (held) held.push(row);
    else inserted.set(index, [row]);
  };
  const tail: Row[] = [];
  const unplaced: UnplacedItem[] = [];

  const editorRow = (target: DraftTarget, comment: ScmComment | undefined): EditorRow => ({
    type: 'editor',
    key: `${path}|editor:${draftKey(target)}`,
    path,
    target,
    comment,
  });

  for (const placed of notes.placed.toSorted(byCreation)) {
    const { comment, side, start, end } = placed;
    const index = lines.get(lineKey(side, end));
    const edit = edits.get(comment.id);
    if (index === undefined) {
      // Listed where the anchor found it NOW, not where it was stored: the two differ
      // as soon as lines were inserted above, and the quote beside it is what to check.
      unplaced.push({ comment, reason: 'hidden', at: { side, start, end }, draft: edit });
    } else if (edit) {
      add(index, editorRow(edit, comment));
    } else {
      add(index, {
        type: 'comment',
        key: `${path}|comment:${comment.id}`,
        path,
        comment,
        side,
        start,
        end,
      });
    }
  }

  // A comment being written: under its last line, or at the end when that line is
  // not drawn (the file changed under the editor).
  for (const draft of notes.drafts) {
    if (draft.commentId !== undefined) continue;
    const index = lines.get(lineKey(draft.side, draft.end));
    if (index === undefined) tail.push(editorRow(draft, undefined));
    else add(index, editorRow(draft, undefined));
  }

  for (const comment of notes.outdated) {
    unplaced.push({ comment, reason: 'outdated', draft: edits.get(comment.id) });
  }
  for (const comment of notes.unread) {
    unplaced.push({ comment, reason: 'unread', draft: edits.get(comment.id) });
  }

  // An edit whose comment is in none of the lists above was deleted elsewhere. The
  // text typed into it is the one thing left of it, so it is never dropped: it
  // stays at the end of the file, as an editor that says what happened.
  const known = new Set<string>();
  for (const { comment } of notes.placed) known.add(comment.id);
  for (const comment of notes.outdated) known.add(comment.id);
  for (const comment of notes.unread) known.add(comment.id);
  for (const draft of notes.drafts) {
    if (draft.commentId === undefined || known.has(draft.commentId)) continue;
    tail.push({ ...editorRow(draft, undefined), orphaned: true });
  }
  if (unplaced.length > 0) {
    tail.push({ type: 'unplaced', key: `${path}|unplaced`, path, items: unplaced });
  }

  const out: Row[] = [];
  rows.forEach((row, index) => {
    out.push(row);
    const extra = inserted.get(index);
    if (extra) out.push(...extra);
  });
  out.push(...tail);
  return out;
}
