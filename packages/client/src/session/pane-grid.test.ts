// The pane grid is pure, so every rule is pinned here against plain data: the recording
// sequence the owner asked for, VS Code's two ported rules (side → sibling-or-wrap, sibling
// collapse), and the reconcile that keeps a saved layout honest against the server's list.
//
// Layouts are built by hand with `leaf`/`row`/`col` so a collapse case names its shape, and
// `expectNormal` holds the invariants every operation must leave: siblings sum to 1, no branch
// of one child, no branch nested in a branch of its own orientation, focus on a real leaf.

import { describe, expect, it } from 'vitest';
import type { TabKind, TabMeta } from '@palmux/shared';
import {
  MIN_FRACTION,
  activate,
  addTab,
  firstInOrder,
  focusLeaf,
  layoutRects,
  leafOf,
  leaves,
  moveTab,
  parseLayout,
  reconcile,
  rectCss,
  removeLeaf,
  removeTab,
  resizeSash,
  singleLeaf,
  splitPane,
  type Orientation,
  type PaneLayout,
  type PaneLeaf,
  type PaneNode,
  type Rect,
  type TabRef,
} from './pane-grid';

const ref = (id: string, kind: TabKind = 'terminal'): TabRef => ({ id, kind });
const meta = (id: string, kind: TabKind = 'terminal'): TabMeta => ({ id, kind });
const refs = (...ids: string[]): TabRef[] => ids.map((id) => ref(id));
const metas = (...ids: string[]): TabMeta[] => ids.map((id) => meta(id));

const leaf = (id: string, tabs: string[], size = 1, active: string | null = tabs[0] ?? null) =>
  ({ type: 'leaf', id, tabs: refs(...tabs), active, size }) satisfies PaneLeaf;
const row = (size: number, ...children: PaneNode[]) =>
  ({ type: 'branch', orientation: 'row', children, size }) satisfies PaneNode;
const col = (size: number, ...children: PaneNode[]) =>
  ({ type: 'branch', orientation: 'column', children, size }) satisfies PaneNode;
const layoutOf = (root: PaneNode, focused = 'p0', nextId = 10): PaneLayout => ({
  v: 3,
  root,
  focused,
  nextId,
});

function expectNormalNode(node: PaneNode, parent: Orientation | null): void {
  expect(node.size).toBeGreaterThan(0);
  if (node.type === 'leaf') return;
  expect(node.children.length).toBeGreaterThanOrEqual(2);
  expect(node.orientation).not.toBe(parent);
  expect(node.children.reduce((sum, c) => sum + c.size, 0)).toBeCloseTo(1, 9);
  for (const c of node.children) expectNormalNode(c, node.orientation);
}

function expectNormal(layout: PaneLayout): void {
  expectNormalNode(layout.root, null);
  expect(layout.root.size).toBe(1);
  expect(leaves(layout).map((l) => l.id)).toContain(layout.focused);
}

const tabIds = (l: PaneLeaf): string[] => l.tabs.map((t) => t.id);
const leafById = (layout: PaneLayout, id: string): PaneLeaf => {
  const found = leaves(layout).find((l) => l.id === id);
  if (!found) throw new Error(`no leaf ${id}`);
  return found;
};
const rectOf = (layout: PaneLayout, id: string): Rect => {
  const r = layoutRects(layout).panes.get(id);
  if (!r) throw new Error(`no rect for ${id}`);
  return r;
};

const ORDER = ['1', '2', '3', '4', '5'];
const json = (v: unknown): string => JSON.stringify(v);

describe('reading a layout', () => {
  it('lists leaves depth first, left and top first', () => {
    const l = layoutOf(
      row(1, leaf('p0', ['1'], 0.5), col(0.5, leaf('p1', ['2'], 0.5), leaf('p2', ['3'], 0.5))),
    );
    expect(leaves(l).map((x) => x.id)).toEqual(['p0', 'p1', 'p2']);
  });

  it('finds the leaf holding a tab, or null', () => {
    const l = layoutOf(row(1, leaf('p0', ['1', '2'], 0.5), leaf('p1', ['3'], 0.5)));
    expect(leafOf(l, '3')?.id).toBe('p1');
    expect(leafOf(l, '2')?.id).toBe('p0');
    expect(leafOf(l, '9')).toBeNull();
  });
});

describe('singleLeaf', () => {
  it('holds every tab in one pane showing the given one', () => {
    const l = singleLeaf(refs('1', '2', '3'), '2');
    expect(leaves(l)).toHaveLength(1);
    expect(tabIds(leaves(l)[0]!)).toEqual(['1', '2', '3']);
    expect(leaves(l)[0]).toMatchObject({ id: 'p0', active: '2', size: 1 });
    expect(l).toMatchObject({ v: 3, focused: 'p0', nextId: 1 });
  });

  // A phone that creates a terminal selects an id the server has not broadcast: only the pane's
  // attach creates it, so the pane has to exist for it.
  it('appends an unknown active tab as a terminal (spawn on attach)', () => {
    const l = singleLeaf([ref('1', 'editor')], '7');
    expect(leaves(l)[0]!.tabs).toEqual([ref('1', 'editor'), ref('7', 'terminal')]);
    expect(leaves(l)[0]!.active).toBe('7');
  });

  it('treats an empty active as none', () => {
    const l = singleLeaf(refs('1'), '');
    expect(leaves(l)[0]!.active).toBeNull();
    expect(tabIds(leaves(l)[0]!)).toEqual(['1']);
  });

  it('keeps the given leaf id and mints above it', () => {
    const l = singleLeaf([], null, 'p5');
    expect(l.focused).toBe('p5');
    expect(l.nextId).toBe(6);
  });

  it("does not share the caller's tab objects", () => {
    const given = refs('1');
    expect(leaves(singleLeaf(given, '1'))[0]!.tabs[0]).not.toBe(given[0]);
  });
});

describe('rectCss', () => {
  it('writes percentages', () => {
    expect(rectCss({ left: 10, top: 20, width: 30, height: 40 })).toEqual({
      left: '10%',
      top: '20%',
      width: '30%',
      height: '40%',
    });
  });

  it('offsets the body below the strip with the token, never a number', () => {
    expect(rectCss({ left: 10, top: 20, width: 30, height: 40 }, true)).toEqual({
      left: '10%',
      top: 'calc(20% + var(--group-strip-h))',
      width: '30%',
      height: 'calc(40% - var(--group-strip-h))',
    });
  });
});

describe('splitPane', () => {
  // The owner's recording: one pane with five tabs; a tab dragged to the right edge; another
  // making three columns; a bottom-edge drop inside a column.
  describe('the recording sequence', () => {
    const first = splitPane(singleLeaf(refs(...ORDER), '1'), 'p0', 'right', ref('2'), ORDER);
    const second = splitPane(first, 'p1', 'right', ref('4'), ORDER);
    const third = splitPane(second, 'p2', 'bottom', ref('5'), ORDER);

    it('First split from one pane', () => {
      expect(leaves(first).map((l) => [l.id, tabIds(l)])).toEqual([
        ['p0', ['1', '3', '4', '5']],
        ['p1', ['2']],
      ]);
      expect(first.focused).toBe('p1');
      expect(leafById(first, 'p1').active).toBe('2');
      expect(leafById(first, 'p0').active).toBe('1');
      expect(rectOf(first, 'p0')).toEqual({ left: 0, top: 0, width: 50, height: 100 });
      expect(rectOf(first, 'p1')).toEqual({ left: 50, top: 0, width: 50, height: 100 });
      expectNormal(first);
    });

    it('makes a third column beside the second', () => {
      expect(layoutRects(second).panes).toEqual(
        new Map([
          ['p0', { left: 0, top: 0, width: 50, height: 100 }],
          ['p1', { left: 50, top: 0, width: 25, height: 100 }],
          ['p2', { left: 75, top: 0, width: 25, height: 100 }],
        ]),
      );
      expect(second.focused).toBe('p2');
      expectNormal(second);
    });

    it('puts a row inside the last column with a bottom drop', () => {
      expect(layoutRects(third).panes).toEqual(
        new Map([
          ['p0', { left: 0, top: 0, width: 50, height: 100 }],
          ['p1', { left: 50, top: 0, width: 25, height: 100 }],
          ['p2', { left: 75, top: 0, width: 25, height: 50 }],
          ['p3', { left: 75, top: 50, width: 25, height: 50 }],
        ]),
      );
      expect(layoutRects(third).sashes).toEqual([
        {
          path: [],
          index: 0,
          orientation: 'row',
          rect: { left: 50, top: 0, width: 0, height: 100 },
          branch: { left: 0, top: 0, width: 100, height: 100 },
        },
        {
          path: [],
          index: 1,
          orientation: 'row',
          rect: { left: 75, top: 0, width: 0, height: 100 },
          branch: { left: 0, top: 0, width: 100, height: 100 },
        },
        {
          path: [2],
          index: 0,
          orientation: 'column',
          rect: { left: 75, top: 50, width: 25, height: 0 },
          branch: { left: 75, top: 0, width: 25, height: 100 },
        },
      ]);
      expect(third.focused).toBe('p3');
      expect(leaves(third).map((l) => tabIds(l))).toEqual([['1', '3'], ['2'], ['4'], ['5']]);
      expect(third.nextId).toBe(4);
      expectNormal(third);
    });
  });

  it('inserts a sibling when the parent already runs that way, halving the target', () => {
    const l = layoutOf(row(1, leaf('p0', ['1', '2'], 0.6), leaf('p1', ['3'], 0.4)), 'p0', 2);
    const next = splitPane(l, 'p0', 'right', ref('2'), ['1', '2', '3']);
    expect(leaves(next).map((x) => [x.id, x.size])).toEqual([
      ['p0', 0.3],
      ['p2', 0.3],
      ['p1', 0.4],
    ]);
    expectNormal(next);
  });

  it('puts the new pane BEFORE the target for left and top', () => {
    // a single leaf root has no parent: the first split wraps
    const wrapped = splitPane(singleLeaf(refs('1', '2'), '1'), 'p0', 'left', ref('2'), ['1', '2']);
    expect(leaves(wrapped).map((x) => x.id)).toEqual(['p1', 'p0']);
    expect(rectOf(wrapped, 'p1')).toEqual({ left: 0, top: 0, width: 50, height: 100 });
    const top = splitPane(singleLeaf(refs('1', '2'), '1'), 'p0', 'top', ref('2'), ['1', '2']);
    expect(leaves(top).map((x) => x.id)).toEqual(['p1', 'p0']);
    expect(rectOf(top, 'p1')).toEqual({ left: 0, top: 0, width: 100, height: 50 });
  });

  it('A row inside a column: wraps the target when the parent runs the other way', () => {
    const l = layoutOf(row(1, leaf('p0', ['1', '3'], 0.5), leaf('p1', ['2', '4'], 0.5)), 'p0', 2);
    const next = splitPane(l, 'p1', 'bottom', ref('4'), ['1', '2', '3', '4']);
    expect(leaves(next).map((x) => [x.id, tabIds(x)])).toEqual([
      ['p0', ['1', '3']],
      ['p1', ['2']],
      ['p2', ['4']],
    ]);
    // the right column is a column of two, taking the old target's size; the left column is untouched
    const right = (next.root as Extract<PaneNode, { type: 'branch' }>).children[1]!;
    expect(right).toMatchObject({ type: 'branch', orientation: 'column', size: 0.5 });
    expect(rectOf(next, 'p1')).toEqual({ left: 50, top: 0, width: 50, height: 50 });
    expect(rectOf(next, 'p2')).toEqual({ left: 50, top: 50, width: 50, height: 50 });
    expect(leafById(next, 'p0')).toBe(leafById(l, 'p0'));
    expect(next.focused).toBe('p2');
    expectNormal(next);
  });

  it('wraps in a row for left/right when the parent is a column', () => {
    const l = layoutOf(col(1, leaf('p0', ['1'], 0.5), leaf('p1', ['2', '3'], 0.5)), 'p0', 2);
    const next = splitPane(l, 'p1', 'left', ref('3'), ['1', '2', '3']);
    expect(rectOf(next, 'p2')).toEqual({ left: 0, top: 50, width: 50, height: 50 });
    expect(rectOf(next, 'p1')).toEqual({ left: 50, top: 50, width: 50, height: 50 });
    expectNormal(next);
  });

  it('splits a deep pane without touching the rest of the tree', () => {
    const l = layoutOf(
      row(1, leaf('p0', ['1'], 0.5), col(0.5, leaf('p1', ['2'], 0.5), leaf('p2', ['3', '4'], 0.5))),
      'p0',
      3,
    );
    const next = splitPane(l, 'p2', 'bottom', ref('4'), ['1', '2', '3', '4']);
    // p2's parent is a column and the drop is a column: a sibling, not a wrap
    const column = (next.root as Extract<PaneNode, { type: 'branch' }>).children[1] as Extract<
      PaneNode,
      { type: 'branch' }
    >;
    expect(column.children.map((c) => [(c as PaneLeaf).id, c.size])).toEqual([
      ['p1', 0.5],
      ['p2', 0.25],
      ['p3', 0.25],
    ]);
    expect(leafById(next, 'p0')).toBe(leafById(l, 'p0'));
    expectNormal(next);
  });

  it("Dragging a pane's only tab to its own edge does nothing", () => {
    const l = layoutOf(row(1, leaf('p0', ['1'], 0.5), leaf('p1', ['2'], 0.5)), 'p0', 2);
    expect(splitPane(l, 'p1', 'right', ref('2'), ['1', '2'])).toBe(l);
    expect(splitPane(l, 'p1', 'top', ref('2'), ['1', '2'])).toBe(l);
    const one = singleLeaf(refs('1'), '1');
    expect(splitPane(one, 'p0', 'left', ref('1'), ['1'])).toBe(one);
  });

  it('splits a pane beside itself with one of several tabs, and the pane keeps the rest', () => {
    const l = singleLeaf(refs('1', '2', '3'), '2');
    const next = splitPane(l, 'p0', 'bottom', ref('2'), ['1', '2', '3']);
    expect(leaves(next).map((x) => [x.id, tabIds(x), x.active])).toEqual([
      ['p0', ['1', '3'], '1'],
      ['p1', ['2'], '2'],
    ]);
  });

  it('removes a source pane left empty and still splits next to the target', () => {
    const l = layoutOf(
      row(1, leaf('p0', ['1', '2'], 0.4), leaf('p1', ['3'], 0.3), leaf('p2', ['4'], 0.3)),
      'p0',
      3,
    );
    const next = splitPane(l, 'p0', 'right', ref('3'), ['1', '2', '3', '4']);
    expect(leaves(next).map((x) => [x.id, tabIds(x)])).toEqual([
      ['p0', ['1', '2']],
      ['p3', ['3']],
      ['p2', ['4']],
    ]);
    expect(next.nextId).toBe(4);
    expectNormal(next);
  });

  it('opens a pane for a tab no pane holds yet (a fresh terminal)', () => {
    const l = singleLeaf(refs('1'), '1');
    const next = splitPane(l, 'p0', 'right', ref('7'), ['1']);
    expect(leaves(next).map((x) => [x.id, tabIds(x)])).toEqual([
      ['p0', ['1']],
      ['p1', ['7']],
    ]);
    expect(next.focused).toBe('p1');
  });

  it('mints leaf ids in base 36 from the counter', () => {
    const l = { ...singleLeaf(refs('1', '2'), '1'), nextId: 35 };
    const next = splitPane(l, 'p0', 'right', ref('2'), ['1', '2']);
    expect(next.focused).toBe('pz');
    expect(next.nextId).toBe(36);
    expect(splitPane(next, 'pz', 'right', ref('1'), ['1', '2']).focused).toBe('p10');
  });

  it('answers the same layout for a target that does not exist', () => {
    const l = singleLeaf(refs('1', '2'), '1');
    expect(splitPane(l, 'p9', 'right', ref('2'), ['1', '2'])).toBe(l);
  });
});

describe('removeLeaf', () => {
  it('hands the room to its siblings in proportion to theirs', () => {
    const l = layoutOf(
      row(1, leaf('p0', ['1'], 0.2), leaf('p1', ['2'], 0.3), leaf('p2', ['3'], 0.5)),
    );
    const next = removeLeaf(l, 'p1');
    const [a, c] = leaves(next);
    expect(a!.size).toBeCloseTo(0.2 + 0.3 * (0.2 / 0.7), 12);
    expect(c!.size).toBeCloseTo(0.5 + 0.3 * (0.5 / 0.7), 12);
    expect(c!.size / a!.size).toBeCloseTo(2.5, 9);
    expectNormal(next);
  });

  it('Closing the last tab: the middle of three columns leaves two, the neighbours taking the width', () => {
    const l = layoutOf(
      row(1, leaf('p0', ['1'], 0.25), leaf('p1', ['2'], 0.5), leaf('p2', ['3'], 0.25)),
      'p0',
    );
    const next = removeTab(l, '2', ['1', '2', '3']);
    expect(leaves(next).map((x) => [x.id, x.size])).toEqual([
      ['p0', 0.5],
      ['p2', 0.5],
    ]);
    expectNormal(next);
  });

  it("replaces a branch left with one leaf by that leaf, which takes the branch's size", () => {
    const l = layoutOf(
      row(1, leaf('p0', ['1'], 0.5), col(0.5, leaf('p1', ['2'], 0.5), leaf('p2', ['3'], 0.5))),
    );
    const next = removeLeaf(l, 'p1');
    expect(next.root).toMatchObject({ type: 'branch', orientation: 'row' });
    expect(leaves(next).map((x) => [x.id, x.size])).toEqual([
      ['p0', 0.5],
      ['p2', 0.5],
    ]);
    expectNormal(next);
  });

  it('splices a same-orientation child branch into the grandparent, sizes scaled', () => {
    const l = layoutOf(
      row(
        1,
        leaf('p0', ['1'], 0.5),
        col(
          0.5,
          leaf('p1', ['2'], 0.25),
          row(0.75, leaf('p2', ['3'], 0.5), leaf('p3', ['4'], 0.5)),
        ),
      ),
    );
    const next = removeLeaf(l, 'p1');
    expect(leaves(next).map((x) => [x.id, x.size])).toEqual([
      ['p0', 0.5],
      ['p2', 0.25],
      ['p3', 0.25],
    ]);
    // spliced flat: the root row now holds three leaves
    expect((next.root as Extract<PaneNode, { type: 'branch' }>).children).toHaveLength(3);
    expectNormal(next);
  });

  it('collapses through several levels', () => {
    const l = layoutOf(
      row(
        1,
        leaf('p0', ['1'], 0.5),
        col(
          0.5,
          leaf('p1', ['2'], 0.5),
          row(
            0.5,
            leaf('p2', ['3'], 0.5),
            col(0.5, leaf('p3', ['4'], 0.5), leaf('p4', ['5'], 0.5)),
          ),
        ),
      ),
    );
    const next = removeLeaf(l, 'p1');
    const root = next.root as Extract<PaneNode, { type: 'branch' }>;
    expect(root.children.map((c) => c.size)).toEqual([0.5, 0.25, 0.25]);
    expect(root.children[2]).toMatchObject({ type: 'branch', orientation: 'column' });
    // a size is a fraction of the parent, so D and E keep their half of the column
    expect(leaves(next).map((x) => x.size)).toEqual([0.5, 0.25, 0.5, 0.5]);
    expect(rectOf(next, 'p3')).toEqual({ left: 75, top: 0, width: 25, height: 50 });
    expect(rectOf(next, 'p4')).toEqual({ left: 75, top: 50, width: 25, height: 50 });
    expectNormal(next);
  });

  it('promotes a lone leaf to root', () => {
    const l = layoutOf(col(1, leaf('p0', ['1'], 0.5), leaf('p1', ['2'], 0.5)));
    const next = removeLeaf(l, 'p0');
    expect(next.root).toMatchObject({ type: 'leaf', id: 'p1', size: 1 });
    expect(next.focused).toBe('p1');
  });

  it('promotes a lone branch child to root, taking the whole area', () => {
    const l = layoutOf(
      col(1, leaf('p0', ['1'], 0.5), row(0.5, leaf('p1', ['2'], 0.5), leaf('p2', ['3'], 0.5))),
    );
    const next = removeLeaf(l, 'p0');
    expect(next.root).toMatchObject({ type: 'branch', orientation: 'row', size: 1 });
    expect(rectOf(next, 'p1')).toEqual({ left: 0, top: 0, width: 50, height: 100 });
    expectNormal(next);
  });

  it('never removes the last pane', () => {
    const l = singleLeaf(refs('1'), '1');
    expect(removeLeaf(l, 'p0')).toBe(l);
  });

  it('answers the same layout for a pane that does not exist', () => {
    const l = layoutOf(row(1, leaf('p0', ['1'], 0.5), leaf('p1', ['2'], 0.5)));
    expect(removeLeaf(l, 'p9')).toBe(l);
  });

  describe('focus', () => {
    const three = () =>
      layoutOf(
        row(1, leaf('p0', ['1'], 0.3), leaf('p1', ['2'], 0.3), leaf('p2', ['3'], 0.4)),
        'p1',
      );

    it('removing a pane that is not focused keeps focus', () => {
      expect(removeLeaf(three(), 'p0').focused).toBe('p1');
      expect(removeLeaf(three(), 'p2').focused).toBe('p1');
    });

    it('removing the focused pane moves focus to the sibling after it', () => {
      expect(removeLeaf(three(), 'p1').focused).toBe('p2');
    });

    it('else to the one before it', () => {
      expect(removeLeaf({ ...three(), focused: 'p2' }, 'p2').focused).toBe('p1');
    });

    it('descending to the first pane of a sibling branch', () => {
      const l = layoutOf(
        row(1, leaf('p0', ['1'], 0.5), col(0.5, leaf('p1', ['2'], 0.5), leaf('p2', ['3'], 0.5))),
        'p0',
      );
      expect(removeLeaf(l, 'p0').focused).toBe('p1');
    });

    it('uses the sibling inside the same branch, not a cousin', () => {
      const l = layoutOf(
        row(1, leaf('p0', ['1'], 0.4), col(0.6, leaf('p1', ['2'], 0.5), leaf('p2', ['3'], 0.5))),
        'p2',
      );
      expect(removeLeaf(l, 'p2').focused).toBe('p1');
    });
  });
});

describe('removeTab', () => {
  it('only drops a tab that is not showing', () => {
    const l = layoutOf(row(1, leaf('p0', ['1', '2', '3'], 0.5, '1'), leaf('p1', ['4'], 0.5)));
    const next = removeTab(l, '2', ORDER);
    expect(tabIds(leafById(next, 'p0'))).toEqual(['1', '3']);
    expect(leafById(next, 'p0').active).toBe('1');
  });

  it('Close the active tab: activates its left neighbour in the pane and leaves the other pane alone', () => {
    const l = layoutOf(row(1, leaf('p0', ['1', '3', '4'], 0.5, '3'), leaf('p1', ['2'], 0.5)));
    const next = removeTab(l, '3', ORDER);
    expect(leafById(next, 'p0').active).toBe('1');
    expect(leafById(next, 'p1')).toBe(leafById(l, 'p1'));
  });

  it('else its right neighbour', () => {
    const l = singleLeaf(refs('1', '3', '4'), '1');
    expect(leaves(removeTab(l, '1', ORDER))[0]!.active).toBe('3');
  });

  // The neighbour is read from the strip, which is the SERVER's order filtered to the pane: a
  // tab appended to the pane last is not last in the strip.
  it('uses the server order, not the order the tabs were appended in', () => {
    const l = layoutOf(row(1, leaf('p0', ['6', '2'], 0.5, '6'), leaf('p1', ['4'], 0.5)), 'p0');
    expect(leafById(removeTab(l, '6', ['2', '4', '6']), 'p0').active).toBe('2');
    // and from the other side: 2 closing hands over to 6 only because 6 follows it in the order
    const m = layoutOf(row(1, leaf('p0', ['6', '2'], 0.5, '2'), leaf('p1', ['4'], 0.5)), 'p0');
    expect(leafById(removeTab(m, '2', ['2', '4', '6']), 'p0').active).toBe('6');
  });

  it("shows the pane's own first tab when the order lists none of the survivors", () => {
    const l = singleLeaf(refs('9', '8'), '9');
    expect(leaves(removeTab(l, '9', ['1']))[0]!.active).toBe('8');
  });

  it('Moving the last tab out: removes the pane with its last tab', () => {
    const l = layoutOf(row(1, leaf('p0', ['1'], 0.5), leaf('p1', ['2'], 0.5)), 'p1');
    const next = removeTab(l, '2', ['1', '2']);
    expect(leaves(next).map((x) => x.id)).toEqual(['p0']);
    expect(next.focused).toBe('p0');
  });

  it('keeps an empty last pane', () => {
    const l = singleLeaf(refs('1'), '1');
    const next = removeTab(l, '1', ['1']);
    expect(leaves(next)).toHaveLength(1);
    expect(leaves(next)[0]).toMatchObject({ id: 'p0', tabs: [], active: null });
  });

  it('answers the same layout for a tab no pane holds', () => {
    const l = singleLeaf(refs('1'), '1');
    expect(removeTab(l, '9', ['1'])).toBe(l);
  });
});

describe('moveTab', () => {
  const two = () =>
    layoutOf(row(1, leaf('p0', ['1', '3', '4'], 0.5, '3'), leaf('p1', ['2'], 0.5)), 'p0', 2);

  it("Centre drop: the tab leaves its pane and becomes the target's active tab, focused", () => {
    const next = moveTab(two(), '4', 'p1', ORDER);
    expect(tabIds(leafById(next, 'p0'))).toEqual(['1', '3']);
    expect(tabIds(leafById(next, 'p1'))).toEqual(['2', '4']);
    expect(leafById(next, 'p1').active).toBe('4');
    expect(leafById(next, 'p0').active).toBe('3');
    expect(next.focused).toBe('p1');
  });

  it('A tab is never in two panes', () => {
    const next = moveTab(two(), '4', 'p1', ORDER);
    expect(leaves(next).filter((l) => l.tabs.some((t) => t.id === '4'))).toHaveLength(1);
  });

  it('moving the active tab out hands the old pane its neighbour', () => {
    const next = moveTab(two(), '3', 'p1', ORDER);
    expect(leafById(next, 'p0').active).toBe('1');
    expect(leafById(next, 'p1').active).toBe('3');
  });

  it('Moving the last tab out: the pane disappears, the target fills the space and is focused', () => {
    const l = layoutOf(row(1, leaf('p0', ['1'], 0.5), leaf('p1', ['2'], 0.5)), 'p1');
    const next = moveTab(l, '2', 'p0', ['1', '2']);
    expect(leaves(next).map((x) => x.id)).toEqual(['p0']);
    expect(leaves(next)[0]).toMatchObject({ active: '2', size: 1 });
    expect(next.focused).toBe('p0');
    expect(tabIds(leaves(next)[0]!)).toEqual(['1', '2']);
    expectNormal(next);
  });

  it('a move to its own pane only activates and focuses it', () => {
    const l = { ...two(), focused: 'p1' };
    const next = moveTab(l, '4', 'p0', ORDER);
    expect(tabIds(leafById(next, 'p0'))).toEqual(['1', '3', '4']);
    expect(leafById(next, 'p0').active).toBe('4');
    expect(next.focused).toBe('p0');
    expect(next.root).not.toBe(l.root);
    expect(leafById(next, 'p1')).toBe(leafById(l, 'p1'));
  });

  it('is the same layout when nothing would change', () => {
    const l = two();
    expect(moveTab(l, '3', 'p0', ORDER)).toBe(l);
  });

  it('answers the same layout for an unknown tab or pane', () => {
    const l = two();
    expect(moveTab(l, '9', 'p1', ORDER)).toBe(l);
    expect(moveTab(l, '4', 'p9', ORDER)).toBe(l);
  });
});

describe('activate, focusLeaf and addTab', () => {
  const l = layoutOf(row(1, leaf('p0', ['1', '2'], 0.5, '1'), leaf('p1', ['3'], 0.5)), 'p0', 2);

  it('activate shows a held tab, and is the same layout when it already does or does not hold it', () => {
    expect(leafById(activate(l, 'p0', '2'), 'p0').active).toBe('2');
    expect(activate(l, 'p0', '1')).toBe(l);
    expect(activate(l, 'p0', '3')).toBe(l);
    expect(activate(l, 'p9', '1')).toBe(l);
  });

  it('focusLeaf is the same layout when focused already or the pane is unknown', () => {
    expect(focusLeaf(l, 'p1').focused).toBe('p1');
    expect(focusLeaf(l, 'p0')).toBe(l);
    expect(focusLeaf(l, 'p9')).toBe(l);
  });

  it('addTab appends, optionally active', () => {
    const inactive = addTab(l, 'p1', ref('7'), false);
    expect(tabIds(leafById(inactive, 'p1'))).toEqual(['3', '7']);
    expect(leafById(inactive, 'p1').active).toBe('3');
    expect(leafById(addTab(l, 'p1', ref('7'), true), 'p1').active).toBe('7');
  });

  it('addTab never puts a tab in two panes', () => {
    expect(addTab(l, 'p1', ref('1'), true)).toBe(l);
    expect(leafById(addTab(l, 'p0', ref('2'), true), 'p0').active).toBe('2');
    expect(addTab(l, 'p0', ref('2'), false)).toBe(l);
  });
});

describe('resizeSash', () => {
  const two = () => layoutOf(row(1, leaf('p0', ['1'], 0.5), leaf('p1', ['2'], 0.5)));

  it('moves the boundary by a fraction of the branch, keeping the sum', () => {
    const next = resizeSash(two(), [], 0, 0.2);
    expect(leaves(next).map((x) => x.size)).toEqual([0.7, 0.30000000000000004]);
    expectNormal(next);
  });

  it('clamps so neither pane goes below 0.15', () => {
    const grown = resizeSash(two(), [], 0, 0.9);
    expect(leaves(grown).map((x) => x.size)).toEqual([0.85, 0.15000000000000002]);
    const shrunk = resizeSash(two(), [], 0, -0.9);
    expect(leaves(shrunk)[0]!.size).toBe(MIN_FRACTION);
    expect(leaves(shrunk)[1]!.size).toBeCloseTo(0.85, 12);
    expectNormal(shrunk);
  });

  it('moves only the two siblings beside the sash', () => {
    const l = layoutOf(
      row(1, leaf('p0', ['1'], 0.2), leaf('p1', ['2'], 0.3), leaf('p2', ['3'], 0.5)),
    );
    const next = resizeSash(l, [], 1, 0.1);
    const [a, b, c] = leaves(next);
    expect(a!.size).toBe(0.2);
    expect(b!.size).toBeCloseTo(0.4, 12);
    expect(c!.size).toBeCloseTo(0.4, 12);
    expect(a).toBe(leaves(l)[0]);
  });

  it('resizes the branch at a path, in percent of THAT branch', () => {
    const l = layoutOf(
      row(1, leaf('p0', ['1'], 0.5), col(0.5, leaf('p1', ['2'], 0.5), leaf('p2', ['3'], 0.5))),
    );
    const next = resizeSash(l, [1], 0, 0.25);
    expect(rectOf(next, 'p1')).toEqual({ left: 50, top: 0, width: 50, height: 75 });
    expect(rectOf(next, 'p2')).toEqual({ left: 50, top: 75, width: 50, height: 25 });
    expect(leafById(next, 'p0')).toBe(leafById(l, 'p0'));
    expectNormal(next);
  });

  it('is the same layout when the clamp leaves nothing to move', () => {
    const l = layoutOf(row(1, leaf('p0', ['1'], 0.15), leaf('p1', ['2'], 0.85)));
    expect(resizeSash(l, [], 0, -0.1)).toBe(l);
    expect(resizeSash(two(), [], 0, 0)).toEqual(two());
    expect(resizeSash(l, [], 0, Number.NaN)).toBe(l);
  });

  // A split can leave a pane under the floor; a drag must not jump it UP to the floor, and may
  // only grow it.
  it('lets a pane already below the floor grow but not shrink, without a jump', () => {
    const l = layoutOf(row(1, leaf('p0', ['1'], 0.1), leaf('p1', ['2'], 0.9)));
    expect(resizeSash(l, [], 0, -0.05)).toBe(l);
    expect(leaves(resizeSash(l, [], 0, 0.1))[0]!.size).toBeCloseTo(0.2, 12);
    const tiny = layoutOf(
      row(
        1,
        leaf('p0', ['1'], 0.4),
        leaf('p1', ['2'], 0.1),
        leaf('p2', ['3'], 0.1),
        leaf('p3', ['4'], 0.4),
      ),
    );
    expect(resizeSash(tiny, [], 1, 0.05)).toBe(tiny);
    expect(resizeSash(tiny, [], 1, -0.05)).toBe(tiny);
  });

  it('answers the same layout for a path or sash that does not exist', () => {
    const l = two();
    expect(resizeSash(l, [0], 0, 0.1)).toBe(l);
    expect(resizeSash(l, [5], 0, 0.1)).toBe(l);
    expect(resizeSash(l, [], 1, 0.1)).toBe(l);
    expect(resizeSash(l, [], -1, 0.1)).toBe(l);
    const single = singleLeaf(refs('1'), '1');
    expect(resizeSash(single, [], 0, 0.1)).toBe(single);
  });
});

describe('layoutRects', () => {
  it('Three columns with a row inside one: four panes, each with its own rect', () => {
    const l = layoutOf(
      row(
        1,
        leaf('p0', ['1'], 0.25),
        col(0.5, leaf('p1', ['2'], 0.5), leaf('p2', ['3'], 0.5)),
        leaf('p3', ['4'], 0.25),
      ),
    );
    const { panes, sashes } = layoutRects(l);
    expect([...panes.entries()]).toEqual([
      ['p0', { left: 0, top: 0, width: 25, height: 100 }],
      ['p1', { left: 25, top: 0, width: 50, height: 50 }],
      ['p2', { left: 25, top: 50, width: 50, height: 50 }],
      ['p3', { left: 75, top: 0, width: 25, height: 100 }],
    ]);
    expect(sashes.map((s) => [s.path, s.index, s.orientation])).toEqual([
      [[], 0, 'row'],
      [[], 1, 'row'],
      [[1], 0, 'column'],
    ]);
    expect(leaves(l)).toHaveLength(4);
  });

  it('a single pane fills the area and has no sash', () => {
    const { panes, sashes } = layoutRects(singleLeaf(refs('1'), '1'));
    expect([...panes.entries()]).toEqual([['p0', { left: 0, top: 0, width: 100, height: 100 }]]);
    expect(sashes).toEqual([]);
  });

  it('tiles the area for sizes that are not exact binary fractions', () => {
    const third = 1 / 3;
    const l = layoutOf(
      row(1, leaf('p0', ['1'], third), leaf('p1', ['2'], third), leaf('p2', ['3'], third)),
    );
    const rects = [...layoutRects(l).panes.values()];
    expect(rects[0]!.width).toBeCloseTo(33.333333, 5);
    expect(rects[1]!.left).toBeCloseTo(rects[0]!.left + rects[0]!.width, 9);
    expect(rects[2]!.left + rects[2]!.width).toBeCloseTo(100, 9);
  });
});

describe('firstInOrder', () => {
  it("answers a pane's first tab in server order, an unlisted tab only when none is listed", () => {
    expect(firstInOrder(refs('9', '3', '2'), ['2', '1', '3'])).toBe('2');
    expect(firstInOrder(refs('9', '8'), ['2', '1'])).toBe('9');
    expect(firstInOrder([], ['2'])).toBeNull();
  });
});

describe('reconcile', () => {
  const none: ReadonlySet<string> = new Set();
  const two = () =>
    layoutOf(row(1, leaf('p0', ['1', '3', '4'], 0.5, '3'), leaf('p1', ['2'], 0.5)), 'p0', 2);
  const live = metas('1', '2', '3', '4');

  it('is the same layout when nothing changed, and a title broadcast stays one', () => {
    const l = two();
    expect(reconcile(l, live, ['1', '2', '3', '4'], none)).toBe(l);
    expect(reconcile(l, [...live], ['1', '2', '3', '4'], none)).toBe(l);
  });

  it('drops a tab the server no longer has', () => {
    const next = reconcile(two(), metas('1', '2', '3'), ['1', '2', '3', '4'], none);
    expect(tabIds(leafById(next, 'p0'))).toEqual(['1', '3']);
    expect(leafById(next, 'p0').active).toBe('3');
  });

  it('Close the active tab: another window closed it, the left neighbour in that pane takes over', () => {
    const next = reconcile(two(), metas('1', '2', '4'), ['1', '2', '3', '4'], none);
    expect(leafById(next, 'p0').active).toBe('1');
    expect(tabIds(leafById(next, 'p1'))).toEqual(['2']);
    expect(leafById(next, 'p1').active).toBe('2');
  });

  it('A recycled id: an editor entry for an id that is now a terminal is dropped and the terminal joins the focused pane', () => {
    const l = layoutOf(
      row(1, leaf('p0', ['1'], 0.5), {
        type: 'leaf',
        id: 'p1',
        tabs: [ref('3', 'editor')],
        active: '3',
        size: 0.5,
      }),
      'p0',
      2,
    );
    const next = reconcile(l, metas('1', '3'), ['1', '3'], none);
    expect(leaves(next).map((x) => [x.id, x.tabs])).toEqual([['p0', [ref('1'), ref('3')]]]);
    expect(leafById(next, 'p0').active).toBe('1');
    expect(next.focused).toBe('p0');
  });

  it('keeps a pending id the server has not listed yet', () => {
    const l = layoutOf(row(1, leaf('p0', ['1'], 0.5), leaf('p1', ['9'], 0.5)), 'p1', 2);
    const next = reconcile(l, metas('1'), ['1'], new Set(['9']));
    expect(next).toBe(l);
    // without it the pane goes
    expect(leaves(reconcile(l, metas('1'), ['1'], none))).toHaveLength(1);
  });

  it('a pending id takes the kind the broadcast states', () => {
    const l = layoutOf(row(1, leaf('p0', ['1'], 0.5), leaf('p1', ['9'], 0.5)), 'p1', 2);
    const next = reconcile(l, [meta('1'), meta('9', 'editor')], ['1'], new Set(['9']));
    expect(leafById(next, 'p1').tabs).toEqual([ref('9', 'editor')]);
    expect(leafById(next, 'p1').active).toBe('9');
  });

  it('a pending id of the same kind is left alone', () => {
    const l = layoutOf(row(1, leaf('p0', ['1'], 0.5), leaf('p1', ['9'], 0.5)), 'p1', 2);
    expect(reconcile(l, metas('1', '9'), ['1'], new Set(['9']))).toBe(l);
  });

  it('Another window opens a tab: it joins the focused pane without taking over', () => {
    const l = { ...two(), focused: 'p1' };
    const next = reconcile(l, metas('1', '2', '3', '4', '7'), ['1', '2', '3', '4'], none);
    expect(tabIds(leafById(next, 'p1'))).toEqual(['2', '7']);
    expect(leafById(next, 'p1').active).toBe('2');
    expect(next.focused).toBe('p1');
    expect(leafById(next, 'p0')).toBe(leafById(l, 'p0'));
  });

  it('adds several foreign tabs in server order', () => {
    const l = singleLeaf(refs('1'), '1');
    const next = reconcile(l, metas('5', '1', '4'), ['1'], none);
    expect(tabIds(leaves(next)[0]!)).toEqual(['1', '5', '4']);
    expect(leaves(next)[0]!.active).toBe('1');
  });

  it('removes a pane every tab of which is gone, and the neighbour takes the space', () => {
    const next = reconcile(two(), metas('1', '3', '4'), ['1', '2', '3', '4'], none);
    expect(leaves(next).map((x) => x.id)).toEqual(['p0']);
    expect(leaves(next)[0]!.size).toBe(1);
    // p1 was not focused: this window's focus does not move
    expect(next.focused).toBe('p0');
    expectNormal(next);
  });

  it('moves focus only when the focused pane is the one that went', () => {
    const l = { ...two(), focused: 'p1' };
    const next = reconcile(l, metas('1', '3', '4'), ['1', '2', '3', '4'], none);
    expect(next.focused).toBe('p0');
  });

  it('a non-focused pane whose active tab died at boot (no previous order) takes its first tab in server order', () => {
    const l = layoutOf(
      row(1, leaf('p0', ['1'], 0.5), leaf('p1', ['9', '3', '2'], 0.5, '9')),
      'p0',
      2,
    );
    const next = reconcile(l, metas('2', '1', '3'), [], none);
    // 9 is gone; the first of 3 and 2 in server order ['2', '1', '3'] is 2
    expect(tabIds(leafById(next, 'p1'))).toEqual(['3', '2']);
    expect(leafById(next, 'p1').active).toBe('2');
  });

  it('A saved terminal that is gone: its pane is removed during reconcile', () => {
    const l = layoutOf(row(1, leaf('p0', ['1', '2'], 0.5), leaf('p1', ['5'], 0.5)), 'p1', 2);
    const next = reconcile(l, metas('1', '2'), [], none);
    expect(leaves(next).map((x) => x.id)).toEqual(['p0']);
    expect(leaves(next).flatMap((x) => tabIds(x))).not.toContain('5');
    expect(next.focused).toBe('p0');
  });

  it('repairs a pane with tabs and no active tab, and one whose active is not among them', () => {
    const l = layoutOf(
      row(
        1,
        { ...leaf('p0', ['2', '1'], 0.5), active: null },
        { ...leaf('p1', ['3', '4'], 0.5), active: '9' },
      ),
      'p0',
      2,
    );
    const next = reconcile(l, metas('1', '2', '3', '4'), ['1', '2', '3', '4'], none);
    expect(leafById(next, 'p0').active).toBe('1');
    expect(leafById(next, 'p1').active).toBe('3');
  });

  it('an empty window keeps one empty pane', () => {
    const next = reconcile(two(), [], ['1', '2', '3', '4'], none);
    expect(leaves(next)).toHaveLength(1);
    expect(leaves(next)[0]).toMatchObject({ tabs: [], active: null, size: 1 });
    expect(reconcile(next, [], [], none)).toBe(next);
  });

  // The window is on the New-tab page: another window's tabs join its strip and do not become its
  // selection. Not keyed on the empty `prevOrder` the empty broadcast leaves behind, and not only
  // on the broadcast that brings the tab: a title broadcast after it must not take over either.
  it('an empty pane gains a foreign tab without activating it, also on a second broadcast after an empty first one', () => {
    const empty = reconcile(two(), [], ['1', '2', '3', '4'], none);
    const joined = reconcile(empty, metas('7'), [], none);
    expect(leaves(joined)[0]).toMatchObject({ tabs: [ref('7')], active: null });
    const titled = reconcile(joined, [{ ...meta('7'), title: 'vim' }], ['7'], none);
    expect(titled).toBe(joined);
    const another = reconcile(joined, metas('7', '8'), ['7'], none);
    expect(leaves(another)[0]).toMatchObject({ tabs: refs('7', '8'), active: null });
    // a window that emptied to the New-tab page on the same broadcast that brings a foreign tab
    const swapped = reconcile(singleLeaf(refs('1'), '1'), metas('7'), ['1'], none);
    expect(leaves(swapped)[0]).toMatchObject({ tabs: [ref('7')], active: null });
  });

  it('a lone pane that lost its active tab with only an unlisted pending tab left shows that tab', () => {
    // 5 is pending (no order lists it), so it is nobody's neighbour; the pane is not blank
    const l = singleLeaf(refs('2', '5'), '2');
    const next = reconcile(l, [], ['2'], new Set(['5']));
    expect(leaves(next)[0]).toMatchObject({ tabs: [ref('5')], active: '5' });
  });

  it('is idempotent', () => {
    const once = reconcile(two(), metas('1', '2', '7'), ['1', '2', '3', '4'], none);
    expect(reconcile(once, metas('1', '2', '7'), ['1', '2', '3', '4'], none)).toBe(once);
    expect(reconcile(once, metas('1', '2', '7'), ['1', '2', '7'], none)).toBe(once);
  });

  it('never creates a tab and never errors on a layout it cannot match', () => {
    const l = singleLeaf([], null);
    expect(reconcile(l, [], [], none)).toBe(l);
    const next = reconcile(singleLeaf(refs('1', '2', '3'), '2'), metas('9'), ['1', '2', '3'], none);
    expect(leaves(next).flatMap((x) => tabIds(x))).toEqual(['9']);
  });
});

describe('parseLayout', () => {
  const recording = () => {
    let l = singleLeaf(refs(...ORDER), '1');
    l = splitPane(l, 'p0', 'right', ref('2'), ORDER);
    l = splitPane(l, 'p1', 'right', ref('4'), ORDER);
    return splitPane(l, 'p2', 'bottom', ref('5'), ORDER);
  };
  const base = () =>
    json(layoutOf(row(1, leaf('p0', ['1'], 0.5), leaf('p1', ['2'], 0.5)), 'p0', 2));

  it('Reload restores: round-trips a layout exactly', () => {
    const l = recording();
    expect(parseLayout(JSON.stringify(l))).toEqual(l);
    const reviewed = layoutOf(leaf('p0', ['1'], 1), 'p0', 1);
    reviewed.root = { ...leaf('p0', [], 1), tabs: [ref('1', 'review')], active: '1' };
    expect(parseLayout(JSON.stringify(reviewed))).toEqual(reviewed);
  });

  it('answers null for nothing and for corrupt JSON', () => {
    expect(parseLayout(null)).toBeNull();
    expect(parseLayout('')).toBeNull();
    expect(parseLayout('{oops')).toBeNull();
    expect(parseLayout('[]')).toBeNull();
    expect(parseLayout('null')).toBeNull();
    expect(parseLayout('3')).toBeNull();
  });

  it('is a v3 blob only', () => {
    expect(parseLayout(base())).not.toBeNull();
    expect(parseLayout(base().replace('"v":3', '"v":2'))).toBeNull();
    expect(parseLayout(json({ root: leaf('p0', ['1']), focused: 'p0', nextId: 1 }))).toBeNull();
  });

  it('rejects a tab id in two panes, and twice in one', () => {
    expect(
      parseLayout(
        json(layoutOf(row(1, leaf('p0', ['1', '2'], 0.5), leaf('p1', ['2'], 0.5)), 'p0', 2)),
      ),
    ).toBeNull();
    expect(parseLayout(json(layoutOf(leaf('p0', ['1', '1'], 1), 'p0', 1)))).toBeNull();
  });

  it('rejects a bad size', () => {
    for (const bad of [0, -0.5, 'half', null]) {
      const l = layoutOf(
        row(1, { ...leaf('p0', ['1']), size: bad as number }, leaf('p1', ['2'], 0.5)),
        'p0',
        2,
      );
      expect(parseLayout(json(l)), String(bad)).toBeNull();
    }
    // NaN and Infinity do not survive JSON.stringify as numbers (they become null); a literal does
    expect(parseLayout(base().replace('"size":0.5', '"size":1e999'))).toBeNull();
  });

  it('rejects siblings that do not add up to the branch', () => {
    expect(
      parseLayout(json(layoutOf(row(1, leaf('p0', ['1'], 0.5), leaf('p1', ['2'], 0.3)), 'p0', 2))),
    ).toBeNull();
  });

  it('rejects a stale nextId', () => {
    expect(
      parseLayout(json(layoutOf(row(1, leaf('p0', ['1'], 0.5), leaf('p1', ['2'], 0.5)), 'p0', 1))),
    ).toBeNull();
    expect(
      parseLayout(json(layoutOf(row(1, leaf('p0', ['1'], 0.5), leaf('pz', ['2'], 0.5)), 'p0', 35))),
    ).toBeNull();
    expect(
      parseLayout(json(layoutOf(row(1, leaf('p0', ['1'], 0.5), leaf('pz', ['2'], 0.5)), 'p0', 36))),
    ).not.toBeNull();
    expect(parseLayout(base().replace('"nextId":2', '"nextId":2.5'))).toBeNull();
    expect(parseLayout(base().replace('"nextId":2', '"nextId":"2"'))).toBeNull();
  });

  it('rejects an active tab outside its pane', () => {
    const l = layoutOf(
      row(1, { ...leaf('p0', ['1']), size: 0.5, active: '2' }, leaf('p1', ['2'], 0.5)),
      'p0',
      2,
    );
    expect(parseLayout(json(l))).toBeNull();
    const nonString = layoutOf(
      row(1, { ...leaf('p0', ['1']), size: 0.5, active: 1 as never }, leaf('p1', ['2'], 0.5)),
      'p0',
      2,
    );
    expect(parseLayout(json(nonString))).toBeNull();
  });

  it('accepts a pane with tabs and no active tab, and an empty pane', () => {
    const l = layoutOf(leaf('p0', [], 1), 'p0', 1);
    expect(parseLayout(json(l))).toEqual(l);
    const none = layoutOf(
      row(1, { ...leaf('p0', ['1']), size: 0.5, active: null }, leaf('p1', ['2'], 0.5)),
      'p0',
      2,
    );
    expect(parseLayout(json(none))).toEqual(none);
  });

  it('rejects an unknown kind, an unknown node type and a focused id that is not a pane', () => {
    expect(parseLayout(base().replace('"kind":"terminal"', '"kind":"nope"'))).toBeNull();
    expect(parseLayout(base().replace('"type":"leaf"', '"type":"stem"'))).toBeNull();
    expect(parseLayout(base().replace('"focused":"p0"', '"focused":"p7"'))).toBeNull();
    expect(
      parseLayout(base().replace('"orientation":"row"', '"orientation":"diagonal"')),
    ).toBeNull();
  });

  it('rejects a branch of fewer than two children, a duplicate pane id and a pane id that was not minted', () => {
    expect(parseLayout(json(layoutOf(row(1, leaf('p0', ['1'], 1)), 'p0', 1)))).toBeNull();
    expect(
      parseLayout(json(layoutOf(row(1, leaf('p0', ['1'], 0.5), leaf('p0', ['2'], 0.5)), 'p0', 2))),
    ).toBeNull();
    expect(
      parseLayout(json(layoutOf(row(1, leaf('p0', ['1'], 0.5), leaf('q1', ['2'], 0.5)), 'p0', 9))),
    ).toBeNull();
  });

  it('drops keys it does not know', () => {
    const parsed = parseLayout(base().replace('"v":3', '"v":3,"extra":1'));
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!)).toEqual(['v', 'root', 'focused', 'nextId']);
  });
});
