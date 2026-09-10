import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { SESSION_COOKIE, isRequestAuthed, readCookie, secretEquals } from './auth';

const fakeReq = (cookie?: string): IncomingMessage =>
  ({ headers: cookie === undefined ? {} : { cookie } }) as IncomingMessage;

describe('secretEquals', () => {
  it('is true for identical strings', () => {
    expect(secretEquals('abc123', 'abc123')).toBe(true);
    expect(secretEquals('', '')).toBe(true);
  });

  it('is false for same-length but different content', () => {
    expect(secretEquals('abc123', 'abc124')).toBe(false);
  });

  it('is false for a length mismatch', () => {
    expect(secretEquals('short', 'longer-value')).toBe(false);
    expect(secretEquals('x', '')).toBe(false);
  });
});

describe('readCookie', () => {
  it('returns null for a missing header', () => {
    expect(readCookie(undefined, SESSION_COOKIE)).toBeNull();
    expect(readCookie('', SESSION_COOKIE)).toBeNull();
  });

  it('reads a named cookie from a single-value header', () => {
    expect(readCookie(`${SESSION_COOKIE}=secret`, SESSION_COOKIE)).toBe('secret');
  });

  it('reads a named cookie from a multi-cookie header with whitespace', () => {
    const header = `foo=1; ${SESSION_COOKIE}=deadbeef ; bar=2`;
    expect(readCookie(header, SESSION_COOKIE)).toBe('deadbeef');
  });

  it('url-decodes the cookie value', () => {
    expect(readCookie(`${SESSION_COOKIE}=a%20b`, SESSION_COOKIE)).toBe('a b');
  });

  it('returns null when the named cookie is absent', () => {
    expect(readCookie('foo=1; bar=2', SESSION_COOKIE)).toBeNull();
  });

  it('skips malformed segments without an equals sign', () => {
    expect(readCookie(`garbage; ${SESSION_COOKIE}=ok`, SESSION_COOKIE)).toBe('ok');
  });
});

describe('isRequestAuthed', () => {
  const secret = 'a'.repeat(64);

  it('bypasses all checks when noAuth is set', () => {
    expect(isRequestAuthed(fakeReq(), { secret, noAuth: true })).toBe(true);
  });

  it('is true with a valid session cookie', () => {
    const req = fakeReq(`${SESSION_COOKIE}=${secret}`);
    expect(isRequestAuthed(req, { secret, noAuth: false })).toBe(true);
  });

  it('is false with an invalid session cookie', () => {
    const req = fakeReq(`${SESSION_COOKIE}=${'b'.repeat(64)}`);
    expect(isRequestAuthed(req, { secret, noAuth: false })).toBe(false);
  });

  it('is false when the session cookie is missing', () => {
    expect(isRequestAuthed(fakeReq('foo=bar'), { secret, noAuth: false })).toBe(false);
    expect(isRequestAuthed(fakeReq(), { secret, noAuth: false })).toBe(false);
  });
});
