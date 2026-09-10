// ── File upload hook ──────────────────────────────────────────────────────────
//
// One flow, four entry points: clipboard paste (images, via the document paste
// event), drag-drop onto the terminal (any file), a button that opens the
// any-file picker (mobile drawer / desktop topbar), and a mobile-only IMAGE
// button that lands directly in the gallery. Picked files may be a BATCH; they
// upload one at a time so the paths are typed in pick order. The file is
// POSTed to the server, saved
// to a temp file, and the returned absolute path is written to the PTY as typed
// text — the contract path-reading CLIs (Claude Code) expect. Text paste is
// never intercepted: it falls through to xterm's native bracketed-paste.

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { DEFAULT_MAX_UPLOAD_BYTES } from '@palmux/shared';
import { extractPasteImage, firstFile } from './pasteFile';

interface UseFileUploadParams {
  /**
   * Write text to the PTY exactly as if typed (binary ws frame).
   * Returns false when the socket is down and the text was dropped.
   */
  sendToPty: (text: string) => boolean;
  sessionId: string;
  /** Server-enforced size cap (bytes); the client rejects oversize files early. */
  maxBytes: number;
  /** The `.term-wrap` element — the drop target. */
  wrapRef: RefObject<HTMLElement | null>;
  /** True while a panel/overlay owns input — paste/drop then stay native. */
  isBlocked?: () => boolean;
  /** Whether this pane is the focused slot. The document-level image-paste
   *  listener is per-pane, so a two-terminal split must route a plain Ctrl+V
   *  paste to the FOCUSED pane, not the first-registered one. Default focused. */
  getFocused?: () => boolean;
  /**
   * Called after a path is injected. Used to return keyboard focus to the
   * terminal — otherwise the picker button keeps focus and the Enter meant to
   * submit the path re-triggers the button.
   */
  onUploaded?: () => void;
  /** Upload feedback (e.g. a toast). */
  onError?: (message: string) => void;
}

export interface UseFileUploadResult {
  /** True while a file is dragged over the terminal (drop indicator). */
  dragActive: boolean;
  /** Open the ANY-file picker (topbar ⬆ / drawer ⬆ Upload). */
  openPicker: () => void;
  /**
   * Open the IMAGE picker. `accept="image/*"` is not cosmetic: Chrome on Android
   * builds its chooser from the accept list, and an EMPTY one accepts image and
   * video supertypes alike, so it offers "take a photo / record a video / pick a
   * file" every time. An image-only accept passes Chromium's
   * `isSupportedPhotoPickerTypes` and goes straight to the system photo picker
   * instead — the gallery, no questions. The cost is that this entry point can
   * only take images; anything else still goes through `openPicker`.
   */
  openImagePicker: () => void;
  /** Upload one file and inject its path (extra entry points, e.g. Ctrl+Shift+V). */
  uploadFile: (file: File) => Promise<boolean>;
}

const formatSize = (bytes: number): string => {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${Math.round(mb)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

export function useFileUpload(params: UseFileUploadParams): UseFileUploadResult {
  const [dragActive, setDragActive] = useState(false);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  /**
   * Upload one file and type its path. `prefix` separates it from a path
   * already typed by an earlier file in the same batch — without it two paths
   * would run together into one unusable token. Returns whether a path landed.
   */
  const upload = useCallback(async (file: File, prefix = ''): Promise<boolean> => {
    const { sessionId, maxBytes, onError } = paramsRef.current;
    // 0 is the server saying the user took the limit OFF (maxUploadBytes: 0), so
    // it must NOT fall back to the default — that would keep rejecting files the
    // server would happily accept. Only a missing value falls back.
    const cap = maxBytes === undefined || maxBytes === null ? DEFAULT_MAX_UPLOAD_BYTES : maxBytes;
    // Reject oversize files before spending the round-trip. The server enforces
    // the same cap (413) as defense-in-depth.
    if (cap > 0 && file.size > cap) {
      onError?.(`File too large (max ${formatSize(cap)})`);
      return false;
    }
    const query = new URLSearchParams({ session: sessionId });
    if (file.name) query.set('filename', file.name);
    let res: Response;
    try {
      res = await fetch(`/upload?${query.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
    } catch {
      onError?.('Upload failed — server unreachable');
      return false;
    }
    if (!res.ok) {
      onError?.(
        res.status === 413
          ? `File too large (max ${formatSize(cap)})`
          : res.status === 404
            ? 'Session not running'
            : `Upload failed (${res.status})`,
      );
      return false;
    }
    let path: string;
    try {
      path = ((await res.json()) as { path: string }).path;
    } catch {
      onError?.('Upload failed — bad server response');
      return false;
    }
    // Re-read params: the user may have switched sessions while the POST was in
    // flight — injecting into the *new* session's PTY would type into whatever
    // runs there, so drop with an explicit message instead.
    const { sendToPty, sessionId: nowSession, onUploaded, onError: err } = paramsRef.current;
    if (nowSession !== sessionId) {
      err?.(`Session changed — path not inserted (${path})`);
      return false;
    }
    // No trailing newline — the user reviews and submits the path.
    if (!sendToPty(prefix + path)) {
      err?.('Disconnected — path not inserted');
      return false;
    }
    onUploaded?.();
    return true;
  }, []);

  // A multi-file pick uploads STRICTLY in sequence. The paths are typed as each
  // upload lands, so the order the user picked in is the order they arrive in —
  // firing the POSTs in parallel would let a small file overtake a large one.
  const uploadAll = useCallback(
    async (files: File[]) => {
      let typed = false;
      for (const file of files) {
        if (await upload(file, typed ? ' ' : '')) typed = true;
      }
    },
    [upload],
  );

  // Clipboard paste (document-level, capture): consume ONLY image pastes.
  // stopImmediatePropagation keeps xterm's own paste listener from also pasting
  // a text representation; a text-only paste returns early so xterm's native
  // handler still owns it. While a panel/overlay is up the terminal isn't the
  // paste target — stay fully native there too.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (paramsRef.current.isBlocked?.()) return;
      // Only the focused pane's listener handles the paste (else in a split the
      // first-registered pane would grab it regardless of focus).
      const focused = paramsRef.current.getFocused;
      if (focused && !focused()) return;
      const image = extractPasteImage(e.clipboardData);
      if (!image) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void upload(image);
    };
    document.addEventListener('paste', onPaste, true);
    return () => document.removeEventListener('paste', onPaste, true);
  }, [upload]);

  // Drag-drop on the terminal wrap (ANY file), with a visual drag-active state.
  useEffect(() => {
    const wrap = paramsRef.current.wrapRef.current;
    if (!wrap) return;

    const onDragOver = (e: DragEvent) => {
      if (!Array.from(e.dataTransfer?.items ?? []).some((item) => item.kind === 'file')) return;
      // Cancel for EVERY file drag: an uncancelled dragover makes the later drop
      // navigate the tab to the dropped file.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      if (!paramsRef.current.isBlocked?.()) setDragActive(true);
    };
    const onDragLeave = (e: DragEvent) => {
      // Ignore leave events into our own children (term-host, overlays).
      if (e.relatedTarget && wrap.contains(e.relatedTarget as Node)) return;
      setDragActive(false);
    };
    const onDrop = (e: DragEvent) => {
      setDragActive(false);
      if (!e.dataTransfer?.files?.length) return;
      // Always cancel a file drop, or the browser replaces the page with it.
      e.preventDefault();
      if (paramsRef.current.isBlocked?.()) return;
      const file = firstFile(e.dataTransfer);
      if (!file) return;
      void upload(file);
    };

    wrap.addEventListener('dragover', onDragOver);
    wrap.addEventListener('dragleave', onDragLeave);
    wrap.addEventListener('drop', onDrop);
    return () => {
      wrap.removeEventListener('dragover', onDragOver);
      wrap.removeEventListener('dragleave', onDragLeave);
      wrap.removeEventListener('drop', onDrop);
    };
  }, [upload]);

  // Hidden file inputs for the button entry points. Created imperatively so the
  // terminal DOM stays free of React children. Two of them because `accept` is
  // what decides Android's chooser (see openImagePicker): one with none (any
  // file), one image-only (straight to the photo picker). Both take a batch —
  // the FileList order is the picker's order, and we never re-sort it.
  useEffect(() => {
    const make = (testId: string, accept?: string) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      if (accept) input.accept = accept;
      input.style.display = 'none';
      input.setAttribute('data-testid', testId);
      input.addEventListener('change', () => {
        const files = Array.from(input.files ?? []);
        input.value = ''; // allow re-picking the same file
        if (files.length) void uploadAll(files);
      });
      document.body.appendChild(input);
      return input;
    };
    const anyInput = make('upload-input');
    const imageInput = make('upload-image-input', 'image/*');
    inputRef.current = anyInput;
    imageInputRef.current = imageInput;
    return () => {
      anyInput.remove();
      imageInput.remove();
      inputRef.current = null;
      imageInputRef.current = null;
    };
  }, [uploadAll]);

  const openPicker = useCallback(() => inputRef.current?.click(), []);
  const openImagePicker = useCallback(() => imageInputRef.current?.click(), []);

  return { dragActive, openPicker, openImagePicker, uploadFile: upload };
}
