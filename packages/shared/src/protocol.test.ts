import { describe, expect, it } from 'vitest';
import { parseServerMessage } from './protocol';

describe('parseServerMessage cli frames', () => {
  it('keeps the valid goto entries of a cliOpen and drops a malformed one', () => {
    const msg = parseServerMessage(
      JSON.stringify({
        type: 'cliOpen',
        requestId: 'r',
        paths: ['/a.ts'],
        goto: [
          { path: '/a.ts', line: 4, column: 2 },
          { path: '/a.ts', line: 9, column: 0 },
          { path: '/a.ts', line: 0 },
          { path: '', line: 3 },
          'x',
        ],
      }),
    );
    expect(msg).toEqual({
      type: 'cliOpen',
      requestId: 'r',
      paths: ['/a.ts'],
      goto: [
        { path: '/a.ts', line: 4, column: 2 },
        { path: '/a.ts', line: 9 },
      ],
    });
  });

  it('reads a cliOpen without goto as before, and a cliWeb', () => {
    expect(
      parseServerMessage(JSON.stringify({ type: 'cliOpen', requestId: 'r', paths: ['/a'] })),
    ).toEqual({
      type: 'cliOpen',
      requestId: 'r',
      paths: ['/a'],
    });
    expect(
      parseServerMessage(JSON.stringify({ type: 'cliWeb', requestId: 'r', url: 'http://x/' })),
    ).toEqual({
      type: 'cliWeb',
      requestId: 'r',
      url: 'http://x/',
    });
    expect(parseServerMessage(JSON.stringify({ type: 'cliWeb', requestId: 'r' }))).toBeNull();
  });
});
