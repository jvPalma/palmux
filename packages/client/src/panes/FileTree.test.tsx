// FileTree + FilePane behaviour: the /files/list walk (expand, select, failure)
// and the Read/Edit pane that composes MarkdownPane + EditorPane. Both live
// here because they are one feature and one scoped test run
// (`yarn test --run src/panes/FileTree`).
//
// The two composed panes are mocked: their own contracts have their own tests,
// and Monaco must not load in a unit run. What matters here is OUR glue —
// notably that a toggle does not remount the editor.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parse, type AtRule, type Rule } from 'postcss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilePane } from './FilePane';
import { FileTree, POLL_INTERVAL_MS } from './FileTree';
import { writeExpandedDir } from './explorer-open';
import { Icon } from '../ui/icons';
import { DEFAULTS, mergeServerSettings, sanitize, toServerSettings } from '../settings/settings';

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

/**
 * Like `serve`, but answers the way the real route does (`server/files.ts` `listDir`):
 * the requested `dir` goes through `path.resolve` EXACTLY AS GIVEN (whitespace is part
 * of a name, so nothing is trimmed) and the listing's `path` is the result. `serve`
 * echoes the request back, so it can never show a key the server reports differently.
 * Resolves with `node:path`, not the client's own `normalizePin`, so the mock cannot
 * agree with the code under test by construction.
 *
 * `trims` plays a server from BEFORE batch 11, which trimmed the request: it answers a
 * folder named `report ` with the listing of its sibling `report`. The client still
 * has to refuse that answer, because a new client can meet an old server until the
 * server is restarted.
 */
const serveResolved = (byDir: Record<string, Entry[]>, home = '/', trims = false) => {
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith('/file-icons/')) {
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    }
    const param = new URL(url, 'http://x').searchParams.get('dir');
    const asked = param === null ? home : decodeURIComponent(param);
    const path = posix.resolve(trims ? asked.trim() : asked);
    const entries = byDir[path];
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
      json: async () => ({ path, parent: posix.dirname(path), entries }),
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

  // B8-CODE-02: toggling or re-delivering a root must not reopen a folder the user
  // collapsed. A pin nested in HOME is also a folder row inside HOME, and it used
  // to share the set that fetched roots, so re-seeding the root reopened that row.
  // B9-02 removed the sharing itself (see 'Explorer remembers its expanded folders').
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
  /** Restore all three roots open, open `project` inside HOME, then collapse it. */
  const collapseProjectInHome = async () => {
    seed(['/home/u', '/home/u/project', '/work']);
    serve(nested, '/home/u');
    const view = render(tree(['/home/u/project', '/work']));
    expect(await screen.findByTestId('ft-row-/work/app.ts')).toBeTruthy();
    // REALIGNED (B9-02): this used to wait for the restore to seed the pinned root
    // into `expanded` and open its folder row inside HOME. Roots are loaded
    // directly now and `expanded` holds only user folder expansions, so the row
    // starts collapsed and the user opens it before collapsing it.
    await waitFor(() => expect(projectInHome()).toHaveAttribute('aria-expanded', 'false'));
    fireEvent.click(projectInHome());
    expect(projectInHome()).toHaveAttribute('aria-expanded', 'true');
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

// ── Folders opened inside a root are remembered per device ────────────────────
//
// An installed PWA is relaunched from nothing, so the folders a user opened
// inside the Explorer have to come back from storage. They are a second key from
// the open roots, and nothing but the user's own toggle and the Explorer's own
// delete may change them: no listing is proof that a folder is gone.
describe('Explorer remembers its expanded folders', () => {
  const OPEN = 'palmux-explorer-open';
  const EXPANDED = 'palmux-explorer-expanded';
  const fs: Record<string, Entry[]> = {
    '/home/u': [folder('docs'), folder('pro'), folder('proj'), file('a.txt')],
    '/home/u/pro': [file('x.txt')],
    '/home/u/proj': [folder('src'), file('p.md')],
    '/home/u/proj/src': [file('main.ts')],
    '/home/u/docs': [file('d.md')],
    '/work': [folder('sub'), file('app.ts')],
    '/work/sub': [file('deep.ts')],
  };

  const seedOpen = (open: string[]) =>
    localStorage.setItem(OPEN, JSON.stringify({ v: 1, open }));
  const seedExpanded = (dirs: string[]): string => {
    const raw = JSON.stringify({ v: 1, dirs });
    localStorage.setItem(EXPANDED, raw);
    return raw;
  };
  const storedDirs = (): unknown => JSON.parse(localStorage.getItem(EXPANDED) ?? 'null');
  const isOpen = (root: string): string | null =>
    screen.getByTestId(`ft-sect-${root}`).getAttribute('data-open');
  const tree = (pins: string[] = [], onPinsChange = vi.fn()) => (
    <FileTree onOpenFile={vi.fn()} pins={pins} onPinsChange={onPinsChange} onNotice={vi.fn()} />
  );
  const listedDirs = (): (string | null)[] =>
    fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.startsWith('/files/list'))
      .map((url) => new URL(url, 'http://x').searchParams.get('dir'));
  const settle = () =>
    act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  const rowIn = (root: string, path: string): Element => {
    const row = screen
      .getByTestId(`ft-sect-${root}`)
      .querySelector(`[data-testid="ft-row-${path}"]`);
    if (!row) throw new Error(`no row ${path} in the ${root} section`);
    return row;
  };
  /** Answer /files/delete too: every path outcome comes from `ok`. */
  const withDelete = (ok: (path: string) => boolean = () => true) => {
    const answer = fetchMock.getMockImplementation() as (url: string) => Promise<unknown>;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url) !== '/files/delete') return answer(url);
      const paths = (JSON.parse(String(init?.body ?? '{}')) as { paths: string[] }).paths;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          results: paths.map((path) =>
            ok(path)
              ? { path, ok: true, kind: 'directory', entries: 1 }
              : { path, ok: false, message: 'refused' },
          ),
        }),
      });
    });
  };
  const deleteRow = async (path: string) => {
    fireEvent.contextMenu(screen.getByTestId(`ft-row-${path}`));
    fireEvent.click(await screen.findByTestId(`ft-menu-${path}-delete`));
  };

  it('stores a folder toggle and opens it again after a remount', async () => {
    serve(fs, '/home/u');
    const first = render(tree());
    fireEvent.click(await screen.findByTestId('ft-row-/home/u/proj'));
    expect(await screen.findByTestId('ft-row-/home/u/proj/p.md')).toBeTruthy();
    expect(storedDirs()).toEqual({ v: 1, dirs: ['/home/u/proj'] });
    first.unmount();

    fetchMock.mockClear();
    render(tree());
    expect(await screen.findByTestId('ft-row-/home/u/proj/p.md')).toBeTruthy();
    expect(screen.getByTestId('ft-row-/home/u/proj')).toHaveAttribute('aria-expanded', 'true');
    expect(listedDirs()).toContain('/home/u/proj');
  });

  // REALIGNED in batch 10 (it was "opens nested stored folders without waiting for
  // their parents"). A folder is now fetched only once its parent's listing proves it
  // exists, so a restore costs one round trip per depth. The parent is held to see
  // that the child is NOT asked for early, then released to see it asked for once.
  it('restores nested stored folders level by level, asking for a child only once its parent lists it', async () => {
    seedOpen(['/home/u']);
    seedExpanded(['/home/u/proj', '/home/u/proj/src']);
    serve(fs, '/home/u');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answer = fetchMock.getMockImplementation() as (url: string) => Promise<unknown>;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === `/files/list?dir=${encodeURIComponent('/home/u/proj')}`) await gate;
      return answer(url);
    });

    render(tree());
    await waitFor(() => expect(listedDirs()).toContain('/home/u/proj'));
    await settle();
    expect(listedDirs()).not.toContain('/home/u/proj/src'); // the parent has not proven it yet

    release();
    expect(await screen.findByTestId('ft-row-/home/u/proj/src/main.ts')).toBeTruthy();
    expect(screen.getByTestId('ft-row-/home/u/proj/src')).toHaveAttribute('aria-expanded', 'true');
    expect(listedDirs().filter((d) => d === '/home/u/proj/src')).toHaveLength(1);
  });

  it('does not fetch a stored folder under a collapsed root until the root opens', async () => {
    seedOpen(['/home/u']);
    seedExpanded(['/work/sub']);
    serve(fs, '/home/u');
    render(tree(['/work']));
    await screen.findByTestId('ft-row-/home/u/a.txt');
    await settle();
    expect(isOpen('/work')).toBe('false');
    expect(listedDirs().filter((d) => d?.startsWith('/work'))).toEqual([]);

    fireEvent.click(screen.getByTestId('ft-sect-toggle-/work'));
    expect(await screen.findByTestId('ft-row-/work/sub/deep.ts')).toBeTruthy();
    expect(screen.getByTestId('ft-row-/work/sub')).toHaveAttribute('aria-expanded', 'true');
  });

  it('does not fetch the folders of a dormant root, and loads them when it comes back', async () => {
    seedOpen(['/home/u', '/work']);
    seedExpanded(['/work/sub']);
    serve(fs, '/home/u');
    const { rerender } = render(tree());
    await screen.findByTestId('ft-row-/home/u/a.txt');
    await settle();
    expect(listedDirs().filter((d) => d?.startsWith('/work'))).toEqual([]);

    rerender(tree(['/work']));
    expect(await screen.findByTestId('ft-row-/work/sub/deep.ts')).toBeTruthy();
  });

  it('does not fetch a stored folder whose ancestor is collapsed', async () => {
    seedOpen(['/home/u']);
    seedExpanded(['/home/u/proj/src']); // `proj` itself is not expanded
    serve(fs, '/home/u');
    render(tree());
    await screen.findByTestId('ft-row-/home/u/a.txt');
    await settle();
    expect(listedDirs()).not.toContain('/home/u/proj/src');
    expect(listedDirs()).not.toContain('/home/u/proj');

    fireEvent.click(screen.getByTestId('ft-row-/home/u/proj'));
    expect(await screen.findByTestId('ft-row-/home/u/proj/src/main.ts')).toBeTruthy();
    expect(screen.getByTestId('ft-row-/home/u/proj/src')).toHaveAttribute('aria-expanded', 'true');
  });

  // Collapse removes the folder's own record and nothing else, so opening the
  // parent again brings its open children back, as VS Code does.
  it('removes a collapsed folder from storage and keeps its stored descendants', async () => {
    seedOpen(['/home/u']);
    seedExpanded(['/home/u/proj', '/home/u/proj/src']);
    serve(fs, '/home/u');
    render(tree());
    expect(await screen.findByTestId('ft-row-/home/u/proj/src/main.ts')).toBeTruthy();

    fireEvent.click(screen.getByTestId('ft-row-/home/u/proj'));
    expect(storedDirs()).toEqual({ v: 1, dirs: ['/home/u/proj/src'] });
    await waitFor(() => expect(screen.queryByTestId('ft-row-/home/u/proj/p.md')).toBeNull());

    fireEvent.click(screen.getByTestId('ft-row-/home/u/proj'));
    expect(storedDirs()).toEqual({ v: 1, dirs: ['/home/u/proj/src', '/home/u/proj'] });
    expect(await screen.findByTestId('ft-row-/home/u/proj/src/main.ts')).toBeTruthy();
    expect(screen.getByTestId('ft-row-/home/u/proj/src')).toHaveAttribute('aria-expanded', 'true');
  });

  // B9-02: a root is loaded as a root. It used to be put into the set that also
  // drives folder rows, so a folder the user had collapsed inside HOME came back
  // open on every relaunch whenever the same path was also a pinned section.
  describe('a root is not a folder row', () => {
    const nested = {
      '/home/u': [folder('project'), file('a.txt')],
      '/home/u/project': [file('p.ts')],
    };
    const projectInHome = () => rowIn('/home/u', '/home/u/project');

    it('keeps a folder collapsed inside HOME on a remount while its own section lists', async () => {
      seedOpen(['/home/u', '/home/u/project']);
      serve(nested, '/home/u');
      const first = render(tree(['/home/u/project']));
      await waitFor(() => expect(projectInHome()).toHaveAttribute('aria-expanded', 'false'));
      expect(await screen.findByTestId('ft-row-/home/u/project/p.ts')).toBeTruthy();
      expect(storedDirs()).toBeNull(); // restoring a root wrote nothing about folders

      // Opened and collapsed again: the collapse is what is remembered.
      fireEvent.click(projectInHome());
      expect(projectInHome()).toHaveAttribute('aria-expanded', 'true');
      fireEvent.click(projectInHome());
      first.unmount();

      render(tree(['/home/u/project']));
      await waitFor(() => expect(projectInHome()).toHaveAttribute('aria-expanded', 'false'));
      expect(isOpen('/home/u')).toBe('true');
      expect(isOpen('/home/u/project')).toBe('true');
      expect(rowIn('/home/u/project', '/home/u/project/p.ts')).toBeTruthy(); // the section lists
      expect(storedDirs()).toEqual({ v: 1, dirs: [] });
    });

    it('keeps a folder OPEN inside HOME on a remount while its own section lists', async () => {
      seedOpen(['/home/u', '/home/u/project']);
      seedExpanded(['/home/u/project']);
      serve(nested, '/home/u');
      render(tree(['/home/u/project']));
      await waitFor(() => expect(projectInHome()).toHaveAttribute('aria-expanded', 'true'));
      expect(rowIn('/home/u', '/home/u/project/p.ts')).toBeTruthy();
      expect(rowIn('/home/u/project', '/home/u/project/p.ts')).toBeTruthy();
    });

    it('does not open the folder inside HOME when its pinned section is opened', async () => {
      seedOpen(['/home/u']);
      serve(nested, '/home/u');
      render(tree(['/home/u/project']));
      await waitFor(() => expect(projectInHome()).toHaveAttribute('aria-expanded', 'false'));

      fireEvent.click(screen.getByTestId('ft-sect-toggle-/home/u/project'));
      expect(await screen.findByTestId('ft-row-/home/u/project/p.ts')).toBeTruthy();
      expect(projectInHome()).toHaveAttribute('aria-expanded', 'false');
      expect(storedDirs()).toBeNull();
    });

    it('does not record the new root as an expanded folder when a folder is pinned', async () => {
      serve(nested, '/home/u');
      const onPinsChange = vi.fn();
      const { rerender } = render(tree([], onPinsChange));
      await waitFor(() => expect(projectInHome()).toBeTruthy());
      fireEvent.contextMenu(projectInHome());
      fireEvent.click(await screen.findByTestId('ft-menu-/home/u/project-pin'));
      expect(onPinsChange).toHaveBeenCalledWith(['/home/u/project']);

      rerender(tree(['/home/u/project'], onPinsChange));
      expect(await screen.findByTestId('ft-row-/home/u/project/p.ts')).toBeTruthy();
      expect(isOpen('/home/u/project')).toBe('true');
      expect(isOpen('/home/u')).toBe('false');
      expect(storedDirs()).toBeNull();
    });
  });

  // B9-CODE-02. The poll reads the same visibility-gated set as the load effect. A
  // listing cached while it was visible must not keep being re-read once it is
  // hidden, and the cache holds every listing ever shown under a root.
  describe('the poll', () => {
    afterEach(() => vi.restoreAllMocks());
    /** Spy BEFORE rendering; the returned function runs the tree's 2-minute poll. */
    const watchPoll = () => {
      const intervals = vi.spyOn(globalThis, 'setInterval');
      return () => {
        const poll = intervals.mock.calls.find(([, delay]) => delay === POLL_INTERVAL_MS)?.[0];
        expect(typeof poll).toBe('function');
        act(() => (poll as () => void)());
      };
    };

    // HOME holds `project`, whose row inside HOME is collapsed; `project` is also its
    // own pinned section, and `src` was restored open beneath it.
    it('stops re-reading a restored subtree once its nested pinned section collapses', async () => {
      seedOpen(['/home/u', '/home/u/project']);
      const raw = seedExpanded(['/home/u/project/src']);
      serve(
        {
          '/home/u': [folder('project'), file('a.txt')],
          '/home/u/project': [folder('src'), file('p.ts')],
          '/home/u/project/src': [file('main.ts')],
        },
        '/home/u',
      );
      const poll = watchPoll();
      render(tree(['/home/u/project']));
      expect(await screen.findByTestId('ft-row-/home/u/project/src/main.ts')).toBeTruthy();
      expect(rowIn('/home/u', '/home/u/project')).toHaveAttribute('aria-expanded', 'false');

      fireEvent.click(screen.getByTestId('ft-sect-toggle-/home/u/project'));
      expect(isOpen('/home/u/project')).toBe('false');
      expect(isOpen('/home/u')).toBe('true');
      fetchMock.mockClear();

      poll();
      // The positive control: the poll ran, and it re-read the root that IS open.
      await waitFor(() => expect(listedDirs()).toContain('/home/u'));
      await settle();
      expect(listedDirs().filter((d) => d?.startsWith('/home/u/project'))).toEqual([]);
      expect(localStorage.getItem(EXPANDED)).toBe(raw); // hidden, not forgotten

      // Visible again, polled again.
      fireEvent.click(screen.getByTestId('ft-sect-toggle-/home/u/project'));
      fetchMock.mockClear();
      poll();
      await waitFor(() =>
        expect(listedDirs()).toEqual(
          expect.arrayContaining(['/home/u', '/home/u/project', '/home/u/project/src']),
        ),
      );
    });

    // B10. Visibility is proven by the parent's listing, so a record for a folder that
    // is not in it (deleted by a cross-window race, renamed, never produced by any
    // listing) is not requested on mount and not polled either. The fixture DOES serve
    // `/home/u/deleted`, so a tree that fetched it would find something to show.
    it('never requests or polls a stored folder its parent listing does not contain', async () => {
      seedOpen(['/home/u']);
      const raw = seedExpanded(['/home/u/deleted', '/home/u/deleted/inner', '/home/u/docs']);
      serve(
        {
          '/home/u': [folder('docs'), file('a.txt')],
          '/home/u/docs': [file('d.md')],
          '/home/u/deleted': [folder('inner'), file('x.txt')],
          '/home/u/deleted/inner': [file('y.txt')],
        },
        '/home/u',
      );
      const poll = watchPoll();
      render(tree());
      expect(await screen.findByTestId('ft-row-/home/u/docs/d.md')).toBeTruthy();

      for (let tick = 0; tick < 3; tick++) {
        poll();
        await settle();
      }
      // The positive control: the poll ran and re-read what IS on screen.
      await waitFor(() => expect(listedDirs().filter((d) => d === '/home/u')).toHaveLength(3));
      await waitFor(() => expect(listedDirs().filter((d) => d === '/home/u/docs')).toHaveLength(4));
      expect(listedDirs().filter((d) => d?.startsWith('/home/u/deleted'))).toEqual([]);
      expect(screen.queryByTestId('ft-row-/home/u/deleted')).toBeNull();
      expect(localStorage.getItem(EXPANDED)).toBe(raw); // dormant, not forgotten
    });

    it('stops re-reading a folder collapsed inside an open root', async () => {
      seedOpen(['/home/u']);
      serve(fs, '/home/u');
      const poll = watchPoll();
      render(tree());
      fireEvent.click(await screen.findByTestId('ft-row-/home/u/proj'));
      expect(await screen.findByTestId('ft-row-/home/u/proj/p.md')).toBeTruthy();
      fireEvent.click(screen.getByTestId('ft-row-/home/u/proj'));
      fetchMock.mockClear();

      poll();
      await waitFor(() => expect(listedDirs()).toContain('/home/u'));
      await settle();
      expect(listedDirs()).not.toContain('/home/u/proj');
    });
  });

  // ── What forgets a stored folder: the Explorer's own delete, and only that ──────
  describe('deleting', () => {
    // The confirm spy would otherwise outlive a test that failed before its end.
    afterEach(() => vi.restoreAllMocks());

    it('drops the deleted folder and every stored folder under it', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      seedOpen(['/home/u']);
      seedExpanded(['/home/u/docs', '/home/u/proj', '/home/u/proj/src']);
      serve(fs, '/home/u');
      withDelete();
      render(tree());
      expect(await screen.findByTestId('ft-row-/home/u/proj/src/main.ts')).toBeTruthy();

      await deleteRow('/home/u/proj');
      await waitFor(() =>
        expect(storedDirs()).toEqual({ v: 1, dirs: ['/home/u/docs'] }),
      );
      // The listing that showed it is re-read; the folder it held is no longer open.
      expect(screen.getByTestId('ft-row-/home/u/docs')).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByTestId('ft-row-/home/u/proj')).toHaveAttribute('aria-expanded', 'false');
      // The rows close their space over --mo-micro and are dropped after it.
      await waitFor(() => expect(screen.queryByTestId('ft-row-/home/u/proj/src/main.ts')).toBeNull());
    });

    // `/home/u/pro` is a prefix of `/home/u/proj` as a STRING and not as a path.
    it('matches by path segment, not by string prefix', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      seedOpen(['/home/u']);
      seedExpanded(['/home/u/pro', '/home/u/proj']);
      serve(fs, '/home/u');
      withDelete();
      render(tree());
      expect(await screen.findByTestId('ft-row-/home/u/proj/p.md')).toBeTruthy();

      await deleteRow('/home/u/pro');
      await waitFor(() => expect(storedDirs()).toEqual({ v: 1, dirs: ['/home/u/proj'] }));
    });

    it('drops every folder a bulk delete removed', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      seedOpen(['/home/u']);
      seedExpanded(['/home/u/docs', '/home/u/proj']);
      serve(fs, '/home/u');
      withDelete();
      render(tree());
      expect(await screen.findByTestId('ft-row-/home/u/proj/p.md')).toBeTruthy();

      fireEvent.contextMenu(screen.getByTestId('ft-row-/home/u/docs'));
      fireEvent.click(await screen.findByTestId('ft-menu-/home/u/docs-select'));
      fireEvent.click(screen.getByTestId('ft-row-/home/u/proj'));
      fireEvent.click(screen.getByTestId('ft-bulk-delete'));
      await waitFor(() => expect(storedDirs()).toEqual({ v: 1, dirs: [] }));
    });

    /** Like `withDelete`, but the answer waits until the returned function runs. */
    const holdDelete = (): (() => void) => {
      withDelete();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const answer = fetchMock.getMockImplementation() as (
        url: string,
        init?: RequestInit,
      ) => Promise<unknown>;
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url) === '/files/delete') await gate;
        return answer(url, init);
      });
      return release;
    };
    const deleteCalls = (): number =>
      fetchMock.mock.calls.filter(([url]) => String(url) === '/files/delete').length;

    // B9-CODE-03. Switching the Explorer away and back mounts a NEW tree while the old
    // one's delete is still in flight. By the time it lands the old tree's memory is
    // stale: writing it back would erase what the new tree opened meanwhile, and the
    // new tree's own memory still holds the folder the delete removed.
    it('applies a delete that lands after a remount to what is stored now and to the live tree', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      seedOpen(['/home/u']);
      seedExpanded(['/home/u/proj', '/home/u/proj/src']);
      serve(fs, '/home/u');
      const release = holdDelete();
      const first = render(tree());
      expect(await screen.findByTestId('ft-row-/home/u/proj/src/main.ts')).toBeTruthy();
      await deleteRow('/home/u/proj');
      await waitFor(() => expect(deleteCalls()).toBe(1));
      first.unmount(); // the Explorer is switched away mid-delete ...

      render(tree()); // ... and back
      expect(await screen.findByTestId('ft-row-/home/u/proj/src/main.ts')).toBeTruthy();
      fireEvent.click(screen.getByTestId('ft-row-/home/u/docs')); // opened meanwhile
      expect(storedDirs()).toEqual({
        v: 1,
        dirs: ['/home/u/proj', '/home/u/proj/src', '/home/u/docs'],
      });

      await act(async () => {
        release();
        await Promise.resolve();
      });
      await waitFor(() => expect(storedDirs()).toEqual({ v: 1, dirs: ['/home/u/docs'] }));
      // The live tree forgot it too: its listing still shows the row until a re-read,
      // and the row is closed ...
      expect(screen.getByTestId('ft-row-/home/u/proj')).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByTestId('ft-row-/home/u/docs')).toHaveAttribute('aria-expanded', 'true');
      // ... so its next toggle cannot write it back.
      fireEvent.click(screen.getByTestId('ft-row-/home/u/docs'));
      expect(storedDirs()).toEqual({ v: 1, dirs: [] });
    });

    it('keeps a folder whose delete the server refused', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      seedOpen(['/home/u']);
      seedExpanded(['/home/u/proj', '/home/u/docs']);
      const raw = JSON.stringify({ v: 1, dirs: ['/home/u/proj', '/home/u/docs'] });
      serve(fs, '/home/u');
      withDelete((path) => path !== '/home/u/proj');
      const notice = vi.fn();
      render(<FileTree onOpenFile={vi.fn()} pins={[]} onPinsChange={vi.fn()} onNotice={notice} />);
      expect(await screen.findByTestId('ft-row-/home/u/proj/p.md')).toBeTruthy();

      await deleteRow('/home/u/proj');
      await waitFor(() => expect(notice).toHaveBeenCalledWith('Delete failed: refused'));
      expect(localStorage.getItem(EXPANDED)).toBe(raw);
      expect(screen.getByTestId('ft-row-/home/u/proj')).toHaveAttribute('aria-expanded', 'true');
    });
  });

  // No listing is proof of absence. The route answers a transient failure as 404,
  // omits an entry whose `lstat` failed, and reports a directory symlink whose
  // target stat failed as `dir:false` — so none of these may forget a folder.
  describe('a listing never forgets a folder', () => {
    it('keeps a folder whose own listing answers 404', async () => {
      seedOpen(['/home/u']);
      const raw = seedExpanded(['/home/u/gone']);
      serve({ '/home/u': [folder('gone'), file('a.txt')] }, '/home/u'); // no `gone` listing
      const first = render(tree());
      expect(await screen.findByTestId('ft-error-/home/u/gone')).toHaveTextContent('not found');
      await settle();
      expect(localStorage.getItem(EXPANDED)).toBe(raw);
      first.unmount();

      // It comes back the moment the directory is readable again.
      serve({ '/home/u': [folder('gone'), file('a.txt')], '/home/u/gone': [file('g.txt')] }, '/home/u');
      render(tree());
      expect(await screen.findByTestId('ft-row-/home/u/gone/g.txt')).toBeTruthy();
      expect(localStorage.getItem(EXPANDED)).toBe(raw);
    });

    it('keeps a folder the parent listing omits (an entry whose lstat failed)', async () => {
      seedOpen(['/home/u']);
      const raw = seedExpanded(['/home/u/ghost']);
      serve(
        { '/home/u': [file('a.txt')], '/home/u/ghost': [file('g.txt')] }, // `ghost` not listed
        '/home/u',
      );
      render(tree());
      await screen.findByTestId('ft-row-/home/u/a.txt');
      await settle();
      expect(screen.queryByTestId('ft-row-/home/u/ghost')).toBeNull();
      expect(localStorage.getItem(EXPANDED)).toBe(raw);

      // The next read lists it, and it is still open.
      serve(
        { '/home/u': [folder('ghost'), file('a.txt')], '/home/u/ghost': [file('g.txt')] },
        '/home/u',
      );
      fireEvent.click(screen.getByTestId('ft-refresh-/home/u'));
      expect(await screen.findByTestId('ft-row-/home/u/ghost/g.txt')).toBeTruthy();
      expect(screen.getByTestId('ft-row-/home/u/ghost')).toHaveAttribute('aria-expanded', 'true');
      expect(localStorage.getItem(EXPANDED)).toBe(raw);
    });

    it('keeps a folder the parent listing reports as dir:false (a symlink whose target stat failed)', async () => {
      seedOpen(['/home/u']);
      const raw = seedExpanded(['/home/u/link']);
      const link = (dir: boolean): Entry => ({ ...file('link'), dir, symlink: true });
      serve({ '/home/u': [link(false), file('a.txt')], '/home/u/link': [file('l.txt')] }, '/home/u');
      render(tree());
      await screen.findByTestId('ft-row-/home/u/link');
      await settle();
      expect(screen.getByTestId('ft-row-/home/u/link')).not.toHaveAttribute('aria-expanded');
      expect(localStorage.getItem(EXPANDED)).toBe(raw);

      serve({ '/home/u': [link(true), file('a.txt')], '/home/u/link': [file('l.txt')] }, '/home/u');
      fireEvent.click(screen.getByTestId('ft-refresh-/home/u'));
      expect(await screen.findByTestId('ft-row-/home/u/link/l.txt')).toBeTruthy();
      expect(screen.getByTestId('ft-row-/home/u/link')).toHaveAttribute('aria-expanded', 'true');
      expect(localStorage.getItem(EXPANDED)).toBe(raw);
    });
  });

  // The dock and the drawer (or two windows) can each hold a live tree. Each toggle is
  // a change to what is stored now, so neither mount's memory overwrites the other's.
  it("keeps two mounted Explorers from erasing each other's folders", async () => {
    seedOpen(['/home/u']);
    serve(fs, '/home/u');
    const dock = render(tree());
    const drawer = render(tree());
    fireEvent.click(await within(dock.container).findByTestId('ft-row-/home/u/docs'));
    fireEvent.click(await within(drawer.container).findByTestId('ft-row-/home/u/proj'));
    expect(storedDirs()).toEqual({ v: 1, dirs: ['/home/u/docs', '/home/u/proj'] });

    fireEvent.click(within(dock.container).getByTestId('ft-row-/home/u/docs'));
    expect(storedDirs()).toEqual({ v: 1, dirs: ['/home/u/proj'] });
  });

  it('keeps only the newest 200 folders, dropping the oldest on a write', async () => {
    seedOpen(['/home/u']);
    // Under a root that is not shown, so restoring all of them costs no request.
    const old = Array.from({ length: 200 }, (_, i) => `/elsewhere/d${i}`);
    seedExpanded(old);
    serve(fs, '/home/u');
    render(tree());
    fireEvent.click(await screen.findByTestId('ft-row-/home/u/proj'));

    const dirs = (storedDirs() as { dirs: string[] }).dirs;
    expect(dirs).toHaveLength(200);
    expect(dirs[0]).toBe('/elsewhere/d1'); // the oldest went
    expect(dirs.at(-1)).toBe('/home/u/proj');
  });

  it('still expands a folder for this mount when storage throws', async () => {
    const denied = vi.fn(() => {
      throw new Error('denied');
    });
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied, removeItem: denied });
    serve(fs, '/home/u');
    render(tree());
    fireEvent.click(await screen.findByTestId('ft-row-/home/u/proj'));
    expect(await screen.findByTestId('ft-row-/home/u/proj/p.md')).toBeTruthy();
    fireEvent.click(screen.getByTestId('ft-row-/home/u/proj'));
    expect(screen.getByTestId('ft-row-/home/u/proj')).toHaveAttribute('aria-expanded', 'false');
  });
});

// ── One identity for a path, and visibility proven by the listing (batch 10) ──────
//
// The server names every listing by the `path.resolve`d path. Anything the client
// asks for in another spelling is answered under a different key, which looped the
// load effect (B9-INSPECT2-02); `normalizePin` is now the one identity, and a folder
// is fetched only when its parent's listing shows it.
describe('Explorer paths have one identity', () => {
  const OPEN = 'palmux-explorer-open';
  const EXPANDED = 'palmux-explorer-expanded';
  const seedOpen = (open: string[]) => localStorage.setItem(OPEN, JSON.stringify({ v: 1, open }));
  const seedExpanded = (dirs: string[]) =>
    localStorage.setItem(EXPANDED, JSON.stringify({ v: 1, dirs }));
  const storedDirs = (): unknown => JSON.parse(localStorage.getItem(EXPANDED) ?? 'null');
  const tree = (pins: string[] = [], onPinsChange = vi.fn()) => (
    <FileTree onOpenFile={vi.fn()} pins={pins} onPinsChange={onPinsChange} onNotice={vi.fn()} />
  );
  const listedDirs = (): (string | null)[] =>
    fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.startsWith('/files/list'))
      .map((url) => new URL(url, 'http://x').searchParams.get('dir'));
  const settle = async (times = 5) => {
    for (let i = 0; i < times; i++) {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    }
  };
  const isOpen = (root: string): string | null =>
    screen.getByTestId(`ft-sect-${root}`).getAttribute('data-open');
  const rowIn = (root: string, path: string): Element => {
    const row = screen
      .getByTestId(`ft-sect-${root}`)
      .querySelector(`[data-testid="ft-row-${path}"]`);
    if (!row) throw new Error(`no row ${path} in the ${root} section`);
    return row;
  };

  const work: Record<string, Entry[]> = {
    '/home/u': [folder('docs'), file('a.txt')],
    '/home/u/docs': [file('d.md')],
    '/work/project': [folder('src'), file('p.md')],
    '/work/project/src': [file('main.ts')],
  };

  it('keeps a synced pin stored as /work/./project open, with its expanded child, across a remount', async () => {
    serveResolved(work, '/home/u');
    const pins = ['/work/./project'];
    const first = render(tree(pins));
    // The section is the canonical root: one header, not one per spelling.
    fireEvent.click(await screen.findByTestId('ft-sect-toggle-/work/project'));
    fireEvent.click(await screen.findByTestId('ft-row-/work/project/src'));
    expect(await screen.findByTestId('ft-row-/work/project/src/main.ts')).toBeTruthy();
    first.unmount();

    render(tree(pins));
    expect(await screen.findByTestId('ft-row-/work/project/src/main.ts')).toBeTruthy();
    expect(isOpen('/work/project')).toBe('true');
    expect(rowIn('/work/project', '/work/project/src')).toHaveAttribute('aria-expanded', 'true');
    expect(storedDirs()).toEqual({ v: 1, dirs: ['/work/project/src'] });
  });

  it('unpins a pin stored in another spelling by its canonical path', async () => {
    serveResolved(work, '/home/u');
    const onPinsChange = vi.fn();
    render(tree(['/work/./project'], onPinsChange));
    fireEvent.click(await screen.findByTestId('ft-unpin-/work/project'));
    expect(onPinsChange).toHaveBeenCalledWith([]);
  });

  // The reported loop: a stored `<HOME>/.` was requested as such, the server answered
  // under `<HOME>`, and the load effect saw its own key missing and asked again.
  it('restores a stored /home/u/. and a pin /work/./project with one request each', async () => {
    seedOpen(['/home/u/.', '/work/./project']);
    seedExpanded(['/home/u/.', '/home/u//docs/../docs']);
    serveResolved(work, '/home/u');
    render(tree(['/work/./project']));
    expect(await screen.findByTestId('ft-row-/home/u/docs/d.md')).toBeTruthy();
    expect(await screen.findByTestId('ft-row-/work/project/p.md')).toBeTruthy();
    await settle(8);

    expect(isOpen('/home/u')).toBe('true');
    expect(isOpen('/work/project')).toBe('true');
    expect(listedDirs().filter((d) => d?.includes('/.'))).toEqual([]); // never asked non-canonically
    expect(listedDirs().filter((d) => d === '/work/project')).toHaveLength(1);
    expect(listedDirs().filter((d) => d === '/home/u/docs')).toHaveLength(1);
    expect(listedDirs().filter((d) => d === '/home/u')).toHaveLength(0); // HOME came from the null ask
  });

  it('asks a server that answers /a/./b with /a/b exactly once', async () => {
    seedOpen(['/a/./b']);
    serveResolved({ '/home/u': [file('a.txt')], '/a/b': [file('x.txt')] }, '/home/u');
    render(tree(['/a/./b']));
    expect(await screen.findByTestId('ft-row-/a/b/x.txt')).toBeTruthy();
    await settle(8);
    expect(listedDirs().filter((d) => d !== null && d.startsWith('/a'))).toEqual(['/a/b']);
  });

  // Defence in depth. A listing names ONE directory, the one the server reports, so a
  // response under another path is never shown under the requested one: the tree builds
  // child paths from the requested key, and every row would name a path the listing
  // never described. The requested key gets a TERMINAL error instead — a key with no
  // state would be asked for again after every answer, for ever (B9-INSPECT2-02).
  it('asks once for a root the server reports under a different path, and shows an error instead of its listing', async () => {
    seedOpen(['/home/u', '/link']);
    serve({ '/home/u': [file('a.txt')], '/real': [file('x.txt')] }, '/home/u');
    const answer = fetchMock.getMockImplementation() as (url: string) => Promise<unknown>;
    fetchMock.mockImplementation((url: string) =>
      answer(
        url === `/files/list?dir=${encodeURIComponent('/link')}`
          ? `/files/list?dir=${encodeURIComponent('/real')}`
          : url,
      ),
    );
    render(tree(['/link']));
    expect(await screen.findByTestId('ft-error-/link')).toHaveTextContent(
      'the server listed a different path: /real',
    );
    await settle(8);
    expect(screen.queryByTestId('ft-row-/link/x.txt')).toBeNull();
    expect(listedDirs().filter((d) => d === '/link')).toHaveLength(1);
    expect(listedDirs().filter((d) => d === '/real')).toHaveLength(0);
  });

  // B10-INSPECT1-01. A server from before batch 11 TRIMS what it is asked for, so a
  // folder named `report ` is answered with its sibling `report`'s listing. Shown
  // under the requested key, `report/x` (a file) became the row `report /x` (really a
  // directory), and a Delete confirmed as a file would remove a whole tree. The server
  // no longer trims, but a new client can meet an old server until it is restarted, so
  // the mismatch guard stays and is exercised against a server that still trims.
  it('never shows a trailing-space folder the listing of the sibling an old server trimmed it to', async () => {
    seedOpen(['/home/u']);
    serveResolved(
      {
        '/home/u': [folder('report'), folder('report ')],
        '/home/u/report': [file('x')],
        // Unreachable through a trimming server, which is the point: it drops the space.
        '/home/u/report ': [folder('x')],
      },
      '/home/u',
      true,
    );
    // Testing Library trims a test id before comparing, which would make `report ` and
    // `report` the same row; these two names differ ONLY by that space.
    const exact = { trim: false, collapseWhitespace: false };
    render(tree());
    fireEvent.click(await screen.findByTestId('ft-row-/home/u/report ', exact));
    expect(await screen.findByTestId('ft-error-/home/u/report ', exact)).toHaveTextContent(
      'the server listed a different path: /home/u/report',
    );
    await settle(8);

    // Nothing of `report` is drawn under `report `, so nothing of it can be clicked,
    // opened, picked or deleted there.
    const section = screen.getByTestId('ft-sect-/home/u');
    expect(section.querySelectorAll('[data-testid^="ft-row-/home/u/report /"]')).toHaveLength(0);
    expect(screen.queryByTestId('ft-row-/home/u/report /x', exact)).toBeNull();
    // Asked once: the error is terminal, so the load effect never asks again.
    expect(listedDirs().filter((d) => d === '/home/u/report ')).toHaveLength(1);
    expect(listedDirs().filter((d) => d === '/home/u/report')).toHaveLength(0);
  });

  // ── Batch 11: a path is the path ───────────────────────────────────────────────
  //
  // The server stopped trimming, and `normalizePin` with it. `report ` and `report` are
  // two folders; neither may be drawn with, requested as, or deleted as the other.
  // Testing Library trims a test id before comparing, which would make the two the same
  // row, so every lookup of a trailing-space id passes `exact`.
  const exact = { trim: false, collapseWhitespace: false };
  const spacedWork: Record<string, Entry[]> = {
    '/home/u': [folder('docs')],
    '/home/u/docs': [file('d.md')],
    '/work/report': [file('plain.txt')],
    '/work/report ': [folder('src'), file('spaced.txt')],
    '/work/report /src': [file('inner.ts')],
  };
  /** What a synced `explorerPins` becomes between the server and the tree: the wire
   *  subset, merged over the defaults, sanitised, which `loadSettings` repeats. */
  const roundTrip = (pins: string[]): string[] =>
    sanitize(
      mergeServerSettings(DEFAULTS, toServerSettings({ ...DEFAULTS, explorerPins: pins })),
    ).explorerPins;

  it('lists a folder named `report ` and its sibling `report`, each with its own entries', async () => {
    seedOpen(['/home/u']);
    serveResolved(
      {
        '/home/u': [folder('report'), folder('report ')],
        '/home/u/report': [file('plain.txt')],
        '/home/u/report ': [file('spaced.txt')],
      },
      '/home/u',
    );
    render(tree());
    fireEvent.click(await screen.findByTestId('ft-row-/home/u/report ', exact));
    fireEvent.click(await screen.findByTestId('ft-row-/home/u/report', exact));
    expect(await screen.findByTestId('ft-row-/home/u/report /spaced.txt')).toBeTruthy();
    expect(await screen.findByTestId('ft-row-/home/u/report/plain.txt')).toBeTruthy();
    await settle(8);

    // Each folder shows ONLY its own file, and nothing was refused as a mismatch.
    expect(screen.queryByTestId('ft-row-/home/u/report /plain.txt')).toBeNull();
    expect(screen.queryByTestId('ft-row-/home/u/report/spaced.txt')).toBeNull();
    expect(screen.queryByTestId('ft-error-/home/u/report ', exact)).toBeNull();
    expect(listedDirs().filter((d) => d === '/home/u/report ')).toHaveLength(1);
    expect(listedDirs().filter((d) => d === '/home/u/report')).toHaveLength(1);
  });

  // B10-INSPECT2-01. The pin arrives as `/work/report /.`. Trimming made the canonical
  // form a moving target (`/work/report ` once, `/work/report` on the next pass), so a
  // restored section, its stored open flag and its expanded child could each land on
  // the sibling.
  it('restores a synced pin /work/report /. as the `report ` section, after a settings round trip and a remount', async () => {
    seedOpen(['/work/report /.']); // the stored open root, in a non-canonical spelling
    seedExpanded(['/work/report /src']);
    serveResolved(spacedWork, '/home/u');
    const pins = roundTrip(['/work/report /.']);
    expect(pins).toEqual(['/work/report ']);

    const check = async () => {
      expect(await screen.findByTestId('ft-row-/work/report /spaced.txt')).toBeTruthy();
      expect(await screen.findByTestId('ft-row-/work/report /src/inner.ts')).toBeTruthy();
      await settle(8);
      const section = screen.getByTestId('ft-sect-/work/report ', exact);
      expect(section).toHaveAttribute('data-open', 'true');
      // The header names the folder with its space, byte for byte.
      expect(screen.getByTestId('ft-sect-toggle-/work/report ', exact)).toHaveAttribute(
        'title',
        '/work/report ',
      );
      expect(section.querySelector('[data-testid="ft-row-/work/report /src"]')).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      // Nothing of the sibling is drawn, and the sibling is never asked for.
      expect(screen.queryByTestId('ft-row-/work/report/plain.txt')).toBeNull();
      expect(screen.queryByTestId('ft-sect-/work/report', exact)).toBeNull();
      expect(listedDirs().filter((d) => d === '/work/report ')).toHaveLength(1);
      expect(listedDirs().filter((d) => d === '/work/report /src')).toHaveLength(1);
      expect(listedDirs().filter((d) => d === '/work/report')).toHaveLength(0);
      expect(listedDirs().filter((d) => d !== null && d.includes('/.'))).toEqual([]);
    };

    const first = render(tree(pins));
    await check();
    first.unmount();

    // A second pass through the settings pipeline must hand back the same pin.
    fetchMock.mockClear();
    const again = roundTrip(pins);
    expect(again).toEqual(pins);
    render(tree(again));
    await check();
    expect(storedDirs()).toEqual({ v: 1, dirs: ['/work/report /src'] });
  });

  it('unpins `report ` and leaves a pinned `report` where it is', async () => {
    serveResolved(spacedWork, '/home/u');
    const onPinsChange = vi.fn();
    render(tree(['/work/report ', '/work/report'], onPinsChange));
    fireEvent.click(await screen.findByTestId('ft-unpin-/work/report ', exact));
    expect(onPinsChange).toHaveBeenCalledWith(['/work/report']);
  });

  it('sends a Delete of `report ` with that exact path, never the sibling', async () => {
    seedOpen(['/home/u']);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const listing = {
      '/home/u': [folder('report'), folder('report ')],
      '/home/u/report': [file('plain.txt')],
      '/home/u/report ': [file('spaced.txt')],
    };
    serveResolved(listing, '/home/u');
    const answer = fetchMock.getMockImplementation() as (url: string) => Promise<unknown>;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/files/delete') {
        const paths = JSON.parse(String(init?.body ?? '{}')).paths as string[];
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            results: paths.map((p) => ({ path: p, ok: true, kind: 'directory', entries: 1 })),
          }),
        });
      }
      return answer(url);
    });
    try {
      render(tree());
      fireEvent.contextMenu(await screen.findByTestId('ft-row-/home/u/report ', exact));
      fireEvent.click(await screen.findByTestId('ft-menu-/home/u/report -delete'));
      await waitFor(() =>
        expect(fetchMock.mock.calls.some(([u]) => String(u) === '/files/delete')).toBe(true),
      );
      const call = fetchMock.mock.calls.find(([u]) => String(u) === '/files/delete');
      const init = call?.[1] as RequestInit | undefined;
      expect(JSON.parse(String(init?.body))).toEqual({ paths: ['/home/u/report '] });
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('still asks the server where home is, and files that answer under the path it reports', async () => {
    serve({ '/home/u': [file('a.txt')] }, '/home/u');
    render(tree());
    expect(await screen.findByTestId('ft-row-/home/u/a.txt')).toBeTruthy();
    await settle();
    expect(listedDirs()).toEqual([null]); // one ask, and no retry for the key it replaced
  });

  // B10-R2-01, outcome (c), end to end. Two windows of ONE device share localStorage and
  // have no lock: this window opens `docs` while another collapses `proj` inside the gap
  // between its read and its write, so the write puts `proj` back. `proj` still exists,
  // so it REOPENS on the next mount. Accepted and documented (CLAUDE.md, Explorer
  // persistence); this test is here so a change to the scheme notices.
  it('reopens a folder whose collapse lost a cross-window race, on the next mount (outcome c)', async () => {
    seedOpen(['/home/u']);
    seedExpanded(['/home/u/proj']);
    serve(
      {
        '/home/u': [folder('docs'), folder('proj'), file('a.txt')],
        '/home/u/docs': [file('d.md')],
        '/home/u/proj': [file('p.md')],
      },
      '/home/u',
    );
    const first = render(tree());
    expect(await screen.findByTestId('ft-row-/home/u/proj/p.md')).toBeTruthy();

    // Spied on the INSTANCE: happy-dom's Storage does not route through the prototype.
    const real = localStorage.getItem.bind(localStorage);
    let raced = false;
    let otherWindowWrote: unknown = null;
    let competingWrites = 0;
    let reads = 0;
    const read = vi.spyOn(localStorage, 'getItem').mockImplementation((key: string) => {
      if (key !== EXPANDED) return real(key);
      reads++;
      const seen = real(key); // this window reads: `proj` is stored
      if (!raced) {
        // Spent BEFORE the other window runs: its own read comes back through this
        // mock, and a guard still unset there re-runs it inside itself until the stack
        // overflows, which `readExpandedDirs` swallows.
        raced = true;
        competingWrites++;
        writeExpandedDir('/home/u/proj', false); // the other window, start to finish
        otherWindowWrote = JSON.parse(real(key) ?? 'null');
      }
      return seen;
    });
    const write = vi.spyOn(localStorage, 'setItem');
    let writes = 0;
    try {
      fireEvent.click(screen.getByTestId('ft-row-/home/u/docs')); // this window's write
      writes = write.mock.calls.filter(([key]) => key === EXPANDED).length;
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
    // One race, run once: this window's read and the other's, then both writes.
    expect(competingWrites).toBe(1);
    expect(reads).toBe(2);
    expect(writes).toBe(2);
    // The other window's collapse really did commit first ...
    expect(otherWindowWrote).toEqual({ v: 1, dirs: [] });
    // ... and this window's write brought the record back.
    expect(storedDirs()).toEqual({ v: 1, dirs: ['/home/u/proj', '/home/u/docs'] });
    first.unmount();

    render(tree());
    expect(await screen.findByTestId('ft-row-/home/u/proj/p.md')).toBeTruthy();
    expect(screen.getByTestId('ft-row-/home/u/proj')).toHaveAttribute('aria-expanded', 'true');
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
