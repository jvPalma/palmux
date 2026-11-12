# Proposal: Source Control row actions, live stage, discard with Undo, and a review header that stays

Source brief: `openspec/brainstorms/2026-11-02-v1-3-scm-cli-preview.md`, items 1 to 6 ("Change 1:
`scm-row-actions`"). Its owner decisions are kept here: discard asks first and offers Undo; a list action
stages what is on disk now; Reviewed keeps staging what you read.

## Why

The Source Control list can only open a review. To stage a folder, unstage a file or throw away a change,
you leave palmux for a terminal. On a desktop the list also takes more room than VS Code's for the same
tree. Inside a review, the file header with Reviewed and Open file scrolls away with the first lines of a
long file, so the one button you came for is off screen.

## What Changes

- **Denser rows on a desktop.** File rows, folder rows and group headers become 24px tall with an 8px indent
  per level (they are 28px and 12px today). The phone keeps its 24px rows and 8px indent.
- **Row actions.** Pointing at a row, or focusing it with the keyboard, shows icon buttons at its right edge.
  Right-click on a desktop and long-press on a phone open the same actions as a menu.

  | Group | File row | Folder row |
  |---|---|---|
  | Merge Changes | Open file | none |
  | Staged Changes | Open file, Unstage | Unstage all |
  | Changes | Open file, Stage, Discard | Stage all, Discard all |

  Discard always sits last, apart from the others, and is drawn as a destructive action.
- **Open file** opens the file in the focused pane's preview tab. This uses the entry point that the sibling
  change `preview-tabs` adds. Without preview support on the server, it opens a normal editor tab as today.
- **A list action stages what is on disk now.** Stage and Stage all run git's own `git add`, and Unstage and
  Unstage all run git's own `git restore --staged`. Line endings therefore behave as they do in a terminal.
  Paths that need a git filter (LFS and similar), a `working-tree-encoding` or `ident`, and unmerged files,
  submodules and nested repositories are skipped and named in the result. Reviewed in the review is
  unchanged: it still stages exactly the version you read.
- **Discard returns a file to its staged (index) version, or deletes it when it is untracked.** A confirm
  dialog names the files first. Before anything is written, the server keeps each file's current bytes in
  git's object store. A file that changed after you confirmed (an agent writing it) is skipped. Symbolic
  links, special files, submodules, converted files and files over 64 MiB are refused.
- **Discard has an Undo for 10 minutes.** The toast offers Undo for 6 seconds, and an "Undo last discard"
  button in the project bar keeps it for the rest of the 10 minutes. Undo puts the bytes back only if every
  file is still exactly as the discard left it; otherwise it changes nothing and says why. Undo does not
  survive a server restart, and the confirm says so.
- **Undo after a list action.** Stage, Unstage and their folder forms answer a receipt, and the same 6-second
  Undo toast the review uses takes them back.
- **The review's current-file bar becomes the file's header.** The bar above the list already names the file
  at the top and its position. On a desktop it now also shows the file's state, its line counts, Reviewed
  or Unstage, and Open file. It stays on screen however far you scroll. Reviewed is disabled, with its
  reason, until that file's snapshot is loaded. The header inside the list keeps its buttons. On a phone the
  bar stays a label, because the review bar already carries Reviewed.
- **Audit lines.** The server logs one line per batch stage, batch unstage, discard, Undo and refusal: the
  project, the counts, the receipt and the time it held the lock.
- **Compatibility.** The server announces the new writes in `ready`. A new client on an older server shows no
  row actions and no Undo last discard, and the review header behaves as today apart from the current-file
  bar.

## Capabilities

### New Capabilities

None. Discard and batch writes are Source Control behaviour, so they live in `source-control`.

### Modified Capabilities

- `source-control`:
  - MODIFIED, and renamed to "Git writes are index entries and confirmed discards": "The only git write is
    one file's index entry". The writes become index entries for the named paths and confirmed discards
    of work-tree files, each with an Undo.
  - MODIFIED: "Git access is confined and bounded" gains the batch limit, the 64 MiB discard limit and the
    link and special-file refusals.
  - REMOVED: "The changed-files list is compact on a phone". Its "The desktop is unchanged" scenario no
    longer holds, and a rename cannot drop a scenario.
  - ADDED: "The changed-files list is compact" (the phone's wording kept, the desktop added), "Rows offer
    actions on hover and in a menu", "Each group offers its own row actions", "Folders can be staged,
    unstaged and discarded as one action", "A discard is confirmed and fixed at the confirm", "A discard
    is backed up first and logged" and "A discard can be undone for ten minutes".
- `diff-review`: ADDED "The current file's header stays on screen" and "Both file headers share one
  write". "The review never edits or discards" stays true: the review pane does not discard. Only the
  Source Control list does.

## Impact

- **Objective, in plain words:** stage, unstage or throw away changes from the list itself, file by file
  or folder by folder, with a way back from a mistake, and keep Reviewed in reach while you read.
- **Today and its limits:** three writes exist, all to the index and all one file at a time (`scm-index.ts`).
  A list row only opens the review. The review's file header scrolls away. The living spec forbids
  touching the work tree.
- **Who it affects:** the owner on a desktop (dock) and on a phone (drawer, long-press menu). Agents that
  write into a project matter too: a discard must never destroy what an agent wrote after you confirmed.
- **Main risks:**
  - The first work-tree write palmux makes. Mitigations: the set of files is fixed when you confirm, a
    backup sits in git's object store before any write, Undo is a compare-and-swap, every discard is
    logged, and the confirm states that Undo is lost on a restart.
  - Lock time on a large folder. Mitigations: paths go to git over stdin in one command, a request carries
    at most 5,000 paths, and the log records how long the lock was held.
  - Backup objects nobody undoes stay in the object store until `git gc` prunes them (git's default is 2
    weeks). This is accepted.
- **How success is measured:**
  - Staging a 300-file folder is one action and one log line, and its Undo restores every entry.
  - A discard confirmed while an agent rewrites one of the files leaves that file untouched and names it.
  - Undo within 10 minutes restores the bytes exactly (same object id). Undo after the file changed again
    changes nothing.
  - On a 1440px desktop the same tree takes a sixth less height (24px rows instead of 28px), and Reviewed is
    on screen at every scroll position of a long file.
- **Code:**
  - server: `scm-index.ts` (batch stage and unstage, batched index reads and restores), new `scm-discard.ts`,
    `scm-snapshot.ts` (a byte limit option on the work-tree reader), `server.ts` (`/scm/stage-paths`,
    `/scm/unstage-paths`, `/scm/discard`, `/scm/restore` dispatch, `ready` flag).
  - shared: `scm.ts` (`ScmBatchResult`, `ScmSkip`), `protocol.ts` (`ready.scmBatchWrites`).
  - client: `scm/SourceControlView.tsx`, `scm/scm.css`, `scm/scm-api.ts`, new `scm/discard-log.ts`,
    `scm/row-actions.ts`, `ui/Collapsible.tsx` + `ui/ui.css` (a `sm` size), `review/ReviewPane.tsx`,
    `review/ReviewRow.tsx`, `review/review.css`, `review/write-log.ts`, `App.tsx`.
- **Dependencies:** `preview-tabs` supplies the preview open, through the contract in its `design.md`
  ("Contract for scm-row-actions and palmux-cli-commands"): `openFileTab(path, { preview: true })` opens
  the path in the focused pane's preview tab, or replaces that tab's file, and ignores `preview` on a
  server without preview support. Today `openFileTab` takes only a path (`App.tsx:2506`). The options
  argument is `preview-tabs`' addition, and this change only calls it. Both changes edit
  `SourceControlView.tsx`: `preview-tabs` adds a group-header button and keeps the row's click target,
  and this change adds the actions beside it.
  Git 2.26 or newer is needed for the batch writes (`--pathspec-from-file` on `restore`). An older git
  answers 501 for those routes and leaves the existing writes working.
- **Restart:** the new routes need a server restart. Under systemd a restart ends every live terminal and
  needs the owner's OK at the time. Any restart drops the pending Undos.
- **Review gates not run:** the project rule asks for an `opsx-zoom-out` review of this proposal. This change
  was written by a forked agent that may not spawn agents, so that review was not run. Run it before
  implementation (for example with `/opsx:refine`).

## Scope

- **In:** brief items 1 to 6, on desktop and phone.
- **Out of scope:**
  - Per-hunk or per-line stage and discard.
  - Committing from palmux.
  - An Undo that survives a restart.
  - Preview tabs themselves (`preview-tabs`) and the CLI (`palmux-cli-commands`).
- **Non-goals:**
  - A git client (branches, commits, push).
  - Running git filters or hooks in a palmux write.
  - Changing Reviewed's "stage what you read" rule.
