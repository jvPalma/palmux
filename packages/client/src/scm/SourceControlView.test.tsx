// The Source Control view, one test per scenario of the `source-control` spec that
// the view itself decides. The server is a stubbed `fetch`; the status store is the
// real one (it is what makes "the list stays live" true), so the live scenarios run
// on fake timers. The host is played by a small harness that keeps the two settings
// the way App does: the project list and this device's selection.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { parse } from 'postcss';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScmEntry, ScmGroup, ScmStatus } from '@palmux/shared';
import userEvent from '@testing-library/user-event';
import { __setIconIndex, type IconIndex } from '../panes/file-icons';
import { undoWrites } from '../review/review-writes';
import { recordWrite, resetWriteLog } from '../review/write-log';
import { DEFAULTS, saveSettings } from '../settings/settings';
import {
  LONG_GROUP_ROWS,
  SourceControlView,
  type ScmOpenTarget,
  type ScmProjectChange,
} from './SourceControlView';
import { DISCARD_UNDO_MS, readLastDiscard, recordDiscard } from './discard-log';
import { restoreScmWrite } from './scm-api';
import { scmStatusStore } from './status-store';

const APP = '/home/u/work/app';
const LIB = '/home/u/work/lib';

const entry = (path: string, over: Partial<ScmEntry> = {}): ScmEntry => ({
  path,
  kind: 'ordinary',
  status: 'M',
  fp: `fp-${path}`,
  ...over,
});

const status = (over: Partial<ScmStatus> = {}): ScmStatus => ({
  top: APP,
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

interface Server {
  /** What `/scm/status?repo=` answers for a project. */
  status: (repo: string) => { body: unknown; httpStatus?: number };
  /** What `/scm/repo?path=` answers for a typed path. */
  repo: (path: string) => { body: unknown; httpStatus?: number };
  /** What a POST to another `/scm/` route answers (stage-paths, unstage-paths, discard, restore). */
  write: (route: string, body: Record<string, unknown>) => { body: unknown; httpStatus?: number };
}

/** The POSTs the view made: the route and the JSON body. */
const posts = (): { route: string; body: Record<string, unknown> }[] =>
  (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([url, init]) => ({
      route: new URL(String(url), 'http://palmux').pathname,
      body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
    }));

const calls = (prefix: string): string[] =>
  (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.startsWith(prefix));

function stubServer(server: Partial<Server> = {}) {
  const handlers: Server = {
    status: (repo) => ({ body: status({ top: repo }) }),
    repo: (path) => ({ body: { top: path } }),
    write: () => ({ body: { error: 'no such route' }, httpStatus: 404 }),
    ...server,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const u = new URL(url, 'http://palmux');
      if (init?.method === 'POST') {
        const out = handlers.write(u.pathname, JSON.parse(String(init.body)));
        return reply(out.body, out.httpStatus);
      }
      if (u.pathname === '/scm/status') {
        const out = handlers.status(u.searchParams.get('repo') ?? '');
        return reply(out.body, out.httpStatus);
      }
      if (u.pathname === '/scm/repo') {
        const out = handlers.repo(u.searchParams.get('path') ?? '');
        return reply(out.body, out.httpStatus);
      }
      // The file-icon index: not installed here, so rows keep their fallback glyph.
      return reply(null, 404);
    }),
  );
}

interface Harness {
  repos?: string[];
  active?: string;
  visible?: boolean;
  /** The server announced batch writes, so rows offer their actions. */
  batchWrites?: boolean;
}

interface Spies {
  onChange: ReturnType<typeof vi.fn<(change: ScmProjectChange) => void>>;
  onOpenFile: ReturnType<
    typeof vi.fn<(target: ScmOpenTarget, opts?: { preview?: boolean }) => void>
  >;
  onOpenReview: ReturnType<typeof vi.fn<(group: ScmGroup) => void>>;
  onOpenPath: ReturnType<typeof vi.fn<(path: string) => void>>;
  onNotice: ReturnType<typeof vi.fn<(message: string) => void>>;
  onNotify: ReturnType<
    typeof vi.fn<(message: string, action?: { label: string; onClick: () => void }) => void>
  >;
}

/** The host: it owns the two settings and mirrors the active one into the store, as App does. */
const mount = ({ repos = [], active, visible = true, batchWrites }: Harness = {}): Spies => {
  const spies: Spies = {
    onChange: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenReview: vi.fn(),
    onOpenPath: vi.fn(),
    onNotice: vi.fn(),
    onNotify: vi.fn(),
  };
  const Host = () => {
    const [list, setList] = useState(repos);
    const [selected, setSelected] = useState(active ?? repos[0] ?? '');
    useEffect(() => {
      scmStatusStore.setActiveRepo(selected);
    }, [selected]);
    return (
      <SourceControlView
        repos={list}
        activeRepo={selected}
        visible={visible}
        onChange={(change) => {
          spies.onChange(change);
          if (change.scmRepos) setList(change.scmRepos);
          if (change.scmActiveRepo !== undefined) setSelected(change.scmActiveRepo);
        }}
        onOpenFile={spies.onOpenFile}
        onOpenReview={spies.onOpenReview}
        {...(batchWrites === undefined
          ? {}
          : {
              batchWrites,
              onOpenPath: spies.onOpenPath,
              onNotice: spies.onNotice,
              onNotify: spies.onNotify,
            })}
      />
    );
  };
  render(<Host />);
  return spies;
};

const press = (el: Element) => fireEvent.click(el);

/** This device reads its groups as flat lists (the tree is the default). */
const asList = () => saveSettings({ ...DEFAULTS, scmTree: false });

/** Let the first status read land inside `act`, so a sync test leaves nothing in flight. */
const settle = () =>
  act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((resolve) => setTimeout(resolve, 0));
  });

const rowPaths = (group: string): string[] =>
  [...screen.getByTestId(`scm-group-${group}`).querySelectorAll('.scm-row')].map(
    (row) => row.getAttribute('data-testid')?.replace(`scm-row-${group}:`, '') ?? '',
  );

const groupOrder = (): string[] =>
  [...document.querySelectorAll('[data-testid^="scm-group-"]')]
    .map((el) => el.getAttribute('data-testid') ?? '')
    .filter((id) => /^scm-group-(merge|staged|changes)$/.test(id));

beforeEach(() => {
  localStorage.clear();
  // The write log is the window's, module-wide by design: no test inherits another's writes.
  resetWriteLog();
  // A tap marks its gesture in module state; a key press clears it, so no test inherits it.
  fireEvent.keyDown(document, { key: 'Shift' });
});

afterEach(async () => {
  // A switch or a removal starts a read of the next project; let it land inside `act`.
  await settle();
  cleanup();
  scmStatusStore.setActiveRepo('');
  __setIconIndex(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('The view starts with no project', () => {
  it('shows an empty state with an Add project control and runs no git command', async () => {
    stubServer();
    mount();
    expect(screen.getByTestId('scm-empty')).toBeInTheDocument();
    expect(screen.getByTestId('scm-add-project')).toHaveTextContent('Add project');
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(calls('/scm/')).toEqual([]);
  });

  it('opens the path form from the empty state', () => {
    stubServer();
    mount();
    press(screen.getByTestId('scm-add-project'));
    expect(screen.getByTestId('scm-add-form')).toBeInTheDocument();
    expect(screen.getByTestId('scm-add-input')).toHaveFocus();
    expect(screen.queryByTestId('scm-add-project')).toBeNull();
  });
});

describe('A project is accepted only inside a git work tree', () => {
  const type = (value: string) =>
    fireEvent.change(screen.getByTestId('scm-add-input'), { target: { value } });
  const submit = async () => {
    await act(async () => {
      press(screen.getByTestId('scm-add-submit'));
    });
  };

  it('stores the top the server names when a subfolder is added, and makes it active', async () => {
    stubServer({ repo: () => ({ body: { top: APP } }) });
    const { onChange } = mount();
    press(screen.getByTestId('scm-add-project'));
    type(`${APP}/src`);
    await submit();
    expect(calls('/scm/repo')).toEqual([`/scm/repo?path=${encodeURIComponent(`${APP}/src`)}`]);
    expect(onChange).toHaveBeenCalledWith({ scmRepos: [APP], scmActiveRepo: APP });
    // The form closes and the project is on screen.
    expect(screen.queryByTestId('scm-add-form')).toBeNull();
    expect(await screen.findByTestId('scm-bar')).toBeInTheDocument();
  });

  it('adds to the end of an existing list', async () => {
    stubServer({ repo: () => ({ body: { top: LIB } }) });
    const { onChange } = mount({ repos: [APP] });
    press(screen.getByTestId('scm-add'));
    type(LIB);
    await submit();
    expect(onChange).toHaveBeenCalledWith({ scmRepos: [APP, LIB], scmActiveRepo: LIB });
  });

  it('refuses a plain folder with the server’s reason and leaves the list alone', async () => {
    stubServer({
      repo: () => ({ body: { error: 'path is not a git repository' }, httpStatus: 400 }),
    });
    const { onChange } = mount();
    press(screen.getByTestId('scm-add-project'));
    type('/tmp');
    await submit();
    expect(screen.getByTestId('scm-add-note')).toHaveTextContent('path is not a git repository');
    expect(screen.getByTestId('scm-add-note')).toHaveAttribute('role', 'alert');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('scm-empty')).toBeInTheDocument();
  });

  it.each([
    ['a relative path', 'work/app', 'path must be absolute'],
    ['a path that does not exist', '/nope', 'path does not exist'],
  ])('refuses %s with the server’s reason', async (_name, path, reason) => {
    stubServer({ repo: () => ({ body: { error: reason }, httpStatus: 400 }) });
    const { onChange } = mount();
    press(screen.getByTestId('scm-add-project'));
    type(path);
    await submit();
    expect(screen.getByTestId('scm-add-note')).toHaveTextContent(reason);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('sends the path exactly as typed: a trailing space is part of the name', async () => {
    stubServer({ repo: () => ({ body: { error: 'x' }, httpStatus: 400 }) });
    mount();
    press(screen.getByTestId('scm-add-project'));
    type('/work/app ');
    await submit();
    expect(calls('/scm/repo')).toEqual(['/scm/repo?path=%2Fwork%2Fapp%20']);
  });

  it('asks for a path instead of sending a blank one', async () => {
    stubServer();
    const { onChange } = mount();
    press(screen.getByTestId('scm-add-project'));
    type('   ');
    await submit();
    expect(screen.getByTestId('scm-add-note')).toHaveTextContent(/absolute path/i);
    expect(calls('/scm/repo')).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('refuses a paste that carries a line break, and says why', () => {
    stubServer();
    mount();
    press(screen.getByTestId('scm-add-project'));
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
      clipboardData: { getData: () => string };
    };
    paste.clipboardData = { getData: () => '/work/app\n' };
    expect(fireEvent(screen.getByTestId('scm-add-input'), paste)).toBe(false);
    expect(screen.getByTestId('scm-add-note')).toHaveTextContent('line break');
  });

  it('submits on Enter and cancels on Escape', async () => {
    stubServer({ repo: () => ({ body: { top: APP } }) });
    const { onChange } = mount();
    press(screen.getByTestId('scm-add-project'));
    type(APP);
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('scm-add-input'), { key: 'Enter' });
    });
    expect(onChange).toHaveBeenCalledTimes(1);

    press(screen.getByTestId('scm-add'));
    fireEvent.keyDown(screen.getByTestId('scm-add-input'), { key: 'Escape' });
    expect(screen.queryByTestId('scm-add-form')).toBeNull();
  });

  it('holds the form while the server is asked, and clears an old reason as the path changes', async () => {
    let answer: (value: unknown) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.startsWith('/scm/repo')
          ? new Promise((resolve) => {
              answer = resolve;
            })
          : reply(null, 404),
      ),
    );
    mount();
    press(screen.getByTestId('scm-add-project'));
    type(APP);
    await submit();
    expect(screen.getByTestId('scm-add-submit')).toBeDisabled();
    expect(screen.getByTestId('scm-add-submit')).toHaveTextContent('Checking');
    expect(screen.getByTestId('scm-add-input')).toBeDisabled();
    await act(async () => {
      answer({ ok: false, status: 400, json: () => Promise.resolve({ error: 'not a repo' }) });
    });
    expect(screen.getByTestId('scm-add-note')).toHaveTextContent('not a repo');
    type(`${APP}/x`);
    expect(screen.queryByTestId('scm-add-note')).toBeNull();
  });

  it('adds the same project twice as one entry and only makes it active', async () => {
    stubServer({ repo: () => ({ body: { top: APP } }) });
    const { onChange } = mount({ repos: [APP, LIB], active: LIB });
    press(screen.getByTestId('scm-add'));
    type(`${APP}/src`);
    await submit();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ scmActiveRepo: APP });
    expect(onChange.mock.calls[0]?.[0]).not.toHaveProperty('scmRepos');
  });

  it('canonicalises what the server names before comparing it with the list', async () => {
    stubServer({ repo: () => ({ body: { top: `${APP}/./` } }) });
    const { onChange } = mount({ repos: [APP, LIB], active: LIB });
    press(screen.getByTestId('scm-add'));
    type(APP);
    await submit();
    expect(onChange).toHaveBeenCalledWith({ scmActiveRepo: APP });
  });
});

describe('The project list is shared and the selection is per device', () => {
  it('lists every project in the selector and shows the active one', async () => {
    stubServer();
    mount({ repos: [APP, LIB], active: LIB });
    await settle();
    expect(screen.getByTestId('scm-project-select')).toHaveTextContent('lib');
    fireEvent.click(screen.getByTestId('scm-project-select'));
    expect(screen.getByTestId(`scm-project-select-option-${APP}`)).toHaveTextContent('app');
    expect(screen.getByTestId(`scm-project-select-option-${LIB}`)).toHaveTextContent('lib');
  });

  it('switching reports only the selection, never the list', async () => {
    stubServer();
    const { onChange } = mount({ repos: [APP, LIB], active: APP });
    await settle();
    fireEvent.click(screen.getByTestId('scm-project-select'));
    fireEvent.click(screen.getByTestId(`scm-project-select-option-${LIB}`));
    expect(onChange).toHaveBeenCalledWith({ scmActiveRepo: LIB });
    expect(onChange.mock.calls[0]?.[0]).not.toHaveProperty('scmRepos');
    expect(screen.getByTestId('scm-project-select')).toHaveTextContent('lib');
    await settle();
  });

  it('tells two projects with the same folder name apart by their whole path', async () => {
    stubServer();
    mount({ repos: ['/a/app', '/b/app'], active: '/a/app' });
    await settle();
    expect(screen.getByTestId('scm-project-select')).toHaveTextContent('/a/app');
  });

  it('reads the status of the active project only', async () => {
    stubServer();
    mount({ repos: [APP, LIB], active: LIB });
    await screen.findByTestId('scm-branch');
    expect(calls('/scm/status')).toEqual([`/scm/status?repo=${encodeURIComponent(LIB)}`]);
  });

  describe('removing the active project', () => {
    it('hands over to the project that followed it', async () => {
      stubServer();
      const { onChange } = mount({ repos: [APP, LIB, '/home/u/work/zed'], active: LIB });
      await settle();
      press(screen.getByTestId('scm-remove'));
      expect(onChange).toHaveBeenCalledWith({
        scmRepos: [APP, '/home/u/work/zed'],
        scmActiveRepo: '/home/u/work/zed',
      });
      expect(screen.getByTestId('scm-project-select')).toHaveTextContent('zed');
      await settle();
    });

    it('hands over to the one before when the last one goes', async () => {
      stubServer();
      const { onChange } = mount({ repos: [APP, LIB], active: LIB });
      await settle();
      press(screen.getByTestId('scm-remove'));
      expect(onChange).toHaveBeenCalledWith({ scmRepos: [APP], scmActiveRepo: APP });
      await settle();
    });

    it('shows the empty state when none is left', async () => {
      stubServer();
      const { onChange } = mount({ repos: [APP] });
      await settle();
      press(screen.getByTestId('scm-remove'));
      expect(onChange).toHaveBeenCalledWith({ scmRepos: [], scmActiveRepo: '' });
      expect(screen.getByTestId('scm-empty')).toBeInTheDocument();
    });

    it('names the project it removes, and touches nothing on the server', async () => {
      stubServer();
      mount({ repos: [APP, LIB], active: APP });
      await screen.findByTestId('scm-branch');
      expect(screen.getByTestId('scm-remove')).toHaveAttribute('aria-label', 'Remove app');
      const before = calls('/scm/').filter((u) => !u.startsWith('/scm/status'));
      press(screen.getByTestId('scm-remove'));
      expect(calls('/scm/').filter((u) => !u.startsWith('/scm/status'))).toEqual(before);
      await settle();
    });
  });
});

describe('Changes are grouped as Staged Changes and Changes', () => {
  it('lists the two groups with name, directory and status letter, and no other', async () => {
    asList();
    stubServer({
      status: () => ({
        body: status({
          staged: [entry('src/panes/FileTree.tsx'), entry('README.md', { status: 'A' })],
          changes: [entry('src/a.ts'), entry('gone.ts', { status: 'D' })],
        }),
      }),
    });
    mount({ repos: [APP] });
    await screen.findByTestId('scm-group-staged');
    expect(groupOrder()).toEqual(['scm-group-staged', 'scm-group-changes']);
    expect(screen.queryByTestId('scm-group-merge')).toBeNull();

    const tree = screen.getByTestId('scm-row-staged:src/panes/FileTree.tsx');
    expect(within(tree).getByText('FileTree.tsx')).toHaveClass('scm-name');
    expect(within(tree).getByText('src/panes')).toHaveClass('scm-dir');
    expect(within(tree).getByRole('img', { name: 'Modified' })).toHaveTextContent('M');
    // A file at the top of the project has a name and no directory.
    const readme = screen.getByTestId('scm-row-staged:README.md');
    expect(readme.querySelector('.scm-dir')).toBeNull();
    expect(within(readme).getByRole('img', { name: 'Added' })).toHaveTextContent('A');
    expect(
      within(screen.getByTestId('scm-row-changes:gone.ts')).getByRole('img', { name: 'Deleted' }),
    ).toHaveTextContent('D');
    expect(screen.getByTestId('scm-count-staged')).toHaveTextContent('2');
    expect(screen.getByTestId('scm-count-changes')).toHaveTextContent('2');
  });

  it('a file edited after staging appears in both groups', async () => {
    stubServer({
      status: () => ({
        body: status({ staged: [entry('a.ts')], changes: [entry('a.ts')] }),
      }),
    });
    mount({ repos: [APP] });
    await screen.findByTestId('scm-group-staged');
    expect(rowPaths('staged')).toEqual(['a.ts']);
    expect(rowPaths('changes')).toEqual(['a.ts']);
  });

  it('lists the files of an untracked folder individually, each marked untracked', async () => {
    const untracked = ['newdir/one.ts', 'newdir/two.ts', 'newdir/sub/three.ts'].map((path) =>
      entry(path, { kind: 'untracked', status: '?' }),
    );
    stubServer({ status: () => ({ body: status({ changes: untracked }) }) });
    mount({ repos: [APP] });
    await screen.findByTestId('scm-group-changes');
    expect(rowPaths('changes')).toEqual(['newdir/one.ts', 'newdir/two.ts', 'newdir/sub/three.ts']);
    for (const path of rowPaths('changes')) {
      const letter = within(screen.getByTestId(`scm-row-changes:${path}`)).getByRole('img');
      expect(letter).toHaveAttribute('aria-label', 'Untracked');
    }
  });

  it('a repository with no commits lists staged files as added, with no error', async () => {
    stubServer({
      status: () => ({
        body: status({
          unborn: true,
          branch: 'main',
          staged: [entry('first.ts', { status: 'A' })],
        }),
      }),
    });
    mount({ repos: [APP] });
    await screen.findByTestId('scm-group-staged');
    expect(
      within(screen.getByTestId('scm-row-staged:first.ts')).getByRole('img', { name: 'Added' }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('scm-error')).toBeNull();
    expect(screen.getByTestId('scm-branch')).toHaveTextContent('no commits yet');
  });

  it('a renamed file names the path it came from', async () => {
    asList();
    stubServer({
      status: () => ({
        body: status({
          staged: [entry('src/new.ts', { kind: 'rename', status: 'R', oldPath: 'lib/old.ts' })],
        }),
      }),
    });
    mount({ repos: [APP] });
    const row = await screen.findByTestId('scm-row-staged:src/new.ts');
    expect(row).toHaveTextContent('src ← lib/old.ts');
    expect(row).toHaveAttribute('title', 'src/new.ts (renamed from lib/old.ts)');
    expect(within(row).getByRole('img', { name: 'Renamed' })).toBeInTheDocument();
  });

  it('shows the branch of the project, or the short head when none is checked out', async () => {
    stubServer({ status: () => ({ body: status({ branch: 'feature/x' }) }) });
    mount({ repos: [APP] });
    expect(await screen.findByTestId('scm-branch')).toHaveTextContent('feature/x');
    cleanup();
    stubServer({
      status: () => {
        const detached = status({ head: 'abcdef0123456' });
        delete detached.branch;
        return { body: detached };
      },
    });
    mount({ repos: [APP] });
    expect(await screen.findByTestId('scm-branch')).toHaveTextContent('abcdef0');
  });

  it('says so when nothing changed, rather than showing an empty panel', async () => {
    stubServer();
    mount({ repos: [APP] });
    expect(await screen.findByTestId('scm-clean')).toHaveTextContent('No changes');
    expect(groupOrder()).toEqual([]);
  });

  it('says it is loading until the first answer lands', async () => {
    stubServer();
    mount({ repos: [APP] });
    expect(screen.getByTestId('scm-loading')).toBeInTheDocument();
    await screen.findByTestId('scm-clean');
    expect(screen.queryByTestId('scm-loading')).toBeNull();
  });

  it('states that the list was truncated when the server cut it', async () => {
    stubServer({
      status: () => ({ body: status({ truncated: true, changes: [entry('a.ts')] }) }),
    });
    mount({ repos: [APP] });
    expect(await screen.findByTestId('scm-truncated')).toHaveTextContent(/more changes/i);
    expect(rowPaths('changes')).toEqual(['a.ts']);
  });

  it('shows no truncation notice for a complete list', async () => {
    stubServer({ status: () => ({ body: status({ changes: [entry('a.ts')] }) }) });
    mount({ repos: [APP] });
    await screen.findByTestId('scm-group-changes');
    expect(screen.queryByTestId('scm-truncated')).toBeNull();
  });

  it('draws a failed read as an error with Retry, never as an empty list', async () => {
    let healthy = false;
    stubServer({
      status: () =>
        healthy
          ? { body: status({ changes: [entry('back.ts')] }) }
          : { body: { error: 'repo must be the work tree’s top level' }, httpStatus: 400 },
    });
    mount({ repos: [APP] });
    const error = await screen.findByTestId('scm-error');
    expect(error).toHaveTextContent('repo must be the work tree’s top level');
    expect(error).toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('scm-clean')).toBeNull();
    healthy = true;
    await act(async () => {
      press(screen.getByTestId('scm-retry'));
    });
    expect(await screen.findByTestId('scm-row-changes:back.ts')).toBeInTheDocument();
    expect(screen.queryByTestId('scm-error')).toBeNull();
  });

  it('keeps the last list on screen when a later read fails, and says the refresh failed', async () => {
    vi.useFakeTimers();
    let n = 0;
    stubServer({
      status: () => {
        n += 1;
        return n === 1
          ? { body: status({ changes: [entry('kept.ts')] }) }
          : { body: { error: 'timed out' }, httpStatus: 504 };
      },
    });
    mount({ repos: [APP] });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByTestId('scm-row-changes:kept.ts')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByTestId('scm-error')).toHaveTextContent('Could not refresh: timed out');
    expect(screen.getByTestId('scm-row-changes:kept.ts')).toBeInTheDocument();
  });
});

describe('Unmerged files are listed, not hidden', () => {
  it('lists a conflicted file under Merge Changes, above the others, marked conflicted', async () => {
    stubServer({
      status: () => ({
        body: status({
          merge: [entry('a.ts', { kind: 'unmerged', status: 'U' })],
          staged: [entry('b.ts')],
          changes: [entry('c.ts')],
        }),
      }),
    });
    mount({ repos: [APP] });
    await screen.findByTestId('scm-group-merge');
    expect(groupOrder()).toEqual(['scm-group-merge', 'scm-group-staged', 'scm-group-changes']);
    const row = screen.getByTestId('scm-row-merge:a.ts');
    expect(row).toHaveAttribute('data-conflicted', 'true');
    expect(within(row).getByRole('img', { name: 'Conflicted' })).toHaveTextContent('U');
    expect(screen.getByTestId('scm-group-merge')).toHaveTextContent('Merge Changes');
    // No error, and the other groups' rows are not marked.
    expect(screen.queryByTestId('scm-error')).toBeNull();
    expect(screen.getByTestId('scm-row-changes:c.ts')).not.toHaveAttribute('data-conflicted');
  });

  it('opens a conflicted file in the Changes review', async () => {
    stubServer({
      status: () => ({
        body: status({ merge: [entry('a.ts', { kind: 'unmerged', status: 'U' })] }),
      }),
    });
    const { onOpenFile } = mount({ repos: [APP] });
    press(await screen.findByTestId('scm-row-merge:a.ts'));
    expect(onOpenFile).toHaveBeenCalledWith({ group: 'changes', path: 'a.ts' });
  });
});

describe('Opening the whole group', () => {
  it('the header button opens the group’s review and does not toggle the group', async () => {
    stubServer({
      status: () => ({
        body: status({
          merge: [entry('m.ts', { kind: 'unmerged', status: 'U' })],
          staged: [entry('s.ts')],
          changes: [entry('c.ts')],
        }),
      }),
    });
    const { onOpenReview, onOpenFile } = mount({ repos: [APP] });
    const button = await screen.findByTestId('scm-open-review-changes');
    const trigger = screen.getByTestId('scm-group-changes-trigger');
    const before = trigger.getAttribute('data-state');
    expect(trigger.contains(button)).toBe(false);
    press(button);
    expect(onOpenReview).toHaveBeenCalledWith('changes');
    expect(trigger.getAttribute('data-state')).toBe(before);
    press(screen.getByTestId('scm-open-review-staged'));
    expect(onOpenReview).toHaveBeenLastCalledWith('staged');
    // A conflicted file is reviewed in Changes.
    press(screen.getByTestId('scm-open-review-merge'));
    expect(onOpenReview).toHaveBeenLastCalledWith('changes');
    expect(onOpenFile).not.toHaveBeenCalled();
  });
});

describe('Choosing a file', () => {
  const rows = () =>
    stubServer({
      status: () => ({
        body: status({
          staged: [
            entry('s.ts'),
            entry('new.ts', { kind: 'rename', status: 'R', oldPath: 'old.ts' }),
          ],
          changes: [entry('c.ts')],
        }),
      }),
    });

  it('a double-click keeps the file open: the row hands over { preview: false }', async () => {
    rows();
    const { onOpenFile } = mount({ repos: [APP] });
    const row = await screen.findByTestId('scm-row-changes:c.ts');
    fireEvent.click(row, { detail: 1 });
    fireEvent.click(row, { detail: 2 });
    fireEvent.doubleClick(row);
    expect(onOpenFile).toHaveBeenLastCalledWith(
      { group: 'changes', path: 'c.ts' },
      { preview: false },
    );
    expect(onOpenFile.mock.calls[0]).toEqual([{ group: 'changes', path: 'c.ts' }]);
  });

  it('opens the Staged review for a staged file and the Changes review for the rest', async () => {
    rows();
    const { onOpenFile } = mount({ repos: [APP] });
    press(await screen.findByTestId('scm-row-staged:s.ts'));
    expect(onOpenFile).toHaveBeenLastCalledWith({ group: 'staged', path: 's.ts' });
    press(screen.getByTestId('scm-row-changes:c.ts'));
    expect(onOpenFile).toHaveBeenLastCalledWith({ group: 'changes', path: 'c.ts' });
  });

  it('hands over the old path of a rename, and carries no oldPath key otherwise', async () => {
    rows();
    const { onOpenFile } = mount({ repos: [APP] });
    press(await screen.findByTestId('scm-row-staged:new.ts'));
    expect(onOpenFile).toHaveBeenLastCalledWith({
      group: 'staged',
      path: 'new.ts',
      oldPath: 'old.ts',
    });
    press(screen.getByTestId('scm-row-staged:s.ts'));
    expect(onOpenFile.mock.lastCall?.[0]).toStrictEqual({ group: 'staged', path: 's.ts' });
  });

  describe('a row lives in a scroller, so it acts on pointer up and never on a pan', () => {
    const at = (clientY: number) => ({ pointerId: 7, pointerType: 'touch', clientX: 10, clientY });

    it('a tap opens the file, once', async () => {
      rows();
      const { onOpenFile } = mount({ repos: [APP] });
      const row = await screen.findByTestId('scm-row-changes:c.ts');
      fireEvent.pointerDown(row, at(100));
      expect(onOpenFile).not.toHaveBeenCalled();
      fireEvent.pointerUp(row, at(100));
      expect(onOpenFile).toHaveBeenCalledTimes(1);
    });

    it('a pan that starts on a row opens nothing', async () => {
      rows();
      const { onOpenFile } = mount({ repos: [APP] });
      const row = await screen.findByTestId('scm-row-changes:c.ts');
      // The browser's pan is left alone: a touch pointerdown is never cancelled.
      expect(fireEvent.pointerDown(row, at(100))).toBe(true);
      fireEvent.pointerMove(row, at(60));
      fireEvent.pointerUp(row, at(60));
      expect(onOpenFile).not.toHaveBeenCalled();
    });

    it('a press the browser cancels opens nothing', async () => {
      rows();
      const { onOpenFile } = mount({ repos: [APP] });
      const row = await screen.findByTestId('scm-row-changes:c.ts');
      fireEvent.pointerDown(row, at(100));
      fireEvent.pointerCancel(row, at(100));
      fireEvent.pointerUp(row, at(100));
      expect(onOpenFile).not.toHaveBeenCalled();
    });

    it('a keyboard or assistive-tech click still opens the file', async () => {
      rows();
      const { onOpenFile } = mount({ repos: [APP] });
      const row = await screen.findByTestId('scm-row-changes:c.ts');
      expect(row.tagName).toBe('BUTTON');
      press(row);
      expect(onOpenFile).toHaveBeenCalledTimes(1);
    });
  });
});

describe('A long group', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => entry(`dir/file-${String(i).padStart(4, '0')}.ts`));

  it('is plain rows up to the limit: every one is mounted', async () => {
    stubServer({ status: () => ({ body: status({ changes: many(LONG_GROUP_ROWS) }) }) });
    mount({ repos: [APP] });
    await screen.findByTestId('scm-group-changes');
    expect(document.querySelector('.ui-virtual-list')).toBeNull();
    expect(rowPaths('changes')).toHaveLength(LONG_GROUP_ROWS);
  });

  it('goes through the virtual list past it: far fewer rows are mounted than exist', async () => {
    stubServer({
      status: () => ({
        body: status({ changes: many(LONG_GROUP_ROWS + 800), staged: [entry('s.ts')] }),
      }),
    });
    mount({ repos: [APP] });
    await screen.findByTestId('scm-group-changes');
    const list = screen.getByTestId('scm-vlist-changes');
    expect(list).toHaveClass('ui-virtual-list');
    const mounted = list.querySelectorAll('.scm-row').length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(100);
    expect(screen.getByTestId('scm-count-changes')).toHaveTextContent('1000');
    // The short group beside it stays plain.
    expect(screen.getByTestId('scm-group-staged').querySelector('.ui-virtual-list')).toBeNull();
  });

  it('opens the file of a row drawn by the virtual list', async () => {
    stubServer({ status: () => ({ body: status({ changes: many(LONG_GROUP_ROWS + 1) }) }) });
    const { onOpenFile } = mount({ repos: [APP] });
    await screen.findByTestId('scm-vlist-changes');
    press(screen.getByTestId('scm-row-changes:dir/file-0000.ts'));
    expect(onOpenFile).toHaveBeenCalledWith({ group: 'changes', path: 'dir/file-0000.ts' });
  });
});

// happy-dom has no layout, so this is checked where it is written: the kit's bar
// is drawn over the viewport's right edge, which is where the status letters and
// the group counts sit, and the list must keep that strip free.
/** The value `prop` takes under exactly `selector` in a stylesheet beside this file. */
const declared = (file: string, selector: string, prop: string): string | undefined => {
  let value: string | undefined;
  parse(readFileSync(join(__dirname, file), 'utf8')).walkRules((rule) => {
    if (rule.selector !== selector) return;
    rule.walkDecls(prop, (decl) => {
      value = decl.value;
    });
  });
  return value;
};

describe('The scrollbar covers no row', () => {
  it('keeps the bar’s own width free at the right edge of the list, and nothing on a phone', () => {
    const bar = declared('../ui/ui.css', ".ui-scroll-bar[data-orientation='vertical']", 'width');
    expect(bar).toBeDefined();
    expect(declared('scm.css', '.scm-scroll .ui-scroll-content', 'padding-right')).toBe(bar);
    // ui.css draws no bar under the mobile class, so the strip would be wasted there.
    expect(declared('../ui/ui.css', ":root[data-mobile='true'] .ui-scroll-bar", 'display')).toBe(
      'none',
    );
    expect(
      declared(
        'scm.css',
        ":root[data-mobile='true'] .scm-scroll .ui-scroll-content",
        'padding-right',
      ),
    ).toBe('0');
  });
});

// The owner (2026-10-26) found the changed-files list too large on a phone: 36px rows, a
// 12px indent per level, and found it still too large at 32px: a row is 24px now, with no
// gap between rows. The desktop followed (scm-row-actions D1): the same 24px row and 8px
// indent from its own 28px control height. happy-dom has no layout, so the metrics are read
// where they are written, and resolved the way a browser would.
describe('The changed-files list is compact', () => {
  const sheet = readFileSync(join(__dirname, 'scm.css'), 'utf8');
  const index = readFileSync(join(__dirname, '../index.css'), 'utf8');
  /** Declarations of every rule that has `selector` among its selectors. */
  const decls = (selector: string): Map<string, string> => {
    const held = new Map<string, string>();
    parse(sheet).walkRules((rule) => {
      if (!rule.selectors.some((s) => s.replace(/\s+/g, ' ').trim() === selector)) return;
      rule.walkDecls((d) => void held.set(d.prop, d.value.replace(/\s+/g, ' ').trim()));
    });
    return held;
  };
  const MOBILE = ":root[data-mobile='true'] .scm-view";
  const scale = (name: string): number => {
    const value = new RegExp(`${name}:\\s*(\\d+)px`).exec(index)?.[1];
    if (value === undefined) throw new Error(`no ${name}`);
    return Number(value);
  };
  const DESKTOP_CTL = scale('--ctl-h');
  const PHONE_CTL = Number(
    /:root\[data-mobile='true'\]\s*{[^}]*--ctl-h:\s*(\d+)px/.exec(index)?.[1],
  );

  it('sizes a row, an indent step and the gap in a row from three properties, set once', () => {
    const rows = decls('.scm-row');
    expect(rows.get('height')).toBe('var(--scm-row-h)');
    expect(rows.get('gap')).toBe('var(--scm-gap)');
    expect(rows.get('padding')).toBe(
      '0 var(--sp-2) 0 calc(var(--sp-2) + var(--depth, 0) * var(--scm-indent))',
    );
    // A folder is the same row, and so is a long group's height cap.
    expect(decls('.scm-folder').get('height')).toBe('var(--scm-row-h)');
    expect(decls('.scm-vlist').get('height')).toBe(
      'min(60vh, calc(var(--scm-rows, 1000) * var(--scm-row-h)))',
    );
    expect(sheet).not.toMatch(/height:\s*var\(--ctl-h\)/);
  });

  it('draws a row 24px tall on a desktop, 8px a level, 4px between parts', () => {
    const own = decls('.scm-view');
    expect(own.get('--scm-row-h')).toBe('calc(var(--ctl-h) - var(--sp-1))');
    expect(own.get('--scm-indent')).toBe('var(--sp-2)');
    expect(own.get('--scm-gap')).toBe('var(--sp-1)');
    expect(DESKTOP_CTL - scale('--sp-1')).toBe(24);
    expect(scale('--sp-2')).toBe(8);
  });

  it('draws a row 24px tall on a phone, well under the extra-keys bar’s own key', () => {
    const phone = decls(MOBILE);
    expect(phone.get('--scm-row-h')).toBe('calc(var(--ctl-h) - var(--sp-3))');
    expect(PHONE_CTL - scale('--sp-3')).toBe(24);
    // The contract is at most 32px; the owner asked for 24.
    expect(PHONE_CTL - scale('--sp-3')).toBeLessThanOrEqual(32);
  });

  it('follows one row with the next: no margin on a row, no gap or padding between rows', () => {
    for (const selector of ['.scm-row', '.scm-folder']) {
      const row = decls(selector);
      for (const prop of ['margin', 'margin-block', 'margin-top', 'margin-bottom']) {
        expect(row.get(prop), `${selector} ${prop}`).toBeUndefined();
      }
    }
    // The rows' containers add nothing: the plain list is unstyled, and the virtual one only caps its height.
    expect(decls('.scm-rows').size).toBe(0);
    expect([...decls('.scm-vlist').keys()]).toEqual(['height']);
    // So the pitch is the row's height: 24px a row on a phone, where it was 32px.
    expect(decls('.scm-row').get('height')).toBe('var(--scm-row-h)');
  });

  it('indents a level by 8px on a phone, where it was 12px, and sits the parts 4px apart', () => {
    const phone = decls(MOBILE);
    expect(phone.get('--scm-indent')).toBe('var(--sp-2)');
    expect(phone.get('--scm-gap')).toBe('var(--sp-1)');
    const level = scale('--sp-2');
    expect(level).toBe(8);
    expect(level).toBeLessThan(scale('--sp-3'));
    // The four-level path of the owner’s screenshot (packages/client/src/mobile): the
    // name starts 16px further left, and a long name is not what the indent truncates.
    const before = scale('--sp-2') + 4 * scale('--sp-3');
    const after = scale('--sp-2') + 4 * level;
    expect(before - after).toBe(16);
    // The drawer’s 275.5px row (390px, three quarters of it, less the border and padding),
    // less the indent, a 16px chevron, a 16px glyph, the 16px status letter, the parts’ gaps
    // and the row’s right padding: room for ~24 characters at the 4-level depth.
    const room = 275.5 - after - 16 - 16 - 16 - 4 * scale('--sp-1') - scale('--sp-2');
    expect(room).toBeGreaterThanOrEqual(24 * 6);
  });

  it('sets a row’s text at the body size, 12px, and the group header at the section-title size', () => {
    expect(decls('.scm-view').get('font-size')).toBe('var(--fs-2)');
    expect(decls('.scm-row').get('font')).toBe('inherit');
    expect(scale('--fs-2')).toBeLessThanOrEqual(13);
    expect(decls('.scm-folder-count').get('font-size')).toBe('var(--fs-1)');
    expect(decls('.scm-letter').get('font-size')).toBe('var(--fs-1)');
  });

  it('declares the phone’s sizes under the attribute, never a media query or `--ctl-h` itself', () => {
    let inMedia = 0;
    parse(sheet).walkAtRules('media', (at) => {
      at.walkDecls(/^--scm-/, () => void (inMedia += 1));
    });
    expect(inMedia).toBe(0);
    expect(decls(MOBILE).has('--ctl-h')).toBe(false);
    expect(sheet).not.toMatch(/--ctl-h:/);
  });

  // A group header is the kit's Collapsible trigger, and no consumer sheet may size a kit
  // control (scale.test.ts), so on a phone the view puts it on the kit's own extra-small step.
  describe('the group headers', () => {
    const kit = readFileSync(join(__dirname, '../ui/ui.css'), 'utf8');
    /** `min-height` for an element with these classes: the last top-level rule naming one wins. */
    const minHeight = (classes: string[]): string | undefined => {
      let won: string | undefined;
      parse(kit).walkRules((rule) => {
        if (rule.parent?.type !== 'root') return;
        if (!rule.selectors.some((s) => classes.some((c) => s.trim() === `.${c}`))) return;
        rule.walkDecls('min-height', (d) => void (won = d.value.replace(/\s+/g, ' ').trim()));
      });
      return won;
    };
    const header = () => screen.findByTestId('scm-group-changes-trigger');
    const withChanges = () =>
      stubServer({ status: () => ({ body: status({ changes: [entry('a/b.ts')] }) }) });

    /** The view follows the attribute through a MutationObserver, so its re-render lands
     *  in `act` only once the observer's callback has run. */
    const mobileLayer = (on: boolean) =>
      act(async () => {
        if (on) document.documentElement.dataset.mobile = 'true';
        else document.documentElement.removeAttribute('data-mobile');
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

    afterEach(() => mobileLayer(false));

    it('are no taller than the rows on a phone: the kit’s extra-small step, 24px', async () => {
      document.documentElement.dataset.mobile = 'true';
      withChanges();
      mount({ repos: [APP] });
      const trigger = await header();
      expect(trigger).toHaveClass('ui-collapsible-trigger', 'ui-collapsible-trigger-xs');
      const height = minHeight([...trigger.classList]);
      expect(height).toBe('calc(var(--ctl-h) - var(--sp-3))');
      expect(height).toBe(decls(MOBILE).get('--scm-row-h'));
      expect(PHONE_CTL - scale('--sp-3')).toBe(24);
    });

    it('are the kit’s small step on a desktop, 24px, which is the rows’ height there', async () => {
      withChanges();
      mount({ repos: [APP] });
      const trigger = await header();
      expect(trigger).toHaveClass('ui-collapsible-trigger', 'ui-collapsible-trigger-sm');
      expect(trigger).not.toHaveClass('ui-collapsible-trigger-xs');
      const height = minHeight([...trigger.classList]);
      expect(height).toBe('calc(var(--ctl-h) - var(--sp-1))');
      expect(height).toBe(decls('.scm-view').get('--scm-row-h'));
      expect(DESKTOP_CTL - scale('--sp-1')).toBe(24);
    });

    // The header is a flex row: a button in its actions slot taller than the trigger
    // makes the whole header that tall (measured: 32px on a 390px phone before this).
    it('hold an Open review button no taller than the header, on a phone and on a desktop', async () => {
      const height = (classes: string[]): string | undefined => {
        let won: string | undefined;
        parse(kit).walkRules((rule) => {
          if (rule.parent?.type !== 'root') return;
          if (!rule.selectors.some((s) => classes.some((c) => s.trim() === `.${c}`))) return;
          rule.walkDecls('height', (d) => void (won = d.value.replace(/\s+/g, ' ').trim()));
        });
        return won;
      };
      withChanges();
      mount({ repos: [APP] });
      const trigger = await header();
      const button = screen.getByTestId('scm-open-review-changes');
      expect(height([...button.classList])).toBe(minHeight([...trigger.classList]));
      await mobileLayer(true);
      expect(button).toHaveClass('ui-icon-btn-xs');
      expect(height([...button.classList])).toBe('calc(var(--ctl-h) - var(--sp-3))');
      expect(height([...button.classList])).toBe(minHeight([...trigger.classList]));
    });

    it('follow the mobile layer as it turns on and off', async () => {
      withChanges();
      mount({ repos: [APP] });
      const trigger = await header();
      await mobileLayer(true);
      expect(trigger).toHaveClass('ui-collapsible-trigger-xs');
      await mobileLayer(false);
      expect(trigger).toHaveClass('ui-collapsible-trigger-sm');
      expect(trigger).not.toHaveClass('ui-collapsible-trigger-xs');
    });
  });

  it('still draws a tree row at its depth, one inline custom property per level', async () => {
    stubServer({
      status: () => ({ body: status({ changes: [entry('a/b/c/d.ts')] }) }),
    });
    mount({ repos: [APP] });
    const file = await screen.findByTestId('scm-row-changes:a/b/c/d.ts');
    expect(file.style.getPropertyValue('--depth')).not.toBe('');
  });
});

describe('File icons', () => {
  const INDEX: IconIndex = {
    fileExtensions: { ts: 'typescript' },
    fileNames: {},
    folderNames: {},
    languageIds: {},
    file: 'file',
    folder: 'folder',
    folderExpanded: 'folder-open',
  };

  it('draws the Material icon of a file once the index is there, a fallback glyph before', async () => {
    stubServer({ status: () => ({ body: status({ changes: [entry('a.ts')] }) }) });
    mount({ repos: [APP] });
    const row = await screen.findByTestId('scm-row-changes:a.ts');
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('.scm-glyph-fallback svg')).not.toBeNull();
    cleanup();

    __setIconIndex(INDEX);
    mount({ repos: [APP] });
    const again = await screen.findByTestId('scm-row-changes:a.ts');
    expect(again.querySelector('img')).toHaveAttribute('src', '/file-icons/typescript.svg');
  });
});

describe('The list stays live while it is visible', () => {
  it('shows a file saved by another program within 2 seconds', async () => {
    vi.useFakeTimers();
    let saved = false;
    stubServer({
      status: () => ({ body: status({ changes: saved ? [entry('saved.ts')] : [] }) }),
    });
    mount({ repos: [APP] });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByTestId('scm-clean')).toBeInTheDocument();

    saved = true;
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByTestId('scm-row-changes:saved.ts')).toBeInTheDocument();
    expect(screen.queryByTestId('scm-clean')).toBeNull();
  });

  it('a view that is not visible reads nothing, for an hour', async () => {
    vi.useFakeTimers();
    stubServer();
    mount({ repos: [APP], visible: false });
    await act(() => vi.advanceTimersByTimeAsync(60 * 60 * 1000));
    expect(calls('/scm/status')).toEqual([]);
  });

  it('stops reading when the view unmounts', async () => {
    vi.useFakeTimers();
    stubServer();
    mount({ repos: [APP] });
    await act(() => vi.advanceTimersByTimeAsync(0));
    const before = calls('/scm/status').length;
    cleanup();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(calls('/scm/status')).toHaveLength(before);
  });

  it('refreshes at once when the window comes back to the foreground', async () => {
    vi.useFakeTimers();
    stubServer();
    mount({ repos: [APP] });
    await act(() => vi.advanceTimersByTimeAsync(0));
    const state = (visibility: 'visible' | 'hidden') => {
      Object.defineProperty(document, 'visibilityState', { value: visibility, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    state('hidden');
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    const hidden = calls('/scm/status').length;
    state('visible');
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(calls('/scm/status')).toHaveLength(hidden + 1);
  });
});

// ── Row actions (scm-row-actions, design D2, D3, D9, D10) ─────────────────────

const itemOf = (testId: string): HTMLElement => {
  const item = screen.getByTestId(testId).closest<HTMLElement>('.scm-item');
  if (!item) throw new Error(`${testId} has no .scm-item`);
  return item;
};

/** The ids of the inline actions of a row, in the order they are drawn. */
const actionIds = (item: HTMLElement): string[] =>
  [...item.querySelectorAll('[data-testid^="scm-action-"]')].map(
    (el) => el.getAttribute('data-testid')?.replace('scm-action-', '') ?? '',
  );

/** Every declaration of every top-level rule of scm.css that lists `selector`. */
const scmRule = (selector: string): Map<string, string> => {
  const held = new Map<string, string>();
  parse(readFileSync(join(__dirname, 'scm.css'), 'utf8')).walkRules((rule) => {
    if (!rule.selectors.some((s) => s.replace(/\s+/g, ' ').trim() === selector)) return;
    rule.walkDecls((d) => void held.set(d.prop, d.value));
  });
  return held;
};

/** A mouse press with `button` (0 primary, 1 middle, 2 secondary), for the pointer events. */
const mouse = (button: number) => ({
  pointerId: 1,
  pointerType: 'mouse',
  button,
  clientX: 10,
  clientY: 10,
});

const batch = (over: Record<string, unknown> = {}) => ({
  body: { receiptId: 'r1', status: 'staged', done: [], skipped: [], ...over },
});

describe('A row offers its actions', () => {
  const changes = () =>
    stubServer({
      status: () => ({
        body: status({ staged: [entry('s.ts')], changes: [entry('src/a.ts')] }),
      }),
    });

  it('a Changes file holds Open file, Stage and Discard, Discard last behind a hairline', async () => {
    changes();
    mount({ repos: [APP], batchWrites: true });
    await screen.findByTestId('scm-row-changes:src/a.ts');
    const item = itemOf('scm-row-changes:src/a.ts');
    expect(item).toHaveAttribute('data-testid', 'scm-item');
    expect(actionIds(item)).toEqual(['open', 'stage', 'discard']);
    const group = within(item).getByRole('group', { name: 'Actions for a.ts' });
    // The actions are siblings of the main button, never inside it.
    expect(screen.getByTestId('scm-row-changes:src/a.ts').contains(group)).toBe(false);
    const discard = within(item).getByTestId('scm-action-discard');
    expect(discard).toHaveAttribute('data-danger', 'true');
    expect(discard.previousElementSibling).toHaveClass('scm-actions-sep');
    expect(within(item).getByTestId('scm-action-stage')).toHaveAccessibleName('Stage');
    // A staged file offers Unstage instead.
    expect(actionIds(itemOf('scm-row-staged:s.ts'))).toEqual(['open', 'unstage']);
  });

  it('shows them only under the pointer or with focus in the row, and never on a phone', () => {
    expect(scmRule('.scm-actions').get('display')).toBe('none');
    expect(scmRule('.scm-item:hover > .scm-actions').get('display')).toBe('flex');
    expect(scmRule('.scm-item:focus-within > .scm-actions').get('display')).toBe('flex');
    expect(scmRule(":root[data-mobile='true'] .scm-item > .scm-actions").get('display')).toBe(
      'none',
    );
    // The wrapper is the row's own height, and the name gives way before the actions.
    expect(scmRule('.scm-item').get('height')).toBe('var(--scm-row-h)');
    expect(scmRule('.scm-item > .scm-row').get('min-width')).toBe('0');
  });

  it('offers no action and no menu when the server has no batch writes', async () => {
    changes();
    mount({ repos: [APP], batchWrites: false });
    const row = await screen.findByTestId('scm-row-changes:src/a.ts');
    expect(row.closest('.scm-item')).toBeNull();
    expect(document.querySelector('[data-testid^="scm-action-"]')).toBeNull();
    fireEvent.contextMenu(row);
    await settle();
    expect(screen.queryByTestId('scm-menu')).toBeNull();
  });

  it('Tab from the row reaches each action, and Enter runs it without opening the review', async () => {
    changes();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    const { onOpenFile, onOpenPath } = mount({ repos: [APP], batchWrites: true });
    const row = await screen.findByTestId('scm-row-changes:src/a.ts');
    const item = itemOf('scm-row-changes:src/a.ts');
    act(() => row.focus());
    await user.tab();
    expect(within(item).getByTestId('scm-action-open')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onOpenPath).toHaveBeenCalledWith(`${APP}/src/a.ts`);
    await user.tab();
    expect(within(item).getByTestId('scm-action-stage')).toHaveFocus();
    await user.tab();
    expect(within(item).getByTestId('scm-action-discard')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onOpenFile).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('a right-click opens a menu with the same items, and opens no review', async () => {
    changes();
    const { onOpenFile } = mount({ repos: [APP], batchWrites: true });
    const row = await screen.findByTestId('scm-row-changes:src/a.ts');
    const right = { pointerId: 1, pointerType: 'mouse', button: 2, clientX: 10, clientY: 10 };
    fireEvent.pointerDown(row, right);
    fireEvent.contextMenu(row, { button: 2 });
    fireEvent.pointerUp(row, right);
    expect(await screen.findByTestId('scm-menu')).toBeInTheDocument();
    expect(
      [...screen.getByTestId('scm-menu').querySelectorAll('[data-testid^="scm-menu-"]')].map(
        (el) => el.textContent,
      ),
    ).toEqual(['Open file', 'Stage', 'Discard changes']);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('a right-click or a middle-click on an inline action runs nothing, a primary press does', async () => {
    stubServer({
      status: () => ({ body: status({ changes: [entry('src/a.ts')] }) }),
      write: () => batch({ done: ['src/a.ts'] }),
    });
    const { onOpenFile } = mount({ repos: [APP], batchWrites: true });
    await screen.findByTestId('scm-row-changes:src/a.ts');
    const stage = within(itemOf('scm-row-changes:src/a.ts')).getByTestId('scm-action-stage');
    // The right-click opens the row's menu, and its release lands on the button under it.
    fireEvent.pointerDown(stage, mouse(2));
    fireEvent.contextMenu(stage, { button: 2 });
    fireEvent.pointerUp(stage, mouse(2));
    const menu = await screen.findByTestId('scm-menu');
    await settle();
    expect(posts()).toEqual([]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    await settle();
    fireEvent.pointerDown(stage, mouse(1));
    fireEvent.pointerUp(stage, mouse(1));
    await settle();
    expect(posts()).toEqual([]);
    fireEvent.pointerDown(stage, mouse(0));
    fireEvent.pointerUp(stage, mouse(0));
    await settle();
    expect(posts()).toEqual([{ route: '/scm/stage-paths', body: { paths: ['src/a.ts'] } }]);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('a menu item runs its action', async () => {
    stubServer({
      status: () => ({ body: status({ changes: [entry('src/a.ts')] }) }),
      write: () => batch({ done: ['src/a.ts'] }),
    });
    mount({ repos: [APP], batchWrites: true });
    fireEvent.contextMenu(await screen.findByTestId('scm-row-changes:src/a.ts'));
    fireEvent.click(await screen.findByTestId('scm-menu-stage'));
    await settle();
    expect(posts()).toEqual([{ route: '/scm/stage-paths', body: { paths: ['src/a.ts'] } }]);
  });

  describe('on a phone', () => {
    const touch = (clientY: number) => ({
      pointerId: 9,
      pointerType: 'touch',
      clientX: 10,
      clientY,
    });
    beforeEach(() => {
      document.documentElement.dataset.mobile = 'true';
    });
    afterEach(() => {
      document.documentElement.removeAttribute('data-mobile');
    });

    it('draws no inline action, and the menu still offers them', async () => {
      changes();
      mount({ repos: [APP], batchWrites: true });
      const row = await screen.findByTestId('scm-row-staged:s.ts');
      expect(row.closest('.scm-item')).not.toBeNull();
      expect(document.querySelector('[data-testid^="scm-action-"]')).toBeNull();
      fireEvent.contextMenu(row);
      expect(await screen.findByTestId('scm-menu-unstage')).toBeInTheDocument();
    });

    it('a long-press opens the menu, and its release opens no review', async () => {
      vi.useFakeTimers();
      changes();
      const { onOpenFile } = mount({ repos: [APP], batchWrites: true });
      await settle();
      const row = screen.getByTestId('scm-row-staged:s.ts');
      fireEvent.pointerDown(row, touch(100));
      await act(() => vi.advanceTimersByTimeAsync(700));
      expect(screen.getByTestId('scm-menu-open')).toBeInTheDocument();
      expect(screen.getByTestId('scm-menu-unstage')).toBeInTheDocument();
      fireEvent.pointerUp(row, touch(100));
      fireEvent.click(row, { detail: 1 });
      expect(onOpenFile).not.toHaveBeenCalled();
    });

    it('a pan that starts on a row is left to the browser and opens no menu', async () => {
      vi.useFakeTimers();
      changes();
      const { onOpenFile } = mount({ repos: [APP], batchWrites: true });
      await settle();
      const row = screen.getByTestId('scm-row-staged:s.ts');
      expect(fireEvent.pointerDown(row, touch(100))).toBe(true);
      expect(fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 100 }] })).toBe(true);
      fireEvent.pointerMove(row, touch(60));
      await act(() => vi.advanceTimersByTimeAsync(700));
      expect(screen.queryByTestId('scm-menu')).toBeNull();
      fireEvent.pointerUp(row, touch(60));
      expect(onOpenFile).not.toHaveBeenCalled();
    });
  });
});

describe('Row writes', () => {
  /** 40 files under packages/server, ten of them in a subfolder the test collapses. */
  const forty = [
    ...Array.from({ length: 30 }, (_, i) => entry(`packages/server/f${i}.ts`)),
    ...Array.from({ length: 10 }, (_, i) => entry(`packages/server/src/g${i}.ts`)),
  ];

  it('Stage all on a folder stages every file under it once, collapsed ones too, with Undo', async () => {
    stubServer({
      status: () => ({ body: status({ changes: forty }) }),
      write: (route, body) =>
        route === '/scm/restore'
          ? { body: { receiptId: null, status: 'restored' } }
          : batch({ done: body['paths'] }),
    });
    const { onNotify } = mount({ repos: [APP], batchWrites: true });
    // Fold the subfolder: its files are off screen and still part of the folder.
    press(await screen.findByTestId('scm-folder-changes:packages/server/src'));
    expect(screen.queryByTestId('scm-row-changes:packages/server/src/g0.ts')).toBeNull();
    press(within(itemOf('scm-folder-changes:packages/server')).getByTestId('scm-action-stage'));
    await settle();
    const [stage] = posts();
    expect(stage?.route).toBe('/scm/stage-paths');
    const paths = stage?.body['paths'] as string[];
    expect(paths.toSorted()).toEqual(forty.map((e) => e.path).toSorted());
    expect(new Set(paths).size).toBe(40);
    expect(onNotify).toHaveBeenLastCalledWith(
      'Staged 40 files',
      expect.objectContaining({ label: 'Undo' }),
    );
    act(() => onNotify.mock.lastCall?.[1]?.onClick());
    await settle();
    expect(posts()[1]).toEqual({ route: '/scm/restore', body: { receiptId: 'r1' } });
    expect(onNotify).toHaveBeenLastCalledWith('Undone', undefined);
  });

  it('Unstage all sends each entry, and the source of a rename', async () => {
    stubServer({
      status: () => ({
        body: status({
          staged: [
            entry('lib/a.ts'),
            entry('lib/new.ts', { kind: 'rename', status: 'R', oldPath: 'lib/old.ts' }),
          ],
        }),
      }),
      write: () => batch({ status: 'unstaged', done: ['lib/a.ts', 'lib/new.ts'] }),
    });
    const { onNotify } = mount({ repos: [APP], batchWrites: true });
    await screen.findByTestId('scm-folder-staged:lib');
    press(within(itemOf('scm-folder-staged:lib')).getByTestId('scm-action-unstage'));
    await settle();
    expect(posts()).toEqual([
      {
        route: '/scm/unstage-paths',
        body: { entries: [{ path: 'lib/a.ts' }, { path: 'lib/new.ts', oldPath: 'lib/old.ts' }] },
      },
    ]);
    expect(onNotify.mock.lastCall?.[0]).toBe('Unstaged 2 files');
  });

  it('says how many were skipped and why', async () => {
    const four = ['d/a.ts', 'd/b.ts', 'd/c.ts', 'd/e.ts'].map((p) => entry(p));
    stubServer({
      status: () => ({ body: status({ changes: four }) }),
      write: () =>
        batch({
          done: ['d/a.ts', 'd/b.ts'],
          skipped: [
            { path: 'd/c.ts', reason: 'converted' },
            { path: 'd/e.ts', reason: 'converted' },
          ],
        }),
    });
    const { onNotify } = mount({ repos: [APP], batchWrites: true });
    await screen.findByTestId('scm-folder-changes:d');
    press(within(itemOf('scm-folder-changes:d')).getByTestId('scm-action-stage'));
    await settle();
    expect(onNotify.mock.lastCall?.[0]).toBe('Staged 2 files, skipped 2 (needs a git filter)');
  });

  it('a write that changed nothing says so, with no Undo', async () => {
    stubServer({
      status: () => ({ body: status({ changes: [entry('a.ts')] }) }),
      write: () => batch({ receiptId: null, skipped: [{ path: 'a.ts', reason: 'converted' }] }),
    });
    const { onNotify } = mount({ repos: [APP], batchWrites: true });
    await screen.findByTestId('scm-row-changes:a.ts');
    press(within(itemOf('scm-row-changes:a.ts')).getByTestId('scm-action-stage'));
    await settle();
    expect(onNotify).toHaveBeenLastCalledWith(
      'Nothing staged, skipped a.ts (needs a git filter)',
      undefined,
    );
  });

  it('a refused write says why, through the notice', async () => {
    stubServer({
      status: () => ({ body: status({ changes: [entry('a.ts')] }) }),
      write: () => ({ body: { error: 'index.lock exists', code: 'busy' }, httpStatus: 409 }),
    });
    const { onNotice, onNotify } = mount({ repos: [APP], batchWrites: true });
    await screen.findByTestId('scm-row-changes:a.ts');
    press(within(itemOf('scm-row-changes:a.ts')).getByTestId('scm-action-stage'));
    await settle();
    expect(onNotice.mock.lastCall?.[0]).toMatch(/index\.lock/);
    expect(onNotify).not.toHaveBeenCalled();
  });

  describe('a discard', () => {
    const two = () =>
      stubServer({
        status: () => ({
          body: status({ changes: [entry('t/a.ts'), entry('t/new.txt', { status: '?' })] }),
        }),
        write: (route) =>
          route === '/scm/restore'
            ? { body: { receiptId: null, status: 'restored' } }
            : batch({ receiptId: 'd1', status: 'discarded', done: ['t/a.ts', 't/new.txt'] }),
      });

    it('asks first, naming the files, the untracked ones and the Undo window', async () => {
      two();
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      mount({ repos: [APP], batchWrites: true });
      await screen.findByTestId('scm-folder-changes:t');
      press(within(itemOf('scm-folder-changes:t')).getByTestId('scm-action-discard'));
      await settle();
      const text = confirm.mock.lastCall?.[0] ?? '';
      expect(text).toContain('Discard changes to 2 files?');
      expect(text).toContain('t/a.ts\nt/new.txt');
      expect(text).toContain('1 untracked file will be deleted.');
      expect(text).toContain('You can undo this for 10 minutes');
      // Each entry carries the fp the list showed, so a file changed since is left alone.
      expect(posts()).toEqual([
        {
          route: '/scm/discard',
          body: {
            entries: [
              { path: 't/a.ts', fp: 'fp-t/a.ts' },
              { path: 't/new.txt', fp: 'fp-t/new.txt' },
            ],
          },
        },
      ]);
      expect(readLastDiscard(APP)).toMatchObject({ receiptId: 'd1', count: 2 });
      confirm.mockRestore();
    });

    it('Cancel on the confirm sends nothing', async () => {
      two();
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      mount({ repos: [APP], batchWrites: true });
      await screen.findByTestId('scm-row-changes:t/a.ts');
      press(within(itemOf('scm-row-changes:t/a.ts')).getByTestId('scm-action-discard'));
      await settle();
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Discard changes to t/a.ts?'));
      expect(posts()).toEqual([]);
      confirm.mockRestore();
    });

    it('the toast’s Undo also takes the project bar’s Undo away', async () => {
      two();
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { onNotify } = mount({ repos: [APP], batchWrites: true });
      await screen.findByTestId('scm-row-changes:t/a.ts');
      press(within(itemOf('scm-row-changes:t/a.ts')).getByTestId('scm-action-discard'));
      await settle();
      expect(screen.getByTestId('scm-undo-discard')).toBeInTheDocument();
      act(() => onNotify.mock.lastCall?.[1]?.onClick());
      await settle();
      expect(posts()[1]).toEqual({ route: '/scm/restore', body: { receiptId: 'd1' } });
      expect(screen.queryByTestId('scm-undo-discard')).toBeNull();
      confirm.mockRestore();
    });

    it('the review’s Undo of a toast holding the discard takes the project bar’s Undo away', async () => {
      two();
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      mount({ repos: [APP], batchWrites: true });
      await screen.findByTestId('scm-row-changes:t/a.ts');
      press(within(itemOf('scm-row-changes:t/a.ts')).getByTestId('scm-action-discard'));
      await settle();
      expect(screen.getByTestId('scm-undo-discard')).toBeInTheDocument();
      // Reviewed within 6 s: the review's toast names both writes, and its Undo takes both back,
      // the way the review pane runs it, outside this view.
      const recent = recordWrite({
        repo: APP,
        receiptId: 'r9',
        action: 'stage',
        name: 'x.ts',
        at: Date.now(),
      });
      expect(recent.map((write) => write.receiptId)).toEqual(['d1', 'r9']);
      await act(async () => {
        expect(await undoWrites(restoreScmWrite, recent)).toEqual({ kind: 'done', undone: 2 });
      });
      expect(readLastDiscard(APP)).toBeNull();
      expect(screen.queryByTestId('scm-undo-discard')).toBeNull();
      confirm.mockRestore();
    });
  });

  it('an Undo from the project bar leaves the toast’s later Undo nothing spent to retry', async () => {
    // Stage A, discard B, undo B from the project bar, stage B, then the toast's Undo (all in 6 s).
    const spent = new Set<string>();
    stubServer({
      status: () => ({ body: status({ changes: [entry('a.ts'), entry('b.ts')] }) }),
      write: (route, body) => {
        if (route === '/scm/discard') {
          return batch({ receiptId: 'd1', status: 'discarded', done: ['b.ts'] });
        }
        if (route === '/scm/restore') {
          const id = String(body['receiptId']);
          if (spent.has(id)) {
            return {
              body: { error: 'Undo is no longer available.', code: 'token' },
              httpStatus: 410,
            };
          }
          spent.add(id);
          return { body: { receiptId: null, status: 'restored' } };
        }
        const [path] = body['paths'] as string[];
        return batch({ receiptId: path === 'a.ts' ? 'r1' : 'r2', done: [path] });
      },
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { onNotify, onNotice } = mount({ repos: [APP], batchWrites: true });
    const action = (path: string, id: string) =>
      press(within(itemOf(`scm-row-changes:${path}`)).getByTestId(`scm-action-${id}`));
    await screen.findByTestId('scm-row-changes:a.ts');
    action('a.ts', 'stage');
    await settle();
    action('b.ts', 'discard');
    await settle();
    press(screen.getByTestId('scm-undo-discard'));
    await settle();
    expect(onNotify).toHaveBeenLastCalledWith('Restored 1 file', undefined);
    action('b.ts', 'stage');
    await settle();
    // The discard was taken back already, so the toast no longer names it.
    expect(onNotify.mock.lastCall?.[0]).toBe('Staged 2 files');
    act(() => onNotify.mock.lastCall?.[1]?.onClick());
    await settle();
    const restores = posts()
      .filter((post) => post.route === '/scm/restore')
      .map((post) => post.body['receiptId']);
    expect(restores).toEqual(['d1', 'r2', 'r1']);
    expect(onNotify).toHaveBeenLastCalledWith('Undid 2 files', undefined);
    expect(onNotice).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});

describe('Undo last discard', () => {
  const MIN = 60_000;
  /** A project with one change, a discard of two files recorded now, and the restore's answer. */
  const discarded = (restore: { body: unknown; httpStatus?: number }) => {
    vi.useFakeTimers();
    stubServer({
      status: () => ({ body: status({ changes: [entry('a.ts')] }) }),
      write: () => restore,
    });
    recordDiscard(APP, { receiptId: 'd1', at: Date.now(), count: 2 });
  };
  const button = () => screen.queryByTestId('scm-undo-discard');
  const later = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  it('is offered after a discard, still at 8 minutes, and restores on tap, then goes', async () => {
    discarded({ body: { receiptId: null, status: 'restored' } });
    const { onNotify } = mount({ repos: [APP], batchWrites: true });
    await settle();
    expect(button()).toHaveAccessibleName('Undo last discard (2 files)');
    await later(8 * MIN);
    expect(button()).toBeInTheDocument();
    press(button()!);
    await settle();
    expect(posts()).toEqual([{ route: '/scm/restore', body: { receiptId: 'd1' } }]);
    expect(onNotify).toHaveBeenLastCalledWith('Restored 2 files', undefined);
    expect(button()).toBeNull();
  });

  it('goes by itself after 10 minutes', async () => {
    discarded({ body: { receiptId: null, status: 'restored' } });
    mount({ repos: [APP], batchWrites: true });
    await settle();
    await later(DISCARD_UNDO_MS - 1);
    expect(button()).toBeInTheDocument();
    await later(1);
    expect(button()).toBeNull();
  });

  it('an expired receipt says so and goes', async () => {
    discarded({ body: { error: 'receipt expired', code: 'token' }, httpStatus: 410 });
    const { onNotice } = mount({ repos: [APP], batchWrites: true });
    await settle();
    press(button()!);
    await settle();
    expect(onNotice).toHaveBeenLastCalledWith('This Undo has expired');
    expect(button()).toBeNull();
  });

  it('a conflict says the files changed and keeps the Undo for later', async () => {
    const message = 'The files changed since the discard; nothing was undone.';
    discarded({ body: { error: message, code: 'conflict' }, httpStatus: 409 });
    const { onNotice } = mount({ repos: [APP], batchWrites: true });
    await settle();
    press(button()!);
    await settle();
    expect(onNotice).toHaveBeenLastCalledWith(message);
    expect(button()).toBeInTheDocument();
  });

  it('is not offered without batch writes', async () => {
    discarded({ body: { receiptId: null, status: 'restored' } });
    mount({ repos: [APP], batchWrites: false });
    await settle();
    expect(button()).toBeNull();
  });
});
