# settings-in-editor Specification

## Purpose

Opening configuration files in the integrated Monaco editor with validation applied on save.

## Requirements

### Requirement: Open configuration files in the integrated editor

palmux SHALL let the user open its JSON configuration in the integrated Monaco editor (VS Code-style),
at minimum the client settings and, where applicable, `config.json` / `extra-keys.json` /
`keybindings`. This SHALL be presented as a **Raw / Form toggle over one dock view** rather than as a
separate editor tab: Form is the existing settings form, Raw is the same configuration as JSON, and
switching between them SHALL NOT create a tab or lose unsaved edits.

The editor SHALL provide JSON editing with syntax highlighting and live validation, and saving SHALL
apply the settings through the existing settings/config path (not a raw unchecked overwrite). **Save
SHALL be disabled while the document is invalid**, and the view SHALL show the parse error and its
line. Blocking the write is the requirement, not merely rejecting it afterwards: the server already
falls back to defaults when it cannot parse `config.json`, so a write that is accepted and then
ignored is indistinguishable to the user from a setting that does not work.

#### Scenario: Open settings in the editor

- **WHEN** the user chooses "Open settings (JSON)" (e.g. from the command palette)
- **THEN** the dock's configuration view opens in Raw mode with the settings JSON in Monaco with
  syntax highlighting

#### Scenario: Saving applies settings

- **WHEN** the user edits and saves the settings JSON
- **THEN** the change is validated and applied through the normal settings path (invalid JSON is rejected, not silently written)

#### Scenario: Invalid JSON blocks the save

- **WHEN** the document has a trailing comma
- **THEN** Save is disabled, the status bar names the error and its line, and nothing is written

#### Scenario: Toggling modes keeps edits

- **WHEN** the user edits in Raw, switches to Form and back
- **THEN** the unsaved Raw edits are still present and no tab was created
