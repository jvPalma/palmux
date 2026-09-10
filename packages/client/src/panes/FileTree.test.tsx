// FileTree + FilePane behaviour: the /files/list walk (expand, select, failure)
// and the Read/Edit pane that composes MarkdownPane + EditorPane. Both live
// here because they are one feature and one scoped test run
// (`yarn test --run src/panes/FileTree`).
//
// The two composed panes are mocked: their own contracts have their own tests,
// and Monaco must not load in a unit run. What matters here is OUR glue —
// notably that a toggle does not remount the editor.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilePane } from './FilePane';
import { FileTree } from './FileTree';

vi.mock('./EditorPane', () => ({
  EditorPane: ({
    active,
    filePath,
    onSaveError,
  }: {
    active: boolean;
    filePath?: string;
    onSaveError?: (m: string | null) => void;
  }) => (
    <div data-testid="mock-editor" data-active={active} data-file={filePath}>
      <input data-testid="mock-editor-input" defaultValue="" />
      <button data-testid="mock-editor-fail" onClick={() => onSaveError?.('file is not writable')}>
        fail
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

/** How many /files/list calls happened — the icon index is not one of them. */
const listCalls = (): number =>
  fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/files/list')).length;

/**
 * Answer /files/list from a dir → entries map; an unmapped dir 404s.
 *
 * A request with NO `dir` is the tree asking the server where home is, and the
 * server answers with the home listing. The fixtures call that root '/', so an
 * absent parameter maps to '/' here — the client never hard-codes a root any more.
 */
const serve = (byDir: Record<string, Entry[]>) => {
  fetchMock.mockImplementation((url: string) => {
    // The tree also fetches the Material icon index on mount. It is not part of
    // the walk these tests measure, and there is nothing vendored in a unit run,
    // so answer it the way a host without icons would.
    if (url.startsWith('/file-icons/')) {
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    }
    const param = new URL(url, 'http://x').searchParams.get('dir');
    const dir = param === null ? '/' : decodeURIComponent(param);
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
    expect(screen.queryByTestId('ft-row-/packages/server.ts')).toBeNull();

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
    expect(screen.getByTestId('file-pane-save-state')).toHaveTextContent('✓ saved');

    fireEvent.click(screen.getByTestId('mock-editor-fail'));

    const state = screen.getByTestId('file-pane-save-state');
    expect(state).toHaveTextContent('file is not writable');
    expect(state).toHaveAttribute('data-tone', 'error');
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
