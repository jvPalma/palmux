// ── PTY transport ─────────────────────────────────────────────────────────────
//
// The narrow surface PtySession needs from a pty, with two implementations:
//   • spawn — a fresh shell via node-pty (the normal path).
//   • adopt — an INHERITED master fd handed over by the previous process during a
//     live handoff, so the running shell survives a server restart.
//
// The adopt path can't use node-pty's `IPty` (that type only ever spawns), so it
// wraps the raw fd the way node-pty does internally: a tty.ReadStream for output,
// writeSync for input, and node-pty's OWN native binding for the TIOCSWINSZ
// resize (verified: `native.resize(fd, cols, rows)` works on a bare inherited fd).

import { spawn as ptySpawn, type IPty } from 'node-pty';
import * as ptyModule from 'node-pty';
import { writeSync } from 'node:fs';
import { ReadStream } from 'node:tty';

export interface PtyTransport {
  readonly pid: number;
  /** Master fd — handed to a successor process during a handoff. */
  readonly fd: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (exitCode: number, signal: number | null) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/** node-pty exposes `fd` at runtime (a UnixTerminal getter) but not in its typings. */
type IPtyWithFd = IPty & { fd: number };

export function spawnTransport(
  shell: string,
  args: string[],
  opts: { cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
): PtyTransport {
  const p = ptySpawn(shell, args, {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: opts.env,
  }) as IPtyWithFd;
  return {
    pid: p.pid,
    fd: p.fd,
    onData: (cb) => {
      p.onData(cb);
    },
    onExit: (cb) => {
      p.onExit(({ exitCode, signal }) => cb(exitCode, signal ?? null));
    },
    write: (d) => p.write(d),
    resize: (c, r) => p.resize(c, r),
    kill: (s) => p.kill(s),
  };
}

/** node-pty's native binding — `resize(fd,…)` by raw fd. Absent → resize no-ops. */
function nativeResize(fd: number, cols: number, rows: number): void {
  const native = (
    ptyModule as unknown as {
      native?: { resize?: (fd: number, cols: number, rows: number) => void };
    }
  ).native;
  native?.resize?.(fd, cols, rows);
}

/** Wrap an inherited PTY master fd (handoff). Throws if the fd isn't usable. */
export function adoptTransport(fd: number, pid: number): PtyTransport {
  const stream = new ReadStream(fd);
  const dataCbs: ((data: string) => void)[] = [];
  const exitCbs: ((exitCode: number, signal: number | null) => void)[] = [];
  let exited = false;

  const fireExit = (): void => {
    if (exited) return;
    exited = true;
    for (const cb of exitCbs) cb(0, null);
  };

  stream.on('data', (chunk: Buffer | string) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const cb of dataCbs) cb(s);
  });
  // A pty master read returns EIO once the last slave closes — i.e. the shell
  // exited. Treat any of error/close/end as the exit signal.
  stream.on('error', fireExit);
  stream.on('close', fireExit);
  stream.on('end', fireExit);

  return {
    pid,
    fd,
    onData: (cb) => {
      dataCbs.push(cb);
    },
    onExit: (cb) => {
      exitCbs.push(cb);
    },
    write: (d) => {
      try {
        writeSync(fd, d);
      } catch {
        /* shell gone */
      }
    },
    resize: (c, r) => {
      try {
        nativeResize(fd, c, r);
      } catch {
        /* shell gone */
      }
    },
    kill: (s) => {
      try {
        process.kill(pid, (s as NodeJS.Signals | undefined) ?? 'SIGHUP');
      } catch {
        /* already dead */
      }
    },
  };
}
