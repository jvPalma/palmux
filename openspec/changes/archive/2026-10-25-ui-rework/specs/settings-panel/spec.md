# Spec Delta

## Purpose

The settings panel is the one field list that both the desktop dock and the mobile drawer host. This
capability owns its layout, so every row shares one rhythm, the App section's rows, and the in-place
theme browser: where a theme is chosen, imported and bound to the system's colour scheme.

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

The Theme row SHALL be a button showing the current theme: its name in Fixed mode, `System · <dark> /
<light>` in Match system. Activating it SHALL replace the panel's content with the theme browser,
inside the same dock or drawer, with a back control that returns to the settings list.

#### Scenario: Open the browser

- **WHEN** the user taps the Theme row in the mobile drawer
- **THEN** the drawer shows the theme list with a `‹ Settings` back control, without opening a
  popover or leaving the drawer

#### Scenario: The row names both themes in Match system

- **WHEN** Match system is on with Catppuccin Mocha for dark and Catppuccin Latte for light
- **THEN** the Theme row reads `System · Catppuccin Mocha / Catppuccin Latte` on one line, ending in
  an ellipsis if it does not fit, with the whole text as its tooltip

### Requirement: Import is a section of the theme browser

The theme browser SHALL contain an Import section, above the Dark and Light lists, that accepts a
theme name, URL or install command. The settings form SHALL NOT contain an import field. An import
SHALL apply to the target captured when it was submitted.

#### Scenario: The form has no import field

- **WHEN** the settings form renders in the dock or the drawer
- **THEN** no import field is shown, and the theme browser shows one above the Dark list

#### Scenario: A Fixed import becomes the theme

- **WHEN** the user submits an import in Fixed mode and the import succeeds
- **THEN** the imported theme becomes the current theme and appears in the list

#### Scenario: A Match-system import fills the edited slot

- **WHEN** the user submits an import while editing For light in Match system and it succeeds
- **THEN** the imported theme becomes the light theme, and it is displayed only if the system scheme
  is light

#### Scenario: Switching slot while an import runs

- **WHEN** the user submits an import for For dark and switches to For light before it completes
- **THEN** the imported theme fills the dark slot, the slot captured at submit

#### Scenario: A mode change supersedes the import

- **WHEN** the user submits an import in Fixed mode, switches to Match system, and the import then
  completes
- **THEN** the theme is imported and listed, but it is not selected and `themeId` is not written

#### Scenario: A round trip back to the same mode still supersedes the import

- **WHEN** the user submits an import in Fixed mode, switches to Match system and back to Fixed,
  picks another theme, and the import then completes
- **THEN** the theme is imported and listed, and the theme picked after the round trip stays current

#### Scenario: A mode change from another device supersedes the import

- **WHEN** an import is pending and a settings broadcast changes the mode, even if a later broadcast
  changes it back
- **THEN** the import is not selected when it completes; a broadcast that leaves the mode unchanged
  does not supersede it

### Requirement: The theme can follow the system colour scheme

The theme browser SHALL offer a Fixed | Match system switch. In Match system the user SHALL pick one
theme for a dark system scheme and one for a light one, and each device SHALL show the theme for its
own scheme, switching live when that scheme changes. The mode and both picks SHALL be synced settings.

#### Scenario: The theme follows the scheme

- **WHEN** Match system is on with a dark and a light theme and the system scheme changes to light
- **THEN** the whole app, every terminal and the editor re-skin to the light theme without a reload

#### Scenario: Two devices in different schemes

- **WHEN** a phone is in light and a desktop is in dark under the same settings
- **THEN** the phone shows the light theme and the desktop shows the dark theme

#### Scenario: The switch changes nothing visible

- **WHEN** the user switches from Fixed to Match system
- **THEN** an unchosen slot starts at the current theme and the screen does not change

#### Scenario: No flash at load

- **WHEN** the app loads on a device whose scheme is light with Match system on
- **THEN** the first paint uses the light theme, not the last exported one

### Requirement: Picking a theme applies it live

Selecting a theme SHALL persist it and keep the browser open so another can be tried; the current
theme SHALL be marked in the list. In Fixed mode the pick SHALL re-skin the app at once. In Match
system the pick SHALL fill the slot being edited ("For dark" or "For light") and SHALL re-skin the
app at once only when that slot is the active scheme.

#### Scenario: Try two themes, keep the second

- **WHEN** the user taps theme A, sees the app re-skin, then taps theme B and goes back
- **THEN** theme B is applied and persisted, and the Theme row shows B

#### Scenario: Each entry previews itself

- **WHEN** the theme list renders
- **THEN** each entry paints in its own palette (background, foreground, accent sample), so a theme
  can be judged before it is applied

#### Scenario: A pick for the active slot applies

- **WHEN** the system scheme is dark, Match system is on and the user picks a theme for For dark
- **THEN** the app re-skins to it at once

#### Scenario: A pick for the inactive slot persists only

- **WHEN** the system scheme is dark, Match system is on and the user picks a theme for For light
- **THEN** the pick is saved, the note under the slot switch names it, and the app does not change

### Requirement: The theme export follows real choices only

The `themeId` setting is the theme the server exports to tmux, delta and Claude Code. A client SHALL
write it on a system scheme change while the app is open in Match system, on a pick or an import
that lands in the active slot, on a pick or an import in Fixed, and on a switch back to Fixed. It
MUST NOT write it for a pick or an import into the inactive slot, for a superseded import, on a
switch into Match system, on boot, on reconnect or on a settings broadcast.

#### Scenario: A scheme change writes the export

- **WHEN** the app is open in Match system and the system scheme changes
- **THEN** the client writes the newly resolved theme as `themeId`

#### Scenario: Boot does not write

- **WHEN** a device opens in a different scheme from the last device to write
- **THEN** `themeId` is not written

#### Scenario: Only the active slot moves the export

- **WHEN** the user picks a theme for the active slot, then for the inactive slot
- **THEN** the first pick also writes `themeId` and the second does not

#### Scenario: An import moves the export only in the active slot

- **WHEN** a Match-system import completes for the active slot, and another for the inactive slot
- **THEN** the first also writes `themeId` and the second does not

### Requirement: The App section lists app-level rows only

Settings › App SHALL list Reload app, Install as app, Latency overlay and, in the desktop dock only,
Edit config.json. It SHALL NOT offer a Sidebar rail option or a Dictation history row.

#### Scenario: The removed rows are gone

- **WHEN** Settings › App renders in the dock or the drawer
- **THEN** no Sidebar rail row and no Dictation history row is shown, and the Dictation view stays
  reachable from the rail on desktop and from the drawer's view switcher on mobile
