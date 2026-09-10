## ADDED Requirements

### Requirement: A web pane's back and forward move the framed page only

A web pane SHALL offer ← and → controls that move the framed page's history.
Because the tab strip no longer writes to the browser's history stack, these
controls SHALL be unambiguous: a press moves the embedded page and SHALL NOT
change which tab is active. This is required because an installed PWA has no
browser chrome of its own.

#### Scenario: Back navigates the page, not the workspace

- **WHEN** the user switches between three tabs, focuses a web tab, navigates
  inside it, and presses ←
- **THEN** the framed page goes back one entry and the active tab is unchanged

#### Scenario: Back at the start of the framed history does nothing visible

- **WHEN** the user presses ← on a web pane that has not navigated since it opened
- **THEN** the pane stays where it is and no tab switch occurs
