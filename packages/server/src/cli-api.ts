// ── The `palmux` CLI's server surface ─────────────────────────────────────────
//
// One route, `POST /cli`, behind the same cookie gate as everything else — the
// CLI authenticates by reading the host's own secret, so no new trust model is
// introduced and no route is exempted. The body names the command; the reply is
// the command's own JSON, or a 400 carrying a message the CLI prints verbatim.
//
// Why HTTP at all, when the app already has a WebSocket. The tab registry is
// server-authoritative: `createTab` calls `listChanged`, which is wired to the
// broadcast, so EVERY browser learns about a tab this route creates with no
// socket involvement. The CLI never opens a WebSocket; it makes one request and
// exits, which is what makes it start fast enough to sit in a shell prompt.
//
// The one thing HTTP cannot do is MOVE a window, because which tab a window
// shows is browser-local state the server deliberately does not hold (see
// openspec/specs/browser-local-tab-selection). That is what `focusTab` is for,
// and it is why `SocketLayer` is threaded in here.

import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { isTabId } from '@palmux/shared';
import { loadSettings } from './config';
import { APP_VERSION } from './version';
import type { AppConfig } from './app-config';
import type { SessionRegistry } from './server';

export interface CliDeps {
  registry: SessionRegistry;
  cfg: AppConfig;
  /** Ask browser windows to show a tab (see SocketLayer). */
  focusTab: (id: string, from?: string) => void;
  /** Open browser windows, for `status`. */
  windowCount: () => number;
}

/** A reply the CLI prints as-is. `status` is the HTTP code; the CLI exits non-zero. */
function fail(status: number, error: string): { status: number; body: { error: string } } {
  return { status, body: { error } };
}

/**
 * `open` — show an absolute path as an `editor` tab.
 *
 * The existence check lives HERE and not in `registry.createTab` (which only
 * gates `isAbsolute`), because the command line is where typos happen and
 * `palmux ~/.tmux.con` silently minting a tab that can never load is worse than
 * an error message. That is a deliberate divergence from the WebSocket
 * `createTab` path, which the Explorer drives from paths it just listed.
 */
async function openFile(
  path: unknown,
  from: unknown,
  deps: CliDeps,
): Promise<{ status: number; body: unknown }> {
  if (typeof path !== 'string' || path === '') return fail(400, 'a path is required');
  // The CLI resolves a relative path against its own cwd before sending, so the
  // server never has to guess whose cwd was meant.
  if (!isAbsolute(path)) return fail(400, `not an absolute path: ${path}`);

  let info;
  try {
    info = await stat(path);
  } catch {
    return fail(400, `no such file: ${path}`);
  }
  if (info.isDirectory()) return fail(400, `is a directory: ${path}`);
  // Not a jail — the cookie is the boundary, exactly as for /download. This
  // stops a typo from opening a tab that renders a socket or /dev/null.
  if (!info.isFile()) return fail(400, `not a regular file: ${path}`);

  // Dedupe by url, matching `openFileTab` (App.tsx) exactly: two editor tabs on
  // one path would be two buffers, and whichever saved last would silently win.
  const existing = deps.registry.tabs().find((t) => t.kind === 'editor' && t.url === path);
  const id = existing?.id ?? deps.registry.createTab({ kind: 'editor', url: path });
  if (id === null) return fail(400, `could not open a tab for ${path}`);

  deps.focusTab(id, isTabId(from) ? from : undefined);
  return { status: 200, body: { id, created: existing === undefined } };
}

export function registerCliRoutes(app: FastifyInstance, deps: CliDeps): void {
  app.post('/cli', async (req, reply) => {
    // The CLI is a process, not a page: it sends no Origin, and a browser cannot
    // omit one on a cross-site POST. So requiring its ABSENCE costs the CLI
    // nothing and shuts the route to every other page on the machine — which
    // matters under `PALMUX_NO_AUTH=1`, where the cookie gate is off and a web
    // page could otherwise drive the registry from a script tag. With auth on
    // this is redundant with the cookie, and it is meant to be: it is the one
    // guard that does not depend on the cookie being configured.
    if (req.headers.origin !== undefined) {
      return reply.code(403).send({ error: 'this route is for the palmux CLI' });
    }
    const raw: unknown = req.body;
    if (typeof raw !== 'object' || raw === null) {
      return reply.code(400).send({ error: 'a JSON body is required' });
    }
    const body = raw as Record<string, unknown>;
    const cmd = body['cmd'];

    switch (cmd) {
      case 'open': {
        const { status, body: payload } = await openFile(body['path'], body['from'], deps);
        return reply.code(status).send(payload);
      }
      // `groups` and `tabs` answer with the SAME payload — one listing, two
      // renderings. `renderGroups` reads `{tabs, groups}` too (it needs the
      // members to name them), so sending anything smaller here would leave the
      // client unable to print a group's contents.
      case 'tabs':
      case 'groups':
        return reply.send({ tabs: deps.registry.tabs(), groups: deps.registry.groups() });
      case 'settings':
        return reply.send(loadSettings());
      case 'status':
        return reply.send({
          version: APP_VERSION,
          port: deps.cfg.port,
          tabs: deps.registry.tabs().length,
          windows: deps.windowCount(),
        });
      default:
        return reply.code(400).send({ error: `unknown command: ${String(cmd)}` });
    }
  });
}
