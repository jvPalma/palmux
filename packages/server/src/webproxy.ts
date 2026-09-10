// ── Loopback web proxy ────────────────────────────────────────────────────────
//
// Why this exists: a web tab's iframe runs in the BROWSER, not on the palmux
// host. So a dev server on the palmux machine's `127.0.0.1:5173` is reachable
// by the palmux process and by nothing the browser can address — the machine's
// public URL for that port (a Cloud Workstations `5173-<ws>…` host, a LAN ip)
// is either auth-walled or refuses framing, and `http://localhost:5173` from an
// HTTPS page is blocked outright as a public→loopback navigation.
//
// So palmux fetches it instead and re-serves it under its OWN origin at
// `/webproxy/<port>/…`. Same-origin means no X-Frame-Options and no private-
// network block; the existing cookie gate is the only door, exactly as for
// /download and the PTY itself — a shell on this host can already reach any
// loopback port, so proxying one grants the client nothing it lacked.
//
// The two directions are asymmetric on purpose, and both are security, not
// tidiness:
//   → upstream: palmux's session cookie MUST NOT travel to the proxied app.
//   ← downstream: the app's Set-Cookie MUST NOT land on palmux's origin (it
//     could otherwise overwrite the session cookie), and its framing headers
//     are dropped since same-origin framing is the entire point.

/** Path prefix the proxy owns. */
export const WEBPROXY_PREFIX = '/webproxy/';

export interface ProxyTarget {
  port: number;
  /** Upstream path, always rooted with `/` (query included). */
  path: string;
}

/**
 * Parse `/webproxy/<port>/<rest>` into a loopback target, or null if the path
 * isn't ours / the port isn't a plausible one. `selfPort` is refused so the
 * proxy can never be pointed at palmux itself (an infinite request loop).
 */
export function parseProxyPath(url: string, selfPort?: number): ProxyTarget | null {
  if (!url.startsWith(WEBPROXY_PREFIX)) return null;
  const rest = url.slice(WEBPROXY_PREFIX.length);
  const slash = rest.indexOf('/');
  const portStr = slash === -1 ? rest.split('?')[0] ?? '' : rest.slice(0, slash);
  if (!/^[0-9]{1,5}$/.test(portStr)) return null;
  const port = Number(portStr);
  if (port < 1 || port > 65535) return null;
  if (selfPort !== undefined && port === selfPort) return null;
  const tail = slash === -1 ? '' : rest.slice(slash);
  return { port, path: tail === '' ? '/' : tail };
}

/**
 * A sub-resource of a proxied page (`/src/main.tsx`, `/@vite/client`) is
 * requested at palmux's ROOT — the framed app has no idea it lives under a
 * prefix, and rewriting its JS is not a thing that can be done reliably. The
 * Referer is what puts it back: it names the proxied document, so any request
 * made from one is re-routed to that same upstream port.
 *
 * Returns null when the referer isn't a proxied page, which is every request
 * the palmux app itself makes.
 */
export function targetFromReferer(
  url: string,
  referer: string | undefined,
  selfPort?: number,
): ProxyTarget | null {
  if (!referer) return null;
  if (url.startsWith(WEBPROXY_PREFIX)) return null; // already explicit
  let refPath: string;
  try {
    refPath = new URL(referer).pathname;
  } catch {
    return null;
  }
  const via = parseProxyPath(refPath, selfPort);
  if (!via) return null;
  return { port: via.port, path: url.startsWith('/') ? url : `/${url}` };
}

// Hop-by-hop headers are per-connection and must never be forwarded either way.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Headers to send upstream. `cookie` and `authorization` are dropped: palmux's
 * session cookie is scoped to this origin and handing it to a proxied app would
 * give that app the terminal. `host` is dropped so undici sets the real one.
 */
export function sanitizeRequestHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (key === 'cookie' || key === 'authorization' || key === 'host') continue;
    if (key === 'content-length') continue; // recomputed from the body we send
    if (typeof value === 'string') out[key] = value;
    else if (Array.isArray(value)) out[key] = value.join(', ');
  }
  return out;
}

/**
 * Headers to send back to the browser. Beyond hop-by-hop:
 *  - the framing headers go, because same-origin embedding IS the feature;
 *  - `set-cookie` goes, because a proxied app writing cookies on palmux's
 *    origin could clobber the session cookie;
 *  - `content-encoding`/`content-length` go, because fetch already decoded the
 *    body — forwarding them would describe bytes we are no longer sending.
 */
export function sanitizeResponseHeaders(headers: Iterable<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, value] of headers) {
    const key = rawKey.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (key === 'x-frame-options') continue;
    if (key === 'content-security-policy' || key === 'content-security-policy-report-only') continue;
    if (key === 'strict-transport-security') continue;
    // The Referer is how a proxied page's root-absolute sub-resources find
    // their way back upstream, so it is load-bearing, not metadata: an upstream
    // sending `Referrer-Policy: no-referrer` would silently strand every asset.
    // Dropping it restores the default policy, which sends the full path on
    // same-origin requests. (A `<meta name="referrer">` in the page's own HTML
    // is still beyond reach — that would need HTML rewriting.)
    if (key === 'referrer-policy') continue;
    if (key === 'set-cookie') continue;
    if (key === 'content-encoding' || key === 'content-length') continue;
    out[key] = value;
  }
  return out;
}

/** The upstream URL for a target. Always loopback — never a routable host. */
export function upstreamUrl(target: ProxyTarget): string {
  return `http://127.0.0.1:${target.port}${target.path}`;
}
