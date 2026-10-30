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
    reply: { status: number; text: string } | Error,
    tty: string | null = 'pts/3',
  ) => {
    const out: string[] = [];
    const err: string[] = [];
    const posted: object[] = [];
    const deps: CliDeps = {
      env: {},
      cwd: '/home/u/renders',
      tty: () => tty,
      post: async (body) => {
        posted.push(body);
        if (reply instanceof Error) throw reply;
        return reply;
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    };
    return { deps, out, err, posted };
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

  it('exits 2 with the usage for an unknown command or a download with no path', async () => {
    for (const argv of [['open', 'x'], ['download']]) {
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
});
