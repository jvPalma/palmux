# keybinding-aware-tips Specification

## Purpose

In-app tips that reference named actions and render the user's current binding (or 'Disabled') live.

## Requirements

### Requirement: Tips render the user's current keybindings live

The tips/shortcuts panel SHALL let a tip reference one or more registry actions and render that
action's CURRENT chord (or "Disabled"), so rebinding an action updates the displayed shortcut without
editing tip text. Tips without an action reference SHALL remain static prose.

#### Scenario: Rebinding updates the tip

- **WHEN** the user rebinds the command-palette action and opens the tips panel
- **THEN** the palette tip shows the new chord, not the old one

#### Scenario: Disabled action

- **WHEN** a tip references an action that has no binding
- **THEN** the tip renders "Disabled" for that shortcut
