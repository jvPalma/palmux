## MODIFIED Requirements

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
