## Why

Picking a terminal theme (Dracula, Gruvbox, …) only re-skins xterm: `applyThemeTokens`
sets just `--t-base` and `--t-text`, so the topbar, panels, drawer, accents, and every
control stay Catppuccin Mocha — the app looks mismatched under any non-default theme.
Separately, tab color accents are a fixed 8-color Mocha palette painted as a crude
`inset 0 3px` shadow that ignores the tab's rounded shape and stays identical across
themes. The user wants the whole webapp to follow the picked theme, more/better tab
accent colors, and a properly designed tab top-border accent.

## What Changes

- **Full theme-token derivation**: every UI token (`--t-base`, `--t-mantle`,
  `--t-surface`, `--t-text`, `--t-subtext`, `--t-accent`, `--t-accent-alt`) derives from
  the selected color profile — explicit per-profile overrides where a profile defines
  them, algorithmic derivation (bg lighten/darken, fg dim, ANSI picks) otherwise. The
  whole app re-skins on theme switch, not just the terminal canvas.
- **Token application moves to App level** (theme applies with zero terminals mounted,
  and on boot before first paint — no Mocha flash under another theme).
- **Theme-aware tab accent palette**: tab colors resolve through per-theme CSS variables
  (`--tab-c-<name>`), so "red" is Dracula-red under Dracula and Gruvbox-red under
  Gruvbox. The palette GROWS from 8 to 12 named colors (adds e.g. sky, lavender,
  maroon, gray). Persisted color NAMES are unchanged — existing tabs keep their color.
- **Redesigned tab accent**: the top-edge accent follows the tab's rounded shape
  (no square shadow poking out of round corners), reads clearly in both active and
  inactive states (inactive = dimmed accent, active = full accent + a subtle
  color-mixed tint of the tab body), and the context-menu swatches render the
  theme-resolved values.

## Capabilities

### New Capabilities

- `theme-tokens`: the derived UI token set, its application lifecycle, and per-profile
  overrides.
- `tab-accents`: the theme-aware, 12-color tab accent palette and the redesigned tab
  top-border treatment.

### Modified Capabilities

<!-- none archived; additive over the unarchived tab changes. -->

## Impact

- **Client only** (no protocol/server changes — color names stay opaque strings):
  `settings/themes.ts` (token derivation + per-profile `ui` overrides + accent slots),
  `terminal/useTerminal.ts` (drop its applyThemeTokens call), `App.tsx` (apply at boot +
  on settings change), `session/tab-meta.ts` (TAB_COLORS → var-based, 12 entries),
  `SessionTabs.tsx` (swatch rendering unchanged shape, more swatches), `index.css`
  (accent redesign + `--tab-c-*` defaults).
- **Persistence untouched**: tab `color` names and `themeId` already sync via settings.
- **Docs**: README theme section, tips.
