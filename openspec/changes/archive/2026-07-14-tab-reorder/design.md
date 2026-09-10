## Context

Ordering is currently an accident of id: the registry's `sortedIds()`
(`server.ts:130`) numerically sorts the tab Map's keys for `ids()`, `tabs()`, and
`persist()`, and the client strip's merge path re-sorts numerically
(`SessionTabs.tsx` `list`). `tabs.json` already persists an ORDERED array
(`PersistedTab[]`), and the registry restore loop (`server.ts:117`) already iterates it
in file order — the persistence format needs zero changes. The strip already carries
tab drags (`TAB_DND_TYPE`) for split gestures; while a split is shown, dropping on the
strip currently collapses it (`onDropToStrip`), a gesture the user has agreed to retire
in favor of reorder (⏏ eject remains the un-split affordance).

Decisions locked with the user: ids/URLs stay; strip drag = reorder (Chrome-like, split
members included, pairing follows the tab); order is server-authoritative and shared
across clients.

## Goals / Non-Goals

**Goals:**

- Explicit registry order: restore from file order, append on create, reorder on demand.
- `reorderTabs` protocol message; `sessions.tabs` array order authoritative.
- Strip drag-to-reorder with an insertion indicator; optimistic local apply.
- Remove the drag-back-to-strip collapse gesture (docs updated).

**Non-Goals:**

- No change to id assignment, URLs, session attach, or the split model.
- No mobile-drawer reordering (the drawer lists in the same shared order; reordering is
  a desktop-strip gesture for now).
- No per-device order (rejected by the user in favor of shared/server-side).
- No cross-window tear-off changes.

## Decisions

### D1 — Registry keeps `order: string[]` alongside the Map; `sortedIds()` becomes `orderedIds()`

`order` is rebuilt from the `store.load()` iteration (file order) at construction —
skipped entries (bare dormant terminals) simply aren't in it. Every `tabs.set` on a NEW
id appends to `order`; every delete filters it. `ids()`, `tabs()`, and `persist()` all
map over `order`, so persistence keeps working with zero format changes (the array
order IS the stored order). `nextFreeId` is order-independent (it scans for the lowest
free number), so id assignment is untouched.
_Alternative rejected_: an `order` field per PersistedTab — redundant with array
position and invites inconsistency.

### D2 — `reorder(ids)` is a forgiving permutation, never a mutation of membership

`reorder(ids)`: keep only ids the registry knows (dedup, first occurrence wins), then
append any known ids the message omitted in their prior relative order. Reorder can
therefore never add, drop, or duplicate a tab, no matter how stale or malformed the
client's view was (two clients racing reorders converge on last-writer-wins). Persist +
`listChanged()` (reuses the existing sessions broadcast).

### D3 — Wire: `reorderTabs { ids: string[] }`, accepted on any socket kind

Same posture as `kill`/`createTab`/`updateTab`: handled in the ws switch regardless of
which tab the socket is attached to (the control socket is the normal sender). Parse
guards: `ids` must be an array of valid tab ids (`isTabId`), capped at a sane length
(the registry cap already bounds real tabs). No server→client ack beyond the `sessions`
broadcast itself.

### D4 — Client: optimistic reorder in App, strip renders array order

`SessionTabs` drops the numeric sort: `list` = broadcast order, with a
not-yet-broadcast current id APPENDED (not sort-inserted). On drop, App reorders its
`tabs` state immediately (so the strip doesn't flash) and sends `reorderTabs` with the
full id list; the next broadcast is authoritative (an old server that ignores the
message just snaps back — acceptable degradation, called out in the proposal).

### D5 — Strip DnD: dragover-on-tabs computes the insertion index; drop anywhere on the strip reorders

During a tab drag, `dragover` on each tab compares pointer x to the tab's horizontal
midpoint → insert-before or insert-after; the gap is marked with a CSS insertion
indicator (a 2px accent bar, Chrome-style). Drop on the strip container (including the
trailing empty area → append) commits. The drag still uses `TAB_DND_TYPE`, so the
existing content-area zones (edge split / slot replace) are untouched — only the
strip's drop semantics change. `onDropToStrip` (collapse) is deleted from App and
SessionTabs.

### D6 — Split state is order-blind

Nothing in `useSplit`/App reads strip positions (slots reference tab IDS), so reorder
requires zero split changes; the spec scenario "reordering a member never touches the
split" holds by construction. The retired collapse gesture is replaced by nothing —
⏏ eject already ships.

## Risks / Trade-offs

- **[Two clients reorder concurrently]** → last-writer-wins at the server; D2's
  forgiving permutation guarantees no loss either way. Acceptable for a personal tool.
- **[Optimistic order vs in-flight broadcast]** → a broadcast composed before the
  server applied the reorder can briefly show the old order, then the post-reorder
  broadcast corrects it. Sub-300ms flicker in the worst (title-debounce) case; no state
  divergence because the server is authoritative.
- **[Bare dormant terminals aren't persisted]** → their order (like the tabs
  themselves) doesn't survive a restart — unchanged from today's behavior.
- **[Removed gesture muscle-memory]** → drag-to-strip now reorders instead of
  collapsing; tips/README updated, ⏏ eject is more discoverable than the old gesture.

## Migration Plan

Pure additive protocol message + client render change; `tabs.json` format unchanged
(existing files load as-is, their array order becoming the initial order — which today
IS numeric order, so nothing visibly changes until the first drag). Rollback = revert
the diff. Old client + new server: fine (client sorts, ignores nothing). New client +
old server: reorder snaps back on next broadcast.

## Open Questions

- **OQ1**: should the mobile drawer later gain long-press reorder? Out of scope now;
  the drawer already inherits the shared order.
