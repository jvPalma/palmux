// ── Source Control: one file's snapshot ───────────────────────────────────────
//
// A snapshot is both sides of one file pair, read once, plus git's own hunks
// between them. Everything the review draws (lines, hunks, colours, comment
// positions) comes from that one read, so an edit during loading can replace a
// version but never mix two.
//
// The sides: blobs by object id (`cat-file blob <oid>`, immutable, never
// `show :path`, so a file named `2:config.ts` cannot select merge stage 2) and
// the work tree through a descriptor-relative walk. Node has no `openat`, but on
// Linux `/proc/self/fd/<dirfd>/<name>` resolves `<name>` inside the directory the
// descriptor already holds, so a directory swapped for a link can make an open
// fail and can never redirect one.
//
// This module also owns the server-side cache of served work tree sides
// (tokens) and of write receipts: staging writes exactly the bytes a snapshot
// served, never whatever is on disk by then.

import { createHash, randomBytes } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { lstat, mkdtemp, open, readlink, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  isScmAlgorithm,
  isScmGroup,
  type ScmAlgorithm,
  type ScmFileSnapshot,
  type ScmGroup,
  type ScmHunk,
  type ScmHunkLine,
} from '@palmux/shared';
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

export const SIDE_LIMIT_BYTES = 1024 * 1024;
/** git's own `FIRST_FEW_BYTES`: a NUL in this prefix makes a file binary. */
export const BINARY_SNIFF_BYTES = 8000;

const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const EMPTY = Buffer.alloc(0);

/** Test seams: a step hook between two opens of the walk, and where `/proc/self/fd` is. */
export const walkHooks: {
  onStep: ((step: WalkStep) => void | Promise<void>) | null;
  procFdDir: string;
} = { onStep: null, procFdDir: '/proc/self/fd' };

export interface WalkStep {
  kind: 'dir' | 'file';
  name: string;
  depth: number;
}

// ── Token and receipt cache (memory only) ─────────────────────────────────────

export type AttrContext = Record<string, string>;

/** Everything staging needs to write exactly what a snapshot served. */
export interface TokenRecord {
  top: string;
  path: string;
  /** The mode the entry will have; null stages a deletion. */
  mode: string | null;
  id: string;
  bytes: Buffer;
  context: AttrContext;
}

export interface ReceiptEntry {
  path: string;
  before: IndexEntry[];
  after: IndexEntry[];
}

export interface ReceiptRecord {
  top: string;
  entries: ReceiptEntry[];
}

interface CacheItem {
  value: TokenRecord | ReceiptRecord;
  size: number;
  createdAt: number;
}

const cacheConfig = { maxBytes: 64 * 1024 * 1024, ttlMs: 10 * 60 * 1000 };
/** Insertion order is least-recently-used first: a read re-inserts. */
const cache = new Map<string, CacheItem>();
let cacheBytes = 0;

/** Tests shrink the bounds; production keeps the defaults. */
export function configureScmCache(next: Partial<typeof cacheConfig>): void {
  Object.assign(cacheConfig, next);
}

export function resetScmCache(): void {
  cache.clear();
  cacheBytes = 0;
}

export function scmCacheStats(): { entries: number; bytes: number } {
  return { entries: cache.size, bytes: cacheBytes };
}

function cacheDrop(key: string): void {
  const item = cache.get(key);
  if (!item) return;
  cache.delete(key);
  cacheBytes -= item.size;
}

function cachePut(prefix: string, value: TokenRecord | ReceiptRecord, size: number): string {
  const now = Date.now();
  for (const [key, item] of cache) {
    if (now - item.createdAt > cacheConfig.ttlMs) cacheDrop(key);
  }
  const key = `${prefix}${randomBytes(16).toString('hex')}`;
  cache.set(key, { value, size, createdAt: now });
  cacheBytes += size;
  for (const oldest of cache.keys()) {
    if (cacheBytes <= cacheConfig.maxBytes || oldest === key) break;
    cacheDrop(oldest);
  }
  return key;
}

function cacheGet(key: string, prefix: string): TokenRecord | ReceiptRecord | undefined {
  if (!key.startsWith(prefix)) return undefined;
  const item = cache.get(key);
  if (!item) return undefined;
  if (Date.now() - item.createdAt > cacheConfig.ttlMs) {
    cacheDrop(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, item);
  return item.value;
}

export function putToken(record: TokenRecord): string {
  return cachePut('t', record, record.bytes.length + 512);
}

export function getToken(token: string): TokenRecord | undefined {
  return cacheGet(token, 't') as TokenRecord | undefined;
}

export function putReceipt(record: ReceiptRecord): string {
  return cachePut('r', record, 512 + record.entries.length * 512);
}

export function getReceipt(id: string): ReceiptRecord | undefined {
  return cacheGet(id, 'r') as ReceiptRecord | undefined;
}

export function deleteReceipt(id: string): void {
  cacheDrop(id);
}

// ── Unified diff ──────────────────────────────────────────────────────────────

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Hunks of one file's `git diff` output, with each line's old and new number. */
export function parseUnifiedDiff(text: string): ScmHunk[] {
  const hunks: ScmHunk[] = [];
  let current: ScmHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split('\n')) {
    const header = line.startsWith('@@') ? HUNK_RE.exec(line) : null;
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[3]);
      current = {
        oldStart: oldNo,
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: newNo,
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        header: header[5] ?? '',
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    // Before the first hunk are the file header lines; they carry no content.
    if (!current) continue;
    const body = line.slice(1);
    let entry: ScmHunkLine;
    if (line.startsWith('\\')) {
      const last = current.lines[current.lines.length - 1];
      if (last) last.noEol = true;
      continue;
    } else if (line.startsWith('+')) {
      entry = { kind: 'add', new: newNo++, text: body };
    } else if (line.startsWith('-')) {
      entry = { kind: 'del', old: oldNo++, text: body };
    } else if (line.startsWith(' ')) {
      entry = { kind: 'ctx', old: oldNo++, new: newNo++, text: body };
    } else {
      continue;
    }
    current.lines.push(entry);
  }
  return hunks;
}

// ── Line endings: git's own check-in rule ─────────────────────────────────────

export interface TextStats {
  nul: number;
  lonecr: number;
  crlf: number;
  lonelf: number;
  printable: number;
  nonprintable: number;
}

/** A port of git's `gather_stats`; the guard below must agree with git byte for byte. */
export function gatherStats(buf: Buffer): TextStats {
  const stats: TextStats = { nul: 0, lonecr: 0, crlf: 0, lonelf: 0, printable: 0, nonprintable: 0 };
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i] as number;
    if (c === 13) {
      if (buf[i + 1] === 10) {
        stats.crlf += 1;
        i += 1;
      } else {
        stats.lonecr += 1;
      }
      continue;
    }
    if (c === 10) {
      stats.lonelf += 1;
      continue;
    }
    if (c === 127) {
      stats.nonprintable += 1;
    } else if (c < 32) {
      // BS, HT, ESC and FF print; everything else below a space does not.
      if (c === 8 || c === 9 || c === 27 || c === 12) stats.printable += 1;
      else {
        if (c === 0) stats.nul += 1;
        stats.nonprintable += 1;
      }
    } else {
      stats.printable += 1;
    }
  }
  if (buf.length >= 1 && buf[buf.length - 1] === 26) stats.nonprintable -= 1;
  return stats;
}

function statsAreBinary(stats: TextStats): boolean {
  return stats.lonecr > 0 || stats.nul > 0 || stats.printable >> 7 < stats.nonprintable;
}

/** git's `has_crlf_in_index`: the index blob is text and already holds a CRLF. */
function hasCrlfInIndex(blob: Buffer): boolean {
  if (!blob.includes(13)) return false;
  const stats = gatherStats(blob);
  return !statsAreBinary(stats) && stats.crlf > 0;
}

type EolAction = 'binary' | 'text' | 'auto' | 'undefined';

function actionOf(value: string | undefined): EolAction {
  switch (value) {
    case 'set':
    case 'input':
      return 'text';
    case 'unset':
      return 'binary';
    case 'auto':
      return 'auto';
    default:
      return 'undefined';
  }
}

export type EolWhy = 'off' | 'on' | 'binary' | 'crlf-in-index';

/**
 * Whether git converts CRLF to LF when it checks this work tree file in.
 * Explicit `text` always converts. The auto-derived modes (`text=auto`, or no
 * `text` under `core.autocrlf=true|input`) convert only when the file is text by
 * git's stats and the index blob does not already hold a CRLF, which is why a
 * CRLF blob that was never renormalised diffs line for line.
 */
export function eolDecision(
  attrs: Readonly<Record<string, string>>,
  autocrlf: string,
  work: Buffer,
  indexBlob: Buffer | null,
): { convert: boolean; why: EolWhy } {
  let action = actionOf(attrs['text']);
  if (action === 'undefined') action = actionOf(attrs['crlf']);
  const eol = attrs['eol'];
  if (action !== 'binary' && (eol === 'lf' || eol === 'crlf')) {
    action = action === 'auto' ? 'auto' : 'text';
  }
  if (action === 'undefined') {
    action = autocrlf === 'true' || autocrlf === 'input' ? 'auto' : 'binary';
  }
  if (action === 'binary' || work.length === 0) return { convert: false, why: 'off' };
  if (action === 'text') return { convert: true, why: 'on' };
  if (statsAreBinary(gatherStats(work))) return { convert: false, why: 'binary' };
  if (indexBlob && hasCrlfInIndex(indexBlob)) return { convert: false, why: 'crlf-in-index' };
  return { convert: true, why: 'on' };
}

/** Drops a CR only when an LF follows it, as git's check-in conversion does. */
export function crlfToLf(buf: Buffer): Buffer {
  if (!buf.includes(13)) return buf;
  const out = Buffer.allocUnsafe(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i] as number;
    if (c === 13 && buf[i + 1] === 10) continue;
    out[n++] = c;
  }
  return out.subarray(0, n);
}

// ── Attributes and config ─────────────────────────────────────────────────────

const CHECKED_ATTRS = ['text', 'eol', 'crlf', 'diff', 'binary', 'filter', 'working-tree-encoding', 'ident'];

/** `core.autocrlf` as git reads it: `input`, or a boolean. */
function normaliseAutocrlf(value: string | undefined): string {
  if (value === undefined) return 'false';
  const v = value.toLowerCase();
  if (v === 'input') return 'input';
  return v === 'true' || v === 'yes' || v === 'on' || v === '1' ? 'true' : 'false';
}

interface CoreConfig {
  autocrlf: string;
  eol: string;
  fileMode: boolean;
}

async function readCoreConfig(top: string): Promise<CoreConfig | ScmFailure> {
  const run = await runGit(top, ['config', '-z', '--get-regexp', '^core\\.(autocrlf|eol|filemode)$'], {
    okCodes: [0, 1],
  });
  if (!run.ok) return gitFailure(run, 'config');
  const values = new Map<string, string>();
  for (const record of run.stdout.toString('utf8').split('\0')) {
    if (record === '') continue;
    const newline = record.indexOf('\n');
    // A key with no value (`[core] filemode`) means true; a later setting wins.
    if (newline < 0) values.set(record.toLowerCase(), 'true');
    else values.set(record.slice(0, newline).toLowerCase(), record.slice(newline + 1));
  }
  const fileMode = values.get('core.filemode');
  return {
    autocrlf: normaliseAutocrlf(values.get('core.autocrlf')),
    eol: (values.get('core.eol') ?? 'unset').toLowerCase(),
    fileMode: fileMode === undefined ? true : normaliseAutocrlf(fileMode) === 'true',
  };
}

async function readAttrValues(top: string, path: string): Promise<AttrContext | ScmFailure> {
  const run = await runGit(top, ['check-attr', '-z', ...CHECKED_ATTRS, '--', path]);
  if (!run.ok) return gitFailure(run, 'check-attr');
  const fields = run.stdout.toString('utf8').split('\0');
  const values: AttrContext = {};
  for (let i = 0; i + 2 < fields.length; i += 3) {
    values[fields[i + 1] as string] = fields[i + 2] as string;
  }
  return values;
}

interface AttrState {
  context: AttrContext;
  core: CoreConfig;
}

async function loadAttrs(top: string, path: string): Promise<AttrState | ScmFailure> {
  const [values, core] = await Promise.all([readAttrValues(top, path), readCoreConfig(top)]);
  if (isFailure(values)) return values;
  if (isFailure(core)) return core;
  return {
    core,
    context: { ...values, 'core.autocrlf': core.autocrlf, 'core.eol': core.eol },
  };
}

/** The attribute and conversion inputs for `path`, re-read by staging to compare with the snapshot's. */
export async function readAttrContext(
  top: string,
  path: string,
): Promise<{ ok: true; context: AttrContext } | ScmFailure> {
  const state = await loadAttrs(top, path);
  if (isFailure(state)) return state;
  return { ok: true, context: state.context };
}

/** An attribute with a value of its own, as opposed to set, unset or unspecified. */
function isNamedValue(value: string | undefined): boolean {
  return value !== undefined && value !== 'unspecified' && value !== 'unset' && value !== 'set';
}

/** A filter driver, a working-tree-encoding or ident expansion: git converts, and palmux does not reconstruct it. */
function isConvertedByGit(context: Readonly<AttrContext>): boolean {
  return (
    isNamedValue(context['filter']) ||
    isNamedValue(context['working-tree-encoding']) ||
    context['ident'] === 'set'
  );
}

// ── The work tree side ────────────────────────────────────────────────────────

export type WorkRead =
  | { ok: true; kind: 'absent' }
  | { ok: true; kind: 'file'; bytes: Buffer; exec: boolean }
  /** Over the size limit: nothing is read, but the stamp still moves when the file does. */
  | { ok: true; kind: 'big'; stamp: string; exec: boolean }
  | { ok: true; kind: 'link'; bytes: Buffer }
  | ScmFailure;

const ABSENT: WorkRead = { ok: true, kind: 'absent' };

function fsFailure(e: unknown, what: string): ScmFailure {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM') return scmFail(403, `${what}: permission denied`);
  return scmFail(500, `${what}: ${String(code ?? e)}`);
}

async function classifyDirFailure(at: string, e: unknown): Promise<WorkRead> {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return ABSENT;
  if (code === 'ENOTDIR' || code === 'ELOOP') {
    // Opening a symlink as a directory fails like opening a file as one; only
    // an lstat through the validated parent tells them apart.
    try {
      if ((await lstat(at)).isSymbolicLink()) {
        return scmFail(403, 'path passes through a symbolic link');
      }
    } catch {
      return ABSENT;
    }
    return ABSENT;
  }
  return fsFailure(e, 'work tree');
}

async function readFileBytes(file: FileHandle): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > SIDE_LIMIT_BYTES) return null;
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Reads `path` under `top` once, component by component, each open relative to
 * the descriptor of the one before and `O_NOFOLLOW`. Fails closed where `/proc`
 * is not available.
 */
export async function readWorkTree(top: string, path: string): Promise<WorkRead> {
  const fdDir = walkHooks.procFdDir;
  if (process.platform !== 'linux' || !existsSync(fdDir)) {
    return scmFail(501, 'this server cannot read the work tree safely', 'unsupported');
  }
  const parts = path.split('/');
  const handles: FileHandle[] = [];
  try {
    let dir: FileHandle;
    try {
      dir = await open(top, constants.O_RDONLY | constants.O_DIRECTORY);
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT'
        ? scmFail(404, 'repository directory does not exist')
        : fsFailure(e, 'work tree');
    }
    handles.push(dir);

    for (let depth = 0; depth < parts.length - 1; depth++) {
      const name = parts[depth] as string;
      await walkHooks.onStep?.({ kind: 'dir', name, depth });
      const at = `${fdDir}/${dir.fd}/${name}`;
      try {
        dir = await open(at, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch (e) {
        return await classifyDirFailure(at, e);
      }
      handles.push(dir);
    }

    const name = parts[parts.length - 1] as string;
    await walkHooks.onStep?.({ kind: 'file', name, depth: parts.length - 1 });
    const at = `${fdDir}/${dir.fd}/${name}`;
    let file: FileHandle;
    try {
      // O_NONBLOCK: opening a FIFO must not wait for a writer.
      file = await open(at, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return ABSENT;
      if (code === 'ELOOP') {
        try {
          return { ok: true, kind: 'link', bytes: await readlink(at, 'buffer') };
        } catch (inner) {
          return (inner as NodeJS.ErrnoException).code === 'ENOENT'
            ? ABSENT
            : fsFailure(inner, 'work tree');
        }
      }
      return fsFailure(e, 'work tree');
    }
    handles.push(file);

    const st = await file.stat();
    // A directory where a tracked file was: the file is gone.
    if (st.isDirectory()) return ABSENT;
    if (!st.isFile()) return scmFail(400, 'path is not a regular file');
    const exec = (st.mode & 0o100) !== 0;
    const big: WorkRead = {
      ok: true,
      kind: 'big',
      stamp: `${st.size}:${st.mtimeMs}:${st.ctimeMs}`,
      exec,
    };
    if (st.size > SIDE_LIMIT_BYTES) return big;
    const bytes = await readFileBytes(file);
    return bytes === null ? big : { ok: true, kind: 'file', bytes, exec };
  } catch (e) {
    return fsFailure(e, 'work tree');
  } finally {
    await Promise.all(handles.map((h) => h.close().catch(() => {})));
  }
}

// ── The diff ──────────────────────────────────────────────────────────────────

/**
 * Both sides go to a private directory and git computes the hunks, so they are
 * git's, the algorithm is selectable, and no pathspec is involved. The user's
 * diff configuration and attributes must not reshape them: the config is pinned
 * and the environment isolated, because `diff` converts a path-based file by the
 * attributes it finds (a global `core.autocrlf` would turn a CRLF blob that was
 * deliberately kept into LF and leave the hunks disagreeing with the text).
 */
async function gitDiff(
  oldBytes: Buffer,
  newBytes: Buffer,
  algorithm: ScmAlgorithm,
  forceText: boolean,
): Promise<{ ok: true; hunks: ScmHunk[] } | ScmFailure> {
  const dir = await mkdtemp(join(tmpdir(), 'palmux-scm-diff-'));
  try {
    await Promise.all([writeFile(join(dir, 'old'), oldBytes), writeFile(join(dir, 'new'), newBytes)]);
    const run = await runGit(
      dir,
      [
        '-c',
        'diff.suppressBlankEmpty=false',
        '-c',
        'diff.noprefix=false',
        '-c',
        'diff.mnemonicPrefix=false',
        '-c',
        'core.autocrlf=false',
        '-c',
        'core.safecrlf=false',
        'diff',
        '--no-index',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        `--diff-algorithm=${algorithm}`,
        '-U3',
        '--inter-hunk-context=0',
        '--indent-heuristic',
        ...(forceText ? ['--text'] : []),
        '--',
        'old',
        'new',
      ],
      {
        okCodes: [0, 1],
        env: {
          HOME: dir,
          XDG_CONFIG_HOME: join(dir, 'xdg'),
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_ATTR_NOSYSTEM: '1',
          GIT_CEILING_DIRECTORIES: dirname(dir),
        },
      },
    );
    if (!run.ok) return gitFailure(run, 'diff');
    return { ok: true, hunks: parseUnifiedDiff(run.stdout.toString('utf8')) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The work tree side's id: git's blob oid of the canonical bytes, in the repository's own object format. */
async function hashBlob(top: string, bytes: Buffer): Promise<string | ScmFailure> {
  const run = await runGit(top, ['hash-object', '--no-filters', '--stdin'], { input: bytes });
  if (!run.ok) return gitFailure(run, 'hash-object');
  return run.stdout.toString('utf8').trim();
}

// ── The snapshot ──────────────────────────────────────────────────────────────

export interface SnapshotRequest {
  top: string;
  group: ScmGroup;
  path: string;
  oldPath?: string | undefined;
  algorithm: ScmAlgorithm;
}

export type SnapshotResult = { ok: true; snapshot: ScmFileSnapshot } | ScmFailure;

/** One side as read: its id, its mode, and its bytes unless it is absent or too big to read. */
interface Side {
  id: string;
  mode: string | null;
  bytes: Buffer | null;
  big: boolean;
}

const ABSENT_SIDE: Side = { id: 'absent', mode: null, bytes: null, big: false };

async function readBlobSide(
  top: string,
  entry: { mode: string; oid: string },
): Promise<Side | ScmFailure> {
  if (entry.mode === '160000') {
    return scmFail(501, 'submodules cannot be shown here', 'unsupported');
  }
  if (!OID_RE.test(entry.oid)) return scmFail(500, 'git printed an unexpected object id');
  const run = await runGit(top, ['cat-file', 'blob', entry.oid], { maxBuffer: SIDE_LIMIT_BYTES });
  if (run.ok) return { id: entry.oid, mode: entry.mode, bytes: run.stdout, big: false };
  if (run.reason === 'truncated') return { id: entry.oid, mode: entry.mode, bytes: null, big: true };
  return gitFailure(run, 'cat-file');
}

function isFailure(value: unknown): value is ScmFailure {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;
}

function sortedAttrs(attrs: Readonly<AttrContext>): [string, string][] {
  return Object.entries(attrs).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Algorithm-free on purpose: the client keys its row cache by `version + algorithm`. */
function versionOf(
  oldSide: { id: string },
  newSide: { id: string },
  modes: { old?: string; new?: string },
  attrs: Readonly<AttrContext>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([oldSide.id, newSide.id, modes.old ?? '', modes.new ?? '', sortedAttrs(attrs)]))
    .digest('hex')
    .slice(0, 16);
}

interface Assembly {
  req: SnapshotRequest;
  oldPath: string | undefined;
  old: { id: string; text: string };
  new: { id: string; text: string };
  hunks: ScmHunk[];
  flags: { binary?: boolean; tooLarge?: boolean; converted?: boolean; unmerged?: boolean };
  modes: { old?: string; new?: string };
  attrs: AttrContext;
  token?: string | undefined;
}

function assemble(a: Assembly): ScmFileSnapshot {
  const { old: oldSide, new: newSide } = a;
  const symlinks: { old?: boolean; new?: boolean } = {};
  if (a.modes.old !== undefined) symlinks.old = a.modes.old === '120000';
  if (a.modes.new !== undefined) symlinks.new = a.modes.new === '120000';
  const anySymlink = symlinks.old === true || symlinks.new === true;
  return {
    path: a.req.path,
    ...(a.oldPath === undefined ? {} : { oldPath: a.oldPath }),
    group: a.req.group,
    algorithm: a.req.algorithm,
    old: oldSide,
    new: newSide,
    hunks: a.hunks,
    binary: a.flags.binary ?? false,
    tooLarge: a.flags.tooLarge ?? false,
    converted: a.flags.converted ?? false,
    unmerged: a.flags.unmerged ?? false,
    modes: a.modes,
    ...(anySymlink ? { symlink: symlinks } : {}),
    attrs: a.attrs,
    version: versionOf(oldSide, newSide, a.modes, a.attrs),
    ...(a.token === undefined ? {} : { token: a.token }),
  };
}

function modesOf(oldMode: string | null, newMode: string | null): { old?: string; new?: string } {
  return {
    ...(oldMode === null ? {} : { old: oldMode }),
    ...(newMode === null ? {} : { new: newMode }),
  };
}

function hasNul(bytes: Buffer | null): boolean {
  return bytes !== null && bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/**
 * Reads one file pair. `top` has passed `checkRepo`; `path` and `oldPath` are
 * checked again here. A staged pair is (HEAD at `oldPath ?? path`, index at
 * `path`), an unstaged pair is (index, work tree), an untracked file is (nothing,
 * work tree). The server resolves every identity itself: the client names a file
 * and a group, never a blob.
 */
export async function readSnapshot(req: SnapshotRequest): Promise<SnapshotResult> {
  if (!isScmGroup(req.group)) return scmFail(400, 'group must be staged or changes');
  if (!isScmAlgorithm(req.algorithm)) return scmFail(400, 'unknown diff algorithm');
  const rel = checkRelPath(req.path);
  if (!rel.ok) return rel;
  let oldPath: string | undefined;
  if (req.group === 'staged' && req.oldPath !== undefined && req.oldPath !== req.path) {
    const from = checkRelPath(req.oldPath, 'oldPath');
    if (!from.ok) return from;
    oldPath = from.path;
  }
  const { top, group, algorithm, path } = req;

  const [state, indexRun, head] = await Promise.all([
    loadAttrs(top, path),
    runGit(top, ['ls-files', '-s', '-z', '--', path]),
    group === 'staged' ? readHeadEntry(top, oldPath ?? path) : Promise.resolve(null),
  ]);
  if (isFailure(state)) return state;
  if (!indexRun.ok) return gitFailure(indexRun, 'ls-files');
  if (head && !head.ok) return head;

  const { context, core } = state;
  const here = parseLsFiles(indexRun.stdout).filter((e) => e.path === path);
  const indexEntry = here.find((e) => e.stage === 0) ?? null;

  if (here.length > 0 && indexEntry === null) {
    return {
      ok: true,
      snapshot: assemble({
        req,
        oldPath,
        old: { id: 'absent', text: '' },
        new: { id: 'absent', text: '' },
        hunks: [],
        flags: { unmerged: true },
        modes: {},
        attrs: {},
      }),
    };
  }

  const oldEntry = group === 'staged' ? (head?.ok ? head.entry : null) : indexEntry;
  const converted = isConvertedByGit(context);

  if (converted) {
    const newEntry = group === 'staged' ? indexEntry : null;
    return {
      ok: true,
      snapshot: assemble({
        req,
        oldPath,
        old: { id: oldEntry?.oid ?? 'absent', text: '' },
        new: { id: group === 'staged' ? (newEntry?.oid ?? 'absent') : 'converted', text: '' },
        hunks: [],
        flags: { converted: true },
        modes: modesOf(oldEntry?.mode ?? null, newEntry?.mode ?? null),
        attrs: context,
      }),
    };
  }

  const oldSide = oldEntry ? await readBlobSide(top, oldEntry) : ABSENT_SIDE;
  if (isFailure(oldSide)) return oldSide;

  let newSide: Side;
  let newBytes: Buffer | null;
  let work: WorkRead | null = null;
  let attrs: AttrContext = context;
  let decisionBytes: Buffer | null = null;

  if (group === 'staged') {
    const side = indexEntry ? await readBlobSide(top, indexEntry) : ABSENT_SIDE;
    if (isFailure(side)) return side;
    newSide = side;
    newBytes = side.bytes;
  } else {
    work = await readWorkTree(top, path);
    if (isFailure(work)) return work;
    switch (work.kind) {
      case 'absent':
        newSide = ABSENT_SIDE;
        newBytes = null;
        break;
      case 'big':
        newSide = { id: `toolarge:${work.stamp}`, mode: workMode(work.exec, core.fileMode, indexEntry), bytes: null, big: true };
        newBytes = null;
        break;
      case 'link':
        newSide = { id: '', mode: '120000', bytes: work.bytes, big: false };
        newBytes = work.bytes;
        attrs = { ...context, convert: 'off' };
        break;
      case 'file': {
        // Only a regular index entry counts as "the index blob" for git's CRLF guard.
        const indexBlob =
          indexEntry && (indexEntry.mode === '100644' || indexEntry.mode === '100755') ? oldSide.bytes : null;
        const decision = eolDecision(context, core.autocrlf, work.bytes, indexBlob);
        decisionBytes = decision.convert ? crlfToLf(work.bytes) : work.bytes;
        attrs = { ...context, convert: decision.convert ? 'on' : decision.why };
        newSide = { id: '', mode: workMode(work.exec, core.fileMode, indexEntry), bytes: decisionBytes, big: false };
        newBytes = decisionBytes;
        break;
      }
    }
  }

  const modes = modesOf(oldSide.mode, newSide.mode);

  if (oldSide.big || newSide.big) {
    return {
      ok: true,
      snapshot: assemble({
        req,
        oldPath,
        old: { id: oldSide.id, text: '' },
        new: { id: newSide.id, text: '' },
        hunks: [],
        flags: { tooLarge: true },
        modes,
        attrs,
      }),
    };
  }

  if (work && newBytes !== null) {
    const id = await hashBlob(top, newBytes);
    if (isFailure(id)) return id;
    newSide = { ...newSide, id };
  }

  const diffAttr = context['diff'];
  const binary = diffAttr === 'unset' || (diffAttr !== 'set' && (hasNul(oldSide.bytes) || hasNul(newBytes)));
  const oldText = oldSide.bytes?.toString('utf8') ?? '';
  const newText = newBytes?.toString('utf8') ?? '';

  let hunks: ScmHunk[] = [];
  if (!binary && (oldSide.bytes ?? EMPTY).compare(newBytes ?? EMPTY) !== 0) {
    const diff = await gitDiff(oldSide.bytes ?? EMPTY, newBytes ?? EMPTY, algorithm, diffAttr === 'set');
    if (!diff.ok) return diff;
    hunks = diff.hunks;
  }

  let token: string | undefined;
  if (work && (work.kind !== 'absent' || indexEntry !== null)) {
    token = putToken({
      top,
      path,
      mode: newSide.mode,
      id: newSide.id,
      bytes: newBytes ?? EMPTY,
      context,
    });
  }

  return {
    ok: true,
    snapshot: assemble({
      req,
      oldPath,
      old: { id: oldSide.id, text: binary ? '' : oldText },
      new: { id: newSide.id, text: binary ? '' : newText },
      hunks,
      flags: { binary },
      modes,
      attrs,
      token,
    }),
  };
}

/**
 * The mode `git add` would record for a work tree file. With `core.fileMode`
 * off git keeps the index's own mode for a tracked regular file.
 */
function workMode(exec: boolean, trustExecutableBit: boolean, indexEntry: IndexEntry | null): string {
  if (!trustExecutableBit) {
    return indexEntry && (indexEntry.mode === '100644' || indexEntry.mode === '100755')
      ? indexEntry.mode
      : '100644';
  }
  return exec ? '100755' : '100644';
}
