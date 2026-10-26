// The socket handlers the source-control-review change touched, end to end.
// `settings`: a client that sends only some keys must not reset the stored ones,
// export the default palette, or broadcast a blob that has lost them.
// `createTab`/`updateTab` for a review: one tab per canonical url, whoever asks.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { JsonObject, ServerMessage } from '@palmux/shared';
import { DEFAULT_APP_CONFIG, type AppConfig } from './app-config';
import { createServer, createSessionRegistry, type SessionRegistry } from './server';
import { memoryGroupsStore, memoryTabsStore } from './tabs-store';
import { memoryRestoreStore } from './session-restore';

const ENV_KEYS = ['HOME', 'PALMUX_CONFIG_DIR', 'TMUX_TMPDIR', 'XDG_CONFIG_HOME'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const scratch: string[] = [];

let app: FastifyInstance;
let registry: SessionRegistry;
let port: number;
let configDir: string;
let home: string;

beforeAll(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  // The theme export writes ~/.claude/themes/palmux.json and may re-source a
  // tmux config under HOME: point all of it at scratch directories.
  home = mkdtempSync(join(tmpdir(), 'palmux-wsset-home-'));
  configDir = mkdtempSync(join(tmpdir(), 'palmux-wsset-cfg-'));
  scratch.push(home, configDir);
  process.env['HOME'] = home;
  process.env['PALMUX_CONFIG_DIR'] = configDir;
  process.env['TMUX_TMPDIR'] = mkdtempSync(join(tmpdir(), 'palmux-wsset-tmux-'));
  scratch.push(process.env['TMUX_TMPDIR']);
  delete process.env['XDG_CONFIG_HOME'];

  const cfg: AppConfig = { ...DEFAULT_APP_CONFIG, fontDirs: [], auth: false };
  registry = createSessionRegistry(
    cfg,
    memoryTabsStore(),
    memoryGroupsStore(),
    undefined,
    memoryRestoreStore(),
  );
  app = await createServer(cfg, 'a'.repeat(64), registry);
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as { port: number }).port;
});

afterAll(async () => {
  await app.close();
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

interface Client {
  ws: WebSocket;
  frames: ServerMessage[];
}

function connect(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?control=1`);
    const frames: ServerMessage[] = [];
    ws.on('message', (data, isBinary) => {
      if (!isBinary) frames.push(JSON.parse(data.toString()) as ServerMessage);
    });
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('error', reject);
  });
}

const until = (done: () => boolean, label: string): Promise<void> =>
  vi.waitFor(
    () => {
      if (!done()) throw new Error(`timed out waiting for ${label}`);
    },
    { timeout: 4000, interval: 10 },
  );

/** A ping answered means every frame this socket sent before it has been handled. */
async function settled(client: Client): Promise<void> {
  const seen = client.frames.filter((f) => f.type === 'pong').length;
  client.ws.send(JSON.stringify({ type: 'ping' }));
  await until(() => client.frames.filter((f) => f.type === 'pong').length > seen, 'a pong');
}

const tabCreatedIds = (client: Client) =>
  client.frames.flatMap((f) => (f.type === 'tabCreated' ? [f.id] : []));

const settingsFrames = (client: Client) =>
  client.frames.flatMap((f) => (f.type === 'settings' ? [f.settings] : []));

const read = (path: string) => readFileSync(path, 'utf8');
describe('WS settings handler', () => {
  it('a partial save without themeId keeps the stored theme, its exports and the broadcast', async () => {
    const full = await connect();
    const observer = await connect();
    const older = await connect();
    try {
      // The observer's handshake already delivered one settings frame; count from here.
      await until(() => settingsFrames(observer).length >= 1, 'the observer handshake');
      const seen = settingsFrames(observer).length;

      const first: JsonObject = { themeId: 'dracula', fontSize: 14, scmRepos: ['/work/a'] };
      full.ws.send(JSON.stringify({ type: 'settings', settings: first }));
      await until(() => settingsFrames(observer).length > seen, 'the first broadcast');
      expect(settingsFrames(observer).at(-1)).toEqual(first);

      const themeSh = join(configDir, 'theme.sh');
      const claudePath = join(home, '.claude', 'themes', 'palmux.json');
      expect(read(themeSh)).toContain("export PALMUX_THEME='dracula'");
      expect(existsSync(claudePath)).toBe(true);
      const claudeBefore = read(claudePath);

      // A window from before most of these keys existed saves one setting.
      older.ws.send(JSON.stringify({ type: 'settings', settings: { fontFamily: 'Fira Code' } }));
      await until(() => settingsFrames(observer).length > seen + 1, 'the partial broadcast');

      const merged: JsonObject = { ...first, fontFamily: 'Fira Code' };
      // What every other window hears is the merged object, not the partial one.
      expect(settingsFrames(observer).at(-1)).toEqual(merged);
      expect(settingsFrames(full).at(-1)).toEqual(merged);
      // The export still follows the stored theme: it was not reset to the default.
      expect(read(themeSh)).toContain("export PALMUX_THEME='dracula'");
      expect(read(themeSh)).not.toContain("export PALMUX_THEME='catppuccin-mocha'");
      expect(read(claudePath)).toBe(claudeBefore);
      // And what is on disk, which a window opened later is handed at its handshake.
      expect(JSON.parse(read(join(configDir, 'settings.local.json')))).toEqual({
        themeId: 'dracula',
      });
      const late = await connect();
      try {
        await until(() => settingsFrames(late).length >= 1, 'the late handshake');
        expect(settingsFrames(late)[0]).toEqual(merged);
      } finally {
        late.ws.close();
      }
    } finally {
      for (const c of [full, observer, older]) c.ws.close();
    }
  });

  it('a save that carries a key, an empty list included, replaces it', async () => {
    const sender = await connect();
    const observer = await connect();
    try {
      await until(() => settingsFrames(observer).length >= 1, 'the observer handshake');
      const seen = settingsFrames(observer).length;
      sender.ws.send(
        JSON.stringify({ type: 'settings', settings: { scmRepos: [], themeId: 'gruvbox-dark' } }),
      );
      await until(() => settingsFrames(observer).length > seen, 'the broadcast');
      expect(settingsFrames(observer).at(-1)).toMatchObject({
        scmRepos: [],
        themeId: 'gruvbox-dark',
        fontFamily: 'Fira Code',
      });
      expect(read(join(configDir, 'theme.sh'))).toContain("export PALMUX_THEME='gruvbox-dark'");
    } finally {
      sender.ws.close();
      observer.ws.close();
    }
  });
});

const review = (url: string) => JSON.stringify({ type: 'createTab', kind: 'review', url });

describe('WS review tabs', () => {
  const reviewTabs = () => registry.tabs().filter((t) => t.kind === 'review');

  it('two windows creating one review at the same moment get one tab and the same id', async () => {
    const a = await connect();
    const b = await connect();
    try {
      a.ws.send(review('changes:/work/palmux'));
      b.ws.send(review('changes:/work//palmux/'));
      await until(
        () => tabCreatedIds(a).length === 1 && tabCreatedIds(b).length === 1,
        'both acks',
      );
      expect(tabCreatedIds(a)).toEqual(tabCreatedIds(b));
      expect(reviewTabs()).toEqual([
        { id: tabCreatedIds(a)[0], kind: 'review', url: 'changes:/work/palmux' },
      ]);
      // A later create answers the same tab, so the client can select it.
      a.ws.send(review('changes:/work/palmux'));
      await until(() => tabCreatedIds(a).length === 2, 'the repeat ack');
      expect(tabCreatedIds(a)[1]).toBe(tabCreatedIds(a)[0]);
      expect(reviewTabs()).toHaveLength(1);
    } finally {
      a.ws.close();
      b.ws.close();
    }
  });

  it('refuses a bad review url without an ack, and keeps a held url on updateTab', async () => {
    const client = await connect();
    try {
      const open = reviewTabs().length;
      client.ws.send(review('changes:relative'));
      client.ws.send(review('/work/palmux'));
      await settled(client);
      expect(tabCreatedIds(client)).toEqual([]);
      expect(reviewTabs()).toHaveLength(open);

      client.ws.send(review('staged:/work/second'));
      await until(() => tabCreatedIds(client).length === 1, 'the ack');
      const second = tabCreatedIds(client)[0]!;
      client.ws.send(
        JSON.stringify({ type: 'updateTab', id: second, url: 'changes:/work/palmux' }),
      );
      await settled(client);
      expect(registry.tabs().find((t) => t.id === second)).toMatchObject({
        url: 'staged:/work/second',
      });
    } finally {
      client.ws.close();
    }
  });
});
