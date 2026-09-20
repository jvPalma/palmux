import { describe, expect, it } from 'vitest';
import { parseArgs } from './args';

const ok = (argv: string[]) => {
  const parsed = parseArgs(argv);
  if (!parsed.ok) throw new Error(`expected a command, got: ${parsed.error}`);
  return parsed.command;
};

const err = (argv: string[]) => {
  const parsed = parseArgs(argv);
  if (parsed.ok) throw new Error(`expected a failure, got: ${JSON.stringify(parsed.command)}`);
  return parsed.error;
};

describe('parseArgs', () => {
  it('bare invocation prints help', () => {
    expect(ok([])).toEqual({ kind: 'help' });
  });

  it('accepts the three help spellings', () => {
    for (const word of ['help', '--help', '-h']) {
      expect(ok([word])).toEqual({ kind: 'help' });
    }
  });

  // The whole feature: `code`-style. An absolute path is passed through verbatim
  // — resolving it against the CLI's cwd is `index.ts`'s job, because it is also
  // the cwd the user's shell is in, which the server cannot know.
  it('a bare word is a PATH, not a misspelled subcommand', () => {
    expect(ok(['/home/user/.tmux.conf'])).toEqual({ kind: 'open', path: '/home/user/.tmux.conf' });
    expect(ok(['./notes.txt'])).toEqual({ kind: 'open', path: './notes.txt' });
    expect(ok(['tabz'])).toEqual({ kind: 'open', path: 'tabz' });
  });

  it('open takes exactly one path', () => {
    expect(ok(['open', '/tmp/a.txt'])).toEqual({ kind: 'open', path: '/tmp/a.txt' });
    expect(err(['open'])).toBe('open needs a path');
    expect(err(['open', ''])).toBe('open needs a path');
    expect(err(['open', '/a', '/b'])).toBe('unexpected argument: /b');
  });

  // `palmux tabs` is the subcommand, so a file actually named `tabs` needs the
  // explicit form — the documented escape hatch.
  it('a subcommand word wins over a path, and `open` reaches it anyway', () => {
    for (const word of ['tabs', 'groups', 'settings', 'status']) {
      expect(ok([word])).toEqual({ kind: word });
      expect(ok(['open', `./${word}`])).toEqual({ kind: 'open', path: `./${word}` });
    }
  });

  it('the nullary subcommands take no arguments', () => {
    expect(err(['tabs', 'extra'])).toBe('tabs takes no arguments');
    expect(err(['status', '--json'])).toBe('status takes no arguments');
  });

  // A bare word after a path is a shell mistake worth naming — silently ignoring
  // it would open the first path and report success.
  it('refuses a second bare word', () => {
    expect(err(['/a.txt', '/b.txt'])).toBe('unexpected argument: /b.txt');
  });

  // The launcher routes `serve` to the server bundle, so reaching that branch
  // means the CLI was run directly. Naming the right command beats treating
  // `serve` as a path and reporting that no file called "serve" exists.
  it('points `serve` at the server entry rather than opening a file named serve', () => {
    expect(err(['serve'])).toBe('serve runs the server — use `yarn start`');
    expect(err(['serve', '--print-config'])).toContain('serve runs the server');
  });

  // Flags belong to the SERVER entry. Seeing one here is a routing failure, and
  // "unknown option" says so; opening a tab for `--help` would not.
  it('refuses a flag rather than treating it as a path', () => {
    expect(err(['--print-config'])).toBe('unknown option: --print-config');
    expect(err(['-x'])).toBe('unknown option: -x');
  });

  // Help is checked before the positional rules, so it wins even when the rest
  // of the line is nonsense — asking for help should never be the thing that
  // errors.
  it('help short-circuits the rest of the line', () => {
    expect(ok(['--help', 'whatever'])).toEqual({ kind: 'help' });
  });
});
