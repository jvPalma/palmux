# pwa-window-controls Specification

## Purpose

Progressive-web-app window-controls-overlay titlebar integration with a theme-driven manifest color, degrading to standalone.

## Requirements

### Requirement: window-controls-overlay PWA titlebar mode

The installed PWA SHALL support `display_override: ["window-controls-overlay", …]` with the app
laying out its top chrome into the `env(titlebar-area-*)` region, so the installed window integrates
its titlebar. This SHALL degrade cleanly to standalone display where the mode is unsupported.

#### Scenario: WCO region respected when installed

- **WHEN** the app runs as an installed PWA with window-controls-overlay active
- **THEN** the top chrome lays out within the titlebar-area insets and remains fully usable

#### Scenario: Graceful without WCO

- **WHEN** window-controls-overlay is unsupported
- **THEN** the app renders in standalone mode with no broken layout

### Requirement: Manifest color follows the theme

The PWA/manifest color surface SHALL reflect the active theme (paired with the live `theme-color` meta
in `theme-tokens`) rather than a hardcoded default.

#### Scenario: Installed chrome matches theme

- **WHEN** a non-default theme is active in the installed PWA
- **THEN** the window/theme color reflects that theme, not the default palette
