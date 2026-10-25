# ui-rework — apply batch 9 (group 10: state that survives a PWA relaunch)

Batch plan for the OpenSpec change `ui-rework`. Batches 1–8 are in production.

Owner report (2026-10-25), verbatim: "on mobile, eu uso pwa. e ha coisas no estado da pagina que nao
persiste: 1. last selected tab 2. explorer open/close states".

## Diagnosis (measured on the deployed build, isolated :44099, 390×844 mobile emulation, the page
closed and a new one opened in the same context — what an installed PWA does on relaunch)

1. **Last tab — reproduced.** Selected tab 2, relaunched: the app came back on tab 0.
   `session/window-selection.ts` keeps the selection in `sessionStorage` only, which is per browsing
   CONTEXT and ends when the PWA's window is closed (Android kills it freely), so every relaunch is
   "no selection" → the first tab.
2. **Explorer roots — NOT reproduced on the batch-8 build:** HOME collapsed before the relaunch stayed
   collapsed after it (`palmux-explorer-open` = `{"v":1,"open":[]}`). Two remaining explanations: the
   owner's PWA was still running the pre-batch-8 bundle when he looked (it resumes without
   reloading), or he means the FOLDERS opened inside a root, which nothing remembers (batch 8 left that
   out explicitly). This batch makes the folders persist too, so both readings are covered, and the
   owner is told to Reload app.

## Acceptance criteria

### A. The last tab survives a relaunch

- `writeSelection` keeps writing `sessionStorage` as today. A SEPARATE writer stores the device-wide
  `localStorage['palmux-last-tab']` (same `{id, kind}` shape, same `parseSelection`) ONLY when this
  window's selection actually CHANGES (B9-01): App's writer effect (`App.tsx:~636–639`) runs on every
  `tabs` change, and `tabs` is replaced on every `sessions` broadcast (list and title changes), so
  writing the shared key there would let a window that merely received a broadcast overwrite the tab
  another window just selected. App tracks the last `{id, kind}` it stored for the shared key and writes when
  the resolved selection differs from it in id OR kind, AND resolves to a known tab — the "resolves"
  part keeps the delayed case (a just-created tab the broadcast has not delivered yet) writing once it
  appears. The comparison state is cleared when the selected tab disappears or the window enters the
  chooser page (B9-R2-01): otherwise closing the last terminal `0` and creating an editor that reuses
  id `0` would skip the write and leave `{id:'0', kind:'terminal'}` stored, which a relaunch rejects
  on kind. The pop-out writes
  neither.
- `readSelection` returns this window's `sessionStorage` selection when there is one, else the
  device-wide last tab. The resolver is unchanged: the kind check still turns a recycled id into
  "gone" → first tab in strip order.
- This keeps the two-window rule the module exists for: the device-wide value is read only when a
  window has NO selection of its own (a fresh window, a relaunched PWA), so an open window is never
  yanked by another; each window still writes its own `sessionStorage`. A second window opening after
  the first will start on whatever was most recently selected anywhere on this device — documented as
  the intended trade.
- The pop-out writes nothing (unchanged), so it cannot overwrite `palmux-last-tab` either.
- `?new=1` and the legacy `/<id>` boot paths keep precedence over any stored value (unchanged).
- The normative spec changes too (B9-04): `specs/browser-local-tab-selection/spec.md` in this change
  is a MODIFIED delta of "Tab selection is per browser window" (the `localStorage` prohibition and
  "a new window starts clean" are replaced by the fallback rules and scenarios, including a broadcast
  not rewriting the last selection).
- The module's header comment and CLAUDE.md's "The URL is not the session" bullets
  (`sessionStorage, not localStorage`) gain the fallback and why: a PWA's window is a browsing context
  that the OS ends.

### B. Folders opened inside an Explorer root survive too

- A second per-device key, `localStorage['palmux-explorer-expanded']` = `{v:1, dirs: string[]}`
  (absolute, normalised; same forgiving parse and swallowed storage errors as `explorer-open.ts`, in
  the same module), holds the folders expanded by the USER (a folder row toggle).
- **Root loading is separated from folder-row expansion (B9-02).** Today a live open root is put into
  the shared `expanded` set to get it fetched (B8-CODE-02's seeding), and that same set drives the
  folder row of a pin nested in HOME — so on a relaunch, a folder collapsed inside HOME but open as
  its own pinned section would be re-seeded open. Instead, the load effect fetches every live open
  root DIRECTLY (as a root, not as an expanded folder) and the seeding into `expanded` is removed:
  `expanded` holds only user folder expansions (restored from storage, then toggled). A section's
  rows come from `dirs[root]`; a nested pin's folder row inside HOME follows `expanded` only. Test: a
  remount with HOME and `/home/u/project` both open as sections and `project` collapsed inside HOME
  keeps the inner row collapsed while the section lists.
- On mount the stored folders are restored into `expanded`, but a folder is FETCHED only while it is
  visible: under a root in the live-open set (`stored-open ∩ explorerRoots`) and with every ancestor
  between it and that root expanded. A collapsed root or a dormant root's folders cost no request.
- **A stored folder is forgotten only when the Explorer itself deleted it (B9-03, B9-R2-02).** No
  listing signal is proof of absence without a server change (which would need a restart that costs
  every live terminal): the server maps transient failures to 404 (`server/files.ts:~100–115`), and a
  successful parent listing silently OMITS an entry whose `lstat` failed and reports a directory
  symlink with a failed target as `dir:false` (`~59–75`). So listings never prune. The one reliable
  signal is the Explorer's own delete: when `POST /files/delete` reports a path as deleted, that path
  and every stored folder under it are dropped from `expanded` and storage. Everything else stays,
  and the 200-entry cap bounds stale records. Tests: a delete drops the folder and its descendants; a
  404 on the folder's own listing keeps it; a parent listing that omits it (lstat failure) keeps it; a
  parent listing reporting it `dir:false` (symlink target failure) keeps it.
- Collapsing a folder removes it from storage; descendants stay stored (re-expanding the parent brings
  its open children back, as VS Code does).
- Bounded: at most 200 stored folders, oldest dropped first on write.
- B8 invariants hold: the open-roots key, first-run HOME, no pruning of the open set, the live
  intersection for rendering/loading/polling, `pin()` → `[newRoot]` (pin still opens the new section;
  it no longer needs to add the root to `expanded`), and the nested-pin collapse rule.
- CLAUDE.md's Explorer paragraph: "Folders expanded INSIDE a root are not remembered" becomes the new
  rule (key, visibility-gated fetch, 404 drop, cap).

## Cluster

One builder (`claude-sonnet-5-5`, xhigh): `session/window-selection.ts` + its test, `App.tsx` +
`App.test.tsx` (the selection writer effect only), `panes/explorer-open.ts` + its test, `panes/FileTree.tsx` +
`FileTree.test.tsx`, `CLAUDE.md` (the two paragraphs named above).

## Non-goals

- Syncing either value across devices.
- Restoring scroll positions, the drawer's open view, or the dock view (not reported).

## Verification

- `yarn typecheck`, `yarn lint` (0 errors), `yarn test`.
- Tests — A: fresh `sessionStorage` + stored last tab → that tab; both present → the window's own; a
  stored last tab of the wrong kind → first tab; pop-out writes neither; a throwing storage still
  boots; a `sessions` broadcast (title change) after a selection does NOT rewrite `palmux-last-tab`; a
  created tab that resolves only on the next broadcast is written once it resolves. B: a stored folder under an open root is fetched and shown after remount; one under a
  collapsed root is not fetched until the root opens; the B9-03/B9-R2-02 delete-drop and keep cases;
  the B9-R2-01 close-last → recreate-same-id-other-kind case (with a tab reordered before it, then a
  relaunch); the B9-02 remount
  case; collapse removes it; the cap; the B8 suite stays green (realign only assertions that read
  `expanded` for roots, never behaviour).
- Isolated smoke (`PALMUX_HOST=127.0.0.1`, `"host":"127.0.0.1"`, port 44099, `command ss -ltnp`,
  client built into /tmp), mobile 390×844 with CDP touch: select tab 2, open a folder inside HOME in the
  drawer's Explorer, close the page, open a new one in the same context → tab 2 is active and the
  folder is open.
