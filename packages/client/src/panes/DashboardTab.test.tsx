// Pinned dashboard tab: renders the shared body but WITHOUT the chooser chrome
// (no pin / close), titled "Dashboard".

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DashboardTab } from './DashboardTab';

// A press is pointerdown THEN pointerup: the chooser's controls activate on
// up (with a movement check) so a finger can scroll the list past them.
const tap = (el: Element | Window | Document) => {
  fireEvent.pointerDown(el);
  fireEvent.pointerUp(el);
};

describe('dashboard tab', () => {
  it('hides the chooser chrome and titles itself Dashboard', () => {
    render(
      <DashboardTab webApps={[]} quickLinks={[]} onCreate={vi.fn()} onUpdateQuickLinks={vi.fn()} />,
    );
    expect(screen.queryByTestId('dashboard-close')).toBeNull();
    expect(screen.queryByTestId('dashboard-pin')).toBeNull();
    expect(screen.getByTestId('dashboard-pane')).toHaveTextContent('Dashboard');
  });

  it('still exposes the shared body actions', () => {
    const onCreate = vi.fn();
    render(
      <DashboardTab
        webApps={[]}
        quickLinks={[]}
        onCreate={onCreate}
        onUpdateQuickLinks={vi.fn()}
      />,
    );
    tap(screen.getByTestId('dash-new-terminal'));
    expect(onCreate).toHaveBeenCalledWith({ kind: 'terminal' });
  });
});
