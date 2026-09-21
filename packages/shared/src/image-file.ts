// ── Image files, told apart by extension ─────────────────────────────────────
//
// One list, two consumers: the client uses it to decide whether a file tab
// shows an <img> instead of the editor, and the server gates /file-image on the
// same list. A path one side treats as an image is always an image to the
// other — a text file opened as an image is the exact garbage this exists to
// avoid.

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
  bmp: 'image/bmp',
};

/** The content type for an image path, or null when the name is not an image. */
export function imageContentType(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot <= 0) return null;
  return IMAGE_TYPES[path.slice(dot + 1).toLowerCase()] ?? null;
}

/** True when the file is one the pane should render as an image. */
export function isImageFile(path: string): boolean {
  return imageContentType(path) !== null;
}
