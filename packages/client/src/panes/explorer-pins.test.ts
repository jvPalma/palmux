// Pinned Explorer roots. Ordering and dedupe are the whole contract: the host
// opens the newest pin and collapses the rest, so "newest first" is not
// cosmetic — a root that appended to the bottom of a long list would have to be
// scrolled to immediately after being created.

import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addPin,
  explorerRoots,
  isPinned,
  normalizePin,
  parsePins,
  removePin,
  rootLabel,
  rootParent,
} from './explorer-pins';

describe('normalizePin', () => {
  it('strips trailing slashes but keeps the root', () => {
    expect(normalizePin('/home/user/')).toBe('/home/user');
    expect(normalizePin('/home/user///')).toBe('/home/user');
    expect(normalizePin('/')).toBe('/');
  });

  it('rejects anything not absolute', () => {
    expect(normalizePin('relative')).toBe('');
    expect(normalizePin('')).toBe('');
    expect(normalizePin('./a')).toBe('');
    expect(normalizePin('../a')).toBe('');
  });

  // B9-INSPECT2-02 / B10-01. The server answers with `path.resolve`d paths, so a
  // path that this function lets through in any other form is one the tree asks
  // for under one key and is answered under another.
  it('collapses repeated slashes', () => {
    expect(normalizePin('/a//b')).toBe('/a/b');
    expect(normalizePin('//a')).toBe('/a');
    expect(normalizePin('///')).toBe('/');
  });

  it('drops "." segments', () => {
    expect(normalizePin('/a/./b')).toBe('/a/b');
    expect(normalizePin('/home/u/.')).toBe('/home/u');
    expect(normalizePin('/.')).toBe('/');
  });

  it('resolves ".." segments and never climbs above the root', () => {
    expect(normalizePin('/a/b/../c')).toBe('/a/c');
    expect(normalizePin('/home/u//x/../y')).toBe('/home/u/y');
    expect(normalizePin('/..')).toBe('/');
    expect(normalizePin('/../../a')).toBe('/a');
    expect(normalizePin('/a/..')).toBe('/');
  });

  it('keeps a name that merely contains dots', () => {
    expect(normalizePin('/a/.hidden')).toBe('/a/.hidden');
    expect(normalizePin('/a/..b/c...')).toBe('/a/..b/c...');
  });

  it('is idempotent', () => {
    for (const p of ['/a//b/./c/../d/', '/', '/..', '/x/y']) {
      expect(normalizePin(normalizePin(p))).toBe(normalizePin(p));
    }
  });

  // Batch 11. `report ` and `report` are two different directories, so whitespace in a
  // path is part of its name. The server stopped trimming (a trimmed request was
  // answered with a sibling's listing, and a trimmed delete removed the sibling), and
  // this is the same identity on the client.
  describe('whitespace is significant', () => {
    it('keeps trailing whitespace inside a segment', () => {
      expect(normalizePin('/work/report ')).toBe('/work/report ');
      expect(normalizePin('/work/report  ')).toBe('/work/report  ');
      expect(normalizePin('/work/report\t')).toBe('/work/report\t');
      expect(normalizePin('/a/b  ')).toBe('/a/b  ');
      expect(normalizePin('/ ')).toBe('/ '); // a directory named by one space
    });

    it('keeps `report ` and `report` apart', () => {
      expect(normalizePin('/work/report ')).not.toBe(normalizePin('/work/report'));
      expect(normalizePin('/work/report /')).toBe('/work/report ');
      expect(normalizePin('/work/report /.')).toBe('/work/report ');
    });

    it('keeps leading whitespace inside a segment', () => {
      expect(normalizePin('/work/ report')).toBe('/work/ report');
    });

    // A leading space is not an absolute path: rejecting it beats repairing it into a
    // path the user never named.
    it('rejects a path that STARTS with whitespace instead of repairing it', () => {
      expect(normalizePin(' /a/b')).toBe('');
      expect(normalizePin('  /a/b  ')).toBe('');
      expect(normalizePin('\t/a')).toBe('');
      expect(normalizePin('\n/a')).toBe('');
      expect(normalizePin(' ')).toBe('');
    });

    // `report /.` used to come out as `/work/report` on the second pass (trim, then
    // canonicalise): the stored form was not a fixed point of the function that
    // wrote it, so a pin could be filed under one key and requested under another.
    it('is idempotent on the tricky cases', () => {
      for (const p of ['/work/report /.', '/a /b/../c ', '/ /', '/a/ /..']) {
        const once = normalizePin(p);
        expect(normalizePin(once), p).toBe(once);
      }
      expect(normalizePin('/work/report /.')).toBe('/work/report ');
      expect(normalizePin('/a /b/../c ')).toBe('/a /c ');
      expect(normalizePin('/ /')).toBe('/ ');
      expect(normalizePin('/a/ /..')).toBe('/a');
    });

    // Every spelling of a short path over a segment alphabet that includes the
    // whitespace-bearing ones: idempotent, and equal to the server's `path.resolve`
    // (which is the key a listing is answered under) for everything absolute.
    it('is idempotent and agrees with path.resolve over every short path', () => {
      const alphabet = ['', '.', '..', 'a', 'a ', ' a', ' ', '\t', '.. ', '. '];
      const spellings: string[] = [];
      const grow = (prefix: string, depth: number): void => {
        spellings.push(prefix);
        if (depth === 0) return;
        for (const segment of alphabet) grow(`${prefix}/${segment}`, depth - 1);
      };
      grow('', 4);
      expect(spellings.length).toBeGreaterThan(10_000);
      for (const raw of spellings) {
        for (const p of [raw, `${raw}/`]) {
          const once = normalizePin(p);
          if (normalizePin(once) !== once) throw new Error(`not idempotent: ${JSON.stringify(p)}`);
          if (p.startsWith('/') && once !== posix.resolve(p)) {
            throw new Error(`differs from path.resolve: ${JSON.stringify(p)}`);
          }
        }
      }
    });
  });
});

describe('addPin', () => {
  it('puts the newest first', () => {
    expect(addPin(['/a'], '/b')).toEqual(['/b', '/a']);
  });

  it('moves an existing pin to the front instead of duplicating it', () => {
    expect(addPin(['/a', '/b', '/c'], '/c')).toEqual(['/c', '/a', '/b']);
    expect(addPin(['/a/'], '/a')).toEqual(['/a']);
  });

  it('ignores an unusable path rather than storing junk', () => {
    expect(addPin(['/a'], 'relative')).toEqual(['/a']);
    expect(addPin(['/a'], '')).toEqual(['/a']);
  });
});

describe('removePin / isPinned / addPin keep whitespace significant', () => {
  it('unpins `report ` and leaves `report` pinned, and the other way round', () => {
    expect(removePin(['/work/report ', '/work/report'], '/work/report ')).toEqual(['/work/report']);
    expect(removePin(['/work/report ', '/work/report'], '/work/report')).toEqual(['/work/report ']);
    expect(isPinned(['/work/report'], '/work/report ')).toBe(false);
    expect(isPinned(['/work/report '], '/work/report /.')).toBe(true);
  });

  it('pins `report ` next to `report` instead of deduplicating them', () => {
    expect(addPin(['/work/report'], '/work/report ')).toEqual(['/work/report ', '/work/report']);
    expect(addPin(['/work/report /.'], '/work/report ')).toEqual(['/work/report ']);
  });

  it('refuses a path with leading whitespace', () => {
    expect(addPin(['/a'], ' /b')).toEqual(['/a']);
  });
});

describe('removePin / isPinned', () => {
  it('matches regardless of a trailing slash', () => {
    expect(removePin(['/a', '/b'], '/a/')).toEqual(['/b']);
    expect(isPinned(['/a/'], '/a')).toBe(true);
    expect(isPinned(['/ab'], '/a')).toBe(false);
  });

  // A pin synced from another machine may carry any spelling of the path.
  it('treats a non-canonical spelling as the same pin', () => {
    expect(removePin(['/work/./project', '/b'], '/work/project')).toEqual(['/b']);
    expect(removePin(['/work/project', '/b'], '/work//project/../project')).toEqual(['/b']);
    expect(isPinned(['/work/./project'], '/work/project')).toBe(true);
    expect(addPin(['/work/./project'], '/work/project')).toEqual(['/work/project']);
  });
});

describe('explorerRoots', () => {
  it('puts home first, then the pins in order', () => {
    expect(explorerRoots('/home/user', ['/srv/app', '/opt/x'])).toEqual([
      '/home/user',
      '/srv/app',
      '/opt/x',
    ]);
  });

  // Home is the tree's floor and cannot be unpinned, so drawing it twice would
  // give the user a root they cannot remove next to one they can.
  it('never draws home twice', () => {
    expect(explorerRoots('/home/user', ['/home/user/'])).toEqual(['/home/user']);
  });

  // The entire point of a pin: a shortcut into a tree you can already reach the
  // slow way.
  it('keeps a pin nested inside home', () => {
    expect(explorerRoots('/home/user', ['/home/user/projects'])).toEqual([
      '/home/user',
      '/home/user/projects',
    ]);
  });

  it('draws `report ` and `report` as two roots', () => {
    expect(explorerRoots('/home/u', ['/work/report ', '/work/report'])).toEqual([
      '/home/u',
      '/work/report ',
      '/work/report',
    ]);
  });

  it('survives home being unknown, and dedupes the pins', () => {
    expect(explorerRoots(null, ['/a', '/a/', '/b'])).toEqual(['/a', '/b']);
    expect(explorerRoots(null, [])).toEqual([]);
  });

  // The root is what the tree REQUESTS, and the server answers under the resolved
  // path, so a root left in any other spelling would be requested under a key it is
  // never answered under.
  it('names every root by its canonical path', () => {
    expect(explorerRoots('/home/u/.', ['/work/./project', '/home/u//'])).toEqual([
      '/home/u',
      '/work/project',
    ]);
  });
});

describe('rootLabel / rootParent keep whitespace', () => {
  it('labels `report ` with the space the folder is named with', () => {
    expect(rootLabel('/work/report ')).toBe('report ');
    expect(rootParent('/work/report ')).toBe('/work/');
    expect(rootParent('/a /b')).toBe('/a /');
  });
});

describe('rootLabel', () => {
  it('is the last segment', () => {
    expect(rootLabel('/home/user/projects')).toBe('projects');
    expect(rootLabel('/home/user/')).toBe('user');
    expect(rootLabel('/')).toBe('/');
  });
});

describe('rootParent', () => {
  it('is the containing directory, with a trailing slash', () => {
    expect(rootParent('/home/user/projects')).toBe('/home/user/');
    expect(rootParent('/srv')).toBe('/');
  });

  it('is empty at the filesystem root, where there is no parent to name', () => {
    expect(rootParent('/')).toBe('');
    expect(rootParent('nonsense')).toBe('');
  });
});

describe('parsePins', () => {
  // Batch 11: a stored pin is never rewritten to a sibling. A trailing-space pin is
  // its own folder, and a pin that starts with whitespace is not a path at all.
  it('keeps a pin whose last segment ends in whitespace, apart from its sibling', () => {
    expect(parsePins(['/work/report ', '/work/report'])).toEqual(['/work/report ', '/work/report']);
    expect(parsePins(['/work/report /.'])).toEqual(['/work/report ']);
    expect(parsePins(parsePins(['/work/report /.', '/a /b/../c ']))).toEqual([
      '/work/report ',
      '/a /c ',
    ]);
  });

  it('drops a pin with leading whitespace instead of repairing it', () => {
    expect(parsePins([' /a', '/b'])).toEqual(['/b']);
  });

  it('drops anything unusable and never throws', () => {
    expect(parsePins(['/a', 42, null, 'rel', '', '/a/', '/b'])).toEqual(['/a', '/b']);
    expect(parsePins('nope')).toEqual([]);
    expect(parsePins(undefined)).toEqual([]);
  });

  // `/` as a pinned root would list the whole filesystem under a second header
  // that duplicates what expanding home already reaches.
  it('refuses the filesystem root', () => {
    expect(parsePins(['/'])).toEqual([]);
    expect(parsePins(['/..', '/a/..'])).toEqual([]); // both resolve to it
  });

  it('stores a pin in its canonical form and dedupes across spellings', () => {
    expect(parsePins(['/work/./project', '/work/project/', '/a//b'])).toEqual([
      '/work/project',
      '/a/b',
    ]);
  });
});
