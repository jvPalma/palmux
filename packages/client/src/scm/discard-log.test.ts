import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DISCARD_UNDO_MS,
  LAST_DISCARD_KEY,
  forgetDiscard,
  readLastDiscard,
  recordDiscard,
  subscribeDiscards,
} from './discard-log';

const discard = (receiptId: string, at = 1000, count = 3) => ({ receiptId, at, count });

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the last discard of a project', () => {
  it('reads nothing when nothing is stored', () => {
    expect(readLastDiscard('/work/app', 1000)).toBeNull();
  });

  it('reads back what was recorded', () => {
    recordDiscard('/work/app', discard('d1'));
    expect(readLastDiscard('/work/app', 2000)).toEqual(discard('d1'));
  });

  it('keeps one entry per project', () => {
    recordDiscard('/work/app', discard('d1'));
    recordDiscard('/work/lib', discard('d2'));
    expect(readLastDiscard('/work/app', 2000)?.receiptId).toBe('d1');
    expect(readLastDiscard('/work/lib', 2000)?.receiptId).toBe('d2');
  });

  it('replaces the project’s entry with a newer discard', () => {
    recordDiscard('/work/app', discard('d1', 1000, 3));
    recordDiscard('/work/app', discard('d2', 5000, 7));
    expect(readLastDiscard('/work/app', 6000)).toEqual(discard('d2', 5000, 7));
  });

  it('stores the documented shape', () => {
    recordDiscard('/work/app', discard('d1'));
    expect(JSON.parse(localStorage.getItem(LAST_DISCARD_KEY) ?? '')).toEqual({
      v: 1,
      byRepo: { '/work/app': discard('d1') },
    });
  });

  it('hides an entry once ten minutes have passed', () => {
    recordDiscard('/work/app', discard('d1', 1000));
    expect(readLastDiscard('/work/app', 1000 + DISCARD_UNDO_MS - 1)).not.toBeNull();
    expect(readLastDiscard('/work/app', 1000 + DISCARD_UNDO_MS)).toBeNull();
  });

  it('is ten minutes', () => {
    expect(DISCARD_UNDO_MS).toBe(600_000);
  });

  it('uses the clock when it is not given a time', () => {
    vi.spyOn(Date, 'now').mockReturnValue(5000);
    recordDiscard('/work/app', discard('d1', 4000));
    expect(readLastDiscard('/work/app')).not.toBeNull();
  });

  it('keeps a project named like an object member', () => {
    recordDiscard('__proto__', discard('d1'));
    expect(readLastDiscard('__proto__', 2000)?.receiptId).toBe('d1');
    expect(readLastDiscard('toString', 2000)).toBeNull();
  });
});

describe('forgetDiscard', () => {
  it('forgets the entry when the receipt matches', () => {
    recordDiscard('/work/app', discard('d1'));
    forgetDiscard('/work/app', 'd1');
    expect(readLastDiscard('/work/app', 2000)).toBeNull();
  });

  it('leaves a newer discard alone', () => {
    recordDiscard('/work/app', discard('d2'));
    forgetDiscard('/work/app', 'd1');
    expect(readLastDiscard('/work/app', 2000)?.receiptId).toBe('d2');
  });

  it('leaves the other projects alone', () => {
    recordDiscard('/work/app', discard('d1'));
    recordDiscard('/work/lib', discard('d2'));
    forgetDiscard('/work/app', 'd1');
    expect(readLastDiscard('/work/lib', 2000)?.receiptId).toBe('d2');
  });

  it('does nothing, and says nothing, for a project with no entry', () => {
    const cb = vi.fn();
    const off = subscribeDiscards(cb);
    forgetDiscard('/work/app', 'd1');
    off();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('junk in storage', () => {
  it.each([
    ['not JSON', '{nope'],
    ['a number', '3'],
    ['null', 'null'],
    ['another version', JSON.stringify({ v: 2, byRepo: { '/work/app': discard('d1') } })],
    ['no byRepo', JSON.stringify({ v: 1 })],
    ['a byRepo list', JSON.stringify({ v: 1, byRepo: [discard('d1')] })],
    [
      'an entry with no receipt',
      JSON.stringify({ v: 1, byRepo: { '/work/app': { at: 1, count: 1 } } }),
    ],
    ['an empty receipt', JSON.stringify({ v: 1, byRepo: { '/work/app': discard('') } })],
    [
      'a text time',
      JSON.stringify({ v: 1, byRepo: { '/work/app': { ...discard('d1'), at: 'x' } } }),
    ],
    [
      'a text count',
      JSON.stringify({ v: 1, byRepo: { '/work/app': { ...discard('d1'), count: '3' } } }),
    ],
  ])('reads %s as nothing', (_name, raw) => {
    localStorage.setItem(LAST_DISCARD_KEY, raw);
    expect(readLastDiscard('/work/app', 2000)).toBeNull();
  });

  it('loses only the bad entry', () => {
    localStorage.setItem(
      LAST_DISCARD_KEY,
      JSON.stringify({ v: 1, byRepo: { '/work/app': { nope: 1 }, '/work/lib': discard('d2') } }),
    );
    expect(readLastDiscard('/work/app', 2000)).toBeNull();
    expect(readLastDiscard('/work/lib', 2000)?.receiptId).toBe('d2');
  });

  it('writes over junk', () => {
    localStorage.setItem(LAST_DISCARD_KEY, '{nope');
    recordDiscard('/work/app', discard('d1'));
    expect(readLastDiscard('/work/app', 2000)?.receiptId).toBe('d1');
  });
});

describe('storage that throws', () => {
  it('reads as nothing when getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readLastDiscard('/work/app', 2000)).toBeNull();
  });

  it('swallows a failed write, and still tells subscribers', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    const cb = vi.fn();
    const off = subscribeDiscards(cb);
    expect(() => recordDiscard('/work/app', discard('d1'))).not.toThrow();
    off();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('subscribeDiscards', () => {
  it('is told of a record and of a forget made here', () => {
    const cb = vi.fn();
    const off = subscribeDiscards(cb);
    recordDiscard('/work/app', discard('d1'));
    forgetDiscard('/work/app', 'd1');
    off();
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('is told when another window changes the key', () => {
    const cb = vi.fn();
    const off = subscribeDiscards(cb);
    window.dispatchEvent(new StorageEvent('storage', { key: LAST_DISCARD_KEY }));
    expect(cb).toHaveBeenCalledTimes(1);
    off();
  });

  it('is told when another window clears storage', () => {
    const cb = vi.fn();
    const off = subscribeDiscards(cb);
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(cb).toHaveBeenCalledTimes(1);
    off();
  });

  it('ignores the storage events of other keys', () => {
    const cb = vi.fn();
    const off = subscribeDiscards(cb);
    window.dispatchEvent(new StorageEvent('storage', { key: 'palmux-explorer-open' }));
    off();
    expect(cb).not.toHaveBeenCalled();
  });

  it('stops after the unsubscribe, for writes and storage events alike', () => {
    const cb = vi.fn();
    subscribeDiscards(cb)();
    recordDiscard('/work/app', discard('d1'));
    window.dispatchEvent(new StorageEvent('storage', { key: LAST_DISCARD_KEY }));
    expect(cb).not.toHaveBeenCalled();
  });
});
