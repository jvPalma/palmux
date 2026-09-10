## ADDED Requirements

### Requirement: Tab accent colors are theme-aware

Tab accent colors SHALL resolve through per-theme values: the persisted color NAME (e.g. `red`) stays stable while its rendered value comes from the active profile (Dracula's red under Dracula, Gruvbox's under Gruvbox). Existing tabs' persisted color names SHALL keep working unchanged, and the context-menu swatches SHALL display the currently-resolved values.

#### Scenario: Same name, theme-matched value

- **WHEN** a tab is colored `red` and the theme switches from Catppuccin to Dracula
- **THEN** the tab's accent re-renders in Dracula's red without any persistence change

#### Scenario: Old tabs unaffected

- **WHEN** tabs colored under the previous 8-color palette load
- **THEN** every existing name resolves and renders

### Requirement: The palette grows to twelve named colors

The accent palette SHALL offer 12 named colors (superset of the current 8), each resolvable in every built-in theme, and the picker SHALL present all of them plus the clear option.

#### Scenario: New colors pickable

- **WHEN** the user opens the tab color menu
- **THEN** 12 swatches (plus ∅ clear) are shown and each applies its accent

### Requirement: The tab top-border accent is properly shaped and stateful

The colored-tab accent SHALL follow the tab's rounded top geometry (no square bar overflowing the corners), SHALL distinguish states — full-strength on the active tab with a subtle accent-tinted tab body, dimmed on inactive colored tabs, and legible on hover — and SHALL NOT collide with the split ◧/◨ badges, the dirty dot, or the reorder insertion indicator.

#### Scenario: Rounded geometry

- **WHEN** a colored tab renders
- **THEN** the accent hugs the rounded top edge with no visual overflow at the corners

#### Scenario: Active vs inactive

- **WHEN** a colored tab is active vs in the background
- **THEN** the active one shows the full accent + tinted body and the inactive one a clearly dimmer accent

#### Scenario: No indicator collisions

- **WHEN** a colored tab is a split member, dirty, or the current reorder drop target
- **THEN** badge, dot, and insertion bar all remain visible and distinct
