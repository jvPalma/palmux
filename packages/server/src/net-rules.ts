// ── Network access rules ──────────────────────────────────────────────────────
//
// Matchers for the security entries in ~/.config/palmux/config.json:
//   allowedIps     — exact IPs or CIDR ranges, IPv4 and IPv6 ("10.0.0.0/24",
//                    "192.168.1.5", "::1", "fd00::/8"). Empty list = allow all.
//   allowedOrigins — origins/domains, optionally with a leading wildcard
//                    ("https://term.example.com", "*.example.com", "localhost").
//                    Empty list = allow all for HTTP; for the WebSocket upgrade
//                    an empty list means SAME-ORIGIN — see wsOriginAllowed.
//
// IPv4-mapped IPv6 addresses (::ffff:10.0.0.5 — what Node reports on dual-stack
// sockets) are normalized to their IPv4 form before matching.

function normalizeIp(ip: string): string {
  let out = ip.trim().toLowerCase();
  if (out.startsWith('[') && out.endsWith(']')) out = out.slice(1, -1);
  if (out.startsWith('::ffff:') && out.includes('.')) out = out.slice(7);
  return out;
}

function ipToBigInt(ip: string): { value: bigint; bits: number } | null {
  if (ip.includes('.') && !ip.includes(':')) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let v = 0n;
    for (const p of parts) {
      if (!/^\d{1,3}$/.test(p)) return null;
      const n = BigInt(p);
      if (n > 255n) return null;
      v = (v << 8n) | n;
    }
    return { value: v, bits: 32 };
  }
  if (ip.includes(':')) {
    const doubles = ip.split('::');
    if (doubles.length > 2) return null;
    const head = doubles[0] ? doubles[0].split(':') : [];
    const tail = doubles.length === 2 && doubles[1] ? doubles[1].split(':') : [];
    const missing = 8 - head.length - tail.length;
    if (doubles.length === 2 ? missing < 0 : missing !== 0) return null;
    const groups = [...head, ...Array(doubles.length === 2 ? missing : 0).fill('0'), ...tail];
    if (groups.length !== 8) return null;
    let v = 0n;
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      v = (v << 16n) | BigInt(parseInt(g, 16));
    }
    return { value: v, bits: 128 };
  }
  return null;
}

/** True when the rule is a syntactically valid IP or CIDR entry. */
export function isValidIpRule(rule: string): boolean {
  const [addr, prefix, extra] = rule.trim().split('/');
  if (extra !== undefined || !addr) return false;
  const parsed = ipToBigInt(normalizeIp(addr));
  if (!parsed) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const n = Number(prefix);
  return n >= 0 && n <= parsed.bits;
}

/** True when `ip` matches the rule (exact IP or CIDR range, same family). */
function ipMatchesRule(ip: { value: bigint; bits: number }, rule: string): boolean {
  const [addr, prefix] = rule.trim().split('/');
  const ruleIp = ipToBigInt(normalizeIp(addr ?? ''));
  if (!ruleIp || ruleIp.bits !== ip.bits) return false;
  const bits = BigInt(prefix === undefined ? ip.bits : Number(prefix));
  const shift = BigInt(ip.bits) - bits;
  return ip.value >> shift === ruleIp.value >> shift;
}

/** True when the remote address may connect. An empty rule list allows all. */
export function ipAllowed(remote: string | undefined, rules: string[]): boolean {
  if (rules.length === 0) return true;
  if (!remote) return false;
  const ip = ipToBigInt(normalizeIp(remote));
  if (!ip) return false;
  return rules.some((r) => ipMatchesRule(ip, r));
}

/** True when the rule is a plausible origin/domain entry (optionally wildcarded). */
export function isValidOriginRule(rule: string): boolean {
  const r = rule.trim();
  if (!r) return false;
  const host = r.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\*\./, '');
  return host.length > 0 && !host.includes('*') && !/\s/.test(host);
}

// Origin header → comparable {scheme, host} (port ignored: rules rarely carry it,
// and a port-specific rule can be written as "host:port" for an exact match).
function originParts(origin: string): { scheme: string; hostPort: string; host: string } | null {
  const m = origin
    .trim()
    .toLowerCase()
    .match(/^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/]+)$/);
  if (!m || !m[2]) return null;
  return { scheme: m[1] ?? '', hostPort: m[2], host: m[2].replace(/:\d+$/, '') };
}

/**
 * True when the Origin header value may connect. An empty rule list allows all.
 * Rules match on host (and scheme/port when the rule specifies them);
 * `*.example.com` matches any subdomain but NOT the bare apex.
 */
export function originAllowed(origin: string | undefined, rules: string[]): boolean {
  if (rules.length === 0) return true;
  if (!origin) return false;
  const o = originParts(origin);
  if (!o) return false;
  return rules.some((raw) => {
    const r = originParts(raw.trim().toLowerCase().replace(/^\*\./, '__WILDCARD__.'));
    if (!r) return false;
    if (r.scheme && o.scheme && r.scheme !== o.scheme) return false;
    if (r.host.startsWith('__wildcard__.')) {
      const suffix = r.host.slice('__wildcard__.'.length);
      return o.host.endsWith(`.${suffix}`);
    }
    // Port-qualified rule → exact host:port; bare rule → host only.
    return r.hostPort.includes(':') ? r.hostPort === o.hostPort : r.host === o.host;
  });
}

/**
 * Origin gate for the /ws upgrade, where an empty rule list means SAME-ORIGIN
 * rather than allow-all.
 *
 * WebSockets are exempt from CORS: a page on any site can open a socket to
 * palmux and the browser attaches the session cookie to the handshake, so this
 * check — not the cookie — is what stands between another site and a shell
 * (cross-site WebSocket hijacking). Deferring to `allowedOrigins` left the
 * guard off on every install that never set it.
 *
 * `Host` is the origin the request was ADDRESSED to, so comparing it with the
 * Origin header is the same-origin test, and it needs no configuration. An
 * explicit `allowedOrigins` replaces the rule outright — that is the escape
 * hatch for a reverse proxy that rewrites Host, or for a deliberate embed.
 * Forwarded headers are deliberately not consulted (palmux trusts no proxy
 * header anywhere else either).
 *
 * A handshake with NO Origin is allowed: only browsers set it, and only a
 * browser can be tricked into being a confused deputy. A script that reached
 * for `ws://` was handed the cookie on purpose.
 */
export function wsOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  rules: string[],
): boolean {
  if (rules.length > 0) return originAllowed(origin, rules);
  if (!origin) return true;
  const o = originParts(origin);
  const h = originParts(host ?? '');
  if (!o || !h) return false;
  return o.hostPort === h.hostPort;
}
