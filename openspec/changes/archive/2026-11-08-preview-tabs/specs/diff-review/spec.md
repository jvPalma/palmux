## MODIFIED Requirements

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

## ADDED Requirements

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
