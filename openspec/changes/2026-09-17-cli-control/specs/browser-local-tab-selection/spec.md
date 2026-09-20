## MODIFIED Requirements

### Requirement: Tab selection is per browser window

Which tab a window is showing SHALL be stored in `sessionStorage`, so it is
scoped to one browsing context and survives a reload of that context. It MUST
NOT be stored in `localStorage` and MUST NOT be sent to the server.

A window MAY announce THAT it is in front — on its control connection opening,
on gaining focus, and on its visibility returning to visible. That announcement
MUST NOT carry a tab id. The distinction is the requirement: the server may learn
which window the user is looking at, and may never learn which tab that window is
showing. The announcement exists only so a command issued from outside palmux has
a window to target, and the server SHALL use it for nothing else.

#### Scenario: Two windows hold independent selections

- **WHEN** the user opens palmux in two browser tabs and selects a different
  palmux tab in each
- **THEN** each window keeps its own selection, and switching in one does not
  move the other

#### Scenario: A reload keeps the selection

- **WHEN** the user reloads a window showing tab `4`
- **THEN** the window comes back showing tab `4`

#### Scenario: A new window starts clean

- **WHEN** the user opens palmux in a fresh browser tab
- **THEN** it does not inherit any other window's selection

#### Scenario: Focus is announced without the selection

- **WHEN** a window showing tab `3` gains focus
- **THEN** the server records that the window is in front, and holds no record
  that it is showing tab `3`

#### Scenario: What the server holds cannot move the wrong window

- **WHEN** a command is delivered on the strength of an activity announcement
- **THEN** it goes to the window that announced, and the decision about which tab
  that window shows is still made in the client
