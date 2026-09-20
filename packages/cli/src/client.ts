// ── Talking to a running palmux ───────────────────────────────────────────────
//
// Node builtins only, and deliberately NOT the server package: the CLI has to
// start fast enough to sit in a shell prompt, and importing the server would drag
// in Fastify, node-pty and the whole registry to send one request and exit.
//
// The cost of that choice is that three facts are DUPLICATED here — the cookie
// name, the secret's filename, and the default port. Each names its source of
// truth in a comment; if they drift, the CLI fails with a clear 401 or a
// connection error rather than silently doing the wrong thing.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

/** Mirrors `SESSION_COOKIE` in server/src/auth.ts. */
const SESSION_COOKIE = 'palmux_session';
/** Mirrors the `port` default in server/src/app-config.ts. */
const DEFAULT_PORT = 44040;

/** Mirrors `configDir()` in server/src/config.ts. */
export function configDir(): string {
  return process.env['PALMUX_CONFIG_DIR'] || join(homedir(), '.config', 'palmux');
}

/**
 * The port to dial. `PALMUX_PORT` is the same env the SERVER reads, so a server
 * started with it is found without any further agreement between the two.
 */
export async function resolvePort(): Promise<number> {
  const fromEnv = process.env['PALMUX_PORT'];
  if (fromEnv !== undefined) {
    const n = Number.parseInt(fromEnv, 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  try {
    const raw = await readFile(join(configDir(), 'config.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const port = (parsed as Record<string, unknown>)['port'];
      if (typeof port === 'number' && Number.isInteger(port) && port > 0) return port;
    }
  } catch {
    // No config file, or unreadable: the default is the answer, not an error.
  }
  return DEFAULT_PORT;
}

/**
 * The host's own secret, read but NEVER created.
 *
 * `loadOrCreateSecret` would mint one on a machine that has none, and a CLI run
 * must not bring a second secret into being — the running server holds the old
 * one, and every browser is authenticated against it.
 */
async function readSecret(): Promise<string | null> {
  try {
    const raw = await readFile(join(configDir(), 'secret'), 'utf8');
    return raw.trim() || null;
  } catch {
    return null;
  }
}

export type CliResult =
  | { ok: true; body: unknown }
  | { ok: false; kind: 'unreachable'; port: number }
  | { ok: false; kind: 'http'; status: number; error: string };

/**
 * One `POST /cli`, then exit the process's interest in the connection.
 *
 * `node:http` rather than `fetch` on purpose: `fetch` keeps a keep-alive pool
 * alive, and a CLI that has finished its work but will not exit until the socket
 * times out is worse than one that is 20 lines longer.
 */
export async function postCli(payload: unknown, port: number): Promise<CliResult> {
  const secret = await readSecret();
  const body = Buffer.from(JSON.stringify(payload), 'utf8');

  return new Promise<CliResult>((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        // NOT the configured `host`: it is `0.0.0.0` by default, which is not a
        // destination, and the CLI runs on the same machine as the server.
        port,
        path: '/cli',
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': String(body.byteLength),
          // No Origin header is sent, and the route refuses any request that
          // carries one — a browser is not a palmux CLI.
          ...(secret ? { cookie: `${SESSION_COOKIE}=${secret}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status >= 400) {
            resolve({ ok: false, kind: 'http', status, error: errorFrom(text, status) });
            return;
          }
          try {
            resolve({ ok: true, body: JSON.parse(text) as unknown });
          } catch {
            // A 2xx that is not JSON means the route does not exist on that
            // server, so the SPA fallback answered with the app shell. Measured
            // against a deployed build: `200 text/html`, 2708 bytes. That is the
            // ORDINARY upgrade path — `yarn bundle` then a CLI newer than the
            // running service — so the message names it instead of reporting the
            // symptom, which reads as a palmux bug rather than a stale process.
            resolve({
              ok: false,
              kind: 'http',
              status,
              error: `the server on port ${port} has no CLI — it is running an older palmux; restart it`,
            });
          }
        });
      },
    );
    req.on('error', () => resolve({ ok: false, kind: 'unreachable', port }));
    req.end(body);
  });
}

/** The server sends `{error}` on every refusal; anything else is a proxy or a crash. */
function errorFrom(text: string, status: number): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) {
      const err = (parsed as Record<string, unknown>)['error'];
      if (typeof err === 'string') return err;
    }
  } catch {
    // Fall through to the status line.
  }
  return `HTTP ${status}`;
}
