## ADDED Requirements

### Requirement: Dragging a tab onto a slot replaces that slot

While a split is active, dragging a strip tab onto one of the two slots SHALL replace that slot's content with the dragged tab while keeping exactly two slots; the slot's prior tab SHALL remain in the strip (not closed), and the dropped-on slot SHALL become the focused slot.

#### Scenario: Drop replaces the targeted slot

- **WHEN** the split is `(t0 | t1)` and the user drags `t2` onto slot A
- **THEN** the split becomes `(t2 | t1)`, slot A is focused, and `t0` remains in the strip

#### Scenario: Dropping a tab already in the other slot is a no-op

- **WHEN** the split is `(t0 | t1)` and the user drags `t1` onto slot A
- **THEN** the split is unchanged (a tab is never duplicated into both slots)

#### Scenario: Edge-drop with no active split still opens a split

- **WHEN** no split is active and a strip tab is dragged to a content edge
- **THEN** the existing open-a-split-at-that-edge behavior applies, unchanged
