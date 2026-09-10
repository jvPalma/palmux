// New-tab chooser: primary actions, Open URL/markdown flows, webApps visibility,
// quick-link CRUD (all via the shared DashboardBody), plus the chooser chrome
// (dismiss/pin).

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NewTabChooser } from './NewTabChooser';

// A press is pointerdown THEN pointerup: the chooser's controls activate on
// up (with a movement check) so a finger can scroll the list past them.
const tap = (el: Element | Window | Document) => {
  fireEvent.pointerDown(el);
  fireEvent.pointerUp(el);
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
