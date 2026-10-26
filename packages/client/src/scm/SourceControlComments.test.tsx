// Copy comments in the Source Control view (`review-comments`: "Comments export as
// one markdown document"): the clipboard receives the document the exporter writes,
// grouped by file, with the outdated ones marked.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScmComment } from '@palmux/shared';
import { commentsStore } from '../review/use-comments';
import { SourceControlView } from './SourceControlView';
import { scmStatusStore } from './status-store';

const APP = '/home/u/work/app';

const reply = (body: unknown, httpStatus = 200) =>
  Promise.resolve({
    ok: httpStatus < 400,
    status: httpStatus,
    json: () => Promise.resolve(body),
  });

const comment = (id: string, path: string, over: Partial<ScmComment> = {}): ScmComment => ({
  id,
  path,
  version: 'worktree',
  side: 'new',
  start: 2,
  end: 2,
  lines: ['TWO'],
  before: ['one'],
  after: ['three'],
  body: `note ${id}`,
  createdAt: Number(id.replace(/\D/g, '')) || 1,
  updatedAt: 1,
  ...over,
});

let comments: ScmComment[];
let files: string[];
let statusEntries: { path: string }[];
const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  comments = [];
  files = [];
  statusEntries = [];
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const u = new URL(url, 'http://palmux');
      if (u.pathname === '/scm/status') {
        return reply({
          top: APP,
          branch: 'main',
          unborn: false,
          merge: [],
          staged: [],
          changes: statusEntries.map((e) => ({ ...e, kind: 'ordinary', status: 'M', fp: e.path })),
          truncated: false,
          tookMs: 1,
          commentsRev: comments.length,
          attrEpoch: 'e',
        });
      }
      if (u.pathname === '/scm/comments') return reply({ rev: comments.length, comments });
      if (u.pathname === '/scm/file') {
        files.push(u.searchParams.get('path') ?? '');
        return reply({
          path: u.searchParams.get('path'),
          group: 'changes',
          algorithm: 'histogram',
          old: { id: 'o', text: 'one\ntwo\n' },
          new: { id: 'n', text: 'one\nTWO\nthree\n' },
          hunks: [],
          binary: false,
          tooLarge: false,
          converted: false,
          unmerged: false,
          modes: {},
          attrs: {},
          version: 'v',
        });
      }
      return reply(null, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  scmStatusStore.setActiveRepo('');
  commentsStore.setActiveRepo('');
  vi.unstubAllGlobals();
});

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 5)));

const Host = ({ onNotice }: { onNotice?: (message: string) => void }) => {
  useEffect(() => {
    scmStatusStore.setActiveRepo(APP);
    commentsStore.setActiveRepo(APP);
  }, []);
  return (
    <SourceControlView
      repos={[APP]}
      activeRepo={APP}
      visible
      onChange={() => {}}
      onOpenFile={() => {}}
      onNotice={onNotice}
    />
  );
};

async function mount(onNotice = vi.fn<(message: string) => void>()) {
  render(<Host onNotice={onNotice} />);
  await settle();
  return onNotice;
}

const copy = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('scm-copy-comments'));
  });
  await settle();
};

describe('Copy comments', () => {
  it('is disabled while the project has no comments, and says why', async () => {
    await mount();
    const button = screen.getByTestId('scm-copy-comments');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'No comments to copy');
    fireEvent.click(button);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('puts three comments in two files on the clipboard as one document', async () => {
    statusEntries = [{ path: 'a.ts' }, { path: 'b.ts' }];
    comments = [
      comment('c1', 'b.ts', { body: 'first of b' }),
      comment('c2', 'a.ts', { body: 'first of a' }),
      comment('c3', 'a.ts', {
        start: 3,
        end: 3,
        lines: ['three'],
        before: ['TWO'],
        after: [],
        body: 'second of a',
      }),
    ];
    const notice = await mount();
    expect(screen.getByTestId('scm-copy-comments')).toBeEnabled();
    expect(screen.getByTestId('scm-copy-comments')).toHaveAttribute(
      'title',
      'Copy 3 comments as markdown',
    );
    await copy();

    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0]?.[0] ?? '';
    // Two file sections, in path order; three quoted blocks; the three texts.
    expect([...text.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(['a.ts', 'b.ts']);
    expect(text.match(/^```typescript$/gm)).toHaveLength(3);
    for (const body of ['first of a', 'second of a', 'first of b']) expect(text).toContain(body);
    expect(text.indexOf('first of a')).toBeLessThan(text.indexOf('second of a'));
    expect(text.indexOf('second of a')).toBeLessThan(text.indexOf('first of b'));
    expect(text).toContain('**L2** (new)');
    expect(notice).toHaveBeenCalledWith('Copied 3 comments');
  });

  it('says "1 comment" for one', async () => {
    statusEntries = [{ path: 'a.ts' }];
    comments = [comment('c1', 'a.ts')];
    const notice = await mount();
    await copy();
    expect(notice).toHaveBeenCalledWith('Copied 1 comment');
  });

  it('marks a comment whose code is gone as outdated, and includes it', async () => {
    statusEntries = [{ path: 'a.ts' }];
    comments = [
      comment('c1', 'a.ts'),
      comment('c2', 'a.ts', {
        lines: ['deleted line'],
        start: 20,
        end: 20,
        body: 'about deleted code',
      }),
    ];
    await mount();
    await copy();
    const text = writeText.mock.calls[0]?.[0] ?? '';
    expect(text).toMatch(/\*\*L20\*\* \(new\) \(outdated\)/);
    expect(text).toContain('deleted line');
    expect(text).toContain('about deleted code');
    expect(text).toMatch(/\*\*L2\*\* \(new\)\n/);
  });

  it('reads only the files that have comments, once each', async () => {
    statusEntries = [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'quiet.ts' }];
    comments = [comment('c1', 'a.ts'), comment('c2', 'a.ts'), comment('c3', 'b.ts')];
    await mount();
    await copy();
    expect(files.toSorted()).toEqual(['a.ts', 'b.ts']);
  });

  it('says when the clipboard refused it', async () => {
    statusEntries = [{ path: 'a.ts' }];
    comments = [comment('c1', 'a.ts')];
    writeText.mockRejectedValue(new Error('denied'));
    const notice = await mount();
    await copy();
    expect(notice).toHaveBeenCalledWith('Could not copy the comments');
  });

  it('is busy while it works, and cannot be started twice', async () => {
    statusEntries = [{ path: 'a.ts' }];
    comments = [comment('c1', 'a.ts')];
    await mount();
    const button = screen.getByTestId('scm-copy-comments');
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await settle();
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});

// WebKit honours a clipboard write only inside the tap, and the document needs a read
// per commented file first. Where `ClipboardItem` exists the write is asked for in the
// tap itself and handed the document as a promise; `writeText` is the fallback.
describe('Copy comments with a ClipboardItem', () => {
  class FakeClipboardItem {
    constructor(readonly items: Record<string, Promise<Blob>>) {}
  }
  const write = vi.fn<(items: FakeClipboardItem[]) => Promise<void>>();

  beforeEach(() => {
    write.mockReset();
    write.mockResolvedValue(undefined);
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    Object.defineProperty(navigator, 'clipboard', {
      value: { write, writeText },
      configurable: true,
    });
  });

  const written = async (): Promise<string> => {
    const item = write.mock.calls[0]?.[0]?.[0];
    const blob = await item?.items['text/plain'];
    expect(blob?.type).toBe('text/plain');
    return (await blob?.text()) ?? '';
  };

  it('asks for the write inside the tap and hands it the whole document', async () => {
    statusEntries = [{ path: 'a.ts' }];
    comments = [
      comment('c1', 'a.ts', { body: 'kept' }),
      comment('c2', 'a.ts', { lines: ['deleted line'], start: 20, end: 20, body: 'gone' }),
    ];
    const notice = await mount();
    act(() => {
      fireEvent.click(screen.getByTestId('scm-copy-comments'));
    });
    // Synchronously, in the click's own task: no file read has answered yet.
    expect(write).toHaveBeenCalledTimes(1);
    await settle();

    const text = await written();
    expect(text).toContain('## a.ts');
    expect(text).toContain('kept');
    expect(text).toMatch(/\*\*L20\*\* \(new\) \(outdated\)/);
    expect(files).toEqual(['a.ts']);
    expect(writeText).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith('Copied 2 comments');
  });

  it('falls back to writeText with the finished document when the write is refused', async () => {
    statusEntries = [{ path: 'a.ts' }];
    comments = [comment('c1', 'a.ts', { body: 'kept' })];
    write.mockRejectedValue(new Error('denied'));
    const notice = await mount();
    await copy();
    expect(write).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toContain('kept');
    expect(notice).toHaveBeenCalledWith('Copied 1 comment');
  });

  it('uses writeText when the browser has no ClipboardItem', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    statusEntries = [{ path: 'a.ts' }];
    comments = [comment('c1', 'a.ts', { body: 'kept' })];
    const notice = await mount();
    await copy();
    expect(write).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toContain('kept');
    expect(notice).toHaveBeenCalledWith('Copied 1 comment');
  });
});
