// ── Terminal restore across a COLD start ──────────────────────────────────────
//
// `handoff.ts` keeps shells alive across a restart by passing their pty master
// fds to a successor — but it refuses to run under systemd (see
// handoffBlockedReason), and nothing at all survives a reboot. Both of those end
// in a cold start, where the old shells are gone for good: a process whose pty
// master died cannot be reattached, by us or by anyone. So a cold start has to
// REBUILD the terminal, from three things captured while it was alive:
//
//   cwd      — where the work was happening
//   command  — the foreground process group's command line, whatever it was
//   ring     — the replay buffer, i.e. what the screen last showed
//
// The command comes from /proc, never from a list of known programs: palmux
// takes whatever was in the foreground and types it back into the fresh shell.
// That is the design constraint — it has to work for tmux, screen, ssh, a REPL,
// a dev server or a log tail without knowing any of them apart.
//
// Be honest about what this is: RELAUNCHING, not resuming. A program comes back
// with its state only if it kept that state somewhere outside the terminal.
// tmux and screen do — their own server owns the panes, so re-running the client
// reattaches a live session with everything still in it, which is why this feels
// seamless there. `vim` reopens the file; a build restarts from the top. The
// restored ring covers the rest: the content is back on screen as scrollback
// even when the process behind it isn't.
//
// Capturing the FOREGROUND process is also what keeps this safe-ish: a command
// has to still be running at capture time to be recorded, which selects
// long-lived interactive programs and all but excludes the fire-and-forget
// destructive one-liners you would not want replayed. It is typed into the
// shell rather than exec'd, so it lands in the scrollback exactly as if the user
// had typed it, and `restoreSessions: false` in config.json turns it all off.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { configDir } from './config';

export interface SessionSnapshot {
  /** Working directory to respawn the shell in. */
  cwd?: string;
  /**
   * The foreground process's argv, as an ARRAY. Not a joined string: joining on
   * spaces is not shell quoting, and this gets typed into a live shell. An argv
   * element holding a space silently becomes two words (`vim my notes.txt`
   * opens two files); one holding `;` or `$()` executes — a filename is enough
   * to inject. `quoteArgv` renders it safely at restore time.
   */
  argv?: string[];
  /**
   * A restore line a PROGRAM advertised for this terminal (see the hint channel
   * below). Used VERBATIM — it was authored deliberately, unlike `argv`, which
   * is scraped and therefore has to be quoted.
   */
  command?: string;
  /** base64 replay ring — what the terminal last showed. */
  ring?: string;
  /** Epoch ms of the capture, for pruning stale records. */
  at: number;
}

/** Caps on what we are willing to type back: per argument, and in total. */
const MAX_ARG = 1024;
const MAX_ARGV = 64;
const MAX_COMMAND = 4096;
/** Records older than this are dropped on load — a month-old cwd is noise. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A restored argument is TYPED into a live shell, so no element may carry a
 * control character. Checked on capture AND on load: the snapshot file is
 * user-editable, and an embedded CR would smuggle a second command past the eye
 * (quoting alone does not save us — a CR ends the line inside quotes too).
 */
// eslint-disable-next-line no-control-regex -- rejecting C0/DEL is the point
const CONTROL_RE = /[\x00-\x1f\x7f]/;

const argvIsTypable = (argv: unknown): argv is string[] =>
  Array.isArray(argv) &&
  argv.length > 0 &&
  argv.length <= MAX_ARGV &&
  argv.every((a) => typeof a === 'string' && a.length > 0 && a.length <= MAX_ARG && !CONTROL_RE.test(a));

/** Characters that need no quoting in any POSIX shell. */
const SHELL_SAFE_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Render argv as ONE shell line, POSIX-quoted. Single quotes are the only
 * construct with no escapes inside, so everything but a literal `'` is inert;
 * the `'` itself closes, escapes, and reopens ('\'').
 */
export function quoteArgv(argv: string[]): string {
  return argv
    .map((a) => (SHELL_SAFE_RE.test(a) ? a : `'${a.split("'").join(`'\\''`)}'`))
    .join(' ');
}

export function restoreDir(): string {
  return join(configDir(), 'sessions');
}

/**
 * The foreground process group of the terminal `shellPid` owns, via /proc.
 *
 * /proc/<pid>/stat field 8 is `tpgid`, the foreground process group of that
 * process's controlling tty — what `tcgetpgrp()` would report, but reachable
 * without the master fd (which node-pty does not expose). `comm` sits unquoted
 * in field 2 and may contain spaces or parens, so parsing starts after the LAST
 * ')': splitting on whitespace from the front is the classic way to read the
 * wrong field for a process named `(my prog)`.
 */
export function foregroundPid(shellPid: number, procRoot = '/proc'): number | null {
  let stat: string;
  try {
    stat = readFileSync(join(procRoot, String(shellPid), 'stat'), 'utf8');
  } catch {
    return null; // process gone, or not Linux
  }
  const close = stat.lastIndexOf(')');
  if (close === -1) return null;
  // After `comm` the fields run: state ppid pgrp session tty_nr tpgid …
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const tpgid = Number(fields[5]);
  if (!Number.isFinite(tpgid) || tpgid <= 0) return null;
  // The shell being its own foreground group means nothing is running in it.
  return tpgid === shellPid ? null : tpgid;
}

/** A process's argv, or null when it is missing or unfit to be typed back. */
export function argvOf(pid: number, procRoot = '/proc'): string[] | null {
  let raw: string;
  try {
    raw = readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8');
  } catch {
    return null;
  }
  const argv = raw.split('\0').filter((a) => a.length > 0);
  if (!argvIsTypable(argv)) return null;
  return quoteArgv(argv).length <= MAX_COMMAND ? argv : null;
}

/**
 * The terminal a process is on, as a bare device name (`pts/7`), or null.
 *
 * This is the JOIN KEY for the hint channel below. fd 0 is used rather than
 * /proc/<pid>/stat's tty_nr because that field is an encoded dev_t that still
 * has to be resolved to a name, while the fd is already the path.
 */
export function ttyOf(pid: number, procRoot = '/proc'): string | null {
  let link: string;
  try {
    link = readlinkSync(join(procRoot, String(pid), 'fd', '0'));
  } catch {
    return null;
  }
  // Keep the device name EXACTLY as it appears under /dev (`pts/16`, not
  // `pts16`): `createHintStore` derives the filename from it, and the two sides
  // silently stopped matching when this stripped the slash and that one mapped
  // it to a dash.
  const m = /^\/dev\/(pts\/\d+|tty[A-Za-z0-9]+)$/.exec(link);
  return m ? m[1]! : null;
}

function cwdOf(pid: number, procRoot = '/proc'): string | null {
  try {
    return readlinkSync(join(procRoot, String(pid), 'cwd'));
  } catch {
    return null;
  }
}

/**
 * What to remember about a live terminal: where it is, and what is running in
 * it. Falls back to the shell's own cwd when nothing is in the foreground.
 */
export function captureProcess(
  shellPid: number,
  procRoot = '/proc',
): { cwd?: string; argv?: string[] } {
  const fg = foregroundPid(shellPid, procRoot);
  const cwd = (fg === null ? null : cwdOf(fg, procRoot)) ?? cwdOf(shellPid, procRoot);
  const argv = fg === null ? null : argvOf(fg, procRoot);
  return {
    ...(cwd ? { cwd } : {}),
    ...(argv ? { argv } : {}),
  };
}

// Alt-screen enter/leave. The restored ring is replayed as SCROLLBACK into a
// fresh terminal, so it must not switch buffers: a `?1049h` mid-replay would put
// the client in the alternate screen, and a later `?1049l` would then wipe
// everything the replay had just drawn. Stripping them flattens a full-screen
// app's last frame into ordinary scrollback — imperfect, but the restore command
// repaints over it immediately, and the alternative is a blank terminal.
const ALT_SCREEN_RE = /\x1b\[\?(?:1049|1047|47)[hl]/g;

/** Prepare a persisted ring for replay into a freshly spawned terminal. */
export function restorableRing(ring: Buffer): Buffer {
  const flat = ring.toString('latin1').replace(ALT_SCREEN_RE, '');
  if (!flat.trim()) return Buffer.alloc(0);
  // The ring is RAW BYTES, so it round-trips through latin1; the marker is real
  // text and has to be encoded as utf8 — sending it through latin1 too would
  // truncate each box-drawing char to one byte and emit mojibake.
  return Buffer.concat([
    Buffer.from(flat, 'latin1'),
    Buffer.from('\x1b[0m\r\n\x1b[2m── restored ──\x1b[0m\r\n', 'utf8'),
  ]);
}

// ── The hint channel ─────────────────────────────────────────────────────────
//
// Some things cannot be read off a process, and the motivating one is exact
// tmux session identity. A wrapper resolves which session to attach at RUN time
// (so its argv may say `dr tmux/session` and name nothing), and `switch-client`
// moves a client to another session without touching any argv — verified: after
// switching from session `a` to `b`, /proc still reports `attach-session -t a`.
// Walking to the deepest child does not fix it either, and it breaks every
// wrapper that exists to inject env (`npm run dev`, `sudo`, `poetry run`), plus
// it is meaningless for a pipeline, whose process group has several leaves.
//
// So the program says it itself. Anything running in a palmux terminal may
// write its restore line to <hintDir>/<its tty>.restore, and that wins over the
// /proc capture. The tty is the join key because it is the one identifier both
// sides already know without agreeing on anything: palmux reads it from the
// shell's fd 0, and a program gets it from its own tty. Notably it works from
// tmux hooks, which run in the SERVER's environment and would never see an
// environment variable palmux exported into a shell (`#{client_tty}` is right
// there in the hook). palmux stays ignorant of tmux; tmux is just the first
// caller.
//
// Staleness is handled by DELETING the hint when a terminal spawns on that tty:
// pts numbers are recycled, so a leftover file from a previous terminal would
// otherwise restore the wrong thing. Anything present afterwards was written
// during this terminal's life.

/** Name of the env var telling programs where to drop a hint. */
export const HINT_DIR_ENV = 'PALMUX_RESTORE_HINT_DIR';

export function hintDir(): string {
  return join(restoreDir(), 'by-tty');
}

export interface HintStore {
  /** The advertised restore for a tty, or null. */
  read(tty: string): { argv?: string[]; command?: string } | null;
  /** Drop a tty's hint — called when a terminal spawns on it. */
  clear(tty: string): void;
  /**
   * Delete every hint that does NOT belong to one of `liveTtys`. Returns how
   * many went.
   *
   * This is the counterpart the snapshots always had and the hints never did.
   * A hint is only ever READ through `ttyOf(pty.pid)` of a live palmux
   * terminal, so one on any other tty is unreadable AND a landmine: pts numbers
   * are handed out lowest-free, so a terminal spawning weeks later lands on the
   * same number and inherits a command from a session that no longer exists.
   *
   * Observed on a real host: 17 files, the oldest three weeks old, seven naming
   * tmux sessions that were gone. They accumulated because a hint is otherwise
   * only cleared by a palmux terminal touching that exact pts — three terminals
   * against fifty ptys — and because every death that runs no code (SIGKILL, a
   * power cut) skips the clear entirely.
   *
   * Liveness, NOT age. An age cutoff looks equivalent and is not: a terminal
   * that has been attached to the same tmux session for a fortnight has a
   * fortnight-old hint that is still exactly right, and a TTL would throw it
   * away and fall back to the /proc capture that cannot see a `switch-client`.
   */
  sweep(liveTtys: Iterable<string>): number;
  dir(): string;
}

export function createHintStore(dir = hintDir()): HintStore {
  // `pts/7` -> `pts-7`: the tty name contains a slash, which cannot be a path
  // segment, and a caller-supplied name must never escape the directory.
  const fileFor = (tty: string): string | null =>
    /^[A-Za-z0-9/]+$/.test(tty) ? join(dir, `${tty.replace(/\//g, '-')}.restore`) : null;
  return {
    dir: () => dir,
    read(tty) {
      const file = fileFor(tty);
      if (!file) return null;
      let raw: string;
      try {
        raw = readFileSync(file, 'utf8').trim();
      } catch {
        return null; // no hint for this terminal
      }
      if (!raw) return null;
      // Two accepted shapes: {"argv":[...]} for a caller that can build JSON,
      // and a bare line for a caller that is a one-line shell hook.
      if (raw.startsWith('{')) {
        try {
          const parsed = JSON.parse(raw) as { argv?: unknown };
          return argvIsTypable(parsed.argv) ? { argv: parsed.argv } : null;
        } catch {
          return null;
        }
      }
      return raw.length <= MAX_COMMAND && !CONTROL_RE.test(raw) ? { command: raw } : null;
    },
    clear(tty) {
      const file = fileFor(tty);
      if (!file) return;
      try {
        rmSync(file);
      } catch {
        /* nothing there — already clear */
      }
    },
    sweep(liveTtys) {
      // The keep set is filenames, not tty names, so the comparison happens in
      // one vocabulary — `pts/7` and `pts-7` are the same terminal and mixing
      // the two is how a sweep silently keeps everything or deletes everything.
      const keep = new Set<string>();
      for (const tty of liveTtys) {
        const file = fileFor(tty);
        if (file) keep.add(file.slice(file.lastIndexOf('/') + 1));
      }
      let removed = 0;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return 0; // no hint dir yet — nothing to sweep
      }
      for (const name of names) {
        if (!name.endsWith('.restore') || keep.has(name)) continue;
        try {
          rmSync(join(dir, name));
          removed++;
        } catch {
          /* raced with something else removing it */
        }
      }
      return removed;
    },
  };
}

/**
 * An in-memory restore store, for tests. Without it a registry built with the
 * defaults reads the REAL `<configDir>/sessions/`, which made a persistence
 * test fail the moment a live palmux wrote a snapshot underneath it — a test
 * that passes or fails depending on what else is running is worse than no test.
 */
export function memoryRestoreStore(seed: Record<string, SessionSnapshot> = {}): RestoreStore {
  const map = new Map(Object.entries(seed));
  return {
    load: (id) => map.get(id) ?? null,
    save: (id, snap) => void map.set(id, snap),
    forget: (id) => void map.delete(id),
    ids: () => [...map.keys()],
  };
}

export interface RestoreStore {
  load(id: string): SessionSnapshot | null;
  save(id: string, snap: SessionSnapshot): void;
  forget(id: string): void;
  /** Ids that currently have a snapshot on disk. */
  ids(): string[];
}

function parseSnapshot(raw: unknown, now = Date.now()): SessionSnapshot | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const at = typeof rec['at'] === 'number' ? rec['at'] : 0;
  if (at && now - at > MAX_AGE_MS) return null;
  // cwd must be an absolute path that still exists: a relative one would resolve
  // against wherever the server happens to run, and a deleted one makes the
  // shell fail to spawn at all. Falling back to the default beats not opening.
  const rawCwd = rec['cwd'];
  const cwd =
    typeof rawCwd === 'string' && rawCwd.startsWith('/') && existsSync(rawCwd) ? rawCwd : '';
  const command = typeof rec['command'] === 'string' ? rec['command'].trim() : '';
  return {
    at,
    ...(cwd ? { cwd } : {}),
    ...(argvIsTypable(rec['argv']) ? { argv: rec['argv'] } : {}),
    ...(command && command.length <= MAX_COMMAND && !CONTROL_RE.test(command)
      ? { command }
      : {}),
    ...(typeof rec['ring'] === 'string' && rec['ring'] ? { ring: rec['ring'] } : {}),
  };
}

/**
 * One JSON file per tab under <configDir>/sessions/. Separate from tabs.json on
 * purpose: this is bulky (a 512 KiB ring, base64'd) and disposable, while
 * tabs.json is small metadata that has to stay readable by an older server.
 */
export function createRestoreStore(dir = restoreDir()): RestoreStore {
  const path = (id: string) => join(dir, `${id}.json`);
  return {
    load(id) {
      try {
        return parseSnapshot(JSON.parse(readFileSync(path(id), 'utf8')));
      } catch {
        return null; // missing or corrupt → nothing to restore
      }
    },
    save(id, snap) {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        // Atomic: a snapshot half-written by a crash mid-shutdown would parse as
        // corrupt and silently lose a session that was perfectly restorable.
        const tmp = `${path(id)}.tmp`;
        writeFileSync(tmp, JSON.stringify(snap), { mode: 0o600 });
        renameSync(tmp, path(id));
      } catch {
        /* an unwritable snapshot must never break the server */
      }
    },
    forget(id) {
      try {
        rmSync(path(id));
      } catch {
        /* already gone */
      }
    },
    ids() {
      if (!existsSync(dir)) return [];
      try {
        return readdirSync(dir)
          .filter((n) => n.endsWith('.json'))
          .map((n) => n.slice(0, -5));
      } catch {
        return [];
      }
    },
  };
}
