// ── Reading and writing an arbitrary file ─────────────────────────────────────
//
// The file browser's Edit mode needs this and nothing else provides it:
// `/pane-file` is bound to an editor TAB and refuses an absolute path, `/md-file`
// is read-only, and `/upload` only ever writes into a temp directory. So "Edit"
// had no way to save the file the tree opened.
//
// Trust model is `/download`'s, stated there and unchanged here: absolute paths
// are the point, the session cookie is the boundary, and the shell behind that
// cookie can already read and write anything the user can. What this module adds
// on top is not a jail — it is the set of refusals that stop a MISTAKE being
// unrecoverable, since a bad write is silent in a way a bad shell command is not:
//
//   * it never CREATES a file, and never creates a parent directory. You can only
//     save over something the tree already showed you.
//   * it refuses anything that is not a regular file, so a typo cannot stream a
//     text buffer into /dev/sda or block forever on a fifo.
//   * it writes atomically into the target's own directory and restores the
//     original mode, so an interrupted save cannot truncate the original.

import { constants } from 'node:fs';
import {
  access,
  chmod,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, dirname, join } from 'node:path';

export interface FileError {
  ok: false;
  status: number;
  message: string;
}
export interface FileRead {
  ok: true;
  text: string;
  path: string;
  /** Bytes on disk, so the client can tell "empty file" from "not loaded". */
  size: number;
}
export interface FileWritten {
  ok: true;
  path: string;
  size: number;
}

const err = (status: number, message: string): FileError => ({ ok: false, status, message });

/** Shared gate: absolute, exists, and is a regular file. */
async function regularFile(path: string): Promise<FileError | { ok: true; mode: number }> {
  if (!path) return err(400, 'path is required');
  if (!isAbsolute(path)) return err(400, 'path must be absolute');
  let st;
  try {
    st = await stat(path);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT') return err(404, 'not found');
    if (code === 'EACCES' || code === 'EPERM') return err(403, 'permission denied');
    return err(400, `cannot stat: ${String(code ?? e)}`);
  }
  if (st.isDirectory()) return err(400, 'path is a directory');
  // Sockets, devices, fifos: a text editor has no business here, and a write
  // would either corrupt something or hang.
  if (!st.isFile()) return err(400, 'not a regular file');
  return { ok: true, mode: st.mode };
}

/** Read a file as UTF-8 text. `maxBytes` guards the editor against a huge file. */
export async function readTextFile(path: string, maxBytes: number): Promise<FileRead | FileError> {
  const gate = await regularFile(path);
  if (!gate.ok) return gate;
  const st = await stat(path);
  if (st.size > maxBytes) {
    return err(413, `file is ${st.size} bytes; the editor limit is ${maxBytes}`);
  }
  try {
    return { ok: true, text: await readFile(path, 'utf8'), path, size: st.size };
  } catch (e) {
    return err(400, `cannot read: ${String((e as { code?: string }).code ?? e)}`);
  }
}

/**
 * Overwrite an EXISTING regular file, atomically.
 *
 * The temp file is created in the target's own directory, because a rename
 * across filesystems fails with EXDEV — writing to the system temp dir and
 * renaming would break for any file on a different mount, which on this kind of
 * host means anything under a separate /home.
 */
export async function writeTextFile(
  path: string,
  text: string,
  maxBytes: number,
): Promise<FileWritten | FileError> {
  const gate = await regularFile(path);
  if (!gate.ok) return gate;
  // Resolve the symlink FIRST. A rename replaces the NAME it lands on, so
  // renaming over a link deletes the link and leaves a regular file in its place
  // — one save would silently detach a dotfile from the repo it is linked out of.
  // Editing a link must edit its target.
  let target = path;
  try {
    target = await realpath(path);
  } catch {
    /* unresolvable: fall back to the literal path, which regularFile already stat'd */
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) return err(413, `body is ${bytes} bytes; the limit is ${maxBytes}`);
  try {
    await access(target, constants.W_OK);
  } catch {
    return err(403, 'file is not writable');
  }
  const tmp = join(dirname(target), `.palmux-save-${process.pid}-${bytes}.tmp`);
  try {
    await writeFile(tmp, text, 'utf8');
    await chmod(tmp, gate.mode & 0o777);
    await rename(tmp, target);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    return err(400, `cannot write: ${String((e as { code?: string }).code ?? e)}`);
  }
  return { ok: true, path, size: bytes };
}
