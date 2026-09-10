// The tty-hint sweep.
//
// Reported from a real host: 17 `by-tty/*.restore` files, the oldest three
// weeks old, seven of them naming tmux sessions that no longer existed — and a
// new, clean terminal picking one up and running its command. They accumulated
// because a hint is only cleared by a palmux terminal touching that exact pts
// (three terminals against fifty ptys) and because every death that runs no
// code skips the clear entirely. The snapshots had a boot sweep from the start;
// the hints had nothing.

import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHintStore } from './session-restore';

const dirs: string[] = [];
const sandbox = (files: Record<string, string> = {}): string => {
  const d = mkdtempSync(join(tmpdir(), 'palmux-hints-'));
  dirs.push(d);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const hint = (session: string) => JSON.stringify({ argv: ['tmux', 'attach-session', '-t', session] });

describe('HintStore.sweep', () => {
  it('keeps only the ttys palmux has a live terminal on', () => {
    const dir = sandbox({
      'pts-1.restore': hint('NETCUP-0'),
      'pts-2.restore': hint('L0_PALMA-0'),
      'pts-6.restore': hint('FORGE-0'),
      'pts-16.restore': hint('BUGS-REPORTER-0'),
    });
    const store = createHintStore(dir);
    expect(store.sweep(['pts/1', 'pts/2'])).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(['pts-1.restore', 'pts-2.restore']);
  });

  // The keep set arrives as `pts/7` and the files are named `pts-7`. Comparing
  // the two vocabularies is how a sweep silently keeps everything or deletes
  // everything — the two failure modes look nothing alike and both are total.
  it('translates tty names to filenames before comparing', () => {
    const dir = sandbox({ 'pts-7.restore': hint('X-0') });
    expect(createHintStore(dir).sweep(['pts/7'])).toBe(0);
    expect(existsSync(join(dir, 'pts-7.restore'))).toBe(true);
  });

  // At boot palmux has no terminals yet — they spawn on the first /ws attach,
  // and `spawnInto` clears the hint for whatever tty it lands on. So sweeping
  // everything is correct, not over-eager.
  it('removes everything when nothing is live', () => {
    const dir = sandbox({ 'pts-1.restore': hint('A-0'), 'pts-2.restore': hint('B-0') });
    expect(createHintStore(dir).sweep([])).toBe(2);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('leaves files that are not hints alone', () => {
    const dir = sandbox({ 'pts-1.restore': hint('A-0'), 'README.md': 'not a hint' });
    expect(createHintStore(dir).sweep([])).toBe(1);
    expect(readdirSync(dir)).toEqual(['README.md']);
  });

  it('is a no-op on a directory that does not exist yet', () => {
    expect(createHintStore(join(tmpdir(), 'palmux-hints-absent-xyz')).sweep([])).toBe(0);
  });

  it('is idempotent', () => {
    const dir = sandbox({ 'pts-9.restore': hint('A-0') });
    const store = createHintStore(dir);
    expect(store.sweep([])).toBe(1);
    expect(store.sweep([])).toBe(0);
  });

  // AGE is deliberately not the rule. A terminal attached to the same tmux
  // session for a fortnight has a fortnight-old hint that is still exactly
  // right — and it is the only thing that knows about a `switch-client`, which
  // the /proc capture structurally cannot see. A TTL would throw that away.
  it('keeps an ancient hint whose terminal is still live', () => {
    const dir = sandbox({ 'pts-3.restore': hint('L0_PALMA-0') });
    const store = createHintStore(dir);
    expect(store.sweep(['pts/3'])).toBe(0);
    expect(store.read('pts/3')).toEqual({ argv: ['tmux', 'attach-session', '-t', 'L0_PALMA-0'] });
  });

  // The exact shape of the reported bug: a hint survives an uncleaned death,
  // the pts is handed out again (lowest-free), and the new terminal inherits a
  // command for a session that is gone.
  it('stops a recycled pts inheriting a dead session', () => {
    const dir = sandbox({ 'pts-2.restore': hint('FORGE-0') });
    const store = createHintStore(dir);
    expect(store.read('pts/2')).not.toBeNull(); // what used to happen
    store.sweep([]); // boot, before any terminal exists
    expect(store.read('pts/2')).toBeNull();
  });

  it('ignores a tty name that could escape the directory', () => {
    const dir = sandbox({ 'pts-1.restore': hint('A-0') });
    // Not a valid tty name, so it contributes nothing to the keep set — and in
    // particular does not accidentally keep everything.
    expect(createHintStore(dir).sweep(['../../etc', 'pts/1'])).toBe(0);
    expect(existsSync(join(dir, 'pts-1.restore'))).toBe(true);
  });
});
