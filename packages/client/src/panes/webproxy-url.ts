// A loopback URL typed into a web tab names a port on the PALMUX HOST, not on
// the device running the browser — which is what the user means and what the
// browser cannot do. Rewrite it to the same-origin proxy route so the palmux
// server fetches it instead (see server/webproxy.ts). The tab keeps storing the
// readable `http://localhost:5173` form; only the iframe src is rewritten.

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):([0-9]{1,5})(\/.*)?$/i;

/**
 * The URL an iframe should actually load for a tab. Loopback URLs become
 * `/webproxy/<port>/…`; everything else is returned untouched.
 */
export function proxiedFrameUrl(url: string): string {
  const m = LOOPBACK.exec(url.trim());
  if (!m) return url;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return url;
  const rest = m[3] ?? '/';
  // The trailing slash matters: without it every root-absolute sub-resource of
  // the framed page resolves one directory too high.
  return `/webproxy/${port}${rest === '' ? '/' : rest}`;
}

/** True when this tab's iframe is going through the loopback proxy. */
export function isProxiedUrl(url: string): boolean {
  return proxiedFrameUrl(url) !== url;
}
