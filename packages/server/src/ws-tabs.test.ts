import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { ServerMessage } from '@palmux/shared';
import { DEFAULT_APP_CONFIG, type AppConfig } from './app-config';
import { createServer, createSessionRegistry, type SessionRegistry } from './server';
import { memoryTabsStore } from './tabs-store';

let app: FastifyInstance;
let registry: SessionRegistry;
let port: number;
let prevConfigDir: string | undefined;

beforeAll(async () => {
  prevConfigDir = process.env['PALMUX_CONFIG_DIR'];
  process.env['PALMUX_CONFIG_DIR'] = mkdtempSync(join(tmpdir(), 'palmux-wstabs-'));
  const cfg: AppConfig = { ...DEFAULT_APP_CONFIG, fontDirs: [], auth: false };
  registry = createSessionRegistry(cfg, memoryTabsStore());
  app = await createServer(cfg, 'a'.repeat(64), registry);
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as { port: number }).port;
});

afterAll(async () => {
  for (const id of registry.ids()) registry.kill(id);
  await app.close();
  if (prevConfigDir === undefined) delete process.env['PALMUX_CONFIG_DIR'];
  else process.env['PALMUX_CONFIG_DIR'] = prevConfigDir;
});

/** Collect frames from a socket for `ms`, then close it. */
interface Collected {
  messages: ServerMessage[];
  binaryCount: number;
}

/**
 * Attach, gather for `ms`, close.
 *
 * `until` turns the window into a DEADLINE rather than a duration: the promise
 * resolves the moment the predicate holds. A test that waits for a freshly
 * spawned shell to print its prompt is waiting on zsh, not on palmux, and a
 * fixed budget makes it a coin toss on a loaded machine — this one failed two
 * runs in three with a browser and two dev servers alongside it. Tests that
 * assert something did NOT happen still pass no predicate and wait the full
 * window, because absence cannot be observed early.
 */
function collect(
  query: string,
  ms: number,
  onOpen?: (ws: WebSocket) => void,
  until?: (state: Collected) => boolean,
): Promise<Collected> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${query}`);
    const state: Collected = { messages: [], binaryCount: 0 };
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      ws.close();
      resolve(state);
    };
    ws.on('message', (data, isBinary) => {
      if (isBinary) state.binaryCount++;
      else state.messages.push(JSON.parse(data.toString()) as ServerMessage);
      if (until?.(state)) finish();
    });
    // The window starts at OPEN, not at construction, so connection time is not
    // charged against it — the absence assertions depend on the full duration.
    ws.on('open', () => {
      onOpen?.(ws);
      timer = setTimeout(finish, ms);
    });
  });
}

describe('WS tab bridge', () => {
  it('acks createTab with the assigned id (tabCreated)', async () => {
    const { messages } = await collect('session=0', 400, (ws) => {
      ws.send(JSON.stringify({ type: 'createTab', kind: 'web', url: 'https://sb.local' }));
    });
    const ack = messages.find((m) => m.type === 'tabCreated');
    expect(ack).toEqual({ type: 'tabCreated', id: '1' }); // 0 is this terminal
    expect(registry.kindOf('1')).toBe('web');
  });

  it('does NOT ack a rejected createTab (web without a valid url)', async () => {
    const { messages } = await collect('session=0', 300, (ws) => {
      ws.send(JSON.stringify({ type: 'createTab', kind: 'web', url: 'javascript:1' }));
    });
    expect(messages.some((m) => m.type === 'tabCreated')).toBe(false);
  });

  it('attaching with kind=web to an UNKNOWN id spawns no terminal (metadata-only)', async () => {
    const before = registry.ids();
    const { messages, binaryCount } = await collect('session=77&kind=web', 300);
    // No PTY spawned → no snapshot, no binary, and id 77 never becomes a tab.
    expect(binaryCount).toBe(0);
    expect(messages.some((m) => m.type === 'snapshot')).toBe(false);
    expect(registry.has('77')).toBe(false);
    expect(registry.ids()).toEqual(before);
  });

  it('attaching with no kind to an unknown id spawns a terminal (URL model preserved)', async () => {
    const { binaryCount, messages } = await collect(
      'session=88',
      4000,
      undefined,
      // Wait for the shell to actually say something rather than for a fixed
      // 400ms — that budget is zsh's startup time, not ours.
      (s) => s.binaryCount > 0 && s.messages.some((m) => m.type === 'ready'),
    );
    // Fresh shell: ready + a snapshot/replay of its initial output.
    expect(messages.some((m) => m.type === 'ready')).toBe(true);
    expect(registry.kindOf('88')).toBe('terminal');
    expect(binaryCount).toBeGreaterThan(0);
    registry.kill('88');
  });

  it('a control socket gets the handshake + broadcasts but no PTY', async () => {
    const before = registry.ids();
    const { messages, binaryCount } = await collect('control=1', 400, (ws) => {
      // Control sends still work (createTab), proving the app channel is live.
      setTimeout(() => ws.send(JSON.stringify({ type: 'createTab', kind: 'dashboard' })), 80);
    });
    expect(messages.some((m) => m.type === 'ready')).toBe(true);
    expect(messages.some((m) => m.type === 'sessions')).toBe(true);
    expect(messages.some((m) => m.type === 'settings')).toBe(true);
    // No tab bound → no PTY, no snapshot, no binary.
    expect(binaryCount).toBe(0);
    expect(messages.some((m) => m.type === 'snapshot')).toBe(false);
    // The control createTab landed and was acked.
    expect(messages.some((m) => m.type === 'tabCreated')).toBe(true);
    // The `control=1` connection itself never became a tab id.
    expect(
      registry.ids().filter((id) => !before.includes(id) && registry.kindOf(id) === 'dashboard'),
    ).toHaveLength(1);
  });
});

describe('WS reorderTabs', () => {
  it('a reorderTabs frame changes the next sessions broadcast order', async () => {
    registry.createTab({ kind: 'editor' });
    registry.createTab({ kind: 'editor' });
    registry.createTab({ kind: 'editor' });
    const before = registry.ids();
    const want = [...before].reverse();
    const { messages } = await collect('control=1', 400, (ws) => {
      ws.send(JSON.stringify({ type: 'reorderTabs', ids: want }));
    });
    const sessions = messages.filter((m) => m.type === 'sessions');
    const last = sessions[sessions.length - 1];
    expect(last && last.type === 'sessions' ? last.tabs.map((t) => t.id) : []).toEqual(want);
    expect(registry.ids()).toEqual(want);
  });
});

describe('WS group ops', () => {
  it('groupCreate + a join reflect in the next sessions broadcast', async () => {
    // Leftover-safe: derive the 3 fresh ids we just created (the shared registry
    // persists tabs across tests in this file).
    const before = new Set(registry.ids());
    registry.createTab({ kind: 'editor' });
    registry.createTab({ kind: 'editor' });
    registry.createTab({ kind: 'editor' });
    const [a, mid, c] = registry.ids().filter((id) => !before.has(id));
    const { messages } = await collect('control=1', 500, (ws) => {
      ws.send(JSON.stringify({ type: 'groupCreate', ids: [a!, c!], name: 'g', color: 'blue' }));
    });
    const last = messages.filter((m) => m.type === 'sessions').at(-1);
    if (!last || last.type !== 'sessions') throw new Error('no sessions broadcast');
    // Our group exists (color blue) and holds exactly a + c.
    const gid = last.tabs.find((t) => t.id === a)!.groupId;
    expect(gid).toBeTruthy();
    expect(last.groups.find((g) => g.id === gid)).toMatchObject({ color: 'blue', name: 'g' });
    const members = last.tabs.filter((t) => t.groupId === gid).map((t) => t.id);
    expect(members).toEqual([a, c]);
    // Contiguous: a and c are adjacent, mid is not between them.
    const order = last.tabs.map((t) => t.id);
    expect(order.indexOf(c!)).toBe(order.indexOf(a!) + 1);
    expect(order.indexOf(mid!)).not.toBe(order.indexOf(a!) + 1);
  });
});

describe('self-update client notice', () => {
  it('broadcasts an `updating` frame to connected clients', async () => {
    const { messages } = await collect('control=1', 400, () => {
      // The self-update runner calls exactly this from index.ts's `notify`.
      setTimeout(() => app.broadcastUpdating('staging', '9.9.0'), 50);
    });
    const updating = messages.find((m) => m.type === 'updating');
    expect(updating).toEqual({ type: 'updating', stage: 'staging', version: '9.9.0' });
  });

  it('omits `version` when it is unknown rather than sending undefined', async () => {
    const { messages } = await collect('control=1', 400, () => {
      setTimeout(() => app.broadcastUpdating('failed'), 50);
    });
    const updating = messages.find((m) => m.type === 'updating');
    expect(updating).toEqual({ type: 'updating', stage: 'failed' });
  });
});
