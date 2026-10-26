# Spec Delta

## MODIFIED Requirements

### Requirement: Drawer navigation is ordered for thumb reach

In the drawer, the session list SHALL stay bottom-anchored with the footer actions under it. The
view switcher (sessions, files, source control, dictation) SHALL sit in the top row with the settings entry
at the row's right end, at the drawer's root views only (owner decisions, 2026-10-25: he does not want it
at the bottom; 2026-10-26: no close control in the top row, the settings gear takes its place). The drawer
still closes through the scrim strip, a swipe and every action that leaves it.

#### Scenario: Settings is the farthest target

- **WHEN** the drawer is open on a phone
- **THEN** the top row holds the view switcher and, at its right end, the settings entry, with no close
  control, and the session list ends just above the footer

#### Scenario: Source Control is a drawer view

- **WHEN** the user selects the Source Control segment on a 390px wide phone
- **THEN** the drawer shows the Source Control view, the four segments and the settings entry fit in the
  top row without truncation, and choosing a file there closes the drawer and opens the review

## ADDED Requirements

### Requirement: Drawer lists are compact on a phone

On a phone, the drawer's session rows and group headers SHALL be compact: rows no taller than the
extra-keys bar's keys and text at the body size, matching the density of the drawer footer, while each row
stays one tappable target.

#### Scenario: More sessions on screen

- **WHEN** the drawer lists seven sessions on a 390x844 phone
- **THEN** each row is at most 32px tall with 13px text, and the list takes visibly less height than before
