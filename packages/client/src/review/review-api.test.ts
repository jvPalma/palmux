import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScmFileSnapshot } from '@palmux/shared';
import { fetchScmFile, isSnapshot, ScmFileError, scmFileUrl } from './review-api';

afterEach(() => vi.unstubAllGlobals());

const snapshot = (): ScmFileSnapshot => ({
  path: 'a.ts',
  group: 'changes',
  algorithm: 'histogram',
  old: { id: 'o', text: 'a\n' },
  new: { id: 'n', text: 'b\n' },
  hunks: [],
  binary: false,
  tooLarge: false,
  converted: false,
  unmerged: false,
  modes: {},
  attrs: {},
  version: 'v1',
});

const answer = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

describe('scmFileUrl', () => {
  it('names the repo, group, path and algorithm, and the old path of a rename', () => {
    const url = scmFileUrl('/work/app', 'staged', {
      path: 'src/b.ts',
      oldPath: 'src/a.ts',
      algorithm: 'patience',
    });
    expect(url).toBe(
      '/scm/file?repo=%2Fwork%2Fapp&group=staged&path=src%2Fb.ts&oldPath=src%2Fa.ts&algorithm=patience',
    );
  });

  it('sends a path exactly as given: a trailing space and pattern characters are part of the name', () => {
    const url = scmFileUrl('/work/app', 'changes', { path: 'a*.ts ', algorithm: 'myers' });
    expect(url).toContain('path=a*.ts%20&');
    expect(url).not.toContain('oldPath');
  });
});

describe('fetchScmFile', () => {
  it('answers the snapshot', async () => {
    const fetch = vi.fn(() => answer(snapshot()));
    vi.stubGlobal('fetch', fetch);
    const got = await fetchScmFile(
      '/work/app',
      'changes',
      { path: 'a.ts', algorithm: 'histogram' },
      new AbortController().signal,
    );
    expect(got.version).toBe('v1');
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/scm/file?repo='), {
      credentials: 'same-origin',
      signal: expect.any(AbortSignal),
    });
  });

  it('throws the server’s own reason with its status and code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => answer({ error: 'path is outside the repository', code: 'unsupported' }, 400)),
    );
    const error = await fetchScmFile(
      '/r',
      'changes',
      { path: '../x', algorithm: 'histogram' },
      new AbortController().signal,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScmFileError);
    expect(error).toMatchObject({
      message: 'path is outside the repository',
      httpStatus: 400,
      code: 'unsupported',
    });
  });

  it('falls back to the HTTP status when the body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new Error('x')) }),
      ),
    );
    await expect(
      fetchScmFile(
        '/r',
        'changes',
        { path: 'a', algorithm: 'histogram' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ message: 'HTTP 502', httpStatus: 502 });
  });

  it('rejects an answer that is not a snapshot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => answer({ hunks: 'no' })),
    );
    await expect(
      fetchScmFile(
        '/r',
        'changes',
        { path: 'a', algorithm: 'histogram' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ message: 'Unexpected answer from the server' });
  });

  it('reports an unreachable server, but lets a deliberate abort through as it was', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    await expect(
      fetchScmFile('/r', 'changes', { path: 'a', algorithm: 'histogram' }, controller.signal),
    ).rejects.toMatchObject({ message: 'Cannot reach palmux', httpStatus: 0 });

    controller.abort();
    const aborted = new DOMException('aborted', 'AbortError');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(aborted)),
    );
    await expect(
      fetchScmFile('/r', 'changes', { path: 'a', algorithm: 'histogram' }, controller.signal),
    ).rejects.toBe(aborted);
  });
});

describe('isSnapshot', () => {
  it('accepts the wire shape and nothing less', () => {
    expect(isSnapshot(snapshot())).toBe(true);
    for (const key of ['path', 'version', 'old', 'new', 'hunks', 'binary', 'modes'] as const) {
      const broken: Record<string, unknown> = { ...snapshot() };
      delete broken[key];
      expect(isSnapshot(broken), key).toBe(false);
    }
    expect(isSnapshot(null)).toBe(false);
    expect(isSnapshot('x')).toBe(false);
  });
});
