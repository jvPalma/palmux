// ── Source Control: the only writes ───────────────────────────────────────────
//
// Stage one file, unstage one file, undo one of those. Each is one index
// transaction under git's own lock protocol, and each changes only the index
// entries of the paths it names: never the work tree, never a commit.
//
// The protocol is git's: create `index.lock` with O_CREAT|O_EXCL (if it exists
// the answer is `409 busy` at once; nothing waits, retries or deletes a lock),
// copy the index to a private temp file, read the affected entries from that
// copy, change it with `update-index`, then write the copy into the lock file,
// fsync, and rename it over the index, which is git's own commit step. Any
// failure removes the lock and leaves the index as it was.

import { constants, unlinkSync } from 'node:fs';
import { mkdtemp, open, readFile, rename, rm, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ScmWriteResult } from '@palmux/shared';
import {
  checkRelPath,
  gitFailure,
  parseLsFiles,
  readHeadEntry,
  runGit,
  scmFail,
  type IndexEntry,
  type ScmFailure,
} from './scm-git';
import {
  deleteReceipt,
  getReceipt,
  getToken,
  putReceipt,
  readAttrContext,
  type AttrContext,
  type ReceiptEntry,
} from './scm-snapshot';
import { invalidateStatus } from './scm-status';

export type WriteResult = { ok: true; result: ScmWriteResult } | ScmFailure;

/** Test seam: runs while the lock is held, before anything else. */
export const indexHooks: { afterLock: (() => void | Promise<void>) | null } = { afterLock: null };

// ── Locks that must not outlive the process ───────────────────────────────────

const liveLocks = new Set<string>();

/**
 * Unlinks every lock this process holds, synchronously, as git does from its own
 * signal handlers: it runs from shutdown and from `process.on('exit')`, where
 * nothing can be awaited, so a `systemctl restart` mid-write never strands an
 * `index.lock`. Returns the paths it removed.
 */
export function releaseAllLocks(): string[] {
  const released: string[] = [];
  for (const lock of liveLocks) {
    try {
      unlinkSync(lock);
      released.push(lock);
    } catch (e) {
      // Already gone is the goal; anything else cannot be reported at exit.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') continue;
    }
  }
  liveLocks.clear();
  return released;
}

// ── Split index ───────────────────────────────────────────────────────────────

/**
 * Whether the index file carries the `link` extension of a split index. The
 * extensions are a chain of `<4-byte name><size><data>` that ends exactly at the
 * trailing checksum, so a `link` is accepted only where the chain from it lands
 * on that checksum, which a file name containing "link" does not.
 */
export function hasSplitIndexExtension(buf: Buffer): boolean {
  if (buf.length < 12 + 20 || buf.toString('latin1', 0, 4) !== 'DIRC') return false;
  for (const hashLength of [20, 32]) {
    const end = buf.length - hashLength;
    for (let at = buf.indexOf('link'); at >= 0; at = buf.indexOf('link', at + 1)) {
      let cursor = at;
      while (cursor + 8 <= end) {
        cursor += 8 + buf.readUInt32BE(cursor + 4);
        if (cursor === end) return true;
        if (cursor > end || !/^[A-Za-z]{4}$/.test(buf.toString('latin1', cursor, cursor + 4))) break;
      }
    }
  }
  return false;
}

// ── One index transaction ─────────────────────────────────────────────────────

interface Op {
  path: string;
  /** The entry to write; null removes the path from the index. */
  entry: { mode: string; oid: string } | null;
}

type Entries = Map<string, IndexEntry[]>;

interface Committed {
  before: Entries;
  after: Entries;
}

const queues = new Map<string, Promise<unknown>>();

/** Writes to one repository queue behind each other; the lock file is what guards against other programs. */
function serialised<T>(top: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(top) ?? Promise.resolve()).then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(top, tail);
  void tail.then(() => {
    if (queues.get(top) === tail) queues.delete(top);
  });
  return run;
}

function isFailure(value: unknown): value is ScmFailure {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;
}

async function readEntries(
  top: string,
  paths: readonly string[],
  indexFile: string,
): Promise<Entries | ScmFailure> {
  const run = await runGit(top, ['ls-files', '-s', '-z', '--', ...paths], {
    env: { GIT_INDEX_FILE: indexFile },
  });
  if (!run.ok) return gitFailure(run, 'ls-files');
  const entries: Entries = new Map();
  for (const entry of parseLsFiles(run.stdout)) {
    if (!paths.includes(entry.path)) continue;
    entries.set(entry.path, [...(entries.get(entry.path) ?? []), entry].toSorted((a, b) => a.stage - b.stage));
  }
  return entries;
}

function describeUpdateIndexFailure(stderr: string): ScmFailure {
  const message = stderr.trim().split('\n').join(' ');
  if (/both a file and as a directory|cannot add|directory\/file/i.test(message)) {
    return scmFail(409, `A file and a directory collide in the index: ${message}`, 'df');
  }
  return scmFail(500, `update-index failed: ${message}`);
}

async function applyOp(top: string, indexFile: string, op: Op): Promise<ScmFailure | null> {
  const args = op.entry
    ? ['update-index', '--add', '--cacheinfo', `${op.entry.mode},${op.entry.oid},${op.path}`]
    : ['update-index', '--force-remove', '--', op.path];
  const run = await runGit(top, args, { env: { GIT_INDEX_FILE: indexFile } });
  if (run.ok) return null;
  return run.reason === 'exit' ? describeUpdateIndexFailure(run.stderr) : gitFailure(run, 'update-index');
}

async function splitIndexConfigured(top: string): Promise<boolean | ScmFailure> {
  const run = await runGit(top, ['config', '-z', '--get', 'core.splitindex'], { okCodes: [0, 1] });
  if (!run.ok) return gitFailure(run, 'config');
  return /^(true|yes|on|1)$/i.test(run.stdout.toString('utf8').split('\0')[0] ?? '');
}

/**
 * Takes the lock, reads the entries of `paths` from the private copy, lets
 * `decide` turn them into operations (or refuse), applies those to the copy, and
 * commits the copy. `top` has passed `checkRepo`.
 */
function transact(
  top: string,
  paths: readonly string[],
  decide: (before: Entries) => Promise<Op[] | ScmFailure>,
): Promise<Committed | ScmFailure> {
  return serialised(top, async (): Promise<Committed | ScmFailure> => {
    const where = await runGit(top, ['rev-parse', '--git-path', 'index']);
    if (!where.ok) return gitFailure(where, 'index');
    const indexFile = resolve(top, where.stdout.toString('utf8').replace(/\n$/, ''));
    const lockFile = `${indexFile}.lock`;

    let lock: FileHandle;
    try {
      lock = await open(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o666);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === 'EEXIST'
        ? scmFail(409, 'The repository is busy (index.lock exists). Try again.', 'busy')
        : scmFail(500, `cannot create index.lock: ${String(code ?? e)}`);
    }
    liveLocks.add(lockFile);
    let scratch: string | undefined;
    let closed = false;
    let committed = false;
    try {
      scratch = await mkdtemp(join(tmpdir(), 'palmux-scm-index-'));
      await indexHooks.afterLock?.();

      let original: Buffer | null = null;
      try {
        original = await readFile(indexFile);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      const configured = await splitIndexConfigured(top);
      if (isFailure(configured)) return configured;
      if (configured || (original !== null && hasSplitIndexExtension(original))) {
        return scmFail(
          501,
          'This repository uses a split index, which palmux does not write. Stage with git instead.',
          'unsupported',
        );
      }

      const copy = join(scratch, 'index');
      if (original !== null) await writeFile(copy, original);

      const before = await readEntries(top, paths, copy);
      if (isFailure(before)) return before;
      const ops = await decide(before);
      if (isFailure(ops)) return ops;
      for (const op of ops) {
        const failed = await applyOp(top, copy, op);
        if (failed) return failed;
      }
      const after = await readEntries(top, paths, copy);
      if (isFailure(after)) return after;

      await lock.write(await readFile(copy));
      await lock.sync();
      await lock.close();
      closed = true;
      await rename(lockFile, indexFile);
      committed = true;
      liveLocks.delete(lockFile);
      return { before, after };
    } catch (e) {
      return scmFail(500, `index write failed: ${String((e as NodeJS.ErrnoException).code ?? e)}`);
    } finally {
      if (!committed) {
        // Best effort: the failure being returned is the one that matters.
        if (!closed) await lock.close().catch(() => {});
        await unlink(lockFile).catch(() => {});
        liveLocks.delete(lockFile);
      }
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  });
}

async function write(
  top: string,
  paths: readonly string[],
  status: ScmWriteResult['status'],
  decide: (before: Entries) => Promise<Op[] | ScmFailure>,
): Promise<WriteResult> {
  let touched: string[] = [];
  const done = await transact(top, paths, async (before) => {
    const ops = await decide(before);
    if (!isFailure(ops)) touched = [...new Set(ops.map((op) => op.path))];
    return ops;
  });
  if (isFailure(done)) return done;
  invalidateStatus(top);
  const entries: ReceiptEntry[] = touched.map((path) => ({
    path,
    before: done.before.get(path) ?? [],
    after: done.after.get(path) ?? [],
  }));
  return { ok: true, result: { receiptId: putReceipt({ top, entries }), status } };
}

function hasConflict(entries: readonly IndexEntry[] | undefined): boolean {
  return (entries ?? []).some((e) => e.stage !== 0);
}

const CONFLICT = 'This file has merge conflicts. Resolve them in your editor.';

function sameContext(a: Readonly<AttrContext>, b: Readonly<AttrContext>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

function sameEntries(a: readonly IndexEntry[], b: readonly IndexEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every((entry, i) => {
      const other = b[i];
      return other && entry.stage === other.stage && entry.mode === other.mode && entry.oid === other.oid;
    })
  );
}

// ── The three writes ──────────────────────────────────────────────────────────

/**
 * Stages exactly what a snapshot showed. The bytes come from the server-side
 * record the snapshot's `token` names, never from the work tree as it is now.
 */
export async function stageFile(req: {
  top: string;
  path: string;
  token: string;
}): Promise<WriteResult> {
  const rel = checkRelPath(req.path);
  if (!rel.ok) return rel;
  if (typeof req.token !== 'string' || req.token === '') return scmFail(400, 'token is required');
  const record = getToken(req.token);
  if (!record) {
    return scmFail(410, 'This version of the file is no longer held. Reload it and try again.', 'token');
  }
  if (record.top !== req.top || record.path !== rel.path) {
    return scmFail(400, 'token does not belong to this file');
  }
  const { top } = req;
  const path = rel.path;

  return write(top, [path], 'staged', async (before) => {
    if (hasConflict(before.get(path))) return scmFail(409, CONFLICT);
    const now = await readAttrContext(top, path);
    if (!now.ok) return now;
    if (!sameContext(now.context, record.context)) {
      return scmFail(
        409,
        'The attribute settings for this file changed since you looked. Reload it.',
        'changed',
      );
    }
    if (record.mode === null) return [{ path, entry: null }];
    const hashed = await runGit(top, ['hash-object', '-w', '--no-filters', '--stdin'], {
      input: record.bytes,
    });
    if (!hashed.ok) return gitFailure(hashed, 'hash-object');
    const oid = hashed.stdout.toString('utf8').trim();
    if (oid !== record.id) return scmFail(500, 'the stored bytes no longer match their object id');
    return [{ path, entry: { mode: record.mode, oid } }];
  });
}

/**
 * Returns the entry of `path` to HEAD's mode and oid, or removes it when HEAD has
 * no such path (an unborn HEAD included). A staged rename also restores
 * `oldPath`, but only where it is a real rename source: gone from the index and
 * present in HEAD.
 */
export async function unstageFile(req: {
  top: string;
  path: string;
  oldPath?: string | undefined;
}): Promise<WriteResult> {
  const rel = checkRelPath(req.path);
  if (!rel.ok) return rel;
  let from: string | undefined;
  if (req.oldPath !== undefined && req.oldPath !== req.path) {
    const checked = checkRelPath(req.oldPath, 'oldPath');
    if (!checked.ok) return checked;
    from = checked.path;
  }
  const { top } = req;
  const path = rel.path;

  return write(top, from === undefined ? [path] : [path, from], 'unstaged', async (before) => {
    if (hasConflict(before.get(path))) return scmFail(409, CONFLICT);
    const head = await readHeadEntry(top, path);
    if (!head.ok) return head;
    const ops: Op[] = [
      { path, entry: head.entry ? { mode: head.entry.mode, oid: head.entry.oid } : null },
    ];
    if (from !== undefined) {
      const goneFromIndex = !(before.get(from) ?? []).some((e) => e.stage === 0);
      const source = goneFromIndex ? await readHeadEntry(top, from) : null;
      if (source && !source.ok) return source;
      if (source?.entry) ops.push({ path: from, entry: { mode: source.entry.mode, oid: source.entry.oid } });
    }
    return ops;
  });
}

/**
 * Compare-and-swap on a receipt palmux recorded: every path's current entry must
 * still equal what that write left, and only then is the earlier entry put back.
 * The client names the receipt and nothing else, so restore can only reinstate
 * entries palmux itself recorded.
 */
export async function restoreReceipt(req: { top: string; receiptId: string }): Promise<WriteResult> {
  if (typeof req.receiptId !== 'string' || req.receiptId === '') {
    return scmFail(400, 'receiptId is required');
  }
  const receipt = getReceipt(req.receiptId);
  if (!receipt) return scmFail(410, 'Undo is no longer available.', 'token');
  if (receipt.top !== req.top) return scmFail(400, 'receipt does not belong to this repository');
  const { top } = req;

  const result = await write(top, receipt.entries.map((e) => e.path), 'restored', async (current) => {
    for (const entry of receipt.entries) {
      if (!sameEntries(current.get(entry.path) ?? [], entry.after)) {
        return scmFail(409, 'The index changed since; nothing was undone.', 'conflict');
      }
    }
    return receipt.entries.map((entry): Op => {
      const staged = entry.before.find((e) => e.stage === 0);
      return { path: entry.path, entry: staged ? { mode: staged.mode, oid: staged.oid } : null };
    });
  });
  if (result.ok) deleteReceipt(req.receiptId);
  return result;
}
