# ui-rework — apply batch 8 (group 9: the Explorer remembers which roots are open, per device)

Batch plan for the OpenSpec change `ui-rework`. Batches 1–7 are in production.

Owner feedback (2026-10-25), verbatim: "na barra de explorer, a home dir esta sempre expandida. nao
quero isso sempre aberto. alias, quero que se lembre per device que groups estao expandidos ou nao."

"Groups" here are the Explorer's ROOT SECTIONS: HOME and each pinned folder, the collapsible
`.ft-sect` blocks. Folder expansion inside a root is not in scope (see Non-goals).

## What exists (`panes/FileTree.tsx`; `grep -a` it, `file` reports it as data)

- `openRoots` (`~208`) is component state, initialised EMPTY on every mount. `FileTree` mounts each
  time the dock's Explorer view or the drawer's Explorer view opens, so the state is lost every time.
- `load(null)` (`~250–257`) adds HOME to `openRoots` on arrival, unconditionally ("HOME opens on
  arrival"): that is why HOME is always open.
- The section header toggles membership (`~684`); `pin()` (`~425–434`) replaces the set with just the
  new root; an effect (`~275–283`) prunes roots that are no longer in `explorerRoots(root, pins)`.
- Per-device UI state elsewhere lives in `localStorage` with a forgiving parse (the tab groups'
  `palmux-collapsed-groups`, `palmux-splits`), never in the synced settings: `explorerPins` is synced
  because those paths are server paths, but which ones are OPEN is a view preference of this device.

## Acceptance criteria

### A. Open roots persist per device

- A new pure module `panes/explorer-open.ts` reads and writes `localStorage['palmux-explorer-open']`
  as `{ v: 1, open: string[] }` (absolute paths). The parse is forgiving: a missing key, bad JSON, a
  wrong shape, non-string or relative entries all yield "no stored state" (`null`) or drop the bad
  entries, and a storage exception (private mode, quota) is swallowed — the Explorer must never fail
  to render over this. Never synced to the server.
- `FileTree` initialises `openRoots` from the stored set, and writes the set back whenever it changes
  (header toggle, pin, prune). The dock's and the drawer's Explorer therefore show the same open
  roots on the same device, and the state survives closing the view, a reload and a restart.

### B. HOME is open only on a device's first run

- When a stored state exists, HOME's open/closed comes from it alone: `load(null)` no longer forces
  HOME open. Collapsing HOME and reopening the Explorer (or reloading) keeps it collapsed.
- When NO stored state exists (first run on this device, or storage unreadable), HOME opens on
  arrival as today, and that initial state is what gets stored.

### C. Remembered roots are never erased by a boot race, and they load (B8-01, B8-02)

- **No destructive pruning of the stored set (B8-01).** `explorerRoots(root, pins)` is incomplete
  while HOME is unknown and while the synced pins have not arrived, and nothing in `useSettings`
  says when they are authoritative; any prune keyed to it can erase a remembered pinned root and
  store the loss. So the stored set is never pruned against the root list. What the Explorer SHOWS
  is `stored ∩ explorerRoots(root, pins)`, recomputed on every render; an entry for a path that is
  not a root today stays dormant in storage and costs nothing. The existing prune effect
  (`~275–283`) is removed. Writes happen only on user actions (header toggle, pin), and each write
  stores the full current set, so dormant entries are kept unless a user action replaces them —
  `pin()` replaces the set with `[newRoot]` by design, which also clears dormant entries.
  Re-pinning a path that has a dormant open flag opens it, which is what pinning does anyway.
- **A restored open root loads its listing (B8-02).** `expanded` starts empty and only expanded paths
  are fetched (`~333–338`); toggling a section and pinning add the root to `expanded`, but restoring
  would not, leaving an open section with no rows. An effect adds every root in
  `stored ∩ explorerRoots(root, pins)` to `expanded` as it becomes a root (HOME on arrival, a pin when
  the pins arrive), so its listing is fetched and its files appear with no toggle.
- **Every reader of "open" uses the live intersection, not the stored set (B8-03).** The 2-minute
  poll (`~301–312`, via `openRootsRef`) refreshes loaded directories under each open root; it must
  iterate `stored ∩ explorerRoots(root, pins)`, as rendering and the restore-load do, so an unpinned
  root's dormant flag never keeps its subtree polling. Persistence alone keeps the full set.
  Regression: load `/work` as a pinned open root, unpin it, advance the poll → no further
  `/files/list` request for `/work` or its descendants, while its stored flag remains.
- Tests: stored `[HOME, /pinned/x]` with pins arriving AFTER HOME and with pins arriving BEFORE HOME
  → both sections open, `/files/list?dir=/pinned/x` fetched and its rows rendered with no click; a
  root unpinned later stops showing but its stored entry is not deleted until a user action replaces
  the set; `pin()` stores exactly `[newRoot]`.

### D. Docs

- CLAUDE.md's Explorer paragraph ("The Explorer (the dock's file view) has ROOTS…") gains the
  per-device memory: the key, why it is local not synced, the first-run default, why the stored
  set is never pruned, and that only LIVE open roots load and poll.

## Cluster

One builder (`claude-sonnet-5-5`, xhigh): `panes/explorer-open.ts` (new) + its test,
`panes/FileTree.tsx`, `panes/FileTree.test.tsx`, `CLAUDE.md` (the Explorer paragraph only). No CSS.

## Non-goals

- Remembering expanded FOLDERS inside a root (offered to the owner as a follow-up).
- Syncing the open state across devices.

## Verification

- `yarn typecheck`, `yarn lint` (0 errors), `yarn test`.
- Tests: the module's parse/serialise cases; FileTree — first run opens HOME and stores it; a stored
  collapsed HOME stays collapsed across unmount/remount; a toggle is stored; pin stores
  `[newRoot]`; the C cases (both arrival orders, restored rows fetched without a click, no deletion
  on unpin); a storage that throws on `getItem`/`setItem` still renders.
- Isolated smoke (`PALMUX_HOST=127.0.0.1`, `"host":"127.0.0.1"`, port 44099, listener checked with
  `command ss -ltnp`, client built into /tmp): desktop 1440×900 — open Explorer, collapse HOME, switch
  the dock to New tab and back, reload → HOME still collapsed; mobile 390×844 — the drawer's Explorer
  shows the same state (same origin, same device).
