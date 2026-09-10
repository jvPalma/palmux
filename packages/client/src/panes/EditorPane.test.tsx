// Editor pane wiring against a mocked monaco loader: content loads from
// /pane-file, edits flip the dirty indicator (and notify the tab strip), and
// Ctrl+S PUTs the buffer back and clears it. The real Monaco is exercised in
// e2e — here we verify OUR contract around it.
//
// The `filePath` source (the file browser's Edit mode) is the same editor over
// /file?path=, and its own describe block covers the three things that differ:
// the URL, the JSON envelope, and a save the server can REFUSE.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorPane } from './EditorPane';
import { DEFAULTS } from '../settings/settings';

// ── fake monaco ───────────────────────────────────────────────────────────────
let value = '';
let version = 1;
let contentListeners: (() => void)[] = [];
const model = {
  getAlternativeVersionId: () => version,
  getValue: () => value,
  onDidChangeContent: (cb: () => void) => contentListeners.push(cb),
};
const fakeEditor = { getModel: () => model, dispose: vi.fn(), addCommand: vi.fn() };
const fakeMonaco = {
  editor: { create: vi.fn(() => fakeEditor) },
  KeyMod: { CtrlCmd: 2048 },
  KeyCode: { KeyS: 49 },
};
vi.mock('./monaco-loader', () => ({ getMonaco: () => fakeMonaco }));

const simulateEdit = (next: string) => {
  value = next;
  version += 1;
  contentListeners.forEach((cb) => cb());
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  value = '';
  version = 1;
  contentListeners = [];
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'stored note' }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const renderPane = async () => {
  const onDirtyChange = vi.fn();
  render(<EditorPane tabId="6" active onDirtyChange={onDirtyChange} />);
  await screen.findByText('✓ saved'); // loader + fetch resolved
  return { onDirtyChange };
};

describe('EditorPane', () => {
  it('loads the note via GET and creates the editor with it', async () => {
    await renderPane();
    expect(fetchMock).toHaveBeenCalledWith('/pane-file?tab=6');
    expect(fakeMonaco.editor.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ value: 'stored note', language: 'markdown', theme: 'palmux' }),
    );
  });

  // Monaco's DEFAULT stack (Menlo, Consolas, 'Courier New', monospace) resolves
  // to a proportional serif on a host with none of them, while Monaco keeps
  // positioning characters on monospace metrics — visibly letter-spaced, barely
  // readable. The terminal's own family is already a bundled monospace.
  it('renders in the terminal font, never Monaco’s default stack', async () => {
    await renderPane();
    expect(fakeMonaco.editor.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fontFamily: DEFAULTS.fontFamily }),
    );
    expect(DEFAULTS.fontFamily).toMatch(/mono/i); // and that family IS a monospace
  });

  it('edits flip the dirty indicator and notify the strip', async () => {
    const { onDirtyChange } = await renderPane();
    simulateEdit('stored note!');
    expect(await screen.findByText('● unsaved')).toBeTruthy();
    expect(onDirtyChange).toHaveBeenCalledWith('6', true);
  });

  it('Ctrl+S PUTs the buffer, suppresses the browser dialog, and clears dirty', async () => {
    const { onDirtyChange } = await renderPane();
    simulateEdit('changed');
    const ev = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true });
    fireEvent(window, ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(await screen.findByText('✓ saved')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      '/pane-file?tab=6',
      expect.objectContaining({ method: 'PUT', body: 'changed' }),
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith('6', false);
  });

  it('a failed save keeps the dirty state', async () => {
    await renderPane();
    fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) =>
      init?.method === 'PUT'
        ? { ok: false, status: 500, text: async () => '' }
        : { ok: true, status: 200, text: async () => '' },
    );
    simulateEdit('lost?');
    fireEvent(window, new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true }));
    expect(await screen.findByText('● unsaved')).toBeTruthy();
  });

  it('a NON-ok load shows an error and never creates an editable buffer (no clobber)', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 404, text: async () => '' }));
    render(<EditorPane tabId="9" active onDirtyChange={vi.fn()} />);
    expect(await screen.findByText('failed to load')).toBeTruthy();
    // Critically: no Monaco editor was created, so nothing can autosave over the
    // stored note.
    expect(fakeMonaco.editor.create).not.toHaveBeenCalled();
  });
});

// ── the file source (GET/PUT /file?path=) ─────────────────────────────────────

describe('EditorPane over a file path', () => {
  const FILE = '/home/u/notes/todo.md';

  /** /file speaks JSON both ways; /pane-file speaks raw text. */
  const serveFile = (text: string) =>
    fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) =>
      init?.method === 'PUT'
        ? { ok: true, status: 200, json: async () => ({ ok: true }) }
        : { ok: true, status: 200, json: async () => ({ text, path: FILE, size: text.length }) },
    );

  it('reads the file route and unwraps the JSON envelope', async () => {
    serveFile('on disk');
    render(<EditorPane tabId={FILE} filePath={FILE} active onDirtyChange={vi.fn()} />);
    await screen.findByText('✓ saved');

    expect(fetchMock).toHaveBeenCalledWith(`/file?path=${encodeURIComponent(FILE)}`);
    expect(fakeMonaco.editor.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ value: 'on disk', language: 'markdown' }),
    );
  });

  // Monaco carries ONE grammar (see monaco-loader): everything else is
  // plaintext, and saying so beats handing Monaco an id it never registered.
  // Behaviour CHANGED deliberately: Monaco used to carry markdown alone, so a
  // .json read exactly like a .txt — dark background, white text — which is what
  // the Read/Edit toggle exists to avoid. It now carries ~23 monarch grammars
  // (tokenizers, not language services: no worker, no IntelliSense, +4 KB in a
  // chunk a terminal-only client never fetches).
  it('opens a file in the grammar its name implies', async () => {
    serveFile('const x = 1');
    render(<EditorPane tabId="/p/a.ts" filePath="/p/a.ts" active onDirtyChange={vi.fn()} />);
    await screen.findByText('✓ saved');
    expect(fakeMonaco.editor.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ language: 'typescript' }),
    );
  });

  it('still falls back to plaintext for a name it does not know', async () => {
    serveFile('binary-ish');
    render(<EditorPane tabId="/p/a.parquet" filePath="/p/a.parquet" active onDirtyChange={vi.fn()} />);
    await screen.findByText('✓ saved');
    expect(fakeMonaco.editor.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ language: 'plaintext' }),
    );
  });

  it('Ctrl+S PUTs the buffer to the file route', async () => {
    serveFile('on disk');
    const onSaveError = vi.fn();
    render(
      <EditorPane
        tabId={FILE}
        filePath={FILE}
        active
        onDirtyChange={vi.fn()}
        onSaveError={onSaveError}
      />,
    );
    await screen.findByText('✓ saved');

    simulateEdit('edited on the phone');
    fireEvent(window, new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true }));
    expect(await screen.findByText('✓ saved')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      `/file?path=${encodeURIComponent(FILE)}`,
      expect.objectContaining({ method: 'PUT', body: 'edited on the phone' }),
    );
    expect(onSaveError).toHaveBeenLastCalledWith(null);
  });

  // The refusal that matters: the text is still on screen and the buffer is
  // still dirty, which alone is indistinguishable from "not saved yet". The
  // host draws the reason, so it has to receive it.
  it('reports the server’s reason when a save is refused', async () => {
    serveFile('on disk');
    const onSaveError = vi.fn();
    render(
      <EditorPane
        tabId={FILE}
        filePath={FILE}
        active
        onDirtyChange={vi.fn()}
        onSaveError={onSaveError}
      />,
    );
    await screen.findByText('✓ saved');

    fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) =>
      init?.method === 'PUT'
        ? { ok: false, status: 403, json: async () => ({ error: 'file is not writable' }) }
        : { ok: true, status: 200, json: async () => ({ text: '', path: FILE, size: 0 }) },
    );
    simulateEdit('nope');
    fireEvent(window, new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true }));

    await waitFor(() => expect(onSaveError).toHaveBeenLastCalledWith('file is not writable'));
    expect(screen.getByText('● unsaved')).toBeTruthy();
  });

  // Both flags live in the HOST as well, and the host does not remount between
  // files — a switch after an edited (or refused) file used to open the new one
  // already captioned "unsaved" / "not writable".
  it('clears dirty and the save error when the path changes', async () => {
    serveFile('first');
    const onDirtyChange = vi.fn();
    const onSaveError = vi.fn();
    const props = { active: true, onDirtyChange, onSaveError } as const;
    const view = render(<EditorPane tabId="/p/a.md" filePath="/p/a.md" {...props} />);
    await screen.findByText('✓ saved');
    simulateEdit('dirty now');
    expect(await screen.findByText('● unsaved')).toBeTruthy();

    onDirtyChange.mockClear();
    onSaveError.mockClear();
    view.rerender(<EditorPane tabId="/p/b.md" filePath="/p/b.md" {...props} />);

    expect(onDirtyChange).toHaveBeenCalledWith('/p/b.md', false);
    expect(onSaveError).toHaveBeenCalledWith(null);
  });

  it('shows the server’s reason in the BODY when a file will not load', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 413,
      json: async () => ({ error: 'file is 9000000 bytes; the editor limit is 52428800' }),
    }));
    render(
      <EditorPane tabId="/p/huge.log" filePath="/p/huge.log" active onDirtyChange={vi.fn()} />,
    );

    // Not the header — FilePane hides that, and an unexplained empty editor is
    // the blank surface this message exists to prevent.
    expect(await screen.findByTestId('editor-load-error')).toHaveTextContent('9000000 bytes');
    expect(fakeMonaco.editor.create).not.toHaveBeenCalled();
  });
});
