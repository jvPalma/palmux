# tab-customization

Rename and recolor tabs; precedence rules; cross-client sync.

## ADDED Requirements

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

The context menu (desktop) and long-press sheet (mobile) SHALL offer a fixed palette of 8 theme
colors plus "none". The color SHALL render Chrome-tab-group style — a colored accent
(top edge/underline on desktop tabs, dot on drawer rows) — not a full tab repaint, preserving
text contrast. Selecting sends `updateTab { id, color }`.

#### Scenario: Color applies everywhere

- **WHEN** the user assigns orange to tab 2 on desktop
- **THEN** tab 2 shows an orange accent in the desktop strip and an orange dot in the mobile
  drawer on all connected clients

#### Scenario: None removes the accent

- **WHEN** the user selects "none"
- **THEN** the tab renders with the default (colorless) style

### Requirement: Customization survives restarts and reconnects

Names and colors SHALL be persisted via the tab registry (`tabs.json`) and included in every
`sessions` broadcast, so a fresh client connection or a server restart presents the same names
and colors.

#### Scenario: New device sees customizations

- **WHEN** a phone connects for the first time after tabs were named/colored on desktop
- **THEN** its drawer shows the same names and colors from the initial `sessions` message
