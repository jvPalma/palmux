## Context

`settings/themes.ts` holds `COLOR_PROFILES` (id/name/fg/bg/ansi16 → xterm ITheme);
`applyThemeTokens` (themes.ts:168) sets only `--t-base` + `--t-text` and is invoked from
`useTerminal`'s settings effect — so themes half-apply, only when a terminal exists.
All chrome styling reads seven `--t-*` vars whose statics are Catppuccin Mocha
(index.css `:root`). Tab accents: `TAB_COLORS` (tab-meta.ts, 8 hex literals) feed a
per-tab `--tab-accent` inline var painted by `.ctab.colored { box-shadow: inset 0 3px 0 }`
(index.css:938) — square, corner-blind, theme-blind. Persisted tab `color` is an opaque
NAME server-side; `themeId` is already a synced setting.

## Goals / Non-Goals

**Goals:**

- One derivation pipeline: profile → full seven-token set (+ 12 accent slot vars).
- Boot-time + App-level application; useTerminal keeps only xterm theming.
- Var-based TAB_COLORS (names stable, values per theme), 12 colors, redesigned accent.

**Non-Goals:**

- New themes or a theme editor (built-in profiles only; additions stay one-object cheap).
- Theming embedded iframes/Monaco beyond what exists (monaco-loader keeps its mapping).
- Server/protocol changes of any kind.

## Decisions

### D1 — `deriveUiTokens(profile): UiTokens` in themes.ts, override-first

`ColorProfile` gains optional `ui?: Partial<UiTokens>` and `accents?: Partial<Record<AccentName, number>>`.
Derivation for omissions: mantle/surface = bg shifted toward black/white by fixed
lightness steps IN THE CORRECT DIRECTION for dark vs light bg (relative luminance
decides); subtext = fg blended 40% toward bg; accent = ansi green (slot 2), accent-alt
= ansi yellow (slot 3) — matching today's Mocha semantics (green one-shot, warm locked).
Pure + unit-testable (contrast assertions per built-in profile).

### D2 — Application lives in App, first-paint safe

`applyThemeTokens(profile)` (now setting ALL tokens + `--tab-c-*`) is called from an
App-level effect on `settings.themeId` AND synchronously at module init from the
locally persisted settings (localStorage read — same source useSettings hydrates from)
so the first frame is themed. `useTerminal` drops its call (keeps `toXtermTheme`).

### D3 — Accent slots as CSS variables, names as the contract

12 `AccentName`s: the current 8 (red, peach, yellow, green, teal, blue, mauve, pink) +
sky, lavender, maroon, gray. Each maps per-theme to an ANSI-derived or overridden hex,
exposed as `--tab-c-<name>`. `TAB_COLORS` becomes `{ name, value: 'var(--tab-c-…)' }` —
`tabColorValue` keeps its signature, swatches/`--tab-accent` keep working, persisted
names untouched. ANSI-derived defaults: red→1, green→2, yellow→3, blue→4, mauve→5,
teal→6, gray→8, plus bright variants/blends for peach, pink, sky, lavender, maroon
(explicit `accents` overrides where a profile has better-fitting colors, e.g.
Catppuccin's real lavender).

### D4 — Accent redesign: border-top + inherited radius + tinted body

Replace the inset shadow with a real top treatment on `.ctab.colored`: a top border (or
::before bar with `border-radius: inherit` clipping) that follows the tab's rounded
corners; active tab additionally gets
`background: color-mix(in srgb, var(--tab-accent) 12%, <tab bg>)`; inactive colored
tabs render the bar at reduced opacity; hover brightens. The reorder insertion bar
(outer box-shadow) and ◧/◨ badges are orthogonal channels — verified by a stacked
test/screenshot. Exact pixel values live in CSS, not spec.

## Risks / Trade-offs

- **[Derived colors can look bad on some profile]** → per-profile overrides are the
  escape hatch; visual e2e screenshots across all built-ins before calling it done.
- **[First-paint apply reads localStorage pre-React]** → same parse the settings module
  already exposes; a corrupt blob falls back to defaults (existing behavior).
- **[color-mix/oklch support]** → color-mix in srgb is already used elsewhere in this
  css (baseline fine in the PWA's Chrome floor); derivation math stays in TS, not CSS.
- **[12 swatches widen the context menu]** → grid wraps to two rows of 6; still compact.

## Migration Plan

Client-only, additive. Persisted color names resolve identically or better; themeId
untouched. Rollback = revert diff. No coordination with the server.

## Open Questions

- **OQ1**: should `--t-accent`(-alt) ALSO feed from the accent-slot table instead of
  raw ANSI picks (single source)? Proposed: yes — accent = slot green, accent-alt =
  slot peach — decided at implementation if it stays visually equivalent for Mocha.
