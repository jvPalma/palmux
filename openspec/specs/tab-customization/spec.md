# tab-customization Specification

## Purpose

Tabs can be renamed and colored with a display-name precedence, and the customization survives restarts and reconnects.

## Requirements

### Requirement: Tabs can be renamed

Any tab SHALL be renameable. Desktop: double-click the tab enters inline rename (Enter commits,
Escape cancels); the right-click context menu SHALL also offer Rename. Mobile: long-press a
drawer row opens a sheet with a rename field. Committing sends `updateTab { id, name }`;
committing an empty name clears the override.

#### Scenario: Inline rename commits on Enter

- **WHEN** the user double-clicks a tab, types "build", and presses Enter
- **THEN** `updateTab` is sent with name "build" and the tab title updates on all clients

#### Scenario: Escape cancels

- **WHEN** the user is in inline rename and presses Escape
- **THEN** no `updateTab` is sent and the previous title remains

### Requirement: Display-name precedence

A tab's displayed title SHALL be: custom name if set, else the live OSC title (terminal tabs),
else a kind default (`shell`, the web tab's hostname, `dashboard`, `editor`). A custom name
SHALL NOT be overwritten by subsequent OSC title changes.

#### Scenario: OSC title changes under a custom name

- **WHEN** terminal tab 1 is custom-named "logs" and the shell emits a new OSC title
- **THEN** the tab keeps displaying "logs"

#### Scenario: Clearing the name restores OSC

- **WHEN** the custom name on tab 1 is cleared
- **THEN** the tab displays the most recent OSC title again

### Requirement: Tabs can be colored from a fixed palette

The context menu (desktop) and the row menu (mobile) SHALL offer the active theme's 16 ANSI
colors (two rows of 8 — normal and bright) plus "none". The color SHALL render as an identity dot
before the title (desktop strip and mobile drawer alike); it SHALL NOT fill or tint the tab.
Selecting sends `updateTab { id, color }` carrying the ANSI slot name; "none" clears it. Legacy
persisted color names continue to resolve (see `tab-accents`).

#### Scenario: Color applies everywhere

- **WHEN** the user colours tab 2 orange from the desktop context menu
- **THEN** tab 2 shows an orange dot in the desktop strip and in the mobile drawer on all connected
  clients, and neither surface fills the tab orange

#### Scenario: None removes the accent

- **WHEN** the user selects "none"
- **THEN** the tab shows a neutral dot (or none) and keeps the same active treatment as any other
  tab

#### Scenario: Sixteen swatches in both surfaces

- **WHEN** the color picker opens on desktop and in the mobile row menu
- **THEN** both show the same 16 theme-resolved swatches in normal/bright rows plus "none"

### Requirement: Customization survives restarts and reconnects

Names and colors SHALL be persisted via the tab registry (`tabs.json`) and included in every
`sessions` broadcast, so a fresh client connection or a server restart presents the same names
and colors.

#### Scenario: New device sees customizations

- **WHEN** a phone connects for the first time after tabs were named/colored on desktop
- **THEN** its drawer shows the same names and colors from the initial `sessions` message
