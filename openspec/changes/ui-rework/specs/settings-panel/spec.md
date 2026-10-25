# Spec Delta

## Purpose

The settings panel is the one field list that both the desktop dock and the mobile drawer host. This
capability owns its layout, so every row shares one rhythm, and the in-place theme browser.

## ADDED Requirements

### Requirement: Settings render as grouped cards

Settings SHALL be grouped into titled sections. Each section's rows SHALL sit in one card separated
by hairline dividers. A section title SHALL be a small secondary-colour label, not an uppercase
tracked heading, so the panel title and section titles form two distinct levels.

#### Scenario: Two levels of heading

- **WHEN** the settings panel opens
- **THEN** the panel title is visibly larger than every section title, and no section title is set
  in uppercase with wide tracking

### Requirement: Rows align on a label column and a fixed control column

Each row SHALL place its label (and optional hint) in a flexible left column and its control in a
right column of one fixed width shared by every row. Text-like controls (select, number, segmented,
text button) SHALL fill that column. Switches and links SHALL align to its right edge.

#### Scenario: Controls share edges

- **WHEN** the Theme, Font, Font size and Cursor rows are shown together
- **THEN** their controls share both the left edge and the right edge

#### Scenario: A row with a hint keeps the rhythm

- **WHEN** one row has a hint line and its neighbour has none
- **THEN** both rows still meet the minimum row height, and the control stays vertically centred

### Requirement: All controls share one height and one select

Every control in the panel SHALL render at the device's control height (one value on desktop and one
on mobile, the mobile one being a touch target). Every choice from a list SHALL use the same select
component. No native select element SHALL appear in the panel.

#### Scenario: Font uses the same select as other lists

- **WHEN** the Font row is opened
- **THEN** it shows the same select trigger, chevron and popup as every other list choice in the
  panel

### Requirement: Long values truncate inside their control

A value longer than its control SHALL truncate with an ellipsis on a single line and SHALL expose the
full value as a tooltip. It MUST NOT wrap or overflow its control.

#### Scenario: A long theme name

- **WHEN** the current theme is `Cobalt Next Minimal` on a 390px phone
- **THEN** the Theme control shows one line ending in an ellipsis, and nothing renders outside its
  box

### Requirement: Focus rings appear for keyboard focus only

Section headers and non-editable panel controls (buttons, switches, segmented items, selects, the
Theme button) SHALL show a focus ring when focused from the keyboard, and SHALL NOT show one after a
pointer or touch activation. Editable text and number inputs SHALL show a focus ring whenever they
hold focus, because the browser treats any focused editable field as needing a visible indicator.

#### Scenario: Click a section header

- **WHEN** the user clicks the Terminal section header with a mouse
- **THEN** the section toggles and no focus ring is drawn around it

#### Scenario: Tab into a number input

- **WHEN** the user moves keyboard focus onto the Scrollback input
- **THEN** a visible focus ring is drawn around it

### Requirement: Theme is chosen in an in-place theme browser

The Theme row SHALL be a button showing the current theme. Activating it SHALL replace the panel's
content with a list of every theme, inside the same dock or drawer, with a back control that returns
to the settings list.

#### Scenario: Open the browser

- **WHEN** the user taps the Theme row in the mobile drawer
- **THEN** the drawer shows the theme list with a `‹ Settings` back control, without opening a
  popover or leaving the drawer

### Requirement: Picking a theme applies it live

Selecting a theme in the browser SHALL apply it to the whole app at once and persist it, and SHALL
keep the browser open so another theme can be tried. The current theme SHALL be marked in the list.

#### Scenario: Try two themes, keep the second

- **WHEN** the user taps theme A, sees the app re-skin, then taps theme B and goes back
- **THEN** theme B is applied and persisted, and the Theme row shows B

#### Scenario: Each entry previews itself

- **WHEN** the theme list renders
- **THEN** each entry paints in its own palette (background, foreground, accent sample), so a theme
  can be judged before it is applied
