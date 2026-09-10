// The markdown pipeline's safety + rewriting contract, against the REAL
// marked + dompurify: hostile files are inert, links/images route correctly.
//
// @vitest-environment jsdom
// DOMPurify targets a spec-faithful DOM; happy-dom (the default env) mis-walks
// its tree and leaves <script> in — the sanitization guarantee must be tested
// on jsdom (and is re-verified live in the browser e2e).

import { describe, expect, it } from 'vitest';
import { renderMarkdown, resolveRelative } from './markdown-render';

const PATH = '/home/user/docs/index.md';

describe('resolveRelative', () => {
  it('resolves ./, ../, and bare names against the file directory', () => {
    expect(resolveRelative(PATH, './a.md')).toBe('/home/user/docs/a.md');
    expect(resolveRelative(PATH, 'sub/b.md')).toBe('/home/user/docs/sub/b.md');
    expect(resolveRelative(PATH, '../c.md')).toBe('/home/user/c.md');
    expect(resolveRelative(PATH, '../../../../../etc/passwd')).toBe('/etc/passwd');
  });

  it('treats a leading-/ target as absolute, not grafted under the dir', () => {
    expect(resolveRelative(PATH, '/home/user/other/notes.md')).toBe('/home/user/other/notes.md');
    expect(resolveRelative(PATH, '/etc/hosts')).toBe('/etc/hosts');
  });
});

describe('renderMarkdown — hostile input is inert', () => {
  it('strips script tags, event handlers, and javascript: URLs', async () => {
    const html = await renderMarkdown(
      [
        '# t',
        '<script>window.pwned = 1;</script>',
        '<img src="x" onerror="window.pwned=2">',
        '[click](javascript:alert(1))',
        '<style>body{display:none}</style>',
        '<iframe src="https://evil.example"></iframe>',
      ].join('\n\n'),
      PATH,
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('<iframe');
  });

  it('renders normal markdown structure', async () => {
    const html = await renderMarkdown('# Title\n\n- a\n- b\n\n`code`\n', PATH);
    expect(html).toContain('<h1');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('<code>code</code>');
  });
});

describe('renderMarkdown — link and image rewriting', () => {
  it('relative .md links become internal navigation with a raw-file fallback href', async () => {
    const html = await renderMarkdown('[next](./sub/next.md)', PATH);
    expect(html).toContain('data-md-path="/home/user/docs/sub/next.md"');
    expect(html).toContain('class="md-internal"');
    // Fallback href for middle-click; NEVER a bare '#'.
    expect(html).toContain(
      `href="/md-file?path=${encodeURIComponent('/home/user/docs/sub/next.md')}"`,
    );
    expect(html).not.toContain('href="#"');
  });

  it('external links open a new browser tab, never the app', async () => {
    const html = await renderMarkdown('[ext](https://example.com/x)', PATH);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('href="https://example.com/x"');
  });

  it('relative non-md links and images route through /md-file', async () => {
    const html = await renderMarkdown('[data](./raw.txt)\n\n![pic](./img/p.png)', PATH);
    expect(html).toContain(`href="/md-file?path=${encodeURIComponent('/home/user/docs/raw.txt')}"`);
    expect(html).toContain(
      `src="/md-file?path=${encodeURIComponent('/home/user/docs/img/p.png')}"`,
    );
  });

  it('pure anchors survive untouched; no anchor file → relative links go inert', async () => {
    expect(await renderMarkdown('[top](#top)', PATH)).toContain('href="#top"');
    const inert = await renderMarkdown('[next](./a.md)\n\n![p](./p.png)', undefined);
    expect(inert).not.toContain('data-md-path');
    expect(inert).not.toContain('/md-file');
  });

  it('non-ASCII / spaced filenames resolve to the real path (no double-encoding)', async () => {
    // marked percent-encodes these; the renderer decodes once, then MD_FILE_URL
    // encodes exactly once — so the server receives the true filename.
    const html = await renderMarkdown('![i](./café.png)\n\n[d](<my notes.txt>)', PATH);
    expect(html).toContain(`src="/md-file?path=${encodeURIComponent('/home/user/docs/café.png')}"`);
    expect(html).toContain(
      `href="/md-file?path=${encodeURIComponent('/home/user/docs/my notes.txt')}"`,
    );
    // Never a double-encoded %25.
    expect(html).not.toContain('%25');
  });
});
