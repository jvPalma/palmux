// ── Server-file download ──────────────────────────────────────────────────────
//
// Client side of GET /download?path=…: fetch (so HTTP errors surface as a toast
// instead of a downloaded error page), then hand the blob to the browser's
// download flow via a temporary anchor. A glob or directory arrives as a ZIP —
// the server decides; we just honor its Content-Disposition filename.

/** Extract the filename from a Content-Disposition header (RFC 6266-lite). */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* malformed encoding — fall through */
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain?.[1] ?? fallback;
}

/** A plausible default name when the server sent no disposition. */
export function fallbackName(pattern: string): string {
  const last = pattern.split('/').filter(Boolean).pop() ?? 'download';
  return /[*?[\]{}]/.test(last) ? 'files.zip' : last;
}

/**
 * Download an absolute path or glob from the server. Resolves to null on
 * success, or a short user-facing error message.
 */
export async function downloadFromServer(pattern: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`/download?path=${encodeURIComponent(pattern)}`);
  } catch {
    return 'Download failed — server unreachable';
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 120);
    return body || `Download failed (${res.status})`;
  }
  const name = filenameFromDisposition(
    res.headers.get('content-disposition'),
    fallbackName(pattern),
  );
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Let the click's navigation grab the blob before the URL is torn down.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return null;
}
