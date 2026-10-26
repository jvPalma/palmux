// ── Where a comment draws in an open review ───────────────────────────────────
//
// Display is content-driven (design D9): a comment is drawn on whichever side of
// the open review its stored lines and context are found in, not on the side or
// version it was made on. That is what lets the owner's flow work. A comment made
// on Changes' new side (the work tree) is still there after Reviewed, because the
// staged file's new side (the index) holds the same lines.
//
// Finding is `anchorLines`, the function scroll anchoring uses too, so a comment
// and a scroll position agree about where code went.

import type {
  ScmComment,
  ScmCommentInput,
  ScmCommentSide,
  ScmCommentVersion,
  ScmFileSnapshot,
  ScmGroup,
} from '@palmux/shared';
import { anchorLines, DEFAULT_CONTEXT, splitLines } from './anchor';

/** One side of the review's file pair: its text as lines, and which version of the file that is. */
export interface PlacementSide {
  version: ScmCommentVersion;
  lines: readonly string[];
}

export interface PlacementSides {
  old: PlacementSide;
  new: PlacementSide;
}

export interface PlacedComment {
  comment: ScmComment;
  /** The side it draws on in this review, which need not be the side it was made on. */
  side: ScmCommentSide;
  /** 1-based and inclusive, in that side's current text. */
  start: number;
  end: number;
}

export interface CommentPlacement {
  /** In the order the comments came. */
  placed: PlacedComment[];
  /** Found on neither side, or ambiguous on both. Listed with their stored code, never attached. */
  outdated: ScmComment[];
}

/**
 * The side to try first. The side showing the comment's own version is the one it
 * was made against. When neither side shows that version (a comment on the work
 * tree, viewed in Staged) the side it was made on is the best guess, since a
 * file staged as reviewed keeps its new side the new side.
 */
function sidesInOrder(comment: ScmComment, sides: PlacementSides): ScmCommentSide[] {
  const preferred: ScmCommentSide =
    sides.new.version === comment.version
      ? 'new'
      : sides.old.version === comment.version
        ? 'old'
        : comment.side;
  return preferred === 'new' ? ['new', 'old'] : ['old', 'new'];
}

/**
 * Place one file's comments on an open review's two sides.
 *
 * Each comment goes to the first of its two candidate sides (its own version's side
 * first) where the anchor finds it. A tie for best match on a side counts as not
 * found there, as it does everywhere else: attaching a comment to the wrong
 * duplicate is worse than listing it as outdated.
 */
export function placeComments(
  comments: readonly ScmComment[],
  sides: PlacementSides,
): CommentPlacement {
  const placed: PlacedComment[] = [];
  const outdated: ScmComment[] = [];
  for (const comment of comments) {
    const spec = {
      lines: comment.lines,
      before: comment.before,
      after: comment.after,
      start: comment.start,
    };
    let found: PlacedComment | null = null;
    for (const side of sidesInOrder(comment, sides)) {
      const result = anchorLines(sides[side].lines, spec);
      if (result.outdated) continue;
      found = { comment, side, start: result.start, end: result.end };
      break;
    }
    if (found) placed.push(found);
    else outdated.push(comment);
  }
  return { placed, outdated };
}

/**
 * Which version of the file each side of a group's review shows: Staged compares
 * HEAD with the index, Changes compares the index with the work tree.
 */
export function versionOf(group: ScmGroup, side: ScmCommentSide): ScmCommentVersion {
  if (group === 'staged') return side === 'old' ? 'head' : 'index';
  return side === 'old' ? 'index' : 'worktree';
}

/** The two sides of a snapshot, ready to place comments on. */
export function placementSidesOf(snapshot: ScmFileSnapshot): PlacementSides {
  return {
    old: { version: versionOf(snapshot.group, 'old'), lines: splitLines(snapshot.old.text) },
    new: { version: versionOf(snapshot.group, 'new'), lines: splitLines(snapshot.new.text) },
  };
}

/**
 * Whether a snapshot's sides are empty because palmux never read the file (over the
 * size limit, or converted by a git filter), not because the file is. Its comments
 * cannot be found, and they are not outdated either: nothing says their code left.
 */
export const isUnread = (snapshot: Pick<ScmFileSnapshot, 'tooLarge' | 'converted'>): boolean =>
  snapshot.tooLarge || snapshot.converted;

/** What the review and the export both say of a comment on a file palmux did not read. */
export const UNREAD_REASON = 'file too large / converted';

export interface SnapshotPlacement extends CommentPlacement {
  /** Comments on a file palmux did not read: neither placed nor outdated. */
  unread: ScmComment[];
}

/** `placeComments` on a snapshot's two sides, except that a file palmux did not read places nothing and outdates nothing. */
export function placeInSnapshot(
  comments: readonly ScmComment[],
  snapshot: ScmFileSnapshot,
): SnapshotPlacement {
  if (isUnread(snapshot)) return { placed: [], outdated: [], unread: [...comments] };
  return { ...placeComments(comments, placementSidesOf(snapshot)), unread: [] };
}

/** The code a comment is about: its lines, and the context its anchor is matched on. */
export interface CapturedRange {
  lines: string[];
  before: string[];
  after: string[];
}

/**
 * The stored text of `start..end` (1-based, inclusive) of one side, or null when
 * the range is not inside the side's text. Captured when the comment is STARTED,
 * not when it is saved: a file edited while the comment is typed must not move
 * the comment onto whatever now sits at those numbers.
 */
export function captureRange(
  sideLines: readonly string[],
  start: number,
  end: number,
  context = DEFAULT_CONTEXT,
): CapturedRange | null {
  if (start < 1 || end < start || end > sideLines.length) return null;
  return {
    lines: sideLines.slice(start - 1, end),
    before: sideLines.slice(Math.max(0, start - 1 - context), start - 1),
    after: sideLines.slice(end, end + context),
  };
}

/** The request that stores a comment on `start..end` of `side` in a review of `group`. */
export function commentInput(
  group: ScmGroup,
  target: { path: string; side: ScmCommentSide; start: number; end: number },
  range: CapturedRange,
  body: string,
): ScmCommentInput {
  return {
    path: target.path,
    version: versionOf(group, target.side),
    side: target.side,
    start: target.start,
    end: target.end,
    lines: range.lines,
    before: range.before,
    after: range.after,
    body,
  };
}
