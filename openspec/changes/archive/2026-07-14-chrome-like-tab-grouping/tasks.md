## 0. Contract docs (author BEFORE implementing — the coder reads these once)

- [x] 0.1 `docs/group-model.md` — TS shapes, `isGroupId`, sidecar `groups.json` + additive per-tab `groupId`, the `normalizeOrder` algorithm + worked examples (test oracle for 1.4).
- [x] 0.2 `docs/collapse-state-machine.md` — the exact App.tsx setSessionId call sites, the ONE centralized auto-expand effect, `nearestOutside`, refusal toast, boot, prune-on-broadcast, mobile parity.
- [x] 0.3 `docs/dnd-decision-table.md` — chip render-index model, the drop→outcome→wire table, group-of-one center-drop rule, chip-block payload, optimistic updates.

## 1. Server group model (D1, D1.2, D1.4, D1.9)

- [x] 1.1 `shared/session-ids.ts`: `isGroupId` (`/^g[0-9a-z]{5,12}$/`) + a group-id generator that regenerates on collision with a live group id.
- [x] 1.2 Registry (`server.ts`): `groups: Map<id,{name?,color}>` + `TabRecord.groupId`; `normalizeOrder(order, groupIdOf)` (stable contiguity partition per group-model.md) run after EVERY mutation incl. `reorder()`, `createTab`, `kill`; empty groups auto-removed. Thread `groupId` through TabRecord / restore loop (drop-if-group-missing) / `persist` / `tabs()` broadcast / `createTab` / `updateTab`.
- [x] 1.3 Registry ops: `groupCreate(ids, {name?,color?})` (assigns id; default color from `TAB_COLORS` when omitted; valid group-of-one; empty ids = no-op) and `groupUpdate(id, {name?,color?,addIds?,removeIds?,dissolve?,order?})` — all forgiving (unknown ids ignored; a tab joining leaves its prior group; last-writer-wins), applying membership THEN `order` THEN normalize, then persist + broadcast.
- [x] 1.4 `tabs-store.ts`: add additive `PersistedTab.groupId`; add a sidecar `createGroupsStore(dir)` (`groups.json`, same atomic/debounce/forgiving pattern); restore drops a `groupId` whose group is absent. Old-server back-compat: `tabs.json` shape unchanged.
- [x] 1.5 Server tests: `normalizeOrder` (the group-model.md examples incl. a reorder trying to fragment); group-of-one lifecycle; empty-group removal; join-steals-from-prior-group; restart round-trip (groupId + sidecar); `tabs.json`-without-groups loads clean; malformed ops inert; kill-member updates/removes.

## 2. Wire protocol (D2, D1.1)

- [x] 2.1 `protocol.ts`: `TabGroup`, `SessionsMessage.groups` (default `[]`), `TabMeta.groupId?`; `GroupCreateMessage` + `GroupUpdateMessage` (incl. `order?`); parses per the validation matrix (member ids `isTabId` ≤1000, group ids `isGroupId`); `parseTabMeta`/`parsePersistedTabs` validate/drop `groupId` via `isGroupId`.
- [x] 2.2 `server.ts` ws switch cases for both messages; `lib/ws.ts` `sendGroupCreate`/`sendGroupUpdate` helpers.
- [x] 2.3 Tests: protocol parse matrix (valid/invalid group id, member-id cap, order); ws bridge — a `groupCreate` then a join `groupUpdate{addIds,order}` reflect in `sessions` (groups + memberships + contiguity + intra-group position).

## 3. Strip UI: chips, clusters, collapse, creation (D4, D3, D1.3, D1.5, D1.6, D1.7, D1.8)

- [x] 3.1 `SessionTabs.tsx`: interleave a chip element before each group's first VISIBLE member WITHOUT shifting the tab-index math (chips are non-tab siblings; `dropIndex` stays a `list` index); cluster framing via `--group-accent` (own `--tab-c-*` var) as a SEPARATE layer from the per-tab `--tab-accent` (both shown — D1.7); collapsed group renders chip + member-count only.
- [x] 3.2 Chip context menu: rename (inline), 12-color recolor swatches, Ungroup (members stay, keep own colors), Close-all. Tab context menu gains "New group from this tab" + "Add to <group>" per live group.
- [x] 3.3 Collapse view state `localStorage['palmux-collapsed-groups']` (forgiving parse; pruned each broadcast); chip click toggles with the active-tab guard (activate `nearestOutside` first; refuse-with-toast when the group is the whole strip).
- [x] 3.4 App: the ONE centralized auto-expand `useEffect([sessionId, groups])` (per collapse-state-machine.md — NOT in selectTab); group-op callbacks → ws helpers; close-all single confirmation that is KIND-AWARE (names terminal count, warns on any dirty editor member, never bulk-kills a dirty editor silently).
- [x] 3.5 `SessionDrawer.tsx`: tappable group headers that collapse/expand (shared per-device set); grouped members render in strip order under their header (do NOT numeric-sort grouped members).
- [x] 3.6 `index.css`: chip pill, cluster underline (`--group-accent`), collapsed chip/header badge — coexisting with the per-tab top-accent, ◧/◨ split badges, dirty dot, and the reorder insertion bar (verify no channel collision, as in theme-and-tab-accents).
- [x] 3.7 Tests: chips at first-member positions; per-tab color + group color both present on a member; collapse filters members (chip stays); active-tab collapse guard + refusal toast; centralized auto-expand fires on a setSessionId path that bypasses selectTab (e.g. split re-tile); ungroup keeps tabs+colors; drawer headers collapse; SessionTabs stays presentational (callbacks only).

## 4. Drag gestures (D5, D1.1, D1.10)

- [x] 4.1 Join/leave by drop per the decision table: interior/center-drop → `groupUpdate{addIds,order}`; edge/leave → `groupUpdate{removeIds,order}` or plain `reorderTabs`; insertion indicator colored by outcome (group color = will-join). Optimistic groupId patch on drop.
- [x] 4.2 Chip-block drag (`application/x-palmux-group`, its OWN handlers, does NOT set `dragTabId` so split/slot zones stay hidden): composes one `reorderTabs` block move (optimistic block relocate); native drag threshold separates chip-click from chip-drag. Strip drop handlers accept BOTH `TAB_DND_TYPE` and the group type.
- [x] 4.3 Tests: interior-drop joins at position; center-drop grows a group-of-one; edge-drop leaves; block move preserves inner order; a group drag shows NO split/slot zone; split pairing + display-scoping unaffected by a member's membership change (App-level regression).

## 5. Docs + verification

- [x] 5.1 tips + README (create/rename/collapse/drag; two-color channels; mobile collapse) + CLAUDE.md model paragraph.
- [x] 5.2 `yarn typecheck` + `yarn test` green.
- [x] 5.3 Live e2e on isolated `:44041` (never prod): create-from-tab + add-to-group, contiguity pull-together, group-of-one grow-by-center-drop, collapse/expand (+ active-tab guard + refusal toast), auto-expand via back/forward AND split re-tile AND close-nav, join/leave/chip-block drags, second-client sync, restart persistence (sidecar), close-all with a dirty editor, mobile-drawer collapse. Screenshots per theme-aware chip color.
- [x] 5.4 `openspec validate chrome-like-tab-grouping --strict`.
