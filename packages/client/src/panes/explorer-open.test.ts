import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXPANDED_DIRS_KEY,
  MAX_EXPANDED_DIRS,
  OPEN_ROOTS_KEY,
  forgetDeletedDirs,
  parseExpandedDirs,
  parseOpenRoots,
  readExpandedDirs,
  readOpenRoots,
  serializeExpandedDirs,
  serializeOpenRoots,
  subscribeDeletedDirs,
  withoutDeleted,
  writeExpandedDir,
  writeExpandedDirs,
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
    expect(parseOpenRoots('{"v":1,"open":["/work/","/work","/x/","/"]}')).toEqual([
      '/work',
      '/x',
      '/',
    ]);
  });

  // Batch 11: whitespace is part of a path's name. A leading space is not absolute and
  // is dropped like any other non-path; trailing whitespace inside the last segment is
  // the folder's own name and survives, apart from its sibling.
  it('drops an entry with leading whitespace and keeps a trailing-space name as itself', () => {
    expect(parseOpenRoots('{"v":1,"open":["/work"," /x ","/work/report ","/work/report"]}')).toEqual(
      ['/work', '/work/report ', '/work/report'],
    );
  });

  it('restores `report /.` as `report `, not as its sibling', () => {
    expect(parseOpenRoots('{"v":1,"open":["/work/report /."]}')).toEqual(['/work/report ']);
  });

  it('round-trips a trailing-space root through the writer and the parser', () => {
    const open = ['/work/report ', '/work/report'];
    expect(parseOpenRoots(serializeOpenRoots(open))).toEqual(open);
    writeOpenRoots(open);
    expect(readOpenRoots()).toEqual(open);
  });

  // B9-INSPECT2-02: a stored `/home/u/.` used to survive as itself, be requested as
  // such, and be answered under the resolved path, which looped the load effect.
  it('restores a non-canonical stored path as its canonical form', () => {
    expect(
      parseOpenRoots('{"v":1,"open":["/home/u/.","/home/u//x/../y","/home/u","/a/./b/"]}'),
    ).toEqual(['/home/u', '/home/u/y', '/a/b']);
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

// The folders a USER opened inside the roots. A second key from the open roots on
// purpose: a root is a section header and a folder is a row, and the two used to
// share one set (the root was seeded into the folder set to get it fetched).
describe('parseExpandedDirs', () => {
  it('reads the stored folders in their stored order', () => {
    expect(parseExpandedDirs('{"v":1,"dirs":["/home/u/a","/work/b"]}')).toEqual([
      '/home/u/a',
      '/work/b',
    ]);
  });

  it('keeps an empty list', () => {
    expect(parseExpandedDirs('{"v":1,"dirs":[]}')).toEqual([]);
  });

  // No first-run state to protect here, unlike the open roots: nothing stored and
  // nothing expanded are the same Explorer, so the answer is always a list.
  it('answers an empty list for anything unusable', () => {
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
      '{"v":1,"dirs":"/work"}',
      '{"v":1,"dirs":{"0":"/work"}}',
      '{"v":2,"dirs":["/work"]}',
      '{"dirs":["/work"]}',
      // the OTHER key's shape must not be mistaken for this one
      '{"v":1,"open":["/work"]}',
    ]) {
      expect(parseExpandedDirs(raw), String(raw)).toEqual([]);
    }
  });

  it('drops entries that are not absolute paths and keeps the rest', () => {
    expect(
      parseExpandedDirs(JSON.stringify({ v: 1, dirs: ['/a', 'b', '', 7, null, {}, ['/c'], '/d'] })),
    ).toEqual(['/a', '/d']);
  });

  it('normalises paths and drops duplicates, keeping the first', () => {
    expect(parseExpandedDirs('{"v":1,"dirs":["/work/","/x","/y/","/work"]}')).toEqual([
      '/work',
      '/x',
      '/y',
    ]);
  });

  // Batch 11, as for the open roots: leading whitespace is not a path, trailing
  // whitespace is part of the folder's name.
  it('drops an entry with leading whitespace and keeps a trailing-space name as itself', () => {
    expect(
      parseExpandedDirs('{"v":1,"dirs":["/work"," /y ","/work/report ","/work/report"]}'),
    ).toEqual(['/work', '/work/report ', '/work/report']);
  });

  it('restores `report /.` as `report `, not as its sibling', () => {
    expect(parseExpandedDirs('{"v":1,"dirs":["/work/report /."]}')).toEqual(['/work/report ']);
  });

  it('round-trips a trailing-space folder through the writer and the parser', () => {
    const dirs = ['/work/report ', '/work/report'];
    expect(parseExpandedDirs(serializeExpandedDirs(dirs))).toEqual(dirs);
    writeExpandedDirs(dirs);
    expect(readExpandedDirs()).toEqual(dirs);
  });

  it('restores a non-canonical stored path as its canonical form', () => {
    expect(
      parseExpandedDirs('{"v":1,"dirs":["/home/u/.","/home/u//x/../y","/home/u","/a/./b/"]}'),
    ).toEqual(['/home/u', '/home/u/y', '/a/b']);
  });

  it('keeps only the newest MAX_EXPANDED_DIRS of a hand-edited, oversized list', () => {
    const dirs = Array.from({ length: MAX_EXPANDED_DIRS + 5 }, (_, i) => `/d${i}`);
    const out = parseExpandedDirs(JSON.stringify({ v: 1, dirs }));
    expect(out).toHaveLength(MAX_EXPANDED_DIRS);
    expect(out[0]).toBe('/d5'); // the five oldest went
    expect(out.at(-1)).toBe(`/d${MAX_EXPANDED_DIRS + 4}`);
  });
});

describe('serializeExpandedDirs', () => {
  it('writes the versioned shape', () => {
    expect(JSON.parse(serializeExpandedDirs(new Set(['/a', '/b/c'])))).toEqual({
      v: 1,
      dirs: ['/a', '/b/c'],
    });
  });

  it('round-trips through the parser', () => {
    const dirs = ['/a', '/b/c'];
    expect(parseExpandedDirs(serializeExpandedDirs(dirs))).toEqual(dirs);
  });

  // Bounded because nothing else forgets: a folder is dropped only when the Explorer
  // itself deletes it, so records for folders that vanished elsewhere would
  // otherwise pile up for good. Oldest first, since the newest is what you opened.
  it('caps at MAX_EXPANDED_DIRS, dropping the oldest', () => {
    expect(MAX_EXPANDED_DIRS).toBe(200);
    const dirs = Array.from({ length: MAX_EXPANDED_DIRS + 1 }, (_, i) => `/d${i}`);
    const stored = (JSON.parse(serializeExpandedDirs(dirs)) as { dirs: string[] }).dirs;
    expect(stored).toHaveLength(200);
    expect(stored[0]).toBe('/d1');
    expect(stored.at(-1)).toBe('/d200');
  });

  it('does not cap a list at the limit', () => {
    const dirs = Array.from({ length: MAX_EXPANDED_DIRS }, (_, i) => `/d${i}`);
    expect((JSON.parse(serializeExpandedDirs(dirs)) as { dirs: string[] }).dirs).toEqual(dirs);
  });
});

describe('readExpandedDirs / writeExpandedDirs', () => {
  it('is empty on a device that has never stored anything', () => {
    expect(readExpandedDirs()).toEqual([]);
  });

  it('persists under palmux-explorer-expanded and reads it back', () => {
    writeExpandedDirs(['/home/u/a', '/work/b']);
    expect(EXPANDED_DIRS_KEY).toBe('palmux-explorer-expanded');
    expect(JSON.parse(localStorage.getItem('palmux-explorer-expanded') ?? 'null')).toEqual({
      v: 1,
      dirs: ['/home/u/a', '/work/b'],
    });
    expect(readExpandedDirs()).toEqual(['/home/u/a', '/work/b']);
  });

  it('shares nothing with the open-roots key', () => {
    writeOpenRoots(['/home/u']);
    writeExpandedDirs(['/home/u/a']);
    expect(readOpenRoots()).toEqual(['/home/u']);
    expect(readExpandedDirs()).toEqual(['/home/u/a']);
  });

  it('treats a corrupt stored value as no state', () => {
    localStorage.setItem(EXPANDED_DIRS_KEY, '{oops');
    expect(readExpandedDirs()).toEqual([]);
  });

  // A valid value is seeded BEFORE the stub goes in, as for the open roots: a stub
  // that never took effect would still read empty from an empty store.
  it('swallows a storage that throws', () => {
    writeExpandedDirs(['/work']);
    const denied = vi.fn(() => {
      throw new Error('denied');
    });
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied, removeItem: denied });
    expect(readExpandedDirs()).toEqual([]);
    expect(() => writeExpandedDirs(['/other'])).not.toThrow();
    expect(denied).toHaveBeenCalledTimes(2);
  });

  it('swallows a storage that is missing altogether', () => {
    writeExpandedDirs(['/work']);
    vi.stubGlobal('localStorage', undefined);
    expect(readExpandedDirs()).toEqual([]);
    expect(() => writeExpandedDirs(['/other'])).not.toThrow();
    vi.unstubAllGlobals();
    expect(readExpandedDirs()).toEqual(['/work']); // the stubbed write never reached the real one
  });
});

// B9-CODE-03. Two FileTree mounts can be alive at once (the dock and the drawer, two
// windows), and a delete can finish after the tree that sent it has unmounted. So
// every write is a change applied to what is stored NOW, never a snapshot of one
// mount's memory, which could erase what another mount opened meanwhile.
describe('writeExpandedDir', () => {
  it('opens one folder on top of what is stored now, newest last', () => {
    writeExpandedDirs(['/a', '/b']); // another mount's state
    writeExpandedDir('/c', true);
    expect(readExpandedDirs()).toEqual(['/a', '/b', '/c']);
    writeExpandedDir('/a', true); // reopened: it is the newest again
    expect(readExpandedDirs()).toEqual(['/b', '/c', '/a']);
  });

  it('closes one folder and keeps everything else, its descendants included', () => {
    writeExpandedDirs(['/a', '/a/x', '/b']);
    writeExpandedDir('/a', false);
    expect(readExpandedDirs()).toEqual(['/a/x', '/b']);
  });

  it('keeps the newest MAX_EXPANDED_DIRS', () => {
    writeExpandedDirs(Array.from({ length: MAX_EXPANDED_DIRS }, (_, i) => `/d${i}`));
    writeExpandedDir('/new', true);
    const dirs = readExpandedDirs();
    expect(dirs).toHaveLength(MAX_EXPANDED_DIRS);
    expect(dirs[0]).toBe('/d1');
    expect(dirs.at(-1)).toBe('/new');
  });

  it('swallows a storage that throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(() => writeExpandedDir('/a', true)).not.toThrow();
  });

  // B10-01. A write names a folder by the one identity the parse restores, so a
  // spelling never stores a second record for the folder it already holds.
  it('records and removes a folder under its canonical path', () => {
    writeExpandedDirs(['/a/b']);
    writeExpandedDir('/a/./b/', true); // the same folder, reopened: newest again
    writeExpandedDir('/c//d', true);
    expect(readExpandedDirs()).toEqual(['/a/b', '/c/d']);
    writeExpandedDir('/a/x/../b', false);
    expect(readExpandedDirs()).toEqual(['/c/d']);
  });

  it('refuses a path that is not absolute rather than storing junk', () => {
    writeExpandedDirs(['/a']);
    const before = localStorage.getItem(EXPANDED_DIRS_KEY);
    writeExpandedDir('relative', true);
    writeExpandedDir('', true);
    writeExpandedDir('relative', false);
    writeExpandedDir(' /a', true); // leading whitespace is not absolute
    expect(localStorage.getItem(EXPANDED_DIRS_KEY)).toBe(before); // not even rewritten
  });

  // Batch 11. `report ` and `report` are two folders: opening or closing one must
  // never touch the other's record.
  it('records and closes `report ` without touching its sibling `report`', () => {
    writeExpandedDir('/work/report', true);
    writeExpandedDir('/work/report ', true);
    expect(readExpandedDirs()).toEqual(['/work/report', '/work/report ']);
    writeExpandedDir('/work/report ', false);
    expect(readExpandedDirs()).toEqual(['/work/report']);
    writeExpandedDir('/work/report ', true);
    writeExpandedDir('/work/report', false);
    expect(readExpandedDirs()).toEqual(['/work/report ']);
  });

  // B10-R2-01, outcome (c). Web Storage has no cross-window lock, so a write is a
  // read, a change and a write with a gap in the middle. Window A opens `/work/other`;
  // window B collapses `/work/a` inside that gap; A then writes back what it read,
  // which still holds `/work/a`. The collapse is lost and the folder reopens on the
  // next mount. This is the documented, accepted outcome (CLAUDE.md, Explorer
  // persistence): a future change to the scheme, a lock or a merge, makes this fail
  // and has to decide on purpose.
  it('loses a collapse that lands inside another window\'s read-modify-write (outcome c)', () => {
    writeExpandedDirs(['/work/a']);
    // Spied on the INSTANCE: happy-dom's Storage does not route through the prototype.
    const real = localStorage.getItem.bind(localStorage);
    let raced = false;
    let otherWindowWrote: unknown = null;
    let competingWrites = 0;
    let reads = 0;
    const read = vi.spyOn(localStorage, 'getItem').mockImplementation((key: string) => {
      if (key !== EXPANDED_DIRS_KEY) return real(key);
      reads++;
      const seen = real(key); // window A's read, before B has written
      if (!raced) {
        // Spent BEFORE B runs: B's own read comes back through this mock, and a guard
        // still unset there re-runs B inside itself until the stack overflows, which
        // `readExpandedDirs` swallows — the race would then be whatever survived that.
        raced = true;
        competingWrites++;
        writeExpandedDir('/work/a', false); // window B, start to finish
        otherWindowWrote = JSON.parse(real(key) ?? 'null');
      }
      return seen;
    });
    const write = vi.spyOn(localStorage, 'setItem');
    let writes = 0;
    try {
      writeExpandedDir('/work/other', true); // window A
      writes = write.mock.calls.filter(([key]) => key === EXPANDED_DIRS_KEY).length;
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
    // One race, run once: A's read and B's read, then B's write and A's write.
    expect(competingWrites).toBe(1);
    expect(reads).toBe(2);
    expect(writes).toBe(2);
    // Guard against a vacuous pass: B's collapse really was committed inside A's gap.
    expect(otherWindowWrote).toEqual({ v: 1, dirs: [] });
    expect(readExpandedDirs()).toEqual(['/work/a', '/work/other']);
  });
});

describe('forgetDeletedDirs', () => {
  it('drops each deleted folder and every one under it from what is stored now', () => {
    writeExpandedDirs(['/home/u/pro', '/home/u/proj', '/home/u/proj/src', '/work']);
    forgetDeletedDirs(['/home/u/proj']);
    // `/home/u/pro` is a prefix of `/home/u/proj` as a string, not as a path.
    expect(readExpandedDirs()).toEqual(['/home/u/pro', '/work']);
  });

  it('tells every subscribed tree, and stops telling one that unsubscribed', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeDeletedDirs(a);
    const offB = subscribeDeletedDirs(b);
    forgetDeletedDirs(['/x']);
    expect(a).toHaveBeenCalledWith(['/x']);
    expect(b).toHaveBeenCalledWith(['/x']);

    offA();
    forgetDeletedDirs(['/y']);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledWith(['/y']);
    offB();
  });

  // B10-01. A delete names the folder as the server reported it, and a stored record
  // is canonical, so a differing spelling must still match.
  it('matches a deleted path by its canonical form, in storage and for the trees', () => {
    writeExpandedDirs(['/work/proj', '/work/proj/src', '/work/other']);
    const heard = vi.fn();
    const off = subscribeDeletedDirs(heard);
    forgetDeletedDirs(['/work/./proj/']);
    expect(readExpandedDirs()).toEqual(['/work/other']);
    expect(heard).toHaveBeenCalledWith(['/work/proj']);
    off();
  });

  // Batch 11. Deleting `report ` forgets `report ` and what is under it — never the
  // sibling `report`, which the same call used to match after the trim.
  it('forgets a deleted `report ` and its children, and leaves `report` stored', () => {
    writeExpandedDirs(['/work/report', '/work/report/src', '/work/report ', '/work/report /src']);
    const heard = vi.fn();
    const off = subscribeDeletedDirs(heard);
    forgetDeletedDirs(['/work/report ']);
    expect(readExpandedDirs()).toEqual(['/work/report', '/work/report/src']);
    expect(heard).toHaveBeenCalledWith(['/work/report ']);
    off();
  });

  it('forgets a deleted `report` and its children, and leaves `report ` stored', () => {
    writeExpandedDirs(['/work/report', '/work/report/src', '/work/report ', '/work/report /src']);
    forgetDeletedDirs(['/work/report']);
    expect(readExpandedDirs()).toEqual(['/work/report ', '/work/report /src']);
  });

  it('ignores a deleted path that is not absolute', () => {
    writeExpandedDirs(['/a']);
    const heard = vi.fn();
    const off = subscribeDeletedDirs(heard);
    forgetDeletedDirs(['relative', '', ' /a']);
    expect(readExpandedDirs()).toEqual(['/a']);
    expect(heard).not.toHaveBeenCalled();
    off();
  });

  // Storage being unavailable does not make the folder any less deleted.
  it('still tells the trees when storage throws', () => {
    const heard = vi.fn();
    const off = subscribeDeletedDirs(heard);
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(() => forgetDeletedDirs(['/x'])).not.toThrow();
    expect(heard).toHaveBeenCalledWith(['/x']);
    off();
  });
});

describe('withoutDeleted', () => {
  it('matches by path segment', () => {
    expect(withoutDeleted(['/a', '/a/b', '/ab', '/c'], ['/a'])).toEqual(['/ab', '/c']);
  });

  it('does not take `report ` for `report`, nor `report` for `report `', () => {
    const dirs = ['/w/report', '/w/report/x', '/w/report ', '/w/report /x'];
    expect(withoutDeleted(dirs, ['/w/report '])).toEqual(['/w/report', '/w/report/x']);
    expect(withoutDeleted(dirs, ['/w/report'])).toEqual(['/w/report ', '/w/report /x']);
  });

  it('keeps everything when nothing was deleted', () => {
    expect(withoutDeleted(new Set(['/a', '/b']), [])).toEqual(['/a', '/b']);
  });
});
