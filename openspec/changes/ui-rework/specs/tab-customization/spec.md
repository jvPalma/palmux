# Spec Delta

## MODIFIED Requirements

### Requirement: Tabs can be colored from a fixed palette

The context menu (desktop) and the row menu (mobile) SHALL offer the active theme's 16 ANSI
colors (two rows of 8 — normal and bright) plus "none". The color SHALL render as an identity dot
before the title (desktop strip and mobile drawer alike); it SHALL NOT fill or tint the tab.
Selecting sends `updateTab { id, color }` carrying the ANSI slot name; "none" clears it. Legacy
persisted color names continue to resolve (see `tab-accents`).

#### Scenario: Color applies everywhere

- **WHEN** the user colours tab 2 orange from the desktop context menu
- **THEN** tab 2 shows an orange dot in the desktop strip and in the mobile drawer on all connected
  clients, and neither surface fills the tab orange

#### Scenario: None removes the accent

- **WHEN** the user selects "none"
- **THEN** the tab shows a neutral dot (or none) and keeps the same active treatment as any other
  tab

#### Scenario: Sixteen swatches in both surfaces

- **WHEN** the color picker opens on desktop and in the mobile row menu
- **THEN** both show the same 16 theme-resolved swatches in normal/bright rows plus "none"
