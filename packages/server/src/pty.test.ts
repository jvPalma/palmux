import { describe, it, expect } from 'vitest';
import { buildShellEnv, PtySession } from './pty';

describe('buildShellEnv', () => {
  it('strips multiplexer context so the shell is not seen as nested', () => {
    const env = buildShellEnv({
      TMUX: '/tmp/tmux-1000/default,123,17',
      TMUX_PANE: '%52',
      STY: '4242.pts-0.host',
      WINDOW: '3',
      PATH: '/usr/bin',
      HOME: '/home/user',
    });
    expect(env['TMUX']).toBeUndefined();
    expect(env['TMUX_PANE']).toBeUndefined();
    expect(env['STY']).toBeUndefined();
    expect(env['WINDOW']).toBeUndefined();
  });

  it('preserves other inherited variables', () => {
    const env = buildShellEnv({ PATH: '/usr/bin', HOME: '/home/user', FOO: 'bar' });
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HOME']).toBe('/home/user');
    expect(env['FOO']).toBe('bar');
  });

  it('forces terminal identity regardless of an inherited TERM', () => {
    const env = buildShellEnv({ TERM: 'tmux-256color' });
    expect(env['TERM']).toBe('xterm-256color');
    expect(env['COLORTERM']).toBe('truecolor');
    expect(env['TERM_PROGRAM']).toBe('palmux');
  });

  it('does not mutate the source environment object', () => {
    const base = { TMUX: 'x', PATH: '/bin' };
    buildShellEnv(base);
    expect(base.TMUX).toBe('x');
  });
});

describe('PtySession', () => {
  it('sizes the PTY to the one active client, ignoring evicted ones', () => {
    const session = new PtySession({ shell: '/bin/sh', cols: 80, rows: 24 });
    try {
      const c1 = {};
      const c2 = {};
      const noop = (): void => {};
      session.attach(c1, 'k1', noop, noop, noop);
      session.resizeClient(c1, 120, 40);
      expect([session.cols, session.rows]).toEqual([120, 40]);
      // A second attach takes over; its size applies whether bigger or smaller.
      session.attach(c2, 'k2', noop, noop, noop);
      session.resizeClient(c2, 80, 50);
      expect([session.cols, session.rows]).toEqual([80, 50]);
      // A resize still in flight from the EVICTED client must not reshape the
      // grid under the client that took over.
      session.resizeClient(c1, 200, 60);
      expect([session.cols, session.rows]).toEqual([80, 50]);
    } finally {
      session.kill();
    }
  });

  it('onExit fires when the shell exits', async () => {
    const session = new PtySession({ shell: '/bin/sh', cols: 80, rows: 24 });
    let called = false;
    const exited = new Promise<void>((resolve) => {
      session.onExit(() => {
        called = true;
        resolve();
      });
    });

    try {
      session.write('exit\n');
      await exited;
      expect(called).toBe(true);
    } finally {
      session.kill();
    }
  }, 5000);

  it('a new attach takes over: the previous client is evicted and goes silent', async () => {
    const session = new PtySession({ shell: '/bin/sh', cols: 80, rows: 24 });
    try {
      const noop = (): void => {};
      const first: string[] = [];
      let evictedFirst = false;
      let evictedSecond = false;

      session.attach({}, 'k1', (d) => first.push(d), noop, () => {
        evictedFirst = true;
      });
      const sawOutput = new Promise<void>((resolve) => {
        session.attach({}, 'k2', () => resolve(), noop, () => {
          evictedSecond = true;
        });
      });

      expect(evictedFirst).toBe(true); // the newcomer took the session
      expect(evictedSecond).toBe(false); // …and still holds it

      session.write('echo hi\n');
      await sawOutput;
      expect(first).toEqual([]); // the evicted client saw none of it
    } finally {
      session.kill();
    }
  }, 5000);

  it('the SAME client reconnecting is an eviction, but not a takeover', () => {
    const session = new PtySession({ shell: '/bin/sh', cols: 80, rows: 24 });
    try {
      const noop = (): void => {};
      let sameClient: boolean | null = null;
      // One pane, one stable key, two sockets: a network blip, not a rival.
      session.attach({}, 'pane-abc', noop, noop, (same) => {
        sameClient = same;
      });
      session.attach({}, 'pane-abc', noop, noop, noop);
      expect(sameClient).toBe(true); // → close quietly, no "opened somewhere else"
    } finally {
      session.kill();
    }
  }, 5000);

  it('a DIFFERENT client is a real takeover', () => {
    const session = new PtySession({ shell: '/bin/sh', cols: 80, rows: 24 });
    try {
      const noop = (): void => {};
      let sameClient: boolean | null = null;
      session.attach({}, 'pane-abc', noop, noop, (same) => {
        sameClient = same;
      });
      session.attach({}, 'pane-xyz', noop, noop, noop);
      expect(sameClient).toBe(false);
    } finally {
      session.kill();
    }
  }, 5000);

  it('an empty key never matches — an older client keeps takeover semantics', () => {
    const session = new PtySession({ shell: '/bin/sh', cols: 80, rows: 24 });
    try {
      const noop = (): void => {};
      let sameClient: boolean | null = null;
      session.attach({}, '', noop, noop, (same) => {
        sameClient = same;
      });
      session.attach({}, '', noop, noop, noop);
      expect(sameClient).toBe(false); // two unidentified clients are not "the same"
    } finally {
      session.kill();
    }
  }, 5000);

  it('the evicted client detaching does not tear down its successor', () => {
    const session = new PtySession({ shell: '/bin/sh', cols: 80, rows: 24 });
    try {
      const noop = (): void => {};
      const b = {};
      // A real evicted client calls its own detach from inside onEvict (that is
      // what the ws bridge does), which must not clear the attachment that just
      // replaced it. Wrong order leaves the session unattached — and reapable.
      let detachA: () => void = noop;
      detachA = session.attach({}, 'ka', noop, noop, () => detachA());
      session.attach(b, 'kb', noop, noop, noop);

      expect(session.emptySince()).toBeNull();
      session.resizeClient(b, 100, 30);
      expect([session.cols, session.rows]).toEqual([100, 30]);
    } finally {
      session.kill();
    }
  }, 5000);

  it('onExit listeners are independent of attach/detach', async () => {
    const session = new PtySession({ shell: '/bin/sh', cols: 80, rows: 24 });
    let attachExitCalled = false;
    const detach = session.attach(
      {},
      'k',
      () => {},
      () => {
        attachExitCalled = true;
      },
      () => {},
    );
    detach();

    let called = false;
    const exited = new Promise<void>((resolve) => {
      session.onExit(() => {
        called = true;
        resolve();
      });
    });

    try {
      session.write('exit\n');
      await exited;
      expect(called).toBe(true);
      expect(attachExitCalled).toBe(false);
    } finally {
      session.kill();
    }
  }, 5000);
});

describe('idle tracking (emptySince, for idle-session eviction)', () => {
  it('is empty at construction, null while a client is attached, set again on drop', () => {
    const session = new PtySession({ shell: '/bin/sh', cols: 80, rows: 24 });
    try {
      // Dormant / never-attached → eligible for the idle sweep.
      expect(session.emptySince()).not.toBeNull();
      const noop = (): void => {};
      const detach = session.attach({}, 'k', noop, noop, noop);
      expect(session.emptySince()).toBeNull(); // attached → never reaped
      detach();
      expect(session.emptySince()).not.toBeNull(); // empty again
    } finally {
      session.kill();
    }
  });
});

// ── The listener gets the ring's own buffer ───────────────────────────────────
//
// Every byte a shell prints crosses this path, from boot, with no transfer
// involved — so it was encoding the same chunk twice: once for the replay ring
// and once for the WebSocket frame. The listener now receives the ring's buffer,
// and this is the assertion that stops the second `Buffer.from` coming back.
describe('PtySession output chunks', () => {
  it('hands the listener the SAME buffer it appended to the replay ring', async () => {
    const session = new PtySession({ shell: '/bin/sh', cols: 80, rows: 24 });
    try {
      const seen: { text: string; bytes: Buffer }[] = [];
      session.attach(
        {},
        'k',
        (text, bytes) => seen.push({ text, bytes }),
        () => {},
        () => {},
      );
      session.write('printf PALMUX_MARK\r');
      await new Promise((r) => setTimeout(r, 1200));

      expect(seen.length).toBeGreaterThan(0);
      for (const { text, bytes } of seen) {
        expect(Buffer.isBuffer(bytes)).toBe(true);
        // Same content, and produced once: the ring's replay must be byte-equal
        // to the concatenation of what the socket was handed.
        expect(bytes.toString('utf8')).toBe(text);
      }
      const fromListener = Buffer.concat(seen.map((s) => s.bytes)).toString('utf8');
      expect(fromListener).toContain('PALMUX_MARK');
      expect(session.snapshot().toString('utf8')).toContain('PALMUX_MARK');
    } finally {
      session.kill();
    }
  });
});
