# diff-review Specification

## Purpose
Renders the changes of the active project as a syntax-coloured diff that you can read, step through and
stage file by file on a desktop or a phone, one file or the whole change set at a time.

## Requirements

### Requirement: A review opens in the content area

Choosing a file in the Source Control view SHALL open a review pane for that project's group (Staged
Changes or Changes) in the content area, never inside the dock, and scroll it to that file. One project
and group SHALL have at most one review pane: choosing another file of the same group SHALL focus that
pane and scroll to the file instead of opening a second one. On mobile, choosing a file SHALL close the
drawer.

#### Scenario: Opening two files of one group

- **WHEN** the user chooses `a.ts` and then `b.ts` under Changes
- **THEN** one review pane exists, and it shows `b.ts` at the top of the view

#### Scenario: Two windows open the same group at once

- **WHEN** a desktop and a phone open a file of the same project's Changes within the same second
- **THEN** exactly one review tab for that group exists afterwards, and both windows show it

#### Scenario: Staged and unstaged versions

- **WHEN** the user chooses `a.ts` under Staged Changes and then under Changes
- **THEN** two review panes exist, one comparing the index with `HEAD` and one comparing the work tree
  with the index

### Requirement: The review shows the whole group as one list

A review pane SHALL show every file of its group in one scrolling list, each file under a header with
its path, its status and its added and removed line counts. A file header SHALL collapse and expand that
file. Only the files near the visible part of the list SHALL be fetched and rendered, so a group of
hundreds of files opens as fast as a group of one.

#### Scenario: A large change set

- **WHEN** the group holds 400 changed files
- **THEN** the pane opens showing the first files, and diffs are fetched only for files that come near the
  visible part of the list

#### Scenario: Collapsing a file

- **WHEN** the user collapses a file's header
- **THEN** that file's lines are hidden and the next file's header follows directly

### Requirement: Side-by-side and unified layouts

The review SHALL offer a side-by-side layout (old on the left, new on the right, changed lines paired)
and a unified layout (one column, removed lines above added lines), plus an automatic mode that uses
unified when the pane is too narrow for two readable columns. The choice SHALL be stored per device.
Switching layout SHALL keep the same file in view.

#### Scenario: A phone in automatic mode

- **WHEN** the review opens in a 390px wide pane with the automatic mode selected
- **THEN** the unified layout is used

#### Scenario: Forcing side-by-side

- **WHEN** the user selects side-by-side on a 1400px wide pane
- **THEN** changed lines appear in two columns with the old and new line numbers on their own sides

### Requirement: The diff algorithm is git's and is selectable

Hunks SHALL be computed by git, not by the browser. The review SHALL offer git's myers, minimal, patience
and histogram algorithms, and the choice SHALL be stored per device. Changing the algorithm SHALL refetch
the loaded files and keep the current file in view.

#### Scenario: Switching to histogram

- **WHEN** the user switches the algorithm from myers to histogram
- **THEN** the loaded files are fetched again with that algorithm and the hunks shown are git's for it

### Requirement: Changed words are marked inside changed lines

When a removed line is paired with an added line, the review SHALL mark the characters that differ
between them, the way VS Code marks inline changes. Lines too long to compare cheaply SHALL be shown
without the inner marks rather than slowing the pane.

#### Scenario: A renamed variable

- **WHEN** a line changes from `const total = a + b` to `const sum = a + b`
- **THEN** only `total` and `sum` carry the inner change mark on their lines

### Requirement: Lines are coloured by the editor's grammars and the palmux theme

Every line SHALL be syntax-coloured with the grammar the editor uses for that file name and with the
colours of the palmux theme this device shows, and SHALL repaint when the theme changes. Colouring SHALL
use the whole file on each side, so a line inside a multi-line comment or string is coloured as such. A
file with no grammar, or too large to colour cheaply, SHALL be shown as plain text. A session that never
opens a review SHALL download no colouring code.

#### Scenario: A theme change

- **WHEN** the user picks a light theme while a review is open
- **THEN** the diff repaints in the new theme's colours without reloading

#### Scenario: Inside a block comment

- **WHEN** a changed line sits inside a multi-line comment that starts outside the hunk
- **THEN** the line is coloured as a comment

### Requirement: Hidden lines between hunks can be expanded

Between two hunks, and before the first and after the last, the review SHALL offer to show more unchanged
lines, a step at a time or all of them, without refetching the diff.

#### Scenario: Expanding a gap

- **WHEN** the user expands a gap of 80 hidden lines one step at a time
- **THEN** each step reveals more of those lines with their correct old and new line numbers

### Requirement: Line endings and git attributes are honoured

The diff SHALL compare the two sides the way git does for that path: line-ending conversion SHALL be
applied, so a file stored with LF and checked out with CRLF shows only its real edits, and a path git is
told to treat as binary SHALL be shown as binary. A path converted by a filter driver, a working-tree
encoding or ident expansion SHALL show a notice that the file is converted by git and cannot be shown,
rather than a wrong diff.

#### Scenario: A CRLF blob that was never normalised

- **WHEN** the repository has `* text=auto`, the index blob of `a.txt` still holds CRLF, and one line is
  edited on disk
- **THEN** the diff shows the one edited line, and Reviewed stages a blob that still uses CRLF

#### Scenario: CRLF in the work tree

- **WHEN** `docs/a.txt` has `text eol=crlf`, its index blob uses LF, and one line is edited on disk
- **THEN** the diff shows the one edited line

#### Scenario: Forced binary

- **WHEN** `.gitattributes` marks `*.lock` with `-diff` and `yarn.lock` changes
- **THEN** its header states that it is binary and no lines are drawn

### Requirement: Special files are explained, not rendered

A binary file, a file with either side over the size limit, a deleted file, a new file, a renamed
file, a mode change and a symbolic link SHALL each show a header that names the case. A binary or
oversized file SHALL show no lines. A rename SHALL show the old and new paths and its content changes,
if any.

#### Scenario: A binary file

- **WHEN** a changed file is binary
- **THEN** its header states that it is binary and no lines are drawn

#### Scenario: A staged rename

- **WHEN** `a.ts` is renamed to `b.ts` with one line changed, and the rename is staged
- **THEN** the header shows `a.ts → b.ts` and the diff shows the one changed line, not a whole new file

#### Scenario: A staged file before the first commit

- **WHEN** the project has no commit yet and `a.ts` is staged
- **THEN** opening it shows every line as added

#### Scenario: Only the executable bit changes

- **WHEN** a file's executable bit is set and nothing else changes
- **THEN** the file is listed and its header shows the mode change

### Requirement: Lines, colours and hunks describe one version

The hunks, the line text, the colours and the comment positions shown for a file SHALL all come from the
same version of each side. An edit on disk while a file is loading SHALL NOT mix the old diff with the new
text; the newer version replaces the older one as a whole.

#### Scenario: An edit during loading

- **WHEN** ten lines are inserted into `a.ts` while its diff is loading
- **THEN** the pane shows either the version from before the edit or the one after it, never hunks from
  one with lines from the other

### Requirement: The review is navigable by change and by file

The review SHALL offer next change, previous change, next file and previous file, and a way back to the
file list. On desktop each SHALL have a keybinding. On mobile, while a review is the active tab, a review
bar SHALL take the extra-keys bar's place, holding the file list, previous file and next file as up and
down arrows, and Reviewed or Unstage, all within thumb reach, and no terminal key.

#### Scenario: Next change crosses a file

- **WHEN** the current change is the last one of a file and the user presses next change
- **THEN** the view moves to the first change of the next file

#### Scenario: The review bar on a phone

- **WHEN** a review is the active tab on mobile and the user taps the bar's down arrow
- **THEN** the view moves to the next file, the extra-keys bar is not shown, and no key is sent to any
  terminal

### Requirement: The review bar keeps the bar's swipes

The review bar SHALL keep the extra-keys bar's horizontal swipes, so the drawer is never out of reach: a
right-to-left swipe opens the drawer, and a left-to-right swipe returns to the tab that was active before
the review was opened, or to the first terminal when that tab is gone.

#### Scenario: Back to the terminal

- **WHEN** the user opened the review from a terminal and swipes left to right on the review bar
- **THEN** that terminal becomes the active tab and the extra-keys bar returns

#### Scenario: Opening the drawer

- **WHEN** the user swipes right to left on the review bar
- **THEN** the drawer opens, as it does from the extra-keys bar

#### Scenario: A swipe that starts on Reviewed

- **WHEN** the user's finger lands on Reviewed and swipes right to left
- **THEN** the drawer opens and nothing is staged

### Requirement: Reviewing a file stages it and moves on

In a Changes review, each file SHALL offer Reviewed. Reviewed SHALL stage exactly the version of the file
the review showed and then move to the next file. If the file changed on disk after it was shown, the
newer change SHALL stay under Changes rather than be staged unseen. A toast SHALL offer Undo for 6
seconds, and Undo SHALL put the file's index entry back exactly as it was, including a partially staged
version.

#### Scenario: Review and move on

- **WHEN** the user taps Reviewed on `a.ts`, the second of five files
- **THEN** `a.ts` is staged, it leaves Changes, and the view moves to the third file

#### Scenario: An edit after it was shown

- **WHEN** `a.ts` is edited on disk after the review showed it, and the user taps Reviewed
- **THEN** the version the user saw is staged and the newer edit appears under Changes

#### Scenario: A file palmux cannot snapshot

- **WHEN** a changed file is over the size limit or converted by a git filter
- **THEN** Reviewed is disabled with the reason, and nothing about the file is staged

#### Scenario: Reviewed after a long review

- **WHEN** the user taps Reviewed on a file loaded more than ten minutes earlier and unchanged since
- **THEN** the file is staged without an error

#### Scenario: Undo after another window staged

- **WHEN** the user taps Reviewed on `a.ts`, another window then stages a newer `a.ts`, and the user taps
  Undo
- **THEN** nothing is undone and the review says the index changed since

#### Scenario: Undo after a partial stage

- **WHEN** part of `a.ts` was already staged, the user taps Reviewed, then Undo
- **THEN** the index holds the earlier partially staged version again

### Requirement: A staged file can be unstaged

In a Staged Changes review, each file SHALL offer Unstage, which returns its index entry to the `HEAD`
version (or removes it from the index when `HEAD` has no such file) and moves to the next file, with the
same 6-second Undo.

#### Scenario: Unstaging a new file

- **WHEN** the user unstages a file that is new in the index
- **THEN** the file leaves the index, stays on disk, and appears under Changes as untracked

### Requirement: The review follows the disk while visible

While a review pane is visible, a change on disk to one of its files SHALL update that file's diff within
2 seconds, keeping the same code in view: the line at the top of the view is found again by its text
and context, not by its number. If that line was deleted, the nearest surviving line takes its place. A
file that leaves the group SHALL be removed, and a file that joins it SHALL be added in path order.

#### Scenario: Editing the file being read

- **WHEN** the user reads the middle of `a.ts` and a line near its end is edited on disk
- **THEN** the new hunk appears within 2 seconds and the lines in view do not move

#### Scenario: Lines inserted above the view

- **WHEN** the user reads line 100 of `a.ts` and ten lines are inserted at line 5
- **THEN** the same code stays in view, now numbered 110

### Requirement: The review never edits or discards

The review SHALL NOT edit a file's text or discard a change; its only write is staging or unstaging a
whole file. It SHALL offer to open the file in the editor, which is the existing editor tab for that
path.

#### Scenario: Opening the file

- **WHEN** the user chooses Open file on a file header
- **THEN** the file opens in an editor tab, or the existing editor tab for that path is focused

### Requirement: The code font size is adjustable at any time

The review's code (line text, line numbers and inline marks) SHALL use the device's code font size, the same
setting the editor uses and independent of the terminal font size. The review's view menu SHALL offer a
font size control with minus and plus buttons and the current value, which changes the size live without
closing the menu; Settings SHALL offer the same value. The value SHALL be stored per device and SHALL NOT be
written to the synced, dotfiles-tracked settings file.

#### Scenario: Smaller code on a phone

- **WHEN** the user opens the review's view menu on a phone and taps minus twice
- **THEN** the diff text shrinks two steps at once, rows stay aligned, and the terminal font size is unchanged

#### Scenario: Not synced

- **WHEN** the code font size is changed on the phone
- **THEN** the desktop's code font size is unchanged and the server's settings file holds no code font size

### Requirement: The review wastes no height on a phone

On a phone, a hunk's divider SHALL be one row of at most 20px that carries both the hidden-lines count with
small expand controls and the hunk header, instead of two rows; a file header SHALL be one row of at most
28px; and the review bar SHALL be no taller than the extra-keys bar it replaces.

#### Scenario: Reading a file with many hunks

- **WHEN** a file with five hunks is reviewed on a 390x844 phone
- **THEN** each divider between hunks is a single row at most 20px tall, and the file header is at most 28px

#### Scenario: One row carries the count, the controls and the heading

- **WHEN** a hunk has hidden lines above it
- **THEN** its divider row shows the hidden-lines count, the expand controls and the hunk heading (the
  heading ending in an ellipsis when the row is full), and no separate hunk header row is drawn for it

#### Scenario: A hunk with nothing hidden above it

- **WHEN** a hunk has no hidden lines above it (it starts the file, or its gap was shown in full)
- **THEN** it keeps one hunk header row of its own, at most 20px tall

#### Scenario: The desktop is unchanged

- **WHEN** the same review is shown on a desktop
- **THEN** each hunk has a gap row and a hunk header row as before, with the kit's buttons
