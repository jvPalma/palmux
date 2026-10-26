# Spec Delta

## ADDED Requirements

### Requirement: The kit provides a scroll area and a virtualized list

The kit SHALL provide a scroll area for bounded content and a virtualized list for long content, both
styled only from the `--t-*` tokens and the size scale. The virtualized list SHALL mount only the rows
near the visible part plus a small overscan, SHALL support rows of different and changing heights, and
SHALL wear the same thin scrollbar as the scroll area, so the two read as one control.

#### Scenario: Ten thousand rows

- **WHEN** a virtualized list holds 10,000 rows in a 600px tall area
- **THEN** fewer than 100 row elements exist in the DOM, and scrolling to the end renders the last rows

#### Scenario: A row grows

- **WHEN** a row in a virtualized list grows because a comment editor opens inside it
- **THEN** the rows below it move down by the new height and none overlap

#### Scenario: A theme change

- **WHEN** the user switches themes
- **THEN** both scrollbars repaint from the new tokens, and neither stylesheet holds a colour literal

### Requirement: Scroll surfaces never compete with the terminal or the drawer

A kit scroll surface SHALL NOT be used inside the terminal grid, and on mobile its scrollbar SHALL NOT sit
under the drawer's edge gesture. Touch panning inside it SHALL stay native, so a swipe that starts inside
a list scrolls the list and a press there never cancels the pan.

#### Scenario: Panning a long list on a phone

- **WHEN** the user swipes up inside a virtualized list in the drawer
- **THEN** the list scrolls natively, and no row activates
