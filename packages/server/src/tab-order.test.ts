// The shared tab-order model (contiguity + forgiving permutation), used
// identically by the server registry and the client optimistic layer.

import { describe, expect, it } from 'vitest';
import { forgivingOrder, normalizeOrder } from '@palmux/shared';

const gof = (m: { [id: string]: string }) => (id: string) => m[id];

describe('normalizeOrder', () => {
  it("pulls each group's members to its first member's slot, order preserved", () => {
    // 0(gA) 1 2(gA) 3 → gA collapses at slot 0: 0 2 1 3
    expect(normalizeOrder(['0', '1', '2', '3'], gof({ '0': 'gA', '2': 'gA' }))).toEqual([
      '0',
      '2',
      '1',
      '3',
    ]);
  });

  it('leaves an already-contiguous / ungrouped order unchanged', () => {
    expect(normalizeOrder(['0', '1', '2'], gof({}))).toEqual(['0', '1', '2']);
    expect(normalizeOrder(['0', '1', '2'], gof({ '0': 'gA', '1': 'gA' }))).toEqual(['0', '1', '2']);
  });

  it('handles multiple groups independently, each at its first slot', () => {
    // 0(gA) 1(gB) 2(gA) 3(gB) → gA at 0, gB at 1: 0 2 1 3
    expect(
      normalizeOrder(['0', '1', '2', '3'], gof({ '0': 'gA', '2': 'gA', '1': 'gB', '3': 'gB' })),
    ).toEqual(['0', '2', '1', '3']);
  });

  it('a fragmenting request is bounced back to contiguity', () => {
    // Trying to slot an outsider between two members: 0(gA) x 1(gA) → 0 1 x
    expect(normalizeOrder(['0', 'x', '1'], gof({ '0': 'gA', '1': 'gA' }))).toEqual(['0', '1', 'x']);
  });
});

describe('forgivingOrder', () => {
  const known = (ids: string[]) => (id: string) => ids.includes(id);

  it('applies a full valid permutation', () => {
    expect(forgivingOrder(['0', '1', '2'], ['2', '0', '1'], known(['0', '1', '2']))).toEqual([
      '2',
      '0',
      '1',
    ]);
  });

  it('drops unknown ids and de-duplicates', () => {
    expect(forgivingOrder(['0', '1'], ['1', 'zzz', '1', '0'], known(['0', '1']))).toEqual([
      '1',
      '0',
    ]);
  });

  it('appends omitted known ids in their prior relative order', () => {
    // desired only names 2; 0 and 1 are appended in their current order
    expect(forgivingOrder(['0', '1', '2'], ['2'], known(['0', '1', '2']))).toEqual(['2', '0', '1']);
  });

  it('never loses or duplicates a tab', () => {
    const current = ['0', '1', '2', '3'];
    const out = forgivingOrder(current, ['3', '3', 'ghost', '1'], known(current));
    expect([...out].sort()).toEqual(['0', '1', '2', '3']);
  });
});
