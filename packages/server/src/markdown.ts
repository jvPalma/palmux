// ── Markdown viewer backend ───────────────────────────────────────────────────
//
// Two trust levels, deliberately different:
//   • GET /md-file?path=  — read ONE file by absolute path. Same trust model as
//     /download: the PTY already grants full read to this user, so the cookie
//     gate is the boundary. Capped (2 MB) and typed for inline viewing.
//   • GET /md-list?dir=   — enumerate a directory. Browsing is a UI surface the
//     user scopes EXPLICITLY via config.json `markdownRoots`; requests outside
//     the (realpath-resolved) roots are refused, symlink escapes included.

import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';

/** Inline-view read cap — markdown beyond this is pathological. */
export const MAX_MD_FILE_BYTES = 2 * 1024 * 1024;

const MD_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);

export const isMarkdownFile = (p: string): boolean => MD_EXTENSIONS.has(extname(p).toLowerCase());

/** Content types for /md-file: markdown/text inline, images for relative srcs. */
const FILE_TYPES: { [ext: string]: string } = {
  '.md': 'text/plain; charset=utf-8',
  '.markdown': 'text/plain; charset=utf-8',
  '.mdx': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export type MdFileResult =
  | { ok: true; data: Buffer; type: string }
  | { ok: false; status: 400 | 404 | 413; message: string };

/** Read a file for the viewer: absolute path, size-capped, typed by extension. */
export async function readMdFile(path: string): Promise<MdFileResult> {
  const p = path.trim();
  if (!p || !isAbsolute(p)) return { ok: false, status: 400, message: 'path must be absolute' };
  const target = normalize(p);
  let s;
  try {
    s = await stat(target);
  } catch {
    return { ok: false, status: 404, message: 'not found' };
  }
  if (!s.isFile()) return { ok: false, status: 400, message: 'not a regular file' };
  if (s.size > MAX_MD_FILE_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `file exceeds ${MAX_MD_FILE_BYTES / (1024 * 1024)} MB`,
    };
  }
  const type = FILE_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
  return { ok: true, data: await readFile(target), type };
}

/** True when realpath(candidate) sits inside realpath(root) (or IS it). */
async function insideRoot(candidate: string, root: string): Promise<boolean> {
  let realCandidate: string;
  let realRoot: string;
  try {
    [realCandidate, realRoot] = await Promise.all([realpath(candidate), realpath(root)]);
  } catch {
    return false; // either side missing/unreadable — refuse
  }
  return realCandidate === realRoot || realCandidate.startsWith(realRoot + sep);
}

export interface MdListing {
  /** The listed directory (absolute), or null for the roots overview. */
  dir: string | null;
  /** The configured root containing `dir` (so the UI clamps breadcrumbs to it);
   *  null in the overview. */
  root: string | null;
  /** Absolute subdirectory paths (roots themselves in the overview). */
  dirs: string[];
  /** Absolute markdown file paths. */
  files: string[];
}

export type MdListResult =
  | { ok: true; listing: MdListing }
  | { ok: false; status: 400 | 403 | 404; message: string };

/**
 * List a directory for the browser view. No `dir` → the configured roots as
 * the top level. Every real listing is confined to the roots subtree.
 */
export async function listMdDir(dir: string | undefined, roots: string[]): Promise<MdListResult> {
  if (roots.length === 0) {
    return { ok: false, status: 404, message: 'no markdownRoots configured (config.json)' };
  }
  if (dir === undefined || dir.trim() === '') {
    // The overview lists the roots that actually exist.
    const dirs: string[] = [];
    for (const r of roots) {
      try {
        if ((await stat(r)).isDirectory()) dirs.push(resolve(r));
      } catch {
        /* configured but missing — skip silently, config errors log at boot */
      }
    }
    return { ok: true, listing: { dir: null, root: null, dirs, files: [] } };
  }

  const p = dir.trim();
  if (!isAbsolute(p)) return { ok: false, status: 400, message: 'dir must be absolute' };
  const target = normalize(p);
  let containingRoot: string | null = null;
  for (const root of roots) {
    if (await insideRoot(target, root)) {
      containingRoot = resolve(root);
      break;
    }
  }
  if (containingRoot === null) {
    return { ok: false, status: 403, message: 'outside the configured markdownRoots' };
  }

  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    return { ok: false, status: 404, message: 'not found' };
  }
  const dirs: string[] = [];
  const files: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // dotfiles are noise in a docs browser
    const full = join(target, e.name);
    if (e.isDirectory()) dirs.push(full);
    else if (e.isFile() && isMarkdownFile(e.name)) files.push(full);
  }
  dirs.sort();
  files.sort();
  return { ok: true, listing: { dir: target, root: containingRoot, dirs, files } };
}

/** Default title for a markdown tab: the file's basename. */
export const mdTitle = (path: string): string => basename(path);
