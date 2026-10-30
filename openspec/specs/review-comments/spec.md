# review-comments Specification

## Purpose
Lets the user leave pull-request-style comments on lines of a diff, keeps them outside the repository
and attached to their code as it changes, and hands them off as one markdown document.

## Requirements

### Requirement: A comment attaches to a line or a range on one side

The user SHALL be able to add a comment to one line or a contiguous range of lines on either side of a
diff: the old side or the new side. On desktop a range SHALL be picked by dragging across line numbers
or shift-clicking; on a phone by tapping a line number, then tapping the last line of the range. The
comment SHALL show under the last line of its range, with the range highlighted.

#### Scenario: A one-line comment

- **WHEN** the user taps the new-side line number 42 of `a.ts`, chooses Comment and saves "rename this"
- **THEN** the comment shows under line 42 and line 42 is marked as commented

#### Scenario: A range on a phone

- **WHEN** the user taps line 10, then taps line 14, then chooses Comment
- **THEN** the new comment covers lines 10 to 14 of that side

### Requirement: Comments can be edited and deleted

A comment SHALL be editable and deletable in place. Deleting SHALL ask for no confirmation when the
comment is empty and SHALL ask once otherwise. An unsaved draft SHALL survive scrolling it out of view and
back.

#### Scenario: A draft scrolled away

- **WHEN** the user types a draft, scrolls ten files further and scrolls back
- **THEN** the draft is still there, unsaved, with its text intact

### Requirement: Comments are stored outside the repository

Comments SHALL be stored per project on the palmux server under the config directory's `.cache/`, never
inside the repository and never in a file git could pick up. That directory SHALL be ignored by any git
repository the config directory sits in. Two windows editing comments of one project SHALL NOT lose each
other's comments.

#### Scenario: The repository stays clean

- **WHEN** the user adds ten comments in a project
- **THEN** `git status` in that project shows nothing new

#### Scenario: Two windows at once

- **WHEN** a desktop adds a comment while a phone deletes a different comment of the same project
- **THEN** both changes are kept, and within 2 seconds both windows, while showing the project, show the
  same comments

### Requirement: Comments stay attached to their code

A comment SHALL record the text of its lines and a few lines around them. When the file changes, the
comment SHALL move to where that text now is, choosing the match nearest its old position. A comment
whose text is no longer in the file SHALL be marked outdated, shown in a list of outdated comments with
its original code quoted, and SHALL NOT be attached to an unrelated line.

#### Scenario: Lines inserted above

- **WHEN** a comment sits on line 50 and ten lines are inserted at line 5
- **THEN** the comment shows on line 60, under the same code

#### Scenario: A comment survives Reviewed

- **WHEN** the user comments on a line under Changes, taps Reviewed, and opens Staged Changes
- **THEN** the comment is shown on the same line of the staged version

#### Scenario: The code is deleted

- **WHEN** the commented lines are deleted from the file
- **THEN** the comment is marked outdated and listed with its original code

### Requirement: Comments export as one markdown document

The view SHALL copy every comment of the active project to the clipboard as one markdown document,
grouped by file in path order, each comment giving its path and line range, the code it covers as a
fenced block, and its text. Outdated comments SHALL be included and marked as such.

#### Scenario: Copying for an agent

- **WHEN** the project has three comments in two files and the user chooses Copy comments
- **THEN** the clipboard holds a markdown document with two file sections, three quoted code blocks and
  the three comment texts
