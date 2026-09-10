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
  it('renders nothing at all when closed and railless', () => {
    // `sidebarRail: 'hidden'` has to cost the terminal ZERO pixels — that is the
    // entire promise of the setting.
    const { container } = render(<DockPanel view={null} rail={false} onView={noop} />);
    expect(container.firstChild).toBeNull();
  });

  it('keeps the rail while closed', () => {
    render(<DockPanel view={null} rail onView={noop} />);
    expect(screen.getByTestId('dock-rail')).toBeInTheDocument();
    expect(screen.queryByTestId('dock')).not.toBeInTheDocument();
  });

  it('shows the open view and marks its rail button pressed', () => {
    render(
      <DockPanel view="files" rail onView={noop}>
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
    render(<DockPanel view="settings" rail onView={onView} />);
    await userEvent.click(screen.getByTestId('dock-rail-settings'));
    expect(onView).toHaveBeenLastCalledWith(null);
    await userEvent.click(screen.getByTestId('dock-rail-files'));
    expect(onView).toHaveBeenLastCalledWith('files');
  });

  it('the close button closes', async () => {
    const onView = vi.fn();
    render(<DockPanel view="dictation" rail onView={onView} />);
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
    const { container } = render(<DockPanel view={null} rail onView={noop} />);
    expect(screen.queryByTestId('dock-rail-upload')).not.toBeInTheDocument();
    expect(container.querySelector('.dock-rail-sep')).toBeNull();
  });

  it('renders them after the four views, behind a separator', () => {
    const { container } = render(
      <DockPanel view={null} rail onView={noop} actions={[...actions(noop)]} />,
    );
    const rail = screen.getByTestId('dock-rail');
    const ids = [...rail.querySelectorAll('button')].map((b) => b.getAttribute('data-testid'));
    expect(ids).toEqual([
      'dock-rail-settings',
      'dock-rail-newtab',
      'dock-rail-files',
      'dock-rail-dictation',
      'dock-rail-upload',
      'dock-rail-download',
    ]);
    expect(container.querySelector('.dock-rail-sep')).not.toBeNull();
  });

  it('runs the action and never opens a view', async () => {
    const onRun = vi.fn();
    const onView = vi.fn();
    render(<DockPanel view={null} rail onView={onView} actions={[...actions(onRun)]} />);
    await userEvent.click(screen.getByTestId('dock-rail-upload'));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onView).not.toHaveBeenCalled();
  });

  // An action never lights up, so it must not claim the pressed state the four
  // views use — that would read as a panel that refuses to open.
  it('carries no aria-pressed', () => {
    render(<DockPanel view="files" rail onView={noop} actions={[...actions(noop)]} />);
    expect(screen.getByTestId('dock-rail-upload')).not.toHaveAttribute('aria-pressed');
    expect(screen.getByTestId('dock-rail-files')).toHaveAttribute('aria-pressed', 'true');
  });

  it('stays hidden with the rail, since it is rail chrome', () => {
    render(<DockPanel view="files" rail={false} onView={noop} actions={[...actions(noop)]} />);
    expect(screen.queryByTestId('dock-rail-upload')).not.toBeInTheDocument();
    expect(screen.getByTestId('dock')).toBeInTheDocument();
  });
});
