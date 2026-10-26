// The writes still inside their Undo window: what lets one toast offer one Undo for
// all of them, and lets a write fall out of it once its 6 seconds are up.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetWrites,
  recordWrite,
  resetWriteLog,
  UNDO_WINDOW_MS,
  type LoggedWrite,
} from './write-log';

const write = (receiptId: string, at: number, over: Partial<LoggedWrite> = {}): LoggedWrite => ({
  repo: '/work/app',
  receiptId,
  action: 'stage',
  name: `${receiptId}.ts`,
  at,
  ...over,
});

beforeEach(resetWriteLog);

describe('the recent writes', () => {
  it('starts with the one write', () => {
    expect(recordWrite(write('r1', 0)).map((w) => w.receiptId)).toEqual(['r1']);
  });

  it('keeps every write inside the window, oldest first, the newest last', () => {
    recordWrite(write('r1', 0));
    recordWrite(write('r2', 2000));
    expect(recordWrite(write('r3', 5999)).map((w) => w.receiptId)).toEqual(['r1', 'r2', 'r3']);
  });

  it('drops a write once its own 6 seconds are over', () => {
    recordWrite(write('r1', 0));
    recordWrite(write('r2', 4000));
    // r1 is exactly one window old: gone. r2 is 2s old: kept.
    expect(recordWrite(write('r3', UNDO_WINDOW_MS)).map((w) => w.receiptId)).toEqual(['r2', 'r3']);
  });

  it('keeps the writes of every project: one toast, so one list', () => {
    recordWrite(write('r1', 0, { repo: '/work/app' }));
    const all = recordWrite(write('r2', 1000, { repo: '/work/lib' }));
    expect(all.map((w) => w.repo)).toEqual(['/work/app', '/work/lib']);
  });

  it('hands out a copy: changing it changes nothing here', () => {
    const first = recordWrite(write('r1', 0));
    first.length = 0;
    expect(recordWrite(write('r2', 10)).map((w) => w.receiptId)).toEqual(['r1', 'r2']);
  });

  it('forgets what was undone, and only that', () => {
    const all = recordWrite(write('r1', 0));
    recordWrite(write('r2', 10));
    forgetWrites(all);
    expect(recordWrite(write('r3', 20)).map((w) => w.receiptId)).toEqual(['r2', 'r3']);
  });
});
