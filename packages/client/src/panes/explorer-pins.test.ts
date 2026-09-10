// Pinned Explorer roots. Ordering and dedupe are the whole contract: the host
// opens the newest pin and collapses the rest, so "newest first" is not
// cosmetic — a root that appended to the bottom of a long list would have to be
// scrolled to immediately after being created.

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
    expect(normalizePin('  /a/b  ')).toBe('/a/b');
  });

  it('rejects anything not absolute', () => {
    expect(normalizePin('relative')).toBe('');
    expect(normalizePin('')).toBe('');
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

describe('removePin / isPinned', () => {
  it('matches regardless of a trailing slash', () => {
    expect(removePin(['/a', '/b'], '/a/')).toEqual(['/b']);
    expect(isPinned(['/a/'], '/a')).toBe(true);
    expect(isPinned(['/ab'], '/a')).toBe(false);
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

  it('survives home being unknown, and dedupes the pins', () => {
    expect(explorerRoots(null, ['/a', '/a/', '/b'])).toEqual(['/a', '/b']);
    expect(explorerRoots(null, [])).toEqual([]);
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
  it('drops anything unusable and never throws', () => {
    expect(parsePins(['/a', 42, null, 'rel', '', '/a/', '/b'])).toEqual(['/a', '/b']);
    expect(parsePins('nope')).toEqual([]);
    expect(parsePins(undefined)).toEqual([]);
  });

  // `/` as a pinned root would list the whole filesystem under a second header
  // that duplicates what expanding home already reaches.
  it('refuses the filesystem root', () => {
    expect(parsePins(['/'])).toEqual([]);
  });
});
