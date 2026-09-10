## Why

The URL path IS the active tab (`/0`, `/1`, …), so switching tabs is a browser
NAVIGATION: `switchSession` calls `pushState`, and `popstate` selects a tab. That
made sense when a tab was always a numbered terminal. It no longer is — a tab is
now a terminal, a web page, a dashboard, a note, a markdown file or a file on
disk, and clicking `package.json` in the Explorer moves the browser to `/2`,
which describes nothing.

The cost is already observable, not theoretical. A web pane's ← / → walk the
same history stack `pushState` writes into, so back can undo a tab switch
instead of navigating the framed page — with nothing on screen to say which it
will do. Palmux cannot fix that while both write to one stack.

The identity the system actually needs is the `tabId`, and it needs it in the
registry, on `/ws?session=`, in `tabs.json`, in snapshots, in notes, in split
pairings and in pop-outs. It does not need it in the browser's path.

## What Changes

- **BREAKING (URL surface):** the app is served at `/` and stays there. Switching
  tabs no longer changes the URL and no longer creates a history entry.
- `pushState` on tab switch is REMOVED, along with the `popstate` handler and the
  rule that the focused split slot rewrites the URL.
- Which tab a window is looking at becomes **per-window** state in
  `sessionStorage` — two browser tabs on the same palmux hold independent
  selections, and neither inherits from the other.
- The tab LIST stays server state and stays shared: creating a tab in one window
  makes it appear in every window's strip, and switches only the window that
  created it.
- Pop-out moves from `/<id>?popout=1` to an explicit **`/popout/<id>`** route.
- `GET /new` keeps working for scripts, redirecting to `/?new=1`; the client
  reads that intent once and creates a terminal.
- `/<id>` remains a LEGACY ENTRY: read once at boot, select that tab, then
  normalise the URL to `/`. No bookmark breaks.
- A window whose stored selection names a tab that no longer exists falls back
  through the existing `neighborAfterClose` rule; a window with no stored
  selection opens the first tab in strip order.

Explicitly NOT in this change: the tab ID SPACE. Ids stay short numeric strings
allocated lowest-free. Decoupling the URL is what would make opaque,
never-recycled ids possible later, but changing them means migrating
`tabs.json`, `sessions/<id>.json` and `notes/<id>.md`, and the recycled-id bug
family is currently covered by the snapshot deletion paths and the tty-hint
sweep. That is a separate decision.

## Capabilities

### New Capabilities
- `browser-local-tab-selection`: the canonical `/` route, per-window selection in
  `sessionStorage`, the fallbacks for a missing or dead selection, and the
  legacy/`?new=1` entry points.

### Modified Capabilities
- `workspace-tabs`: a tab id is no longer "the URL routing"; the id remains the
  wire/persistence identity but the path stops naming it.
- `window-pop-out`: the pop-out address becomes `/popout/<id>` rather than
  `/<id>?popout=1`, and is a real route rather than a query flag on a tab path.
- `web-panes`: the pane's ← / → gain a stated behaviour now that the tab strip no
  longer writes to the same history stack.

## Impact

- `packages/client/src/App.tsx` — `switchSession` (`pushState`), `replaceNav`
  (`replaceState`), the `popstate` listener, the boot read of `location.pathname`.
- `packages/client/src/session/session-url.ts` — `sessionIdFromPath`,
  `pathForSession`, `isPopout`; new per-window selection helpers.
- `packages/client/src/session/workspaceController.ts` — the `navigate` effect's
  `push`/`replace`/`set` modes collapse to state-only.
- `packages/server/src/server.ts` — `GET /new` redirect target; a `/popout/<id>`
  route that serves the SPA shell.
- `packages/client/public/manifest.webmanifest` — `start_url` already `/`; verify
  `scope` still covers `/popout/`.
- No wire-protocol change, no `tabs.json` migration, no change to the registry.
