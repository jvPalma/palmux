import { describe, expect, it } from 'vitest';
import type { TabGroup, TabMeta } from '@palmux/shared';
import {
  buildStrip,
  decideGroupDrop,
  nearestOutside,
  outsideForeignGroup,
  parseCollapsed,
} from './tab-groups';

const t = (id: string, groupId?: string): TabMeta => ({
  id,
  kind: 'terminal',
  ...(groupId ? { groupId } : {}),
});
const g = (id: string, color = 'blue', name?: string): TabGroup => ({
  id,
  color,
  ...(name ? { name } : {}),
});
const gidFn = (tabs: TabMeta[]) => (id: string) => tabs.find((x) => x.id === id)?.groupId;

describe('parseCollapsed', () => {
  it('parses a string array; forgiving on garbage', () => {
    expect(parseCollapsed('["gaa111","gbb222"]')).toEqual(['gaa111', 'gbb222']);
    expect(parseCollapsed(null)).toEqual([]);
    expect(parseCollapsed('{bad')).toEqual([]);
    expect(parseCollapsed('[1,"gaa111",null]')).toEqual(['gaa111']);
  });
});

describe('buildStrip', () => {
  it('emits a chip before each group and interleaves ungrouped tabs', () => {
    const tabs = [t('0', 'gA'), t('1', 'gA'), t('2'), t('3', 'gB')];
    const items = buildStrip(tabs, [g('gA', 'blue', 'proj'), g('gB', 'green')], new Set());
    expect(
      items.map((i) => (i.kind === 'chip' ? `chip:${i.group.id}` : `tab:${i.tab.id}`)),
    ).toEqual(['chip:gA', 'tab:0', 'tab:1', 'tab:2', 'chip:gB', 'tab:3']);
    const chipA = items[0];
    expect(chipA?.kind).toBe('chip');
    expect(chipA?.kind === 'chip' ? chipA.memberCount : 0).toBe(2);
  });

  it('a collapsed group shows only its chip (members hidden), with a count', () => {
    const tabs = [t('0', 'gA'), t('1', 'gA'), t('2')];
    const items = buildStrip(tabs, [g('gA')], new Set(['gA']));
    expect(
      items.map((i) =>
        i.kind === 'chip' ? `chip:${i.group.id}(${i.memberCount})` : `tab:${i.tab.id}`,
      ),
    ).toEqual(['chip:gA(2)', 'tab:2']);
    const chip = items[0];
    expect(chip?.kind === 'chip' ? chip.collapsed : false).toBe(true);
    expect(chip?.kind === 'chip' ? chip.firstMemberId : '').toBe('0');
  });

  it('plain tabs with no groups are one tab item each', () => {
    const tabs = [t('0'), t('1'), t('2')];
    const items = buildStrip(tabs, [], new Set());
    expect(items).toEqual([
      { kind: 'tab', tab: tabs[0] },
      { kind: 'tab', tab: tabs[1] },
      { kind: 'tab', tab: tabs[2] },
    ]);
  });

  // Each pane runs `buildStrip` over its own subset of the server's list, so a colour group that
  // spans two panes draws a chip (and a frame) in each, counting only that pane's members.
  it('a group spanning two panes draws a chip in each, counting its own members', () => {
    const all = [t('0', 'gA'), t('1', 'gA'), t('2', 'gA'), t('3')];
    const groups = [g('gA', 'blue', 'proj')];
    const left = buildStrip(
      all.filter((x) => x.id === '0' || x.id === '3'),
      groups,
      new Set(),
    );
    const right = buildStrip(
      all.filter((x) => x.id === '1' || x.id === '2'),
      groups,
      new Set(),
    );
    const label = (i: (typeof left)[number]): string =>
      i.kind === 'chip' ? `chip:${i.group.id}(${i.memberCount})` : `tab:${i.tab.id}`;
    expect(left.map(label)).toEqual(['chip:gA(1)', 'tab:0', 'tab:3']);
    expect(right.map(label)).toEqual(['chip:gA(2)', 'tab:1', 'tab:2']);
  });
});

describe('nearestOutside', () => {
  it('prefers the tab before the span, else after', () => {
    const tabs = [t('0'), t('1', 'gA'), t('2', 'gA'), t('3')];
    expect(nearestOutside(['0', '1', '2', '3'], gidFn(tabs), 'gA')).toBe('0'); // before
    const tabs2 = [t('0', 'gA'), t('1', 'gA'), t('2')];
    expect(nearestOutside(['0', '1', '2'], gidFn(tabs2), 'gA')).toBe('2'); // no left → after
  });

  it('null when the group is the whole strip', () => {
    const tabs = [t('0', 'gA'), t('1', 'gA')];
    expect(nearestOutside(['0', '1'], gidFn(tabs), 'gA')).toBeNull();
  });
});

describe('decideGroupDrop', () => {
  it('interior drop between two members of one group → join', () => {
    const tabs = [t('0', 'gA'), t('x'), t('1', 'gA')];
    // order after dropping x between the members:
    expect(decideGroupDrop(['0', 'x', '1'], gidFn(tabs), 'x')).toEqual({ join: 'gA' });
  });

  it('center drop on a member → join that group (grows a group of one)', () => {
    const tabs = [t('0', 'gA'), t('x')];
    expect(decideGroupDrop(['0', 'x'], gidFn(tabs), 'x', 'gA')).toEqual({ join: 'gA' });
  });

  it('a member dragged past its group edge → leave', () => {
    const tabs = [t('0', 'gA'), t('1', 'gA'), t('2')];
    // order after moving 0 to the end (outside gA's span):
    expect(decideGroupDrop(['1', '2', '0'], gidFn(tabs), '0')).toEqual({ leave: 'gA' });
  });

  it('a member reordered WITHIN its own span → no change', () => {
    const tabs = [t('0', 'gA'), t('1', 'gA'), t('2', 'gA')];
    expect(decideGroupDrop(['1', '0', '2'], gidFn(tabs), '0')).toEqual({}); // still interior to gA
  });

  it('ungrouped ↔ ungrouped → plain reorder', () => {
    const tabs = [t('0'), t('1'), t('2')];
    expect(decideGroupDrop(['1', '0', '2'], gidFn(tabs), '0')).toEqual({});
  });

  it('reorder to the front of its OWN group keeps membership (a neighbor is still a member)', () => {
    const tabs = [t('0', 'gA'), t('1', 'gA')];
    // 0 at the front, R='1' is still gA → not fully detached → stays.
    expect(decideGroupDrop(['0', '1'], gidFn(tabs), '0')).toEqual({});
  });

  it('a two-member group: dragging one out to a clearly-outside slot leaves', () => {
    const tabs = [t('0', 'gA'), t('1', 'gA'), t('2')];
    expect(decideGroupDrop(['1', '2', '0'], gidFn(tabs), '0')).toEqual({ leave: 'gA' });
  });

  it('a boundary drop never joins, even between two members of another group', () => {
    const tabs = [t('0', 'gA'), t('x'), t('1', 'gA')];
    expect(decideGroupDrop(['0', 'x', '1'], gidFn(tabs), 'x', undefined, true)).toEqual({});
  });

  it('a boundary drop still leaves when it detaches a member from its own group', () => {
    const tabs = [t('0', 'gA'), t('1', 'gA'), t('2')];
    expect(decideGroupDrop(['1', '2', '0'], gidFn(tabs), '0', undefined, true)).toEqual({
      leave: 'gA',
    });
  });
});

describe('outsideForeignGroup', () => {
  // rest = [a, g1, g2, g3, b]: insertion index k sits before rest[k].
  const tabs = [t('a'), t('g1', 'gA'), t('g2', 'gA'), t('g3', 'gA'), t('b')];
  const rest = tabs.map((x) => x.id);

  it("moves a point between two of a foreign group's members to its nearer edge", () => {
    expect(outsideForeignGroup(rest, 2, gidFn(tabs), undefined)).toBe(1); // g1|g2 → before g1
    expect(outsideForeignGroup(rest, 3, gidFn(tabs), undefined)).toBe(4); // g2|g3 → after g3
    // g1|g2 of a two-member group is a tie, and a tie goes before the group.
    const two = [t('a'), t('g1', 'gA'), t('g2', 'gA'), t('b')];
    const twoIds = two.map((x) => x.id);
    expect(outsideForeignGroup(twoIds, 2, gidFn(two), 'gB')).toBe(1);
  });

  it('leaves a point inside the OWN group, at an edge, or outside any group alone', () => {
    expect(outsideForeignGroup(rest, 2, gidFn(tabs), 'gA')).toBe(2);
    expect(outsideForeignGroup(rest, 1, gidFn(tabs), undefined)).toBe(1); // a|g1
    expect(outsideForeignGroup(rest, 4, gidFn(tabs), undefined)).toBe(4); // g3|b
    expect(outsideForeignGroup(rest, 0, gidFn(tabs), undefined)).toBe(0);
    expect(outsideForeignGroup(rest, 5, gidFn(tabs), undefined)).toBe(5);
  });
});
