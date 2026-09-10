// Restoring a terminal after a cold start. The capture side reads /proc, so it
// is tested against a FAKE /proc tree (deterministic, and it exercises the
// parsing edge cases a real machine rarely produces) plus one end-to-end pass
// over this process's own real /proc.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  argvOf,
  captureProcess,
  createHintStore,
  createRestoreStore,
  foregroundPid,
  quoteArgv,
  restorableRing,
  ttyOf,
} from './session-restore';

const dirs: string[] = [];
const fresh = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `palmux-${label}-`));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake /proc entry. `comm` is written raw — parens and spaces included. */
function fakeProc(
  root: string,
  pid: number,
  opts: { comm: string; tpgid: number; cmdline?: string[]; cwd?: string },
): void {
  const dir = join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  // pid (comm) state ppid pgrp session tty_nr tpgid …
  writeFileSync(
    join(dir, 'stat'),
    `${pid} (${opts.comm}) S 1 ${pid} ${pid} 34816 ${opts.tpgid} 4194304 0 0`,
  );
  if (opts.cmdline) writeFileSync(join(dir, 'cmdline'), opts.cmdline.join('\0') + '\0');
  if (opts.cwd) symlinkSync(opts.cwd, join(dir, 'cwd'));
}

describe('foregroundPid', () => {
  it('reads tpgid past a comm containing spaces and parens', () => {
    // Splitting /proc/pid/stat from the FRONT reads the wrong field for these,
    // which is why parsing starts after the last ')'.
    const root = fresh('proc');
    fakeProc(root, 100, { comm: 'my (weird) prog', tpgid: 222 });
    expect(foregroundPid(100, root)).toBe(222);
  });

  it('is null when the shell is its own foreground group (nothing running)', () => {
    const root = fresh('proc');
    fakeProc(root, 100, { comm: 'zsh', tpgid: 100 });
    expect(foregroundPid(100, root)).toBe(null);
  });

  it('is null for a vanished process or a tty-less one', () => {
    const root = fresh('proc');
    fakeProc(root, 100, { comm: 'zsh', tpgid: -1 });
    expect(foregroundPid(100, root)).toBe(null);
    expect(foregroundPid(999, root)).toBe(null);
  });
});

describe('argvOf', () => {
  it('reads argv as an ARRAY, never a joined string', () => {
    const root = fresh('proc');
    fakeProc(root, 222, { comm: 'tmux', tpgid: 222, cmdline: ['tmux', 'new', '-A', '-s', 'work'] });
    expect(argvOf(222, root)).toEqual(['tmux', 'new', '-A', '-s', 'work']);
  });

  it('refuses an argument carrying a control character', () => {
    // Quoting does NOT save us here: a CR ends the typed line inside quotes too,
    // so a second command would run behind the one the user can see.
    const root = fresh('proc');
    fakeProc(root, 222, { comm: 'x', tpgid: 222, cmdline: ['echo hi\rrm -rf /tmp/x'] });
    expect(argvOf(222, root)).toBe(null);
  });

  it('refuses an absurdly long argument', () => {
    const root = fresh('proc');
    fakeProc(root, 222, { comm: 'x', tpgid: 222, cmdline: ['x'.repeat(5000)] });
    expect(argvOf(222, root)).toBe(null);
  });

  it('is null with no cmdline (a kernel thread, or a race with exit)', () => {
    const root = fresh('proc');
    fakeProc(root, 222, { comm: 'x', tpgid: 222 });
    expect(argvOf(222, root)).toBe(null);
  });
});

describe('quoteArgv', () => {
  // The command is TYPED into a live shell. Joining argv on spaces is not shell
  // quoting: `vim my notes.txt` opens two files, and a filename holding `;` or
  // `$()` executes — a filename alone was enough to inject.
  it('leaves plain arguments untouched', () => {
    expect(quoteArgv(['tmux', 'new', '-A', '-s', 'work'])).toBe('tmux new -A -s work');
    expect(quoteArgv(['ls', '/home/user/.config'])).toBe('ls /home/user/.config');
  });

  it('quotes an argument holding a space so it stays ONE argument', () => {
    expect(quoteArgv(['vim', 'my notes.txt'])).toBe("vim 'my notes.txt'");
  });

  it('neutralises shell metacharacters in a filename', () => {
    expect(quoteArgv(['vim', 'x; touch /tmp/PWNED'])).toBe("vim 'x; touch /tmp/PWNED'");
    expect(quoteArgv(['echo', '$(id)'])).toBe("echo '$(id)'");
    expect(quoteArgv(['echo', '`id`'])).toBe("echo '`id`'");
    expect(quoteArgv(['rm', '*'])).toBe("rm '*'");
    expect(quoteArgv(['cat', 'a > b'])).toBe("cat 'a > b'");
  });

  it("closes, escapes and reopens around a literal single quote", () => {
    expect(quoteArgv(['echo', "it's"])).toBe("echo 'it'\\''s'");
  });
});

describe('captureProcess', () => {
  it('records the foreground command and ITS working directory', () => {
    const root = fresh('proc');
    const work = fresh('work');
    fakeProc(root, 100, { comm: 'zsh', tpgid: 222, cwd: '/home/user' });
    fakeProc(root, 222, { comm: 'tmux', tpgid: 222, cmdline: ['tmux', 'attach'], cwd: work });
    expect(captureProcess(100, root)).toEqual({ cwd: work, argv: ['tmux', 'attach'] });
  });

  it('records only the shell cwd when nothing is running in it', () => {
    const root = fresh('proc');
    const home = fresh('home');
    fakeProc(root, 100, { comm: 'zsh', tpgid: 100, cwd: home });
    expect(captureProcess(100, root)).toEqual({ cwd: home });
  });

  it('falls back to the shell cwd when the foreground process has none', () => {
    const root = fresh('proc');
    const home = fresh('home2');
    fakeProc(root, 100, { comm: 'zsh', tpgid: 222, cwd: home });
    fakeProc(root, 222, { comm: 'top', tpgid: 222, cmdline: ['top'] });
    expect(captureProcess(100, root)).toEqual({ cwd: home, argv: ['top'] });
  });

  it('reads THIS process out of the real /proc', () => {
    // The fake tree could drift from the kernel's format; this catches that.
    const got = captureProcess(process.pid);
    expect(got.cwd).toBe(process.cwd());
  });
});

describe('restorableRing', () => {
  const ESC = '\x1b';

  it('strips alt-screen switches so the replay stays in the normal buffer', () => {
    // A `?1049h` mid-replay would put the client in the alternate screen, and
    // the matching `?1049l` would then wipe everything the replay just drew.
    const ring = Buffer.from(`before${ESC}[?1049hFULLSCREEN${ESC}[?1049lafter`, 'latin1');
    const out = restorableRing(ring).toString('latin1');
    expect(out).not.toContain('1049');
    expect(out).toContain('beforeFULLSCREENafter');
  });

  it('closes any open SGR and marks where the old session ended', () => {
    // Decoded as utf8: the marker is TEXT, while the ring before it is raw bytes.
    const out = restorableRing(Buffer.from(`${ESC}[31mred`, 'latin1')).toString('utf8');
    expect(out).toContain('── restored ──');
    expect(out.indexOf(`${ESC}[0m`)).toBeGreaterThan(out.indexOf('red'));
  });

  it('is empty for a blank ring rather than emitting a lone marker', () => {
    expect(restorableRing(Buffer.from('   \n', 'latin1'))).toHaveLength(0);
    expect(restorableRing(Buffer.alloc(0))).toHaveLength(0);
  });
});

describe('createRestoreStore', () => {
  it('round-trips a snapshot', () => {
    const store = createRestoreStore(fresh('store'));
    store.save('3', { at: Date.now(), cwd: '/tmp', argv: ['tmux', 'attach'], ring: 'aGk=' });
    expect(store.load('3')).toMatchObject({ cwd: '/tmp', argv: ['tmux', 'attach'], ring: 'aGk=' });
    expect(store.ids()).toEqual(['3']);
  });

  it('forgets a snapshot once it has been consumed', () => {
    const store = createRestoreStore(fresh('forget'));
    store.save('3', { at: Date.now(), cwd: '/tmp' });
    store.forget('3');
    expect(store.load('3')).toBe(null);
    expect(store.ids()).toEqual([]);
  });

  it('drops a stale record instead of respawning month-old work', () => {
    const store = createRestoreStore(fresh('stale'));
    store.save('3', { at: Date.now() - 40 * 24 * 60 * 60 * 1000, cwd: '/tmp', argv: ['top'] });
    expect(store.load('3')).toBe(null);
  });

  it('re-validates argv on LOAD — the file is user-editable', () => {
    const dir = fresh('tamper');
    const store = createRestoreStore(dir);
    writeFileSync(
      join(dir, '3.json'),
      JSON.stringify({ at: Date.now(), cwd: '/tmp', argv: ['ls\rrm -rf /'] }),
    );
    expect(store.load('3')?.argv).toBeUndefined();
    expect(store.load('3')?.cwd).toBe('/tmp'); // the rest of the record survives
  });

  it('drops a cwd that is relative or no longer exists', () => {
    // Relative would resolve against wherever the SERVER runs; a deleted one
    // makes the shell fail to spawn at all. The default cwd beats no terminal.
    const dir = fresh('cwd');
    const store = createRestoreStore(dir);
    writeFileSync(join(dir, '3.json'), JSON.stringify({ at: Date.now(), cwd: 'relative/path' }));
    expect(store.load('3')?.cwd).toBeUndefined();
    writeFileSync(join(dir, '4.json'), JSON.stringify({ at: Date.now(), cwd: '/no/such/dir/here' }));
    expect(store.load('4')?.cwd).toBeUndefined();
  });

  it('treats a corrupt or missing file as nothing to restore', () => {
    const dir = fresh('corrupt');
    const store = createRestoreStore(dir);
    writeFileSync(join(dir, '3.json'), '{not json');
    expect(store.load('3')).toBe(null);
    expect(store.load('9')).toBe(null);
  });

  it('lists nothing when the directory was never created', () => {
    expect(createRestoreStore(join(fresh('empty'), 'nope')).ids()).toEqual([]);
  });
});

describe('ttyOf', () => {
  it('names this process\'s own terminal, or nothing when there is none', () => {
    // In CI stdin is a pipe/null, so both outcomes are correct — what must NOT
    // happen is a bogus name, because it is the hint channel's join key.
    // The name must survive VERBATIM as it appears under /dev — createHintStore
    // derives the hint filename from it, and stripping the slash here silently
    // broke the join.
    const got = ttyOf(process.pid);
    expect(got === null || /^pts\/\d+$|^tty[A-Za-z0-9]+$/.test(got)).toBe(true);
  });

  it('is null for a process that has no fd 0 to read', () => {
    expect(ttyOf(999999, fresh('noproc'))).toBe(null);
  });
});

describe('createHintStore', () => {
  const write = (dir: string, name: string, body: string) =>
    writeFileSync(join(dir, name), body);

  it('reads a bare shell line, which is what a one-line hook can write', () => {
    const dir = fresh('hint');
    write(dir, 'pts-7.restore', 'tmux attach-session -t ISD\n');
    expect(createHintStore(dir).read('pts/7')).toEqual({ command: 'tmux attach-session -t ISD' });
  });

  it('reads the JSON argv form for a caller that can build one', () => {
    const dir = fresh('hintjson');
    write(dir, 'pts-7.restore', JSON.stringify({ argv: ['tmux', 'attach-session', '-t', 'a b'] }));
    expect(createHintStore(dir).read('pts/7')).toEqual({
      argv: ['tmux', 'attach-session', '-t', 'a b'],
    });
  });

  it('rejects a hint carrying a control character', () => {
    const dir = fresh('hintctl');
    write(dir, 'pts-7.restore', 'ls\rrm -rf /');
    expect(createHintStore(dir).read('pts/7')).toBe(null);
  });

  it('rejects malformed JSON and an empty file rather than guessing', () => {
    const dir = fresh('hintbad');
    write(dir, 'pts-7.restore', '{not json');
    expect(createHintStore(dir).read('pts/7')).toBe(null);
    write(dir, 'pts-8.restore', '   \n');
    expect(createHintStore(dir).read('pts/8')).toBe(null);
  });

  it('is null when no program advertised anything', () => {
    expect(createHintStore(fresh('hintnone')).read('pts/7')).toBe(null);
  });

  it('refuses a tty name that would escape the directory', () => {
    const dir = fresh('hintescape');
    const store = createHintStore(dir);
    expect(store.read('../../../etc/passwd')).toBe(null);
    expect(() => store.clear('../../../etc/passwd')).not.toThrow();
  });

  it('clear() drops the hint — pts numbers are recycled', () => {
    // Without this, a terminal opening on a pts a DEAD terminal used would
    // inherit that terminal's restore command.
    const dir = fresh('hintclear');
    write(dir, 'pts-7.restore', 'tmux attach-session -t stale');
    const store = createHintStore(dir);
    store.clear('pts/7');
    expect(store.read('pts/7')).toBe(null);
    expect(() => store.clear('pts/7')).not.toThrow(); // already gone
  });
});

describe('tty name <-> hint filename', () => {
  it('round-trips: the name ttyOf produces is the one createHintStore reads', () => {
    // These two are the halves of the join key and were written apart; a
    // mismatch makes every hint silently invisible, which is exactly what
    // happened when ttyOf returned `pts16` for a `pts-16.restore` file.
    const dir = fresh('ttyjoin');
    writeFileSync(join(dir, 'pts-16.restore'), 'tmux attach-session -t omega-0');
    expect(createHintStore(dir).read('pts/16')).toEqual({
      command: 'tmux attach-session -t omega-0',
    });
  });
});
