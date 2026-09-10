# chrome-tab-strip Specification

## Purpose

The desktop tab strip renders in Chrome's visual language, closes only via a confirming ✕, overflows horizontally, and shows the same tab identity in the mobile drawer.

## Requirements

### Requirement: Desktop tabs render in Chrome's visual language

The desktop topbar tab strip SHALL render each tab as a button with `min-width: 120px` and a
**top-only corner radius**, showing: a kind icon (terminal / web / dashboard / editor / markdown) in
the leading slot, the display title (custom name > OSC title > kind default), and a ✕ close affordance
on the active tab and on hover. The **active tab SHALL be taller than its inactive neighbours, share
the content area's background, and carry a top border in its accent color** (its own tab color if set,
else the theme accent) so it reads as joined to the terminal below it. Inactive tabs SHALL render an
8% tint of their own color over the strip background (`bg/92`) with the subdued foreground, and SHALL
sit flush against one another with no gap. A `+` button SHALL sit after the last tab.

Group chips and fused split buttons SHALL adopt the same top-only radius as a single unit — a group's
members and a fused pairing each keep one shared outer radius rather than one per member — so grouping
and splitting remain visually distinguishable from a run of ordinary tabs.

#### Scenario: Active tab joins the content

- **WHEN** an uncolored tab is active under a theme with a light accent
- **THEN** it renders taller than its neighbours, filled with the content-area background, with a top
  border in the theme accent and a top-only corner radius, at least 120px wide

#### Scenario: Inactive tab is an 8% tint

- **WHEN** a peach-colored tab is inactive
- **THEN** its button background is an 8% peach tint over the strip background and its text uses
  the subdued foreground

#### Scenario: Kind icon shown

- **WHEN** a `web` tab and a `terminal` tab are open
- **THEN** each tab shows its kind's icon in the leading position

#### Scenario: A fused pairing still reads as one button

- **WHEN** two tabs are fused as a split pairing
- **THEN** the pair carries one shared top-only radius with a seam between the members, not two
  separate tab shapes

#### Scenario: A group still reads as a block

- **WHEN** a group of three tabs is rendered
- **THEN** the chip and its members share one outer radius and the group's color remains visible
  across the whole block

### Requirement: Closing a tab requires targeting the ✕ and confirms terminals

Clicking a tab's body SHALL switch to it (including the active tab — the current
"tap-active-to-kill" behavior is removed). Clicking the ✕ SHALL close the tab; for `terminal`
tabs a confirmation SHALL be required (shell termination warning), for non-terminal kinds with
no unsaved state it SHALL close immediately.

#### Scenario: Clicking the active tab is a no-op

- **WHEN** the user clicks the body of the already-active tab
- **THEN** nothing is killed and no confirmation appears

#### Scenario: Terminal close confirms

- **WHEN** the user clicks ✕ on a terminal tab
- **THEN** a confirmation is shown before `kill` is sent

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
