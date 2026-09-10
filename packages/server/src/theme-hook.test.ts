// The theme hook: an on-disk script that replaces the built-in Claude export so
// the mapping can be changed without restarting the service.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runThemeHook, themeHookLogPath, themeHookPath } from './theme-hook';

const settle = (ms = 1500): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('theme hook', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'palmux-hook-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports NOT handled when there is no hook, so the built-in export runs', () => {
    expect(runThemeHook(dir)).toBe(false);
  });

  it('runs the hook and hands it the config dir', async () => {
    writeFileSync(
      themeHookPath(dir),
      `import { writeFileSync } from 'node:fs';
       import { join } from 'node:path';
       writeFileSync(join(process.env.PALMUX_CONFIG_DIR, 'hook-ran'), 'yes');`,
    );
    expect(runThemeHook(dir)).toBe(true);
    await settle();
    expect(readFileSync(join(dir, 'hook-ran'), 'utf8')).toBe('yes');
  });

  it('is re-read from disk every run — that is the whole point', async () => {
    const write = (marker: string): void =>
      writeFileSync(
        themeHookPath(dir),
        `import { writeFileSync } from 'node:fs';
         import { join } from 'node:path';
         writeFileSync(join(process.env.PALMUX_CONFIG_DIR, 'out'), '${marker}');`,
      );
    write('first');
    runThemeHook(dir);
    await settle();
    expect(readFileSync(join(dir, 'out'), 'utf8')).toBe('first');
    // Edited in place, no restart, no rebuild.
    write('second');
    runThemeHook(dir);
    await settle();
    expect(readFileSync(join(dir, 'out'), 'utf8')).toBe('second');
  });

  it('a throwing hook is non-fatal, and says so in the log', async () => {
    writeFileSync(themeHookPath(dir), `throw new Error('hook exploded');`);
    expect(() => runThemeHook(dir)).not.toThrow();
    await settle();
    const log = readFileSync(themeHookLogPath(dir), 'utf8');
    expect(log).toContain('FAILED');
    expect(log).toContain('hook exploded');
  });
});
