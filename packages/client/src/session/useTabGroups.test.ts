// The tab-group model + collapse view-state, now testable in isolation (the
// point of extracting it from App). Covers broadcast pruning, the send handlers,
// the collapse guard, and centralized auto-expand.

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

const setup = (tabs: TabMeta[], sessionId: string) => {
  const tabsRef = ref(tabs);
  const sessionIdRef = ref(sessionId);
  const dirtyRef = ref<{ [id: string]: boolean }>({});
  const { calls, ws } = makeWs();
  const wsRef = ref(ws);
  const switchSession = vi.fn((id: string) => {
    sessionIdRef.current = id;
  });
  const showToast = vi.fn();
  const view = renderHook(
    ({ tabs, sessionId }) =>
      useTabGroups({
        tabs,
        sessionId,
        tabsRef,
        sessionIdRef,
        dirtyRef,
        wsRef,
        switchSession,
        showToast,
      }),
    { initialProps: { tabs, sessionId } },
  );
  return { view, calls, switchSession, showToast, tabsRef, sessionIdRef, dirtyRef };
};

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('useTabGroups', () => {
  it('applyBroadcast sets groups and prunes dangling collapsed ids', () => {
    const { view } = setup([t('0', 'gA'), t('1')], '1');
    act(() => view.result.current.applyBroadcast([g('gA')]));
    act(() => view.result.current.toggleGroup('gA')); // collapse gA (active '1' is outside)
    expect(view.result.current.collapsed.has('gA')).toBe(true);
    // A broadcast without gA prunes it from the collapsed set.
    act(() => view.result.current.applyBroadcast([]));
    expect(view.result.current.collapsed.has('gA')).toBe(false);
    expect(view.result.current.groups).toEqual([]);
  });

  it('the send handlers hit the wire', () => {
    const { view, calls } = setup([t('0', 'gA'), t('1', 'gA'), t('2')], '2');
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
    const { view, calls } = setup([t('0'), t('1', 'gA'), t('2', 'gA'), t('3')], '0');
    act(() => view.result.current.addToGroup('3', 'gA'));
    expect(calls).toContainEqual([
      'update',
      { id: 'gA', addIds: ['3'], order: ['0', '1', '2', '3'] },
    ]);
  });

  it('the collapse guard navigates out first, and refuses the whole-strip case', () => {
    // Active tab is a member → collapsing must navigate to the outside neighbor.
    const g1 = setup([t('0', 'gA'), t('1', 'gA'), t('2')], '0');
    act(() => g1.view.result.current.toggleGroup('gA'));
    expect(g1.switchSession).toHaveBeenCalledWith('2'); // nearest outside
    expect(g1.view.result.current.collapsed.has('gA')).toBe(true);

    // Whole strip is one group → refuse with a toast, stay expanded.
    const g2 = setup([t('0', 'gA'), t('1', 'gA')], '0');
    act(() => g2.view.result.current.toggleGroup('gA'));
    expect(g2.showToast).toHaveBeenCalledWith("Can't collapse the only group");
    expect(g2.view.result.current.collapsed.has('gA')).toBe(false);
  });

  it('auto-expands when the active tab lands on a collapsed member', () => {
    const { view } = setup([t('0', 'gA'), t('1', 'gA'), t('2')], '2');
    act(() => view.result.current.applyBroadcast([g('gA')]));
    act(() => view.result.current.toggleGroup('gA')); // collapse (active '2' outside)
    expect(view.result.current.collapsed.has('gA')).toBe(true);
    // Navigate onto a collapsed member → the effect auto-expands.
    act(() => view.rerender({ tabs: [t('0', 'gA'), t('1', 'gA'), t('2')], sessionId: '0' }));
    expect(view.result.current.collapsed.has('gA')).toBe(false);
  });
});
