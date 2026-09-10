## 1. Tooling gate (introduce Oxlint + Oxfmt — D1)

- [x] 1.1 Add `oxlint` + `oxfmt` as root dev-dependencies (yarn); do NOT add `eslint`/`prettier`/`@oxlint/migrate`.
- [x] 1.2 Author `.oxlintrc.json`: `$schema` pinned; categories `correctness`(error) + `perf`(error) + `suspicious`(warn); rule sets `react`, `react-perf`, `import`, `unicorn`; `ignorePatterns` for `dist`/`bin`/`node_modules`.
- [x] 1.3 Author `.oxfmtrc.json`: `tabWidth:2`, `semi:true`, `singleQuote:true`, `jsxSingleQuote:false`, `trailingComma:"all"`, `printWidth:100`; ignore `dist`/`bin`.
- [x] 1.4 Add root scripts: `lint` (`oxlint`), `lint:fix` (`oxlint --fix`), `format` (`oxfmt --write`), `format:check` (`oxfmt --check`).
- [x] 1.5 Land the one-time repo-wide `oxfmt --write` reflow as an ISOLATED change, separate from every refactor below (keeps behavioral diffs reviewable).
- [x] 1.6 Triage the initial `yarn lint` backlog: fix `correctness`/`perf` hits; scope other categories to `warn` where a clean sweep isn't immediate. (`performance-lint-rules` is N/A — its analog is the `perf`+`react-perf` rules enabled in 1.2.)

## 2. Re-render hygiene — shared root cause: no `React.memo` + hot state at App root (P1, P3, P4, P7)

- [x] 2.1 Extract a `<Toast>` component owning its own state via a ref/emitter; stop routing `toast` through the App root so copy-on-select stops re-rendering the strip (P4 — `App.tsx:168-174,1162`).
- [x] 2.2 Localize the live divider ratio to the split container (drive the two pane rects + divider from a scoped context/imperative), so `dragRatio` no longer re-renders `SessionTabs`/`PaneHost`/`ExtraKeysBar`/panes every rAF frame (P1 — `App.tsx:158,831-840`).
- [x] 2.3 `useMemo` the `SessionTabs` `split` summary object and pass the already-stable `doSplit` directly (drop the inline arrow) (P3 — `App.tsx:899-933`).
- [x] 2.4 `useMemo` `paneRects`; wrap `PaneHost` (and, once props are stabilized, `SessionTabs`) in `React.memo` so they bail on unrelated App re-renders (P7 — `App.tsx:842-847`, `PaneHost.tsx:64`).
- [x] 2.5 Verify no behavior change: `yarn typecheck` + `yarn test` green; spot-check the divider drag + copy-on-select in the isolated dev server.

## 3. Hot-path O(n²) fixes + shared order model (P2, P5, A2)

- [x] 3.1 In `SessionTabs` strip render, build `groupById = new Map(groups.map(...))` once and derive `tabIndex` from a running counter instead of `visibleTabs.indexOf` / `groups.find` (P2 — `SessionTabs.tsx:351,356`).
- [x] 3.2 Compute one `Map<id,groupId>` per operation and pass a `(id)=>map.get(id)` accessor into `nearestOutside` / `moveGroup` / `decideGroupDrop` (P5 — `App.tsx:446,468`, `tab-groups.ts:75-110`).
- [x] 3.3 Move `normalizeOrder(order, groupIdOf)` and `applyForgivingOrder(order, ids, known)` into `@palmux/shared` as pure functions; have the server `SessionRegistry` and the client optimistic layer (`addToGroup`/`moveGroup`/`doReorder`) both call the ONE definition, ending the hand-rolled client re-prediction (A2 — `server.ts`, `App.tsx:358-485`).
- [x] 3.4 Add unit tests for the shared order functions (the contiguity + forgiving-permutation oracle now has a real interface).
- [x] 3.5 `yarn typecheck` + `yarn test` green.

## 4. Composition: decompose the App.tsx rendering + group state (C1, C2, C3, C4, C5, C6, C7)

- [x] 4.1 Extract `useTabGroups(tabs, sessionId, send)` — colocate `collapsedGroups` state, the persist + auto-expand effects, the prune-on-broadcast logic, and the 9 group handlers; App consumes the returned `{ groups, collapsed, toggle, newGroup, addTo, remove, rename, recolor, dissolve, closeAll, move }` (C3 — `App.tsx` group subsystem).
- [x] 4.2 Introduce a grouping provider/interface consumed by BOTH `SessionTabs` and `SessionDrawer` (exposing `groups`/`collapsed`/`toggle` and the memoized `strip`), collapsing SessionTabs' 24-prop surface and removing the double `buildStrip` (C1 + C5 — `SessionTabs.tsx:38-77`, `SessionDrawer`).
- [x] 4.3 Extract a `<SplitView split=… registry=…>` compound owning slot geometry, `TerminalPane` slots, `SplitDivider`, the eject overlays, and the drop zones — moving ~230 lines out of App's render (C2 — `App.tsx:826-1058`). Composes with 2.2.
- [x] 4.4 Collapse `TerminalPane`'s 5-callback mobile-gesture bundle into one `gestures={…}` object and derive `inSplit`/`focused` from the registry seam (C4 — `TerminalPane.tsx:22-50`).
- [x] 4.5 Give `SessionDrawer` a single `actions={…}` object (or render the footer as `children`) instead of 5 flat callback props (C6 — `SessionDrawer.tsx:20-41`).
- [x] 4.6 Split `DashboardPane` into `<NewTabChooser onClose onPin>` and `<DashboardTab>` sharing a `<DashboardBody>`, so each of App's 3 mount sites passes only the props it uses (C7 — `DashboardPane.tsx:25-37`).
- [x] 4.7 After each extraction: `yarn typecheck` + `yarn test` green; add direct unit tests for the newly-testable hooks/components (e.g. `useTabGroups`).

## 5. Architecture: extract the workspace navigation controller (A1, A3, A4, A5)

- [x] 5.1 Author a pure `workspaceController` reducer `reduce(state, event) → { state, effects }` over `{ sessionId, split, seenTermIds, chooserPage }`, with declarative effects (`Navigate{id,replace}`, `ClearSplit`); cover `SelectTab | PopState | TabCreated | SessionsBroadcast | OpenSplit | DropSplit | DropSlot | Eject` (A1).
- [x] 5.2 Fold the recycled-id hazard into a `freshSlotId(exclude, seenSet)` used by the controller (was inlined 3× in doSplit/doDropSplit/createTab) (A3 — `App.tsx:296-339,626-629`).
- [x] 5.3 Fold the `history.replaceState(…)+setSessionId` pair into the controller's single `Navigate{id,replace}` effect application (was ~7× ad hoc) (A4).
- [x] 5.4 Move the `sessions`-handler prune loops behind `reconcileClientState(prev, broadcast)` (or a `pruneToLive(map, liveKeys)` util); close-nav becomes a controller event (A5 — `App.tsx:519-575`).
- [x] 5.5 Replace the full-`<App>`-render invariant assertions with direct `reduce()` unit tests where equivalent; keep the integration tests that still add value.
- [x] 5.6 `yarn typecheck` + `yarn test` green; behavior-parity confirmed on a live isolated server (split re-tile, close-nav, back/forward, tabCreated).

## 6. Lower-priority / speculative (only if cheap and clearly net-positive)

> **Deferred at archive (2026-07-23):** 6.2 / 6.4 / 6.5 left undone by decision — 6.2/6.4 are
> low-value polish and 6.5 is explicitly speculative (apply only if the deletion test still favors
> it). Carried forward as follow-ups, not blockers.

- [x] 6.1 P8: pass `{ passive: true }` to the visualViewport `resize`/`scroll` listeners (`App.tsx:815-816`).
- [ ] 6.2 P9: add a version field to the `palmux-split` / `palmux-collapsed-groups` / settings localStorage payloads (parsers already forgiving).
- [x] 6.3 P6: collapse `MarkdownPane`'s `browsing`-from-`path` effect to a prev-path ref check during render (`MarkdownPane.tsx:45-47`).
- [ ] 6.4 C8: replace `PaneHost`'s 4-branch `kind` switch with a `kind→component` registry + a small `PaneChromeContext` for `onMenu` (`PaneHost.tsx:83-110`).
- [ ] 6.5 A6/A7 (evaluate, don't force): consider collapsing `WsClient`'s 9 `sendX` wrappers to one `send(msg)`; consider excluding pane data sockets from control broadcasts server-side. Both Speculative — apply only if the deletion test still favors them after 3–5 land.

## 7. Verification & close-out

- [x] 7.1 `yarn lint` and `yarn format:check` clean across the workspace. (0 errors — remaining `react-perf` hits are the `warn`-scoped category from 1.2; `format:check` clean on 332 files.)
- [x] 7.2 `yarn typecheck` + full `yarn test` (500+ tests) green — no behavior change anywhere.
- [x] 7.3 Confirm the archived feature specs still describe actual behavior unchanged (no spec edits needed — these are internal-quality refactors).
- [x] 7.4 `openspec validate codebase-quality-check --strict`.
