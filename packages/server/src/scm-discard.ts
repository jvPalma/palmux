// ── Source Control: discarding work tree changes, and their Undo ──────────────
//
// palmux's only write to the work tree. A discard brings each confirmed file
// back to its INDEX version (a tracked file) or deletes it (an untracked one),
// and never touches the index: it takes no `index.lock`, and no git command it
// runs writes one. It runs under `serialised(top)`, so it never interleaves with
// palmux's own index writes.
//
// The rule that shapes everything here is that a discard never loses bytes it
// did not back up first, and never replaces a file that changed since the user
// confirmed. Every file is hashed into the repository's object store
// (`hash-object -w`) before anything is written. Each write is a temp file beside
// the name, swapped in only after a last look shows the name still holds what was
// backed up, and Undo swaps the backups back under the same rule. Every path is
// reached through the descriptor walk of `scm-snapshot.ts`, and every write goes
// through a folder that walk holds open, so a folder swapped for a link can make
// a write fail and can never redirect one. That is why git writes no file here:
// `checkout-index` opens ordinary paths, and a folder swapped between its own
// check and its open would send the write outside the project.
//
// Nor does git convert the bytes. `cat-file --filters` reads `.gitattributes` and
// the filter config at the moment it runs, which no check made before it can pin:
// the batch itself may have just put back a `.gitattributes` that names a driver,
// and anything else may write one. So the index version is read raw and the one
// conversion palmux writes, LF to CRLF, is git's rule ported here; a path whose
// attributes ask for a filter, an encoding or `ident` is skipped instead.

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import {
  SCM_BATCH_LIMIT,
  type ScmBatchResult,
  type ScmEntry,
  type ScmSkip,
  type ScmSkipReason,
} from '@palmux/shared';
import {
  GIT_BATCH_TIMEOUT_MS,
  checkRelPath,
  convertedPaths,
  gitFailure,
  runGit,
  scmFail,
  type ScmFailure,
} from './scm-git';
import { checkoutBytes, readEolConfig, type Attrs } from './scm-eol';
import { BATCH_MAX_BUFFER, isFailure, readEntries, serialised, type WriteResult } from './scm-index';
import {
  closeAll,
  openChildDir,
  openParent,
  openTop,
  procPath,
  readWorkTree,
  statAt,
  type ParentWalk,
  type WorkProbe,
  type WorkStat,
} from './scm-snapshot';
import { getStatus, invalidateStatus } from './scm-status';

/** A file over this is not discarded: its backup would sit in memory whole, and a terminal does it better. */
export const DISCARD_LIMIT_BYTES = 64 * 1024 * 1024;
export const DISCARD_RECEIPT_MS = 600_000;
export const DISCARD_RECEIPT_MAX = 20;

/**
 * A checkout can grow a file past the size it has in the index (an LF blob checked
 * out as CRLF at most doubles), and those bytes are held to be written and hashed.
 */
const AFTER_LIMIT_BYTES = 2 * DISCARD_LIMIT_BYTES;

/** What `link` answers on a filesystem without hard links, where a swap onto nothing falls back to `rename`. */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

type Hook = (() => void | Promise<void>) | null;

/**
 * Test seams: `afterStatus` runs once a discard has read the status, `beforeWrite`
 * once every backup exists and before the first work tree write, and
 * `afterCompare` once an Undo has compared every file and before it puts one back.
 */
export const discardHooks: { afterStatus: Hook; beforeWrite: Hook; afterCompare: Hook } = {
  afterStatus: null,
  beforeWrite: null,
  afterCompare: null,
};

// ── Receipts (memory only, apart from the shared snapshot cache) ──────────────

/** A file as it is on disk: absent, or a blob in the object store and the mode it had. */
export type FileState = 'absent' | { oid: string; mode: string; perm: number };

export interface DiscardReceiptEntry {
  path: string;
  before: FileState;
  after: FileState;
  /** The folders the discard made to put the file back, deepest first: Undo removes each one it finds empty. */
  created: string[];
}

interface DiscardReceipt {
  top: string;
  entries: DiscardReceiptEntry[];
  createdAt: number;
}

/**
 * Its own store, so review tokens and index receipts, which share a 64 MB LRU,
 * can never push a discard's Undo out. Insertion order is creation order.
 */
const receipts = new Map<string, DiscardReceipt>();

function pruneExpired(now: number): void {
  for (const [id, receipt] of receipts) {
    if (now - receipt.createdAt > DISCARD_RECEIPT_MS) receipts.delete(id);
  }
}

function putDiscardReceipt(top: string, entries: DiscardReceiptEntry[]): string {
  const now = Date.now();
  pruneExpired(now);
  const id = `d${randomBytes(16).toString('hex')}`;
  receipts.set(id, { top, entries, createdAt: now });
  for (const oldest of receipts.keys()) {
    if (receipts.size <= DISCARD_RECEIPT_MAX) break;
    receipts.delete(oldest);
  }
  return id;
}

function getDiscardReceipt(id: string): DiscardReceipt | undefined {
  const receipt = receipts.get(id);
  if (!receipt) return undefined;
  if (Date.now() - receipt.createdAt > DISCARD_RECEIPT_MS) {
    receipts.delete(id);
    return undefined;
  }
  return receipt;
}

/**
 * How many files a live discard receipt still holds, 0 for an unknown or expired one.
 * The audit line reads it before and after an Undo to count what was put back.
 */
export function discardReceiptSize(id: string): number {
  return getDiscardReceipt(id)?.entries.length ?? 0;
}

/** Test seam: forget every discard receipt. */
export function resetDiscardReceipts(): void {
  receipts.clear();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function errnoOf(e: unknown): string {
  return String((e as NodeJS.ErrnoException).code ?? e);
}

function sameStat(a: WorkStat, b: WorkStat): boolean {
  return (
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.ino === b.ino &&
    a.mode === b.mode
  );
}

/** Only content and git's mode are compared: Undo restores the permission bits, a checkout picks its own. */
function sameState(a: FileState, b: FileState): boolean {
  if (a === 'absent' || b === 'absent') return a === b;
  return a.oid === b.oid && a.mode === b.mode;
}

function gitMode(mode: number): string {
  return (mode & 0o100) !== 0 ? '100755' : '100644';
}

async function hashBytes(top: string, bytes: Buffer, store: boolean): Promise<string | ScmFailure> {
  const args = store ? ['hash-object', '-w', '--no-filters', '--stdin'] : ['hash-object', '--no-filters', '--stdin'];
  const run = await runGit(top, args, { input: bytes, timeoutMs: GIT_BATCH_TIMEOUT_MS });
  if (!run.ok) return gitFailure(run, 'hash-object');
  return run.stdout.toString('utf8').trim();
}

/** A file's state and the stat it was read with; `stat` is null when nothing is there. */
interface Observed {
  state: FileState;
  stat: WorkStat | null;
}

/**
 * What is at `path` now, hashed without storing it. Anything but a regular file
 * or nothing is answered as `null`: a write must not go near it.
 */
async function currentState(top: string, path: string): Promise<Observed | null | ScmFailure> {
  const read = await readWorkTree(top, path, { limit: AFTER_LIMIT_BYTES, classify: true });
  if (!read.ok) return read;
  if (read.kind === 'absent') return { state: 'absent', stat: null };
  if (read.kind !== 'file') return null;
  const oid = await hashBytes(top, read.bytes, false);
  if (isFailure(oid)) return oid;
  return { state: { oid, mode: gitMode(read.stat.mode), perm: read.stat.mode & 0o777 }, stat: read.stat };
}

type Placed =
  /** `mode` is the new file's, umask applied. */
  | { kind: 'placed'; mode: number }
  /** The name no longer holds what was expected (`link`: a symbolic link is there now); nothing was written. */
  | { kind: 'moved'; link: boolean }
  | { kind: 'failed'; error: string };

/**
 * Writes `bytes` to a temp file beside the name, through the folder the walk
 * holds, and swaps it in only if the name still holds `expected`: a regular file
 * with that stat, or nothing. That look is the last step before the swap, so a
 * file written in between is never replaced. A swap onto nothing is a hard link,
 * which fails where a `rename` would replace a file created after the look.
 * `create` is the mode the temp is created with (the umask applies), `set` one to
 * force on it afterwards.
 */
async function placeFile(
  walk: { dirs: FileHandle[]; name: string },
  bytes: Buffer,
  mode: { create: number; set?: number },
  expected: WorkStat | null,
): Promise<Placed> {
  const depth = walk.dirs.length - 1;
  const parent = walk.dirs[depth] as FileHandle;
  const target = procPath(parent, walk.name);
  // Not derived from the name: a name near NAME_MAX leaves no room for a suffix.
  const temp = procPath(parent, `.palmux-${randomBytes(8).toString('hex')}`);
  let file: FileHandle | null = null;
  let tempLeft = false;
  try {
    file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode.create);
    tempLeft = true;
    await file.writeFile(bytes);
    if (mode.set !== undefined) await file.chmod(mode.set);
    await file.sync();
    const written = (await file.stat()).mode;
    await file.close();
    file = null;

    const now = await statAt(parent, walk.name, depth);
    if (!now.ok) return { kind: 'failed', error: now.error };
    const still = expected === null ? now.kind === 'absent' : now.kind === 'file' && sameStat(now.stat, expected);
    if (!still) return { kind: 'moved', link: now.kind === 'link' };
    if (expected !== null) {
      await rename(temp, target);
      tempLeft = false;
      return { kind: 'placed', mode: written };
    }
    try {
      await link(temp, target);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (code === 'EEXIST') return { kind: 'moved', link: false };
      if (!NO_HARD_LINKS.has(code)) throw e;
      // No hard links here: the look above is the last one there can be.
      await rename(temp, target);
      tempLeft = false;
    }
    return { kind: 'placed', mode: written };
  } catch (e) {
    return { kind: 'failed', error: `cannot write the file (${errnoOf(e)})` };
  } finally {
    // Best effort: the outcome being returned is the one that matters.
    if (file) await file.close().catch(() => {});
    if (tempLeft) await unlink(temp).catch(() => {});
  }
}

/** The size of each blob, from one `cat-file --batch-check`. */
async function blobSizes(top: string, oids: readonly string[]): Promise<Map<string, number> | ScmFailure> {
  const sizes = new Map<string, number>();
  if (oids.length === 0) return sizes;
  const run = await runGit(top, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], {
    input: `${oids.join('\n')}\n`,
    timeoutMs: GIT_BATCH_TIMEOUT_MS,
  });
  if (!run.ok) return gitFailure(run, 'cat-file');
  for (const line of run.stdout.toString('utf8').split('\n')) {
    const [oid, size] = line.split(' ');
    if (oid && size && /^\d+$/.test(size)) sizes.set(oid, Number(size));
  }
  return sizes;
}

// ── Attributes and line endings: git's checkout rule ──────────────────────────

const CONVERT_ATTRS = ['filter', 'working-tree-encoding', 'ident'];
const CHECKOUT_ATTRS = ['text', 'eol', 'crlf', ...CONVERT_ATTRS];

/**
 * One `check-attr --stdin` over `paths`, NUL-separated so none is read as an
 * option. Without `cached` git reads each folder's `.gitattributes` from the work
 * tree and falls back to the index, which is what a checkout reads; with it, the
 * index alone. Reading attributes never runs a driver.
 */
async function readAttrs(
  top: string,
  paths: readonly string[],
  names: readonly string[],
  cached: boolean,
): Promise<Map<string, Attrs> | ScmFailure> {
  const attrs = new Map<string, Record<string, string>>();
  if (paths.length === 0) return attrs;
  const run = await runGit(top, ['check-attr', ...(cached ? ['--cached'] : []), '-z', '--stdin', ...names], {
    input: `${paths.join('\0')}\0`,
    timeoutMs: GIT_BATCH_TIMEOUT_MS,
    maxBuffer: BATCH_MAX_BUFFER,
  });
  if (!run.ok) return gitFailure(run, 'check-attr');
  const fields = run.stdout.toString('utf8').split('\0');
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const path = fields[i] as string;
    const values = attrs.get(path) ?? {};
    values[fields[i + 1] as string] = fields[i + 2] as string;
    attrs.set(path, values);
  }
  return attrs;
}

/** An attribute with a value of its own, as opposed to set, unset or unspecified. */
const isNamed = (value: string | undefined): boolean =>
  value !== undefined && value !== 'unspecified' && value !== 'unset' && value !== 'set';

/** A filter driver, a working-tree-encoding or `ident`: a conversion palmux does not write. */
function isConverted(attrs: Attrs | undefined): boolean {
  if (!attrs) return false;
  return isNamed(attrs['filter']) || isNamed(attrs['working-tree-encoding']) || attrs['ident'] === 'set';
}

/** Whether `path` names a `.gitattributes`, whose write changes the attributes of the files after it. */
function isAttributesFile(path: string): boolean {
  return path === '.gitattributes' || path.endsWith('/.gitattributes');
}

// ── Validation ────────────────────────────────────────────────────────────────

interface Requested {
  path: string;
  fp: string;
}

type Parsed = { ok: true; entries: Requested[]; nested: string[]; order: string[] } | ScmFailure;

/**
 * At most `SCM_BATCH_LIMIT` `{ path, fp }` entries, each path checked as every
 * route checks one. A nested repository's entry (`vendor/inner/`) is checked
 * without its slash and set aside; any other bad path refuses the whole request.
 */
function parseEntries(raw: unknown): Parsed {
  if (!Array.isArray(raw) || raw.length === 0) return scmFail(400, 'entries must be a non-empty list');
  if (raw.length > SCM_BATCH_LIMIT) return scmFail(400, `at most ${SCM_BATCH_LIMIT} paths per request`);
  const seen = new Set<string>();
  const entries: Requested[] = [];
  const nested: string[] = [];
  const order: string[] = [];
  for (const item of raw as unknown[]) {
    const { path, fp } = (item ?? {}) as { path?: unknown; fp?: unknown };
    if (typeof path !== 'string' || typeof fp !== 'string') {
      return scmFail(400, 'each entry needs a path and an fp');
    }
    const nestedRepo = path.endsWith('/');
    const rel = checkRelPath(nestedRepo ? path.slice(0, -1) : path);
    if (!rel.ok) return rel;
    if (seen.has(path)) continue;
    seen.add(path);
    order.push(path);
    if (nestedRepo) nested.push(path);
    else entries.push({ path, fp });
  }
  return { ok: true, entries, nested, order };
}

// ── The discard ───────────────────────────────────────────────────────────────

/** A file that could not be written, with the reason the route can log. */
export interface DiscardFailure {
  path: string;
  error: string;
}

export type DiscardResult =
  | { ok: true; result: ScmBatchResult; failures: DiscardFailure[] }
  | ScmFailure;

interface Candidate {
  path: string;
  /** The index entry a tracked file goes back to; null for an untracked file. */
  index: { oid: string; mode: string } | null;
  /** The stat the backup was read with; null for a tracked file deleted from the work tree. */
  stat: WorkStat | null;
  before: FileState;
}

/**
 * Discards each confirmed entry (D6). Each file is independent: one that cannot
 * be written is skipped as `failed` and the rest go on, because its backup
 * already exists. A file over `DISCARD_LIMIT_BYTES` refuses the whole request
 * before anything is written.
 */
export async function discardPaths(req: { top: string; entries: unknown }): Promise<DiscardResult> {
  const parsed = parseEntries(req.entries);
  if (!parsed.ok) return parsed;
  const { top } = req;

  return serialised(top, async (): Promise<DiscardResult> => {
    const order = new Map<string, number>();
    parsed.order.forEach((path, i) => order.set(path, i));
    const skipped: ScmSkip[] = parsed.nested.map((path) => ({ path, reason: 'nested-repo' }));
    const failures: DiscardFailure[] = [];
    const skip = (path: string, reason: ScmSkipReason, error?: string): void => {
      skipped.push({ path, reason });
      if (error !== undefined) failures.push({ path, error });
    };

    // Step 2 starts on disk. Each path is looked at once BEFORE the status is read,
    // and every later look must find that same stat. The status's own lstat falls
    // between the two, so a file that still matches this look is the file whose
    // fingerprint the user confirmed. Looked at after the status instead, an edit
    // landing in between would become the version backed up and discarded.
    const probes = new Map<string, WorkProbe>();
    for (const { path } of parsed.entries) {
      probes.set(path, await readWorkTree(top, path, { statOnly: true, classify: true }));
    }

    // Then only what the status lists now, as the user saw it.
    invalidateStatus(top);
    const status = await getStatus(top);
    if (!status.ok) return status;
    await discardHooks.afterStatus?.();
    const listed = new Map<string, ScmEntry>(status.status.changes.map((e) => [e.path, e]));
    let remaining: ScmEntry[] = [];
    for (const { path, fp } of parsed.entries) {
      const entry = listed.get(path);
      if (!entry) skip(path, 'gone');
      else if (entry.fp !== fp) skip(path, 'changed');
      else if (entry.status === 'A') skip(path, 'intent-to-add');
      else if (entry.status === 'R') skip(path, 'rename');
      else remaining.push(entry);
    }

    // Step 3: a path git would run a filter or an encoding for is not palmux's to
    // rewrite. Both the work tree's attributes and the index's count, because those
    // are the two states this batch can leave each `.gitattributes` in. Here, before
    // the backups and the size check, so a large filtered file never refuses the batch.
    const askedFor = remaining.map((e) => e.path);
    const converted = await convertedPaths(top, askedFor);
    if (!converted.ok) return converted;
    const inIndex = await readAttrs(top, askedFor, CONVERT_ATTRS, true);
    if (isFailure(inIndex)) return inIndex;
    remaining = remaining.filter((e) => {
      if (!converted.paths.has(e.path) && !isConverted(inIndex.get(e.path))) return true;
      skip(e.path, 'converted');
      return false;
    });

    // Step 4: what each path is in the index, and what the look before the status found on disk.
    const tracked = remaining.filter((e) => e.status !== '?').map((e) => e.path);
    const index = await readEntries(top, tracked, { timeoutMs: GIT_BATCH_TIMEOUT_MS });
    if (isFailure(index)) return index;
    const probed: { entry: ScmEntry; stat: WorkStat | null; index: Candidate['index'] }[] = [];
    for (const entry of remaining) {
      const { path } = entry;
      const isTracked = entry.status !== '?';
      const staged = (index.get(path) ?? []).find((e) => e.stage === 0) ?? null;
      if (isTracked) {
        if (staged === null) {
          skip(path, 'gone');
          continue;
        }
        if (staged.mode === '120000') {
          skip(path, 'symlink');
          continue;
        }
        if (staged.mode === '160000') {
          skip(path, 'submodule');
          continue;
        }
      }
      const at = isTracked && staged ? { oid: staged.oid, mode: staged.mode } : null;
      const probe = probes.get(path);
      if (!probe?.ok) {
        skip(path, 'failed', probe ? probe.error : 'the path was not looked at');
        continue;
      }
      switch (probe.kind) {
        case 'link':
        case 'link-in-path':
          skip(path, 'symlink');
          continue;
        case 'special':
          skip(path, 'special');
          continue;
        case 'absent':
          // Only a tracked deletion is expected to be absent; anything else moved since the status.
          if (entry.status === 'D') probed.push({ entry, stat: null, index: at });
          else skip(path, 'changed');
          continue;
        case 'stat':
          if (entry.status === 'D') skip(path, 'changed');
          else probed.push({ entry, stat: probe.stat, index: at });
          continue;
        default:
          // statOnly never reads bytes, so no other kind can come back.
          skip(path, 'failed', `unexpected work tree read: ${probe.kind}`);
      }
    }

    // A file too large to back up, or an index version too large to write back,
    // refuses the whole request: nothing has been written yet.
    const sizes = await blobSizes(top, [...new Set(probed.flatMap((p) => (p.index ? [p.index.oid] : [])))]);
    if (isFailure(sizes)) return sizes;
    for (const p of probed) {
      const blob = p.index ? (sizes.get(p.index.oid) ?? 0) : 0;
      if ((p.stat?.size ?? 0) > DISCARD_LIMIT_BYTES || blob > DISCARD_LIMIT_BYTES) {
        return scmFail(413, `${p.entry.path} is larger than 64 MiB; discard it from a terminal`);
      }
    }

    // Step 5: the backup, one file in memory at a time.
    const candidates: Candidate[] = [];
    for (const { entry, stat, index: at } of probed) {
      if (stat === null) {
        candidates.push({ path: entry.path, index: at, stat: null, before: 'absent' });
        continue;
      }
      const read = await readWorkTree(top, entry.path, { limit: DISCARD_LIMIT_BYTES, classify: true });
      if (!read.ok) {
        skip(entry.path, 'failed', read.error);
        continue;
      }
      if (read.kind !== 'file' || !sameStat(read.stat, stat)) {
        skip(entry.path, 'changed');
        continue;
      }
      const oid = await hashBytes(top, read.bytes, true);
      if (isFailure(oid)) {
        skip(entry.path, 'failed', oid.error);
        continue;
      }
      candidates.push({
        path: entry.path,
        index: at,
        stat,
        before: { oid, mode: gitMode(stat.mode), perm: stat.mode & 0o777 },
      });
    }

    // Read while nothing is written yet, so a failure can still refuse the whole request.
    const eolConfig = await readEolConfig(top);
    if (isFailure(eolConfig)) return eolConfig;

    await discardHooks.beforeWrite?.();

    const changed: DiscardReceiptEntry[] = [];
    let wrote = false;

    // Steps 6 and 7: a tracked file is written back and an untracked one deleted,
    // each only if it is still the file that was backed up. The after-state comes
    // from what was written, never from reading the file again, so a file that was
    // replaced is always in the receipt. Every `.gitattributes` goes first, and each
    // wave reads the attributes as they are just before it writes: those are the
    // ones a checkout of each file would read, whatever order the request named
    // them in, and a filter one of them brings back is a skip, never a run.
    const waves = [
      candidates.filter((c) => isAttributesFile(c.path)),
      candidates.filter((c) => !isAttributesFile(c.path)),
    ];
    for (const wave of waves) {
      const toWrite = wave.filter((c) => c.index !== null).map((c) => c.path);
      // Something may already be written, so a failure here skips files and refuses nothing.
      const attrs = await readAttrs(top, toWrite, CHECKOUT_ATTRS, false);
      for (const c of wave) {
        if (c.index !== null) {
          if (isFailure(attrs)) {
            skip(c.path, 'failed', attrs.error);
            continue;
          }
          const pathAttrs = attrs.get(c.path) ?? {};
          if (isConverted(pathAttrs)) {
            skip(c.path, 'converted');
            continue;
          }
          const outcome = await writeTracked(top, c, c.index, (blob) => checkoutBytes(blob, pathAttrs, eolConfig));
          if (outcome.kind === 'written') {
            wrote = true;
            changed.push({ path: c.path, before: c.before, after: outcome.after, created: outcome.created });
          } else {
            skip(c.path, outcome.reason, outcome.error);
          }
          continue;
        }
        const outcome = await deleteUntracked(top, c);
        if (outcome.kind === 'deleted') {
          wrote = true;
          changed.push({ path: c.path, before: c.before, after: 'absent', created: [] });
        } else {
          if (outcome.wrote) wrote = true;
          skip(c.path, outcome.reason, outcome.error);
        }
      }
    }

    if (wrote) invalidateStatus(top);
    const receiptId = changed.length > 0 ? putDiscardReceipt(top, changed) : null;
    const rank = (path: string): number => order.get(path) ?? 0;
    return {
      ok: true,
      result: {
        receiptId,
        status: 'discarded',
        done: changed.map((e) => e.path).toSorted((a, b) => rank(a) - rank(b)),
        skipped: skipped.toSorted((a, b) => rank(a.path) - rank(b.path)),
      },
      failures,
    };
  });
}

type Rewrite =
  | { kind: 'written'; after: FileState; created: string[] }
  | { kind: 'skip'; reason: ScmSkipReason; error?: string };

/**
 * Writes one tracked file back to its index version. The blob is read raw, so no
 * driver can run, and `convert` turns it into the bytes a checkout would write;
 * the caller has skipped every path a filter driver, an encoding or `ident` would
 * rewrite. They are written beside the name through the folder the walk holds and
 * swapped in only if the name still holds the file that was backed up, or still
 * holds nothing for a deletion. A folder the deletion took with it is created
 * again, as a checkout would.
 */
async function writeTracked(
  top: string,
  c: Candidate,
  index: { oid: string; mode: string },
  convert: (blob: Buffer) => Buffer,
): Promise<Rewrite> {
  // blobSizes held every index version to DISCARD_LIMIT_BYTES.
  const blob = await runGit(top, ['cat-file', 'blob', index.oid], {
    maxBuffer: DISCARD_LIMIT_BYTES,
    timeoutMs: GIT_BATCH_TIMEOUT_MS,
  });
  if (!blob.ok) return { kind: 'skip', reason: 'failed', error: gitFailure(blob, 'cat-file').error };
  const bytes = convert(blob.stdout);
  const oid = await hashBytes(top, bytes, false);
  if (isFailure(oid)) return { kind: 'skip', reason: 'failed', error: oid.error };

  const walk = await ensureParent(top, c.path);
  if (!walk.ok) return { kind: 'skip', reason: 'failed', error: walk.error };
  if (walk.kind === 'link-in-path') return { kind: 'skip', reason: 'symlink' };
  if (walk.kind !== 'dirs') return { kind: 'skip', reason: 'special' };
  try {
    // Created 0777 or 0666 so the umask applies, as it does to a file git checks out.
    const create = index.mode === '100755' ? 0o777 : 0o666;
    const placed = await placeFile(walk, bytes, { create }, c.stat);
    if (placed.kind === 'placed') {
      return {
        kind: 'written',
        after: { oid, mode: gitMode(placed.mode), perm: placed.mode & 0o777 },
        created: walk.created,
      };
    }
    // Nothing was written, so a folder made for the file goes again.
    await removeFolders(walk.dirs, walk.created);
    return placed.kind === 'moved'
      ? { kind: 'skip', reason: placed.link ? 'symlink' : 'changed' }
      : { kind: 'skip', reason: 'failed', error: placed.error };
  } finally {
    await closeAll(walk.dirs);
  }
}

type Deletion =
  | { kind: 'deleted' }
  /** `wrote` is true only when the unlink itself failed: then the file may be gone. */
  | { kind: 'skip'; reason: ScmSkipReason; error?: string; wrote: boolean };

/**
 * Unlinks one untracked file through its parent's descriptor, after an `lstat`
 * through the same descriptor shows it is still the file that was backed up.
 */
async function deleteUntracked(top: string, c: Candidate): Promise<Deletion> {
  const walk = await openParent(top, c.path);
  if (!walk.ok) return { kind: 'skip', reason: 'failed', error: walk.error, wrote: false };
  if (walk.kind === 'link-in-path') return { kind: 'skip', reason: 'symlink', wrote: false };
  if (walk.kind !== 'dirs') return { kind: 'skip', reason: 'changed', wrote: false };
  const { dirs, name } = walk;
  const parts = c.path.split('/');
  try {
    const parent = dirs[dirs.length - 1] as FileHandle;
    const now = await statAt(parent, name, dirs.length - 1);
    if (!now.ok) return { kind: 'skip', reason: 'failed', error: now.error, wrote: false };
    if (now.kind === 'link') return { kind: 'skip', reason: 'symlink', wrote: false };
    if (now.kind !== 'file' || c.stat === null || !sameStat(now.stat, c.stat)) {
      return { kind: 'skip', reason: 'changed', wrote: false };
    }
    try {
      await unlink(procPath(parent, name));
    } catch (e) {
      return { kind: 'skip', reason: 'failed', error: `unlink: ${errnoOf(e)}`, wrote: true };
    }
    for (let depth = dirs.length - 1; depth >= 1; depth--) {
      try {
        await rmdir(procPath(dirs[depth - 1] as FileHandle, parts[depth - 1] as string));
      } catch (e) {
        // A folder that still holds anything (an ignored file, a sibling) ends the climb.
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') break;
      }
    }
    return { kind: 'deleted' };
  } finally {
    await closeAll(dirs);
  }
}

/**
 * Removes each of `folders` (deepest first, all on the way the walk `dirs` took)
 * that is empty, through its parent's descriptor. The first that still holds
 * anything ends it, since every folder above holds that one.
 */
async function removeFolders(dirs: readonly FileHandle[], folders: readonly string[]): Promise<void> {
  for (const folder of folders) {
    const parts = folder.split('/');
    const depth = parts.length - 1;
    const parent = dirs[depth];
    if (!parent) return;
    try {
      await rmdir(procPath(parent, parts[depth] as string));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return;
    }
  }
}

type MadeParent =
  /** `created` holds the folders this walk made, deepest first. */
  | (Extract<ParentWalk, { kind: 'dirs' }> & { created: string[] })
  | { ok: true; kind: 'link-in-path' | 'not-dir' }
  | ScmFailure;

/**
 * Opens the folders on the way to `path`, creating the missing ones through the
 * descriptor of the folder before (mode 0777, so the umask applies, as for any
 * folder git or a shell creates). A link or a file on the way is answered as
 * `link-in-path` or `not-dir`; nothing stays open then, and nothing it made stays.
 */
async function ensureParent(top: string, path: string): Promise<MadeParent> {
  const parts = path.split('/');
  const opened = await openTop(top);
  if (!opened.ok) return scmFail(500, `${path}: ${opened.error}`);
  const dirs: FileHandle[] = [opened.dir];
  const created: string[] = [];
  const giveUp = async (): Promise<void> => {
    await removeFolders(dirs, created);
    await closeAll(dirs);
  };
  try {
    for (let depth = 0; depth < parts.length - 1; depth++) {
      const parent = dirs[depth] as FileHandle;
      const name = parts[depth] as string;
      let child = await openChildDir(parent, name, depth);
      if (child.ok && child.kind === 'absent') {
        try {
          await mkdir(procPath(parent, name), 0o777);
          created.unshift(parts.slice(0, depth + 1).join('/'));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
        child = await openChildDir(parent, name, depth);
      }
      if (!child.ok || child.kind !== 'dir') {
        await giveUp();
        if (!child.ok) return scmFail(500, `${path}: ${child.error}`);
        // Absent again right after it was made is as unusable as a file there.
        return { ok: true, kind: child.kind === 'link-in-path' ? 'link-in-path' : 'not-dir' };
      }
      dirs.push(child.dir);
    }
  } catch (e) {
    await giveUp();
    return scmFail(500, `${path}: cannot create its folder (${errnoOf(e)})`);
  }
  return { ok: true, kind: 'dirs', dirs, name: parts[parts.length - 1] as string, created };
}

// ── Undo ──────────────────────────────────────────────────────────────────────

/** `moved`: the file is no longer what the comparison saw, and nothing was written. */
type Restored = null | 'moved' | ScmFailure;

/**
 * Puts one entry's `before` back, but only onto the file the comparison saw:
 * `seen` is the stat it was read with, or null where nothing was. The look is
 * taken again as the last step before the swap, so an edit or a recreated file
 * that lands after the comparison is never replaced.
 */
async function restoreEntry(top: string, entry: DiscardReceiptEntry, seen: WorkStat | null): Promise<Restored> {
  const { path, before } = entry;
  if (before === 'absent') {
    const walk = await openParent(top, path);
    if (!walk.ok) return scmFail(500, `${path}: ${walk.error}`);
    // Its folder is gone, so the file is too: that is the state Undo puts back.
    if (walk.kind === 'absent') return null;
    if (walk.kind !== 'dirs') return 'moved';
    try {
      const depth = walk.dirs.length - 1;
      const parent = walk.dirs[depth] as FileHandle;
      const now = await statAt(parent, walk.name, depth);
      if (!now.ok) return scmFail(500, `${path}: ${now.error}`);
      if (now.kind !== 'absent') {
        if (now.kind !== 'file' || seen === null || !sameStat(now.stat, seen)) return 'moved';
        await unlink(procPath(parent, walk.name));
      }
      // The state Undo puts back has no file, and so none of the folders made for it.
      await removeFolders(walk.dirs, entry.created);
      return null;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : scmFail(500, `${path}: unlink ${errnoOf(e)}`);
    } finally {
      await closeAll(walk.dirs);
    }
  }

  // The blob first: a failure to read it must leave nothing behind, not even a folder.
  const blob = await runGit(top, ['cat-file', 'blob', before.oid], {
    maxBuffer: DISCARD_LIMIT_BYTES,
    timeoutMs: GIT_BATCH_TIMEOUT_MS,
  });
  if (!blob.ok) return scmFail(500, `${path}: ${gitFailure(blob, 'cat-file').error}`);

  const walk = await ensureParent(top, path);
  if (!walk.ok) return walk;
  if (walk.kind !== 'dirs') return 'moved';
  try {
    const placed = await placeFile(walk, blob.stdout, { create: 0o600, set: before.perm }, seen);
    if (placed.kind === 'placed') return null;
    await removeFolders(walk.dirs, walk.created);
    if (placed.kind === 'moved') return 'moved';
    return scmFail(500, `${path}: ${placed.error}`);
  } finally {
    await closeAll(walk.dirs);
  }
}

const NOTHING_UNDONE = 'The files changed since the discard; nothing was undone.';

/**
 * Undoes one discard (D7): every file must still be exactly as the discard left
 * it, and only then is each one put back, each after a last look of its own. A
 * failure or a file that changed part way keeps the receipt for the files not yet
 * restored, so a second Undo retries only those.
 */
export async function restoreDiscard(req: { top: string; receiptId: string }): Promise<WriteResult> {
  if (typeof req.receiptId !== 'string' || req.receiptId === '') {
    return scmFail(400, 'receiptId is required');
  }
  const { top, receiptId } = req;

  return serialised(top, async (): Promise<WriteResult> => {
    const receipt = getDiscardReceipt(receiptId);
    if (!receipt) return scmFail(410, 'Undo is no longer available.', 'token');
    if (receipt.top !== top) return scmFail(400, 'receipt does not belong to this repository');

    const seen = new Map<string, WorkStat | null>();
    for (const entry of receipt.entries) {
      const now = await currentState(top, entry.path);
      if (isFailure(now)) return now;
      if (now === null || !sameState(now.state, entry.after)) return scmFail(409, NOTHING_UNDONE, 'conflict');
      seen.set(entry.path, now.stat);
    }
    await discardHooks.afterCompare?.();

    const total = receipt.entries.length;
    const restored = new Set<string>();
    for (const entry of receipt.entries) {
      const outcome = await restoreEntry(top, entry, seen.get(entry.path) ?? null);
      if (outcome === null) {
        restored.add(entry.path);
        continue;
      }
      receipt.entries = receipt.entries.filter((e) => !restored.has(e.path));
      if (restored.size > 0) invalidateStatus(top);
      if (outcome !== 'moved') return outcome;
      return scmFail(
        409,
        restored.size === 0
          ? NOTHING_UNDONE
          : `The files changed since the discard; ${restored.size} of ${total} were restored, and Undo keeps the rest.`,
        'conflict',
      );
    }
    receipts.delete(receiptId);
    invalidateStatus(top);
    return { ok: true, result: { receiptId: null, status: 'restored' } };
  });
}
