import { afterEach, describe, expect, it } from 'vitest';
import { loadEnvFile, parseEnvFile } from './env-file';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'palmux-envfile-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('parseEnvFile', () => {
  it('parses KEY=VALUE, comments, blanks and quoted values', () => {
    const out = parseEnvFile(`
# a comment
OPEN_ROUTER_API_KEY=sk-or-v1-abc
GEMINI_API_KEY="AIza-sy"

  QUOTED='single'
EMPTY=
=bare
no-equals
1INVALID=x
`);
    expect(out).toEqual({
      OPEN_ROUTER_API_KEY: 'sk-or-v1-abc',
      GEMINI_API_KEY: 'AIza-sy',
      QUOTED: 'single',
      EMPTY: '',
    });
  });
});

describe('loadEnvFile', () => {
  afterEach(() => {
    delete process.env['ENVF_A'];
    delete process.env['ENVF_B'];
  });

  it('sets file variables into the process env, never overriding existing ones', () => {
    const f = join(tmp(), 'env');
    writeFileSync(f, 'ENVF_A=from-file\nENVF_B=from-file\n');
    process.env['ENVF_B'] = 'from-process';
    loadEnvFile(f);
    expect(process.env['ENVF_A']).toBe('from-file');
    expect(process.env['ENVF_B']).toBe('from-process');
  });

  it('is a no-op when the file does not exist', () => {
    loadEnvFile(join(tmp(), 'nope'));
  });
});
