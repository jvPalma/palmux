import { describe, expect, it } from 'vitest';
import { callerTty, runCli, serverPath, ttyName, USAGE, type CliDeps } from './palmux-cli';

describe('ttyName', () => {
  it('names a pty the way the server does, and nothing else', () => {
    expect(ttyName('/dev/pts/11\n')).toBe('pts/11');
    expect(ttyName('/dev/tty2')).toBe('tty2');
    expect(ttyName('/dev/null')).toBeNull();
    expect(ttyName('pipe:[1234]')).toBeNull();
    expect(ttyName('')).toBeNull();
  });
});

describe('callerTty', () => {
  const noFds = () => {
    throw new Error('closed');
  };

  it('under tmux, asks tmux for the client tty (the palmux terminal), not its own', () => {
    const calls: string[][] = [];
    const tty = callerTty(
      { TMUX: '/tmp/tmux-1000/default,1,0' },
      (cmd, args) => {
        calls.push([cmd, ...args]);
        return '/dev/pts/11\n';
      },
      () => '/dev/pts/40',
    );
    expect(tty).toBe('pts/11');
    expect(calls).toEqual([['tmux', 'display-message', '-p', '#{client_tty}']]);
  });

  it('under tmux, a failing tmux is no terminal', () => {
    const tty = callerTty(
      { TMUX: 'x' },
      () => {
        throw new Error('no server');
      },
      noFds,
    );
    expect(tty).toBeNull();
  });

  it('outside tmux, takes the first of fd 0, 1 and 2 that is a terminal', () => {
    const fds: Record<number, string> = { 0: '/dev/null', 1: 'pipe:[9]', 2: '/dev/pts/7' };
    expect(
      callerTty(
        {},
        () => '',
        (fd) => fds[fd]!,
      ),
    ).toBe('pts/7');
    expect(callerTty({}, () => '', noFds)).toBeNull();
  });
});

describe('serverPath', () => {
  it('reads a relative path from the current directory and keeps glob characters', () => {
    expect(serverPath('/home/u/renders', 'a.mp4')).toBe('/home/u/renders/a.mp4');
    expect(serverPath('/home/u/renders', '../video/*.mp4')).toBe('/home/u/video/*.mp4');
    expect(serverPath('/home/u', '.')).toBe('/home/u');
  });

  it('leaves an absolute path and a ~ path to the server', () => {
    expect(serverPath('/x', '/abs/a.mp4')).toBe('/abs/a.mp4');
    expect(serverPath('/x', '~/a.mp4')).toBe('~/a.mp4');
    expect(serverPath('/x', '~')).toBe('~');
    // Not a home path: a file named `~other` in the current directory.
    expect(serverPath('/x', '~other')).toBe('/x/~other');
  });
});

describe('runCli', () => {
  const harness = (
    reply: { status: number; text: string } | Error | ({ status: number; text: string } | Error)[],
    tty: string | null = 'pts/3',
  ) => {
    const out: string[] = [];
    const err: string[] = [];
    const posted: object[] = [];
    const written: string[] = [];
    let ttyCalls = 0;
    const deps: CliDeps = {
      env: {},
      cwd: '/home/u/renders',
      tty: () => {
        ttyCalls += 1;
        return tty;
      },
      post: async (body) => {
        posted.push(body);
        // A list is answered in turn, its last entry repeating.
        const next = Array.isArray(reply)
          ? reply[Math.min(posted.length, reply.length) - 1]!
          : reply;
        if (next instanceof Error) throw next;
        return next;
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      write: (t) => written.push(t),
      version: async () => '1.3.0+abc1234',
      address: 'http://127.0.0.1:44040',
      sleep: async () => {},
    };
    return { deps, out, err, posted, written, ttyCalls: () => ttyCalls };
  };
  const ok = (body: object) => ({ status: 200, text: JSON.stringify(body) });

  it('prints help for no command and for help, and exits 0', async () => {
    for (const argv of [[], ['help'], ['--help'], ['-h']]) {
      const h = harness(ok({}));
      expect(await runCli(argv, h.deps)).toBe(0);
      expect(h.out).toEqual([USAGE]);
      expect(h.posted).toEqual([]);
    }
  });

  it('prints the version for -v, --version and version, and posts nothing', async () => {
    for (const argv of [['-v'], ['--version'], ['version']]) {
      const h = harness(ok({}));
      expect(await runCli(argv, h.deps)).toBe(0);
      expect(h.out).toEqual(['palmux 1.3.0+abc1234']);
      expect(h.posted).toEqual([]);
    }
  });

  it('prints help for a command given -h or --help anywhere, and for help <command>', async () => {
    for (const argv of [
      ['open', '-h'],
      ['git', '--help'],
      ['download', 'a.mp4', '--help'],
      ['help', 'open'],
    ]) {
      const h = harness(ok({}));
      expect(await runCli(argv, h.deps)).toBe(0);
      expect(h.out).toEqual([USAGE]);
      expect(h.posted).toEqual([]);
      expect(h.ttyCalls()).toBe(0);
    }
  });

  it('refuses an unknown option with exit 2, and takes everything after -- as a path', async () => {
    const bad = harness(ok({}));
    expect(await runCli(['open', '-x', 'a.ts'], bad.deps)).toBe(2);
    expect(bad.err).toEqual(["palmux: unknown option '-x'", USAGE]);
    expect(bad.posted).toEqual([]);

    const h = harness(
      ok({
        commands: ['open'],
        opened: ['/home/u/renders/-x', '/home/u/renders/--help'],
        failed: [],
      }),
    );
    expect(await runCli(['open', '--', '-x', '--help'], h.deps)).toBe(0);
    expect(h.posted).toEqual([
      { cmd: 'open', tty: 'pts/3', paths: ['/home/u/renders/-x', '/home/u/renders/--help'] },
    ]);
  });

  it('exits 2 with the usage for an unknown command , or a command with missing or extra arguments', async () => {
    for (const argv of [
      ['frob', 'x'],
      ['download'],
      ['open'],
      ['git', 'extra'],
      ['comments', 'x'],
    ]) {
      const h = harness(ok({}));
      expect(await runCli(argv, h.deps)).toBe(2);
      expect(h.err).toEqual([USAGE]);
      expect(h.posted).toEqual([]);
    }
  });

  it('posts the tty and the resolved paths, and reports what was sent', async () => {
    const h = harness(ok({ sent: ['/home/u/renders/a.mp4', '~/b.mp4'], failed: [] }));
    expect(await runCli(['download', 'a.mp4', '~/b.mp4'], h.deps)).toBe(0);
    expect(h.posted).toEqual([
      { cmd: 'download', tty: 'pts/3', paths: ['/home/u/renders/a.mp4', '~/b.mp4'] },
    ]);
    expect(h.out).toEqual(['downloading /home/u/renders/a.mp4', 'downloading ~/b.mp4']);
    expect(h.err).toEqual([]);
  });

  it('names each path that failed and exits 1, while the rest still go', async () => {
    const h = harness(
      ok({ sent: ['/a'], failed: [{ path: '/home/u/renders/b.mp4', error: 'not found' }] }),
    );
    expect(await runCli(['download', '/a', 'b.mp4'], h.deps)).toBe(1);
    expect(h.out).toEqual(['downloading /a']);
    expect(h.err).toEqual(['palmux: /home/u/renders/b.mp4: not found']);
  });

  it('refuses to run with no terminal, without posting', async () => {
    const h = harness(ok({}), null);
    expect(await runCli(['download', 'a'], h.deps)).toBe(1);
    expect(h.err[0]).toMatch(/inside a palmux terminal/);
    expect(h.posted).toEqual([]);
  });

  it('shows the server refusal, an unreachable server, and an older server', async () => {
    const refused = harness({
      status: 409,
      text: JSON.stringify({ error: 'no open palmux terminal is on pts/3' }),
    });
    expect(await runCli(['download', 'a'], refused.deps)).toBe(1);
    expect(refused.err).toEqual(['palmux: no open palmux terminal is on pts/3']);

    const down = harness(new Error('connect ECONNREFUSED 127.0.0.1:44040'));
    expect(await runCli(['download', 'a'], down.deps)).toBe(1);
    expect(down.err[0]).toMatch(/cannot reach the palmux server \(connect ECONNREFUSED/);

    const old = harness({ status: 200, text: '<!doctype html><html>' });
    expect(await runCli(['download', 'a'], old.deps)).toBe(1);
    expect(old.err[0]).toMatch(/restart it/);
  });

  const newServer = (extra: object) =>
    ok({ commands: ['download', 'open', 'git', 'comments', 'web', 'status', 'wait'], ...extra });

  it('tells a newer CLI that the server is older, and still downloads from it', async () => {
    const old = harness(ok({ commands: ['download'] }));
    expect(await runCli(['open', 'a'], old.deps)).toBe(1);
    expect(old.err).toEqual(['palmux: this palmux server predates `palmux open`; restart it']);

    const html = harness({ status: 200, text: '<!doctype html>' });
    expect(await runCli(['git'], html.deps)).toBe(1);
    expect(html.err[0]).toMatch(/predates `palmux git`/);

    const noList = harness(ok({ repo: '/x' }));
    expect(await runCli(['comments'], noList.deps)).toBe(1);
    expect(noList.err[0]).toMatch(/predates `palmux comments`/);

    const dl = harness(ok({ sent: ['/a'], failed: [] }));
    expect(await runCli(['download', '/a'], dl.deps)).toBe(0);
    expect(dl.out).toEqual(['downloading /a']);
  });

  it('open reports opened files, and each failure with exit 1', async () => {
    const good = harness(newServer({ opened: ['/home/u/renders/a.ts'], failed: [] }));
    expect(await runCli(['open', 'a.ts'], good.deps)).toBe(0);
    expect(good.posted).toEqual([{ cmd: 'open', tty: 'pts/3', paths: ['/home/u/renders/a.ts'] }]);
    expect(good.out).toEqual(['opened /home/u/renders/a.ts']);

    const dir = harness(
      newServer({ opened: [], failed: [{ path: '/d', error: 'is a directory' }] }),
    );
    expect(await runCli(['open', '/d'], dir.deps)).toBe(1);
    expect(dir.err).toEqual(['palmux: /d: is a directory']);

    const other = harness(
      newServer({ opened: [], failed: [{ path: '/a', error: 'open in another window' }] }),
    );
    expect(await runCli(['open', '/a'], other.deps)).toBe(1);
    expect(other.err).toEqual(['palmux: /a: open in another window']);

    const none = harness(ok({}), null);
    expect(await runCli(['open', 'a'], none.deps)).toBe(1);
    expect(none.err[0]).toMatch(/run palmux open inside a palmux terminal/);
    expect(none.posted).toEqual([]);
  });

  it('git names the repository, prints a note on stderr, and shows refusals', async () => {
    const nested = harness(newServer({ repo: '/home/u/dgsl' }));
    expect(await runCli(['git'], nested.deps)).toBe(0);
    expect(nested.posted).toEqual([{ cmd: 'git', tty: 'pts/3', cwd: '/home/u/renders' }]);
    expect(nested.out).toEqual(['Source Control: /home/u/dgsl']);

    const detached = harness(newServer({ repo: '/r', note: 'HEAD is detached' }));
    expect(await runCli(['git'], detached.deps)).toBe(0);
    expect(detached.err).toEqual(['palmux: HEAD is detached']);

    const bad = harness({
      status: 400,
      text: JSON.stringify({ commands: ['git'], error: 'not a git repository' }),
    });
    expect(await runCli(['git'], bad.deps)).toBe(1);
    expect(bad.err).toEqual(['palmux: not a git repository']);

    const none = harness(ok({}), null);
    expect(await runCli(['git'], none.deps)).toBe(1);
    expect(none.err[0]).toMatch(/run palmux git inside/);
  });

  it('comments writes the markdown exactly, needs no terminal, and reports errors', async () => {
    const md = '# Review\n\n- a\n';
    const h = harness(newServer({ markdown: md }), null);
    expect(await runCli(['comments'], h.deps)).toBe(0);
    expect(h.posted).toEqual([{ cmd: 'comments', cwd: '/home/u/renders' }]);
    expect(h.written).toEqual([md]);
    expect(h.out).toEqual([]);
    expect(h.ttyCalls()).toBe(0);

    const empty = harness(newServer({ markdown: '' }));
    expect(await runCli(['comments'], empty.deps)).toBe(0);
    expect(empty.written).toEqual([]);

    const bad = harness({
      status: 400,
      text: JSON.stringify({ commands: ['comments'], error: 'not inside a git work tree' }),
    });
    expect(await runCli(['comments'], bad.deps)).toBe(1);
    expect(bad.err).toEqual(['palmux: not inside a git work tree']);
    expect(bad.written).toEqual([]);

    const down = harness(new Error('connect ECONNREFUSED'));
    expect(await runCli(['comments'], down.deps)).toBe(1);
    expect(down.err[0]).toMatch(/cannot reach the palmux server/);
  });

  it('web sends the target as typed, prints the url, and needs exactly one', async () => {
    const h = harness(newServer({ url: 'http://localhost:5173/' }));
    expect(await runCli(['web', '5173'], h.deps)).toBe(0);
    expect(h.posted).toEqual([{ cmd: 'web', tty: 'pts/3', url: '5173' }]);
    expect(h.out).toEqual(['opened http://localhost:5173/']);

    for (const argv of [['web'], ['web', 'a', 'b']]) {
      const bad = harness(newServer({}));
      expect(await runCli(argv, bad.deps)).toBe(2);
      expect(bad.posted).toEqual([]);
    }
    const none = harness(newServer({}), null);
    expect(await runCli(['web', '80'], none.deps)).toBe(1);
    expect(none.err[0]).toMatch(/run palmux web inside/);
  });

  it('status prints both versions, the address and the terminal, and says when they differ', async () => {
    const h = harness(
      newServer({ version: '1.3.0+abc1234', terminal: { id: '3', window: null, attached: true } }),
    );
    expect(await runCli(['status'], h.deps)).toBe(0);
    expect(h.posted).toEqual([{ cmd: 'status', tty: 'pts/3' }]);
    expect(h.out).toEqual([
      'palmux  1.3.0+abc1234',
      'server  1.3.0+abc1234 at http://127.0.0.1:44040',
      'tty     pts/3: terminal 3, shown in the main window',
    ]);

    const older = harness(
      newServer({
        version: '1.2.0+0000000',
        terminal: { id: '3', window: 'wabc123', attached: false },
      }),
    );
    expect(await runCli(['status'], older.deps)).toBe(0);
    expect(older.out.slice(1)).toEqual([
      'server  1.2.0+0000000 at http://127.0.0.1:44040',
      'tty     pts/3: terminal 3, in detached window wabc123, not shown now',
    ]);
    expect(older.err).toEqual([
      'palmux: the server runs another build than this checkout; restart it to update it',
    ]);

    const outside = harness(newServer({ version: '1.3.0+abc1234', terminal: null }), null);
    expect(await runCli(['status'], outside.deps)).toBe(0);
    expect(outside.posted).toEqual([{ cmd: 'status' }]);
    expect(outside.out.at(-1)).toBe('tty     none: this shell has no terminal');

    const none = harness(newServer({ version: '1.3.0+abc1234', terminal: null }));
    await runCli(['status'], none.deps);
    expect(none.out.at(-1)).toBe('tty     pts/3: not a palmux terminal');
  });

  it('status still prints this version when the server is down or predates it, and exits 1', async () => {
    const down = harness(new Error('connect ECONNREFUSED 127.0.0.1:44040'));
    expect(await runCli(['status'], down.deps)).toBe(1);
    expect(down.out).toEqual(['palmux  1.3.0+abc1234']);
    expect(down.err[0]).toMatch(/cannot reach the palmux server/);

    const old = harness(
      ok({ commands: ['download', 'open', 'git', 'comments'], error: 'expected' }),
    );
    expect(await runCli(['status'], old.deps)).toBe(1);
    expect(old.out).toEqual(['palmux  1.3.0+abc1234']);
    expect(old.err[0]).toMatch(/predates `palmux status`/);
  });

  it('open --wait returns once the window closed every opened file, asking with appear first', async () => {
    const opened = newServer({ opened: ['/home/u/renders/a.ts', '/b.ts'], failed: [] });
    const h = harness([
      opened,
      newServer({ open: ['/home/u/renders/a.ts', '/b.ts'] }),
      newServer({ open: ['/b.ts'] }),
      newServer({ open: [] }),
    ]);
    expect(await runCli(['open', '-w', 'a.ts', '/b.ts'], h.deps)).toBe(0);
    expect(h.posted).toEqual([
      { cmd: 'open', tty: 'pts/3', paths: ['/home/u/renders/a.ts', '/b.ts'] },
      { cmd: 'wait', paths: ['/home/u/renders/a.ts', '/b.ts'], appear: true },
      { cmd: 'wait', paths: ['/home/u/renders/a.ts', '/b.ts'] },
      { cmd: 'wait', paths: ['/b.ts'] },
    ]);

    const long = harness([opened, newServer({ open: [] })]);
    expect(await runCli(['open', '--wait', 'a.ts'], long.deps)).toBe(0);
    expect(long.posted).toHaveLength(2);
  });

  it('open --wait keeps waiting across a server restart, and gives up after a minute of it', async () => {
    const opened = newServer({ opened: ['/a.ts'], failed: [] });
    const blip = harness([
      opened,
      new Error('ECONNREFUSED'),
      new Error('ECONNREFUSED'),
      newServer({ open: [] }),
    ]);
    expect(await runCli(['open', '-w', '/a.ts'], blip.deps)).toBe(0);
    expect(blip.posted).toHaveLength(4);
    expect(blip.err).toEqual([]);

    const gone = harness([opened, new Error('ECONNREFUSED')]);
    expect(await runCli(['open', '-w', '/a.ts'], gone.deps)).toBe(1);
    expect(gone.err.at(-1)).toMatch(/cannot reach the palmux server/);
  });

  it('open --wait waits for what opened and still exits 1 for a failure; nothing opened waits for nothing', async () => {
    const partial = harness([
      newServer({ opened: ['/a.ts'], failed: [{ path: '/d', error: 'path is a directory' }] }),
      newServer({ open: [] }),
    ]);
    expect(await runCli(['open', '-w', '/a.ts', '/d'], partial.deps)).toBe(1);
    expect(partial.posted).toHaveLength(2);

    const nothing = harness(
      newServer({ opened: [], failed: [{ path: '/d', error: 'not found' }] }),
    );
    expect(await runCli(['open', '-w', '/d'], nothing.deps)).toBe(1);
    expect(nothing.posted).toHaveLength(1);

    const old = harness(
      ok({ commands: ['download', 'open', 'git', 'comments'], opened: ['/a.ts'], failed: [] }),
    );
    expect(await runCli(['open', '-w', '/a.ts'], old.deps)).toBe(1);
    expect(old.err).toEqual([
      'palmux: this palmux server predates `palmux open --wait`; restart it',
    ]);
  });

  it('takes -w only after open', async () => {
    const h = harness(newServer({}));
    expect(await runCli(['git', '-w'], h.deps)).toBe(2);
    expect(h.err[0]).toBe("palmux: unknown option '-w'");
  });
});
