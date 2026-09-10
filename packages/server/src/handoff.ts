// ── Live-PTY handoff ──────────────────────────────────────────────────────────
//
// Hand every running shell to a freshly-exec'd successor process so a server
// restart does NOT kill live sessions (palmux previously admitted "server
// restarts KILL live workspace sessions").
//
// Mechanism (validated by spike 0.1):
//   parent  — collect each live PTY's master fd + replay ring + mode state,
//             spawn a DETACHED successor with the fds inherited at 3,4,5…,
//             hand the manifest over in an env var, then exit WITHOUT killing
//             the shells (they are reparented, still holding their slave side).
//   successor — read the manifest, wrap each inherited fd with adoptTransport,
//             and register the sessions under their original tab ids.
//
// Safe degrade: anything that fails to adopt is simply skipped, and the normal
// cold-restart path respawns that tab's shell (tab metadata already persists via
// tabs.json), so a handoff failure is never worse than today's behaviour.

import { spawn } from 'node:child_process';
import { PtySession } from './pty';

export interface HandoffEntry {
  id: string;
  pid: number;
  /** Position in the inherited-fd list; the successor reads fd 3 + fdIndex. */
  fdIndex: number;
  cols: number;
  rows: number;
  /** base64 replay ring. */
  ring: string;
  modes: [number, boolean][];
  title: string;
}

export interface HandoffManifest {
  v: 1;
  entries: HandoffEntry[];
}

const ENV_KEY = 'PALMUX_HANDOFF';
/** Inherited fds start after stdin/stdout/stderr. */
const FD_BASE = 3;

/**
 * Why a live handoff must NOT run in this process, or null when it is safe.
 *
 * Under systemd the successor is spawned INSIDE the unit's cgroup, and the
 * default Type=simple + KillMode=control-group means the instant we exit
 * systemd tears that cgroup down — killing the successor and every shell we
 * just handed it, then cold-starting a replacement. That is strictly WORSE than
 * not handing off, so we refuse and leave the running server untouched.
 * (Making it work there needs Type=notify + NotifyAccess=all and a MAINPID
 * reassignment before exit — a service-unit change, deliberately not done here.)
 */
export function handoffBlockedReason(env: NodeJS.ProcessEnv = process.env): string | null {
  // systemd sets INVOCATION_ID for every unit it starts; nothing else does.
  if (env['INVOCATION_ID']) {
    return "running under systemd — the successor would be killed with this unit's cgroup";
  }
  return null;
}

/** Collect the manifest + the master fds to pass to a successor. */
export function buildHandoff(sessions: Iterable<{ id: string; session: PtySession }>): {
  manifest: HandoffManifest;
  fds: number[];
} {
  const entries: HandoffEntry[] = [];
  const fds: number[] = [];
  for (const { id, session } of sessions) {
    if (!session.alive) continue;
    try {
      const s = session.exportState();
      entries.push({
        id,
        pid: s.pid,
        fdIndex: fds.length,
        cols: s.cols,
        rows: s.rows,
        ring: s.ring,
        modes: s.modes,
        title: s.title,
      });
      fds.push(s.fd);
    } catch {
      // A session we can't export just isn't handed over — it cold-respawns.
    }
  }
  return { manifest: { v: 1, entries }, fds };
}

/**
 * Relaunch this server detached, inheriting the PTY master fds at 3,4,5… The
 * caller must exit afterwards WITHOUT killing the shells.
 */
export function spawnSuccessor(manifest: HandoffManifest, fds: number[]): void {
  const stdio: ('ignore' | 'inherit' | number)[] = ['ignore', 'inherit', 'inherit', ...fds];
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    detached: true,
    stdio,
    env: { ...process.env, [ENV_KEY]: JSON.stringify(manifest) },
  });
  child.unref();
}

/** Read (and consume) the handoff manifest this process was started with. */
export function readHandoff(): HandoffManifest | null {
  const raw = process.env[ENV_KEY];
  if (!raw) return null;
  // Consume it so the value never leaks into spawned child shells.
  delete process.env[ENV_KEY];
  try {
    const parsed = JSON.parse(raw) as HandoffManifest;
    if (parsed && parsed.v === 1 && Array.isArray(parsed.entries)) return parsed;
  } catch {
    /* malformed → cold start */
  }
  return null;
}

/**
 * Rebuild live sessions from a manifest by adopting the inherited fds. Entries
 * that fail to adopt are skipped so the tab cold-respawns instead (safe degrade).
 */
export function adoptSessions(
  manifest: HandoffManifest,
  scrollbackBytes: number,
): Map<string, PtySession> {
  const out = new Map<string, PtySession>();
  for (const e of manifest.entries) {
    try {
      out.set(
        e.id,
        new PtySession({
          adoptFd: FD_BASE + e.fdIndex,
          adoptPid: e.pid,
          cols: e.cols,
          rows: e.rows,
          scrollbackBytes,
          ring: Buffer.from(e.ring, 'base64'),
          modes: e.modes,
          title: e.title,
        }),
      );
    } catch {
      console.error(`palmux: handoff adopt failed for tab ${e.id} — it will respawn instead`);
    }
  }
  return out;
}
