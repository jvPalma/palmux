## 1. Token derivation (D1)

- [x] 1.1 `settings/themes.ts`: `UiTokens` + `AccentName` types; `ColorProfile.ui`/`.accents` optional overrides; pure `deriveUiTokens(profile)` (luminance-aware shade direction, subtext blend, ANSI accent picks) + `deriveAccents(profile)` (12 slots, override-first).
- [x] 1.2 Per-profile overrides where derivation is visibly off (at minimum Catppuccin's real lavender/peach/pink; audit each built-in).
- [x] 1.3 Unit tests: override precedence; dark vs light shade direction; contrast floor (text vs base/surface) for EVERY built-in profile; all 12 accent slots resolve everywhere.

## 2. Application lifecycle (D2)

- [x] 2.1 `applyThemeTokens` sets all seven `--t-*` tokens + twelve `--tab-c-*` vars.
- [x] 2.2 App-level effect on `settings.themeId` + synchronous first-paint application from persisted settings; REMOVE the useTerminal call site (xterm ITheme mapping stays).
- [x] 2.3 Tests: panes-only theming (no terminal mounted → tokens applied) in App.test; first-paint application unit-level.

## 3. Tab accents + top-border redesign (D3, D4)

- [x] 3.1 `tab-meta.ts`: TAB_COLORS → 12 var-based entries (names: existing 8 + sky, lavender, maroon, gray); `tabColorValue` signature unchanged.
- [x] 3.2 `index.css`: `--tab-c-*` Mocha defaults at `:root`; `.ctab.colored` redesign — radius-following top bar, active full accent + color-mix body tint, inactive dimmed, hover step; swatch grid wraps 2×6.
- [x] 3.3 Verify no collision: accent + ◧/◨ badge + dirty dot + reorder insertion bar on one tab (test + screenshot).
- [x] 3.4 Tests: SessionTabs renders 12 swatches + ∅; colored tab carries the var-based accent; existing color names resolve.

## 4. Docs + verification

- [x] 4.1 README (themes now skin the whole app; tab palette) + tips + CLAUDE.md.
- [x] 4.2 `yarn typecheck` + `yarn test` green.
- [x] 4.3 Live e2e on isolated `:44041`: switch through EVERY built-in profile with screenshots (chrome coherence, no Mocha remnants, first-paint no-flash via reload under Gruvbox), tab accents re-resolve on switch, active/inactive/hover accent states, light-profile readability. Never prod `:44040`.
- [x] 4.4 `openspec validate theme-and-tab-accents --strict`.
