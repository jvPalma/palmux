// ── HTTP + WebSocket server ────────────────────────────────────────────────────
//
// Fastify hosts the built client and guards everything behind the session
// cookie; a raw `ws` server handles the /ws upgrade and bridges each socket to
// its own PTY. Text frames are the JSON protocol; binary frames are raw bytes.

import { createReadStream, existsSync, mkdirSync, watch } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  dynamicThemes,
  encodeServerMessage,
  forgivingOrder,
  isEmbeddableUrl,
  isTabId,
  nextFreeId,
  normalizeOrder,
  parseClientMessage,
  registerDynamicThemes,
  type JsonObject,
  type TabGroup,
  type TabKind,
  type TabMeta,
  type UpdatingMessage,
  type WebAppLink,
} from '@palmux/shared';

declare module 'fastify' {
  interface FastifyInstance {
    /** Broadcast a self-update stage to every connected client. */
    broadcastUpdating(stage: UpdatingMessage['stage'], version?: string): void;
    /** Close every live WebSocket. Must run before app.close() — see index.ts. */
    closeSockets(): void;
  }
}
import {
  SESSION_COOKIE,
  type AuthConfig,
  authPageHtml,
  isRequestAuthed,
  safeNext,
  secretEquals,
} from './auth';
import { configDir, loadExtraKeys, loadSettings, saveExtraKeys, saveSettings } from './config';
import { PtySession } from './pty';
import { themeIdFrom, writeThemeExport } from './theme-export';
import { APP_VERSION } from './version';
import { discoverThemes, watchThemes } from './theme-files';
import {
  WEBPROXY_PREFIX,
  parseProxyPath,
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
  targetFromReferer,
  upstreamUrl,
} from './webproxy';
import { importTheme } from './theme-import';
import {
  createGroupsStore,
  createTabsStore,
  type GroupsStore,
  type PersistedGroup,
  type PersistedTab,
  type TabsStore,
} from './tabs-store';
import { randomBytes } from 'node:crypto';
import { saveUpload } from './upload';
import { dictate, DictationError } from './dictate';
import {
  audioStream,
  findAudio,
  parseRange,
  listTranscripts,
  readAudioFile,
  saveAudio,
  saveTranscript,
} from './transcripts';
import {
  captureProcess,
  createHintStore,
  createRestoreStore,
  quoteArgv,
  restorableRing,
  ttyOf,
  type HintStore,
  type RestoreStore,
} from './session-restore';
import { bundleZip, contentDisposition, resolveDownload } from './download';
import { listMdDir, readMdFile } from './markdown';
import { deletePaths, listDir } from './files';
import { readTextFile, writeTextFile } from './file-rw';
import { themedManifest } from './manifest';
import { registerConfigFileRoutes } from './config-file';
import { registerPortsRoutes } from './ports';
import { discoverFonts } from './fonts';
import { isTmuxSessionName, listTmuxSessions, tmuxAttachCommand } from './tmux';
import { ipAllowed, wsOriginAllowed } from './net-rules';
import { appConfigPath, type AppConfig } from './app-config';
import type { FontInfo } from '@palmux/shared';

function resolveClientDir(): string {
  const override = process.env['PALMUX_CLIENT_DIR'];
  if (override) return override;
  return fileURLToPath(new URL('../../client/dist', import.meta.url));
}

// A same-origin rejection is indistinguishable from "the app is broken" in the
// browser — the socket just closes — so it has to say what to do about it. One
// line per distinct Origin (a rejected handshake is retried by the client's
// reconnect loop, and a hostile one can be sent in a flood), capped so a stream
// of junk origins cannot grow the set without bound.
const rejectedOrigins = new Set<string>();
function warnOriginRejected(origin: string | undefined, host: string | undefined): void {
  const key = `${origin ?? '(none)'} \u2192 ${host ?? '(none)'}`;
  if (rejectedOrigins.has(key) || rejectedOrigins.size >= 20) return;
  rejectedOrigins.add(key);
  console.error(
    `palmux: refused a WebSocket from Origin ${origin ?? '(none)'} — it does not match the ` +
      `requested host ${host ?? '(none)'}. If this is your own reverse proxy rewriting Host, ` +
      `add the origin to "allowedOrigins" in ${appConfigPath()}.`,
  );
}

// ── Tab registry ──────────────────────────────────────────────────────────────
//
// Every workspace slot is a tab; only `terminal` tabs own a PTY (spawned on
// first attach, exactly as sessions always worked). Non-terminal tabs are pure
// metadata: they exist, persist, and broadcast, but no process backs them.
// Shared by the ws bridge and the HTTP routes so all see the same live tabs.

interface TabRecord {
  kind: TabKind;
  name?: string;
  color?: string;
  url?: string;
  pty?: PtySession;
  /** Tab-group membership (isGroupId). Independent of name/color. */
  groupId?: string;
  /**
   * The pty's controlling tty (`pts/16`), captured while the process is ALIVE.
   * `ttyOf` reads /proc/<pid>/fd/0, which is gone the instant the shell exits,
   * so the exit path could otherwise never find the hint file to clear.
   */
  tty?: string;
  /**
   * Set the moment a kill is issued, cleared by nothing (the record is dropped
   * on exit). A killed shell stays `alive` until it actually dies — up to the
   * 3s SIGKILL escalation — and a snapshot tick or a shutdown landing inside
   * that window would write back the snapshot the kill just forgot.
   */
  dying?: boolean;
}

interface GroupMeta {
  name?: string;
  color: string;
}

/** Metadata for a group op (create/update); all fields optional. */
export interface GroupPatch {
  name?: string;
  color?: string;
  addIds?: string[];
  removeIds?: string[];
  dissolve?: boolean;
  order?: string[];
}

// Palette color NAMES a color-less group cycles through (matches the client's
// TAB_COLORS / --tab-c-* accents). Kept here so the server can assign a default.
const GROUP_DEFAULT_COLORS = [
  'blue',
  'green',
  'peach',
  'mauve',
  'teal',
  'yellow',
  'pink',
  'sky',
  'red',
  'lavender',
  'maroon',
  'gray',
];

export interface CreateTabSpec {
  kind: TabKind;
  url?: string;
  name?: string;
  color?: string;
}

export interface UpdateTabPatch {
  name?: string;
  color?: string;
  url?: string;
}

export interface SessionRegistry {
  /**
   * The live PTY for a terminal tab `id`, creating/spawning it if needed.
   *
   * `spawn.command` is typed into the shell if — and only if — this call is what
   * spawns it. It rides the /ws attach rather than a control message because the
   * attach IS the spawn trigger: a separate message travels on a different
   * socket and could lose the race with it.
   */
  get(id: string, spawn?: { command?: string }): PtySession;
  has(id: string): boolean;
  kill(id: string): void;
  ids(): string[];
  titles(): { [id: string]: string };
  /** Full tab metadata for the `sessions` broadcast. */
  tabs(): TabMeta[];
  /** Tab groups, strip-ordered (each group's position = its first member's). */
  groups(): TabGroup[];
  /** The kind of a live tab, or undefined when no tab exists at `id`. */
  kindOf(id: string): TabKind | undefined;
  /** Create a tab at the lowest free id. Null = invalid spec (web without url). */
  createTab(spec: CreateTabSpec): string | null;
  /** Patch tab metadata; empty-string name/color clears. False = no such tab. */
  updateTab(id: string, patch: UpdateTabPatch): boolean;
  /**
   * Apply a new display order (forgiving permutation: unknown ids ignored,
   * omitted known ids appended in prior relative order). False = no change.
   */
  reorder(ids: string[]): boolean;
  /** Create a group from known tab ids (default color if omitted). Null = no
   *  known members. Joining tabs leave any prior group (at most one each). */
  groupCreate(ids: string[], meta: { name?: string; color?: string }): string | null;
  /** Mutate a group (name/color/add/remove/dissolve/order), forgiving. False =
   *  unknown group or no effective change. */
  groupUpdate(id: string, patch: GroupPatch): boolean;
  /** Fired when the tab list or any tab's metadata changes. */
  onListChanged(cb: () => void): void;
  /** Fired on every title change; the subscriber coalesces. */
  onTitleChanged(cb: () => void): void;
  /** Live terminal PTYs — the export side of a live handoff. */
  liveSessions(): { id: string; session: PtySession }[];
  /**
   * Write a cold-start snapshot (cwd + the foreground command) for every live
   * terminal. Called periodically and on shutdown, because the two ways this
   * server dies — a systemd restart and a reboot — both end in a cold start
   * where the shells themselves are unrecoverable.
   *
   * `includeRing` adds the replay buffer, which is ~4 orders of magnitude
   * bigger than the rest of the record and is ONLY what a terminal shows, never
   * what it is running. The periodic tick leaves it out: a program that keeps
   * its own state (tmux, screen) is fully restored by the command alone, and
   * rewriting half a megabyte per tab per minute to buy back scrollback after a
   * power cut is not a trade worth making. Shutdown — the overwhelmingly common
   * case, and the one where accuracy matters — writes it.
   */
  snapshotForRestore(includeRing?: boolean): number;
  /**
   * Announce that the process is stopping, BEFORE the final snapshot. Every
   * shell is about to exit, and those exits must not be read as "the user
   * closed this tab" — that is the one case whose snapshot has to survive.
   */
  beginShutdown(): void;
}

export function createSessionRegistry(
  cfg: AppConfig,
  store: TabsStore = createTabsStore(),
  groupsStore: GroupsStore = createGroupsStore(),
  /** PTYs inherited from a previous process via a live handoff (id → session). */
  adopted?: Map<string, PtySession>,
  restoreStore: RestoreStore = createRestoreStore(),
  hints: HintStore = createHintStore(),
): SessionRegistry {
  const tabs = new Map<string, TabRecord>();
  const restoreEnabled = cfg.restoreSessions;
  // Set once, on the way out. It is what tells the exit path apart from the two
  // situations that look identical to it: a shell the user quit (its snapshot is
  // garbage — the id will be recycled) and a shell the SERVER is killing on
  // shutdown (its snapshot is the whole point of session restore).
  let shuttingDown = false;
  // Tab groups: id → metadata. Restored from the SIDECAR groups.json; a tab's
  // groupId is kept below only if its group survives here (dangling self-heals).
  const groups = new Map<string, GroupMeta>();
  for (const g of groupsStore.load()) {
    groups.set(g.id, { color: g.color, ...(g.name !== undefined ? { name: g.name } : {}) });
  }
  // Restore persisted tabs. Non-terminal tabs come back fully. A terminal comes
  // back as a DORMANT tab (kind terminal, no live PTY) only if it carried a
  // name/color worth remembering — bare terminals are dropped (their process is
  // gone and they held no metadata). A dormant terminal is a first-class tab:
  // it's listed, switchable, renamable, and killable; clicking it (get → attach)
  // spawns a fresh shell that inherits the remembered name/color. This keeps
  // termMeta from being a hidden, unkillable, unlistable shadow map.
  // Display order, decoupled from id: tabs.json's ARRAY ORDER is the persisted
  // order (restore below iterates it), new tabs append, reorder() permutes.
  // Ids/URLs stay stable identities; only this array moves.
  const order: string[] = [];
  for (const t of store.load()) {
    // A bare terminal (no remembered metadata) is dropped — its process is gone.
    // Membership in a SURVIVING group counts as metadata worth keeping: the
    // terminal comes back dormant in its group (respawns on attach), so a restart
    // never silently drops a member and fragments the group. A dangling groupId
    // (its group gone from the sidecar) is NOT worth keeping — dropped as usual.
    // A restore snapshot is ALSO metadata worth keeping, and the most important
    // kind: it is what the terminal was doing. Without this clause a bare tab
    // running a named tmux session was dropped on every restart — the exact
    // "four terminals, all their content gone" complaint.
    const liveMember = t.groupId !== undefined && groups.has(t.groupId);
    const restorable = restoreEnabled && restoreStore.load(t.id) !== null;
    if (
      t.kind === 'terminal' &&
      t.name === undefined &&
      t.color === undefined &&
      !liveMember &&
      !restorable
    ) {
      continue;
    }
    tabs.set(t.id, {
      kind: t.kind,
      ...(t.name !== undefined ? { name: t.name } : {}),
      ...(t.color !== undefined ? { color: t.color } : {}),
      ...(t.url !== undefined ? { url: t.url } : {}),
      // Keep membership only if the group survived the sidecar restore.
      ...(t.groupId !== undefined && groups.has(t.groupId) ? { groupId: t.groupId } : {}),
    });
    order.push(t.id);
  }
  pruneEmptyGroups(); // a group whose members were all dropped is gone
  applyNormalizedOrder(); // contiguous on boot

  let listChanged: () => void = () => {};
  let titleChanged: () => void = () => {};

  const orderedIds = () => [...order];
  const dropFromOrder = (id: string) => {
    const at = order.indexOf(id);
    if (at !== -1) order.splice(at, 1);
  };

  // A function declaration (not a const arrow) so the restore-time normalize
  // above can call it — hoisted with `tabs` already initialized.
  function groupIdOf(id: string): string | undefined {
    return tabs.get(id)?.groupId;
  }

  function applyNormalizedOrder(): void {
    // The contiguity partition itself is the shared model (used identically by
    // the client's optimistic layer) — here it just re-partitions `order`.
    const norm = normalizeOrder(order, groupIdOf);
    order.length = 0;
    order.push(...norm);
  }

  function pruneEmptyGroups(): void {
    for (const gid of [...groups.keys()]) {
      let has = false;
      for (const r of tabs.values()) {
        if (r.groupId === gid) {
          has = true;
          break;
        }
      }
      if (!has) groups.delete(gid);
    }
  }

  function newGroupId(): string {
    let id: string;
    do {
      id = 'g' + randomBytes(4).toString('hex'); // 'g' + 8 hex → matches isGroupId
    } while (groups.has(id));
    return id;
  }

  /** Forgiving permutation of `order` from `ids` (known-first, omitted appended);
   *  does NOT persist/normalize — callers do. Returns whether `order` changed. */
  function applyForgivingOrder(ids: string[]): boolean {
    const next = forgivingOrder(order, ids, (id) => tabs.has(id));
    const same = next.length === order.length && next.every((id, i) => id === order[i]);
    order.length = 0;
    order.push(...next);
    return !same;
  }

  const persist = () => {
    const out: PersistedTab[] = orderedIds().map((id) => {
      const r = tabs.get(id)!;
      return {
        id,
        kind: r.kind,
        ...(r.name !== undefined ? { name: r.name } : {}),
        ...(r.color !== undefined ? { color: r.color } : {}),
        ...(r.url !== undefined ? { url: r.url } : {}),
        ...(r.groupId !== undefined ? { groupId: r.groupId } : {}),
      };
    });
    store.save(out);
    const g: PersistedGroup[] = [...groups].map(([id, m]) => ({
      id,
      color: m.color,
      ...(m.name !== undefined ? { name: m.name } : {}),
    }));
    groupsStore.save(g);
  };

  // Wire a live PTY — freshly spawned OR adopted from a handoff — into the registry.
  const wireSession = (id: string, rec: TabRecord, created: PtySession): PtySession => {
    rec.pty = created;
    const tty = ttyOf(created.pid);
    if (tty) rec.tty = tty;
    created.onExit(() => {
      // The session is over, so its restore state goes with it — EXCEPT on
      // shutdown, where every shell exits precisely because we are stopping and
      // the snapshot just written is what brings it back. Without this, typing
      // `exit` left `sessions/<id>.json` on disk; ids are recycled lowest-free,
      // so the next tab to land on that id resurrected a shell closed weeks ago.
      // killTab forgets too — it has to, because it returns before the shell is
      // actually dead — and forgetting twice costs nothing.
      if (restoreEnabled && !shuttingDown) {
        restoreStore.forget(id);
        if (rec.tty) hints.clear(rec.tty);
      }
      // Shell exit (or kill) closes the tab; the slot's name/color end with it.
      if (tabs.get(id) === rec) {
        tabs.delete(id);
        dropFromOrder(id);
        pruneEmptyGroups(); // a killed last member dissolves its group
        persist();
      }
      listChanged();
    });
    created.onTitle(() => titleChanged());
    return created;
  };

  // Spawn a shell for a tab, rebuilding what was in it before a cold start:
  // same cwd, the previous screen replayed as scrollback, and whatever command
  // was in the foreground typed back in. A snapshot is consumed ONCE — a tab
  // that respawns again later (shell exited, user reopened) starts clean rather
  // than resurrecting a session from two restarts ago.
  const spawnInto = (id: string, rec: TabRecord, wanted?: string): PtySession => {
    // An explicitly requested command (today: a tmux attach chosen in the
    // new-tab chooser) beats a restore snapshot and discards it. The user just
    // said what this terminal is for; replaying what a previous one was doing
    // and then typing a second command on top of it would be neither.
    const snap = restoreEnabled && !wanted ? restoreStore.load(id) : null;
    if (restoreEnabled && (snap || wanted)) restoreStore.forget(id);
    const ring = snap?.ring ? restorableRing(Buffer.from(snap.ring, 'base64')) : undefined;
    // Rendered here, not stored rendered: the snapshot keeps argv as an array so
    // quoting is applied at the last possible moment, by the one place that
    // knows the string is about to be typed into a shell.
    // An advertised `command` is used verbatim; a scraped argv is quoted.
    const command = wanted || snap?.command || (snap?.argv ? quoteArgv(snap.argv) : '');
    const restore =
      ring?.length || command
        ? {
            ...(ring?.length ? { ring } : {}),
            ...(command ? { command } : {}),
          }
        : undefined;
    const pty = wireSession(
      id,
      rec,
      new PtySession({
        cols: 80,
        rows: 24,
        ...(cfg.shell ? { shell: cfg.shell } : {}),
        ...(snap?.cwd ? { cwd: snap.cwd } : cfg.cwd ? { cwd: cfg.cwd } : {}),
        scrollbackBytes: cfg.scrollbackBytes,
        ...(restoreEnabled ? { hintDir: hints.dir() } : {}),
        ...(restore ? { restore } : {}),
      }),
    );
    // pts numbers are recycled, so a hint left by a PREVIOUS terminal on this
    // same tty would restore the wrong thing. Clearing here — before the shell
    // has even printed a prompt, let alone run anything — means every hint we
    // later read was written during this terminal's own life.
    if (restoreEnabled) {
      const tty = ttyOf(pty.pid);
      if (tty) hints.clear(tty);
    }
    return pty;
  };

  // Live handoff: adopt the PTYs inherited from the previous process. These are
  // kept even when the store dropped their (bare) tab record — the shell is
  // still running, so the tab must come back attached to it, not respawned.
  for (const [id, session] of adopted ?? []) {
    const existing = tabs.get(id);
    if (existing && existing.kind !== 'terminal') continue; // id reused by a pane
    const rec: TabRecord = existing ?? { kind: 'terminal' };
    tabs.set(id, rec);
    if (!order.includes(id)) order.push(id);
    wireSession(id, rec, session);
  }

  // Drop snapshots with no tab. Every in-process death now forgets its own
  // snapshot, but the deaths that run no code — SIGKILL, a power cut — cannot,
  // and tabs.json is the record of what actually survived. Anything on disk
  // without a tab here is from a session nothing can reattach to, and ids are
  // recycled, so leaving it means handing it to a stranger. Runs after BOTH the
  // tabs.json restore and the handoff adopt, so neither is swept out from under.
  if (restoreEnabled) {
    for (const id of restoreStore.ids()) {
      if (!tabs.has(id)) restoreStore.forget(id);
    }
    // And the same for the tty HINTS, which never had this and accumulated for
    // weeks. Runs after the handoff adopt above, so a terminal that survived
    // with its pty keeps the hint it advertised; everything else is from a
    // terminal nothing can reattach to, on a pts number that WILL be handed out
    // again. See HintStore.sweep.
    const swept = hints.sweep(liveTtys());
    if (swept) console.log(`restore: swept ${swept} stale tty hint(s)`);
  }

  /** The ttys palmux's live terminals are on — the only readable hints. */
  function liveTtys(): string[] {
    const out: string[] = [];
    for (const r of tabs.values()) {
      if (r.kind !== 'terminal' || !r.pty?.alive) continue;
      const tty = ttyOf(r.pty.pid);
      if (tty) out.push(tty);
    }
    return out;
  }

  // Kill a tab: a live PTY gets SIGHUP then a SIGKILL escalation (its exit
  // handler removes the tab); a dormant/non-terminal tab drops immediately.
  function killTab(id: string): void {
    const rec = tabs.get(id);
    if (!rec) return;
    // Closing a tab ends that session for good, so its restore snapshot goes
    // with it. Ids are RECYCLED (`/new` picks the lowest free one), and without
    // this the next tab to land on this id would silently resurrect the closed
    // session's command. Only on an explicit kill — never on the exit path,
    // which also runs while the server is shutting down, i.e. right after the
    // snapshots we actually want to keep were written.
    restoreStore.forget(id);
    if (rec.pty?.alive) {
      const tty = ttyOf(rec.pty.pid);
      if (tty) hints.clear(tty);
    }
    if (rec.pty?.alive) {
      rec.dying = true; // keep the snapshot writer off a tab we just forgot
      const dying = rec.pty;
      dying.kill(); // SIGHUP; the exit handler removes the tab + persists + broadcasts
      // Escalate if the shell traps SIGHUP: a tab must not become immortal.
      const force = setTimeout(() => {
        if (dying.alive) dying.kill('SIGKILL');
      }, 3000);
      force.unref?.();
      return;
    }
    tabs.delete(id); // dormant terminal or non-terminal tab
    dropFromOrder(id);
    pruneEmptyGroups();
    persist();
    listChanged();
  }

  // Idle-session eviction: reap terminal PTYs that have had no attached client
  // for longer than cfg.idleTimeoutMs. 0 disables it (the default — never reap).
  if (cfg.idleTimeoutMs > 0) {
    const period = Math.max(30_000, Math.floor(cfg.idleTimeoutMs / 4));
    const sweep = setInterval(() => {
      const now = Date.now();
      for (const [id, rec] of tabs) {
        if (rec.kind !== 'terminal' || !rec.pty?.alive) continue;
        const empty = rec.pty.emptySince();
        if (empty !== null && now - empty >= cfg.idleTimeoutMs) killTab(id);
      }
    }, period);
    sweep.unref?.();
  }

  return {
    get(id, spawn) {
      const existing = tabs.get(id);
      if (existing && existing.kind !== 'terminal') {
        // Programmer error — the ws bridge routes non-terminal attaches away.
        throw new Error(`tab ${id} is ${existing.kind}, not terminal`);
      }
      // Already running: a reconnect, not a spawn, so `spawn.command` does not
      // apply — it must never be typed into a shell that is already in use.
      if (existing?.pty?.alive) return existing.pty;
      // A dormant terminal (restored, or created but not yet attached) keeps its
      // name/color; a brand-new id becomes a fresh terminal.
      if (existing) return spawnInto(id, existing, spawn?.command);
      const rec: TabRecord = { kind: 'terminal' };
      tabs.set(id, rec);
      order.push(id); // new tabs append — a recycled low id never jumps mid-strip
      const pty = spawnInto(id, rec, spawn?.command);
      persist();
      listChanged();
      return pty;
    },
    has: (id) => tabs.has(id),
    liveSessions: () =>
      [...tabs.entries()]
        .filter(([, r]) => r.kind === 'terminal' && r.pty?.alive)
        .map(([id, r]) => ({ id, session: r.pty! })),
    snapshotForRestore(includeRing = false) {
      if (!restoreEnabled) return 0;
      let saved = 0;
      for (const [id, r] of tabs) {
        if (r.kind !== 'terminal' || !r.pty?.alive || r.dying) continue;
        const ring = includeRing ? r.pty.ringBytes() : null;
        // A hint the program advertised for this tty BEATS the /proc capture:
        // it is the only thing that can know what /proc structurally cannot,
        // such as which tmux session a client is on after a switch-client.
        const tty = ttyOf(r.pty.pid);
        const hint = tty ? hints.read(tty) : null;
        const scraped = captureProcess(r.pty.pid);
        restoreStore.save(id, {
          at: Date.now(),
          ...(scraped.cwd ? { cwd: scraped.cwd } : {}),
          ...(hint ?? (scraped.argv ? { argv: scraped.argv } : {})),
          ...(ring?.length ? { ring: ring.toString('base64') } : {}),
        });
        saved++;
      }
      // Cheap, and it keeps a long uptime from re-accumulating what the boot
      // sweep just cleared: this walk already knows every live terminal.
      hints.sweep(liveTtys());
      return saved;
    },
    beginShutdown() {
      shuttingDown = true;
    },
    kill: killTab,
    ids: orderedIds,
    titles: () => {
      const titles: { [id: string]: string } = {};
      for (const [id, r] of tabs) if (r.pty?.title) titles[id] = r.pty.title;
      return titles;
    },
    tabs: () =>
      orderedIds().map((id) => {
        const r = tabs.get(id)!;
        return {
          id,
          kind: r.kind,
          ...(r.name !== undefined ? { name: r.name } : {}),
          ...(r.color !== undefined ? { color: r.color } : {}),
          ...(r.url !== undefined ? { url: r.url } : {}),
          ...(r.pty?.title ? { title: r.pty.title } : {}),
          ...(r.groupId !== undefined ? { groupId: r.groupId } : {}),
        };
      }),
    groups: () => {
      const out: TabGroup[] = [];
      const seen = new Set<string>();
      for (const id of order) {
        const g = tabs.get(id)?.groupId;
        if (!g || seen.has(g)) continue;
        const meta = groups.get(g);
        if (!meta) continue;
        seen.add(g);
        out.push({
          id: g,
          color: meta.color,
          ...(meta.name !== undefined ? { name: meta.name } : {}),
        });
      }
      return out;
    },
    kindOf: (id) => tabs.get(id)?.kind,
    createTab(spec) {
      // A web tab needs a url, and it MUST be embeddable — reject javascript:/
      // data:/protocol-relative so a hostile frame can't be stored + rebroadcast
      // + rendered into an iframe src on every client.
      if (spec.kind === 'web' && !(spec.url && isEmbeddableUrl(spec.url))) return null;
      // A markdown tab's url is a server FILE PATH: optional (no path = the
      // browser view), but when present it must be absolute. An EDITOR tab's
      // url works the same way and is what distinguishes the two things that
      // kind now means: with a url it edits that file on disk, without one it is
      // the tab's own note at /pane-file?tab=<id>.
      if (
        (spec.kind === 'markdown' || spec.kind === 'editor') &&
        spec.url !== undefined &&
        !isAbsolute(spec.url)
      ) {
        return null;
      }
      const id = nextFreeId(orderedIds());
      // The id is recycled, and the tab that held it last may have left a
      // terminal snapshot behind (a crash, or a restart that outlived it). It
      // has nothing to do with the web/editor pane about to take the slot, and
      // leaving it would hand it to whichever terminal lands here next.
      if (restoreEnabled) restoreStore.forget(id);
      tabs.set(id, {
        kind: spec.kind,
        ...(spec.name ? { name: spec.name } : {}),
        ...(spec.color ? { color: spec.color } : {}),
        ...(spec.kind === 'web' && spec.url ? { url: spec.url } : {}),
        ...(spec.kind === 'markdown' && spec.url ? { url: spec.url } : {}),
        ...(spec.kind === 'editor' && spec.url ? { url: spec.url } : {}),
      });
      order.push(id);
      persist();
      listChanged();
      return id;
    },
    updateTab(id, patch) {
      const rec = tabs.get(id);
      if (!rec) return false;
      if (patch.name !== undefined) {
        if (patch.name === '') delete rec.name;
        else rec.name = patch.name;
      }
      if (patch.color !== undefined) {
        if (patch.color === '') delete rec.color;
        else rec.color = patch.color;
      }
      // Same kind-aware url gates as createTab (a raw updateTab frame bypasses
      // the client's validation otherwise): web ⇒ embeddable, markdown ⇒
      // absolute file path.
      if (patch.url !== undefined && rec.kind === 'web' && isEmbeddableUrl(patch.url)) {
        rec.url = patch.url;
      }
      if (
        patch.url !== undefined &&
        (rec.kind === 'markdown' || rec.kind === 'editor') &&
        isAbsolute(patch.url)
      ) {
        rec.url = patch.url;
      }
      persist();
      listChanged();
      return true;
    },
    reorder(ids) {
      // Forgiving permutation (known-first, omitted appended) then normalize for
      // group contiguity — a stale/fragmenting request can never lose, duplicate,
      // or split a group; it just resolves to a valid order.
      const before = [...order];
      applyForgivingOrder(ids);
      applyNormalizedOrder();
      if (order.length === before.length && order.every((id, i) => id === before[i])) return false;
      persist();
      listChanged();
      return true;
    },
    groupCreate(ids, meta) {
      const members = ids.filter((id) => tabs.has(id)); // known tabs only
      if (members.length === 0) return null;
      const gid = newGroupId();
      const color = meta.color || GROUP_DEFAULT_COLORS[groups.size % GROUP_DEFAULT_COLORS.length]!;
      groups.set(gid, { color, ...(meta.name ? { name: meta.name } : {}) });
      for (const id of members) tabs.get(id)!.groupId = gid; // joining leaves any prior group
      pruneEmptyGroups(); // a stolen tab may have emptied its old group
      applyNormalizedOrder();
      persist();
      listChanged();
      return gid;
    },
    groupUpdate(id, patch) {
      const meta = groups.get(id);
      if (!meta) return false; // unknown group → inert (forgiving)
      let changed = false;
      if (patch.dissolve) {
        for (const r of tabs.values()) if (r.groupId === id) delete r.groupId;
        groups.delete(id);
        changed = true;
      } else {
        if (patch.name !== undefined) {
          if (patch.name === '') delete meta.name;
          else meta.name = patch.name;
          changed = true;
        }
        if (patch.color) {
          meta.color = patch.color;
          changed = true;
        }
        for (const tid of patch.addIds ?? []) {
          const r = tabs.get(tid);
          if (r && r.groupId !== id) {
            r.groupId = id; // joining leaves any prior group
            changed = true;
          }
        }
        for (const tid of patch.removeIds ?? []) {
          const r = tabs.get(tid);
          if (r && r.groupId === id) {
            delete r.groupId;
            changed = true;
          }
        }
      }
      if (patch.order && applyForgivingOrder(patch.order)) changed = true;
      pruneEmptyGroups(); // a moved/removed tab may have emptied another group
      applyNormalizedOrder();
      if (!changed) return false;
      persist();
      listChanged();
      return true;
    },
    onListChanged: (cb) => {
      listChanged = cb;
    },
    onTitleChanged: (cb) => {
      titleChanged = cb;
    },
  };
}

export async function createServer(
  cfg: AppConfig,
  secret: string,
  registry: SessionRegistry = createSessionRegistry(cfg),
): Promise<FastifyInstance> {
  const authCfg: AuthConfig = { secret, noAuth: !cfg.auth };
  const fonts = discoverFonts(cfg.fontDirs);
  const app = Fastify({ logger: false });

  // Discover external/user themes so they appear in the picker AND so a saved
  // user-theme id resolves for the theme.sh export written just below.
  registerDynamicThemes(discoverThemes());

  // Write the theme palette export on boot so a fresh shell (even before any
  // theme change) already has <configDir>/theme.sh matching the saved theme.
  writeThemeExport(configDir(), themeIdFrom(loadSettings()));

  // Pane storage: editor-tab notes and same-origin HTML artifacts, both under
  // the config dir so they follow PALMUX_CONFIG_DIR.
  const notesDir = join(configDir(), 'notes');
  const artifactsDir = join(configDir(), 'artifacts');
  try {
    mkdirSync(artifactsDir, { recursive: true });
  } catch {
    /* unwritable config dir — the /artifacts route just 404s */
  }
  const noteFile = (id: string) => join(notesDir, `${id}.md`);
  // Closing an editor tab deletes its note — otherwise a later editor tab that
  // lands on the same id would resurrect ghost content.
  const killTab = (id: string) => {
    if (registry.kindOf(id) === 'editor') {
      void rm(noteFile(id), { force: true }).catch(() => {});
    }
    registry.kill(id);
  };

  await app.register(fastifyCookie);
  await app.register(fastifyFormbody); // parse the POST /auth token form

  // Guard every navigation/asset behind the cookie, except the auth endpoints
  // and the liveness probe. HTML navigations get the token form; other requests
  // get a flat 401. The allowedIps rules apply to EVERYTHING, /auth included —
  // they are a network boundary, not a login convenience.
  app.addHook('onRequest', async (req, reply) => {
    if (!ipAllowed(req.socket.remoteAddress, cfg.allowedIps)) {
      return reply.code(403).send('forbidden');
    }
    const path = req.url.split('?')[0] ?? '/';
    // Defense-in-depth for the artifacts namespace: browsers normalize dot
    // segments away, but raw-socket clients can send them verbatim — reject
    // any /artifacts/ URL whose decoded path still contains one. fastify-static
    // has its own traversal protection; this guarantees a flat 404 regardless.
    if (path.startsWith('/artifacts/')) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(path);
      } catch {
        return reply.code(404).send('not found');
      }
      if (decoded.split('/').includes('..') || decoded.includes('\\')) {
        return reply.code(404).send('not found');
      }
    }
    if (authCfg.noAuth || path === '/auth' || path === '/logout' || path === '/ping') {
      return;
    }
    // PWA install: browsers fetch the manifest and its icons WITHOUT
    // credentials, so these must be public (they contain nothing sensitive;
    // the IP rules above still apply). Bundled webfonts are the same case — CSS
    // @font-face / preload / FontFace fetch in anonymous CORS mode (no cookie),
    // so a gated /webfonts/* would 401 and the font would silently fail to load.
    // (/fonts/:id — the streamed ~/.fonts route — stays gated, above the static.)
    if (
      path === '/manifest.webmanifest' ||
      path.startsWith('/icons/') ||
      path.startsWith('/webfonts/')
    ) {
      return;
    }
    if (isRequestAuthed(req.raw, authCfg)) return;
    const accept = req.headers.accept ?? '';
    if (accept.includes('text/html')) {
      reply.code(401).type('text/html').send(authPageHtml(req.url));
    } else {
      reply.code(401).send('unauthorized');
    }
  });

  // Loopback web proxy (see webproxy.ts for why it must exist at all). This is
  // an onRequest hook rather than a route on purpose: it runs AFTER the auth
  // hook above (registration order), so the cookie gate still guards it, and it
  // sees the raw request before any content-type parser claims the body — the
  // proxy forwards bytes, it does not want them parsed.
  //
  // It runs BEFORE the static handlers so a proxied page's `/src/main.tsx` can
  // never be answered by palmux's own build; the referer check is what keeps
  // that from touching requests the palmux app itself makes.
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '/';
    const target =
      parseProxyPath(req.url, cfg.port) ??
      targetFromReferer(req.url, req.headers.referer, cfg.port);
    if (!target) {
      // A /webproxy/ path we could not resolve (bad port, or palmux's own port
      // — a loop) must not fall through to the SPA shell: answering a proxy
      // request with the app is indistinguishable from the blank frame this
      // feature exists to kill.
      if (path.startsWith(WEBPROXY_PREFIX)) {
        return reply.code(400).type('text/plain').send('palmux: bad /webproxy/<port> target');
      }
      return;
    }
    // A bare `/webproxy/<port>` (no trailing slash) makes every root-absolute
    // sub-resource resolve one level too high, and the referer fallback cannot
    // see the difference. Redirect once so the document always sits at a dir.
    if (path === `${WEBPROXY_PREFIX}${target.port}`) {
      return reply.redirect(`${WEBPROXY_PREFIX}${target.port}/`, 308);
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    try {
      const upstream = await fetch(upstreamUrl(target), {
        method: req.method,
        headers: sanitizeRequestHeaders(req.headers),
        ...(hasBody ? { body: Readable.toWeb(req.raw) as ReadableStream, duplex: 'half' } : {}),
        redirect: 'manual',
      });
      reply.code(upstream.status).headers(sanitizeResponseHeaders(upstream.headers));
      return reply.send(upstream.body ? Readable.fromWeb(upstream.body) : null);
    } catch {
      // The silent blank frame is the thing this whole feature replaces, so a
      // dead upstream must SAY so rather than render nothing.
      return reply
        .code(502)
        .type('text/plain')
        .send(`palmux: nothing answering on 127.0.0.1:${target.port}`);
    }
  });

  app.get('/ping', async (_req, reply) => reply.code(204).send());

  // Dictation history (cookie-gated by the onRequest hook like every route).
  // Full text rides along — snippets are small and it saves a per-entry fetch.
  app.get('/transcripts', async (_req, reply) => reply.send({ entries: listTranscripts() }));

  // GET /transcript-audio?name=<id> — the stored clip, for playback in the
  // history panel. The id is format-checked (isTranscriptId) and never joined
  // to a path the caller controls; findAudio resolves the extension itself.
  app.get('/transcript-audio', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const id = typeof q['name'] === 'string' ? q['name'] : '';
    const clip = findAudio(id);
    if (!clip) return reply.code(404).send({ error: 'no audio for that entry' });
    // Range support is what lets the panel preload metadata for every entry
    // without downloading every clip, and it is also what makes the player's
    // scrubber work at all. Announced unconditionally so the browser asks.
    const range = parseRange(req.headers.range, clip.size);
    if (range === 'unsatisfiable') {
      return reply
        .code(416)
        .header('content-range', `bytes */${clip.size}`)
        .send({ error: 'range not satisfiable' });
    }
    reply
      .header('content-type', clip.mime)
      .header('accept-ranges', 'bytes')
      .header('cache-control', 'private, max-age=300');
    if (range) {
      reply
        .code(206)
        .header('content-range', `bytes ${range.start}-${range.end}/${clip.size}`)
        .header('content-length', String(range.end - range.start + 1));
    } else {
      reply.header('content-length', String(clip.size));
    }
    return reply.send(audioStream(clip.path, range ?? undefined));
  });

  // Build version — lets the client detect a redeploy across reconnects.
  app.get('/version', async (_req, reply) => reply.send({ version: APP_VERSION }));

  // GET renders the token form; the token is submitted via POST so it never
  // lands in a URL / access log / browser history / Referer.
  app.get('/auth', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const next = safeNext(q['next']);
    // Already authenticated → don't re-prompt; go where they were headed. The
    // POST path still re-validates, so this is purely a UX shortcut.
    if (!authCfg.noAuth && isRequestAuthed(req.raw, authCfg)) {
      return reply.redirect(next);
    }
    return reply.type('text/html').send(authPageHtml(next));
  });

  app.post('/auth', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const token = body['token'] ?? '';
    const next = safeNext(body['next']);
    if (token && secretEquals(token, authCfg.secret)) {
      reply.setCookie(SESSION_COOKIE, authCfg.secret, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: Math.round(cfg.cookieDays * 24 * 60 * 60),
      });
      return reply.redirect(next);
    }
    return reply.code(401).type('text/html').send(authPageHtml(next, true));
  });

  app.get('/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.redirect('/auth');
  });

  // GET /new — jump straight into a fresh workspace: redirect (302, never
  // cacheable) to the lowest free session id. The PTY spawns when the client
  // attaches to /ws?session=<id>, exactly as if the user typed the path.
  // `GET /new` is the script-facing "open me a terminal" (`xdg-open
  // http://host/new`). It used to 302 to `/<lowest free id>`, back when the path
  // WAS the tab. The path is no longer an address for a tab, so it redirects to
  // an INTENT instead and the client creates one terminal and clears the query —
  // which also means the id is allocated by whoever is about to use it, rather
  // than by a redirect that may be minutes stale by the time the page loads.
  app.get('/new', async (_req, reply) => reply.redirect('/?new=1'));

  // The tmux sessions on this host, for the new-tab chooser. Read-only, and
  // fetched when the picker opens rather than pushed: the list is owned by a
  // tmux server palmux does not manage, so any cached copy is a guess.
  app.get('/tmux-sessions', async () => await listTmuxSessions());

  // Stream a discovered font file by id (registered before the static wildcard).
  app.get('/fonts/:id', async (req, reply) => {
    const id = (req.params as { id?: string }).id ?? '';
    const entry = fonts.serve(id);
    if (!entry) return reply.code(404).send('not found');
    return reply
      .header('Cache-Control', 'public, max-age=86400')
      .type(entry.type)
      .send(createReadStream(entry.path));
  });

  // GET /download?path=<absolute path | glob> — pull files off this machine.
  // Single file streams raw; a glob / directory / multi-match arrives as one
  // ZIP. Absolute paths are BY DESIGN, not a traversal hole: the PTY already
  // grants full shell access to this user, so the cookie gate above (plus the
  // IP/origin rules) is the boundary — same trust model as the terminal.
  app.get('/download', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const pattern = typeof q['path'] === 'string' ? q['path'] : '';
    const res = await resolveDownload(pattern, cfg.maxDownloadBytes);
    if (res.kind === 'error') return reply.code(res.status).send(res.message);
    if (res.kind === 'file') {
      return reply
        .header('Content-Disposition', contentDisposition(res.name))
        .header('Content-Length', res.size)
        .type('application/octet-stream')
        .send(createReadStream(res.path));
    }
    const zip = await bundleZip(res.base, res.files);
    return reply
      .header('Content-Disposition', contentDisposition(res.zipName))
      .type('application/zip')
      .send(zip);
  });

  // Markdown viewer backend (see markdown.ts for the two trust levels).
  app.get('/md-file', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const res = await readMdFile(typeof q['path'] === 'string' ? q['path'] : '');
    if (!res.ok) return reply.code(res.status).send(res.message);
    // Defence-in-depth: a served file must never SCRIPT the app. `sandbox`
    // makes a top-level open (an <a target=_blank> to an .svg) a sandboxed,
    // script-disabled document — while <img src> embedding is unaffected;
    // nosniff stops content-type confusion. This is the boundary the DOMPurify
    // pipeline can't cover (files opened as their own document, not inlined).
    return reply
      .header('X-Content-Type-Options', 'nosniff')
      .header(
        'Content-Security-Policy',
        "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      )
      .type(res.type)
      .send(res.data);
  });

  app.get('/md-list', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const dir = typeof q['dir'] === 'string' ? q['dir'] : undefined;
    const res = await listMdDir(dir, cfg.markdownRoots);
    if (!res.ok) return reply.code(res.status).send({ error: res.message });
    return reply.send(res.listing);
  });

  // GET /files/list?dir=<absolute path> — the file browser's directory listing
  // (see files.ts). NOT roots-confined like /md-list: same trust model as
  // /download, cookie gate as the boundary. Read-only, and every failure is a
  // JSON error status so a broken path can never render as a blank pane.
  app.get('/files/list', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const res = await listDir(typeof q['dir'] === 'string' ? q['dir'] : undefined);
    if (!res.ok) return reply.code(res.status).send({ error: res.message });
    return reply.send(res.listing);
  });

  // POST /files/delete { paths: string[] } — remove files/directories from the
  // Explorer's context menu. A POST rather than a DELETE because the payload is
  // a list: a bulk selection cannot ride in a query string without a length
  // limit that would silently truncate what gets removed.
  //
  // Every path reports independently (see deletePaths) and the response is
  // always 200 with per-path outcomes — a partial failure is normal here and the
  // caller has to be able to say which ones survived. Only a malformed REQUEST
  // is a 400.
  app.post('/files/delete', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const res = await deletePaths(body['paths']);
    if (!Array.isArray(res)) return reply.code(400).send(res);
    const failed = res.filter((r) => !r.ok).length;
    if (failed) console.warn(`files: delete failed for ${failed}/${res.length} path(s)`);
    return reply.send({ results: res });
  });

  // GET /file?path=<absolute> — read one file for the browser's Read/Edit pane.
  // The matching PUT is registered inside the raw-body scope further down, which
  // is the only place a raw text body is parsed. See file-rw.ts for the refusals.
  app.get('/file', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const res = await readTextFile(typeof q['path'] === 'string' ? q['path'] : '', maxUploadBytes);
    if (!res.ok) return reply.code(res.status).send({ error: res.message });
    return reply.send({ text: res.text, path: res.path, size: res.size });
  });

  // GET/PUT /config-file — the raw config.json behind the settings editor. The
  // PUT re-runs the boot parser and refuses anything it would ignore, so a
  // saved setting is a setting that will actually load (see config-file.ts).
  await registerConfigFileRoutes(app);

  // GET /ports — TCP ports this user is listening on, for the loopback pane
  // picker (see ports.ts).
  registerPortsRoutes(app);

  // GET /pane-file?tab=<id> — an editor tab's note content. The id must be a
  // LIVE editor tab, so the filesystem path is always built from a registry-
  // validated id (no traversal surface). A missing file is an empty note.
  app.get('/pane-file', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const tab = typeof q['tab'] === 'string' ? q['tab'] : '';
    // Two independent gates before the path is built: the id must be canonical
    // (no traversal chars can survive isTabId), AND it must be a live editor tab.
    if (!isTabId(tab) || registry.kindOf(tab) !== 'editor') {
      return reply.code(404).send({ error: 'unknown editor tab' });
    }
    let content = '';
    try {
      content = await readFile(noteFile(tab), 'utf8');
    } catch {
      /* not written yet */
    }
    return reply.type('text/plain; charset=utf-8').send(content);
  });

  // POST /upload?session=<id>&filename=<name> — save a pasted/dropped/picked
  // file to a temp path and return it, so the client can inject the path into
  // the PTY as typed text. Auth-gated by the onRequest hook like every other
  // route. Any content type / any file is accepted up to cfg.maxUploadBytes.
  // Registered in an encapsulated plugin so the catch-all raw-body parser
  // (browsers POST blobs) cannot leak to other routes. PUT /pane-file shares
  // the plugin because it needs the same raw-body parsing + size cap.
  // The ENFORCED cap. `maxUploadBytes: 0` in config.json means the user has
  // taken the limit off deliberately; every check below still runs, it just
  // never trips. The client is told the raw 0 so it stops pre-rejecting too.
  const maxUploadBytes = cfg.maxUploadBytes || Number.MAX_SAFE_INTEGER;
  await app.register(async (scope) => {
    // `'*'` is a FALLBACK, not a catch-all: Fastify ships parsers for
    // application/json and text/plain, and a more specific parser always wins.
    // A browser labels an uploaded .json as application/json and a .txt as
    // text/plain, so those two were parsed into an object/string, the route saw
    // no Buffer, and every such file came back "empty body" — while the exact
    // same bytes sent as application/octet-stream saved fine. Dropping the
    // built-ins inside this scope is what makes "any file" true.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (req, payload, done) => {
      // Declared-length fast-reject. Fastify's bodyLimit precheck only runs for
      // parseAs parsers, so a raw-stream parser must do it itself.
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxUploadBytes) {
        done(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        payload.destroy();
        return;
      }
      // Stream with a hard cap so a lying / chunked Content-Length cannot blow RSS.
      const chunks: Buffer[] = [];
      let size = 0;
      let failed = false;
      payload.on('data', (chunk: Buffer) => {
        if (failed) return;
        size += chunk.length;
        if (size > maxUploadBytes) {
          failed = true;
          done(Object.assign(new Error('payload too large'), { statusCode: 413 }));
          payload.destroy();
          return;
        }
        chunks.push(chunk);
      });
      payload.on('end', () => {
        if (!failed) done(null, Buffer.concat(chunks));
      });
      payload.on('error', (err) => {
        if (!failed) {
          failed = true;
          done(err);
        }
      });
    });

    scope.post('/upload', { bodyLimit: maxUploadBytes }, async (req, reply) => {
      // Repeated query keys parse as arrays — coerce to plain strings so a
      // hostile `?filename=a&filename=b` cannot throw in saveUpload.
      const q = req.query as Record<string, unknown>;
      const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
      if (!registry.has(asString(q['session']))) {
        return reply.code(404).send({ error: 'unknown session' });
      }
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: 'empty body' });
      }
      const path = await saveUpload(body, asString(q['filename']));
      return reply.send({ path });
    });

    // POST /dictate?mime=<audio type> — transcribe a recorded snippet and
    // return the one line of text to inject. Shares the raw-body parser and
    // size cap above; the recording never touches disk.
    scope.post('/dictate', { bodyLimit: maxUploadBytes }, async (req, reply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: 'empty body' });
      }
      const q = req.query as Record<string, unknown>;
      const mime = typeof q['mime'] === 'string' ? q['mime'] : '';
      // The clip lands on disk BEFORE the model is called. Transcription is a
      // paid network round-trip that fails for reasons the speaker can't act on
      // — until this, such a failure threw the recording away with it.
      let id: string | null = null;
      try {
        id = saveAudio(body, mime);
      } catch {
        /* an unwritable history must not break dictation itself */
      }
      try {
        const text = await dictate(body, mime, cfg.dictation);
        // History BEFORE the client's fragile injection step — this is also the
        // recovery path when the paste lands nowhere. Never fails the request.
        if (text) {
          try {
            saveTranscript(text, new Date(), id ?? undefined);
          } catch {
            /* as above */
          }
        }
        return reply.send({ text });
      } catch (err) {
        if (err instanceof DictationError) {
          // `recoverable` tells the client the words still exist: the history
          // holds the clip and can re-run the transcription on demand.
          return reply.code(err.status).send({ error: err.message, recoverable: !!id });
        }
        throw err;
      }
    });

    // POST /transcribe?name=<id> — re-run dictation on a clip already in the
    // history. This is the retry for an entry whose transcription failed.
    scope.post('/transcribe', async (req, reply) => {
      const q = req.query as Record<string, unknown>;
      const id = typeof q['name'] === 'string' ? q['name'] : '';
      const clip = readAudioFile(id);
      if (!clip) return reply.code(404).send({ error: 'no audio for that entry' });
      try {
        const text = await dictate(clip.audio, clip.mime, cfg.dictation);
        if (text) {
          try {
            saveTranscript(text, new Date(), id);
          } catch {
            /* as above */
          }
        }
        return reply.send({ text });
      } catch (err) {
        if (err instanceof DictationError) {
          return reply.code(err.status).send({ error: err.message });
        }
        throw err;
      }
    });

    // PUT /pane-file?tab=<id> — persist an editor tab's note (atomic write,
    // capped at maxUploadBytes by the shared parser → 413 on overflow).
    scope.put('/pane-file', { bodyLimit: maxUploadBytes }, async (req, reply) => {
      const q = req.query as Record<string, unknown>;
      const tab = typeof q['tab'] === 'string' ? q['tab'] : '';
      if (!isTabId(tab) || registry.kindOf(tab) !== 'editor') {
        return reply.code(404).send({ error: 'unknown editor tab' });
      }
      // The '*' parser yields a Buffer, but fastify's BUILT-IN parsers win for
      // text/plain (string) and application/json (object) — accept all three.
      const body = req.body;
      const bytes = Buffer.isBuffer(body)
        ? body
        : typeof body === 'string'
          ? Buffer.from(body, 'utf8')
          : Buffer.alloc(0);
      await mkdir(notesDir, { recursive: true });
      const target = noteFile(tab);
      const tmp = `${target}.${process.pid}.tmp`;
      await writeFile(tmp, bytes, { mode: 0o600 });
      await rename(tmp, target);
      return reply.send({ ok: true });
    });

    // PUT /file?path=<absolute> — save one file from the browser's Edit mode.
    // It lives in THIS scope because the raw-body parser is only installed here;
    // registered outside it, fastify's built-in JSON parser would eat a .json
    // file's bytes and hand the route an object.
    scope.put('/file', { bodyLimit: maxUploadBytes }, async (req, reply) => {
      const q = req.query as Record<string, unknown>;
      const body = req.body;
      const text = Buffer.isBuffer(body)
        ? body.toString('utf8')
        : typeof body === 'string'
          ? body
          : JSON.stringify(body ?? '');
      const res = await writeTextFile(
        typeof q['path'] === 'string' ? q['path'] : '',
        text,
        maxUploadBytes,
      );
      if (!res.ok) return reply.code(res.status).send({ error: res.message });
      return reply.send({ ok: true, path: res.path, size: res.size });
    });
  });

  // Same-origin artifact hosting: anything in <configDir>/artifacts/ is served
  // at /artifacts/<name>, cookie-gated like the app. fastify-static handles
  // path-traversal rejection; same-origin means these pages are always
  // embeddable in web tabs (unlike third-party sites that refuse framing).
  if (existsSync(artifactsDir)) {
    await app.register(fastifyStatic, {
      root: artifactsDir,
      prefix: '/artifacts/',
      decorateReply: false,
      index: false,
    });
  }

  const clientDir = resolveClientDir();
  if (existsSync(clientDir)) {
    // BEFORE the static handler, which would otherwise answer with the file
    // verbatim: an installed PWA paints its system bars from the MANIFEST, never
    // from the `<meta name="theme-color">` the client keeps in sync, so a static
    // colour here is a black status bar over a light theme. See manifest.ts.
    app.get('/manifest.webmanifest', async (_req, reply) => {
      const themed = await themedManifest(clientDir, themeIdFrom(loadSettings()));
      if (!themed) return reply.callNotFound(); // unreadable: let static try
      return reply.type('application/manifest+json').send(themed);
    });

    // Hashed build output: pre-compressed siblings (see vite-precompress.ts) and
    // a year of immutable caching, because the hash in the name IS the version.
    // Measured before this existed: `GET /assets/index-*.js` answered 962 KB
    // with NO content-encoding, and `max-age=0` on a file that can never change.
    //
    // `Vary: Accept-Encoding` is not optional here and this version of
    // @fastify/static does not add it. It sets `content-encoding` per request
    // but declares no variance, so a shared cache holding an `immutable`
    // response would hand brotli to a client that only accepts gzip — and with
    // `immutable` it would never revalidate its way out of that.
    await app.register(fastifyStatic, {
      root: join(clientDir, 'assets'),
      prefix: '/assets/',
      decorateReply: false,
      index: false,
      preCompressed: true,
      immutable: true,
      maxAge: 31536000_000,
      setHeaders: (res) => res.setHeader('vary', 'Accept-Encoding'),
    });

    // The Material icon set: compressible and effectively frozen, but NOT
    // content-hashed, so it gets compression and a day of caching rather than
    // `immutable` — re-running the vendor script must be able to take effect.
    // Checked once, at boot — like the artifacts mount. A server started before
    // the icons were vendored simply falls through to the root mount and serves
    // them uncompressed, which is a slower file browser and nothing worse.
    const iconDir = join(clientDir, 'file-icons');
    if (existsSync(iconDir)) {
      await app.register(fastifyStatic, {
        root: iconDir,
        prefix: '/file-icons/',
        decorateReply: false,
        index: false,
        preCompressed: true,
        maxAge: 86400_000,
        setHeaders: (res) => res.setHeader('vary', 'Accept-Encoding'),
      });
    }

    await app.register(fastifyStatic, { root: clientDir, prefix: '/' });
    // SPA fallback: serve index.html for unknown (authed) routes — except the
    // file namespaces, where a miss must be a real 404, not the app shell.
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0] ?? '/';
      if (path.startsWith('/artifacts/') || path === '/pane-file') {
        return reply.code(404).send('not found');
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply
        .type('text/html')
        .send('<h1>palmux</h1><p>Client not built. Run <code>yarn build</code>.</p>'),
    );
  }

  attachWebSocket(app, authCfg, fonts.faces, cfg, registry, killTab);
  return app;
}

// ── WebSocket ↔ PTY bridge ──────────────────────────────────────────────────────

function attachWebSocket(
  app: FastifyInstance,
  authCfg: AuthConfig,
  fonts: FontInfo[],
  cfg: AppConfig,
  registry: SessionRegistry,
  killTab: (id: string) => void,
): void {
  const wss = new WebSocketServer({ noServer: true });
  const connections = new Set<WebSocket>();

  // Persisted config changes in one browser propagate to every open socket.
  const broadcast = (msg: string, except?: WebSocket) => {
    for (const ws of connections) {
      if (ws !== except && ws.readyState === ws.OPEN) ws.send(msg);
    }
  };

  // Let the self-update runner (owned by index.ts) tell every client that the
  // imminent disconnect is an intentional update rather than a dropped link.
  // An upgraded socket is a connection the HTTP server counts, and Fastify's
  // close() waits for every connection to end. A palmux with any browser open
  // therefore never finished closing: measured in the journal as
  // `State 'stop-sigterm' timed out. Killing.` 90s after SIGTERM, followed by a
  // SIGKILL of the whole cgroup — which is every shell the user had running.
  app.decorate('closeSockets', () => {
    for (const ws of connections) {
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    }
    connections.clear();
    wss.close();
  });

  app.decorate('broadcastUpdating', (stage: UpdatingMessage['stage'], version?: string) => {
    broadcast(
      encodeServerMessage({
        type: 'updating',
        stage,
        ...(version !== undefined ? { version } : {}),
      }),
    );
  });

  const sessionsMessage = () =>
    encodeServerMessage({
      type: 'sessions',
      ids: registry.ids(),
      titles: registry.titles(),
      tabs: registry.tabs(),
      groups: registry.groups(),
    });
  const broadcastSessions = () => broadcast(sessionsMessage());

  // Hot-reload user theme files → re-register + rebroadcast to every client.
  watchThemes(() => {
    registerDynamicThemes(discoverThemes());
    broadcast(encodeServerMessage({ type: 'themes', themes: dynamicThemes() }));
  });
  registry.onListChanged(broadcastSessions);
  // Titles change on every prompt redraw — coalesce retitle broadcasts.
  let titleTimer: ReturnType<typeof setTimeout> | undefined;
  registry.onTitleChanged(() => {
    clearTimeout(titleTimer);
    titleTimer = setTimeout(broadcastSessions, 300);
  });

  // Live-reload the extra-keys toolbar when ~/.config/palmux/extra-keys.json
  // is edited on disk — no page refresh needed.
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    watch(configDir(), (_event, filename) => {
      if (filename?.toString() !== 'extra-keys.json') return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        broadcast(encodeServerMessage({ type: 'extraKeys', extraKeys: loadExtraKeys() }));
      }, 150);
    });
  } catch {
    /* fs.watch unsupported here — a page refresh reloads the config instead */
  }

  app.server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/ws') {
      socket.destroy();
      return;
    }
    // Network rules first (cheapest rejection), then origin (cross-site WS
    // hijack guard — browser requests always carry Origin), then the cookie.
    if (!ipAllowed(req.socket.remoteAddress, cfg.allowedIps)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!wsOriginAllowed(req.headers.origin, req.headers.host, cfg.allowedOrigins)) {
      warnOriginRejected(req.headers.origin, req.headers.host);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!isRequestAuthed(req, authCfg)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const params = new URL(req.url ?? '', 'http://localhost').searchParams;
    // A control socket carries the app's tab-list/settings/control channel with
    // NO tab binding — so the client keeps that channel even when no terminal is
    // mounted (a pane-only split, or a lone non-terminal tab). It gets the full
    // handshake + broadcasts and handles control messages, but never a PTY.
    const isControl = params.get('control') === '1';
    const sid = params.get('session') ?? '0';
    const sessionId = isTabId(sid) ? sid : '0';
    // Stable per-pane identity (see PtySession.attach). Length-capped: it is
    // untrusted input that we only ever compare, never interpret.
    const clientKey = (params.get('client') ?? '').slice(0, 64);
    // `tmux=<name>` (or `tmux=` for a brand-new unnamed session) asks the FIRST
    // spawn on this id to land straight in that tmux session. Validated here and
    // quoted again in tmuxAttachCommand: it is a query parameter that ends up in
    // a line typed into a shell.
    const tmuxParam = params.get('tmux');
    const tmuxTarget =
      tmuxParam === null
        ? undefined
        : tmuxParam === ''
          ? tmuxAttachCommand(null)
          : isTmuxSessionName(tmuxParam)
            ? tmuxAttachCommand(tmuxParam)
            : undefined;
    const claimedKind = params.get('kind');
    const expectKind: TabKind | undefined =
      claimedKind && (['terminal', 'web', 'dashboard', 'editor'] as string[]).includes(claimedKind)
        ? (claimedKind as TabKind)
        : undefined;
    wss.handleUpgrade(req, socket, head, (ws) => {
      connections.add(ws);
      handleConnection(ws, sessionId, expectKind, isControl, clientKey, tmuxTarget, {
        broadcast,
        fonts,
        registry,
        sessionsMessage,
        killTab,
        maxUploadBytes: cfg.maxUploadBytes,
        webApps: cfg.webApps,
      });
      ws.on('close', () => connections.delete(ws));
    });
  });
}

interface ConnectionDeps {
  broadcast: (msg: string, except?: WebSocket) => void;
  fonts: FontInfo[];
  registry: SessionRegistry;
  sessionsMessage: () => string;
  killTab: (id: string) => void;
  maxUploadBytes: number;
  webApps: WebAppLink[];
}

function handleConnection(
  ws: WebSocket,
  sessionId: string,
  expectKind: TabKind | undefined,
  isControl: boolean,
  clientKey: string,
  /** Command to type if this attach is what spawns the shell (tmux picker). */
  spawnCommand: string | undefined,
  deps: ConnectionDeps,
): void {
  // Terminal tabs get the full PTY bridge; non-terminal tabs (and control
  // sockets) get a metadata-only attach — same handshake (so settings/fonts/
  // broadcasts flow) but no snapshot, no binary frames, and input/resize are
  // ignored. The registry is authoritative for a KNOWN id; for an unknown id we
  // honor the client's expected kind so a reconnect to a just-killed pane doesn't
  // spawn a stray terminal there — only a client that actually expects a terminal
  // (a new /N URL) gets one spawned. A control socket never binds a PTY.
  const kind = isControl
    ? 'control'
    : (deps.registry.kindOf(sessionId) ?? expectKind ?? 'terminal');
  const pty =
    kind === 'terminal'
      ? deps.registry.get(sessionId, spawnCommand ? { command: spawnCommand } : undefined)
      : null;

  // Handshake: ready (the live PTY's current size + upload cap) + config + fonts.
  ws.send(
    encodeServerMessage({
      type: 'ready',
      cols: pty?.cols ?? 80,
      rows: pty?.rows ?? 24,
      maxUploadBytes: deps.maxUploadBytes,
      webApps: deps.webApps,
      version: APP_VERSION,
    }),
  );
  ws.send(encodeServerMessage({ type: 'settings', settings: loadSettings() }));
  ws.send(encodeServerMessage({ type: 'extraKeys', extraKeys: loadExtraKeys() }));
  if (deps.fonts.length) ws.send(encodeServerMessage({ type: 'fonts', fonts: deps.fonts }));
  const themes = dynamicThemes();
  if (themes.length) ws.send(encodeServerMessage({ type: 'themes', themes }));
  ws.send(deps.sessionsMessage());

  // Identity of this connection as THE active client of the session (one per
  // terminal; a later attach evicts it). `clientKey` is the LOGICAL identity —
  // stable across this pane's reconnects — so a reconnect can be told apart from
  // a rival. Absent (older client) means "never matches", i.e. the old behaviour.
  const client = {};
  let detach: () => void = () => {};
  if (pty) {
    // Replay recent output so a refreshed/reconnected client restores its screen.
    // The 'snapshot' marker tells the client to discard any input the terminal
    // emits while processing the replay (e.g. responses to replayed queries).
    const snap = pty.snapshot();
    if (snap.length && ws.readyState === ws.OPEN) {
      ws.send(encodeServerMessage({ type: 'snapshot' }));
      ws.send(snap);
    }

    // Attach to the live stream, TAKING OVER from any earlier client; detach
    // (NOT kill) when this client goes away.
    detach = pty.attach(
      client,
      clientKey,
      // `bytes` is the chunk the replay ring already encoded — sending it as-is
      // is what removes the second `Buffer.from(data, 'utf8')` of identical
      // content from the terminal's hottest path.
      (_data, bytes) => {
        if (ws.readyState === ws.OPEN) ws.send(bytes);
      },
      (code, signal) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(encodeServerMessage({ type: 'exit', code, signal }));
          ws.close();
        }
      },
      (byTheSameClient) => {
        if (ws.readyState !== ws.OPEN) return;
        // The same pane reconnecting (network blip, tab restore) is NOT a
        // takeover: just close the spent socket. Announcing it would show
        // "opened somewhere else" for a session the client never lost.
        if (byTheSameClient) {
          ws.close();
          return;
        }
        // A genuine rival. Tell this client BEFORE closing — frames are
        // delivered in order, so it suppresses its auto-reconnect (which would
        // otherwise take the session straight back, forever) and offers a
        // manual Reconnect instead.
        ws.send(encodeServerMessage({ type: 'detached' }));
        ws.close();
      },
    );
  }

  ws.on('message', (raw: Buffer, isBinary: boolean) => {
    if (isBinary) {
      pty?.write(raw.toString('utf8'));
      return;
    }
    const msg = parseClientMessage(raw.toString('utf8'));
    if (!msg) return;
    switch (msg.type) {
      case 'ping':
        // Liveness reply — lets the client detect a zombie socket (readyState
        // OPEN but dead) after a mobile background / network switch.
        ws.send(encodeServerMessage({ type: 'pong' }));
        break;
      case 'resize':
        // Clamp untrusted client dimensions, then contribute to the min size.
        pty?.resizeClient(
          client,
          Math.min(Math.max(1, msg.cols | 0), 1000),
          Math.min(Math.max(1, msg.rows | 0), 1000),
        );
        break;
      case 'settings': {
        const settings = msg.settings as JsonObject;
        saveSettings(settings);
        // Keep <configDir>/theme.sh in sync so the shell/tmux/delta colours
        // follow the palmux theme (unification export).
        writeThemeExport(configDir(), themeIdFrom(settings));
        deps.broadcast(encodeServerMessage({ type: 'settings', settings }), ws);
        break;
      }
      case 'extraKeys': {
        const extraKeys = msg.extraKeys as JsonObject;
        saveExtraKeys(extraKeys);
        deps.broadcast(encodeServerMessage({ type: 'extraKeys', extraKeys }), ws);
        break;
      }
      case 'kill': {
        deps.killTab(msg.id);
        break;
      }
      case 'importTheme': {
        // Async: the fetch must not block the socket. On success the themes-dir
        // watcher rebroadcasts `themes` to everyone; the reply goes only to the
        // asker, which is the one that can select it and show the toast.
        void importTheme(msg.source).then((r) => {
          if (ws.readyState !== ws.OPEN) return;
          ws.send(
            encodeServerMessage(
              r.ok
                ? { type: 'themeImported', ok: true, id: r.id, detail: r.name }
                : { type: 'themeImported', ok: false, detail: r.error },
            ),
          );
        });
        break;
      }
      case 'reorderTabs': {
        // The registry validates; a real change fires listChanged → broadcast.
        deps.registry.reorder(msg.ids);
        break;
      }
      case 'groupCreate': {
        deps.registry.groupCreate(msg.ids, {
          ...(msg.name !== undefined ? { name: msg.name } : {}),
          ...(msg.color !== undefined ? { color: msg.color } : {}),
        });
        break;
      }
      case 'groupUpdate': {
        deps.registry.groupUpdate(msg.id, {
          ...(msg.name !== undefined ? { name: msg.name } : {}),
          ...(msg.color !== undefined ? { color: msg.color } : {}),
          ...(msg.addIds !== undefined ? { addIds: msg.addIds } : {}),
          ...(msg.removeIds !== undefined ? { removeIds: msg.removeIds } : {}),
          ...(msg.dissolve !== undefined ? { dissolve: msg.dissolve } : {}),
          ...(msg.order !== undefined ? { order: msg.order } : {}),
        });
        break;
      }
      case 'createTab': {
        const id = deps.registry.createTab({
          kind: msg.kind,
          ...(msg.url !== undefined ? { url: msg.url } : {}),
          ...(msg.name !== undefined ? { name: msg.name } : {}),
          ...(msg.color !== undefined ? { color: msg.color } : {}),
        });
        // Ack the assigned id to THIS client so it switches deterministically.
        if (id !== null && ws.readyState === ws.OPEN) {
          ws.send(encodeServerMessage({ type: 'tabCreated', id }));
        }
        break;
      }
      case 'updateTab': {
        deps.registry.updateTab(msg.id, {
          ...(msg.name !== undefined ? { name: msg.name } : {}),
          ...(msg.color !== undefined ? { color: msg.color } : {}),
          ...(msg.url !== undefined ? { url: msg.url } : {}),
        });
        break;
      }
    }
  });

  ws.on('close', () => detach());
  ws.on('error', () => detach());
}
