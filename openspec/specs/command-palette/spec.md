# command-palette Specification

## Purpose

A fuzzy, keyboard-driven command palette over the app's action registry, surfacing each action's live keybinding.

## Requirements

### Requirement: A fuzzy command palette

palmux SHALL provide a command palette opened by a bound chord (default Ctrl+Shift+P) that fuzzy-
matches over app actions (theme switch, new/close tab, split, focus pane, search, diagnostics,
settings, etc.), executes the chosen action, and supports keyboard navigation. Each palette entry
that maps to a registry action SHALL display that action's current binding.

#### Scenario: Open and run an action

- **WHEN** the user opens the palette and types a partial action name, then confirms
- **THEN** the matched action executes

#### Scenario: Palette shows live bindings

- **WHEN** an action with a keybinding appears in the palette
- **THEN** its current chord is displayed next to it

#### Scenario: Dismiss without action

- **WHEN** the user presses Escape in the palette
- **THEN** it closes and no action runs
