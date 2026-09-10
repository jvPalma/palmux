// ── Embeddable-URL policy ─────────────────────────────────────────────────────
//
// The single source of truth for what may appear in a web tab's iframe `src`.
// Enforced BOTH client-side (before sending createTab/updateTab) and server-side
// (before storing/rebroadcasting) — a hostile raw WS frame must not be able to
// park a `javascript:`/`data:` URL in a tab that then renders on every device.

/** True only for `http(s)://…` absolute URLs and `/`-rooted same-origin paths. */
export function isEmbeddableUrl(url: string): boolean {
  if (typeof url !== 'string' || url === '') return false;
  // `//host` is protocol-relative → an EXTERNAL origin, not same-origin. Reject:
  // a same-origin path is a single leading slash.
  if (url.startsWith('//')) return false;
  if (url.startsWith('/')) return true;
  return /^https?:\/\//i.test(url);
}

/**
 * Normalize a user-typed destination into an embeddable URL, or null if it
 * can't be one. Bare hosts get `https://`; `/`-rooted paths pass through; any
 * other scheme (javascript:, data:, file:, //host…) is rejected.
 */
export function normalizeTabUrl(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (s.startsWith('//')) return null; // protocol-relative external — reject
  if (s.startsWith('/')) return s; // same-origin (artifacts, local routes)
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null; // any other explicit scheme
  return `https://${s}`;
}

/** Whether a URL points at THIS origin (a `/`-rooted path). Cross-origin sites
 *  keep their own origin in a sandboxed frame; same-origin pages would inherit
 *  ours, so they must be framed WITHOUT `allow-same-origin`. */
export function isSameOriginUrl(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//');
}
