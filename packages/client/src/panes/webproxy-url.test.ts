import { describe, expect, it } from 'vitest';
import { isProxiedUrl, proxiedFrameUrl } from './webproxy-url';

describe('proxiedFrameUrl', () => {
  it('routes a loopback url through the same-origin proxy', () => {
    expect(proxiedFrameUrl('http://localhost:5173')).toBe('/webproxy/5173/');
    expect(proxiedFrameUrl('http://127.0.0.1:5173/')).toBe('/webproxy/5173/');
    expect(proxiedFrameUrl('http://localhost:3000/dash?x=1')).toBe('/webproxy/3000/dash?x=1');
  });

  it('covers the other loopback spellings', () => {
    expect(proxiedFrameUrl('http://[::1]:8080/')).toBe('/webproxy/8080/');
    expect(proxiedFrameUrl('http://0.0.0.0:9000/')).toBe('/webproxy/9000/');
    expect(proxiedFrameUrl('HTTPS://LOCALHOST:5173/')).toBe('/webproxy/5173/');
  });

  it('always ends the bare form in a slash (root-absolute assets resolve there)', () => {
    expect(proxiedFrameUrl('http://localhost:5173')).toMatch(/\/$/);
  });

  it('leaves remote urls, same-origin paths and portless loopback alone', () => {
    expect(proxiedFrameUrl('https://github.com/x')).toBe('https://github.com/x');
    expect(proxiedFrameUrl('/artifacts/report.html')).toBe('/artifacts/report.html');
    expect(proxiedFrameUrl('http://localhost/')).toBe('http://localhost/');
    // A host that merely CONTAINS the word is not loopback.
    expect(proxiedFrameUrl('https://localhost.evil.com:80/')).toBe('https://localhost.evil.com:80/');
  });

  it('rejects an out-of-range port rather than minting a bad route', () => {
    expect(proxiedFrameUrl('http://localhost:99999/')).toBe('http://localhost:99999/');
  });

  it('isProxiedUrl reports the rewrite', () => {
    expect(isProxiedUrl('http://localhost:5173')).toBe(true);
    expect(isProxiedUrl('https://github.com')).toBe(false);
  });
});
