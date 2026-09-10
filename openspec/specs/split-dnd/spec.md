# split-dnd Specification

## Purpose

Drag-and-drop and menu gestures for the split view: menu actions and edge-drags open a split, dropping a strip tab onto a slot replaces that slot, and the mobile layer never invokes a split. (The former drag-back-to-strip collapse is retired — un-splitting is the per-slot eject.)

## Requirements

### Requirement: Menu actions open a split (desktop)

A tab's context menu SHALL offer "Split right" and "Split down", opening the current content in one
slot and the chosen tab in the other, with the orientation implied by the action.

#### Scenario: Split from the tab menu

- **WHEN** the user right-clicks a tab and picks "Split right"
- **THEN** a side-by-side split opens with that tab in the right slot and the previously active tab
  in the left

#### Scenario: Split with the active/only tab spawns a new terminal (S1 Q3)

- **WHEN** the user invokes "Split right" on the tab that is already the sole content, or only one
  tab exists
- **THEN** a NEW terminal tab opens in the empty slot beside the current tab (never the same tab id
  in both slots)

### Requirement: Dragging a strip tab to a content edge forms a split

On desktop, a strip tab SHALL be draggable; while dragging, the content area SHALL present
left/right/top/bottom drop zones. Dropping on an edge SHALL fuse the dragged tab with the current
tab into a pairing — the dragged tab in that position, orientation from the drop axis — which
includes adopting the current (anchor) tab's group membership and reordering the dragged tab
adjacent to it (see `split-fusion`).

#### Scenario: Drop on the right edge

- **WHEN** the user drags a tab and drops it on the right edge of the content area
- **THEN** a side-by-side pairing opens with the dragged tab on the right and its fused button in
  the strip

#### Scenario: Drag is cancellable

- **WHEN** the user starts dragging a tab and releases it INSIDE the browser window but outside
  any drop zone
- **THEN** no pairing is created and the layout is unchanged (a release OUTSIDE the browser window
  is the pop-out gesture — see `window-pop-out`)

### Requirement: No split invocation while the mobile layer is active

Split creation and collapse SHALL be absent while the mobile layer is active — no context-menu
"Split" items, no drag-to-split, no orientation toggle (split is desktop-only, see `split-layout`).

#### Scenario: Mobile long-press sheet has no split

- **WHEN** the user long-presses a drawer row on mobile
- **THEN** the sheet offers rename/color/close (and pop-out) but no "Split" action

### Requirement: Dragging a tab onto a slot replaces that slot

While a pairing is active, dragging a strip tab onto one of the two slots SHALL replace that
slot's content with the dragged tab while keeping exactly two slots; the slot's prior tab SHALL
pop out of the pairing as a standalone strip tab (not closed), the newcomer SHALL adopt the
pairing's group membership and adjacency, and the dropped-on slot SHALL become the focused slot.

#### Scenario: Drop replaces the targeted slot

- **WHEN** the active pairing is `(t0 | t1)` and the user drags `t2` onto slot A
- **THEN** the pairing becomes `(t2 | t1)`, slot A is focused, and `t0` stands alone in the strip

#### Scenario: Dropping a tab already in the other slot is a no-op

- **WHEN** the active pairing is `(t0 | t1)` and the user drags `t1` onto slot A
- **THEN** the pairing is unchanged (a tab is never duplicated into both slots)

#### Scenario: Edge-drop with no active split still opens a split

- **WHEN** no pairing is active and a strip tab is dragged to a content edge
- **THEN** the fuse-at-that-edge behavior applies, unchanged

### Requirement: Drop zones preview the claimed region

While a tab drag hovers a split or slot drop zone, the zone SHALL paint a visible preview overlay
(theme-accent tint) covering the REGION the drop would claim — the actual half of the content area
(left/right/top/bottom, at the initial 0.5 ratio) for an edge drop, the whole slot for a slot
replacement — cleared on drag-leave, drop, or drag end. OS file drags SHALL never trigger the
preview (they keep hitting the upload path).

#### Scenario: Edge hover shows the claimed half

- **WHEN** a dragged tab hovers the right-edge drop zone
- **THEN** the right HALF of the content area is tinted with the theme accent until the drag
  leaves the zone or drops

#### Scenario: Slot hover shows the claimed slot

- **WHEN** a pairing is active and a dragged tab hovers slot B
- **THEN** slot B's full region is tinted; slot A is not

#### Scenario: File drags never preview

- **WHEN** an OS file is dragged over the content area
- **THEN** no split/slot preview appears and the upload drop path handles the file
