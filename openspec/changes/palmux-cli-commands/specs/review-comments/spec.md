# Spec Delta

## MODIFIED Requirements

### Requirement: Comments can be edited and deleted

A comment SHALL be editable and deletable in place. Deleting SHALL ask for no confirmation when the
comment is empty and SHALL ask once otherwise. An unsaved draft SHALL survive scrolling it out of view and
back. A comment SHALL also offer Resolve, which deletes it without asking and offers Undo for as long as
the write toast shows; Undo SHALL store the same comment again. The view SHALL offer Clear all, which asks
once, naming how many comments it deletes, and then deletes every comment of the active project.

#### Scenario: A draft scrolled away

- **WHEN** the user types a draft, scrolls ten files further and scrolls back
- **THEN** the draft is still there, unsaved, with its text intact

#### Scenario: Resolve and undo

- **WHEN** the user chooses Resolve on a comment and then Undo on the toast
- **THEN** the comment disappears without a confirmation and then comes back with the same range, code and text

#### Scenario: Clear all

- **WHEN** the project has seven comments and the user chooses Clear all and confirms
- **THEN** the confirmation named 7 comments, and afterwards the project has no comments in every window showing it

#### Scenario: Clear all cancelled

- **WHEN** the user chooses Clear all and cancels the confirmation
- **THEN** no comment is deleted

### Requirement: Comments export as one markdown document

The view SHALL copy every comment of the active project to the clipboard as one markdown document,
grouped by file in path order, each comment giving its path and line range, the code it covers as a
fenced block, and its text. Outdated comments SHALL be included and marked as such. The document SHALL
open with a short instruction to address the comments, and each comment SHALL be headed
`<path>:L<start>-L<end>` (`<path>:L<line>` for one line) followed by its side. Copy comments SHALL be a
labelled control in the review's top bar as well as in the Source Control view, and a file header that
has comments SHALL offer a copy of that file's comments alone, in the same format. `palmux comments`
SHALL produce the same document as the view's copy for the same project and state.

#### Scenario: Copying for an agent

- **WHEN** the project has three comments in two files and the user chooses Copy comments
- **THEN** the clipboard holds a markdown document with the instruction, two file sections, three quoted
  code blocks and the three comment texts

#### Scenario: The heading names path and range

- **WHEN** a comment covers new-side lines 10 to 14 of `src/a.ts`
- **THEN** its heading in the document is `src/a.ts:L10-L14 (new)`

#### Scenario: One file's comments

- **WHEN** the user chooses the copy on the file header of `src/a.ts`, which holds two of the project's five comments
- **THEN** the clipboard holds the instruction, one file section and those two comments only

#### Scenario: Copy from the review

- **WHEN** a review is open on a desktop
- **THEN** its top bar shows a control labelled Copy comments that copies the active project's comments
