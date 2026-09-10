// The wording that guards an irreversible action, and the refresh set that
// follows it. Both are pure on purpose: a confirm string built inline in a
// component is a string nobody ever tests, and this one is the last thing
// between a misclick and a deleted project.

import { describe, expect, it } from 'vitest';
import { affectedDirs, deleteConfirmMessage, deleteSummary } from './explorer-actions';

describe('deleteConfirmMessage', () => {
  it('names a single file', () => {
    const msg = deleteConfirmMessage([{ path: '/home/user/notes.md', dir: false }]) ?? '';
    expect(msg).toContain('Delete file “notes.md”?');
    expect(msg).toContain('cannot be undone');
    expect(msg).not.toContain('inside');
  });

  // The one that matters: a folder takes its contents, and "delete projects?" does
  // not say so.
  it('says a folder takes everything inside it', () => {
    const msg = deleteConfirmMessage([{ path: '/home/user/projects', dir: true }]) ?? '';
    expect(msg).toContain('Delete folder “projects”?');
    expect(msg).toContain('Everything inside it is deleted too.');
  });

  it('counts a mixed bulk selection by kind', () => {
    const msg =
      deleteConfirmMessage([
        { path: '/a/one.txt', dir: false },
        { path: '/a/two.txt', dir: false },
        { path: '/a/pkg', dir: true },
      ]) ?? '';
    expect(msg).toContain('Delete 3 items?');
    expect(msg).toContain('2 files and 1 folder.');
    expect(msg).toContain('Folders are deleted with everything inside them.');
  });

  it('says nothing about folders when there are none', () => {
    const msg =
      deleteConfirmMessage([
        { path: '/a/one.txt', dir: false },
        { path: '/a/two.txt', dir: false },
      ]) ?? '';
    expect(msg).toContain('2 files.');
    expect(msg).not.toMatch(/folder/i);
  });

  // Null, not an empty string: the caller uses it to skip the dialog entirely,
  // and an empty confirm() is a dialog with no question in it.
  it('is null for an empty selection', () => {
    expect(deleteConfirmMessage([])).toBeNull();
  });
});

describe('deleteSummary', () => {
  it('counts a clean run', () => {
    expect(deleteSummary([{ path: '/a', ok: true, kind: 'file' }])).toBe('Deleted 1 item');
    expect(
      deleteSummary([
        { path: '/a', ok: true, kind: 'file' },
        { path: '/b', ok: true, kind: 'directory' },
      ]),
    ).toBe('Deleted 2 items');
  });

  it('quotes the reason when exactly one thing failed', () => {
    expect(deleteSummary([{ path: '/a', ok: false, message: 'permission denied' }])).toBe(
      'Delete failed: permission denied',
    );
  });

  it('reports a partial failure as both numbers', () => {
    expect(
      deleteSummary([
        { path: '/a', ok: true, kind: 'file' },
        { path: '/b', ok: false, message: 'busy' },
      ]),
    ).toBe('Deleted 1, 1 failed');
  });

  it('does not quote a reason when several differ', () => {
    expect(
      deleteSummary([
        { path: '/a', ok: false, message: 'busy' },
        { path: '/b', ok: false, message: 'permission denied' },
      ]),
    ).toBe('Delete failed');
  });
});

describe('affectedDirs', () => {
  // The deleted path is gone; the LISTING that showed it is what is now wrong.
  it('is the parents, deduped', () => {
    expect(affectedDirs(['/a/b/one.txt', '/a/b/two.txt', '/a/c/three.txt']).sort()).toEqual([
      '/a/b',
      '/a/c',
    ]);
  });

  it('maps a top-level path to the filesystem root', () => {
    expect(affectedDirs(['/thing'])).toEqual(['/']);
  });

  it('is empty for nothing', () => {
    expect(affectedDirs([])).toEqual([]);
  });
});
