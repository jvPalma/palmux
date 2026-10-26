// ── Source Control wire types ─────────────────────────────────────────────────
//
// The JSON shapes `/scm/status` and `/scm/file` answer, shared so the server's
// producer and the client's consumer cannot drift. See the `source-control-review`
// design (D2) for what each field means and where it comes from.

export type ScmGroup = 'staged' | 'changes';

export type ScmAlgorithm = 'myers' | 'minimal' | 'patience' | 'histogram';

export const SCM_ALGORITHMS: readonly ScmAlgorithm[] = ['myers', 'minimal', 'patience', 'histogram'];

export type ScmEntryKind = 'ordinary' | 'rename' | 'unmerged' | 'untracked';

export interface ScmEntry {
  path: string;
  /** The source path of a rename. */
  oldPath?: string;
  kind: ScmEntryKind;
  status: 'M' | 'A' | 'D' | 'R' | 'T' | 'U' | '?';
  /** Line counts from `--numstat`; absent for untracked files and binaries. */
  added?: number;
  removed?: number;
  binary?: boolean;
  /** Changes whenever anything the review shows for this entry changes (kind, modes, oids, stat). */
  fp: string;
}

export interface ScmStatus {
  top: string;
  branch?: string;
  head?: string;
  unborn: boolean;
  merge: ScmEntry[];
  staged: ScmEntry[];
  changes: ScmEntry[];
  truncated: boolean;
  tookMs: number;
  commentsRev: number;
  attrEpoch: string;
}

/** One side of a file pair. `id` is a git blob oid, or `'absent'` when the side does not exist. */
export interface ScmSide {
  id: string;
  text: string;
}

export interface ScmHunkLine {
  kind: 'ctx' | 'add' | 'del';
  old?: number;
  new?: number;
  text: string;
  /** The line has no trailing newline (`\ No newline at end of file`). */
  noEol?: boolean;
}

export interface ScmHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: ScmHunkLine[];
}

export interface ScmFileSnapshot {
  path: string;
  oldPath?: string;
  group: ScmGroup;
  algorithm: ScmAlgorithm;
  old: ScmSide;
  new: ScmSide;
  hunks: ScmHunk[];
  binary: boolean;
  tooLarge: boolean;
  converted: boolean;
  unmerged: boolean;
  modes: { old?: string; new?: string };
  symlink?: { old?: boolean; new?: boolean };
  /** The effective attribute and line-ending context the comparison was built with. */
  attrs: Record<string, string>;
  /** Identifies the file pair and its presentation rules; independent of the algorithm. */
  version: string;
  /** Present only when this snapshot can be staged. */
  token?: string;
}

export type ScmErrorCode = 'busy' | 'conflict' | 'changed' | 'token' | 'unsupported' | 'df';

export interface ScmError {
  error: string;
  code?: ScmErrorCode;
}

export interface ScmWriteResult {
  receiptId: string;
  status: 'staged' | 'unstaged' | 'restored';
}

export function isScmGroup(v: unknown): v is ScmGroup {
  return v === 'staged' || v === 'changes';
}

export function isScmAlgorithm(v: unknown): v is ScmAlgorithm {
  return typeof v === 'string' && (SCM_ALGORITHMS as readonly string[]).includes(v);
}

/** The `url` of a review tab: `changes:/abs/top` or `staged:/abs/top`. */
export function reviewUrl(group: ScmGroup, top: string): string {
  return `${group}:${top}`;
}

/** Inverse of `reviewUrl`; null for anything that is not a group prefix followed by an absolute path. */
export function parseReviewUrl(url: string): { group: ScmGroup; top: string } | null {
  const colon = url.indexOf(':');
  if (colon < 0) return null;
  const group = url.slice(0, colon);
  const top = url.slice(colon + 1);
  if (!isScmGroup(group) || !top.startsWith('/')) return null;
  return { group, top };
}
