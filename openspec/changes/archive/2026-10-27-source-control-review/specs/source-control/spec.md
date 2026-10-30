# Spec Delta

## Purpose

Shows the uncommitted changes of a project the user chose, grouped the way VS Code's Source Control view
groups them, and keeps that list current while it is on screen without watching the file system.

## ADDED Requirements

### Requirement: The view starts with no project

The Source Control view SHALL show no repository until the user adds a project path. It MUST NOT infer
a project from the server's working directory, the user's home, a terminal's cwd or any open file. With
no project added, the view SHALL show an empty state that offers to add one.

#### Scenario: First open

- **WHEN** the user opens Source Control on a palmux that has no project added
- **THEN** the view shows an empty state with an Add project control and runs no git command

### Requirement: A project is accepted only inside a git work tree

Adding a project SHALL take an absolute path. palmux SHALL ask git whether the path is inside a work
tree and, if it is, store the work tree's top-level directory in its canonical form. A relative path, a
path that does not exist, or a path outside any work tree SHALL be refused with a message that names
the reason, and nothing is stored.

#### Scenario: A subfolder is added

- **WHEN** the user adds `/home/u/work/app/src` and `/home/u/work/app` is the work tree's top level
- **THEN** the project list gains `/home/u/work/app`

#### Scenario: A plain folder is refused

- **WHEN** the user adds a directory that is not inside a git work tree
- **THEN** the view shows that the path is not a git repository and the project list is unchanged

#### Scenario: The same project twice

- **WHEN** the user adds a path whose top level is already in the list
- **THEN** the list is unchanged and that project becomes the active one

### Requirement: The project list is shared and the selection is per device

The list of projects SHALL be a synced setting, the same on every device connected to one palmux,
because the paths are on the server. Which project is active SHALL be stored per device. A selector at
the top of the view SHALL list every project, switch the active one, and remove a project from the list.
Removing a project SHALL NOT touch the repository on disk.

#### Scenario: Two devices, one list, two selections

- **WHEN** a desktop has project A active and a phone switches to project B
- **THEN** both devices list A and B, the desktop still shows A, and the phone shows B

#### Scenario: Removing the active project

- **WHEN** the user removes the active project
- **THEN** the next project in the list becomes active, or the empty state shows when none is left

### Requirement: The project list survives a save from an older window

A settings save that does not carry the project list, as an older client's save does not, SHALL leave the
stored list unchanged. Only a save that carries the list, including an explicitly empty one, SHALL
replace it.

#### Scenario: An older window saves a font change

- **WHEN** a window running a bundle from before this feature saves a font change
- **THEN** the stored project list is unchanged and every new window still lists the projects

### Requirement: Only the active project is read

palmux SHALL read only the device's active project. Showing or focusing a review pane SHALL make its
project the active one on that device. A review pane of a project that is not active, such as the
unfocused half of a split, SHALL pause and say so, offering to make its project active. A review of a
project removed from the list SHALL stop reading and say the project was removed.

#### Scenario: Switching project with a review open

- **WHEN** a review of project A is visible and the user selects project B in the dock
- **THEN** only B is read, and A's review shows that it is paused with a control to make A active

#### Scenario: Focusing a review switches the project

- **WHEN** the user focuses a review tab of project A while B is active
- **THEN** A becomes the active project on this device and the dock lists A's changes

### Requirement: Unmerged files are listed, not hidden

During a merge or rebase with conflicts, the view SHALL list unmerged files in a Merge Changes group
above the others, marked as conflicted. Choosing one SHALL show a read-only notice that the file has
conflicts, with Open file, and no diff.

#### Scenario: A conflicted file

- **WHEN** a merge leaves `a.ts` with conflicts
- **THEN** `a.ts` appears under Merge Changes marked conflicted, and no error is shown

### Requirement: Changes are grouped as Staged Changes and Changes

For the active project the view SHALL list two groups: Staged Changes (the index compared with `HEAD`)
and Changes (the work tree compared with the index, untracked files included as individual files). Each
entry SHALL show the file name, its directory, and a status of modified, added, deleted, renamed (with
the old path) or untracked. A file changed in both places SHALL appear in both groups. Files git ignores
SHALL NOT appear.

#### Scenario: A file edited after staging

- **WHEN** `a.ts` is staged and then edited again
- **THEN** `a.ts` appears in Staged Changes and in Changes

#### Scenario: An untracked folder

- **WHEN** a new untracked folder holds three files
- **THEN** Changes lists the three files, each marked untracked

#### Scenario: A repository with no commits

- **WHEN** the active project has no `HEAD` yet
- **THEN** staged files are listed as added and no error is shown

### Requirement: The list stays live while it is visible

While the Source Control view or a review pane of the active project is visible and the window is in the
foreground, a change on disk in the active project SHALL appear in the view within 2 seconds whenever
reading its status takes under 300 ms; a slower project refreshes less often (see below). When
neither is visible, or the window is in the background, palmux SHALL run no git command for that
window. Inactive projects SHALL never be read.

#### Scenario: An edit appears

- **WHEN** the view is open and a file in the active project is saved by another program
- **THEN** the file appears under Changes within 2 seconds

#### Scenario: A hidden view costs nothing

- **WHEN** the user switches the dock to Explorer and leaves the window open for an hour
- **THEN** the server runs no git command for that window during the hour

#### Scenario: The window returns

- **WHEN** a background window comes back to the foreground with the view visible
- **THEN** the list refreshes at once rather than waiting for the next interval

### Requirement: Reading status never interferes with the user's git

palmux SHALL read status without taking git's index lock and without writing to the repository, so that
a commit, rebase, lazygit or an editor running at the same moment never fails because of palmux. palmux
SHALL NOT add a recursive file-system watcher for a project. A slow repository SHALL make palmux read
less often rather than pile up reads.

#### Scenario: A commit during a refresh

- **WHEN** the user runs `git commit` in a terminal while the view is refreshing
- **THEN** the commit does not fail with an `index.lock` error

#### Scenario: A slow repository

- **WHEN** reading status takes 900 ms in the active project
- **THEN** palmux starts no new read while one is running and waits longer between reads

### Requirement: The only git write is one file's index entry

The server SHALL expose the status and one file's snapshot of a project, and exactly three writes:
staging one file, unstaging one file, and undoing one of palmux's own stage or unstage writes, each on an
explicit request. Undo SHALL only reinstate entries palmux itself recorded. It SHALL NOT commit,
discard, check out, stash, reset the work tree or write anything else. Every request SHALL take an
absolute project path under the same cookie trust model as the file listing.

#### Scenario: The write surface

- **WHEN** the server's routes are listed
- **THEN** only stage, unstage and undo change a repository, and each changes only index entries (the one
  file named, or the entries a recorded write changed) and nothing in the work tree

#### Scenario: The index is busy

- **WHEN** the user stages a file while another program holds `index.lock`
- **THEN** nothing waits, nothing is staged, and the review says the repository is busy and to try again

### Requirement: Git access is confined and bounded

A file path outside the project SHALL be refused, including through a symbolic link anywhere on its
path, and a file name SHALL always be taken literally, never as a pattern. Each git command SHALL have a
time limit and an output limit, and a response cut by a limit SHALL say so.

#### Scenario: A file name with pattern characters

- **WHEN** the project holds `a*.ts` and `alpha.ts`, both changed, and the user opens `a*.ts`
- **THEN** the diff shows only `a*.ts`

#### Scenario: A folder swapped for a link

- **WHEN** an untracked folder is replaced by a symbolic link to a directory outside the project
- **THEN** reading a file under it is refused and nothing outside the project is read

#### Scenario: A path that escapes the project

- **WHEN** a request asks for the content of `../other/secret` in a project
- **THEN** the server refuses it and reads nothing

#### Scenario: A huge status

- **WHEN** the work tree has more untracked files than the status limit
- **THEN** the view lists files up to the limit and states that the list was truncated

### Requirement: Changed files can be browsed as a tree

Each group SHALL be shown as a folder tree by default, with a per-device control to switch to a flat list.
Folders SHALL collapse and expand, and a chain of folders holding a single folder SHALL show as one row.
Which folders are collapsed SHALL be remembered per device, per project and per group. The tree SHALL list
files in the same order as the review, so moving to the next file in a review follows the tree.

#### Scenario: Collapsing a folder

- **WHEN** the user collapses `packages/server` under Changes
- **THEN** the files under it are hidden, the folder row stays with its file count, and the choice survives a
  reload on this device

#### Scenario: A deep single-folder chain

- **WHEN** the only changes are under `packages/client/src/review/`
- **THEN** the tree shows one folder row named `packages/client/src/review` above its files

#### Scenario: Switching to a flat list

- **WHEN** the user switches the view to a list
- **THEN** every file shows as one row with its directory, as before, and the choice persists on this device

### Requirement: The changed-files list is compact on a phone

On a phone, Source Control's rows (folders, files and group headers) SHALL be compact (owner, 2026-10-26,
twice): 24px tall, with no space between one row and the next, text at the body size (12px, `--fs-2`) and an
8px indent per level, so a deep tree stays readable on a 390px screen.

#### Scenario: A deep tree on a phone

- **WHEN** the Changes group shows `packages/client/src/review/` expanded on a 390x844 phone
- **THEN** every row, group headers included, is 24px tall and the next row starts where the one above ends,
  text is 12px (the body size, `--fs-2`), each level indents by 8px, and file names are not truncated by the indent

#### Scenario: The desktop is unchanged

- **WHEN** the same tree is shown on a desktop
- **THEN** rows keep the control height and the 12px indent
