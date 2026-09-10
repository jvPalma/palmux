# expanded-settings-surface Specification

## Purpose

A broadened, forward-compatible client settings surface routed through a synced-keys allowlist, with unknown/legacy settings degrading safely.

## Requirements

### Requirement: Broadened client settings surface

palmux SHALL extend its client settings with the following customization fields —
including (at least) `vimInputMode`, `middleClickPaste`, `ctrlVPaste`, `ctrlFSearch`,
`keyboardSelection`, `altDigitPassthrough`, `undoSequence`, and a renderer/antialias preference —
while continuing to route every synced field through the existing `SYNCED_KEYS` allowlist and server
broadcast, and continuing to treat the payload as opaque server-side.

It SHALL additionally carry `sidebarRail` (`always` | `hidden`), which controls the side dock's icon
rail. `sidebarRail` is a **per-device** field: it MUST be excluded from the synced payload, because a
value that follows the user between a phone and a desktop is wrong on one of them, and a synced copy
reintroduces the cross-machine write conflict that per-device persistence exists to prevent.

#### Scenario: New field syncs cross-device via the allowlist

- **WHEN** the user changes an allowlisted new setting on one client
- **THEN** other connected clients receive it via the existing settings broadcast, no server schema change

#### Scenario: Per-device fields stay per-device

- **WHEN** a field is designated device-local (e.g. font size, mobile mode, sidebar rail)
- **THEN** it is excluded from the synced payload and does not leak to other devices

#### Scenario: The rail preference does not reach the synced file

- **WHEN** the user changes `sidebarRail` and the server persists settings
- **THEN** the synced settings file is unchanged by that write

### Requirement: Unknown/legacy settings degrade safely

Loading a settings blob with unknown or missing fields SHALL fall back to defaults per field without
failing the load.

#### Scenario: Legacy blob still loads

- **WHEN** a device has a stored settings blob written by an older build
- **THEN** settings load from it and new fields take their defaults
