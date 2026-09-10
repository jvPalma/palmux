// ── PTY session ───────────────────────────────────────────────────────────────
//
// A shell PTY that OUTLIVES individual WebSocket connections. Sessions are
// addressed by URL id; clients attach/detach without killing the shell, so a
// page refresh re-attaches to the same running shell (with whatever — tmux,
// vim, a long job — still running inside it). We keep each process alive and
// replay recent output so a reconnecting client restores its screen.

import { homedir } from 'node:os';
import { adoptTransport, spawnTransport, type PtyTransport } from './pty-transport';

export interface PtyOptions {
  cols: number;
  rows: number;
  cwd?: string;
  shell?: string;
  /** Output ring-buffer size replayed on reconnect (default 512 KiB). */
  scrollbackBytes?: number;
  /**
   * Cold-start restore (see session-restore.ts). `ring` is seeded into the
   * replay buffer so an attaching client sees what the terminal showed BEFORE
   * the restart; `command` is typed into the fresh shell to bring back whatever
   * was running in it. Both are absent on a normal spawn.
   */
  restore?: {
    ring?: Buffer;
    command?: string;
  };
  /**
   * Where a program running in this shell may advertise its own restore command
   * (session-restore.ts's hint channel). Exported as `$PALMUX_RESTORE_HINT_DIR`
   * so a caller doesn't have to guess the config dir — the file within it is
   * named after the caller's own tty.
   */
  hintDir?: string;
}

/**
 * How long to wait before typing a restore command. The shell has to have
 * finished loading its rc files first: input written earlier does sit in the
 * tty buffer, but a profile that reads stdin (or a prompt framework that drains
 * it) would eat the line instead.
 */
const RESTORE_DELAY_MS = 400;

/**
 * Adopt an INHERITED pty master fd from a live handoff instead of spawning a new
 * shell — the running shell (and everything inside it) survives a server restart.
 */
export interface AdoptOptions {
  adoptFd: number;
  adoptPid: number;
  cols: number;
  rows: number;
  scrollbackBytes?: number;
  /** Replay ring + terminal mode state carried across the handoff. */
  ring?: Buffer;
  modes?: [number, boolean][];
  title?: string;
}

// Variables that tell a shell it is running *inside* a terminal multiplexer.
// If the server was launched from within tmux/screen these leak into every
// spawned shell via process.env, so the shell wrongly believes it is nested —
// `$TMUX`-branching tools and multiplexer autostart then misbehave. A terminal
// emulator must present a clean, un-nested environment, like a native terminal.
const MULTIPLEXER_VARS = ['TMUX', 'TMUX_PANE', 'STY', 'WINDOW'] as const;

/** The child shell's environment: inherited, minus multiplexer context, with TERM forced. */
export function buildShellEnv(
  base: NodeJS.ProcessEnv = process.env,
  hintDir?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of MULTIPLEXER_VARS) delete env[key];
  env['TERM'] = 'xterm-256color';
  env['COLORTERM'] = 'truecolor';
  env['TERM_PROGRAM'] = 'palmux';
  if (hintDir) env['PALMUX_RESTORE_HINT_DIR'] = hintDir;
  return env;
}

/**
 * PTY output. `bytes` is the SAME chunk already encoded for the replay ring —
 * handed over so the socket does not encode it a second time. This is the
 * hottest path in the process (every byte a shell prints, from boot, with no
 * transfer involved), and the two encodes were of identical content.
 */
type DataListener = (data: string, bytes: Buffer) => void;
type ExitListener = (code: number, signal: number | null) => void;
type TitleListener = (title: string) => void;

// OSC 0/2 window-title sequences (BEL- or ST-terminated), as emitted by shells,
// tmux, and prompt frameworks. The last one in a chunk wins.
const TITLE_RE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

// DEC private modes whose CURRENT state matters to a late-attaching client and
// whose set/reset is idempotent (safe to re-assert after replay). Mouse tracking
// + encodings, focus reporting, bracketed paste, cursor visibility. NOT the
// alt-screen modes (47/1047/1049) — re-asserting those clears the screen.
const SYNCED_MODES = new Set([25, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 2004]);
const MODE_RE = /\x1b\[\?([\d;]+)([hl])/g;

export class PtySession {
  private readonly pty: PtyTransport;
  // The ONE client currently owning this session (see `attach`). Output goes
  // only here; a new attach evicts whoever held it.
  private attachment: {
    client: object;
    /** Stable per-pane identity; equal keys mean the SAME logical client. */
    clientKey: string;
    onData: DataListener;
    onExit: ExitListener;
    onEvict: (byTheSameClient: boolean) => void;
  } | null = null;
  // Exit listeners NOT tied to a client attach (registry cleanup) — these
  // survive takeovers.
  private readonly exitListeners = new Set<ExitListener>();
  private readonly titleListeners = new Set<TitleListener>();
  // Ring buffer of recent output, replayed to (re)connecting clients.
  private readonly chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private readonly maxBufferedBytes: number;
  private trimmed = false;

  cols: number;
  rows: number;
  alive = true;
  /** Last OSC 0/2 window title seen in the output stream ('' until one appears). */
  title = '';
  // Live values of SYNCED_MODES, scanned from the output stream. Appended to
  // every replay so a (re)connecting client's parser can't drift out of sync
  // when the enabling/disabling sequence was trimmed from the ring buffer —
  // a client that wrongly believes mouse reporting is on turns every tap into
  // an SGR report the shell just echoes ("0;78;49M").
  private readonly modeState = new Map<number, boolean>();
  /** Pending restore-command write; cleared if the shell exits before it fires. */
  private restoreTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: PtyOptions | AdoptOptions) {
    this.cols = Math.max(1, opts.cols);
    this.rows = Math.max(1, opts.rows);
    this.maxBufferedBytes = opts.scrollbackBytes ?? 512 * 1024;
    if ('adoptFd' in opts) {
      // Live handoff: the SAME shell keeps running behind an inherited master fd.
      // Restore the replay ring + mode state so reattaching clients see no gap.
      this.pty = adoptTransport(opts.adoptFd, opts.adoptPid);
      if (opts.ring?.length) {
        this.chunks.push(opts.ring);
        this.bufferedBytes = opts.ring.length;
      }
      for (const [mode, on] of opts.modes ?? []) this.modeState.set(mode, on);
      if (opts.title) this.title = opts.title;
    } else {
      const shell = opts.shell || process.env['SHELL'] || '/bin/bash';
      // Login shell (-l) so the user's full profile loads, like a native terminal.
      this.pty = spawnTransport(shell, ['-l'], {
        cols: this.cols,
        rows: this.rows,
        cwd: opts.cwd || homedir(),
        env: buildShellEnv(process.env, opts.hintDir),
      });
      // Cold-start restore. The ring goes in FIRST so it sits below everything
      // the new shell prints, exactly like scrollback from before the restart.
      const restoreRing = opts.restore?.ring;
      if (restoreRing?.length) {
        this.chunks.push(restoreRing);
        this.bufferedBytes = restoreRing.length;
      }
      const command = opts.restore?.command;
      if (command) {
        this.restoreTimer = setTimeout(() => {
          this.restoreTimer = null;
          if (this.alive) this.write(`${command}\r`);
        }, RESTORE_DELAY_MS);
      }
    }
    this.pty.onData((data) => {
      const bytes = this.remember(data);
      this.scanTitle(data);
      this.scanModes(data);
      this.attachment?.onData(data, bytes);
    });
    this.pty.onExit((exitCode, signal) => {
      this.alive = false;
      if (this.restoreTimer) clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
      this.attachment?.onExit(exitCode, signal);
      for (const l of this.exitListeners) l(exitCode, signal);
    });
  }

  /** The child shell's pid — what session-restore inspects via /proc. */
  get pid(): number {
    return this.pty.pid;
  }

  /** The raw replay ring, for persisting a cold-start snapshot. */
  ringBytes(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** Everything a successor process needs to adopt this live PTY across a restart. */
  exportState(): {
    pid: number;
    fd: number;
    cols: number;
    rows: number;
    ring: string;
    modes: [number, boolean][];
    title: string;
  } {
    return {
      pid: this.pty.pid,
      fd: this.pty.fd,
      cols: this.cols,
      rows: this.rows,
      ring: Buffer.concat(this.chunks).toString('base64'),
      modes: [...this.modeState.entries()],
      title: this.title,
    };
  }

  private scanTitle(data: string): void {
    if (!data.includes('\x1b]')) return;
    let last: string | null = null;
    for (const m of data.matchAll(TITLE_RE)) last = m[1] ?? null;
    if (last !== null && last !== this.title) {
      this.title = last;
      for (const l of this.titleListeners) l(last);
    }
  }

  private scanModes(data: string): void {
    if (!data.includes('\x1b[?')) return;
    for (const m of data.matchAll(MODE_RE)) {
      const on = m[2] === 'h';
      for (const num of m[1]!.split(';')) {
        const mode = Number(num);
        if (SYNCED_MODES.has(mode)) this.modeState.set(mode, on);
      }
    }
  }

  /** Append to the replay ring and return the encoded chunk for reuse. */
  private remember(data: string): Buffer {
    const buf = Buffer.from(data, 'utf8');
    this.chunks.push(buf);
    this.bufferedBytes += buf.length;
    while (this.bufferedBytes > this.maxBufferedBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      if (dropped) this.bufferedBytes -= dropped.length;
      this.trimmed = true;
    }
    return buf;
  }

  /** Recent output, replayed to a (re)connecting client so it restores its screen. */
  snapshot(): Buffer {
    let all = Buffer.concat(this.chunks);
    if (this.trimmed) {
      // The ring drops whole chunks from the front, so a trimmed buffer can start
      // mid-escape-sequence (or mid-UTF-8 rune) — xterm would render the dangling
      // tail as literal text (e.g. "8;83;158t"). Resync to the first line boundary.
      const nl = all.indexOf(0x0a);
      if (nl !== -1) all = all.subarray(nl + 1);
    }
    // Strip terminal identity/size/mode QUERIES (DA, DSR, XTWINOPS, DECRQM,
    // kitty-kbd). They're invisible on screen, but a replaying client would
    // answer them — and the program that asked is long gone, so the answer
    // lands at the shell prompt as typed junk ("?1;2c").
    const scrubbed = all
      .toString('latin1')
      .replace(/\x1b\[(>?[\d;]*c|[56]n|1[468]t|\?[\d;]*\$p|\?u)/g, '');
    // Re-assert the live mode state so the client ends the replay in sync even
    // if the toggling sequences were trimmed out of the ring.
    let sync = '';
    for (const [mode, on] of this.modeState) sync += `\x1b[?${mode}${on ? 'h' : 'l'}`;
    return Buffer.from(scrubbed + sync, 'latin1');
  }

  /**
   * Attach a client, taking the session OVER: a terminal has exactly one active
   * client, so any earlier one is evicted (its `onEvict` fires) and stops
   * receiving output. `onEvict` is told whether the newcomer is the SAME logical
   * client (same `clientKey`) — a reconnect rather than a takeover. Returns a
   * detach function that does NOT kill the PTY.
   */
  attach(
    client: object,
    clientKey: string,
    onData: DataListener,
    onExit: ExitListener,
    onEvict: (byTheSameClient: boolean) => void,
  ): () => void {
    const evicted = this.attachment;
    // Install BEFORE evicting: the evicted client's cleanup calls its own detach,
    // which must not tear down the attachment that just replaced it.
    this.attachment = { client, clientKey, onData, onExit, onEvict };
    this.lastEmptyAt = null;
    // A matching key is the SAME pane reconnecting (network blip, tab restore),
    // not a rival taking the session. Still evict — the old socket is spent —
    // but tell the caller, so it can go quietly instead of crying takeover.
    if (evicted) evicted.onEvict(evicted.clientKey !== '' && evicted.clientKey === clientKey);
    return () => {
      if (this.attachment?.client !== client) return; // already superseded
      this.attachment = null;
      this.lastEmptyAt = Date.now();
    };
  }

  /** Register a persistent exit listener not tied to a client attach (registry cleanup). */
  onExit(listener: ExitListener): void {
    this.exitListeners.add(listener);
  }

  /** Register a listener for OSC window-title changes (session-list labels). */
  onTitle(listener: TitleListener): void {
    this.titleListeners.add(listener);
  }

  write(data: string): void {
    this.pty.write(data);
  }

  // Timestamp when this PTY last had an attached client (for idle eviction);
  // null while one is attached. Seeded at construction so a dormant/never-
  // attached PTY is also eligible for the idle sweep.
  private lastEmptyAt: number | null = Date.now();

  /** Ms-epoch since this PTY last had an attached client, or null if attached. */
  emptySince(): number | null {
    return this.attachment === null ? this.lastEmptyAt : null;
  }

  /**
   * Report the active client's size. Only the client that currently owns the
   * session may resize it — an evicted socket can still have a resize in flight,
   * and honouring it would reshape the grid under the client that took over.
   */
  resizeClient(client: object, cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return;
    if (this.attachment?.client !== client) return;
    this.resize(cols, rows);
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0 && (cols !== this.cols || rows !== this.rows)) {
      this.cols = cols;
      this.rows = rows;
      try {
        this.pty.resize(cols, rows);
      } catch {
        // pty already gone
      }
    }
  }

  kill(signal?: string): void {
    try {
      this.pty.kill(signal);
    } catch {
      // already dead
    }
  }
}
