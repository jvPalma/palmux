# Proposal

## Why

You review the changes in a project, often your own or an agent's, from a phone, and palmux has no way to show
them. Today that means `git diff` in a terminal on a 390px screen, or lazygit, neither of which can hold a
review comment. A Source Control view, the way VS Code shows one, gives you the changed files of a chosen
project, a readable diff with the theme you already picked, and line comments you can hand back to whoever
made the change.

## What Changes

- **A Source Control view.** A new dock view on desktop (a rail entry) and a new drawer view on mobile.
  It never opens on a default repository. It shows nothing until you add a project path.
- **A project list with one active project.** A selector at the top of the view holds every project you
  added. You can add, remove and switch projects. Only the selected project is shown and kept live.
  A path is accepted only if `git` confirms it is inside a work tree.
- **Changes, as VS Code groups them.** Two groups for the active project: *Staged Changes* (index vs
  `HEAD`) and *Changes* (work tree vs index, untracked files included). Each file shows its status
  (modified, added, deleted, renamed, untracked).
- **Live while open, idle while not.** While the view is visible and the window is in the foreground, a
  change on disk in the active project appears within 2 seconds. A hidden view, a background window and
  every inactive project cost nothing. palmux adds no recursive file watcher, and the status read never
  takes git's index lock, so it cannot get in the way of your own git, lazygit or an editor.
- **A review pane.** Choosing a file opens a review of its whole group in the content area, not in the
  300px dock, scrolled to that file, so several files are read and staged in one pass. It offers
  side-by-side and unified layouts, a choice of git's diff algorithms (myers, minimal, patience,
  histogram), syntax colouring from the grammars the editor already ships, and the palmux theme in use.
  It never edits a file.
- **Built for review on a phone.** The diff pane has controls to step to the next and previous change and
  the next and previous file, and a way back to the file list, each reachable by thumb. A narrow pane uses
  the unified layout.
- **Line comments, like a pull request review.** You can attach a comment to a line or a range of lines
  on either side of a diff, then edit or delete it. Comments are stored per project under
  `~/.config/palmux/.cache/`, never inside the repository, and stay attached to their lines when the file
  changes around them. You can copy every comment in a project as one markdown document.
- **A virtualized scroll surface.** The kit gains a scroll area and a windowed list, the palmux
  equivalent of the design system's `ScrollArea` with `react-window`. The file list and the diff rows use
  them, so a project with thousands of changed lines stays fast.
- **Review and stage.** Reviewed stages exactly the version you saw and moves to the next file; Staged
  offers Unstage; both have a 6-second Undo that restores the index entry exactly. On a phone, a review
  bar replaces the extra-keys bar while a review is open: file list, previous and next file, Reviewed or
  Unstage, and the same swipes (right to left opens the drawer, left to right goes back to the terminal).
- **Non-goals.** No committing, discarding, branch switching or any git write other than staging and
  unstaging one file. No branch-to-branch or commit-range comparison in this change. No editing inside
  the diff.

## Capabilities

### New Capabilities

- `source-control`: the project list, the active project, the server's read-only git status and file
  content endpoints, and the live refresh rules.
- `diff-review`: the diff pane, its layouts, the diff algorithm choice, syntax colouring and theme, and
  file and change navigation on desktop and mobile.
- `review-comments`: line and range comments on a diff, their storage outside the repository, how they
  stay anchored, and the markdown export.

### Modified Capabilities

- `sidebar-dock`: the rail order requirement gains a Source Control entry, and the dock's view list
  gains the view.
- `mobile-drawer`: the drawer's view switcher gains Source Control.
- `ui-primitives`: the kit gains a scroll area and a virtualized list built on the theme tokens.
- `editor-pane`: the editor's font size follows a per-device code font size, independent of the terminal font
  size once set (the review uses the same setting).

## Impact

- **Server.** A new module runs `git` with argument arrays (never a shell) and `--no-optional-locks`. It
  adds read-only routes for status and for one file's snapshot (both sides read once, by object id and
  one work tree read, with git's hunks between them), plus routes for reading and writing comments. The
  settings write becomes a merge, so an older window can no longer erase keys it does not know. Every route takes an absolute project path under the same cookie trust
  model as `/files/list`. New server routes need one restart of the palmux service, which ends open
  terminals; tmux sessions survive it.
- **Config dir.** `~/.config/palmux/.cache/` is new and per-machine. It carries its own `.gitignore`
  holding `*`, so a dotfiles-tracked config dir ignores it without editing the user's root `.gitignore`.
- **Settings.** The project list is a synced setting, like `explorerPins`, because the paths are on the
  server. The selected project, the layout and the algorithm choice are per device.
- **Client.** A new dock and drawer view, a new pane for the diff, a rail entry and a drawer segment.
  Syntax colouring reuses the lazy Monaco chunk and the `palmux` theme, so a session that never opens a
  diff downloads none of it.
- **Dependencies.** `react-window` 2.x and `@radix-ui/react-scroll-area`. No Tailwind: the design
  system's component is restyled on the eight `--t-*` tokens and the scale.
- **Tests.** New server tests for the git module and the routes, using a temporary repository. Kit tests
  for the scroll primitives, and the existing scale, heading and colour-literal guards apply to the new
  stylesheets.
