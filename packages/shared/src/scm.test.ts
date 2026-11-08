import { describe, expect, it } from 'vitest';
import { fileReviewUrl, parseReviewUrl, reviewUrl } from './scm.js';

describe('review urls', () => {
  it('parses the old form unchanged', () => {
    expect(parseReviewUrl(reviewUrl('changes', '/a/b'))).toEqual({ group: 'changes', top: '/a/b' });
    expect(parseReviewUrl('staged:/x')).toEqual({ group: 'staged', top: '/x' });
    expect(parseReviewUrl('web:/x')).toBeNull();
  });

  it('round-trips a path with special characters', () => {
    const file = 'dir with space/a:b%c#d/é ü.ts';
    const url = fileReviewUrl('staged', '/home/u/app', file);
    expect(parseReviewUrl(url)).toEqual({ group: 'staged', top: '/home/u/app', file });
  });

  it('matches the documented example', () => {
    expect(fileReviewUrl('changes', '/home/u/app', 'src/a.ts')).toBe(
      'changes-file:%2Fhome%2Fu%2Fapp:src%2Fa.ts',
    );
  });

  it.each([
    ['..', '../x'],
    ['.git', '.git/x'],
    ['.GIT', 'a/.GIT/x'],
    ['absolute', '/etc/x'],
    ['empty', ''],
    ['empty component', 'a//b'],
    ['dot', './a'],
  ])('rejects %s', (_n, file) => {
    expect(parseReviewUrl(fileReviewUrl('changes', '/a', file))).toBeNull();
  });

  it('rejects a bad escape and a relative top', () => {
    expect(parseReviewUrl('changes-file:%2Fa:%E0%A4%A')).toBeNull();
    expect(parseReviewUrl(fileReviewUrl('changes', 'rel', 'x.ts'))).toBeNull();
    expect(parseReviewUrl('changes-file:%2Fa')).toBeNull();
    expect(parseReviewUrl('other-file:%2Fa:x')).toBeNull();
  });

  // A JSON frame can carry a raw lone surrogate, which decodeURIComponent passes through and
  // encodeURIComponent then throws on, so the canonicaliser must never see one.
  it('rejects a lone surrogate in either component, and keeps a well-formed pair', () => {
    expect(parseReviewUrl('changes-file:%2Fa:x\ud800')).toBeNull();
    expect(parseReviewUrl('changes-file:%2Fa:x\udc00y')).toBeNull();
    expect(parseReviewUrl('staged-file:%2Fa\ud800:x.ts')).toBeNull();
    const file = 'emoji 😀/a.ts';
    expect(parseReviewUrl(fileReviewUrl('changes', '/a/😀', file))).toEqual({
      group: 'changes',
      top: '/a/😀',
      file,
    });
    expect(parseReviewUrl('changes-file:%2Fa:x😀')).toEqual({
      group: 'changes',
      top: '/a',
      file: 'x😀',
    });
  });
});
