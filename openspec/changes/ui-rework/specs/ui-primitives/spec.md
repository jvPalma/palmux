# Spec Delta

## ADDED Requirements

### Requirement: UI dimensions come from one scale

Font sizes, spacing, corner radii and control heights in client stylesheets SHALL come from a named
scale declared next to the colour tokens. The scale has four UI type sizes plus one monospace size,
spacing on a 4px grid, three radii plus a pill, and one control height per device class. The terminal
grid and user-chosen terminal font sizes are outside it.

#### Scenario: An off-scale value is rejected

- **WHEN** a stylesheet declares `font-size: 10.5px` or `padding: 7px 11px` outside the scale
- **THEN** the guard test fails and names the file and the value

#### Scenario: The scale is the only source

- **WHEN** the client stylesheets are scanned
- **THEN** every font size, gap, padding, radius and control height resolves to a scale value

### Requirement: Icons come from one SVG set

Every icon in the app chrome SHALL be an SVG from a single shared set that uses one stroke width and
two sizes and inherits the text colour. Emoji and text glyphs (✕ ☰ ⚙ 📂 🌐 ⬆ and the like) MUST NOT be
used as icons. User-supplied labels in `extra-keys.json` are exempt.

#### Scenario: Drawer footer icons

- **WHEN** the mobile drawer footer renders Upload, Download, Dictate and Images
- **THEN** each icon is an SVG from the shared set, drawn at the same stroke width, and none is an
  emoji

#### Scenario: Theme change recolours icons

- **WHEN** the theme switches from dark to light
- **THEN** every chrome icon follows the new text colour with no per-icon override

### Requirement: Kit buttons acknowledge a press

Kit buttons and icon buttons SHALL show press feedback the moment they are pressed and release it on
the micro motion tier. The feedback MUST NOT change the control's layout box. Under reduced motion,
the feedback SHALL be a colour change only.

#### Scenario: Pressing a button

- **WHEN** the user presses a kit Button
- **THEN** it shows its pressed state before the pointer is released, and neighbouring elements do
  not move

### Requirement: Menus and popovers grow from their trigger

Context menus, dropdowns, select popups and popovers SHALL enter by scaling up slightly from their
trigger point while fading in, on the micro tier, and SHALL exit faster than they enter. Dialogs stay
centred. Under reduced motion they SHALL appear without scale.

#### Scenario: A right-click menu

- **WHEN** the user right-clicks a tab
- **THEN** the menu grows from the click point rather than from its own centre

### Requirement: Rows entering or leaving a list transition

A row added to or removed from the drawer's session list or the Explorer tree SHALL fade and shift
slightly on the micro tier, using transitions that retarget if interrupted. A list rendering for the
first time follows the existing stagger tier instead.

#### Scenario: A tab closes from the drawer

- **WHEN** a session row is closed while the drawer is open
- **THEN** the row fades out and the rows below close the gap without a jump
