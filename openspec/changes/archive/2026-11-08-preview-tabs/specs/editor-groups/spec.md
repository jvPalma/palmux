## MODIFIED Requirements

### Requirement: New tabs open in the focused pane

A tab this window creates (the `+` button, the New-tab page, a file or review opened from the dock, the tmux picker)
SHALL open in the focused pane as its active tab, unless it is created from a specific pane's `+`. A tab that
already exists elsewhere and is opened again (a file or review already open) SHALL be selected in its own pane,
which becomes focused.
A preview open (see `preview-tabs`) of a target with no tab SHALL reuse the focused pane's preview tab when it has
one, and SHALL otherwise open a new preview tab in the focused pane as above. Moving a preview tab to another pane
(a drop, Split right or Split down) SHALL pin it; the rest of what pins is listed in `preview-tabs` only.

#### Scenario: Opening a file

- **WHEN** pane B is focused and the user opens a file from the Explorer
- **THEN** the file's tab opens in pane B as its active tab

#### Scenario: Reopening an open file

- **WHEN** a file is already open in pane A while pane B is focused, and the user opens it again
- **THEN** no new tab is created, pane A is focused and shows that file

#### Scenario: A preview open reuses the pane's preview

- **WHEN** pane B is focused and holds a preview of `a.ts`, and the user opens `b.ts` from the Explorer
- **THEN** pane B's preview tab shows `b.ts` and pane B holds no new tab

#### Scenario: Split right pins a preview

- **WHEN** a pane holds a pinned tab and a preview tab, and the user chooses Split right on the preview tab
- **THEN** the preview tab moves into the new pane and is pinned

### Requirement: The layout follows the server's tab list

On every `sessions` broadcast the client SHALL reconcile the layout: a tab that no longer exists, or whose kind
changed (ids are recycled), SHALL leave its pane; a tab no pane holds SHALL join the focused pane without becoming
active. Reconcile SHALL never error and never create a tab. Tab order and colour groups SHALL stay server state; the
layout SHALL hold only which pane holds which tab.
Before any of that, a listed tab that `replaces` a tab some pane holds, where the list no longer lists the replaced
tab and no pane holds the new one, SHALL take the replaced tab's entry in place: the same pane, the same position,
and the pane's active tab if the replaced one was. The pane's close rule SHALL then not run for the replaced tab, so
no neighbour is shown in between. On the mobile layer the window's selection SHALL move the same way in the same
broadcast.

#### Scenario: Another window opens a tab

- **WHEN** another window creates tab 7 while this window has two panes with B focused
- **THEN** tab 7 appears in B's strip and B's active tab does not change

#### Scenario: A recycled id

- **WHEN** a saved layout holds tab 3 as an editor but tab 3 is now a terminal
- **THEN** the editor entry is dropped and terminal 3 joins the focused pane as a new tab

#### Scenario: A replaced preview keeps its place

- **WHEN** pane B holds tabs `[2, 4, 6]` with 4 active, and a broadcast lists tab 9 with `replaces: '4'` and no tab 4
- **THEN** one reconcile leaves pane B holding `[2, 9, 6]` with 9 active, and no intermediate layout has 2 or 6 active

#### Scenario: A replaced tab this window does not hold

- **WHEN** a broadcast lists tab 9 with `replaces: '4'` and no pane of this window held tab 4
- **THEN** tab 9 joins the focused pane without becoming active, as any new tab does
