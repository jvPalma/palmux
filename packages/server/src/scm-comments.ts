// ── Review comments store ─────────────────────────────────────────────────────
//
// One JSON file per project under <configDir>/.cache/scm/, named by the first 16
// hex digits of sha256(top). Comments live here and never inside the repository,
// so `git status` in a project never shows them. `.cache/.gitignore` holds `*`,
// which keeps a dotfiles-tracked config dir from picking them up without touching
// the user's own root .gitignore (see the source-control-review design, D9).
//
// Every operation is one read-modify-write under a per-file in-process mutex,
// committed with a temp file and a rename, so two windows can never clobber each
// other. Each write bumps `rev`, and every operation answers with the WHOLE list
// and its rev: a client replaces its state with the answer, so it never holds a
// rev whose changes it has not applied.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import {
  isScmCommentSide,
  isScmCommentVersion,
  SCM_COMMENT_LIMITS,
  type ScmComment,
  type ScmCommentInput,
  type ScmCommentList,
} from '@palmux/shared';
import { configDir, ensureConfigDir } from './config';

/** A refused operation. `status` is the HTTP code a route answers with. */
export class ScmCommentError extends Error {
  readonly status: 400 | 404;

  constructor(status: 400 | 404, message: string) {
    super(message);
    this.name = 'ScmCommentError';
    this.status = status;
  }
}

const LIMITS = SCM_COMMENT_LIMITS;

const FIELDS = [
  'path',
  'version',
  'side',
  'start',
  'end',
  'lines',
  'before',
  'after',
  'body',
] as const;

function reject(message: string): never {
  throw new ScmCommentError(400, message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function stringList(value: unknown, name: string, max: number): string[] {
  if (!Array.isArray(value)) return reject(`${name} must be an array of strings`);
  if (value.length > max) return reject(`${name} has more than ${max} entries`);
  if (!value.every((item): item is string => typeof item === 'string')) {
    return reject(`${name} must be an array of strings`);
  }
  return value;
}

/** Validate every field of a comment's content. Unknown keys are ignored. */
function validateInput(raw: unknown): ScmCommentInput {
  if (!isRecord(raw)) return reject('comment must be an object');

  const path = raw['path'];
  if (typeof path !== 'string' || path === '') return reject('path is required');
  if (path.length > LIMITS.pathChars) return reject('path is too long');
  if (path.includes('\0')) return reject('path must not contain NUL');
  if (path.startsWith('/')) return reject('path must be relative to the repository');
  if (path.split('/').includes('..')) return reject('path must stay inside the repository');

  const version = raw['version'];
  if (!isScmCommentVersion(version)) return reject('version must be head, index or worktree');
  const side = raw['side'];
  if (!isScmCommentSide(side)) return reject('side must be old or new');

  const start = raw['start'];
  const end = raw['end'];
  if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 1) {
    return reject('start must be an integer of at least 1');
  }
  if (typeof end !== 'number' || !Number.isSafeInteger(end) || end < start) {
    return reject('end must be an integer, not before start');
  }

  const lines = stringList(raw['lines'], 'lines', LIMITS.lines);
  if (lines.length !== end - start + 1)
    return reject('lines must hold one entry per line of the range');
  const before = stringList(raw['before'], 'before', LIMITS.context);
  const after = stringList(raw['after'], 'after', LIMITS.context);
  const textBytes = [...lines, ...before, ...after].reduce(
    (sum, line) => sum + Buffer.byteLength(line),
    0,
  );
  if (textBytes > LIMITS.textBytes) return reject('the commented code is too large');

  const body = raw['body'];
  if (typeof body !== 'string') return reject('body must be a string');
  if (Buffer.byteLength(body) > LIMITS.bodyBytes) return reject('body is too large');

  return { path, version, side, start, end, lines, before, after, body };
}

/** `current` with the patch's fields replaced, validated as a whole. */
function applyPatch(current: ScmComment, patch: unknown): ScmCommentInput {
  if (!isRecord(patch)) return reject('patch must be an object');
  const changed = FIELDS.filter((field) => Object.hasOwn(patch, field));
  if (changed.length === 0) return reject('nothing to update');
  const merged: Record<string, unknown> = {};
  for (const field of FIELDS) merged[field] = current[field];
  for (const field of changed) merged[field] = patch[field];
  return validateInput(merged);
}

/** A comment read back from disk, or null when it no longer passes validation. */
function storedComment(raw: unknown): ScmComment | null {
  if (!isRecord(raw)) return null;
  const { id, createdAt, updatedAt } = raw;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof createdAt !== 'number' || typeof updatedAt !== 'number') return null;
  try {
    return { id, ...validateInput(raw), createdAt, updatedAt };
  } catch (error) {
    if (error instanceof ScmCommentError) return null;
    throw error;
  }
}

interface Stored {
  rev: number;
  comments: ScmComment[];
}

// A missing or corrupt file reads as an empty project, the way tabs.json and
// extra-keys.json do: nothing here is worth failing a request over.
function parseStored(text: string): Stored {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { rev: 0, comments: [] };
  }
  if (!isRecord(raw) || !Array.isArray(raw['comments'])) return { rev: 0, comments: [] };
  const rev = raw['rev'];
  return {
    rev: typeof rev === 'number' && Number.isSafeInteger(rev) && rev >= 0 ? rev : 0,
    comments: raw['comments'].flatMap((item) => storedComment(item) ?? []),
  };
}

function storePath(top: string): string {
  if (!isAbsolute(top) || top.includes('\0')) {
    throw new ScmCommentError(400, 'repo must be an absolute path');
  }
  const key = createHash('sha256').update(top).digest('hex').slice(0, 16);
  return join(configDir(), '.cache', 'scm', `${key}.json`);
}

async function readStored(file: string): Promise<Stored> {
  try {
    return parseStored(await readFile(file, 'utf8'));
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { rev: 0, comments: [] };
    throw error;
  }
}

/** Create the store directory, and the `.cache/.gitignore` that keeps it out of git. */
async function ensureStoreDir(file: string): Promise<void> {
  const scmDir = dirname(file);
  ensureConfigDir();
  await mkdir(scmDir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(join(dirname(scmDir), '.gitignore'), '*\n', { flag: 'wx' });
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
  }
}

async function writeStored(file: string, top: string, data: Stored): Promise<void> {
  await ensureStoreDir(file);
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ v: 1, repo: top, ...data })}\n`, { mode: 0o600 });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

// The newest rev this process has seen per store file: what a status answer
// reports as `commentsRev` without reading the disk.
const knownRevs = new Map<string, number>();

// Store files `latestRev` has already warned about.
const unreadableLogged = new Set<string>();

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// One queue per file. Each operation starts when the previous one on that file
// has settled, whether it succeeded or not.
const queues = new Map<string, Promise<void>>();

function serialized<T>(file: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(file) ?? Promise.resolve()).then(task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(file, settled);
  void settled.then(() => {
    if (queues.get(file) === settled) queues.delete(file);
  });
  return run;
}

/**
 * One read-modify-write. `change` gets the stored comments and returns the next
 * list, or null when nothing changed (nothing is written and the rev stays).
 */
async function transact(
  top: string,
  change: (comments: ScmComment[]) => ScmComment[] | null,
): Promise<ScmCommentList> {
  const file = storePath(top);
  return serialized(file, async () => {
    const current = await readStored(file);
    const next = change(current.comments);
    if (next === null) {
      knownRevs.set(file, current.rev);
      return current;
    }
    const written: Stored = { rev: current.rev + 1, comments: next };
    await writeStored(file, top, written);
    knownRevs.set(file, written.rev);
    return written;
  });
}

export function listComments(top: string): Promise<ScmCommentList> {
  return transact(top, () => null);
}

/** `input` is untrusted: every field is validated, unknown keys are ignored. */
export async function createComment(top: string, input: unknown): Promise<ScmCommentList> {
  const content = validateInput(input);
  const now = Date.now();
  const comment: ScmComment = { id: randomUUID(), ...content, createdAt: now, updatedAt: now };
  return transact(top, (comments) => [...comments, comment]);
}

/** `patch` is any subset of the comment's content; the merged result is validated whole. */
export function updateComment(top: string, id: string, patch: unknown): Promise<ScmCommentList> {
  return transact(top, (comments) => {
    const current = comments.find((comment) => comment.id === id);
    if (current === undefined) throw new ScmCommentError(404, 'comment not found');
    const next: ScmComment = { ...current, ...applyPatch(current, patch), updatedAt: Date.now() };
    return comments.map((comment) => (comment.id === id ? next : comment));
  });
}

/** Deleting a comment that is already gone is not an error: it answers the current list. */
export function deleteComment(top: string, id: string): Promise<ScmCommentList> {
  return transact(top, (comments) =>
    comments.some((comment) => comment.id === id)
      ? comments.filter((comment) => comment.id !== id)
      : null,
  );
}

/**
 * The newest rev of a project's comments, synchronously. The first call after a
 * start reads the file once; every later one is a map lookup kept current by the
 * writes.
 */
export function latestRev(top: string): number {
  const file = storePath(top);
  const known = knownRevs.get(file);
  if (known !== undefined) return known;
  let rev = 0;
  try {
    rev = parseStored(readFileSync(file, 'utf8')).rev;
  } catch (error) {
    // An unreadable file (a directory in its place, EACCES, EIO) must not turn
    // every status poll into a 500: nothing is known, so report 0. It is not
    // cached, so a file that becomes readable is picked up by the next call, and
    // it is logged once per file rather than once per poll.
    if (!hasCode(error, 'ENOENT')) {
      if (!unreadableLogged.has(file)) {
        unreadableLogged.add(file);
        console.warn(`scm: cannot read the comments file ${file}: ${errorText(error)}`);
      }
      return 0;
    }
  }
  knownRevs.set(file, rev);
  return rev;
}
