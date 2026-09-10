## Context

The URL path has been the active tab since palmux was terminals-only: `/0`,
`/1`, … with bare `/` meaning `0`. Eight places produce or consume it —
the boot read (`App.tsx:154`), `switchSession`'s `pushState` (`:503`),
`replaceNav`'s `replaceState` (`:510`), the `popstate` listener (`:1141`),
`isPopout()`, the server's `GET /new` 302, and the PWA manifest's
`start_url`/`scope`.

Two things made that design stop paying. A tab is no longer always a numbered
terminal — it can be a web page, a dashboard, a note, a markdown file, or (since
this week) a file on disk, so `/2` for `package.json` describes nothing. And web
panes gained ← / → that walk the browser's history, which is the same stack
`pushState` writes into: back can undo a tab switch instead of navigating the
framed page, and neither the user nor the code can tell which it will do.

An independent review (codex, gpt-5.6-sol) reached the same conclusion from the
code alone and put the distinction better than this document originally did:
**the id is necessary; its presence in the path is not.**

## Goals / Non-Goals

**Goals**
- The browser URL stops being authoritative for which tab is active.
- Tab switching stops creating history entries, so ← belongs to web panes alone.
- Selection becomes per-WINDOW, so two browser tabs on one palmux are independent.
- No bookmark breaks and no script breaks: `/<id>` and `/new` keep working.

**Non-Goals**
- Changing the tab ID SPACE. Ids stay short numeric strings, allocated
  lowest-free. This change makes opaque ids *possible* later; it does not make
  them, because that means migrating `tabs.json`, `sessions/<id>.json` and
  `notes/<id>.md` for a bug family already covered by the snapshot deletion
  paths and the tty-hint sweep.
  **DEFERRED, not dismissed.** Recycling is a real hazard and this change met it
  once more: a stored selection can name an id that came back as a different
  kind of tab, which is why `WindowSelection` carries the `kind` and a mismatch
  reads as gone. That is a local defence, not a fix. What would REOPEN the
  decision: an id leaking somewhere a user can bookmark or share (the pop-out
  address is machine-local and does not count), or a second recycled-id defect
  that no per-site kind check can express — at that point the migration is
  cheaper than the next defence.
- Changing what the SERVER persists. Tabs, order, groups, colours and notes stay
  exactly as they are, and stay shared across windows.
- Named workspaces, shareable per-tab links, or multi-layout support.

## Decisions

### D1 — `sessionStorage`, not `localStorage`

Selection is per browsing context. `sessionStorage` is scoped to one browser tab
and survives a reload; `localStorage` is shared across every tab on the origin.

*Alternative considered:* `localStorage`. Rejected because it produces the
opposite of what "browser-aware" means here — opening a second window would
yank it to whatever the first was showing, and switching in one would fight the
other. The one thing it would buy (a new window resuming where you left off) is
not wanted: a new window should start clean.

*Known consequence:* duplicating a browser tab copies `sessionStorage` in most
browsers, so the copy opens on the same palmux tab and diverges from there. That
is inheritance rather than pure isolation, and it is the desirable behaviour.

### D2 — The URL is an ENTRY point, never a mirror

After boot the URL is `/` and nothing rewrites it — not even `replaceState`.

*Alternative considered:* keep the URL in sync with `replaceState` (no history
entries, but the address still shows `/2`). Rejected: it keeps every navigation
path having to agree on the URL, keeps the id space tied to the path grammar,
and buys only a display that is wrong for four of the five tab kinds.

### D3 — Pop-out becomes a real route, `/popout/<id>`

A separate window needs an address; that is not negotiable. Making it a route
rather than a query flag on a tab path means the pop-out address does not
depend on the tab path continuing to exist.

*Alternative considered:* `window.open('/')` plus `postMessage` telling the new
window which tab it is. Rejected: the window opens empty and only then learns
what it is, and a lost message strands it. An address is exactly the thing that
solves this and it is cheap.

### D4 — `/new` keeps working, as an INTENT

`GET /new` currently 302s to `/<lowest free id>`. It becomes a 302 to `/?new=1`;
the client reads that once, creates a terminal, and clears the query. The
script-facing contract (`xdg-open http://host/new` opens a new terminal) is
unchanged.

### D5 — Fallbacks are explicit, not incidental

- Stored selection names a tab that no longer exists → the existing
  `neighborAfterClose` rule (left neighbour, else right).
- No stored selection at all → the FIRST tab in strip order. Not `0`: id `0`
  may not exist, and "lowest id" is not "leftmost" since tab-reorder decoupled
  order from id.
- No tabs at all → the New-tab chooser page, as today.

## Risks / Trade-offs

- **Pop-out stops surviving a refresh.** Today the id is in the path and read at
  boot; `/popout/<id>` must do the same or a refresh strands the window. → This
  is the first thing built and the first thing tested, including a hard reload.
- **The server must serve the SPA shell at `/popout/<id>`.** The not-found
  handler already falls through to `index.html`, but it excludes some
  namespaces; `/popout/` must be reachable and must not be swallowed by a static
  mount or the Vite dev proxy. → The `/file` prefix trap earlier this week is
  the precedent: an anchored route and a served-response test, not an assumption.
- **Losing back-as-tab-switch is a real loss for whoever used it.** → Owner
  decision, taken with the alternative on screen. `Ctrl+Tab` / `Ctrl+Shift+Tab`
  already exist and the command palette lists them.
- **`sessionStorage` can be unavailable** (private mode, storage disabled). →
  Every read and write is best-effort; an unusable store degrades to "always
  open the first tab", never to a crash. The collapse-set and dock-view stores
  already work this way.
- **A stale selection could point at a tab of a different KIND** after an id is
  recycled. → The selection is validated against the live tab list on every
  broadcast, the same reconciliation `reconcilePairings` already does for splits.

## Migration Plan

1. Add the per-window store and the `/popout/<id>` route; keep everything else
   working. Both addresses valid at once.
2. Switch the client to read selection from the store, with `/<id>` still
   honoured at boot and then normalised to `/`.
3. Remove `pushState`, the `popstate` listener and the focused-slot URL rule.
4. Point `GET /new` at `/?new=1`.
5. Retire `/<id>?popout=1` once `/popout/<id>` is verified, keeping `/<id>` as a
   legacy entry indefinitely — it costs one regex.

**Rollback:** every step is client-side except the two server routes, and both
are additive until step 5. Reverting the client restores the old behaviour with
no persisted state to undo, because `sessionStorage` dies with the window.

## Open Questions

None blocking. Two the owner has already decided, recorded here so they are not
silently re-opened: back must NOT switch tabs, and only the pop-out needs an
address of its own.
