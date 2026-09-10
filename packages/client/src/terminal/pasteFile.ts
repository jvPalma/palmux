// Pull a file out of a paste/drop DataTransfer.
//
// The terminal intercepts *image* paste so it can upload the file to the server
// and inject its path (path-reading CLIs like Claude Code read files from the
// server filesystem, not the browser clipboard). Plain-text paste is
// intentionally NOT handled — it falls through to xterm's native `paste`
// handler, which forwards the text to the PTY. Drag-drop and the picker accept
// ANY file type (see firstFile); only clipboard paste is image-scoped, because
// that is effectively all a browser ever puts on the clipboard as a file.

/** The first image file in a DataTransfer (clipboard paste / image drop), or null. */
export function extractPasteImage(data: DataTransfer | null | undefined): File | null {
  if (!data) return null;

  // Prefer `items` — present on real paste events and lets us getAsFile().
  const items = data.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item?.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) return file;
      }
    }
  }

  // Fallback for environments that populate `files` but not `items`.
  const files = data.files;
  if (files) {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file?.type.startsWith('image/')) return file;
    }
  }

  return null;
}

/** The first file of ANY type in a DataTransfer (drag-drop), or null. */
export function firstFile(data: DataTransfer | null | undefined): File | null {
  if (!data) return null;
  const items = data.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item?.kind === 'file') {
        const file = item.getAsFile();
        if (file) return file;
      }
    }
  }
  return data.files?.[0] ?? null;
}
