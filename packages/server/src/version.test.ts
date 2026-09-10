import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_APP_CONFIG, type AppConfig } from './app-config';
import { createServer, createSessionRegistry } from './server';
import { memoryTabsStore } from './tabs-store';
import { APP_VERSION } from './version';

describe('APP_VERSION', () => {
  it('is a non-empty version string (semver, optionally +sha)', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+(\+[0-9a-f]{4,40})?$/);
  });
});

describe('GET /version', () => {
  let app: FastifyInstance;
  let prevConfigDir: string | undefined;

  beforeAll(async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'palmux-version-'));
    prevConfigDir = process.env['PALMUX_CONFIG_DIR'];
    process.env['PALMUX_CONFIG_DIR'] = configDir;
    const cfg: AppConfig = { ...DEFAULT_APP_CONFIG, fontDirs: [], auth: false };
    const registry = createSessionRegistry(cfg, memoryTabsStore());
    app = await createServer(cfg, 'a'.repeat(64), registry);
  });

  afterAll(async () => {
    if (prevConfigDir === undefined) delete process.env['PALMUX_CONFIG_DIR'];
    else process.env['PALMUX_CONFIG_DIR'] = prevConfigDir;
    await app.close();
  });

  it('returns the build version as JSON', async () => {
    const res = await app.inject({ method: 'GET', url: '/version' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: APP_VERSION });
  });
});
