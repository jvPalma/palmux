## Why

Tabs render in numeric-id order (`sortedIds()` in the registry; a numeric sort in the
strip's merge path), so the strip can't be rearranged — the position of a tab is an
accident of which id was free when it was created. The user wants a Chrome-like strip:
grab a tab, drop it where it belongs. Tab ids and their `/0 /1 /2` URLs are stable
identities and stay exactly as they are; only DISPLAY ORDER becomes a first-class,
reorderable property.

## What Changes

- **Display order is decoupled from tab id.** The registry maintains an explicit order
  (insertion/append order, mutated by reorder); `sessions.tabs` array order becomes
  meaningful and authoritative for every client. Ids, URLs, and `nextFreeId` id
  assignment are unchanged — a new tab still takes the lowest free id but APPENDS to
  the end of the order.
- **Server-authoritative, shared order**: persisted via `tabs.json`'s existing array
  order (no schema change), synced to all clients through the existing `sessions`
  broadcast. One new client→server message: `reorderTabs { ids }`.
- **Strip drag = reorder (Chrome-like).** Dragging a tab within the strip shows an
  insertion indicator and drops move the tab — including split members (the pairing
  follows the tab; order never affects split state). Applied optimistically client-side,
  confirmed by the broadcast.
- **BREAKING (gesture): drag-back-to-strip no longer collapses the split.** Reorder owns
  the strip surface; un-splitting is the per-slot ⏏ eject (and the split can also be
  ended by ejecting via context menu in future). Drag-to-content-edge (open split) and
  drag-onto-slot (replace slot) are unchanged.
- **The client strip stops sorting numerically** and renders the broadcast order; a
  freshly navigated not-yet-broadcast id appends at the end instead of sort-inserting.

## Capabilities

### New Capabilities

- `tab-reorder`: display order as a server-authoritative, persisted, reorderable
  property of the tab list, plus the Chrome-like strip drag-to-reorder gesture that
  replaces the drag-back-to-strip collapse.

### Modified Capabilities

<!-- openspec/specs/ is empty (no archived capabilities), so there is no base spec to
     write deltas against; the drag-back-collapse removal supersedes the corresponding
     requirement in the unarchived split-view/split-view-and-terminal-fixes changes and
     is called out as BREAKING above. -->

## Impact

- **Shared**: `protocol.ts` — new client→server `reorderTabs` message (parse + type);
  `sessions` unchanged on the wire (array order now meaningful).
- **Server**: `server.ts` registry — explicit `order: string[]` replacing `sortedIds()`
  (restore from `tabs.json` array order; append on create/spawn-on-attach; filter on
  delete; new `reorder(ids)` with validation), ws switch case for `reorderTabs`;
  `tabs-store.ts` untouched (array order IS the persistence).
- **Client**: `session/SessionTabs.tsx` — render broadcast order (drop the numeric
  sort), strip-internal dragover insertion indicator + drop → reorder callback, remove
  the `onDropToStrip` collapse wiring; `App.tsx` — optimistic reorder of `tabs` state +
  `sendReorderTabs`, remove the collapse-on-strip-drop handler; `lib/ws.ts` — send
  helper; `index.css` — insertion indicator style.
- **Docs/tips**: strip reorder tip; README/CLAUDE.md split-view paragraphs lose the
  drag-back-collapse sentence.
- **Back-compat**: an older server ignores `reorderTabs`; the optimistic order is then
  corrected by its next (sorted) broadcast — graceful degradation.
