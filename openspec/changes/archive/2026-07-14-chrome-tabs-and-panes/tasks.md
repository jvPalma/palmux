# Tasks — chrome-tabs-and-panes

## 1. Protocol & shared types

- [x] 1.1 Add `TabKind`, `TabMeta`, and the `tabs` field to `SessionsMessage` in
      `packages/shared/src/protocol.ts` (keep `ids`/`titles`); extend `parseServerMessage`
- [x] 1.2 Add `CreateTabMessage` / `UpdateTabMessage` client messages + parsing (forgiving:
      invalid payloads → null, never disconnect)
- [x] 1.3 Extend `ReadyMessage` with `webApps: { name, url, icon? }[]` (default `[]`)
- [x] 1.4 Update `packages/server/src/protocol.test.ts` + shared tests for the new
      messages/fields, including old-client back-compat parsing

## 2. Server — tab registry

- [x] 2.1 Generalize `createSessionRegistry` in `server.ts` into a tab registry: tab records
      `{ id, kind, name?, color?, url? }`, PTY only for `kind: 'terminal'`; keep existing
      terminal semantics (spawn on attach, replay ring, exit) byte-identical
- [x] 2.2 New `packages/server/src/tabs-store.ts`: debounced persist to `<configDir>/tabs.json`,
      boot restore (non-terminal tabs fully; terminal name/color only), corrupt file → empty
- [x] 2.3 Handle `createTab` (lowest free id) / `updateTab` (empty name clears) / `kill` for all
      kinds; broadcast extended `sessions` on every mutation including OSC retitle
- [x] 2.4 Metadata-only WS attach for non-terminal tabs: send ready/settings/extraKeys/
      sessions/fonts, no snapshot/binary; ignore binary input + resize
- [x] 2.5 Add `webApps` to `app-config.ts` (validate name/url; default `[]`) and include in `ready`
- [x] 2.6 Server tests: registry kinds, persistence round-trip + corrupt file, create/update/kill
      wire handling, metadata-only attach, webApps config parsing

## 3. Server — artifact & editor-file routes

- [x] 3.1 `GET /artifacts/<name>` serving `<configDir>/artifacts/` — cookie-gated, IP rules,
      path-traversal-safe (resolved path must stay inside dir; else 404); create dir on boot
- [x] 3.2 `GET/PUT /pane-file?tab=<id>` bound to `<configDir>/notes/<id>.md` — cookie-gated,
      404 for non-editor tabs, GET of missing file → empty 200, PUT capped at `maxUploadBytes`
      (413), atomic write
- [x] 3.3 Route tests (mirroring `upload-route.test.ts` patterns): auth, traversal, caps,
      kind validation

## 4. Client — tab state & wiring

- [x] 4.1 Consume `sessions.tabs` + `ready.webApps` in `App.tsx`; state becomes `TabMeta[]`;
      derive display title (name > OSC title > kind default) in one helper with tests
- [x] 4.2 Add `sendCreateTab`/`sendUpdateTab` to `lib/ws.ts`
- [x] 4.3 Pane switching in `App.tsx`: hide (never unmount) `term-wrap` when active tab is
      non-terminal; skip xterm reset/replay wiring for non-terminal attaches; keep the
      socket-per-active-tab lifecycle for all kinds
- [x] 4.4 New `panes/PaneHost.tsx`: one mounted element per open non-terminal tab, hidden unless
      active (state preservation per D4)

## 5. Client — Chrome tab strip (desktop)

- [x] 5.1 Rewrite `session/SessionTabs.tsx`: Chrome shape (rounded-top, active elevated/joined
      to content, inactive recessed + dividers), kind icon, display title, ✕ on active/hover,
      trailing `+`; remove tap-active-to-kill; terminal-close confirmation stays
- [x] 5.2 Overflow: min tab width, horizontal scroll, active tab scrolled into view; `+` and
      topbar icons always reachable
- [x] 5.3 Color accent rendering (top edge/underline) from the 8-color palette + none
- [x] 5.4 `index.css` for the strip (theme tokens, both light/dark-safe with existing vars)
- [x] 5.5 Component tests: rendering per kind, close flow, precedence of titles, overflow class

## 6. Client — rename & recolor

- [x] 6.1 Desktop inline rename (double-click, Enter/Escape) + right-click context menu
      (Rename, palette, Close) on tabs
- [x] 6.2 Mobile: long-press drawer row → bottom sheet (rename field + palette + close);
      pointerdown convention so the soft keyboard isn't dismissed
- [x] 6.3 Drawer rows show kind icon + color dot + display title (`SessionDrawer.tsx`)
- [x] 6.4 Tests: rename commit/cancel, empty-name clears, color select sends `updateTab`

## 7. Client — web panes

- [x] 7.1 `panes/WebPane.tsx`: sandboxed iframe + slim header (URL display/edit, reload, open
      externally); `updateTab` on URL edit
- [x] 7.2 URL normalization helper (bare host → https://) with tests
- [x] 7.3 Tests: header actions, sandbox attrs, mounted-while-hidden behavior

## 8. Client — dashboard / new-tab page

- [x] 8.1 `panes/DashboardPane.tsx`: primary actions (New terminal / Open URL… / New editor),
      `webApps` section (omitted when empty), user quick links; ≥48px touch targets,
      pointerdown activation
- [x] 8.2 `+` / drawer "New Session" opens the new-tab page (transient — dismiss creates
      nothing); picking an entry sends `createTab` and switches to the new id
- [x] 8.3 Quick links CRUD stored in settings JSON (`SYNCED_KEYS`) — add/edit/remove in place
- [x] 8.4 Pinnable dashboard tab (persistent `dashboard` kind)
- [x] 8.5 Tests: new-tab flow, dismissal, quick-link CRUD sync, webApps rendering

## 9. Client — editor pane

- [x] 9.1 Add `monaco-editor` dep; `panes/EditorPane.tsx` with lazy `import()` (verify vite
      splits the chunk + workers; no CDN references in `dist/`)
- [x] 9.2 Load/save against `/pane-file`; Ctrl+S (preventDefault) + ~2s debounced autosave;
      dirty indicator on the tab; close-dirty confirmation
- [x] 9.3 Keep Monaco model mounted across switches (buffer, cursor, undo history preserved);
      theme Monaco from app CSS vars
- [x] 9.4 Tests: load/save flow, dirty lifecycle, lazy-load boundary (no monaco import in
      main chunk)

## 10. Integration, docs, deploy

- [x] 10.1 `yarn test` + `yarn typecheck` green across packages (291 tests: 177 client + 114 server)
- [x] 10.2 Update `tips/tips.ts` (rename/color gestures, new-tab page) and README (tab kinds,
      webApps config, artifacts dir, notes dir); update CLAUDE.md project notes
- [x] 10.3 Verify old-client compat: WS probe confirms the `sessions` frame carries ids/titles
      (old-client path) alongside `tabs`; metadata-only attach sends no snapshot/binary
- [x] 10.4 `yarn build` + live smoke test on an ISOLATED :44041 backend (Playwright): created +
      renamed + colored terminal/web/editor tabs on desktop AND mobile, restarted the server and
      confirmed tabs.json restore. `service:update` intentionally NOT run (no-deploy constraint —
      the user's production :44040 service is untouched; that step is theirs to run).
