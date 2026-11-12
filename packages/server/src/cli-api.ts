// `POST /cli`: the `palmux` command-line tool (`src/cli/`) talking to the server it runs
// under. Seven commands:
//   download  the window showing the caller's terminal downloads the named server paths
//             (fire and forget);
//   open      the same window opens the named files as editor tabs and answers what it did;
//   git       the same window opens Source Control on the caller's repository and answers;
//   comments  the review comments of the caller's repository as the agent document (no
//             terminal and no window needed);
//   web       the same window shows a url (or a port on this host) in a web tab and answers;
//   status    the server's version and the caller's terminal, for `palmux status`;
//   wait      held until no editor tab shows the given files, for `palmux open --wait`.
// Every reply carries `commands`, so a CLI can tell a server that predates a command.
//
// The terminal is found by its TTY, the join key the restore hints already use: the CLI
// reports its own tty, or under tmux the tty of the tmux client (`#{client_tty}`), which is
// the palmux shell's. An environment variable cannot do this inside tmux, whose server
// hands every pane the environment of whichever shell started it.
//
// `open` and `git` wait for the window's `cliResult` frame, at most CLI_ANSWER_MS. The
// answer counts only when it comes on the socket the request went out on.

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import type { WebSocket } from 'ws';
import {
  commentsMarkdown,
  encodeServerMessage,
  type CliGoto,
  type CliResultMessage,
  type ReadSnapshot,
  type ScmStatus,
  type ServerMessage,
} from '@palmux/shared';
import { expandHome, resolveDownload } from './download';
import { regularFile } from './file-rw';
import { listComments, latestRev } from './scm-comments';
import { resolveRepo } from './scm-git';
import { readSnapshot } from './scm-snapshot';
import { getStatus } from './scm-status';
import type { SessionRegistry } from './server';
import { APP_VERSION } from './version';

/** How long the server waits for a window to answer `open` or `git`. */
export const CLI_ANSWER_MS = 3000;

/** How long one `wait` request holds before it answers that the files are still open. */
export const CLI_WAIT_MS = 20_000;
/** How long a `wait` with `appear` gives a file's tab to be created before it counts as closed. */
export const CLI_APPEAR_MS = 5000;
/** How often a `wait` looks at the tab list. */
const WAIT_POLL_MS = 100;

/** The commands this server answers; every reply carries the list (D8). */
export const CLI_COMMANDS = [
  'download',
  'open',
  'git',
  'comments',
  'web',
  'status',
  'wait',
] as const;
export type CliCommand = (typeof CLI_COMMANDS)[number];

/** A path the server or the window refused, with the reason. */
export interface CliFailure {
  path: string;
  error: string;
}

/** `palmux open`: what the window opened and what was refused, both in argument order. */
export interface CliOpenResult {
  opened: string[];
  failed: CliFailure[];
}

/** `palmux git`: the work tree top the window now shows, and why it could not show the panel. */
export interface CliGitResult {
  repo: string;
  note?: string;
}

/** `palmux web`: the url the window now shows. */
export interface CliWebResult {
  url: string;
}

/** `palmux status`: the server's version and, when a tty was given, the terminal on it. */
export interface CliStatusResult {
  version: string;
  /** Null: no palmux terminal is on the tty. Absent: the request named no tty. */
  terminal?: { id: string; window: string | null; attached: boolean } | null;
}

/** `wait`: the files that still have an editor tab, in request order. */
export interface CliWaitResult {
  open: string[];
}

/** `palmux comments`: the agent document, `''` when there are no comments. */
export interface CliCommentsResult {
  markdown: string;
}

export interface CliDownloadResult {
  /** Paths sent to the browser, in the order given. */
  sent: string[];
  /** Paths `GET /download` would refuse, with its reason. */
  failed: CliFailure[];
}

/** What a request resolves to; the one exit point sends it and logs it. */
interface Outcome {
  status: number;
  body: Record<string, unknown>;
  /** The tail of the log line: counts or the refusal, never file or comment text. */
  log: string;
}

const refuse = (status: number, error: string): Outcome => ({
  status,
  body: { error },
  log: error,
});

type CliRequest =
  | { cmd: 'download' | 'open'; tty: string; paths: string[] }
  | { cmd: 'git'; tty: string; cwd: string }
  | { cmd: 'comments'; cwd: string }
  | { cmd: 'web'; tty: string; url: string }
  | { cmd: 'status'; tty?: string }
  | { cmd: 'wait'; paths: string[]; appear: boolean };

function parseRequest(body: Record<string, unknown>): CliRequest | string {
  const { cmd, tty, paths, cwd, url, appear } = body;
  const hasTty = typeof tty === 'string' && tty !== '';
  switch (cmd) {
    case 'download':
    case 'open':
      if (
        hasTty &&
        Array.isArray(paths) &&
        paths.length > 0 &&
        paths.every((p): p is string => typeof p === 'string')
      ) {
        return { cmd, tty, paths };
      }
      return `expected { cmd: "${cmd}", tty, paths: [...] }`;
    case 'git':
      return hasTty && typeof cwd === 'string'
        ? { cmd, tty, cwd }
        : 'expected { cmd: "git", tty, cwd }';
    case 'comments':
      return typeof cwd === 'string' ? { cmd, cwd } : 'expected { cmd: "comments", cwd }';
    case 'web':
      return hasTty && typeof url === 'string'
        ? { cmd, tty, url }
        : 'expected { cmd: "web", tty, url }';
    case 'status':
      return hasTty ? { cmd, tty } : { cmd };
    case 'wait':
      return Array.isArray(paths) &&
        paths.length > 0 &&
        paths.every((p): p is string => typeof p === 'string' && isAbsolute(p))
        ? { cmd, paths, appear: appear === true }
        : 'expected { cmd: "wait", paths: [absolute paths], appear? }';
    default:
      return `expected { cmd: ${CLI_COMMANDS.map((c) => `"${c}"`).join(' | ')}, ... }`;
  }
}

const noAnswer = (): Outcome => ({
  status: 504,
  body: { error: 'no palmux window answered within 3 s' },
  log: 'no answer',
});

const isCommand = (cmd: unknown): cmd is CliCommand => CLI_COMMANDS.some((known) => known === cmd);

/**
 * What `palmux web` was given, as the url a web tab stores: a port is that port on this host
 * (the window shows it through /webproxy), a host with no scheme is http. Null when the result
 * is not an http(s) url.
 */
export function webTarget(target: string): string | null {
  const port = /^\d+$/.test(target) ? Number(target) : null;
  if (port !== null) return port >= 1 && port <= 65535 ? `http://localhost:${port}/` : null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `http://${target}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** `/a/b.ts:12` or `/a/b.ts:12:5`: the path and the position, or null for no suffix. */
function splitGoto(path: string): { path: string; line: number; column?: number } | null {
  const m = /^(.+?):(\d+)(?::(\d+))?$/.exec(path);
  if (!m) return null;
  const line = Number(m[2]);
  const column = m[3] === undefined ? undefined : Number(m[3]);
  if (line < 1 || (column !== undefined && column < 1)) return null;
  return column === undefined ? { path: m[1]!, line } : { path: m[1]!, line, column };
}

// A tty comes from the request: keep control characters out of the log line.
const logText = (text: string): string => text.replace(/[\u0000-\u001f\u007f]/g, '?');

export function registerCliRoutes(
  app: FastifyInstance,
  deps: {
    registry: SessionRegistry;
    maxDownloadBytes: number;
    /** The editor's size cap, the one `GET /file` applies. */
    maxEditBytes: number;
    /** How long `open` and `git` wait for the window; tests shorten it. */
    answerMs?: number | undefined;
    /** How long one `wait` request holds; tests shorten it. */
    waitMs?: number | undefined;
  },
): void {
  const answerMs = deps.answerMs ?? CLI_ANSWER_MS;
  const waitMs = deps.waitMs ?? CLI_WAIT_MS;
  const pending = new Map<
    string,
    { ws: WebSocket; resolve: (answer: CliResultMessage | null) => void }
  >();

  app.decorate('cliAnswered', (ws: WebSocket, msg: CliResultMessage) => {
    const entry = pending.get(msg.requestId);
    // An unknown id, or an answer on another socket, is not for this request.
    if (entry && entry.ws === ws) entry.resolve(msg);
  });

  /** Send a frame to `ws` and wait for its answer; null when none came in time. */
  const ask = (
    ws: WebSocket,
    frame: (requestId: string) => ServerMessage,
  ): Promise<CliResultMessage | null> => {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const settle = (answer: CliResultMessage | null): void => {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve(answer);
      };
      const timer = setTimeout(() => settle(null), answerMs);
      pending.set(requestId, { ws, resolve: settle });
      try {
        ws.send(encodeServerMessage(frame(requestId)));
      } catch {
        settle(null);
      }
    });
  };

  const notHere = (tty: string): Outcome =>
    refuse(409, `no open palmux terminal is on ${tty}: run this inside a palmux terminal`);

  async function download(tty: string, paths: string[]): Promise<Outcome> {
    const id = deps.registry.terminalOnTty(tty);
    if (id === undefined) return notHere(tty);
    const result: CliDownloadResult = { sent: [], failed: [] };
    for (const path of paths) {
      const res = await resolveDownload(path, deps.maxDownloadBytes);
      if (res.kind === 'error') result.failed.push({ path, error: res.message });
      else result.sent.push(path);
    }
    if (result.sent.length > 0) {
      const ws = app.terminalSocket(id);
      if (!ws) return notHere(tty);
      ws.send(encodeServerMessage({ type: 'download', paths: result.sent }));
    }
    return {
      status: 200,
      body: { ...result },
      log: `sent=${result.sent.length} failed=${result.failed.length}`,
    };
  }

  /** The reason a file cannot be opened in the editor, or null. */
  async function openRefusal(path: string): Promise<string | null> {
    const gate = await regularFile(path);
    if (!gate.ok) return gate.message;
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return 'not found';
    }
    return size > deps.maxEditBytes
      ? `file is ${size} bytes; the editor limit is ${deps.maxEditBytes}`
      : null;
  }

  async function open(tty: string, given: string[]): Promise<Outcome> {
    const id = deps.registry.terminalOnTty(tty);
    if (id === undefined) return notHere(tty);
    const checked: { given: string; path: string; error: string | null }[] = [];
    const goto: CliGoto[] = [];
    for (const arg of given) {
      // A tab is matched by its url, so `/a/./b.ts` would open a second editor beside the `/a/b.ts`
      // one. `resolve` is the server's file identity (the Explorer names paths the same way); a
      // relative path is kept as typed for its refusal.
      const canonical = (p: string): string => {
        const expanded = expandHome(p);
        return isAbsolute(expanded) ? resolve(expanded) : expanded;
      };
      const path = canonical(arg);
      const error = await openRefusal(path);
      // `file:line[:col]`, the form compilers and agents print, only when the name as typed is not
      // a file: a file really named `notes:12` opens as itself.
      const at = error === null ? null : splitGoto(arg);
      if (at !== null) {
        const file = canonical(at.path);
        if ((await openRefusal(file)) === null) {
          checked.push({ given: arg, path: file, error: null });
          goto.push({ ...at, path: file });
          continue;
        }
      }
      checked.push({ given: arg, path, error });
    }
    const survivors = checked.filter((c) => c.error === null).map((c) => c.path);
    const result: CliOpenResult = { opened: [], failed: [] };
    const report = (): Outcome => ({
      status: 200,
      body: { ...result },
      log: `opened=${result.opened.length} failed=${result.failed.length}`,
    });
    if (survivors.length === 0) {
      for (const c of checked) result.failed.push({ path: c.given, error: c.error ?? '' });
      return report();
    }
    const ws = app.terminalSocket(id);
    if (!ws) return notHere(tty);
    const answer = await ask(ws, (requestId) => ({
      type: 'cliOpen',
      requestId,
      paths: survivors,
      ...(goto.length > 0 ? { goto } : {}),
    }));
    if (answer === null) return noAnswer();
    const reported = new Map<string, { ok: boolean; error?: string }>();
    for (const r of answer.results) if (!reported.has(r.path)) reported.set(r.path, r);
    for (const c of checked) {
      if (c.error !== null) {
        result.failed.push({ path: c.given, error: c.error });
        continue;
      }
      const r = reported.get(c.path);
      if (r === undefined) {
        result.failed.push({ path: c.given, error: 'the window did not report this path' });
      } else if (r.ok) {
        result.opened.push(c.path);
      } else {
        result.failed.push({
          path: c.given,
          error: r.error ?? 'the window could not open this file',
        });
      }
    }
    return report();
  }

  async function git(tty: string, cwd: string): Promise<Outcome> {
    const repo = await resolveRepo(cwd);
    if (!repo.ok) return refuse(400, repo.error);
    const id = deps.registry.terminalOnTty(tty);
    if (id === undefined) return notHere(tty);
    const ws = app.terminalSocket(id);
    if (!ws) return notHere(tty);
    const answer = await ask(ws, (requestId) => ({ type: 'cliGit', requestId, repo: repo.top }));
    if (answer === null) return noAnswer();
    const entry = answer.results[0];
    if (entry === undefined || !entry.ok) {
      return refuse(400, entry?.error ?? 'the window did not open Source Control');
    }
    const result: CliGitResult = {
      repo: repo.top,
      ...(answer.note !== undefined ? { note: answer.note } : {}),
    };
    return { status: 200, body: { ...result }, log: `repo=${repo.top}` };
  }

  async function web(tty: string, target: string): Promise<Outcome> {
    const url = webTarget(target);
    if (url === null) return refuse(400, `not a port or an http(s) url: ${target}`);
    const id = deps.registry.terminalOnTty(tty);
    if (id === undefined) return notHere(tty);
    const ws = app.terminalSocket(id);
    if (!ws) return notHere(tty);
    const answer = await ask(ws, (requestId) => ({ type: 'cliWeb', requestId, url }));
    if (answer === null) return noAnswer();
    const entry = answer.results[0];
    if (entry === undefined || !entry.ok) {
      return refuse(400, entry?.error ?? 'the window did not open the page');
    }
    const result: CliWebResult = { url };
    return { status: 200, body: { ...result }, log: `url=${url}` };
  }

  function status(tty: string | undefined): Outcome {
    const result: CliStatusResult = { version: APP_VERSION };
    if (tty !== undefined) {
      const id = deps.registry.terminalOnTty(tty);
      result.terminal =
        id === undefined
          ? null
          : {
              id,
              window: deps.registry.windowOf(id) ?? null,
              attached: app.terminalSocket(id) !== undefined,
            };
    }
    return { status: 200, body: { ...result }, log: `version=${APP_VERSION}` };
  }

  /**
   * Held until no editor tab, in any window, shows any of `paths`, or for `waitMs`. With
   * `appear`, a file with no tab yet is given CLI_APPEAR_MS for its tab to be created first: the
   * window answered `open` on its data socket, and its `createTab` travels on its control socket,
   * so the tab can still be on its way.
   */
  async function wait(paths: string[], appear: boolean): Promise<Outcome> {
    const started = Date.now();
    const appearUntil = appear ? started + Math.min(CLI_APPEAR_MS, waitMs) : started;
    const seen = new Set<string>();
    const stillOpen = (): string[] => {
      const shown = new Set(
        deps.registry
          .tabs()
          .filter((t) => t.kind === 'editor' && t.url !== undefined)
          .map((t) => t.url),
      );
      for (const p of paths) if (shown.has(p)) seen.add(p);
      const waiting = Date.now() < appearUntil;
      return paths.filter((p) => shown.has(p) || (waiting && !seen.has(p)));
    };
    let open = stillOpen();
    while (open.length > 0 && Date.now() - started < waitMs) {
      await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
      open = stillOpen();
    }
    // A path still waiting to appear when the window ends is reported only if it did appear.
    open = open.filter((p) => seen.has(p) || Date.now() < appearUntil);
    const result: CliWaitResult = { open };
    return { status: 200, body: { ...result }, log: `open=${open.length}` };
  }

  async function comments(cwd: string): Promise<Outcome> {
    const repo = await resolveRepo(cwd);
    if (!repo.ok) return refuse(400, repo.error);
    const top = repo.top;
    const list = await listComments(top);
    // A status failure is not fatal: the document is produced unmarked.
    const res = await getStatus(top);
    const status: ScmStatus | null = res.ok ? { ...res.status, commentsRev: latestRev(top) } : null;
    const read: ReadSnapshot = async (repoTop, group, req) => {
      const snap = await readSnapshot({
        top: repoTop,
        group,
        path: req.path,
        ...(req.oldPath !== undefined ? { oldPath: req.oldPath } : {}),
        algorithm: req.algorithm,
        keepToken: false,
      });
      // A rejection is how the shared code learns a read failed.
      if (!snap.ok) throw new Error(snap.error);
      return snap.snapshot;
    };
    const markdown = await commentsMarkdown(top, status, list.comments, read);
    const result: CliCommentsResult = { markdown };
    return { status: 200, body: { ...result }, log: `comments=${list.comments.length}` };
  }

  async function handle(req: CliRequest): Promise<Outcome> {
    switch (req.cmd) {
      case 'download':
        return download(req.tty, req.paths);
      case 'open':
        return open(req.tty, req.paths);
      case 'git':
        return git(req.tty, req.cwd);
      case 'comments':
        return comments(req.cwd);
      case 'web':
        return web(req.tty, req.url);
      case 'status':
        return status(req.tty);
      case 'wait':
        return wait(req.paths, req.appear);
    }
  }

  /** The one exit point: every reply carries `commands`, and every request logs one line. */
  const finish = (reply: FastifyReply, cmd: string, tty: string, out: Outcome) => {
    console.info(`palmux: cli ${cmd} tty=${tty} -> ${out.status} ${logText(out.log)}`);
    return reply.code(out.status).send({ ...out.body, commands: CLI_COMMANDS });
  };

  // Only the CLI posts here. A browser always sends an Origin on a cross-site POST, and
  // the session cookie would ride along with it, so refuse any request that has one.
  const fromBrowser = (origin: string | undefined): Outcome | null =>
    origin === undefined ? null : refuse(403, 'the CLI endpoint does not take browser requests');

  app.post(
    '/cli',
    {
      // Fastify parses the body before the handler runs, so a body it cannot read (bad or empty
      // JSON, another content type, over the size limit) would otherwise get Fastify's own reply:
      // no `commands`, no log line, and a 400 even for a browser. Its text is never echoed, since
      // the parser's message can quote the body.
      errorHandler: (error: FastifyError, req, reply) => {
        const status = error.statusCode ?? 500;
        const out =
          fromBrowser(req.headers.origin) ??
          (status === 413
            ? refuse(413, 'the request body is too large')
            : status >= 400 && status < 500
              ? refuse(status, 'the request body is not JSON')
              : refuse(500, 'the server could not complete the command'));
        return finish(reply, '-', '-', out);
      },
    },
    async (req, reply) => {
      const body =
        typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      const cmd = isCommand(body['cmd']) ? body['cmd'] : '-';
      const tty =
        typeof body['tty'] === 'string' && body['tty'] !== '' ? logText(body['tty']) : '-';

      let out = fromBrowser(req.headers.origin);
      if (out === null) {
        const parsed = parseRequest(body);
        if (typeof parsed === 'string') {
          out = refuse(400, parsed);
        } else {
          try {
            out = await handle(parsed);
          } catch (error) {
            // The comment store or git failed in a way the user cannot act on: say so briefly.
            out = refuse(500, 'the server could not complete the command');
            console.warn(`palmux: cli ${cmd} failed: ${logText(String(error))}`);
          }
        }
      }
      return finish(reply, cmd, tty, out);
    },
  );
}
