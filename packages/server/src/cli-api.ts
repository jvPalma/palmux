// `POST /cli`: the `palmux` command-line tool (`src/cli/`) talking to the server it runs
// under. Today one command, `download`: the browser window showing the terminal the
// command ran in downloads the named server paths.
//
// The terminal is found by its TTY, the join key the restore hints already use: the CLI
// reports its own tty, or under tmux the tty of the tmux client (`#{client_tty}`), which is
// the palmux shell's. An environment variable cannot do this inside tmux, whose server
// hands every pane the environment of whichever shell started it.

import type { FastifyInstance } from 'fastify';
import { encodeServerMessage } from '@palmux/shared';
import { resolveDownload } from './download';
import type { SessionRegistry } from './server';

export interface CliDownloadResult {
  /** Paths sent to the browser, in the order given. */
  sent: string[];
  /** Paths `GET /download` would refuse, with its reason. */
  failed: { path: string; error: string }[];
}

export function registerCliRoutes(
  app: FastifyInstance,
  deps: { registry: SessionRegistry; maxDownloadBytes: number },
): void {
  app.post('/cli', async (req, reply) => {
    // Only the CLI posts here. A browser always sends an Origin on a cross-site POST, and
    // the session cookie would ride along with it, so refuse any request that has one.
    if (req.headers.origin !== undefined) {
      return reply.code(403).send({ error: 'the CLI endpoint does not take browser requests' });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const tty = body['tty'];
    const paths = body['paths'];
    if (
      body['cmd'] !== 'download' ||
      typeof tty !== 'string' ||
      tty === '' ||
      !Array.isArray(paths) ||
      paths.length === 0 ||
      !paths.every((p): p is string => typeof p === 'string')
    ) {
      return reply.code(400).send({ error: 'expected { cmd: "download", tty, paths: [...] }' });
    }
    const id = deps.registry.terminalOnTty(tty);
    const notHere = () =>
      reply.code(409).send({
        error: `no open palmux terminal is on ${tty}: run this inside a palmux terminal`,
      });
    if (id === undefined) return notHere();

    const result: CliDownloadResult = { sent: [], failed: [] };
    for (const path of paths) {
      const res = await resolveDownload(path, deps.maxDownloadBytes);
      if (res.kind === 'error') result.failed.push({ path, error: res.message });
      else result.sent.push(path);
    }
    if (
      result.sent.length > 0 &&
      !app.sendToTerminal(id, encodeServerMessage({ type: 'download', paths: result.sent }))
    ) {
      return notHere();
    }
    return result;
  });
}
