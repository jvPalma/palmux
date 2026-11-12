// ── Copy comments: the document, with what is outdated marked ─────────────────
//
// The exporter (`export-md.ts`) is told which comments are outdated, because only a
// look at the file can say. This is that look, for a caller that has no review open
// to ask: the Source Control view, a review's own copy buttons and `palmux comments`
// on the server, each with its own way to read a snapshot. For each file that has
// comments and is in a group, it reads the snapshot a review of that group would show
// and places the comments on its two sides exactly as the review does
// (`comment-placement.ts`), so the copy and the screen cannot disagree.
//
// A comment is outdated when it anchors in NONE of the groups its file is in (a file
// changed both before and after staging is in two, and a comment may sit in either).
// A file that is in no group is not read: its code may well still be there, and
// "unknown" must not be reported as "outdated". The same goes for a read that
// failed: the document is for pasting to an agent, and a wrong "(outdated)" is worse
// than a missing one. And for a file palmux answered but did not READ (too large,
// converted by a git filter: both sides come back empty): its comments are marked
// "not shown", never outdated, because nothing says their code left.

import { isUnread, placeComments, placementSidesOf } from './comment-placement';
import { exportCommentsMarkdown } from './export-md';
import type { ScmAlgorithm, ScmFileSnapshot, ScmGroup, ScmStatus } from './scm';
import type { ScmComment } from './scm-comments';

/**
 * The algorithm the marks read with. Placement compares side TEXTS only, so the
 * algorithm cannot change a mark; this is the client's default, so a read can come
 * from a cache the review already filled.
 */
export const MARKS_ALGORITHM: ScmAlgorithm = 'histogram';

/** Which file a mark check asks for. */
export interface CommentSnapshotRequest {
  path: string;
  oldPath?: string;
  algorithm: ScmAlgorithm;
}

/** Reads one file's snapshot in one group; rejects when it cannot. */
export type ReadSnapshot = (
  repo: string,
  group: ScmGroup,
  request: CommentSnapshotRequest,
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
  read: ReadSnapshot,
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
      const request: CommentSnapshotRequest = { path, algorithm: MARKS_ALGORITHM };
      if (oldPath !== undefined) request.oldPath = oldPath;
      let snapshot: ScmFileSnapshot;
      try {
        // One file at a time: this runs on a tap or a CLI call, for a handful of
        // files, and the server reads each from git.
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
  read: ReadSnapshot,
): Promise<string> {
  const marks = status
    ? await commentMarks(repo, status, comments, read)
    : { outdated: new Set<string>(), unread: new Set<string>() };
  return exportCommentsMarkdown(repo, comments, marks);
}
