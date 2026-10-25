// FileTree + FilePane behaviour: the /files/list walk (expand, select, failure)
// and the Read/Edit pane that composes MarkdownPane + EditorPane. Both live
// here because they are one feature and one scoped test run
// (`yarn test --run src/panes/FileTree`).
//
// The two composed panes are mocked: their own contracts have their own tests,
// and Monaco must not load in a unit run. What matters here is OUR glue —
// notably that a toggle does not remount the editor.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, type AtRule, type Rule } from 'postcss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilePane } from './FilePane';
import { FileTree, POLL_INTERVAL_MS } from './FileTree';
import { Icon } from '../ui/icons';

vi.mock('./EditorPane', () => ({
  EditorPane: ({
    active,
    filePath,
    onSaveError,
    onDirtyChange,
  }: {
    active: boolean;
    filePath?: string;
    onSaveError?: (m: string | null) => void;
    onDirtyChange?: (id: string, dirty: boolean) => void;
  }) => (
    <div data-testid="mock-editor" data-active={active} data-file={filePath}>
      <input data-testid="mock-editor-input" defaultValue="" />
      <button data-testid="mock-editor-fail" onClick={() => onSaveError?.('file is not writable')}>
        fail
      </button>
      <button data-testid="mock-editor-dirty" onClick={() => onDirtyChange?.(filePath ?? '', true)}>
        dirty
      </button>
    </div>
  ),
}));

vi.mock('./MarkdownPane', () => ({
  MarkdownPane: ({ tab }: { tab: { url?: string } }) => (
    <div data-testid="mock-markdown">{tab.url}</div>
  ),
}));

interface Entry {
  name: string;
  dir: boolean;
  size: number;
  mtime: number;
  symlink: boolean;
}

const file = (name: string): Entry => ({ name, dir: false, size: 1, mtime: 0, symlink: false });
const folder = (name: string): Entry => ({ name, dir: true, size: 0, mtime: 0, symlink: false });

let fetchMock: ReturnType<typeof vi.fn>;

/** The drawn shapes of a registered icon, to compare against what a control
 *  rendered. Rendered into a detached node so `screen` never sees it. */
const iconPaths = (name: string): string | undefined => {
  const host = document.createElement('div');
  render(<Icon name={name} />, { container: host });
  return host.querySelector('svg')?.innerHTML;
};

/** How many /files/list calls happened — the icon index is not one of them. */
const listCalls = (): number =>
  fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/files/list')).length;

/**
 * Answer /files/list from a dir → entries map; an unmapped dir 404s.
 *
 * A request with NO `dir` is the tree asking the server where home is, and the
 * server answers with the home listing. The fixtures call that root '/', so an
 * absent parameter maps to '/' here — the client never hard-codes a root any more.
 * A test that needs HOME to be a real directory (so that `/work` is not one of
 * its descendants) names it in `home`.
 */
const serve = (byDir: Record<string, Entry[]>, home = '/') => {
  fetchMock.mockImplementation((url: string) => {
    // The tree also fetches the Material icon index on mount. It is not part of
    // the walk these tests measure, and there is nothing vendored in a unit run,
    // so answer it the way a host without icons would.
    if (url.startsWith('/file-icons/')) {
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    }
    const param = new URL(url, 'http://x').searchParams.get('dir');
    const dir = param === null ? home : decodeURIComponent(param);
    const entries = byDir[dir];
    if (!entries) {
      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({ error: 'not found' }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ path: dir, parent: '/', entries }),
    });
  });
};

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // The open roots are remembered per device; without this one test's Explorer
  // would start from the previous test's.
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('FileTree', () => {
  it('lists the root and shows it in the header', async () => {
    serve({ '/': [folder('packages'), file('CLAUDE.md')] });
    render(<FileTree onOpenFile={vi.fn()} />);

    expect(await screen.findByTestId('ft-row-/packages')).toHaveTextContent('packages');
    expect(screen.getByTestId('ft-row-/CLAUDE.md')).toHaveAttribute('data-kind', 'md');
    expect(screen.getByTestId('ft-row-/packages')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('file-tree-path')).toHaveTextContent('/');
    // No `dir` on the first call: the root is the server's home, not a constant.
    expect(fetchMock).toHaveBeenCalledWith('/files/list');
  });

  it('expands a folder without dropping the selection or the scroll position', async () => {
    serve({
      '/': [folder('packages'), file('CLAUDE.md')],
      '/packages': [file('server.ts'), file('readme.md')],
    });
    const onOpenFile = vi.fn();
    render(<FileTree onOpenFile={onOpenFile} />);

    fireEvent.click(await screen.findByTestId('ft-row-/CLAUDE.md'));
    expect(onOpenFile).toHaveBeenCalledWith('/CLAUDE.md');

    const body = screen.getByTestId('file-tree-body');
    body.scrollTop = 40;

    fireEvent.click(screen.getByTestId('ft-row-/packages'));
    expect(await screen.findByTestId('ft-row-/packages/server.ts')).toHaveAttribute(
      'data-kind',
      'code',
    );

    expect(screen.getByTestId('ft-row-/CLAUDE.md')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('file-tree-path')).toHaveTextContent('/CLAUDE.md');
    expect(screen.getByTestId('file-tree-body')).toBe(body); // never remounted
    expect(body.scrollTop).toBe(40);
    expect(screen.getByTestId('ft-row-/packages')).toHaveAttribute('aria-expanded', 'true');
  });

  it('collapses without re-fetching an already loaded folder', async () => {
    serve({ '/': [folder('packages')], '/packages': [file('server.ts')] });
    render(<FileTree onOpenFile={vi.fn()} />);

    fireEvent.click(await screen.findByTestId('ft-row-/packages'));
    await screen.findByTestId('ft-row-/packages/server.ts');
    expect(listCalls()).toBe(2);

    fireEvent.click(screen.getByTestId('ft-row-/packages'));
    // The rows close their space over --mo-micro and are dropped after it.
    expect(screen.getByTestId('ft-row-/packages/server.ts').closest('.ft-leaf')).toHaveAttribute(
      'data-phase',
      'leaving',
    );
    await waitFor(() => expect(screen.queryByTestId('ft-row-/packages/server.ts')).toBeNull());

    fireEvent.click(screen.getByTestId('ft-row-/packages'));
    expect(await screen.findByTestId('ft-row-/packages/server.ts')).toBeTruthy();
    expect(listCalls()).toBe(2);
  });

  it('renders the server error and retries it', async () => {
    serve({});
    render(<FileTree onOpenFile={vi.fn()} />);

    // The ROOT request carries no `dir` — it is asking where home is — so when
    // it fails there is no path to file the error under yet, and the key is
    // empty. The error still renders in place with a retry, which is the claim.
    expect(await screen.findByTestId('ft-error-')).toHaveTextContent('not found');

    serve({ '/': [file('CLAUDE.md')] });
    fireEvent.click(screen.getByTestId('ft-retry-'));
    expect(await screen.findByTestId('ft-row-/CLAUDE.md')).toBeTruthy();
    expect(screen.queryByTestId('ft-error-')).toBeNull();
  });

  it('reports a failed sub-directory in place, leaving the rest of the tree', async () => {
    serve({ '/': [folder('root'), file('CLAUDE.md')] });
    render(<FileTree onOpenFile={vi.fn()} />);

    fireEvent.click(await screen.findByTestId('ft-row-/root'));
    expect(await screen.findByTestId('ft-error-/root')).toHaveTextContent('not found');
    expect(screen.getByTestId('ft-row-/CLAUDE.md')).toBeTruthy();
  });

  it('shows an empty folder as such', async () => {
    serve({ '/': [] });
    render(<FileTree onOpenFile={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('ft-note-/')).toHaveTextContent('empty'));
  });
});

describe('FilePane', () => {
  it('shows the path and offers both views for markdown', () => {
    render(<FilePane path="/p/CLAUDE.md" mode="read" onMode={vi.fn()} />);

    expect(screen.getByTestId('file-pane-path')).toHaveTextContent('/p/CLAUDE.md');
    expect(screen.getByTestId('file-pane-mode-read')).not.toBeDisabled();
    expect(screen.getByTestId('file-pane-read')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('file-pane-edit')).toHaveAttribute('data-active', 'false');
    expect(screen.getByTestId('mock-markdown')).toHaveTextContent('/p/CLAUDE.md');
  });

  it('disables Read for a file with no rendered form and stays on Edit', () => {
    render(<FilePane path="/p/server.ts" mode="read" onMode={vi.fn()} />);

    expect(screen.getByTestId('file-pane-mode-read')).toBeDisabled();
    expect(screen.getByTestId('file-pane-mode-edit')).toHaveAttribute('data-state', 'on');
    expect(screen.queryByTestId('file-pane-read')).toBeNull();
    expect(screen.getByTestId('file-pane-edit')).toHaveAttribute('data-active', 'true');
  });

  it('reports a mode change from the segmented control', async () => {
    const onMode = vi.fn();
    render(<FilePane path="/p/CLAUDE.md" mode="read" onMode={onMode} />);

    fireEvent.click(screen.getByTestId('file-pane-mode-edit'));
    await waitFor(() => expect(onMode).toHaveBeenCalledWith('edit'));
  });

  // The whole point of Edit: the editor writes back to the file the tree
  // opened, not to the host tab's note file (which is what it did while no
  // route could write an arbitrary path).
  it('binds the editor to the opened file', () => {
    render(<FilePane path="/p/CLAUDE.md" mode="edit" onMode={vi.fn()} />);
    expect(screen.getByTestId('mock-editor')).toHaveAttribute('data-file', '/p/CLAUDE.md');
  });

  it('shows a refused save instead of claiming the file is saved', () => {
    render(<FilePane path="/p/server.ts" mode="edit" onMode={vi.fn()} />);
    const saved = screen.getByTestId('file-pane-save-state');
    expect(saved).toHaveTextContent(/^saved$/);
    expect(saved.querySelector('svg')?.innerHTML).toBe(iconPaths('check'));

    fireEvent.click(screen.getByTestId('mock-editor-fail'));

    const state = screen.getByTestId('file-pane-save-state');
    expect(state).toHaveTextContent('file is not writable');
    expect(state).not.toHaveTextContent(/saved/);
    expect(state).toHaveAttribute('data-tone', 'error');
    // The refusal wears the warning icon, not the check it replaced.
    expect(state.querySelector('svg')?.innerHTML).toBe(iconPaths('warning'));
  });

  // The ● of an unsaved buffer is the solid dot now; the word still says it.
  it('marks an unsaved buffer with the dot and the word', () => {
    const onDirtyChange = vi.fn();
    render(
      <FilePane path="/p/server.ts" mode="edit" onMode={vi.fn()} onDirtyChange={onDirtyChange} />,
    );
    fireEvent.click(screen.getByTestId('mock-editor-dirty'));
    const state = screen.getByTestId('file-pane-save-state');
    expect(state).toHaveTextContent(/^unsaved$/);
    expect(state.querySelector('svg')?.innerHTML).toBe(iconPaths('dot'));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  // ✕ is the close icon now, and the button has no text: its label is its name.
  it('closes through a named icon button', () => {
    const onClose = vi.fn();
    render(<FilePane path="/p/server.ts" mode="edit" onMode={vi.fn()} onClose={onClose} />);
    const close = screen.getByRole('button', { name: 'Close file' });
    expect(close).toBe(screen.getByTestId('file-overlay-close'));
    expect(close.textContent).toBe('');
    expect(close.querySelector('svg')?.innerHTML).toBe(iconPaths('close'));
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // The failed-image notice is an alert: its leading ⚠ is the warning icon, and
  // the sentence stays whole (an aria-hidden icon adds nothing to its name).
  it('names a failed image load with the warning icon', () => {
    render(<FilePane path="/p/photo.png" mode="read" onMode={vi.fn()} />);
    fireEvent.error(screen.getByTestId('file-pane-image').querySelector('img') as Element);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/^Could not load this image/);
    expect(alert.querySelector('svg')?.innerHTML).toBe(iconPaths('warning'));
  });

  it('keeps unsaved editor text across a toggle', () => {
    const view = render(<FilePane path="/p/CLAUDE.md" mode="edit" onMode={vi.fn()} />);

    const input = screen.getByTestId('mock-editor-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'unsaved work' } });

    view.rerender(<FilePane path="/p/CLAUDE.md" mode="read" onMode={vi.fn()} />);

    expect(screen.getByTestId('mock-editor-input')).toBe(input); // not remounted
    expect(input.value).toBe('unsaved work');
    expect(screen.getByTestId('file-pane-edit')).toHaveAttribute('data-active', 'false');
  });
});

// ── Explorer roots, selection and the context menu ────────────────────────────
describe('Explorer roots', () => {
  const home = { '/': [folder('packages'), file('CLAUDE.md')], '/work': [file('app.ts')] };

  it('renders HOME as a section, open, plus one per pin', async () => {
    serve(home);
    render(<FileTree onOpenFile={vi.fn()} pins={['/work']} onPinsChange={vi.fn()} />);
    await screen.findByTestId('ft-sect-/');
    expect(screen.getByTestId('ft-sect-/').getAttribute('data-open')).toBe('true');
    expect(screen.getByTestId('ft-sect-/work')).toBeTruthy();
    // A pinned root starts closed — only the newest pin opens, and that happens
    // at pin time, not on every render.
    expect(screen.getByTestId('ft-sect-/work').getAttribute('data-open')).toBe('false');
  });

  it('opens a pinned root on click and lists it', async () => {
    serve(home);
    render(<FileTree onOpenFile={vi.fn()} pins={['/work']} onPinsChange={vi.fn()} />);
    await screen.findByTestId('ft-sect-/work');
    fireEvent.click(screen.getByTestId('ft-sect-toggle-/work'));
    expect(await screen.findByTestId('ft-row-/work/app.ts')).toBeTruthy();
  });

  it('gives every root an always-visible refresh that re-reads its subtree', async () => {
    serve(home);
    render(<FileTree onOpenFile={vi.fn()} pins={['/work']} onPinsChange={vi.fn()} />);
    await screen.findByTestId('ft-row-/packages');
    const before = listCalls();
    fireEvent.click(screen.getByTestId('ft-refresh-/'));
    expect(listCalls()).toBeGreaterThan(before);
  });

  // The root header's controls are icon-only and the icon is aria-hidden, so the
  // aria-label has to carry the name; the caret is the open/closed cue and must
  // change shape with the state.
  it('draws the root header as icons and keeps its controls named', async () => {
    serve(home);
    render(<FileTree onOpenFile={vi.fn()} pins={['/work']} onPinsChange={vi.fn()} />);
    await screen.findByTestId('ft-row-/packages'); // home's listing has landed
    const caret = (r: string) =>
      screen.getByTestId(`ft-sect-toggle-${r}`).querySelector('.ft-sect-caret svg')?.innerHTML;
    expect(caret('/')).toBe(iconPaths('chevron-down')); // open
    expect(caret('/work')).toBe(iconPaths('chevron-right')); // closed
    fireEvent.click(screen.getByTestId('ft-sect-toggle-/work'));
    expect(caret('/work')).toBe(iconPaths('chevron-down')); // the cue follows the state

    for (const [id, label, icon] of [
      ['ft-refresh-/work', 'Refresh work', 'reload'],
      ['ft-unpin-/work', 'Unpin work', 'close'],
    ] as const) {
      const button = screen.getByTestId(id);
      expect(button.querySelectorAll('svg')).toHaveLength(1);
      expect(button.querySelector('svg')?.innerHTML).toBe(iconPaths(icon));
      expect(button.textContent).toBe('');
      expect(button).toHaveAttribute('aria-label', label);
    }
  });

  it('draws the caret and fallback glyph of a row as icons: a folder, a file, a state', async () => {
    serve({ '/': [folder('pkg'), file('a.txt')], '/pkg': [file('inner.txt')] });
    render(<FileTree onOpenFile={vi.fn()} pins={[]} onPinsChange={vi.fn()} />);
    await screen.findByTestId('ft-row-/a.txt');
    const dir = screen.getByTestId('ft-row-/pkg');
    const leaf = screen.getByTestId('ft-row-/a.txt');
    expect(dir.querySelector('.ft-caret svg')?.innerHTML).toBe(iconPaths('chevron-right'));
    expect(leaf.querySelector('.ft-caret svg')).toBeNull(); // a file has nothing to open
    expect(dir.querySelector('.ft-glyph-fallback svg')?.innerHTML).toBe(iconPaths('folder'));
    expect(leaf.querySelector('.ft-glyph-fallback svg')?.innerHTML).toBe(iconPaths('file'));

    fireEvent.click(dir); // opening a folder turns its caret down
    await screen.findByTestId('ft-row-/pkg/inner.txt');
    expect(screen.getByTestId('ft-row-/pkg').querySelector('.ft-caret svg')?.innerHTML).toBe(
      iconPaths('chevron-down'),
    );
  });

  it('offers unpin on a pinned root only', async () => {
    const onPinsChange = vi.fn();
    serve(home);
    render(<FileTree onOpenFile={vi.fn()} pins={['/work']} onPinsChange={onPinsChange} />);
    await screen.findByTestId('ft-sect-/work');
    expect(screen.queryByTestId('ft-unpin-/')).toBeNull();
    fireEvent.click(screen.getByTestId('ft-unpin-/work'));
    expect(onPinsChange).toHaveBeenCalledWith([]);
  });

  // Reported behaviour: pinning collapses everything else and focuses the new
  // root. Without it a pin appears somewhere below the fold of an open home.
  it('pinning a folder collapses the others and opens the new one', async () => {
    const onPinsChange = vi.fn();
    serve(home);
    const { rerender } = render(
      <FileTree onOpenFile={vi.fn()} pins={[]} onPinsChange={onPinsChange} />,
    );
    await screen.findByTestId('ft-row-/packages');
    fireEvent.contextMenu(screen.getByTestId('ft-row-/packages'));
    fireEvent.click(await screen.findByTestId('ft-menu-/packages-pin'));
    expect(onPinsChange).toHaveBeenCalledWith(['/packages']);

    rerender(<FileTree onOpenFile={vi.fn()} pins={['/packages']} onPinsChange={onPinsChange} />);
    await screen.findByTestId('ft-sect-/packages');
    expect(screen.getByTestId('ft-sect-/packages').getAttribute('data-open')).toBe('true');
    expect(screen.getByTestId('ft-sect-/').getAttribute('data-open')).toBe('false');
  });
});

// ── Which root sections are open is remembered per device ─────────────────────
describe('Explorer remembers its open roots', () => {
  const KEY = 'palmux-explorer-open';
  const home = { '/': [folder('packages'), file('CLAUDE.md')] };
  const pinned = { ...home, '/pinned/x': [file('x.ts')] };

  const seed = (open: string[]): string => {
    const raw = JSON.stringify({ v: 1, open });
    localStorage.setItem(KEY, raw);
    return raw;
  };
  const stored = (): unknown => JSON.parse(localStorage.getItem(KEY) ?? 'null');
  const isOpen = (root: string): string | null =>
    screen.getByTestId(`ft-sect-${root}`).getAttribute('data-open');
  const tree = (pins: string[] = [], onPinsChange = vi.fn()) => (
    <FileTree onOpenFile={vi.fn()} pins={pins} onPinsChange={onPinsChange} />
  );
  /** The `dir` of every /files/list call so far (null = "where is home?"). */
  const listedDirs = (): (string | null)[] =>
    fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.startsWith('/files/list'))
      .map((url) => new URL(url, 'http://x').searchParams.get('dir'));

  it('opens HOME on a first run and stores that state', async () => {
    serve(home);
    render(tree());

    expect(await screen.findByTestId('ft-row-/packages')).toBeTruthy();
    expect(isOpen('/')).toBe('true');
    await waitFor(() => expect(stored()).toEqual({ v: 1, open: ['/'] }));
  });

  it('keeps a collapsed HOME collapsed across an unmount and a remount', async () => {
    serve(home);
    const first = render(tree());
    await screen.findByTestId('ft-row-/packages');

    fireEvent.click(screen.getByTestId('ft-sect-toggle-/'));
    expect(isOpen('/')).toBe('false');
    expect(stored()).toEqual({ v: 1, open: [] });
    first.unmount();

    // The dock's Explorer view mounting again, as it does on every open.
    render(tree());
    await screen.findByTestId('ft-sect-/');
    await act(async () => {
      await Promise.resolve();
    });
    expect(isOpen('/')).toBe('false');
    expect(screen.queryByTestId('ft-row-/packages')).toBeNull();
    // Remembering "collapsed" is not the same as remembering nothing: the empty
    // set stays stored, so the next device start does not read as a first run.
    expect(stored()).toEqual({ v: 1, open: [] });
  });

  it('stores a header toggle, dormant entries included', async () => {
    seed(['/', '/gone']);
    serve({ ...home, '/work': [file('app.ts')] });
    render(tree(['/work']));
    await screen.findByTestId('ft-row-/packages');

    fireEvent.click(screen.getByTestId('ft-sect-toggle-/work'));
    expect(await screen.findByTestId('ft-row-/work/app.ts')).toBeTruthy();
    // `/gone` is not a root today. It stays: a toggle stores the whole set.
    expect(stored()).toEqual({ v: 1, open: ['/', '/gone', '/work'] });

    fireEvent.click(screen.getByTestId('ft-sect-toggle-/'));
    expect(stored()).toEqual({ v: 1, open: ['/gone', '/work'] });
  });

  it('stores exactly the new root when a folder is pinned', async () => {
    seed(['/', '/gone']);
    serve(home);
    const onPinsChange = vi.fn();
    render(tree([], onPinsChange));
    await screen.findByTestId('ft-row-/packages');

    fireEvent.contextMenu(screen.getByTestId('ft-row-/packages'));
    fireEvent.click(await screen.findByTestId('ft-menu-/packages-pin'));
    expect(onPinsChange).toHaveBeenCalledWith(['/packages']);
    // Pinning replaces the set by design, which also clears the dormant `/gone`.
    expect(stored()).toEqual({ v: 1, open: ['/packages'] });
  });

  // B8-02: the section is open but only `expanded` paths are fetched, so a
  // restored root must be expanded for its rows to appear without a click.
  it('opens and lists a remembered pinned root when the pins arrive AFTER home', async () => {
    const raw = seed(['/', '/pinned/x']);
    serve(pinned);
    const { rerender } = render(tree());
    await screen.findByTestId('ft-row-/packages');

    rerender(tree(['/pinned/x']));
    expect(await screen.findByTestId('ft-row-/pinned/x/x.ts')).toBeTruthy();
    expect(isOpen('/')).toBe('true');
    expect(isOpen('/pinned/x')).toBe('true');
    expect(fetchMock).toHaveBeenCalledWith('/files/list?dir=%2Fpinned%2Fx');
    // Nothing the user did, so nothing was written: the stored set is untouched.
    expect(localStorage.getItem(KEY)).toBe(raw);
  });

  it('opens and lists a remembered pinned root when the pins arrive BEFORE home', async () => {
    const raw = seed(['/', '/pinned/x']);
    serve(pinned);
    // Hold the "where is home?" answer so the pins are known first.
    let releaseHome!: () => void;
    const homeGate = new Promise<void>((resolve) => {
      releaseHome = resolve;
    });
    const answer = fetchMock.getMockImplementation() as (url: string) => Promise<unknown>;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/files/list') await homeGate;
      return answer(url);
    });

    render(tree(['/pinned/x']));
    expect(await screen.findByTestId('ft-row-/pinned/x/x.ts')).toBeTruthy();
    expect(screen.queryByTestId('ft-sect-/')).toBeNull(); // HOME is still unknown

    releaseHome();
    expect(await screen.findByTestId('ft-row-/packages')).toBeTruthy();
    // The race that a prune keyed to the live root list would lose: HOME arriving
    // second must find its flag still stored.
    expect(isOpen('/')).toBe('true');
    expect(isOpen('/pinned/x')).toBe('true');
    expect(localStorage.getItem(KEY)).toBe(raw);
  });

  it('stops showing an unpinned root but does not erase its stored flag', async () => {
    const raw = seed(['/', '/work']);
    serve({ ...home, '/work': [file('app.ts')] });
    const { rerender } = render(tree(['/work']));
    expect(await screen.findByTestId('ft-row-/work/app.ts')).toBeTruthy();

    rerender(tree([]));
    expect(screen.queryByTestId('ft-sect-/work')).toBeNull();
    expect(screen.queryByTestId('ft-row-/work/app.ts')).toBeNull();
    expect(localStorage.getItem(KEY)).toBe(raw);

    // Pinned again, it comes back open: the flag was never deleted.
    rerender(tree(['/work']));
    expect(await screen.findByTestId('ft-row-/work/app.ts')).toBeTruthy();
    expect(isOpen('/work')).toBe('true');
  });

  // B8-03: the poll must read the same live intersection as the rendering does.
  // HOME is a real directory here: with HOME at '/', every path is its descendant
  // and HOME's own poll would re-read `/work` for the wrong reason.
  it('stops polling an unpinned root while its stored flag remains', async () => {
    seed(['/home/u', '/work']);
    serve(
      {
        '/home/u': [file('a.txt')],
        '/work': [folder('sub'), file('app.ts')],
        '/work/sub': [file('deep.ts')],
      },
      '/home/u',
    );
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const { rerender } = render(tree(['/work']));
    fireEvent.click(await screen.findByTestId('ft-row-/work/sub'));
    expect(await screen.findByTestId('ft-row-/work/sub/deep.ts')).toBeTruthy();
    expect(listedDirs()).toContain('/work/sub'); // a descendant is loaded too

    rerender(tree([]));
    expect(screen.queryByTestId('ft-sect-/work')).toBeNull();
    fetchMock.mockClear();

    const poll = intervals.mock.calls.find(([, delay]) => delay === POLL_INTERVAL_MS)?.[0];
    expect(typeof poll).toBe('function');
    act(() => (poll as () => void)());
    // The positive control: the poll ran, and it re-read the root that IS open.
    await waitFor(() => expect(listedDirs()).toContain('/home/u'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(listedDirs().filter((d) => d === '/work' || d?.startsWith('/work/'))).toEqual([]);
    expect(stored()).toEqual({ v: 1, open: ['/home/u', '/work'] });
    intervals.mockRestore();
  });

  // B8-CODE-01: on a first run HOME's default ("open") is owed until HOME is
  // known, however long its request takes, and toggling another root meanwhile
  // must not settle it. HOME is a real directory so `/work` is not inside it.
  const workHome = {
    '/home/u': [file('a.txt')],
    '/work': [folder('sub'), file('app.ts')],
    '/work/sub': [file('deep.ts')],
  };
  /** Hold the "where is home?" answer until the returned function is called. */
  const holdHome = (): (() => void) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answer = fetchMock.getMockImplementation() as (url: string) => Promise<unknown>;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/files/list') await gate;
      return answer(url);
    });
    return release;
  };

  it('opens HOME on a first run when another root was toggled before HOME arrived', async () => {
    serve(workHome, '/home/u');
    const releaseHome = holdHome();
    const first = render(tree(['/work']));
    fireEvent.click(await screen.findByTestId('ft-sect-toggle-/work'));
    expect(await screen.findByTestId('ft-row-/work/app.ts')).toBeTruthy();
    expect(screen.queryByTestId('ft-sect-/home/u')).toBeNull(); // HOME is still unknown

    releaseHome();
    expect(await screen.findByTestId('ft-row-/home/u/a.txt')).toBeTruthy();
    expect(isOpen('/home/u')).toBe('true');
    expect(isOpen('/work')).toBe('true');
    expect(stored()).toEqual({ v: 1, open: ['/work', '/home/u'] });

    // Stored, not just shown: the next mount reads HOME open back.
    first.unmount();
    render(tree(['/work']));
    expect(await screen.findByTestId('ft-row-/home/u/a.txt')).toBeTruthy();
    expect(isOpen('/home/u')).toBe('true');
  });

  it('opens HOME on a first run when another root was toggled while HOME awaited a retry', async () => {
    serve({ '/work': workHome['/work'] }, '/home/u'); // "where is home?" fails
    render(tree(['/work']));
    expect(await screen.findByTestId('ft-error-')).toHaveTextContent('not found');
    fireEvent.click(screen.getByTestId('ft-sect-toggle-/work'));
    expect(await screen.findByTestId('ft-row-/work/app.ts')).toBeTruthy();

    serve(workHome, '/home/u');
    fireEvent.click(screen.getByTestId('ft-retry-'));
    expect(await screen.findByTestId('ft-row-/home/u/a.txt')).toBeTruthy();
    expect(isOpen('/home/u')).toBe('true');
    expect(isOpen('/work')).toBe('true');
    expect(stored()).toEqual({ v: 1, open: ['/work', '/home/u'] });
  });

  it('stays a first run across a remount until HOME has arrived', async () => {
    serve(workHome, '/home/u');
    const releaseHome = holdHome();
    const first = render(tree(['/work']));
    fireEvent.click(await screen.findByTestId('ft-sect-toggle-/work'));
    expect(await screen.findByTestId('ft-row-/work/app.ts')).toBeTruthy();
    // Nothing is written while HOME's default is owed: a set stored without HOME
    // would make the next mount read "HOME collapsed" instead of "first run".
    expect(localStorage.getItem(KEY)).toBeNull();
    first.unmount();

    render(tree(['/work']));
    releaseHome();
    expect(await screen.findByTestId('ft-row-/home/u/a.txt')).toBeTruthy();
    expect(isOpen('/home/u')).toBe('true');
    // The price: a toggle made before HOME was ever known did not survive the
    // remount, because it was never written.
    expect(stored()).toEqual({ v: 1, open: ['/home/u'] });
  });

  it('keeps HOME collapsed when a folder was pinned before HOME arrived', async () => {
    serve(workHome, '/home/u');
    const releaseHome = holdHome();
    const onPinsChange = vi.fn();
    const { rerender } = render(tree(['/work'], onPinsChange));
    fireEvent.click(await screen.findByTestId('ft-sect-toggle-/work'));
    fireEvent.contextMenu(await screen.findByTestId('ft-row-/work/sub'));
    fireEvent.click(await screen.findByTestId('ft-menu-/work/sub-pin'));
    expect(onPinsChange).toHaveBeenCalledWith(['/work/sub', '/work']);
    expect(stored()).toEqual({ v: 1, open: ['/work/sub'] });

    rerender(tree(['/work/sub', '/work'], onPinsChange));
    releaseHome();
    await screen.findByTestId('ft-sect-/home/u');
    await act(async () => {
      await Promise.resolve();
    });
    // A pin replaces the whole set, and HOME's owed default is part of it.
    expect(isOpen('/home/u')).toBe('false');
    expect(isOpen('/work/sub')).toBe('true');
    expect(stored()).toEqual({ v: 1, open: ['/work/sub'] });
  });

  it('respects a choice about HOME made through a pin equal to it before HOME arrived', async () => {
    serve(workHome, '/home/u');
    const releaseHome = holdHome();
    render(tree(['/home/u']));
    // Until HOME is known this is an ordinary pinned section that happens to be
    // HOME's path. Opened and closed again, it is an explicit "closed".
    const toggle = await screen.findByTestId('ft-sect-toggle-/home/u');
    fireEvent.click(toggle);
    expect(await screen.findByTestId('ft-row-/home/u/a.txt')).toBeTruthy();
    fireEvent.click(toggle);

    releaseHome();
    // HOME has landed once the section stops being a pin (no unpin control).
    await waitFor(() => expect(screen.queryByTestId('ft-unpin-/home/u')).toBeNull());
    expect(isOpen('/home/u')).toBe('false');
    expect(stored()).toEqual({ v: 1, open: [] });
  });

  // B8-CODE-02: a root is seeded into the shared `expanded` set as it ENTERS the
  // open set, never again while it stays open. A pin nested in HOME is also a
  // folder row inside HOME, so re-seeding it reopened that row.
  const nested = {
    '/home/u': [folder('project'), file('a.txt')],
    '/home/u/project': [file('p.ts')],
    '/work': [file('app.ts')],
  };
  /** A row inside one root's section: the same path can be a row in two sections. */
  const rowIn = (root: string, path: string): Element => {
    const row = screen
      .getByTestId(`ft-sect-${root}`)
      .querySelector(`[data-testid="ft-row-${path}"]`);
    if (!row) throw new Error(`no row ${path} in the ${root} section`);
    return row;
  };
  const projectInHome = (): Element => rowIn('/home/u', '/home/u/project');
  /** Restore all three roots open, then collapse `project` inside HOME. */
  const collapseProjectInHome = async () => {
    seed(['/home/u', '/home/u/project', '/work']);
    serve(nested, '/home/u');
    const view = render(tree(['/home/u/project', '/work']));
    expect(await screen.findByTestId('ft-row-/work/app.ts')).toBeTruthy();
    // The restore seeded the pinned root into `expanded`, so its folder inside
    // HOME opens with it — what opening that section's header has always done.
    await waitFor(() => expect(projectInHome()).toHaveAttribute('aria-expanded', 'true'));
    fireEvent.click(projectInHome());
    expect(projectInHome()).toHaveAttribute('aria-expanded', 'false');
    // Its own pinned section is untouched: a root lists itself regardless.
    expect(rowIn('/home/u/project', '/home/u/project/p.ts')).toBeTruthy();
    return view;
  };

  it('keeps a folder collapsed inside HOME when an unrelated root is toggled', async () => {
    await collapseProjectInHome();

    fireEvent.click(screen.getByTestId('ft-sect-toggle-/work'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(isOpen('/work')).toBe('false');
    expect(projectInHome()).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps a folder collapsed inside HOME when the same pins arrive as a new array', async () => {
    const { rerender } = await collapseProjectInHome();

    // A settings broadcast: `sanitize` hands back a fresh array, same content.
    rerender(tree(['/home/u/project', '/work']));
    await act(async () => {
      await Promise.resolve();
    });
    expect(projectInHome()).toHaveAttribute('aria-expanded', 'false');
  });

  it('still renders when storage throws on read and on write', async () => {
    const denied = vi.fn(() => {
      throw new Error('denied');
    });
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied, removeItem: denied });
    serve(home);
    render(tree());

    // Nothing readable, so it is a first run: HOME opens.
    expect(await screen.findByTestId('ft-row-/packages')).toBeTruthy();
    expect(isOpen('/')).toBe('true');
    expect(denied).toHaveBeenCalled();

    // The toggle still works for this mount; it just cannot be remembered.
    fireEvent.click(screen.getByTestId('ft-sect-toggle-/'));
    expect(isOpen('/')).toBe('false');
    fireEvent.click(screen.getByTestId('ft-sect-toggle-/'));
    expect(isOpen('/')).toBe('true');
  });
});

describe('Explorer context menu', () => {
  const tree = { '/': [folder('pkg'), file('a.txt')] };

  it('offers file actions on a file and folder actions on a folder', async () => {
    serve(tree);
    render(<FileTree onOpenFile={vi.fn()} pins={[]} onPinsChange={vi.fn()} />);
    await screen.findByTestId('ft-row-/a.txt');

    fireEvent.contextMenu(screen.getByTestId('ft-row-/a.txt'));
    expect(await screen.findByTestId('ft-menu-/a.txt-open')).toBeTruthy();
    expect(screen.queryByTestId('ft-menu-/a.txt-pin')).toBeNull();
    for (const id of ['download', 'select', 'delete']) {
      expect(screen.getByTestId(`ft-menu-/a.txt-${id}`), id).toBeTruthy();
    }
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    fireEvent.contextMenu(screen.getByTestId('ft-row-/pkg'));
    expect(await screen.findByTestId('ft-menu-/pkg-pin')).toBeTruthy();
    expect(screen.queryByTestId('ft-menu-/pkg-open')).toBeNull();
  });

  it('gives every menu item an icon, not a glyph character', async () => {
    serve(tree);
    render(<FileTree onOpenFile={vi.fn()} pins={[]} onPinsChange={vi.fn()} />);
    await screen.findByTestId('ft-row-/a.txt');
    fireEvent.contextMenu(screen.getByTestId('ft-row-/a.txt'));
    for (const [id, name] of [
      ['open', 'external'],
      ['download', 'download'],
      ['select', 'checkbox-on'],
      ['delete', 'close'],
    ] as const) {
      const item = await screen.findByTestId(`ft-menu-/a.txt-${id}`);
      const icon = item.querySelector('.ui-menu-icon');
      expect(icon?.querySelectorAll('svg'), id).toHaveLength(1);
      expect(icon?.querySelector('svg')?.innerHTML, id).toBe(iconPaths(name));
      expect(icon?.textContent, id).toBe('');
      // The label is still the item's accessible name: the icon adds none.
      expect(item.textContent, id).not.toBe('');
    }
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    fireEvent.contextMenu(screen.getByTestId('ft-row-/pkg'));
    const pin = await screen.findByTestId('ft-menu-/pkg-pin');
    expect(pin.querySelector('.ui-menu-icon svg')?.innerHTML).toBe(iconPaths('pin'));
  });

  it('Open on a file hands the path to the host', async () => {
    const onOpenFile = vi.fn();
    serve(tree);
    render(<FileTree onOpenFile={onOpenFile} pins={[]} onPinsChange={vi.fn()} />);
    await screen.findByTestId('ft-row-/a.txt');
    fireEvent.contextMenu(screen.getByTestId('ft-row-/a.txt'));
    fireEvent.click(await screen.findByTestId('ft-menu-/a.txt-open'));
    expect(onOpenFile).toHaveBeenCalledWith('/a.txt');
  });
});

describe('Explorer bulk selection', () => {
  const tree = { '/': [folder('pkg'), file('a.txt'), file('b.txt')] };

  const enterSelect = async () => {
    serve(tree);
    render(<FileTree onOpenFile={vi.fn()} pins={[]} onPinsChange={vi.fn()} onNotice={vi.fn()} />);
    await screen.findByTestId('ft-row-/a.txt');
    fireEvent.contextMenu(screen.getByTestId('ft-row-/a.txt'));
    fireEvent.click(await screen.findByTestId('ft-menu-/a.txt-select'));
    return screen.findByTestId('ft-bulk');
  };

  it('Select enters the mode with that row already picked', async () => {
    await enterSelect();
    expect(screen.getByTestId('ft-bulk')).toHaveTextContent('1 selected');
    expect(screen.getByTestId('ft-row-/a.txt').getAttribute('data-picked')).toBe('true');
  });

  // The pick mark and the bar's buttons are icons now; picked and unpicked
  // must still LOOK different, since that is the whole selection UI.
  it('draws the pick marks as icons that differ when picked', async () => {
    await enterSelect();
    const mark = (path: string) =>
      screen.getByTestId(`ft-row-${path}`).querySelector('.ft-pick svg')?.innerHTML;
    expect(mark('/a.txt')).toBe(iconPaths('checkbox-on')); // picked
    expect(mark('/b.txt')).toBe(iconPaths('checkbox-off'));
    fireEvent.click(screen.getByTestId('ft-row-/b.txt')); // and it follows the pick
    expect(mark('/b.txt')).toBe(iconPaths('checkbox-on'));
    expect(screen.getByTestId('ft-bulk-download').querySelector('svg')?.innerHTML).toBe(
      iconPaths('download'),
    );
    expect(screen.getByTestId('ft-bulk-download')).toHaveTextContent(/^Download$/);
    expect(screen.getByTestId('ft-bulk-delete').querySelector('svg')?.innerHTML).toBe(
      iconPaths('close'),
    );
    expect(screen.getByTestId('ft-bulk-delete')).toHaveTextContent(/^Delete$/);
  });

  // A mode whose rows still opened files would make building a selection
  // impossible: every attempt to add one would also navigate.
  it('a click PICKS instead of opening while selecting', async () => {
    await enterSelect();
    fireEvent.click(screen.getByTestId('ft-row-/b.txt'));
    expect(screen.getByTestId('ft-bulk')).toHaveTextContent('2 selected');
    fireEvent.click(screen.getByTestId('ft-row-/b.txt'));
    expect(screen.getByTestId('ft-bulk')).toHaveTextContent('1 selected');
  });

  it('Cancel leaves the mode entirely, not just the selection', async () => {
    await enterSelect();
    fireEvent.click(screen.getByTestId('ft-bulk-cancel'));
    expect(screen.queryByTestId('ft-bulk')).toBeNull();
    expect(screen.getByTestId('ft-row-/a.txt').getAttribute('data-picked')).toBe('false');
  });

  it('deletes the selection behind one confirm, then re-reads the parent', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await enterSelect();
    fireEvent.click(screen.getByTestId('ft-row-/b.txt'));

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url) === '/files/delete') {
        const paths = JSON.parse(String(init?.body ?? '{}')).paths as string[];
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            results: paths.map((p) => ({ path: p, ok: true, kind: 'file' })),
          }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ path: '/', parent: null, entries: [] }) });
    });

    fireEvent.click(screen.getByTestId('ft-bulk-delete'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u) === '/files/delete')).toBe(true),
    );
    // ONE confirm for the whole selection, not one per path.
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0]?.[0]).toContain('Delete 2 items?');
    confirmSpy.mockRestore();
  });

  it('a refused confirm deletes nothing', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await enterSelect();
    fireEvent.click(screen.getByTestId('ft-bulk-delete'));
    expect(fetchMock.mock.calls.some(([u]) => String(u) === '/files/delete')).toBe(false);
    confirmSpy.mockRestore();
  });
});

// ── Rows entering and leaving ─────────────────────────────────────────────────
//
// Real timers: the hook holds a removed row for --mo-micro (140ms when no
// stylesheet defines the token, as in a unit run), which `waitFor` outlasts.
describe('Explorer row enter and exit', () => {
  const leafOf = (path: string): Element | null =>
    screen.getByTestId(`ft-row-${path}`).closest('.ft-leaf');

  /** A home listing that a delete edits, and the /files/delete route that edits it. */
  const serveEditable = (listing: { current: Entry[] }) => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/file-icons/')) {
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      }
      if (url === '/files/delete') {
        const paths = JSON.parse(String(init?.body ?? '{}')).paths as string[];
        listing.current = listing.current.filter((e) => !paths.includes(`/${e.name}`));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ results: paths.map((p) => ({ path: p, ok: true, kind: 'file' })) }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ path: '/', parent: null, entries: listing.current }),
      });
    });
  };

  const deleteViaMenu = async (path: string) => {
    fireEvent.contextMenu(screen.getByTestId(`ft-row-${path}`));
    fireEvent.click(await screen.findByTestId(`ft-menu-${path}-delete`));
  };

  it('runs the first fill on the stagger tier and a row inserted later on the micro one', async () => {
    serve({ '/': [folder('pkg'), file('a.txt')], '/pkg': [file('inner.txt')] });
    render(<FileTree onOpenFile={vi.fn()} pins={[]} onPinsChange={vi.fn()} />);

    await screen.findByTestId('ft-row-/a.txt');
    // The list's first fill never runs the micro enter.
    expect(leafOf('/pkg')).toHaveAttribute('data-enter', 'stagger');
    expect(leafOf('/a.txt')).toHaveAttribute('data-enter', 'stagger');
    await waitFor(() => expect(leafOf('/a.txt')).toHaveAttribute('data-phase', 'present'));
    // Each row carries its position, which the stylesheet turns into the stagger step.
    expect(leafOf('/pkg')).toHaveStyle('--ft-i: 0');
    expect(leafOf('/a.txt')).toHaveStyle('--ft-i: 1');

    fireEvent.click(screen.getByTestId('ft-row-/pkg'));
    await screen.findByTestId('ft-row-/pkg/inner.txt');
    expect(leafOf('/pkg/inner.txt')).toHaveAttribute('data-enter', 'micro');
    // The rows that were already there keep the tier they arrived on.
    expect(leafOf('/a.txt')).toHaveAttribute('data-enter', 'stagger');
  });

  it('fades a deleted row and leaves its siblings alone, then drops it', async () => {
    const listing = { current: [file('a.txt'), file('b.txt'), file('c.txt')] };
    serveEditable(listing);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<FileTree onOpenFile={vi.fn()} pins={[]} onPinsChange={vi.fn()} onNotice={vi.fn()} />);
    await screen.findByTestId('ft-row-/b.txt');
    await waitFor(() => expect(leafOf('/b.txt')).toHaveAttribute('data-phase', 'present'));

    await deleteViaMenu('/b.txt');

    // The parent is re-read, and only the row that is gone leaves.
    await waitFor(() => expect(leafOf('/b.txt')).toHaveAttribute('data-phase', 'leaving'));
    expect(leafOf('/a.txt')).toHaveAttribute('data-phase', 'present');
    expect(leafOf('/c.txt')).toHaveAttribute('data-phase', 'present');
    // No "Loading…" note took the list's place while it was re-read.
    expect(screen.queryByTestId('ft-note-/')).toBeNull();
    // Mounted rows keep their order, the leaving one where it was.
    const order = [...screen.getByTestId('file-tree-body').querySelectorAll('.ft-row')].map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(order).toEqual(['ft-row-/a.txt', 'ft-row-/b.txt', 'ft-row-/c.txt']);

    await waitFor(() => expect(screen.queryByTestId('ft-row-/b.txt')).toBeNull());
    expect(screen.getByTestId('ft-row-/a.txt')).toBeTruthy();
    expect(screen.getByTestId('ft-row-/c.txt')).toBeTruthy();
  });

  it('takes no click and no focus from a row on its way out', async () => {
    const onOpenFile = vi.fn();
    const listing = { current: [file('a.txt'), file('b.txt')] };
    serveEditable(listing);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<FileTree onOpenFile={onOpenFile} pins={[]} onPinsChange={vi.fn()} onNotice={vi.fn()} />);
    await screen.findByTestId('ft-row-/b.txt');

    await deleteViaMenu('/b.txt');
    await waitFor(() => expect(leafOf('/b.txt')).toHaveAttribute('data-phase', 'leaving'));

    expect(leafOf('/b.txt')).toHaveAttribute('inert');
    expect(leafOf('/a.txt')).not.toHaveAttribute('inert');
    await waitFor(() => expect(screen.queryByTestId('ft-row-/b.txt')).toBeNull());
  });

  it('keeps a loaded listing on screen while a refresh re-reads it', async () => {
    serve({ '/': [folder('pkg'), file('a.txt')] });
    render(<FileTree onOpenFile={vi.fn()} pins={[]} onPinsChange={vi.fn()} />);
    await screen.findByTestId('ft-row-/a.txt');
    await waitFor(() => expect(leafOf('/a.txt')).toHaveAttribute('data-phase', 'present'));
    const before = listCalls();

    fireEvent.click(screen.getByTestId('ft-refresh-/'));

    expect(listCalls()).toBeGreaterThan(before);
    // Neither dropped nor leaving: a refresh that changed nothing changes nothing.
    expect(screen.queryByTestId('ft-note-/')).toBeNull();
    expect(leafOf('/a.txt')).toHaveAttribute('data-phase', 'present');
    expect(leafOf('/pkg')).toHaveAttribute('data-phase', 'present');
    await waitFor(() => expect(listCalls()).toBe(before + 1));
    expect(leafOf('/a.txt')).toHaveAttribute('data-phase', 'present');
  });

  it('still shows "Loading…" for a directory that has never been read', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/file-icons/')) return { ok: false, status: 404, json: async () => ({}) };
      const dir = new URL(url, 'http://x').searchParams.get('dir');
      if (dir === '/pkg') await gate;
      const entries = dir === '/pkg' ? [file('inner.txt')] : [folder('pkg')];
      return { ok: true, status: 200, json: async () => ({ path: dir ?? '/', parent: null, entries }) };
    });
    render(<FileTree onOpenFile={vi.fn()} pins={[]} onPinsChange={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('ft-row-/pkg'));

    expect(await screen.findByTestId('ft-note-/pkg')).toHaveTextContent('Loading…');
    release?.();
    expect(await screen.findByTestId('ft-row-/pkg/inner.txt')).toBeTruthy();
    // The note is a row like any other: it closes its space, then goes, while the
    // listing that replaced it arrives on the micro tier (the list is not new).
    expect(screen.getByTestId('ft-note-/pkg').closest('.ft-leaf')).toHaveAttribute(
      'data-phase',
      'leaving',
    );
    expect(leafOf('/pkg/inner.txt')).toHaveAttribute('data-enter', 'micro');
    await waitFor(() => expect(screen.queryByTestId('ft-note-/pkg')).toBeNull());
    await waitFor(() => expect(leafOf('/pkg/inner.txt')).toHaveAttribute('data-phase', 'present'));
  });

  // A first fill runs on the stagger tier, whose 380ms + a delay per row would
  // make a delete feel stuck if the exit kept it.
  it('lets a row that arrived on the stagger tier leave on the micro one', async () => {
    const listing = { current: [file('a.txt'), file('b.txt')] };
    serveEditable(listing);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<FileTree onOpenFile={vi.fn()} pins={[]} onPinsChange={vi.fn()} onNotice={vi.fn()} />);
    await screen.findByTestId('ft-row-/b.txt');
    await waitFor(() => expect(leafOf('/b.txt')).toHaveAttribute('data-phase', 'present'));
    expect(leafOf('/b.txt')).toHaveAttribute('data-enter', 'stagger');

    await deleteViaMenu('/b.txt');

    await waitFor(() => expect(leafOf('/b.txt')).toHaveAttribute('data-phase', 'leaving'));
    expect(leafOf('/b.txt')).toHaveAttribute('data-enter', 'micro');
    // The sibling that stays keeps the tier it arrived on.
    expect(leafOf('/a.txt')).toHaveAttribute('data-enter', 'stagger');
    await waitFor(() => expect(screen.queryByTestId('ft-row-/b.txt')).toBeNull());
  });

  // The change is a transition, not a keyframe, because it can be interrupted: a
  // folder opened again while its rows are still closing must bring THOSE rows
  // back, not drop them a moment later or replay an entrance.
  it('brings a closing folder back without remounting its rows, and keeps them', async () => {
    serve({ '/': [folder('pkg')], '/pkg': [file('inner.txt')] });
    render(<FileTree onOpenFile={vi.fn()} pins={[]} onPinsChange={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('ft-row-/pkg'));
    const inner = await screen.findByTestId('ft-row-/pkg/inner.txt');
    await waitFor(() => expect(leafOf('/pkg/inner.txt')).toHaveAttribute('data-phase', 'present'));

    fireEvent.click(screen.getByTestId('ft-row-/pkg')); // collapse
    expect(leafOf('/pkg/inner.txt')).toHaveAttribute('data-phase', 'leaving');
    expect(leafOf('/pkg/inner.txt')).toHaveAttribute('inert');

    fireEvent.click(screen.getByTestId('ft-row-/pkg')); // expand again, mid-leave
    expect(screen.getByTestId('ft-row-/pkg/inner.txt')).toBe(inner); // same node
    expect(leafOf('/pkg/inner.txt')).toHaveAttribute('data-phase', 'present');
    expect(leafOf('/pkg/inner.txt')).not.toHaveAttribute('inert');

    // Well past --mo-micro: the cancelled leave must not drop the row.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(screen.getByTestId('ft-row-/pkg/inner.txt')).toBe(inner);
    expect(leafOf('/pkg/inner.txt')).toHaveAttribute('data-phase', 'present');
    expect(listCalls()).toBe(2); // and nothing was re-fetched for it
  });

  it('closes every level of a collapsed folder and keeps the folder row itself', async () => {
    serve({
      '/': [folder('pkg')],
      '/pkg': [folder('deep'), file('top.txt')],
      '/pkg/deep': [file('leaf.txt')],
    });
    render(<FileTree onOpenFile={vi.fn()} pins={[]} onPinsChange={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('ft-row-/pkg'));
    fireEvent.click(await screen.findByTestId('ft-row-/pkg/deep'));
    await screen.findByTestId('ft-row-/pkg/deep/leaf.txt');
    await waitFor(() =>
      expect(leafOf('/pkg/deep/leaf.txt')).toHaveAttribute('data-phase', 'present'),
    );

    fireEvent.click(screen.getByTestId('ft-row-/pkg'));

    for (const path of ['/pkg/deep', '/pkg/top.txt', '/pkg/deep/leaf.txt']) {
      expect(leafOf(path), path).toHaveAttribute('data-phase', 'leaving');
    }
    expect(leafOf('/pkg')).toHaveAttribute('data-phase', 'present');
    await waitFor(() => {
      for (const path of ['/pkg/deep', '/pkg/top.txt', '/pkg/deep/leaf.txt']) {
        expect(screen.queryByTestId(`ft-row-${path}`), path).toBeNull();
      }
    });
    expect(screen.getByTestId('ft-row-/pkg')).toBeTruthy();
  });

  // Only the row that is new enters, and it does not replay the first fill: a
  // re-read is the common way a file made in the terminal reaches the tree.
  it('inserts only a new file on a re-read, on the micro tier, and leaves the rest alone', async () => {
    const listing = { current: [file('a.txt')] };
    serveEditable(listing);
    render(<FileTree onOpenFile={vi.fn()} pins={[]} onPinsChange={vi.fn()} />);
    const a = await screen.findByTestId('ft-row-/a.txt');
    await waitFor(() => expect(leafOf('/a.txt')).toHaveAttribute('data-phase', 'present'));

    listing.current = [file('a.txt'), file('b.txt')];
    fireEvent.click(screen.getByTestId('ft-refresh-/'));

    await screen.findByTestId('ft-row-/b.txt');
    expect(leafOf('/b.txt')).toHaveAttribute('data-enter', 'micro');
    expect(screen.getByTestId('ft-row-/a.txt')).toBe(a);
    expect(leafOf('/a.txt')).toHaveAttribute('data-phase', 'present');
    expect(leafOf('/a.txt')).toHaveAttribute('data-enter', 'stagger');
    await waitFor(() => expect(leafOf('/b.txt')).toHaveAttribute('data-phase', 'present'));
  });

  // The 2-minute poll re-reads every open listing. It used to swap each one for
  // "Loading…", which dropped every row and with it the scroller's offset.
  it('re-reads on the poll without remounting a single row', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    serve({ '/': [folder('pkg'), file('a.txt')] });
    render(<FileTree onOpenFile={vi.fn()} pins={[]} onPinsChange={vi.fn()} />);
    const a = await screen.findByTestId('ft-row-/a.txt');
    const pkg = screen.getByTestId('ft-row-/pkg');
    await waitFor(() => expect(leafOf('/a.txt')).toHaveAttribute('data-phase', 'present'));
    const before = listCalls();

    const poll = intervals.mock.calls.find(([, delay]) => delay === POLL_INTERVAL_MS)?.[0];
    expect(typeof poll).toBe('function');
    act(() => (poll as () => void)());

    // Mid-request: the listing is still the one on screen, not a note.
    expect(screen.queryByTestId('ft-note-/')).toBeNull();
    expect(screen.getByTestId('ft-row-/a.txt')).toBe(a);
    await waitFor(() => expect(listCalls()).toBe(before + 1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('ft-row-/a.txt')).toBe(a);
    expect(screen.getByTestId('ft-row-/pkg')).toBe(pkg);
    expect(leafOf('/a.txt')).toHaveAttribute('data-phase', 'present');
    intervals.mockRestore();
  });

  describe('under reduced motion', () => {
    afterEach(() => vi.restoreAllMocks());

    it('draws the first fill as present and drops a collapsed folder at once', async () => {
      vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
      serve({ '/': [folder('pkg')], '/pkg': [file('inner.txt')] });
      render(<FileTree onOpenFile={vi.fn()} pins={[]} onPinsChange={vi.fn()} />);

      fireEvent.click(await screen.findByTestId('ft-row-/pkg'));
      await screen.findByTestId('ft-row-/pkg/inner.txt');
      // No frame is spent collapsed, and no two-frame flip is waited for.
      expect(leafOf('/pkg')).toHaveAttribute('data-phase', 'present');
      expect(leafOf('/pkg/inner.txt')).toHaveAttribute('data-phase', 'present');

      fireEvent.click(screen.getByTestId('ft-row-/pkg'));
      // Nothing to wait for: not even a `leaving` frame.
      expect(screen.queryByTestId('ft-row-/pkg/inner.txt')).toBeNull();
    });
  });
});

// ── The stylesheet side of the same contract ──────────────────────────────────
describe('files.css row transitions', () => {
  const sheet = parse(readFileSync(join(__dirname, 'files.css'), 'utf8'));

  const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

  /** Declarations of every rule whose selector list is exactly `selector`. */
  const declsOf = (selector: string, within?: AtRule): Record<string, string> => {
    const out: Record<string, string> = {};
    const root = within ?? sheet;
    root.walkRules((rule: Rule) => {
      if (squash(rule.selector) !== selector) return;
      if (!within && rule.parent?.type === 'atrule') return;
      rule.walkDecls((decl) => {
        out[decl.prop] = squash(decl.value);
      });
    });
    return out;
  };

  it('has the wrapper transition grid-template-rows and opacity on --mo-micro', () => {
    const leaf = declsOf('.ft-leaf');
    expect(leaf['display']).toBe('grid');
    expect(leaf['grid-template-rows']).toBe('1fr');
    expect(leaf['transition']).toContain('grid-template-rows var(--mo-micro)');
    expect(leaf['transition']).toContain('opacity var(--mo-micro)');
  });

  it('collapses the space and clears the row while entering and leaving', () => {
    const rest = declsOf(".ft-leaf[data-phase='entering'], .ft-leaf[data-phase='leaving']");
    expect(rest['grid-template-rows']).toBe('0fr');
    expect(rest['opacity']).toBe('0');
    expect(declsOf(".ft-leaf[data-phase='leaving']")['pointer-events']).toBe('none');
  });

  it('clips the track the grid shrinks, or 0fr would still leave the row its height', () => {
    const inner = declsOf('.ft-leaf-inner');
    expect(inner['min-height']).toBe('0');
    expect(inner['overflow']).toBe('hidden');
  });

  it('runs the first fill on --mo-enter and a capped --mo-stagger step per row', () => {
    const stagger = declsOf(".ft-leaf[data-enter='stagger']");
    expect(stagger['transition-duration']).toBe('var(--mo-enter)');
    expect(stagger['transition-timing-function']).toBe('var(--mo-ease)');
    expect(stagger['transition-delay']).toMatch(/--mo-stagger/);
    expect(stagger['transition-delay']).toMatch(/min\(var\(--ft-i, 0\), \d+\)/);
  });

  it('takes every duration and delay from the motion tokens, never a literal', () => {
    let seen = 0;
    sheet.walkRules((rule: Rule) => {
      if (!rule.selector.includes('.ft-leaf')) return;
      rule.walkDecls(/^transition/, (decl) => {
        if (decl.value === 'none') return;
        seen += 1;
        expect(decl.value, `${rule.selector} { ${decl.prop} }`).not.toMatch(/\d\s*m?s\b/);
      });
    });
    expect(seen).toBeGreaterThan(0);
  });

  it('uses transitions, never keyframes, so an interrupted change retargets', () => {
    let keyframes = 0;
    sheet.walkAtRules('keyframes', () => void (keyframes += 1));
    expect(keyframes).toBe(0);
  });

  it('has neither transition under reduced motion', () => {
    let reduced: AtRule | undefined;
    sheet.walkAtRules('media', (at) => {
      if (/prefers-reduced-motion:\s*reduce/.test(at.params)) reduced = at;
    });
    expect(reduced).toBeDefined();
    if (reduced) expect(declsOf('.ft-leaf', reduced)['transition']).toBe('none');
  });
});
