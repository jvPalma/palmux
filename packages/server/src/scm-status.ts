// ── Source Control: status ────────────────────────────────────────────────────
//
// `git status --porcelain=v2 -z` parsed into the three groups the view lists,
// with line counts from `--numstat`, a fingerprint per entry, and the
// `attrEpoch` that tells a review its loaded files may now render differently.
// Concurrent requests for one repository share one read, and its answer is
// cached for 500 ms, so two windows cost one set of git processes.

import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { ScmEntry, ScmEntryKind, ScmStatus } from '@palmux/shared';
import {
  gitFailure,
  homeDir,
  parseLsFiles,
  runGit,
  scmFail,
  xdgConfigDir,
  type GitResult,
  type ScmFailure,
} from './scm-git';

export const STATUS_ENTRY_LIMIT = 5000;
export const STATUS_CACHE_MS = 500;
const STATUS_MAX_BUFFER = 32 * 1024 * 1024;
const LS_FILES_MAX_BUFFER = 64 * 1024 * 1024;
const LSTAT_CONCURRENCY = 64;

/** `commentsRev` is not here: it changes independently of git, so the route adds it per response. */
export type ScmStatusCore = Omit<ScmStatus, 'commentsRev'>;
export type StatusResult = { ok: true; status: ScmStatusCore } | ScmFailure;

// ── Porcelain v2 ──────────────────────────────────────────────────────────────

type Group = 'merge' | 'staged' | 'changes';

export interface RawEntry {
  group: Group;
  path: string;
  oldPath?: string;
  kind: ScmEntryKind;
  status: ScmEntry['status'];
  /** Every mode git printed for the record, in its order (HEAD, index, work tree; or the three stages and the work tree). */
  modes: string[];
  oids: string[];
}

export interface RawStatus {
  branch?: string;
  head?: string;
  unborn: boolean;
  merge: RawEntry[];
  staged: RawEntry[];
  changes: RawEntry[];
  truncated: boolean;
}

function statusLetter(ch: string | undefined): ScmEntry['status'] {
  switch (ch) {
    case 'A':
    case 'D':
    case 'R':
    case 'T':
    case 'U':
      return ch;
    // A copy is not a wire status; the new path is shown as the addition it is.
    case 'C':
      return 'A';
    default:
      return 'M';
  }
}

/** The first `count` space-separated fields, then everything after them (a path may hold spaces). */
function splitLeading(record: string, count: number): string[] | null {
  const out: string[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const space = record.indexOf(' ', at);
    if (space < 0) return null;
    out.push(record.slice(at, space));
    at = space + 1;
  }
  out.push(record.slice(at));
  return out;
}

/** `cutOff` says the output was cut by the buffer cap: the partial last field is dropped and the result is `truncated`. */
export function parsePorcelainV2(buf: Buffer, limit: number, cutOff = false): RawStatus {
  const result: RawStatus = { unborn: false, merge: [], staged: [], changes: [], truncated: cutOff };
  const fields = buf.toString('utf8').split('\0');
  // Complete output ends with a NUL, so the last field is empty; a cut one ends in a partial field.
  fields.pop();
  let count = 0;

  for (let i = 0; i < fields.length; i++) {
    const record = fields[i] as string;
    if (record === '') continue;

    if (record.startsWith('# ')) {
      const space = record.indexOf(' ', 2);
      const key = record.slice(2, space);
      const value = record.slice(space + 1);
      if (key === 'branch.oid') {
        if (value === '(initial)') result.unborn = true;
        else result.head = value;
      } else if (key === 'branch.head' && value !== '(detached)') {
        result.branch = value;
      }
      continue;
    }

    if (count >= limit) {
      result.truncated = true;
      break;
    }

    const type = record[0];
    if (type === '?') {
      result.changes.push({
        group: 'changes',
        path: record.slice(2),
        kind: 'untracked',
        status: '?',
        modes: [],
        oids: [],
      });
      count += 1;
    } else if (type === '1') {
      const f = splitLeading(record, 8);
      if (!f) continue;
      const xy = f[1] ?? '..';
      const base = { modes: [f[3], f[4], f[5]] as string[], oids: [f[6], f[7]] as string[], path: f[8] as string };
      if (xy[0] !== '.') {
        result.staged.push({ ...base, group: 'staged', kind: 'ordinary', status: statusLetter(xy[0]) });
        count += 1;
      }
      if (xy[1] !== '.') {
        result.changes.push({ ...base, group: 'changes', kind: 'ordinary', status: statusLetter(xy[1]) });
        count += 1;
      }
    } else if (type === '2') {
      const f = splitLeading(record, 9);
      const oldPath = fields[i + 1];
      if (!f || oldPath === undefined) break;
      i += 1;
      const xy = f[1] ?? '..';
      const path = f[9] as string;
      const base = { modes: [f[3], f[4], f[5]] as string[], oids: [f[6], f[7]] as string[], path };
      if (xy[0] !== '.') {
        const rename = xy[0] === 'R';
        result.staged.push({
          ...base,
          group: 'staged',
          kind: rename ? 'rename' : 'ordinary',
          status: statusLetter(xy[0]),
          ...(rename ? { oldPath } : {}),
        });
        count += 1;
      }
      if (xy[1] !== '.') {
        const rename = xy[1] === 'R';
        result.changes.push({
          ...base,
          group: 'changes',
          kind: rename ? 'rename' : 'ordinary',
          status: statusLetter(xy[1]),
          ...(rename ? { oldPath } : {}),
        });
        count += 1;
      }
    } else if (type === 'u') {
      const f = splitLeading(record, 10);
      if (!f) continue;
      result.merge.push({
        group: 'merge',
        path: f[10] as string,
        kind: 'unmerged',
        status: 'U',
        modes: [f[3], f[4], f[5], f[6]] as string[],
        oids: [f[7], f[8], f[9]] as string[],
      });
      count += 1;
    }
  }
  return result;
}

// ── numstat ───────────────────────────────────────────────────────────────────

export interface NumstatRecord {
  /** The new path of a rename. */
  path: string;
  added?: number;
  removed?: number;
  binary: boolean;
}

/**
 * `diff --numstat -z`: `<added>\t<removed>\t<path>\0`, binary as `-`. A rename is
 * `<added>\t<removed>\t\0<old>\0<new>\0`: the path field is empty and the two
 * paths follow as their own NUL-terminated fields.
 */
export function parseNumstat(buf: Buffer): NumstatRecord[] {
  const fields = buf.toString('utf8').split('\0');
  fields.pop();
  const records: NumstatRecord[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] as string;
    const first = field.indexOf('\t');
    const second = first < 0 ? -1 : field.indexOf('\t', first + 1);
    if (second < 0) continue;
    const added = field.slice(0, first);
    const removed = field.slice(first + 1, second);
    let path = field.slice(second + 1);
    if (path === '') {
      path = fields[i + 2] ?? '';
      i += 2;
    }
    const binary = added === '-' || removed === '-';
    records.push(
      binary
        ? { path, binary }
        : { path, added: Number(added), removed: Number(removed), binary },
    );
  }
  return records;
}

// ── Fingerprints and the read ─────────────────────────────────────────────────

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const at = next++;
      results[at] = await fn(items[at] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** One `lstat`: ctime catches a same-size replacement that kept its mtime, the mode a chmod. */
async function statTuple(path: string): Promise<string> {
  try {
    const st = await lstat(path);
    return `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.mode}`;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : `error:${code}`;
  }
}

function digest(parts: readonly string[]): string {
  return createHash('sha1').update(parts.join('\0')).digest('hex').slice(0, 16);
}

/** Staged entries compare blobs only; the other groups also read the work tree side. */
async function fingerprint(top: string, raw: RawEntry): Promise<string> {
  const work = raw.group === 'staged' ? '' : await statTuple(join(top, raw.path));
  return digest([raw.group, raw.kind, raw.status, ...raw.modes, ...raw.oids, raw.oldPath ?? '', work]);
}

async function toEntries(
  top: string,
  raws: readonly RawEntry[],
  counts: ReadonlyMap<string, NumstatRecord>,
): Promise<ScmEntry[]> {
  const entries = await mapLimit(raws, LSTAT_CONCURRENCY, async (raw): Promise<ScmEntry> => {
    const count = raw.kind === 'untracked' || raw.kind === 'unmerged' ? undefined : counts.get(raw.path);
    return {
      path: raw.path,
      ...(raw.oldPath === undefined ? {} : { oldPath: raw.oldPath }),
      kind: raw.kind,
      status: raw.status,
      ...(count?.binary ? { binary: true } : {}),
      ...(count && !count.binary ? { added: count.added as number, removed: count.removed as number } : {}),
      fp: await fingerprint(top, raw),
    };
  });
  return entries.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ── attrEpoch ─────────────────────────────────────────────────────────────────

interface AttributeFiles {
  [path: string]: string;
}
const attributeFileCache = new Map<string, { sig: string; files: AttributeFiles }>();

/**
 * Every `.gitattributes` the index knows, by oid. The full `ls-files` output is
 * filtered here by basename: under literal pathspecs a `:(glob)` pattern would
 * match nothing. It is re-read only when the index file itself changed.
 */
async function indexedAttributeFiles(
  top: string,
  indexPath: string,
): Promise<{ files: AttributeFiles; cut: boolean }> {
  const sig = await statTuple(indexPath);
  const cached = attributeFileCache.get(top);
  if (cached && cached.sig === sig) return { files: cached.files, cut: false };

  const run = await runGit(top, ['ls-files', '-s', '-z'], { maxBuffer: LS_FILES_MAX_BUFFER });
  const buf = run.ok ? run.stdout : run.reason === 'truncated' ? run.stdout : Buffer.alloc(0);
  const files: AttributeFiles = {};
  for (const entry of parseLsFiles(buf)) {
    if (basename(entry.path) !== '.gitattributes') continue;
    files[entry.path] = `${files[entry.path] ?? ''}${entry.oid},`;
  }
  const cut = !run.ok && run.reason === 'truncated';
  if (run.ok) attributeFileCache.set(top, { sig, files });
  return { files, cut };
}

function expandHome(value: string): string {
  return value === '~' || value.startsWith('~/') ? join(homeDir(), value.slice(1)) : value;
}

/**
 * A hash of everything that can change how a path is converted or compared:
 * each `.gitattributes` git could read (index oid plus work tree lstat; a new
 * untracked one counts, as git reads the work tree copy first), the repository's
 * `info/attributes`, the global attributes file, and the config files' mtime and
 * size. When it moves, a review refetches every loaded file.
 */
async function computeAttrEpoch(
  top: string,
  gitPaths: { index: string; info: string; config: string },
  statusPaths: Iterable<string>,
  attributesFile: string | null,
): Promise<string> {
  const indexed = await indexedAttributeFiles(top, gitPaths.index);
  const paths = new Set(Object.keys(indexed.files));
  for (const path of statusPaths) if (basename(path) === '.gitattributes') paths.add(path);

  const parts: string[] = [indexed.cut ? 'ls-files-cut' : 'ls-files'];
  for (const path of [...paths].toSorted()) {
    parts.push(`${path}\t${indexed.files[path] ?? '-'}\t${await statTuple(join(top, path))}`);
  }
  const extra = [
    gitPaths.info,
    attributesFile ?? join(xdgConfigDir(), 'git', 'attributes'),
    gitPaths.config,
    join(homeDir(), '.gitconfig'),
    join(xdgConfigDir(), 'git', 'config'),
  ];
  for (const path of extra) parts.push(`${path}\t${await statTuple(path)}`);
  return digest(parts);
}

// ── The read ──────────────────────────────────────────────────────────────────

/** `--numstat` of a huge or binary diff can be slow; missing counts beat a missing list. */
function countsOf(run: GitResult): Map<string, NumstatRecord> {
  const map = new Map<string, NumstatRecord>();
  const buf = run.ok ? run.stdout : run.reason === 'truncated' ? run.stdout : Buffer.alloc(0);
  const parsed = parseNumstat(buf);
  // A truncated numstat can end mid-record; the last record is not trusted.
  if (!run.ok && run.reason === 'truncated') parsed.pop();
  for (const record of parsed) map.set(record.path, record);
  return map;
}

async function readStatus(top: string): Promise<StatusResult> {
  const started = performance.now();
  const diffFlags = ['--numstat', '-z', '--no-ext-diff', '--no-textconv', '--no-color'];
  const [status, unstaged, staged, gitPaths, attributesConfig] = await Promise.all([
    runGit(
      top,
      [
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
        '--branch',
        '--renames',
        '--no-ahead-behind',
      ],
      { maxBuffer: STATUS_MAX_BUFFER },
    ),
    // `diff-files`, not `diff`: `git diff` refreshes the index under its lock even with
    // --no-optional-locks (measured), which could fail a commit running at the same moment.
    runGit(top, ['diff-files', ...diffFlags], { maxBuffer: STATUS_MAX_BUFFER }),
    runGit(top, ['diff', '--cached', ...diffFlags, '-M'], { maxBuffer: STATUS_MAX_BUFFER }),
    runGit(top, [
      'rev-parse',
      '--git-path',
      'index',
      '--git-path',
      'info/attributes',
      '--git-path',
      'config',
    ]),
    runGit(top, ['config', '-z', '--get', 'core.attributesfile'], { okCodes: [0, 1] }),
  ]);

  const cutOff = !status.ok && status.reason === 'truncated';
  if (!status.ok && !cutOff) return gitFailure(status, 'status');
  if (!gitPaths.ok) return gitFailure(gitPaths, 'status');
  const [index, info, config] = gitPaths.stdout
    .toString('utf8')
    .split('\n')
    .map((p) => (isAbsolute(p) ? p : resolve(top, p)));
  if (index === undefined || info === undefined || config === undefined) {
    return scmFail(500, 'status: unexpected rev-parse output');
  }

  const raw = parsePorcelainV2(status.stdout, STATUS_ENTRY_LIMIT, cutOff);
  const unstagedCounts = countsOf(unstaged);
  const stagedCounts = countsOf(staged);
  const [merge, stagedEntries, changes] = await Promise.all([
    toEntries(top, raw.merge, new Map()),
    toEntries(top, raw.staged, stagedCounts),
    toEntries(top, raw.changes, unstagedCounts),
  ]);

  let attributesFile: string | null = null;
  if (attributesConfig.ok) {
    const configured = attributesConfig.stdout.toString('utf8').split('\0')[0] ?? '';
    if (configured !== '') attributesFile = resolve(top, expandHome(configured));
  }
  const attrEpoch = await computeAttrEpoch(
    top,
    { index, info, config },
    [...raw.merge, ...raw.staged, ...raw.changes].map((e) => e.path),
    attributesFile,
  );

  return {
    ok: true,
    status: {
      top,
      ...(raw.branch === undefined ? {} : { branch: raw.branch }),
      ...(raw.head === undefined ? {} : { head: raw.head }),
      unborn: raw.unborn,
      merge,
      staged: stagedEntries,
      changes,
      truncated: raw.truncated,
      tookMs: Math.round(performance.now() - started),
      attrEpoch,
    },
  };
}

// ── Coalescing ────────────────────────────────────────────────────────────────

interface Slot {
  /** Bumped by `invalidateStatus`, so a read that started before a write never caches its answer. */
  generation: number;
  inflight: Promise<StatusResult> | undefined;
  cached: { at: number; result: StatusResult } | undefined;
}
const slots = new Map<string, Slot>();

/**
 * `top` must already have passed `checkRepo`. The result is shared: callers
 * copy it (`{ ...status, commentsRev }`) rather than change it.
 */
export function getStatus(top: string): Promise<StatusResult> {
  let slot = slots.get(top);
  if (!slot) {
    slot = { generation: 0, inflight: undefined, cached: undefined };
    slots.set(top, slot);
  }
  const current = slot;
  if (current.cached && Date.now() - current.cached.at < STATUS_CACHE_MS) {
    return Promise.resolve(current.cached.result);
  }
  if (current.inflight) return current.inflight;

  const generation = current.generation;
  const read: Promise<StatusResult> = readStatus(top)
    .then((result) => {
      if (result.ok && current.generation === generation) {
        current.cached = { at: Date.now(), result };
      }
      return result;
    })
    .finally(() => {
      if (current.inflight === read) current.inflight = undefined;
    });
  current.inflight = read;
  return read;
}

/** A write calls this, so the next poll reflects it. */
export function invalidateStatus(top: string): void {
  const slot = slots.get(top);
  if (!slot) return;
  slot.generation += 1;
  slot.cached = undefined;
  slot.inflight = undefined;
}
