# user-theme-files Specification

## Purpose

Discovery of user-supplied and common-emulator terminal themes (files, system X resources, Alacritty/Kitty/Ghostty/WezTerm/Termux), offered in the picker and fed through the whole theming pipeline.

## Requirements

### Requirement: User-supplied theme files are discovered and offered

The server SHALL discover color themes from `~/.config/palmux/themes/*.conf` (Xresources syntax) and
`*.json` (Windows-Terminal / VS Code color-scheme shape), parse each into the existing `ColorProfile`
shape, and broadcast them to clients alongside the built-in profiles so they appear in the theme
picker. Discovery SHALL be realpath-confined and symlink-escape-safe, matching the existing
font-discovery / `markdownRoots` confinement pattern, and SHALL hot-reload via `fs.watch`.

#### Scenario: Xresources theme appears in the picker

- **WHEN** a user drops `mytheme.conf` (with `foreground`/`background`/`color0..15`) into `~/.config/palmux/themes/`
- **THEN** "mytheme" appears as a selectable profile whose ANSI/fg/bg drive the terminal and the derived UI tokens

#### Scenario: Windows-Terminal JSON theme

- **WHEN** a `*.json` color scheme in Windows-Terminal shape is present
- **THEN** it is parsed into a `ColorProfile` (its `purple` mapped to the magenta ANSI slot) and offered

#### Scenario: Malformed theme file is skipped, not fatal

- **WHEN** a theme file is missing required colors or is not valid
- **THEN** it is skipped with a logged warning and the other themes still load

### Requirement: Auto-discovery of common external terminal themes

The server SHALL optionally auto-discover color themes from the well-known config locations of common
terminal emulators (e.g. Alacritty, Kitty, Ghostty, WezTerm, Termux) when present, parse each into a
`ColorProfile`, and offer the found themes as selectable profiles (clearly labeled by source). Missing
locations SHALL be skipped silently; discovery SHALL be confined and safe like the `themes/` dir walk,
and SHALL never fail boot.

#### Scenario: Alacritty theme discovered

- **WHEN** an Alacritty color config exists at its standard location
- **THEN** its palette is offered as a selectable profile labeled with its source (e.g. "Alacritty")

#### Scenario: No external configs present

- **WHEN** none of the known emulator config locations exist
- **THEN** discovery adds nothing and boot is unaffected

#### Scenario: Unparseable external config skipped

- **WHEN** a discovered emulator config cannot be parsed into a profile
- **THEN** it is skipped with a logged warning and other themes still load

### Requirement: A system profile derives from the host X resources

The server SHALL offer a `system` profile derived from `~/.Xresources` (requiring at least
`foreground` + `background`), so a user's existing terminal palette is available without writing a
palmux-specific file.

#### Scenario: System profile from Xresources

- **WHEN** `~/.Xresources` defines foreground/background (and optionally color0..15)
- **THEN** a `system` profile is offered that reflects those colors

### Requirement: User themes flow through the whole theming pipeline

A selected user/system theme SHALL feed `deriveUiTokens`/`deriveAccents` (whole-app chrome), the xterm
palette, AND the shell/tmux theme export identically to a built-in profile — no user theme is a
second-class citizen.

#### Scenario: User theme exports to the shell

- **WHEN** a user selects a `*.conf` theme and saves settings
- **THEN** `theme.sh`/`theme.tmux` regenerate from that theme just as they do for a built-in profile
