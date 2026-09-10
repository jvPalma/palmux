## 1. Per-window selection store

- [x] 1.1 Add `session/window-selection.ts`: read/write the active tab id in
      `sessionStorage`, forgiving on both sides (private mode, junk value) so an
      unusable store degrades to "no selection" and never throws
- [x] 1.2 Add the pure resolver: `(stored, tabsInStripOrder) → id | null` —
      stored-if-alive, else the left/right neighbour rule, else the first tab,
      else null for the chooser page
      · AMENDED during implementation: the neighbour rule is NOT here. It needs
      the PREVIOUS strip order, which only `workspaceController`'s
      `sessionsBroadcast` holds; the resolver only ever sees the list as it is
      now, and at boot there is no "before" for a dead id to be a neighbour of.
      Two owners for one rule would be worse than the duplication it saves. The
      resolver is stored-if-alive-and-same-kind → first tab → null.
- [x] 1.3 Unit-test the resolver against every branch, including a stored id
      whose tab came back as a DIFFERENT kind (recycled id)
- [x] 1.4 Unit-test the store with `sessionStorage` throwing on get and on set

## 2. Pop-out route

- [x] 2.1 Server: serve the SPA shell at `/popout/<id>`, anchored so no static
      mount or the not-found handler swallows it
- [x] 2.2 Verify with `curl` that `/popout/3` answers the shell and that
      `/popout/` and `/popout/abc` do not 500
      · Measured: `/popout/3`, `/popout`, `/popout/`, `/popout/abc` and
      `/popout/12345` all answer 200 with the shell; the two malformed shapes
      degrade to the normal app rather than erroring, which is the right
      failure for an address a user can type.
- [x] 2.3 Add the Vite dev-proxy entry ANCHORED, and assert the icons/assets
      prefixes still resolve (the `/file` prefix trap)
      · AMENDED: no dev-proxy entry is needed or wanted. `/popout/<id>` must
      answer the SPA SHELL, which Vite's own history fallback already does for
      any extension-less path; proxying it to the backend would serve the built
      bundle instead and kill HMR for popped-out windows. Verified live on both
      hosts, and `/assets/*` + `/file-icons/index.json` still resolve.
- [x] 2.4 Client: `isPopout()` + the popped tab id read from `/popout/<id>`,
      with `/<id>?popout=1` still accepted and normalised
- [x] 2.5 `openPopout(id)` opens `/popout/<id>`
- [x] 2.6 Live-test a HARD RELOAD of a popped-out window — the risk named in
      design.md, and the first thing that would break
      · Popout at `/popout/0` survives a hard reload chrome-less, and does NOT
      write the main window's `sessionStorage`.

## 3. Boot entry points

- [x] 3.1 Boot reads, in order: `/popout/<id>` → `/<id>` (legacy) → `?new=1`
      (intent) → the stored selection → the resolver's default
- [x] 3.2 Normalise the address to `/` after boot with `replaceState`, adding no
      history entry
- [x] 3.3 Server: `GET /new` redirects to `/?new=1`
- [x] 3.4 Client consumes `?new=1` exactly once (create one terminal, clear the
      query) so a reload does not create a second
      · The consume had to be DEFERRED to the first `sessions` broadcast and
      seed `tabsRef` from it: `nextFreeId` reads the tab list, so creating at
      mount allocated from an empty list and collided with tab 0.

## 4. Remove the URL as authority

- [x] 4.1 Delete the `pushState` in `switchSession` and the `popstate` listener
- [x] 4.2 Delete the focused-slot `replaceState` rule in `replaceNav`
- [x] 4.3 Collapse `workspaceController`'s `navigate` effect modes
      (`push`/`replace`/`set`) to state-only, and update its tests
- [x] 4.4 Persist the selection on every change of active tab
- [x] 4.5 Re-resolve the selection on every `sessions` broadcast, so a tab
      closed in another window moves this one

## 5. Verification

- [x] 5.1 `yarn test`, `yarn typecheck`, `yarn lint` clean
- [x] 5.2 Live: two browser windows, independent selections, and a tab created
      in one appears — but does not focus — in the other
      · Window A held `{"id":"4"}` on a fresh shell while window B held
      `{"id":"3"}` on CLAUDE.md; both listed the same five tabs. A second window
      with an empty store opened on the FIRST tab in strip order, not on A's.
- [x] 5.3 Live: a web pane's ← navigates the framed page after several tab
      switches, and never undoes a tab switch
      · Frame navigated A→B, then three tab switches (history.length 13→13),
      then ← returned the frame to PAGE A with the active tab untouched.
- [x] 5.4 Live: reload keeps the selection; a fresh window starts at the first
      tab in strip order
- [x] 5.5 Live: closing the viewed tab from the other window moves this one to
      the neighbour
      · A closed CLAUDE.md; B, which was viewing it, moved to its LEFT
      neighbour `package.json` with no reload and nothing stranded.
- [x] 5.6 Live: `/3` and `/new` still work and normalise
- [x] 5.7 Confirm `history.length` does not grow while switching tabs

## 6. Documentation

- [x] 6.1 Update `CLAUDE.md`: the URL is no longer the session; what the id IS
      still identity for; why `sessionStorage` and not `localStorage`
- [x] 6.2 Update `tips/tips.ts`: back belongs to web panes; each browser window
      remembers its own tab
- [x] 6.3 Record the id-space decision as explicitly deferred, with what would
      reopen it
