// ── tmux session discovery ────────────────────────────────────────────────────
//
// Palmux stays ignorant of tmux everywhere else (session-restore just replays
// whatever was in the foreground). This module is the one deliberate exception:
// the new-tab chooser offers the tmux sessions already running on THIS host, so
// opening a terminal can go straight into one instead of typing the attach.
//
// It only ever READS the session list and builds a command string. Nothing here
// starts, kills or reconfigures a tmux server.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { quoteArgv } from './session-restore';

export interface TmuxSession {
  name: string;
  /** A client is currently attached. Picking it will DETACH that client. */
  attached: boolean;
}

export interface TmuxListing {
  /** False when tmux is not installed — the chooser hides the whole section. */
  available: boolean;
  /** Alphabetical, case-insensitive. Empty when no server is running. */
  sessions: TmuxSession[];
}

/**
 * tmux forbids `.` and `:` in a session name (they are its target syntax), and
 * a control character would break out of the line we type into the shell — the
 * quoting below cannot save that, exactly as in session-restore. The name comes
 * off a query parameter, so it is untrusted twice over: validated here, quoted
 * again at the point of use.
 */
export function isTmuxSessionName(name: string): boolean {
  // Hyphens, underscores and spaces are all legal and all common
  // (DB_BACKFILL-0), so only tmux's own target punctuation and control
  // characters are excluded.
  // oxlint-disable-next-line no-control-regex
  return name.length > 0 && name.length <= 128 && !/[.:\u0000-\u001f\u007f]/.test(name);
}

/**
 * The command typed into a fresh shell to land in `session`.
 *
 * `new-session -A` is attach-or-create, so a session that disappeared between
 * the listing and the click still opens something rather than erroring; `-D`
 * makes the attach half detach whoever else is on it. Stealing is the deliberate
 * choice (verified against tmux 3.7b: client count stays 1 across the second
 * attach): tmux sizes a window to its SMALLEST client, so a parallel attach from
 * a phone would silently shrink the same session on a desktop.
 *
 * `null` means "a new session with no name" — tmux picks the next free number.
 */
export function tmuxAttachCommand(session: string | null): string {
  if (session === null) return 'tmux new-session';
  return quoteArgv(['tmux', 'new-session', '-A', '-D', '-s', session]);
}

const LIST_FORMAT = '#{session_name}\t#{?session_attached,1,0}';

/**
 * Where to look for tmux when it is not on PATH.
 *
 * This is not defensive padding — it is the difference between the feature
 * working and silently reporting "tmux is not installed". Palmux runs as a
 * systemd USER UNIT, whose PATH is systemd's minimal default
 * (/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin), not the login
 * shell's. A Homebrew tmux — the case this was caught on, with 26 live sessions
 * the server could not see — lives outside all of it.
 *
 * The command TYPED into a terminal still says plain `tmux`: that runs in the
 * user's own shell, with the user's own PATH, which is the right resolver there.
 */
const TMUX_FALLBACKS = [
  '/usr/local/bin/tmux',
  '/usr/bin/tmux',
  '/opt/homebrew/bin/tmux',
  '/home/linuxbrew/.linuxbrew/bin/tmux',
  join(homedir(), '.linuxbrew/bin/tmux'),
  join(homedir(), '.local/bin/tmux'),
];

/** Resolved once per process — a binary does not move while we run. */
let resolvedTmux: string | null | undefined;

function tmuxBinary(): string | null {
  if (resolvedTmux !== undefined) return resolvedTmux;
  resolvedTmux = TMUX_FALLBACKS.find((p) => existsSync(p)) ?? null;
  return resolvedTmux;
}

function runTmuxList(bin: string): Promise<{ code: number; stdout: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      ['list-sessions', '-F', LIST_FORMAT],
      { timeout: 3000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        const code = (err as { code?: unknown } | null)?.code;
        // ENOENT is the only answer that means "there is no tmux here". Every
        // other failure — most often exit 1, "no server running on ..." — is a
        // working tmux with nothing to list.
        resolve({
          code: typeof code === 'number' ? code : err ? 1 : 0,
          stdout,
          missing: code === 'ENOENT',
        });
      },
    );
  });
}

/** The tmux sessions running on this host, alphabetical. Never throws. */
export async function listTmuxSessions(): Promise<TmuxListing> {
  // PATH first: it is right whenever palmux was started from a shell, and it
  // honours a tmux the user deliberately put ahead of the system one.
  let out = await runTmuxList('tmux');
  if (out.missing) {
    const bin = tmuxBinary();
    if (!bin) return { available: false, sessions: [] };
    out = await runTmuxList(bin);
  }
  const { stdout, missing } = out;
  if (missing) return { available: false, sessions: [] };
  const sessions: TmuxSession[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const tab = line.lastIndexOf('\t');
    if (tab <= 0) continue;
    const name = line.slice(0, tab);
    // A name tmux itself allows but we could not safely type back is dropped
    // rather than offered: a row that errors on click is worse than no row.
    if (!isTmuxSessionName(name)) continue;
    sessions.push({ name, attached: line.slice(tab + 1) === '1' });
  }
  // Case-insensitive but PUNCTUATION-SIGNIFICANT. `localeCompare` at base
  // sensitivity treats `_` and `-` as ignorable, which scattered a real host's
  // names: L1_ORCHESTRATOR-0 collated as L1ORCHESTRATOR0 and landed after the
  // whole L1_ORCHESTRATOR_* group it belongs with, which reads as a bug.
  sessions.sort((a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return { available: true, sessions };
}
