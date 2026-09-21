// ── Serving an image to a file tab ───────────────────────────────────────────
//
// A file tab whose url is an image renders an <img>; this is what the img asks
// for. Trust model is /download's and /file's, stated there: absolute paths
// are the point, the session cookie is the boundary. On top of /file's regular-
// file gate sits the extension allowlist from shared — a text file served as an
// image is the exact garbage the viewer exists to avoid, and the two sides must
// agree on what an image IS, which is why the list lives in shared.

import { imageContentType } from '@palmux/shared';
import { regularFile, type FileError } from './file-rw';

export interface ImageFile {
  ok: true;
  path: string;
  contentType: string;
}

/** Gate an absolute path for /file-image: must exist, be a regular file, and name an image. */
export async function resolveImageFile(path: string): Promise<ImageFile | FileError> {
  const contentType = imageContentType(path);
  if (!contentType) return { ok: false, status: 400, message: 'not an image file' };
  const gate = await regularFile(path);
  if (!gate.ok) return gate;
  return { ok: true, path, contentType };
}
