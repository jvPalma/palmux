## ADDED Requirements

### Requirement: Split display is scoped to its member tabs

The split layout SHALL be displayed only when the active tab is one of the split's two member tabs; selecting or opening any other tab SHALL show that tab full-width while preserving the split pairing (orientation, ratio, and the two member tab ids) so the split re-tiles on return. This supersedes the previous behavior where any strip selection replaced the focused slot.

#### Scenario: Active tab is a split member

- **WHEN** the split is `(t0 | t1)` and the active tab is `t0`
- **THEN** both member tabs are tiled in their slots and the content area shows the split

#### Scenario: Selecting a non-member tab hides but preserves the split

- **WHEN** the split is `(t0 | t1)` and the user selects tab `t2` (not a member)
- **THEN** `t2` is shown full-width, and the split state `(t0 | t1)` is preserved (not cleared)

#### Scenario: Returning to a member re-tiles the split

- **WHEN** the split is `(t0 | t1)` but hidden (active tab is `t2`) and the user selects `t0`
- **THEN** the split re-tiles and slot A (`t0`) becomes the focused slot

### Requirement: A split has exactly two slots

A split SHALL contain exactly two slots at all times; no operation SHALL produce a third slot, a nested split, or a single-slot split, and the tab strip SHALL remain a flat, unre-ordered list (the split references two tab ids without grouping the strip).

#### Scenario: Dragging a tab into an active split replaces, never adds

- **WHEN** a split is active and the user drags a strip tab into the content area
- **THEN** the targeted slot's content is replaced and the split still has exactly two slots

#### Scenario: Splitting does not restructure the strip

- **WHEN** the strip is `[t0, t1, t2, t3]`, the active tab is `t0`, and `t2` is dragged into a split
- **THEN** the strip stays `[t0, t1, t2, t3]` (flat, same order) and the split references exactly two tab ids

### Requirement: New tabs are created outside the split

Creating a new tab (the `[+]` control or a server `tabCreated` message) while a split is active SHALL NOT replace either split slot; the new tab SHALL be added outside the split and shown full-width, with the split pairing preserved.

#### Scenario: [+] while split-focused creates an outside tab

- **WHEN** the split is `(t0 | t1)`, slot A (`t0`) is focused, and the user clicks `[+]`
- **THEN** a new terminal tab `t4` is created, activated full-width, and the split still equals `(t0 | t1)`

#### Scenario: Server-created tab does not consume a slot

- **WHEN** a `tabCreated` message arrives while the split is `(t0 | t1)`
- **THEN** the created tab is activated full-width and neither slot is replaced

### Requirement: A tab can be ejected from a split slot

Each split slot SHALL expose a control that removes it from the split; ejecting a slot SHALL collapse the split entirely and show the OTHER slot's tab full-width, and SHALL NOT close either tab (both remain in the strip).

#### Scenario: Eject slot A keeps slot B full-width

- **WHEN** the split is `(t0 | t1)` and the user activates eject on slot A
- **THEN** the split is collapsed, `t1` is shown full-width and active, and both `t0` and `t1` remain in the strip

#### Scenario: Eject slot B keeps slot A full-width

- **WHEN** the split is `(t0 | t1)` and the user activates eject on slot B
- **THEN** the split is collapsed and `t0` is shown full-width and active

### Requirement: The focused split slot is reflected in the tab strip

While a split is displayed, the tab strip SHALL visually distinguish the tab in the focused slot from the tab in the unfocused slot, so the focused slot is identifiable from the strip alone (not only from the pane border).

#### Scenario: Focused-slot indicator on the strip

- **WHEN** the split is `(t0 | t1)` and slot A (`t0`) is focused
- **THEN** `t0`'s strip item shows the focused-slot indicator and `t1`'s shows the unfocused member indicator

#### Scenario: Indicator follows focus changes

- **WHEN** focus moves to slot B (`t1`) via a strip click or a click on pane B
- **THEN** the focused-slot indicator moves to `t1`'s strip item

#### Scenario: Collapsing clears the indicators

- **WHEN** the split is collapsed
- **THEN** no split slot indicators remain in the strip
