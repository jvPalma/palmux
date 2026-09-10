// ── File browser backend ──────────────────────────────────────────────────────
//
// GET /files/list?dir=<absolute path> enumerates ONE directory for the dock's
// file tree. Read-only: there is no write counterpart on this route.
//
// Unlike /md-list (confined to cfg.markdownRoots, because a docs browser is a
// deliberately scoped surface) this follows the /download trust model: absolute
// paths anywhere are BY DESIGN, since the PTY behind the same cookie already
// reads whatever this process can. The cookie gate (plus the IP/origin rules)
// is the boundary.
//
// Every failure is an explicit status, never an empty listing: a blank pane is
// indistinguishable from a broken feature.

import { lstat, readdir, rm, stat } from 'node:fs/promises';
import type { DeleteResult } from '@palmux/shared';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface FileEntry {
  name: string;
  /** A directory, or a symlink that resolves to one (so the tree can expand it). */
  dir: boolean;
  size: number;
  /** Modification time in epoch milliseconds. */
  mtime: number;
  symlink: boolean;
}

export interface DirListing {
  /** The listed directory, absolute and normalized. */
  path: string;
  /** Its parent, or null at the filesystem root. */
  parent: string | null;
  entries: FileEntry[];
}

export type ListDirResult =
  | { ok: true; listing: DirListing }
  | { ok: false; status: 400 | 403 | 404; message: string };

const errnoOf = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'code' in e
    ? String((e as { code: unknown }).code)
    : undefined;

const denied = (e: unknown): boolean => {
  const code = errnoOf(e);
  return code === 'EACCES' || code === 'EPERM';
};

/**
 * Describe one entry. `lstat` is the only stat that cannot throw on a broken
 * symlink, so it owns size/mtime/symlink; a symlink additionally gets a GUARDED
 * `stat` purely to answer "is it a folder", falling back to false when the link
 * dangles. Returns null for an entry we may not stat — one root-owned file must
 * not make the whole directory unlistable.
 */
async function describe(dir: string, name: string): Promise<FileEntry | null> {
  let s;
  try {
    s = await lstat(join(dir, name));
  } catch {
    return null;
  }
  const symlink = s.isSymbolicLink();
  let isDir = s.isDirectory();
  if (symlink) {
    try {
      isDir = (await stat(join(dir, name))).isDirectory();
    } catch {
      /* dangling or unreadable target — a plain entry, not a folder */
    }
  }
  return { name, dir: isDir, size: s.size, mtime: s.mtimeMs, symlink };
}

/** Directories first, then case-insensitive but PUNCTUATION-SIGNIFICANT.
 *  `localeCompare` at base sensitivity treats `_` and `-` as ignorable, which
 *  scatters names that belong together (see tmux.ts for the same reasoning). */
function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.dir !== b.dir) return a.dir ? -1 : 1;
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** List an absolute directory for the file browser. */
export async function listDir(dir: string | undefined): Promise<ListDirResult> {
  // An ABSENT dir means the user's home. Requiring one forced the file tree to
  // open at '/', which meant walking down four levels on every open — and the
  // client cannot guess a home directory, only the server knows it. An EMPTY
  // string is still an error: that is a caller passing a broken value, not a
  // caller declining to pass one.
  const p = (dir === undefined ? homedir() : dir).trim();
  if (!p) return { ok: false, status: 400, message: 'dir is required' };
  if (!isAbsolute(p)) return { ok: false, status: 400, message: 'dir must be absolute' };
  const target = resolve(p);

  let s;
  try {
    s = await stat(target);
  } catch (e) {
    if (denied(e)) return { ok: false, status: 403, message: 'not readable' };
    return { ok: false, status: 404, message: 'not found' };
  }
  if (!s.isDirectory()) return { ok: false, status: 400, message: 'not a directory' };

  let names;
  try {
    names = await readdir(target);
  } catch (e) {
    if (denied(e)) return { ok: false, status: 403, message: 'not readable' };
    return { ok: false, status: 404, message: 'not found' };
  }

  const described = await Promise.all(names.map((name) => describe(target, name)));
  const entries = described.filter((e): e is FileEntry => e !== null).sort(compareEntries);
  const parent = dirname(target);
  return {
    ok: true,
    listing: { path: target, parent: parent === target ? null : parent, entries },
  };
}

// ── Deleting ──────────────────────────────────────────────────────────────────
//
// Same trust model as the rest of this file: the cookie is the boundary, and the
// PTY behind it can already `rm` anything this process can. What the refusals
// below stop is not an attacker — it is a MISTAKE, and specifically the class of
// mistake that a two-click context menu makes easy and a shell does not.
//
// Deletion is the one operation here with no undo, so it is worth being explicit
// about what this deliberately does NOT do: there is no trash. A delete is a
// delete. The client asks for confirmation naming what will go; this end refuses
// the handful of targets whose loss would be catastrophic regardless of intent.

/** Paths that are never deletable, however the request is spelled. */
function undeletable(path: string): string | null {
  const home = homedir();
  if (path === '/') return 'refusing to delete the filesystem root';
  if (path === home) return 'refusing to delete the home directory';
  // Two segments is `/etc`, `/usr`, `/home` — a top-level directory. Nothing a
  // file browser should be able to remove by accident.
  const depth = path.split('/').filter(Boolean).length;
  if (depth <= 1) return `refusing to delete a top-level directory (${path})`;
  return null;
}

/** Re-exported from the wire protocol so both ends share one shape. */
export type DeleteOutcome = DeleteResult;

/**
 * Remove one absolute path. A directory goes recursively, which is why the
 * count of what it contained is reported back — a caller that deleted more than
 * it meant to should at least be able to see so.
 *
 * Symlinks are removed as LINKS, never followed: deleting a symlink to a
 * directory must not empty the directory it points at.
 */
export async function deletePath(path: unknown): Promise<DeleteOutcome> {
  if (typeof path !== 'string' || !path.trim()) {
    return { path: String(path ?? ''), ok: false, message: 'path is required' };
  }
  const p = resolve(path.trim());
  if (!isAbsolute(p)) return { path: p, ok: false, message: 'path must be absolute' };
  const refusal = undeletable(p);
  if (refusal) return { path: p, ok: false, message: refusal };

  let info;
  try {
    info = await lstat(p);
  } catch {
    return { path: p, ok: false, message: 'no such file or directory' };
  }

  try {
    // lstat, so a symlink is a symlink even when it points at a directory.
    if (info.isDirectory()) {
      const entries = await readdir(p).catch(() => []);
      await rm(p, { recursive: true, force: false });
      return { path: p, ok: true, kind: 'directory', entries: entries.length };
    }
    await rm(p, { force: false });
    return { path: p, ok: true, kind: 'file' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { path: p, ok: false, message };
  }
}

/**
 * Remove several paths, reporting each independently.
 *
 * Independently is the point: one unwritable file must not abandon the rest
 * half-done, and the caller needs to know exactly which survived. The list is
 * capped because this arrives from a browser and a bulk selection has no natural
 * ceiling.
 */
export const MAX_DELETE_PATHS = 200;

export async function deletePaths(paths: unknown): Promise<DeleteOutcome[] | { error: string }> {
  if (!Array.isArray(paths) || paths.length === 0) return { error: 'paths must be a non-empty array' };
  if (paths.length > MAX_DELETE_PATHS) {
    return { error: `too many paths (max ${MAX_DELETE_PATHS})` };
  }
  // Sequential, not Promise.all: deleting a directory and something inside it in
  // the same batch is a race, and the second one should report "no such file"
  // rather than fight the first.
  const out: DeleteOutcome[] = [];
  for (const p of paths) out.push(await deletePath(p));
  return out;
}
