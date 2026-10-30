# Spec Delta

## MODIFIED Requirements

### Requirement: App surfaces render in a side dock instead of modals

palmux SHALL host Settings, the new-tab chooser, Files, Source Control and Dictation as **views of one
right-side dock** rather than as modal overlays. The dock SHALL occupy layout width, shrinking the content
area, and MUST NOT cover the terminal — the terminal is what the user is reading from while using these
surfaces. Exactly one view SHALL be active at a time, and the active view SHALL persist per device.

#### Scenario: Opening settings keeps the terminal readable

- **WHEN** the user opens Settings while a terminal is showing output
- **THEN** the dock appears beside the terminal, the terminal narrows, and no terminal content is
  hidden behind an overlay

#### Scenario: Switching views does not close the dock

- **WHEN** the dock is showing Settings and the user selects Files
- **THEN** the dock stays open and swaps its content

#### Scenario: Source Control is a dock view

- **WHEN** the user selects Source Control on the rail
- **THEN** the dock shows the Source Control view beside the content area, and a review it opens goes to
  the content area, not the dock

### Requirement: The rail orders entries by frequency of use

The desktop rail SHALL list, from top to bottom: New tab, Explorer, Source Control, Dictation, a
separator, Upload, Download, and Settings pinned to the bottom of the rail.

#### Scenario: Settings sits at the bottom

- **WHEN** the rail is visible on desktop
- **THEN** New tab is the topmost entry and Settings is the bottommost, separated from the other
  entries by free space

#### Scenario: Source Control follows Explorer

- **WHEN** the rail is visible on desktop
- **THEN** Source Control is the entry directly below Explorer and directly above Dictation
