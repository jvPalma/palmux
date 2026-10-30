import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { ServerMessage } from '@palmux/shared';
import { DEFAULT_APP_CONFIG, type AppConfig } from './app-config';
import { createServer, createSessionRegistry, type SessionRegistry } from './server';
import { ttyOf } from './session-restore';
import { memoryTabsStore } from './tabs-store';

let app: FastifyInstance;
let registry: SessionRegistry;
let port: number;
let prevConfigDir: string | undefined;
let files: string;
// Read once, as the shell starts: zsh's startup points fd 0 at a pipe for a while, so a later
// `ttyOf` can read null. The registry keeps the tty it captured at spawn for the same reason.
let shellTty: string | null = null;

beforeAll(async () => {
  prevConfigDir = process.env['PALMUX_CONFIG_DIR'];
  process.env['PALMUX_CONFIG_DIR'] = mkdtempSync(join(tmpdir(), 'palmux-cli-'));
  files = mkdtempSync(join(tmpdir(), 'palmux-cli-files-'));
  writeFileSync(join(files, 'a.mp4'), 'a');
  writeFileSync(join(files, 'b.mp4'), 'b');
  const cfg: AppConfig = { ...DEFAULT_APP_CONFIG, fontDirs: [], auth: false };
  // In-memory stores: the defaults point at the real config dir and sweep its tty hints.
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

/** Attach a data socket to terminal `id`, collecting its text frames, once `ready` arrives. */
function attach(id: string): Promise<{ ws: WebSocket; messages: ServerMessage[] }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?session=${id}`);
    const messages: ServerMessage[] = [];
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString()) as ServerMessage;
      messages.push(msg);
      if (msg.type === 'ready') resolve({ ws, messages });
    });
  });
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/cli', payload: body as object, headers });

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
};

describe('POST /cli download', () => {
  it('sends the paths that resolve to the socket attached to the caller tty, and lists the rest', async () => {
    const { ws, messages } = await attach('0');
    shellTty = ttyOf(registry.get('0').pid);
    const tty = shellTty;
    expect(tty).toMatch(/^pts\//);
    const missing = join(files, 'nope.mp4');
    const res = await post({
      cmd: 'download',
      tty,
      paths: [join(files, 'a.mp4'), missing, join(files, '*.mp4')],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sent: [join(files, 'a.mp4'), join(files, '*.mp4')],
      failed: [{ path: missing, error: 'not found' }],
    });
    await until(() => messages.some((m) => m.type === 'download'));
    expect(messages.find((m) => m.type === 'download')).toEqual({
      type: 'download',
      paths: [join(files, 'a.mp4'), join(files, '*.mp4')],
    });
    ws.close();
  });

  it('sends nothing when no path resolves', async () => {
    const { ws, messages } = await attach('0');
    const tty = shellTty;
    const res = await post({ cmd: 'download', tty, paths: ['relative.mp4'] });
    expect(res.statusCode).toBe(200);
    expect(res.json().sent).toEqual([]);
    await new Promise((r) => setTimeout(r, 100));
    expect(messages.some((m) => m.type === 'download')).toBe(false);
    ws.close();
  });

  it('answers 409 for a tty no attached palmux terminal is on', async () => {
    const res = await post({ cmd: 'download', tty: 'pts/99999', paths: [join(files, 'a.mp4')] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/palmux terminal/);
  });

  it('answers 409 once the terminal has no socket attached', async () => {
    const { ws } = await attach('0');
    const tty = shellTty;
    ws.close();
    await until(() => ws.readyState === ws.CLOSED);
    await new Promise((r) => setTimeout(r, 50));
    const res = await post({ cmd: 'download', tty, paths: [join(files, 'a.mp4')] });
    expect(res.statusCode).toBe(409);
  });

  it('refuses a request that carries an Origin (a browser page, not the CLI)', async () => {
    const res = await post(
      { cmd: 'download', tty: 'pts/1', paths: ['/x'] },
      { origin: 'https://evil.example' },
    );
    expect(res.statusCode).toBe(403);
  });

  it('answers 400 for a malformed body', async () => {
    expect((await post({ cmd: 'download', paths: ['/x'] })).statusCode).toBe(400);
    expect((await post({ cmd: 'download', tty: 'pts/1', paths: [] })).statusCode).toBe(400);
    expect((await post({ cmd: 'nope', tty: 'pts/1', paths: ['/x'] })).statusCode).toBe(400);
  });
});
