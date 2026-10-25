# Spec Delta

## ADDED Requirements

### Requirement: The rail orders entries by frequency of use

The desktop rail SHALL list, from top to bottom: New tab, Explorer, Dictation, a separator, Upload,
Download, and Settings pinned to the bottom of the rail.

#### Scenario: Settings sits at the bottom

- **WHEN** the rail is visible on desktop
- **THEN** New tab is the topmost entry and Settings is the bottommost, separated from the other
  entries by free space

### Requirement: The desktop rail is always shown

The dock's icon rail SHALL be rendered whenever the desktop layout is, and no setting SHALL hide it.
A `sidebarRail` value stored by an earlier version SHALL be parsed and ignored. `sidebarRail` MUST NOT
be added to the synced settings keys, because a synced copy would put a per-machine value back into
the tracked settings file.

#### Scenario: A stored hidden value does not remove the rail

- **WHEN** the stored settings carry `sidebarRail: 'hidden'` and the desktop layout is active
- **THEN** the rail is rendered with every entry, and Explorer, Dictation, Upload and Download are
  reachable by pointer

#### Scenario: Settings offers no rail option

- **WHEN** the user opens Settings › App on desktop or in the mobile drawer
- **THEN** no Sidebar rail row is shown

#### Scenario: The retired value does not travel between machines

- **WHEN** a device stores a `sidebarRail` value and the synced settings payload is built
- **THEN** the payload does not contain `sidebarRail`

#### Scenario: Mobile has no rail

- **WHEN** the mobile layer is active
- **THEN** no rail is rendered, and the drawer hosts the same surfaces

## REMOVED Requirements

### Requirement: The icon rail is a per-device preference

**Reason**: The owner dropped the Sidebar rail option (2026-10-25). A hidden rail left Explorer,
Dictation, Upload and Download with no pointer route, and the Dictation entry on the rail made the
Dictation history row redundant. The rail is now always shown on desktop.

**Migration**: Replaced by "The desktop rail is always shown". The `hidden` scenario goes with the
option: Settings stays reachable from the rail's own Settings button, from the keyboard shortcut
(`settings` is Ctrl+,), from the command palette and from the topbar's app menu.
