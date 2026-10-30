# Spec Delta

## REMOVED Requirements

### Requirement: Strip drag reorders, Chrome-like

**Reason**: Its split-member scenarios describe pairings, which are retired; each pane now has its own strip.

**Migration**: "A pane strip drag reorders, Chrome-like".

## ADDED Requirements

### Requirement: A pane strip drag reorders, Chrome-like

Dragging a tab within a pane's strip SHALL reorder it: during the drag an insertion indicator SHALL mark the drop position, and dropping SHALL move the tab there, applied optimistically in the dragging client and confirmed by the server broadcast. A pane's strip lists a subset of the tabs, so the drop position SHALL be mapped to the full server order (before the tab the marker precedes in that strip). Dropping a tab on the strip SHALL NOT change any other pane.

#### Scenario: Drop between tabs moves the tab

- **WHEN** the strip is `[t0, t1, t2, t3]` and `t3` is dropped between `t0` and `t1`
- **THEN** the strip becomes `[t0, t3, t1, t2]`

#### Scenario: A pane's reorder maps to the full order

- **WHEN** the server order is `[t0, t1, t2, t3]`, pane A holds `t0, t2, t3` and pane B holds `t1`, and `t3` is dropped before `t2` in A's strip
- **THEN** the server order becomes `[t0, t1, t3, t2]` and pane B is unchanged

#### Scenario: Content-area drag gestures are separate

- **WHEN** a tab is dragged to a pane's edge or centre instead of a strip
- **THEN** the editor-group drops apply (see `editor-groups`)
