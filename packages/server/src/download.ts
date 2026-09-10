// ── File download ─────────────────────────────────────────────────────────────
//
// GET /download?path=<absolute path | glob> lets the browser pull files OFF the
// server machine: a single file streams as-is; a glob (`/notes/*.md`), multiple
// matches, or a directory arrive as one ZIP built with node:zlib only (deflate
// entries + crc32 — no dependencies). Absolute paths are the point, not a
// traversal bug: the shell in the PTY can already read anything this process
// can, so the cookie gate (plus IP/origin rules) is the security boundary,
// exactly as for the terminal itself.

import { glob, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { formatByteSize } from '@palmux/shared';

/** Bounds for ZIP bundling — the archive is assembled in memory. */
export const MAX_ZIP_FILES = 500;
/**
 * Fallback cap when the caller passes none. The real limit is
 * `maxDownloadBytes` in config.json (`"512MB"`, `"2GB"`, `0` for none) —
 * this constant only keeps the pure-function tests and any older caller honest.
 */
export const MAX_ZIP_TOTAL_BYTES = 256 * 1024 * 1024;

const GLOB_CHARS = /[*?[\]{}]/;

export const isGlobPattern = (p: string): boolean => GLOB_CHARS.test(p);

export type DownloadResolution =
  | { kind: 'file'; path: string; name: string; size: number }
  | { kind: 'zip'; base: string; zipName: string; files: string[] }
  | { kind: 'error'; status: 400 | 404 | 413; message: string };

const err = (status: 400 | 404 | 413, message: string): DownloadResolution => ({
  kind: 'error',
  status,
  message,
});

/** The static directory prefix of a glob (segments before the first magic one). */
export function globBase(pattern: string): string {
  const parts = normalize(pattern).split(sep);
  const staticParts: string[] = [];
  for (const part of parts) {
    if (GLOB_CHARS.test(part)) break;
    staticParts.push(part);
  }
  return staticParts.join(sep) || sep;
}

async function collectDir(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    out.push(join(e.parentPath, e.name));
    if (out.length > MAX_ZIP_FILES) break;
  }
  return out;
}

/**
 * Resolve a download request to a single file or a ZIP file-set. Only regular
 * files are ever included; the total-size cap is enforced here so the route
 * can reply 413 before buffering anything.
 */
export async function resolveDownload(
  pattern: string,
  maxTotalBytes: number = MAX_ZIP_TOTAL_BYTES,
): Promise<DownloadResolution> {
  const p = pattern.trim();
  if (!p || !isAbsolute(p)) {
    return err(400, 'path must be absolute (e.g. /home/user/notes/*.md)');
  }

  let files: string[];
  let base: string;
  let zipName: string;

  if (isGlobPattern(p)) {
    base = globBase(p);
    zipName = `${basename(base) || 'files'}.zip`;
    files = [];
    for await (const entry of glob(p, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      files.push(join(entry.parentPath, entry.name));
      if (files.length > MAX_ZIP_FILES) return err(413, `over ${MAX_ZIP_FILES} files`);
    }
    files.sort();
  } else {
    const target = normalize(p);
    let s;
    try {
      s = await stat(target);
    } catch {
      return err(404, 'not found');
    }
    if (s.isFile()) {
      return { kind: 'file', path: target, name: basename(target), size: s.size };
    }
    if (!s.isDirectory()) return err(400, 'not a regular file or directory');
    base = dirname(target);
    zipName = `${basename(target) || 'files'}.zip`;
    files = await collectDir(target);
    if (files.length > MAX_ZIP_FILES) return err(413, `over ${MAX_ZIP_FILES} files`);
    files.sort();
  }

  if (files.length === 0) return err(404, 'no files matched');
  if (files.length === 1) {
    const only = files[0]!;
    const s = await stat(only);
    return { kind: 'file', path: only, name: basename(only), size: s.size };
  }

  // 0 is the explicit "no limit" setting, the same convention maxUploadBytes
  // uses — so the stat walk is skipped entirely rather than compared to zero.
  if (maxTotalBytes > 0) {
    let total = 0;
    for (const f of files) {
      total += (await stat(f)).size;
      if (total > maxTotalBytes) {
        return err(413, `matched files exceed ${formatByteSize(maxTotalBytes)}`);
      }
    }
  }
  return { kind: 'zip', base, zipName, files };
}

// ── Minimal ZIP writer (deflate entries, 32-bit format) ──────────────────────

export interface ZipEntry {
  /** Forward-slash relative path inside the archive. */
  name: string;
  data: Buffer;
  mtime?: Date;
}

const dosDateTime = (d: Date): { date: number; time: number } => ({
  // DOS epoch is 1980; clamp older mtimes rather than underflow.
  date:
    ((Math.max(0, d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
});

/** Build a complete ZIP archive in memory (entries deflated, UTF-8 names). */
export function buildZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const { date, time } = dosDateTime(entry.mtime ?? new Date(0));
    const crc = crc32(entry.data) >>> 0;
    const deflated = deflateRawSync(entry.data);
    // Method 8 (deflate) unless stored is smaller (tiny/incompressible data).
    const stored = deflated.length >= entry.data.length;
    const payload = stored ? entry.data : deflated;
    const method = stored ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); // central directory signature
    cen.writeUInt16LE(20, 4); // version made by
    cen.writeUInt16LE(20, 6); // version needed
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(payload.length, 20);
    cen.writeUInt32LE(entry.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    // extra/comment/disk/attrs stay zero
    cen.writeUInt32LE(offset, 42); // local header offset

    chunks.push(local, name, payload);
    central.push(cen, name);
    offset += local.length + name.length + payload.length;
  }

  const centralStart = offset;
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);

  return Buffer.concat([...chunks, ...central, eocd]);
}

/** Read + bundle a resolved file-set, entry names relative to `base`. */
export async function bundleZip(base: string, files: string[]): Promise<Buffer> {
  const entries: ZipEntry[] = [];
  for (const f of files) {
    const real = await realpath(f);
    const s = await stat(real);
    if (!s.isFile()) continue;
    const name = relative(base, f).split(sep).join('/') || basename(f);
    entries.push({ name, data: await readFile(real), mtime: s.mtime });
  }
  return buildZip(entries);
}

/** RFC 6266 attachment header: ASCII fallback + UTF-8 filename*. */
export function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
