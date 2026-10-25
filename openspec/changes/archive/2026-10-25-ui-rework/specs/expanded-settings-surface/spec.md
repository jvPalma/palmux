# Spec Delta

## Purpose

The sidebar rail is no longer a setting (owner decision, 2026-10-25): the desktop rail is always
shown, so `sidebarRail` stops controlling anything. The field stays parseable so an older settings
file still loads, and it stays out of the synced payload.

## MODIFIED Requirements

### Requirement: Broadened client settings surface

palmux SHALL extend its client settings with the following customization fields —
including (at least) `vimInputMode`, `middleClickPaste`, `ctrlVPaste`, `ctrlFSearch`,
`keyboardSelection`, `altDigitPassthrough`, `undoSequence`, and a renderer/antialias preference —
while continuing to route every synced field through the existing `SYNCED_KEYS` allowlist and server
broadcast, and continuing to treat the payload as opaque server-side. A retired `sidebarRail` value
SHALL still parse but SHALL control nothing, and SHALL stay out of the synced payload.

#### Scenario: New field syncs cross-device via the allowlist

- **WHEN** the user changes an allowlisted new setting on one client
- **THEN** other connected clients receive it via the existing settings broadcast, no server schema change

#### Scenario: Per-device fields stay per-device

- **WHEN** a field is designated device-local (e.g. font size, mobile mode)
- **THEN** it is excluded from the synced payload and does not leak to other devices

#### Scenario: The rail preference does not reach the synced file

- **WHEN** a device still holds a stored `sidebarRail` value and the server persists settings
- **THEN** the synced settings file is unchanged by that value, and the desktop rail is shown
  regardless of it
