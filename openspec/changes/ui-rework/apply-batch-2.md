# ui-rework — apply batch 2 (open R1 + tasks 2.3–2.9)

Batch plan for the OpenSpec change `ui-rework`. The contracts live in this directory: `proposal.md`,
`design.md` §1 (with the owner's tuned pill values and the snap-to-scale decision), the `specs/`
deltas for `chrome-tab-strip`, `tab-accents`, `tab-customization`, `tab-grouping`, `split-fusion`
and `sidebar-dock`, and `tasks.md`.

Batch 1 is done and deployed: production `dist` rebuilt 2026-10-24.

**In scope:**
- the finding left open by batch 1, inspection 3 R1 (scale guard string parsing)
- tasks 2.3–2.9

**Out of scope:**
- 2.10, the owner's live sign-off after deploy
- groups 3–6

**Dependency.** `@radix-ui/react-dropdown-menu@^2.2.1` was added by the coordinator before the build
(`packages/client/package.json` and `yarn.lock`). Agents run no package installs.

## Acceptance criteria

### A. Scale guard parses CSS strings correctly (batch-1 R1)

`packages/client/src/ui/scale.test.ts` currently parses declarations by hand. Two defects:
- A quoted string closes at an escaped quote, so an escaped quote inside a `content` string swallows
  every declaration after it.
- `tokenizeWithSlashes` splits a quoted font family that contains `/`, so
  `font: 10.5px "UI/Body"` makes `fontShorthandSize` pick `"UI` and accept 10.5px.

**Fix:**
- Parse declarations with PostCSS, already a client devDependency used by
  `ui/press-consumers.test.tsx`, keeping rule/selector context, nested at-rules, comment-free values
  and source line numbers.
- Make value tokenization quote-aware, including escapes, so quoted strings are opaque when finding
  the shorthand size and the `/` separator.

**Fixtures:**
- `content: "a\"b"; padding: 7px` must report the 7px.
- `font: 10.5px "UI/Body"` must report 10.5px.
- `font: 600 12px/1 "A/B", monospace` must pass.

All existing scale tests stay green. The real-tree counts in `ui/scale-baseline.json` stay identical.
If the correct parser finds genuine violations the old one missed, update those counts and list each
file and value.

### B. Desktop tab strip renders as pills (2.3)

Implements spec `chrome-tab-strip` ("Desktop tabs render as pills", "The active pill clears a contrast
floor") with the values in design §1, snapped to the scale. Changes go in `session/SessionTabs.tsx`
and the strip and topbar section of `index.css` (~1800–2216).

**Every pill:**
- a 1px border at `color-mix(in srgb, var(--t-text) 10%, transparent)`
- radius `var(--r-2)` (6px)
- a gap of `var(--sp-2)` (8px) between strip entries
- height 28px (`var(--ctl-h)`)
- `min-width: 92px`, max ~200px, flex-grow so titles show in full when there is room

**Strip and topbar:**
- `.session-tabs` vertically centres its children; the Chrome flex-end and taller-active rules go.
- The topbar gets a 1px bottom separator or keeps the mantle/base contrast. The old "no bottom
  border" rule existed only so the Chrome active tab could merge with the content, and that reason
  is gone. Pick one and pin it in the test.

**Active pill:**
- background `color-mix(in srgb, var(--t-surface), var(--t-text) 10.5%)` (fill step 1.5 × 7%)
- ring `box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--t-text) 60%, transparent)`
- title at full `--t-text`, weight 600

**Inactive pill:**
- title `color-mix(in srgb, var(--t-text) 85%, var(--t-mantle))`
- no fill; a hover fill only on non-active pills

**Colour and icons:**
- Colour is a 7px dot (`--tab-accent`) before the title, only when the tab has a colour.
- The 8% tint, the coloured top border and the colour fill are removed. Colour never marks active.
- The kind icon renders only for non-terminal kinds (`kindIcon` from `tab-meta.ts`). Terminals show
  no icon.

**Unchanged:**
- the ✕ (`ctab-kill`) on the active pill and on hover, and the dirty dot
- every drag/drop, rename, middle-click and context-menu behaviour, and every `data-testid`
  (`session-tab-*`, `fused-tab-*`, `fused-seg-*`, `group-chip-*`, `tab-close-*`, `session-new`,
  `tab-rename-input`, `group-rename-input`, `tab-menu`)
- the drop insertion bars (`drop-before`/`drop-after`) and `join-armed` stay clearly visible on the
  new shape (spec `tab-accents` coexistence)
- the strip still scrolls horizontally, and the active pill still scrolls into view

**Drop targets in gaps (review R1).** The 8px gaps between pills and the cluster padding are NEW
empty space. Today the strip container's `onDragOver` (`SessionTabs.tsx:336–341`) treats any target
that is not `.ctab`/`.group-chip` as the trailing area and sets `dropIndex = entryCount`. Unchanged,
a tab dropped in a gap or inside a cluster's padding would append at the end, and a grouped tab would
LEAVE its group via `groupUpdate(removeIds)`, which `server.ts` persists.
- **Fix.** When the target is not a tab or chip, derive the insertion index from the pointer's x
  against the rendered entries' rects (plain pills, fused pills and chips), in the existing
  entry-index space: the nearest boundary wins. A drop counts as the trailing area ONLY when the
  pointer is right of the last entry's right edge. Over a gap, `centerJoinRef` and `joinArmedIndex`
  are always cleared.
- **Tests:** a drop in the gap between two plain pills, in a gap inside an expanded cluster
  (membership unchanged, i.e. no `removeIds`), in a collapsed cluster's padding, next to a fused
  pill, and in the true trailing area (still appends).

**Boundary drops around groups need an explicit anchor (review R3; the bug exists today for chip
drops too).** The entry-index space excludes chips (`SessionTabs.tsx:189–195`) and collapsed members
(`App.tsx:163` `visibleEntries`). With full order `[a, g1, g2, b, c]` and `{g1,g2}` collapsed,
"before the chip" and "after the chip" both map to index 1, which resolves to `b`. A tab or group
meant to land BEFORE the group therefore lands after it.
- **Fix.** `onReorder(id, index, joinGid?, beforeId?)` and `onMoveGroup(gid, index, beforeId?)`
  gain an optional `beforeId`: a FULL-order tab id that wins over the index. When the computed drop
  boundary sits immediately before a group chip (gap, chip left half, or the chip's own
  `onDragOver`), `SessionTabs` passes `beforeId` = the first member of that group in full order
  (collapsed or not). `App.tsx` `doReorder` (~867) and `moveGroup` (~935) use
  `const beforeId = anchor ?? entries[index]?.[0]`. A boundary just AFTER a group (between its last
  member or its collapsed chip and the next entry) keeps today's index mapping.
- **A boundary drop never joins a group.** Joining stays the centre-of-a-grouped-tab gesture, so a
  tab dropped before a chip keeps its membership. If it was a member of another group,
  `decideGroupDrop` keeps its existing leave semantics.
- **Integration tests (App-level, asserting the emitted order and group ops):**
  - `c` dropped before a collapsed `{g1,g2}` chip → `[a,c,g1,g2,b]`, no `addIds`
  - `c` dropped just after it → `[a,g1,g2,c,b]`
  - two adjacent collapsed groups, dropping between them
  - the same three cases with expanded groups
  - `moveGroup` of another group dropped before and after a collapsed group
- **The preview matches the commit (review R5).** Today the insertion marker comes only from
  `dropIndex` (`SessionTabs.tsx:317–321`), and only plain and fused pills render it, so a
  "before the chip" boundary would preview on the entry AFTER the group while committing before
  it.
  - Keep ONE resolved boundary in state, the `dropIndex` plus the optional `beforeId` anchor, and
    feed both the marker and `commitDrop` from it.
  - When the anchor is set, render the insertion marker at the LEFT edge of that group's
    cluster/chip (`drop-before` on `.group-cluster`, or on the chip when the cluster wrapper is
    absent), and suppress the numeric-index marker for that hover.
  - Test: hovering just before and just after a collapsed group, and between two adjacent collapsed
    groups, shows the marker on different elements, and each committed order matches its preview.

### C. Groups render as a framed cluster (2.4)

Implements spec `tab-grouping` ("The strip renders groups as chips + clusters").
- The chip and the member pills of a group render inside one wrapper element,
  `.group-cluster`, with a 1px frame in the group colour (`--group-accent`), radius `var(--r-3)`,
  inner padding 2–4px and the same 8px gap. A collapsed group's cluster holds only its chip.
- The wrapper is presentational: drag/drop indices, `entryIndexByPos`, insertion maths and the chip's
  DnD stay exactly as today.
- The chip keeps the group-colour fill with luminance ink (`--group-ink`), and its look does NOT
  change when a member is active. The `member-active` visual goes; the class may stay for tests or
  hooks, but no style may depend on it.
- The 3px group underline and the `:has(+ …)` shared-radius rules go.
- A member keeps its own colour dot.

**Test:** activating a member leaves the chip's class list and computed fill unchanged.

### D. Fused pairings render as one pill (2.5)

Implements spec `split-fusion` ("A pairing renders as one fused strip button").
- One pill holds a leading `<Icon name="split" />` and two segments separated by a 1px seam. The
  glyph and the seam are visible whether or not the pairing is active.
- Each segment shows its colour dot (if coloured) and title. A non-terminal member shows its kind
  icon.
- When the pairing is active, the pill takes the active treatment and the focused segment
  (`fused-seg.on`) is raised inside it, with full text. The other segment stays unraised, with
  inactive text. Colour never marks focus; the solid and dimmed tints go.
- Each segment keeps a minimum width.

**Tests:**
- glyph and seam present while the pairing is inactive
- focused segment raised
- `SplitView.test.tsx`'s one-mount assertion still passes

### E. App-menu button replaces the wordmark (2.6)

Implements spec `chrome-tab-strip` "The topbar leads with an app menu button" and spec
`sidebar-dock` (pointer route to Settings with the rail hidden).
- **Kit wrapper.** A new `ui/DropdownMenu.tsx` wraps `@radix-ui/react-dropdown-menu`, styled with the
  existing `.ui-menu` / `.ui-menu-item` classes in `ui/ui.css` (micro-tier entrance from
  `--radix-dropdown-menu-content-transform-origin`; add that origin variable to the menu rule if it
  is missing). Export it from `ui/index.ts`.
- **Placement.** In `App.tsx`, the desktop topbar's `<span className="topbar-brand">palmux</span>`
  (~line 1516; NOT the pop-out bar's at ~1493) becomes an icon button (`<Icon name="menu" />`,
  `aria-label="palmux menu"`, 28px, kit IconButton styling) that opens the menu.
- **Items:**
  - Settings → the same handler as the `settings` keybinding (`App.tsx:1137`,
    `openDockView('settings')` on desktop)
  - Tips → `setPanel('tips')`
  - Reload app → a NEW app-level `guardedReload()` in `App.tsx`, NOT `reloadApp()` directly (review
    R2). `reloadApp()` (`settings/app-reload.ts:50–70`) reloads unconditionally. An editor whose save
    was rejected keeps its unsaved buffer, and `dirtyRef` / `dirtyTabs` (`App.tsx:~1300`) knows
    about it, so a bare reload destroys that work. `guardedReload()` counts the dirty editor tabs;
    if there are any, it asks
    `window.confirm('<n> editor tab(s) have unsaved changes. Reload and discard them?')`, mirroring
    the close-tab discard confirm at `App.tsx:~1262`, and returns without reloading on cancel.
    Otherwise it calls `reloadApp()`.
- **The same protection for the existing Settings → Reload app row:** `settings/SettingsFields.tsx`
  (~218) calls `reloadApp()` directly today. It takes an optional `onReloadApp` prop that `App`
  supplies as `guardedReload`, keeping `reloadApp` as the fallback for hosts that pass nothing.
- **`guardedReload` reports whether it is proceeding (review R4):** it returns `Promise<boolean>`,
  `false` when the user cancels. Today `ReloadRow` (`SettingsFields.tsx:217–223`) sets `busy` and
  "Reloading…" BEFORE calling reload and never resets it. It must enter the busy state only once
  reload is confirmed (the promise resolves `true`), and reset `busy` if reload is cancelled or
  throws. Test: cancel, then retry WITHOUT remounting `SettingsFields`; the button is enabled again
  and the second attempt proceeds.
- **Tests:**
  - With `sidebarRail: 'hidden'`, opening the menu and choosing Settings opens the settings view.
  - With a dirty editor tab, Reload app from the menu AND from Settings asks for confirmation;
    cancelling does not call the reload; accepting does.
  - With no dirty tab, it reloads without asking.

### F. Rail order (2.7)

Implements spec `sidebar-dock` "The rail orders entries by frequency of use".
- `session/DockPanel.tsx`: the rail renders New tab, Explorer, Dictation, the separator, Upload,
  Download, and Settings pinned to the BOTTOM of the rail. Use `margin-top: auto` on its own element
  in `session/dock.css`.
- `DOCK_VIEWS` order changes accordingly. It has no consumers outside `DockPanel.tsx`; verified by
  grep. The mobile drawer's own `VIEWS` list is untouched; mobile ordering is group 5.

**Test:** `DockPanel.test.tsx` asserts the rendered order with Settings last.

### G. Scale migration of the touched CSS (2.8)

Every declaration this batch writes or rewrites in the strip/topbar section of `index.css`, in
`session/dock.css` (rail) and in `ui/ui.css` (dropdown) uses scale variables or on-scale literals.
Lower the matching entries in `ui/scale-baseline.json` (the ratchet demands the exact lower count).
No baseline may rise.

### H. Docs (2.9)

Rewrite the CLAUDE.md paragraphs that describe the old strip:
- the Chrome-like tab strip
- the four cues of a fused pairing
- the group chip and the 3px line
- the topbar wordmark
- the rail order

so they describe the pills, the cluster, the fused pill, the app menu and the new rail. No paragraph
may still describe the Chrome tab shape, the 8% tints, the solid group chip or the 3px group line.
Preserve every unrelated paragraph byte for byte.

## Approach and clusters (disjoint file ownership)

- **C1 (guard, runs FIRST, alone):** `ui/scale.test.ts`, plus `ui/scale-baseline.json` only if A
  finds genuine misses. It finishes before C2 starts, because C2 lowers baselines that C1's parser
  defines.
- **C2 (strip):**
  - `session/SessionTabs.tsx`, `session/SessionTabs.test.tsx`, `session/tab-strip-css.test.ts`
  - the strip and topbar section of `index.css` (~1800–2216; nothing outside it)
  - `ui/scale-baseline.json`, its `index.css` entry only
  - `App.tsx`: ONLY `doReorder` and `moveGroup` (the R3 anchor), with their tests in `App.test.tsx`
- **C3 (menu and rail):**
  - new `ui/DropdownMenu.tsx`, `ui/index.ts`, `ui/ui.css` (dropdown rules only), `ui/ui.test.tsx`
    (dropdown assertions only)
  - `App.tsx`, `App.test.tsx`, `settings/SettingsFields.tsx`, `settings/SettingsFields.test.tsx`
  - `session/DockPanel.tsx`, `session/DockPanel.test.tsx`, `session/dock.css`
  - `ui/scale-baseline.json`, its `ui/ui.css` and `session/dock.css` entries only
  - **C2 and C3 run SEQUENTIALLY (C2 first):** the R3 fix puts `App.tsx` `doReorder`/`moveGroup`
    into C2's scope (only those two functions plus their tests in `App.test.tsx`), and C3 owns the
    rest of `App.tsx` (app menu, `guardedReload`). Running them in order keeps every file to one
    writer at a time. Both touch `scale-baseline.json` on different keys; each edits only its own
    entries and re-reads the file just before writing.
- **C4 (docs, after C2 and C3):** `CLAUDE.md` only.
- **Unchanged:** the server, the protocol, tab ids, persisted data, mobile UI (the strip is
  desktop-only) and the extra-keys bar.

## Non-goals

- Settings, dock content, menus' density (4.1), and the drawer (group 5).
- New-tab chooser styling.
- Light-theme tuning beyond the tokens.

## Pre-existing uncommitted work (baseline)

All of batch 1 plus this morning's keyboard and extra-keys edits are uncommitted in the tree. The
exact pre-batch-2 state is snapshotted at `~/.cache/claudex-nomcp/prebuild-b2/` and is used to isolate
this batch's diff. Batch 2 must preserve all of it. The coordinator added
`@radix-ui/react-dropdown-menu` to `package.json`/`yarn.lock` before the build.

## Risks

- **[The cluster wrapper changes DOM nesting the DnD code relies on]** `closest('.ctab')`, insertion
  indices, `onDragOver` on chips → The wrapper is presentational only. Existing SessionTabs DnD tests
  must pass unchanged, and the review checks every `closest()`/index use.
- **[Removing the flex-end/taller-active rules breaks the window-controls-overlay contract]**
  (`tab-strip-css.test.ts:142–166`) → That describe block must keep passing.
- **[Pills fit fewer tabs]** → min-width 92px; 9 tabs fit at 1440px per design §1.
- **[Light themes]** → All colours are token mixes; the smoke checks one light theme screenshot.

## Verification (proof commands)

- `yarn typecheck`, `yarn lint` (0 errors; existing warnings allowed) and `yarn test`, all from the
  repo root. All must pass.
- Smoke, exactly as in batch 1, never touching production:

  ```bash
  # from the repo root; the subshell keeps the cwd at the root
  (cd packages/client && npx vite build --outDir /tmp/palmux-smoke/dist --emptyOutDir)
  ```

  Use a FRESH `/tmp/palmux-smoke-b2/cfg` holding:
  - `config.json`:
    `{"host":"127.0.0.1","port":44099,"restoreSessions":false,"shell":"/bin/bash"}`
  - a no-op `theme-hook.mjs` (`export {};`)
  - a seeded `tabs.json` with:
    - a 2-member group (colours ansi5, ansi3)
    - a red tab
    - two adjacent tabs for a split pairing
    - an uncoloured tab
    - a markdown tab
    - a web tab
  - a `groups.json`

  Start it from the repo root:

  ```bash
  cd /home/user/projects/palmux
  PALMUX_HOST=127.0.0.1 PALMUX_CLIENT_DIR=/tmp/palmux-smoke/dist \
    PALMUX_CONFIG_DIR=/tmp/palmux-smoke-b2/cfg PALMUX_NO_AUTH=1 \
    node node_modules/tsx/dist/cli.mjs packages/server/src/index.ts
  ```

  Seed the split with `localStorage['palmux-splits']` (`{v:2,pairings:[…]}`). Check with Playwright at
  1440×900, taking a screenshot of each state:
  - **active plain pill:** raised and ringed, and the only filled pill
  - **active group member:** chip fill unchanged
  - **active split:** glyph + seam, focused segment raised
  - **inactive split:** glyph + seam still visible
  - **hover:** an inactive pill gets a hover fill, the active pill keeps its fill
  - **app menu:** opens Settings with `sidebarRail` set to `hidden`
  - **rail:** order with Settings at the bottom
  - **console:** no errors
  - **light theme:** one screenshot

  Stop the server by PID after checking its environment, and confirm production (:44040) still
  answers.
- The production `packages/client/dist` is NOT rebuilt by this batch; the deploy is the owner's call.
