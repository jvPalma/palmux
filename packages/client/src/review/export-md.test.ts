// The scenario is the `review-comments` spec's "Copying for an agent": three
// comments in two files become one document with two file sections, three quoted
// code blocks and the three texts.

import type { ScmComment } from '@palmux/shared';
import { describe, expect, it } from 'vitest';
import { exportCommentsMarkdown } from './export-md';

let seq = 0;
const comment = (over: Partial<ScmComment> = {}): ScmComment => {
  seq += 1;
  return {
    id: `c${seq}`,
    path: 'src/a.ts',
    version: 'worktree',
    side: 'new',
    start: 1,
    end: 1,
    lines: ['const a = 1;'],
    before: [],
    after: [],
    body: 'rename this',
    createdAt: seq,
    updatedAt: seq,
    ...over,
  };
};

describe('exportCommentsMarkdown', () => {
  it('exports nothing for no comments', () => {
    expect(exportCommentsMarkdown([])).toBe('');
  });

  it('writes one comment as a heading, its range and side, its code and its text', () => {
    const md = exportCommentsMarkdown([
      comment({
        start: 10,
        end: 11,
        lines: ['const a = 1;', 'const b = 2;'],
        body: 'merge these',
      }),
    ]);
    expect(md).toBe(
      [
        '## src/a.ts',
        '',
        '**L10–11** (new)',
        '',
        '```typescript',
        'const a = 1;',
        'const b = 2;',
        '```',
        '',
        'merge these',
        '',
      ].join('\n'),
    );
  });

  it('writes a one-line range as one number and names the old side', () => {
    const md = exportCommentsMarkdown([comment({ start: 42, end: 42, side: 'old' })]);
    expect(md).toContain('**L42** (old)');
    expect(md).not.toContain('L42–42');
  });

  describe('Copying for an agent', () => {
    const three = [
      comment({ path: 'src/b.ts', body: 'second file', lines: ['b'] }),
      comment({ path: 'src/a.ts', start: 20, end: 20, body: 'later in a', lines: ['later'] }),
      comment({ path: 'src/a.ts', start: 3, end: 3, body: 'early in a', lines: ['early'] }),
    ];
    const md = exportCommentsMarkdown(three);

    it('has a section per file, in path order', () => {
      expect(md.match(/^## .*$/gm)).toEqual(['## src/a.ts', '## src/b.ts']);
    });

    it('has a quoted code block and a text per comment', () => {
      expect(md.match(/^```/gm)).toHaveLength(6);
      for (const text of ['second file', 'later in a', 'early in a']) expect(md).toContain(text);
    });

    it('orders a file comments by line, whatever order they were made in', () => {
      expect(md.indexOf('early in a')).toBeLessThan(md.indexOf('later in a'));
      expect(md.indexOf('later in a')).toBeLessThan(md.indexOf('second file'));
    });
  });

  it('orders paths by code unit, so a directory and a file sort the way git lists them', () => {
    const md = exportCommentsMarkdown([
      comment({ path: 'b.ts' }),
      comment({ path: 'A.ts' }),
      comment({ path: 'a/z.ts' }),
      comment({ path: 'a.ts' }),
    ]);
    expect(md.match(/^## .*$/gm)).toEqual(['## A.ts', '## a.ts', '## a/z.ts', '## b.ts']);
  });

  it('puts the old side before the new one at the same range, then the earlier comment', () => {
    const md = exportCommentsMarkdown([
      comment({ side: 'new', body: 'third', createdAt: 5 }),
      comment({ side: 'new', body: 'second', createdAt: 2 }),
      comment({ side: 'old', body: 'first', createdAt: 9 }),
    ]);
    const order = ['first', 'second', 'third'].map((text) => md.indexOf(text));
    expect(order).toEqual(order.toSorted((a, b) => a - b));
  });

  describe('fences', () => {
    it('names the file language, from the path', () => {
      const md = exportCommentsMarkdown([
        comment({ path: 'x/run.py', lines: ['print(1)'] }),
        comment({ path: 'x/ui.tsx', lines: ['<A />'] }),
        comment({ path: 'x/setup.sh', lines: ['ls'] }),
      ]);
      expect(md).toContain('```python\nprint(1)\n```');
      expect(md).toContain('```typescript\n<A />\n```');
      expect(md).toContain('```shell\nls\n```');
    });

    it('leaves a file with no known language on a bare fence', () => {
      const md = exportCommentsMarkdown([comment({ path: 'NOTES.weird', lines: ['x'] })]);
      expect(md).toContain('```\nx\n```');
      expect(md).not.toContain('plaintext');
    });

    it('grows the fence past any backtick run in the code', () => {
      const md = exportCommentsMarkdown([
        comment({ path: 'doc.md', lines: ['```ts', 'const a = 1;', '```'] }),
      ]);
      expect(md).toContain('````markdown\n```ts\nconst a = 1;\n```\n````');
    });

    it('quotes the stored lines exactly, blank lines and indentation included', () => {
      const md = exportCommentsMarkdown([
        comment({ start: 5, end: 7, lines: ['  if (x) {', '', '  }'] }),
      ]);
      expect(md).toContain('```typescript\n  if (x) {\n\n  }\n```');
    });
  });

  describe('outdated comments', () => {
    it('are included and marked, with the original code quoted', () => {
      const gone = comment({ id: 'gone', lines: ['removed();'], body: 'why was this here' });
      const kept = comment({ id: 'kept', lines: ['kept();'], body: 'fine' });
      const md = exportCommentsMarkdown([gone, kept], { outdated: new Set(['gone']) });
      expect(md).toContain('**L1** (new) (outdated)\n\n```typescript\nremoved();\n```');
      expect(md).toContain('why was this here');
      expect(md.match(/\(outdated\)/g)).toHaveLength(1);
    });

    it('are not marked when nothing says they are', () => {
      expect(exportCommentsMarkdown([comment()])).not.toContain('outdated');
    });
  });

  describe('the body', () => {
    it('is written as typed, line breaks included', () => {
      const md = exportCommentsMarkdown([comment({ body: 'one\n\n- two\n- three' })]);
      expect(md).toContain('\n\none\n\n- two\n- three\n');
    });

    it('drops trailing whitespace, so the document ends on one newline', () => {
      const md = exportCommentsMarkdown([comment({ body: 'text\n\n  \n' })]);
      expect(md.endsWith('text\n')).toBe(true);
    });

    it('leaves out the text of an empty comment and keeps its code', () => {
      const md = exportCommentsMarkdown([comment({ body: '', lines: ['x'] })]);
      expect(md).toBe('## src/a.ts\n\n**L1** (new)\n\n```typescript\nx\n```\n');
    });
  });
});

describe('a comment on a file palmux did not read', () => {
  it('is marked as not shown, in words that name why, and never as outdated', () => {
    const md = exportCommentsMarkdown([comment({ id: 'big', start: 4, end: 4 })], {
      unread: new Set(['big']),
    });
    expect(md).toContain('**L4** (new) (not shown: file too large / converted)');
    expect(md).not.toContain('outdated');
  });

  it('marks only the comments it was told about, and outdated ones still say so', () => {
    const md = exportCommentsMarkdown(
      [
        comment({ id: 'a', start: 1, end: 1 }),
        comment({ id: 'b', start: 2, end: 2 }),
        comment({ id: 'c', start: 3, end: 3 }),
      ],
      { outdated: new Set(['b']), unread: new Set(['c']) },
    );
    expect(md).toMatch(/\*\*L1\*\* \(new\)\n/);
    expect(md).toContain('**L2** (new) (outdated)');
    expect(md).toContain('**L3** (new) (not shown: file too large / converted)');
  });

  it('still quotes its code and its text', () => {
    const md = exportCommentsMarkdown([comment({ id: 'big', body: 'split this up' })], {
      unread: new Set(['big']),
    });
    expect(md).toContain('const a = 1;');
    expect(md).toContain('split this up');
  });
});
