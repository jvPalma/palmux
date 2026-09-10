import { describe, expect, it } from 'vitest';
import { isEmbeddableUrl, isSameOriginUrl, normalizeUrl } from './normalize-url';

describe('normalizeUrl', () => {
  it('prefixes bare hosts with https://', () => {
    expect(normalizeUrl('sb.example.com')).toBe('https://sb.example.com');
    expect(normalizeUrl('  sb.example.com/path  ')).toBe('https://sb.example.com/path');
  });

  it('passes through http(s) urls and same-origin paths', () => {
    expect(normalizeUrl('http://10.0.0.5:3000')).toBe('http://10.0.0.5:3000');
    expect(normalizeUrl('HTTPS://x.dev')).toBe('HTTPS://x.dev');
    expect(normalizeUrl('/artifacts/report.html')).toBe('/artifacts/report.html');
  });

  it('rejects empty input, non-http schemes, and protocol-relative external urls', () => {
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('   ')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('data:text/html,x')).toBeNull();
    expect(normalizeUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeUrl('//evil.com/x')).toBeNull(); // protocol-relative external
  });
});

describe('isEmbeddableUrl', () => {
  it('accepts http(s) and single-slash same-origin paths only', () => {
    expect(isEmbeddableUrl('https://x.dev')).toBe(true);
    expect(isEmbeddableUrl('http://x.dev')).toBe(true);
    expect(isEmbeddableUrl('/artifacts/a.html')).toBe(true);
    expect(isEmbeddableUrl('//evil.com')).toBe(false);
    expect(isEmbeddableUrl('javascript:alert(1)')).toBe(false);
    expect(isEmbeddableUrl('data:x')).toBe(false);
    expect(isEmbeddableUrl('')).toBe(false);
  });
});

describe('isSameOriginUrl', () => {
  it('is true only for single-slash-rooted paths', () => {
    expect(isSameOriginUrl('/artifacts/a.html')).toBe(true);
    expect(isSameOriginUrl('//evil.com')).toBe(false);
    expect(isSameOriginUrl('https://x.dev')).toBe(false);
  });
});
