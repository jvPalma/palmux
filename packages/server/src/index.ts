// ── Entry point + CLI ──────────────────────────────────────────────────────────
//
// Thin CLI over app-config.ts. Precedence: CLI > PALMUX_* env > config.json >
// defaults; `--print-config` shows the fully resolved result.

import { dirname } from 'node:path';
import { createServer, createSessionRegistry } from './server';
import { createUpdater } from './self-update';
import { createUpdateDeps } from './self-update-runtime';
import {
  adoptSessions,
  buildHandoff,
  handoffBlockedReason,
  readHandoff,
  spawnSuccessor,
} from './handoff';
import { APP_VERSION } from './version';
import {
  loadOrCreateSecret,
  rotateSecret,
  configDir,
  ensureConfigGitignore,
  ensureExtraKeysFile,
  ensureSettingsSplit,
} from './config';
import { type AppConfig, appConfigPath, ensureAppConfigFile, resolveAppConfig } from './app-config';

interface CliArgs {
  overrides: Partial<AppConfig>;
  newToken: boolean;
  printConfig: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    overrides: {},
    newToken: false,
    printConfig: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--port':
      case '-p': {
        const port = Number(argv[++i]);
        if (Number.isInteger(port) && port >= 1 && port <= 65535) args.overrides.port = port;
        break;
      }
      case '--host': {
        const host = argv[++i];
        if (host) args.overrides.host = host;
        break;
      }
      case '--no-auth':
        args.overrides.auth = false;
        break;
      case '--new-token':
        args.newToken = true;
        break;
      case '--print-config':
        args.printConfig = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--version':
      case '-v':
        args.version = true;
        break;
    }
  }
  return args;
}

const HELP = `palmux — a web terminal

Usage: palmux [options]

Options:
  -p, --port <n>     Port to listen on (default 44040, env PALMUX_PORT)
      --host <addr>  Bind address (default 0.0.0.0, env PALMUX_HOST)
      --no-auth      Disable token auth (trusted networks only; env PALMUX_NO_AUTH=1)
      --new-token    Rotate the session token and exit
      --print-config Print the resolved configuration and exit
  -v, --version      Print the build version and exit
  -h, --help         Show this help

Configuration file: ~/.config/palmux/config.json (created on first run).
Every option — host, port, auth, shell, cwd, fontDirs, allowedIps (CIDR ok),
allowedOrigins (*.wildcards ok), scrollbackBytes, cookieDays — lives there.
Precedence: CLI > PALMUX_* env > config.json > defaults.
Config dir override: PALMUX_CONFIG_DIR (default ~/.config/palmux)`;

/** Directory holding the running bundle — only meaningful for a `bin/` deployment
 *  (from source, self-update is a no-op and never asks). */
const bundleDir = (): string => dirname(process.argv[1] ?? '');

/** How often a restore snapshot is taken, for the deaths that send no signal. */
const SNAPSHOT_INTERVAL_MS = 60_000;
/** How long a clean shutdown may take before we exit anyway (systemd's own
 *  patience is 90s, and it ends in SIGKILL for every process in the unit). */
const SHUTDOWN_GRACE_MS = 3000;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    console.log(APP_VERSION);
    return;
  }
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.newToken) {
    const token = rotateSecret();
    console.log(`New session token (all existing sessions invalidated):\n${token}`);
    return;
  }

  ensureAppConfigFile();
  const cfg = resolveAppConfig(args.overrides);

  if (args.printConfig) {
    console.log(JSON.stringify(cfg, null, 2));
    console.log(`\n(config file: ${appConfigPath()})`);
    return;
  }

  const secret = loadOrCreateSecret();
  ensureExtraKeysFile(); // write a starter ~/.config/palmux/extra-keys.json if absent
  ensureConfigGitignore(); // keep per-machine state out of a dotfiles repo
  ensureSettingsSplit(); // lift a legacy themeId out of the synced settings.json

  // Live handoff: adopt any PTYs the previous process handed over, so their
  // shells (and everything running inside them) survive this restart. Anything
  // that fails to adopt is skipped and simply respawns — never worse than a cold
  // start. Read EARLY so the manifest never leaks into a spawned shell's env.
  const handoff = readHandoff();
  const adopted = handoff ? adoptSessions(handoff, cfg.scrollbackBytes) : undefined;
  const registry = createSessionRegistry(cfg, undefined, undefined, adopted);
  const app = await createServer(cfg, secret, registry);

  await app.listen({ port: cfg.port, host: cfg.host });

  const shown = cfg.host === '0.0.0.0' ? 'localhost' : cfg.host;
  console.log(`palmux listening on http://${shown}:${cfg.port}`);
  console.log(`config: ${configDir()}`);
  if (cfg.allowedIps.length) console.log(`allowed IPs: ${cfg.allowedIps.join(', ')}`);
  if (cfg.allowedOrigins.length) console.log(`allowed origins: ${cfg.allowedOrigins.join(', ')}`);
  if (!cfg.auth) {
    console.log('auth: DISABLED');
  } else {
    console.log(`auth: token required — authenticate at http://${shown}:${cfg.port}/auth`);
    console.log(`token: ${secret}`);
  }

  if (adopted?.size) {
    console.log(`handoff: adopted ${adopted.size} live session(s) from the previous process`);
  }

  // Hand every live shell to a successor, then exit without killing them.
  const restartViaHandoff = (why: string): void => {
    const blocked = handoffBlockedReason();
    if (blocked) {
      console.error(`handoff: REFUSED — ${blocked}. Sessions left running, untouched.`);
      return;
    }
    const { manifest, fds } = buildHandoff(registry.liveSessions());
    console.log(`handoff: ${why} — handing ${manifest.entries.length} session(s) to a successor`);
    app.close().finally(() => {
      try {
        spawnSuccessor(manifest, fds);
      } catch (err) {
        console.error('handoff: successor spawn failed:', err);
      }
      process.exit(0);
    });
  };

  // Opt-in self-update. Inert unless config.json enables it AND supplies both a
  // repo and a signing key (app-config refuses the combination otherwise).
  if (cfg.selfUpdate.enabled) {
    const updater = createUpdater(
      cfg.selfUpdate,
      createUpdateDeps({
        repo: cfg.selfUpdate.repo,
        bundleDir: bundleDir(),
        notify: (stage, version) => app.broadcastUpdating(stage, version),
      }),
    );
    updater.start();
    console.log(
      `self-update: enabled (${cfg.selfUpdate.repo}, ${cfg.selfUpdate.channel}, every ${String(cfg.selfUpdate.intervalHours)}h)`,
    );
    // A staged update only takes effect on restart — do it through the handoff so
    // the user's shells survive the version change.
    void updater.checkNow().then((outcome) => {
      console.log(`self-update: ${outcome}`);
      if (outcome === 'staged') restartViaHandoff('self-update');
    });
  }

  // SIGUSR1 = LIVE HANDOFF. Collect every running shell's master fd + replay
  // ring, close our listener so the successor can bind the port, hand the fds to
  // a detached successor, and exit WITHOUT killing the shells (they are
  // reparented and keep running behind the fds the successor now holds).
  process.on('SIGUSR1', () => restartViaHandoff('SIGUSR1'));

  // Cold-start restore snapshots. Written on the way out AND on a timer: a
  // systemd restart or a reboot gives us SIGTERM (so the shutdown capture is the
  // accurate one), but a crash or a power cut gives us nothing, and a snapshot a
  // minute stale still reopens what was running. The tick records only cwd +
  // command — a few hundred bytes; the screen buffer rides along at shutdown.
  if (cfg.restoreSessions) {
    const timer = setInterval(() => registry.snapshotForRestore(), SNAPSHOT_INTERVAL_MS);
    timer.unref(); // never hold the process open on our own account
    registry.snapshotForRestore();
  }

  const shutdown = () => {
    // Before the capture, not after: closing the server kills every shell, and
    // the exit handler must not mistake that for the user closing a tab (which
    // deletes the snapshot).
    registry.beginShutdown();
    const saved = cfg.restoreSessions ? registry.snapshotForRestore(true) : 0;
    if (saved) console.log(`restore: saved ${saved} terminal snapshot(s)`);
    // Sockets first: Fastify's close() waits for open connections, and an
    // upgraded WebSocket is one, so a single attached browser used to hold the
    // stop open until systemd lost patience and SIGKILLed the cgroup (taking
    // every shell with it). Snapshots are already on disk by this point.
    app.closeSockets();
    // And a floor under it regardless. Whatever else is holding the event loop,
    // the snapshots are written, so exiting is strictly better than being killed.
    const giveUp = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
    giveUp.unref();
    app.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // SIGHUP (e.g. the terminal running the server closing, or a supervisor
  // restart) would otherwise kill the process WITHOUT emitting 'exit', dropping
  // the tabs-store's debounced write. Route it through the clean shutdown so the
  // exit-flush runs.
  process.on('SIGHUP', shutdown);
}

main().catch((err) => {
  console.error('palmux failed to start:', err);
  process.exit(1);
});
