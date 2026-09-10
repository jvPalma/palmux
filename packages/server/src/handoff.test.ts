import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nodePty from 'node-pty';
import { PtySession } from './pty';
import {
  adoptSessions,
  buildHandoff,
  handoffBlockedReason,
  readHandoff,
  type HandoffManifest,
} from './handoff';

const until = async (pred: () => boolean, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('buildHandoff', () => {
  it('assigns sequential fd indices and skips dead sessions', () => {
    const live = new PtySession({ shell: '/bin/sh', cols: 80, rows: 24 });
    const dead = new PtySession({ shell: '/bin/sh', cols: 80, rows: 24 });
    try {
      dead.kill();
      (dead as unknown as { alive: boolean }).alive = false;
      const { manifest, fds } = buildHandoff([
        { id: '0', session: live },
        { id: '1', session: dead },
      ]);
      expect(manifest.v).toBe(1);
      expect(manifest.entries).toHaveLength(1);
      expect(manifest.entries[0]).toMatchObject({ id: '0', fdIndex: 0 });
      expect(manifest.entries[0]!.pid).toBeGreaterThan(0);
      expect(fds).toHaveLength(1);
    } finally {
      live.kill();
    }
  });
});

describe('handoffBlockedReason', () => {
  it('refuses under systemd (the successor would die with the unit cgroup)', () => {
    expect(handoffBlockedReason({ INVOCATION_ID: 'abc123' })).toMatch(/systemd/);
  });

  it('allows a plain foreground/bundle process', () => {
    expect(handoffBlockedReason({})).toBeNull();
  });
});

describe('readHandoff', () => {
  it('parses and CONSUMES the env manifest (never leaks to child shells)', () => {
    const manifest: HandoffManifest = { v: 1, entries: [] };
    process.env['PALMUX_HANDOFF'] = JSON.stringify(manifest);
    expect(readHandoff()).toEqual(manifest);
    expect(process.env['PALMUX_HANDOFF']).toBeUndefined();
    expect(readHandoff()).toBeNull();
  });

  it('returns null on a malformed manifest (cold start)', () => {
    process.env['PALMUX_HANDOFF'] = '{not json';
    expect(readHandoff()).toBeNull();
  });
});

describe('adoptSessions', () => {
  it('safe-degrades: an unusable fd is skipped, not thrown (tab respawns instead)', () => {
    const manifest: HandoffManifest = {
      v: 1,
      // fdIndex 9996 → fd 9999, which is not open in this process.
      entries: [
        { id: '0', pid: 1, fdIndex: 9996, cols: 80, rows: 24, ring: '', modes: [], title: '' },
      ],
    };
    let adopted: Map<string, PtySession> | undefined;
    expect(() => {
      adopted = adoptSessions(manifest, 65536);
    }).not.toThrow();
    expect(adopted?.size).toBe(0);
  });
});

describe('adopted PtySession state', () => {
  it('carries the replay ring, mode state and title across the handoff', () => {
    // State-only (no I/O): in THIS process node-pty still owns a libuv handle on
    // the fd, so a second reader can't receive bytes — the cross-process test
    // below covers the actual same-shell round-trip.
    const raw = nodePty.spawn('/bin/sh', [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
    }) as nodePty.IPty & { fd: number };
    raw.pause();
    const adopted = new PtySession({
      adoptFd: raw.fd,
      adoptPid: raw.pid,
      cols: 80,
      rows: 24,
      ring: Buffer.from('previous-scrollback\r\n', 'utf8'),
      modes: [[1000, true]],
      title: 'carried-title',
    });
    try {
      const snap = adopted.snapshot().toString('latin1');
      expect(snap).toContain('previous-scrollback');
      expect(snap).toContain('\x1b[?1000h'); // mode re-asserted after replay
      expect(adopted.title).toBe('carried-title');
      expect(() => adopted.resize(100, 30)).not.toThrow();
      expect(adopted.cols).toBe(100);
    } finally {
      adopted.kill();
    }
  }, 15000);

  it('recomputes smallest-client-wins from the reattaching clients, not the carried size', () => {
    const raw = nodePty.spawn('/bin/sh', [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
    }) as nodePty.IPty & { fd: number };
    raw.pause();
    // Handed over at the previous process's aggregated size…
    const adopted = new PtySession({ adoptFd: raw.fd, adoptPid: raw.pid, cols: 200, rows: 60 });
    try {
      expect(adopted.cols).toBe(200);
      const a = {};
      const b = {};
      const noop = (): void => {};
      adopted.attach(a, 'ka', noop, noop, noop);
      adopted.resizeClient(a, 120, 40);
      expect(adopted.cols).toBe(120); // first client back sets the size
      adopted.attach(b, 'kb', noop, noop, noop); // …a later attach takes over
      adopted.resizeClient(b, 90, 50);
      expect([adopted.cols, adopted.rows]).toEqual([90, 50]);
    } finally {
      adopted.kill();
    }
  }, 15000);
});

describe('cross-process handoff (the real thing)', () => {
  it('a successor inheriting the fd resumes the SAME shell', async () => {
    const raw = nodePty.spawn('/bin/sh', [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
    }) as nodePty.IPty & { fd: number };
    const resultPath = join(tmpdir(), `palmux-handoff-${process.pid}-${Date.now()}.json`);
    let child: ReturnType<typeof spawn> | undefined;
    try {
      // Mark the shell BEFORE the handoff; only the same shell can echo it back.
      raw.write('MARK=handoff-ok\n');
      await until(() => false, 600);
      raw.pause();

      // Launch the successor exactly as spawnSuccessor does: node + loader flags,
      // NOT the tsx CLI (which re-spawns a grandchild that would lose the fd).
      const tsxLoader = new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
      const fixture = fileURLToPath(new URL('./__fixtures__/adopt-child.ts', import.meta.url));
      child = spawn(process.execPath, ['--import', tsxLoader, fixture, resultPath], {
        // The master fd is inherited at 3 — exactly what spawnSuccessor does.
        stdio: ['ignore', 'ignore', 'ignore', raw.fd],
        env: { ...process.env, ADOPT_PID: String(raw.pid) },
      });

      // Relinquish OUR master fd now that the successor holds its own dup —
      // exactly what production does by exiting. Leaving this side's libuv
      // handle open lets it race the successor for the shell's output.
      (raw as unknown as { _socket?: { destroy(): void } })._socket?.destroy();

      await until(() => existsSync(resultPath), 25000);
      expect(existsSync(resultPath)).toBe(true);
      const res = JSON.parse(readFileSync(resultPath, 'utf8')) as {
        sameShell: boolean;
        resized: boolean;
      };
      expect(res.sameShell).toBe(true); // survived: same shell answered
      expect(res.resized).toBe(true); // TIOCSWINSZ on the bare inherited fd
    } finally {
      child?.kill();
      try {
        process.kill(raw.pid); // our node-pty handle is gone; reap by pid
      } catch {
        /* already exited */
      }
      rmSync(resultPath, { force: true });
    }
  }, 40000);
});
