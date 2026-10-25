# ui-rework — apply batch 4 (group 5: the mobile drawer)

Batch plan for the OpenSpec change `ui-rework`.

**Contracts:**
- spec `mobile-drawer`, all eight requirements
- spec `ui-primitives`: "Rows entering or leaving a list transition", and the motion tiers
- `design.md` §4 (keyboard hold) and §5 (tree port)
- `tasks.md` 5.1–5.9

The owner is asleep, with a standing instruction to keep going through the openspec. Batches 1–3 are
in the tree, uncommitted.

## 5.1: the spike, decided without the device

Task 5.1 asked for a spike on the S26: does HTML5 `draggable` long-press drag start, does the list
still scroll, does `contextmenu` fire? adb has been disconnected since the network outage, so the
spike cannot run tonight.

**Decision: drive the drag with pointer events.** This is design §5's specified fallback, and it is
the safer of the two paths:

- The drawer already owns its touch gestures (`rowDown`/`rowMove`/`rowUp`, `SessionDrawer.tsx:~241`).
- HTML5 drag would compete with them, with the list's pan, and with the long-press menu.
- The pointer path works the same whether or not Chrome for Android starts an HTML5 drag.

The coordinator records this in design.md §5. Running the spike on the device afterwards stays a
follow-up for the owner. The tree MODEL is shared by both input layers, so if the spike later shows
HTML5 drag works, only the input layer changes.

## Acceptance criteria

### A. The ported tree model (5.4)

New `session/drawer-tree.ts`, pure, with no React: a port of the DGSL TreeView model
(`~/dgsl/design/ds/src/ui/TreeView/rows.ts`, `types.ts`, and the drop maths in `TreeView.tsx`
~210–260).

**Nodes:**
- group nodes, from `groups`: `value = 'g:<gid>'`, with `children` = the member tabs in full order
- tab leaves: `value = 't:<id>'`
- top-level tabs in full order

**Functions:**
- `toRows(nodes, expanded)`
- `ancestorsOf`
- `siblingsOf`
- `dropAt(rect, clientY, target, isGroup)`. Over a tab row, the top half drops `before` and the
  bottom half `after`. Over a GROUP header, the top quarter drops `before` (the group), the bottom
  quarter `after`, and the middle `inside`.
- `accepts(dragged, drop)`. It refuses a drop on itself, a group into itself or its descendants,
  and the place it already is. A group cannot go inside a group (one level only).
- `resolveDrop(fullOrder, membership, dragged, drop)` returns `{ order: string[],
  membership change: {addTo?: gid, removeFrom?: gid} }`:
  - `before`/`after` a tab: the dragged tab takes that tab's parent, its group or top level.
  - `inside` a group: it is appended as that group's LAST member.
  - A dragged group moves as a block, before or after a top-level node.
  - The result order is passed through the shared `normalizeOrder`, so it equals what the server
    will broadcast.
  - **Root space and group headers (review B4-R4):**
    - A `{ target: null, position: 'inside' }` drop (the root) moves the tab to the END of the top
      level and removes it from its group.
    - A tab dropped `before` / `after` a group HEADER lands as a TOP-LEVEL node immediately before or
      after that whole group block, leaving its own group if it had one.
    - The UI keeps a permanent root drop area below the last row, at least one row tall, visible and
      labelled "Drop here to ungroup" only while dragging. So a root target exists even when EVERY
      tab is grouped, as in the DGSL TreeView (`TreeView.tsx:84–85`, `485–491`).

**Proof.** `session/drawer-tree.test.ts` ports the DGSL TreeView behaviour tests that apply:
- no self, descendant or same-place drop
- before/after quarters, middle inside
- reorder within a group
- join via a header
- leave by dropping among top-level rows
- group block moves
- normalization (the result is contiguous)
- an all-grouped list: a drop on the root area ungroups the tab
- leaving the only group: its last member dropped on the root
- a tab before and after a group header (top-level placement)

### B. One drawer close path and the keyboard hold (5.2)

In `App.tsx`:

**Hold:**
- The viewport effect's `deferred` flag (`App.tsx:~1380`, which today means "a native selection
  holds the layout") is generalized to "the layout is held".
- It is set while a native selection is live OR while the drawer is open. The open state reaches
  the effect through a ref, so the effect does not re-subscribe.
- While held, viewport events change nothing: no `--app-height` write, no refit.

**Open:**
- Record `kbdWasUp`: `#mobile-kbd` is focused AND the pinned height is below the screen height by
  more than `KEYBOARD_GONE_PX`.
- The drawer NEVER blurs `#mobile-kbd` itself.

**Close:** one `closeDrawer()` is used by EVERY close path:
- the scrim
- the back controls
- choosing a tab (switch)
- creating a tab
- opening a file from the drawer's Explorer
- an upload / download / dictate / images action
- `onTabMenu`
- every `setDrawerOpen(false)` at `App.tsx:~1782–1831`

On close, it runs the selection hold's existing release path: if `kbdWasUp`, re-raise first
(`kbdRaiseRef.current()`), then re-pin through the `KEYBOARD_RETURN_MS` fallback; else re-pin
immediately. This costs at most one resize per attached PTY.

**Native pickers keep the hold until they return (review B4-R2).** Upload and Images close the drawer
and open a file picker (`SessionDrawer.tsx:~482`, `~519`; `terminal/useFileUpload.ts:~218–247`), and
the picker may dismiss the IME. Dismissing the drawer visually is therefore separate from releasing
the layout hold:
- `closeDrawer({ holdUntil: 'picker' })` hides the drawer but keeps the hold and the saved
  `kbdWasUp`.
- `useFileUpload` gains a picker-return signal: the hidden input's `change` and `cancel` events
  (Chrome fires `cancel` on file inputs), plus a `focus` back on `window` as a fallback.
- When the signal fires, `App` runs the release path ONCE: raise the keyboard if it was up, then
  re-pin.
- The `KEYBOARD_RETURN_MS` fallback timer does NOT start while a picker hold is active.
- **Elapsed time never releases the hold (review B4-R2).** Browsing files or taking a photo can take
  minutes, and the spec requires the row count to stay unchanged for the whole picker, so there is
  no 60s timeout. Release requires a COMPLETION signal (`change`) or a CANCELLATION signal
  (`cancel`), or a CONFIRMED RETURN to the app: a `window` `focus` while
  `document.visibilityState === 'visible'`. After a confirmed return, a short grace period (one tick
  plus 300ms) lets a late `change` arrive first. If none does, it is treated as a cancel and the
  hold is released once.
- **The hold is acquired only when a picker actually opens (review B4-R7).** Today
  `guardedOpenPicker` / `guardedOpenImagePicker` (`App.tsx`) only toast when
  `registry.focusedApi()` is null (editor, markdown and web tabs), and `SessionDrawer` calls
  `onClose` BEFORE them, with `DrawerActions` / `PaneApi` returning `void`. So:
  - The picker-opening chain returns whether a picker was launched:
    `PaneApi.openPicker(): boolean`, `DrawerActions.uploadFile(): boolean`,
    `DrawerActions.uploadImages(): boolean`, and the guarded wrappers.
  - The drawer's Upload/Images handlers call the action FIRST.
  - On `true` they call `closeDrawer({ holdUntil: 'picker' })`, acquiring the hold immediately
    before the picker is up.
  - On `false` (a toast, no picker) they call a plain `closeDrawer()`, which releases normally.

Tests:
- a picker open for longer than 600ms keeps `--app-height` unchanged until `change` fires
- a picker open for longer than 60s (fake timers) STILL holds
- `cancel` releases once
- a confirmed return (focus + visible) with no `change` releases once after the grace period
- a `focus` while hidden does not release
- Upload and Images from an editor, markdown or web tab, and with an unavailable input, acquire no
  picker hold and close the drawer normally

**Long-press menu:** `onTabMenu` (long-press → `TabSheet`) no longer closes the drawer. The sheet
opens over it, so after a rename or colour change you are back in the drawer.

**Proof.** App-level tests in the style of the existing "ending a selection with the keyboard up
does not resize twice" suite (`App.test.tsx`):
- no `--app-height` change while the drawer is open and the viewport grows
- on close with `kbdWasUp`, the raise happens before the re-pin, with one height write at most
- on close without `kbdWasUp`, there is no raise and an immediate re-pin
- every close path routes through `closeDrawer` (spot-check: scrim, switch, create, upload)

### C. Drawer layout, scrim and reach order (5.3, 5.8)

`session/SessionDrawer.tsx`, plus the drawer section of `index.css` (~1285–1500) and
`session/drawer-views.css`.

**Width and scrim:**
- **The drawer covers the full HEIGHT and all but a scrim strip (review B4-R3).** It is
  `width: calc(100% - 44px)` from the right edge (drop `min(78vw, 300px)`), still bounded by
  `--app-top`/`--app-height`. That leaves a dimmed 44px scrim strip on the left that hit-testing
  reaches with the keyboard up or down; 44px is the touch-target floor.
- **The root view has its own close control:** a `close` icon button in the drawer's top row, next
  to the Settings button, wired to `closeDrawer()`. Sub-view back controls keep popping their
  sub-view.
- The `mobile-drawer` spec delta is amended: "full-height, leaving a scrim strip at least 44px wide",
  replacing "full-screen".
- The scrim fades opacity 0 → 1 on `--mo-surface`/`--mo-ease` with a shorter exit
  (`--mo-micro`), and takes pointer events only while open. Tapping it closes the drawer through
  `closeDrawer()`.
- The drawer's slide uses `--mo-surface`/`--mo-ease` instead of today's off-tier `0.18s`, again
  with a shorter exit.
- Under reduced motion there is no slide or fade transition.
- The scrim colour comes from the tokens:
  `color-mix(in srgb, var(--t-base) 72%, transparent)`, the same mix the kit Dialog overlay uses.

**Reach order (bottom → top):**
1. the footer actions: Upload, Download, Dictate, Images
2. the view switcher: Sessions, Files, Dictation. It moves from the top to just above the footer
   and keeps the kit Segmented, `keepFocus` and the `hostedViews` contract.
3. the bottom-anchored session list
4. at the TOP: a Settings icon button (`settings` icon, `aria-label="Settings"`), the drawer control
   farthest from the bottom edge

**Unchanged:** the Settings view and the New-tab sub-surface behave as before (back header pops,
`DashboardBody` hosted). Batch 3's theme sub-view lift must keep working.

**Proof.**
- Tests: the Settings button is the first focusable control in DOM order and the switcher sits after
  the list.
- In Playwright at 390×844, the Settings button's `top` is the smallest of all drawer controls and
  the switcher's `bottom` sits above the footer's `top`.
- A real tap (`page.touchscreen.tap`) at x=20 hits the scrim (`elementFromPoint`) and closes the
  drawer, with the keyboard down and with it up.
- The root close button closes it too.
- The scrim and drawer motion rules use tier tokens (stylesheet assertion).

### D. Session rows (5.5)

**Row anatomy:**
- colour dot (`--tab-accent`, neutral `--t-subtext` dot when uncoloured)
- the title
- the tab number as secondary text (`var(--fs-1)`, `--t-subtext`), right-aligned before the row end
- the kind icon (shared `Icon`, `kindIcon()`) for non-terminal tabs only

**What goes:**
- the 34px numbered circle
- the per-row terminal `❯`
- the always-visible ✕ cell (`drawer-kill`)

**Active row:** a raised background (`color-mix(in srgb, var(--t-surface), var(--t-text) 10.5%)`, the
strip's active fill) plus a 3px `--t-accent` left edge. It is never filled with the tab colour.

**Group headers:** they keep their caret, dot, label and count, restyled to the batch-3 section-title
type. Collapse is still a tap.

**Proof.** Tests:
- no `.drawer-num` circle and no `drawer-kill`
- a coloured active row has no colour fill, only the dot
- terminal rows have no kind icon, non-terminal rows do
- the number is rendered as secondary text

### E. Gestures: long-press drag, long-press menu, swipe-left close (5.6, 5.7)

All gestures live in the drawer's existing pointer handlers (no HTML5 `draggable`). They keep
today's rules:
- never `preventDefault` a touch pointerdown, so the list can pan
- activate on pointer UP
- 10px slop

**Long-press:**
- **Arm:** a press held for `LONG_PRESS_MS` (450) without moving more than 10px arms the row
  (subtle `navigator.vibrate?.(8)`).
- **Release without moving:** opens the row menu (`onTabMenu` → `TabSheet`: rename, colour, group
  membership, close, the terminal close keeps its confirm).
- **Taking the gesture from the browser's pan (review B4-R1).** Pointer capture changes targeting;
  it does not stop native scrolling, and a vertical move after the hold would start a pan and emit
  `pointercancel` instead of a drag. Install ONE non-passive `touchmove` listener on the list root
  (`{ passive: false }`, registered in an effect, reading the gesture state from a ref). It calls
  `preventDefault()` ONLY while the press is armed or dragging, so a pre-arm move still pans
  natively. Chrome holds the pan within its touch slop, so the first post-arm `touchmove` is still
  cancelable. Clean up on `touchend` / `touchcancel` / `pointercancel` and on unmount.
- **Moving more than 10px after arming starts a DRAG:**
  - pointer capture on the list
  - the row lifts and follows the finger on `transform` only
  - an insertion line or group highlight shows the resolved drop, using A's `dropAt` / `accepts`
  - the list auto-scrolls when the finger is within 40px of its top or bottom edge
- **Releasing a drag:** commits through B's API (below). A refused drop cancels and nothing moves.

**Other gestures:**
- **Moving more than 10px BEFORE arming:** a scroll or swipe. No menu, no drag.
- **Swipe left:** a dominantly horizontal move left of more than 32px before arming reveals a Close
  action behind the row; the row slides left on `transform` (micro tier). Tapping Close calls
  `onKill(id)`, which is `App.closeTab`, so terminal confirm and editor discard confirm still
  apply. A swipe right, a tap elsewhere, or a scroll hides the action.
- **A plain tap** still switches tab.

**Commit API (`App.tsx`):**
- `moveTabInTree(id, drop)` uses A's `resolveDrop` and sends either `groupUpdate { id, addIds |
  removeIds, order }`, when membership changes, or `reorderTabs(order)`, applied optimistically
  with the same normalized order.
- `moveGroupInTree(gid, drop)` sends `reorderTabs(normalizedOrder)`.
- A no-op (normalized order unchanged and membership unchanged) sends nothing.

These sit beside `doReorder`/`moveGroup`; they do not replace the desktop paths.

**Proof.**
- Component tests driving pointer sequences (down, wait with fake timers, move, up):
  - long-press + move + release before a row → the expected `moveTabInTree` call
  - onto a group header middle → join
  - among top-level rows → leave
  - long-press + release → menu
  - pre-arm move → no menu, no drag
  - swipe-left + tap Close → `onKill`
  - swipe-right hides the action
- App-level tests: `moveTabInTree` emits the right messages for join, leave and reorder, and sends
  nothing for a no-op.
- **Native touch arbitration is verified with REAL touch input:** in the smoke, CDP
  `Input.dispatchTouchEvent` (touchStart, a 500ms hold, touchMove steps, touchEnd) drives the
  browser's own scroll arbitration, which synthetic pointer sequences skip. The check asserts the
  drag completes (order changed) and the list did not scroll. A control check without the hold
  asserts the list DOES scroll.

### F. Row enter and exit (5.8, ui-primitives)

**Mechanism.** A small hook, `ui/useLeavingItems.ts`, keeps a removed item rendered for `--mo-micro`
with a `leaving` class, then drops it. Each row sits in a wrapper that animates its OWN occupied space
with the same `grid-template-rows: 1fr ↔ 0fr` technique the kit Collapsible uses, together with
opacity (review B4-R5). The space collapses with the fade, so the rows below glide up instead of
jumping when the item finally unmounts.
- **Enter:** `0fr → 1fr` plus opacity.
- **Exit:** `1fr → 0fr` plus opacity.
- **The FIRST render of a list does not run the micro enter.** It follows the existing first-render
  stagger tier (380ms + 40ms per item, `--mo-enter`), or none if the list is restored from state.
  Only subsequent insertions use `--mo-micro`.

Transitions, not keyframes, so an interrupted change retargets. Under reduced motion there is
neither. Used by the drawer session list and the Explorer tree rows (`panes/FileTree.tsx`, whose
deletions are the common exit).

**Proof.**
- Hook tests with fake timers: a removed key stays for the duration with `leaving`, then
  disappears; a re-added key cancels the leave.
- The drawer and FileTree each render a leaving row in a test.
- A stylesheet test asserts that the wrapper transitions `grid-template-rows` and opacity on
  `--mo-micro`.
- In the smoke, sampling the next row's `getBoundingClientRect().top` during a close shows
  intermediate values, a glide rather than a single jump.
- A first-render test asserts no micro enter class on the initial rows.

### G. Scale migration and docs (5.9)

- The drawer CSS (`index.css` drawer section, `session/drawer-views.css`) moves to the scale. Lower
  the baselines to the exact counts; nothing rises.
- `--mbtn-h` (30px) is off-grid. Drawer controls take `var(--ctl-h)`, which is 36px in mobile mode.
  That includes CONTROLS HOSTED in the drawer (review B4-R6). The kit Button, IconButton and Input
  fall back to `var(--mbtn-h, 30px)` (`ui/ui.css:70–77`, `157–163`, `233–234`), so the drawer gets
  scoped overrides that set those controls' `min-height` / `height` to `var(--ctl-h)` inside
  `.drawer`: `.drawer .ui-btn`, `.drawer .ui-icon-btn`, `.drawer .ui-input` and the kit Select
  trigger. Settings is already covered by batch 3's `.settings-form` overrides.
- The goal is narrowed to what is true: `--mbtn-h` stays defined for the extra-keys bar AND as the
  kit's documented fallback outside the drawer. Its other consumers are listed in the report, not
  hidden.
- **Proof.** In Playwright at 390×844, the computed height of hosted controls (the Settings Theme
  button, a New-tab Button, the Explorer filter input) equals 36px.
- CLAUDE.md: rewrite only the drawer paragraphs:
  - "The mobile drawer (`SessionDrawer.tsx`)…"
  - the row anatomy / number chip
  - the `--mbtn-h` sizing
  - the footer layout
  - the "+ New tab" sub-surface wording where it moved
  - the keyboard/drawer relationship

  Add the new gestures and the keyboard hold. Preserve every unrelated paragraph byte for byte.
- `tips/tips.ts`: add tips for long-press drag (reorder / regroup), long-press menu, swipe-left
  close, and the top Settings button. Update the tips that mention the ✕ cell or the old switcher
  position. The tips test covers them.

## Approach and clusters (sequential where files are shared)

1. **C1 (model + hook), first:** new `session/drawer-tree.ts` (+ test), new
   `ui/useLeavingItems.ts` (+ test).
2. **C2 (App), after C1:** `App.tsx` (viewport hold generalization, `closeDrawer` including
   `holdUntil: 'picker'`, `onTabMenu` behaviour, `moveTabInTree` / `moveGroupInTree`, the
   boolean-returning guarded picker wrappers, passing the new props to SessionDrawer),
   `App.test.tsx`, and the picker chain: `terminal/useFileUpload.ts` (picker-return signal plus a
   boolean launch result), `session/SplitFocusContext.ts` (the `PaneApi.openPicker` return type),
   and `terminal/TerminalPane.tsx` (only where it implements `openPicker`), with their tests.
3. **C3 (drawer UI), after C2:** `session/SessionDrawer.tsx` (+ test), `session/TabSheet.tsx` only if
   needed, the drawer section of `index.css`, `session/drawer-views.css`, and `ui/scale-baseline.json`
   (its own keys).
4. **C4 (Explorer leaving rows), in parallel with C2/C3 (disjoint files):** `panes/FileTree.tsx`
   (+ test), `panes/files.css`, and `ui/scale-baseline.json` (`panes/files.css` key only). Re-read
   it before writing, because C3 also writes the file, on different keys.
5. **C5 (docs + tips), last:** `CLAUDE.md`, `tips/tips.ts` (+ its test).

## Non-goals

- Mobile split view, which stays desktop-only.
- Desktop strip changes.
- An HTML5-drag input layer, unless the device spike later shows it works.
- Server changes: `reorderTabs` / `groupUpdate` already cover every drop.

## Pre-existing uncommitted work (baseline)

Batches 1–3 and the 2026-10-24 morning work. The coordinator snapshots the pre-batch-4 state at
`~/.cache/claudex-nomcp/prebuild-b4/` before the build. Everything is preserved; in particular the
selection-hold release path from the 2026-10-24 jump fix (`KEYBOARD_RETURN_MS`, re-raise before
re-pin) must keep its existing tests green.

## Risks

- **[Generalizing the hold breaks the selection path]** → The existing selection tests must pass
  unchanged. The drawer adds a second source; it does not replace the first.
- **[Long-press drag conflicts with the list's pan]** → Drag starts only after arming, with pointer
  capture taken only then. Before arming nothing is prevented, so the browser pans as today.
- **[Full-width drawer hides the terminal entirely]** → That is the spec ("full-screen"), with a
  scrim strip none. Closing restores the keyboard state found at open.
- **[Swipe-left fights the drawer's own close gesture]** → None exists today: the drawer opens with a
  right→left swipe on the extra-keys bar, not on rows, and closes by scrim, back or selection. So a
  row swipe-left has no competitor.
- **[Exit animations delay test assertions]** → Fake timers in tests. The hook's duration reads the
  tier token value (140ms), and is 0 under reduced motion.

## Verification (proof commands)

- `yarn typecheck`, `yarn lint` (0 errors) and `yarn test`, all from the repo root.
- Smoke as before:
  1. Build to `/tmp/palmux-smoke/dist`.
  2. Use a fresh `/tmp/palmux-smoke-b4/cfg` with the batch-2 seed (group + colours + kinds), a
     loopback bind, `NO_AUTH` and the no-op theme hook.
  3. Check with Playwright at 390×844 (`isMobile` + `hasTouch`, mobile mode on), with screenshots:
     - full-width drawer and scrim
     - Settings button on top, switcher above the footer
     - row anatomy: dot, title, number; no circle, no ✕
     - long-press + move reorders, verified by the resulting `sessions` broadcast order on the smoke
       server
     - long-press onto a group header joins it (membership persisted, visible after a reload)
     - long-press + release opens the sheet
     - swipe-left reveals Close
     - a row closes with a fade
     - keyboard hold: focus `#mobile-kbd`, open the drawer, shrink-then-grow `visualViewport`
       (emulated), and confirm `--app-height` is unchanged until close
     - no console errors
  4. Stop the server by PID after checking its environment, and confirm production :44040 still
     answers.
- The production `dist` is NOT rebuilt.
- Device checks are left to the owner: the S26 gesture feel, the real IME behaviour, and the
  HTML5-drag spike.
