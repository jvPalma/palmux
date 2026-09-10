import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { TabMeta } from '@palmux/shared';
import {
  clampRatio,
  fullRect,
  memberSlot,
  pairingOf,
  parsePairings,
  reconcilePairings,
  splitRects,
  useSplit,
  type SplitState,
} from './useSplit';

const base: SplitState = {
  a: { tabId: '0', kind: 'terminal' },
  b: { tabId: '1', kind: 'editor' },
  orientation: 'row',
  ratio: 0.5,
  focused: 'a',
};

const noGroups = (): string | undefined => undefined;

describe('clampRatio', () => {
  it('clamps to 0.15–0.85 and defaults bad input to 0.5', () => {
    expect(clampRatio(0.5)).toBe(0.5);
    expect(clampRatio(0.01)).toBe(0.15);
    expect(clampRatio(0.99)).toBe(0.85);
    expect(clampRatio(NaN)).toBe(0.5);
  });
});

describe('splitRects', () => {
  it('row = side by side, column = stacked, both summing to 100%', () => {
    const row = splitRects('row', 0.4);
    expect(row.a).toEqual({ left: 0, top: 0, width: 40, height: 100 });
    expect(row.b).toEqual({ left: 40, top: 0, width: 60, height: 100 });
    const col = splitRects('column', 0.4);
    expect(col.a).toEqual({ left: 0, top: 0, width: 100, height: 40 });
    expect(col.b).toEqual({ left: 0, top: 40, width: 100, height: 60 });
  });

  it('clamps the ratio', () => {
    expect(splitRects('row', 0.01).a.width).toBe(15);
  });

  it('fullRect is the whole area', () => {
    expect(fullRect()).toEqual({ left: 0, top: 0, width: 100, height: 100 });
  });
});

describe('memberSlot / pairingOf', () => {
  it('maps member ids to their slot within one pairing', () => {
    expect(memberSlot(base, '0')).toBe('a');
    expect(memberSlot(base, '1')).toBe('b');
    expect(memberSlot(base, '2')).toBeNull();
  });

  it('finds the pairing containing an id', () => {
    const other: SplitState = {
      a: { tabId: '5', kind: 'terminal' },
      b: { tabId: '6', kind: 'web' },
      orientation: 'row',
      ratio: 0.5,
      focused: 'a',
    };
    const pairings = [base, other];
    expect(pairingOf(pairings, '0')).toBe(base);
    expect(pairingOf(pairings, '6')).toBe(other);
    expect(pairingOf(pairings, '9')).toBeNull();
    expect(pairingOf([], '0')).toBeNull();
  });
});

describe('parsePairings', () => {
  const v2 = (pairings: unknown[]): string => JSON.stringify({ v: 2, pairings });

  it('round-trips a v2 store', () => {
    expect(parsePairings(v2([base]), null)).toEqual([base]);
  });

  it('is forgiving per entry — drops bad, keeps good', () => {
    const good: SplitState = {
      a: { tabId: '4', kind: 'web' },
      b: { tabId: '5', kind: 'markdown' },
      orientation: 'column',
      ratio: 0.5,
      focused: 'b',
    };
    const raw = v2([base, { a: base.a }, 'nonsense', good]);
    expect(parsePairings(raw, null)).toEqual([base, good]);
  });

  it('drops later pairings that reuse a tab (at most one pairing per tab)', () => {
    const dup: SplitState = {
      a: { tabId: '1', kind: 'editor' }, // '1' already in base
      b: { tabId: '9', kind: 'terminal' },
      orientation: 'row',
      ratio: 0.5,
      focused: 'a',
    };
    expect(parsePairings(v2([base, dup]), null)).toEqual([base]);
  });

  it('accepts an explicitly-empty v2 store WITHOUT falling back to legacy', () => {
    expect(parsePairings(v2([]), JSON.stringify(base))).toEqual([]);
  });

  it('falls back to the legacy single-pairing blob when v2 is absent', () => {
    expect(parsePairings(null, JSON.stringify(base))).toEqual([base]);
  });

  it('falls back to legacy when the v2 raw is corrupt / not a v2 blob', () => {
    expect(parsePairings('{not json', JSON.stringify(base))).toEqual([base]);
    expect(parsePairings(JSON.stringify({ v: 1, pairings: [base] }), JSON.stringify(base))).toEqual(
      [base],
    );
  });

  it('discards everything when both sources are unusable', () => {
    expect(parsePairings(null, null)).toEqual([]);
    expect(parsePairings('{bad', '{also bad')).toEqual([]);
    expect(parsePairings(v2([{ a: base.a }]), null)).toEqual([]); // one bad entry, no legacy
  });
});

describe('reconcilePairings', () => {
  const tabs: TabMeta[] = [
    { id: '0', kind: 'terminal' },
    { id: '1', kind: 'editor' },
  ];
  const seen = new Set(['0']);

  it('keeps both-live adjacent same-group pairings — SAME array reference', () => {
    const pairings = [base];
    const res = reconcilePairings(pairings, tabs, seen, noGroups);
    expect(res.pairings).toBe(pairings); // unchanged → identity preserved
    expect(res.dissolved).toEqual([]);
  });

  it('keeps a pairing whose absent terminal was never seen (fresh slot)', () => {
    const fresh: SplitState = { ...base, b: { tabId: '9', kind: 'terminal' } };
    const res = reconcilePairings([fresh], tabs, seen, noGroups);
    expect(res.pairings).toEqual([fresh]);
    expect(res.dissolved).toEqual([]);
  });

  it('dissolves with the live survivor when a SEEN terminal is killed', () => {
    const p: SplitState = { ...base, b: { tabId: '3', kind: 'terminal' } };
    const res = reconcilePairings([p], tabs, new Set(['0', '3']), noGroups);
    expect(res.pairings).toEqual([]);
    expect(res.dissolved).toEqual([{ key: '0', survivor: '0' }]);
  });

  it('dissolves with survivor when a non-terminal slot is gone', () => {
    const gone: SplitState = { ...base, b: { tabId: '5', kind: 'editor' } };
    const res = reconcilePairings([gone], tabs, seen, noGroups);
    expect(res.dissolved).toEqual([{ key: '0', survivor: '0' }]);
  });

  it('dissolves on a kind mismatch (recycled id)', () => {
    const nowTerminal: TabMeta[] = [
      { id: '0', kind: 'terminal' },
      { id: '1', kind: 'terminal' },
    ];
    const res = reconcilePairings([base], nowTerminal, seen, noGroups);
    expect(res.dissolved).toEqual([{ key: '0', survivor: '0' }]);
  });

  it('dissolves (survivor null) when both members are alive but no longer adjacent', () => {
    const spread: TabMeta[] = [
      { id: '0', kind: 'terminal' },
      { id: '2', kind: 'web' },
      { id: '1', kind: 'editor' },
    ];
    const res = reconcilePairings([base], spread, seen, noGroups);
    expect(res.pairings).toEqual([]);
    expect(res.dissolved).toEqual([{ key: '0', survivor: null }]);
  });

  it('dissolves (survivor null) when adjacent members no longer share membership', () => {
    const groupOf = (id: string): string | undefined => (id === '1' ? 'gabcde' : undefined);
    const res = reconcilePairings([base], tabs, seen, groupOf);
    expect(res.dissolved).toEqual([{ key: '0', survivor: null }]);
  });

  it('keeps adjacent members that share the same group', () => {
    const groupOf = (): string | undefined => 'gabcde';
    const pairings = [base];
    const res = reconcilePairings(pairings, tabs, seen, groupOf);
    expect(res.pairings).toBe(pairings);
    expect(res.dissolved).toEqual([]);
  });

  it('dissolves only the affected pairing, keeping the others', () => {
    const other: SplitState = {
      a: { tabId: '1', kind: 'editor' },
      b: { tabId: '5', kind: 'editor' }, // gone
      orientation: 'row',
      ratio: 0.5,
      focused: 'a',
    };
    // First pairing (0/… killed terminal) dissolves; make base's b a killed terminal.
    const dying: SplitState = { ...base, b: { tabId: '3', kind: 'terminal' } };
    const res = reconcilePairings([dying, other], tabs, new Set(['0', '3']), noGroups);
    expect(res.dissolved).toEqual([
      { key: '0', survivor: '0' },
      { key: '1', survivor: '1' },
    ]);
    expect(res.pairings).toEqual([]);
  });

  it('dissolves with survivor null when both slots are dead', () => {
    const both: SplitState = {
      a: { tabId: '7', kind: 'web' },
      b: { tabId: '8', kind: 'web' },
      orientation: 'row',
      ratio: 0.5,
      focused: 'a',
    };
    const res = reconcilePairings([both], tabs, seen, noGroups);
    expect(res.dissolved).toEqual([{ key: '7', survivor: null }]);
    expect(res.pairings).toEqual([]);
  });
});

describe('reconcilePairings pendingAdjacency (newborn self-split shield)', () => {
  const tabs: TabMeta[] = [
    { id: '0', kind: 'terminal' },
    { id: '1', kind: 'terminal' },
    { id: '2', kind: 'terminal' },
  ];
  const seen = new Set(['0', '1', '2']);
  const noGroups = (): string | undefined => undefined;
  // 0 and 2 are NOT adjacent (1 sits between them).
  const newborn: SplitState = {
    a: { tabId: '0', kind: 'terminal' },
    b: { tabId: '2', kind: 'terminal' },
    orientation: 'row',
    ratio: 0.5,
    focused: 'b',
  };

  it('keeps a non-adjacent pairing while its key is pending (same reference)', () => {
    const arr = [newborn];
    const res = reconcilePairings(arr, tabs, seen, noGroups, new Set(['0']));
    expect(res.dissolved).toEqual([]);
    expect(res.pairings).toBe(arr);
  });

  it('still dissolves the same pairing without the pending shield', () => {
    const res = reconcilePairings([newborn], tabs, seen, noGroups);
    expect(res.dissolved).toEqual([{ key: '0', survivor: null }]);
  });

  it('pending shields membership mismatches too, but never liveness', () => {
    const grouped = (id: string): string | undefined => (id === '0' ? 'gA' : undefined);
    const shielded = reconcilePairings([newborn], tabs, seen, grouped, new Set(['0']));
    expect(shielded.dissolved).toEqual([]);
    const dead: SplitState = { ...newborn, b: { tabId: '9', kind: 'editor' } };
    const res = reconcilePairings([dead], tabs, seen, noGroups, new Set(['0']));
    expect(res.dissolved).toEqual([{ key: '0', survivor: '0' }]);
  });
});

// ── swapSlots ─────────────────────────────────────────────────────────────────
//
// Double-clicking the divider trades the two panes' sides. Three things have to
// move together, and each of them is a bug on its own if it doesn't.
describe('swapSlots', () => {
  const render = () => renderHook(() => useSplit(true));

  beforeEach(() => localStorage.clear());

  const open = (r: ReturnType<typeof render>) =>
    act(() =>
      r.result.current.openSplit(
        { tabId: '0', kind: 'terminal' },
        { tabId: '1', kind: 'editor' },
        'row',
        'a',
      ),
    );

  it('trades the members and flips the focused slot with them', () => {
    const r = render();
    open(r);
    act(() => r.result.current.swapSlots('0'));
    const p = r.result.current.pairings[0]!;
    expect(p.a).toEqual({ tabId: '1', kind: 'editor' });
    expect(p.b).toEqual({ tabId: '0', kind: 'terminal' });
    // '0' was focused before and must still be — `focused` names a SLOT, so
    // leaving it alone would silently move focus (and the URL) to the other tab.
    expect(p.focused).toBe('b');
    expect(memberSlot(p, '0')).toBe('b');
  });

  it('leaves the ratio alone so the divider stays and the contents cross it', () => {
    const r = render();
    open(r);
    act(() => r.result.current.setRatio('0', 0.3));
    act(() => r.result.current.swapSlots('0'));
    expect(r.result.current.pairings[0]!.ratio).toBeCloseTo(0.3);
  });

  it('renames the pairing key, so a second swap uses the new one', () => {
    const r = render();
    open(r);
    act(() => r.result.current.swapSlots('0'));
    // The old key is gone — a caller holding it is a no-op, not a crash.
    act(() => r.result.current.swapSlots('0'));
    expect(r.result.current.pairings[0]!.a.tabId).toBe('1');
    act(() => r.result.current.swapSlots('1'));
    expect(r.result.current.pairings[0]!.a.tabId).toBe('0');
    expect(r.result.current.pairings[0]!.focused).toBe('a');
  });

  it('touches only the pairing it names', () => {
    const r = render();
    open(r);
    act(() =>
      r.result.current.openSplit(
        { tabId: '2', kind: 'terminal' },
        { tabId: '3', kind: 'terminal' },
        'row',
        'a',
      ),
    );
    act(() => r.result.current.swapSlots('2'));
    const keys = r.result.current.pairings.map((p) => p.a.tabId);
    expect(keys).toEqual(['0', '3']);
  });
});
