// ── The review's one read: a file's snapshot ───────────────────────────────────
//
// `GET /scm/file` answers both sides' text and git's hunks between them in one
// response (D2), which is what lets a file's lines, colours and comment positions
// describe one version. It throws instead of answering a union: the queue that
// calls it already turns a rejection into a per-file error and drops answers from
// superseded requests, so a failure here is the file's, not the pane's.
//
// Paths go on the wire exactly as given (`encodeURIComponent`, no trimming): a
// file named `a ` and one named `a` are two files.

import type {
  ScmAlgorithm,
  ScmError,
  ScmErrorCode,
  ScmFileSnapshot,
  ScmGroup,
} from '@palmux/shared';
import type { SnapshotRequest } from './file-queue';

/** A snapshot the server refused, with the server's own reason. */
export class ScmFileError extends Error {
  readonly httpStatus: number;
  readonly code: ScmErrorCode | undefined;

  constructor(message: string, httpStatus: number, code?: ScmErrorCode) {
    super(message);
    this.name = 'ScmFileError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const isSide = (v: unknown): boolean =>
  isRecord(v) && typeof v['id'] === 'string' && typeof v['text'] === 'string';

/** The shape the rows model reads; anything else is not a snapshot of this protocol. */
export function isSnapshot(raw: unknown): raw is ScmFileSnapshot {
  return (
    isRecord(raw) &&
    typeof raw['path'] === 'string' &&
    typeof raw['version'] === 'string' &&
    typeof raw['algorithm'] === 'string' &&
    isSide(raw['old']) &&
    isSide(raw['new']) &&
    Array.isArray(raw['hunks']) &&
    typeof raw['binary'] === 'boolean' &&
    typeof raw['tooLarge'] === 'boolean' &&
    typeof raw['converted'] === 'boolean' &&
    isRecord(raw['modes'])
  );
}

export function scmFileUrl(
  repo: string,
  group: ScmGroup,
  request: { path: string; oldPath?: string | undefined; algorithm: ScmAlgorithm },
): string {
  const query = [
    `repo=${encodeURIComponent(repo)}`,
    `group=${group}`,
    `path=${encodeURIComponent(request.path)}`,
    ...(request.oldPath !== undefined ? [`oldPath=${encodeURIComponent(request.oldPath)}`] : []),
    `algorithm=${request.algorithm}`,
  ];
  return `/scm/file?${query.join('&')}`;
}

export async function fetchScmFile(
  repo: string,
  group: ScmGroup,
  request: SnapshotRequest,
  signal: AbortSignal,
): Promise<ScmFileSnapshot> {
  let res: Response;
  try {
    res = await fetch(scmFileUrl(repo, group, request), { credentials: 'same-origin', signal });
  } catch (error) {
    // An abort is the queue superseding this request, not a failure to report.
    if (signal.aborted) throw error;
    throw new ScmFileError('Cannot reach palmux', 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as Partial<ScmError> | null;
    const message =
      typeof body?.error === 'string' && body.error ? body.error : `HTTP ${res.status}`;
    throw new ScmFileError(message, res.status, body?.code);
  }
  const raw: unknown = await res.json().catch(() => null);
  if (!isSnapshot(raw)) throw new ScmFileError('Unexpected answer from the server', res.status);
  return raw;
}
