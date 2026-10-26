// ── Source Control: the git runner and the request checks ─────────────────────
//
// Every git process the Source Control routes start goes through `runGit`: argv
// arrays only, never a shell, a clean environment, literal pathspecs, a time
// limit and an output limit. The request checks (`checkRepo`, `checkRelPath`)
// live here too, so a route cannot name a path the runner would then misread.

import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ScmErrorCode } from '@palmux/shared';

export const GIT_TIMEOUT_MS = 10_000;
export const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/** What a route answers with: an HTTP status and the `{ error, code }` body. */
export interface ScmFailure {
  ok: false;
  status: number;
  error: string;
  code?: ScmErrorCode;
}

export function scmFail(status: number, error: string, code?: ScmErrorCode): ScmFailure {
  return code === undefined ? { ok: false, status, error } : { ok: false, status, error, code };
}

export interface GitRunOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  /** Written to the process's stdin, then closed. */
  input?: Buffer | string;
  /** Exit codes that count as success (`diff --no-index` exits 1 when the sides differ). */
  okCodes?: readonly number[];
  /** Layered over the clean base, for `GIT_INDEX_FILE` and the diff isolation. */
  env?: Readonly<Record<string, string>>;
}

export type GitFailureReason = 'timeout' | 'truncated' | 'exit' | 'spawn';

export type GitResult =
  | { ok: true; code: number; stdout: Buffer; stderr: string }
  | {
      ok: false;
      reason: GitFailureReason;
      code: number | null;
      /** Whatever arrived before a timeout or an output cut. */
      stdout: Buffer;
      stderr: string;
      message: string;
    };

type GitObserver = (args: readonly string[]) => void;
let observer: GitObserver | null = null;

/** Tests count the processes a read costs through this; production never sets it. */
export function setGitObserver(fn: GitObserver | null): void {
  observer = fn;
}

export function homeDir(): string {
  return process.env['HOME'] || homedir();
}

export function xdgConfigDir(): string {
  return process.env['XDG_CONFIG_HOME'] || join(homeDir(), '.config');
}

/**
 * Built from scratch on each call, not inherited. `GIT_DIFF_OPTS` would
 * override `-U`, and `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE` and
 * `GIT_CONFIG_PARAMETERS` would redirect or reshape a command. `XDG_CONFIG_HOME`
 * stays because git's global config and default attributes file live under it.
 */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env['PATH'] || '/usr/local/bin:/usr/bin:/bin',
    HOME: homeDir(),
    LC_ALL: 'C',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const xdg = process.env['XDG_CONFIG_HOME'];
  if (xdg) env['XDG_CONFIG_HOME'] = xdg;
  const tmp = process.env['TMPDIR'];
  if (tmp) env['TMPDIR'] = tmp;
  return env;
}

// `core.fsmonitor=false` keeps a read from starting a daemon that writes into .git.
const FIXED_ARGS = [
  '--no-optional-locks',
  '--literal-pathspecs',
  '-c',
  'core.quotepath=false',
  '-c',
  'core.fsmonitor=false',
];

/** Kills the whole group: a hook or filter git started must not outlive the timeout. */
function killTree(pid: number | undefined, fallback: () => void): void {
  try {
    if (pid === undefined) throw new Error('no pid');
    process.kill(-pid, 'SIGKILL');
  } catch {
    fallback();
  }
}

export function runGit(
  cwd: string,
  args: readonly string[],
  opts: GitRunOptions = {},
): Promise<GitResult> {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? GIT_MAX_BUFFER;
  const okCodes = opts.okCodes ?? [0];
  observer?.(args);

  return new Promise<GitResult>((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let truncated = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: GitResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const failure = (
      reason: GitFailureReason,
      code: number | null,
      message: string,
    ): GitResult => ({
      ok: false,
      reason,
      code,
      stdout: Buffer.concat(out),
      stderr: Buffer.concat(err).toString('utf8'),
      message,
    });

    let child;
    try {
      child = spawn('git', ['-C', cwd, ...FIXED_ARGS, ...args], {
        env: { ...baseEnv(), ...opts.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (e) {
      finish(failure('spawn', null, e instanceof Error ? e.message : String(e)));
      return;
    }
    const kill = (): void => killTree(child.pid, () => child.kill('SIGKILL'));

    timer = setTimeout(() => {
      kill();
      finish(failure('timeout', null, `git ${args[0] ?? ''} timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      if (outBytes + chunk.length > maxBuffer) {
        out.push(chunk.subarray(0, maxBuffer - outBytes));
        outBytes = maxBuffer;
        truncated = true;
        kill();
        return;
      }
      out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.concat(err).length < 64 * 1024) err.push(chunk);
    });
    // git can exit before reading its stdin; the exit status is the answer then.
    child.stdin.on('error', () => {});
    child.on('error', (e) => finish(failure('spawn', null, e.message)));
    child.on('close', (code) => {
      if (truncated) {
        finish(failure('truncated', code, `git ${args[0] ?? ''} output exceeded ${maxBuffer} bytes`));
        return;
      }
      if (code !== null && okCodes.includes(code)) {
        finish({
          ok: true,
          code,
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(err).toString('utf8'),
        });
        return;
      }
      const detail = Buffer.concat(err).toString('utf8').trim().split('\n')[0] ?? '';
      finish(failure('exit', code, `git ${args[0] ?? ''} failed (${code}): ${detail}`));
    });

    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** A git failure as the answer a route sends. */
export function gitFailure(
  result: Extract<GitResult, { ok: false }>,
  what: string,
): ScmFailure {
  switch (result.reason) {
    case 'timeout':
      return scmFail(504, `${what}: git timed out`);
    case 'truncated':
      return scmFail(413, `${what}: git output exceeded the limit`);
    case 'spawn':
      return scmFail(500, `${what}: cannot run git (${result.message})`);
    case 'exit':
      return scmFail(500, `${what}: ${result.message}`);
  }
}

// ── Repository and path checks ────────────────────────────────────────────────

export type RepoResult = { ok: true; top: string } | ScmFailure;

/** `trim()` only detects a blank value; the value itself is used exactly as given. */
function checkAbsolute(value: unknown, what: string): ScmFailure | null {
  if (typeof value !== 'string' || value.trim() === '') return scmFail(400, `${what} is required`);
  if (value.includes('\0')) return scmFail(400, `${what} must not contain a NUL byte`);
  if (!isAbsolute(value)) return scmFail(400, `${what} must be absolute`);
  return null;
}

/**
 * The canonical work tree top of `path`, or a 400 that names the reason.
 * `isAbsolute` runs on the raw string, before anything resolves it.
 */
export async function resolveRepo(path: unknown): Promise<RepoResult> {
  const bad = checkAbsolute(path, 'path');
  if (bad) return bad;
  const dir = path as string;
  let info;
  try {
    info = await stat(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return scmFail(400, code === 'ENOENT' ? 'path does not exist' : `cannot read path (${code})`);
  }
  if (!info.isDirectory()) return scmFail(400, 'path is not a directory');

  const run = await runGit(dir, ['rev-parse', '--show-toplevel']);
  if (!run.ok) {
    if (run.reason === 'spawn') return scmFail(500, 'git is not available on this server');
    if (run.reason !== 'exit') return gitFailure(run, 'repository');
    if (/dubious ownership/i.test(run.stderr)) {
      return scmFail(400, 'git refuses this repository (it belongs to another user)');
    }
    if (/must be run in a work tree/i.test(run.stderr)) {
      return scmFail(400, 'path is not inside a git work tree');
    }
    return scmFail(400, 'path is not a git repository');
  }
  const top = run.stdout.toString('utf8').replace(/\n$/, '');
  if (top === '') return scmFail(400, 'path is not inside a git work tree');
  try {
    return { ok: true, top: await realpath(top) };
  } catch {
    return scmFail(400, 'path is not a git repository');
  }
}

/** Every request names its project by the work tree's own top level, never a subfolder of it. */
export async function checkRepo(repo: unknown): Promise<RepoResult> {
  const bad = checkAbsolute(repo, 'repo');
  if (bad) return bad;
  const resolved = await resolveRepo(repo);
  if (!resolved.ok) return resolved;
  if (resolved.top !== repo) {
    return scmFail(400, `repo must be the work tree's top level (${resolved.top})`);
  }
  return resolved;
}

export type RelPathResult = { ok: true; path: string } | ScmFailure;

/**
 * A repository-relative path, used exactly as given: no trimming and no
 * normalising, so `a*.ts`, `2:config.ts` and `report ` stay what they are. A
 * `.` or `..` component is refused rather than resolved, because the work tree
 * walk never calls `resolve`, and `a/../b` through a symlinked `a` is not `b`.
 */
export function checkRelPath(value: unknown, what = 'path'): RelPathResult {
  if (typeof value !== 'string' || value.trim() === '') return scmFail(400, `${what} is required`);
  if (value.includes('\0')) return scmFail(400, `${what} must not contain a NUL byte`);
  if (isAbsolute(value)) return scmFail(400, `${what} must be relative to the repository`);
  for (const part of value.split('/')) {
    if (part === '' || part === '.' || part === '..') {
      return scmFail(400, `${what} must stay inside the repository`);
    }
    if (part.toLowerCase() === '.git') {
      return scmFail(400, `${what} must not name git's own directory`);
    }
  }
  return { ok: true, path: value };
}

// ── Output parsers shared by the status, snapshot and index modules ───────────

export interface IndexEntry {
  mode: string;
  oid: string;
  stage: number;
  path: string;
}

/** `ls-files -s -z`: `<mode> <oid> <stage>\t<path>\0`. */
export function parseLsFiles(buf: Buffer): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const record of buf.toString('utf8').split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, oid, stage] = record.slice(0, tab).split(' ');
    if (mode === undefined || oid === undefined || stage === undefined) continue;
    entries.push({ mode, oid, stage: Number(stage), path: record.slice(tab + 1) });
  }
  return entries;
}

export interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  path: string;
}

/** `ls-tree -z`: `<mode> <type> <oid>\t<path>\0`. */
export function parseLsTree(buf: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of buf.toString('utf8').split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    if (mode === undefined || type === undefined || oid === undefined) continue;
    entries.push({ mode, type, oid, path: record.slice(tab + 1) });
  }
  return entries;
}

export type HeadResult = { ok: true; oid: string | null } | ScmFailure;

/** The HEAD commit, or `oid: null` for an unborn branch (which is never handed to `ls-tree`). */
export async function readHead(top: string): Promise<HeadResult> {
  const run = await runGit(top, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [0, 1] });
  if (!run.ok) return gitFailure(run, 'HEAD');
  return { ok: true, oid: run.code === 0 ? run.stdout.toString('utf8').trim() : null };
}

export type HeadEntryResult = { ok: true; entry: TreeEntry | null } | ScmFailure;

/**
 * HEAD's blob (or gitlink) at exactly `path`. A tree there counts as absent: the
 * path was a directory in HEAD, which has no content to compare.
 */
export async function readHeadEntry(top: string, path: string): Promise<HeadEntryResult> {
  const head = await readHead(top);
  if (!head.ok) return head;
  if (head.oid === null) return { ok: true, entry: null };
  const run = await runGit(top, ['ls-tree', '-z', 'HEAD', '--', path]);
  if (!run.ok) return gitFailure(run, 'ls-tree');
  const entry = parseLsTree(run.stdout).find((e) => e.path === path && e.type !== 'tree');
  return { ok: true, entry: entry ?? null };
}
