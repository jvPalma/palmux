# ui-primitives Specification

## Purpose

A Radix-headless component kit styled entirely from the eight --t-* tokens, three surface depth levels, four motion tiers, and no animation inside the terminal grid.

## Requirements

### Requirement: A shared component kit derived from theme tokens

palmux SHALL provide a component kit under `client/src/ui/` covering at minimum Button, IconButton,
Input, Switch, Segmented, Collapsible, Tooltip and Dialog. Every visual property of every component
SHALL be expressed in terms of the existing `--t-*` UI tokens (base, mantle, surface, text, subtext,
accent, accent-alt, accent-ink) and MUST NOT hard-code any color literal. Behaviour, focus management
and ARIA SHALL come from Radix headless primitives; the kit SHALL NOT introduce Tailwind, PostCSS, or
any shadcn/ui-derived styling layer, because a second token vocabulary would have to be kept obedient
to the first.

#### Scenario: A theme change repaints every control

- **WHEN** the user switches from a dark profile to a light one
- **THEN** every kit component repaints from the new tokens with no reload and no component-level
  color override

#### Scenario: No color literals in the kit

- **WHEN** the kit's stylesheet is inspected
- **THEN** it contains no hex, `rgb()` or named-color literal outside of `color-mix()` compositions of
  `--t-*` tokens

### Requirement: Surfaces carry three depth levels

Kit surfaces SHALL express depth with three background levels — crust (recessed), mantle (default) and
surface (raised) — plus a 1px border in `--t-surface`. A drop shadow SHALL be used only on surfaces
that genuinely float above the page (dialog, popover, toast) and MUST NOT be applied to inline
controls or panel rows.

#### Scenario: An inline control has no shadow

- **WHEN** a Button or Switch is rendered inside a panel row
- **THEN** it has a border and a background level but no box-shadow

### Requirement: Motion follows four tiers and never enters the terminal

Animated surfaces SHALL use exactly one of four tiers: **0ms** for keyboard-driven state (tab switch,
pane focus), **140ms ease** for micro feedback (hover, switch, button press), **240ms
cubic-bezier(.2,.9,.3,1)** for surfaces entering or leaving (dock, drawer, toast, popover, collapse),
and **380ms with a 40ms per-item stagger** for lists appearing for the first time. Exit transitions
SHALL be shorter than their matching entrances. No CSS transition or animation SHALL be applied to any
element inside the terminal grid, because xterm renders it on a WebGL canvas where compositing work
costs frames that are visible as input latency. All motion SHALL be suppressed under
`prefers-reduced-motion: reduce`.

#### Scenario: Tab switching is instant

- **WHEN** the user switches tabs with the keyboard
- **THEN** the new tab's content appears with no transition

#### Scenario: A re-render does not replay an entrance

- **WHEN** a list that has already appeared re-renders because its data changed
- **THEN** no stagger animation runs

#### Scenario: Reduced motion

- **WHEN** the OS reports `prefers-reduced-motion: reduce`
- **THEN** every kit transition and animation is reduced to an imperceptible duration and no entrance
  animation plays

### Requirement: Collapsible sections animate without measuring in JavaScript

A Collapsible SHALL animate its height with `grid-template-rows: 0fr → 1fr` rather than a measured
pixel height, so content of unknown size expands correctly without a layout read. Its open/closed
state SHALL persist per device.

#### Scenario: A section with dynamic content expands fully

- **WHEN** a collapsed section containing a list that grew since it was last opened is expanded
- **THEN** it animates open to the full current content height with no clipping and no JS measurement

#### Scenario: Collapse state survives a reload

- **WHEN** the user collapses a section and reloads the app on the same device
- **THEN** the section is still collapsed, and a different device is unaffected

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
