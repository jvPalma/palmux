# Tasks

Each group is deployable alone: `yarn workspace @palmux/client build` (production serves this
checkout's `dist`), then a reload on the S26 and the desktop. The owner confirms each group on his
devices before the next starts.

## 1. Scale and icon foundation

- [x] 1.1 Add the scale variables (`--fs-1…4`, `--fs-mono`, `--sp-1…6`, `--r-1…3`, `--r-pill`,
      `--ctl-h` with the mobile override) next to the `--t-*` tokens in `index.css`; verify
      `yarn typecheck` and `yarn test` pass with no visual change
- [x] 1.2 Add `ui/scale.test.ts`, a guard that scans every client `.css` for off-scale font-size,
      padding, margin, gap, radius and height literals, with the design's exemptions, a single-line
      pragma escape and a per-file baseline that may only go down; verify it passes on the current
      tree and fails when a `font-size: 10.5px` is added to a fixture
- [x] 1.3 Move `mobile/key-icons.tsx` to `ui/icons.tsx` with named exports, keep a re-export at the
      old path, and add the chrome icons from design §3; verify `ExtraKeysBar.test.tsx` still
      passes and a new `icons.test.tsx` asserts every icon is an SVG with stroke 1.75 and
      `currentColor`
- [x] 1.4 Replace every emoji or glyph used as an icon in chrome (dashboard, Explorer actions,
      drawer footer, menus, toasts, pane headers) with the shared icons, and add a test that scans
      non-test `.tsx` for the emoji ranges outside `extra-keys` labels; verify the scan passes and
      the drawer footer renders four SVGs
- [x] 1.5 Add the `ui-primitives` motion items that need no layout change (kit button press,
      menu and popover origin-aware entry); extend `ui.test.tsx` so their durations are on a tier;
      verify on desktop that a right-click menu grows from the click point

## 2. Desktop tab strip (pills)

- [x] 2.1 Build the tunable pills prototype on the visual-explainer gallery
      (`~/.agent/diagrams/palmux-tabs-pills-prototype.html`). Use the owner's real tab names, a
      group, a split pairing, the Cobalt Next palette plus a light toggle, and knobs for active
      fill, ring, border alpha, radius, gap and inactive text. Add a copy button that emits the
      values. Deliver the URL; verify it renders with no console errors at 1440px and 390px
- [x] 2.2 Get the owner's tuned values back (at most two rounds, per the design's risk note) and
      record them in design.md §1; verify the recorded values match the copied block
- [x] 2.3 Rebuild the strip in `SessionTabs.tsx` and `index.css` as pills: border on every pill,
      raised and ringed active, colour dot, kind icon for non-terminals only, flexible width
      between min and max, `+` after the last pill; verify with a rewritten
      `session/tab-strip-css.test.ts` that pins those rules
- [x] 2.4 Render groups as a framed cluster with a chip whose fill does not follow activation;
      verify with a test that activating a member leaves the chip's class and style unchanged
- [x] 2.5 Render fused pairings as one pill with a split glyph and a seam, visible when inactive,
      with the focused segment raised; verify with a test that the glyph and seam render while the
      pairing is inactive, and that `SplitView.test.tsx`'s one-mount assertion still passes
- [x] 2.6 Replace the `palmux` wordmark with an app-menu button (`@radix-ui/react-dropdown-menu`,
      wrapped in the kit) offering Settings, Tips and Reload app; verify a test opens Settings from
      the menu with `sidebarRail: hidden`
- [x] 2.7 Reorder the dock rail to New tab, Explorer, Dictation · Upload, Download · Settings pinned
      to the bottom; verify with a `DockPanel` test on the rendered order
- [x] 2.8 Migrate the strip, topbar and rail CSS to the scale and lower their guard baselines to
      zero; verify `ui/scale.test.ts` passes with the new baselines
- [x] 2.9 Update CLAUDE.md (tab strip, split fusion, group chip, the topbar paragraph) and verify
      no paragraph still describes the Chrome tab shape, the 8% tints or the 3px group line
- [ ] 2.10 Verify live at 1440×900 on the desktop with 9 tabs, one group and one pairing: the owner
      can name the active tab, the split and the group at a glance (owner sign-off)

## 3. Settings panel

- [x] 3.1 Restructure `SettingsFields` markup into section cards with the two-column row grid and
      fixed control column, and drop the uppercase tracked section titles; verify
      `SettingsFields.test.tsx` passes and a new test asserts every row's control sits in the
      control column
- [x] 3.2 Replace the Font `<select>` with the kit Select and give every control `--ctl-h`;
      verify a test finds no native `select` in the panel
- [x] 3.3 Make long values truncate on one line with a tooltip, and switch section headers and
      controls to `:focus-visible` rings; verify on the S26 that `Cobalt Next Minimal` no longer
      overflows, and with a test that a mouse click on a section header draws no ring
- [x] 3.4 Turn the Theme row into a button that pushes an in-place theme sub-view (dock and drawer
      share the stack), listing every theme painted by `theme-preview.ts`, with a checkmark on the
      current theme and a `‹ Settings` back control; verify with tests that tapping a theme applies
      and persists it while the list stays open
- [x] 3.5 Move the Raw/Form config switch to a row at the end ("Edit config.json ›"); verify the
      Raw editor still opens and saves
- [x] 3.6 Migrate the settings CSS (`settings/*.css`, `.settings-form` in `index.css`) to the scale
      and lower the guard baselines; verify `ui/scale.test.ts` passes
- [x] 3.7 Update CLAUDE.md's settings form and theme picker paragraphs; verify live on the dock
      (1440px) and the drawer (S26) that the controls share both edges

## 4. Dock, menus and the rest of desktop

- [x] 4.1 Rework the tab context menu: 30px rows, icons, three separated groups (edit ·
      split/group/colour · close, with close last); verify `SessionTabs` menu tests on item order
- [x] 4.2 Apply the settings section style to the New-tab chooser and dock headers (no uppercase
      tracked titles; shared icons); verify `DashboardBody` tests pass and a screenshot shows one
      heading style across Settings, Explorer, New tab and Dictation
- [x] 4.3 Investigate the 16px black band seen under the terminal in headless 1440×900 (likely an
      `--app-height` remainder); fix it only if it reproduces on the owner's desktop, and record the
      outcome in this task either way
      **Outcome (2026-10-25, batch 3).** The cause was NOT `--app-height`. Measured at 1440×900 on
      Catppuccin: `.app`, `.content-row`, `.content-area`, `.term-wrap` and `.term-host` all reach
      the viewport bottom (857px from y=43). `elementFromPoint` in the band is `div.xterm-viewport`.
      `xterm.css` gives `.xterm-viewport` `background-color: #000`, and in xterm 6 that layer
      covers the whole `.xterm` box under the grid. The sub-cell remainder (`height mod
      cellHeight`, 9px here) plus xterm's 2px inset therefore showed pure black instead of the
      `--t-term-bg` that `.term-wrap` paints. This is plain CSS, so it reproduces in any desktop
      window with a remainder, not only headless.
      **Decision:** fixed in `index.css` (`.term-host .xterm .xterm-viewport { background-color:
      var(--t-term-bg, var(--t-base)) }`). The batch-3 smoke afterwards found no black pixels.
      **Owner to confirm on his desktop.**
- [x] 4.4 Migrate dock, dashboard and files CSS to the scale and lower the baselines; verify
      `ui/scale.test.ts` passes

## 5. Mobile drawer

- [x] 5.1 Spike: open the DGSL TreeView Storybook story on the S26 over adb and record whether
      long-press drag starts, whether the list still scrolls and whether `contextmenu` fires; write
      the result and the chosen input layer (HTML5 or pointer) into design.md §5
- [x] 5.2 Generalise the viewport hold in `App.tsx` so an open drawer holds the layout like a live
      selection does, record keyboard-up at open, and release through one `closeDrawer()` on every
      close path; verify with App-level tests in the style of the existing "does not resize twice"
      suite (no `--app-height` change while open; keyboard re-raised only if it was up)
- [x] 5.3 Make the drawer full-width with a scrim (240ms fade, tap closes); verify on the S26 that
      typing, opening the drawer, tapping Upload and returning keeps the keyboard and costs at most
      one terminal resize (measure with the CDP tap from 2026-10-24)
- [x] 5.4 Port TreeView's `rows.ts`, `types.ts` and drop computation into
      `session/drawer-tree.ts` with its behaviour tests adapted (no self or descendant drop,
      quarters before/after, middle inside); verify the ported tests pass
- [x] 5.5 Rebuild the session list rows as dot + title + subdued number, kind icon for non-terminals
      only, and the active row marked by a raised background and an accent edge; verify a test that
      no row renders a numbered circle and that a coloured active row is not filled
- [x] 5.6 Wire long-press drag to the tree model on the chosen input layer, mapping drops to
      `reorderTabs` and `groupUpdate`; verify with tests for reorder, join group and leave group,
      and on the S26 that a plain swipe still scrolls
- [x] 5.7 Make long-press without moving open the row menu (rename, colour, group, close with the
      terminal confirmation), and swipe left reveal a close action; remove the always-visible ✕;
      verify with tests for both gestures and the confirmation
- [x] 5.8 Order the drawer for reach (sessions and files lowest, settings farthest from the bottom)
      and add row enter/exit transitions; verify the order with a test and the transitions with
      `ui.test.tsx`'s tier check
- [x] 5.9 Migrate the drawer CSS to the scale and lower the baselines; update CLAUDE.md's drawer
      paragraphs and `tips/tips.ts` (long-press drag, row menu, swipe to close); verify
      `ui/scale.test.ts` passes and the tips test covers the new gestures

      **Batch 4 outcome (2026-10-25).** Built, reviewed, two fix rounds, two Codex inspections.
      5.1 is decided without the device (design.md §5: pointer events); the spike itself and the
      S26 checks in 5.3 and 5.6 are owed to the owner. Inspection 2's two findings (B4-RV2-001
      keyboard-restore fallback, B4-RV2-002 stale drop order) are carried into batch 5 as B6/B7.

## 6. Integration

- [x] 6.1 Bring every remaining guard baseline to zero; verify `ui/scale.test.ts` runs with no
      baseline entries left
- [x] 6.2 Run `yarn test`, `yarn typecheck` and `yarn lint`, and verify all three pass
- [x] 6.3 Re-run the 2026-10-24 review captures (isolated server on :44099 plus Playwright, and the
      S26 over adb) and publish a before/after page on the gallery; verify every finding in the
      review is either fixed or listed as deliberately kept

      **Batch 5 outcome (2026-10-25).** Plan approved after 5 Codex rounds (12 findings accepted);
      built, Fable-reviewed, one fix round, two Codex inspections (the second APPROVED). Every
      scale baseline is zero and kit controls sit on `--ctl-h`. Gates: typecheck OK, lint 0
      errors, 2685 + 520 + 33 tests. 6.3: captures re-run on the isolated :44099 server at
      1440×900 and 390×844 (CDP touch); the before/after page is
      `~/.agent/diagrams/palmux-ui-rework-final-report.html`. One review finding is still OPEN,
      not fixed and not deliberately kept: the drawer still sets its `‹` back headers and footer
      cells in monospace accent beside sans rows. The S26 checks were not run (no device).

## 7. Drawer rows as pills (owner follow-up, 2026-10-25)

- [x] 7.1 Render the drawer's session rows as pills with the desktop strip's tokens (border, radius,
      raised fill + ring for the active row, no accent edge) and its groups as framed clusters with a
      filled chip header; verify with stylesheet tests that the drawer reads the same `--pill-*`
      tokens as the strip, that no row carries an accent edge, and that the group frame is continuous
      (header, members, last member)
- [x] 7.2 Update CLAUDE.md's drawer row paragraph; verify live at 390×844 with real touch that drag,
      swipe-to-close and the row menu still work and the ring is not clipped

      **Batch 6 outcome (2026-10-25).** Plan approved in 3 Codex rounds; built (Sonnet), one fix
      round (Opus), two Codex inspections (the second APPROVED). Deviation accepted by the
      inspection: frame segments sit on `.drawer-leaf` (the inner box is the grid item and falls
      short mid-transition). Gates: 2728 + 520 + 33 tests. Verified at 390×844 with CDP touch on an
      isolated server; not yet on the S26.

## 8. Drawer switcher on top, its contrast, a gear (owner follow-up, 2026-10-25)

- [x] 8.1 Move the drawer view switcher into the top row (gear · switcher · close) at the root views,
      drop it above the footer and from the sub-surfaces; verify with tests on the rendered order and
      that `keepFocus` still keeps `#mobile-kbd`
- [x] 8.2 Raise the switcher's unselected colour to `--pill-text`; verify with a stylesheet test
- [x] 8.3 Make the settings icon a gear; verify `icons.test.tsx` and that the sun shape is gone

## 9. The Explorer remembers open roots per device (owner follow-up, 2026-10-25)

- [ ] 9.1 Persist the Explorer's open root sections in `localStorage` (per device, never synced),
      open HOME only on a device's first run, and guard the prune against an incomplete root list;
      verify with module and FileTree tests (first run, remount, toggle, pin, boot prune, throwing
      storage) and a reload on loopback

## Workflow follow-up

- Archive the change after the owner signs off groups 2–5 on his devices.
- After archiving, confirm `openspec/specs/mobile-drawer` and `openspec/specs/settings-panel` exist
  and the modified capabilities carry the new text.
