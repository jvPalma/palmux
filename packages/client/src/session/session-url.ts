// ── URL helpers ───────────────────────────────────────────────────────────────
//
// The URL is no longer the workspace. The app lives at `/` and stays there;
// which tab a WINDOW is showing is per-window state (see window-selection.ts).
// What is left here is the /ws address, and the things a URL can still mean AT
// BOOT and only at boot:
//
//   /window/<wid>  this window is a DETACHED window; `?tab=<id>` names the tab it
//                  was opened for, consumed once
//   /popout/<id>   the retired pop-out: now a detached window with a fresh id, which
//                  claims tab <id> itself (`legacy`)
//   /<id>          a legacy address — honoured once, then normalised to /
//   /?new=1        an INTENT, from `GET /new`, to create one terminal
//
// The path stopped being authoritative because a tab stopped being a numbered
// terminal: `/2` for `package.json` describes nothing, and every tab switch was
// a history entry a web pane's back button could not be told apart from a page
// navigation.

import { isTabId, isWindowId } from '@palmux/shared';

/** A legacy `/12` path → '12'; anything else → null. */
export function sessionIdFromPath(pathname: string): string | null {
  return /^\/(\d{1,4})$/.exec(pathname)?.[1] ?? null;
}

/** A `/popout/12` path → '12'; anything else → null. */
export function popoutIdFromPath(pathname: string): string | null {
  return /^\/popout\/(\d{1,4})\/?$/.exec(pathname)?.[1] ?? null;
}

/**
 * A fresh detached-window id: `w` plus 10 base-36 characters. The OPENER mints it, because the
 * window's address is its identity and nobody else knows it yet; the server checks it with the
 * same `isWindowId`. A byte modulo 36 is slightly uneven, which does not matter for a name that
 * only has to be unlikely to collide.
 */
export function newWindowId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let id = 'w';
  for (const b of bytes) id += (b % 36).toString(36);
  return id;
}

/** The address a detached window lives at. */
export function windowPath(wid: string): string {
  return `/window/${wid}`;
}

/** A `/window/<wid>` path → the id, when it is a valid window id; anything else → null. */
export function windowIdFromPath(pathname: string): string | null {
  const wid = /^\/window\/([^/]+)\/?$/.exec(pathname)?.[1];
  return isWindowId(wid) ? wid : null;
}

/**
 * What this window was OPENED as. Read once, at boot, and never again — after
 * that the address is `/` and the window's own state is the answer.
 */
export type BootIntent =
  | {
      kind: 'detached';
      wid: string;
      /** The tab this window was opened for (`?tab=`), when it is a tab id. Consumed at boot. */
      tab: string | null;
      /** Booted from a retired pop-out address, so the window itself must claim `tab`. */
      legacy: boolean;
    }
  | { kind: 'legacy'; id: string }
  | { kind: 'new' }
  | { kind: 'app' };

/**
 * Classify the boot address.
 *
 * Order matters and is not arbitrary. A detached window is the most specific and is checked
 * first; a malformed id (`/window/abc`) is no window at all and falls through to the rest. The
 * retired pop-out comes next, in BOTH its forms — `/popout/<id>` and `/<id>?popout=1`, because a
 * window opened before this change may still be sitting there when its client reloads. It becomes
 * a detached window with an id of its own: nobody opened it, so nobody else knows the id, and the
 * window itself moves `<id>` in (`legacy`). `?new=1` beats a legacy path so that `GET /new`'s
 * redirect can never be mistaken for an address.
 */
export function readBootIntent(loc: { pathname: string; search: string } = location): BootIntent {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(loc.search);
  } catch {
    params = new URLSearchParams();
  }

  const wid = windowIdFromPath(loc.pathname);
  if (wid) {
    const tab = params.get('tab');
    return { kind: 'detached', wid, tab: isTabId(tab) ? tab : null, legacy: false };
  }

  const legacy = sessionIdFromPath(loc.pathname);
  const popped =
    popoutIdFromPath(loc.pathname) ?? (legacy && params.get('popout') === '1' ? legacy : null);
  if (popped) {
    const tab = isTabId(popped) ? popped : null;
    return { kind: 'detached', wid: newWindowId(), tab, legacy: true };
  }

  if (params.get('new') === '1') return { kind: 'new' };
  if (legacy) return { kind: 'legacy', id: legacy };
  return { kind: 'app' };
}

// Shared with the server's GET /new route so both allocate identically.
export { nextFreeId } from '@palmux/shared';

/** The WebSocket URL for a session id, scheme-matched to the page. The optional
 *  `kind` tells the server what the client EXPECTS this tab to be; the server's
 *  registry is authoritative for known tabs and only consults `kind` for an
 *  unknown id — so a reconnect to a just-killed non-terminal id doesn't spawn a
 *  stray terminal there. */
export function wsUrlFor(
  id: string,
  kind?: string,
  clientKey?: string,
  /** tmux session to land in when THIS attach is what spawns the shell.
   *  `null` = a brand-new unnamed session; `undefined` = a plain shell. The
   *  server ignores it whenever the PTY is already alive, so a reconnect that
   *  still carries it cannot re-run the attach into a shell in use. */
  tmux?: string | null,
  /** The detached window attaching. Claims the tab only when THIS attach creates a new id; the
   *  server ignores it for a live or restored terminal, so a reconnect cannot steal one. */
  wid?: string,
): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const k = kind ? `&kind=${encodeURIComponent(kind)}` : '';
  // An EMPTY value is meaningful (new unnamed session), so the parameter is
  // present-or-absent, never empty-as-absent.
  const t = tmux === undefined ? '' : `&tmux=${encodeURIComponent(tmux ?? '')}`;
  // A STABLE id for this pane, carried across every reconnect. "One active
  // client" is about logical clients, not sockets: without it the server reads
  // a plain reconnect as a second client arriving and evicts the pane from its
  // own session.
  const c = clientKey ? `&client=${encodeURIComponent(clientKey)}` : '';
  const w = wid ? `&window=${encodeURIComponent(wid)}` : '';
  return `${proto}://${location.host}/ws?session=${id}${k}${c}${t}${w}`;
}

/** The control WebSocket URL — a tab-unbound attach carrying the app's tab-list,
 *  settings, fonts and control channel (no PTY). A detached window names itself: the
 *  server ties that window's ownership of its tabs to this socket's life. */
export function wsControlUrl(wid?: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const w = wid ? `&window=${encodeURIComponent(wid)}` : '';
  return `${proto}://${location.host}/ws?control=1${w}`;
}

/**
 * Open a tab in a NEW detached window, at `/window/<wid>?tab=<id>`. The id is minted here and
 * returned even when the browser blocks the popup (`win` null), so the caller never guesses it.
 * The window name is per window (a dedupe key, not an identity): two opens never share one.
 * The caller moves the tab (`moveToWindow`) only once `win` is not null.
 */
export function openDetached(id: string): { wid: string; win: Window | null } {
  const wid = newWindowId();
  const win = window.open(
    `${windowPath(wid)}?tab=${id}`,
    `palmux-${wid}`,
    'popup,width=1000,height=640',
  );
  return { wid, win };
}
