## 1. Split display scoping + selection model (D1, D2 — fixes item 4 + tabCreated)

- [x] 1.1 In `App.tsx`, derive `splitShown = !!split && (activeId === split.a.tabId || activeId === split.b.tabId)`; render the two-slot rect layout only when `splitShown`, otherwise render the active tab full-width (panes stay mounted via the rect layer — no remount).
- [x] 1.2 Rewrite `selectTab`: if a split exists and `id` is a member → `focusSlot(thatSlot)` + navigate; if `id` is not a member → navigate only (`setSessionId` + `replaceState`), leaving `split` intact. Remove the `setSlotTab(focused, …)` (Rule R) branch.
- [x] 1.3 Confirm `tabCreated → selectTab(id)` now opens the new tab full-width outside the split (a fresh id is never a member); no separate handler change should be needed.
- [x] 1.4 Audit `useSplit.ts` + `App.tsx` for any path that could yield a nested/third/single slot; confirm the exactly-two-slots invariant holds by construction.
- [x] 1.5 Tests (`useSplit.test.ts` / App-level): selecting a non-member preserves the split; returning to a member re-tiles with the correct focused slot; `[+]`/`tabCreated` while split creates an outside tab and leaves `(a|b)` unchanged; killed-member collapse (existing `seenTermIds` behavior) still works.

## 2. Explicit drag-onto-slot replacement (D3 — item 4 replace gesture)

- [x] 2.1 Extend `SplitDropZones.tsx` (or add per-slot drop targets) so that while a split is active, dropping a strip tab onto a slot calls `setSlotTab(slot, ref)` and focuses that slot.
- [x] 2.2 Verify no-op when the dropped tab equals the other slot's tab (dedup already in `setSlotTab`); confirm edge-drop-with-no-split still opens a split (unchanged).
- [x] 2.3 Tests: drop `t2` onto slot A ⇒ split `(t2|t1)`, `t0` remains in the strip; drop the other slot's tab ⇒ unchanged.

## 3. Per-slot eject (D4 — item 2)

- [x] 3.1 Add an App-owned per-slot eject overlay positioned by slot rect (mirror `SplitDivider`'s overlay pattern), each control wired to `doCollapse(keep=otherSlot)`; works for every tab kind.
- [x] 3.2 Remove the divider's collapse-to-focused `⧉` control (OQ3 — superseded by per-slot eject); keep the orientation toggle.
- [x] 3.3 `index.css`: style the eject control (small, corner-anchored, `pointer-events` scoped so it never steals terminal clicks).
- [x] 3.4 Tests: eject slot A ⇒ split collapsed, `t1` full-width + active, both tabs still in strip; eject slot B ⇒ `t0` full-width.

## 4. Focused-slot indicator in the tab strip (D5 — item 3)

- [x] 4.1 Pass the two split member ids + the focused member id into `SessionTabs.tsx`.
- [x] 4.2 Render a focused-member accent + unfocused-member "paired" marker when `splitShown`; keep a light paired marker on both members while the split is hidden (OQ1); clear all markers on collapse.
- [x] 4.3 `index.css`: strip focus/paired styling.
- [x] 4.4 Tests: focused indicator on the correct strip item; moves with `focusSlot`; cleared on collapse.

## 5. Mouse-report leak gating (D6 — item 1)

- [x] 5.1 Reproduce the `\x1b[<…M` leak (desktop motion in a mouse-reporting app + the mobile case), logging both `onData` (client→pty) and the `instance.write` (pty→display) path to locate where the bytes render as text.
- [x] 5.2 Fix at the identified origin; guarantee no code path passes SGR mouse-report bytes to `instance.write()`.
- [x] 5.3 Ensure the `onData`/`REPORT_RE` gate in `TerminalPane.tsx` classifies mouse frames as input-only without dropping legitimate mouse input to a reporting app.
- [x] 5.4 Tests: a stream containing `\x1b[<35;94;41M\x1b[<35;96;41M` never renders as text; app-consumed mouse input is still delivered; a sequence split across frames is not partially printed.

## 6. Mobile swipe-scroll under tmux (D7 — item 5)

- [x] 6.1 Reproduce the swipe-scroll misbehavior with tmux + Claude on mobile; determine whether wheel frames reach the app or land in tmux copy-mode, and whether over-scroll comes from `encodeWheel`'s `.repeat(|lines|)`.
- [x] 6.2 Correct the swipe→lines mapping and target cell in `useMobileGestures.ts` / `touch.ts` (send at the touched cell; clamp the frame count).
- [x] 6.3 Preserve the `isMouseReporting ? app-wheel : local-scrollback` fork.
- [x] 6.4 Tests: `encodeWheel`/mapping unit tests (clamped frame counts, correct button/cell).

## 7. Docs + full verification

- [x] 7.1 Update `tips/tips.ts` (eject a slot, drag-onto-slot to replace, tabs now open outside the split).
- [x] 7.2 Update `README.md` + `CLAUDE.md` split-view section (Chrome-like display-scoping model, eject, strip focus indicator).
- [x] 7.3 `yarn typecheck` clean across packages.
- [x] 7.4 `yarn test` green (client + server).
- [x] 7.5 Live-verify on an ISOLATED `:44041` backend (own `PALMUX_CONFIG_DIR`, `PALMUX_NO_AUTH=1`, Playwright): display-scoping, `[+]` outside split, drag-onto-slot replace, per-slot eject, strip focus indicator, mouse-leak gone, mobile swipe-scroll. Do NOT touch prod `:44040`.
- [x] 7.6 `openspec validate split-view-and-terminal-fixes --strict` passes.
