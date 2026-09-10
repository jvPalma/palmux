# split-dnd

Forming and dissolving splits on desktop — via the tab context menu and drag-and-drop. Split is a
desktop-only feature (see `split-layout`); there is no split invocation while the mobile layer is
active, and no default keyboard shortcut (S1 Q3 — Ctrl+\ collides with tmux; any future shortcut
must be user-configurable and default unset).

## ADDED Requirements

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
left/right/top/bottom drop zones. Dropping on an edge SHALL open a split with the dragged tab in
that position and the current tab in the opposite slot, orientation from the drop axis.

#### Scenario: Drop on the right edge

- **WHEN** the user drags a tab and drops it on the right edge of the content area
- **THEN** a side-by-side split opens with the dragged tab on the right

#### Scenario: Drag is cancellable

- **WHEN** the user starts dragging a tab and releases it INSIDE the browser window but outside
  any drop zone
- **THEN** no split is created and the layout is unchanged (a release OUTSIDE the browser window
  is the pop-out gesture — see `window-pop-out`)

### Requirement: Dragging a split tab back to the strip collapses the split

On desktop, a split slot's tab SHALL be draggable onto the tab strip; dropping it there SHALL
collapse the split — that tab becomes the lone active tab and the other slot fills the area.

#### Scenario: Drag back to the strip

- **WHEN** the user drags a split slot's tab chip onto the tab strip and drops it
- **THEN** the split collapses to a single slot and the dropped tab is the active tab

### Requirement: No split invocation while the mobile layer is active

Split creation and collapse SHALL be absent while the mobile layer is active — no context-menu
"Split" items, no drag-to-split, no orientation toggle (split is desktop-only, see `split-layout`).

#### Scenario: Mobile long-press sheet has no split

- **WHEN** the user long-presses a drawer row on mobile
- **THEN** the sheet offers rename/color/close (and pop-out) but no "Split" action
