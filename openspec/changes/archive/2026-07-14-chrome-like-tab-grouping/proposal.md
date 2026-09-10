## Why

The strip now has Chrome's bones — stable ids, drag-to-reorder, per-tab colors, split
pairings — but no way to organize many tabs. The user wants Chrome tab groups: named,
colored clusters that keep related tabs (a project's terminal + notes + docs) together,
collapse out of the way, and move as a unit.

## What Changes

- **Tab groups as first-class shared state**: a group is `{ id, name?, color }`; each tab
  MAY belong to one group; a group's members are CONTIGUOUS in the strip order. A group
  of one is valid; only an empty group dissolves. Groups are server-authoritative and
  sync via the `sessions` broadcast — per-tab `groupId` persists (additively) in
  `tabs.json`; group name/color in a **sidecar `groups.json`** (so an old server loads
  `tabs.json` unchanged — rollback-safe).
- **Protocol**: `sessions` gains `groups`; `TabMeta` gains `groupId`; two client→server
  ops — `groupCreate { ids, name?, color? }` and `groupUpdate { id, name?, color?,
addIds?, removeIds?, dissolve?, order? }`. A join/leave drop carries membership AND the
  new strip `order` in one message (a plain reorder CANNOT move membership). Old servers
  ignore them; old clients ignore the new fields.
- **Creation** (no multi-select): a tab's context menu gains "New group from this tab" and
  "Add to <group>"; a group grows/shrinks by dragging tabs in/out of its span (a drop on
  a lone member's center joins, so a group of one stays growable).
- **Strip UI (desktop)**: a colored group CHIP renders before the first member; members
  get the group's cluster framing WHILE ALSO keeping their own per-tab color/name (two
  independent channels — intentional). Clicking the chip collapses/expands; collapse is
  per-device VIEW state (localStorage), like the split. Chip menu: rename, recolor,
  ungroup, close-all (kind-aware, warns on dirty editors).
- **Gestures**: drag a tab into a group's span to join; past the edge to leave; drag the
  chip to move the whole group (block reorder). The server keeps members contiguous via a
  `normalizeOrder` pass whatever a client sends.
- **Safety rails**: collapsing a group holding the active tab activates the nearest
  OUTSIDE tab first (refused, with a toast, when none exists); a hidden member becoming
  active by ANY path (URL/popstate, split re-tile, close-nav, reconcile, boot) auto-
  expands its group via one centralized effect; killed tabs leave their group; an emptied
  group disappears.
- **Mobile drawer**: group headers are tappable to collapse/expand (sharing the desktop
  per-device collapse state); members render in strip order under their header. No
  drag/join on mobile this milestone.

## Capabilities

### New Capabilities

- `tab-grouping`: the group model (shared, persisted, contiguous), its wire protocol,
  the strip chip UI with per-device collapse, and the join/leave/move-as-unit gestures.

### Modified Capabilities

<!-- none archived; composes with the unarchived tab-reorder (order normalization) and
     split-view changes (auto-expand on activation) as ADDED requirements. -->

## Impact

- **Shared**: `protocol.ts` — `TabGroup`, `sessions.groups`, `TabMeta.groupId`,
  `groupCreate`/`groupUpdate` messages + parses; `session-ids.ts` — `isGroupId` +
  group-id generator (shape-distinct from `isTabId`).
- **Server**: `server.ts` registry — `groups` map + per-tab `groupId` + `normalizeOrder`
  (contiguity pass after every mutation incl. `reorder`), group ops in the ws switch;
  `tabs-store.ts` — per-tab `groupId` (additive) + a sidecar `groups.json` store.
- **Client**: `SessionTabs.tsx` (chips, cluster framing, collapse, tab-menu create/add,
  group DnD), `App.tsx` (group op wiring, centralized auto-expand effect, collapse view
  state, close-all), `tab-meta.ts` (group helpers), `SessionDrawer.tsx` (tappable group
  headers), `index.css` (`--group-accent` layer), `localStorage['palmux-collapsed-groups']`.
- **Docs**: `docs/group-model.md`, `docs/collapse-state-machine.md`,
  `docs/dnd-decision-table.md` (authored before implementation); tips, README, CLAUDE.md.
