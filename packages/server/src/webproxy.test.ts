// Loopback web proxy: path parsing, referer re-routing, and the two header
// sanitizers (which are the security boundary, not cosmetics).

import { describe, expect, it } from 'vitest';
import {
  parseProxyPath,
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
  targetFromReferer,
  upstreamUrl,
} from './webproxy';

describe('parseProxyPath', () => {
  it('splits port from upstream path', () => {
    expect(parseProxyPath('/webproxy/5173/src/main.tsx')).toEqual({
      port: 5173,
      path: '/src/main.tsx',
    });
  });

  it('a bare port is the upstream root', () => {
    expect(parseProxyPath('/webproxy/5173')).toEqual({ port: 5173, path: '/' });
    expect(parseProxyPath('/webproxy/5173/')).toEqual({ port: 5173, path: '/' });
  });

  it('keeps the query string with the path', () => {
    expect(parseProxyPath('/webproxy/3000/a?b=1')).toEqual({ port: 3000, path: '/a?b=1' });
  });

  it('rejects a non-proxy path, a non-numeric port, and an out-of-range port', () => {
    expect(parseProxyPath('/artifacts/x.html')).toBeNull();
    expect(parseProxyPath('/webproxy/evil/x')).toBeNull();
    expect(parseProxyPath('/webproxy/0/x')).toBeNull();
    expect(parseProxyPath('/webproxy/99999/x')).toBeNull();
  });

  it('refuses palmux itself (a proxy loop)', () => {
    expect(parseProxyPath('/webproxy/44040/', 44040)).toBeNull();
    expect(parseProxyPath('/webproxy/5173/', 44040)).toEqual({ port: 5173, path: '/' });
  });

  it('cannot be pointed off-loopback (the port is the only free variable)', () => {
    // No host component exists in the route at all, so there is nothing to
    // traverse into — upstream is always 127.0.0.1.
    expect(upstreamUrl({ port: 5173, path: '/x' })).toBe('http://127.0.0.1:5173/x');
    expect(parseProxyPath('/webproxy/evil.com:80/x')).toBeNull();
  });
});

describe('targetFromReferer', () => {
  const REF = 'https://palmux.example.com/webproxy/5173/';

  it('re-routes a root-absolute sub-resource back to its upstream', () => {
    // Vite emits `/src/main.tsx`; the framed app does not know about the prefix.
    expect(targetFromReferer('/src/main.tsx', REF)).toEqual({
      port: 5173,
      path: '/src/main.tsx',
    });
  });

  it('ignores requests from the palmux app itself', () => {
    expect(targetFromReferer('/assets/index.js', 'https://palmux.example.com/0')).toBeNull();
  });

  it('ignores a missing or unparseable referer', () => {
    expect(targetFromReferer('/src/main.tsx', undefined)).toBeNull();
    expect(targetFromReferer('/src/main.tsx', 'not a url')).toBeNull();
  });

  it('leaves an already-explicit proxy path alone', () => {
    expect(targetFromReferer('/webproxy/3000/x', REF)).toBeNull();
  });
});

describe('sanitizeRequestHeaders', () => {
  it('never forwards the palmux session cookie upstream', () => {
    // The cookie IS the terminal. A proxied app must not receive it.
    const out = sanitizeRequestHeaders({
      cookie: 'palmux_session=secret',
      authorization: 'Bearer x',
      accept: 'text/html',
    });
    expect(out['cookie']).toBeUndefined();
    expect(out['authorization']).toBeUndefined();
    expect(out['accept']).toBe('text/html');
  });

  it('drops host, content-length and hop-by-hop headers', () => {
    const out = sanitizeRequestHeaders({
      host: 'palmux.example.com',
      'content-length': '12',
      connection: 'keep-alive',
      'accept-language': 'pt',
    });
    expect(Object.keys(out)).toEqual(['accept-language']);
  });

  it('joins a repeated header', () => {
    expect(sanitizeRequestHeaders({ 'x-a': ['1', '2'] })['x-a']).toBe('1, 2');
  });
});

describe('sanitizeResponseHeaders', () => {
  const run = (h: Record<string, string>) => sanitizeResponseHeaders(Object.entries(h));

  it('strips the framing headers (same-origin embedding is the whole point)', () => {
    const out = run({
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'",
      'content-security-policy-report-only': "frame-ancestors 'none'",
      'content-type': 'text/html',
    });
    expect(out['x-frame-options']).toBeUndefined();
    expect(out['content-security-policy']).toBeUndefined();
    expect(out['content-security-policy-report-only']).toBeUndefined();
    expect(out['content-type']).toBe('text/html');
  });

  it('strips set-cookie so a proxied app cannot clobber the session cookie', () => {
    expect(run({ 'set-cookie': 'palmux_session=attacker' })['set-cookie']).toBeUndefined();
  });

  it('strips content-encoding/length (fetch already decoded the body)', () => {
    const out = run({ 'content-encoding': 'gzip', 'content-length': '99', etag: '"a"' });
    expect(out['content-encoding']).toBeUndefined();
    expect(out['content-length']).toBeUndefined();
    expect(out['etag']).toBe('"a"');
  });

  it('strips referrer-policy (the Referer is what routes sub-resources)', () => {
    expect(run({ 'referrer-policy': 'no-referrer' })['referrer-policy']).toBeUndefined();
  });

  it('strips HSTS (an upstream must not set policy for palmux origin)', () => {
    expect(run({ 'strict-transport-security': 'max-age=1' })['strict-transport-security'])
      .toBeUndefined();
  });
});
