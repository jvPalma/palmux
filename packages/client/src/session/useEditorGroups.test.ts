// The window's pane layout as a hook: boot gating, reconcile against each broadcast, `show`
// (the one door every navigation goes through), and per-window persistence.
//
// Storage is a counting fake so a test can say what was read and written, and "no storage access
// when disabled" is an assertion and not a hope. A window is a storage: two windows are two fakes.

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabKind, TabMeta } from '@palmux/shared';
import {
  activate,
  focusLeaf,
  leaves,
  moveTab,
  resizeSash,
  singleLeaf,
  splitPane,
  type PaneLayout,
  type TabRef,
} from './pane-grid';
import {
  LAYOUT_STORE_KEY,
  layoutKey,
  useEditorGroups,
  type UseEditorGroupsOptions,
} from './useEditorGroups';

const ref = (id: string, kind: TabKind = 'terminal'): TabRef => ({ id, kind });
const refs = (...ids: string[]): TabRef[] => ids.map((id) => ref(id));
const list = (...ids: string[]): TabMeta[] => ids.map((id) => ({ id, kind: 'terminal' }));

const ORDER = ['1', '2', '3', '4'];
const tabIds = (l: { tabs: TabRef[] }): string[] => l.tabs.map((t) => t.id);

/** A window's `sessionStorage`, counting what it is asked. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const calls = { get: 0, set: 0, remove: 0 };
  const storage = {
    getItem: (k: string) => {
      calls.get += 1;
      return data.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      calls.set += 1;
      data.set(k, v);
    },
    removeItem: (k: string) => {
      calls.remove += 1;
      data.delete(k);
    },
    clear: () => data.clear(),
  };
  const saved = (): unknown => JSON.parse(data.get(LAYOUT_STORE_KEY) ?? 'null');
  return { storage, data, calls, saved };
}

let store: ReturnType<typeof fakeStorage>;
beforeEach(() => {
  store = fakeStorage();
  vi.stubGlobal('sessionStorage', store.storage);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const save = (layout: PaneLayout | string): void => {
  store.data.set(LAYOUT_STORE_KEY, typeof layout === 'string' ? layout : JSON.stringify(layout));
};

/** p0 holds 1 and 3 (showing 1), p1 holds 2; p1 is focused. */
const twoPanes = (): PaneLayout =>
  splitPane(singleLeaf(refs('1', '2', '3'), '1'), 'p0', 'right', ref('2'), ORDER);

const base = (over: Partial<UseEditorGroupsOptions> = {}): UseEditorGroupsOptions => ({
  enabled: true,
  tabs: list('1', '2', '3'),
  ready: true,
  bootSelection: null,
  sessionId: '1',
  ...over,
});

const mount = (over: Partial<UseEditorGroupsOptions> = {}) =>
  renderHook((props: UseEditorGroupsOptions) => useEditorGroups(props), {
    initialProps: base(over),
  });

const leafNamed = (layout: PaneLayout | null, id: string) => {
  const found = layout ? leaves(layout).find((l) => l.id === id) : undefined;
  if (!found) throw new Error(`no leaf ${id}`);
  return found;
};

describe('before the first broadcast', () => {
  it('has no layout, so nothing mounts', () => {
    const { result } = mount({ ready: false, tabs: [] });
    expect(result.current.layout).toBeNull();
    expect(result.current.focusedActive).toBeNull();
    expect(result.current.rects.size).toBe(0);
    expect(result.current.sashes).toEqual([]);
  });

  // Nothing mounts before the first broadcast on ANY path, the phone included.
  it('has no layout with groups disabled either', () => {
    const { result } = mount({ ready: false, enabled: false, tabs: [] });
    expect(result.current.layout).toBeNull();
  });

  it('reads no storage until ready', () => {
    save(twoPanes());
    mount({ ready: false, tabs: [] });
    expect(store.calls.get).toBe(0);
  });

  it('builds the layout in the render that turns `ready` on, with no frame of the old one', () => {
    const seen: Array<PaneLayout | null> = [];
    const { rerender } = renderHook(
      (props: UseEditorGroupsOptions) => {
        const out = useEditorGroups(props);
        seen.push(out.layout);
        return out;
      },
      { initialProps: base({ ready: false, tabs: [] }) },
    );
    rerender(base());
    expect(seen[0]).toBeNull();
    // every render after `ready` has a layout: none is committed without one
    expect(seen.slice(1).every((l) => l !== null)).toBe(true);
  });
});

describe('boot', () => {
  it('A fresh window opens one pane holding every tab, on the first tab', () => {
    const { result } = mount();
    const layout = result.current.layout!;
    expect(leaves(layout)).toHaveLength(1);
    expect(tabIds(leaves(layout)[0]!)).toEqual(['1', '2', '3']);
    expect(result.current.focusedActive).toBe('1');
  });

  it('opens on the boot selection', () => {
    const { result } = mount({ bootSelection: '3' });
    expect(result.current.focusedActive).toBe('3');
    expect(leaves(result.current.layout!)).toHaveLength(1);
  });

  it('A fresh window opens one pane even when other windows have several: the layout is not shared', () => {
    // another window, open with three panes in ITS sessionStorage
    const other = fakeStorage({
      [LAYOUT_STORE_KEY]: JSON.stringify(splitPane(twoPanes(), 'p1', 'bottom', ref('3'), ORDER)),
    });
    vi.stubGlobal('sessionStorage', other.storage);
    const open = mount();
    expect(leaves(open.result.current.layout!)).toHaveLength(3);

    // a fresh window beside it has its own, empty, storage
    vi.stubGlobal('sessionStorage', store.storage);
    const fresh = mount();
    expect(leaves(fresh.result.current.layout!)).toHaveLength(1);
    expect(tabIds(leaves(fresh.result.current.layout!)[0]!)).toEqual(['1', '2', '3']);
    expect(leaves(open.result.current.layout!)).toHaveLength(3);
  });

  it('a saved layout whose tabs all died boots on the first live tab', () => {
    save(twoPanes()); // 1, 2 and 3 are all gone
    const { result } = mount({ tabs: list('6', '5') });
    const layout = result.current.layout!;
    expect(leaves(layout)).toHaveLength(1);
    expect(tabIds(leaves(layout)[0]!)).toEqual(['6', '5']);
    expect(result.current.focusedActive).toBe('6');
  });

  it('a saved window on the New-tab page boots on its first tab when nothing names one', () => {
    save(singleLeaf(refs('2', '1'), null)); // the one pane showed nothing; others' tabs joined it
    expect(mount().result.current.focusedActive).toBe('1');
  });

  it('Reload restores: the same panes, tabs, sizes and focused pane', () => {
    const saved = resizeSash(twoPanes(), [], 0, 0.2);
    save(saved);
    const { result } = mount();
    expect(result.current.layout).toEqual(saved);
    expect(result.current.focusedActive).toBe('2');
    expect(result.current.layout!.focused).toBe('p1');
  });

  it('discards a corrupt saved layout and starts with one pane', () => {
    save('{"v":3,"root":');
    const { result } = mount();
    expect(leaves(result.current.layout!)).toHaveLength(1);
    // and replaces it with a usable one
    expect(store.saved()).toMatchObject({ v: 3 });
  });

  it('discards a layout that parses as JSON but is not a layout', () => {
    save('{"v":2,"root":null}');
    expect(leaves(mount().result.current.layout!)).toHaveLength(1);
  });

  it('A saved terminal that is gone: its pane is removed and no pane holds it', () => {
    const saved = splitPane(singleLeaf(refs('1', '5'), '1'), 'p0', 'right', ref('5'), ['1', '5']);
    save(saved);
    const { result } = mount({ tabs: list('1', '2') });
    const layout = result.current.layout!;
    expect(leaves(layout).map((l) => l.id)).toEqual(['p0']);
    expect(leaves(layout).flatMap(tabIds)).not.toContain('5');
    // the tab it did not know joined the focused pane without taking over
    expect(tabIds(leafNamed(layout, 'p0'))).toEqual(['1', '2']);
  });

  it('focuses the leaf holding the boot selection', () => {
    save(twoPanes()); // focused p1
    const { result } = mount({ bootSelection: '3' });
    expect(result.current.layout!.focused).toBe('p0');
    expect(leafNamed(result.current.layout, 'p0').active).toBe('3');
    expect(result.current.focusedActive).toBe('3');
  });

  // The stored selection can be unusable (a recycled id, a closed tab); `resolveSelection` would
  // answer the first tab, a guess that must not override a valid restored focus.
  it('keeps the restored focus when there is no boot selection', () => {
    save(twoPanes());
    const { result } = mount({ bootSelection: null });
    expect(result.current.layout!.focused).toBe('p1');
    expect(result.current.focusedActive).toBe('2');
  });

  it('a boot selection already shown where it is changes nothing', () => {
    const saved = twoPanes();
    save(saved);
    const { result } = mount({ bootSelection: '2' });
    expect(result.current.layout).toEqual(saved);
  });
});

describe('a show from before the first broadcast', () => {
  const early = (show: Parameters<ReturnType<typeof mount>['result']['current']['show']>[0]) => {
    const view = renderHook((props: UseEditorGroupsOptions) => useEditorGroups(props), {
      initialProps: base({ ready: false, tabs: [] }),
    });
    act(() => view.result.current.show(show));
    expect(view.result.current.layout).toBeNull();
    return view;
  };

  it('A script asks for a terminal: lands as the selection once ready, as a pending terminal', () => {
    // `?new=1` creates its terminal inside the first `sessions` handler: the first list lacks it
    const view = early({ id: '3', kind: 'terminal', known: false });
    view.rerender(base({ tabs: list('1', '2') }));
    const layout = view.result.current.layout!;
    expect(view.result.current.focusedActive).toBe('3');
    expect(layoutHas(layout, '3')).toBe(true);
    expect(view.result.current.pending.has('3')).toBe(true);
  });

  it('a legacy id that is live is activated where it is and is not pending', () => {
    save(twoPanes());
    const view = early({ id: '3', kind: 'terminal', known: false });
    view.rerender(base({ tabs: list('1', '2', '3') }));
    expect(view.result.current.focusedActive).toBe('3');
    expect(view.result.current.layout!.focused).toBe('p0');
    expect(view.result.current.pending.has('3')).toBe(false);
  });

  it('a legacy id the list does not hold is a pending terminal whose attach spawns it', () => {
    const view = early({ id: '9', kind: 'terminal', known: false });
    view.rerender(base({ tabs: list('1', '2', '3') }));
    expect(view.result.current.focusedActive).toBe('9');
    expect(view.result.current.pending.has('9')).toBe(true);
    expect(leafNamed(view.result.current.layout, 'p0').tabs).toContainEqual(ref('9'));
  });

  it('comes after the boot selection, as the selection', () => {
    const view = early({ id: '2', kind: 'terminal', known: false });
    view.rerender(base({ bootSelection: '3' }));
    expect(view.result.current.focusedActive).toBe('2');
  });

  it('a later show is a show, not a boot request', () => {
    const view = early({ id: '2', kind: 'terminal', known: true });
    view.rerender(base());
    expect(view.result.current.focusedActive).toBe('2');
    act(() => view.result.current.show({ id: '3', kind: 'terminal', known: true }));
    expect(view.result.current.focusedActive).toBe('3');
  });
});

const layoutHas = (layout: PaneLayout, id: string): boolean =>
  leaves(layout).some((l) => l.tabs.some((t) => t.id === id));

describe('following the server', () => {
  it('Another window opens a tab: it joins the focused pane without taking over', () => {
    save(twoPanes()); // focused p1 showing 2
    const view = mount();
    view.rerender(base({ tabs: list('1', '2', '3', '7') }));
    const layout = view.result.current.layout!;
    expect(tabIds(leafNamed(layout, 'p1'))).toEqual(['2', '7']);
    expect(leafNamed(layout, 'p1').active).toBe('2');
    expect(view.result.current.focusedActive).toBe('2');
  });

  it("a closed tab's pane disappears and the neighbour takes the space", () => {
    save(twoPanes());
    const view = mount();
    view.rerender(base({ tabs: list('1', '3') })); // 2 closed elsewhere: it was all of p1
    const layout = view.result.current.layout!;
    expect(leaves(layout).map((l) => l.id)).toEqual(['p0']);
    expect(layout.focused).toBe('p0'); // p1 was focused and went
    expect(view.result.current.focusedActive).toBe('1');
  });

  it("Close the active tab: the previous broadcast's order picks the left neighbour in that pane", () => {
    const saved = splitPane(
      singleLeaf(refs('1', '2', '3', '4'), '4'),
      'p0',
      'right',
      ref('2'),
      ORDER,
    );
    save(focusLeaf(activate(saved, 'p0', '4'), 'p0')); // p0 holds 1, 3, 4 showing 4; p1 holds 2
    const view = mount({ tabs: list('1', '2', '3', '4') });
    expect(view.result.current.focusedActive).toBe('4');
    view.rerender(base({ tabs: list('1', '2', '3') }));
    expect(leafNamed(view.result.current.layout, 'p0').active).toBe('3');
    expect(leafNamed(view.result.current.layout, 'p1').active).toBe('2');
  });

  it('A recycled id: an id that came back as another kind leaves its pane and joins the focused one', () => {
    const saved = singleLeaf([ref('1'), ref('2', 'editor')], '1');
    save(saved);
    const view = mount({
      tabs: [
        { id: '1', kind: 'terminal' },
        { id: '2', kind: 'editor' },
      ],
    });
    expect(leafNamed(view.result.current.layout, 'p0').tabs).toContainEqual(ref('2', 'editor'));
    view.rerender(base({ tabs: list('1', '2') })); // 2 is a terminal now
    expect(leafNamed(view.result.current.layout, 'p0').tabs).toEqual(refs('1', '2'));
  });

  it('a title broadcast changes neither the layout object nor the saved layout', () => {
    save(twoPanes());
    const view = mount();
    const before = view.result.current.layout;
    const writes = store.calls.set;
    view.rerender(base({ tabs: list('1', '2', '3').map((t) => ({ ...t, title: 'vim' })) }));
    expect(view.result.current.layout).toBe(before);
    expect(store.calls.set).toBe(writes);
  });

  // The window is on the New-tab page: another window's tab joins its strip and does not become
  // its selection, on the broadcast that brings it and on every one after it.
  it('an empty leaf gains a foreign tab without activating it, also on a second broadcast after an empty first one', () => {
    save(twoPanes());
    const view = mount();
    view.rerender(base({ tabs: [] }));
    expect(leaves(view.result.current.layout!)).toHaveLength(1);
    expect(view.result.current.focusedActive).toBeNull();
    view.rerender(base({ tabs: list('7') }));
    expect(tabIds(leaves(view.result.current.layout!)[0]!)).toEqual(['7']);
    expect(view.result.current.focusedActive).toBeNull();
    view.rerender(base({ tabs: list('7').map((t) => ({ ...t, title: 'vim' })) }));
    expect(view.result.current.focusedActive).toBeNull();
    view.rerender(base({ tabs: list('7', '8') }));
    expect(view.result.current.focusedActive).toBeNull();
    // choosing it is what shows it
    act(() => view.result.current.show({ id: '7', kind: 'terminal', known: true }));
    expect(view.result.current.focusedActive).toBe('7');
  });

  it('a broadcast that changes nothing costs one render', () => {
    save(twoPanes());
    let renders = 0;
    const view = renderHook(
      (props: UseEditorGroupsOptions) => {
        renders += 1;
        return useEditorGroups(props);
      },
      { initialProps: base() },
    );
    const before = view.result.current.layout;
    renders = 0;
    view.rerender(base({ tabs: list('1', '2', '3').map((t) => ({ ...t, title: 'vim' })) }));
    expect(renders).toBe(1);
    view.rerender(base({ tabs: list('1', '2', '3').map((t) => ({ ...t, title: 'less' })) }));
    expect(renders).toBe(2);
    expect(view.result.current.layout).toBe(before);
    // and a broadcast that does change it still lands
    view.rerender(base({ tabs: list('1', '3') }));
    expect(leaves(view.result.current.layout!).map((l) => l.id)).toEqual(['p0']);
  });
});

describe('show', () => {
  it('activates a tab where it is and focuses that pane', () => {
    save(twoPanes()); // focused p1
    const view = mount();
    act(() => view.result.current.show({ id: '3', kind: 'terminal', known: true }));
    expect(view.result.current.layout!.focused).toBe('p0');
    expect(leafNamed(view.result.current.layout, 'p0').active).toBe('3');
    expect(view.result.current.focusedActive).toBe('3');
  });

  it('adds a tab no pane holds to the focused pane as its active tab', () => {
    save(twoPanes());
    const view = mount();
    act(() => view.result.current.show({ id: '8', kind: 'editor', known: true }));
    expect(leafNamed(view.result.current.layout, 'p1').tabs).toContainEqual(ref('8', 'editor'));
    expect(view.result.current.focusedActive).toBe('8');
  });

  it('a new terminal id survives a broadcast that lacks it, and stays after one that lists it', () => {
    save(twoPanes());
    const view = mount();
    act(() => view.result.current.show({ id: '5', kind: 'terminal', known: false }));
    expect(view.result.current.pending.has('5')).toBe(true);
    expect(view.result.current.focusedActive).toBe('5');

    view.rerender(base({ tabs: list('1', '2', '3').map((t) => ({ ...t, title: 'x' })) }));
    expect(layoutHas(view.result.current.layout!, '5')).toBe(true);
    expect(view.result.current.focusedActive).toBe('5');

    view.rerender(base({ tabs: list('1', '2', '3', '5') }));
    expect(layoutHas(view.result.current.layout!, '5')).toBe(true);
    expect(view.result.current.pending.has('5')).toBe(false); // listed: pending no more
    expect(view.result.current.focusedActive).toBe('5');

    // and once listed it is an ordinary tab: when it dies it goes
    view.rerender(base({ tabs: list('1', '2', '3') }));
    expect(layoutHas(view.result.current.layout!, '5')).toBe(false);
  });

  it('a known editor id never enters pending', () => {
    const view = mount({ tabs: [...list('1', '2'), { id: '9', kind: 'editor' }] });
    act(() => view.result.current.show({ id: '9', kind: 'editor', known: true }));
    expect(view.result.current.pending.size).toBe(0);
    expect(view.result.current.focusedActive).toBe('9');
  });

  it('keeps a pending id a caller added itself (a lone-tab split)', () => {
    const view = mount();
    const layout = view.result.current.layout!;
    view.result.current.pending.add('6');
    act(() =>
      view.result.current.commit(splitPane(layout, 'p0', 'right', ref('6'), ['1', '2', '3'])),
    );
    view.rerender(base({ tabs: list('1', '2', '3').map((t) => ({ ...t, title: 'x' })) }));
    expect(layoutHas(view.result.current.layout!, '6')).toBe(true);
  });

  it('ignores an empty id (the chooser has none)', () => {
    const view = mount();
    const before = view.result.current.layout;
    act(() => view.result.current.show({ id: '', kind: 'terminal', known: false }));
    expect(view.result.current.layout).toBe(before);
    expect(view.result.current.pending.size).toBe(0);
  });

  it('is saved', () => {
    save(twoPanes());
    const view = mount();
    act(() => view.result.current.show({ id: '3', kind: 'terminal', known: true }));
    expect(store.saved()).toMatchObject({ focused: 'p0' });
  });

  it('Focus is the window selection: focusedActive follows what was shown last', () => {
    save(twoPanes());
    const view = mount();
    act(() => view.result.current.show({ id: '1', kind: 'terminal', known: true }));
    expect(view.result.current.focusedActive).toBe('1');
    act(() => view.result.current.show({ id: '2', kind: 'terminal', known: true }));
    expect(view.result.current.focusedActive).toBe('2');
  });
});

describe('commit and setLive', () => {
  it('commit replaces the layout and saves it', () => {
    const view = mount();
    const split = splitPane(view.result.current.layout!, 'p0', 'right', ref('2'), ['1', '2', '3']);
    act(() => view.result.current.commit(split));
    expect(view.result.current.layout).toBe(split);
    expect(store.saved()).toEqual(split);
    expect(view.result.current.rects.size).toBe(2);
    expect(view.result.current.sashes).toHaveLength(1);
  });

  it('setLive draws without saving, and the commit that follows saves once', () => {
    save(twoPanes());
    const view = mount();
    const writes = store.calls.set;
    const start = view.result.current.layout!;
    const during = resizeSash(start, [], 0, 0.2);
    act(() => view.result.current.setLive(during));
    expect(view.result.current.layout).toBe(during);
    expect(view.result.current.rects.get('p0')?.width).toBe(70);
    expect(store.calls.set).toBe(writes);

    const further = resizeSash(start, [], 0, 0.3);
    act(() => view.result.current.setLive(further));
    expect(store.calls.set).toBe(writes);

    act(() => view.result.current.commit(further));
    expect(store.calls.set).toBe(writes + 1);
    expect(store.saved()).toEqual(further);
  });

  it('committing the layout already being drawn still ends the drag and saves it', () => {
    save(twoPanes());
    const view = mount();
    const writes = store.calls.set;
    const live = resizeSash(view.result.current.layout!, [], 0, 0.2);
    act(() => view.result.current.setLive(live));
    act(() => view.result.current.commit(live));
    expect(store.calls.set).toBe(writes + 1);
  });

  // A sash drag resizes the layout it captured at pointerdown. A broadcast mid-drag must not be
  // undone by it: a dead tab's pane would come back with that tab active, and a terminal pane
  // for a dead id spawns a shell for it.
  it('a setLive from a layout captured before a broadcast does not bring a dead tab back', () => {
    save(twoPanes()); // p0: 1, 3   p1: 2
    const view = mount();
    const startLayout = view.result.current.layout!;
    view.rerender(base({ tabs: list('1', '3') })); // 2 closed in another window
    act(() => view.result.current.setLive(resizeSash(startLayout, [], 0, 0.1)));
    const layout = view.result.current.layout!;
    expect(leaves(layout).map((l) => l.id)).toEqual(['p0']);
    expect(leaves(layout).flatMap(tabIds)).not.toContain('2');
    expect(view.result.current.focusedActive).toBe('1');
  });

  it('a commit from a layout captured before a broadcast does not bring a dead tab back', () => {
    save(twoPanes());
    const view = mount();
    const startLayout = view.result.current.layout!;
    view.rerender(base({ tabs: list('1', '3', '7') })); // 2 closed, 7 opened elsewhere
    act(() => view.result.current.commit(resizeSash(startLayout, [], 0, 0.1)));
    const layout = view.result.current.layout!;
    expect(leaves(layout).map((l) => l.id)).toEqual(['p0']);
    expect(leaves(layout).flatMap(tabIds)).toEqual(['1', '3', '7']);
    expect(view.result.current.focusedActive).toBe('1');
    expect(JSON.stringify(store.saved())).not.toContain('"2"');
  });

  it('a commit keeps a pending id that the list does not hold yet', () => {
    const view = mount();
    view.result.current.pending.add('6');
    const split = splitPane(view.result.current.layout!, 'p0', 'right', ref('6'), ['1', '2', '3']);
    act(() => view.result.current.commit(split));
    expect(view.result.current.layout).toBe(split);
  });

  it('a layout committed as it already is saves nothing', () => {
    save(twoPanes());
    const view = mount();
    const writes = store.calls.set;
    act(() => view.result.current.commit(view.result.current.layout!));
    expect(store.calls.set).toBe(writes);
  });

  it('survives storage that throws', () => {
    store.storage.setItem = () => {
      throw new Error('quota');
    };
    store.storage.getItem = () => {
      throw new Error('denied');
    };
    const view = mount();
    expect(leaves(view.result.current.layout!)).toHaveLength(1);
    const split = splitPane(view.result.current.layout!, 'p0', 'right', ref('2'), ['1', '2', '3']);
    expect(() => act(() => view.result.current.commit(split))).not.toThrow();
    expect(view.result.current.layout).toBe(split);
    expect(view.result.current.hasSavedLayout()).toBe(false);
  });
});

describe('hasSavedLayout', () => {
  it('is false for a fresh window and for a corrupt value, true for a usable one', () => {
    expect(mount({ ready: false, tabs: [] }).result.current.hasSavedLayout()).toBe(false);
    save('{oops');
    expect(mount({ ready: false, tabs: [] }).result.current.hasSavedLayout()).toBe(false);
    save(twoPanes());
    expect(mount({ ready: false, tabs: [] }).result.current.hasSavedLayout()).toBe(true);
  });
});

describe('stripTabs', () => {
  it('Two strips: each pane lists only its own tabs', () => {
    const saved = splitPane(
      singleLeaf(refs('1', '2', '3', '4'), '1'),
      'p0',
      'right',
      ref('2'),
      ORDER,
    );
    save(saved); // p0: 1, 3, 4   p1: 2
    const view = mount({ tabs: list('1', '2', '3', '4') });
    expect(view.result.current.stripTabs('p0').map((t) => t.id)).toEqual(['1', '3', '4']);
    expect(view.result.current.stripTabs('p1').map((t) => t.id)).toEqual(['2']);
    expect(view.result.current.stripTabs('p9')).toEqual([]);
  });

  // The pane's own array is in the order tabs arrived in; the strip is the SERVER's order.
  it("lists them in the server's order, not the order they joined the pane", () => {
    save(singleLeaf(refs('6', '2'), '6'));
    const view = mount({ tabs: list('2', '4', '6') });
    expect(view.result.current.stripTabs('p0').map((t) => t.id)).toEqual(['2', '4', '6']);
    // 4 joined as a foreign tab, so it is listed too; a pane that did not hold it would not
    save(splitPane(singleLeaf(refs('6', '2', '4'), '6'), 'p0', 'right', ref('4'), ['2', '4', '6']));
    const split = mount({ tabs: list('2', '4', '6') });
    expect(split.result.current.stripTabs('p0').map((t) => t.id)).toEqual(['2', '6']);
  });

  it('keeps its identity while neither the pane nor the list changed', () => {
    save(twoPanes());
    const view = mount();
    const first = view.result.current.stripTabs('p0');
    // activating another tab in the pane replaces the pane object but not its tabs
    act(() => view.result.current.show({ id: '3', kind: 'terminal', known: true }));
    expect(view.result.current.stripTabs('p0')).toBe(first);
    expect(view.result.current.stripTabs('p1')).toBe(view.result.current.stripTabs('p1'));
  });

  it('is rebuilt when the list changes, and when the pane gains a tab', () => {
    save(twoPanes());
    const view = mount();
    const first = view.result.current.stripTabs('p0');
    view.rerender(base({ tabs: list('1', '2', '3').map((t) => ({ ...t, title: 'new' })) }));
    const afterTitle = view.result.current.stripTabs('p0');
    expect(afterTitle).not.toBe(first);
    expect(afterTitle.map((t) => t.title)).toEqual(['new', 'new']);
    view.rerender(base({ tabs: list('1', '2', '3', '7') }));
    // 7 joined the focused pane (p1), so p0's strip is the same tabs but the list is a new one
    expect(view.result.current.stripTabs('p1').map((t) => t.id)).toEqual(['2', '7']);
  });
});

describe('with groups disabled (the phone)', () => {
  it("A phone shows one pane holding every tab, showing the window's tab, and never touches storage", () => {
    save(splitPane(twoPanes(), 'p1', 'bottom', ref('3'), ORDER)); // three panes saved
    const calls = { ...store.calls };
    const view = mount({ enabled: false, sessionId: '2' });
    const layout = view.result.current.layout!;
    expect(leaves(layout)).toHaveLength(1);
    expect(tabIds(leaves(layout)[0]!)).toEqual(['1', '2', '3']);
    expect(view.result.current.focusedActive).toBe('2');
    expect(store.calls).toEqual(calls);
    expect(view.result.current.sashes).toEqual([]);
  });

  it('ignores the layout while groups are off: the window’s tab stays in view and the saved layout is unchanged', () => {
    const saved = twoPanes();
    save(saved);
    const before = store.data.get(LAYOUT_STORE_KEY);
    const view = mount({ enabled: false, sessionId: '3' });
    act(() => view.result.current.show({ id: '1', kind: 'terminal', known: true }));
    act(() => view.result.current.commit(singleLeaf(refs('9'), '9')));
    act(() => view.result.current.setLive(singleLeaf(refs('9'), '9')));
    view.rerender(base({ enabled: false, sessionId: '3', tabs: list('1', '2', '3', '4') }));
    expect(view.result.current.focusedActive).toBe('3');
    expect(store.data.get(LAYOUT_STORE_KEY)).toBe(before);
    expect(store.calls).toEqual({ get: 0, set: 0, remove: 0 });
    expect(view.result.current.pending.size).toBe(0);
  });

  it('draws an id the server has not listed as a terminal (a phone creating one)', () => {
    const view = mount({ enabled: false, sessionId: '7', tabs: list('1', '2') });
    const pane = leaves(view.result.current.layout!)[0]!;
    expect(pane.tabs).toContainEqual(ref('7'));
    expect(pane.active).toBe('7');
    expect(pane.id).toBe('p0');
  });

  it('shows nothing active for no selection', () => {
    const view = mount({ enabled: false, sessionId: '' });
    expect(view.result.current.focusedActive).toBeNull();
  });

  it("flipping to the mobile layer keeps the virtual pane's id equal to the focused pane's, so its terminal is not remounted", () => {
    save(twoPanes()); // focused p1
    const view = mount({ sessionId: '2' });
    expect(view.result.current.layout!.focused).toBe('p1');
    view.rerender(base({ enabled: false, sessionId: '2' }));
    expect(leaves(view.result.current.layout!).map((l) => l.id)).toEqual(['p1']);
    expect(view.result.current.focusedActive).toBe('2');
  });

  it("flipping back restores the saved layout and shows the window's tab in it", () => {
    save(twoPanes()); // p0: 1, 3   p1: 2 (focused)
    const view = mount({ sessionId: '2' });
    const saved = store.data.get(LAYOUT_STORE_KEY);
    view.rerender(base({ enabled: false, sessionId: '3' })); // the phone moved to tab 3
    expect(store.data.get(LAYOUT_STORE_KEY)).toBe(saved); // and wrote nothing
    view.rerender(base({ enabled: true, sessionId: '3' }));
    const layout = view.result.current.layout!;
    expect(leaves(layout).map((l) => l.id)).toEqual(['p0', 'p1']);
    // the old focused pane shows its own tab again; the pane holding 3 shows it, and is focused
    expect(leafNamed(layout, 'p1').active).toBe('2');
    expect(leafNamed(layout, 'p0').active).toBe('3');
    expect(layout.focused).toBe('p0');
    expect(view.result.current.focusedActive).toBe('3');
  });

  // A phone creates a terminal by selecting an id the server has not listed; its pane's attach
  // creates it. Turned back into a desktop before that broadcast, the id must survive one that
  // lacks it, or the pane about to create it unmounts.
  it('flipping back with a terminal the server has not listed yet keeps it, as pending', () => {
    save(twoPanes());
    const view = mount({ sessionId: '2' });
    view.rerender(base({ enabled: false, sessionId: '7' }));
    view.rerender(base({ enabled: true, sessionId: '7' }));
    expect(view.result.current.focusedActive).toBe('7');
    expect(view.result.current.pending.has('7')).toBe(true);

    view.rerender(
      base({ sessionId: '7', tabs: list('1', '2', '3').map((t) => ({ ...t, title: 'x' })) }),
    );
    expect(layoutHas(view.result.current.layout!, '7')).toBe(true);
    expect(view.result.current.focusedActive).toBe('7');

    view.rerender(base({ sessionId: '7', tabs: list('1', '2', '3', '7') }));
    expect(view.result.current.pending.has('7')).toBe(false); // listed: pending no more
    expect(view.result.current.focusedActive).toBe('7');
  });

  it('flipping back on a tab the server lists marks nothing pending', () => {
    save(twoPanes());
    const view = mount({ sessionId: '2' });
    view.rerender(base({ enabled: false, sessionId: '3' }));
    view.rerender(base({ enabled: true, sessionId: '3' }));
    expect(view.result.current.pending.size).toBe(0);
  });

  it("starting on a phone and turning groups on later opens one pane on the window's tab", () => {
    const view = mount({ enabled: false, sessionId: '3' });
    view.rerender(base({ enabled: true, sessionId: '3' }));
    expect(leaves(view.result.current.layout!)).toHaveLength(1);
    expect(view.result.current.focusedActive).toBe('3');
  });

  it('does not apply a stale boot selection when groups turn on later', () => {
    const view = mount({ enabled: false, sessionId: '3', bootSelection: '1' });
    view.rerender(base({ enabled: true, sessionId: '3', bootSelection: '1' }));
    expect(view.result.current.focusedActive).toBe('3');
  });
});

describe('windows', () => {
  it('Two windows keep their own layouts', () => {
    const windowOne = fakeStorage({ [LAYOUT_STORE_KEY]: JSON.stringify(twoPanes()) });
    const windowTwo = fakeStorage({
      [LAYOUT_STORE_KEY]: JSON.stringify(singleLeaf(refs('1', '2', '3'), '1')),
    });

    vi.stubGlobal('sessionStorage', windowTwo.storage);
    const reloaded = mount();
    expect(leaves(reloaded.result.current.layout!)).toHaveLength(1);
    reloaded.unmount();

    // window 2 reloaded; window 1 is untouched
    vi.stubGlobal('sessionStorage', windowOne.storage);
    const first = mount();
    expect(leaves(first.result.current.layout!)).toHaveLength(2);
    expect(windowOne.saved()).toEqual(twoPanes());
  });
});

describe('layoutKey', () => {
  it("is the main window's key for no window, and a per-window key for a detached one", () => {
    expect(layoutKey(null)).toBe(LAYOUT_STORE_KEY);
    expect(layoutKey('wq3k9x2m1a')).toBe('palmux-layout:wq3k9x2m1a');
  });
});

// A detached window is opened by `window.open`, which may copy the opener's `sessionStorage`, so a
// detached window that read `palmux-layout` would boot from the main window's panes.
describe('storageKey', () => {
  const KEY = layoutKey('wq3k9x2m1a');
  const own = (): unknown => JSON.parse(store.data.get(KEY) ?? 'null');

  it("never reads the main window's layout", () => {
    save(twoPanes());
    const view = mount({ storageKey: KEY });
    expect(leaves(view.result.current.layout!)).toHaveLength(1);
    expect(tabIds(leaves(view.result.current.layout!)[0]!)).toEqual(['1', '2', '3']);
  });

  it('restores the layout saved under its own key', () => {
    store.data.set(KEY, JSON.stringify(twoPanes()));
    const view = mount({ storageKey: KEY });
    expect(leaves(view.result.current.layout!)).toHaveLength(2);
    expect(view.result.current.layout!.focused).toBe('p1');
  });

  it("saves under its own key and leaves the main window's untouched", () => {
    save(twoPanes());
    const view = mount({ storageKey: KEY });
    const split = splitPane(view.result.current.layout!, 'p0', 'right', ref('2'), ORDER);
    act(() => view.result.current.commit(split));
    expect(own()).toEqual(split);
    expect(store.saved()).toEqual(twoPanes());
  });

  it('answers hasSavedLayout from its own key', () => {
    save(twoPanes()); // the main window's: not ours
    const view = mount({ ready: false, tabs: [], storageKey: KEY });
    expect(view.result.current.hasSavedLayout()).toBe(false);
    store.data.set(KEY, JSON.stringify(twoPanes()));
    expect(view.result.current.hasSavedLayout()).toBe(true);
  });

  it("defaults to the main window's key", () => {
    const view = mount();
    act(() => view.result.current.commit(singleLeaf(refs('1', '2', '3'), '2')));
    expect(store.saved()).not.toBeNull();
    expect(store.data.has(KEY)).toBe(false);
  });
});

// A tab dragged in from another window is not in this window's list until the server says so, so
// where it should LAND is parked and applied in the render where it first appears.
describe('place', () => {
  const four = list('1', '2', '3', '4');
  const withEditor = [...list('1', '2', '3'), { id: '4', kind: 'editor' } as TabMeta];

  it('centre: once listed, the tab moves into the target pane and is shown there', () => {
    save(twoPanes()); // p0 [1,3] showing 1; p1 [2] showing 2, focused
    const view = mount();
    act(() => view.result.current.place({ id: '4', leafId: 'p0', where: 'centre' }));
    view.rerender(base({ tabs: four }));
    const layout = view.result.current.layout!;
    expect(tabIds(leafNamed(layout, 'p0'))).toEqual(['1', '3', '4']);
    expect(leafNamed(layout, 'p0').active).toBe('4');
    expect(tabIds(leafNamed(layout, 'p1'))).toEqual(['2']);
    expect(layout.focused).toBe('p0');
    expect(view.result.current.focusedActive).toBe('4');
  });

  it('a side: once listed, the tab opens a pane on that side of the target, with its own kind, and takes focus', () => {
    save(twoPanes());
    const view = mount();
    act(() => view.result.current.place({ id: '4', leafId: 'p0', where: 'bottom' }));
    view.rerender(base({ tabs: withEditor }));
    const layout = view.result.current.layout!;
    expect(leaves(layout)).toHaveLength(3);
    const holder = leaves(layout).find((l) => l.tabs.some((t) => t.id === '4'))!;
    expect(holder.tabs).toEqual([{ id: '4', kind: 'editor' }]);
    expect(holder.active).toBe('4');
    expect(layout.focused).toBe(holder.id);
    // Below p0, in p0's own column, and p1 is as it was.
    const rects = view.result.current.rects;
    expect(rects.get(holder.id)!.left).toBe(rects.get('p0')!.left);
    expect(rects.get(holder.id)!.top).toBeGreaterThan(rects.get('p0')!.top);
    expect(tabIds(leafNamed(layout, 'p1'))).toEqual(['2']);
    expect(view.result.current.focusedActive).toBe('4');
  });

  it('applies to a tab that is already listed, on the next render', () => {
    save(twoPanes());
    const view = mount({ tabs: four }); // 4 joined the focused pane p1 at boot
    expect(tabIds(leafNamed(view.result.current.layout!, 'p1'))).toEqual(['2', '4']);
    act(() => view.result.current.place({ id: '4', leafId: 'p0', where: 'centre' }));
    expect(tabIds(leafNamed(view.result.current.layout!, 'p0'))).toEqual(['1', '3', '4']);
    expect(view.result.current.focusedActive).toBe('4');
  });

  it('waits for its tab: nothing changes, and another tab joining does not trigger it', () => {
    save(twoPanes());
    const view = mount();
    const before = view.result.current.layout;
    act(() => view.result.current.place({ id: '4', leafId: 'p0', where: 'right' }));
    expect(view.result.current.layout).toBe(before);
    view.rerender(base({ tabs: list('1', '2', '3', '9') }));
    expect(leaves(view.result.current.layout!)).toHaveLength(2);
    expect(tabIds(leafNamed(view.result.current.layout!, 'p1'))).toEqual(['2', '9']);
    view.rerender(base({ tabs: list('1', '2', '3', '9', '4') }));
    expect(leaves(view.result.current.layout!)).toHaveLength(3);
  });

  // The leaf can be gone by the time the tab arrives (its other tabs closed meanwhile).
  it('falls back to the focused pane when the target leaf is gone: centre', () => {
    save(twoPanes());
    const view = mount();
    act(() => view.result.current.place({ id: '4', leafId: 'p9', where: 'centre' }));
    view.rerender(base({ tabs: four }));
    const layout = view.result.current.layout!;
    expect(leaves(layout)).toHaveLength(2);
    expect(tabIds(leafNamed(layout, 'p1'))).toEqual(['2', '4']);
    expect(leafNamed(layout, 'p1').active).toBe('4');
    expect(view.result.current.focusedActive).toBe('4');
  });

  it('falls back to the focused pane when the target leaf is gone: a side', () => {
    save(twoPanes());
    const view = mount();
    act(() => view.result.current.place({ id: '4', leafId: 'p9', where: 'right' }));
    view.rerender(base({ tabs: four }));
    const layout = view.result.current.layout!;
    expect(leaves(layout)).toHaveLength(3);
    const holder = leaves(layout).find((l) => l.tabs.some((t) => t.id === '4'))!;
    expect(tabIds(holder)).toEqual(['4']);
    // Right of the focused pane p1, which is already the rightmost.
    const rects = view.result.current.rects;
    expect(rects.get(holder.id)!.left).toBeGreaterThan(rects.get('p1')!.left);
    expect(layout.focused).toBe(holder.id);
  });

  it('is applied once only: a later broadcast does not apply it again', () => {
    save(twoPanes());
    const view = mount();
    act(() => view.result.current.place({ id: '4', leafId: 'p0', where: 'right' }));
    view.rerender(base({ tabs: four }));
    expect(leaves(view.result.current.layout!)).toHaveLength(3);

    // The reader merges the new pane away again...
    const merged = moveTab(view.result.current.layout!, '4', 'p1', ['1', '2', '3', '4']);
    act(() => view.result.current.commit(merged));
    expect(leaves(view.result.current.layout!)).toHaveLength(2);

    // ...and a broadcast that changes the list (a rename) must not split it off again.
    view.rerender(base({ tabs: four.map((t) => ({ ...t, name: `t${t.id}` })) }));
    const layout = view.result.current.layout!;
    expect(leaves(layout)).toHaveLength(2);
    expect(tabIds(leafNamed(layout, 'p1'))).toContain('4');
  });

  // A drop that changes nothing (a pane's only tab on its own edge) is consumed all the same, or it
  // would wait for the next list change and fire on a layout the reader has since rearranged.
  it('is consumed even when applying it changes nothing', () => {
    save(twoPanes()); // p1 holds 2 alone
    const view = mount();
    act(() => view.result.current.place({ id: '2', leafId: 'p1', where: 'right' }));
    expect(leaves(view.result.current.layout!)).toHaveLength(2);

    act(() => view.result.current.commit(moveTab(view.result.current.layout!, '2', 'p0', ORDER)));
    expect(leaves(view.result.current.layout!)).toHaveLength(1);
    view.rerender(base({ tabs: list('1', '2', '3').map((t) => ({ ...t, name: `t${t.id}` })) }));
    expect(leaves(view.result.current.layout!)).toHaveLength(1);
  });

  it('is applied once only: the saved layout holds the result, not a pending move', () => {
    save(twoPanes());
    const view = mount();
    act(() => view.result.current.place({ id: '4', leafId: 'p0', where: 'centre' }));
    view.rerender(base({ tabs: four }));
    const saved = store.saved() as PaneLayout;
    expect(tabIds(leafNamed(saved, 'p0'))).toEqual(['1', '3', '4']);
    const writes = store.calls.set;
    view.rerender(base({ tabs: four.map((t) => ({ ...t })) }));
    expect(store.calls.set).toBe(writes);
  });
});

const sorted = (ids: string[]): string[] => ids.toSorted();

describe('heldTabIds', () => {
  it('before the first broadcast, reads the saved layout', () => {
    save(twoPanes());
    const view = mount({ ready: false, tabs: [] });
    expect(sorted(view.result.current.heldTabIds())).toEqual(['1', '2', '3']);
  });

  it('before the first broadcast and with nothing usable saved, is empty', () => {
    expect(mount({ ready: false, tabs: [] }).result.current.heldTabIds()).toEqual([]);
    save('{oops');
    expect(mount({ ready: false, tabs: [] }).result.current.heldTabIds()).toEqual([]);
  });

  it('reads the key it was given', () => {
    const KEY = layoutKey('wq3k9x2m1a');
    save(twoPanes()); // the main window's: not ours
    store.data.set(KEY, JSON.stringify(singleLeaf(refs('2'), '2')));
    const view = mount({ ready: false, tabs: [], storageKey: KEY });
    expect(view.result.current.heldTabIds()).toEqual(['2']);
  });

  it('once held, answers the held layout and not the saved one', () => {
    // Nothing can be saved, so the saved layout (the main one's, under this key) is stale on purpose.
    vi.stubGlobal('sessionStorage', {
      getItem: () => JSON.stringify(singleLeaf(refs('9'), '9')),
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {},
      clear: () => {},
    });
    const view = mount({ tabs: list('1', '2') });
    expect(view.result.current.layout).not.toBeNull();
    expect(sorted(view.result.current.heldTabIds())).toEqual(['1', '2']);
  });

  it('follows the server: a tab that closed is no longer held', () => {
    save(twoPanes());
    const view = mount();
    view.rerender(base({ tabs: list('1', '2') }));
    expect(sorted(view.result.current.heldTabIds())).toEqual(['1', '2']);
  });

  it('keeps answering while groups are disabled, from the layout kept as a memory', () => {
    save(twoPanes());
    const view = mount();
    view.rerender(base({ enabled: false }));
    expect(sorted(view.result.current.heldTabIds())).toEqual(['1', '2', '3']);
  });
});

describe('rects', () => {
  it('follow the layout in percent of the content area', () => {
    save(twoPanes());
    const view = mount();
    expect(view.result.current.rects.get('p0')).toEqual({
      left: 0,
      top: 0,
      width: 50,
      height: 100,
    });
    expect(view.result.current.rects.get('p1')).toEqual({
      left: 50,
      top: 0,
      width: 50,
      height: 100,
    });
  });
});
