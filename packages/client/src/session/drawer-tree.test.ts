// The drawer tree's model, ported from the DGSL TreeView's behaviour tests (the
// ones that apply: it has no keyboard, selection or HTML5 events here). The drop
// maths is held against the SAME `normalizeOrder` the server runs, so "the result
// is contiguous" is checked rather than assumed.

import { normalizeOrder } from '@palmux/shared';
import type { TabGroup, TabMeta } from '@palmux/shared';
import { describe, expect, it } from 'vitest';
import {
  accepts,
  ancestorsOf,
  buildNodes,
  dropAt,
  groupValue,
  ROOT_DROP,
  resolveDrop,
  siblingsOf,
  tabValue,
  toRows,
} from './drawer-tree';
import type { DrawerDrop, DrawerNode, DropResult } from './drawer-tree';
import { groupIdMap } from './tab-groups';

const tab = (id: string, groupId?: string): TabMeta => ({
  id,
  kind: 'terminal',
  ...(groupId ? { groupId } : {}),
});
const group = (id: string): TabGroup => ({ id, color: 'ansi1' });

const t = tabValue;
const g = groupValue;
const before = (target: string): DrawerDrop => ({ target, position: 'before' });
const after = (target: string): DrawerDrop => ({ target, position: 'after' });
const inside = (target: string): DrawerDrop => ({ target, position: 'inside' });

// 0, [gA: 1 2], 3, [gB: 4 5]
const TABS = [tab('0'), tab('1', 'gA'), tab('2', 'gA'), tab('3'), tab('4', 'gB'), tab('5', 'gB')];
const GROUPS = [group('gA'), group('gB')];
const ORDER = TABS.map((x) => x.id);
const nodes = buildNodes(TABS, GROUPS);
const groupOf = groupIdMap(TABS);

// Every tab grouped, so no top-level row exists to drop beside.
const ALL_TABS = [tab('0', 'gA'), tab('1', 'gA'), tab('2', 'gB')];
const ALL_GROUPS = [group('gA'), group('gB')];
const allNodes = buildNodes(ALL_TABS, ALL_GROUPS);
const allGroupOf = groupIdMap(ALL_TABS);

const drop = (dragged: string, to: DrawerDrop) => resolveDrop(ORDER, groupOf, dragged, to);

describe('buildNodes', () => {
  it('puts a group where its first member sits and lists its members in full order', () => {
    expect(nodes.map((n) => n.value)).toEqual([t('0'), g('gA'), t('3'), g('gB')]);
    expect(nodes[1]?.children?.map((n) => n.value)).toEqual([t('1'), t('2')]);
    expect(nodes[0]?.children).toBeUndefined();
  });

  it('keeps a group at its first member when the members are not adjacent', () => {
    const scattered = buildNodes([tab('0', 'gA'), tab('1'), tab('2', 'gA')], [group('gA')]);
    expect(scattered.map((n) => n.value)).toEqual([g('gA'), t('1')]);
    expect(scattered[0]?.children?.map((n) => n.value)).toEqual([t('0'), t('2')]);
  });

  it('draws a tab whose group is not listed as a top-level leaf, as the strip does', () => {
    expect(buildNodes([tab('0', 'gGone'), tab('1')], []).map((n) => n.value)).toEqual([
      t('0'),
      t('1'),
    ]);
  });

  it('draws nothing for no tabs, and no header for a listed group that has no members', () => {
    expect(buildNodes([], [])).toEqual([]);
    expect(buildNodes([], [group('gA')])).toEqual([]);
    // The strip is tab-driven too: a header exists only where a member does.
    expect(buildNodes([tab('0')], [group('gA')]).map((n) => n.value)).toEqual([t('0')]);
  });
});

describe('ancestorsOf and siblingsOf', () => {
  it('names the nodes above a value, nearest last', () => {
    expect(ancestorsOf(nodes, t('2'))).toEqual([g('gA')]);
    expect(ancestorsOf(nodes, t('3'))).toEqual([]);
    expect(ancestorsOf(nodes, g('gA'))).toEqual([]);
    expect(ancestorsOf(nodes, t('nope'))).toEqual([]);
  });

  it('lists the values at a value level, itself included', () => {
    expect(siblingsOf(nodes, t('2'))).toEqual([t('1'), t('2')]);
    expect(siblingsOf(nodes, g('gB'))).toEqual([t('0'), g('gA'), t('3'), g('gB')]);
    expect(siblingsOf(nodes, t('nope'))).toEqual([]);
  });
});

describe('toRows', () => {
  it('hides a closed group’s members', () => {
    const rows = toRows(nodes, new Set());
    expect(rows.map((r) => r.key)).toEqual([t('0'), g('gA'), t('3'), g('gB')]);
  });

  it('shows the members of an open group right after it, one level down', () => {
    const rows = toRows(nodes, new Set([g('gA')]));
    expect(rows.map((r) => r.key)).toEqual([t('0'), g('gA'), t('1'), t('2'), t('3'), g('gB')]);
    const member = rows.find((r) => r.key === t('2'));
    expect(member).toMatchObject({ level: 1, parent: g('gA'), position: 2, siblings: 2 });
    expect(rows.find((r) => r.key === t('3'))).toMatchObject({
      level: 0,
      parent: null,
      position: 3,
      siblings: 4,
    });
  });

  it('draws nothing for an empty tree', () => {
    expect(toRows([], new Set())).toEqual([]);
  });

  it('reads `expanded` as node values: a bare group id opens nothing', () => {
    // The drawer's collapsed set holds bare group ids; passing one through unconverted
    // must not silently open (or close) anything, so the contract is pinned here.
    expect(toRows(nodes, new Set(['gA'])).map((r) => r.key)).toEqual([
      t('0'),
      g('gA'),
      t('3'),
      g('gB'),
    ]);
  });

  it('ignores expanded values that are tabs or not in the tree', () => {
    const rows = toRows(nodes, new Set([t('0'), t('1'), g('gGone')]));
    expect(rows.map((r) => r.key)).toEqual([t('0'), g('gA'), t('3'), g('gB')]);
  });

  it('opens several groups at once and keys every row by its node value, uniquely', () => {
    const rows = toRows(nodes, new Set([g('gA'), g('gB')]));
    expect(rows.map((r) => r.key)).toEqual([
      t('0'),
      g('gA'),
      t('1'),
      t('2'),
      t('3'),
      g('gB'),
      t('4'),
      t('5'),
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(rows.every((r) => r.node.value === r.key)).toBe(true);
  });
});

describe('dropAt', () => {
  const rect = { top: 100, height: 40 };

  it('splits a tab row in halves: before above the middle, after from it down', () => {
    expect(dropAt(rect, 101, t('3'), false)).toEqual(before(t('3')));
    expect(dropAt(rect, 119, t('3'), false)).toEqual(before(t('3')));
    expect(dropAt(rect, 120, t('3'), false)).toEqual(after(t('3')));
    expect(dropAt(rect, 139, t('3'), false)).toEqual(after(t('3')));
  });

  it('splits a group header in quarters: before, inside for the middle half, after', () => {
    expect(dropAt(rect, 105, g('gA'), true)).toEqual(before(g('gA')));
    expect(dropAt(rect, 110, g('gA'), true)).toEqual(inside(g('gA'))); // the quarter's edge is inside
    expect(dropAt(rect, 120, g('gA'), true)).toEqual(inside(g('gA')));
    expect(dropAt(rect, 130, g('gA'), true)).toEqual(inside(g('gA')));
    expect(dropAt(rect, 135, g('gA'), true)).toEqual(after(g('gA')));
  });

  it('puts the header’s quarter edges at a quarter and three quarters of its height', () => {
    // 40px tall: the edges are y=10 and y=30. Pinning the middle of each zone alone
    // would let a fifth or a third pass for a quarter.
    expect(dropAt(rect, 109.9, g('gA'), true)).toEqual(before(g('gA')));
    expect(dropAt(rect, 110, g('gA'), true)).toEqual(inside(g('gA')));
    expect(dropAt(rect, 130, g('gA'), true)).toEqual(inside(g('gA')));
    expect(dropAt(rect, 130.1, g('gA'), true)).toEqual(after(g('gA')));
    // And the same on a row that is not 40px, where the edges are not whole numbers.
    const row = { top: 0, height: 30 };
    expect(dropAt(row, 7.4, g('gA'), true)).toEqual(before(g('gA')));
    expect(dropAt(row, 7.5, g('gA'), true)).toEqual(inside(g('gA')));
    expect(dropAt(row, 22.5, g('gA'), true)).toEqual(inside(g('gA')));
    expect(dropAt(row, 22.6, g('gA'), true)).toEqual(after(g('gA')));
  });

  it('answers before or after, never inside, for a pointer past the row', () => {
    // The lifted row follows the finger and the list scrolls under it, so the row
    // measured can sit wholly above or below the pointer.
    expect(dropAt(rect, 20, t('3'), false)).toEqual(before(t('3')));
    expect(dropAt(rect, 400, t('3'), false)).toEqual(after(t('3')));
    expect(dropAt(rect, 20, g('gA'), true)).toEqual(before(g('gA')));
    expect(dropAt(rect, 400, g('gA'), true)).toEqual(after(g('gA')));
  });

  it('measures from the row’s own top, not from the page’s', () => {
    expect(dropAt({ top: 600, height: 40 }, 605, t('3'), false)).toEqual(before(t('3')));
    expect(dropAt({ top: 600, height: 40 }, 635, t('3'), false)).toEqual(after(t('3')));
    expect(dropAt({ top: 600, height: 40 }, 620, g('gA'), true)).toEqual(inside(g('gA')));
  });
});

describe('accepts', () => {
  it('refuses a drop on itself', () => {
    expect(accepts(nodes, t('3'), before(t('3')))).toBe(false);
    expect(accepts(nodes, t('3'), after(t('3')))).toBe(false);
    expect(accepts(nodes, g('gA'), before(g('gA')))).toBe(false);
    expect(accepts(nodes, g('gA'), inside(g('gA')))).toBe(false);
  });

  it('refuses a group into itself or beside its own members', () => {
    expect(accepts(nodes, g('gA'), before(t('1')))).toBe(false);
    expect(accepts(nodes, g('gA'), after(t('2')))).toBe(false);
  });

  it('refuses a group inside a group, whatever the target, and a group beside a member', () => {
    expect(accepts(nodes, g('gA'), inside(g('gB')))).toBe(false);
    expect(accepts(nodes, g('gA'), before(t('4')))).toBe(false);
    expect(accepts(nodes, g('gA'), after(t('5')))).toBe(false);
  });

  it('refuses a drop inside a tab: a tab holds nothing', () => {
    expect(accepts(nodes, t('0'), inside(t('3')))).toBe(false);
    expect(accepts(nodes, t('1'), inside(t('3')))).toBe(false);
  });

  it('refuses the place a node already holds', () => {
    // 0 precedes gA; 3 follows it.
    expect(accepts(nodes, t('0'), before(g('gA')))).toBe(false);
    expect(accepts(nodes, t('3'), after(g('gA')))).toBe(false);
    expect(accepts(nodes, t('0'), after(g('gB')))).toBe(true);
    // 1 and 2 are neighbours inside gA.
    expect(accepts(nodes, t('1'), before(t('2')))).toBe(false);
    expect(accepts(nodes, t('2'), after(t('1')))).toBe(false);
    // The LAST member inside its own group, the LAST top-level node on the root.
    expect(accepts(nodes, t('2'), inside(g('gA')))).toBe(false);
    expect(accepts(nodes, g('gB'), ROOT_DROP)).toBe(false);
    // Groups are siblings of top-level tabs: gA sits between 0 and 3.
    expect(accepts(nodes, g('gA'), before(t('3')))).toBe(false);
    expect(accepts(nodes, g('gA'), after(t('0')))).toBe(false);
  });

  it('accepts the quarters and the middle of a header, a gap between rows and the root', () => {
    expect(accepts(nodes, t('0'), inside(g('gA')))).toBe(true);
    expect(accepts(nodes, t('1'), inside(g('gB')))).toBe(true);
    expect(accepts(nodes, t('3'), before(t('2')))).toBe(true);
    expect(accepts(nodes, t('1'), after(t('0')))).toBe(true);
    expect(accepts(nodes, t('1'), before(g('gA')))).toBe(true); // leave, land before its own block
    expect(accepts(nodes, t('1'), ROOT_DROP)).toBe(true);
    expect(accepts(nodes, g('gA'), after(g('gB')))).toBe(true);
    expect(accepts(nodes, g('gB'), before(t('0')))).toBe(true);
  });

  it('refuses a node or a target that left the tree while the drag was in flight', () => {
    expect(accepts(nodes, t('9'), before(t('0')))).toBe(false);
    expect(accepts(nodes, t('0'), before(t('9')))).toBe(false);
    expect(accepts(nodes, t('0'), inside(g('gGone')))).toBe(false);
    expect(accepts(nodes, t('9'), ROOT_DROP)).toBe(false);
    expect(accepts(nodes, g('gGone'), ROOT_DROP)).toBe(false);
    expect(accepts(nodes, g('gA'), before(g('gGone')))).toBe(false);
    expect(accepts(nodes, g('gGone'), after(t('0')))).toBe(false);
  });

  it('refuses a group dropped inside one of its own members', () => {
    expect(accepts(nodes, g('gA'), inside(t('1')))).toBe(false);
    expect(accepts(nodes, g('gA'), inside(t('2')))).toBe(false);
  });

  it('accepts a tab beside ANOTHER group’s header, leaving its own group, and refuses an empty move', () => {
    // 1 is in gA; before gB's header it lands top-level, just ahead of gB's block.
    expect(accepts(nodes, t('1'), before(g('gB')))).toBe(true);
    expect(accepts(nodes, t('1'), after(g('gB')))).toBe(true);
    expect(accepts(nodes, t('4'), before(g('gA')))).toBe(true);
    // 3 already sits right before gB, at the top level.
    expect(accepts(nodes, t('3'), before(g('gB')))).toBe(false);
  });

  // The DGSL TreeView reads "the parent it already has" as "the place it already
  // is", so it refuses a drop inside a node's own group and a top-level node on the
  // root. Palmux's contract gives both drops a POSITION instead: inside a header
  // appends as the group's LAST member, and the root sends a node to the END of the
  // top level. Only a drop that would leave the node exactly where it is is refused.
  describe('a same-parent drop is a move unless the node is already last there', () => {
    it('appends a member dropped inside its own header when it is not the last one', () => {
      // gA = [1, 2]: 1 goes after 2.
      expect(accepts(nodes, t('1'), inside(g('gA')))).toBe(true);
      expect(drop(t('1'), inside(g('gA')))).toEqual({
        order: ['0', '2', '1', '3', '4', '5'],
        membership: {},
      });
      expect(accepts(nodes, t('2'), inside(g('gA')))).toBe(false);
    });

    it('sends the first of two top-level tabs to the end through the root, not the last', () => {
      const pair = [tab('0'), tab('1')];
      const pairNodes = buildNodes(pair, []);
      expect(accepts(pairNodes, t('0'), ROOT_DROP)).toBe(true);
      expect(resolveDrop(['0', '1'], groupIdMap(pair), t('0'), ROOT_DROP)).toEqual({
        order: ['1', '0'],
        membership: {},
      });
      expect(accepts(pairNodes, t('1'), ROOT_DROP)).toBe(false);
    });

    it('moves a top-level tab or a block that is not last to the end through the root', () => {
      // Top level: 0 · gA · 3 · gB, and gB is last.
      expect(accepts(nodes, t('0'), ROOT_DROP)).toBe(true);
      expect(accepts(nodes, t('3'), ROOT_DROP)).toBe(true);
      expect(accepts(nodes, g('gA'), ROOT_DROP)).toBe(true);
      expect(accepts(nodes, g('gB'), ROOT_DROP)).toBe(false);
    });
  });

  it('accepts the root for the only member of a lone group', () => {
    const solo = buildNodes([tab('7', 'gS')], [group('gS')]);
    expect(accepts(solo, t('7'), ROOT_DROP)).toBe(true);
    expect(accepts(solo, g('gS'), ROOT_DROP)).toBe(false);
  });
});

describe('resolveDrop: a tab', () => {
  it('reorders within a group', () => {
    expect(drop(t('2'), before(t('1')))).toEqual({
      order: ['0', '2', '1', '3', '4', '5'],
      membership: {},
    });
    expect(drop(t('1'), after(t('2')))).toEqual({
      order: ['0', '2', '1', '3', '4', '5'],
      membership: {},
    });
  });

  it('joins a group through its header, as the LAST member', () => {
    expect(drop(t('0'), inside(g('gA')))).toEqual({
      order: ['1', '2', '0', '3', '4', '5'],
      membership: { addTo: 'gA' },
    });
  });

  it('joins a group by landing between its members, in that spot', () => {
    expect(drop(t('3'), before(t('2')))).toEqual({
      order: ['0', '1', '3', '2', '4', '5'],
      membership: { addTo: 'gA' },
    });
    expect(drop(t('0'), after(t('2')))).toEqual({
      order: ['1', '2', '0', '3', '4', '5'],
      membership: { addTo: 'gA' },
    });
  });

  it('moves from one group to another with a single addTo', () => {
    expect(drop(t('1'), inside(g('gB')))).toEqual({
      order: ['0', '2', '3', '4', '5', '1'],
      membership: { addTo: 'gB' },
    });
    expect(drop(t('1'), before(t('5')))).toEqual({
      order: ['0', '2', '3', '4', '1', '5'],
      membership: { addTo: 'gB' },
    });
  });

  it('leaves its group by dropping among the top-level rows', () => {
    expect(drop(t('1'), after(t('3')))).toEqual({
      order: ['0', '2', '3', '1', '4', '5'],
      membership: { removeFrom: 'gA' },
    });
    expect(drop(t('2'), before(t('0')))).toEqual({
      order: ['2', '0', '1', '3', '4', '5'],
      membership: { removeFrom: 'gA' },
    });
  });

  it('lands before or after a whole group block when dropped on its header', () => {
    expect(drop(t('0'), after(g('gA')))).toEqual({
      order: ['1', '2', '0', '3', '4', '5'],
      membership: {},
    });
    expect(drop(t('3'), before(g('gA')))).toEqual({
      order: ['0', '3', '1', '2', '4', '5'],
      membership: {},
    });
    expect(drop(t('0'), after(g('gB')))).toEqual({
      order: ['1', '2', '3', '4', '5', '0'],
      membership: {},
    });
  });

  it('leaves its own group for a spot beside that group’s header', () => {
    expect(drop(t('1'), before(g('gA')))).toEqual({
      order: ['0', '1', '2', '3', '4', '5'],
      membership: { removeFrom: 'gA' },
    });
    expect(drop(t('1'), after(g('gA')))).toEqual({
      order: ['0', '2', '1', '3', '4', '5'],
      membership: { removeFrom: 'gA' },
    });
    // Leaving from the far end of its group, to the far side of the block.
    expect(drop(t('2'), after(g('gA')))).toEqual({
      order: ['0', '1', '2', '3', '4', '5'],
      membership: { removeFrom: 'gA' },
    });
  });

  it('leaves its group for a spot beside ANOTHER group’s header, as a top-level node', () => {
    // Not a join: a header's quarters name the position around the whole block.
    expect(drop(t('1'), before(g('gB')))).toEqual({
      order: ['0', '2', '3', '1', '4', '5'],
      membership: { removeFrom: 'gA' },
    });
    expect(drop(t('1'), after(g('gB')))).toEqual({
      order: ['0', '2', '3', '4', '5', '1'],
      membership: { removeFrom: 'gA' },
    });
    expect(drop(t('4'), before(g('gA')))).toEqual({
      order: ['0', '4', '1', '2', '3', '5'],
      membership: { removeFrom: 'gB' },
    });
    expect(drop(t('5'), after(g('gA')))).toEqual({
      order: ['0', '1', '2', '5', '3', '4'],
      membership: { removeFrom: 'gB' },
    });
  });

  it('moves a top-level tab among the top-level rows', () => {
    expect(drop(t('0'), after(t('3')))).toEqual({
      order: ['1', '2', '3', '0', '4', '5'],
      membership: {},
    });
  });

  it('reads its inputs without changing them, so a caller can compare before and after', () => {
    const frozen = Object.freeze([...ORDER]);
    const res = resolveDrop(frozen, groupOf, t('1'), after(t('3')));
    expect(frozen).toEqual(ORDER);
    expect(res?.order).not.toBe(frozen);
    // A same-place drop answers with the same sequence, as a copy: the caller's
    // no-op test is a comparison, and a shared array would make it vacuous.
    const same = resolveDrop(frozen, groupOf, t('0'), before(g('gA')));
    expect(same?.order).toEqual(ORDER);
    expect(same?.order).not.toBe(frozen);
  });

  it('sends a tab dropped on the root to the end of the top level, out of its group', () => {
    expect(drop(t('1'), ROOT_DROP)).toEqual({
      order: ['0', '2', '3', '4', '5', '1'],
      membership: { removeFrom: 'gA' },
    });
    expect(drop(t('0'), ROOT_DROP)).toEqual({
      order: ['1', '2', '3', '4', '5', '0'],
      membership: {},
    });
  });

  it('ungroups through the root in a list where EVERY tab is grouped', () => {
    expect(siblingsOf(allNodes, t('0'))).toEqual([t('0'), t('1')]); // no top-level tab to drop beside
    expect(accepts(allNodes, t('2'), ROOT_DROP)).toBe(true);
    expect(resolveDrop(['0', '1', '2'], allGroupOf, t('1'), ROOT_DROP)).toEqual({
      order: ['0', '2', '1'],
      membership: { removeFrom: 'gA' },
    });
  });

  it('leaves the only group: its last member dropped on the root', () => {
    // Tab 2 is the sole member of gB.
    expect(resolveDrop(['0', '1', '2'], allGroupOf, t('2'), ROOT_DROP)).toEqual({
      order: ['0', '1', '2'],
      membership: { removeFrom: 'gB' },
    });
    const solo = [tab('7', 'gS')];
    expect(resolveDrop(['7'], groupIdMap(solo), t('7'), ROOT_DROP)).toEqual({
      order: ['7'],
      membership: { removeFrom: 'gS' },
    });
  });

  it('ungroups the only member of a group that is dropped beside that group’s own header', () => {
    const order = ['0', '1', '2'];
    expect(resolveDrop(order, allGroupOf, t('2'), before(g('gB')))).toEqual({
      order: ['0', '1', '2'],
      membership: { removeFrom: 'gB' },
    });
    expect(resolveDrop(order, allGroupOf, t('2'), after(g('gB')))).toEqual({
      order: ['0', '1', '2'],
      membership: { removeFrom: 'gB' },
    });
  });

  it('returns a same-place drop unchanged, which is what accepts refuses', () => {
    expect(drop(t('0'), before(g('gA')))).toEqual({ order: ORDER, membership: {} });
    expect(drop(t('1'), before(t('2')))).toEqual({ order: ORDER, membership: {} });
  });

  it('cannot be resolved against an order that lost a node, or against a tab as a parent', () => {
    expect(drop(t('9'), before(t('0')))).toBeNull();
    expect(drop(t('0'), before(t('9')))).toBeNull();
    expect(drop(t('0'), inside(g('gGone')))).toBeNull();
    expect(drop(t('0'), inside(t('3')))).toBeNull();
    expect(drop(t('0'), before(t('0')))).toBeNull();
    expect(drop('nonsense', ROOT_DROP)).toBeNull();
    expect(drop(t('0'), before('nonsense'))).toBeNull();
  });
});

describe('resolveDrop: a group', () => {
  it('moves as a block, before or after a top-level node', () => {
    expect(drop(g('gA'), after(t('3')))).toEqual({
      order: ['0', '3', '1', '2', '4', '5'],
      membership: {},
    });
    expect(drop(g('gB'), before(t('0')))).toEqual({
      order: ['4', '5', '0', '1', '2', '3'],
      membership: {},
    });
  });

  it('moves before or after another group as a whole block', () => {
    expect(drop(g('gA'), after(g('gB')))).toEqual({
      order: ['0', '3', '4', '5', '1', '2'],
      membership: {},
    });
    expect(drop(g('gB'), before(g('gA')))).toEqual({
      order: ['0', '4', '5', '1', '2', '3'],
      membership: {},
    });
  });

  it('goes to the end of the top level when dropped on the root, as a block', () => {
    expect(drop(g('gA'), ROOT_DROP)).toEqual({
      order: ['0', '3', '4', '5', '1', '2'],
      membership: {},
    });
    expect(drop(g('gB'), ROOT_DROP)).toEqual({ order: ORDER, membership: {} });
  });

  it('keeps the members’ inner order', () => {
    const tabs = [tab('0'), tab('1', 'gA'), tab('2', 'gA'), tab('3', 'gA')];
    const res = resolveDrop(['0', '1', '2', '3'], groupIdMap(tabs), g('gA'), ROOT_DROP);
    expect(res?.order).toEqual(['0', '1', '2', '3']);
    const moved = resolveDrop(['1', '2', '3', '0'], groupIdMap(tabs), g('gA'), after(t('0')));
    expect(moved?.order).toEqual(['0', '1', '2', '3']);
  });

  it('cannot go inside a group, beside a member, or into itself', () => {
    expect(drop(g('gA'), inside(g('gB')))).toBeNull();
    expect(drop(g('gA'), before(t('4')))).toBeNull();
    expect(drop(g('gA'), after(t('1')))).toBeNull();
    expect(drop(g('gA'), before(g('gA')))).toBeNull();
    expect(drop(g('gGone'), ROOT_DROP)).toBeNull();
    expect(drop(g('gA'), before(g('gGone')))).toBeNull();
  });
});

// Shapes the model has to survive, beyond the two above: a group at the very start
// with a tab last, groups of one beside plain tabs, and a list that is one lone member.
const SHAPES: [string, TabMeta[], TabGroup[]][] = [
  ['mixed', TABS, GROUPS],
  ['all grouped', ALL_TABS, ALL_GROUPS],
  ['group first, tab last', [tab('0', 'gA'), tab('1', 'gA'), tab('2')], [group('gA')]],
  [
    'groups of one among tabs',
    [tab('0'), tab('1', 'gS'), tab('2', 'gT'), tab('3')],
    [group('gS'), group('gT')],
  ],
  ['one lone member', [tab('0', 'gA')], [group('gA')]],
];

/** Every node the pointer can name, and every drop it can ask for over them. */
function dragsAndDrops(tabs: TabMeta[], groups: TabGroup[]) {
  const values = [...tabs.map((x) => t(x.id)), ...groups.map((x) => g(x.id))];
  const drops: DrawerDrop[] = [
    ROOT_DROP,
    ...values.flatMap((v) => [before(v), after(v), inside(v)]),
  ];
  return { values, drops };
}

/** The tabs as the server would hold them after a drop: the new order, the dragged tab's group changed. */
function afterDrop(
  gof: (id: string) => string | undefined,
  dragged: string,
  res: DropResult,
): TabMeta[] {
  const movedId = isGroup(dragged) ? null : dragged.slice(2);
  return res.order.map((id) => {
    if (id !== movedId) return tab(id, gof(id));
    return tab(id, res.membership.addTo ?? (res.membership.removeFrom ? undefined : gof(id)));
  });
}

/** Whether `dragged` sits in `next` where `to` said, judged by the tree the drawer would draw. */
function expectLanded(
  prior: DrawerNode[],
  next: DrawerNode[],
  dragged: string,
  to: DrawerDrop,
  label: string,
) {
  const level = siblingsOf(next, dragged);
  const at = level.indexOf(dragged);
  expect(at, `${label}: the node is still in the tree`).toBeGreaterThanOrEqual(0);
  if (to.target === null) {
    expect(ancestorsOf(next, dragged), `${label}: top level`).toEqual([]);
    expect(at, `${label}: last of the top level`).toBe(level.length - 1);
    return;
  }
  const { target } = to;
  if (to.position === 'inside') {
    expect(ancestorsOf(next, dragged), `${label}: inside the group`).toEqual([target]);
    expect(at, `${label}: last member`).toBe(level.length - 1);
    return;
  }
  const step = to.position === 'before' ? -1 : 1;
  if (isGroup(target)) {
    expect(ancestorsOf(next, dragged), `${label}: beside a header is top level`).toEqual([]);
    // A group the dragged tab was the only member of is no longer a header; its
    // header's old place is where the tab now stands.
    const anchor = level.indexOf(target);
    if (anchor !== -1) expect(at, `${label}: next to the whole block`).toBe(anchor + step);
    else
      expect(at, `${label}: in the lone group's own place`).toBe(
        siblingsOf(prior, target).indexOf(target),
      );
    return;
  }
  expect(ancestorsOf(next, dragged), `${label}: takes the target's parent`).toEqual(
    ancestorsOf(prior, target),
  );
  expect(at, `${label}: right beside the target`).toBe(level.indexOf(target) + step);
}

describe('resolveDrop: normalization', () => {
  // Every drag against every drop target of every shape: whatever the pointer
  // can ask for, an accepted drop resolves, to a permutation that is already what
  // the server would broadcast, and that really is a move.
  const cases = SHAPES;

  for (const [name, tabs, groups] of cases) {
    it(`resolves every accepted drop to a contiguous permutation (${name})`, () => {
      const tree = buildNodes(tabs, groups);
      const gof = groupIdMap(tabs);
      const order = tabs.map((x) => x.id);
      const { values, drops } = dragsAndDrops(tabs, groups);
      let accepted = 0;
      for (const dragged of values) {
        for (const to of drops) {
          if (!accepts(tree, dragged, to)) continue;
          accepted += 1;
          const res = resolveDrop(order, gof, dragged, to);
          expect(res, `${dragged} ${JSON.stringify(to)}`).not.toBeNull();
          if (!res) continue;
          expect(res.order.toSorted()).toEqual(order.toSorted());
          const gid = isGroup(dragged) ? undefined : gof(dragged.slice(2));
          const into = res.membership.addTo ?? (res.membership.removeFrom ? undefined : gid);
          const post = (x: string) => (!isGroup(dragged) && x === dragged.slice(2) ? into : gof(x));
          expect(res.order, `${dragged} ${JSON.stringify(to)}`).toEqual(
            normalizeOrder(res.order, post),
          );
          const moved =
            res.order.some((v, i) => v !== order[i]) || Object.keys(res.membership).length > 0;
          expect(moved, `${dragged} ${JSON.stringify(to)} is a no-op but accepted`).toBe(true);
        }
      }
      expect(accepted).toBeGreaterThan(0);
    });

    it(`lands the node where the pointer said, and moves nothing else (${name})`, () => {
      // The contiguity check above would pass a drop that put the node in the wrong
      // place. This one rebuilds the tree the drawer would draw from the result and
      // asks where the dragged node stands in it.
      const tree = buildNodes(tabs, groups);
      const gof = groupIdMap(tabs);
      const order = tabs.map((x) => x.id);
      const { values, drops } = dragsAndDrops(tabs, groups);
      for (const dragged of values) {
        for (const to of drops) {
          if (!accepts(tree, dragged, to)) continue;
          const label = `${dragged} ${JSON.stringify(to)}`;
          const res = resolveDrop(order, gof, dragged, to);
          expect(res, label).not.toBeNull();
          if (!res) continue;
          expectLanded(tree, buildNodes(afterDrop(gof, dragged, res), groups), dragged, to, label);
          // One tab, or one block, moved: the rest keep the order they had.
          const moved = isGroup(dragged)
            ? order.filter((x) => gof(x) === dragged.slice(2))
            : [dragged.slice(2)];
          expect(
            res.order.filter((x) => !moved.includes(x)),
            `${label}: the others keep their order`,
          ).toEqual(order.filter((x) => !moved.includes(x)));
          if (isGroup(dragged)) {
            expect(
              res.order.filter((x) => moved.includes(x)),
              `${label}: inner order`,
            ).toEqual(moved);
            expect(res.membership, `${label}: a block changes no membership`).toEqual({});
          }
        }
      }
    });
  }

  it('contiguates an order that arrives scattered, exactly as the server would', () => {
    // gA's members are apart (1 _ 2), as in a strip mid-edit from another window.
    const tabs = [tab('1', 'gA'), tab('0'), tab('2', 'gA'), tab('3')];
    const scattered = ['1', '0', '2', '3'];
    expect(resolveDrop(scattered, groupIdMap(tabs), t('3'), after(t('0')))).toEqual({
      order: ['1', '2', '0', '3'],
      membership: {},
    });
    expect(resolveDrop(scattered, groupIdMap(tabs), g('gA'), after(t('3')))).toEqual({
      order: ['0', '3', '1', '2'],
      membership: {},
    });
  });

  it('closes a gap a drop would open inside a foreign group by joining it', () => {
    // Landing between two members of gB is a join, never a split of gB.
    const res = drop(t('0'), after(t('4')));
    expect(res).toEqual({ order: ['1', '2', '3', '4', '0', '5'], membership: { addTo: 'gB' } });
    expect(res?.order).toEqual(
      normalizeOrder(res?.order ?? [], (x) => (x === '0' ? 'gB' : groupOf(x))),
    );
  });
});

function isGroup(value: string): boolean {
  return value.startsWith('g:');
}
