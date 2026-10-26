// ── Copy comments: the document, with what is outdated marked ─────────────────
//
// The exporter (`review/export-md.ts`) is told which comments are outdated, because
// only a look at the file can say. This is that look, for the Source Control view,
// which has no review open to ask. For each file that has comments and is in a
// group, it reads the same snapshot a review of that group would show and places the
// comments on its two sides exactly as the review does (`comment-placement.ts`), so
// the copy and the screen cannot disagree about what is outdated.
//
// A comment is outdated when it anchors in NONE of the groups its file is in (a file
// changed both before and after staging is in two, and a comment may sit in either).
// A file that is in no group is not read: its code may well still be there, and
// "unknown" must not be reported as "outdated". The same goes for a read that
// failed: the document is for pasting to an agent, and a wrong "(outdated)" is worse
// than a missing one. And for a file palmux answered but did not READ (too large,
// converted by a git filter: both sides come back empty): its comments are marked
// "not shown", never outdated, because nothing says their code left.

import type { ScmComment, ScmFileSnapshot, ScmGroup, ScmStatus } from '@palmux/shared';
import { isUnread, placeComments, placementSidesOf } from '../review/comment-placement';
import { exportCommentsMarkdown } from '../review/export-md';
import { fetchScmFile } from '../review/review-api';
import type { SnapshotRequest } from '../review/file-queue';
import { copyText } from '../mobile/clipboard';
import { DEFAULTS } from '../settings/settings';

export type ReadSnapshot = (
  repo: string,
  group: ScmGroup,
  request: SnapshotRequest,
  signal: AbortSignal,
) => Promise<ScmFileSnapshot>;

interface Where {
  group: ScmGroup;
  oldPath?: string;
}

/** The review groups that list `path`, with the rename source where the entry has one. */
function groupsOf(status: ScmStatus, path: string): Where[] {
  const found: Where[] = [];
  const staged = status.staged.find((entry) => entry.path === path);
  if (staged)
    found.push({ group: 'staged', ...(staged.oldPath ? { oldPath: staged.oldPath } : {}) });
  const changed = status.changes.find((entry) => entry.path === path);
  if (changed)
    found.push({ group: 'changes', ...(changed.oldPath ? { oldPath: changed.oldPath } : {}) });
  return found;
}

/** What a check found of the comments it could say something about. */
export interface CommentMarks {
  /** Ids of the comments whose code is in none of the reviews their file is in. */
  outdated: Set<string>;
  /** Ids of the comments on a file palmux did not read: not outdated, just not shown. */
  unread: Set<string>;
}

/** Which comments the review would list as outdated, and which as not shown. */
export async function commentMarks(
  repo: string,
  status: ScmStatus,
  comments: readonly ScmComment[],
  read: ReadSnapshot = fetchScmFile,
): Promise<CommentMarks> {
  const byPath = new Map<string, ScmComment[]>();
  for (const comment of comments) {
    const held = byPath.get(comment.path);
    if (held) held.push(comment);
    else byPath.set(comment.path, [comment]);
  }
  const outdated = new Set<string>();
  const unread = new Set<string>();
  const signal = new AbortController().signal;
  for (const [path, mine] of byPath) {
    const where = groupsOf(status, path);
    const anchored = new Set<string>();
    let readable = 0;
    let unreadable = 0;
    for (const { group, oldPath } of where) {
      const request: SnapshotRequest = { path, algorithm: DEFAULTS.scmAlgorithm };
      if (oldPath !== undefined) request.oldPath = oldPath;
      let snapshot: ScmFileSnapshot;
      try {
        // One file at a time: this runs on a tap, for a handful of files, and the
        // server reads each from git.
        // oxlint-disable-next-line no-await-in-loop -- sequential by design
        snapshot = await read(repo, group, request, signal);
      } catch {
        continue;
      }
      if (isUnread(snapshot)) {
        unreadable += 1;
        continue;
      }
      readable += 1;
      for (const placed of placeComments(mine, placementSidesOf(snapshot)).placed) {
        anchored.add(placed.comment.id);
      }
    }
    if (readable + unreadable === 0) continue;
    for (const comment of mine) {
      if (anchored.has(comment.id)) continue;
      // Its code may be in the review palmux could not read, so it is not known to be gone.
      (unreadable > 0 ? unread : outdated).add(comment.id);
    }
  }
  return { outdated, unread };
}

/** Every comment as one markdown document, outdated and not-shown ones marked. */
export async function commentsMarkdown(
  repo: string,
  status: ScmStatus | null,
  comments: readonly ScmComment[],
  read?: ReadSnapshot,
): Promise<string> {
  const marks = status
    ? await commentMarks(repo, status, comments, read)
    : { outdated: new Set<string>(), unread: new Set<string>() };
  return exportCommentsMarkdown(comments, marks);
}

/**
 * Puts `text` on the clipboard while it is still being computed. The document needs
 * a read per commented file, and a clipboard write is honoured only inside the tap:
 * WebKit refuses one that follows an awaited fetch, and Firefox one that outlasts its
 * activation window. A `ClipboardItem` takes a PROMISE, so the write is asked for
 * inside the gesture and the browser waits for the text. Where that is missing or
 * refused, the finished text goes through `copyText`, which Chromium still accepts.
 */
export async function copyPendingText(text: Promise<string>): Promise<boolean> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      const blob = text.then((value) => new Blob([value], { type: 'text/plain' }));
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      return true;
    } catch {
      // fall through to the copy that waits for the text
    }
  }
  return copyText(await text);
}
