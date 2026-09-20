// `postCli` against a real local server, because the branches worth pinning are
// all about what comes BACK: a refusal the server phrased, a 200 that is not
// JSON because the server is too old to have the route, and no server at all.

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postCli } from './client';

// Pointed at an empty dir so the CLI finds no secret and sends no cookie — the
// real path mints nothing, but this keeps the test off the developer's own
// config regardless.
process.env['PALMUX_CONFIG_DIR'] = mkdtempSync(join(tmpdir(), 'palmux-cli-client-'));

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

/** A server that answers every request the one way it is told to. */
async function serveWith(status: number, type: string, body: string): Promise<number> {
  server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  });
  const listening = server;
  // `listen`'s callback takes no arguments, so the resolver cannot be passed
  // straight through — a `(value) => void` is not assignable to `() => void`.
  await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', () => resolve()));
  const addr = listening.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return addr.port;
}

describe('postCli', () => {
  it('parses the JSON body of a successful reply', async () => {
    const port = await serveWith(200, 'application/json', '{"tabs":[],"groups":[]}');
    expect(await postCli({ cmd: 'tabs' }, port)).toEqual({
      ok: true,
      body: { tabs: [], groups: [] },
    });
  });

  it('surfaces the message the server wrote for a refusal', async () => {
    const port = await serveWith(400, 'application/json', '{"error":"no such file: /tmp/x"}');
    expect(await postCli({ cmd: 'open', path: '/tmp/x' }, port)).toEqual({
      ok: false,
      kind: 'http',
      status: 400,
      error: 'no such file: /tmp/x',
    });
  });

  it('falls back to the status when a refusal carries no message', async () => {
    const port = await serveWith(500, 'text/plain', 'boom');
    expect(await postCli({ cmd: 'status' }, port)).toMatchObject({ error: 'HTTP 500' });
  });

  // Measured against a deployed build: a server predating the `/cli` route
  // answers the SPA shell with `200 text/html`. That is the ordinary upgrade
  // path — a new CLI, a service still running the old bundle — so the message
  // has to name the stale process, not the parse failure.
  it('reads a non-JSON 200 as a server too old to have the route', async () => {
    const port = await serveWith(200, 'text/html', '<!doctype html><html></html>');
    const result = await postCli({ cmd: 'status' }, port);
    if (result.ok || result.kind !== 'http') throw new Error(`expected an http failure: ${result}`);
    expect(result.error).toContain('older palmux');
    expect(result.error).toContain(String(port));
  });

  it('reports a port nothing is listening on as unreachable', async () => {
    // Port 1 needs root to bind, so nothing will be there.
    expect(await postCli({ cmd: 'status' }, 1)).toEqual({
      ok: false,
      kind: 'unreachable',
      port: 1,
    });
  });
});
