# Spec Delta

## MODIFIED Requirements

### Requirement: The rail orders entries by frequency of use

The desktop rail SHALL list, from top to bottom: the app menu button, New tab, Explorer, Source Control, Dictation, a
separator, Upload, Download, and Settings pinned to the bottom of the rail.

#### Scenario: Settings sits at the bottom

- **WHEN** the rail is visible on desktop
- **THEN** the app menu button is the topmost control, New tab the topmost view entry below it, and Settings is the
  bottommost, separated from the other entries by free space

#### Scenario: Source Control follows Explorer

- **WHEN** the rail is visible on desktop
- **THEN** Source Control is the entry directly below Explorer and directly above Dictation
