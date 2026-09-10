// Drawer tab rows: identity rendering (icon/dot/title) and the tap-vs-longpress
// split — tap switches, holding LONG_PRESS_MS opens the tab sheet instead.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabGroup, TabMeta } from '@palmux/shared';
import { SessionDrawer } from './SessionDrawer';
import { DEFAULTS } from '../settings/settings';

// Controls inside the scrolling list activate on pointer UP (with a movement
// check), so a press is down THEN up. Fixed chrome still fires on down.
const tap = (el: Element) => {
  fireEvent.pointerDown(el);
  fireEvent.pointerUp(el);
};

const TABS: TabMeta[] = [
  { id: '0', kind: 'terminal', title: 'vim' },
  { id: '1', kind: 'web', url: 'https://sb.local', name: 'SB', color: 'teal' },
];

const GROUPED_TABS: TabMeta[] = [
  { id: '0', kind: 'terminal', title: 'vim', groupId: 'g1' },
  { id: '1', kind: 'web', url: 'https://sb.local', name: 'SB', color: 'teal' },
];

const GROUPS: TabGroup[] = [{ id: 'g1', name: 'dev', color: 'ansi3' }];

const renderDrawer = (overrides: Partial<Parameters<typeof SessionDrawer>[0]> = {}) => {
  const props = {
    open: true,
    tabs: TABS,
    current: '0',
    onSwitch: vi.fn(),
    onCreate: vi.fn(),
    onKill: vi.fn(),
    onClose: vi.fn(),
    onTabMenu: vi.fn(),
    actions: {
      uploadFile: vi.fn(),
      uploadImages: vi.fn(),
      downloadFile: vi.fn(),
      dictate: vi.fn(),
    },
    settings: DEFAULTS,
    onChangeSettings: vi.fn(),
    ...overrides,
  };
  render(<SessionDrawer {...props} />);
  return props;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('rows', () => {
  it('render kind icon, color dot, and display title', () => {
    renderDrawer();
    expect(screen.getByTestId('drawer-session-0')).toHaveTextContent('❯');
    expect(screen.getByTestId('drawer-session-0')).toHaveTextContent('vim');
    expect(screen.getByTestId('drawer-session-1')).toHaveTextContent('SB');
  });

  it('every row carries a color chip with its tab number', () => {
    renderDrawer();
    // Rendered for the uncolored tab too (it falls back to the theme accent) —
    // the number is the URL path, not a decoration.
    expect(screen.getByTestId('drawer-num-0')).toHaveTextContent('0');
    expect(screen.getByTestId('drawer-num-1')).toHaveTextContent('1');
  });

  it('tap switches and closes the drawer', () => {
    const p = renderDrawer();
    const row = screen.getByTestId('drawer-session-1');
    fireEvent.pointerDown(row);
    fireEvent.pointerUp(row);
    expect(p.onSwitch).toHaveBeenCalledWith('1');
    expect(p.onClose).toHaveBeenCalled();
    expect(p.onTabMenu).not.toHaveBeenCalled();
  });

  it('long-press opens the tab sheet and swallows the switch', () => {
    const p = renderDrawer();
    const row = screen.getByTestId('drawer-session-1');
    fireEvent.pointerDown(row);
    act(() => {
      vi.advanceTimersByTime(500); // past LONG_PRESS_MS
    });
    fireEvent.pointerUp(row);
    expect(p.onTabMenu).toHaveBeenCalledWith('1');
    expect(p.onSwitch).not.toHaveBeenCalled();
  });

  it('row ✕ requests a close for that tab', () => {
    const p = renderDrawer();
    tap(screen.getByTestId('drawer-kill-1'));
    expect(p.onKill).toHaveBeenCalledWith('1');
  });

  it('+ New tab opens the new-tab flow', () => {
    const p = renderDrawer();
    tap(screen.getByTestId('drawer-new'));
    expect(p.onCreate).toHaveBeenCalled();
  });

  it('group header gets member-active when the current tab is a member', () => {
    renderDrawer({ tabs: GROUPED_TABS, groups: GROUPS, current: '0' });
    expect(screen.getByTestId('drawer-group-g1')).toHaveClass('member-active');
  });

  it('group header omits member-active when the current tab is not a member', () => {
    renderDrawer({ tabs: GROUPED_TABS, groups: GROUPS, current: '1' });
    expect(screen.getByTestId('drawer-group-g1')).not.toHaveClass('member-active');
  });
});

describe('footer', () => {
  it('🖼 Images opens the image picker and closes the drawer', () => {
    const p = renderDrawer();
    fireEvent.pointerDown(screen.getByTestId('drawer-upload-images'));
    expect(p.actions.uploadImages).toHaveBeenCalled();
    expect(p.actions.uploadFile).not.toHaveBeenCalled();
    expect(p.onClose).toHaveBeenCalled();
  });

  it('has no keyboard cell — ESC long-press and the bar swipe already raise it', () => {
    renderDrawer();
    expect(screen.queryByTestId('drawer-keyboard')).toBeNull();
  });

  it('has no mic cell — the remote-mic bridge is gone', () => {
    renderDrawer();
    expect(screen.queryByTestId('drawer-mic')).toBeNull();
  });
});

describe('header', () => {
  // The segmented header IS the way to settings. The old `palmux` + ⚙ row under
  // it was a second control for the same job, so it is gone — and with it the
  // wordmark, which told the user the name of the app they were already in.
  it('has no brand row and no second settings control', () => {
    renderDrawer();
    expect(screen.queryByTestId('drawer-settings')).toBeNull();
    expect(document.querySelector('.drawer-head')).toBeNull();
    expect(screen.queryByText('palmux')).toBeNull();
  });

  it('the settings segment opens the view, and its header goes back', () => {
    renderDrawer();
    expect(screen.queryByTestId('drawer-settings-body')).toBeNull();

    fireEvent.pointerDown(screen.getByTestId('drawer-view-settings'));
    expect(screen.getByTestId('drawer-settings-body')).toBeTruthy();

    fireEvent.pointerDown(screen.getByTestId('drawer-settings-back'));
    expect(screen.queryByTestId('drawer-settings-body')).toBeNull();
  });
});

// The four-view header. Files and Dictation have no body of their own, so the
// host renders them — and availability has to be DECLARED, not inferred from
// the body: the body can only exist for the view that is already selected, so
// inferring it left both views disabled forever and unreachable.
describe('view switching', () => {
  const options = () =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-testid^="drawer-view-"]')].map((e) => [
        (e as HTMLElement).dataset['testid']!.replace('drawer-view-', ''),
        !(e as HTMLButtonElement).disabled,
      ]),
    );

  it('disables a hosted view the host has not declared', () => {
    renderDrawer();
    expect(options()).toMatchObject({
      sessions: true,
      settings: true,
      files: false,
      dictation: false,
    });
  });

  it('enables a declared hosted view even before any body exists', () => {
    renderDrawer({ hostedViews: ['files', 'dictation'] });
    expect(options()).toMatchObject({ files: true, dictation: true });
  });

  // The full round trip the old rule made impossible: select → host reacts →
  // body appears. A controlled host owns `view`, so the drawer only reports it.
  it('selecting a declared view reports it, and its body renders once supplied', () => {
    const onView = vi.fn();
    const props = {
      open: true,
      tabs: TABS,
      current: '0',
      onSwitch: vi.fn(),
      onCreate: vi.fn(),
      onKill: vi.fn(),
      onClose: vi.fn(),
      onTabMenu: vi.fn(),
      actions: {
        uploadFile: vi.fn(),
        uploadImages: vi.fn(),
        downloadFile: vi.fn(),
        dictate: vi.fn(),
      },
      settings: DEFAULTS,
      onChangeSettings: vi.fn(),
      hostedViews: ['files'] as const,
      onView,
    };
    const view = render(<SessionDrawer {...props} view="sessions" />);

    fireEvent.click(screen.getByTestId('drawer-view-files'));
    expect(onView).toHaveBeenCalledWith('files');
    expect(screen.queryByTestId('host-files')).toBeNull(); // nothing yet

    view.rerender(
      <SessionDrawer {...props} view="files" viewContent={<div data-testid="host-files" />} />,
    );
    expect(screen.getByTestId('host-files')).toBeTruthy();
    expect(screen.getByTestId('drawer-view-body')).toBeTruthy();
  });
});

// `+ New tab` used to CLOSE the drawer and leave the host to float the chooser
// somewhere else — on a phone that was a box in the screen corner. The chooser
// belongs in the container that is already open.
describe('new tab', () => {
  it('closes the drawer only when the host renders no chooser of its own', () => {
    const { onCreate, onClose } = renderDrawer();
    tap(screen.getByTestId('drawer-new'));
    expect(onCreate).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled(); // legacy host: nothing here to show
  });

  it('keeps the drawer open when the host will render the chooser inside it', () => {
    const { onCreate, onClose } = renderDrawer({ onNewTabBack: vi.fn() });
    tap(screen.getByTestId('drawer-new'));
    expect(onCreate).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the chooser in place of the session list, with a way back', () => {
    const onNewTabBack = vi.fn();
    renderDrawer({
      onNewTabBack,
      newTabContent: <div data-testid="host-chooser">chooser</div>,
    });

    expect(screen.getByTestId('host-chooser')).toBeTruthy();
    expect(screen.getByTestId('drawer-newtab-body')).toBeTruthy();
    // The list is still mounted (its rows keep their state) but not shown.
    expect(screen.getByTestId('drawer-session-0').closest('.drawer-sessions')).toHaveAttribute(
      'hidden',
    );

    fireEvent.pointerDown(screen.getByTestId('drawer-newtab-back'));
    expect(onNewTabBack).toHaveBeenCalled();
  });
});
