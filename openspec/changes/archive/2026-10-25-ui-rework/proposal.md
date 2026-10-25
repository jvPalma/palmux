# Proposal

## Why

The 2026-10-24 review (`~/.agent/diagrams/palmux-ui-review.html`) captured every surface on desktop
and on the owner's phone. It found two problems the owner had already named.

- **Desktop tabs:** the strip cannot say which tab is active, which ones are split, and which ones
  are grouped. The active tab differs from the strip by about 9/255. Coloured inactive tabs are
  louder than the active one. The group chip turns solid when a member is active and outshouts the
  tab. An inactive split pairing looks like two ordinary tabs.
- **Settings:** spacing and control sizes have no rhythm.

The root cause is the absence of a scale. The client CSS carries 20 font sizes, 76 distinct
paddings, 19 radii, 15 gaps and about 24 emoji or text glyphs used as icons. The owner answered the
eight review decisions (D1–D8) on the same day. This change turns those answers into one rework.

## What Changes

- **Desktop tab strip becomes pills (D1-B), with a contrast requirement.**
  - Every tab is a rounded pill with a subtle 1px border.
  - The active pill takes a raised fill and a ring that clear a stated contrast floor against the
    strip.
  - A group is a frame around its members, led by a chip that never changes fill with activation.
  - A split pairing is one pill with two segments and a split glyph, visible when inactive too.
  - The owner reserved the final look: "tenho de ver para decidir". The tab phase therefore starts
    with a tunable prototype, and the owner signs it off before the strip is rebuilt.
  - **BREAKING (visual):** this replaces the Chrome tab shape. The top-only radius, the taller
    active tab and the 8% tints go.
- **A tab's colour becomes a 7px dot before the title (D2-A),** on the strip and in the drawer.
  Colour no longer encodes the active state anywhere.
- **Settings move to a grouped-card layout (D3-A).**
  - Sections become cards with a label column and a fixed control column.
  - All controls share one height and one Select component.
  - Focus rings appear for keyboard focus only.
  - **Theme becomes a button** that opens a theme-list sub-view inside the same dock or drawer.
    Tapping a theme applies it live, so the owner can try themes freely and go back when one fits.
- **The topbar's `palmux` wordmark becomes an app-menu icon button (D4-C)** with a pointer route to
  Settings and Tips. (Batch 12 later moved it to the topbar's END, above the rail, and retired the
  `sidebarRail` option: the desktop rail is always shown.)
- **Navigation order follows reach (D5).**
  - Desktop rail: New tab, Explorer, Dictation · Upload, Download · Settings last.
  - Mobile drawer: the most-used views sit nearest the bottom edge, where the thumb is.
- **Opening the mobile drawer never loses the keyboard (D6, the owner's own design).**
  - The drawer opens full-screen.
  - If the IME goes away, the layout holds still, as it already does during a text selection.
  - Closing the drawer re-raises the keyboard only if it was up when the drawer opened.
- **The mobile drawer's session list becomes a tree (D7-B).**
  - Long-press and drag reorders tabs and moves them in and out of groups. The model is the DGSL
    design system's `TreeView`, ported to palmux tokens.
  - Long-press without moving opens the tab's context menu.
  - Close moves off the row into that menu, or behind a swipe left.
  - A row becomes colour dot + title + a subdued tab number. The big numbered circles and the
    per-row kind glyphs for terminals go.
- **One scale and one icon set.**
  - CSS custom properties define type (11/12/13/15, mono 13), spacing on a 4pt grid, radii (4/6/10
    plus pill) and control heights (28 desktop, 36 mobile).
  - A single SVG icon module replaces every emoji or glyph used as an icon.
  - A guard test rejects off-scale values, as `ui.test.tsx` already rejects colour literals.
- **Four motion additions that pass the gate:** a drawer scrim, origin-aware popovers and menus,
  press feedback on kit buttons, and list-row enter/exit. Each one lands on an existing tier.

## Capabilities

### New Capabilities

- `mobile-drawer`: the drawer as a surface:
  - keyboard-preserving full-screen open and close
  - the session tree with long-press reorder and grouping
  - row anatomy
  - close via the context menu or a swipe
  - reach-ordered navigation and the scrim
- `settings-panel`: the settings layout contract (grouped cards, label and control columns, one
  control height, one Select, keyboard-only focus rings) and the in-place theme browser with live
  apply.

### Modified Capabilities

- `chrome-tab-strip`: the strip's visual language changes from Chrome tabs to pills with a
  contrast floor and a subtle border. Kind icons appear only for non-terminal tabs. Width becomes
  flexible. The wordmark becomes an app-menu button. The drawer-row requirement drops its fill and
  tint language.
- `tab-accents`: the accent renders as an identity dot instead of a fill or tint. The coexistence
  rule is restated for dots.
- `tab-customization`: the colour requirement drops the solid-when-active and 8%-tint-when-inactive
  rendering for the dot.
- `tab-grouping`: groups render as a framed cluster led by a chip whose fill does not follow
  activation. The 3px underline and the solid-on-active chip go.
- `split-fusion`: the fused button becomes a two-segment pill with a split glyph that stays visible
  while inactive. The focused segment is raised; the solid-fill and dimmed-tint segment colours go.
- `sidebar-dock`: the rail order is fixed (Settings last), and the rail is always shown on desktop
  (batch 12 retired the hide option); the app-menu button is a second pointer route to Settings.
- `expanded-settings-surface`: `sidebarRail` still parses but controls nothing (batch 12).
- `ui-primitives`: adds the type, spacing, radius and control-height scale with its guard test, the
  single SVG icon set, and the four motion additions within the existing tiers.

## Impact

- **Client CSS:**
  - `index.css` (strip, drawer, settings form, extra-keys, popups)
  - `session/dock.css`, `session/drawer-views.css`, `ui/ui.css`
  - `panes/dashboard.css`, `panes/files.css`, `settings/*.css`
  - a new scale-token block next to the eight `--t-*` tokens
- **Client components:**
  - `session/SessionTabs.tsx` (strip and fused buttons)
  - `session/SessionDrawer.tsx` (rows become a tree, gestures)
  - `session/DockPanel.tsx` (rail order)
  - `settings/SettingsFields.tsx`, `settings/ThemePicker.tsx` (button plus theme sub-view)
  - `App.tsx` (topbar app menu; drawer keyboard hold, reusing the selection-deferral path)
  - a new `ui/icons.tsx` grown from `mobile/key-icons.tsx`
  - the emoji call sites in the dashboard, Explorer, drawer footer and menus
- **Tests:**
  - `session/tab-strip-css.test.ts` and the strip, drawer and settings tests change with the visual
    contract
  - a new scale guard test
  - TreeView behaviour tests ported with the component
- **No protocol or server change.** Reorder and grouping from the drawer reuse `reorderTabs` and
  `groupUpdate`.
- **One new runtime dependency:** `@radix-ui/react-dropdown-menu` for the app menu, from the same
  family the kit already uses. The TreeView is ported, not imported: palmux has no Tailwind and no
  `lucide-react`, and `@design/ds` is a different repository.
- **Docs:** CLAUDE.md sections on the tab strip, split fusion, the drawer and `--mbtn-h`, plus
  `tips/tips.ts` for the new drawer gestures.
