# configurable-keybindings Specification

## Purpose

A rebindable desktop keybinding system: a named action registry, a keyseq byte-emitting grammar, settings-gated interception toggles, an editor UI, and an optional vim-style input mode.

## Requirements

### Requirement: A rebindable desktop action registry

palmux SHALL provide a registry of named desktop actions (e.g. copy, paste, search, palette,
new-tab, close-tab, split, focus-pane, kill-line, word-delete, backtab, newline, undo) each bound to
a physical-keyboard chord. User bindings SHALL take precedence over default bindings, and the registry
SHALL sit ABOVE xterm.js as a capture-phase handler that only claims explicitly-bound chords — all
unbound keys SHALL reach xterm unchanged (preserving DECCKM/DECKPAM and default encoding).

#### Scenario: Unbound key reaches the terminal untouched

- **WHEN** the user presses an arrow key with no binding claiming it
- **THEN** xterm.js encodes it normally (application-cursor mode honored), the registry does not interfere

#### Scenario: User binding shadows a default

- **WHEN** the user rebinds "command palette" to a new chord
- **THEN** the new chord opens the palette and the old chord no longer does

### Requirement: A keybinding editor UI

palmux SHALL provide an editor UI to view and change bindings, capturing a chord via two-phase
keydown-then-keyup, detecting and highlighting conflicts, supporting reset-to-defaults, and
persisting bindings per device (with optional settings sync). Persistence SHALL be additive and
rollback-safe.

#### Scenario: Capture and conflict

- **WHEN** the user assigns a chord already bound to another action
- **THEN** the editor highlights the conflict and does not silently overwrite

#### Scenario: Reset to defaults

- **WHEN** the user chooses reset-to-defaults
- **THEN** all bindings return to the shipped defaults

### Requirement: A keyseq escape-sequence grammar for byte-emitting actions

For actions that emit a fixed byte sequence, palmux SHALL accept a small escape grammar (`^X` for
control chars, `\xNN` hex, `\e` escape, `\n`/`\r`/`\t`, literal passthrough) so a user can define an
arbitrary byte sequence (e.g. for an `undo` action) from settings.

#### Scenario: Custom undo sequence

- **WHEN** the user sets the undo action's sequence to `^_`
- **THEN** triggering undo writes byte 0x1f to the PTY

### Requirement: Settings-gated key-interception toggles

palmux SHALL expose toggles — `ctrlVPaste`, `ctrlFSearch`, `keyboardSelection`, `altDigitPassthrough`
— that control whether the app intercepts those keys versus passing them to the foreground shell.
These SHALL default OFF so vim/readline users are not broken by default.

#### Scenario: Default preserves the shell

- **WHEN** `ctrlVPaste` is at its default (off) and the user presses Ctrl+V in vim
- **THEN** the literal control byte reaches vim; the app does not intercept for paste

#### Scenario: Opt-in interception

- **WHEN** the user enables `ctrlFSearch`
- **THEN** Ctrl+F opens the scrollback search UI instead of sending the byte

### Requirement: A vim-style input mode for app text inputs

palmux SHALL offer an optional vim-style editing mode (insert/normal, motions, `d`/`y`/`c` operators,
registers, `p`/`P`) for app free-text inputs such as the command palette, gated by a `vimInputMode`
setting.

#### Scenario: Vim mode in the palette input

- **WHEN** `vimInputMode` is enabled and the palette input is focused
- **THEN** normal-mode motions/operators edit the query text
