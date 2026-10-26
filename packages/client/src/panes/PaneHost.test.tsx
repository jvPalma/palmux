// PaneHost keeps every non-terminal tab mounted and positions it by rect. A review
// tab gets the review pane, told whether it is shown and whether its slot has
// focus, and no other kind's pane stands in for it. The pane's own behaviour
// (a hidden review issues no request) is ReviewPane.test.tsx; what only the host
// can get wrong is handing it the right signals.

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabMeta } from '@palmux/shared';
import { PaneHost } from './PaneHost';

vi.mock('./WebPane', () => ({ WebPane: () => <div data-testid="mock-web" /> }));
vi.mock('./DashboardTab', () => ({ DashboardTab: () => <div data-testid="mock-dashboard" /> }));
vi.mock('./EditorPane', () => ({ EditorPane: () => <div data-testid="mock-editor" /> }));
vi.mock('./MarkdownPane', () => ({ MarkdownPane: () => <div data-testid="mock-markdown" /> }));
vi.mock('./FileTabPane', () => ({ FileTabPane: () => <div data-testid="mock-file" /> }));

const reviewProps = vi.hoisted(() => ({
  seen: [] as { id: string; url: string | undefined; visible: boolean; focused: boolean }[],
}));
vi.mock('../review/ReviewPane', () => ({
  ReviewPane: (p: { tab: TabMeta; visible: boolean; focused: boolean }) => {
    reviewProps.seen.push({
      id: p.tab.id,
      url: p.tab.url,
      visible: p.visible,
      focused: p.focused,
    });
    return <div data-testid={`mock-review-${p.tab.id}`} />;
  },
}));

const noop = () => {};
const none: never[] = [];

function renderHost(
  tabs: TabMeta[],
  rects: Record<string, { left: number; top: number; width: number; height: number }>,
  focusedId: string | null = null,
) {
  return render(
    <PaneHost
      tabs={tabs}
      rects={rects}
      focusedId={focusedId}
      inSplit={false}
      webApps={none}
      quickLinks={none}
      onCreate={noop}
      onUpdateQuickLinks={noop}
      onChangeUrl={noop}
      onDirtyChange={noop}
      onFocus={noop}
    />,
  );
}

const review: TabMeta = { id: '3', kind: 'review', url: 'changes:/work/palmux' };
const full = { left: 0, top: 0, width: 100, height: 100 };

const lastSeen = (id: string) => reviewProps.seen.filter((s) => s.id === id).at(-1);

beforeEach(() => {
  reviewProps.seen.length = 0;
});

describe('review tabs', () => {
  it('renders the review pane for the tab, positioned by its rect', () => {
    renderHost([review], { '3': full });
    const pane = screen.getByTestId('mock-review-3').parentElement!;
    expect(pane.classList.contains('hidden')).toBe(false);
    expect(pane.style.width).toBe('100%');
    expect(lastSeen('3')?.url).toBe('changes:/work/palmux');
    // No other kind's pane stands in for it.
    for (const id of ['mock-web', 'mock-dashboard', 'mock-editor', 'mock-markdown', 'mock-file']) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });

  it('passes `shown` as visible: a review in a slot is visible, one in none is not', () => {
    const { rerender } = renderHost([review], { '3': full });
    expect(lastSeen('3')?.visible).toBe(true);

    rerender(
      <PaneHost
        tabs={[review]}
        rects={{}}
        focusedId={null}
        inSplit={false}
        webApps={none}
        quickLinks={none}
        onCreate={noop}
        onUpdateQuickLinks={noop}
        onChangeUrl={noop}
        onDirtyChange={noop}
        onFocus={noop}
      />,
    );
    // Still mounted and hidden: the pane keeps its scroll and its loaded files.
    expect(screen.getByTestId('mock-review-3').parentElement?.classList.contains('hidden')).toBe(
      true,
    );
    expect(lastSeen('3')?.visible).toBe(false);
  });

  it('passes focus from the focused id', () => {
    renderHost(
      [review, { id: '4', kind: 'review', url: 'staged:/work/palmux' }],
      { '3': full, '4': full },
      '4',
    );
    expect(lastSeen('3')?.focused).toBe(false);
    expect(lastSeen('4')?.focused).toBe(true);
  });

  it('keeps one pane per review tab beside other kinds', () => {
    renderHost(
      [
        review,
        { id: '4', kind: 'review', url: 'staged:/work/palmux' },
        { id: '5', kind: 'web', url: 'https://a.dev' },
      ],
      {},
    );
    expect(screen.getByTestId('mock-review-3')).toBeTruthy();
    expect(screen.getByTestId('mock-review-4')).toBeTruthy();
    expect(screen.getAllByTestId('mock-web')).toHaveLength(1);
  });
});
