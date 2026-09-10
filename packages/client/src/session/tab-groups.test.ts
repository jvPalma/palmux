import { describe, expect, it } from 'vitest';
import type { TabGroup, TabMeta } from '@palmux/shared';
import type { StripItem } from './tab-groups';
import { buildStrip, decideGroupDrop, nearestOutside, parseCollapsed } from './tab-groups';

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
      items.map((i) =>
        i.kind === 'chip'
          ? `chip:${i.group.id}`
          : i.kind === 'fused'
            ? `fused:${i.a.id}-${i.b.id}`
            : `tab:${i.tab.id}`,
      ),
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
        i.kind === 'chip'
          ? `chip:${i.group.id}(${i.memberCount})`
          : i.kind === 'fused'
            ? `fused:${i.a.id}-${i.b.id}`
            : `tab:${i.tab.id}`,
      ),
    ).toEqual(['chip:gA(2)', 'tab:2']);
    const chip = items[0];
    expect(chip?.kind === 'chip' ? chip.collapsed : false).toBe(true);
    expect(chip?.kind === 'chip' ? chip.firstMemberId : '').toBe('0');
  });

  it('3-arg calls (no pairings) are byte-compatible with the pre-fusion behavior', () => {
    const tabs = [t('0'), t('1'), t('2')];
    const items = buildStrip(tabs, [], new Set());
    expect(items).toEqual([
      { kind: 'tab', tab: tabs[0] },
      { kind: 'tab', tab: tabs[1] },
      { kind: 'tab', tab: tabs[2] },
    ]);
  });

  const label = (i: StripItem): string => {
    if (i.kind === 'chip') return `chip:${i.group.id}`;
    if (i.kind === 'fused') return `fused:${i.a.id}-${i.b.id}`;
    return `tab:${i.tab.id}`;
  };

  it('fuses an adjacent pairing at the first member position, slot order preserved', () => {
    const tabs = [t('0'), t('1'), t('2'), t('3')];
    const items = buildStrip(tabs, [], new Set(), [{ a: '1', b: '2' }]);
    expect(items.map(label)).toEqual(['tab:0', 'fused:1-2', 'tab:3']);
  });

  it('fused a/b follow pairing SLOT order even when reversed vs. strip order', () => {
    const tabs = [t('1'), t('2')];
    const items = buildStrip(tabs, [], new Set(), [{ a: '2', b: '1' }]);
    expect(items.map(label)).toEqual(['fused:2-1']);
    const fused = items[0];
    expect(fused?.kind === 'fused' ? fused.a.id : null).toBe('2');
    expect(fused?.kind === 'fused' ? fused.b.id : null).toBe('1');
  });

  it('a pairing whose members are not adjacent-visible renders as two plain tabs', () => {
    const tabs = [t('0'), t('1'), t('2')];
    const items = buildStrip(tabs, [], new Set(), [{ a: '0', b: '2' }]);
    expect(items.map(label)).toEqual(['tab:0', 'tab:1', 'tab:2']);
  });

  it('a fused pair inside a collapsed group stays hidden like any members', () => {
    const tabs = [t('0', 'gA'), t('1', 'gA'), t('2')];
    const items = buildStrip(tabs, [g('gA')], new Set(['gA']), [{ a: '0', b: '1' }]);
    expect(items.map(label)).toEqual(['chip:gA', 'tab:2']);
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
});
