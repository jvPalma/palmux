# ui-rework — apply batch 5 (group 6: integration, plus carried defects)

Batch plan for the OpenSpec change `ui-rework`.

**Contracts:**
- `tasks.md` 6.1–6.3
- spec `ui-primitives` (motion tiers, kit) and spec `settings-panel` ("Focus rings appear for keyboard
  focus only", "Theme is chosen in an in-place theme browser")
- spec `mobile-drawer` (the drawer never dismisses the soft keyboard by itself)
- `design.md` §2 (one scale, enforced by a ratchet)

The owner is asleep, with a standing instruction to keep going through the openspec. Batches 1–4
are in the tree, uncommitted.

## Why this batch carries defects

Inspections of batches 2–4 found seven defects that their fix budgets could not absorb. Each one
lives in code this change wrote or reshaped, so leaving them out would ship the change knowingly
broken. They are listed as section B with their source. Nothing else outside group 6 is in scope.

## Acceptance criteria

### A. Every scale baseline reaches zero (6.1)

Today the guard (`packages/client/src/ui/scale.test.ts`) reports 94 off-scale declarations:
`index.css` 62, `ui/ui.css` 17, `dictation/dictation-view.css` 15. The full list is reproducible by
running the guard with an empty baseline. After this batch:

- `ui/scale-baseline.json` is `{}`, and the guard passes with no baseline entries.
- Every declaration is fixed by one of two means, chosen per declaration:
  1. **Snap to the scale variable** (`var(--fs-N)`, `var(--sp-N)`, `var(--r-N)`), using these rules
     so two builders cannot snap the same value differently:
     - **font-size**: 10px, 10.5px, 11.5px → `--fs-1` (11); 12.5px → `--fs-2` (12); 14px in body
       text, rows and inputs → `--fs-3` (13); 14px in a title or message heading
       (`.ui-dialog-title`, `.exit-card-msg`, `.pane-btn` glyph size) → `--fs-4` (15).
     - **radius**: a control (button, input, icon button, menu item, segmented control, toast,
       banner, swatch) → `--r-2` (6px); a card, panel, menu surface, dialog, sheet or toast-sized
       surface (`.ui-dialog-content`, `.panel`, `.exit-card`, `.rec-toast`, `.dictation-card`,
       `.ui-menu`, `.link-menu`, `.tab-sheet`'s top corners, `.ui-error-boundary`,
       `.settings-editor-host`) → `--r-3` (10px). Radius 1px–2px on a swatch or a bar → `--r-1`
       (4px) only when the element is at least 8px on its short side; otherwise a pragma.
     - **space** (padding, margin, gap): to the nearest 4px step; a value exactly between two steps
       (6, 10, 14, 18, 22) goes UP, following the owner's 2026-10-24 decision for the pill gap
       (6 → 8). 3px and 5px go to 4px. 1px and 2px are already legal.
     - **height**: a control height becomes `var(--ctl-h)` when it is the control's own height
       (`.icon-btn` 26px, `.slot-eject` 22px); other heights snap by the space rule.
  2. **A `/* scale-ok: <reason> */` pragma** on that one declaration, when the value is GEOMETRY,
     not rhythm: a dot or thumb sized to sit inside another fixed box (`.ui-switch-thumb` 18px in
     its track, `.drawer-dot` and `.menu-group-dot` 10px), a 1px radius on a 2px drop line, the
     waveform bar gap, or a `max-height` that sizes a scroller (`.dh-text` 130px). The reason names
     the box the value is measured against.
- **Kit control heights read `--ctl-h`, not `--mbtn-h` (B5-R6).** `ui/ui.css:71,77,163,164,182,183,
  235,326,367` size the Button, its small variant, IconButton (and small), Input, Segmented item and
  Collapsible trigger off `var(--mbtn-h, 30px)`, a function value the literal guard cannot see. They
  become `var(--ctl-h)` (28px desktop, 36px under `:root[data-mobile='true']`), and each small
  variant `calc(var(--ctl-h) - var(--sp-1))` (24px desktop). The Segmented is the exception in
  shape, not in result (B5-R8): its wrapper `.ui-seg` (`ui/ui.css:~315`) adds 2px padding and a 1px
  border per side, so the OUTER box takes `--ctl-h` and `.ui-seg-item` takes
  `calc(var(--ctl-h) - 6px)`, the subtraction `settings/settings-view.css:~202–216` already does;
  that settings override then becomes redundant and is removed if it no longer changes anything. The drawer's compensating overrides
  (`index.css` `.drawer .ui-btn:not(.ui-btn-sm)` … `.drawer .ui-icon-btn`, ~1371–1389) and the
  `.drawer { --mbtn-h: 30px }` pin are deleted once nothing in the drawer reads them; `--mbtn-h`
  stays defined for the extra-keys bar (exempt). Settings' own overrides stay only where they still
  change something. A new `scale.test.ts` case resolves every kit control's height from the sheets
  and asserts the TOTAL geometry: the box a user sees is `--ctl-h` (or the small calc) for Button,
  IconButton, Input, Select trigger and the Segmented's outer box (wrapper padding and borders
  included), in the base context, the drawer and `FilePane`'s header (`panes/FilePane.tsx:~124`
  uses the base Segmented), and that no rule outside `.ek-`/
  `.extra-keys` reads `--mbtn-h`. Visible consequence, stated: kit controls on a phone OUTSIDE the
  drawer (pane headers, the file pane, dialogs) grow from 30px to the 36px touch target, and on
  desktop shrink 2px to 28px; the mobile screenshots must show none of them clipped.
- No visible deviation exceeds one scale step (the kit-height change above is the one deliberate
  exception, because it is the token's defined value, not a snap). The builder lists every change as
  `file:line old → new` in its report, so the smoke can compare the right elements.
- The guard's own exemptions (`EXEMPT_SELECTORS`) do not grow. `ui.test.tsx` still passes
  (no colour literal in `ui.css`, durations on a tier).

### B. Carried defects

**B1. Theme row steals `#mobile-kbd` focus (B3-F2-001, batch-3 fix-2 inspection, medium).**
`settings/SettingsFields.tsx:~474`: the Theme row is a kit `Button` with only `onClick`. With
`#mobile-kbd` focused in the drawer, a real touch or mouse press focuses the button natively before
the click runs, so `carriesFocus` (`~348`) sees focus inside the panel and moves it into the theme
list: the soft keyboard is dismissed.
- Pointer activation of the Theme row leaves `#mobile-kbd` focused when it was focused at
  pointerdown, on touch AND mouse, and the settings list still scrolls when a touch starts on that
  row and moves (no `preventDefault` on a touch pointerdown).
- Keyboard (Enter, Space) and assistive-tech activation still open the theme browser, and the B3-R7
  rule still holds: entering focuses the first drawn button when focus was lost; returning focuses
  the Theme row when focus was lost; never steals focus from a text field.
- The test at `session/SessionDrawer.test.tsx:~695` that uses `fireEvent.click` is replaced by a
  complete pointer sequence (`pointerdown` → focus as the browser would move it → `pointerup` →
  `click`) starting with `#mobile-kbd` focused, asserting focus is on `#mobile-kbd` after entry and
  after return. A matching test in `SettingsFields.test.tsx` covers the desktop dock (mouse).
- The same holds for every control of that round trip, not only the entry button (B5-R2, B5-R3):
  - the Theme row's LABEL (`Row`, `SettingsFields.tsx:~140`, `<label htmlFor="set-theme">`):
    clicking or tapping it opens the browser and leaves `#mobile-kbd` focused when it was focused at
    the press. The `<label for>` association stays (the button's `aria-label` remains its name);
  - each theme entry in `settings/ThemeBrowser.tsx:~92` (`.tb-item`, a list inside a scroller): a
    pointer pick applies the theme and leaves `#mobile-kbd` focused, and a touch that moves scrolls
    the list and picks nothing;
  - the dock's `‹ Settings` back control (`settings-themes-back`, `SettingsFields.tsx:~430`): a
    pointer press returns to the form without moving focus off a protected text field.
  Tests drive complete pointer sequences (down → native focus move → up → click) for entry by the
  button, entry by the label, a pick, and return, for touch and for mouse, each starting with
  `#mobile-kbd` focused, plus Enter on each control.
- Mechanism: these controls use `pressMove` from `panes/press.ts` with the revised click rule in B3.
  The label uses `pressMove` itself; its own forwarded click to the button is the tail of a gesture
  `pressMove` acted on, so B4's mark swallows it and the browser does not open twice.

**B2. Leaving Settings drops unsaved config.json (batch-2 inspection, queued).**
`App.tsx:~1953`: `ConfigEditor` renders only while `dockView === 'settings'`, and `DockPanel` keys
its children's `ErrorBoundary` by view (`session/DockPanel.tsx:~173`), so switching the dock to
another view, or closing it, unmounts the editor and its unsaved text.
- When the editor is dirty (`configDirtyRef`), any dock change that leaves Settings (another rail
  view, the close toggle, the `settings` keybinding, the app menu) asks
  `Discard unsaved changes to config.json?` with `window.confirm`, the same mechanism
  `guardedReload` uses. Cancel leaves the dock on Settings in Raw mode with the text intact; OK
  proceeds and clears the dirty flag.
- The same confirm guards the other path that removes the dock (B5-R1): an explicit Settings change
  of `mobileMode` that would make `mobileActive` true (`App.tsx:~1946` drops the whole dock). The
  guard sits in App's settings-update path for that one key, before the change is applied or
  persisted; Cancel leaves `mobileMode` and the editor untouched. The case is tested with the dirty
  buffer hidden behind Form (`cfgMode === 'form'`).
- Stated limit: `mobileMode: 'auto'` can flip `mobileActive` from a viewport change with no user
  action to confirm against; that path still unmounts the editor. Recorded, not fixed.
- A clean editor switches silently, exactly as today.
- Implemented in `openDockView` (the only writer of `dockView`, `App.tsx:~286`), reading the current
  view from a ref so the callback keeps its identity.
- Non-goal: keeping the editor mounted across views. That would load the Monaco chunk for every
  desktop session, which CLAUDE.md forbids for terminal-only use.

**B3. List controls and some fixed buttons have no keyboard path (batch-3 fix round 1, queued).**
- `pressMove` (`panes/press.ts:~61`) gains an `onClick` that acts on every click that REACHES it,
  except the click that ends a gesture on the same element which moved past the slop (a mouse drag
  released on the element). A pointer press still acts on pointerup, and its own trailing click
  never reaches the handler, because B4 marks the gesture and the document-level capture listener
  swallows it. So Enter, Space, assistive tech, `element.click()` and a click forwarded by a
  `<label>` all activate exactly once, and `detail` plays no part in the decision (B5-R3: a label's
  forwarded click carries a count).
- `pressKbdMove` keeps its `onKeyDown` for non-button elements. On a native `<button>` it must not
  activate twice for one Enter or Space: the keydown handler acts only when the element is not a
  `<button>` (a button already gets the `detail === 0` click). Tests cover Enter and Space on a
  `<button>` and on a `role="button"` element, each activating exactly once.
- The fixed buttons that use bare `press` on pointerdown move to `pressClick`:
  `panes/NewTabChooser.tsx:31,42,52`, `panes/DashboardTab.tsx:20`, and `session/TabSheet.tsx:140,149,156`.
  The scrims (`session/TabSheet.tsx:56`, `session/SessionDrawer.tsx:870`) are not focusable and keep
  `press`.
- `session/SessionDrawer.tsx:~885` (the swipe Close button) spreads `pressMove` after an explicit
  `onClick` that acts on `detail === 0`. With `pressMove` returning `onClick`, that is a duplicate
  JSX property (TS2783), so the explicit handler is deleted; its `onKeyDown` (arrow keys) stays
  (B5-R5).

**B4. Trailing clicks after a pointer action (batch-4 smoke 10b class, queued).**
A pointer action that redraws the spot under the finger lets the browser deliver the gesture's
trailing click to whatever the action put there (measured for `pressClick` in batch 4; fixed there
by `consumeGesture`). Three other paths have the same shape:
- `press` (scrims): closing the drawer on pointerdown hands the click to the terminal underneath,
  which under mouse reporting sends a click report to tmux (it can change the focused pane).
- `pressMove` on activation: `preventDefault()` on `pointerup` does not cancel the click, so a
  `drawer-new` or chooser-row tap that swaps the view delivers its click to the new content.
- `ui/Segmented.tsx:~77` with `keepFocus` (the drawer's view switcher) selects on pointerdown.
- `session/TabSheet.tsx:30` defines its OWN local `press` (used by the sheet scrim at :56); it is
  deleted and the shared `press` imported, so the scrim gets the mark too (B5-R4).
- the drawer rows' own state machine (`SessionDrawer.tsx:~726`, `up`): a tap that switches tab and
  closes the drawer, and a hold released in place that opens `TabSheet`, both redraw under the
  finger. Both arm the mark BEFORE acting; a scroll, a cancelled gesture, a drag and a gesture
  ended by `endIfGone` arm nothing (B5-R4).
Each of these arms the same per-gesture tail mark `pressClick` uses (`consumeGesture`, exported
from `panes/press.ts` for `Segmented`). Two properties of the mark change with it:
- **It covers the compatibility mouse events, not only the click (B5-R7).** A touch can deliver its
  compatibility `mousedown` (which moves focus) AFTER `pointerup`, so restoring `#mobile-kbd` at
  `pointerup` alone is undone by it. While the mark is armed, the capture listener also takes the
  gesture's compatibility `mousedown` and `mouseup` and calls `preventDefault()` on the mousedown
  (which cancels its focus move); it never touches a `pointerdown`, so panning is unaffected. A
  test drives pointerdown → pointerup → compat mousedown (+ the focus move it would cause) →
  mouseup → click, starting with `#mobile-kbd` focused, and asserts focus after the WHOLE sequence.
- **Its expiry starts at the LATER of two events: the action returning and the matching pointer
  releasing (B5-R9, B5-R10).** The mark is armed before the action runs (so mutations it makes are
  covered) and stays active, unexpired, until BOTH have happened; `CLICK_TAIL_MS` counts from the
  later one. For a pointerdown action (`pressClick`, `press`, Segmented) the release comes last, so
  a long hold still has its click swallowed exactly as today (`press.ts:~114`, the five-second hold
  case at `press.test.tsx:~263` is kept unchanged); for a pointerup action the action's return
  comes last. A synchronous `window.confirm` inside the action (the swipe Close
  → `App.closeTab`, `SessionDrawer.tsx:~797`, `App.tsx:~1472`) can block for any time; the click it
  delayed is still swallowed afterwards. Test: an action that blocks for 1.5s (fake timers / a stub
  confirm advancing the clock), then the original trailing click (swallowed), then a separate,
  legitimate press (acts); and the existing long-hold case stays green. The `detail === 0` exemption stays, so B3's keyboard clicks
and the upload/download `element.click()` calls still pass. Tests: for each path (scrims, `pressMove`, Segmented, the row tap, the row menu), a pointer
sequence whose action replaces the element under the pointer, asserting the replacement's click
handler does not run; and a later, separate tap still activates.

**B5. Focus is lost entering and leaving the raw config editor (batch-3 fix round 2, queued).**
The "Edit config.json" row (`SettingsFields.tsx:~667`) unmounts the form, and `config-back`
(`settings/ConfigEditor.tsx:~333`) remounts it, so focus falls to `<body>` both ways (desktop dock).
- Entering Raw: when focus was lost, it moves to `config-back`.
- Returning to the form: when focus was lost, it moves to the Edit config.json row.
- Neither ever takes focus from a text field, the B3-R7 rule.

**B6. A viewport event during the keyboard restore costs a second resize (B4-RV2-001, batch-4
inspection 2, medium).** `App.tsx:~1703`: the release path raises the keyboard and arms the
`KEYBOARD_RETURN_MS` fallback, but ANY viewport event before the keyboard returns runs `apply`
again, cancels the fallback and pins the current (expanded) height; when the IME then returns the
height changes a second time. Measured shape: pinned 500px → close at 844px → a scroll at 844px →
keyboard back at 500px = two height writes and two resizes per PTY.
- Restoration becomes an explicit pending state set by the release path. While it is pending,
  viewport events write NOTHING and leave the `KEYBOARD_RETURN_MS` fallback armed. Crossing back
  under the keyboard-presence threshold is not completion (B5-R12): an IME animates through
  intermediate heights (844 → 580 → 500). Completion is a SETTLE rule: once the viewport is within
  `KEYBOARD_GONE_PX` of the pinned height, a short settle timer (`RESTORE_SETTLE_MS`, 150ms) starts
  and every further viewport event restarts it; when it fires, the final geometry is committed ONCE
  (no write at all when it equals the pinned geometry). The fallback is the upper bound: when it
  fires first, it commits the real geometry once. A hold acquired meanwhile (a new selection, the
  drawer reopening) cancels both timers and takes over as it does today.
- Tests in the style of the existing "does not resize twice" suite: the exact sequence above ends
  with at most one `--app-height` write and one refit; 844 → 580 → 500 with pinned 500 ends with
  zero writes; 844 → 580 → 480 (a keyboard of a different height) ends with exactly one write, of
  480; the fallback still pins once when the
  keyboard never returns; a hold acquired mid-restore is respected.
- This is the one sanctioned change to the hold/release state machine in this batch, and it is
  C3's (C3 owns `App.tsx`).

**B7. A drop computed from a stale tab list can drop a tab locally (B4-RV2-002, batch-4
inspection 2, medium).** `App.tsx:~1121` (`moveTabInTree`) and `~1150` (`moveGroupInTree`) compute
the order from `tabsRef.current`, then apply it inside a functional `setTabs` updater to a possibly
NEWER `prev`, rebuilding the list only from `order`. A `sessions` broadcast whose `setTabs` is
queued but not yet rendered (`App.tsx:~1239–1275`) can hold a tab the stale order lacks; the
updater then discards it, and the server (already at that order) sends no corrective broadcast.
- **One latest snapshot (B5-R11).** Today `tabsRef.current = msg.tabs` runs only on the first
  `?new=1` broadcast (`App.tsx:~1261`); every other broadcast leaves the ref stale until the next
  render, and `groupsRef` likewise. The `sessions` handler therefore updates both refs
  synchronously on EVERY broadcast, immediately AFTER the close-navigation decision
  (`dispatch({ type: 'sessionsBroadcast' })`), which is the one consumer that needs the PREVIOUS
  list and reads it before the assignment. The two drop commits update the same refs synchronously
  with the order and membership they apply, so a second drop before the next render resolves
  against the first.
- **The optimistic update never loses or duplicates a tab, and never applies a stale membership
  decision.** The updater applies the drop to `prev` with the shared forgiving permutation (unknown
  ids dropped, omitted current ids appended in prior relative order) and normalizes the result.
  Membership follows the SERVER's conditional semantics (`server.ts:~789–793`): a removal from group
  G applies only if the tab is still in G in `prev`; an add moves it to the target group (the
  server's `groupUpdate` steals). The sent message is the same order and membership the updater
  applied.
- Tests cover the interleaves the findings name: a broadcast queued with a NEW tab, then a drop
  resolved before it renders → the new tab survives in the order the server would produce; a
  broadcast queued that MOVES tab T from G to H, then a drop of T resolved as "remove from G" → T
  stays in H locally; and the close-navigation tests stay green (they read the previous list).
- Same treatment for the desktop paths only if they share the defect (`doReorder`, `moveGroup`);
  the builder checks and reports, and fixes them the same way if so.

### C. Gates (6.2)

`yarn typecheck`, `yarn lint` (0 errors) and `yarn test` pass from the repo root.

### D. Review captures and the before/after page (6.3)

The coordinator re-runs the 2026-10-24 review captures on the isolated smoke server (:44099,
`PALMUX_CONFIG_DIR` under /tmp, `PALMUX_NO_AUTH=1`, client built into `/tmp/palmux-smoke/dist`),
desktop 1440×900 and mobile 390×844 with real CDP touch, and publishes a before/after page in the
visual-explainer gallery that lists every review finding as fixed or deliberately kept. The S26 is
not reachable tonight, so device-only checks are listed for the owner, not claimed.

## Approach and clusters (non-overlapping files)

| Cluster | Model | Files | Items |
|---|---|---|---|
| C1 press | opus xhigh | `panes/press.ts`, `panes/press.test.tsx`, `ui/Segmented.tsx`, `ui/press-consumers.test.tsx` | B3 helper contract, B4 helpers + Segmented |
| C2 call sites | opus xhigh | `panes/NewTabChooser.tsx`, `panes/DashboardTab.tsx`, `session/TabSheet.tsx`, `panes/DashboardBody.tsx`, `session/SessionDrawer.tsx`, their tests incl. `session/SessionDrawer.test.tsx` (the `~695` rewrite, row-gesture marks, the Close button) | B3 call sites, B4 TabSheet + rows, B5-R5, B1 drawer test |
| C3 settings, config and App | opus xhigh | `settings/SettingsFields.tsx`, `settings/SettingsFields.test.tsx`, `settings/ThemeBrowser.tsx`, its test, `settings/ConfigEditor.tsx`, its test, `App.tsx`, `App.test.tsx` | B1 code, B2, B5, B6, B7 |
| C4 scale | sonnet xhigh | `index.css`, `ui/ui.css`, `dictation/dictation-view.css`, `ui/scale-baseline.json`, `ui/scale.test.ts` (the kit-height case only) | A |

C1 runs first; C2 and C3 depend on its contract and start after it. C4 is independent and runs in
parallel with C1. Each cluster writes its failing tests before its fix where a defect is involved.

Then: Fable xhigh adversarial review of the batch diff (kill criteria below) → Opus repair if needed
→ one gate runner (sonnet) with an Opus fixer, at most two loops → smoke on loopback.

**Kill criteria for the reviewer:**
- a touch pointerdown `preventDefault` anywhere inside a scroller (breaks panning);
- any path that dismisses `#mobile-kbd` that did not before;
- a double activation for one pointer press, one Enter or one Space;
- a `detail === 0` click swallowed (upload/download `element.click()` must still work);
- a static import path from `App.tsx` to Monaco or `monaco-loader.ts`;
- a scale value changed by more than one step, a new `EXEMPT_SELECTORS` entry, or a pragma without
  a reason naming the measured box;
- a colour literal in `ui.css`, or a duration off the tiers.

## Non-goals

- Device spikes (5.1) and owner sign-offs (2.10, 4.3); they need the owner's devices.
- Keeping ConfigEditor mounted across dock views (see B2).
- Any production deploy, any write to `packages/client/dist`, any git write.

## Risks

- **[B4 swallows a click someone relies on]** A `pressMove` activation that does not redraw used to
  let its click through harmlessly; now it is swallowed. → The reviewer checks every `pressMove`
  and `press` call site for an `onClick` on the same or an ancestor element.
- **[Space on a native button]** Whether `preventDefault` on keydown cancels Space's click differs
  by engine. → B3 avoids relying on it: a `<button>` activates only through its click.
- **[Scale snapping shifts layout]** → the rules above, the one-step bound, and before/after
  screenshots at 1440px and 390px.

## Verification (proof commands)

- `yarn typecheck`, `yarn lint` (0 errors) and `yarn test`, all from the repo root.
- `yarn workspace @palmux/client vitest run src/ui/scale.test.ts` passes with `scale-baseline.json`
  equal to `{}`.
- Smoke on the isolated :44099 server, never production:
  1. drawer, real touch: with `#mobile-kbd` focused, tap Settings → Theme → a theme → back; the
     keyboard target stays `#mobile-kbd` throughout;
  2. drawer, real touch: tap the scrim; no click reaches the terminal (no SGR click report in the
     PTY echo);
  3. drawer, real touch: `+ New tab` opens the chooser sub-surface and stays open;
  4. dock: edit config.json, switch to Explorer → confirm appears; Cancel keeps the text;
  5. dock: Tab to Edit config.json, Enter, then `‹ Settings`; focus is on `config-back`, then on the
     Edit config.json row;
  6. dock: Tab to a dashboard Go button and to a TabSheet button; Enter activates once;
  7. screenshots at 1440×900 and 390×844 of the strip, dock (all views), drawer (all views), exit
     card, dialog and toasts, compared with the batch-4 captures.
