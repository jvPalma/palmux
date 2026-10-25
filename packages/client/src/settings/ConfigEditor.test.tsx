// The raw config.json editor, at the seam that matters: the Monaco INSTANCE.
//
// Settings opens it from a row and a `‹ Settings` control closes it, and the one
// property that has to survive that is that the editor is never rebuilt. It holds
// text that exists nowhere else until a Save succeeds, plus the cursor and the
// undo stack, and Monaco is created once (as the file arrives) into the host the
// component renders — so a component that rendered nothing in Form mode would have
// no host to create it in and the first Raw would open onto nothing. These tests
// therefore watch the fake's `create` and `dispose` counts and the identity of the
// host node, not just the text on screen.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { parse } from 'postcss';
import {
  ConfigEditor,
  focusLost,
  type ConfigEditorMode,
  type ConfigEditorProps,
} from './ConfigEditor';
import { Icon } from '../ui/icons';

// Monaco is 3.7 MB behind a lazy loader and has no business in a happy-dom run.
// The fake keeps what a user could lose: the buffer, an undo stack, a cursor, and
// how many times the instance was built, torn down or had its text replaced.
const monacoFake = vi.hoisted(() => {
  const state = {
    value: '',
    listeners: [] as Array<() => void>,
    created: 0,
    disposed: 0,
    setValueCalls: 0,
    layoutCalls: 0,
    host: null as HTMLElement | null,
    undoStack: [] as string[],
    cursor: { line: 1, column: 1 },
  };
  const model = {
    onDidChangeContent: (cb: () => void) => state.listeners.push(cb),
    getLineMaxColumn: () => 1,
    getLineCount: () => 1,
  };
  const editor = {
    getModel: () => model,
    getValue: () => state.value,
    setValue: (text: string) => {
      state.setValueCalls += 1;
      state.value = text;
    },
    updateOptions: () => {},
    onDidFocusEditorText: () => {},
    trigger: () => {},
    focus: () => {},
    layout: () => {
      state.layoutCalls += 1;
    },
    dispose: () => {
      state.disposed += 1;
    },
  };
  const monaco = {
    editor: {
      create: (host: HTMLElement, opts: { value: string }) => {
        state.created += 1;
        state.host = host;
        state.value = opts.value;
        state.listeners = [];
        state.undoStack = [];
        state.cursor = { line: 1, column: 1 };
        return editor;
      },
      setModelMarkers: () => {},
    },
    languages: {
      register: () => {},
      setMonarchTokensProvider: () => {},
      setLanguageConfiguration: () => {},
    },
    MarkerSeverity: { Error: 8 },
  };
  /** Someone typing: the previous text goes on the undo stack, then the listeners fire. */
  const type = (text: string) => {
    state.undoStack.push(state.value);
    state.value = text;
    state.listeners.forEach((cb) => cb());
  };
  const reset = () => {
    state.value = '';
    state.listeners = [];
    state.created = 0;
    state.disposed = 0;
    state.setValueCalls = 0;
    state.layoutCalls = 0;
    state.host = null;
    state.undoStack = [];
    state.cursor = { line: 1, column: 1 };
  };
  return { monaco, type, state, reset };
});
vi.mock('../panes/monaco-loader', () => ({ getMonaco: () => monacoFake.monaco }));

const STORED = '{"port": 44040}';

let putStatus = 200;
let getOk = true;
const puts: string[] = [];

beforeEach(() => {
  putStatus = 200;
  getOk = true;
  puts.length = 0;
  monacoFake.reset();
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url !== '/config-file') return Promise.resolve({ ok: false, status: 404 });
      if (init?.method === 'PUT') {
        puts.push(String(init.body));
        return Promise.resolve({
          ok: putStatus < 400,
          status: putStatus,
          json: () => Promise.resolve({ error: 'unknown key "prot"', line: 1 }),
        });
      }
      return Promise.resolve({
        ok: getOk,
        status: getOk ? 200 : 500,
        json: () => Promise.resolve({ text: STORED, path: '/cfg/config.json' }),
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Mount in `mode` and return a way to change it, the way Settings' host does. */
const mount = (mode: ConfigEditorMode, extra: Partial<ConfigEditorProps> = {}) => {
  const onMode = vi.fn();
  const ui = (m: ConfigEditorMode) => <ConfigEditor mode={m} onMode={onMode} {...extra} />;
  const view = render(ui(mode));
  return { onMode, setMode: (m: ConfigEditorMode) => view.rerender(ui(m)), unmount: view.unmount };
};

/** The drawn shapes of a registered icon, to compare against what a control
 *  rendered. Rendered into a detached node so `screen` never sees it. */
const iconPaths = (name: string): string | undefined => {
  const host = document.createElement('div');
  render(<Icon name={name} />, { container: host });
  return host.querySelector('svg')?.innerHTML;
};

/** Wait for the file to arrive and the editor to exist. */
const loaded = () => screen.findByText(/^Valid JSON/);

const root = () => screen.getByTestId('config-editor');
const host = () => screen.getByTestId('config-editor-host');

describe('in Form mode', () => {
  it('renders nothing visible and keeps the editor host mounted', async () => {
    mount('form');
    expect(root()).toHaveAttribute('hidden');
    expect(root()).toBeInTheDocument();
    expect(host()).toBeInTheDocument();
    await loaded();
    // The editor exists although nothing has ever been shown: it needs the host.
    expect(monacoFake.state.created).toBe(1);
    expect(monacoFake.state.host).toBe(host());
  });

  it('is not hidden in Raw', async () => {
    mount('raw');
    expect(root()).not.toHaveAttribute('hidden');
    await loaded();
  });
});

describe('the header in Raw', () => {
  it('has a `‹ Settings` control and the file’s title, and no Raw/Form toggle', async () => {
    mount('raw');
    await loaded();
    const back = screen.getByTestId('config-back');
    expect(back).toHaveTextContent('Settings');
    expect(back.querySelectorAll('svg')).toHaveLength(1);
    // The ‹ is the shared left chevron, the same one the theme sub-view's back wears.
    expect(back.querySelector('svg')?.innerHTML).toBe(iconPaths('chevron-left'));
    expect(screen.getByText('config.json')).toHaveAttribute('title', '/cfg/config.json');
    expect(screen.queryByTestId('config-mode')).toBeNull();
    expect(screen.queryByRole('group', { name: /mode/i })).toBeNull();
  });

  it('asks the host for the form when `‹ Settings` is pressed', async () => {
    const { onMode } = mount('raw');
    await loaded();
    fireEvent.click(screen.getByTestId('config-back'));
    expect(onMode).toHaveBeenCalledTimes(1);
    expect(onMode).toHaveBeenCalledWith('form');
  });
});

// Settings' Edit config.json row is what opens Raw, and the form (row included)
// unmounts as Raw comes in, so the focus that row held falls on the body. A
// keyboard user would start again from the top of the page; it lands on the
// header's `‹ Settings` instead, the first control Raw draws.
describe('focus as Raw comes into view', () => {
  it('moves to ‹ Settings when the control that held it went away', async () => {
    const { setMode } = mount('form');
    await loaded();
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    opener.remove(); // the Edit config.json row, gone with the form
    expect(document.activeElement).toBe(document.body);

    setMode('raw');
    expect(document.activeElement).toBe(screen.getByTestId('config-back'));
  });

  it('leaves focus that still sits somewhere real, and never takes it from a text field', async () => {
    const { setMode } = mount('form');
    await loaded();
    const field = document.createElement('textarea');
    document.body.append(field);
    try {
      field.focus();
      setMode('raw');
      expect(document.activeElement).toBe(field);
    } finally {
      field.remove();
    }
  });

  it('takes no focus on its first render, even straight into Raw', async () => {
    mount('raw');
    await loaded();
    expect(document.activeElement).toBe(document.body);
  });

  it('takes none on the way back to the form: that is the host’s to return', async () => {
    const { setMode } = mount('raw');
    await loaded();
    setMode('form');
    expect(document.activeElement).toBe(document.body);
  });
});

// The test the host and this component share for "focus fell somewhere nobody can
// see". It must say yes only then: a text field's focus can be a soft keyboard, and
// a control the user is on is where they meant to be.
describe('focusLost', () => {
  const held: HTMLElement[] = [];
  const focused = (el: HTMLElement, parent: HTMLElement = document.body): HTMLElement => {
    parent.append(el);
    held.push(el);
    el.focus();
    return el;
  };
  afterEach(() => {
    for (const el of held.splice(0)) el.remove();
  });

  it('is true when focus is on the body', () => {
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    expect(focusLost()).toBe(true);
  });

  it('is true when the control that held focus was removed', () => {
    const gone = focused(document.createElement('button'));
    gone.remove();
    expect(focusLost()).toBe(true);
  });

  it('is false for a control the user is on', () => {
    expect(focused(document.createElement('button'))).toBe(document.activeElement);
    expect(focusLost()).toBe(false);
  });

  it.each(['textarea', 'input'])(
    'is false for a %s, whose focus may be the soft keyboard',
    (tag) => {
      focused(document.createElement(tag));
      expect(focusLost()).toBe(false);
    },
  );

  it('is true for a control inside a hidden subtree, which is focus nobody can see', () => {
    const wrap = document.createElement('div');
    wrap.hidden = true;
    const inner = document.createElement('div');
    wrap.append(inner);
    document.body.append(wrap);
    held.push(wrap);
    focused(document.createElement('button'), inner);
    expect(document.activeElement?.tagName).toBe('BUTTON');
    expect(focusLost()).toBe(true);
  });

  it('is true for this editor’s own ‹ Settings once Form hides it', async () => {
    const { setMode } = mount('raw');
    await loaded();
    screen.getByTestId('config-back').focus();
    expect(focusLost()).toBe(false);
    setMode('form');
    expect(document.activeElement).toBe(screen.getByTestId('config-back'));
    expect(focusLost()).toBe(true);
  });
});

describe('an initial Form → Raw', () => {
  it('opens onto a working editor that loaded config.json', async () => {
    const { setMode } = mount('form');
    await loaded();
    expect(monacoFake.state.value).toBe(STORED);

    setMode('raw');
    expect(root()).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('config-status')).toHaveTextContent('Valid JSON · 1 keys');
    // The host is the one the editor was built in, now visible, and re-measured:
    // a hidden host gets no resize events of its own.
    expect(monacoFake.state.host).toBe(host());
    expect(monacoFake.state.layoutCalls).toBeGreaterThan(0);

    act(() => monacoFake.type('{"port": 44041}'));
    expect(screen.getByTestId('config-save')).toBeEnabled();
    expect(monacoFake.state.created).toBe(1);
  });

  it('works when Raw is chosen before the file has arrived', async () => {
    const { setMode } = mount('form');
    setMode('raw');
    expect(screen.getByTestId('config-status')).toHaveTextContent('loading…');
    await loaded();
    expect(monacoFake.state.created).toBe(1);
    expect(monacoFake.state.value).toBe(STORED);
  });

  it('says so when the file cannot be read, and offers no Save over it', async () => {
    getOk = false;
    mount('raw');
    expect(await screen.findByText('could not read config.json')).toBeInTheDocument();
    expect(screen.getByTestId('config-save')).toBeDisabled();
    expect(monacoFake.state.created).toBe(0);
  });
});

describe('Raw → Form → Raw', () => {
  const TYPED = '{"port": 44041,\n "host": "0.0.0.0"}';

  it('keeps the same editor, the same host and the same text', async () => {
    const { setMode } = mount('raw');
    await loaded();
    const hostBefore = host();
    act(() => monacoFake.type(TYPED));

    setMode('form');
    expect(root()).toHaveAttribute('hidden');
    setMode('raw');

    // Never rebuilt, never torn down, never handed its own text back.
    expect(monacoFake.state.created).toBe(1);
    expect(monacoFake.state.disposed).toBe(0);
    expect(monacoFake.state.setValueCalls).toBe(0);
    expect(host()).toBe(hostBefore);
    expect(monacoFake.state.host).toBe(hostBefore);
    expect(monacoFake.state.value).toBe(TYPED);
    expect(screen.getByTestId('config-status')).toHaveTextContent('Valid JSON · 2 keys');
  });

  it('keeps the cursor and the undo history, which live in the instance', async () => {
    const { setMode } = mount('raw');
    await loaded();
    act(() => monacoFake.type('{"port": 1}'));
    act(() => monacoFake.type('{"port": 12}'));
    monacoFake.state.cursor = { line: 1, column: 12 };

    setMode('form');
    setMode('raw');
    setMode('form');
    setMode('raw');

    expect(monacoFake.state.undoStack).toEqual([STORED, '{"port": 1}']);
    expect(monacoFake.state.cursor).toEqual({ line: 1, column: 12 });
    expect(monacoFake.state.created).toBe(1);
  });

  it('re-measures the editor each time Raw comes back into view', async () => {
    const { setMode } = mount('raw');
    await loaded();
    const afterLoad = monacoFake.state.layoutCalls;
    setMode('form');
    expect(monacoFake.state.layoutCalls).toBe(afterLoad); // nothing to measure while hidden
    setMode('raw');
    expect(monacoFake.state.layoutCalls).toBe(afterLoad + 1);
  });

  it('reports a dirty buffer through Form too, so a reload guard still sees it', async () => {
    const onDirtyChange = vi.fn();
    const { setMode } = mount('raw', { onDirtyChange });
    await loaded();
    act(() => monacoFake.type(TYPED));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    setMode('form');
    // Hiding the editor does not discard its text, so it must not read as clean.
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(onDirtyChange.mock.calls.at(-1)).toEqual([true]);
  });
});

describe('Raw still saves', () => {
  it('PUTs the buffer and reports that a restart is needed', async () => {
    mount('raw');
    await loaded();
    act(() => monacoFake.type('{"port": 44041}'));
    fireEvent.click(screen.getByTestId('config-save'));
    expect(await screen.findByText('Saved · restart palmux to apply')).toBeInTheDocument();
    expect(puts).toEqual(['{"port": 44041}']);
  });

  it('refuses to save text that does not parse', async () => {
    mount('raw');
    await loaded();
    // A trailing comma: the most common config mistake, and one V8 locates.
    act(() => monacoFake.type('{"port": 1,}'));
    expect(screen.getByTestId('config-save')).toBeDisabled();
    expect(screen.getByTestId('config-status').textContent).toMatch(/^Line 1 · /);
    expect(puts).toEqual([]);
  });

  it('shows the server’s own refusal and leaves the buffer dirty', async () => {
    const onDirtyChange = vi.fn();
    mount('raw', { onDirtyChange });
    await loaded();
    act(() => monacoFake.type('{"prot": 44041}'));
    putStatus = 400;
    fireEvent.click(screen.getByTestId('config-save'));
    expect(await screen.findByText('Line 1 · unknown key "prot"')).toBeInTheDocument();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it('saves from Raw after a trip through Form without losing the edit', async () => {
    const { setMode } = mount('raw');
    await loaded();
    act(() => monacoFake.type('{"port": 44041}'));
    setMode('form');
    setMode('raw');
    fireEvent.click(screen.getByTestId('config-save'));
    await screen.findByText('Saved · restart palmux to apply');
    expect(puts).toEqual(['{"port": 44041}']);
  });
});

// The batch-2 guard: this text exists nowhere else, so the host's Reload has to
// know when it differs from the file.
describe('onDirtyChange', () => {
  it('is clean on load, dirty on an edit, clean again once saved', async () => {
    const onDirtyChange = vi.fn();
    mount('raw', { onDirtyChange });
    await loaded();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    act(() => monacoFake.type('{"port": 44041}'));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByTestId('config-save'));
    await screen.findByText('Saved · restart palmux to apply');
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('reads text typed back to what the file holds as clean', async () => {
    const onDirtyChange = vi.fn();
    mount('raw', { onDirtyChange });
    await loaded();
    act(() => monacoFake.type('{"port": 44041}'));
    act(() => monacoFake.type(STORED));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('is never dirty before the file arrives, whatever the empty buffer says', async () => {
    const onDirtyChange = vi.fn();
    mount('form', { onDirtyChange });
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
    await loaded();
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
  });

  it('forgets the buffer when the editor goes with it', async () => {
    const onDirtyChange = vi.fn();
    const { unmount } = mount('raw', { onDirtyChange });
    await loaded();
    act(() => monacoFake.type('{"port": 44041}'));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    unmount();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(monacoFake.state.disposed).toBe(1);
  });
});

// ── Hidden is hidden: for a person, for a keyboard and for a screen reader ────
describe('while hidden in Form', () => {
  it('leaves no control to reach: no back control, no Save', async () => {
    const { setMode } = mount('form');
    await loaded();
    // The component is mounted — its controls exist — but none is in the
    // accessibility tree, so none is a stop for Tab or a line for a reader.
    expect(screen.getByTestId('config-back')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();

    setMode('raw');
    expect(screen.getByRole('button', { name: 'Settings' })).toBe(
      screen.getByTestId('config-back'),
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('is not shown at all before the file has arrived', () => {
    mount('form');
    expect(root()).toHaveAttribute('hidden');
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  });
});

// ── What a trip through Form keeps besides the text ───────────────────────────
describe('Raw → Form → Raw, the status bar', () => {
  it('keeps a refused save’s message, and the dirty buffer under it', async () => {
    const onDirtyChange = vi.fn();
    const { setMode } = mount('raw', { onDirtyChange });
    await loaded();
    act(() => monacoFake.type('{"prot": 44041}'));
    putStatus = 400;
    fireEvent.click(screen.getByTestId('config-save'));
    expect(await screen.findByText('Line 1 · unknown key "prot"')).toBeInTheDocument();

    setMode('form');
    setMode('raw');
    // Nothing remounted, so the verdict the user was reading is still the verdict.
    expect(screen.getByTestId('config-status')).toHaveTextContent('Line 1 · unknown key "prot"');
    expect(screen.getByTestId('config-save')).toBeDisabled();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(monacoFake.state.created).toBe(1);
  });

  it('keeps a successful save’s note, and the clean state', async () => {
    const onDirtyChange = vi.fn();
    const { setMode } = mount('raw', { onDirtyChange });
    await loaded();
    act(() => monacoFake.type('{"port": 44041}'));
    fireEvent.click(screen.getByTestId('config-save'));
    await screen.findByText('Saved · restart palmux to apply');

    setMode('form');
    setMode('raw');
    expect(screen.getByTestId('config-status')).toHaveTextContent(
      'Saved · restart palmux to apply',
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('does not read the file again on the way back', async () => {
    const { setMode } = mount('raw');
    await loaded();
    const gets = () =>
      vi
        .mocked(fetch)
        .mock.calls.filter(([url, init]) => url === '/config-file' && init?.method !== 'PUT');
    expect(gets()).toHaveLength(1);
    setMode('form');
    setMode('raw');
    setMode('form');
    expect(gets()).toHaveLength(1);
  });
});

// ── config-editor.css: what the component's `hidden` relies on ────────────────
//
// happy-dom applies no stylesheet, so `hidden` here only sets an attribute. In a
// browser `.config-editor { display: flex }` outranks the attribute's own
// `display: none`, so without the restated `[hidden]` rule the "hidden" editor
// would sit in the dock under the form, which is the bug this pair of rules is.
describe('config-editor.css', () => {
  const sheet = parse(readFileSync(join(__dirname, 'config-editor.css'), 'utf8'));
  const declarationsOf = (selector: string): Record<string, string> => {
    const out: Record<string, string> = {};
    let found = false;
    sheet.walkRules((rule) => {
      if (!rule.selectors.includes(selector)) return;
      found = true;
      rule.walkDecls((d) => {
        out[d.prop] = d.value.replace(/\s+/g, ' ').trim();
      });
    });
    expect(found, `no rule for ${selector}`).toBe(true);
    return out;
  };

  it('restates display: none for [hidden], against a display that would outrank it', () => {
    expect(declarationsOf('.config-editor')['display']).toBe('flex');
    expect(declarationsOf('.config-editor[hidden]')['display']).toBe('none');
  });

  it('gives the editor host a size of its own and never transitions it', () => {
    const host = declarationsOf('.config-editor-host');
    // Monaco measures its container: a host that collapses to nothing measures 0.
    expect(host['min-height']).toMatch(/^[1-9]\d*px$/);
    expect(host['flex']).toBe('1 1 auto');
    expect(Object.keys(host).filter((prop) => /^(?:transition|animation)/.test(prop))).toEqual([]);
  });

  it('sizes the back control to the control height, over the kit’s 30px floor', () => {
    const back = declarationsOf('.config-editor .config-editor-back');
    expect(back['height']).toBe('var(--ctl-h)');
    expect(back['min-height']).toBe('var(--ctl-h)');
  });

  it('draws the title as a heading level, never an uppercase tracked caption', () => {
    const title = declarationsOf('.config-editor-title');
    expect(title['text-transform']).toBeUndefined();
    expect(title['letter-spacing']).toBeUndefined();
    expect(title['font-size']).toBe('var(--fs-3)');
    // One line, ending in an ellipsis: the whole path is the title attribute.
    expect(title['white-space']).toBe('nowrap');
    expect(title['text-overflow']).toBe('ellipsis');
  });
});
