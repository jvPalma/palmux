// ── Generic token auth ────────────────────────────────────────────────────────
//
// A single shared secret (see config.ts) guards the terminal. There is NO
// Cloud-Workstations proxy-header trust here — anyone reaching the port must
// present the token once, after which a session cookie (the secret itself,
// httpOnly) authenticates subsequent requests and the WebSocket upgrade.
//
// `--no-auth` (PALMUX_NO_AUTH=1) bypasses everything for localhost dev.

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const SESSION_COOKIE = 'palmux_session';

export interface AuthConfig {
  secret: string;
  noAuth: boolean;
}

/**
 * Sanitise a post-auth redirect target. Only same-origin absolute paths are
 * allowed: a single leading '/' NOT followed by '/' or '\' (which would make it
 * protocol-relative, e.g. `//evil.com`, and browsers normalise `/\` to `//`).
 */
export function safeNext(raw: string | undefined): string {
  if (raw === '/') return '/';
  if (raw && /^\/[^/\\]/.test(raw)) return raw;
  return '/';
}

/** Constant-time string compare that tolerates length mismatch. */
export function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Pull a named cookie out of a raw Cookie header (used for the WS upgrade). */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/** True when the raw HTTP request carries a valid session cookie. */
export function isRequestAuthed(req: IncomingMessage, cfg: AuthConfig): boolean {
  if (cfg.noAuth) return true;
  const cookie = readCookie(req.headers.cookie, SESSION_COOKIE);
  return cookie !== null && secretEquals(cookie, cfg.secret);
}

/** Minimal token-entry page for non-proxied access (localhost direct, etc.). */
export function authPageHtml(next: string, error = false): string {
  const safeNextAttr = safeNext(next).replace(/"/g, '&quot;');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>palmux — authenticate</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    background:#1e1e2e; color:#cdd6f4; font:16px/1.5 system-ui, sans-serif; }
  form { width:min(92vw,360px); padding:28px; background:#181825; border-radius:14px;
    box-shadow:0 12px 40px rgba(0,0,0,.45); }
  h1 { margin:0 0 4px; font-size:20px; }
  p { margin:0 0 18px; color:#9399b2; font-size:13px; }
  input { width:100%; box-sizing:border-box; padding:12px 14px; border-radius:9px;
    border:1px solid #313244; background:#11111b; color:#cdd6f4; font:inherit; }
  input:focus { outline:2px solid #a6e3a1; border-color:transparent; }
  button { margin-top:14px; width:100%; padding:12px; border:0; border-radius:9px;
    background:#a6e3a1; color:#11111b; font:600 15px/1 system-ui; cursor:pointer; }
  .err { color:#f38ba8; font-size:13px; margin-top:12px; ${error ? '' : 'display:none;'} }
</style>
</head>
<body>
<form method="POST" action="/auth">
  <h1>palmux</h1>
  <p>Paste your session token to continue.</p>
  <input name="token" type="password" autocomplete="off" autofocus
    placeholder="session token" aria-label="session token" />
  <input type="hidden" name="next" value="${safeNextAttr}" />
  <button type="submit">Authenticate</button>
  <div class="err">Invalid token — try again.</div>
</form>
</body>
</html>`;
}
