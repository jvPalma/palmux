## 1. Server order model (D1, D2)

- [x] 1.1 Registry (`server.ts`): add `order: string[]` built from the `store.load()` iteration; replace `sortedIds()` with `orderedIds()` mapping over `order`; append to `order` on every NEW `tabs.set` (spawn-on-attach `get`, `createTab`); filter `order` on every delete (kill, exit handler).
- [x] 1.2 Registry: add `reorder(ids: string[]): boolean` — forgiving permutation per D2 (known ids only, dedup, omitted known ids appended in prior relative order), then `persist()` + `listChanged()`; no-op (return false) when the result equals the current order.
- [x] 1.3 Verify `persist()`/restore round-trips order via the `tabs.json` array (no store format change) and that `nextFreeId` behavior is unchanged (order-independent lowest-free).
- [x] 1.4 Server tests (`tabs-registry.test.ts`): append-on-create with a recycled low id; reorder happy path; malformed reorder (unknown ids / dupes / omissions) never loses or duplicates a tab; order survives store round-trip.

## 2. Wire protocol (D3)

- [x] 2.1 `shared/protocol.ts`: add `ReorderTabsMessage { type: 'reorderTabs'; ids: string[] }` to the client→server union; parse with `isTabId` guards + length cap; keep `sessions` untouched.
- [x] 2.2 `server.ts` ws switch: `case 'reorderTabs'` → `registry.reorder(msg.ids)` (any socket kind, like `kill`).
- [x] 2.3 `lib/ws.ts`: `sendReorderTabs(ids)` helper.
- [x] 2.4 Tests: protocol parse (valid / invalid ids / non-array); ws bridge test — a `reorderTabs` frame changes the next `sessions` broadcast order (`ws-tabs.test.ts`).

## 3. Strip renders broadcast order + reorder DnD (D4, D5)

- [x] 3.1 `SessionTabs.tsx`: drop the numeric sort — `list` = broadcast order with a not-yet-broadcast current id APPENDED.
- [x] 3.2 `SessionTabs.tsx`: strip-drag insertion index (dragover vs tab midpoint), insertion-indicator rendering, drop → `onReorder(id, index)`; trailing strip area drops append; replace the `onDropToStrip` prop with `onReorder`.
- [x] 3.3 `App.tsx`: `doReorder(id, index)` — optimistic `setTabs` move + `sendReorderTabs(fullIdList)`; DELETE the strip-drop collapse handler (gesture retired per user decision; ⏏ eject remains).
- [x] 3.4 `index.css`: insertion indicator (2px accent bar in the tab gap, Chrome-style).
- [x] 3.5 Tests: `SessionTabs.test.tsx` — renders broadcast order (no sorting), appends unbroadcast current, drop between tabs fires `onReorder` with the right index; `App.test.tsx` — optimistic reorder updates the strip and sends the full id list; dropping a split member on the strip reorders WITHOUT collapsing the split (regression for the retired gesture).

## 4. Docs + verification

- [x] 4.1 `tips/tips.ts` + `README.md` + `CLAUDE.md`: strip drag = reorder; remove the drag-back-to-strip collapse sentences; note order is shared + persisted.
- [x] 4.2 `yarn typecheck` clean; `yarn test` green across packages.
- [x] 4.3 Live e2e on an ISOLATED `:44041` backend (own `PALMUX_CONFIG_DIR`, `PALMUX_NO_AUTH=1`; never prod `:44040`): reorder via drag with indicator; recycled-id append; order survives server restart; second client sees the order; split member reorder leaves the split tiled; edge-split + slot-drop gestures still work.
- [x] 4.4 `openspec validate tab-reorder --strict` passes.
