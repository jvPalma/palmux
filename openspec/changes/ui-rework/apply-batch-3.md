# ui-rework — apply batch 3 (groups 3 and 4: settings panel, menus, dock and the rest of desktop)

Batch plan for the OpenSpec change `ui-rework`. The contracts are in this directory: `design.md` §2
(scale) and §6 (settings layout + theme browser), spec `settings-panel` (all seven requirements),
spec `ui-primitives` (scale, icons, motion), and `tasks.md` 3.1–3.7 and 4.1–4.4.

Batches 1 and 2 are in the tree, uncommitted. The owner is asleep, and gave a standing instruction to
keep going through the openspec. Two steps need a real device, which is unavailable tonight (adb is
disconnected). They are replaced by a 390×844 emulated check, and the device check is left to the
owner:

- task 3.3's S26 check
- task 3.7's S26 check

## Acceptance criteria

### A. A kit Select, and one section-title style (kit, prerequisite for 3.x and 4.2)

- **New `ui/Select.tsx`.** It wraps `@radix-ui/react-select`, already a dependency, which
  `settings/ThemePicker.tsx` uses directly today.
  - **Props:** `{ id?, value, onChange, options: {value,label}[], 'aria-label'?, 'data-testid'? }`.
  - **Trigger:** height `var(--ctl-h)`, label truncates on one line with an ellipsis, full value in
    `title`.
  - **Chevron:** `<Icon name="chevron-down" />`.
  - **Popup:** reuses the kit menu surface, enters on `--mo-micro` from
    `--radix-select-content-transform-origin`.
  - **Styling:** tokens only (`ui.test.tsx`'s colour guard covers `ui.css`).
  - Exported from `ui/index.ts`.
- **One section-title style.** `.ui-collapsible-trigger` (`ui/ui.css:~357`) is today 11px/700,
  uppercase, 0.06em tracking. It becomes the spec's "small secondary-colour label":
  `font-size: var(--fs-1)`, weight 600, colour `--t-subtext`, NO uppercase, letter-spacing 0.
  Because every Collapsible uses it, this one change restyles the settings sections and the New-tab
  chooser's sections (4.2) together. The chevron and the 0fr→1fr animation stay as they are.
- **Consumer overrides must go too (review B3-R3).** Two consumer rules out-specify the kit and
  would keep the old caption:
  - `settings/settings-view.css:55–62` (`.settings-view .settings-section > .ui-collapsible-trigger`:
    10px / 700 / 0.12em)
  - `panes/dashboard.css:37–44` (`.dash-dock .ui-collapsible-trigger`: 10px / 600 / 0.12em)

  Remove their font-size, font-weight, letter-spacing and casing declarations, keeping only
  layout (padding, min-height) aligned to the scale, so the kit style is what renders.
- **Proof.** A test resolves the EFFECTIVE trigger typography in both contexts (Settings and New
  tab) by parsing the stylesheets in cascade order, the way `ui/press-consumers.test.tsx` does with
  PostCSS. It asserts font-size, weight, colour, letter-spacing and no uppercase.
- **Proof.**
  - `ui.test.tsx` asserts the trigger has no `text-transform: uppercase` and uses `--t-subtext`.
  - `Select` tests: renders the value, opens, picks, calls `onChange`, truncates with a `title`.

### B. Settings as grouped cards (3.1, 3.2, 3.3, 3.6)

Implements spec `settings-panel`.

**Layout (3.1):**
- `SettingsFields` keeps its field list and every `data-testid`.
- Each `Section`'s rows render inside one card (`.set-card`: base on the mantle panel, 1px
  `--t-surface` border, `var(--r-3)` radius), with hairline dividers between rows.
- A row is a two-column grid: label (+ hint) in a flexible column, control in a FIXED column
  `--set-control` (one width for every row; ~132px; the host may set it).
- Text-like controls fill the control column: Select, number Input, Segmented, the Theme button and
  text buttons. Switches and "›" link rows align to its right edge.
- Rows have a min-height of 44px, and the control is vertically centred whether or not the row has
  a hint. Stacked rows (`srow-stacked`, e.g. Import theme) span both columns.
- The panel title / section title hierarchy follows A.

**Controls (3.2):**
- Font becomes the kit Select (A). After this, no native `<select>` remains in the panel.
- Every control in `.settings-form` is `height: var(--ctl-h)`: Input, Select, Segmented, Button and
  the Theme button.
- **That alone cannot reach 28px (review B3-R4).** Today:
  - `.ui-btn-md` and `.ui-input` impose a 30px `min-height` (`ui/ui.css:70–73`, `:233–244`).
  - Segmented items have a 24px minimum inside a wrapper with 4px padding and 2px borders, which
    adds up to 30px.

  So:
  - Inside `.settings-form`, override `min-height` to `var(--ctl-h)` for Button, Input and Select.
  - Size the Segmented OUTER box to `var(--ctl-h)` and its items to
    `calc(var(--ctl-h) - 2 * (padding + border))`.
  - The Switch keeps its visual size but gets a hit target the full `var(--ctl-h)` tall: a padded
    label or `::before` on the root, which must not change the row's layout.
- **Proof.** A test computes the effective heights from the stylesheets at desktop (28) and with
  `:root[data-mobile='true']` (36). In Playwright, the measured `getBoundingClientRect().height` of
  each control at 1440 and 390 equals `--ctl-h` (±0.5px), and the Switch hit area does too.

**Truncation and focus (3.3):**
- Long values truncate on one line with a `title` tooltip, never wrap or overflow. This covers the
  Theme button label, the Select trigger and the version text.
- Section headers and panel controls show a ring on `:focus-visible` ONLY. Replace every `:focus`
  ring rule in the settings and kit CSS with `:focus-visible`.
- **Do not let a reset erase the keyboard ring (review B3-R5).** `.ui-input:focus` (`ui/ui.css:250`)
  sets `outline: none` AFTER the kit's ring declaration (`:82–89`). Renaming selectors alone would
  still wipe the keyboard ring. Remove that `outline: none`, or move the ring rule after it, so a
  keyboard-focused input keeps a visible ring.
- **Proof.** A stylesheet test asserts that no rule after the ring declaration resets `outline` on
  `:focus-visible` for `.ui-input`, `.ui-btn`, `.ui-collapsible-trigger` and the Select trigger. In
  Playwright, a keyboard Tab onto the Scrollback input shows a non-`none` outline.
- **Editable inputs are the exception (review B3-R6).** Chromium matches `:focus-visible` on an
  EDITABLE input (text, number) even when a pointer focused it, because the caret needs a focus
  indication. Fighting that would mean custom input-modality tracking, which weakens keyboard and AT
  focus for no gain. So:
  - The pointer-no-ring rule applies to non-editable controls only: section headers, buttons,
    switches, Segmented items, the Theme button and the Select trigger. Each shows a ring after
    keyboard focus and none after a mouse click; Playwright checks the Terminal section header and
    the Theme button.
  - Editable inputs (Scrollback, Font size, Import theme) show the native `:focus-visible` ring on
    any focus.
  - The `settings-panel` spec delta is amended accordingly.
  - The blanket `outline: none` reset is NOT restored.

**Scale (3.6):**
- `.settings-form` rules (`index.css` ~2380–2480), `settings/settings-view.css`,
  `settings/theme-picker.css` and `settings/config-editor.css` move to the scale variables.
- Lower the `ui/scale-baseline.json` entries to the exact new counts. Nothing may rise.

**Proof:**
- `SettingsFields.test.tsx`:
  - every row's control sits in `.srow-control`
  - no `select` element exists in the panel
  - a long theme name renders with a `title` and the truncation class
  - a mouse click on a section header leaves no `:focus-visible` (assert that the rules use
    `:focus-visible`, via the stylesheet text, plus that the trigger is not given a focus class)
- At 390×844 in Playwright (mobile mode on, theme Cobalt Next Minimal) the Theme control is one line
  and nothing overflows its box.
- At 1440px the dock's controls share both edges (bounding-box check).

### C. The in-place theme browser (3.4)

Implements spec `settings-panel` "Theme is chosen in an in-place theme browser" and "Picking a theme
applies it live".

**Theme row and sub-view:**
- The Theme row becomes a Button that shows the current theme's name, truncated with a `title`, and
  a `chevron-right` icon. Activating it switches `SettingsFields` to a `themes` SUB-VIEW, in place,
  inside whatever hosts it (dock or drawer).
- The sub-view renders:
  - a header row: a `‹ Settings` back control (`chevron-left` icon) plus the title "Theme"
  - the full theme list, grouped Dark / Light (`isLightBg`), each entry painted in its own palette by
    the existing `settings/theme-preview.ts` (background, foreground, cursor block, ANSI sample)
  - a checkmark (`check` icon) on the current theme

**Behaviour:**
- Tapping an entry calls the existing theme setter (`onChange({ themeId })`), which applies and
  persists it, and the list STAYS open.
- `‹ Settings` returns to the list, and the Theme row then shows the new name.

**One back stack:**
- `SettingsFields` owns `subView` by default, but accepts optional controlled props
  (`subView`, `onSubViewChange`).
- `session/SessionDrawer.tsx` lifts it, so the drawer's own Settings back header ALSO pops the theme
  sub-view first, instead of leaving Settings. The dock needs nothing extra.

**What goes:**
- The Radix-Select `settings/ThemePicker.tsx` popup is removed, not kept in parallel.
  - The list markup and preview painting move into a new `settings/ThemeBrowser.tsx`.
  - `ThemePicker.test.tsx` is realigned to `ThemeBrowser.test.tsx`: same preview/grouping
    assertions, plus the new behaviour.
  - Styles move from `theme-picker.css` to a renamed `theme-browser.css`, and the old file is
    deleted. Keep `MAX_PREVIEW_CHARS` and the "ring, not fill" highlight reasoning, adapted to a list.
  - **Filesystem consumers of `theme-picker.css` must move with it (review B3-R2):**
    - `ui/ui.test.tsx:~540–550` reads that file to check the `.tp-content` popup motion. Transfer
      that assertion to the new kit Select popup in `ui/ui.css`.
    - `ui/scale.test.ts:~760` lists the filename in its stylesheet inventory. Change it to
      `settings/theme-browser.css`.
    - Remove the `settings/theme-picker.css` key from `ui/scale-baseline.json`, and give
      `theme-browser.css` its exact count.

    C1 owns `ui/ui.test.tsx`, so C1 moves the motion assertion. C2 owns the scale inventory line and
    the baseline keys for these files.

**Proof (tests):**
- tap A → `onChange({themeId:A})`, list still mounted
- tap B → B applied, list still mounted
- back → form shows B
- drawer back header pops the sub-view before leaving Settings
- the current theme carries the check

### D. Edit config.json as a row (3.5)

- **Today.** The dock renders `<ConfigEditor mode onMode>` above `SettingsFields`
  (`App.tsx:~1721–1723`), and its header carries the "CONFIG.JSON  Raw | Form" Segmented, which is
  jargon at the top of the panel.
- **New row.** `SettingsFields` gains an optional `onEditConfig` prop. When provided (desktop dock
  only), it renders a final row "Edit config.json" with a `chevron-right` icon that calls it. `App`
  passes `() => setCfgMode('raw')`.
- **`ConfigEditor` changes:**
  - **In `form` mode it renders nothing VISIBLE, but keeps the same component instance and the same
    editor DOM host MOUNTED and hidden (review B3-R1).** Today it initializes Monaco only on mount,
    and returns early when `hostRef.current` is absent (`ConfigEditor.tsx:154–232`). Its comments
    (`:18`, `:142`) already describe the host as hidden, never unmounted. `App.tsx:255` starts in
    form mode, so a `return null` would leave Raw without an editor and break the preservation.
    Hide the header and the editor host (for example `hidden` / `display: none`), never unmount.
  - In `raw` mode it renders its editor with a header of `‹ Settings` (calls `onMode('form')`) and
    the title "config.json". The Segmented toggle is removed.
  - Preserve its existing behaviour: the status bar, the save path, and the editor instance that
    survives Raw → Form → Raw.
- **Proof.** Tests:
  - the row exists only when `onEditConfig` is given
  - clicking it switches to raw
  - `‹ Settings` returns to form
  - an INITIAL Form → Raw shows a working editor that loads `config.json`
  - Raw → Form → Raw preserves unsaved text, the cursor position and the undo history, using the
    Monaco mock in the existing tests or a new one at the editor-instance seam
  - Raw still saves

  There are no lifecycle tests today, so these are new.

### E. Tab context menu (4.1)

`session/SessionTabs.tsx` `.tab-menu` (the hand-positioned menu, ~`SessionTabs.tsx:695`) and its CSS
(`index.css` `.tab-menu*`).

**Item order, in three groups with a 1px `--t-surface` separator between them:**
1. **Edit:** Rename
2. **Layout:** Split right, Split down, New group from this tab / Add to <group>, the colour
   swatches, Open in new window
3. **Close:** Close, Close other tabs, Close tabs to the right — always last

**Look:**
- Each actionable item gets a leading 16px shared icon: `pencil`, `split`, `split` (rotated or
  `rotate-col`), `plus`, `external`, `close`. Add a name to `ui/icons.tsx` if one is missing, as an
  addition only.
- Item height `var(--ctl-h)` (28px). Deviation: the task's "30px" is off the 4px grid, so the
  control height is used.
- Text `var(--fs-3)`, radius `var(--r-2)`.

**Unchanged:** every item's behaviour and `data-testid`, conditional rendering (an item that would
do nothing is not rendered), keyboard/escape dismissal and the batch-1 entrance animation.

**Proof.** `SessionTabs` tests assert the item order and the presence of two separators.

### F. One heading style across the dock (4.2)

- **Panel title.** The dock panel title (`session/dock.css:78` `.dock-title`, today 10.5px uppercase
  tracked) becomes the panel title: `var(--fs-4)`, weight 650, `--t-text`, no uppercase,
  letter-spacing −0.01em. This is the first of the two heading levels.
- **Section titles.** Every remaining uppercase tracked section caption takes the A section-title
  style:
  - `panes/files.css:275` (Explorer root header)
  - `dictation/dictation-view.css:49`
  - `settings/config-editor.css:52`
  - `index.css:845`, `:2232` and `:2362`, if they are chrome headings: read each and decide; an
    uppercase that is a keycap or a badge may stay, with a note
- **New-tab chooser.** Its sections are Collapsibles, so A restyles them. Its emoji were already
  replaced in batch 1.
- **Proof.**
  - `DashboardBody` tests pass.
  - A test reads the stylesheets and asserts no `text-transform: uppercase` remains on the
    `.dock-title`, `.ui-collapsible-trigger`, Explorer root and dictation header selectors.
  - A 1440px screenshot of Settings, Explorer, New tab and Dictation shows one heading style.

### G. The black band (4.3)

**Investigate, then decide by evidence.** The batch-1 review saw a 16px pure-black band under the
terminal in headless Chromium at 1440×900.

- **Measure.** On the isolated smoke server, use `document.elementFromPoint` at that row, plus the
  computed heights of `.app`, `.content-row`, `.content-area`, `.term-wrap` and `.term-host`.
- **Fix it in this batch if** the band comes from app CSS: an element shorter than its container
  because of a calc, `--app-height`, or `100dvh` vs `100%`, in a way that also applies to a normal
  desktop Chromium window.
- **Leave the code alone if** it is a headless-only artifact (for example the area the WebGL canvas
  leaves when `width mod cellWidth` or `height mod cellHeight` is non-zero, which CLAUDE.md says is
  painted `--t-term-bg`, not black).
- **Either way,** record the measured cause and the decision under task 4.3 in `tasks.md` (the
  coordinator ticks it), and leave it open for the owner to confirm on his desktop.

### H. Scale migration of dock, dashboard and files CSS (4.4)

`session/dock.css`, `panes/dashboard.css` and `panes/files.css` move to the scale variables, with
on-scale literals where a variable would read worse. Lower the baselines to the exact new counts;
nothing may rise. Visual parity matters: a 7px that becomes 8px is fine, a layout jump is not. The
1440px screenshot comparison before and after is the check.

### I. Docs (3.7, plus the 4.x paragraphs)

Rewrite only the CLAUDE.md paragraphs on:
- the settings form (`.settings-form`, rows, sections)
- the theme picker ("The theme picker is not a `<select>`")
- the config JSON / Raw-Form wording
- the tab context menu
- dock titles

so they describe the new layout, the theme browser, the Edit config.json row, the menu groups and
the heading levels. Keep the reasoning that still holds (palette-painted previews,
`MAX_PREVIEW_CHARS`, the ring-not-fill highlight). Preserve every unrelated paragraph byte for byte.

## Approach and clusters (disjoint ownership, sequential where a file is shared)

1. **C1 (kit), first:**
   - files: new `ui/Select.tsx` (+ test), `ui/index.ts`, `ui/ui.css` (Select rules + Collapsible
     trigger title), `ui/ui.test.tsx`, `ui/icons.tsx` (additions only, if needed)
   - `ui/scale-baseline.json`: the `ui/ui.css` key only
2. **C2 (settings), after C1:**
   - files: `settings/SettingsFields.tsx` (+ test), new `settings/ThemeBrowser.tsx` (+ test),
     `settings/ThemePicker.tsx` + `ThemePicker.test.tsx` (deleted after the move),
     `settings/theme-picker.css` → `settings/theme-browser.css`, `settings/settings-view.css`,
     `settings/ConfigEditor.tsx` (+ test), `settings/config-editor.css`
   - `App.tsx`: only the ConfigEditor/SettingsFields wiring at ~1715–1740, plus any SettingsFields
     props elsewhere
   - `session/SessionDrawer.tsx`: only the Settings sub-view lift (+ `SessionDrawer.test.tsx`)
   - `index.css`: the `.settings-form` section only
   - `ui/scale-baseline.json`: its own keys only
3. **C3 (desktop rest), after C2:**
   - files: `session/SessionTabs.tsx` (tab menu only) + `SessionTabs.test.tsx`, `index.css`
     (`.tab-menu*` section only, and G's fix if it lands in `index.css`), `session/dock.css`,
     `session/DockPanel.tsx` (title only, if needed), `panes/dashboard.css`, `panes/DashboardBody.tsx`
     (only if markup must change), `panes/files.css`, `dictation/dictation-view.css`, plus the
     heading-style test
   - `ui/scale-baseline.json`: its own keys only
4. **C4 (docs), after C3:** `CLAUDE.md` only.

Test auditors run behind each builder, in their own cluster's test files.

## Non-goals

- The mobile drawer rows, gestures, scrim and keyboard hold (group 5).
- Any server change.
- Light-theme retuning beyond tokens.
- Migrating the whole of `index.css` (only the sections named here).

## Pre-existing uncommitted work (baseline)

The tree holds:
- batches 1 and 2, plus batch 2's fix round, still in flight when this plan was written. The
  coordinator snapshots the exact pre-batch-3 state at `~/.cache/claudex-nomcp/prebuild-b3/` after
  batch 2 closes, and batch 3 starts only then
- the 2026-10-24 morning keyboard and extra-keys work

All of it is preserved.

## Risks

- **[Restyling the kit Collapsible trigger changes every Collapsible at once]** → That is the intent
  (one heading style). The screenshot check covers Settings, New tab, Explorer and Dictation.
- **[Deleting ThemePicker breaks importers]** → `ThemePicker` is imported only by `SettingsFields`.
  Typecheck catches any other importer.
- **[The ConfigEditor instance must survive Raw → Form → Raw]** It holds the cursor and undo stack →
  The existing tests for that are kept, and form mode renders nothing but keeps the instance mounted
  if it is today. Preserve whatever mechanism exists.
- **[The scale migration shifts layout]** → Before/after screenshots at 1440px. Prefer the nearest
  scale step, and keep any visible deviation under one step.

## Verification (proof commands)

- `yarn typecheck`, `yarn lint` (0 errors) and `yarn test`, all from the repo root.
- Smoke exactly as in batch 2, never touching production:
  1. Build to `/tmp/palmux-smoke/dist`.
  2. Use a fresh `/tmp/palmux-smoke-b3/cfg` with the batch-2 seed, a loopback bind, `NO_AUTH` and the
     no-op theme hook.
  3. Check with Playwright at 1440×900:
     - Settings dock: cards; controls share edges; Font is a kit Select; no uppercase headings
     - the theme browser: open; pick 2 themes and the list stays; back; the row shows the name
     - Edit config.json: opens Raw; `‹ Settings` returns
     - tab context menu: groups, separators, icons
     - Explorer, New tab and Dictation headings
     - no console errors
     - the G measurement
  4. Check at 390×844 (mobile mode): the drawer Settings, a long theme name on one line, the theme
     browser in the drawer, and the drawer back header popping the sub-view.
  5. Stop the server by PID after checking its environment, and confirm production :44040 still
     answers.
- The production `dist` is NOT rebuilt.
