// ── Source Control: the only writes ───────────────────────────────────────────
//
// Stage one file, unstage one file, stage or unstage a list of paths, undo one of
// those. Each is one index transaction under git's own lock protocol, and each
// changes only the index entries of the paths it names: never the work tree,
// never a commit.
//
// The protocol is git's: create `index.lock` with O_CREAT|O_EXCL (if it exists
// the answer is `409 busy` at once; nothing waits, retries or deletes a lock),
// copy the index to a private temp file, read the affected entries from that
// copy, change it with `update-index` (or, for a list, git's own `add` and
// `restore`), then write the copy into the lock file,
// fsync, and rename it over the index, which is git's own commit step. Any
// failure removes the lock and leaves the index as it was.

import { constants, unlinkSync, type Stats } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  SCM_BATCH_LIMIT,
  type ScmBatchResult,
  type ScmSkip,
  type ScmSkipReason,
  type ScmWriteResult,
} from '@palmux/shared';
import {
  GIT_BATCH_TIMEOUT_MS,
  checkRelPath,
  convertedPaths,
  gitFailure,
  gitVersion,
  parseLsFiles,
  parseLsTree,
  readHead,
  readHeadEntry,
  runGit,
  scmFail,
  supportsPathspecFromFile,
  type GitResult,
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
import { getStatus, invalidateStatus } from './scm-status';

export type WriteResult = { ok: true; result: ScmWriteResult } | ScmFailure;

/** `lockMs` is how long `index.lock` was held, for the route's audit line. */
export type BatchWrite = { ok: true; result: ScmBatchResult; lockMs: number } | ScmFailure;

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
  /** The paths `change` reported touching. */
  touched: string[];
  /** From creating `index.lock` to renaming it over the index. */
  lockMs: number;
}

/** Above this many paths a read lists the whole index once instead of naming every path in argv. */
const PATHSPEC_ARGV_MAX = 64;
/** The output cap of a batch read: a whole index listing, or attributes for 5,000 paths. */
export const BATCH_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Leads every git command here that writes an index. Writing even the private
 * copy runs the repository's `post-index-change` hook (`GIT_INDEX_FILE` does not
 * stop it), and `restore` runs `post-checkout` too: a hook can change the work
 * tree, and a palmux write runs none.
 */
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

const queues = new Map<string, Promise<unknown>>();

/** Writes to one repository queue behind each other; the lock file is what guards against other programs. */
export function serialised<T>(top: string, task: () => Promise<T>): Promise<T> {
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

export function isFailure(value: unknown): value is ScmFailure {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;
}

/**
 * Whether `path` is one of `wanted` or lies under one. A pathspec names a
 * directory's contents too, so a batch that names `foo` can change `foo/x`, and
 * the receipt has to see it to undo it.
 */
function covered(path: string, wanted: ReadonlySet<string>): boolean {
  if (wanted.has(path)) return true;
  for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) {
    if (wanted.has(path.slice(0, at))) return true;
  }
  return false;
}

/**
 * The entries at or under `paths`, sorted by stage, from `indexFile` (a transaction's
 * private copy) or, with none, from the repository's own index without a lock.
 */
export async function readEntries(
  top: string,
  paths: readonly string[],
  opts: { indexFile?: string; timeoutMs?: number } = {},
): Promise<Entries | ScmFailure> {
  // Thousands of paths in argv cost more than one listing of the whole index.
  const whole = paths.length > PATHSPEC_ARGV_MAX;
  const run = await runGit(top, whole ? ['ls-files', '-s', '-z'] : ['ls-files', '-s', '-z', '--', ...paths], {
    ...(opts.indexFile !== undefined ? { env: { GIT_INDEX_FILE: opts.indexFile } } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(whole ? { maxBuffer: BATCH_MAX_BUFFER } : {}),
  });
  if (!run.ok) return gitFailure(run, 'ls-files');
  const wanted = new Set(paths);
  const entries: Entries = new Map();
  for (const entry of parseLsFiles(run.stdout)) {
    if (!covered(entry.path, wanted)) continue;
    entries.set(entry.path, [...(entries.get(entry.path) ?? []), entry].toSorted((a, b) => a.stage - b.stage));
  }
  return entries;
}

/** The blobs and gitlinks HEAD holds at or under `paths`; empty for an unborn HEAD. */
async function readHeadPaths(
  top: string,
  headOid: string | null,
  paths: readonly string[],
): Promise<Set<string> | ScmFailure> {
  if (headOid === null || paths.length === 0) return new Set();
  const whole = paths.length > PATHSPEC_ARGV_MAX;
  const args = whole ? ['ls-tree', '-r', '-z', 'HEAD'] : ['ls-tree', '-r', '-z', 'HEAD', '--', ...paths];
  const run = await runGit(top, args, whole ? { maxBuffer: BATCH_MAX_BUFFER } : {});
  if (!run.ok) return gitFailure(run, 'ls-tree');
  const wanted = new Set(paths);
  return new Set(parseLsTree(run.stdout).map((e) => e.path).filter((path) => covered(path, wanted)));
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
    ? [...NO_HOOKS, 'update-index', '--add', '--cacheinfo', `${op.entry.mode},${op.entry.oid},${op.path}`]
    : [...NO_HOOKS, 'update-index', '--force-remove', '--', op.path];
  const run = await runGit(top, args, { env: { GIT_INDEX_FILE: indexFile } });
  if (run.ok) return null;
  return run.reason === 'exit' ? describeUpdateIndexFailure(run.stderr) : gitFailure(run, 'update-index');
}

/** The all-zero oid in the receipt's object format: 40 digits for SHA-1, 64 for SHA-256. */
function zeroOidOf(entries: readonly ReceiptEntry[]): string {
  const oid = entries.flatMap((e) => [...e.before, ...e.after])[0]?.oid ?? '';
  return '0'.repeat(oid.length || 40);
}

/**
 * Many operations in one `update-index -z --index-info`, so an Undo of a folder is
 * one process under the lock rather than one per path. A removal is mode 0 with
 * the zero oid. Removals go first, so a path that was a file and is a directory
 * again (or the reverse) is never added while the other shape still holds it.
 */
async function applyIndexInfo(
  top: string,
  indexFile: string,
  ops: readonly Op[],
  zeroOid: string,
): Promise<ScmFailure | null> {
  const ordered = [...ops.filter((op) => op.entry === null), ...ops.filter((op) => op.entry !== null)];
  const input = ordered
    .map((op) => (op.entry ? `${op.entry.mode} ${op.entry.oid}\t${op.path}\0` : `0 ${zeroOid}\t${op.path}\0`))
    .join('');
  const run = await runGit(top, [...NO_HOOKS, 'update-index', '-z', '--index-info'], {
    env: { GIT_INDEX_FILE: indexFile },
    input,
    timeoutMs: GIT_BATCH_TIMEOUT_MS,
  });
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
 * `change` edit the copy (or refuse) and report the paths it touched, reads the
 * entries again, and commits the copy. `top` has passed `checkRepo`. A change that
 * touched nothing releases the lock without rewriting the index.
 */
function transact(
  top: string,
  paths: readonly string[],
  change: (before: Entries, copy: string) => Promise<string[] | ScmFailure>,
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
    const lockedAt = performance.now();
    liveLocks.add(lockFile);
    let scratch: string | undefined;
    let closed = false;
    let committed = false;
    let unchanged: Committed | null = null;
    try {
      scratch = await mkdtemp(join(tmpdir(), 'palmux-scm-index-'));
      await indexHooks.afterLock?.();

      let original: Buffer | null = null;
      let originalStat: Stats | null = null;
      try {
        originalStat = await stat(indexFile);
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
      // git reads an entry's content instead of trusting its stat only while the entry is
      // "racy", no older than the index file. A fresh copy would be newer than every entry,
      // so a same-size edit made in the second of the last index write would look clean and
      // not be staged. The copy takes the index's own times (Node keeps milliseconds, which
      // only ever makes it older, so more entries are read, never fewer).
      if (originalStat !== null) await utimes(copy, originalStat.atime, originalStat.mtime);

      const before = await readEntries(top, paths, { indexFile: copy });
      if (isFailure(before)) return before;
      const touched = await change(before, copy);
      if (isFailure(touched)) return touched;
      if (touched.length === 0) {
        // Nothing to commit: the finally below releases the lock, then the time is taken.
        unchanged = { before, after: before, touched, lockMs: 0 };
        return unchanged;
      }
      const after = await readEntries(top, paths, { indexFile: copy });
      if (isFailure(after)) return after;

      await lock.write(await readFile(copy));
      await lock.sync();
      await lock.close();
      closed = true;
      await rename(lockFile, indexFile);
      committed = true;
      liveLocks.delete(lockFile);
      return { before, after, touched, lockMs: performance.now() - lockedAt };
    } catch (e) {
      return scmFail(500, `index write failed: ${String((e as NodeJS.ErrnoException).code ?? e)}`);
    } finally {
      if (!committed) {
        // Best effort: the failure being returned is the one that matters.
        if (!closed) await lock.close().catch(() => {});
        await unlink(lockFile).catch(() => {});
        liveLocks.delete(lockFile);
        if (unchanged) unchanged.lockMs = performance.now() - lockedAt;
      }
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  });
}

/** The single-file writes as a `change`: each operation through `update-index`. */
function applyOps(
  top: string,
  decide: (before: Entries) => Promise<Op[] | ScmFailure>,
): (before: Entries, copy: string) => Promise<string[] | ScmFailure> {
  return async (before, copy) => {
    const ops = await decide(before);
    if (isFailure(ops)) return ops;
    for (const op of ops) {
      const failed = await applyOp(top, copy, op);
      if (failed) return failed;
    }
    return [...new Set(ops.map((op) => op.path))];
  };
}

async function write(
  top: string,
  paths: readonly string[],
  status: ScmWriteResult['status'],
  change: (before: Entries, copy: string) => Promise<string[] | ScmFailure>,
): Promise<WriteResult> {
  const done = await transact(top, paths, change);
  if (isFailure(done)) return done;
  invalidateStatus(top);
  const entries: ReceiptEntry[] = done.touched.map((path) => ({
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

  return write(top, [path], 'staged', applyOps(top, async (before) => {
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
  }));
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

  return write(top, from === undefined ? [path] : [path, from], 'unstaged', applyOps(top, async (before) => {
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
  }));
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

  const restoring = (current: Entries): Op[] | ScmFailure => {
    for (const entry of receipt.entries) {
      if (!sameEntries(current.get(entry.path) ?? [], entry.after)) {
        return scmFail(409, 'The index changed since; nothing was undone.', 'conflict');
      }
    }
    return receipt.entries.map((entry): Op => {
      const staged = entry.before.find((e) => e.stage === 0);
      return { path: entry.path, entry: staged ? { mode: staged.mode, oid: staged.oid } : null };
    });
  };
  const paths = receipt.entries.map((e) => e.path);
  const change =
    receipt.entries.length > 1
      ? async (current: Entries, copy: string): Promise<string[] | ScmFailure> => {
          const ops = restoring(current);
          if (isFailure(ops)) return ops;
          const failed = await applyIndexInfo(top, copy, ops, zeroOidOf(receipt.entries));
          return failed ?? paths;
        }
      : applyOps(top, async (current) => restoring(current));
  const result = await write(top, paths, 'restored', change);
  if (result.ok) deleteReceipt(req.receiptId);
  return result;
}

// ── Batch stage and unstage ───────────────────────────────────────────────────
//
// The list's Stage and Unstage take the files as they are now, through git's own
// `add` and `restore --staged` run on the private copy, so line endings and modes
// come out exactly as in a terminal. Paths the list could not have meant (a
// conflict, a submodule, a file with a filter driver, one no longer changed) are
// skipped with a reason, because one path git refuses fails the whole command.

interface BatchRequest {
  /** The paths to write, validated and deduplicated, in request order. */
  paths: string[];
  /** The rename source each path names, if any. */
  oldPaths: Map<string, string>;
  skipped: ScmSkip[];
}

function validateBatch(items: unknown, what: 'paths' | 'entries'): BatchRequest | ScmFailure {
  if (!Array.isArray(items) || items.length === 0) return scmFail(400, `${what} must be a non-empty array`);
  if (items.length > SCM_BATCH_LIMIT) {
    return scmFail(400, `at most ${SCM_BATCH_LIMIT} paths can be written at once`);
  }
  const request: BatchRequest = { paths: [], oldPaths: new Map(), skipped: [] };
  const seen = new Set<string>();
  for (const item of items) {
    let raw: unknown = item;
    let rawOld: unknown;
    if (what === 'entries') {
      if (typeof item !== 'object' || item === null) return scmFail(400, 'each entry must be an object');
      raw = (item as { path?: unknown }).path;
      rawOld = (item as { oldPath?: unknown }).oldPath;
    }
    // Status lists an untracked nested repository as one entry with a trailing
    // slash. It is validated without the slash and skipped, not refused.
    const nested = typeof raw === 'string' && raw.endsWith('/') && !raw.endsWith('//');
    const rel = checkRelPath(nested ? (raw as string).slice(0, -1) : raw);
    if (!rel.ok) return rel;
    let from: string | undefined;
    if (rawOld !== undefined && rawOld !== rel.path) {
      const checked = checkRelPath(rawOld, 'oldPath');
      if (!checked.ok) return checked;
      from = checked.path;
    }
    const key = nested ? `${rel.path}/` : rel.path;
    if (seen.has(key)) continue;
    seen.add(key);
    if (nested) {
      request.skipped.push({ path: key, reason: 'nested-repo' });
      continue;
    }
    request.paths.push(rel.path);
    if (from !== undefined) request.oldPaths.set(rel.path, from);
  }
  return request;
}

async function checkBatchVersion(): Promise<ScmFailure | null> {
  if (supportsPathspecFromFile(await gitVersion())) return null;
  return scmFail(501, 'palmux needs git 2.26 or newer to stage folders', 'unsupported');
}

const nulList = (paths: readonly string[]): string => paths.map((p) => `${p}\0`).join('');
const FROM_STDIN = ['--pathspec-from-file=-', '--pathspec-file-nul'];

function batchCommandFailure(run: Extract<GitResult, { ok: false }>, what: string): ScmFailure {
  if (run.reason !== 'exit') return gitFailure(run, what);
  const message = run.stderr.trim().split('\n').join(' ');
  return scmFail(500, `git ${what} failed: ${message === '' ? `exit ${String(run.code)}` : message}`);
}

/** What a committed batch answers: `done` is the requested paths whose entries changed. */
function batchAnswer(
  top: string,
  status: ScmBatchResult['status'],
  requested: readonly string[],
  skipped: ScmSkip[],
  done: Committed,
): BatchWrite {
  invalidateStatus(top);
  const changed: ReceiptEntry[] = [];
  for (const path of new Set([...done.before.keys(), ...done.after.keys()])) {
    const before = done.before.get(path) ?? [];
    const after = done.after.get(path) ?? [];
    if (!sameEntries(before, after)) changed.push({ path, before, after });
  }
  const differs = new Set(changed.map((e) => e.path));
  return {
    ok: true,
    lockMs: done.lockMs,
    result: {
      receiptId: changed.length === 0 ? null : putReceipt({ top, entries: changed }),
      status,
      done: requested.filter((path) => differs.has(path)),
      skipped,
    },
  };
}

interface Listed {
  merge: Set<string>;
  /** Each listed path, with the rename source it names. */
  staged: Map<string, string | undefined>;
  changes: Map<string, string | undefined>;
  truncated: boolean;
}

/** A fresh status read, so a batch can tell a listed path from one that left. */
async function listedGroups(top: string): Promise<Listed | ScmFailure> {
  invalidateStatus(top);
  const read = await getStatus(top);
  if (!read.ok) return read;
  const { status } = read;
  return {
    merge: new Set(status.merge.map((e) => e.path)),
    staged: new Map(status.staged.map((e) => [e.path, e.oldPath])),
    changes: new Map(status.changes.map((e) => [e.path, e.oldPath])),
    truncated: status.truncated,
  };
}

/**
 * Stages each path as it is on disk now, through one `git add` on the private
 * copy, and each deletion through one `update-index --force-remove`.
 * `--literal-pathspecs` (on every git call) keeps `a*.ts` a name, and the paths
 * ride stdin NUL-separated, so none is ever read as an option.
 */
export async function stagePaths(req: { top: string; paths: unknown }): Promise<BatchWrite> {
  const request = validateBatch(req.paths, 'paths');
  if (isFailure(request)) return request;
  const unsupported = await checkBatchVersion();
  if (unsupported) return unsupported;
  const { top } = req;
  const skipped = [...request.skipped];
  const skip = (path: string, reason: ScmSkipReason): void => {
    skipped.push({ path, reason });
  };

  const listed = await listedGroups(top);
  if (isFailure(listed)) return listed;
  const candidates: string[] = [];
  for (const path of request.paths) {
    if (listed.merge.has(path)) skip(path, 'unmerged');
    // A list cut at the status limit says nothing about the paths past it.
    else if (!listed.changes.has(path) && !listed.truncated) skip(path, 'gone');
    else candidates.push(path);
  }

  const sources = new Map<string, string>();
  for (const path of candidates) {
    const from = request.oldPaths.get(path) ?? listed.changes.get(path);
    if (from !== undefined && from !== path) sources.set(path, from);
  }
  const pathspec = [...new Set([...candidates, ...sources.values()])];
  if (pathspec.length === 0) {
    return { ok: true, lockMs: 0, result: { receiptId: null, status: 'staged', done: [], skipped } };
  }

  const done = await transact(top, pathspec, async (before, copy) => {
    // A pathspec names everything under a folder, so `git add` only ever gets a
    // path that is a file or a link on disk: given `foo` where a tracked file
    // became the folder `foo/`, it would also stage `foo/bar`, a file the request
    // never named and no filter check ever saw. A path the index holds as a file
    // and the disk holds as nothing or as a folder is the deletion it shows as,
    // removed through `update-index`, which touches that one entry. A path that
    // matches nothing in either place left since the list was read.
    const disk = await diskKinds(top, pathspec);
    // Attributes are read here, under the lock and just before `git add`, which
    // reads them again as it runs: a `.gitattributes` written after the status
    // was read must not let it run a clean filter. `check-attr` falls back to the
    // real index, which the lock keeps equal to the copy until the removals below.
    const converted = await convertedPaths(top, pathspec);
    if (!converted.ok) return converted;
    const route = (path: string): 'add' | 'remove' | 'gone' | 'special' => {
      const kind = disk.get(path) ?? 'absent';
      if (kind === 'file') return 'add';
      if (kind === 'special') return 'special';
      if ((before.get(path) ?? []).some((e) => e.stage === 0)) return 'remove';
      return kind === 'dir' ? 'special' : 'gone';
    };
    const adds: string[] = [];
    const removals: string[] = [];
    const taken = new Set<string>();
    const take = (path: string, how: 'add' | 'remove'): void => {
      taken.add(path);
      (how === 'add' ? adds : removals).push(path);
    };
    const named: string[] = [];
    for (const path of candidates) {
      const entries = before.get(path) ?? [];
      const how = route(path);
      if (converted.paths.has(path)) skip(path, 'converted');
      else if (entries.some((e) => e.stage !== 0)) skip(path, 'unmerged');
      else if (entries.some((e) => e.mode === '160000')) skip(path, 'submodule');
      else if (how === 'gone' || how === 'special') skip(path, how);
      else {
        named.push(path);
        take(path, how);
      }
    }
    // A rename's old side is staged with it, as the removal it is.
    for (const path of named) {
      const from = sources.get(path);
      if (from === undefined || taken.has(from)) continue;
      const how = route(from);
      // An old side still on disk would go through `git add` too.
      if (how === 'add' && converted.paths.has(from)) continue;
      if (how === 'add' || how === 'remove') take(from, how);
    }
    if (adds.length === 0 && removals.length === 0) return [];
    // Removals first, so a file that became a folder is gone before anything under it is added.
    if (removals.length > 0) {
      const run = await runGit(top, [...NO_HOOKS, 'update-index', '--force-remove', '-z', '--stdin'], {
        env: { GIT_INDEX_FILE: copy },
        input: nulList(removals),
        timeoutMs: GIT_BATCH_TIMEOUT_MS,
      });
      if (!run.ok) return run.reason === 'exit' ? describeUpdateIndexFailure(run.stderr) : gitFailure(run, 'update-index');
    }
    if (adds.length > 0) {
      const run = await runGit(top, [...NO_HOOKS, 'add', ...FROM_STDIN, '--'], {
        env: { GIT_INDEX_FILE: copy },
        input: nulList(adds),
        timeoutMs: GIT_BATCH_TIMEOUT_MS,
      });
      if (!run.ok) return batchCommandFailure(run, 'add');
    }
    return [...removals, ...adds];
  });
  if (isFailure(done)) return done;
  return batchAnswer(top, 'staged', request.paths, skipped, done);
}

type DiskKind = 'file' | 'dir' | 'special' | 'absent';

/** What the work tree holds at each path, without following a final link: a link counts as a file, as git adds one. */
async function diskKinds(top: string, paths: readonly string[]): Promise<Map<string, DiskKind>> {
  const kinds = await Promise.all(
    paths.map((path) =>
      lstat(join(top, path)).then(
        (st): DiskKind => (st.isFile() || st.isSymbolicLink() ? 'file' : st.isDirectory() ? 'dir' : 'special'),
        (): DiskKind => 'absent',
      ),
    ),
  );
  return new Map(paths.map((path, i) => [path, kinds[i] ?? 'absent']));
}

/**
 * Returns each path's index entry to HEAD's, through one `git restore --staged`
 * on the private copy, or removes the entries with `git rm --cached` before the
 * first commit. A rename's old side is restored with it only where it is a real
 * rename source, as `unstageFile` decides: gone from the index, present in HEAD.
 */
export async function unstagePaths(req: { top: string; entries: unknown }): Promise<BatchWrite> {
  const request = validateBatch(req.entries, 'entries');
  if (isFailure(request)) return request;
  const unsupported = await checkBatchVersion();
  if (unsupported) return unsupported;
  const { top } = req;
  const skipped = [...request.skipped];
  const skip = (path: string, reason: ScmSkipReason): void => {
    skipped.push({ path, reason });
  };

  const listed = await listedGroups(top);
  if (isFailure(listed)) return listed;
  const candidates: string[] = [];
  for (const path of request.paths) {
    if (listed.merge.has(path)) skip(path, 'unmerged');
    else if (!listed.staged.has(path) && !listed.truncated) skip(path, 'gone');
    else candidates.push(path);
  }
  const sources = new Map<string, string>();
  for (const path of candidates) {
    const from = request.oldPaths.get(path);
    if (from !== undefined) sources.set(path, from);
  }
  const pathspec = [...new Set([...candidates, ...sources.values()])];
  if (pathspec.length === 0) {
    return { ok: true, lockMs: 0, result: { receiptId: null, status: 'unstaged', done: [], skipped } };
  }

  const done = await transact(top, pathspec, async (before, copy) => {
    const headOid = await readHead(top);
    if (!headOid.ok) return headOid;
    const head = await readHeadPaths(top, headOid.oid, pathspec);
    if (isFailure(head)) return head;
    // `restore --staged` refuses the whole list when one path is known to
    // neither the index nor HEAD, so a path that left both since is a skip. A
    // path is known when something is at it or under it.
    const known = new Set<string>();
    for (const path of [...before.keys(), ...head]) {
      known.add(path);
      for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) {
        known.add(path.slice(0, at));
      }
    }
    const named: string[] = [];
    for (const path of candidates) {
      if ((before.get(path) ?? []).some((e) => e.stage !== 0)) skip(path, 'unmerged');
      else if (!known.has(path)) skip(path, 'gone');
      else named.push(path);
    }
    const withSources = [...named];
    for (const path of named) {
      const from = sources.get(path);
      const goneFromIndex = !(before.get(from ?? '') ?? []).some((e) => e.stage === 0);
      if (from !== undefined && goneFromIndex && head.has(from)) withSources.push(from);
    }
    const unique = [...new Set(withSources)];
    if (unique.length === 0) return [];

    // Before the first commit there is no HEAD to restore from, so the entries
    // go. `-f` because git otherwise refuses an entry that differs from both the
    // work tree and HEAD, which is every edit made after `git add`; `--cached`
    // still leaves the work tree alone, and the receipt keeps the entry for Undo.
    const args =
      headOid.oid === null
        ? [...NO_HOOKS, 'rm', '--cached', '-r', '-q', '-f', '--ignore-unmatch', ...FROM_STDIN]
        : [...NO_HOOKS, 'restore', '--staged', ...FROM_STDIN];
    const run = await runGit(top, args, {
      env: { GIT_INDEX_FILE: copy },
      input: nulList(unique),
      timeoutMs: GIT_BATCH_TIMEOUT_MS,
    });
    if (!run.ok) return batchCommandFailure(run, headOid.oid === null ? 'rm' : 'restore');
    return unique;
  });
  if (isFailure(done)) return done;
  return batchAnswer(top, 'unstaged', request.paths, skipped, done);
}
