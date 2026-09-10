# chrome-tab-strip Delta

## MODIFIED Requirements

### Requirement: Desktop tabs render in Chrome's visual language

The desktop topbar tab strip SHALL render each tab as a FLAT, squared (no corner radius),
full-strip-height button with `min-width: 120px`, showing: a kind icon (terminal / web /
dashboard / editor / markdown) in the leading slot, the display title (custom name > OSC title >
kind default), and a ✕ close affordance on the active tab and on hover. The active tab SHALL fill
with its SOLID accent color (its own tab color if set, else the theme accent) with ink color
flipped by accent luminance (dark ink on light accents, light ink on dark); inactive tabs SHALL
render an 8% tint of the same color over the strip background (`bg/92`). No curved-corner,
elevation, or content-joining treatment SHALL remain. A `+` button SHALL sit after the last tab.

#### Scenario: Active tab is a solid accent block

- **WHEN** an uncolored tab is active under a theme with a light accent
- **THEN** it renders as a flat squared block solidly filled with the theme accent and dark ink,
  full strip height, at least 120px wide

#### Scenario: Inactive tab is an 8% tint

- **WHEN** a peach-colored tab is inactive
- **THEN** its button background is an 8% peach tint over the strip background and its text uses
  the subdued foreground

#### Scenario: Kind icon shown

- **WHEN** a `web` tab and a `terminal` tab are open
- **THEN** each tab shows its kind's icon in the leading position

### Requirement: Tab strip overflows horizontally

When tabs exceed the available width the strip SHALL keep every tab at or above its 120px minimum
width (fused split buttons at their 180px minimum) and scroll horizontally; the `+` button and the
topbar action icons SHALL remain reachable.

#### Scenario: Many tabs

- **WHEN** 12 tabs are open in a narrow window
- **THEN** no tab renders below 120px wide, the strip scrolls horizontally, and the active tab is
  scrolled into view on switch

### Requirement: Mobile drawer rows show the same identity

Mobile drawer session rows SHALL display each tab's kind icon, display title, and color consistent
with the desktop strip, sourced from the same `sessions.tabs` metadata, using the same flat visual
language: the active row solidly filled with its accent (luminance-flipped ink), inactive rows an
8% tint of their color.

#### Scenario: Rename on desktop appears on phone

- **WHEN** a tab is renamed from a desktop client
- **THEN** the mobile drawer row shows the new name after the next `sessions` broadcast without
  a reload

#### Scenario: Active drawer row matches desktop treatment

- **WHEN** the drawer opens while a colored tab is active
- **THEN** that row is solidly filled with the tab's accent color and flipped ink, and the other
  rows show 8% tints
