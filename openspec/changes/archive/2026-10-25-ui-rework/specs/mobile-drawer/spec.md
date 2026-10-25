# Spec Delta

## Purpose

The mobile drawer is the phone's container for sessions, settings, files and dictation. This
capability owns how it opens without costing the soft keyboard, how its session list is ordered and
grouped by touch, and how a row presents a tab.

## ADDED Requirements

### Requirement: The drawer opens full-screen without losing the keyboard

Opening the drawer SHALL present it over the full height of the app, covering the terminal except
for a scrim strip at least 44px wide on the side it did not slide in from. If the soft keyboard is dismissed
while the drawer is open, the app layout SHALL hold its current height instead of reflowing the
terminal. The drawer SHALL NOT dismiss the keyboard itself.

#### Scenario: Typing, then uploading a screenshot

- **WHEN** the keyboard is up, the user opens the drawer and taps Upload
- **THEN** the drawer covers the full height except the scrim strip, and neither the terminal behind
  it nor its row count changes while the picker is open

#### Scenario: The IME leaves on its own

- **WHEN** Android dismisses the keyboard while the drawer is open
- **THEN** the terminal receives no resize until the drawer closes

### Requirement: Closing the drawer restores the keyboard state it found

Closing the drawer SHALL re-raise the soft keyboard if, and only if, it was up when the drawer
opened, and SHALL then apply any viewport change that was held while the drawer was open.

#### Scenario: Keyboard was up

- **WHEN** the drawer opened with the keyboard up, the keyboard went away, and the drawer closes
- **THEN** the keyboard is raised again and the terminal is resized at most once

#### Scenario: Keyboard was down

- **WHEN** the drawer opened with the keyboard down and then closes
- **THEN** the keyboard stays down

### Requirement: A scrim separates the drawer from the terminal

While the drawer is open, a scrim SHALL dim the content behind it, and tapping the scrim SHALL close
the drawer. The scrim SHALL fade on the surface motion tier; under reduced motion it SHALL appear
without a transition.

#### Scenario: Tap outside to close

- **WHEN** the drawer is open and the user taps the dimmed area
- **THEN** the drawer closes and the keyboard is restored per the restore rule

### Requirement: Session rows show a dot, a title and a subdued number

A session row SHALL show the tab's colour as a dot, its display title, and its tab number as
secondary text. A non-terminal tab SHALL show its kind icon; a terminal tab SHALL show none.

#### Scenario: Uncoloured terminal row

- **WHEN** an uncoloured terminal tab 6 named `TV-0` is listed
- **THEN** its row shows a neutral dot, `TV-0`, and `6` in secondary text, with no kind icon and no
  filled circle

### Requirement: Drawer rows and groups wear the desktop strip's pills

Every session row SHALL be a pill like the desktop strip's: a 1px border, the control radius, no
fill at rest. The active row SHALL have a raised fill, a ring and heavier text, never a colour fill or
an accent edge. A group SHALL be a framed cluster: one continuous frame in the group colour around a
filled chip header and its visible members.

#### Scenario: Active row

- **WHEN** a red-coloured tab is active
- **THEN** its row is a pill with a raised fill and a ring, as the active desktop pill is, and its red
  appears only in the dot

#### Scenario: A group in the drawer

- **WHEN** the `DGSL` group with two members is expanded in the drawer
- **THEN** one frame in the group colour surrounds the `DGSL` chip and both member pills, with no gap
  in the frame between them

### Requirement: Long-press and drag reorders and regroups tabs

In the session list, a long-press followed by a drag SHALL pick up the row. Dropping between rows
SHALL reorder it. Dropping on a group header SHALL add it to that group. Dropping outside every group
SHALL remove it from its group. Changes SHALL go to the server as the existing reorder and group
operations.

#### Scenario: Move a tab into a group

- **WHEN** the user long-presses `L0_PALMA`, drags it onto the `DGSL` group header and lets go
- **THEN** `L0_PALMA` becomes a member of `DGSL` on every connected client

#### Scenario: Reorder within the list

- **WHEN** the user drags a row between two other rows
- **THEN** the strip order on every client matches the new list order

#### Scenario: A scroll is not a drag

- **WHEN** the user swipes the list without holding first
- **THEN** the list scrolls and no row moves

### Requirement: Long-press without moving opens the row's menu

A long-press that ends without a drag SHALL open the row's context menu, offering at least rename,
colour, group membership and close. Closing a terminal from this menu SHALL keep the existing
terminal confirmation.

#### Scenario: Close from the menu

- **WHEN** the user long-presses a terminal row, releases without moving and picks Close
- **THEN** the terminal-close confirmation appears before the tab is killed

### Requirement: Swiping a row left reveals close

A horizontal swipe to the left on a row SHALL reveal a close action for that row. The row SHALL
carry no always-visible close control.

#### Scenario: Swipe to close

- **WHEN** the user swipes a markdown tab's row to the left and taps the revealed close action
- **THEN** the tab closes without a confirmation, because it holds no shell

### Requirement: Drawer navigation is ordered for thumb reach

In the drawer, the session list SHALL stay bottom-anchored with the footer actions under it. The
view switcher (sessions, files, dictation) SHALL sit in the top row between the settings entry and
the close control, at the drawer's root views only (owner decision, 2026-10-25: he does not want it
at the bottom).

#### Scenario: Settings is the farthest target

- **WHEN** the drawer is open on a phone
- **THEN** the top row holds the settings entry, the view switcher and the close control, and the
  session list ends just above the footer
