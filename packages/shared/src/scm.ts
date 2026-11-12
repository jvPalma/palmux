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
  /** null when an Undo leaves nothing to redo (a discard's Undo). */
  receiptId: string | null;
  status: 'staged' | 'unstaged' | 'restored';
}

/** Why a batch stage, unstage or discard left a path alone. */
export type ScmSkipReason =
  | 'converted'
  | 'unmerged'
  | 'submodule'
  | 'nested-repo'
  | 'gone'
  | 'changed'
  | 'symlink'
  | 'special'
  | 'intent-to-add'
  | 'rename'
  | 'failed';

export interface ScmSkip {
  path: string;
  reason: ScmSkipReason;
}

/** The answer of `/scm/stage-paths`, `/scm/unstage-paths` and `/scm/discard`. */
export interface ScmBatchResult {
  /** null when nothing changed. */
  receiptId: string | null;
  status: 'staged' | 'unstaged' | 'discarded';
  done: string[];
  skipped: ScmSkip[];
}

/** The most paths one batch request may name. */
export const SCM_BATCH_LIMIT = 5000;

/** What the client says of each skip reason. */
/** The word for each status letter: a list row's title and the review's header. */
export const SCM_STATUS_LABEL: Record<ScmEntry['status'], string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  T: 'Type changed',
  U: 'Conflicted',
  '?': 'Untracked',
};

export const SCM_SKIP_LABEL: Record<ScmSkipReason, string> = {
  converted: 'needs a git filter',
  unmerged: 'unmerged',
  submodule: 'a submodule',
  'nested-repo': 'a nested repository',
  gone: 'no longer changed',
  changed: 'changed since you confirmed',
  symlink: 'a symbolic link',
  special: 'not a regular file',
  'intent-to-add': 'added with intent to add',
  rename: 'a rename',
  failed: 'could not be written',
};

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

/** The `url` of a single-file review: `<group>-file:<enc(top)>:<enc(path)>`. */
export function fileReviewUrl(group: ScmGroup, top: string, path: string): string {
  return `${group}-file:${encodeURIComponent(top)}:${encodeURIComponent(path)}`;
}

/** The rules of the server's `checkRelPath`: a relative path with no empty, `.`, `..` or `.git` component. */
export function isReviewFilePath(path: string): boolean {
  if (path.trim() === '' || path.includes('\0') || path.startsWith('/')) return false;
  return path
    .split('/')
    .every((c) => c !== '' && c !== '.' && c !== '..' && c.toLowerCase() !== '.git');
}

/** Ill-formed UTF-16: under the `u` flag a surrogate pair is one code point, so only a lone half matches. */
const LONE_SURROGATE = /\p{Surrogate}/u;

/**
 * Inverse of `reviewUrl` and `fileReviewUrl`; null for anything else. `file` is set only for the
 * per-file form.
 */
export function parseReviewUrl(url: string): { group: ScmGroup; top: string; file?: string } | null {
  const colon = url.indexOf(':');
  if (colon < 0) return null;
  const prefix = url.slice(0, colon);
  const rest = url.slice(colon + 1);
  if (prefix.endsWith('-file')) {
    const group = prefix.slice(0, -5);
    if (!isScmGroup(group)) return null;
    const sep = rest.indexOf(':');
    if (sep < 0) return null;
    let top: string;
    let file: string;
    try {
      top = decodeURIComponent(rest.slice(0, sep));
      file = decodeURIComponent(rest.slice(sep + 1));
    } catch {
      return null;
    }
    // A raw lone surrogate decodes untouched, and `fileReviewUrl` could not encode it back.
    if (LONE_SURROGATE.test(top) || LONE_SURROGATE.test(file)) return null;
    if (!top.startsWith('/') || !isReviewFilePath(file)) return null;
    return { group, top, file };
  }
  if (!isScmGroup(prefix) || !rest.startsWith('/')) return null;
  return { group: prefix, top: rest };
}
