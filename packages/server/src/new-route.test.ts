import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_APP_CONFIG, type AppConfig } from './app-config';
import { SESSION_COOKIE } from './auth';
import { createServer, createSessionRegistry, type SessionRegistry } from './server';
import { memoryTabsStore } from './tabs-store';

const baseCfg: AppConfig = { ...DEFAULT_APP_CONFIG, fontDirs: [] };
const secret = 'a'.repeat(64);

// Registries in tests always get a memory store so they never touch the real
// ~/.config/palmux/tabs.json.
const testRegistry = (cfg: AppConfig) => createSessionRegistry(cfg, memoryTabsStore());

describe('GET /new (auth enabled)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const cfg = { ...baseCfg, auth: true };
    app = await createServer(cfg, secret, testRegistry(cfg));
  });
  afterAll(async () => {
    await app.close();
  });

  it('is gated by the session cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/new' });
    expect(res.statusCode).toBe(401);
  });

  // `/new` is the script-facing "open me a terminal" (`xdg-open http://host/new`).
  // It used to 302 to `/<lowest free id>`, back when the path WAS the tab. The
  // path no longer addresses a tab, so it redirects to an INTENT and the client
  // allocates the id at the moment it is used — rather than a redirect handing
  // out an id that may be minutes stale by the time the page loads.
  it('redirects to the new-terminal intent when the cookie is valid', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/new',
      cookies: { [SESSION_COOKIE]: secret },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/?new=1');
  });
});

describe('GET /new (no auth)', () => {
  let app: FastifyInstance;
  let registry: SessionRegistry;

  beforeAll(async () => {
    registry = testRegistry({ ...baseCfg, auth: false });
    app = await createServer({ ...baseCfg, auth: false }, secret, registry);
  });
  afterAll(async () => {
    for (const id of registry.ids()) registry.kill(id);
    await app.close();
  });

  // The redirect no longer depends on server state at all. It used to answer
  // `/<lowest free id>`, which meant the id was chosen at REDIRECT time and could
  // be stale — or taken — by the time the page finished loading. The client
  // allocates it at the moment it creates the tab instead. `nextFreeId` still
  // has its own tests; what is pinned here is that the route stopped caring.
  it('answers the same intent whether or not sessions exist', async () => {
    const empty = await app.inject({ method: 'GET', url: '/new' });
    expect(empty.statusCode).toBe(302);
    expect(empty.headers.location).toBe('/?new=1');

    registry.get('0'); // spawn PTYs so the ids are live
    registry.get('1');
    registry.get('3');
    const busy = await app.inject({ method: 'GET', url: '/new' });
    expect(busy.statusCode).toBe(302);
    expect(busy.headers.location).toBe('/?new=1');
  });
});
