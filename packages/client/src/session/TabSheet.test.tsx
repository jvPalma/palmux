// Mobile tab sheet: rename via Done/Enter, palette recolor, close-tab routing.

import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TabGroup, TabMeta } from '@palmux/shared';
import { TabSheet } from './TabSheet';

const TAB: TabMeta = { id: '3', kind: 'web', url: 'https://sb.local', name: 'SB', color: 'teal' };
const GROUPS: TabGroup[] = [
  { id: 'gaaaaa', name: 'dev', color: 'ansi2' },
  { id: 'gbbbbb', color: 'ansi4' },
];

const renderSheet = (tab: TabMeta = TAB) => {
  const props = {
    tab,
    onRename: vi.fn(),
    onRecolor: vi.fn(),
    groups: GROUPS,
    onNewGroup: vi.fn(),
    onAddToGroup: vi.fn(),
    onRemoveFromGroup: vi.fn(),
    onCloseTab: vi.fn(),
    onDismiss: vi.fn(),
  };
  render(<TabSheet {...props} />);
  return props;
};

describe('TabSheet', () => {
  it('commits a changed name on Done and dismisses', () => {
    const p = renderSheet();
    fireEvent.change(screen.getByTestId('sheet-rename'), { target: { value: 'notes' } });
    fireEvent.pointerDown(screen.getByTestId('sheet-done'));
    expect(p.onRename).toHaveBeenCalledWith('3', 'notes');
    expect(p.onDismiss).toHaveBeenCalled();
  });

  it('does not send a rename when the name is unchanged', () => {
    const p = renderSheet();
    fireEvent.pointerDown(screen.getByTestId('sheet-done'));
    expect(p.onRename).not.toHaveBeenCalled();
    expect(p.onDismiss).toHaveBeenCalled();
  });

  it('clearing the field sends an empty rename (falls back to automatic title)', () => {
    const p = renderSheet();
    fireEvent.change(screen.getByTestId('sheet-rename'), { target: { value: '' } });
    fireEvent.pointerDown(screen.getByTestId('sheet-done'));
    expect(p.onRename).toHaveBeenCalledWith('3', '');
  });

  it('palette swatches recolor; ∅ clears', () => {
    const p = renderSheet();
    fireEvent.click(screen.getByTestId('sheet-color-ansi4'));
    expect(p.onRecolor).toHaveBeenCalledWith('3', 'ansi4');
    fireEvent.pointerDown(screen.getByTestId('sheet-color-none'));
    expect(p.onRecolor).toHaveBeenCalledWith('3', '');
  });

  it('renders 16 swatches across two labeled rows', () => {
    renderSheet();
    const rows = document.querySelectorAll('.swatch-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelectorAll('.tab-swatch')).toHaveLength(8);
    expect(rows[1]?.querySelectorAll('.tab-swatch')).toHaveLength(8);
    const labels = screen.getAllByText(/normal|bright/);
    expect(labels.map((el) => el.textContent)).toEqual(['normal', 'bright']);
  });

  it('a legacy color name highlights its mapped ansi swatch', () => {
    // tab.color is 'teal', which resolves to ansi6 (see LEGACY_COLOR_SLOTS).
    renderSheet();
    expect(screen.getByTestId('sheet-color-ansi6').className).toMatch(/selected/);
    expect(screen.getByTestId('sheet-color-ansi4').className).not.toMatch(/selected/);
  });

  // The group rows live in a bounded SCROLLER, so they use `pressMove`: they act
  // on pointer UP, within 10px of where the finger landed. A pointerdown alone
  // must NOT activate them — that is the whole point, and the reason the drawer
  // list was once unscrollable.
  const tap = (testid: string) => {
    const el = screen.getByTestId(testid);
    const at = { pointerId: 1, clientX: 40, clientY: 40 };
    fireEvent.pointerDown(el, at);
    fireEvent.pointerUp(el, at);
  };

  it('offers group creation and each existing group to an ungrouped tab', () => {
    const p = renderSheet();

    tap('sheet-new-group');
    expect(p.onNewGroup).toHaveBeenCalledWith('3');

    tap('sheet-add-to-gaaaaa');
    expect(p.onAddToGroup).toHaveBeenCalledWith('3', 'gaaaaa');
    expect(screen.getByTestId('sheet-add-to-gbbbbb')).toHaveTextContent('Add to group');
  });

  it('offers removal and excludes the current group for a grouped tab', () => {
    const p = renderSheet({ ...TAB, groupId: 'gaaaaa' });

    expect(screen.queryByTestId('sheet-add-to-gaaaaa')).toBeNull();
    tap('sheet-remove-from-group');
    expect(p.onRemoveFromGroup).toHaveBeenCalledWith('3');
  });

  it('Close tab dismisses then routes to onCloseTab', () => {
    const p = renderSheet();
    fireEvent.pointerDown(screen.getByTestId('sheet-close-tab'));
    expect(p.onDismiss).toHaveBeenCalled();
    expect(p.onCloseTab).toHaveBeenCalledWith('3');
  });

  it('scrim tap dismisses without side effects', () => {
    const p = renderSheet();
    fireEvent.pointerDown(screen.getByTestId('sheet-scrim'));
    expect(p.onDismiss).toHaveBeenCalled();
    expect(p.onRename).not.toHaveBeenCalled();
    expect(p.onCloseTab).not.toHaveBeenCalled();
  });
});

// A control inside a scroller that fires on pointerdown makes the list
// unscrollable AND picks whatever the finger happened to land on. That bug has
// shipped here once already, in the drawer's tmux list.
describe('TabSheet group rows are scroll-safe', () => {
  it('does not act on pointerdown alone', () => {
    const p = renderSheet();
    fireEvent.pointerDown(screen.getByTestId('sheet-new-group'), {
      pointerId: 1,
      clientX: 40,
      clientY: 40,
    });
    expect(p.onNewGroup).not.toHaveBeenCalled();
  });

  it('does not act when the finger scrolled past the slop', () => {
    const p = renderSheet();
    const row = screen.getByTestId('sheet-add-to-gaaaaa');
    fireEvent.pointerDown(row, { pointerId: 1, clientX: 40, clientY: 200 });
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 40, clientY: 150 });
    fireEvent.pointerUp(row, { pointerId: 1, clientX: 40, clientY: 150 });
    expect(p.onAddToGroup).not.toHaveBeenCalled();
  });

  // A touch pointerdown must be left alone or the browser's pan is cancelled.
  it('never preventDefaults a touch pointerdown', () => {
    renderSheet();
    const ev = createEvent.pointerDown(screen.getByTestId('sheet-new-group'), {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 40,
      clientY: 40,
    });
    fireEvent(screen.getByTestId('sheet-new-group'), ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});
