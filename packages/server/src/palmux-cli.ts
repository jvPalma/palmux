// The `palmux` command-line tool, run from a shell inside a palmux terminal (see
// `scripts/palmux`). It talks to the palmux server on this machine over `POST /cli`
// (`cli-api.ts`), which finds the terminal by its tty and reaches the browser window
// showing it.
//
//   palmux download <path>...   the browser window you typed this in downloads each path
//   palmux open <file>...       that window opens each file in its editor
//   palmux git                  that window shows Source Control for the current directory
//   palmux comments             prints the repository's review comments (no terminal needed)

import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveAppConfig } from './app-config';
import { SESSION_COOKIE } from './auth';
import type {
  CliCommand,
  CliCommentsResult,
  CliDownloadResult,
  CliGitResult,
  CliOpenResult,
  CliStatusResult,
  CliWaitResult,
  CliWebResult,
} from './cli-api';
import { configDir } from './config';

export const USAGE = `usage: palmux download <path>...
       palmux open [-w | --wait] <file>[:line[:col]]...
       palmux web <port | url>
       palmux git
       palmux comments
       palmux status
       palmux -v | --version
       palmux [<command>] -h | --help

  download  the palmux window you run this in downloads each path. A folder or
            a quoted glob such as '*.mp4' arrives as one .zip (or as the file,
            when it holds just one).
  open      opens each file in the editor of that window, at line and column
            when given. With --wait it returns once you close them, so
            GIT_EDITOR='palmux open --wait' edits commit messages there.
  web       shows a port on this machine (5173) or a url in a web tab.
  git       opens Source Control for the repository of the current directory.
  comments  prints the review comments of the current repository, as markdown
            for an agent. It needs no palmux terminal.
  status    prints this version, the server's, and the terminal you are in.

Relative paths are read from the current directory, and ~/ is your home.
download, open, web and git run inside a palmux terminal (tmux in one is fine).

Paths that cannot be handled are listed and the others still go. A path that
starts with - goes after --, as in: palmux open -- -notes.md
Exit status: 0 ok, 1 a failure, 2 wrong usage.`;

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
  /** Raw stdout, no newline added. */
  write: (text: string) => void;
  /** The checkout's version; a function so a run that does not print it never pays for the git call behind it. */
  version: () => Promise<string>;
  /** Where `post` goes, for `palmux status`. */
  address: string;
  sleep: (ms: number) => Promise<void>;
}

/** How many times `open --wait` retries an unreachable server, a second apart (a restart). */
const WAIT_RETRIES = 60;
const WAIT_RETRY_MS = 1000;

const HELP_FLAGS = new Set(['-h', '--help']);

/** Split the arguments at `--`: options before it, every argument after it a literal operand. */
function splitOptions(args: string[]): { options: string[]; operands: string[] } {
  const options: string[] = [];
  const operands: string[] = [];
  let literal = false;
  for (const arg of args) {
    if (literal) operands.push(arg);
    else if (arg === '--') literal = true;
    else if (arg.startsWith('-') && arg !== '-') options.push(arg);
    else operands.push(arg);
  }
  return { options, operands };
}

type Reply =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; unreachable?: { message: string } };

/**
 * Post one request and read the reply; every failure is already reported on `err`, except an
 * unreachable server under `quietUnreachable`, which the caller retries.
 */
async function request(
  deps: CliDeps,
  cmd: CliCommand,
  body: object,
  quietUnreachable = false,
): Promise<Reply> {
  const predates = (): Reply => {
    deps.err(`palmux: this palmux server predates \`palmux ${cmd}\`; restart it`);
    return { ok: false };
  };
  let res: { status: number; text: string };
  try {
    res = await deps.post(body);
  } catch (e) {
    const message = `palmux: cannot reach the palmux server (${(e as Error).message})`;
    if (quietUnreachable) return { ok: false, unreachable: { message } };
    deps.err(message);
    return { ok: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    // The SPA shell or a 404 page: a server started before `/cli` existed.
    return predates();
  }
  const reply: Record<string, unknown> =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const commands = reply['commands'];
  if (Array.isArray(commands)) {
    if (!commands.includes(cmd)) return predates();
  } else if (cmd !== 'download') {
    return predates();
  }
  // Without `commands`, a download reply comes from an older server that knows download only.
  if (res.status !== 200) {
    const error = reply['error'];
    deps.err(`palmux: ${typeof error === 'string' ? error : `server answered ${res.status}`}`);
    return { ok: false };
  }
  return { ok: true, body: reply };
}

function noTerminal(deps: CliDeps, cmd: string): string | null {
  const tty = deps.tty();
  if (!tty) {
    deps.err(`palmux: this shell has no terminal; run palmux ${cmd} inside a palmux terminal`);
  }
  return tty;
}

/**
 * `open --wait`: ask until no editor tab shows any of `paths`. The first request gives a tab that
 * is still being created time to appear. A server that cannot be reached is asked again for a
 * minute, because its tabs survive a restart.
 */
async function waitClosed(deps: CliDeps, paths: string[]): Promise<boolean> {
  let open = paths;
  let first = true;
  let misses = 0;
  while (open.length > 0) {
    const reply = await request(
      deps,
      'wait',
      first ? { cmd: 'wait', paths: open, appear: true } : { cmd: 'wait', paths: open },
      true,
    );
    if (!reply.ok) {
      if (!reply.unreachable) return false;
      misses += 1;
      if (misses > WAIT_RETRIES) {
        deps.err(reply.unreachable.message);
        return false;
      }
      await deps.sleep(WAIT_RETRY_MS);
      continue;
    }
    misses = 0;
    first = false;
    const still = (reply.body as unknown as CliWaitResult).open;
    open = Array.isArray(still) ? open.filter((p) => still.includes(p)) : [];
  }
  return true;
}

function describeTerminal(terminal: CliStatusResult['terminal']): string {
  if (!terminal) return 'not a palmux terminal';
  const where = terminal.window ? `in detached window ${terminal.window}` : 'in the main window';
  return `terminal ${terminal.id}, ${terminal.attached ? `shown ${where}` : `${where}, not shown now`}`;
}

/** Run one invocation; resolves to the exit status. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [cmd, ...args] = argv;
  if (cmd === undefined || cmd === 'help' || HELP_FLAGS.has(cmd)) {
    deps.out(USAGE);
    return 0;
  }
  if (cmd === '-v' || cmd === '--version' || cmd === 'version') {
    deps.out(`palmux ${await deps.version()}`);
    return 0;
  }
  const usage = (): number => {
    deps.err(USAGE);
    return 2;
  };
  const { options, operands: rest } = splitOptions(args);
  if (options.some((option) => HELP_FLAGS.has(option))) {
    deps.out(USAGE);
    return 0;
  }
  const waitFlag = cmd === 'open' && options.some((o) => o === '-w' || o === '--wait');
  const unknown = options.find((o) => !(cmd === 'open' && (o === '-w' || o === '--wait')));
  if (unknown !== undefined) {
    deps.err(`palmux: unknown option '${unknown}'`);
    return usage();
  }
  switch (cmd) {
    case 'download':
    case 'open': {
      if (rest.length === 0) return usage();
      const tty = noTerminal(deps, cmd);
      if (!tty) return 1;
      const paths = rest.map((arg) => serverPath(deps.cwd, arg));
      const reply = await request(deps, cmd, { cmd, tty, paths });
      if (!reply.ok) return 1;
      const failures: CliOpenResult['failed'] =
        (reply.body['failed'] as CliOpenResult['failed']) ?? [];
      if (cmd === 'download') {
        for (const path of (reply.body as unknown as CliDownloadResult).sent) {
          deps.out(`downloading ${path}`);
        }
      } else {
        for (const path of (reply.body as unknown as CliOpenResult).opened) {
          deps.out(`opened ${path}`);
        }
      }
      for (const { path, error } of failures) deps.err(`palmux: ${path}: ${error}`);
      const status = failures.length > 0 ? 1 : 0;
      if (!waitFlag) return status;
      const opened = [...new Set((reply.body as unknown as CliOpenResult).opened)];
      if (opened.length === 0) return status;
      const commands = reply.body['commands'];
      if (!Array.isArray(commands) || !commands.includes('wait')) {
        deps.err('palmux: this palmux server predates `palmux open --wait`; restart it');
        return 1;
      }
      return (await waitClosed(deps, opened)) ? status : 1;
    }
    case 'web': {
      if (rest.length !== 1) return usage();
      const tty = noTerminal(deps, cmd);
      if (!tty) return 1;
      const reply = await request(deps, cmd, { cmd, tty, url: rest[0] });
      if (!reply.ok) return 1;
      deps.out(`opened ${(reply.body as unknown as CliWebResult).url}`);
      return 0;
    }
    case 'status': {
      if (rest.length > 0) return usage();
      const mine = await deps.version();
      deps.out(`palmux  ${mine}`);
      const tty = deps.tty();
      const reply = await request(deps, cmd, tty ? { cmd, tty } : { cmd });
      if (!reply.ok) return 1;
      const { version, terminal } = reply.body as unknown as CliStatusResult;
      deps.out(`server  ${version} at ${deps.address}`);
      deps.out(
        tty
          ? `tty     ${tty}: ${describeTerminal(terminal)}`
          : 'tty     none: this shell has no terminal',
      );
      if (version !== mine) {
        deps.err(
          'palmux: the server runs another build than this checkout; restart it to update it',
        );
      }
      return 0;
    }
    case 'git': {
      if (rest.length > 0) return usage();
      const tty = noTerminal(deps, cmd);
      if (!tty) return 1;
      const reply = await request(deps, cmd, { cmd, tty, cwd: deps.cwd });
      if (!reply.ok) return 1;
      const { repo, note } = reply.body as unknown as CliGitResult;
      deps.out(`Source Control: ${repo}`);
      if (note) deps.err(`palmux: ${note}`);
      return 0;
    }
    case 'comments': {
      if (rest.length > 0) return usage();
      const reply = await request(deps, cmd, { cmd, cwd: deps.cwd });
      if (!reply.ok) return 1;
      const { markdown } = reply.body as unknown as CliCommentsResult;
      if (markdown !== '') deps.write(markdown);
      return 0;
    }
    default:
      return usage();
  }
}

/** POST to the palmux server this machine's config names, with its session cookie. */
export function serverAddress(): string {
  const cfg = resolveAppConfig();
  const wildcard = cfg.host === '' || cfg.host === '0.0.0.0' || cfg.host === '::';
  const host = wildcard ? '127.0.0.1' : cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host;
  return `http://${host}:${cfg.port}`;
}

export function localPost(address = serverAddress()): CliDeps['post'] {
  const cfg = resolveAppConfig();
  return async (body) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.auth) {
      const secret = readFileSync(join(configDir(), 'secret'), 'utf8').trim();
      headers['cookie'] = `${SESSION_COOKIE}=${secret}`;
    }
    const res = await fetch(`${address}/cli`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  };
}
