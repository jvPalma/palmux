// ── Listening TCP ports ───────────────────────────────────────────────────────
//
// GET /ports answers "what is listening on this machine, and who owns it" — the
// list the web-pane url bar wants when you type a loopback port (see
// webproxy.ts). Linux only: /proc/net/tcp{,6} is the source, and there is no
// portable equivalent, so a non-Linux host answers `available: false` rather
// than an empty list that would read as "nothing is running".
//
// PERFORMANCE IS THE DESIGN. Resolving a socket to a pid means finding which
// process holds the socket's INODE open, and /proc offers no index for that —
// only /proc/<pid>/fd/* symlinks reading `socket:[<inode>]`. Done per socket
// that is O(processes × fds) EVERY time, which on a busy box is thousands of
// readlink calls for one answer. Here it is one pass: collect every listening
// inode first, walk /proc once, stop the moment the last inode is placed. The
// whole listing is then cached for CACHE_MS, and concurrent callers share the
// in-flight scan instead of each starting their own.
//
// Only sockets owned by the server's OWN uid are reported. Anything else is
// both unactionable (you cannot proxy into another user's dev server without
// their cooperation) and unreadable (their /proc/<pid>/fd is not ours to list).

import { readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

export interface ListeningPort {
  port: number;
  /** 0 when the owner could not be resolved — the port is still taken. */
  pid: number;
  /** /proc/<pid>/comm, or '' alongside pid 0. */
  process: string;
}

export interface PortsResult {
  /** false on a host with no /proc/net/tcp; `ports` is then always empty. */
  available: boolean;
  ports: ListeningPort[];
}

/** TCP_LISTEN in the `st` column of /proc/net/tcp. */
const STATE_LISTEN = '0A';

/** Long enough that a page's burst of requests costs one scan, short enough
 *  that a dev server started five seconds ago shows up. */
export const CACHE_MS = 2000;

interface SocketRow {
  port: number;
  inode: string;
}

/**
 * Parse one /proc/net/tcp or /proc/net/tcp6 table, keeping LISTEN rows owned by
 * `uid`. Columns: sl, local_address, rem_address, st, tx:rx, tr:when, retrnsmt,
 * uid, timeout, inode. The address is `<hex addr>:<hex port>`, and the address
 * half is 8 hex digits for v4 and 32 for v6 — only the port is read, so one
 * parser serves both tables.
 */
export function parseProcNetTcp(text: string, uid: number): SocketRow[] {
  const rows: SocketRow[] = [];
  const lines = text.split('\n');
  // Line 0 is the column header.
  for (let i = 1; i < lines.length; i += 1) {
    const fields = (lines[i] ?? '').trim().split(/\s+/);
    if (fields.length < 10) continue;
    if (fields[3] !== STATE_LISTEN) continue;
    if (Number(fields[7]) !== uid) continue;
    const local = fields[1] ?? '';
    const colon = local.lastIndexOf(':');
    if (colon < 0) continue;
    const port = Number.parseInt(local.slice(colon + 1), 16);
    if (!Number.isInteger(port) || port <= 0) continue;
    rows.push({ port, inode: fields[9] ?? '' });
  }
  return rows;
}

/**
 * Map socket inode → owning pid in ONE walk of /proc. Returns early once every
 * requested inode has an owner, so the common case (a handful of listeners)
 * costs a fraction of a full scan. A forked child sharing the listening fd can
 * win the race for an inode; either pid is a truthful answer to "who holds it".
 */
export async function buildInodeOwners(
  inodes: Set<string>,
  procRoot = '/proc',
): Promise<Map<string, number>> {
  const owners = new Map<string, number>();
  if (inodes.size === 0) return owners;
  let names: string[];
  try {
    names = await readdir(procRoot);
  } catch {
    return owners;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const fdDir = join(procRoot, name, 'fd');
    let fds: string[];
    try {
      fds = await readdir(fdDir);
    } catch {
      // Another user's process, or one that exited mid-walk.
      continue;
    }
    const pid = Number(name);
    for (const fd of fds) {
      let link: string;
      try {
        link = await readlink(join(fdDir, fd));
      } catch {
        continue;
      }
      if (!link.startsWith('socket:[')) continue;
      const inode = link.slice('socket:['.length, -1);
      if (!inodes.has(inode) || owners.has(inode)) continue;
      owners.set(inode, pid);
      if (owners.size === inodes.size) return owners;
    }
  }
  return owners;
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Uncached listing. `procRoot` is a seam for tests, never set in production. */
export async function listPorts(procRoot = '/proc'): Promise<PortsResult> {
  const v4 = await readTextOrNull(join(procRoot, 'net', 'tcp'));
  if (v4 === null) return { available: false, ports: [] };
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const v6 = await readTextOrNull(join(procRoot, 'net', 'tcp6'));
  const rows = [...parseProcNetTcp(v4, uid), ...(v6 === null ? [] : parseProcNetTcp(v6, uid))];

  const owners = await buildInodeOwners(new Set(rows.map((r) => r.inode)), procRoot);
  const comms = new Map<string, string>();
  const ports = new Map<string, ListeningPort>();
  for (const row of rows) {
    const pid = owners.get(row.inode) ?? 0;
    // A dual-stack listener appears in both tables, and one process can bind
    // the same port on several addresses. Same port + same pid is one entry;
    // two processes on one port (SO_REUSEPORT) stay two.
    const key = `${row.port}:${pid}`;
    if (ports.has(key)) continue;
    let name = comms.get(key);
    if (name === undefined) {
      name = pid === 0 ? '' : ((await readTextOrNull(join(procRoot, String(pid), 'comm'))) ?? '');
      name = name.trim();
      comms.set(key, name);
    }
    ports.set(key, { port: row.port, pid, process: name });
  }

  return {
    available: true,
    ports: [...ports.values()].toSorted((a, b) => a.port - b.port || a.pid - b.pid),
  };
}

let cache: { at: number; value: PortsResult } | null = null;
let pending: Promise<PortsResult> | null = null;

/** The cached listing. Concurrent callers share one scan. */
export async function getPorts(): Promise<PortsResult> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  if (pending) return pending;
  pending = listPorts()
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** Drop the cache. Tests only — nothing in the app invalidates it by hand. */
export function clearPortsCache(): void {
  cache = null;
  pending = null;
}

/** GET /ports → `{ available, ports }`, ports sorted ascending. */
export function registerPortsRoutes(app: FastifyInstance): void {
  app.get('/ports', async () => getPorts());
}
