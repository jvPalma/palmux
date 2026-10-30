// The `palmux` command-line tool, run from a shell inside a palmux terminal (see
// `scripts/palmux`). It talks to the palmux server on this machine over `POST /cli`
// (`cli-api.ts`), which finds the terminal by its tty and reaches the browser window
// showing it.
//
//   palmux download <path>...   the browser window you typed this in downloads each path

import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveAppConfig } from './app-config';
import { SESSION_COOKIE } from './auth';
import type { CliDownloadResult } from './cli-api';
import { configDir } from './config';

export const USAGE = `usage: palmux download <path>...

Downloads files or folders from this machine in the palmux window you run it in.
Run it inside a palmux terminal (tmux in one is fine).

  <path>   a file, a folder (sent as a .zip) or a quoted glob such as '*.mp4'
           (one .zip). Relative paths are read from the current directory, and
           ~/ is your home.

Paths that cannot be downloaded are listed and the others still go. The exit
status is 1 when any path failed.`;

/** `/dev/pts/16` → `pts/16`, the form the server names a terminal's tty by; null for anything else. */
export function ttyName(device: string): string | null {
  const m = /^\/dev\/(pts\/\d+|tty[A-Za-z0-9]+)$/.exec(device.trim());
  return m ? m[1]! : null;
}

/**
 * The tty of the palmux terminal this command runs in. Under tmux the process is on a tmux
 * pane's tty, so it asks tmux which client is looking at this session: that client is the
 * one running in the palmux terminal.
 */
export function callerTty(
  env: NodeJS.ProcessEnv,
  run: (cmd: string, args: string[]) => string = (cmd, args) =>
    execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
  readFd: (fd: number) => string = (fd) => readlinkSync(`/proc/self/fd/${fd}`),
): string | null {
  if (env['TMUX']) {
    try {
      return ttyName(run('tmux', ['display-message', '-p', '#{client_tty}']));
    } catch {
      return null;
    }
  }
  for (const fd of [0, 1, 2]) {
    try {
      const name = ttyName(readFd(fd));
      if (name) return name;
    } catch {
      /* not open */
    }
  }
  return null;
}

/** A path as the server reads it: absolute, or `~`/`~/…` (its home); anything else is under `cwd`. */
export function serverPath(cwd: string, arg: string): string {
  if (arg.startsWith('/') || arg === '~' || arg.startsWith('~/')) return arg;
  return resolve(cwd, arg);
}

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  tty: () => string | null;
  /** POST the body to the local server's `/cli`; resolves to the status and the raw body. */
  post: (body: object) => Promise<{ status: number; text: string }>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Run one invocation; resolves to the exit status. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    deps.out(USAGE);
    return 0;
  }
  if (cmd !== 'download' || rest.length === 0) {
    deps.err(USAGE);
    return 2;
  }
  const tty = deps.tty();
  if (!tty) {
    deps.err('palmux: this shell has no terminal; run palmux download inside a palmux terminal');
    return 1;
  }
  const paths = rest.map((arg) => serverPath(deps.cwd, arg));
  let res: { status: number; text: string };
  try {
    res = await deps.post({ cmd: 'download', tty, paths });
  } catch (e) {
    deps.err(`palmux: cannot reach the palmux server (${(e as Error).message})`);
    return 1;
  }
  let body: unknown;
  try {
    body = JSON.parse(res.text);
  } catch {
    // The SPA shell or a 404 page: a server started before `/cli` existed.
    deps.err('palmux: this palmux server does not know `palmux download` yet; restart it');
    return 1;
  }
  if (res.status !== 200) {
    const error = (body as { error?: unknown }).error;
    deps.err(`palmux: ${typeof error === 'string' ? error : `server answered ${res.status}`}`);
    return 1;
  }
  const { sent, failed } = body as CliDownloadResult;
  for (const path of sent) deps.out(`downloading ${path}`);
  for (const { path, error } of failed) deps.err(`palmux: ${path}: ${error}`);
  return failed.length > 0 ? 1 : 0;
}

/** POST to the palmux server this machine's config names, with its session cookie. */
export function localPost(): CliDeps['post'] {
  const cfg = resolveAppConfig();
  const wildcard = cfg.host === '' || cfg.host === '0.0.0.0' || cfg.host === '::';
  const host = wildcard ? '127.0.0.1' : cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host;
  return async (body) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.auth) {
      const secret = readFileSync(join(configDir(), 'secret'), 'utf8').trim();
      headers['cookie'] = `${SESSION_COOKIE}=${secret}`;
    }
    const res = await fetch(`http://${host}:${cfg.port}/cli`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  };
}
