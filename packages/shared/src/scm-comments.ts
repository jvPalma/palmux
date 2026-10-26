// ── Review comment wire types ─────────────────────────────────────────────────
//
// A comment on a line or a range of one side of a diff, as `/scm/comments` stores
// and answers it. See the `source-control-review` design (D9).

/** The content the commented side showed when the comment was made (provenance, not a display rule). */
export type ScmCommentVersion = 'head' | 'index' | 'worktree';

export type ScmCommentSide = 'old' | 'new';

export interface ScmComment {
  id: string;
  path: string;
  version: ScmCommentVersion;
  side: ScmCommentSide;
  /** 1-based, inclusive. */
  start: number;
  end: number;
  /** The commented lines' text, and up to three lines either side, for anchoring. */
  lines: string[];
  before: string[];
  after: string[];
  body: string;
  createdAt: number;
  updatedAt: number;
}

/** What every comments read and write answers: the whole list and its revision. */
export interface ScmCommentList {
  rev: number;
  comments: ScmComment[];
}

export type ScmCommentInput = Omit<ScmComment, 'id' | 'createdAt' | 'updatedAt'>;

/** An edit: any subset of the input fields. The merged comment must still be valid. */
export type ScmCommentPatch = Partial<ScmCommentInput>;

/** What the server accepts, so a client can stop a write it knows would be refused. */
export const SCM_COMMENT_LIMITS = {
  /** UTF-8 bytes of `body` (an empty body is valid). */
  bodyBytes: 64 * 1024,
  /** Entries in `lines`, which also bounds a range: `end - start + 1 === lines.length`. */
  lines: 2000,
  /** Entries in each of `before` and `after`. */
  context: 10,
  /** UTF-8 bytes of `lines`, `before` and `after` together. */
  textBytes: 256 * 1024,
  /** Characters in `path`. */
  pathChars: 4096,
} as const;

export function isScmCommentVersion(v: unknown): v is ScmCommentVersion {
  return v === 'head' || v === 'index' || v === 'worktree';
}

export function isScmCommentSide(v: unknown): v is ScmCommentSide {
  return v === 'old' || v === 'new';
}
