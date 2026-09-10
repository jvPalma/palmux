// ── URL helpers ───────────────────────────────────────────────────────────────
//
// The URL is no longer the workspace. The app lives at `/` and stays there;
// which tab a WINDOW is showing is per-window state (see window-selection.ts).
// What is left here is the /ws address, and the three things a URL can still
// mean AT BOOT and only at boot:
//
//   /popout/<id>   this window is a chrome-less single-tab window
//   /<id>          a legacy address — honoured once, then normalised to /
//   /?new=1        an INTENT, from `GET /new`, to create one terminal
//
// The path stopped being authoritative because a tab stopped being a numbered
// terminal: `/2` for `package.json` describes nothing, and every tab switch was
// a history entry a web pane's back button could not be told apart from a page
// navigation.

/** A legacy `/12` path → '12'; anything else → null. */
export function sessionIdFromPath(pathname: string): string | null {
  return /^\/(\d{1,4})$/.exec(pathname)?.[1] ?? null;
}

/** A `/popout/12` path → '12'; anything else → null. */
export function popoutIdFromPath(pathname: string): string | null {
  return /^\/popout\/(\d{1,4})\/?$/.exec(pathname)?.[1] ?? null;
}

/** The address a popped-out window lives at. */
export function popoutPath(id: string): string {
  return `/popout/${id}`;
}

/**
 * What this window was OPENED as. Read once, at boot, and never again — after
 * that the address is `/` and the window's own state is the answer.
 */
export type BootIntent =
  | { kind: 'popout'; id: string }
  | { kind: 'legacy'; id: string }
  | { kind: 'new' }
  | { kind: 'app' };

/**
 * Classify the boot address.
 *
 * Order matters and is not arbitrary. A pop-out is the most specific and is
 * checked first, in BOTH its forms — `/popout/<id>` and the retired
 * `/<id>?popout=1`, because a window opened before this change may still be
 * sitting there when its client reloads. `?new=1` beats a legacy path so that
 * `GET /new`'s redirect can never be mistaken for an address.
 */
export function readBootIntent(loc: { pathname: string; search: string } = location): BootIntent {
  const popped = popoutIdFromPath(loc.pathname);
  if (popped) return { kind: 'popout', id: popped };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(loc.search);
  } catch {
    params = new URLSearchParams();
  }

  const legacy = sessionIdFromPath(loc.pathname);
  if (legacy && params.get('popout') === '1') return { kind: 'popout', id: legacy };
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
  return `${proto}://${location.host}/ws?session=${id}${k}${c}${t}`;
}

/** The control WebSocket URL — a tab-unbound attach carrying the app's tab-list,
 *  settings, fonts and control channel (no PTY). */
export function wsControlUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws?control=1`;
}

/**
 * Open a tab in a separate window. The window NAME dedupes repeat opens.
 *
 * A real ROUTE, not a query flag on a tab path: a separate window needs an
 * address — that part was never negotiable — and hanging it off `/<id>` would
 * tie it to per-tab paths that no longer exist.
 */
export function openPopout(id: string): Window | null {
  return window.open(popoutPath(id), `palmux-${id}`, 'popup,width=1000,height=640');
}

/** Post the "return to main" message to the opener (origin-locked). */
export const POPOUT_RETURN = 'palmux-popout-return';
export function postReturnToMain(id: string): boolean {
  if (!window.opener || window.opener.closed) return false;
  try {
    (window.opener as Window).postMessage({ type: POPOUT_RETURN, tabId: id }, location.origin);
    return true;
  } catch {
    return false;
  }
}
