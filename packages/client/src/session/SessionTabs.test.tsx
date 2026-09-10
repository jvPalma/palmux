// Chrome tab strip behavior: kind icons + title precedence, switch vs close
// semantics (active click is a no-op, ✕ closes), inline rename commit/cancel,
// context-menu recolor, and the dirty dot.

import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TabGroup, TabMeta } from '@palmux/shared';
import { GROUP_DND_TYPE, SessionTabs, TAB_DND_TYPE, type TabGrouping } from './SessionTabs';

const TABS: TabMeta[] = [
  { id: '0', kind: 'terminal', title: 'vim' },
  { id: '1', kind: 'web', url: 'https://sb.example.com', color: 'peach' },
  { id: '2', kind: 'editor', name: 'ideas' },
];

const noop = () => {};

const renderTabs = (over: Partial<Parameters<typeof SessionTabs>[0]> = {}) => {
  const props = {
    tabs: TABS,
    current: '0',
    dirty: {} as { [id: string]: boolean },
    onSwitch: vi.fn(),
    onNewTab: vi.fn(),
    onClose: vi.fn(),
    onRename: vi.fn(),
    onRecolor: vi.fn(),
  };
  render(<SessionTabs {...props} {...over} />);
  return props;
};

describe('rendering', () => {
  it('shows kind icon and title with name > OSC title > default precedence', () => {
    renderTabs();
    expect(screen.getByTestId('session-tab-0')).toHaveTextContent('vim');
    expect(screen.getByTestId('session-tab-1')).toHaveTextContent('sb.example.com');
    expect(screen.getByTestId('session-tab-2')).toHaveTextContent('ideas');
    expect(screen.getByTestId('session-tab-0')).toHaveTextContent('❯');
    expect(screen.getByTestId('session-tab-1')).toHaveTextContent('🌐');
  });

  it('marks the active tab and sets the accent var on a colored tab only', () => {
    renderTabs();
    expect(screen.getByTestId('session-tab-0').className).toContain('active');
    // A colored tab gets --tab-accent inline; an uncolored one falls back to the
    // CSS default (no inline var).
    expect(screen.getByTestId('session-tab-1').style.getPropertyValue('--tab-accent')).toBe(
      'var(--tab-c-ansi9)',
    );
    expect(screen.getByTestId('session-tab-0').style.getPropertyValue('--tab-accent')).toBe('');
  });

  it('a colored tab carries the theme-aware accent + ink vars (legacy name mapped)', () => {
    renderTabs(); // tab 1 = peach → ansi9 slot
    const tab = screen.getByTestId('session-tab-1').style;
    expect(tab.getPropertyValue('--tab-accent')).toBe('var(--tab-c-ansi9)');
    expect(tab.getPropertyValue('--tab-ink')).toBe('var(--tab-c-ansi9-ink)');
  });

  it('merges a not-yet-broadcast current id as a terminal tab', () => {
    renderTabs({ tabs: [], current: '5' });
    expect(screen.getByTestId('session-tab-5')).toHaveTextContent('shell');
  });
});

describe('switch / close', () => {
  it('switches on click of an inactive tab; active tab click is a no-op', () => {
    const p = renderTabs();
    // Switch fires on click (NOT pointerdown) so a drag-to-split/reorder never
    // yanks the source tab active first.
    fireEvent.pointerDown(screen.getByTestId('session-tab-1'), { button: 0 });
    expect(p.onSwitch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('session-tab-1'), { button: 0 });
    expect(p.onSwitch).toHaveBeenCalledWith('1');
    p.onSwitch.mockClear();
    fireEvent.click(screen.getByTestId('session-tab-0'), { button: 0 });
    expect(p.onSwitch).not.toHaveBeenCalled();
    expect(p.onClose).not.toHaveBeenCalled();
  });

  it('✕ closes without switching', () => {
    const p = renderTabs();
    fireEvent.pointerDown(screen.getByTestId('tab-close-1'), { button: 0 });
    expect(p.onClose).toHaveBeenCalledWith('1');
    expect(p.onSwitch).not.toHaveBeenCalled();
  });

  it('shows a dirty dot instead of ✕ for dirty tabs', () => {
    renderTabs({ dirty: { '2': true } });
    expect(screen.getByTestId('tab-close-2')).toHaveTextContent('●');
    expect(screen.getByTestId('tab-close-0')).toHaveTextContent('✕');
  });

  it('+ opens the new-tab flow', () => {
    const p = renderTabs();
    fireEvent.pointerDown(screen.getByTestId('session-new'));
    expect(p.onNewTab).toHaveBeenCalled();
  });
});

describe('fused split pairing', () => {
  // Tabs 0 and 1 are visibly adjacent → the pairing fuses into one button.
  const paired = [{ a: '0', b: '1', focusedId: '0' }];

  it('renders adjacent members as one fused button with two segments', () => {
    renderTabs({ pairings: paired });
    expect(screen.getByTestId('fused-tab-0-1')).toBeTruthy();
    expect(screen.getByTestId('fused-seg-0')).toHaveTextContent('vim');
    expect(screen.getByTestId('fused-seg-1')).toHaveTextContent('sb.example.com');
    // The fused members are not also rendered as plain tabs.
    expect(screen.queryByTestId('session-tab-0')).toBeNull();
    expect(screen.queryByTestId('session-tab-1')).toBeNull();
    // Tab 2 still renders plainly.
    expect(screen.getByTestId('session-tab-2')).toBeTruthy();
  });

  it('lights only the focused segment while a member is current', () => {
    renderTabs({ pairings: paired, current: '0' });
    expect(screen.getByTestId('fused-tab-0-1').className).toContain('active');
    expect(screen.getByTestId('fused-seg-0').className).toContain('on');
    expect(screen.getByTestId('fused-seg-1').className).not.toContain('on');
  });

  it('moves the lit segment with the focused member', () => {
    renderTabs({ pairings: [{ a: '0', b: '1', focusedId: '1' }], current: '1' });
    expect(screen.getByTestId('fused-seg-0').className).not.toContain('on');
    expect(screen.getByTestId('fused-seg-1').className).toContain('on');
  });

  it('an inactive pairing (neither member current) lights no segment', () => {
    renderTabs({ pairings: paired, current: '2' });
    expect(screen.getByTestId('fused-tab-0-1').className).not.toContain('active');
    expect(screen.getByTestId('fused-seg-0').className).not.toContain('on');
    expect(screen.getByTestId('fused-seg-1').className).not.toContain('on');
  });

  it('a segment click switches to that member (no-op on the current one)', () => {
    const p = renderTabs({ pairings: paired, current: '0' });
    fireEvent.click(screen.getByTestId('fused-seg-1'), { button: 0 });
    expect(p.onSwitch).toHaveBeenCalledWith('1');
    p.onSwitch.mockClear();
    fireEvent.click(screen.getByTestId('fused-seg-0'), { button: 0 });
    expect(p.onSwitch).not.toHaveBeenCalled();
  });

  it('does not fuse a pairing whose members are not visibly adjacent', () => {
    renderTabs({ pairings: [{ a: '0', b: '2', focusedId: '0' }] });
    expect(screen.queryByTestId('fused-tab-0-2')).toBeNull();
    expect(screen.getByTestId('session-tab-0')).toBeTruthy();
    expect(screen.getByTestId('session-tab-2')).toBeTruthy();
  });

  it('emits no split badges', () => {
    renderTabs({ pairings: paired });
    expect(screen.queryByTestId('tab-split-badge-0')).toBeNull();
    expect(screen.queryByTestId('tab-split-badge-1')).toBeNull();
  });

  const dragDt = () => {
    let data = '';
    return {
      types: [TAB_DND_TYPE],
      setData: (_t: string, v: string) => {
        data = v;
      },
      getData: () => data,
      effectAllowed: '',
      dropEffect: '',
    };
  };

  it('the fused container drags with the pairing slot-A id as payload', () => {
    const onReorder = vi.fn();
    renderTabs({ pairings: paired, onReorder });
    const t = dragDt();
    fireEvent.dragStart(screen.getByTestId('fused-tab-0-1'), { dataTransfer: t });
    expect(t.getData()).toBe('0'); // slot A id, not slot B
  });

  it('reorders in ENTRY-index space (a fused pair is one entry)', () => {
    const onReorder = vi.fn();
    renderTabs({ pairings: paired, onReorder });
    const strip = screen.getByTestId('session-tabs');
    const t = dragDt();
    // Entries: [fused(0,1) = 0, tab2 = 1]. Drag tab 2 over the fused button;
    // zero-width rect → rel after → insertion index = fused entry + 1 = 1.
    fireEvent.dragStart(screen.getByTestId('session-tab-2'), { dataTransfer: t });
    t.setData(TAB_DND_TYPE, '2');
    fireEvent.dragOver(screen.getByTestId('fused-tab-0-1'), { dataTransfer: t, clientX: 10 });
    expect(screen.getByTestId('session-tab-2').className).toContain('drop-before'); // entry 1
    fireEvent.drop(strip, { dataTransfer: t });
    expect(onReorder).toHaveBeenCalledWith('2', 1);
  });

  it('a trailing drop appends past the fused entry (index = entry count)', () => {
    const onReorder = vi.fn();
    renderTabs({ pairings: paired, onReorder });
    const strip = screen.getByTestId('session-tabs');
    const t = dragDt();
    fireEvent.dragStart(screen.getByTestId('fused-tab-0-1'), { dataTransfer: t });
    t.setData(TAB_DND_TYPE, '0');
    fireEvent.dragOver(strip, { dataTransfer: t }); // trailing area
    expect(screen.getByTestId('session-tab-2').className).toContain('drop-after'); // last entry
    fireEvent.drop(strip, { dataTransfer: t });
    expect(onReorder).toHaveBeenCalledWith('0', 2); // 2 entries total
  });
});

describe('inline rename', () => {
  it('double-click → type → Enter commits the trimmed name', () => {
    const p = renderTabs();
    fireEvent.doubleClick(screen.getByTestId('session-tab-0'));
    const input = screen.getByTestId('tab-rename-input');
    fireEvent.change(input, { target: { value: '  build ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.onRename).toHaveBeenCalledWith('0', 'build');
  });

  it('Escape cancels without sending anything', () => {
    const p = renderTabs();
    fireEvent.doubleClick(screen.getByTestId('session-tab-0'));
    const input = screen.getByTestId('tab-rename-input');
    fireEvent.change(input, { target: { value: 'nope' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(p.onRename).not.toHaveBeenCalled();
    expect(screen.queryByTestId('tab-rename-input')).toBeNull();
  });

  it('committing an empty value clears the custom name', () => {
    const p = renderTabs();
    fireEvent.doubleClick(screen.getByTestId('session-tab-2'));
    const input = screen.getByTestId('tab-rename-input');
    expect((input as HTMLInputElement).value).toBe('ideas'); // pre-filled with the custom name
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.onRename).toHaveBeenCalledWith('2', '');
  });
});

describe('context menu', () => {
  it('right-click → swatch sends the ansi slot name; ∅ clears it', () => {
    const p = renderTabs();
    fireEvent.contextMenu(screen.getByTestId('session-tab-1'));
    fireEvent.click(screen.getByTestId('menu-color-ansi2'));
    expect(p.onRecolor).toHaveBeenCalledWith('1', 'ansi2');
    expect(screen.queryByTestId('tab-menu')).toBeNull(); // menu closed

    fireEvent.contextMenu(screen.getByTestId('session-tab-1'));
    fireEvent.click(screen.getByTestId('menu-color-none'));
    expect(p.onRecolor).toHaveBeenCalledWith('1', '');
  });

  it('offers all sixteen ansi swatches (two labeled rows) + clear', () => {
    renderTabs();
    fireEvent.contextMenu(screen.getByTestId('session-tab-1'));
    for (let n = 0; n < 16; n += 1) {
      expect(screen.getByTestId(`menu-color-ansi${n}`)).toBeTruthy();
    }
    expect(screen.getByTestId('menu-color-none')).toBeTruthy();
    fireEvent.click(screen.getByTestId('menu-color-ansi14'));
    expect(screen.queryByTestId('tab-menu')).toBeNull();
  });

  it('highlights the mapped slot for a LEGACY-colored tab', () => {
    renderTabs(); // tab 1 = peach → ansi9
    fireEvent.contextMenu(screen.getByTestId('session-tab-1'));
    expect(screen.getByTestId('menu-color-ansi9').className).toContain('selected');
    expect(screen.getByTestId('menu-color-ansi2').className).not.toContain('selected');
  });

  it('menu Close routes to onClose', () => {
    const p = renderTabs();
    fireEvent.contextMenu(screen.getByTestId('session-tab-2'));
    fireEvent.click(screen.getByTestId('menu-close'));
    expect(p.onClose).toHaveBeenCalledWith('2');
  });

  it('menu Rename opens the inline input', () => {
    renderTabs({ onRename: noop as never });
    fireEvent.contextMenu(screen.getByTestId('session-tab-0'));
    fireEvent.click(screen.getByTestId('menu-rename'));
    expect(screen.getByTestId('tab-rename-input')).toBeTruthy();
  });
});

describe('strip order + drag-to-reorder', () => {
  const outOfOrder: TabMeta[] = [
    { id: '2', kind: 'terminal' },
    { id: '0', kind: 'terminal' },
    { id: '1', kind: 'terminal' },
  ];

  it('renders the broadcast order verbatim (no numeric sorting)', () => {
    renderTabs({ tabs: outOfOrder, current: '2' });
    const rendered = [...document.querySelectorAll('[data-testid^="session-tab-"]')].map((e) =>
      (e as HTMLElement).dataset['testid']!.replace('session-tab-', ''),
    );
    expect(rendered).toEqual(['2', '0', '1']);
  });

  it('appends a not-yet-broadcast current id instead of sort-inserting it', () => {
    renderTabs({ tabs: outOfOrder, current: '1', ...{} });
    // current in list: unchanged
    let rendered = [...document.querySelectorAll('[data-testid^="session-tab-"]')].map((e) =>
      (e as HTMLElement).dataset['testid']!.replace('session-tab-', ''),
    );
    expect(rendered).toEqual(['2', '0', '1']);
  });

  it('appends an unbroadcast current at the END', () => {
    renderTabs({ tabs: outOfOrder, current: '5' });
    const rendered = [...document.querySelectorAll('[data-testid^="session-tab-"]')].map((e) =>
      (e as HTMLElement).dataset['testid']!.replace('session-tab-', ''),
    );
    expect(rendered).toEqual(['2', '0', '1', '5']);
  });

  const dragDt = () => {
    let data = '';
    return {
      types: [TAB_DND_TYPE],
      setData: (_t: string, v: string) => {
        data = v;
      },
      getData: () => data,
      effectAllowed: '',
      dropEffect: '',
    };
  };

  it('dragover a tab marks the insertion point and drop fires onReorder', () => {
    const onReorder = vi.fn();
    renderTabs({ onReorder });
    const strip = screen.getByTestId('session-tabs');
    const tab1 = screen.getByTestId('session-tab-1');
    // happy-dom rects are all zeros → midpoint 0 → clientX 10 lands AFTER tab
    // index 1 → insertion index 2.
    const t = dragDt();
    fireEvent.dragStart(screen.getByTestId('session-tab-2'), { dataTransfer: t });
    t.setData(TAB_DND_TYPE, '2');
    fireEvent.dragOver(tab1, { dataTransfer: t, clientX: 10 });
    expect(tab1.className).not.toContain('drop-before'); // marker is on index 2
    expect(screen.getByTestId('session-tab-2').className).toContain('drop-before');
    fireEvent.drop(strip, { dataTransfer: t });
    expect(onReorder).toHaveBeenCalledWith('2', 2);
  });

  it('dragover the trailing strip area appends (index = length)', () => {
    const onReorder = vi.fn();
    renderTabs({ onReorder });
    const strip = screen.getByTestId('session-tabs');
    const t = dragDt();
    fireEvent.dragStart(screen.getByTestId('session-tab-0'), { dataTransfer: t });
    t.setData(TAB_DND_TYPE, '0');
    fireEvent.dragOver(strip, { dataTransfer: t }); // target = container, not a .ctab
    expect(screen.getByTestId('session-tab-2').className).toContain('drop-after'); // last tab
    fireEvent.drop(strip, { dataTransfer: t });
    expect(onReorder).toHaveBeenCalledWith('0', 3);
  });

  it('file drags never trigger reorder (TAB_DND_TYPE only)', () => {
    const onReorder = vi.fn();
    renderTabs({ onReorder });
    const strip = screen.getByTestId('session-tabs');
    fireEvent.drop(strip, { dataTransfer: { types: ['Files'], getData: () => '' } });
    expect(onReorder).not.toHaveBeenCalled();
  });
});

describe('tab groups', () => {
  const GROUP_TABS: TabMeta[] = [
    { id: '0', kind: 'terminal', groupId: 'gaa111' },
    { id: '1', kind: 'terminal', groupId: 'gaa111', color: 'blue' },
    { id: '2', kind: 'terminal' },
  ];
  const GROUPS: TabGroup[] = [{ id: 'gaa111', color: 'green', name: 'proj' }];

  const renderGroups = (over: Partial<TabGrouping> = {}) => {
    const grouping = {
      groups: GROUPS,
      collapsed: new Set<string>(),
      onToggleGroup: vi.fn(),
      onNewGroup: vi.fn(),
      onAddToGroup: vi.fn(),
      onRemoveFromGroup: vi.fn(),
      onGroupRename: vi.fn(),
      onGroupRecolor: vi.fn(),
      onGroupDissolve: vi.fn(),
      onGroupCloseAll: vi.fn(),
      onMoveGroup: vi.fn(),
      ...over,
    };
    const props = {
      tabs: GROUP_TABS,
      current: '2',
      dirty: {} as { [id: string]: boolean },
      onSwitch: vi.fn(),
      onNewTab: vi.fn(),
      onClose: vi.fn(),
      onRename: vi.fn(),
      onRecolor: vi.fn(),
      onReorder: vi.fn(),
    };
    render(<SessionTabs {...props} grouping={grouping} />);
    return { ...props, ...grouping };
  };

  const order = () =>
    [
      ...document.querySelectorAll('[data-testid^="group-chip-"],[data-testid^="session-tab-"]'),
    ].map((e) => (e as HTMLElement).dataset['testid']!);

  it('renders a chip before the group first member; ungrouped tabs interleave', () => {
    renderGroups();
    expect(order()).toEqual([
      'group-chip-gaa111',
      'session-tab-0',
      'session-tab-1',
      'session-tab-2',
    ]);
    expect(screen.getByTestId('group-chip-gaa111')).toHaveTextContent('proj');
  });

  it('a member shows BOTH color channels (own accent + group accent)', () => {
    renderGroups();
    const member = screen.getByTestId('session-tab-1'); // color blue, group green
    expect(member.className).toContain('grouped');
    expect(member.style.getPropertyValue('--tab-accent')).toBe('var(--tab-c-ansi4)');
    expect(member.style.getPropertyValue('--group-accent')).toBe('var(--tab-c-ansi2)');
  });

  it('lights the chip (member-active) when the active tab is one of its members', () => {
    renderGroups({}); // current '2' is ungrouped
    expect(screen.getByTestId('group-chip-gaa111').className).not.toContain('member-active');
  });

  it('marks the chip member-active while a member is the active tab', () => {
    // current '0' is a member of gaa111.
    const grouping = {
      groups: GROUPS,
      collapsed: new Set<string>(),
      onToggleGroup: vi.fn(),
    };
    render(
      <SessionTabs
        tabs={GROUP_TABS}
        current="0"
        dirty={{}}
        onSwitch={vi.fn()}
        onNewTab={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onRecolor={vi.fn()}
        grouping={grouping}
      />,
    );
    expect(screen.getByTestId('group-chip-gaa111').className).toContain('member-active');
  });

  it('a collapsed group hides its members and shows a count (chip stays)', () => {
    renderGroups({ collapsed: new Set(['gaa111']) });
    expect(order()).toEqual(['group-chip-gaa111', 'session-tab-2']);
    expect(screen.getByTestId('group-count-gaa111')).toHaveTextContent('2');
  });

  it('clicking a chip toggles its collapse', () => {
    const p = renderGroups();
    fireEvent.click(screen.getByTestId('group-chip-gaa111'));
    expect(p.onToggleGroup).toHaveBeenCalledWith('gaa111');
  });

  it('the group menu ungroups, closes-all, and recolors', () => {
    const p = renderGroups();
    fireEvent.contextMenu(screen.getByTestId('group-chip-gaa111'));
    fireEvent.click(screen.getByTestId('group-color-ansi1'));
    expect(p.onGroupRecolor).toHaveBeenCalledWith('gaa111', 'ansi1');

    fireEvent.contextMenu(screen.getByTestId('group-chip-gaa111'));
    fireEvent.click(screen.getByTestId('group-menu-ungroup'));
    expect(p.onGroupDissolve).toHaveBeenCalledWith('gaa111');

    fireEvent.contextMenu(screen.getByTestId('group-chip-gaa111'));
    fireEvent.click(screen.getByTestId('group-menu-close-all'));
    expect(p.onGroupCloseAll).toHaveBeenCalledWith('gaa111');
  });

  it('the group menu renames inline', () => {
    const p = renderGroups();
    fireEvent.contextMenu(screen.getByTestId('group-chip-gaa111'));
    fireEvent.click(screen.getByTestId('group-menu-rename'));
    const input = screen.getByTestId('group-rename-input');
    fireEvent.change(input, { target: { value: '  build ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.onGroupRename).toHaveBeenCalledWith('gaa111', 'build');
  });

  it('the tab menu offers group creation + add-to for a non-member', () => {
    const p = renderGroups();
    fireEvent.contextMenu(screen.getByTestId('session-tab-2'));
    fireEvent.click(screen.getByTestId('menu-new-group'));
    expect(p.onNewGroup).toHaveBeenCalledWith('2');

    fireEvent.contextMenu(screen.getByTestId('session-tab-2'));
    fireEvent.click(screen.getByTestId('menu-add-to-gaa111'));
    expect(p.onAddToGroup).toHaveBeenCalledWith('2', 'gaa111');
  });

  it('a member gets Remove-from-group and no add-to-its-own-group entry', () => {
    const p = renderGroups();
    fireEvent.contextMenu(screen.getByTestId('session-tab-0'));
    expect(screen.queryByTestId('menu-add-to-gaa111')).toBeNull(); // already in it
    fireEvent.click(screen.getByTestId('menu-remove-from-group'));
    expect(p.onRemoveFromGroup).toHaveBeenCalledWith('0');
  });

  const dt = (type: string) => {
    let data = '';
    return {
      types: [type],
      setData: (_t: string, v: string) => {
        data = v;
      },
      getData: () => data,
      effectAllowed: '',
      dropEffect: '',
    };
  };

  it('a center-drop on a member reports the join gid to onReorder', () => {
    const p = renderGroups();
    const strip = screen.getByTestId('session-tabs');
    const tab0 = screen.getByTestId('session-tab-0');
    // happy-dom omits clientX on DragEvent, so build the event by hand (clientX
    // set on the native event; React reads it through) with a 100px-wide rect.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      width: 100,
      right: 100,
      top: 0,
      bottom: 30,
      height: 30,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const t = dt(TAB_DND_TYPE);
    fireEvent.dragStart(screen.getByTestId('session-tab-2'), { dataTransfer: t });
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    Object.assign(over, { dataTransfer: t, clientX: 50 }); // dead center → join
    fireEvent(tab0, over);
    fireEvent.drop(strip, { dataTransfer: t });
    expect(p.onReorder).toHaveBeenCalledWith('2', 0, 'gaa111');
  });

  it('a plain (edge) tab drop reports NO join gid', () => {
    const p = renderGroups();
    const strip = screen.getByTestId('session-tabs');
    const t = dt(TAB_DND_TYPE);
    fireEvent.dragStart(screen.getByTestId('session-tab-0'), { dataTransfer: t });
    fireEvent.dragOver(strip, { dataTransfer: t }); // trailing area → append
    fireEvent.drop(strip, { dataTransfer: t });
    expect(p.onReorder).toHaveBeenCalledWith('0', 3); // 2-arg: plain reorder
  });

  it('a tab dragged over a chip drops at the group block edge (not a stale index)', () => {
    const p = renderGroups();
    const strip = screen.getByTestId('session-tabs');
    const t = dt(TAB_DND_TYPE);
    fireEvent.dragStart(screen.getByTestId('session-tab-2'), { dataTransfer: t });
    fireEvent.dragOver(screen.getByTestId('group-chip-gaa111'), { dataTransfer: t }); // chip = block edge
    fireEvent.drop(strip, { dataTransfer: t });
    // Chip sits before the first member (visible index 0) → insertion index 0.
    expect(p.onReorder).toHaveBeenCalledWith('2', 0);
  });

  it('a chip block drag moves the whole group (its own payload, not a tab drop)', () => {
    const p = renderGroups();
    const strip = screen.getByTestId('session-tabs');
    const t = dt(GROUP_DND_TYPE);
    fireEvent.dragStart(screen.getByTestId('group-chip-gaa111'), { dataTransfer: t });
    fireEvent.dragOver(screen.getByTestId('session-tab-2'), { dataTransfer: t, clientX: 10 });
    fireEvent.drop(strip, { dataTransfer: t });
    expect(p.onMoveGroup).toHaveBeenCalledWith('gaa111', expect.any(Number));
    expect(p.onReorder).not.toHaveBeenCalled(); // group payload never routes to reorder
  });
});

describe('not-yet-broadcast pairing member (newborn self-split)', () => {
  it('inserts the ghost current next to its partner so the pair fuses immediately', () => {
    // current '9' is not in TABS but pairs with '0' (slot a='0', b='9') — the
    // ghost must slot in right after '0', rendering ONE fused entry, not a
    // trailing plain tab.
    renderTabs({
      current: '9',
      pairings: [{ a: '0', b: '9', focusedId: '9' }],
    });
    expect(screen.getByTestId('fused-tab-0-9')).toBeInTheDocument();
    expect(screen.queryByTestId('session-tab-9')).toBeNull();
    expect(screen.getByTestId('fused-seg-9').className).toContain('on');
  });
});

describe('fused segment rename', () => {
  const fusedProps = { pairings: [{ a: '0', b: '1', focusedId: '0' }] };

  it('double-click on a segment opens the inline rename and Enter commits', () => {
    const p = renderTabs(fusedProps);
    fireEvent.doubleClick(screen.getByTestId('fused-seg-1'));
    const input = screen.getByTestId('tab-rename-input');
    fireEvent.change(input, { target: { value: ' logs ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.onRename).toHaveBeenCalledWith('1', 'logs');
  });

  it('menu Rename on a segment shows the input inside that segment', () => {
    renderTabs(fusedProps);
    fireEvent.contextMenu(screen.getByTestId('fused-seg-0'));
    fireEvent.click(screen.getByTestId('menu-rename'));
    const input = screen.getByTestId('tab-rename-input');
    expect(screen.getByTestId('fused-seg-0')).toContainElement(input);
  });

  it('clicking the rename input never switches tabs', () => {
    const p = renderTabs({ ...fusedProps, current: '0' });
    fireEvent.doubleClick(screen.getByTestId('fused-seg-1'));
    fireEvent.click(screen.getByTestId('tab-rename-input'));
    expect(p.onSwitch).not.toHaveBeenCalled();
  });
});

// ── Middle-click closes, like every browser ───────────────────────────────────
//
// Reported as "scrollwheel-middle-click on a tab does absolutely nothing". The
// action lives on `auxclick`, but the pointerdown guard is load-bearing too:
// Chrome starts its autoscroll on middle-mousedown, and preventing it at
// auxclick time is already too late.
describe('middle-click', () => {
  // testing-library has no fireEvent.auxClick in this version; React listens for
  // the native `auxclick`, so dispatch it directly.
  const aux = (el: HTMLElement, button: number) =>
    fireEvent(el, new MouseEvent('auxclick', { button, bubbles: true, cancelable: true }));

  it('closes a plain tab', () => {
    const p = renderTabs();
    aux(screen.getByTestId('session-tab-1'), 1);
    expect(p.onClose).toHaveBeenCalledWith('1');
  });

  it('closes the tab under the pointer, including the active one', () => {
    const p = renderTabs({ current: '0' });
    aux(screen.getByTestId('session-tab-0'), 1);
    expect(p.onClose).toHaveBeenCalledWith('0');
    expect(p.onSwitch).not.toHaveBeenCalled();
  });

  it('closes ONE member of a fused pairing, not the pair', () => {
    const p = renderTabs({ pairings: [{ a: '0', b: '1', focusedId: '0' }], current: '0' });
    aux(screen.getByTestId('fused-seg-1'), 1);
    expect(p.onClose).toHaveBeenCalledTimes(1);
    expect(p.onClose).toHaveBeenCalledWith('1');
  });

  it('ignores the right button — that is the context menu', () => {
    const p = renderTabs();
    aux(screen.getByTestId('session-tab-1'), 2);
    expect(p.onClose).not.toHaveBeenCalled();
  });

  it('does not close while that tab is being renamed', () => {
    const p = renderTabs();
    fireEvent.doubleClick(screen.getByTestId('session-tab-1'));
    expect(screen.getByTestId('tab-rename-input')).toBeTruthy();
    aux(screen.getByTestId('session-tab-1'), 1);
    expect(p.onClose).not.toHaveBeenCalled();
  });

  it('suppresses the default on middle pointerdown so Chrome does not autoscroll', () => {
    renderTabs();
    const ev = createEvent.pointerDown(screen.getByTestId('session-tab-1'), {
      button: 1,
      pointerId: 1,
    });
    fireEvent(screen.getByTestId('session-tab-1'), ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});

// ── Chrome's bulk closes ──────────────────────────────────────────────────────
describe('close others / close to the right', () => {
  const open = (id: string) =>
    fireEvent.contextMenu(screen.getByTestId(`session-tab-${id}`), { clientX: 5, clientY: 5 });

  it('closes every other tab, in strip order', () => {
    const onCloseMany = vi.fn();
    renderTabs({ onCloseMany });
    open('1');
    fireEvent.click(screen.getByTestId('menu-close-others'));
    expect(onCloseMany).toHaveBeenCalledWith(['0', '2']);
  });

  it('closes only what follows', () => {
    const onCloseMany = vi.fn();
    renderTabs({ onCloseMany });
    open('1');
    fireEvent.click(screen.getByTestId('menu-close-right'));
    expect(onCloseMany).toHaveBeenCalledWith(['2']);
  });

  // An item that would close nothing is a promise the menu cannot keep.
  it('hides "to the right" on the last tab, and both on the only tab', () => {
    renderTabs({ onCloseMany: vi.fn() });
    open('2');
    expect(screen.queryByTestId('menu-close-right')).toBeNull();
    expect(screen.getByTestId('menu-close-others')).toBeTruthy();
    cleanup();

    renderTabs({ onCloseMany: vi.fn(), tabs: [TABS[0]!], current: '0' });
    open('0');
    expect(screen.queryByTestId('menu-close-others')).toBeNull();
    expect(screen.queryByTestId('menu-close-right')).toBeNull();
  });

  it('offers neither when the host supplies no handler', () => {
    renderTabs();
    open('1');
    expect(screen.queryByTestId('menu-close-others')).toBeNull();
    expect(screen.queryByTestId('menu-close-right')).toBeNull();
    expect(screen.getByTestId('menu-close')).toBeTruthy();
  });

  // Collapsing a group is per-device view state. Which tabs are "to the right"
  // must not depend on it, or the same menu closes different tabs on a phone.
  it('counts hidden members of a collapsed group', () => {
    const onCloseMany = vi.fn();
    const grouped: TabMeta[] = [
      { id: '0', kind: 'terminal' },
      { id: '1', kind: 'terminal', groupId: 'gaaaaa' },
      { id: '2', kind: 'terminal', groupId: 'gaaaaa' },
    ];
    renderTabs({
      onCloseMany,
      tabs: grouped,
      current: '0',
      grouping: {
        groups: [{ id: 'gaaaaa', color: 'blue' }] as TabGroup[],
        collapsed: new Set(['gaaaaa']),
      },
    });
    open('0');
    fireEvent.click(screen.getByTestId('menu-close-right'));
    expect(onCloseMany).toHaveBeenCalledWith(['1', '2']);
  });
});
