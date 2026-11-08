# diff-review Specification

## Purpose
Renders the changes of the active project as a syntax-coloured diff that you can read, step through and
stage file by file on a desktop or a phone, one file or the whole change set at a time.

## Requirements

### Requirement: A review opens in the content area

Choosing a file in the Source Control view SHALL open a single-file review of that file (see "A single file can be
reviewed in its own tab") as a preview open, in the content area, never inside the dock. Each group header SHALL
offer Open review, which opens the continuous review pane for that project's group (Staged Changes or Changes) in
the content area. One project and group SHALL have at most one continuous review pane: opening it again SHALL focus
that pane instead of opening a second one. On mobile, choosing a file or Open review SHALL close the drawer. Against
a server that does not announce `previewTabs`, choosing a file SHALL open the group's continuous review and scroll it
to that file, as before.

#### Scenario: Opening two files of one group

- **WHEN** the user chooses `a.ts` and then `b.ts` under Changes
- **THEN** one preview review tab exists, and it shows only `b.ts`

#### Scenario: Opening the whole group

- **WHEN** the user presses Open review on the Changes header
- **THEN** the continuous review of Changes opens, listing every file of the group

#### Scenario: Two windows open the same group at once

- **WHEN** a desktop and a phone press Open review on the same project's Changes within the same second
- **THEN** exactly one continuous review tab for that group exists afterwards, and both windows show it

#### Scenario: Staged and unstaged versions

- **WHEN** the user presses Open review under Staged Changes and then under Changes
- **THEN** two review panes exist, one comparing the index with `HEAD` and one comparing the work tree
  with the index

#### Scenario: An older server

- **WHEN** the server does not announce `previewTabs` and the user chooses `b.ts` under Changes
- **THEN** the continuous review of Changes opens scrolled to `b.ts`

### Requirement: The review shows the whole group as one list

A continuous review pane SHALL show every file of its group in one scrolling list, each file under a header with
its path, its status and its added and removed line counts. A file header SHALL collapse and expand that
file. Only the files near the visible part of the list SHALL be fetched and rendered, so a group of
hundreds of files opens as fast as a group of one. A single-file review (see "A single file can be reviewed in its
own tab") SHALL show only its one file, under the same header, and SHALL NOT list the group's other files.

#### Scenario: A large change set

- **WHEN** the group holds 400 changed files
- **THEN** the pane opens showing the first files, and diffs are fetched only for files that come near the
  visible part of the list

#### Scenario: Collapsing a file

- **WHEN** the user collapses a file's header
- **THEN** that file's lines are hidden and the next file's header follows directly

#### Scenario: A single-file review lists one file

- **WHEN** a single-file review of `src/a.ts` is open under Changes, a group of 53 files
- **THEN** only `src/a.ts`'s header and rows are drawn, and only `src/a.ts` is fetched

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
down arrows, and Reviewed or Unstage, all within thumb reach, and no terminal key. In a continuous review, next and
previous file SHALL scroll the list; in a single-file review they SHALL load the neighbouring file of the group in
the same tab (see "A single-file review moves through its group").

#### Scenario: Next change crosses a file

- **WHEN** the current change is the last one of a file and the user presses next change
- **THEN** the view moves to the first change of the next file

#### Scenario: The review bar on a phone

- **WHEN** a review is the active tab on mobile and the user taps the bar's down arrow
- **THEN** the view moves to the next file, the extra-keys bar is not shown, and no key is sent to any
  terminal

#### Scenario: The review bar in a single-file review

- **WHEN** a single-file review of the second of five files is the active tab on mobile and the user taps the bar's
  down arrow
- **THEN** the same tab shows the third file and no tab is created

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
the review showed and then move to the next file: a continuous review scrolls to it, a single-file review loads it
in the same tab. If the file changed on disk after it was shown, the
newer change SHALL stay under Changes rather than be staged unseen. A toast SHALL offer Undo for 6
seconds, and Undo SHALL put the file's index entry back exactly as it was, including a partially staged
version. Reviewed SHALL NOT pin a single-file review preview.

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

#### Scenario: Reviewed keeps a preview a preview

- **WHEN** a single-file review preview shows `a.ts` and the user taps Reviewed
- **THEN** the same tab, still a preview, shows the next file

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
and context, not by its number. If that line was deleted, the nearest surviving line takes its place. In a
continuous review a file that leaves the group SHALL be removed, and a file that joins it SHALL be added in path
order. A single-file review SHALL follow only its own file, and when that file leaves the group it SHALL show "No
longer changed" instead of being removed.

#### Scenario: Editing the file being read

- **WHEN** the user reads the middle of `a.ts` and a line near its end is edited on disk
- **THEN** the new hunk appears within 2 seconds and the lines in view do not move

#### Scenario: Lines inserted above the view

- **WHEN** the user reads line 100 of `a.ts` and ten lines are inserted at line 5
- **THEN** the same code stays in view, now numbered 110

#### Scenario: A file joins the group while a single-file review is open

- **WHEN** a single-file review of `a.ts` is visible and `z.ts` becomes changed
- **THEN** the review still shows only `a.ts`, and its position in the bar counts one more file

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

### Requirement: A single file can be reviewed in its own tab

A single-file review SHALL be a `review` tab whose url names the group, the project and one path. It SHALL show only
that file, with the continuous review's rows, comments, Reviewed or Unstage, and keybindings, and its current-file bar
SHALL show the file's position in the group as `n / N`, the format the bar already uses. One url SHALL have at most one tab, as for a continuous review.

#### Scenario: One file only

- **WHEN** the user chooses `src/a.ts` under Changes, a group of 53 files
- **THEN** the tab shows the diff of `src/a.ts` only, and its bar reads `src/a.ts` with `3/53`

#### Scenario: The same file twice

- **WHEN** `src/a.ts` under Changes is open as a pinned single-file review and the user chooses it again
- **THEN** that tab is shown and no second tab is created

### Requirement: A single-file review moves through its group

In a single-file review, next file and previous file, and Reviewed or Unstage moving on, SHALL load the neighbouring
file of the group in the same tab by changing its url, whether the tab is a preview or pinned. When Reviewed or Unstage
leaves no file after it, the tab SHALL show "No more files in `<group>`" with Open review. A file that leaves the group
by any other route SHALL show "No longer changed" with Open review. The tab SHALL NOT close by itself.

#### Scenario: Reviewed loads the next file

- **WHEN** a single-file review shows `a.ts`, the second of five files, and the user taps Reviewed
- **THEN** `a.ts` is staged and the same tab shows the third file

#### Scenario: Reviewed on the last file

- **WHEN** a single-file review shows the last file of Changes and the user taps Reviewed
- **THEN** the file is staged and the tab shows "No more files in Changes" and an Open review button

#### Scenario: Next file at the end

- **WHEN** a single-file review shows the last file of Changes and the user presses next file
- **THEN** the tab keeps the file and a toast reads "No more files in Changes"

#### Scenario: The file was committed elsewhere

- **WHEN** a single-file review shows `a.ts` and the user commits `a.ts` from a terminal
- **THEN** the tab shows "No longer changed" with Open review, and stays open

#### Scenario: Next change crosses into the next file

- **WHEN** the current change is the last one of the file and the user presses next change
- **THEN** the same tab shows the next file of the group at its first change

### Requirement: The current file's header stays on screen

On a desktop, the bar above the review's list SHALL act as the header of the file at the top of the view,
at every scroll position. It SHALL show that file's path, state, added and removed line counts, position in
the group ("n / N"), the same Reviewed (Changes) or Unstage (Staged) action as the file's own header, and
Open file. On a phone the bar SHALL stay a label with the path and position only, because the review bar
already carries Reviewed.

#### Scenario: Scrolling deep into a long file

- **WHEN** the user scrolls 400 lines into a long file under review on a desktop
- **THEN** the bar above the list names that file and offers Reviewed and Open file, while the file's own
  header has scrolled away

#### Scenario: The file at the top changes

- **WHEN** scrolling brings the next file's first line to the top of the view
- **THEN** the bar names that file, with its state, counts and position

#### Scenario: Reviewed from the bar

- **WHEN** the user taps Reviewed in the bar
- **THEN** the file is staged as if Reviewed were tapped on its own header, the 6-second Undo toast appears,
  and the review moves to the next file

#### Scenario: The phone keeps its label

- **WHEN** a review is shown on a 390x844 phone
- **THEN** the bar shows only the path and the position, at its current height, and the review bar keeps
  Reviewed

### Requirement: Both file headers share one write

The bar's Reviewed or Unstage and the file's own header SHALL use one write queue, so a write started from
either shows as running on both and cannot run twice. While the file's snapshot is not loaded, the bar's
Reviewed SHALL be disabled with the same reason the file's own header gives.

#### Scenario: One queue for both headers

- **WHEN** the user taps Reviewed in the bar while the file's own header is on screen
- **THEN** both buttons show the write as running, and a second tap on either does nothing until it ends

#### Scenario: The snapshot is not loaded yet

- **WHEN** the file at the top is still a placeholder
- **THEN** the bar's Reviewed is disabled and says the file is still loading
