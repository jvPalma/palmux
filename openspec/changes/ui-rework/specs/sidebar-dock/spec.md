# Spec Delta

## ADDED Requirements

### Requirement: The rail orders entries by frequency of use

The desktop rail SHALL list, from top to bottom: New tab, Explorer, Dictation, a separator, Upload,
Download, and Settings pinned to the bottom of the rail.

#### Scenario: Settings sits at the bottom

- **WHEN** the rail is visible on desktop
- **THEN** New tab is the topmost entry and Settings is the bottommost, separated from the other
  entries by free space

## MODIFIED Requirements

### Requirement: The icon rail is a per-device preference

The dock SHALL offer a persistent icon rail listing its views. Its visibility SHALL be controlled by a
`sidebarRail` preference with values `always` and `hidden`, defaulting to `always` on desktop and
`hidden` on mobile. `sidebarRail` SHALL be stored **per device** and MUST NOT be added to the synced
settings keys, because a synced copy reintroduces the cross-machine conflict that per-device
persistence exists to prevent.

#### Scenario: Rail hidden still reaches every view

- **WHEN** `sidebarRail` is `hidden`
- **THEN** no rail is rendered, and every view remains reachable from its keyboard shortcut
  (`settings` is Ctrl+,) and from the command palette
- **AND** Settings remains reachable by pointer from the topbar's app menu button

#### Scenario: The preference does not travel between machines

- **WHEN** the user sets `sidebarRail` to `hidden` on one device and the synced settings are read on
  another
- **THEN** the second device keeps its own value
