## MODIFIED Requirements

### Requirement: Opening a review or file another window holds

When a window opens a review whose url another window holds, it SHALL move that review tab into itself and show it,
and SHALL NOT create a second review. This holds for a continuous review url and for a single-file review url alike.
When a window opens a file whose editor tab another window holds, it SHALL
show the toast "`<name>` is open in another window" and SHALL change nothing, because it cannot see that window's
unsaved text. A preview open in a window SHALL only ever replace a preview tab that window shows; a preview another
window holds is never replaced from here.

#### Scenario: A review held by the main window moves

- **WHEN** the main window shows the Changes review of a project, and a single-file review of that project in a
  detached window shows "No more files in Changes" and the user presses its Open review
- **THEN** the review tab moves into the detached window, and the main window no longer lists it

#### Scenario: A single-file review held by the main window moves

- **WHEN** a detached window shows a single-file review of `a.ts` under Changes, and the main window chooses `a.ts`
  under Changes in Source Control
- **THEN** that review tab moves into the main window and is shown there, and no second tab is created

#### Scenario: A file held by another window stays there

- **WHEN** the main window holds an editor tab for `/home/u/notes.md`, and a detached window opens that file
- **THEN** the detached window shows "notes.md is open in another window", and the editor stays in the main window
  with its text

#### Scenario: A preview open in a detached window stays in it

- **WHEN** a detached window's focused pane holds a preview of `a.ts`, the main window holds a preview of `b.ts`, and
  the user opens `c.ts` from the Explorer in the main window
- **THEN** the main window's preview shows `c.ts`, and the detached window's preview still shows `a.ts`
