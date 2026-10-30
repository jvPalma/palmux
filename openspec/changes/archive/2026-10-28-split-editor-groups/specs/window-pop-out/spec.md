# Spec Delta

## MODIFIED Requirements

### Requirement: Dragging a tab out of the browser window pops it out (desktop)

The client SHALL, when a strip-tab drag ends OUTSIDE the browser window (release coordinates beyond
the viewport and no internal drop target), open that tab as a popup positioned near the release
point. If the popup is blocked despite the gesture, the client SHALL show a toast with an explicit
open action instead of failing silently.

#### Scenario: Drag-release outside spawns a window

- **WHEN** the user drags a tab and releases it outside the browser window
- **THEN** a popup window opens near the release position showing that tab

#### Scenario: Release inside a drop zone does not pop out

- **WHEN** the drag ends on a pane's edge, centre or strip
- **THEN** the editor-group drop applies and no popup opens

## REMOVED Requirements

### Requirement: Popping out a tab in a split keeps the split

**Reason**: Pairings are retired; the rule is restated for panes below.

**Migration**: "Popping out a tab in a pane keeps the pane".

## ADDED Requirements

### Requirement: Popping out a tab in a pane keeps the pane

Popping out a tab SHALL NOT move it out of its pane in the main window: the pane keeps the tab and, for a terminal,
shows the taken-over state with Take back. "Return to main" SHALL select the tab in its pane and focus that pane.

#### Scenario: Pop out a pane's terminal

- **WHEN** the user pops out the terminal shown in pane B of three panes
- **THEN** the main window still has three panes, and pane B shows the taken-over state with Take back
