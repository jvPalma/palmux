// New-tab chooser: primary actions, Open URL/markdown flows, webApps visibility,
// quick-link CRUD (all via the shared DashboardBody), plus the chooser chrome
// (dismiss/pin).

import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardTab } from './DashboardTab';
import { NewTabChooser } from './NewTabChooser';
import { Icon } from '../ui/icons';

// A press is pointerdown THEN pointerup: the chooser's controls activate on
// up (with a movement check) so a finger can scroll the list past them.
const tap = (el: Element | Window | Document) => {
  fireEvent.pointerDown(el);
  fireEvent.pointerUp(el);
};

/** The drawn shapes of a registered icon, to compare against what a control
 *  rendered. Rendered into a detached node so `screen` never sees it. */
const iconPaths = (name: string): string | undefined => {
  const host = document.createElement('div');
  render(<Icon name={name} />, { container: host });
  return host.querySelector('svg')?.innerHTML;
};

const renderChooser = (over: Partial<Parameters<typeof NewTabChooser>[0]> = {}) => {
  const props = {
    webApps: [],
    quickLinks: [],
    onCreate: vi.fn(),
    onUpdateQuickLinks: vi.fn(),
    onClose: vi.fn(),
    onPin: vi.fn(),
    ...over,
  };
  render(<NewTabChooser {...props} />);
  return props;
};

describe('primary actions', () => {
  it('creates terminal and editor tabs', () => {
    const p = renderChooser();
    tap(screen.getByTestId('dash-new-terminal'));
    expect(p.onCreate).toHaveBeenCalledWith({ kind: 'terminal' });
    tap(screen.getByTestId('dash-new-editor'));
    expect(p.onCreate).toHaveBeenCalledWith({ kind: 'editor' });
  });

  it('Open URL… normalizes the input and creates a web tab', () => {
    const p = renderChooser();
    tap(screen.getByTestId('dash-open-url'));
    const input = screen.getByTestId('dash-url-input');
    fireEvent.change(input, { target: { value: 'sb.example.com' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.onCreate).toHaveBeenCalledWith({ kind: 'web', url: 'https://sb.example.com' });
  });

  it('rejects an empty/invalid URL (no create)', () => {
    const p = renderChooser();
    tap(screen.getByTestId('dash-open-url'));
    const input = screen.getByTestId('dash-url-input');
    fireEvent.change(input, { target: { value: 'javascript:alert(1)' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.onCreate).not.toHaveBeenCalled();
  });

  it('Open markdown… with a path creates a markdown tab', () => {
    const p = renderChooser();
    tap(screen.getByTestId('dash-open-markdown'));
    const input = screen.getByTestId('dash-md-input');
    fireEvent.change(input, { target: { value: '/home/user/notes/a.md' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.onCreate).toHaveBeenCalledWith({ kind: 'markdown', url: '/home/user/notes/a.md' });
  });

  it('Open markdown… with an empty path creates a browse-view tab', () => {
    const p = renderChooser();
    tap(screen.getByTestId('dash-open-markdown'));
    tap(screen.getByTestId('dash-md-go')); // empty → browse
    expect(p.onCreate).toHaveBeenCalledWith({ kind: 'markdown' });
  });
});

describe('webApps section', () => {
  it('is omitted entirely when nothing is configured', () => {
    renderChooser();
    expect(screen.queryByTestId('dash-webapps')).toBeNull();
  });

  it('opens a configured app as a pre-named web tab', () => {
    const p = renderChooser({
      webApps: [{ name: 'SilverBullet', url: 'https://sb.local', icon: '📓' }],
    });
    tap(screen.getByTestId('dash-webapp-SilverBullet'));
    expect(p.onCreate).toHaveBeenCalledWith({
      kind: 'web',
      url: 'https://sb.local',
      name: 'SilverBullet',
    });
  });
});

describe('icons', () => {
  afterEach(() => vi.unstubAllGlobals());

  // Chrome, not data: the create tiles and the section rows draw shared icons,
  // while a configured app's own `icon` is the user's text and stays as written.
  it('draws each create tile as its own icon plus its label', () => {
    renderChooser();
    for (const [id, label, icon] of [
      ['dash-new-terminal', 'Terminal', 'terminal'],
      ['dash-new-editor', 'Editor', 'pencil'],
      ['dash-open-url', 'URL…', 'globe'],
      ['dash-open-markdown', 'Markdown…', 'book'],
    ] as const) {
      const tile = screen.getByTestId(id);
      expect(tile.querySelectorAll('svg')).toHaveLength(1);
      expect(tile.querySelector('svg')?.innerHTML, id).toBe(iconPaths(icon));
      expect(tile.textContent).toBe(label);
    }
  });

  it('gives an app with no icon the link icon and keeps one that has its own', () => {
    renderChooser({
      webApps: [
        { name: 'SilverBullet', url: 'https://sb.local', icon: '📓' },
        { name: 'Plain', url: 'https://plain.local' },
      ],
    });
    const own = screen.getByTestId('dash-webapp-SilverBullet');
    expect(own.querySelector('svg')).toBeNull();
    expect(own.querySelector('.dash-srow-icon')?.textContent).toBe('📓');
    expect(
      screen.getByTestId('dash-webapp-Plain').querySelector('.dash-srow-icon svg')?.innerHTML,
    ).toBe(iconPaths('link'));
  });

  it('keeps the icon-only controls named, each with its own icon', () => {
    renderChooser({ quickLinks: [{ name: 'grafana', url: 'https://g.local' }] });
    for (const [id, name, icon] of [
      ['dashboard-close', { attr: 'aria-label', value: 'Close' }, 'close'],
      ['dashboard-pin', { attr: 'title', value: 'Keep as a tab' }, 'pin'],
      ['dash-link-remove-grafana', { attr: 'aria-label', value: 'Remove grafana' }, 'close'],
    ] as const) {
      const button = screen.getByTestId(id);
      expect(button.querySelectorAll('svg')).toHaveLength(1);
      expect(button.querySelector('svg')?.innerHTML, id).toBe(iconPaths(icon));
      expect(button.textContent).toBe('');
      expect(button).toHaveAttribute(name.attr, name.value);
    }
    // A saved link's leading mark is the link icon, not the 🔗 it replaced.
    expect(
      screen.getByTestId('dash-link-grafana').querySelector('.dash-srow-icon svg')?.innerHTML,
    ).toBe(iconPaths('link'));
  });

  // The drawer button is the only way to the tab list on a phone, so it has to
  // keep a name now that ☰ is an aria-hidden icon, and it has to keep working.
  it('names the drawer button on the chooser and on the dashboard tab', () => {
    const onMenu = vi.fn();
    renderChooser({ onMenu });
    const chooserMenu = screen.getByRole('button', { name: 'Open drawer' });
    expect(chooserMenu.textContent).toBe('');
    expect(chooserMenu.querySelector('svg')?.innerHTML).toBe(iconPaths('menu'));
    fireEvent.pointerDown(chooserMenu);
    expect(onMenu).toHaveBeenCalledTimes(1);

    const onTabMenu = vi.fn();
    render(
      <DashboardTab
        webApps={[]}
        quickLinks={[]}
        onCreate={vi.fn()}
        onUpdateQuickLinks={vi.fn()}
        onMenu={onTabMenu}
      />,
    );
    const tabMenus = screen.getAllByRole('button', { name: 'Open drawer' });
    const tabMenu = tabMenus[tabMenus.length - 1] as HTMLElement;
    expect(tabMenu.textContent).toBe('');
    expect(tabMenu.querySelector('svg')?.innerHTML).toBe(iconPaths('menu'));
    fireEvent.pointerDown(tabMenu);
    expect(onTabMenu).toHaveBeenCalledTimes(1);
  });

  // The tmux "new" row was a ＋ character and a listening port a ◉; the port's
  // mark is the solid record dot, tinted live by its class.
  it('draws the tmux new-session row and a listening port as icons', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () =>
          url === '/ports'
            ? { available: true, ports: [{ port: 5173, pid: 42, process: 'node' }] }
            : { available: true, sessions: [{ name: 'build', attached: true }] },
      })),
    );
    renderChooser();
    const newRow = await screen.findByTestId('dash-tmux-new');
    expect(newRow.querySelector('.dash-srow-icon svg')?.innerHTML).toBe(iconPaths('plus'));
    expect(newRow).toHaveTextContent(/^New tmux session$/);
    const port = await screen.findByTestId('dash-port-5173');
    expect(port.querySelector('.dash-srow-icon-live svg')?.innerHTML).toBe(iconPaths('record'));
    expect(port.textContent).toBe('5173node');
  });
});

describe('quick links', () => {
  it('adds a link with a normalized url', () => {
    const p = renderChooser();
    tap(screen.getByTestId('dash-add-link'));
    fireEvent.change(screen.getByTestId('dash-add-name'), { target: { value: 'grafana' } });
    fireEvent.change(screen.getByTestId('dash-add-url'), { target: { value: 'g.local' } });
    tap(screen.getByTestId('dash-add-save'));
    expect(p.onUpdateQuickLinks).toHaveBeenCalledWith([
      { name: 'grafana', url: 'https://g.local' },
    ]);
  });

  it('removes a link and opens one as a named web tab', () => {
    const p = renderChooser({ quickLinks: [{ name: 'grafana', url: 'https://g.local' }] });
    tap(screen.getByTestId('dash-link-grafana'));
    expect(p.onCreate).toHaveBeenCalledWith({
      kind: 'web',
      url: 'https://g.local',
      name: 'grafana',
    });
    tap(screen.getByTestId('dash-link-remove-grafana'));
    expect(p.onUpdateQuickLinks).toHaveBeenCalledWith([]);
  });
});

// The header buttons are fixed chrome, so a pointer acts on pointerdown (which
// keeps #mobile-kbd focused). They are focusable buttons as well, so Enter, Space
// and a click with no pointer press behind it (assistive tech, `element.click()`)
// must reach them too, and a pointer press's own trailing click must not act a
// second time.
describe('header buttons as buttons', () => {
  // A mark armed by one test's press must not swallow the next test's first click.
  afterEach(() => void fireEvent.keyDown(document));

  const HEADER = [
    ['the chooser close', () => screen.getByTestId('dashboard-close'), 'onClose'],
    ['the chooser pin', () => screen.getByTestId('dashboard-pin'), 'onPin'],
    [
      'the chooser drawer button',
      () => screen.getByRole('button', { name: 'Open drawer' }),
      'onMenu',
    ],
  ] as const;
  const renderHeader = () => renderChooser({ onMenu: vi.fn() });

  it.each(HEADER)('%s acts once on Enter', async (_, get, prop) => {
    const p = renderHeader();
    get().focus();
    await userEvent.setup().keyboard('{Enter}');
    expect(p[prop]).toHaveBeenCalledTimes(1);
  });

  it.each(HEADER)('%s acts once on Space', async (_, get, prop) => {
    const p = renderHeader();
    get().focus();
    await userEvent.setup().keyboard(' ');
    expect(p[prop]).toHaveBeenCalledTimes(1);
  });

  it.each(HEADER)('%s acts once on a click with no pointer press before it', (_, get, prop) => {
    const p = renderHeader();
    act(() => get().click());
    expect(p[prop]).toHaveBeenCalledTimes(1);
  });

  it.each(HEADER)('%s acts once for a pointer press: down, up, then its click', (_, get, prop) => {
    const p = renderHeader();
    const button = get();
    fireEvent.pointerDown(button, { pointerId: 1, pointerType: 'touch' });
    expect(p[prop]).toHaveBeenCalledTimes(1); // fixed chrome acts as the finger lands
    fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'touch' });
    fireEvent.click(button, { detail: 1 });
    expect(p[prop]).toHaveBeenCalledTimes(1);
  });

  it.each(HEADER)('%s keeps #mobile-kbd focused: its touch pointerdown is prevented', (_, get) => {
    renderHeader();
    expect(fireEvent.pointerDown(get(), { pointerId: 1, pointerType: 'touch' })).toBe(false);
  });

  it.each(HEADER)(
    '%s acts once for a mouse press, and keeps focus where it was',
    (_, get, prop) => {
      const p = renderHeader();
      const button = get();
      const mouse = { pointerId: 1, pointerType: 'mouse' };
      expect(fireEvent.pointerDown(button, mouse)).toBe(false);
      fireEvent.pointerUp(button, mouse);
      fireEvent.click(button, { detail: 1 });
      expect(p[prop]).toHaveBeenCalledTimes(1);
    },
  );

  it('the dashboard tab’s drawer button acts once on Enter, on Space and for a pointer press', async () => {
    const onMenu = vi.fn();
    render(
      <DashboardTab
        webApps={[]}
        quickLinks={[]}
        onCreate={vi.fn()}
        onUpdateQuickLinks={vi.fn()}
        onMenu={onMenu}
      />,
    );
    const button = screen.getByRole('button', { name: 'Open drawer' });
    button.focus();
    await userEvent.setup().keyboard('{Enter}');
    expect(onMenu).toHaveBeenCalledTimes(1);
    await userEvent.setup().keyboard(' ');
    expect(onMenu).toHaveBeenCalledTimes(2);
    fireEvent.pointerDown(button, { pointerId: 1, pointerType: 'touch' });
    fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'touch' });
    fireEvent.click(button, { detail: 1 });
    expect(onMenu).toHaveBeenCalledTimes(3);
  });
});

// The body's list controls activate on pointer UP so a finger can scroll past them;
// the same controls must answer the keyboard, exactly once per Enter or Space. A
// <button> turns either key into a click of its own, so that click is the one route.
describe('body controls from the keyboard', () => {
  afterEach(() => void fireEvent.keyDown(document));

  it.each([
    ['Enter', '{Enter}'],
    ['Space', ' '],
  ])('%s on Open (URL) creates the web tab once', async (_, key) => {
    const p = renderChooser();
    tap(screen.getByTestId('dash-open-url'));
    fireEvent.change(screen.getByTestId('dash-url-input'), { target: { value: 'sb.example.com' } });
    screen.getByTestId('dash-url-go').focus();
    await userEvent.setup().keyboard(key);
    expect(p.onCreate).toHaveBeenCalledTimes(1);
    expect(p.onCreate).toHaveBeenCalledWith({ kind: 'web', url: 'https://sb.example.com' });
  });

  it.each([
    ['Enter', '{Enter}'],
    ['Space', ' '],
  ])('%s on Open (markdown) creates the browse tab once', async (_, key) => {
    const p = renderChooser();
    tap(screen.getByTestId('dash-open-markdown'));
    screen.getByTestId('dash-md-go').focus();
    await userEvent.setup().keyboard(key);
    expect(p.onCreate).toHaveBeenCalledTimes(1);
    expect(p.onCreate).toHaveBeenCalledWith({ kind: 'markdown' });
  });

  it.each([
    ['Enter', '{Enter}'],
    ['Space', ' '],
  ])('%s on Add saves the link once', async (_, key) => {
    const p = renderChooser();
    tap(screen.getByTestId('dash-add-link'));
    fireEvent.change(screen.getByTestId('dash-add-name'), { target: { value: 'grafana' } });
    fireEvent.change(screen.getByTestId('dash-add-url'), { target: { value: 'g.local' } });
    screen.getByTestId('dash-add-save').focus();
    await userEvent.setup().keyboard(key);
    expect(p.onUpdateQuickLinks).toHaveBeenCalledTimes(1);
    expect(p.onUpdateQuickLinks).toHaveBeenCalledWith([
      { name: 'grafana', url: 'https://g.local' },
    ]);
  });

  it.each([
    ['Enter', '{Enter}'],
    ['Space', ' '],
  ])('%s on a link’s remove button removes it once', async (_, key) => {
    const p = renderChooser({ quickLinks: [{ name: 'grafana', url: 'https://g.local' }] });
    screen.getByTestId('dash-link-remove-grafana').focus();
    await userEvent.setup().keyboard(key);
    expect(p.onUpdateQuickLinks).toHaveBeenCalledTimes(1);
    expect(p.onUpdateQuickLinks).toHaveBeenCalledWith([]);
  });

  it.each([
    ['Enter', '{Enter}'],
    ['Space', ' '],
  ])('%s on a create tile creates once', async (_, key) => {
    const p = renderChooser();
    screen.getByTestId('dash-new-editor').focus();
    await userEvent.setup().keyboard(key);
    expect(p.onCreate).toHaveBeenCalledTimes(1);
    expect(p.onCreate).toHaveBeenCalledWith({ kind: 'editor' });
  });

  it('a pointer press on Open, then its own click, creates once', () => {
    const p = renderChooser();
    tap(screen.getByTestId('dash-open-markdown'));
    const go = screen.getByTestId('dash-md-go');
    fireEvent.pointerDown(go, { pointerId: 1, pointerType: 'touch' });
    fireEvent.pointerUp(go, { pointerId: 1, pointerType: 'touch' });
    fireEvent.click(go, { detail: 1 });
    expect(p.onCreate).toHaveBeenCalledTimes(1);
  });
});

// `URL…` and `Markdown…` TOGGLE their input row, so a second activation shows up
// as the row closing again: the plainest witness that a route acted exactly once.
describe('a toggle tile opens its row once, by every route', () => {
  afterEach(() => void fireEvent.keyDown(document));

  const TILES = [
    ['dash-open-url', 'dash-url-input'],
    ['dash-open-markdown', 'dash-md-input'],
  ] as const;
  const touch = { pointerId: 1, pointerType: 'touch' };
  const mouse = { pointerId: 1, pointerType: 'mouse' };
  const ROUTES: [string, (el: HTMLElement) => void | Promise<void>][] = [
    [
      'Enter',
      async (el) => {
        el.focus();
        await userEvent.setup().keyboard('{Enter}');
      },
    ],
    [
      'Space',
      async (el) => {
        el.focus();
        await userEvent.setup().keyboard(' ');
      },
    ],
    ['a click with no pointer press', (el) => void act(() => el.click())],
    [
      'a touch press with the mouse events a browser adds',
      (el) => {
        fireEvent.pointerDown(el, touch);
        fireEvent.pointerUp(el, touch);
        fireEvent.mouseDown(el, { detail: 1 });
        fireEvent.mouseUp(el, { detail: 1 });
        fireEvent.click(el, { detail: 1 });
      },
    ],
    [
      'a mouse press',
      (el) => {
        fireEvent.pointerDown(el, mouse);
        fireEvent.pointerUp(el, mouse);
        fireEvent.click(el, { detail: 1 });
      },
    ],
  ];

  describe.each(TILES)('%s', (tile, input) => {
    it.each(ROUTES)('on %s', async (_, route) => {
      renderChooser();
      await route(screen.getByTestId(tile));
      expect(screen.queryByTestId(input)).not.toBeNull();
    });
  });
});

// The chooser's controls sit in a list that scrolls. A touch pointerdown must be
// left alone or the list cannot pan, and a press that moved is a scroll, so it acts
// on nothing: not on the release, and not on the click a mouse drag ends with.
describe('body controls inside a scroller', () => {
  afterEach(() => void fireEvent.keyDown(document));

  const LINKS = [{ name: 'grafana', url: 'https://g.local' }];
  const CONTROLS = [
    ['a create tile', 'dash-new-terminal', 'onCreate'],
    ['a quick link', 'dash-link-grafana', 'onCreate'],
    ['a link’s remove button', 'dash-link-remove-grafana', 'onUpdateQuickLinks'],
  ] as const;

  it.each(CONTROLS)('%s: a touch pointerdown is left alone, so the list pans', (_, id) => {
    renderChooser({ quickLinks: LINKS });
    expect(
      fireEvent.pointerDown(screen.getByTestId(id), { pointerId: 1, pointerType: 'touch' }),
    ).toBe(true);
  });

  it.each(CONTROLS)('%s: a touch that moved past the slop acts on nothing', (_, id, spy) => {
    const p = renderChooser({ quickLinks: LINKS });
    const el = screen.getByTestId(id);
    const at = { pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 200 };
    fireEvent.pointerDown(el, at);
    fireEvent.pointerMove(el, { ...at, clientY: 150 });
    fireEvent.pointerUp(el, { ...at, clientY: 150 });
    expect(p[spy]).not.toHaveBeenCalled();
  });

  it.each(CONTROLS)('%s: a mouse drag released on it acts on nothing', (_, id, spy) => {
    const p = renderChooser({ quickLinks: LINKS });
    const el = screen.getByTestId(id);
    const at = { pointerId: 1, pointerType: 'mouse', clientX: 40, clientY: 40 };
    fireEvent.pointerDown(el, at);
    fireEvent.pointerMove(el, { ...at, clientX: 100 });
    fireEvent.pointerUp(el, { ...at, clientX: 100 });
    fireEvent.click(el, { detail: 1 });
    expect(p[spy]).not.toHaveBeenCalled();
  });
});

// Picking a create tile hands the page to a new tab, and closing the chooser
// uncovers what was under it. The browser hit-tests the rest of the tap after the
// release, so its mouse events and click land on THAT, which took them as a tap of
// its own. `Close` acts on pointerdown and the tile on pointerup, so both orders.
describe('the rest of a press, landing on what the chooser uncovered', () => {
  afterEach(() => void fireEvent.keyDown(document));

  const touch = { pointerId: 1, pointerType: 'touch' };
  const mouse = { pointerId: 1, pointerType: 'mouse' };
  const renderOverTerminal = () => {
    const under = { click: vi.fn(), mouseDown: vi.fn(), mouseUp: vi.fn() };
    const Host = () => {
      const [gone, setGone] = useState(false);
      if (gone) {
        return (
          <button
            data-testid="terminal"
            onClick={under.click}
            onMouseDown={under.mouseDown}
            onMouseUp={under.mouseUp}
          >
            terminal
          </button>
        );
      }
      return (
        <NewTabChooser
          webApps={[]}
          quickLinks={[]}
          onCreate={() => setGone(true)}
          onUpdateQuickLinks={vi.fn()}
          onClose={() => setGone(true)}
        />
      );
    };
    render(<Host />);
    return under;
  };

  /** A later, separate tap on the terminal, which is the user's own and must land. */
  const tapAgain = (under: ReturnType<typeof renderOverTerminal>) => {
    const terminal = screen.getByTestId('terminal');
    fireEvent.pointerDown(terminal, { pointerId: 2, pointerType: 'touch' });
    fireEvent.pointerUp(terminal, { pointerId: 2, pointerType: 'touch' });
    fireEvent.click(terminal, { detail: 1 });
    expect(under.click).toHaveBeenCalledTimes(1);
  };

  it('a touch on a create tile (acts on release): the rest of the tap reaches nothing', () => {
    const under = renderOverTerminal();
    fireEvent.pointerDown(screen.getByTestId('dash-new-terminal'), touch);
    fireEvent.pointerUp(screen.getByTestId('dash-new-terminal'), touch);
    const terminal = screen.getByTestId('terminal');
    fireEvent.mouseDown(terminal, { detail: 1 });
    fireEvent.mouseUp(terminal, { detail: 1 });
    fireEvent.click(terminal, { detail: 1 });
    expect(under.mouseDown).not.toHaveBeenCalled();
    expect(under.mouseUp).not.toHaveBeenCalled();
    expect(under.click).not.toHaveBeenCalled();
    tapAgain(under);
  });

  it('a mouse press on a create tile: its click reaches nothing', () => {
    const under = renderOverTerminal();
    fireEvent.pointerDown(screen.getByTestId('dash-new-terminal'), mouse);
    fireEvent.pointerUp(screen.getByTestId('dash-new-terminal'), mouse);
    fireEvent.click(screen.getByTestId('terminal'), { detail: 1 });
    expect(under.click).not.toHaveBeenCalled();
    tapAgain(under);
  });

  it('a touch on Close (acts on press): the rest of the tap reaches nothing', () => {
    const under = renderOverTerminal();
    fireEvent.pointerDown(screen.getByTestId('dashboard-close'), touch);
    const terminal = screen.getByTestId('terminal');
    fireEvent.pointerUp(terminal, touch);
    fireEvent.mouseDown(terminal, { detail: 1 });
    fireEvent.mouseUp(terminal, { detail: 1 });
    fireEvent.click(terminal, { detail: 1 });
    expect(under.mouseDown).not.toHaveBeenCalled();
    expect(under.mouseUp).not.toHaveBeenCalled();
    expect(under.click).not.toHaveBeenCalled();
    tapAgain(under);
  });
});

describe('chooser chrome', () => {
  it('dismiss creates nothing; pin pins', () => {
    const p = renderChooser();
    tap(screen.getByTestId('dashboard-close'));
    expect(p.onClose).toHaveBeenCalled();
    expect(p.onCreate).not.toHaveBeenCalled();
    tap(screen.getByTestId('dashboard-pin'));
    expect(p.onPin).toHaveBeenCalled();
  });

  it('the last-tab page (no onClose) shows pin but no close button', () => {
    renderChooser({ onClose: undefined });
    expect(screen.queryByTestId('dashboard-close')).toBeNull();
    expect(screen.getByTestId('dashboard-pin')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-pane')).toHaveTextContent('New tab');
  });
});
