// The Source Control view as a tree: one test per scenario of "Changed files can be
// browsed as a tree", then the keyboard, the pointer, a long group and the two hosts
// (the dock and the drawer render the same component). The server is a stubbed
// `fetch` and the status store is the real one, as in SourceControlView.test.tsx.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScmEntry, ScmStatus } from '@palmux/shared';
import { __setIconIndex, type IconIndex } from '../panes/file-icons';
import { DockPanel } from '../session/DockPanel';
import { SessionDrawer } from '../session/SessionDrawer';
import {
  DEFAULTS,
  loadSettings,
  notifySettingsChange,
  sanitize,
  saveSettings,
} from '../settings/settings';
import { LONG_GROUP_ROWS, SourceControlView, type ScmOpenTarget } from './SourceControlView';
import { COLLAPSED_KEY } from './scm-tree';
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

const files = (...paths: string[]): ScmEntry[] => paths.map((p) => entry(p));

type Lists = Partial<Pick<ScmStatus, 'merge' | 'staged' | 'changes'>>;

const serve = (byRepo: Record<string, Lists>) => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const u = new URL(url, 'http://palmux');
      if (u.pathname !== '/scm/status') {
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
      }
      const repo = u.searchParams.get('repo') ?? '';
      const body: ScmStatus = {
        top: repo,
        branch: 'main',
        unborn: false,
        merge: [],
        staged: [],
        changes: [],
        truncated: false,
        tookMs: 1,
        commentsRev: 0,
        attrEpoch: 'e0',
        ...byRepo[repo],
      };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }),
  );
};

/** The host's half of the setting: App persists a change and tells the settings pub/sub. */
const writeTree = (scmTree: boolean) => {
  const next = sanitize({ ...loadSettings(), scmTree });
  saveSettings(next);
  notifySettingsChange(next);
};

interface Spies {
  onOpenFile: ReturnType<typeof vi.fn<(target: ScmOpenTarget) => void>>;
}

const noop = () => undefined;

const drawerProps = (viewContent: ReactNode) => ({
  open: true,
  tabs: [{ id: '0', kind: 'terminal' as const, title: 'vim' }],
  current: '0',
  onSwitch: noop,
  onCreate: noop,
  onKill: noop,
  onClose: noop,
  onTabMenu: noop,
  onMoveTab: noop,
  onMoveGroup: noop,
  actions: {
    uploadFile: () => false,
    uploadImages: () => false,
    downloadFile: noop,
    dictate: noop,
  },
  settings: DEFAULTS,
  onChangeSettings: noop,
  view: 'scm' as const,
  hostedViews: ['scm' as const],
  viewContent,
});

type HostKind = 'plain' | 'dock' | 'drawer';

interface MountOptions {
  repos?: string[];
  active?: string;
  host?: HostKind;
}

const mount = ({ repos = [APP], active, host = 'plain' }: MountOptions = {}): Spies => {
  const spies: Spies = { onOpenFile: vi.fn() };
  const Host = () => {
    const [selected, setSelected] = useState(active ?? repos[0] ?? '');
    useEffect(() => {
      scmStatusStore.setActiveRepo(selected);
    }, [selected]);
    const view = (
      <SourceControlView
        repos={repos}
        activeRepo={selected}
        visible
        onChange={(change) => {
          if (change.scmActiveRepo !== undefined) setSelected(change.scmActiveRepo);
          if (change.scmTree !== undefined) writeTree(change.scmTree);
        }}
        onOpenFile={spies.onOpenFile}
      />
    );
    if (host === 'dock') {
      return (
        <DockPanel view="scm" onView={noop}>
          {view}
        </DockPanel>
      );
    }
    if (host === 'drawer') return <SessionDrawer {...drawerProps(view)} />;
    return view;
  };
  render(<Host />);
  return spies;
};

const press = (el: Element) => fireEvent.click(el);
const folderOf = (group: string, path: string) => screen.getByTestId(`scm-folder-${group}:${path}`);
const fileOf = (group: string, path: string) => screen.getByTestId(`scm-row-${group}:${path}`);

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

/** The rows of a group, top to bottom: `name/` for a folder, the path for a file. */
const rowsOf = (group: string): string[] =>
  [...screen.getByTestId(`scm-group-${group}`).querySelectorAll('.scm-folder, .scm-row')].map(
    (row) => {
      const id = row.getAttribute('data-testid') ?? '';
      return row.classList.contains('scm-folder')
        ? `${id.replace(`scm-folder-${group}:`, '')}/`
        : id.replace(`scm-row-${group}:`, '');
    },
  );

const filesOf = (group: string): string[] => rowsOf(group).filter((r) => !r.endsWith('/'));

const depthOf = (el: Element): string => (el as HTMLElement).style.getPropertyValue('--depth');
const rowCountOf = (el: Element): string =>
  (el as HTMLElement).style.getPropertyValue('--scm-rows');

const stored = (): unknown => JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? 'null');

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  await settle();
  cleanup();
  scmStatusStore.setActiveRepo('');
  __setIconIndex(null);
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('A group is a folder tree by default', () => {
  it('shows folder rows above their files, indented a level each, with no directory column', async () => {
    serve({
      [APP]: {
        changes: files('README.md', 'src/a.ts', 'src/ui/b.ts', 'src/ui/c.ts', 'z.ts'),
      },
    });
    mount();
    await screen.findByTestId('scm-group-changes');
    expect(rowsOf('changes')).toEqual([
      'README.md',
      'src/',
      'src/a.ts',
      'src/ui/',
      'src/ui/b.ts',
      'src/ui/c.ts',
      'z.ts',
    ]);
    expect(depthOf(fileOf('changes', 'README.md'))).toBe('0');
    expect(depthOf(folderOf('changes', 'src'))).toBe('0');
    expect(depthOf(fileOf('changes', 'src/a.ts'))).toBe('1');
    expect(depthOf(folderOf('changes', 'src/ui'))).toBe('1');
    expect(depthOf(fileOf('changes', 'src/ui/b.ts'))).toBe('2');
    expect(document.querySelector('.scm-dir')).toBeNull();
    // A one-segment folder has a name and nothing to give way in front of it.
    expect(folderOf('changes', 'src').querySelector('.scm-chain-head')).toBeNull();
    expect(folderOf('changes', 'src').querySelector('.scm-chain-tail')).toHaveTextContent(/^src$/);
    // The name is the file's own; the folders above say where it lives.
    expect(within(fileOf('changes', 'src/ui/b.ts')).getByText('b.ts')).toHaveClass('scm-name');
  });

  it('counts the files below a folder, at any depth, and the group counts its files', async () => {
    serve({ [APP]: { changes: files('src/a.ts', 'src/ui/b.ts', 'src/ui/c.ts', 'z.ts') } });
    mount();
    await screen.findByTestId('scm-group-changes');
    expect(screen.getByTestId('scm-folder-count-changes:src')).toHaveTextContent('3');
    expect(screen.getByTestId('scm-folder-count-changes:src/ui')).toHaveTextContent('2');
    expect(screen.getByTestId('scm-count-changes')).toHaveTextContent('4');
  });

  it('draws each of the three groups as its own tree', async () => {
    serve({
      [APP]: {
        merge: files('lib/m.ts'),
        staged: files('lib/s.ts', 'lib/t.ts'),
        changes: files('lib/c.ts'),
      },
    });
    mount();
    await screen.findByTestId('scm-group-merge');
    expect(rowsOf('merge')).toEqual(['lib/', 'lib/m.ts']);
    expect(rowsOf('staged')).toEqual(['lib/', 'lib/s.ts', 'lib/t.ts']);
    expect(rowsOf('changes')).toEqual(['lib/', 'lib/c.ts']);
    expect(fileOf('merge', 'lib/m.ts')).toHaveAttribute('data-conflicted', 'true');
  });

  it('keeps naming a rename by where it came from', async () => {
    serve({
      [APP]: {
        staged: [entry('src/new.ts', { kind: 'rename', status: 'R', oldPath: 'lib/old.ts' })],
      },
    });
    mount();
    const row = await screen.findByTestId('scm-row-staged:src/new.ts');
    expect(row).toHaveTextContent('new.ts← lib/old.tsR');
    expect(row).toHaveAttribute('title', 'src/new.ts (renamed from lib/old.ts)');
  });

  it('opens the review of a file in the tree exactly as the flat list does', async () => {
    serve({
      [APP]: { merge: files('m.ts'), staged: files('d/s.ts'), changes: files('d/c.ts') },
    });
    const { onOpenFile } = mount();
    press(await screen.findByTestId('scm-row-staged:d/s.ts'));
    expect(onOpenFile).toHaveBeenLastCalledWith({ group: 'staged', path: 'd/s.ts' });
    press(fileOf('changes', 'd/c.ts'));
    expect(onOpenFile).toHaveBeenLastCalledWith({ group: 'changes', path: 'd/c.ts' });
    // A conflicted file opens the Changes review.
    press(fileOf('merge', 'm.ts'));
    expect(onOpenFile).toHaveBeenLastCalledWith({ group: 'changes', path: 'm.ts' });
  });
});

describe('Scenario: Collapsing a folder', () => {
  const lists = {
    [APP]: {
      changes: files(
        'packages/client/a.ts',
        'packages/server/b.ts',
        'packages/server/c.ts',
        'z.ts',
      ),
    },
  };

  it('hides the files under it, keeps the folder row with its count, and survives a reload', async () => {
    serve(lists);
    mount();
    await screen.findByTestId('scm-group-changes');
    expect(folderOf('changes', 'packages/server')).toHaveAttribute('aria-expanded', 'true');

    press(folderOf('changes', 'packages/server'));
    expect(folderOf('changes', 'packages/server')).toHaveAttribute('aria-expanded', 'false');
    expect(rowsOf('changes')).toEqual([
      'packages/',
      'packages/client/',
      'packages/client/a.ts',
      'packages/server/',
      'z.ts',
    ]);
    expect(screen.getByTestId('scm-folder-count-changes:packages/server')).toHaveTextContent('2');
    // The group's own count is the files it holds, not the rows it shows.
    expect(screen.getByTestId('scm-count-changes')).toHaveTextContent('4');
    expect(stored()).toEqual({ v: 1, byRepo: { [APP]: { changes: ['packages/server'] } } });

    // A reload: nothing of the component survives but this device's storage.
    cleanup();
    scmStatusStore.setActiveRepo('');
    mount();
    await screen.findByTestId('scm-group-changes');
    expect(folderOf('changes', 'packages/server')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('scm-row-changes:packages/server/b.ts')).toBeNull();
    expect(fileOf('changes', 'packages/client/a.ts')).toBeInTheDocument();
  });

  it('opens it again, and the reload then finds it open', async () => {
    serve(lists);
    mount();
    await screen.findByTestId('scm-group-changes');
    press(folderOf('changes', 'packages/server'));
    press(folderOf('changes', 'packages/server'));
    expect(fileOf('changes', 'packages/server/b.ts')).toBeInTheDocument();
    expect(stored()).toEqual({ v: 1, byRepo: {} });
    cleanup();
    scmStatusStore.setActiveRepo('');
    mount();
    await screen.findByTestId('scm-group-changes');
    expect(folderOf('changes', 'packages/server')).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps a collapsed parent collapsed over the open state of what is inside it', async () => {
    serve(lists);
    mount();
    await screen.findByTestId('scm-group-changes');
    press(folderOf('changes', 'packages/server'));
    press(folderOf('changes', 'packages'));
    expect(rowsOf('changes')).toEqual(['packages/', 'z.ts']);
    press(folderOf('changes', 'packages'));
    // The child that was collapsed before is still collapsed.
    expect(folderOf('changes', 'packages/server')).toHaveAttribute('aria-expanded', 'false');
    expect(fileOf('changes', 'packages/client/a.ts')).toBeInTheDocument();
  });

  it('is remembered per project and per group', async () => {
    serve({
      [APP]: { staged: files('d/x.ts'), changes: files('d/x.ts') },
      [LIB]: { changes: files('d/x.ts') },
    });
    mount({ repos: [APP, LIB] });
    await screen.findByTestId('scm-group-staged');
    press(folderOf('changes', 'd'));
    // The same folder in the other group of the same project stays open.
    expect(folderOf('staged', 'd')).toHaveAttribute('aria-expanded', 'true');
    expect(folderOf('changes', 'd')).toHaveAttribute('aria-expanded', 'false');

    // Another project has its own memory of a folder with the same path.
    cleanup();
    scmStatusStore.setActiveRepo('');
    mount({ repos: [APP, LIB], active: LIB });
    await screen.findByTestId('scm-group-changes');
    expect(folderOf('changes', 'd')).toHaveAttribute('aria-expanded', 'true');
    expect(stored()).toEqual({ v: 1, byRepo: { [APP]: { changes: ['d'] } } });
  });

  it('keeps what it stored about a folder the project no longer lists', async () => {
    serve(lists);
    mount();
    await screen.findByTestId('scm-group-changes');
    press(folderOf('changes', 'packages/server'));
    cleanup();
    scmStatusStore.setActiveRepo('');
    // The folder has no changes for a while: the list has nothing under it.
    serve({ [APP]: { changes: files('z.ts') } });
    mount();
    await screen.findByTestId('scm-group-changes');
    expect(rowsOf('changes')).toEqual(['z.ts']);
    expect(stored()).toEqual({ v: 1, byRepo: { [APP]: { changes: ['packages/server'] } } });
    // And it is collapsed again when its changes come back.
    cleanup();
    scmStatusStore.setActiveRepo('');
    serve(lists);
    mount();
    await screen.findByTestId('scm-group-changes');
    expect(folderOf('changes', 'packages/server')).toHaveAttribute('aria-expanded', 'false');
  });

  it('starts open when the stored value is garbage', async () => {
    localStorage.setItem(COLLAPSED_KEY, '{"v":1,"byRepo":"nope"');
    serve(lists);
    mount();
    await screen.findByTestId('scm-group-changes');
    expect(folderOf('changes', 'packages/server')).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('Scenario: A deep single-folder chain', () => {
  it('shows one folder row named by the chain, above its files', async () => {
    serve({
      [APP]: {
        changes: files('packages/client/src/review/a.ts', 'packages/client/src/review/b.ts'),
      },
    });
    mount();
    await screen.findByTestId('scm-group-changes');
    expect(rowsOf('changes')).toEqual([
      'packages/client/src/review/',
      'packages/client/src/review/a.ts',
      'packages/client/src/review/b.ts',
    ]);
    const folder = folderOf('changes', 'packages/client/src/review');
    // One name, drawn as a shrinkable front and the folder the row is about.
    const name = folder.querySelector('.scm-name');
    expect(name).toHaveTextContent('packages/client/src/review');
    expect(name?.querySelector('.scm-chain-head')).toHaveTextContent('packages/client/src/');
    expect(name?.querySelector('.scm-chain-tail')).toHaveTextContent(/^review$/);
    expect(depthOf(folder)).toBe('0');
    expect(depthOf(fileOf('changes', 'packages/client/src/review/a.ts'))).toBe('1');
    expect(
      screen.getByTestId('scm-folder-count-changes:packages/client/src/review'),
    ).toHaveTextContent('2');
  });

  it('splits the chain once a sibling joins it, and collapses it as one row', async () => {
    serve({
      [APP]: { changes: files('a/b/c/x.ts', 'a/b/c/d/y.ts', 'a/b/c/e/z.ts', 'a/b/c/f.ts') },
    });
    mount();
    await screen.findByTestId('scm-group-changes');
    expect(rowsOf('changes')[0]).toBe('a/b/c/');
    press(folderOf('changes', 'a/b/c'));
    expect(rowsOf('changes')).toEqual(['a/b/c/']);
    expect(stored()).toEqual({ v: 1, byRepo: { [APP]: { changes: ['a/b/c'] } } });
  });
});

describe('Scenario: Switching to a flat list', () => {
  const lists = {
    [APP]: { changes: files('README.md', 'src/panes/a.ts', 'src/panes/b.ts', 'src/c.ts') },
  };

  it('shows every file as one row with its directory, as before, and persists on this device', async () => {
    serve(lists);
    mount();
    await screen.findByTestId('scm-group-changes');
    const toggle = screen.getByTestId('scm-view-toggle');
    expect(toggle).toHaveAccessibleName('View as list');

    press(toggle);
    expect(screen.getByTestId('scm-view-toggle')).toHaveAccessibleName('View as tree');
    expect(document.querySelector('.scm-folder')).toBeNull();
    expect(rowsOf('changes')).toEqual([
      'README.md',
      'src/panes/a.ts',
      'src/panes/b.ts',
      'src/c.ts',
    ]);
    expect(within(fileOf('changes', 'src/panes/a.ts')).getByText('src/panes')).toHaveClass(
      'scm-dir',
    );
    expect(fileOf('changes', 'README.md').querySelector('.scm-dir')).toBeNull();
    // No indent, no chevron column.
    expect(depthOf(fileOf('changes', 'src/panes/a.ts'))).toBe('');
    expect(document.querySelector('.scm-twisty')).toBeNull();
    expect(loadSettings().scmTree).toBe(false);

    cleanup();
    scmStatusStore.setActiveRepo('');
    mount();
    await screen.findByTestId('scm-group-changes');
    expect(document.querySelector('.scm-folder')).toBeNull();
    expect(screen.getByTestId('scm-view-toggle')).toHaveAccessibleName('View as tree');
  });

  it('goes back to the tree with the collapsed folders as they were', async () => {
    serve(lists);
    mount();
    await screen.findByTestId('scm-group-changes');
    press(folderOf('changes', 'src'));
    press(screen.getByTestId('scm-view-toggle'));
    // The flat list is every file, whatever a folder was doing.
    expect(filesOf('changes')).toHaveLength(4);
    press(screen.getByTestId('scm-view-toggle'));
    expect(folderOf('changes', 'src')).toHaveAttribute('aria-expanded', 'false');
    expect(rowsOf('changes')).toEqual(['README.md', 'src/']);
  });

  it('is a per-device choice: it never reaches the synced payload', async () => {
    serve(lists);
    mount();
    await screen.findByTestId('scm-group-changes');
    press(screen.getByTestId('scm-view-toggle'));
    expect(JSON.parse(localStorage.getItem('palmux-settings') ?? '{}')).toMatchObject({
      scmTree: false,
    });
  });
});

describe('The tree lists the files in the order of the review', () => {
  it('follows the status order of every group, which is the order the review walks', async () => {
    const staged = files('.github/ci.yml', 'README.md', 'a/b/c.ts', 'a/b/d.ts', 'a/e.ts', 'z.ts');
    const changes = files('api/x.ts', 'api/y.ts', 'app.ts', 'docs/g/h.md', 'docs/i.md');
    serve({ [APP]: { staged, changes } });
    mount();
    await screen.findByTestId('scm-group-staged');
    // The review of Staged Changes walks `staged`, and the Changes review walks `merge` then `changes`.
    expect(filesOf('staged')).toEqual(staged.map((e) => e.path));
    expect(filesOf('changes')).toEqual(changes.map((e) => e.path));
  });

  it('keeps a file after its folder-mates when the folder is collapsed and opened', async () => {
    const changes = files('a/x.ts', 'a/y.ts', 'b.ts', 'c/z.ts');
    serve({ [APP]: { changes } });
    mount();
    await screen.findByTestId('scm-group-changes');
    press(folderOf('changes', 'a'));
    press(folderOf('changes', 'a'));
    expect(filesOf('changes')).toEqual(changes.map((e) => e.path));
  });
});

describe('Keyboard', () => {
  const lists = {
    [APP]: { changes: files('a/b/x.ts', 'a/b/y.ts', 'a/c.ts', 'd.ts') },
  };
  const key = (el: Element, name: string) => fireEvent.keyDown(el, { key: name });

  it('makes a folder a real button with the state of its disclosure', async () => {
    serve(lists);
    mount();
    await screen.findByTestId('scm-group-changes');
    const folder = folderOf('changes', 'a');
    expect(folder.tagName).toBe('BUTTON');
    expect(folder).toHaveAttribute('aria-expanded', 'true');
    expect(folder).toHaveAccessibleName('a, 3 files');
    expect(folderOf('changes', 'a/b')).toHaveAccessibleName('b, 2 files');
    folder.focus();
    expect(folder).toHaveFocus();
  });

  it('toggles on Enter and Space, which a button turns into a click', async () => {
    serve(lists);
    mount();
    await screen.findByTestId('scm-group-changes');
    const folder = folderOf('changes', 'a');
    // A click with no pointer behind it (`detail` 0) is what a key press on a button sends.
    fireEvent.click(folder, { detail: 0 });
    expect(folder).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(folder, { detail: 0 });
    expect(folder).toHaveAttribute('aria-expanded', 'true');
  });

  it('expands a collapsed folder on ArrowRight, and leaves an open one alone', async () => {
    serve(lists);
    mount();
    await screen.findByTestId('scm-group-changes');
    const folder = folderOf('changes', 'a');
    press(folder);
    expect(folder).toHaveAttribute('aria-expanded', 'false');
    key(folder, 'ArrowRight');
    expect(folder).toHaveAttribute('aria-expanded', 'true');
    expect(stored()).toEqual({ v: 1, byRepo: {} });
    key(folder, 'ArrowRight');
    expect(folder).toHaveAttribute('aria-expanded', 'true');
  });

  it('collapses an open folder on ArrowLeft', async () => {
    serve(lists);
    mount();
    await screen.findByTestId('scm-group-changes');
    const folder = folderOf('changes', 'a/b');
    key(folder, 'ArrowLeft');
    expect(folder).toHaveAttribute('aria-expanded', 'false');
    expect(stored()).toEqual({ v: 1, byRepo: { [APP]: { changes: ['a/b'] } } });
  });

  it('moves to the parent on ArrowLeft from a collapsed folder or from a file', async () => {
    serve(lists);
    mount();
    await screen.findByTestId('scm-group-changes');
    const child = folderOf('changes', 'a/b');
    press(child);
    key(child, 'ArrowLeft');
    expect(folderOf('changes', 'a')).toHaveFocus();

    key(fileOf('changes', 'a/c.ts'), 'ArrowLeft');
    expect(folderOf('changes', 'a')).toHaveFocus();
    // Nothing collapsed on the way: moving up is not closing.
    expect(folderOf('changes', 'a')).toHaveAttribute('aria-expanded', 'true');

    press(child);
    key(fileOf('changes', 'a/b/x.ts'), 'ArrowLeft');
    expect(child).toHaveFocus();
  });

  it('does nothing at the top: no parent to move to, and a file does not expand', async () => {
    serve(lists);
    mount();
    await screen.findByTestId('scm-group-changes');
    const top = fileOf('changes', 'd.ts');
    top.focus();
    const left = fireEvent.keyDown(top, { key: 'ArrowLeft' });
    const right = fireEvent.keyDown(top, { key: 'ArrowRight' });
    expect(top).toHaveFocus();
    // Not handled, so the browser keeps its own use of the arrows.
    expect(left).toBe(true);
    expect(right).toBe(true);
    const root = folderOf('changes', 'a');
    root.focus();
    press(root);
    expect(fireEvent.keyDown(root, { key: 'ArrowLeft' })).toBe(true);
    expect(root).toHaveFocus();
  });

  it('leaves a modified arrow to the browser', async () => {
    serve(lists);
    mount();
    await screen.findByTestId('scm-group-changes');
    const folder = folderOf('changes', 'a');
    fireEvent.keyDown(folder, { key: 'ArrowLeft', ctrlKey: true });
    fireEvent.keyDown(folder, { key: 'ArrowLeft', altKey: true });
    expect(folder).toHaveAttribute('aria-expanded', 'true');
  });

  it('has no tree keys in the flat list', async () => {
    serve(lists);
    mount();
    await screen.findByTestId('scm-group-changes');
    press(screen.getByTestId('scm-view-toggle'));
    const row = fileOf('changes', 'a/c.ts');
    expect(fireEvent.keyDown(row, { key: 'ArrowLeft' })).toBe(true);
  });
});

describe('A row lives in a scroller, so a folder acts on pointer up and never on a pan', () => {
  const at = (clientY: number) => ({ pointerId: 3, pointerType: 'touch', clientX: 10, clientY });
  const lists = { [APP]: { changes: files('a/x.ts', 'a/y.ts') } };

  it('a tap toggles the folder, once', async () => {
    serve(lists);
    mount();
    await screen.findByTestId('scm-group-changes');
    const folder = folderOf('changes', 'a');
    fireEvent.pointerDown(folder, at(100));
    expect(folder).toHaveAttribute('aria-expanded', 'true');
    fireEvent.pointerUp(folder, at(100));
    expect(folder).toHaveAttribute('aria-expanded', 'false');
  });

  it('a pan that starts on a folder toggles nothing', async () => {
    serve(lists);
    mount();
    await screen.findByTestId('scm-group-changes');
    const folder = folderOf('changes', 'a');
    expect(fireEvent.pointerDown(folder, at(100))).toBe(true);
    fireEvent.pointerMove(folder, at(40));
    fireEvent.pointerUp(folder, at(40));
    expect(folder).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('A long group', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => entry(`dir/file-${String(i).padStart(4, '0')}.ts`));

  it('counts the limit in files: collapsing a folder never swaps the list for plain rows', async () => {
    serve({ [APP]: { changes: [...many(LONG_GROUP_ROWS + 50), entry('other/x.ts')] } });
    mount();
    await screen.findByTestId('scm-vlist-changes');
    const list = screen.getByTestId('scm-vlist-changes');
    expect(rowCountOf(list)).toBe(String(LONG_GROUP_ROWS + 50 + 3));
    expect(list.querySelectorAll('.scm-row, .scm-folder').length).toBeLessThan(100);

    press(folderOf('changes', 'dir'));
    // The folder is folded: two folder rows and one file remain, in the same virtual list.
    const same = screen.getByTestId('scm-vlist-changes');
    expect(same).toBe(list);
    expect(rowsOf('changes')).toEqual(['dir/', 'other/', 'other/x.ts']);
    expect(rowCountOf(same)).toBe('3');
  });

  it('is plain rows up to the limit, folders and all', async () => {
    serve({ [APP]: { changes: many(LONG_GROUP_ROWS) } });
    mount();
    await screen.findByTestId('scm-group-changes');
    expect(document.querySelector('.ui-virtual-list')).toBeNull();
    expect(rowsOf('changes')).toHaveLength(LONG_GROUP_ROWS + 1);
  });

  it('opens the file of a row the virtual list draws', async () => {
    serve({ [APP]: { changes: many(LONG_GROUP_ROWS + 1) } });
    const { onOpenFile } = mount();
    await screen.findByTestId('scm-vlist-changes');
    press(fileOf('changes', 'dir/file-0000.ts'));
    expect(onOpenFile).toHaveBeenCalledWith({ group: 'changes', path: 'dir/file-0000.ts' });
  });

  it('moves focus to the parent folder with ArrowLeft', async () => {
    serve({ [APP]: { changes: many(LONG_GROUP_ROWS + 1) } });
    mount();
    await screen.findByTestId('scm-vlist-changes');
    const file = fileOf('changes', 'dir/file-0000.ts');
    file.focus();
    fireEvent.keyDown(file, { key: 'ArrowLeft' });
    expect(folderOf('changes', 'dir')).toHaveFocus();
  });
});

describe('File icons', () => {
  const INDEX: IconIndex = {
    fileExtensions: { ts: 'typescript' },
    fileNames: {},
    folderNames: { src: 'folder-src' },
    languageIds: {},
    file: 'file',
    folder: 'folder',
    folderExpanded: 'folder-open',
  };

  it('draws a folder icon by the last name of the chain, open or closed', async () => {
    __setIconIndex(INDEX);
    serve({ [APP]: { changes: files('packages/client/src/a.ts', 'z/y.ts', 'z/x.ts') } });
    mount();
    await screen.findByTestId('scm-group-changes');
    const src = folderOf('changes', 'packages/client/src');
    expect(src.querySelector('img')).toHaveAttribute('src', '/file-icons/folder-src-open.svg');
    expect(folderOf('changes', 'z').querySelector('img')).toHaveAttribute(
      'src',
      '/file-icons/folder-open.svg',
    );
    press(folderOf('changes', 'z'));
    expect(folderOf('changes', 'z').querySelector('img')).toHaveAttribute(
      'src',
      '/file-icons/folder.svg',
    );
    press(src);
    expect(src.querySelector('img')).toHaveAttribute('src', '/file-icons/folder-src.svg');
  });

  it('falls back to a folder glyph until the index lands', async () => {
    serve({ [APP]: { changes: files('z/y.ts', 'z/x.ts') } });
    mount();
    await screen.findByTestId('scm-group-changes');
    const folder = folderOf('changes', 'z');
    expect(folder.querySelector('img')).toBeNull();
    expect(folder.querySelector('.scm-glyph-fallback svg')).not.toBeNull();
  });
});

describe('The dock and the drawer are the same tree', () => {
  const lists = {
    [APP]: { changes: files('src/a.ts', 'src/ui/b.ts', 'src/ui/c.ts', 'z.ts') },
  };
  const expected = ['src/', 'src/a.ts', 'src/ui/', 'src/ui/b.ts', 'src/ui/c.ts', 'z.ts'];

  for (const host of ['dock', 'drawer'] as const) {
    it(`in the ${host}: rows, collapse, persistence and the list toggle`, async () => {
      serve(lists);
      mount({ host });
      await screen.findByTestId('scm-group-changes');
      expect(rowsOf('changes')).toEqual(expected);

      press(folderOf('changes', 'src/ui'));
      expect(rowsOf('changes')).toEqual(['src/', 'src/a.ts', 'src/ui/', 'z.ts']);
      expect(stored()).toEqual({ v: 1, byRepo: { [APP]: { changes: ['src/ui'] } } });

      fireEvent.keyDown(folderOf('changes', 'src'), { key: 'ArrowLeft' });
      expect(rowsOf('changes')).toEqual(['src/', 'z.ts']);

      press(screen.getByTestId('scm-view-toggle'));
      expect(rowsOf('changes')).toEqual(['src/a.ts', 'src/ui/b.ts', 'src/ui/c.ts', 'z.ts']);
      expect(screen.getByTestId('scm-view-toggle')).toHaveAccessibleName('View as tree');

      cleanup();
      scmStatusStore.setActiveRepo('');
      mount({ host });
      await screen.findByTestId('scm-group-changes');
      // The list is still the list; the tree it comes back to remembers both folders.
      expect(filesOf('changes')).toHaveLength(4);
      press(screen.getByTestId('scm-view-toggle'));
      expect(rowsOf('changes')).toEqual(['src/', 'z.ts']);
    });
  }

  it('shares one preference between a dock and a drawer on one device', async () => {
    serve(lists);
    mount({ host: 'dock' });
    await screen.findByTestId('scm-group-changes');
    press(screen.getByTestId('scm-view-toggle'));
    cleanup();
    scmStatusStore.setActiveRepo('');
    mount({ host: 'drawer' });
    await screen.findByTestId('scm-group-changes');
    expect(document.querySelector('.scm-folder')).toBeNull();
  });
});
