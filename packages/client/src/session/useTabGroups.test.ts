// The tab-group model + collapse view-state, now testable in isolation (the
// point of extracting it from App). Covers broadcast pruning, the send handlers,
// the collapse guard (per pane), and centralized auto-expand (any pane's active tab).

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MutableRefObject } from 'react';
import type { TabGroup, TabMeta } from '@palmux/shared';
import { useTabGroups } from './useTabGroups';

const t = (id: string, groupId?: string): TabMeta => ({
  id,
  kind: 'terminal',
  ...(groupId ? { groupId } : {}),
});
const g = (id: string, color = 'blue'): TabGroup => ({ id, color });

const ref = <T>(v: T): MutableRefObject<T> => ({ current: v });

const makeWs = () => {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    ws: {
      sendGroupCreate: (ids: string[], meta?: unknown) => (
        calls.push(['create', { ids, meta }]),
        true
      ),
      sendGroupUpdate: (patch: unknown) => (calls.push(['update', patch]), true),
      sendKill: (id: string) => (calls.push(['kill', id]), true),
    } as never,
  };
};

interface Props {
  tabs: TabMeta[];
  activeIds: string[];
}

/**
 * `panes` is each pane's tab ids in server order (a pane's strip); without it there is one pane
 * holding everything, which is what the mobile layer passes.
 */
const setup = (
  tabs: TabMeta[],
  activeIds: string[],
  panes?: string[][],
  /** The FULL list, hidden tabs included, as a window that shows only part of it passes it. */
  full?: TabMeta[],
) => {
  const tabsRef = ref(tabs);
  const fullTabsRef = full ? ref(full) : undefined;
  const dirtyRef = ref<{ [id: string]: boolean }>({});
  const { calls, ws } = makeWs();
  const wsRef = ref(ws);
  const stripOf = (id: string) =>
    panes?.find((p) => p.includes(id)) ?? tabsRef.current.map((x) => x.id);
  const switchTo = vi.fn();
  const showToast = vi.fn();
  const view = renderHook(
    (props: Props) =>
      useTabGroups({
        ...props,
        stripOf,
        switchTo,
        tabsRef,
        ...(fullTabsRef ? { fullTabsRef } : {}),
        dirtyRef,
        wsRef,
        showToast,
      }),
    { initialProps: { tabs, activeIds } satisfies Props },
  );
  return { view, calls, switchTo, showToast, tabsRef, dirtyRef };
};

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('useTabGroups', () => {
  it('applyBroadcast sets groups and prunes dangling collapsed ids', () => {
    const { view } = setup([t('0', 'gA'), t('1')], ['1']);
    act(() => view.result.current.applyBroadcast([g('gA')]));
    act(() => view.result.current.toggleGroup('gA')); // collapse gA (active '1' is outside)
    expect(view.result.current.collapsed.has('gA')).toBe(true);
    // A broadcast without gA prunes it from the collapsed set.
    act(() => view.result.current.applyBroadcast([]));
    expect(view.result.current.collapsed.has('gA')).toBe(false);
    expect(view.result.current.groups).toEqual([]);
  });

  it('the send handlers hit the wire', () => {
    const { view, calls } = setup([t('0', 'gA'), t('1', 'gA'), t('2')], ['2']);
    act(() => view.result.current.newGroup('2'));
    act(() => view.result.current.groupRename('gA', 'proj'));
    act(() => view.result.current.groupRecolor('gA', 'red'));
    act(() => view.result.current.groupDissolve('gA'));
    act(() => view.result.current.removeFromGroup('0'));
    expect(calls).toContainEqual(['create', { ids: ['2'], meta: undefined }]);
    expect(calls).toContainEqual(['update', { id: 'gA', name: 'proj' }]);
    expect(calls).toContainEqual(['update', { id: 'gA', color: 'red' }]);
    expect(calls).toContainEqual(['update', { id: 'gA', dissolve: true }]);
    expect(calls).toContainEqual(['update', { id: 'gA', removeIds: ['0'] }]);
  });

  it('addToGroup pulls the tab to the group (order after the last member)', () => {
    const { view, calls } = setup([t('0'), t('1', 'gA'), t('2', 'gA'), t('3')], ['0']);
    act(() => view.result.current.addToGroup('3', 'gA'));
    expect(calls).toContainEqual([
      'update',
      { id: 'gA', addIds: ['3'], order: ['0', '1', '2', '3'] },
    ]);
  });

  // A window shows part of the list, and the server applies `order` as a forgiving permutation that
  // appends any id the request omits AT THE END, so an order built from the visible tabs would move
  // every hidden tab to the tail.
  describe('in a window that shows only some of the tabs', () => {
    // Tabs 1 and 3 belong to another window; this one shows 0, 2 and 4.
    const full = [t('0'), t('1'), t('2', 'gA'), t('3'), t('4')];
    const visible = full.filter((x) => x.id !== '1' && x.id !== '3');

    it('addToGroup sends an order that keeps the hidden tabs in place', () => {
      const { view, calls } = setup(visible, ['0'], undefined, full);
      act(() => view.result.current.addToGroup('4', 'gA'));
      expect(calls).toContainEqual([
        'update',
        { id: 'gA', addIds: ['4'], order: ['0', '1', '2', '4', '3'] },
      ]);
    });

    it('lands after the last member in the FULL order, even when that member is hidden', () => {
      const withHiddenMember = [t('0'), t('1'), t('2', 'gA'), t('3', 'gA'), t('4')];
      const shown = withHiddenMember.filter((x) => x.id !== '3');
      const { view, calls } = setup(shown, ['0'], undefined, withHiddenMember);
      act(() => view.result.current.addToGroup('4', 'gA'));
      expect(calls).toContainEqual([
        'update',
        { id: 'gA', addIds: ['4'], order: ['0', '1', '2', '3', '4'] },
      ]);
    });

    it('a group whose members are all in another window has no visible member but still has an order', () => {
      const away = [t('0'), t('1', 'gA'), t('2')];
      const { view, calls } = setup([t('0'), t('2')], ['0'], undefined, away);
      act(() => view.result.current.addToGroup('2', 'gA'));
      expect(calls).toContainEqual(['update', { id: 'gA', addIds: ['2'], order: ['0', '1', '2'] }]);
    });

    it('collapse, switch, close-all and remove keep reading the visible list', () => {
      // gA has members 2 (here) and 3 (another window): close-all must kill only 2.
      const grouped = [t('0'), t('1'), t('2', 'gA'), t('3', 'gA'), t('4')];
      const shown = grouped.filter((x) => x.id !== '1' && x.id !== '3');
      const { view, calls } = setup(shown, ['0'], undefined, grouped);
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      act(() => view.result.current.groupCloseAll('gA'));
      expect(calls.filter(([k]) => k === 'kill')).toEqual([['kill', '2']]);
      act(() => view.result.current.removeFromGroup('2'));
      expect(calls).toContainEqual(['update', { id: 'gA', removeIds: ['2'] }]);
    });
  });

  it('without fullTabsRef the visible list is the full one, as before', () => {
    const { view, calls } = setup([t('0'), t('1', 'gA'), t('2')], ['0']);
    act(() => view.result.current.addToGroup('2', 'gA'));
    expect(calls).toContainEqual(['update', { id: 'gA', addIds: ['2'], order: ['0', '1', '2'] }]);
  });

  it('the collapse guard navigates out first, and refuses the whole-strip case', () => {
    // Active tab is a member → collapsing must navigate to the outside neighbor.
    const g1 = setup([t('0', 'gA'), t('1', 'gA'), t('2')], ['0']);
    act(() => g1.view.result.current.toggleGroup('gA'));
    expect(g1.switchTo).toHaveBeenCalledWith('0', '2'); // nearest outside
    expect(g1.view.result.current.collapsed.has('gA')).toBe(true);

    // Whole strip is one group → refuse with a toast, stay expanded.
    const g2 = setup([t('0', 'gA'), t('1', 'gA')], ['0']);
    act(() => g2.view.result.current.toggleGroup('gA'));
    expect(g2.showToast).toHaveBeenCalledWith("Can't collapse the only group");
    expect(g2.view.result.current.collapsed.has('gA')).toBe(false);
  });

  it('the guard leaves a group whose members are not on screen to collapse untouched', () => {
    const { view, switchTo, showToast } = setup([t('0', 'gA'), t('1', 'gA'), t('2')], ['2']);
    act(() => view.result.current.toggleGroup('gA'));
    expect(switchTo).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    expect(view.result.current.collapsed.has('gA')).toBe(true);
  });

  describe('with several panes', () => {
    // Pane A holds 0 (gA), 1 (gA) and 2; pane B holds 3 (gA) and 4 (gA) and 5.
    const tabs = [t('0', 'gA'), t('1', 'gA'), t('2'), t('3', 'gA'), t('4', 'gA'), t('5')];
    const panes = [
      ['0', '1', '2'],
      ['3', '4', '5'],
    ];

    it('collapses when every pane showing a member has a way out, switching each in its own strip', () => {
      const { view, switchTo } = setup(tabs, ['0', '4'], panes);
      act(() => view.result.current.toggleGroup('gA'));
      expect(switchTo).toHaveBeenCalledTimes(2);
      expect(switchTo).toHaveBeenCalledWith('0', '2'); // pane A's own outside tab
      expect(switchTo).toHaveBeenCalledWith('4', '5'); // pane B's: 3 and 4 are members, 5 is out
      expect(view.result.current.collapsed.has('gA')).toBe(true);
    });

    it('is refused when one pane has no outside tab, and no pane is switched', () => {
      // Pane B holds only members of gA: nothing to show once it collapses.
      const onlyMembers = [
        ['0', '1', '2'],
        ['3', '4'],
      ];
      const { view, switchTo, showToast } = setup(
        [t('0', 'gA'), t('1', 'gA'), t('2'), t('3', 'gA'), t('4', 'gA')],
        ['0', '4'],
        onlyMembers,
      );
      act(() => view.result.current.toggleGroup('gA'));
      expect(showToast).toHaveBeenCalledWith("Can't collapse the only group");
      expect(switchTo).not.toHaveBeenCalled();
      expect(view.result.current.collapsed.has('gA')).toBe(false);
    });

    it('a pane showing a tab outside the group is left alone', () => {
      const { view, switchTo } = setup(tabs, ['0', '5'], panes);
      act(() => view.result.current.toggleGroup('gA'));
      expect(switchTo).toHaveBeenCalledTimes(1);
      expect(switchTo).toHaveBeenCalledWith('0', '2');
    });
  });

  it('auto-expands when the active tab lands on a collapsed member', () => {
    const { view } = setup([t('0', 'gA'), t('1', 'gA'), t('2')], ['2']);
    act(() => view.result.current.applyBroadcast([g('gA')]));
    act(() => view.result.current.toggleGroup('gA')); // collapse (active '2' outside)
    expect(view.result.current.collapsed.has('gA')).toBe(true);
    // Navigate onto a collapsed member → the effect auto-expands.
    act(() => view.rerender({ tabs: [t('0', 'gA'), t('1', 'gA'), t('2')], activeIds: ['0'] }));
    expect(view.result.current.collapsed.has('gA')).toBe(false);
  });

  it('auto-expands for a pane that is not the focused one', () => {
    // Two panes: the first shows 2 (outside), the second shows 4, which is NOT a member yet.
    const all = [t('0', 'gA'), t('1', 'gA'), t('2'), t('4')];
    const { view } = setup(all, ['2', '4']);
    act(() => view.result.current.applyBroadcast([g('gA')]));
    act(() => view.result.current.toggleGroup('gA'));
    expect(view.result.current.collapsed.has('gA')).toBe(true);
    // The OTHER pane (not the first id) lands on a collapsed member.
    act(() => view.rerender({ tabs: all, activeIds: ['2', '1'] }));
    expect(view.result.current.collapsed.has('gA')).toBe(false);
  });
});
