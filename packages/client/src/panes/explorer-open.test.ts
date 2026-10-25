import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OPEN_ROOTS_KEY,
  parseOpenRoots,
  readOpenRoots,
  serializeOpenRoots,
  writeOpenRoots,
} from './explorer-open';

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('parseOpenRoots', () => {
  it('reads the stored open set', () => {
    expect(parseOpenRoots('{"v":1,"open":["/home/u","/work"]}')).toEqual(['/home/u', '/work']);
  });

  it('keeps an empty set: "everything collapsed" is a state, not a missing one', () => {
    expect(parseOpenRoots('{"v":1,"open":[]}')).toEqual([]);
  });

  it('answers null when nothing usable is stored', () => {
    for (const raw of [
      null,
      '',
      'not json',
      '{"v":1,',
      'null',
      '42',
      '"x"',
      '[]',
      '["/work"]',
      '{}',
      '{"v":1}',
      '{"v":1,"open":"/work"}',
      '{"v":1,"open":{"0":"/work"}}',
      '{"v":2,"open":["/work"]}',
      '{"open":["/work"]}',
    ]) {
      expect(parseOpenRoots(raw), String(raw)).toBeNull();
    }
  });

  it('drops entries that are not absolute paths and keeps the rest', () => {
    expect(
      parseOpenRoots(JSON.stringify({ v: 1, open: ['/a', 'b', '', 7, null, {}, ['/c'], '/d'] })),
    ).toEqual(['/a', '/d']);
  });

  // The roots the tree compares against are normalised (no trailing slash), so a
  // hand-edited `/work/` must still match the `/work` root rather than go dormant.
  it('normalises paths and drops duplicates', () => {
    expect(parseOpenRoots('{"v":1,"open":["/work/","/work"," /x ","/"]}')).toEqual([
      '/work',
      '/x',
      '/',
    ]);
  });
});

describe('serializeOpenRoots', () => {
  it('writes the versioned shape', () => {
    expect(JSON.parse(serializeOpenRoots(new Set(['/home/u', '/work'])))).toEqual({
      v: 1,
      open: ['/home/u', '/work'],
    });
  });

  it('round-trips through the parser', () => {
    const open = ['/a', '/b/c'];
    expect(parseOpenRoots(serializeOpenRoots(open))).toEqual(open);
  });
});

describe('readOpenRoots / writeOpenRoots', () => {
  it('is null on a device that has never stored anything', () => {
    expect(readOpenRoots()).toBeNull();
  });

  it('persists under palmux-explorer-open and reads it back', () => {
    writeOpenRoots(['/home/u', '/work']);
    expect(OPEN_ROOTS_KEY).toBe('palmux-explorer-open');
    expect(JSON.parse(localStorage.getItem('palmux-explorer-open') ?? 'null')).toEqual({
      v: 1,
      open: ['/home/u', '/work'],
    });
    expect(readOpenRoots()).toEqual(['/home/u', '/work']);
  });

  it('treats a corrupt stored value as no state', () => {
    localStorage.setItem(OPEN_ROOTS_KEY, '{oops');
    expect(readOpenRoots()).toBeNull();
  });

  // Private mode and a full quota both throw from storage. The Explorer must
  // render either way, so neither function may let the exception out.
  //
  // A valid value is seeded BEFORE the stub goes in: a stub that never took effect
  // would still read null from an empty store, and the test would prove nothing.
  it('swallows a storage that throws', () => {
    writeOpenRoots(['/work']);
    const denied = vi.fn(() => {
      throw new Error('denied');
    });
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied, removeItem: denied });
    expect(readOpenRoots()).toBeNull();
    expect(() => writeOpenRoots(['/other'])).not.toThrow();
    expect(denied).toHaveBeenCalledTimes(2);
  });

  it('swallows a storage that is missing altogether', () => {
    writeOpenRoots(['/work']);
    vi.stubGlobal('localStorage', undefined);
    expect(readOpenRoots()).toBeNull();
    expect(() => writeOpenRoots(['/other'])).not.toThrow();
    vi.unstubAllGlobals();
    expect(readOpenRoots()).toEqual(['/work']); // the stubbed write never reached the real one
  });
});
