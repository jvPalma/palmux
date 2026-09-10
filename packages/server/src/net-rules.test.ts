import { describe, expect, it } from 'vitest';
import {
  ipAllowed,
  isValidIpRule,
  isValidOriginRule,
  originAllowed,
  wsOriginAllowed,
} from './net-rules';

describe('ipAllowed', () => {
  it('allows everything when no rules are configured', () => {
    expect(ipAllowed('203.0.113.9', [])).toBe(true);
    expect(ipAllowed(undefined, [])).toBe(true);
  });

  it('matches exact IPv4 addresses', () => {
    expect(ipAllowed('192.168.1.5', ['192.168.1.5'])).toBe(true);
    expect(ipAllowed('192.168.1.6', ['192.168.1.5'])).toBe(false);
  });

  it('matches IPv4 CIDR ranges', () => {
    expect(ipAllowed('10.0.0.7', ['10.0.0.0/24'])).toBe(true);
    expect(ipAllowed('10.0.1.7', ['10.0.0.0/24'])).toBe(false);
    expect(ipAllowed('10.200.3.4', ['10.0.0.0/8'])).toBe(true);
  });

  it('normalizes IPv4-mapped IPv6 (Node dual-stack sockets)', () => {
    expect(ipAllowed('::ffff:10.0.0.7', ['10.0.0.0/24'])).toBe(true);
    expect(ipAllowed('::ffff:172.16.0.1', ['10.0.0.0/24'])).toBe(false);
  });

  it('matches IPv6 exact and CIDR', () => {
    expect(ipAllowed('::1', ['::1'])).toBe(true);
    expect(ipAllowed('fd12:3456::1', ['fd00::/8'])).toBe(true);
    expect(ipAllowed('fe80::1', ['fd00::/8'])).toBe(false);
  });

  it('denies unknown/garbage remotes when rules exist', () => {
    expect(ipAllowed(undefined, ['10.0.0.0/24'])).toBe(false);
    expect(ipAllowed('not-an-ip', ['10.0.0.0/24'])).toBe(false);
  });
});

describe('isValidIpRule', () => {
  it('accepts IPs and CIDRs, rejects junk', () => {
    expect(isValidIpRule('10.0.0.0/24')).toBe(true);
    expect(isValidIpRule('192.168.1.5')).toBe(true);
    expect(isValidIpRule('fd00::/8')).toBe(true);
    expect(isValidIpRule('10.0.0.0/33')).toBe(false);
    expect(isValidIpRule('10.0.0/24')).toBe(false);
    expect(isValidIpRule('example.com')).toBe(false);
  });
});

describe('originAllowed', () => {
  it('allows everything when no rules are configured', () => {
    expect(originAllowed('https://evil.example', [])).toBe(true);
    expect(originAllowed(undefined, [])).toBe(true);
  });

  it('matches exact hosts regardless of scheme when the rule has none', () => {
    expect(originAllowed('https://term.example.com', ['term.example.com'])).toBe(true);
    expect(originAllowed('http://term.example.com:44040', ['term.example.com'])).toBe(true);
    expect(originAllowed('https://other.example.com', ['term.example.com'])).toBe(false);
  });

  it('enforces the scheme when the rule specifies one', () => {
    expect(originAllowed('https://t.example.com', ['https://t.example.com'])).toBe(true);
    expect(originAllowed('http://t.example.com', ['https://t.example.com'])).toBe(false);
  });

  it('supports *. wildcards (subdomains only, not the apex)', () => {
    expect(originAllowed('https://a.example.com', ['*.example.com'])).toBe(true);
    expect(originAllowed('https://a.b.example.com', ['*.example.com'])).toBe(true);
    expect(originAllowed('https://example.com', ['*.example.com'])).toBe(false);
    expect(originAllowed('https://notexample.com', ['*.example.com'])).toBe(false);
  });

  it('port-qualified rules require the exact port', () => {
    expect(originAllowed('http://lan-host:44040', ['lan-host:44040'])).toBe(true);
    expect(originAllowed('http://lan-host:9999', ['lan-host:44040'])).toBe(false);
  });

  it('denies a missing Origin when rules exist (non-browser callers use IP rules)', () => {
    expect(originAllowed(undefined, ['term.example.com'])).toBe(false);
  });
});

describe('wsOriginAllowed', () => {
  it('falls back to same-origin when no rules are configured', () => {
    expect(wsOriginAllowed('https://term.example.com', 'term.example.com', [])).toBe(true);
    expect(wsOriginAllowed('https://evil.example', 'term.example.com', [])).toBe(false);
  });

  it('compares the port too, so another port on the same host is another site', () => {
    expect(wsOriginAllowed('http://localhost:5173', 'localhost:5173', [])).toBe(true);
    expect(wsOriginAllowed('http://localhost:5173', 'localhost:44040', [])).toBe(false);
  });

  it('rejects the opaque origin a sandboxed frame sends', () => {
    expect(wsOriginAllowed('null', 'term.example.com', [])).toBe(false);
  });

  it('allows a handshake with no Origin — only browsers set it', () => {
    expect(wsOriginAllowed(undefined, 'localhost:44040', [])).toBe(true);
  });

  it('denies when Host is missing and cannot be compared', () => {
    expect(wsOriginAllowed('https://term.example.com', undefined, [])).toBe(false);
  });

  it('an explicit rule list replaces the same-origin rule entirely', () => {
    // A reverse proxy rewriting Host: Origin no longer matches, the rule does.
    expect(
      wsOriginAllowed('https://term.example.com', 'localhost:44040', ['term.example.com']),
    ).toBe(true);
    expect(wsOriginAllowed('https://evil.example', 'evil.example', ['term.example.com'])).toBe(
      false,
    );
  });
});

describe('isValidOriginRule', () => {
  it('accepts hosts, schemes and wildcards; rejects junk', () => {
    expect(isValidOriginRule('term.example.com')).toBe(true);
    expect(isValidOriginRule('https://term.example.com')).toBe(true);
    expect(isValidOriginRule('*.example.com')).toBe(true);
    expect(isValidOriginRule('a*.example.com')).toBe(false);
    expect(isValidOriginRule('')).toBe(false);
  });
});
