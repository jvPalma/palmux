## ADDED Requirements

### Requirement: Alt+Z toggles word wrap in a file view

The registry SHALL hold a rebindable `toggleWrap` action, labelled "Toggle word wrap", bound by default to Alt+Z. It
SHALL be claimed, and offered in the command palette, only while the active tab is an editor or a review. In an editor
it SHALL flip `editorWrap`; in a unified review it SHALL flip the review's wrap; a side-by-side review always wraps and
SHALL say so. A toast SHALL name the new state. On any other tab the chord SHALL reach the terminal unchanged.

#### Scenario: In the editor

- **WHEN** an editor tab is active with wrap on and the user presses Alt+Z
- **THEN** the editor stops wrapping and a toast reads "Word wrap off"

#### Scenario: In a unified review

- **WHEN** a unified review is active and wrapping, and the user presses Alt+Z
- **THEN** the review stops wrapping and the setting is kept for the next review

#### Scenario: In a side-by-side review

- **WHEN** a side-by-side review is active and the user presses Alt+Z
- **THEN** nothing changes and a toast reads "Side-by-side always wraps"

#### Scenario: In the markdown viewer

- **WHEN** a markdown tab is active and the user presses Alt+Z
- **THEN** no action runs and the palette does not offer Toggle word wrap

#### Scenario: On a terminal

- **WHEN** a terminal tab is active and the user presses Alt+Z
- **THEN** the terminal receives the bytes Alt+Z always sent, and no toast shows

### Requirement: An Alt+letter chord matches the physical key

When a key event has Alt and no Ctrl, does not report the `AltGraph` modifier, its key is not a single letter or digit, and its physical code is a letter key
(`KeyA` to `KeyZ`), the registry SHALL match the chord by that letter. Every other event SHALL match by its key as
before, so Ctrl+Alt chords and AltGr characters are unchanged.

#### Scenario: Option+Z on a Mac

- **WHEN** the user presses Option+Z on a Mac, which produces `Ω`, with an editor tab active
- **THEN** `toggleWrap` runs

#### Scenario: AltGr still types

- **WHEN** a user on a Portuguese layout presses AltGr+2 to type `@` in a terminal
- **THEN** no action runs and `@` reaches the terminal
