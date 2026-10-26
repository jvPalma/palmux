import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScmCommentInput, ScmEntry, ScmStatus } from '@palmux/shared';
import {
  createScmComment,
  deleteScmComment,
  fetchScmComments,
  fetchScmRepo,
  fetchScmStatus,
  parseCommentList,
  parseStatus,
  restoreScmWrite,
  stageScmFile,
  unstageScmFile,
  updateScmComment,
} from './scm-api';

const entry = (path: string, over: Partial<ScmEntry> = {}): ScmEntry => ({
  path,
  kind: 'ordinary',
  status: 'M',
  fp: `fp-${path}`,
  ...over,
});

const status = (over: Partial<ScmStatus> = {}): ScmStatus => ({
  top: '/work/app',
  branch: 'main',
  unborn: false,
  merge: [],
  staged: [],
  changes: [],
  truncated: false,
  tookMs: 10,
  commentsRev: 0,
  attrEpoch: 'e0',
  ...over,
});

const reply = (body: unknown, httpStatus = 200) =>
  Promise.resolve({
    ok: httpStatus >= 200 && httpStatus < 300,
    status: httpStatus,
    json: () => Promise.resolve(body),
  });

const stubFetch = (impl: (url: string, init?: RequestInit) => Promise<unknown>) => {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchScmRepo', () => {
  it('sends the path exactly as given, encoded, with the cookie', async () => {
    const fn = stubFetch(() => reply({ top: '/work/app' }));
    await fetchScmRepo('/work/my app /src');
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/scm/repo?path=%2Fwork%2Fmy%20app%20%2Fsrc');
    expect(init.credentials).toBe('same-origin');
  });

  it('answers the canonical top', async () => {
    stubFetch(() => reply({ top: '/work/app' }));
    expect(await fetchScmRepo('/work/app/src')).toEqual({ ok: true, value: { top: '/work/app' } });
  });

  it('carries the server’s reason for a refusal, status included', async () => {
    stubFetch(() => reply({ error: 'path is not a git repository' }, 400));
    expect(await fetchScmRepo('/tmp')).toEqual({
      ok: false,
      message: 'path is not a git repository',
      httpStatus: 400,
    });
  });

  it('falls back to the HTTP status when the refusal has no message', async () => {
    stubFetch(() =>
      Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new Error('x')) }),
    );
    expect(await fetchScmRepo('/tmp')).toMatchObject({ ok: false, message: 'HTTP 502' });
  });

  it('refuses an answer with no top rather than adding an empty project', async () => {
    stubFetch(() => reply({}));
    expect(await fetchScmRepo('/work/app')).toMatchObject({ ok: false });
    stubFetch(() => reply({ top: '' }));
    expect(await fetchScmRepo('/work/app')).toMatchObject({ ok: false });
  });

  it('reads a network failure as no answer, never as a throw', async () => {
    stubFetch(() => Promise.reject(new TypeError('offline')));
    expect(await fetchScmRepo('/work/app')).toEqual({
      ok: false,
      message: 'Cannot reach palmux',
      httpStatus: 0,
    });
  });
});

describe('fetchScmStatus', () => {
  it('asks for the repo by its top, forwarding the abort signal', async () => {
    const fn = stubFetch(() => reply(status()));
    const ctrl = new AbortController();
    await fetchScmStatus('/work/app', ctrl.signal);
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/scm/status?repo=%2Fwork%2Fapp');
    expect(init.signal).toBe(ctrl.signal);
  });

  it('answers the status as sent', async () => {
    const s = status({ changes: [entry('a.ts')], tookMs: 42 });
    stubFetch(() => reply(s));
    expect(await fetchScmStatus('/work/app')).toEqual({ ok: true, value: s });
  });

  it('keeps a machine-readable code beside the message', async () => {
    stubFetch(() => reply({ error: 'repo is busy', code: 'busy' }, 409));
    expect(await fetchScmStatus('/work/app')).toEqual({
      ok: false,
      message: 'repo is busy',
      httpStatus: 409,
      code: 'busy',
    });
  });

  it('refuses a body that is not a status', async () => {
    for (const body of [null, 'x', { top: '/a' }, { ...status(), staged: 'no' }, { top: 3 }]) {
      stubFetch(() => reply(body));
      expect(await fetchScmStatus('/work/app'), JSON.stringify(body)).toMatchObject({
        ok: false,
        message: 'Unexpected answer from the server',
      });
    }
  });

  it('reads a network failure as no answer', async () => {
    stubFetch(() => Promise.reject(new TypeError('offline')));
    expect(await fetchScmStatus('/work/app')).toMatchObject({ ok: false, httpStatus: 0 });
  });
});

describe('parseStatus', () => {
  it('accepts a status whose three groups hold well-formed entries', () => {
    const s = status({ merge: [entry('m.ts', { kind: 'unmerged', status: 'U' })] });
    expect(parseStatus(s)).toBe(s);
  });

  it('rejects an entry with no fingerprint', () => {
    const bad = { ...status(), changes: [{ path: 'a.ts', kind: 'ordinary', status: 'M' }] };
    expect(parseStatus(bad)).toBeNull();
  });
});

const comment = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  path: 'src/a.ts',
  version: 'worktree',
  side: 'new',
  start: 10,
  end: 11,
  lines: ['one', 'two'],
  before: ['zero'],
  after: [],
  body: 'rename this',
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const input: ScmCommentInput = {
  path: 'src/a.ts',
  version: 'worktree',
  side: 'new',
  start: 10,
  end: 11,
  lines: ['one', 'two'],
  before: ['zero'],
  after: [],
  body: 'rename this',
};

describe('the comment requests', () => {
  it('reads the list by project, and answers it as sent', async () => {
    const list = { rev: 4, comments: [comment()] };
    const fn = stubFetch(() => reply(list));
    expect(await fetchScmComments('/work/my app')).toEqual({ ok: true, value: list });
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/scm/comments?repo=%2Fwork%2Fmy%20app');
    expect(init.method).toBeUndefined();
    expect(init.credentials).toBe('same-origin');
  });

  it('creates with a JSON body and answers the whole list', async () => {
    const list = { rev: 5, comments: [comment()] };
    const fn = stubFetch(() => reply(list));
    expect(await createScmComment('/work/app', input)).toEqual({ ok: true, value: list });
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/scm/comments?repo=%2Fwork%2Fapp');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual(input);
  });

  it('patches and deletes by id, in the query', async () => {
    const fn = stubFetch(() => reply({ rev: 6, comments: [] }));
    await updateScmComment('/work/app', 'c 1', { body: 'x' });
    await deleteScmComment('/work/app', 'c 1');
    const [patchUrl, patch] = fn.mock.calls[0] as [string, RequestInit];
    const [deleteUrl, del] = fn.mock.calls[1] as [string, RequestInit];
    expect(patchUrl).toBe('/scm/comments?repo=%2Fwork%2Fapp&id=c%201');
    expect(patch.method).toBe('PATCH');
    expect(JSON.parse(String(patch.body))).toEqual({ body: 'x' });
    expect(deleteUrl).toBe('/scm/comments?repo=%2Fwork%2Fapp&id=c%201');
    expect(del.method).toBe('DELETE');
    expect(del.body).toBeUndefined();
  });

  it('carries the server’s reason for a refused write', async () => {
    stubFetch(() => reply({ error: 'body is too long' }, 400));
    expect(await createScmComment('/work/app', input)).toEqual({
      ok: false,
      message: 'body is too long',
      httpStatus: 400,
    });
  });

  it('refuses a list with a malformed comment or no rev', () => {
    expect(parseCommentList({ rev: 1, comments: [comment({ side: 'middle' })] })).toBeNull();
    expect(parseCommentList({ rev: 1, comments: [comment({ lines: 'x' })] })).toBeNull();
    expect(parseCommentList({ comments: [] })).toBeNull();
    expect(parseCommentList(null)).toBeNull();
    expect(parseCommentList({ rev: 2, comments: [comment()] })).toEqual({
      rev: 2,
      comments: [comment()],
    });
  });
});

describe('the index writes', () => {
  it('stages the snapshot a token names, by path, in the body', async () => {
    const fn = stubFetch(() => reply({ receiptId: 'r1', status: 'staged' }));
    expect(await stageScmFile('/work/app', 'src/a ', 'tok')).toEqual({
      ok: true,
      value: { receiptId: 'r1', status: 'staged' },
    });
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/scm/stage?repo=%2Fwork%2Fapp');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ path: 'src/a ', token: 'tok' });
  });

  it('unstages with the rename source only when there is one', async () => {
    const fn = stubFetch(() => reply({ receiptId: 'r2', status: 'unstaged' }));
    await unstageScmFile('/work/app', 'b.ts');
    await unstageScmFile('/work/app', 'b.ts', 'a.ts');
    expect(JSON.parse(String((fn.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
      path: 'b.ts',
    });
    expect(JSON.parse(String((fn.mock.calls[1] as [string, RequestInit])[1].body))).toEqual({
      path: 'b.ts',
      oldPath: 'a.ts',
    });
    expect((fn.mock.calls[0] as [string])[0]).toBe('/scm/unstage?repo=%2Fwork%2Fapp');
  });

  it('restores by receipt', async () => {
    const fn = stubFetch(() => reply({ receiptId: 'r3', status: 'restored' }));
    expect(await restoreScmWrite('/work/app', 'r2')).toMatchObject({ ok: true });
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/scm/restore?repo=%2Fwork%2Fapp');
    expect(JSON.parse(String(init.body))).toEqual({ receiptId: 'r2' });
  });

  it.each([
    [409, 'busy'],
    [409, 'conflict'],
    [409, 'changed'],
    [410, 'token'],
    [501, 'unsupported'],
    [409, 'df'],
  ] as const)(
    'keeps the %i %s code, so the review can tell the refusals apart',
    async (status, code) => {
      stubFetch(() => reply({ error: 'refused', code }, status));
      expect(await stageScmFile('/work/app', 'a.ts', 't')).toEqual({
        ok: false,
        message: 'refused',
        httpStatus: status,
        code,
      });
    },
  );

  it('refuses an answer that is not a write result', async () => {
    stubFetch(() => reply({ receiptId: 3 }));
    expect(await stageScmFile('/work/app', 'a.ts', 't')).toMatchObject({
      ok: false,
      message: 'Unexpected answer from the server',
    });
  });
});
