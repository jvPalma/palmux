import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { ServerMessage } from '@palmux/shared';
import { DEFAULT_APP_CONFIG, type AppConfig } from './app-config';
import { createServer, createSessionRegistry, type SessionRegistry } from './server';
import { memoryTabsStore } from './tabs-store';

let app: FastifyInstance;
let registry: SessionRegistry;
let port: number;
let prevConfigDir: string | undefined;

beforeAll(async () => {
  prevConfigDir = process.env['PALMUX_CONFIG_DIR'];
  process.env['PALMUX_CONFIG_DIR'] = mkdtempSync(join(tmpdir(), 'palmux-wstabs-'));
  const cfg: AppConfig = { ...DEFAULT_APP_CONFIG, fontDirs: [], auth: false };
  registry = createSessionRegistry(cfg, memoryTabsStore());
  app = await createServer(cfg, 'a'.repeat(64), registry);
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as { port: number }).port;
});

afterAll(async () => {
  for (const id of registry.ids()) registry.kill(id);
  await app.close();
  if (prevConfigDir === undefined) delete process.env['PALMUX_CONFIG_DIR'];
  else process.env['PALMUX_CONFIG_DIR'] = prevConfigDir;
});

/** Collect frames from a socket for `ms`, then close it. */
interface Collected {
  messages: ServerMessage[];
  binaryCount: number;
}

/**
 * Attach, gather for `ms`, close.
 *
 * `until` turns the window into a DEADLINE rather than a duration: the promise
 * resolves the moment the predicate holds. A test that waits for a freshly
 * spawned shell to print its prompt is waiting on zsh, not on palmux, and a
 * fixed budget makes it a coin toss on a loaded machine — this one failed two
 * runs in three with a browser and two dev servers alongside it. Tests that
 * assert something did NOT happen still pass no predicate and wait the full
 * window, because absence cannot be observed early.
 */
function collect(
  query: string,
  ms: number,
  onOpen?: (ws: WebSocket) => void,
  until?: (state: Collected) => boolean,
): Promise<Collected> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${query}`);
    const state: Collected = { messages: [], binaryCount: 0 };
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      ws.close();
      resolve(state);
    };
    ws.on('message', (data, isBinary) => {
      if (isBinary) state.binaryCount++;
      else state.messages.push(JSON.parse(data.toString()) as ServerMessage);
      if (until?.(state)) finish();
    });
    // The window starts at OPEN, not at construction, so connection time is not
    // charged against it — the absence assertions depend on the full duration.
    ws.on('open', () => {
      onOpen?.(ws);
      timer = setTimeout(finish, ms);
    });
  });
}

describe('WS tab bridge', () => {
  it('acks createTab with the assigned id (tabCreated)', async () => {
    const { messages } = await collect('session=0', 400, (ws) => {
      ws.send(JSON.stringify({ type: 'createTab', kind: 'web', url: 'https://sb.local' }));
    });
    const ack = messages.find((m) => m.type === 'tabCreated');
    expect(ack).toEqual({ type: 'tabCreated', id: '1' }); // 0 is this terminal
    expect(registry.kindOf('1')).toBe('web');
  });

  it('does NOT ack a rejected createTab (web without a valid url)', async () => {
    const { messages } = await collect('session=0', 300, (ws) => {
      ws.send(JSON.stringify({ type: 'createTab', kind: 'web', url: 'javascript:1' }));
    });
    expect(messages.some((m) => m.type === 'tabCreated')).toBe(false);
  });

  it('attaching with kind=web to an UNKNOWN id spawns no terminal (metadata-only)', async () => {
    const before = registry.ids();
    const { messages, binaryCount } = await collect('session=77&kind=web', 300);
    // No PTY spawned → no snapshot, no binary, and id 77 never becomes a tab.
    expect(binaryCount).toBe(0);
    expect(messages.some((m) => m.type === 'snapshot')).toBe(false);
    expect(registry.has('77')).toBe(false);
    expect(registry.ids()).toEqual(before);
  });

  // The attach kind is the client's claim about a tab that may already be gone. A
  // kind the server does not read as a claim falls through to "terminal", and an
  // attach by id to a closed markdown or review tab then spawned a shell on it.
  it.each(['editor', 'markdown', 'review', 'dashboard'])(
    'attaching with kind=%s to an UNKNOWN id spawns no terminal',
    async (kind) => {
      const before = registry.ids();
      const { messages, binaryCount } = await collect(`session=78&kind=${kind}`, 300);
      expect(binaryCount).toBe(0);
      expect(messages.some((m) => m.type === 'snapshot')).toBe(false);
      expect(registry.has('78')).toBe(false);
      expect(registry.ids()).toEqual(before);
    },
  );

  it('attaching with kind=review to a LIVE review tab binds no terminal either', async () => {
    const id = registry.createTab({ kind: 'review', url: 'changes:/tmp/palmux-attach-review' });
    expect(id).not.toBeNull();
    const { messages, binaryCount } = await collect(`session=${id}&kind=review`, 300);
    expect(binaryCount).toBe(0);
    expect(messages.some((m) => m.type === 'snapshot')).toBe(false);
    expect(registry.kindOf(id as string)).toBe('review');
    registry.kill(id as string);
  });

  it('attaching with no kind to an unknown id spawns a terminal (URL model preserved)', async () => {
    const { binaryCount, messages } = await collect(
      'session=88',
      4000,
      undefined,
      // Wait for the shell to actually say something rather than for a fixed
      // 400ms — that budget is zsh's startup time, not ours.
      (s) => s.binaryCount > 0 && s.messages.some((m) => m.type === 'ready'),
    );
    // Fresh shell: ready + a snapshot/replay of its initial output.
    expect(messages.some((m) => m.type === 'ready')).toBe(true);
    expect(registry.kindOf('88')).toBe('terminal');
    expect(binaryCount).toBeGreaterThan(0);
    registry.kill('88');
  });

  it('a control socket gets the handshake + broadcasts but no PTY', async () => {
    const before = registry.ids();
    const { messages, binaryCount } = await collect('control=1', 400, (ws) => {
      // Control sends still work (createTab), proving the app channel is live.
      setTimeout(() => ws.send(JSON.stringify({ type: 'createTab', kind: 'dashboard' })), 80);
    });
    expect(messages.some((m) => m.type === 'ready')).toBe(true);
    expect(messages.some((m) => m.type === 'sessions')).toBe(true);
    expect(messages.some((m) => m.type === 'settings')).toBe(true);
    // No tab bound → no PTY, no snapshot, no binary.
    expect(binaryCount).toBe(0);
    expect(messages.some((m) => m.type === 'snapshot')).toBe(false);
    // The control createTab landed and was acked.
    expect(messages.some((m) => m.type === 'tabCreated')).toBe(true);
    // The `control=1` connection itself never became a tab id.
    expect(
      registry.ids().filter((id) => !before.includes(id) && registry.kindOf(id) === 'dashboard'),
    ).toHaveLength(1);
  });
});

describe('WS reorderTabs', () => {
  it('a reorderTabs frame changes the next sessions broadcast order', async () => {
    registry.createTab({ kind: 'editor' });
    registry.createTab({ kind: 'editor' });
    registry.createTab({ kind: 'editor' });
    const before = registry.ids();
    const want = [...before].reverse();
    const { messages } = await collect('control=1', 400, (ws) => {
      ws.send(JSON.stringify({ type: 'reorderTabs', ids: want }));
    });
    const sessions = messages.filter((m) => m.type === 'sessions');
    const last = sessions[sessions.length - 1];
    expect(last && last.type === 'sessions' ? last.tabs.map((t) => t.id) : []).toEqual(want);
    expect(registry.ids()).toEqual(want);
  });
});

describe('WS group ops', () => {
  it('groupCreate + a join reflect in the next sessions broadcast', async () => {
    // Leftover-safe: derive the 3 fresh ids we just created (the shared registry
    // persists tabs across tests in this file).
    const before = new Set(registry.ids());
    registry.createTab({ kind: 'editor' });
    registry.createTab({ kind: 'editor' });
    registry.createTab({ kind: 'editor' });
    const [a, mid, c] = registry.ids().filter((id) => !before.has(id));
    const { messages } = await collect('control=1', 500, (ws) => {
      ws.send(JSON.stringify({ type: 'groupCreate', ids: [a!, c!], name: 'g', color: 'blue' }));
    });
    const last = messages.filter((m) => m.type === 'sessions').at(-1);
    if (!last || last.type !== 'sessions') throw new Error('no sessions broadcast');
    // Our group exists (color blue) and holds exactly a + c.
    const gid = last.tabs.find((t) => t.id === a)!.groupId;
    expect(gid).toBeTruthy();
    expect(last.groups.find((g) => g.id === gid)).toMatchObject({ color: 'blue', name: 'g' });
    const members = last.tabs.filter((t) => t.groupId === gid).map((t) => t.id);
    expect(members).toEqual([a, c]);
    // Contiguous: a and c are adjacent, mid is not between them.
    const order = last.tabs.map((t) => t.id);
    expect(order.indexOf(c!)).toBe(order.indexOf(a!) + 1);
    expect(order.indexOf(mid!)).not.toBe(order.indexOf(a!) + 1);
  });
});

describe('self-update client notice', () => {
  it('broadcasts an `updating` frame to connected clients', async () => {
    const { messages } = await collect('control=1', 400, () => {
      // The self-update runner calls exactly this from index.ts's `notify`.
      setTimeout(() => app.broadcastUpdating('staging', '9.9.0'), 50);
    });
    const updating = messages.find((m) => m.type === 'updating');
    expect(updating).toEqual({ type: 'updating', stage: 'staging', version: '9.9.0' });
  });

  it('omits `version` when it is unknown rather than sending undefined', async () => {
    const { messages } = await collect('control=1', 400, () => {
      setTimeout(() => app.broadcastUpdating('failed'), 50);
    });
    const updating = messages.find((m) => m.type === 'updating');
    expect(updating).toEqual({ type: 'updating', stage: 'failed' });
  });
});

// ── Detached windows ────────────────────────────────────────────────────────────
//
// Ownership lives while the window's control socket does. The grace is shortened
// from the shipped 15 s / 3 s, but not to the bottom of what a timer can resolve:
// the assertions that tell the two graces apart are UPPER bounds on a wall clock,
// and a loaded machine stalls a test for tens of milliseconds.
const GRACE = 200;
const CLOSING = 20;

interface Probe {
  ws: WebSocket;
  messages: ServerMessage[];
  /** The first frame at or after `from` that `pred` accepts, now or later. */
  until(pred: (m: ServerMessage) => boolean, from?: number, ms?: number): Promise<ServerMessage>;
  send(msg: Record<string, unknown>): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A `sessions` frame that lists `id` held by `window` (undefined = the main window). */
const listsOwner =
  (id: string, window: string | undefined) =>
  (m: ServerMessage): boolean =>
    m.type === 'sessions' &&
    m.tabs.some((t) => t.id === id) &&
    m.tabs.find((t) => t.id === id)?.window === window;

describe('WS detached windows', () => {
  let wapp: FastifyInstance;
  let wregistry: SessionRegistry;
  let wport: number;
  const probes: Probe[] = [];
  let info: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    const cfg: AppConfig = { ...DEFAULT_APP_CONFIG, fontDirs: [], auth: false };
    wregistry = createSessionRegistry(cfg, memoryTabsStore());
    wapp = await createServer(cfg, 'a'.repeat(64), wregistry, {
      windowGraceMs: GRACE,
      windowCloseGraceMs: CLOSING,
    });
    await wapp.listen({ host: '127.0.0.1', port: 0 });
    wport = (wapp.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    for (const id of wregistry.ids()) wregistry.kill(id);
    await wapp.close();
  });

  beforeEach(() => {
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(async () => {
    // Tabs first: a socket that closes while its window still holds one arms a timer.
    for (const id of wregistry.ids()) wregistry.kill(id);
    for (const p of probes.splice(0)) p.ws.terminate();
    info.mockRestore();
    await sleep(0);
  });

  /** Connect and wait for the handshake's `ready`, which the server sends after it has registered the socket. */
  function connect(query: string): Promise<Probe> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${wport}/ws?${query}`);
      const messages: ServerMessage[] = [];
      const waiters = new Set<() => void>();
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        messages.push(JSON.parse(data.toString()) as ServerMessage);
        for (const w of waiters) w();
      });
      const probe: Probe = {
        ws,
        messages,
        until: (pred, from = 0, ms = 2000) =>
          new Promise((res, rej) => {
            const look = () => {
              const hit = messages.slice(from).find(pred);
              if (!hit) return false;
              waiters.delete(look);
              clearTimeout(timer);
              res(hit);
              return true;
            };
            const timer = setTimeout(() => {
              waiters.delete(look);
              rej(new Error('no matching frame'));
            }, ms);
            if (!look()) waiters.add(look);
          }),
        send: (msg) => ws.send(JSON.stringify(msg)),
      };
      probes.push(probe);
      ws.on('error', reject);
      ws.on('open', () => {
        void probe.until((m) => m.type === 'sessions').then(() => resolve(probe), reject);
      });
    });
  }

  const ownerOf = (id: string) => wregistry.tabs().find((t) => t.id === id)?.window;
  const newTab = () => wregistry.createTab({ kind: 'editor' }) as string;

  it('moveToWindow broadcasts the field to every socket', async () => {
    const id = newTab();
    const W = 'wtestmove001';
    const holder = await connect(`control=1&window=${W}`);
    const other = await connect('control=1');
    const mark = other.messages.length;
    other.send({ type: 'moveToWindow', ids: [id], window: W });
    const frame = await other.until(listsOwner(id, W), mark);
    expect(frame.type === 'sessions' && frame.tabs.find((t) => t.id === id)).toMatchObject({
      window: W,
    });
    await holder.until(listsOwner(id, W), 0);
    // And back to the main window with null.
    const back = other.messages.length;
    other.send({ type: 'moveToWindow', ids: [id], window: null });
    await other.until(listsOwner(id, undefined), back);
    expect(ownerOf(id)).toBeUndefined();
  });

  it('moveToWindow ignores unknown ids and a no-op move does not broadcast', async () => {
    const id = newTab();
    const W = 'wtestmove002';
    const holder = await connect(`control=1&window=${W}`);
    holder.send({ type: 'moveToWindow', ids: [id, '99'], window: W });
    await holder.until(listsOwner(id, W));
    expect(wregistry.has('99')).toBe(false);
    const mark = holder.messages.length;
    holder.send({ type: 'moveToWindow', ids: [id], window: W }); // already there
    await sleep(60);
    expect(holder.messages.slice(mark).filter((m) => m.type === 'sessions')).toEqual([]);
  });

  it('closing the window control socket releases its tabs after the grace', async () => {
    const id = newTab();
    const W = 'wtestgrace01';
    const holder = await connect(`control=1&window=${W}`);
    const watcher = await connect('control=1');
    holder.send({ type: 'moveToWindow', ids: [id], window: W });
    await watcher.until(listsOwner(id, W));
    const mark = watcher.messages.length;
    const t0 = performance.now();
    holder.ws.close();
    await watcher.until(listsOwner(id, undefined), mark);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(GRACE - 10);
    expect(wregistry.tabsOfWindow(W)).toEqual([]);
    expect(info).toHaveBeenCalledWith(`palmux: window ${W} released 1 tabs (grace)`);
  });

  it('windowClosing then close releases after the short grace', async () => {
    const id = newTab();
    const W = 'wtestclose01';
    const holder = await connect(`control=1&window=${W}`);
    const watcher = await connect('control=1');
    holder.send({ type: 'moveToWindow', ids: [id], window: W });
    await watcher.until(listsOwner(id, W));
    holder.send({ type: 'windowClosing' });
    const mark = watcher.messages.length;
    const t0 = performance.now();
    holder.ws.close();
    await watcher.until(listsOwner(id, undefined), mark);
    expect(performance.now() - t0).toBeLessThan(GRACE - 50);
    expect(info).toHaveBeenCalledWith(`palmux: window ${W} released 1 tabs (closing)`);
  });

  it('a reconnect inside the grace keeps the tabs', async () => {
    const id = newTab();
    const W = 'wtestreconn1';
    const first = await connect(`control=1&window=${W}`);
    const watcher = await connect('control=1');
    first.send({ type: 'moveToWindow', ids: [id], window: W });
    await watcher.until(listsOwner(id, W));
    const mark = watcher.messages.length;
    first.ws.close();
    await sleep(GRACE / 4);
    await connect(`control=1&window=${W}`); // a reload coming back
    await sleep(GRACE + 100); // past where the first close's timer would have fired
    expect(ownerOf(id)).toBe(W);
    expect(watcher.messages.slice(mark).some(listsOwner(id, undefined))).toBe(false);
    expect(info).not.toHaveBeenCalled();
  });

  it('a second socket keeps the window alive when the first closes', async () => {
    const id = newTab();
    const W = 'wtesttwosock';
    const first = await connect(`control=1&window=${W}`);
    await connect(`control=1&window=${W}`);
    first.send({ type: 'moveToWindow', ids: [id], window: W });
    await first.until(listsOwner(id, W));
    first.ws.close();
    await sleep(GRACE + 100);
    expect(ownerOf(id)).toBe(W);
  });

  it('a move to a window id with no socket releases after the grace', async () => {
    const id = newTab();
    const W = 'wtestnobody1';
    const mover = await connect('control=1');
    const t0 = performance.now();
    mover.send({ type: 'moveToWindow', ids: [id], window: W });
    await mover.until(listsOwner(id, W));
    const mark = mover.messages.length;
    await mover.until(listsOwner(id, undefined), mark);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(GRACE - 10);
    expect(ownerOf(id)).toBeUndefined();
  });

  it('repeating a move that changes nothing does not restart the grace', async () => {
    const id = newTab();
    const W = 'wtestrepeat1';
    const mover = await connect('control=1');
    const t0 = performance.now();
    mover.send({ type: 'moveToWindow', ids: [id], window: W });
    await mover.until(listsOwner(id, W));
    const held = mover.messages.length;
    await sleep(GRACE / 2);
    mover.send({ type: 'moveToWindow', ids: [id], window: W }); // already there
    await mover.until(listsOwner(id, undefined), held);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(GRACE - 10);
    // A timer restarted by the repeat would fire a full grace after it.
    expect(elapsed).toBeLessThan(GRACE + GRACE / 2 - 10);
  });

  it('a move to a window that is connected arms nothing', async () => {
    const id = newTab();
    const W = 'wtestlive001';
    await connect(`control=1&window=${W}`);
    const mover = await connect('control=1');
    mover.send({ type: 'moveToWindow', ids: [id], window: W });
    await mover.until(listsOwner(id, W));
    await sleep(GRACE + 100);
    expect(ownerOf(id)).toBe(W);
  });

  it('a move back to main arms nothing', async () => {
    const id = newTab();
    const mover = await connect('control=1');
    mover.send({ type: 'moveToWindow', ids: [id], window: null });
    await sleep(GRACE + 100);
    expect(info).not.toHaveBeenCalled();
  });

  it('a timer that finds its window already empty releases and logs nothing', async () => {
    const id = newTab();
    const W = 'wtestempty01';
    const mover = await connect('control=1');
    mover.send({ type: 'moveToWindow', ids: [id], window: W });
    await mover.until(listsOwner(id, W));
    const back = mover.messages.length;
    mover.send({ type: 'moveToWindow', ids: [id], window: null }); // gone before the timer fires
    await mover.until(listsOwner(id, undefined), back);
    const mark = mover.messages.length;
    await sleep(GRACE + 100);
    expect(mover.messages.slice(mark).filter((m) => m.type === 'sessions')).toEqual([]);
    expect(info).not.toHaveBeenCalled();
  });

  it('ignores an invalid window param: no lease, no claim', async () => {
    const id = newTab();
    const W = 'wtestinval01';
    wregistry.setWindow([id], W); // held by W, with no socket and no timer
    const bad = await connect('control=1&window=NOT-A-WINDOW!');
    bad.ws.close();
    await sleep(GRACE + 100);
    expect(ownerOf(id)).toBe(W); // an invalid id leased nothing, so it released nothing

    // A data attach with a bad window claims nothing either.
    const data = await connect('session=41&window=main');
    expect(wregistry.kindOf('41')).toBe('terminal');
    expect(ownerOf('41')).toBeUndefined();
    data.ws.close();
  });

  // Reconnecting restores the full grace only if the socket did something after
  // `windowClosing`; the heartbeat is not that.
  it.each([
    {
      name: 'a message after windowClosing restores the full grace',
      follow: { type: 'reorderTabs', ids: [] },
      short: false,
    },
    { name: 'a ping after windowClosing does not', follow: { type: 'ping' }, short: true },
  ])('$name', async ({ follow, short }) => {
    const id = newTab();
    const W = 'wtestcancel1';
    const holder = await connect(`control=1&window=${W}`);
    const watcher = await connect('control=1');
    holder.send({ type: 'moveToWindow', ids: [id], window: W });
    await watcher.until(listsOwner(id, W));
    holder.send({ type: 'windowClosing' });
    const answered = holder.messages.length;
    holder.send(follow);
    if (follow.type === 'ping') await holder.until((m) => m.type === 'pong', answered);
    else await sleep(40); // the server has handled it before the close below
    const mark = watcher.messages.length;
    const t0 = performance.now();
    holder.ws.close();
    await watcher.until(listsOwner(id, undefined), mark);
    const elapsed = performance.now() - t0;
    if (short) expect(elapsed).toBeLessThan(GRACE - 50);
    else expect(elapsed).toBeGreaterThanOrEqual(GRACE - 10);
  });

  it('a fresh control socket is not marked closing by an earlier one', async () => {
    const id = newTab();
    const W = 'wtestfresh01';
    const old = await connect(`control=1&window=${W}`);
    old.send({ type: 'windowClosing' });
    old.send({ type: 'moveToWindow', ids: [id], window: W }); // un-marks it again
    await old.until(listsOwner(id, W));
    const next = await connect(`control=1&window=${W}`);
    const watcher = await connect('control=1');
    old.ws.close();
    await sleep(GRACE + 100);
    expect(ownerOf(id)).toBe(W); // `next` is live
    const mark = watcher.messages.length;
    next.ws.close();
    const t0 = performance.now();
    await watcher.until(listsOwner(id, undefined), mark);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(GRACE - 10);
  });

  it('announces detachedWindows in ready', async () => {
    const probe = await connect('control=1');
    expect(probe.messages.find((m) => m.type === 'ready')).toMatchObject({
      type: 'ready',
      detachedWindows: true,
    });
  });

  it('a data attach with window on a NEW id is listed with window in the first broadcast that lists it', async () => {
    const W = 'wtestattach1';
    const watcher = await connect('control=1');
    const mark = watcher.messages.length;
    const data = await connect(`session=42&window=${W}`);
    await watcher.until((m) => m.type === 'sessions' && m.tabs.some((t) => t.id === '42'), mark);
    const listing = watcher.messages
      .slice(mark)
      .filter(
        (m): m is Extract<ServerMessage, { type: 'sessions' }> =>
          m.type === 'sessions' && m.tabs.some((t) => t.id === '42'),
      );
    expect(listing[0]?.tabs.find((t) => t.id === '42')).toMatchObject({ window: W });
    expect(listing.every((m) => m.tabs.find((t) => t.id === '42')?.window === W)).toBe(true);
    data.ws.close();
  });

  // The window a tab moved to attaches while the window it left may still show it: that window's
  // control socket can bring the move later than its data socket brings the eviction. Told it was
  // a move, the pane leaves quietly instead of showing "Opened somewhere else.".
  it('evicts the socket of a window that no longer holds the tab as moved, and a rival in the holding window as a takeover', async () => {
    const W = 'wtestevict01';
    const holder = await connect(`control=1&window=${W}`);
    const main = await connect('session=47');
    holder.send({ type: 'moveToWindow', ids: ['47'], window: W });
    await holder.until(listsOwner('47', W));
    const det = await connect(`session=47&window=${W}`);
    expect(await main.until((m) => m.type === 'detached')).toEqual({
      type: 'detached',
      moved: true,
    });
    // A second attach from the window that holds the tab is a rival: the plain takeover.
    const rival = await connect(`session=47&window=${W}`);
    expect(await det.until((m) => m.type === 'detached')).toEqual({ type: 'detached' });
    // And back: once the tab is the main window's again, its attach evicts the detached one as moved.
    const back = holder.messages.length;
    holder.send({ type: 'moveToWindow', ids: ['47'], window: null });
    await holder.until(listsOwner('47', undefined), back);
    await connect('session=47');
    expect(await rival.until((m) => m.type === 'detached')).toEqual({
      type: 'detached',
      moved: true,
    });
  });

  it('a data attach with window to a LIVE terminal claims nothing', async () => {
    const first = await connect('session=43');
    expect(ownerOf('43')).toBeUndefined();
    const second = await connect('session=43&window=wtestlive002');
    expect(ownerOf('43')).toBeUndefined();
    first.ws.close();
    second.ws.close();
  });

  it('createTab with a window creates the tab in that window', async () => {
    const W = 'wtestcreate1';
    const holder = await connect(`control=1&window=${W}`);
    holder.send({ type: 'createTab', kind: 'editor', window: W });
    const ack = await holder.until((m) => m.type === 'tabCreated');
    const id = ack.type === 'tabCreated' ? ack.id : '';
    expect(ownerOf(id)).toBe(W);
    // The first broadcast that lists the tab already names the window.
    const first = holder.messages.find(
      (m) => m.type === 'sessions' && m.tabs.some((t) => t.id === id),
    );
    expect(first?.type === 'sessions' && first.tabs.find((t) => t.id === id)?.window).toBe(W);
  });

  // A tab claimed into a window that never connects must come back to the main
  // window, whichever way it was claimed.
  it('a data attach that claims a NEW id for an unconnected window releases it after the grace', async () => {
    const W = 'wtestattach2';
    const watcher = await connect('control=1');
    const mark = watcher.messages.length;
    const t0 = performance.now();
    await connect(`session=44&window=${W}`);
    await watcher.until(listsOwner('44', W), mark);
    const held = watcher.messages.length;
    await watcher.until(listsOwner('44', undefined), held);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(GRACE - 10);
    expect(ownerOf('44')).toBeUndefined();
    expect(info).toHaveBeenCalledWith(`palmux: window ${W} released 1 tabs (grace)`);
  });

  it('createTab into an unconnected window releases the tab after the grace', async () => {
    const W = 'wtestcreate2';
    const creator = await connect('control=1');
    const t0 = performance.now();
    creator.send({ type: 'createTab', kind: 'editor', window: W });
    const ack = await creator.until((m) => m.type === 'tabCreated');
    const id = ack.type === 'tabCreated' ? ack.id : '';
    await creator.until(listsOwner(id, W));
    const held = creator.messages.length;
    await creator.until(listsOwner(id, undefined), held);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(GRACE - 10);
    expect(ownerOf(id)).toBeUndefined();
  });

  it('the window connecting inside the grace keeps a tab its data attach claimed', async () => {
    const W = 'wtestattach3';
    const watcher = await connect('control=1');
    const mark = watcher.messages.length;
    await connect(`session=45&window=${W}`);
    await watcher.until(listsOwner('45', W), mark);
    await sleep(GRACE / 4);
    await connect(`control=1&window=${W}`);
    await sleep(GRACE + 100); // past where the claim's timer would have fired
    expect(ownerOf('45')).toBe(W);
    expect(watcher.messages.slice(mark).some(listsOwner('45', undefined))).toBe(false);
    expect(info).not.toHaveBeenCalled();
  });
});
