// Mobile tab sheet: rename via Done/Enter, palette recolor, close-tab routing.

import { act, createEvent, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TabGroup, TabMeta } from '@palmux/shared';
import { TabSheet } from './TabSheet';
import { Icon } from '../ui/icons';

const TAB: TabMeta = { id: '3', kind: 'web', url: 'https://sb.local', name: 'SB', color: 'teal' };
const GROUPS: TabGroup[] = [
  { id: 'gaaaaa', name: 'dev', color: 'ansi2' },
  { id: 'gbbbbb', color: 'ansi4' },
];

/** The drawn shapes of a registered icon, to compare against what a control
 *  rendered. Rendered into a detached node so `screen` never sees it. */
const iconPaths = (name: string): string | undefined => {
  const host = document.createElement('div');
  render(<Icon name={name} />, { container: host });
  return host.querySelector('svg')?.innerHTML;
};

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
  it('draws the kind and the close action as icons next to their text', () => {
    renderSheet();
    const title = document.querySelector('.sheet-title');
    expect(title?.querySelectorAll('svg')).toHaveLength(1);
    expect(title?.querySelector('svg')?.innerHTML).toBe(iconPaths('globe')); // TAB is a web tab
    expect(title).toHaveTextContent(/^SB$/);
    const close = screen.getByTestId('sheet-close-tab');
    expect(close.querySelectorAll('svg')).toHaveLength(1);
    expect(close.querySelector('svg')?.innerHTML).toBe(iconPaths('close'));
    expect(close).toHaveTextContent(/^Close tab$/);
  });

  it('draws the kind of the tab it was opened for', () => {
    renderSheet({ id: '4', kind: 'markdown', url: '/docs/a.md' });
    expect(document.querySelector('.sheet-title svg')?.innerHTML).toBe(iconPaths('book'));
  });

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

// Done, Close tab and ∅ are fixed buttons: a pointer acts on pointerdown, with
// the default prevented, which keeps #mobile-kbd focused. They are focusable
// buttons too, so Enter, Space and a click with no pointer press behind it
// (assistive tech, `element.click()`) reach them as well, and a pointer press's
// own trailing click is not a second activation.
describe('TabSheet buttons as buttons', () => {
  // A mark armed by one test's press must not swallow the next test's first click.
  afterEach(() => void fireEvent.keyDown(document));

  type Props = ReturnType<typeof renderSheet>;
  const BUTTONS = [
    ['sheet-done', (p: Props) => p.onDismiss],
    ['sheet-close-tab', (p: Props) => p.onCloseTab],
    ['sheet-color-none', (p: Props) => p.onRecolor],
  ] as const;

  it.each(BUTTONS)('%s acts once on Enter', async (id, spy) => {
    const p = renderSheet();
    screen.getByTestId(id).focus();
    await userEvent.setup().keyboard('{Enter}');
    expect(spy(p)).toHaveBeenCalledTimes(1);
  });

  it.each(BUTTONS)('%s acts once on Space', async (id, spy) => {
    const p = renderSheet();
    screen.getByTestId(id).focus();
    await userEvent.setup().keyboard(' ');
    expect(spy(p)).toHaveBeenCalledTimes(1);
  });

  it.each(BUTTONS)('%s acts once on a click with no pointer press before it', (id, spy) => {
    const p = renderSheet();
    act(() => screen.getByTestId(id).click());
    expect(spy(p)).toHaveBeenCalledTimes(1);
  });

  it.each(BUTTONS)('%s acts once for a pointer press: down, up, then its click', (id, spy) => {
    const p = renderSheet();
    const button = screen.getByTestId(id);
    const touch = { pointerId: 1, pointerType: 'touch' };
    expect(fireEvent.pointerDown(button, touch)).toBe(false); // prevented: #mobile-kbd keeps focus
    expect(spy(p)).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(button, touch);
    fireEvent.click(button, { detail: 1 });
    expect(spy(p)).toHaveBeenCalledTimes(1);
  });
});

// The sheet sits over the drawer, and dismissing it on pointerdown uncovers what
// was under the finger. The browser hit-tests the rest of the tap after the
// release, so the press's mouse events and its click land on THAT, which took
// them as a tap of its own.
describe('a sheet press’s own click, landing on what the press uncovered', () => {
  afterEach(() => void fireEvent.keyDown(document));

  const touch = { pointerId: 1, pointerType: 'touch' };
  const renderOverRow = () => {
    const under = { click: vi.fn(), mouseDown: vi.fn(), mouseUp: vi.fn() };
    const Host = () => {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button
            data-testid="under-sheet"
            onClick={under.click}
            onMouseDown={under.mouseDown}
            onMouseUp={under.mouseUp}
          >
            a drawer row
          </button>
          {open && (
            <TabSheet
              tab={TAB}
              onRename={vi.fn()}
              onRecolor={vi.fn()}
              onCloseTab={vi.fn()}
              onDismiss={() => setOpen(false)}
            />
          )}
        </>
      );
    };
    render(<Host />);
    return under;
  };

  it.each(['sheet-scrim', 'sheet-done', 'sheet-close-tab'])(
    '%s dismisses, and the rest of its tap reaches nothing under it',
    (id) => {
      const under = renderOverRow();
      fireEvent.pointerDown(screen.getByTestId(id), touch);
      expect(screen.queryByTestId('tab-sheet')).toBeNull();
      const row = screen.getByTestId('under-sheet');
      fireEvent.pointerUp(row, touch);
      fireEvent.mouseDown(row, { detail: 1 });
      fireEvent.mouseUp(row, { detail: 1 });
      fireEvent.click(row, { detail: 1 });
      expect(under.mouseDown).not.toHaveBeenCalled();
      expect(under.mouseUp).not.toHaveBeenCalled();
      expect(under.click).not.toHaveBeenCalled();
    },
  );

  it('a later, separate tap on what was under it reaches it', () => {
    const under = renderOverRow();
    fireEvent.pointerDown(screen.getByTestId('sheet-scrim'), touch);
    const row = screen.getByTestId('under-sheet');
    fireEvent.pointerUp(row, touch);
    fireEvent.pointerDown(row, { pointerId: 2, pointerType: 'touch' });
    fireEvent.pointerUp(row, { pointerId: 2, pointerType: 'touch' });
    fireEvent.click(row, { detail: 1 });
    expect(under.click).toHaveBeenCalledTimes(1);
  });
});

// The group rows are `pressMove` controls: they act on the pointer going UP and
// take every click that REACHES them, so the click a real press ends with must be
// the one that does not act. It stays away only because the press marked its
// gesture, so each pointer route below would run twice without the mark.
describe('TabSheet group rows by every route', () => {
  afterEach(() => void fireEvent.keyDown(document));

  type Props = ReturnType<typeof renderSheet>;
  const ROWS = [
    ['sheet-new-group', TAB, (p: Props) => p.onNewGroup],
    ['sheet-add-to-gaaaaa', TAB, (p: Props) => p.onAddToGroup],
    ['sheet-remove-from-group', { ...TAB, groupId: 'gaaaaa' }, (p: Props) => p.onRemoveFromGroup],
  ] as const;

  const touch = { pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 40 };
  const mouse = { pointerId: 1, pointerType: 'mouse', clientX: 40, clientY: 40 };
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

  describe.each(ROWS)('%s', (id, tab, spy) => {
    it.each(ROUTES)('acts once on %s, and dismisses once', async (_, route) => {
      const p = renderSheet(tab);
      await route(screen.getByTestId(id));
      expect(spy(p)).toHaveBeenCalledTimes(1);
      expect(p.onDismiss).toHaveBeenCalledTimes(1);
    });

    // A mouse cannot pan, so a drag released on the row still ends in a click on it.
    it('acts on nothing for a mouse drag released on it, nor for the click that ends it', () => {
      const p = renderSheet(tab);
      const row = screen.getByTestId(id);
      fireEvent.pointerDown(row, mouse);
      fireEvent.pointerMove(row, { ...mouse, clientX: 100 });
      fireEvent.pointerUp(row, { ...mouse, clientX: 100 });
      fireEvent.click(row, { detail: 1 });
      expect(spy(p)).not.toHaveBeenCalled();
      expect(p.onDismiss).not.toHaveBeenCalled();
    });
  });
});

// Choosing a group row dismisses the sheet, and the dismissal uncovers the drawer
// row that was under the finger. The rest of the tap lands on THAT.
describe('a group row press’s own click, landing on what the dismissal uncovered', () => {
  afterEach(() => void fireEvent.keyDown(document));

  const touch = { pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 40 };
  const renderOverRow = () => {
    const under = { click: vi.fn(), mouseDown: vi.fn(), mouseUp: vi.fn() };
    const Host = () => {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button
            data-testid="under-sheet"
            onClick={under.click}
            onMouseDown={under.mouseDown}
            onMouseUp={under.mouseUp}
          >
            a drawer row
          </button>
          {open && (
            <TabSheet
              tab={TAB}
              onRename={vi.fn()}
              onRecolor={vi.fn()}
              groups={GROUPS}
              onNewGroup={vi.fn()}
              onAddToGroup={vi.fn()}
              onCloseTab={vi.fn()}
              onDismiss={() => setOpen(false)}
            />
          )}
        </>
      );
    };
    render(<Host />);
    return under;
  };

  it.each(['sheet-new-group', 'sheet-add-to-gaaaaa'])(
    '%s dismisses on release, and the rest of its tap reaches nothing under it',
    (id) => {
      const under = renderOverRow();
      fireEvent.pointerDown(screen.getByTestId(id), touch);
      fireEvent.pointerUp(screen.getByTestId(id), touch);
      expect(screen.queryByTestId('tab-sheet')).toBeNull();
      const row = screen.getByTestId('under-sheet');
      fireEvent.mouseDown(row, { detail: 1 });
      fireEvent.mouseUp(row, { detail: 1 });
      fireEvent.click(row, { detail: 1 });
      expect(under.mouseDown).not.toHaveBeenCalled();
      expect(under.mouseUp).not.toHaveBeenCalled();
      expect(under.click).not.toHaveBeenCalled();

      // A later, separate tap is the user's own.
      fireEvent.pointerDown(row, { pointerId: 2, pointerType: 'touch' });
      fireEvent.pointerUp(row, { pointerId: 2, pointerType: 'touch' });
      fireEvent.click(row, { detail: 1 });
      expect(under.click).toHaveBeenCalledTimes(1);
    },
  );

  // The scrim acts as the finger lands, so a long hold puts the release, and the
  // click behind it, far past any window measured from the press.
  it('the scrim still swallows the click of a press held for five seconds', () => {
    vi.useFakeTimers();
    try {
      const under = renderOverRow();
      fireEvent.pointerDown(screen.getByTestId('sheet-scrim'), touch);
      expect(screen.queryByTestId('tab-sheet')).toBeNull();
      act(() => void vi.advanceTimersByTime(5_000));
      const row = screen.getByTestId('under-sheet');
      fireEvent.pointerUp(row, touch);
      fireEvent.mouseDown(row, { detail: 1 });
      fireEvent.mouseUp(row, { detail: 1 });
      fireEvent.click(row, { detail: 1 });
      expect(under.mouseDown).not.toHaveBeenCalled();
      expect(under.mouseUp).not.toHaveBeenCalled();
      expect(under.click).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
