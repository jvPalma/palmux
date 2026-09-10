# tab-customization Delta

## MODIFIED Requirements

### Requirement: Tabs can be colored from a fixed palette

The context menu (desktop) and long-press sheet (mobile) SHALL offer the active theme's 16 ANSI
colors (two rows of 8 — normal and bright) plus "none". The color SHALL render per the flat strip
language — solid fill when active, 8% tint when inactive (desktop strip and mobile drawer alike) —
with ink flipped by luminance. Selecting sends `updateTab { id, color }` carrying the ANSI slot
name; "none" clears it. Legacy persisted color names continue to resolve (see `tab-accents`).

#### Scenario: Color applies everywhere

- **WHEN** the user assigns an ANSI orange slot to tab 2 on desktop
- **THEN** tab 2 renders the orange fill/tint in the desktop strip and the mobile drawer on all
  connected clients

#### Scenario: None removes the accent

- **WHEN** the user selects "none"
- **THEN** the tab renders with the default (theme-accent-when-active, neutral-tint) style

#### Scenario: Sixteen swatches in both surfaces

- **WHEN** the color picker opens on desktop and on the mobile sheet
- **THEN** both show the same 16 theme-resolved swatches in normal/bright rows plus "none"
