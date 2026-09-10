## Context

Builds directly on tab-reorder (registry `order: string[]`, `sessions.tabs` order
authoritative, strip DnD with insertion indicator) and theme-and-tab-accents (the
12-slot `--tab-c-*` palette — group colors reuse the same names/vars). The registry
already persists via `tabs.json` array order; `updateTab` shows the patch-message
pattern; the split's display scoping proves per-device view state layered over shared
state. Precedents to respect: forgiving-permutation validation (reorder), opaque
name/color strings, kind-aware confirmation on close.

## Goals / Non-Goals

**Goals:**

- Shared group model (contiguity server-enforced), forgiving wire ops.
- Chip + cluster strip UI, per-device collapse, safe-activation rules.
- Join/leave/move-as-unit drag gestures composed with reorder.

**Non-Goals:**

- Nested groups, saved/restorable group "workspaces", cross-window group moves.
- Mobile drawer editing (headers only).
- Auto-grouping heuristics (new tabs join nothing by default).

## Decisions

### D1 — Registry: `groups: Map<groupId, {name?, color?}>` + per-tab `groupId`; contiguity as a normalization pass

Membership lives on the tab record (persisted per tab entry in tabs.json; groups
themselves as a `groups` array in the same file — parse ignores unknowns, drops
memberships pointing at missing groups). One `normalizeOrder()` runs after EVERY
mutation (group op, reorder, create, kill): stable-partition the order so each group's
members sit contiguously at the position of their first member. reorder() therefore
accepts anything and emerges group-valid — same forgiving posture as tab-reorder.
Group ids: short random tokens (not tab-id-shaped, avoiding any id-space confusion).

### D2 — Wire: two messages, sessions carries the rest [REVISED in Session 1 — see D1.1]

`groupCreate { ids, name?, color? }` (server assigns the group id) and
`groupUpdate { id, name?, color?, addIds?, removeIds?, dissolve?, order? }`. `sessions`
gains `groups: TabGroup[]` (strip-ordered) and `TabMeta.groupId?`. Chip drag = a plain
`reorderTabs` whose ids list moves the members as a block (normalization keeps them
together). Back-compat: parse-default-null on old servers; old clients ignore unknown
fields. **CORRECTION (D1.1):** the original claim "reorder absorbs join/leave" is WRONG
— a plain `reorderTabs` cannot express membership change (normalize bounces a groupless
tab back out of a group's span, and pulls a member back in). Join/leave sends
`groupUpdate` with `addIds`/`removeIds` PLUS the optional `order` so membership + strip
position mutate atomically in one message. See D1.1.

### D3 — Collapse: `localStorage['palmux-collapsed-groups']` = groupId[] [REVISED — see D1.3]

Pure view state (like `palmux-split`): SessionTabs filters collapsed members from the
rendered list (chip stays); the mobile drawer collapses too (see D1.6). Guard before
collapsing the active tab's group → activate the nearest-outside tab first (refuse when
none, with a toast). **CORRECTION (D1.3):** the original claim that activation "funnels
through selectTab" is FALSE — the split re-tile, boot, reconcile, and close-navigation
paths call `setSessionId` DIRECTLY (focusSlotHandler, doSplit/doDropSplit, doDropSlot,
doCollapse, the reconcile effect, the sessions-handler close-nav, and the boot useState
initializer). Auto-expand is therefore centralized in a `useEffect` keyed on
`[sessionId, groups]` that removes the active tab's groupId from the collapsed set — one
place, catches every path. Dead group ids are pruned on every broadcast.

### D4 — Strip rendering: chip as a pseudo-entry, cluster framing via CSS

SessionTabs builds a render list interleaving chips before each group's first member
(chips are NOT tabs — no id collision with reorder indices; drop-index math counts tabs
only, chips map to their following tab's index). Cluster framing: members get
`--group-accent` (same `--tab-c-*` vars as tab colors) painted as a connected underline
strip + chip pill — visually Chrome-like, distinct from the per-tab TOP accent
(theme-and-tab-accents) so both can coexist on one tab. Collapsed chip shows a member
count badge.

### D5 — DnD: span membership decided by drop index, chip drag carries a marker

A tab dropped at index i joins the group iff the tabs on BOTH sides of the insertion
point belong to it (interior drop); edge drops (before first / after last member)
land OUTSIDE the group — leaving is therefore "drag past the edge", exactly Chrome's
feel. The chip is draggable with a distinct DND payload (`application/x-palmux-group`);
dropping it reorders the whole block via one composed `reorderTabs`. Content-area zones
ignore the group payload (no group-to-split gesture).

### D6 — Close-all with one summary confirmation

Chip menu "Close all" shows ONE confirm naming the terminal count it will kill (reuses
the kind-aware language); on accept, sends kill per member. No new protocol.

## Risks / Trade-offs

- **[Contiguity vs concurrent clients]** → last-writer-wins + normalization means a
  racing reorder can only produce a VALID (possibly surprising) order, never a
  fragmented group. Accepted for a personal tool (same trade as tab-reorder).
- **[Strip complexity creep]** → chips are render-only entries; all mutation flows stay
  in App via the existing callback pattern. SessionTabs stays presentational.
- **[Collapsed group hiding the URL-active tab on load]** → boot runs the same
  auto-expand guard (active tab's group is force-expanded before first paint of the
  strip).
- **[DnD ambiguity at group edges]** → deliberate: interior joins, edges don't; the
  insertion indicator renders in the GROUP color when the drop would join, plain accent
  otherwise — the user sees the outcome before releasing.

## Migration Plan

Additive protocol + persistence fields; tabs.json without `groups` loads as today.
Old server + new client: group ops ignored, UI simply never shows groups (sessions has
no groups field → empty). Deploy = the usual build + service restart. Rollback = revert;
persisted `groups`/`groupId` fields are dropped by the old parser harmlessly.

## Refinement Session 1 Decisions (2026-07-14)

Six-agent + codex analysis (5 critical, 25 important, 11 minor gaps). User answered 3
product questions; the rest were self-resolved from the codebase / best practice. Full
data shapes and algorithms live in `docs/` (authored before implementation, task 0).

### D1.1 — Join/leave wire contract [Critical; self-resolved]

**Context:** the spec asserted drag-join/leave but D2 said "reorder absorbs it" — false;
`normalizeOrder` partitions by `groupId`, so a plain reorder cannot change membership.
**Decision:** a join/leave drop sends ONE `groupUpdate { id, addIds?|removeIds?, order }`
where `order` is the full desired strip id-order (tab placed at the drop index). The
server applies membership, then order, then `normalizeOrder` — which, being a STABLE
partition, preserves the tab's just-set intra-group position ("lands there"). Single
message → single broadcast → no flicker/race. Chip-block move stays a plain `reorderTabs`
(no membership change). See `docs/dnd-decision-table.md`.

### D1.2 — Persistence: sidecar `groups.json`, `groupId` additive per-tab [Critical; self-resolved]

**Context:** `tabs.json` is a bare `PersistedTab[]` array — you cannot add a top-level
`groups` key without breaking the old parser. **Decision:** per-tab `groupId` is an
additive field IN `tabs.json` (the old selective-copy parser ignores it — rollback-safe);
group name/color live in a SIDECAR `~/.config/palmux/groups.json` = `[{id,name,color}]`.
Members are DERIVED from per-tab `groupId` (not stored twice). Restore drops a `groupId`
whose group is absent from the sidecar. An old server reads `tabs.json` unchanged and
ignores both `groupId` and `groups.json`. See `docs/group-model.md`.

### D1.3 — Auto-expand centralized in one effect [Critical; self-resolved]

Superseded the false "funnels through selectTab" claim (see D3 correction). A single
`useEffect([sessionId, groups])` expands the active tab's group. Covers split re-tile,
boot (groups arrive on the first broadcast → effect re-runs), reconcile, and
close-navigation — all of which bypass `selectTab`. See `docs/collapse-state-machine.md`.

### D1.4 — Group id format + `isGroupId` [Important; self-resolved]

Group ids are `g` + base36 (`/^g[0-9a-z]{5,12}$/`, `isGroupId` in `shared/session-ids.ts`)
— shape-distinct from `isTabId` (`/^(?:0|[1-9]\d{0,3})$/`) so the two id spaces never
collide. The generator regenerates on collision with a live group. The wire parses
validate `groupUpdate.id`/`groupCreate` group ids via `isGroupId` and member ids via
`isTabId` (same 1000-length cap as `reorderTabs`); `TabMeta.groupId` and persisted
`groupId` validate via `isGroupId`.

### D1.5 — Group creation UI: single-tab menu, grow by drag [Critical; USER-DECIDED]

No multi-select is introduced. The tab context menu (`SessionTabs`) gains **"New group
from this tab"** (→ `groupCreate { ids:[thisTab] }`, a valid group-of-one) and **"Add to
▢ <group>"** for each live group (→ `groupUpdate { id, addIds:[thisTab], order }`). A
group grows/shrinks by dragging tabs into/out of its span. A **group of one is valid** —
only an EMPTY group dissolves. To keep a group-of-one growable (it has no drag "interior"),
a drop **on a member tab's center** joins that member's group (Chrome-style hysteresis),
in addition to the between-members interior rule. See `docs/dnd-decision-table.md`.

### D1.6 — Mobile: drawer groups collapse/expand [Important; USER-DECIDED]

The mobile drawer is NOT read-only: group headers are tappable to collapse/expand,
sharing the SAME per-device `localStorage['palmux-collapsed-groups']` set as desktop
(no drag/join on mobile this milestone). The drawer must render grouped members in
broadcast/strip order (NOT numeric-sorted) under their header.

### D1.7 — Group color/name and per-tab color/name are INDEPENDENT [USER-DECIDED]

A grouped tab keeps its OWN color + name AND shows the group's color + name framing —
two deliberate channels (this diverges from Chrome, where a tab surrenders its color;
here it's intentional). The per-tab top accent (`--tab-accent`) and the group cluster
accent (`--group-accent`) are separate CSS layers on one tab (both draw from the 12-slot
`--tab-c-*` palette). Group color, like tab color, is optional; if `groupCreate` omits it
the server assigns a palette default (cycles `TAB_COLORS`) so the chip always has a color.

### D1.8 — "Nearest outside" + collapse refusal + close-all [Important; self-resolved]

- **Nearest outside** (for the active-tab-collapse guard) = `neighborAfterClose`
  semantics over the strip MINUS the group's span: the tab immediately before the first
  member, else immediately after the last. Same feel as close-navigation.
- **Refused collapse** (group is the whole strip) → a `showToast` hint (e.g. "Can't
  collapse — every tab is in this group"); members stay visible. Consistent with the
  existing guarded-action toasts.
- **Close-all** is kind-aware: the single confirm names the terminal count AND warns if
  any member is a dirty editor (reusing the per-tab dirty-editor guard); it never bulk-
  kills a dirty editor without the discard warning.

### D1.9 — Concurrent membership: last-writer-wins [Important; self-resolved]

Two valid ops touching the same tab (client A groups t2 into G1 while B groups it into
G2) resolve last-writer-wins — a tab is in AT MOST one group, so the newest op MOVES it
(steals from the prior group; an emptied prior group dissolves). Same forgiving posture
as `reorder`.

### D1.10 — Chip drag isolation [Minor; self-resolved]

Chip drag uses its own payload `application/x-palmux-group` and its OWN handlers — it
does NOT route through the tab `onDrag`/`dragTabId` path, so `SplitDropZones`/`SlotDropZones`
(gated on React `dragTabId !== null`) never appear during a group drag. A native HTML5
drag threshold distinguishes a chip DRAG (block move) from a chip CLICK (collapse toggle).

## Resolved Open Questions

- **OQ1** (new tab joins active group?) — RESOLVED: no. `[+]`/`tabCreated` stays global
  (creates outside any group), consistent with the tab-reorder append-at-end rule.
- **OQ2** (mobile) — RESOLVED by D1.6: mobile gets collapse/expand (not just read-only).
