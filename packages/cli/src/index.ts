// ── `palmux` — the client-side half of the command ────────────────────────────
//
// The only file with side effects: it parses argv, resolves the path, makes one
// request and sets an exit code. Everything it decides with is in `args.ts`
// (parsing) and `render.ts` (output), both pure and both unit-tested, so the
// behaviour worth testing is not trapped behind a subprocess.

import { resolve } from 'node:path';
import { parseArgs, type CliCommand } from './args';
import { postCli, resolvePort } from './client';
import { HELP, renderGroups, renderOpen, renderSettings, renderStatus, renderTabs } from './render';

/**
 * The tab this shell lives in — the window the user is looking at, as far as
 * anything here can know.
 *
 * Suppressed under tmux, and that is the whole subtlety. A tmux SERVER outlives
 * the shell that started it and hands its own environment to every pane of every
 * future attach, from any tab and any machine — so `$PALMUX_TAB_ID` read inside
 * tmux can name a tab that has nothing to do with this command. Reporting it
 * would move a window the user is not looking at, which is worse than reporting
 * nothing: with no origin the server falls back to the most recently focused
 * window, which is usually right and never surprising.
 */
function sourceTab(): string | undefined {
  if (process.env['TMUX']) return undefined;
  return process.env['PALMUX_TAB_ID'] || undefined;
}

/**
 * The directory the user typed the command in — which is NOT always `cwd`.
 *
 * `bin/palmux` is an `exec`, so it inherits the shell's cwd and `process.cwd()`
 * is right. The `yarn palmux` script does NOT: yarn runs a root script with the
 * cwd set to the project root, so the caller's directory only survives in
 * `INIT_CWD`, where yarn records the invocation. Reading `cwd` alone made
 * `yarn palmux ../README.md` from `scripts/` look for `README.md` beside the
 * root.
 *
 * The root script deliberately calls node on the source rather than going
 * through `yarn workspace`, and that is not a style choice: `yarn workspace`
 * re-roots the cwd AND rewrites `INIT_CWD` to the workspace directory, so the
 * caller's directory is gone by the time this runs and no amount of reading the
 * environment gets it back. If that script ever reverts to `yarn workspace`,
 * this function silently degrades to `process.cwd()` for that entry point.
 */
function callerCwd(): string {
  return process.env['INIT_CWD'] || process.cwd();
}

interface Invocation {
  payload: Record<string, unknown>;
  render: (body: unknown) => string;
}

/** The request a command becomes, and how its reply reads. Exhaustive by type. */
function invocationOf(cmd: CliCommand): Invocation {
  switch (cmd.kind) {
    case 'open': {
      // Resolved HERE rather than server-side: the CLI runs on the same host as
      // the server, but not in the same cwd, so a relative path would otherwise
      // be resolved against the server's.
      const path = resolve(callerCwd(), cmd.path);
      return {
        payload: { cmd: 'open', path, from: sourceTab() },
        render: (body) => renderOpen(body, path),
      };
    }
    case 'tabs':
      return { payload: { cmd: 'tabs' }, render: renderTabs };
    case 'groups':
      return { payload: { cmd: 'groups' }, render: renderGroups };
    case 'settings':
      return { payload: { cmd: 'settings' }, render: renderSettings };
    case 'status':
      return { payload: { cmd: 'status' }, render: renderStatus };
    case 'help':
      return { payload: {}, render: () => HELP };
  }
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`palmux: ${parsed.error}\n`);
    return 1;
  }
  if (parsed.command.kind === 'help') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const { payload, render } = invocationOf(parsed.command);
  const port = await resolvePort();
  const result = await postCli(payload, port);

  if (!result.ok) {
    process.stderr.write(
      result.kind === 'unreachable'
        ? `palmux: not running on port ${result.port}\n`
        : `palmux: ${result.error}\n`,
    );
    return 1;
  }
  process.stdout.write(`${render(result.body)}\n`);
  return 0;
}

// `process.exitCode`, not `process.exit()`: an exit call can truncate a stdout
// write to a pipe that is still draining, which is exactly what a command whose
// whole output is a listing does.
main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`palmux: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
