# Spec Delta

## MODIFIED Requirements

### Requirement: Drawer navigation is ordered for thumb reach

In the drawer, the session list SHALL stay bottom-anchored with the footer actions under it. The
view switcher (sessions, files, source control, dictation) SHALL sit in the top row with the settings entry
at the row's right end, at the drawer's root views only (owner decisions, 2026-10-25: he does not want it
at the bottom; 2026-10-26: no close control in the top row, the settings gear takes its place). The drawer
still closes through the scrim strip, Escape from inside it and every action that leaves it.

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

On a phone, the drawer's session rows and group headers SHALL be compact: at most 28px tall with text at
the body size (`--fs-2`), matching the density of the drawer footer, while each row stays one tappable
target.

#### Scenario: More sessions on screen

- **WHEN** the drawer lists seven sessions on a 390x844 phone
- **THEN** each row is at most 28px tall with 12px text

### Requirement: The drawer is narrower on a phone

On a phone, the drawer SHALL cover about three quarters of the screen width (owner decision 2026-10-26:
"too large"), leaving the rest as the scrim strip that closes it.

#### Scenario: A 390px phone

- **WHEN** the drawer opens on a 390x844 phone
- **THEN** it is about 290–300px wide, and a tap on the uncovered left part closes it
