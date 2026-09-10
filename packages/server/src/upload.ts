// ── Upload persistence ────────────────────────────────────────────────────────
//
// Saves a pasted/dropped/picked file from the browser to a temp path so
// programs in the shell (Claude Code, image viewers, editors …) can reference
// it by absolute path. Files land in the OS temp dir on purpose: they are
// ephemeral clipboard artifacts, not managed state — the OS temp cleaner
// reclaims them. The size cap lives in AppConfig; the route enforces it.

import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Longest sanitized name we will embed in the temp path. Linux caps a path
 * component at 255 bytes; 120 leaves ample room for the `palmux-clip-<hex>-`
 * prefix while keeping any real-world name intact.
 */
const MAX_NAME_LENGTH = 120;

/**
 * Reduce an untrusted filename to a safe basename: directory components are
 * stripped (both separators), anything outside [\w.-] becomes `_`, and
 * leading/trailing dots/underscores are trimmed so `..` can never survive.
 * Over-long names are truncated (keeping the extension) so the final path
 * component stays under the OS limit. An empty result falls back to `file`.
 */
export function sanitizeFilename(filename: string): string {
  const base = filename.split('/').pop()?.split('\\').pop() ?? '';
  const safe = base.replace(/[^\w.-]/g, '_').replace(/^[._]+|[._]+$/g, '');
  if (!safe) return 'file';
  if (safe.length <= MAX_NAME_LENGTH) return safe;
  const dot = safe.lastIndexOf('.');
  const ext = dot > 0 ? safe.slice(dot).slice(0, 16) : '';
  return safe.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
}

/** Derive an image extension from magic bytes (PNG/JPEG/GIF/WebP), or ''. */
export function sniffImageExtension(bytes: Uint8Array): string {
  const startsWith = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return '.png';
  if (startsWith([0xff, 0xd8, 0xff])) return '.jpg';
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return '.gif';
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) {
    return '.webp';
  }
  return '';
}

/**
 * Persist an uploaded payload to `<tmpdir>/palmux-clip-<12-hex>-<safe-name>`
 * and return the absolute path. When no filename is given the name is just
 * the token plus a magic-byte-sniffed image extension (a clipboard screenshot
 * has no name); a named upload keeps its sanitized basename.
 */
export async function saveUpload(bytes: Uint8Array, filename = ''): Promise<string> {
  const token = randomBytes(6).toString('hex');
  const name = filename ? `-${sanitizeFilename(filename)}` : sniffImageExtension(bytes);
  const path = join(tmpdir(), `palmux-clip-${token}${name}`);
  await writeFile(path, bytes, { mode: 0o600 });
  return path;
}
