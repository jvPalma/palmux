## ADDED Requirements

### Requirement: The entire webapp follows the selected terminal theme

Selecting a color profile SHALL re-skin the whole app chrome — topbar, tab strip, panels, drawer, buttons, panes, overlays — by deriving every UI token (base, mantle, surface, text, subtext, accent, accent-alt) from that profile, not only the terminal canvas. Switching themes SHALL take effect immediately without a reload.

#### Scenario: Non-default theme, coherent chrome

- **WHEN** the user selects Gruvbox Dark
- **THEN** the topbar/panels/controls render in Gruvbox-derived colors (no Catppuccin remnants) and the terminal palette matches as today

#### Scenario: Live switch

- **WHEN** the theme is changed in Settings
- **THEN** the app chrome updates in place, terminals re-rasterize as they already do

### Requirement: Tokens derive with per-profile override precedence

Each profile MAY declare explicit UI tokens; any token it omits SHALL be derived deterministically from the profile's bg/fg/ANSI colors (e.g. mantle/surface as bg shade steps, subtext as dimmed fg, accents from ANSI slots). Derivation SHALL keep readable contrast between text and surfaces for every built-in profile, including the light one(s).

#### Scenario: Override wins

- **WHEN** a profile declares an explicit accent token
- **THEN** that value is used verbatim; its other tokens still derive

#### Scenario: Light profile stays readable

- **WHEN** a light-background profile (e.g. Solarized Light, if present) is selected
- **THEN** derived surfaces darken (not lighten) relative to bg and text tokens keep contrast

### Requirement: Theme applies at boot and without terminals

Theme tokens SHALL be applied when the app boots (before meaningful paint — no default-theme flash) and whenever settings change, independent of any terminal being mounted (a panes-only workspace is fully themed).

#### Scenario: Panes-only workspace

- **WHEN** the active tab is an editor/web pane and no terminal has ever mounted
- **THEN** the selected theme's tokens are applied

#### Scenario: Boot under a saved theme

- **WHEN** the app loads with a persisted non-default themeId
- **THEN** the first rendered frame already uses that theme's tokens
