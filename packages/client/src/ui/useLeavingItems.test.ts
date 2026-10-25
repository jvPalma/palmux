// The leaving-rows hook: a removed row stays for --mo-micro, in place, and a
// re-added one cancels the leave. Timers are faked, rAF included (vitest's default
// leaves it real), because the enter flip waits two animation frames.

import { act, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { microDurationMs, useLeavingItems } from './useLeavingItems';
import type { LeavingItemsOptions, TrackedRow } from './useLeavingItems';

interface Item {
  id: string;
  label?: string;
}

const item = (id: string, label?: string): Item => (label === undefined ? { id } : { id, label });
const keyOf = (i: Item) => i.id;
const abc = ['a', 'b', 'c'].map((id) => item(id));

/** `key:phase` per row, in render order. */
const view = (rows: readonly TrackedRow<Item>[]) => rows.map((r) => `${r.key}:${r.phase}`);
const keys = (rows: readonly TrackedRow<Item>[]) => rows.map((r) => r.key);

/** Two animation frames and a little more: what an `entering` row waits for. */
const settle = () => act(() => void vi.advanceTimersByTime(40));
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

const setup = (initial: Item[], options?: LeavingItemsOptions, strict = false) =>
  renderHook(({ items }) => useLeavingItems(items, keyOf, options), {
    initialProps: { items: initial },
    ...(strict ? { wrapper: StrictMode } : {}),
  });

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
  });
  document.documentElement.style.setProperty('--mo-micro', '140ms');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty('--mo-micro');
});

describe('useLeavingItems: entering', () => {
  it('runs a list’s first fill on the stagger tier, never the micro one', async () => {
    const { result } = setup(abc);
    expect(view(result.current)).toEqual(['a:entering', 'b:entering', 'c:entering']);
    expect(result.current.map((r) => r.enter)).toEqual(['stagger', 'stagger', 'stagger']);
    await settle();
    expect(view(result.current)).toEqual(['a:present', 'b:present', 'c:present']);
    // The tier stays on the row: the stylesheet reads it on the destination style.
    expect(result.current.map((r) => r.enter)).toEqual(['stagger', 'stagger', 'stagger']);
  });

  it('draws a list restored from saved state as present from its first frame', () => {
    const { result } = setup(abc, { initial: 'none' });
    expect(view(result.current)).toEqual(['a:present', 'b:present', 'c:present']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still enters a later insertion on the micro tier when the first fill was `none`', async () => {
    const { result, rerender } = setup(abc, { initial: 'none' });
    rerender({ items: [...abc, item('d')] });
    expect(result.current.at(-1)).toMatchObject({ key: 'd', phase: 'entering', enter: 'micro' });
    expect(view(result.current).slice(0, 3)).toEqual(['a:present', 'b:present', 'c:present']);
    await settle();
    expect(result.current.at(-1)?.phase).toBe('present');
  });

  it('runs a first fill that arrives empty-then-full on `none` as present, with no timers', () => {
    const { result, rerender } = setup([], { initial: 'none' });
    rerender({ items: abc });
    expect(view(result.current)).toEqual(['a:present', 'b:present', 'c:present']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts the first time a list holds anything as its first fill, not its first render', async () => {
    const { result, rerender } = setup([]);
    expect(result.current).toEqual([]);
    rerender({ items: abc });
    expect(result.current.map((r) => r.enter)).toEqual(['stagger', 'stagger', 'stagger']);
    await settle();
    rerender({ items: [...abc, item('d')] });
    expect(result.current.at(-1)).toMatchObject({ key: 'd', phase: 'entering', enter: 'micro' });
  });

  it('enters a row inserted later on the micro tier, collapsed first, present two frames on', async () => {
    const { result, rerender } = setup(abc);
    await settle();
    rerender({ items: [item('a'), item('x'), item('b'), item('c')] });
    expect(view(result.current)).toEqual(['a:present', 'x:entering', 'b:present', 'c:present']);
    expect(result.current[1]?.enter).toBe('micro');
    await act(() => void vi.advanceTimersByTime(16));
    expect(result.current[1]?.phase).toBe('entering'); // one frame is not enough to be painted
    await settle();
    expect(result.current[1]?.phase).toBe('present');
  });

  it('does not replay a first fill when the list empties and fills again', async () => {
    const { result, rerender } = setup(abc);
    await settle();
    rerender({ items: [] });
    await advance(200);
    expect(result.current).toEqual([]);
    rerender({ items: [item('z')] });
    expect(result.current[0]).toMatchObject({ key: 'z', phase: 'entering', enter: 'micro' });
  });

  it('flips only the rows of each batch, so a late arrival still gets its own painted frame', async () => {
    const { result, rerender } = setup(abc);
    await settle();
    rerender({ items: [...abc, item('x')] });
    await act(() => void vi.advanceTimersByTime(20)); // the first frame of x's batch passed
    rerender({ items: [...abc, item('x'), item('y')] });
    await act(() => void vi.advanceTimersByTime(16)); // x's second frame: x flips, y does not
    expect(view(result.current)).toEqual([
      'a:present',
      'b:present',
      'c:present',
      'x:present',
      'y:entering',
    ]);
    await settle();
    expect(result.current.at(-1)?.phase).toBe('present');
  });

  it('draws an inserted row as present at once under reduced motion', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    const { result, rerender } = setup(abc);
    expect(view(result.current)).toEqual(['a:present', 'b:present', 'c:present']);
    rerender({ items: [...abc, item('d')] });
    expect(result.current.at(-1)?.phase).toBe('present');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('useLeavingItems: leaving', () => {
  it('keeps a removed row, leaving, for the micro duration, then drops it', async () => {
    const { result, rerender } = setup(abc);
    await settle();
    rerender({ items: [item('a'), item('c')] });
    expect(view(result.current)).toEqual(['a:present', 'b:leaving', 'c:present']);
    await advance(139);
    expect(view(result.current)).toEqual(['a:present', 'b:leaving', 'c:present']);
    await advance(1);
    expect(view(result.current)).toEqual(['a:present', 'c:present']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds the leaving row for as long as --mo-micro says', async () => {
    document.documentElement.style.setProperty('--mo-micro', '0.3s');
    const { result, rerender } = setup(abc);
    await settle();
    rerender({ items: [item('a'), item('c')] });
    await advance(299);
    expect(keys(result.current)).toEqual(['a', 'b', 'c']);
    await advance(1);
    expect(keys(result.current)).toEqual(['a', 'c']);
  });

  it('does not stretch a leave when the list re-renders while the row is leaving', async () => {
    const { result, rerender } = setup(abc);
    await settle();
    rerender({ items: [item('a'), item('c')] });
    await advance(100);
    rerender({ items: [item('a'), item('c')] }); // a fresh array, same keys: a data tick
    await advance(39);
    expect(keys(result.current)).toEqual(['a', 'b', 'c']);
    await advance(1);
    expect(keys(result.current)).toEqual(['a', 'c']); // 140ms after the removal, not after the re-render
  });

  it('times each leaving row on its own, from when it was removed', async () => {
    const { result, rerender } = setup(abc);
    await settle();
    rerender({ items: [item('a'), item('c')] }); // b leaves at 140
    await advance(100);
    rerender({ items: [item('a')] }); // c leaves at 240
    expect(view(result.current)).toEqual(['a:present', 'b:leaving', 'c:leaving']);
    await advance(40);
    expect(keys(result.current)).toEqual(['a', 'c']);
    await advance(99);
    expect(keys(result.current)).toEqual(['a', 'c']);
    await advance(1);
    expect(keys(result.current)).toEqual(['a']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a replaced row, leaving, ahead of the row that takes its place', async () => {
    const { result, rerender } = setup(abc);
    await settle();
    rerender({ items: [item('a'), item('x'), item('c')] }); // b out, x in, same slot
    expect(view(result.current)).toEqual(['a:present', 'b:leaving', 'x:entering', 'c:present']);
    await advance(140);
    expect(view(result.current)).toEqual(['a:present', 'x:present', 'c:present']);
  });

  it('hands a row leaving from the first fill the micro tier, so its exit never runs the stagger', async () => {
    const { result, rerender } = setup(abc);
    await settle();
    expect(result.current[1]?.enter).toBe('stagger');
    rerender({ items: [item('a'), item('c')] });
    expect(result.current[1]).toMatchObject({ key: 'b', phase: 'leaving', enter: 'micro' });
  });

  it('keeps the last item a removed row held, not the one it was inserted with', async () => {
    const { result, rerender } = setup([item('a', 'first'), item('b')]);
    await settle();
    rerender({ items: [item('a', 'second'), item('b')] });
    expect(result.current[0]?.item.label).toBe('second');
    rerender({ items: [item('b')] });
    expect(result.current[0]).toMatchObject({ key: 'a', phase: 'leaving' });
    expect(result.current[0]?.item.label).toBe('second');
  });

  it('keeps removed rows in place: first, last and adjacent ones', async () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((id) => item(id));
    const { result, rerender } = setup(five);
    await settle();
    rerender({ items: five.filter((i) => i.id !== 'a') });
    expect(view(result.current)).toEqual([
      'a:leaving',
      'b:present',
      'c:present',
      'd:present',
      'e:present',
    ]);
    rerender({ items: five.filter((i) => !['a', 'c', 'd', 'e'].includes(i.id)) });
    expect(view(result.current)).toEqual([
      'a:leaving',
      'b:present',
      'c:leaving',
      'd:leaving',
      'e:leaving',
    ]);
    await advance(140);
    expect(keys(result.current)).toEqual(['b']);
  });

  it('keeps a row leaving beside the neighbour it followed when the list is reordered meanwhile', async () => {
    const { result, rerender } = setup(abc);
    await settle();
    rerender({ items: [item('c'), item('a')] }); // b goes, a and c swap
    expect(keys(result.current)).toEqual(['c', 'a', 'b']);
  });

  it('lets a row go that is removed before it finished entering', async () => {
    const { result, rerender } = setup(abc);
    await settle();
    rerender({ items: [...abc, item('x')] });
    rerender({ items: abc });
    expect(result.current.at(-1)).toMatchObject({ key: 'x', phase: 'leaving' });
    await advance(40); // the enter flip fires on a row that is no longer entering
    expect(result.current.at(-1)).toMatchObject({ key: 'x', phase: 'leaving' });
    await advance(140);
    expect(keys(result.current)).toEqual(['a', 'b', 'c']);
  });

  it('drops a removed row at once under reduced motion', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    const { result, rerender } = setup(abc);
    rerender({ items: [item('a'), item('c')] });
    expect(keys(result.current)).toEqual(['a', 'c']);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('useLeavingItems: a key that comes back', () => {
  it('cancels the leave: the same row is present again and nothing drops it', async () => {
    const { result, rerender } = setup(abc);
    await settle();
    rerender({ items: [item('a'), item('c')] });
    await advance(100);
    rerender({ items: abc });
    expect(view(result.current)).toEqual(['a:present', 'b:present', 'c:present']);
    expect(result.current[1]?.enter).toBe('micro');
    await advance(500);
    expect(keys(result.current)).toEqual(['a', 'b', 'c']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not replay the stagger on a first-fill row that left and came back', async () => {
    const { result, rerender } = setup(abc);
    await settle();
    rerender({ items: [item('a'), item('c')] });
    rerender({ items: abc });
    expect(result.current[1]).toMatchObject({ key: 'b', phase: 'present', enter: 'micro' });
  });

  it('takes the place the list gives a returning key, not the one it left', async () => {
    const { result, rerender } = setup(abc);
    await settle();
    rerender({ items: [item('a'), item('c')] });
    rerender({ items: [item('b'), item('a'), item('c')] });
    expect(view(result.current)).toEqual(['b:present', 'a:present', 'c:present']);
    await advance(500);
    expect(keys(result.current)).toEqual(['b', 'a', 'c']);
  });

  it('gives a second leave the full duration again', async () => {
    const { result, rerender } = setup(abc);
    await settle();
    rerender({ items: [item('a'), item('c')] });
    await advance(100);
    rerender({ items: abc });
    rerender({ items: [item('a'), item('c')] });
    await advance(100); // 200ms since the first removal, 100 since the second
    expect(keys(result.current)).toEqual(['a', 'b', 'c']);
    await advance(40);
    expect(keys(result.current)).toEqual(['a', 'c']);
  });
});

describe('useLeavingItems: live rows and teardown', () => {
  it('hands live rows the current item object', async () => {
    const { result, rerender } = setup([item('a', 'old')]);
    await settle();
    const next = item('a', 'new');
    rerender({ items: [next] });
    expect(result.current[0]?.item).toBe(next);
  });

  it('keeps a row’s place in the order the list gives, for rows that only move', async () => {
    const { result, rerender } = setup(abc);
    await settle();
    rerender({ items: [item('c'), item('b'), item('a')] });
    expect(view(result.current)).toEqual(['c:present', 'b:present', 'a:present']);
  });

  it('clears every pending timer and frame on unmount', async () => {
    const { rerender, unmount } = setup(abc);
    await settle();
    rerender({ items: [item('a'), item('x')] }); // b, c leaving; x entering
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('behaves the same under Strict Mode’s double render and simulated remount', async () => {
    const { result, rerender } = setup(abc, undefined, true);
    expect(view(result.current)).toEqual(['a:entering', 'b:entering', 'c:entering']);
    await settle();
    expect(view(result.current)).toEqual(['a:present', 'b:present', 'c:present']);
    rerender({ items: [item('a'), item('c')] });
    expect(view(result.current)).toEqual(['a:present', 'b:leaving', 'c:present']);
    await advance(140);
    expect(keys(result.current)).toEqual(['a', 'c']);
  });

  it('flips a later insertion to present under Strict Mode, once', async () => {
    const { result, rerender } = setup(abc, undefined, true);
    await settle();
    rerender({ items: [...abc, item('d')] });
    expect(result.current.at(-1)).toMatchObject({ key: 'd', phase: 'entering', enter: 'micro' });
    await settle();
    expect(view(result.current)).toEqual(['a:present', 'b:present', 'c:present', 'd:present']);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('microDurationMs', () => {
  it('reads the tier token, in ms or s', () => {
    expect(microDurationMs()).toBe(140);
    document.documentElement.style.setProperty('--mo-micro', '0.14s');
    expect(microDurationMs()).toBe(140);
  });

  it('falls back to the tier’s value when no stylesheet defines the token', () => {
    document.documentElement.style.removeProperty('--mo-micro');
    expect(microDurationMs()).toBe(140);
  });

  it('reads a token written without a leading zero, and falls back on one it cannot read', () => {
    document.documentElement.style.setProperty('--mo-micro', '.2s');
    expect(microDurationMs()).toBe(200);
    document.documentElement.style.setProperty('--mo-micro', 'fast');
    expect(microDurationMs()).toBe(140);
  });

  it('is 0 under reduced motion, by the media query and by the zeroed token', () => {
    document.documentElement.style.setProperty('--mo-micro', '0.001ms');
    expect(microDurationMs()).toBe(0);
    document.documentElement.style.setProperty('--mo-micro', '140ms');
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    expect(microDurationMs()).toBe(0);
  });
});
