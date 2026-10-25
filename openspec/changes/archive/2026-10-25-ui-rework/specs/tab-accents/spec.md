# Spec Delta

## MODIFIED Requirements

### Requirement: Accent states coexist with strip indicators

The accent dot SHALL NOT collide with the reorder insertion indicator or the dirty dot: both SHALL
remain visible and distinct on coloured active and inactive pills, and the dirty indicator SHALL be
told apart from the accent dot by shape or position, not by colour alone.

#### Scenario: Insertion bar on a colored tab

- **WHEN** a coloured pill is the current reorder drop target
- **THEN** the insertion indicator renders visibly beside the pill

#### Scenario: Dirty editor with an accent

- **WHEN** a coloured editor tab has unsaved changes
- **THEN** its accent dot and its dirty indicator are both visible and cannot be mistaken for each
  other
