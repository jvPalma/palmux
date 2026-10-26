// ── Source Control: typed fetch wrappers ──────────────────────────────────────
//
// Two reads: `/scm/repo` (is this path inside a work tree, and where is its top)
// and `/scm/status` (the grouped change list). Each answers a union instead of
// throwing, because a refusal is the normal outcome of typing a path and a status
// that fails is something the view must SHOW, not a crash. The server's own message
// is carried through, so "path is not a git repository" reaches the user as written.
//
// The writes follow the same shape: the comment store's four requests and the three
// index writes (stage, unstage, restore). A refused write carries the server's
// `code`, which is what lets the review tell a busy index from a conflict.
//
// Paths go on the wire exactly as given (`encodeURIComponent`, no trimming): a
// folder named `app ` and one named `app` are two projects.

import {
  isScmCommentSide,
  isScmCommentVersion,
  type ScmComment,
  type ScmCommentInput,
  type ScmCommentList,
  type ScmCommentPatch,
  type ScmEntry,
  type ScmError,
  type ScmErrorCode,
  type ScmStatus,
  type ScmWriteResult,
} from '@palmux/shared';

export type ScmFetchResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      message: string;
      /** The HTTP status, or 0 when no answer arrived at all. */
      httpStatus: number;
      code?: ScmErrorCode;
    };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const isEntry = (v: unknown): v is ScmEntry =>
  isRecord(v) &&
  typeof v['path'] === 'string' &&
  typeof v['fp'] === 'string' &&
  typeof v['status'] === 'string' &&
  typeof v['kind'] === 'string';

const isEntryList = (v: unknown): v is ScmEntry[] => Array.isArray(v) && v.every(isEntry);

/** The status the server sent, or null when it is not the shape the view reads. */
export function parseStatus(raw: unknown): ScmStatus | null {
  if (!isRecord(raw)) return null;
  if (typeof raw['top'] !== 'string') return null;
  if (!isEntryList(raw['merge']) || !isEntryList(raw['staged']) || !isEntryList(raw['changes'])) {
    return null;
  }
  return raw as unknown as ScmStatus;
}

async function messageOf(res: Response): Promise<{ message: string; code?: ScmErrorCode }> {
  const body = (await res.json().catch(() => null)) as Partial<ScmError> | null;
  const message = typeof body?.error === 'string' && body.error ? body.error : `HTTP ${res.status}`;
  return typeof body?.code === 'string' ? { message, code: body.code } : { message };
}

async function requestJson<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  parse: (raw: unknown) => T | null,
  options: { body?: unknown; signal?: AbortSignal | undefined } = {},
): Promise<ScmFetchResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      credentials: 'same-origin',
      ...(method === 'GET' ? {} : { method }),
      ...(options.body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    return { ok: false, message: 'Cannot reach palmux', httpStatus: 0 };
  }
  if (!res.ok) return { ok: false, httpStatus: res.status, ...(await messageOf(res)) };
  const value = parse(await res.json().catch(() => null));
  if (value === null) {
    return { ok: false, message: 'Unexpected answer from the server', httpStatus: res.status };
  }
  return { ok: true, value };
}

const getJson = <T>(
  url: string,
  parse: (raw: unknown) => T | null,
  signal?: AbortSignal,
): Promise<ScmFetchResult<T>> => requestJson('GET', url, parse, { signal });

/**
 * The canonical work-tree top of `path`, or the server's reason it is not a
 * project (relative, missing, outside any work tree).
 */
export function fetchScmRepo(path: string): Promise<ScmFetchResult<{ top: string }>> {
  return getJson(`/scm/repo?path=${encodeURIComponent(path)}`, (raw) =>
    isRecord(raw) && typeof raw['top'] === 'string' && raw['top'] !== ''
      ? { top: raw['top'] }
      : null,
  );
}

/** The grouped status of the project at `repo`, its work-tree top. */
export function fetchScmStatus(
  repo: string,
  signal?: AbortSignal,
): Promise<ScmFetchResult<ScmStatus>> {
  return getJson(`/scm/status?repo=${encodeURIComponent(repo)}`, parseStatus, signal);
}

const repoQuery = (repo: string): string => `repo=${encodeURIComponent(repo)}`;

// ── Comments ──────────────────────────────────────────────────────────────────

const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => typeof item === 'string');

const isComment = (v: unknown): v is ScmComment =>
  isRecord(v) &&
  typeof v['id'] === 'string' &&
  typeof v['path'] === 'string' &&
  isScmCommentVersion(v['version']) &&
  isScmCommentSide(v['side']) &&
  typeof v['start'] === 'number' &&
  typeof v['end'] === 'number' &&
  isStringList(v['lines']) &&
  isStringList(v['before']) &&
  isStringList(v['after']) &&
  typeof v['body'] === 'string' &&
  typeof v['createdAt'] === 'number' &&
  typeof v['updatedAt'] === 'number';

/** The list every comments read and write answers, or null when it is not that shape. */
export function parseCommentList(raw: unknown): ScmCommentList | null {
  if (!isRecord(raw) || typeof raw['rev'] !== 'number') return null;
  const list = raw['comments'];
  if (!Array.isArray(list) || !list.every(isComment)) return null;
  return { rev: raw['rev'], comments: list };
}

/** The project's comments and the rev they are at. */
export function fetchScmComments(
  repo: string,
  signal?: AbortSignal,
): Promise<ScmFetchResult<ScmCommentList>> {
  return requestJson('GET', `/scm/comments?${repoQuery(repo)}`, parseCommentList, { signal });
}

export function createScmComment(
  repo: string,
  input: ScmCommentInput,
): Promise<ScmFetchResult<ScmCommentList>> {
  return requestJson('POST', `/scm/comments?${repoQuery(repo)}`, parseCommentList, {
    body: input,
  });
}

export function updateScmComment(
  repo: string,
  id: string,
  patch: ScmCommentPatch,
): Promise<ScmFetchResult<ScmCommentList>> {
  return requestJson(
    'PATCH',
    `/scm/comments?${repoQuery(repo)}&id=${encodeURIComponent(id)}`,
    parseCommentList,
    { body: patch },
  );
}

export function deleteScmComment(
  repo: string,
  id: string,
): Promise<ScmFetchResult<ScmCommentList>> {
  return requestJson(
    'DELETE',
    `/scm/comments?${repoQuery(repo)}&id=${encodeURIComponent(id)}`,
    parseCommentList,
  );
}

// ── Index writes ──────────────────────────────────────────────────────────────

const parseWriteResult = (raw: unknown): ScmWriteResult | null =>
  isRecord(raw) &&
  typeof raw['receiptId'] === 'string' &&
  (raw['status'] === 'staged' || raw['status'] === 'unstaged' || raw['status'] === 'restored')
    ? { receiptId: raw['receiptId'], status: raw['status'] }
    : null;

/** Stage exactly the snapshot `token` names. */
export function stageScmFile(
  repo: string,
  path: string,
  token: string,
): Promise<ScmFetchResult<ScmWriteResult>> {
  return requestJson('POST', `/scm/stage?${repoQuery(repo)}`, parseWriteResult, {
    body: { path, token },
  });
}

/** Return `path` (and the source of a rename) to what HEAD holds. */
export function unstageScmFile(
  repo: string,
  path: string,
  oldPath?: string,
): Promise<ScmFetchResult<ScmWriteResult>> {
  return requestJson('POST', `/scm/unstage?${repoQuery(repo)}`, parseWriteResult, {
    body: oldPath === undefined ? { path } : { path, oldPath },
  });
}

/** Undo one of palmux's own writes by the receipt it answered. */
export function restoreScmWrite(
  repo: string,
  receiptId: string,
): Promise<ScmFetchResult<ScmWriteResult>> {
  return requestJson('POST', `/scm/restore?${repoQuery(repo)}`, parseWriteResult, {
    body: { receiptId },
  });
}
