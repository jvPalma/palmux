## RENAMED Requirements

- FROM: `### Requirement: The only git write is one file's index entry`
- TO: `### Requirement: Git writes are index entries and confirmed discards`

## MODIFIED Requirements

### Requirement: Git writes are index entries and confirmed discards

The server SHALL expose the status and one file's snapshot of a project, and exactly these writes, each on
an explicit request:

- staging one file as the snapshot the review showed;
- staging a list of paths as they are on disk now;
- unstaging one file or a list of paths;
- discarding a list of work-tree changes the user confirmed;
- undoing one of palmux's own writes above.

Stage and unstage SHALL change only index entries of the paths they name. A discard SHALL change only the
work-tree files it names: a tracked file returns to its index version and an untracked file is deleted.
A discard SHALL NOT change the index. Undo SHALL only reinstate what palmux itself recorded. The server
SHALL NOT commit, check out a branch, stash, reset, run a git filter or hook, or write anything else.
Every request SHALL take an absolute project path under the same cookie trust model as the file listing.

#### Scenario: The write surface

- **WHEN** the server's routes are listed
- **THEN** only stage, stage paths, unstage, unstage paths, discard and undo change a repository; stage and
  unstage change only the index entries of the paths named, and a discard changes only the work-tree files
  named and nothing in the index

#### Scenario: The index is busy

- **WHEN** the user stages a file or a folder while another program holds `index.lock`
- **THEN** nothing waits, nothing is staged, and the view or the review says the repository is busy and to
  try again

#### Scenario: A list stage takes the file as it is on disk

- **WHEN** the user chooses Stage on a file row after editing the file again since the list was read
- **THEN** the index holds the file's current content with the line-ending conversion git applies in a
  terminal, and Undo returns the index entry to what it was before

#### Scenario: A file that needs a git filter is skipped

- **WHEN** the user stages a folder holding a file whose attributes name a `filter`, a
  `working-tree-encoding` or `ident`
- **THEN** that file is not staged and is named as skipped with its reason, no filter runs, and the other
  files are staged

#### Scenario: Unmerged files, submodules and nested repositories are skipped

- **WHEN** a folder action covers an unmerged file, a submodule or a nested repository
- **THEN** each is named as skipped with its reason and the rest of the folder is processed

#### Scenario: Reviewed still stages what was read

- **WHEN** the user taps Reviewed in a review after the file changed on disk
- **THEN** the review's existing rule applies: the shown version is staged or the change is refused, and no
  live `git add` runs

#### Scenario: A discard keeps staged changes

- **WHEN** a file has a staged change and a further unstaged change, and the user discards it from Changes
- **THEN** the work tree returns to the staged version and the staged change stays in the index

### Requirement: Git access is confined and bounded

A file path outside the project SHALL be refused, including through a symbolic link anywhere on its
path, and a file name SHALL always be taken literally, never as a pattern. Each git command SHALL have a
time limit and an output limit, and a response cut by a limit SHALL say so. A batch request SHALL carry at
most 5,000 paths, and a discard SHALL refuse a file larger than 64 MiB.

#### Scenario: A file name with pattern characters

- **WHEN** the project holds `a*.ts` and `alpha.ts`, both changed, and the user opens, stages or discards
  `a*.ts`
- **THEN** only `a*.ts` is shown, staged or discarded

#### Scenario: A folder swapped for a link

- **WHEN** an untracked folder is replaced by a symbolic link to a directory outside the project
- **THEN** reading, discarding or restoring a file under it is refused and nothing outside the project is
  read or written

#### Scenario: A path that escapes the project

- **WHEN** a request asks for the content of `../other/secret` in a project, or names it in a batch
- **THEN** the server refuses the whole request and reads or writes nothing

#### Scenario: A huge status

- **WHEN** the work tree has more untracked files than the status limit
- **THEN** the view lists files up to the limit and states that the list was truncated

#### Scenario: A batch over the limit

- **WHEN** a stage, unstage or discard request names more than 5,000 paths
- **THEN** the server refuses it with a 400 and changes nothing

#### Scenario: A large file is not discarded

- **WHEN** a discard includes a file larger than 64 MiB
- **THEN** the whole discard is refused before anything is written, and the answer names the file

#### Scenario: A link or special file is not discarded

- **WHEN** a discard includes a symbolic link, a socket, a FIFO or a device, or a submodule
- **THEN** that entry is skipped and named with its reason, and nothing is written through it

## REMOVED Requirements

### Requirement: The changed-files list is compact on a phone

**Reason**: Its "The desktop is unchanged" scenario no longer holds: the desktop gets the same compact rows.
**Migration**: Replaced by the ADDED requirement "The changed-files list is compact", which keeps the phone's
24px rows, 12px text and 8px indent word for word and adds the desktop.

## ADDED Requirements

### Requirement: The changed-files list is compact

Source Control's rows (folders, files and group headers) SHALL be compact on every device: 24px tall, with no
space between one row and the next, and an 8px indent per level. A file or folder row's text is the body size
(12px, `--fs-2`); a group header keeps the section-title type (11px, `--fs-1`) every Collapsible wears. On a
phone this is the owner's 2026-10-26 density. On a desktop it replaces the control height and the 12px
indent, so a tree reads at VS Code's density.

#### Scenario: A deep tree on a phone

- **WHEN** the Changes group shows `packages/client/src/review/` expanded on a 390x844 phone
- **THEN** every row, group headers included, is 24px tall and the next row starts where the one above ends,
  file and folder text is 12px (the body size, `--fs-2`), group headers are 11px (`--fs-1`), each level indents
  by 8px, and file names are not truncated by the indent

#### Scenario: A deep tree on a desktop

- **WHEN** the same tree is shown in the dock on a 1440px desktop
- **THEN** every row, group headers included, is 24px tall, the next row starts where the one above ends,
  file and folder text is 12px, group headers are 11px and each level indents by 8px


### Requirement: Rows offer actions on hover and in a menu

On a desktop, a file or folder row SHALL show its actions as icon buttons at its right edge while the
pointer is over the row or focus is inside it. Right-click, and a long press on a phone, SHALL open the
same actions as a menu. Activating an action SHALL NOT also open the row's review. Each action SHALL have
an accessible name, and an action that cannot run SHALL be disabled with its reason as its tooltip. No
action SHALL be offered when the server does not announce support for them.

#### Scenario: Hovering a changed file

- **WHEN** the pointer rests on a modified file under Changes on a desktop
- **THEN** its actions appear at the row's right edge, and the row's name is truncated before it reaches
  them

#### Scenario: Keyboard focus shows the actions

- **WHEN** the user moves keyboard focus onto a row
- **THEN** its actions show, Tab reaches each of them, and Enter or Space on one runs it without opening the
  review

#### Scenario: Long-press on a phone

- **WHEN** the user long-presses a staged file row in the drawer
- **THEN** a menu offers that row's actions, the release does not open the review, and a swipe that starts
  on the row still scrolls the list

#### Scenario: An older server

- **WHEN** the server's `ready` does not announce batch writes
- **THEN** no row shows actions and no row offers a menu

### Requirement: Each group offers its own row actions

A row's actions SHALL depend on its group. Merge Changes SHALL offer Open file on a file. Staged Changes
SHALL offer Open file and Unstage on a file, and Unstage all on a folder. Changes SHALL offer Open file,
Stage and Discard on a file, and Stage all and Discard all on a folder. Discard SHALL be the last action,
set apart from the others and marked as destructive. Open file SHALL open the file in the focused pane's
preview tab and SHALL be unavailable for a file deleted in the work tree.

#### Scenario: The actions of a changed file

- **WHEN** a modified file under Changes shows its actions
- **THEN** they are Open file, Stage and Discard, with Discard last and apart

#### Scenario: The actions of a staged folder

- **WHEN** a folder under Staged Changes shows its actions
- **THEN** the only action is Unstage all

#### Scenario: A conflicted file

- **WHEN** a file under Merge Changes shows its actions
- **THEN** the only action is Open file

#### Scenario: Open file opens a preview

- **WHEN** the user chooses Open file on a row
- **THEN** the file opens in the focused pane's preview tab, replacing the file that tab showed

#### Scenario: A deleted file cannot be opened

- **WHEN** a row shows a file deleted in the work tree
- **THEN** its Open file action is disabled and says the file is deleted

### Requirement: Folders can be staged, unstaged and discarded as one action

A folder action SHALL apply to every file the list shows under that folder in that group, as one request,
and SHALL report which files were done and which were skipped, with each skip's reason. A folder action
SHALL be unavailable while the status is truncated, because the list does not hold every file under the
folder. Stage, Unstage and their folder forms SHALL offer Undo for 6 seconds in the toast, the same Undo
window as Reviewed.

#### Scenario: Staging a folder

- **WHEN** the user chooses Stage all on `packages/server` under Changes, which shows 40 files
- **THEN** all 40 are staged in one request, the toast says "Staged 40 files" with Undo, and Undo returns
  every one of their index entries

#### Scenario: Skips are reported

- **WHEN** a folder stage skips two files
- **THEN** the toast names how many were staged and how many were skipped, and the skipped files stay under
  Changes

#### Scenario: A truncated list

- **WHEN** the status is truncated at its limit
- **THEN** every folder action is disabled and says the list is truncated; file actions still work

### Requirement: A discard is confirmed and fixed at the confirm

A discard SHALL ask before it writes. The confirm SHALL name up to ten files and count the rest, SHALL say
that untracked files are deleted, and SHALL say that Undo lasts 10 minutes and is lost on a server restart.
The client SHALL send each confirmed file with the fingerprint the list showed, and the server SHALL skip
any file whose fingerprint changed since, naming it as changed.

#### Scenario: Confirming a discard

- **WHEN** the user chooses Discard on a modified file
- **THEN** a confirm names the file and the Undo limits, and Cancel changes nothing

#### Scenario: An agent writes after the confirm

- **WHEN** a file changes on disk between the list's last read and the user's confirm
- **THEN** that file is not discarded, the result names it as changed since you confirmed, and the other
  confirmed files are discarded

### Requirement: A discard is backed up first and logged

Before it writes any file, the server SHALL keep every file's current bytes and mode in the repository's
object store. Deleting an untracked file SHALL also remove each folder it leaves empty, up to the project's
top. The server SHALL log one line per discard, per Undo and per refused write, naming the project, the
counts, the receipt and the time taken.

#### Scenario: Discarding an untracked folder

- **WHEN** the user discards an untracked folder `tmp/out` holding three untracked files
- **THEN** the three files are deleted, `tmp/out` and an emptied `tmp` are removed, and a folder that still
  holds an ignored file stays

#### Scenario: The backup exists before the write

- **WHEN** writing a discarded file fails half way through a discard
- **THEN** every file the discard had already changed can still be restored by Undo

#### Scenario: Every discard is logged

- **WHEN** a discard runs
- **THEN** the server log has one line with the project, how many files were discarded and skipped, the
  receipt and the time taken

### Requirement: A discard can be undone for ten minutes

A discard that changed a file SHALL answer a receipt kept for 10 minutes in a store that review snapshots
and index receipts cannot push out. Undo SHALL restore every file, with its mode and missing parent folders,
only if every file is still as the discard left it, and otherwise change nothing. Undo SHALL be offered in
the toast, then by "Undo last discard" in the project bar for this device's latest discard in the project.

#### Scenario: Undo from the toast

- **WHEN** the user taps Undo within 6 seconds of a discard
- **THEN** every discarded file has its exact bytes and mode back, and deleted untracked files exist again

#### Scenario: Undo later from the project bar

- **WHEN** the user taps Undo last discard eight minutes after a discard
- **THEN** the files come back as with the toast's Undo, and the button disappears

#### Scenario: The files changed since

- **WHEN** an agent recreates a discarded untracked file before the user taps Undo
- **THEN** Undo restores nothing, says the files changed since the discard, and the receipt stays usable
  once the conflict is gone

#### Scenario: The receipt is gone

- **WHEN** the user taps Undo last discard after 10 minutes or after a server restart
- **THEN** the view says the Undo has expired, restores nothing, and the button disappears

#### Scenario: A receipt is used once

- **WHEN** an Undo has restored a discard
- **THEN** a second Undo with the same receipt says it has expired and changes nothing
