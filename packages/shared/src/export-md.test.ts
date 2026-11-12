// The scenario is the `review-comments` spec's "Copying for an agent": three
// comments in two files become one document with two file sections, three quoted
// code blocks and the three texts.

import type { ScmComment } from './scm-comments';
import { describe, expect, it } from 'vitest';
import { exportCommentsMarkdown, exportFileCommentsMarkdown } from './export-md';

const TOP = '/work/app';
const PREAMBLE = [
  '# Review comments',
  '',
  'Address each review comment below in /work/app. A heading names the file, the line range and the side',
  '(old = before the change, new = after it); the fenced block is the code the comment was written on.',
].join('\n');

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
    expect(exportCommentsMarkdown(TOP, [])).toBe('');
  });

  it('writes one comment as a heading, its range and side, its code and its text', () => {
    const md = exportCommentsMarkdown(TOP, [
      comment({
        start: 10,
        end: 11,
        lines: ['const a = 1;', 'const b = 2;'],
        body: 'merge these',
      }),
    ]);
    expect(md).toBe(
      [
        PREAMBLE,
        '',
        '## src/a.ts',
        '',
        '### src/a.ts:L10-L11 (new)',
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
    const md = exportCommentsMarkdown(TOP, [comment({ start: 42, end: 42, side: 'old' })]);
    expect(md).toContain('### src/a.ts:L42 (old)');
    expect(md).not.toContain('L42-L42');
  });

  describe('Copying for an agent', () => {
    const three = [
      comment({ path: 'src/b.ts', body: 'second file', lines: ['b'] }),
      comment({ path: 'src/a.ts', start: 20, end: 20, body: 'later in a', lines: ['later'] }),
      comment({ path: 'src/a.ts', start: 3, end: 3, body: 'early in a', lines: ['early'] }),
    ];
    const md = exportCommentsMarkdown(TOP, three);

    it('has a section per file, in path order', () => {
      expect(md.match(/^## .*$/gm)).toEqual(['## src/a.ts', '## src/b.ts']);
    });

    it('has a quoted code block and a text per comment', () => {
      expect(md.match(/^```/gm)).toHaveLength(6);
      for (const text of ['second file', 'later in a', 'early in a']) expect(md).toContain(text);
    });

    it('opens with the instruction naming the project, before the first file', () => {
      expect(md.startsWith(`${PREAMBLE}\n\n## src/a.ts\n`)).toBe(true);
    });

    it('heads every comment with its path, range and side', () => {
      expect(md.match(/^### .*$/gm)).toEqual([
        '### src/a.ts:L3 (new)',
        '### src/a.ts:L20 (new)',
        '### src/b.ts:L1 (new)',
      ]);
    });

    it('orders a file comments by line, whatever order they were made in', () => {
      expect(md.indexOf('early in a')).toBeLessThan(md.indexOf('later in a'));
      expect(md.indexOf('later in a')).toBeLessThan(md.indexOf('second file'));
    });
  });

  it('The heading names path and range: new-side lines 10 to 14 of src/a.ts', () => {
    const md = exportCommentsMarkdown(TOP, [comment({ start: 10, end: 14, lines: ['a', 'b', 'c', 'd', 'e'] })]);
    expect(md).toContain('\n### src/a.ts:L10-L14 (new)\n');
  });

  describe('One file’s comments', () => {
    const five = [
      comment({ path: 'src/a.ts', start: 1, end: 1, body: 'a one' }),
      comment({ path: 'src/b.ts', body: 'b one' }),
      comment({ path: 'src/a.ts', start: 5, end: 6, lines: ['x', 'y'], body: 'a two' }),
      comment({ path: 'src/c.ts', body: 'c one' }),
      comment({ path: 'src/b.ts', start: 9, end: 9, body: 'b two' }),
    ];

    it('is the instruction, one file section and that file’s comments only', () => {
      const md = exportFileCommentsMarkdown(TOP, 'src/a.ts', five);
      expect(md.startsWith(`${PREAMBLE}\n\n`)).toBe(true);
      expect(md.match(/^## .*$/gm)).toEqual(['## src/a.ts']);
      expect(md.match(/^### .*$/gm)).toEqual(['### src/a.ts:L1 (new)', '### src/a.ts:L5-L6 (new)']);
      for (const text of ['b one', 'b two', 'c one']) expect(md).not.toContain(text);
    });

    it('is the same text the whole document gives that file', () => {
      const whole = exportCommentsMarkdown(TOP, five.filter((c) => c.path === 'src/a.ts'));
      expect(exportFileCommentsMarkdown(TOP, 'src/a.ts', five)).toBe(whole);
    });

    it('is empty for a file with no comments', () => {
      expect(exportFileCommentsMarkdown(TOP, 'src/z.ts', five)).toBe('');
    });
  });

  it('orders paths by code unit, so a directory and a file sort the way git lists them', () => {
    const md = exportCommentsMarkdown(TOP, [
      comment({ path: 'b.ts' }),
      comment({ path: 'A.ts' }),
      comment({ path: 'a/z.ts' }),
      comment({ path: 'a.ts' }),
    ]);
    expect(md.match(/^## .*$/gm)).toEqual(['## A.ts', '## a.ts', '## a/z.ts', '## b.ts']);
  });

  it('puts the old side before the new one at the same range, then the earlier comment', () => {
    const md = exportCommentsMarkdown(TOP, [
      comment({ side: 'new', body: 'third', createdAt: 5 }),
      comment({ side: 'new', body: 'second', createdAt: 2 }),
      comment({ side: 'old', body: 'first', createdAt: 9 }),
    ]);
    const order = ['first', 'second', 'third'].map((text) => md.indexOf(text));
    expect(order).toEqual(order.toSorted((a, b) => a - b));
  });

  describe('fences', () => {
    it('names the file language, from the path', () => {
      const md = exportCommentsMarkdown(TOP, [
        comment({ path: 'x/run.py', lines: ['print(1)'] }),
        comment({ path: 'x/ui.tsx', lines: ['<A />'] }),
        comment({ path: 'x/setup.sh', lines: ['ls'] }),
      ]);
      expect(md).toContain('```python\nprint(1)\n```');
      expect(md).toContain('```typescript\n<A />\n```');
      expect(md).toContain('```shell\nls\n```');
    });

    it('leaves a file with no known language on a bare fence', () => {
      const md = exportCommentsMarkdown(TOP, [comment({ path: 'NOTES.weird', lines: ['x'] })]);
      expect(md).toContain('```\nx\n```');
      expect(md).not.toContain('plaintext');
    });

    it('grows the fence past any backtick run in the code', () => {
      const md = exportCommentsMarkdown(TOP, [
        comment({ path: 'doc.md', lines: ['```ts', 'const a = 1;', '```'] }),
      ]);
      expect(md).toContain('````markdown\n```ts\nconst a = 1;\n```\n````');
    });

    it('quotes the stored lines exactly, blank lines and indentation included', () => {
      const md = exportCommentsMarkdown(TOP, [
        comment({ start: 5, end: 7, lines: ['  if (x) {', '', '  }'] }),
      ]);
      expect(md).toContain('```typescript\n  if (x) {\n\n  }\n```');
    });
  });

  describe('outdated comments', () => {
    it('are included and marked, with the original code quoted', () => {
      const gone = comment({ id: 'gone', lines: ['removed();'], body: 'why was this here' });
      const kept = comment({ id: 'kept', lines: ['kept();'], body: 'fine' });
      const md = exportCommentsMarkdown(TOP, [gone, kept], { outdated: new Set(['gone']) });
      expect(md).toContain('### src/a.ts:L1 (new) (outdated)\n\n```typescript\nremoved();\n```');
      expect(md).toContain('why was this here');
      expect(md.match(/\(outdated\)/g)).toHaveLength(1);
    });

    it('are not marked when nothing says they are', () => {
      expect(exportCommentsMarkdown(TOP, [comment()])).not.toContain('outdated');
    });
  });

  describe('the body', () => {
    it('is written as typed, line breaks included', () => {
      const md = exportCommentsMarkdown(TOP, [comment({ body: 'one\n\n- two\n- three' })]);
      expect(md).toContain('\n\none\n\n- two\n- three\n');
    });

    it('drops trailing whitespace, so the document ends on one newline', () => {
      const md = exportCommentsMarkdown(TOP, [comment({ body: 'text\n\n  \n' })]);
      expect(md.endsWith('text\n')).toBe(true);
    });

    it('leaves out the text of an empty comment and keeps its code', () => {
      const md = exportCommentsMarkdown(TOP, [comment({ body: '', lines: ['x'] })]);
      expect(md).toBe(`${PREAMBLE}\n\n## src/a.ts\n\n### src/a.ts:L1 (new)\n\n\`\`\`typescript\nx\n\`\`\`\n`);
    });
  });
});

describe('a comment on a file palmux did not read', () => {
  it('is marked as not shown, in words that name why, and never as outdated', () => {
    const md = exportCommentsMarkdown(TOP, [comment({ id: 'big', start: 4, end: 4 })], {
      unread: new Set(['big']),
    });
    expect(md).toContain('### src/a.ts:L4 (new) (not shown: file too large / converted)');
    expect(md).not.toContain('outdated');
  });

  it('marks only the comments it was told about, and outdated ones still say so', () => {
    const md = exportCommentsMarkdown(TOP, 
      [
        comment({ id: 'a', start: 1, end: 1 }),
        comment({ id: 'b', start: 2, end: 2 }),
        comment({ id: 'c', start: 3, end: 3 }),
      ],
      { outdated: new Set(['b']), unread: new Set(['c']) },
    );
    expect(md).toMatch(/^### src\/a\.ts:L1 \(new\)\n/m);
    expect(md).toContain('### src/a.ts:L2 (new) (outdated)');
    expect(md).toContain('### src/a.ts:L3 (new) (not shown: file too large / converted)');
  });

  it('still quotes its code and its text', () => {
    const md = exportCommentsMarkdown(TOP, [comment({ id: 'big', body: 'split this up' })], {
      unread: new Set(['big']),
    });
    expect(md).toContain('const a = 1;');
    expect(md).toContain('split this up');
  });
});
