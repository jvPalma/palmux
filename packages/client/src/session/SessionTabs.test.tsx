// Tab strip behavior: kind icons (non-terminal only) + colour dots + title precedence,
// switch vs close semantics (active click is a no-op, the close button closes),
// inline rename commit/cancel, context-menu recolor, the dirty dot, and where a drag
// lands (pills, chips, the gaps between them).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { parse, type Declaration, type Rule } from 'postcss';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TabGroup, TabMeta } from '@palmux/shared';
import { GROUP_DND_TYPE, SessionTabs, TAB_DND_TYPE, type TabGrouping } from './SessionTabs';
import { Icon } from '../ui/icons';
import { TabSheet } from './TabSheet';

const TABS: TabMeta[] = [
  { id: '0', kind: 'terminal', title: 'vim' },
  { id: '1', kind: 'web', url: 'https://sb.example.com', color: 'peach' },
  { id: '2', kind: 'editor', name: 'ideas' },
];

const noop = () => {};

/** The anchor a boundary right before group `groupId` carries: the GROUP's edge,
 *  which App resolves to its first member at commit time. */
const beforeGroup = (groupId: string) => ({ groupId, edge: 'before' as const });

/** The drawn shapes of a registered icon, for comparing against what a control
 *  rendered. Rendered into a detached node so `screen` never sees it. */
const iconPaths = (name: string): string | undefined => {
  const host = document.createElement('div');
  render(<Icon name={name} />, { container: host });
  return host.querySelector('svg')?.innerHTML;
};

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
    // The kind is an icon, not a glyph character: a globe, a pencil. A terminal
    // is the default kind and carries no icon at all.
    const kindMark = (id: string) =>
      screen.getByTestId(`session-tab-${id}`).querySelector('.ctab-icon svg')?.innerHTML;
    expect(screen.getByTestId('session-tab-0').querySelector('.ctab-icon')).toBeNull();
    expect(kindMark('1')).toBe(iconPaths('globe'));
    expect(kindMark('2')).toBe(iconPaths('pencil'));
    expect(screen.getByTestId('session-tab-1').querySelector('.ctab-icon')?.textContent).toBe('');
  });

  // Colour is an identity dot before the title and nothing else: it never fills
  // the pill and never marks it as the active one.
  it('draws a colour dot only for a coloured tab, active or not', () => {
    renderTabs({ current: '2' });
    const dot = (id: string) => screen.getByTestId(`session-tab-${id}`).querySelector('.ctab-dot');
    expect(dot('1')).not.toBeNull(); // coloured (peach), inactive
    expect(dot('0')).toBeNull(); // uncoloured
    expect(dot('2')).toBeNull(); // uncoloured AND active
    // The dot leads the title, so it reads as the tab's identity.
    const title = screen.getByTestId('session-tab-1').querySelector('.ctab-title')!;
    expect(
      dot('1')!.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    cleanup();

    renderTabs({ current: '1' });
    expect(dot('1')).not.toBeNull(); // still there once the coloured tab is active
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

  // The two dots must never be confused (tab-accents): the accent leads the title
  // as a plain dot, the unsaved mark trails it inside the close button as an icon.
  it("keeps a coloured unsaved tab's accent dot apart from its dirty mark", () => {
    renderTabs({ current: '0', dirty: { '1': true } }); // tab 1 is coloured (peach)
    const pill = screen.getByTestId('session-tab-1');
    const accent = pill.querySelector('.ctab-dot')!;
    const title = pill.querySelector('.ctab-title')!;
    const dirty = screen.getByTestId('tab-close-1');
    expect(dirty.className).toContain('dirty');
    expect(dirty.contains(accent)).toBe(false);
    expect(accent.querySelector('svg')).toBeNull(); // a plain dot, not the icon
    expect(dirty.querySelector('svg')?.innerHTML).toBe(iconPaths('dot'));
    expect(accent.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(title.compareDocumentPosition(dirty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // The strip clips its overflow, so a pill the user switches to (or a restored
  // active one) is only seen if the strip scrolls to it — and only as far as it
  // takes ('nearest'), or every switch would re-centre the whole strip.
  it('scrolls the active pill into view, on mount and whenever the active tab changes', () => {
    const scrolled: Array<{ id: string | null; arg: unknown }> = [];
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (
      this: Element,
      arg?: boolean | ScrollIntoViewOptions,
    ) {
      scrolled.push({ id: this.getAttribute('data-testid'), arg });
    });
    try {
      const props = {
        tabs: TABS,
        dirty: {} as { [id: string]: boolean },
        onSwitch: vi.fn(),
        onNewTab: vi.fn(),
        onClose: vi.fn(),
        onRename: vi.fn(),
        onRecolor: vi.fn(),
      };
      const { rerender } = render(<SessionTabs {...props} current="0" />);
      expect(scrolled.map((c) => c.id)).toEqual(['session-tab-0']);
      rerender(<SessionTabs {...props} current="2" />);
      expect(scrolled.map((c) => c.id)).toEqual(['session-tab-0', 'session-tab-2']);
      const nearest = { inline: 'nearest', block: 'nearest' };
      expect(scrolled.map((c) => c.arg)).toEqual([nearest, nearest]);
    } finally {
      spy.mockRestore();
    }
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

  it('the close button closes without switching', () => {
    const p = renderTabs();
    const close = screen.getByTestId('tab-close-1');
    // Icon-only: the icon is aria-hidden, so the label is the accessible name.
    expect(close.querySelector('svg')).not.toBeNull();
    expect(close).toHaveAttribute('aria-label', 'Close tab 1');
    fireEvent.pointerDown(close, { button: 0 });
    expect(p.onClose).toHaveBeenCalledWith('1');
    expect(p.onSwitch).not.toHaveBeenCalled();
  });

  it('shows a dirty dot instead of the close mark for dirty tabs', () => {
    renderTabs({ dirty: { '2': true } });
    expect(screen.getByTestId('tab-close-2').querySelector('svg')?.innerHTML).toBe(
      iconPaths('dot'),
    );
    expect(screen.getByTestId('tab-close-0').querySelector('svg')?.innerHTML).toBe(
      iconPaths('close'),
    );
    // Both are still the close button: the dot does not cost it its name.
    expect(screen.getByTestId('tab-close-2')).toHaveAttribute('aria-label', 'Close tab 2');
  });

  it('the plus button opens the new-tab flow', () => {
    const p = renderTabs();
    const plus = screen.getByTestId('session-new');
    expect(plus.querySelector('svg')?.innerHTML).toBe(iconPaths('plus'));
    expect(plus).toHaveAttribute('aria-label', 'New tab');
    fireEvent.pointerDown(plus);
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

  // The fused segments draw their kind through the same icon as a plain tab: a
  // second render site that a plain-tab assertion would never reach.
  it('draws a non-terminal segment with its kind icon and a terminal with none', () => {
    renderTabs({ pairings: paired });
    const mark = (id: string) =>
      screen.getByTestId(`fused-seg-${id}`).querySelector('.ctab-icon svg')?.innerHTML;
    expect(screen.getByTestId('fused-seg-0').querySelector('.ctab-icon')).toBeNull();
    expect(mark('1')).toBe(iconPaths('globe'));
    expect(screen.getByTestId('fused-seg-1').querySelector('.ctab-icon')?.textContent).toBe('');
  });

  // The split glyph is what says "two tabs in one pill", so it must not depend on
  // the pairing being active — an inactive pairing used to read as two tabs.
  it('leads the pill with a split glyph whether or not the pairing is active', () => {
    for (const current of ['0', '2']) {
      renderTabs({ pairings: paired, current });
      const pill = screen.getByTestId('fused-tab-0-1');
      const glyph = screen.getByTestId('fused-glyph-0-1');
      expect(glyph.querySelector('svg')?.innerHTML).toBe(iconPaths('split'));
      // Before both segments, in the same pill: the seam sits between the two.
      expect(pill.firstElementChild).toBe(glyph);
      expect([...pill.children].map((c) => c.className.split(' ')[0])).toEqual([
        'fused-glyph',
        'fused-seg',
        'fused-seg',
      ]);
      cleanup();
    }
  });

  it('shows each segment its own colour dot, never a colour fill', () => {
    renderTabs({ tabs: [{ ...TABS[0]!, color: 'ansi1' }, TABS[1]!, TABS[2]!], pairings: paired });
    expect(screen.getByTestId('fused-seg-0').querySelector('.ctab-dot')).not.toBeNull();
    expect(screen.getByTestId('fused-seg-1').querySelector('.ctab-dot')).not.toBeNull();
    expect(screen.getByTestId('fused-seg-0').style.getPropertyValue('--tab-accent')).toBe(
      'var(--tab-c-ansi1)',
    );
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
    expect(onReorder).toHaveBeenCalledWith('2', 1, undefined, undefined, true); // a half: a boundary
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
    expect(onReorder).toHaveBeenCalledWith('0', 2, undefined, undefined, true); // 2 entries; a gap drop
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

// ── The tab menu's structure: three groups, a hairline between each ───────────
//
// EDIT (rename), LAYOUT (split, group, colour, pop out) and CLOSE — in that
// order, Close always last, with an icon leading every action. The separators
// are rendered, not drawn by a border, so the order is something a test can read.
describe('context menu structure', () => {
  const GROUPS_FOR_MENU: TabGroup[] = [{ id: 'gaa111', color: 'green', name: 'proj' }];

  const fullProps = (over: Partial<Parameters<typeof SessionTabs>[0]> = {}) => ({
    onSplit: vi.fn(),
    onPopout: vi.fn(),
    onCloseMany: vi.fn(),
    grouping: {
      groups: GROUPS_FOR_MENU,
      collapsed: new Set<string>(),
      onNewGroup: vi.fn(),
      onAddToGroup: vi.fn(),
      onRemoveFromGroup: vi.fn(),
    } satisfies TabGrouping,
    ...over,
  });

  /** What each child of the menu is: its testid, or its class for the swatch block. */
  const layout = (): string[] =>
    [...screen.getByTestId('tab-menu').children].map(
      (c) => (c as HTMLElement).dataset['testid'] ?? c.className,
    );

  const open = (id: string) => fireEvent.contextMenu(screen.getByTestId(`session-tab-${id}`));

  it('orders the items edit → layout → close, with Close always last', () => {
    renderTabs(fullProps());
    open('1'); // a middle tab outside the group, so every conditional item shows
    expect(layout()).toEqual([
      'menu-rename',
      'tab-menu-sep',
      'menu-split-right',
      'menu-split-down',
      'menu-new-group',
      'menu-add-to-gaa111',
      'tab-menu-colors',
      'menu-popout',
      'tab-menu-sep',
      'menu-close',
      'menu-close-others',
      'menu-close-right',
    ]);
  });

  it('puts Remove-from-group with the layout items, before the colours', () => {
    renderTabs({
      ...fullProps(),
      tabs: [TABS[0]!, { ...TABS[1]!, groupId: 'gaa111' }, TABS[2]!],
    });
    open('1');
    const order = layout();
    expect(order).toContain('menu-remove-from-group');
    expect(order).not.toContain('menu-add-to-gaa111'); // it is already in that group
    expect(order.indexOf('menu-remove-from-group')).toBeGreaterThan(
      order.indexOf('menu-split-down'),
    );
    expect(order.indexOf('menu-remove-from-group')).toBeLessThan(order.indexOf('tab-menu-colors'));
  });

  it('draws exactly two separators, each with an item on both sides', () => {
    renderTabs(fullProps());
    open('1');
    const seps = screen.getAllByRole('separator');
    expect(seps).toHaveLength(2);
    const order = layout();
    expect(order[0]).not.toBe('tab-menu-sep');
    expect(order.at(-1)).not.toBe('tab-menu-sep');
    // Never two in a row: that would be an empty group between them.
    expect(order.join(',')).not.toContain('tab-menu-sep,tab-menu-sep');
  });

  // A host that supplies no split / pop-out / group handlers still gets three
  // groups — rename, the swatches and Close are unconditional — so the menu never
  // collapses to one flat list or grows a separator with nothing beside it.
  it('keeps both separators when every optional item is absent', () => {
    renderTabs();
    open('1');
    expect(layout()).toEqual([
      'menu-rename',
      'tab-menu-sep',
      'tab-menu-colors',
      'tab-menu-sep',
      'menu-close',
    ]);
    expect(screen.getAllByRole('separator')).toHaveLength(2);
  });

  it('leads every action with a 16px shared icon', () => {
    renderTabs({
      ...fullProps(),
      tabs: [TABS[0]!, { ...TABS[1]!, groupId: 'gaa111' }, TABS[2]!],
    });
    open('1');
    const iconOf = (testid: string): { svg: SVGElement | null; paths: string | undefined } => {
      const item = screen.getByTestId(testid);
      const svg = item.querySelector('svg');
      return { svg, paths: svg?.innerHTML };
    };
    const expected: [string, string][] = [
      ['menu-rename', 'pencil'],
      ['menu-split-right', 'split'],
      ['menu-split-down', 'split'],
      ['menu-new-group', 'plus'],
      ['menu-remove-from-group', 'eject'],
      ['menu-popout', 'external'],
      ['menu-close', 'close'],
      ['menu-close-others', 'close'],
      ['menu-close-right', 'close'],
    ];
    for (const [testid, name] of expected) {
      const { svg, paths } = iconOf(testid);
      expect(svg?.getAttribute('width'), testid).toBe('16');
      expect(paths, testid).toBe(iconPaths(name));
      // Leading: the icon (or its wrapper) is the item's first child, ahead of the label.
      const first = screen.getByTestId(testid).firstElementChild;
      expect(first === svg || first?.contains(svg), testid).toBe(true);
    }
    // The only text glyphs left are the label itself: no emoji or arrow character.
    expect(screen.getByTestId('menu-popout').textContent).toBe('Open in new window');
  });

  it('turns the split glyph a quarter for Split down, and only there', () => {
    renderTabs(fullProps());
    open('1');
    expect(
      screen.getByTestId('menu-split-down').querySelector('.tab-menu-icon-turned'),
    ).not.toBeNull();
    expect(
      screen.getByTestId('menu-split-right').querySelector('.tab-menu-icon-turned'),
    ).toBeNull();
  });

  it('labels the group row with its colour dot as well as its icon', () => {
    renderTabs(fullProps());
    open('1');
    const row = screen.getByTestId('menu-add-to-gaa111');
    expect(row.querySelector('svg')?.innerHTML).toBe(iconPaths('plus'));
    expect(row.querySelector('.menu-group-dot')).not.toBeNull();
    expect(row).toHaveTextContent('Add to proj');
  });

  // The regrouping must not have cost an action its behaviour. Each of these used
  // to be a flat list item; they are asserted by what they CALL, not by position.
  it('routes Split right, Split down and Open in new window, closing the menu each time', () => {
    const p = fullProps();
    renderTabs(p);

    open('1');
    fireEvent.click(screen.getByTestId('menu-split-right'));
    expect(p.onSplit).toHaveBeenLastCalledWith('1', 'row');
    expect(screen.queryByTestId('tab-menu')).toBeNull();

    open('1');
    fireEvent.click(screen.getByTestId('menu-split-down'));
    expect(p.onSplit).toHaveBeenLastCalledWith('1', 'column');
    expect(screen.queryByTestId('tab-menu')).toBeNull();

    open('2');
    fireEvent.click(screen.getByTestId('menu-popout'));
    expect(p.onPopout).toHaveBeenCalledWith('2');
    expect(screen.queryByTestId('tab-menu')).toBeNull();
    expect(p.onSplit).toHaveBeenCalledTimes(2);
  });

  it('acts on the tab that was right-clicked, not the active one', () => {
    const p = fullProps();
    renderTabs({ ...p, current: '0' });
    open('2');
    fireEvent.click(screen.getByTestId('menu-split-right'));
    expect(p.onSplit).toHaveBeenCalledWith('2', 'row');
  });

  // An item that would do nothing is not rendered — including the whole of each
  // group a host does not support, with no orphaned separator left behind.
  it.each([
    ['onSplit', ['menu-split-right', 'menu-split-down']],
    ['onPopout', ['menu-popout']],
  ] as const)('does not render what %s alone would have offered', (handler, testids) => {
    renderTabs(fullProps({ [handler]: undefined }));
    open('1');
    for (const testid of testids) expect(screen.queryByTestId(testid), testid).toBeNull();
    expect(screen.getAllByRole('separator')).toHaveLength(2);
    expect(layout()[0]).toBe('menu-rename');
    expect(layout().at(-1)).toBe('menu-close-right');
  });

  // Close is last because the group is last: a bulk close that does not apply
  // simply is not there, and nothing may follow the Close group.
  it('ends on the last Close item that applies', () => {
    renderTabs(fullProps());
    open('2'); // the last tab: nothing to its right
    expect(layout().slice(-3)).toEqual(['tab-menu-sep', 'menu-close', 'menu-close-others']);
    cleanup();

    renderTabs(fullProps({ tabs: [TABS[0]!], current: '0' }));
    open('0'); // the only tab
    expect(layout().slice(-2)).toEqual(['tab-menu-sep', 'menu-close']);
    expect(screen.getAllByRole('separator')).toHaveLength(2);
  });

  it('keeps every item a real button, so the keyboard reaches it', () => {
    renderTabs(fullProps());
    open('1');
    const items = [...screen.getByTestId('tab-menu').querySelectorAll('.tab-menu-item')];
    expect(items.length).toBeGreaterThan(8);
    for (const item of items) expect(item.tagName, item.textContent ?? '').toBe('BUTTON');
    // The hairlines are decoration: not focusable, announced as separators only.
    for (const sep of screen.getAllByRole('separator')) expect(sep.tagName).toBe('DIV');
  });

  // Unchanged: an outside press or Escape dismisses it, and a press INSIDE the
  // menu — including on a separator — must not, or reaching an item would close
  // the menu under the pointer.
  it('dismisses on an outside press or Escape, and survives a press on itself', () => {
    renderTabs(fullProps());
    open('1');
    fireEvent.pointerDown(screen.getAllByRole('separator')[0]!);
    fireEvent.pointerDown(screen.getByTestId('menu-split-right'));
    expect(screen.getByTestId('tab-menu')).toBeTruthy();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('tab-menu')).toBeNull();

    open('1');
    expect(screen.getByTestId('tab-menu')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('tab-menu')).toBeNull();

    open('1');
    fireEvent.keyDown(window, { key: 'a' });
    expect(screen.getByTestId('tab-menu')).toBeTruthy();
  });

  it('opens at the pointer', () => {
    renderTabs();
    fireEvent.contextMenu(screen.getByTestId('session-tab-1'), { clientX: 41, clientY: 17 });
    const menu = screen.getByTestId('tab-menu');
    expect(menu.style.left).toBe('41px');
    expect(menu.style.top).toBe('17px');
  });

  // The group menu is a different menu: it was not regrouped and has no icons, so
  // it must not have inherited the tab menu's separators by sharing a class.
  it('leaves the group menu as it was: flat, no icons, no separators', () => {
    renderTabs({
      ...fullProps(),
      tabs: [{ ...TABS[0]!, groupId: 'gaa111' }, TABS[1]!, TABS[2]!],
    });
    fireEvent.contextMenu(screen.getByTestId('group-chip-gaa111'));
    const menu = screen.getByTestId('group-menu');
    expect(
      [...menu.children].map((c) => (c as HTMLElement).dataset['testid'] ?? c.className),
    ).toEqual([
      'group-menu-rename',
      'tab-menu-colors',
      'group-menu-ungroup',
      'group-menu-close-all',
    ]);
    expect(menu.querySelector('[role="separator"]')).toBeNull();
    for (const item of menu.querySelectorAll('.tab-menu-item')) {
      expect(item.querySelector('svg'), item.textContent ?? '').toBeNull();
    }
  });

  // The mobile long-press sheet reuses `.tab-menu-item` for its group rows. The
  // desktop sizing is scoped under `.tab-menu`, so it only reaches the sheet if
  // the sheet is ever rendered inside one — which would give a touch target the
  // 28px desktop height.
  it("never puts the mobile sheet's rows under a .tab-menu ancestor", () => {
    render(
      <TabSheet
        tab={TABS[1]!}
        groups={GROUPS_FOR_MENU}
        onRename={vi.fn()}
        onRecolor={vi.fn()}
        onNewGroup={vi.fn()}
        onAddToGroup={vi.fn()}
        onRemoveFromGroup={vi.fn()}
        onCloseTab={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const rows = document.querySelectorAll('.tab-menu-item');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.closest('.tab-menu')).toBeNull();
  });
});

// jsdom does not cascade, so the sizing is read from the stylesheet. The desktop
// menu's row is scoped under `.tab-menu` on purpose: the mobile long-press sheet
// reuses `.tab-menu-item` for its group rows and must keep its own sizing.
describe('context menu stylesheet', () => {
  const css = readFileSync(join(__dirname, '..', 'index.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const body = (selector: string): string =>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map(([, sel, decls]) => ({
        sel: (sel ?? '').replace(/\s+/g, ' ').trim(),
        decls: decls ?? '',
      }))
      .find((b) => b.sel === selector)?.decls ?? '';

  it('sizes a desktop item at the control height, with the menu scale', () => {
    const row = body('.tab-menu .tab-menu-item');
    expect(row).toMatch(/height:\s*var\(--ctl-h\)/);
    expect(row).toMatch(/display:\s*flex/);
    expect(body('.tab-menu-item')).toMatch(/font-size:\s*var\(--fs-3\)/);
    expect(body('.tab-menu-item')).toMatch(/border-radius:\s*var\(--r-2\)/);
  });

  it('leaves the sheet row unsized', () => {
    expect(body('.tab-menu-item')).not.toMatch(/(?:^|[;\s])(?:min-)?height\s*:/);
    expect(body('.tab-menu-item')).not.toMatch(/display\s*:/);
  });

  it('draws the separator as one --t-surface hairline', () => {
    const sep = body('.tab-menu-sep');
    expect(sep).toMatch(/height:\s*1px/);
    expect(sep).toMatch(/background:\s*var\(--t-surface\)/);
  });

  // The rest is read with PostCSS, which knows a media query from a rule — the
  // text match above cannot tell `.tab-menu` at rest from `.tab-menu` under
  // reduced motion.
  describe('as parsed', () => {
    const root = parse(readFileSync(join(__dirname, '..', 'index.css'), 'utf8'));

    /** What a selector declares at rest, at the top level, later declarations winning. */
    const atRest = (selector: string): Map<string, string> => {
      const out = new Map<string, string>();
      root.walkRules((rule: Rule) => {
        if (rule.parent?.type !== 'root' || !rule.selectors.includes(selector)) return;
        rule.walkDecls((d: Declaration) => void out.set(d.prop, d.value.replace(/\s+/g, ' ')));
      });
      return out;
    };

    it('is 28px on a desktop: the control height the item sizes itself from', () => {
      expect(atRest(':root').get('--ctl-h')).toBe('28px');
    });

    it('keeps the batch-1 entrance: micro tier, from the pointer corner, off under reduced motion', () => {
      const menu = atRest('.tab-menu');
      expect(menu.get('animation')).toMatch(
        /^tab-menu-in var\(--mo-micro, 140ms\) var\(--mo-ease\)/,
      );
      expect(menu.get('transform-origin')).toBe('top left');
      let keyframes = false;
      let reduced = '';
      root.walkAtRules((at) => {
        if (at.name === 'keyframes' && at.params === 'tab-menu-in') keyframes = true;
        if (at.name === 'media' && /prefers-reduced-motion:\s*reduce/.test(at.params)) {
          at.walkRules('.tab-menu', (rule) =>
            rule.walkDecls('animation', (d) => void (reduced = d.value)),
          );
        }
      });
      expect(keyframes).toBe(true);
      expect(reduced).toBe('none');
    });

    it('frames the menu on the scale: --sp-1 padding inside a --r-3 hairline-bordered box', () => {
      const menu = atRest('.tab-menu');
      expect(menu.get('padding')).toBe('var(--sp-1)');
      expect(menu.get('border-radius')).toBe('var(--r-3)');
      expect(menu.get('border')).toBe('1px solid var(--t-surface)');
      expect(menu.get('background')).toBe('var(--t-mantle)');
      // Flush items: the groups are told apart by the hairline, not by air.
      expect(menu.get('gap')).toBeUndefined();
    });

    it('spaces the row from the scale and puts the icon at the row start', () => {
      const row = atRest('.tab-menu .tab-menu-item');
      expect(row.get('gap')).toBe('var(--sp-2)');
      expect(row.get('padding')).toBe('0 var(--sp-2)');
      expect(row.get('align-items')).toBe('center');
      expect(row.get('white-space')).toBe('nowrap');
    });

    it('turns the Split down glyph with a static transform, not motion', () => {
      const turned = atRest('.tab-menu-icon-turned');
      expect(turned.get('transform')).toBe('rotate(90deg)');
      expect(turned.has('transition')).toBe(false);
      expect(turned.has('animation')).toBe(false);
    });

    it('highlights the hovered row from the surface token', () => {
      expect(atRest('.tab-menu-item:hover').get('background')).toBe('var(--t-surface)');
    });

    // Colour comes from the eight tokens. The one literal is the drop shadow,
    // which is black at 50% by design and not a theme colour.
    it('uses no colour literal outside the drop shadow', () => {
      const literals: string[] = [];
      root.walkRules((rule: Rule) => {
        if (!rule.selectors.some((sel) => sel.startsWith('.tab-menu'))) return;
        rule.walkDecls((d: Declaration) => {
          if (d.prop === 'box-shadow') return;
          if (/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(d.value)) {
            literals.push(`${rule.selector} { ${d.prop}: ${d.value} }`);
          }
        });
      });
      expect(literals).toEqual([]);
    });

    // The base rule is the sheet's, and it must stay free of anything that would
    // make a touch row 28px: that is the whole reason the desktop row is scoped.
    it('leaves the unscoped row as the sheet needs it', () => {
      const base = atRest('.tab-menu-item');
      expect([...base.keys()].filter((k) => /height|display|gap|white-space/.test(k))).toEqual([]);
    });
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
    expect(onReorder).toHaveBeenCalledWith('2', 2, undefined, undefined, true); // a half: a boundary
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
    expect(onReorder).toHaveBeenCalledWith('0', 3, undefined, undefined, true);
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
  // One test below pins getBoundingClientRect; none may leak it into the next.
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  // The cluster is the frame: one wrapper holds the chip and every visible member
  // pill, and it is presentational — nothing about it is an entry or a drop target.
  it('frames the chip and its members in one cluster, ungrouped tabs outside it', () => {
    renderGroups();
    const cluster = screen.getByTestId('group-cluster-gaa111');
    expect([...cluster.children].map((c) => (c as HTMLElement).dataset['testid'])).toEqual([
      'group-chip-gaa111',
      'session-tab-0',
      'session-tab-1',
    ]);
    expect(cluster.style.getPropertyValue('--group-accent')).toBe('var(--tab-c-ansi2)');
    expect(screen.getByTestId('session-tab-2').closest('.group-cluster')).toBeNull();
  });

  it('a collapsed cluster holds only its chip', () => {
    renderGroups({ collapsed: new Set(['gaa111']) });
    const cluster = screen.getByTestId('group-cluster-gaa111');
    expect(cluster.className).toContain('collapsed');
    expect([...cluster.children].map((c) => (c as HTMLElement).dataset['testid'])).toEqual([
      'group-chip-gaa111',
    ]);
  });

  // The chip is the group's constant identity: activating a member moves the
  // active treatment onto the member pill and leaves the chip exactly as it was.
  it('leaves the chip untouched when a member becomes the active tab', () => {
    const grouping = { groups: GROUPS, collapsed: new Set<string>(), onToggleGroup: vi.fn() };
    const props = {
      tabs: GROUP_TABS,
      dirty: {} as { [id: string]: boolean },
      onSwitch: vi.fn(),
      onNewTab: vi.fn(),
      onClose: vi.fn(),
      onRename: vi.fn(),
      onRecolor: vi.fn(),
      grouping,
    };
    const { rerender } = render(<SessionTabs {...props} current="2" />); // outside the group
    const chip = screen.getByTestId('group-chip-gaa111');
    const before = { className: chip.className, style: chip.getAttribute('style') };
    const clusterBefore = screen.getByTestId('group-cluster-gaa111').className;

    rerender(<SessionTabs {...props} current="0" />); // a member
    expect(screen.getByTestId('session-tab-0').className).toContain('active');
    expect(chip.className).toBe(before.className);
    expect(chip.getAttribute('style')).toBe(before.style);
    expect(screen.getByTestId('group-cluster-gaa111').className).toBe(clusterBefore);
    expect(chip.className).not.toContain('member-active');
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
    expect(p.onReorder).toHaveBeenCalledWith('0', 3, undefined, undefined, true); // no join gid: a boundary
  });

  it('a tab dragged over a chip drops at the group block edge (not a stale index)', () => {
    const p = renderGroups();
    const strip = screen.getByTestId('session-tabs');
    const t = dt(TAB_DND_TYPE);
    fireEvent.dragStart(screen.getByTestId('session-tab-2'), { dataTransfer: t });
    fireEvent.dragOver(screen.getByTestId('group-chip-gaa111'), { dataTransfer: t }); // chip = block edge
    fireEvent.drop(strip, { dataTransfer: t });
    // Chip sits before the first member (visible index 0) → insertion index 0,
    // anchored to the group's edge so a collapsed group cannot move it.
    expect(p.onReorder).toHaveBeenCalledWith('2', 0, undefined, beforeGroup('gaa111'), true);
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

// ── Where a drag lands ────────────────────────────────────────────────────────
//
// happy-dom has no layout, so these hand each rendered unit (plain pill, fused
// pill, group chip — the things the strip measures, in strip order) a rect, and
// drive the strip with real pointer x. A pointer over a pill/chip is that
// element's own handler; a pointer over a gap, a cluster's padding or the `+` is
// the strip's, which resolves the nearest boundary from x.
describe('where a drag lands', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** `spans` are [left, right] per unit, in strip order; other elements measure 0. */
  const layout = (spans: [number, number][]) => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        const [left, right] = spans[
          [...document.querySelectorAll('.ctab, .group-chip')].indexOf(this)
        ] ?? [0, 0];
        return {
          left,
          right,
          width: right - left,
          top: 0,
          bottom: 28,
          height: 28,
          x: left,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      },
    );
  };

  const dragData = (type: string) => {
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
  const overAt = (el: Element, dataTransfer: unknown, clientX: number) => {
    const ev = new Event('dragover', { bubbles: true, cancelable: true });
    Object.assign(ev, { dataTransfer, clientX });
    fireEvent(el, ev);
  };

  const term = (id: string, groupId?: string): TabMeta =>
    groupId ? { id, kind: 'terminal', groupId } : { id, kind: 'terminal' };
  const marked = () =>
    [...document.querySelectorAll('.drop-before, .drop-after')].map(
      (e) =>
        `${(e as HTMLElement).dataset['testid']}:${e.classList.contains('drop-before') ? 'before' : 'after'}`,
    );

  const mount = (over: Partial<Parameters<typeof SessionTabs>[0]>) => {
    const props = {
      current: '0',
      dirty: {} as { [id: string]: boolean },
      onSwitch: vi.fn(),
      onNewTab: vi.fn(),
      onClose: vi.fn(),
      onRename: vi.fn(),
      onRecolor: vi.fn(),
      onReorder: vi.fn(),
    };
    render(<SessionTabs tabs={[]} {...props} {...over} />);
    return props;
  };
  const grouping = (over: Partial<TabGrouping> = {}): TabGrouping => ({
    groups: [{ id: 'gaa111', color: 'green', name: 'one' }],
    collapsed: new Set<string>(),
    onMoveGroup: vi.fn(),
    ...over,
  });

  // Review R1. The 8px gaps and a cluster's padding are empty strip space; the
  // strip used to read ANY such target as "after the last tab", so a drop in a
  // gap appended at the end — and a grouped tab left its group doing it.
  describe('in empty strip space (R1)', () => {
    const plain = [term('0'), term('1'), term('2')];
    // pills: 0 [0,100]  1 [108,208]  2 [216,316]; the gaps are 100–108, 208–216.
    const plainSpans: [number, number][] = [
      [0, 100],
      [108, 208],
      [216, 316],
    ];

    it('a gap between two plain pills is the boundary between them', () => {
      layout(plainSpans);
      const p = mount({ tabs: plain });
      const strip = screen.getByTestId('session-tabs');
      const t = dragData(TAB_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId('session-tab-2'), { dataTransfer: t });
      t.setData(TAB_DND_TYPE, '2');
      overAt(strip, t, 104);
      expect(marked()).toEqual(['session-tab-1:before']);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(p.onReorder).toHaveBeenCalledWith('2', 1, undefined, undefined, true);
    });

    it('the second gap lands before the third pill, not at the end', () => {
      layout(plainSpans);
      const p = mount({ tabs: plain });
      const strip = screen.getByTestId('session-tabs');
      const t = dragData(TAB_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId('session-tab-0'), { dataTransfer: t });
      t.setData(TAB_DND_TYPE, '0');
      overAt(strip, t, 212);
      expect(marked()).toEqual(['session-tab-2:before']);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(p.onReorder).toHaveBeenCalledWith('0', 2, undefined, undefined, true);
    });

    it('the strip padding left of the first pill is the start, not the end', () => {
      layout(plainSpans);
      const p = mount({ tabs: plain });
      const strip = screen.getByTestId('session-tabs');
      const t = dragData(TAB_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId('session-tab-2'), { dataTransfer: t });
      t.setData(TAB_DND_TYPE, '2');
      overAt(strip, t, -4);
      expect(marked()).toEqual(['session-tab-0:before']);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(p.onReorder).toHaveBeenCalledWith('2', 0, undefined, undefined, true);
    });

    // Only a pointer right of the LAST entry's right edge is the trailing area —
    // including over the `+` that follows it.
    it('the area right of the last pill, and the + button, still append', () => {
      layout(plainSpans);
      const p = mount({ tabs: plain });
      const strip = screen.getByTestId('session-tabs');
      const t = dragData(TAB_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId('session-tab-0'), { dataTransfer: t });
      t.setData(TAB_DND_TYPE, '0');
      overAt(strip, t, 400);
      expect(marked()).toEqual(['session-tab-2:after']);
      overAt(screen.getByTestId('session-new'), t, 330);
      expect(marked()).toEqual(['session-tab-2:after']);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(p.onReorder).toHaveBeenCalledWith('0', 3, undefined, undefined, true);
    });

    it('a gap next to a fused pill counts the pair as ONE entry', () => {
      // strip: fused(0,1) [0,200]   2 [208,308]   3 [316,416]
      layout([
        [0, 200],
        [208, 308],
        [316, 416],
      ]);
      const p = mount({
        tabs: [term('0'), term('1'), term('2'), term('3')],
        current: '3',
        pairings: [{ a: '0', b: '1', focusedId: '0' }],
      });
      const strip = screen.getByTestId('session-tabs');
      const t = dragData(TAB_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId('session-tab-3'), { dataTransfer: t });
      t.setData(TAB_DND_TYPE, '3');
      overAt(strip, t, 204);
      expect(marked()).toEqual(['session-tab-2:before']); // entry 1, after the fused entry 0
      fireEvent.drop(strip, { dataTransfer: t });
      expect(p.onReorder).toHaveBeenCalledWith('3', 1, undefined, undefined, true);
    });

    // Inside an expanded cluster the gap is between its members. It must NOT be
    // the trailing area: that read as "leave the group" for a grouped tab.
    it("a gap inside a member's own cluster is the boundary between its members", () => {
      // strip: chip [10,50]  0 [58,158]  1 [166,266]  2 [274,374] | 3 [390,490]
      layout([
        [10, 50],
        [58, 158],
        [166, 266],
        [274, 374],
        [390, 490],
      ]);
      const p = mount({
        tabs: [term('0', 'gaa111'), term('1', 'gaa111'), term('2', 'gaa111'), term('3')],
        current: '3',
        grouping: grouping(),
      });
      const strip = screen.getByTestId('session-tabs');
      const t = dragData(TAB_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId('session-tab-0'), { dataTransfer: t });
      t.setData(TAB_DND_TYPE, '0');
      overAt(screen.getByTestId('group-cluster-gaa111'), t, 270); // the 1|2 gap
      expect(marked()).toEqual(['session-tab-2:before']);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(p.onReorder).toHaveBeenCalledWith('0', 2, undefined, undefined, true);
    });

    // For a tab that is NOT a member, between two members is someone else's
    // group: a drop there would read as a join that nothing previewed. A boundary
    // never joins, so it takes the group's nearer outer edge, marker included.
    it("a gap inside another group's cluster resolves to that group's nearer edge", () => {
      // strip: chip [10,50]  0 [58,158]  1 [166,266]  2 [274,374] | 3 [390,490]
      layout([
        [10, 50],
        [58, 158],
        [166, 266],
        [274, 374],
        [390, 490],
      ]);
      const p = mount({
        tabs: [term('0', 'gaa111'), term('1', 'gaa111'), term('2', 'gaa111'), term('3')],
        current: '3',
        grouping: grouping(),
      });
      const strip = screen.getByTestId('session-tabs');
      const cluster = screen.getByTestId('group-cluster-gaa111');
      const t = dragData(TAB_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId('session-tab-3'), { dataTransfer: t });
      t.setData(TAB_DND_TYPE, '3');

      overAt(cluster, t, 162); // the 0|1 gap: 152 from the left edge, 212 from the right
      expect(marked()).toEqual(['group-cluster-gaa111:before']);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(p.onReorder).toHaveBeenLastCalledWith('3', 0, undefined, beforeGroup('gaa111'), true);

      overAt(cluster, t, 270); // the 1|2 gap: 260 from the left edge, 104 from the right
      expect(marked()).toEqual(['session-tab-3:before']);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(p.onReorder).toHaveBeenLastCalledWith('3', 3, undefined, undefined, true);
    });

    // A whole group cannot sit inside another one either, on a member's half as
    // much as in a gap — the same edge a tab takes there.
    it("a chip dragged over another group's member half takes that group's nearer edge", () => {
      // strip: chip A [10,50]  0 [58,158]  1 [166,266]  2 [274,374] | chip B [390,450]  3 [458,558]
      layout([
        [10, 50],
        [58, 158],
        [166, 266],
        [274, 374],
        [390, 450],
        [458, 558],
      ]);
      const onMoveGroup = vi.fn();
      mount({
        tabs: [term('0', 'gaa111'), term('1', 'gaa111'), term('2', 'gaa111'), term('3', 'gbb222')],
        current: '3',
        grouping: grouping({
          groups: [
            { id: 'gaa111', color: 'green', name: 'one' },
            { id: 'gbb222', color: 'blue', name: 'two' },
          ],
          onMoveGroup,
        }),
      });
      const strip = screen.getByTestId('session-tabs');
      const t = dragData(GROUP_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId('group-chip-gbb222'), { dataTransfer: t });

      overAt(screen.getByTestId('session-tab-0'), t, 140); // right half of A's first member
      expect(marked()).toEqual(['group-cluster-gaa111:before']);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(onMoveGroup).toHaveBeenLastCalledWith('gbb222', 0, beforeGroup('gaa111'));

      overAt(screen.getByTestId('session-tab-2'), t, 280); // left half of A's last member
      expect(marked()).toEqual(['group-cluster-gbb222:before']);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(onMoveGroup).toHaveBeenLastCalledWith('gbb222', 3, beforeGroup('gbb222'));
    });

    it("a collapsed cluster's padding resolves to the edge it is nearest, never to the end", () => {
      // strip: [chip] [10,60] inside a cluster spanning 8–62;  2 [70,170]  3 [178,278]
      layout([
        [10, 60],
        [70, 170],
        [178, 278],
      ]);
      const p = mount({
        tabs: [term('0', 'gaa111'), term('1', 'gaa111'), term('2'), term('3')],
        current: '3',
        grouping: grouping({ collapsed: new Set(['gaa111']) }),
      });
      const strip = screen.getByTestId('session-tabs');
      const cluster = screen.getByTestId('group-cluster-gaa111');
      const t = dragData(TAB_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId('session-tab-3'), { dataTransfer: t });
      t.setData(TAB_DND_TYPE, '3');

      overAt(cluster, t, 9); // left padding → before the group
      expect(marked()).toEqual(['group-cluster-gaa111:before']);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(p.onReorder).toHaveBeenLastCalledWith('3', 0, undefined, beforeGroup('gaa111'), true);

      overAt(cluster, t, 61); // right padding → after the group
      expect(marked()).toEqual(['session-tab-2:before']);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(p.onReorder).toHaveBeenLastCalledWith('3', 0, undefined, undefined, true);
    });

    // Joining stays the centre-of-a-member gesture. Moving from one into a gap
    // must drop the armed join, or the drop would still join the group.
    it('a gap always clears an armed join', () => {
      layout([
        [10, 50],
        [58, 158],
        [166, 266],
        [280, 380],
      ]);
      const p = mount({
        tabs: [term('0', 'gaa111'), term('1', 'gaa111'), term('2')],
        current: '2',
        grouping: grouping(),
      });
      const strip = screen.getByTestId('session-tabs');
      const t = dragData(TAB_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId('session-tab-2'), { dataTransfer: t });
      t.setData(TAB_DND_TYPE, '2');
      overAt(screen.getByTestId('session-tab-0'), t, 108); // dead centre of member 0
      expect(screen.getByTestId('session-tab-0').className).toContain('join-armed');

      overAt(strip, t, 274); // the gap between the cluster and tab 2
      expect(screen.getByTestId('session-tab-0').className).not.toContain('join-armed');
      fireEvent.drop(strip, { dataTransfer: t });
      expect(p.onReorder).toHaveBeenCalledWith('2', 2, undefined, undefined, true); // no join gid
    });

    // A whole group dragged by its chip resolves gaps the same way a tab does:
    // before this fix a chip released in a gap went to the very end of the strip.
    it('a chip dragged into a gap moves the group there; past the last pill appends', () => {
      // 0 [0,100] | chip [108,170] (members 1,2 hidden) | 3 [178,278] | 4 [286,386]
      layout([
        [0, 100],
        [108, 170],
        [178, 278],
        [286, 386],
      ]);
      const onMoveGroup = vi.fn();
      mount({
        tabs: [term('0'), term('1', 'gaa111'), term('2', 'gaa111'), term('3'), term('4')],
        grouping: grouping({ collapsed: new Set(['gaa111']), onMoveGroup }),
      });
      const strip = screen.getByTestId('session-tabs');
      const t = dragData(GROUP_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId('group-chip-gaa111'), { dataTransfer: t });

      overAt(strip, t, 282); // the gap between 3 and 4
      expect(marked()).toEqual(['session-tab-4:before']);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(onMoveGroup).toHaveBeenLastCalledWith('gaa111', 2);

      overAt(strip, t, 104); // the gap just before the group itself: anchored
      expect(marked()).toEqual(['group-cluster-gaa111:before']);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(onMoveGroup).toHaveBeenLastCalledWith('gaa111', 1, beforeGroup('gaa111'));

      overAt(strip, t, 500); // right of the last pill: the trailing area
      expect(marked()).toEqual(['session-tab-4:after']);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(onMoveGroup).toHaveBeenLastCalledWith('gaa111', 3);
    });

    // A coloured pill is a target like any other: the bar shows beside it and its
    // dot is untouched (tab-accents: the insertion bar and the dot coexist).
    it('marks a coloured pill as the drop target without costing it its dot', () => {
      layout(plainSpans);
      mount({ tabs: [term('0'), { ...term('1'), color: 'ansi1' }, term('2')] });
      const t = dragData(TAB_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId('session-tab-2'), { dataTransfer: t });
      t.setData(TAB_DND_TYPE, '2');
      overAt(screen.getByTestId('session-tab-1'), t, 112); // left half of the coloured pill
      expect(marked()).toEqual(['session-tab-1:before']);
      expect(screen.getByTestId('session-tab-1').querySelector('.ctab-dot')).not.toBeNull();
    });

    // The marker belongs to the drag. Leaving the strip for something else clears
    // it; moving between the strip's own children (a gap, a pill) must not.
    it('leaving the strip clears the marker and commits nothing', () => {
      layout(plainSpans);
      const p = mount({ tabs: plain });
      const strip = screen.getByTestId('session-tabs');
      const t = dragData(TAB_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId('session-tab-2'), { dataTransfer: t });
      t.setData(TAB_DND_TYPE, '2');
      overAt(strip, t, 104);
      expect(marked()).toEqual(['session-tab-1:before']);

      const leaveTo = (relatedTarget: Element) => {
        const ev = new Event('dragleave', { bubbles: true, cancelable: true });
        Object.assign(ev, { relatedTarget });
        fireEvent(strip, ev);
      };
      leaveTo(screen.getByTestId('session-tab-0')); // still inside the strip
      expect(marked()).toEqual(['session-tab-1:before']);
      leaveTo(document.body); // out
      expect(marked()).toEqual([]);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(p.onReorder).not.toHaveBeenCalled();
    });
  });

  // Reviews R3 + R5. The entry-index space has no chips and no collapsed members,
  // so with a group collapsed "before its chip" and "after it" are ONE index and
  // the entry after the group won both. The boundary now carries an explicit
  // GROUP anchor, and the marker and the commit both read that one value.
  describe('boundaries around groups (R3, R5)', () => {
    // 0 [0,100] | cluster: chip [108,170] | 3 [178,278] | 4 [286,386]
    const collapsedOne = () => {
      layout([
        [0, 100],
        [108, 170],
        [178, 278],
        [286, 386],
      ]);
      return mount({
        tabs: [term('0'), term('1', 'gaa111'), term('2', 'gaa111'), term('3'), term('4')],
        grouping: grouping({ collapsed: new Set(['gaa111']) }),
      });
    };
    const chip = () => screen.getByTestId('group-chip-gaa111');
    const startTab = (id: string) => {
      const t = dragData(TAB_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId(`session-tab-${id}`), { dataTransfer: t });
      t.setData(TAB_DND_TYPE, id);
      return t;
    };

    it('before a collapsed chip anchors to the group and marks the cluster', () => {
      const p = collapsedOne();
      const t = startTab('4');
      overAt(chip(), t, 120); // left half
      expect(marked()).toEqual(['group-cluster-gaa111:before']);
      fireEvent.drop(screen.getByTestId('session-tabs'), { dataTransfer: t });
      expect(p.onReorder).toHaveBeenCalledWith('4', 1, undefined, beforeGroup('gaa111'), true);
    });

    it('just after a collapsed chip keeps the plain index and marks the next pill', () => {
      const p = collapsedOne();
      const t = startTab('4');
      overAt(chip(), t, 160); // right half
      expect(marked()).toEqual(['session-tab-3:before']);
      fireEvent.drop(screen.getByTestId('session-tabs'), { dataTransfer: t });
      expect(p.onReorder).toHaveBeenCalledWith('4', 1, undefined, undefined, true);
    });

    it('the two sides of a collapsed chip preview on different elements', () => {
      collapsedOne();
      const t = startTab('4');
      overAt(chip(), t, 120);
      const before = marked();
      overAt(chip(), t, 160);
      const after = marked();
      expect(before).not.toEqual(after);
      expect(before).toHaveLength(1);
      expect(after).toHaveLength(1);
    });

    it('the right half of the pill before a collapsed group is the same boundary as its chip', () => {
      const p = collapsedOne();
      const t = startTab('4');
      overAt(screen.getByTestId('session-tab-0'), t, 90); // right half of tab 0
      expect(marked()).toEqual(['group-cluster-gaa111:before']);
      fireEvent.drop(screen.getByTestId('session-tabs'), { dataTransfer: t });
      expect(p.onReorder).toHaveBeenCalledWith('4', 1, undefined, beforeGroup('gaa111'), true);
    });

    it('between two adjacent collapsed groups is a boundary of its own', () => {
      // 0 [0,100] | chip A [108,170] | chip B [178,240] | 5 [248,348]
      layout([
        [0, 100],
        [108, 170],
        [178, 240],
        [248, 348],
      ]);
      const p = mount({
        tabs: [
          term('0'),
          term('1', 'gaa111'),
          term('2', 'gaa111'),
          term('3', 'gbb222'),
          term('4', 'gbb222'),
          term('5'),
        ],
        grouping: grouping({
          groups: [
            { id: 'gaa111', color: 'green', name: 'one' },
            { id: 'gbb222', color: 'blue', name: 'two' },
          ],
          collapsed: new Set(['gaa111', 'gbb222']),
        }),
      });
      const strip = screen.getByTestId('session-tabs');
      const t = startTab('5');

      overAt(screen.getByTestId('group-chip-gaa111'), t, 120); // before A
      expect(marked()).toEqual(['group-cluster-gaa111:before']);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(p.onReorder).toHaveBeenLastCalledWith('5', 1, undefined, beforeGroup('gaa111'), true);

      overAt(screen.getByTestId('group-chip-gbb222'), t, 190); // between A and B
      expect(marked()).toEqual(['group-cluster-gbb222:before']);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(p.onReorder).toHaveBeenLastCalledWith('5', 1, undefined, beforeGroup('gbb222'), true);

      overAt(screen.getByTestId('group-chip-gaa111'), t, 165); // right of A: the same boundary
      expect(marked()).toEqual(['group-cluster-gbb222:before']);

      overAt(screen.getByTestId('group-chip-gbb222'), t, 235); // after B
      expect(marked()).toEqual(['session-tab-5:before']);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(p.onReorder).toHaveBeenLastCalledWith('5', 1, undefined, undefined, true);
    });

    // An expanded group has the same two edges. Its chip's right half and its
    // first member's left half commit exactly like "before the chip" (a boundary
    // never joins), so they preview there too instead of inside the frame.
    it('before an expanded group marks its cluster, after its last member marks the next pill', () => {
      // 0 [0,100] | chip [108,170] 1 [178,278] 2 [286,386] | 3 [400,500]
      layout([
        [0, 100],
        [108, 170],
        [178, 278],
        [286, 386],
        [400, 500],
      ]);
      const p = mount({
        tabs: [term('0'), term('1', 'gaa111'), term('2', 'gaa111'), term('3')],
        grouping: grouping(),
      });
      const strip = screen.getByTestId('session-tabs');
      const t = startTab('3');

      overAt(chip(), t, 120);
      expect(marked()).toEqual(['group-cluster-gaa111:before']);
      overAt(chip(), t, 160);
      expect(marked()).toEqual(['group-cluster-gaa111:before']);
      overAt(screen.getByTestId('session-tab-1'), t, 185); // left half of the first member
      expect(marked()).toEqual(['group-cluster-gaa111:before']);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(p.onReorder).toHaveBeenLastCalledWith('3', 1, undefined, beforeGroup('gaa111'), true);

      overAt(screen.getByTestId('session-tab-2'), t, 380); // right half of the last member
      expect(marked()).toEqual(['session-tab-3:before']);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(p.onReorder).toHaveBeenLastCalledWith('3', 3, undefined, undefined, true);

      // Between two members is inside a group tab 3 is not in. It used to keep
      // that index — which App read as a join — and now takes the nearer edge.
      overAt(screen.getByTestId('session-tab-2'), t, 290); // left half of the last member
      expect(marked()).toEqual(['session-tab-3:before']);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(p.onReorder).toHaveBeenLastCalledWith('3', 3, undefined, undefined, true);
    });

    // The trailing bar belongs after the LAST BLOCK. With a group collapsed at the
    // end, the last entry is the pill before it — a marker there would preview a
    // drop on the wrong side of the group the commit appends past.
    it('appending past a trailing group marks the cluster, not the pill before it', () => {
      layout([
        [0, 100],
        [108, 170],
      ]);
      const p = mount({
        tabs: [term('0'), term('1', 'gaa111'), term('2', 'gaa111')],
        grouping: grouping({ collapsed: new Set(['gaa111']) }),
      });
      const strip = screen.getByTestId('session-tabs');
      const t = startTab('0');
      overAt(strip, t, 300);
      expect(marked()).toEqual(['group-cluster-gaa111:after']);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(p.onReorder).toHaveBeenCalledWith('0', 1, undefined, undefined, true);
    });

    // Joining is the centre-of-a-member gesture and nothing else. Moving off a
    // member's centre onto a chip or a fused pill disarms it, so the drop is the
    // boundary it previews — an anchored or plain reorder, never a join.
    it('a boundary on a chip or a fused pill never joins, even after arming a join', () => {
      // chip [10,50]  0 [58,158]  1 [166,266]  fused(2,3) [280,480]
      layout([
        [10, 50],
        [58, 158],
        [166, 266],
        [280, 480],
      ]);
      const p = mount({
        tabs: [term('0', 'gaa111'), term('1', 'gaa111'), term('2'), term('3'), term('4')],
        current: '4',
        pairings: [{ a: '2', b: '3', focusedId: '2' }],
        grouping: grouping(),
      });
      const strip = screen.getByTestId('session-tabs');
      const t = startTab('4');

      overAt(screen.getByTestId('session-tab-1'), t, 216); // dead centre of a member
      expect(screen.getByTestId('session-tab-1').className).toContain('join-armed');
      overAt(chip(), t, 20); // left half of the chip
      expect(screen.getByTestId('session-tab-1').className).not.toContain('join-armed');
      fireEvent.drop(strip, { dataTransfer: t });
      expect(p.onReorder).toHaveBeenLastCalledWith('4', 0, undefined, beforeGroup('gaa111'), true);

      overAt(screen.getByTestId('session-tab-1'), t, 216);
      expect(screen.getByTestId('session-tab-1').className).toContain('join-armed');
      overAt(screen.getByTestId('fused-tab-2-3'), t, 290); // left half of the fused pill
      expect(screen.getByTestId('session-tab-1').className).not.toContain('join-armed');
      fireEvent.drop(strip, { dataTransfer: t });
      expect(p.onReorder).toHaveBeenLastCalledWith('4', 2, undefined, undefined, true);
    });

    it('a group dragged before another collapsed group carries the same anchor', () => {
      layout([
        [0, 100],
        [108, 170],
        [178, 240],
        [248, 348],
      ]);
      const onMoveGroup = vi.fn();
      mount({
        tabs: [
          term('0'),
          term('1', 'gaa111'),
          term('2', 'gaa111'),
          term('3', 'gbb222'),
          term('4', 'gbb222'),
          term('5'),
        ],
        grouping: grouping({
          groups: [
            { id: 'gaa111', color: 'green', name: 'one' },
            { id: 'gbb222', color: 'blue', name: 'two' },
          ],
          collapsed: new Set(['gaa111', 'gbb222']),
          onMoveGroup,
        }),
      });
      const strip = screen.getByTestId('session-tabs');
      const t = dragData(GROUP_DND_TYPE);
      fireEvent.dragStart(screen.getByTestId('group-chip-gbb222'), { dataTransfer: t });

      overAt(screen.getByTestId('group-chip-gaa111'), t, 120); // before A
      expect(marked()).toEqual(['group-cluster-gaa111:before']);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(onMoveGroup).toHaveBeenLastCalledWith('gbb222', 1, beforeGroup('gaa111'));

      overAt(screen.getByTestId('group-chip-gbb222'), t, 235); // after B itself: plain index
      expect(marked()).toEqual(['session-tab-5:before']);
      fireEvent.drop(strip, { dataTransfer: t });
      expect(onMoveGroup).toHaveBeenLastCalledWith('gbb222', 1);
    });
  });
});
