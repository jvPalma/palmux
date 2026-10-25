import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DockPanel, readDockView, writeDockView, DOCK_SETTLE_MS } from './DockPanel';

const noop = () => {};

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('DockPanel', () => {
  // Realigned (batch 12): there is no `rail` prop and no railless state any more.
  // The "renders nothing when closed and railless" test went with the option.
  it('always draws the rail, with the dock closed', () => {
    render(<DockPanel view={null} onView={noop} />);
    expect(screen.getByTestId('dock-rail')).toBeInTheDocument();
    expect(screen.queryByTestId('dock')).not.toBeInTheDocument();
  });

  it('draws the rail beside an open view too', () => {
    render(<DockPanel view="files" onView={noop} />);
    expect(screen.getByTestId('dock-rail')).toBeInTheDocument();
    expect(screen.getByTestId('dock')).toBeInTheDocument();
  });

  it('puts every view on the rail, Dictation included', () => {
    render(<DockPanel view={null} onView={noop} />);
    for (const id of ['newtab', 'files', 'dictation', 'settings']) {
      expect(screen.getByTestId(`dock-rail-${id}`)).toBeInTheDocument();
    }
  });

  it('shows the open view and marks its rail button pressed', () => {
    render(
      <DockPanel view="files" onView={noop}>
        <p>tree</p>
      </DockPanel>,
    );
    expect(screen.getByTestId('dock')).toBeInTheDocument();
    expect(screen.getByTestId('dock-body')).toHaveTextContent('tree');
    expect(screen.getByTestId('dock-rail-files')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('dock-rail-settings')).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking the OPEN view closes the dock, a different one switches', async () => {
    const onView = vi.fn();
    render(<DockPanel view="settings" onView={onView} />);
    await userEvent.click(screen.getByTestId('dock-rail-settings'));
    expect(onView).toHaveBeenLastCalledWith(null);
    await userEvent.click(screen.getByTestId('dock-rail-files'));
    expect(onView).toHaveBeenLastCalledWith('files');
  });

  it('the close button closes', async () => {
    const onView = vi.fn();
    render(<DockPanel view="dictation" onView={onView} />);
    await userEvent.click(screen.getByTestId('dock-close'));
    expect(onView).toHaveBeenCalledWith(null);
  });
});

describe('dock view persistence', () => {
  it('round-trips and clears', () => {
    writeDockView('files');
    expect(readDockView()).toBe('files');
    writeDockView(null);
    expect(readDockView()).toBeNull();
  });

  it('a corrupt or unknown stored value reads as closed, never throws', () => {
    localStorage.setItem('palmux-dock-view', 'not-a-view');
    expect(readDockView()).toBeNull();
  });

  it('survives localStorage being unavailable', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readDockView()).toBeNull();
    spy.mockRestore();
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => writeDockView('settings')).not.toThrow();
    setSpy.mockRestore();
  });
});

describe('resize discipline', () => {
  // The settle window must OUTLAST the surface motion tier. TerminalPane flushes
  // the LAST buffered size when the pause is released, so releasing before the
  // layout settles would send a width measured mid-transition and the shell would
  // redraw at the wrong size — the exact storm the pause exists to prevent.
  it('holds the PTY resize longer than the 240ms surface tier', () => {
    expect(DOCK_SETTLE_MS).toBeGreaterThan(240);
  });
});

// ── Rail actions ──────────────────────────────────────────────────────────────
//
// The desktop topbar used to carry ⬆ Upload, ⬇ Download, ? Tips and ⚙ Settings
// while the rail carried four views — two action bars, reported as "temos duas
// action bars, temos de remover isso e ter apenas a lateral". Upload and
// download moved HERE rather than into a panel, because both are one-click
// actions and a panel would make them three.
describe('rail actions', () => {
  const actions = (onRun: () => void) =>
    [
      { id: 'upload' as const, label: 'Upload a file', onRun },
      { id: 'download' as const, label: 'Download', onRun },
    ] as const;

  it('renders no action buttons, and no separator, without the prop', () => {
    const { container } = render(<DockPanel view={null} onView={noop} />);
    expect(screen.queryByTestId('dock-rail-upload')).not.toBeInTheDocument();
    expect(container.querySelector('.dock-rail-sep')).toBeNull();
  });

  // Frequency of use, top to bottom: what you open mid-session, then the actions
  // behind their separator, then Settings alone at the bottom edge.
  it('renders New tab, Explorer, Dictation, a separator, Upload, Download, Settings', () => {
    const { container } = render(
      <DockPanel view={null} onView={noop} actions={[...actions(noop)]} />,
    );
    const rail = screen.getByTestId('dock-rail');
    const order = [...rail.children].map(
      (el) => el.getAttribute('data-testid') ?? (el.className.includes('sep') ? 'sep' : '?'),
    );
    expect(order).toEqual([
      'dock-rail-newtab',
      'dock-rail-files',
      'dock-rail-dictation',
      'sep',
      'dock-rail-upload',
      'dock-rail-download',
      'dock-rail-settings',
    ]);
    expect(container.querySelector('.dock-rail-sep')).not.toBeNull();
  });

  it('pins Settings, and only Settings, to the bottom of the rail', () => {
    render(<DockPanel view={null} onView={noop} actions={[...actions(noop)]} />);
    const rail = screen.getByTestId('dock-rail');
    expect(rail.lastElementChild).toBe(screen.getByTestId('dock-rail-settings'));
    expect([...rail.querySelectorAll('.dock-rail-pinned')]).toEqual([
      screen.getByTestId('dock-rail-settings'),
    ]);
  });

  it('still ends on Settings with no actions, and draws no separator', () => {
    const { container } = render(<DockPanel view={null} onView={noop} />);
    const rail = screen.getByTestId('dock-rail');
    expect(rail.lastElementChild).toBe(screen.getByTestId('dock-rail-settings'));
    expect(container.querySelector('.dock-rail-sep')).toBeNull();
  });

  it('Settings is still a pressed-state view, not an action', async () => {
    const onView = vi.fn();
    render(<DockPanel view="settings" onView={onView} actions={[...actions(noop)]} />);
    const settings = screen.getByTestId('dock-rail-settings');
    expect(settings).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(settings);
    expect(onView).toHaveBeenLastCalledWith(null);
  });

  // jsdom does not cascade, so the pin is read from the stylesheet: free space
  // above Settings comes from `margin-top: auto` on the element itself.
  it('takes its bottom edge from margin-top: auto on its own element', () => {
    const css = readFileSync(join(__dirname, 'dock.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const body = /\.dock-rail-pinned\s*\{([^{}]*)\}/.exec(css)?.[1] ?? '';
    expect(body).toMatch(/margin-top:\s*auto/);
  });

  // `margin-top: auto` absorbs free space only inside a flex column, so the pin
  // is worth nothing unless the rail itself is one.
  it('keeps the rail a flex column, the container the auto margin needs', () => {
    const css = readFileSync(join(__dirname, 'dock.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const body = /(?:^|\})\s*\.dock-rail\s*\{([^{}]*)\}/.exec(css)?.[1] ?? '';
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/flex-direction:\s*column/);
  });

  it('runs the action and never opens a view', async () => {
    const onRun = vi.fn();
    const onView = vi.fn();
    render(<DockPanel view={null} onView={onView} actions={[...actions(onRun)]} />);
    await userEvent.click(screen.getByTestId('dock-rail-upload'));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onView).not.toHaveBeenCalled();
  });

  // An action never lights up, so it must not claim the pressed state the four
  // views use — that would read as a panel that refuses to open.
  it('carries no aria-pressed', () => {
    render(<DockPanel view="files" onView={noop} actions={[...actions(noop)]} />);
    expect(screen.getByTestId('dock-rail-upload')).not.toHaveAttribute('aria-pressed');
    expect(screen.getByTestId('dock-rail-files')).toHaveAttribute('aria-pressed', 'true');
  });
});
