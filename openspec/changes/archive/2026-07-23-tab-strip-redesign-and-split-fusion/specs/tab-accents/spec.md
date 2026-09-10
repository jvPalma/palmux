# tab-accents Delta

## MODIFIED Requirements

### Requirement: Tab accent colors are theme-aware

Tab accent colors SHALL resolve through per-theme values: the persisted color NAME stays stable
while its rendered value comes from the active profile's `ansi16` palette. The palette names are
the 16 ANSI slots (`ansi0`–`ansi15`); the 12 legacy accent names (`red`, `peach`, `maroon`,
`yellow`, `green`, `teal`, `sky`, `blue`, `lavender`, `mauve`, `pink`, `gray`) SHALL keep
resolving forever via a static legacy→slot mapping applied at render time — persisted data is
never rewritten. The picker swatches SHALL display the currently-resolved values and write only
slot names.

#### Scenario: Same name, theme-matched value

- **WHEN** a tab is colored `ansi1` and the theme switches from Catppuccin to Dracula
- **THEN** the tab's accent re-renders in Dracula's ANSI red without any persistence change

#### Scenario: Legacy names resolve without migration

- **WHEN** tabs colored `peach` or `lavender` under the old 12-color palette load
- **THEN** each renders via its mapped ANSI slot (e.g. `peach`→`ansi9`, `lavender`→`ansi12`)
  and `tabs.json` is not modified

## REMOVED Requirements

### Requirement: The palette grows to twelve named colors

**Reason**: The invented 12-color palette is replaced by the theme's own 16 ANSI colors, which are
already curated per theme and match what the terminal shows.
**Migration**: Picker offers the 16 ANSI slots (see ADDED requirement); legacy names resolve via
the static mapping in the modified theme-aware requirement.

### Requirement: The tab top-border accent is properly shaped and stateful

**Reason**: Accent presentation changed from a top-edge stripe + wash on a rounded tab to a solid
fill / 8% tint on a flat squared tab; rounded geometry, stripe shaping, and the ◧/◨ badge
collision constraint (badges are removed by split fusion) no longer exist.
**Migration**: Active/inactive accent rendering is specified in `chrome-tab-strip` (solid fill +
8% tint); indicator coexistence with the reorder insertion bar is covered by the ADDED requirement
below.

## ADDED Requirements

### Requirement: The palette is the theme's 16 ANSI colors

The accent palette SHALL be the active theme's `ansi16` — presented as two rows of 8 (normal,
bright) plus a clear option — with a CSS variable and a luminance-derived ink variable emitted per
slot so both the fill and its text color are theme-true. Group colors SHALL draw from the same 16
slots.

#### Scenario: Picker mirrors the theme

- **WHEN** the user opens the tab color menu under ayu-dark
- **THEN** 16 swatches render ayu-dark's ANSI values in two labeled rows (8 normal / 8 bright)
  plus ∅ clear, and each applies its accent

#### Scenario: Ink follows the slot

- **WHEN** a tab is filled with a light ANSI color (e.g. bright yellow) and another with a dark one
- **THEN** the light-filled tab shows dark ink and the dark-filled tab shows light ink

### Requirement: Accent states coexist with strip indicators

The solid-fill/tint accent SHALL NOT collide with the reorder insertion indicator or the dirty
dot: both SHALL remain visible and distinct on colored active and inactive tabs.

#### Scenario: Insertion bar on a colored tab

- **WHEN** a colored tab is the current reorder drop target
- **THEN** the insertion indicator renders visibly against the solid fill or tint
