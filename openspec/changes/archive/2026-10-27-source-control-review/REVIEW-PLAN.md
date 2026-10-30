# Plan under review: OpenSpec change source-control-review (palmux)

Host: Claude Code (planner, opus-5-5). Reviewer: Codex gpt-6-astra xhigh. Builder later: Sonnet 5.5 xhigh; fixes Opus 5.5 xhigh; inspection fresh Codex.
Scope of this review: the plan only (no code exists yet). The repo is /home/user/projects/palmux; read CLAUDE.md and any source file to check claims. Owner decisions already made (do not relitigate without new evidence): renderer = own virtualized rows + Monaco colorize (NOT Monaco DiffEditor); git computes hunks server-side with a selectable algorithm; comments live in ~/.config/palmux/.cache/; v1 compares worktree/index vs HEAD only; live refresh <2s while visible, no fs watchers; git writes limited to stage/unstage of one file on explicit tap (owner decision 2026-10-25, after round 2: "Reviewed" = stage + next file, Unstage in Staged, exact Undo; the local Viewed mark is dropped). On mobile a review bar replaces the extra-keys bar while a review is active (no terminal keys; ↑/↓ = prev/next file; swipes kept: right→left drawer, left→right back to the previous tab).
Verification for the build: yarn typecheck, yarn test, yarn lint; isolated smoke server on :44099; S26 device check.


---
## FILE: proposal.md

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

---
## FILE: design.md

# Design

## Context

See proposal.md for why and the specs for the required behaviour. What shapes the approach:

- **The server already has the trust model and the shape.** `/files/list`, `/download` and `/file` take
  absolute paths behind the cookie, answer JSON errors, never trim a path and check `isAbsolute` on the raw
  input. New routes follow the same rules (see CLAUDE.md "The path is used exactly as given").
- **Monaco is already a lazy chunk with 23 grammars and a `palmux` theme.** `panes/markdown-code.ts`
  already colours text with `monaco.editor.colorize()` and `languageOf()` from `editor-language.ts`. One
  colour source for the editor, the markdown viewer and now the diff.
- **Non-terminal panes stay mounted.** `PaneHost` positions every non-terminal tab by rect and hides the
  rest with `display:none`, and knows which panes are `shown`. A review pane therefore has a reliable
  "visible" signal and must cost nothing while hidden.
- **Measured on this host:** `git status --porcelain=v2 -z` over palmux's 1,685 tracked files takes about
  10 ms.
- **The design system's equivalent** (`~/dgsl/design/ds`, `ScrollArea` + `ActionList`) is Radix
  ScrollArea for bounded content and react-window 2.3.3 for long lists. Its own note says react-window is
  its own scroll container, so the ScrollArea cannot wrap it; the list wears a thin native scrollbar
  instead. palmux copies that split. The DS is Tailwind-styled, so its code is not imported, only its
  structure.
- **No Tailwind, eight tokens, one size scale, four motion tiers,** enforced by `ui.test.tsx`,
  `scale.test.ts` and `headings.test.ts`. Every new stylesheet meets them.

## Goals / Non-Goals

**Goals:**
- Status refresh under 2 s with zero work when nothing is visible, and no fs watchers.
- A review of hundreds of files and tens of thousands of lines that scrolls at frame rate on the S26.
- One renderer for side-by-side and unified, built from git's hunks.

**Non-Goals:**
- Monaco's `DiffEditor` (owner decision 2026-10-25, renderer (a)): it diffs in the browser with its own
  two algorithms, is weak on touch, and puts comments in view zones.
- Word-level diffs computed by git (`--word-diff`); inner marks are computed client-side between paired
  lines (cheap, bounded).
- Branch or commit-range comparison, blame, history, and any git write other than one file's index
  entry (D10): no commit, discard, checkout, stash or work tree change.
- A web worker for colouring; deferred until a measurement shows main-thread colouring janks (see Risks).

## Decisions

### D1. Server module `server/scm.ts` runs git with argv arrays

`execFile('git', ['-C', top, '--no-optional-locks', '--literal-pathspecs', '-c', 'core.quotepath=false',
...])` with an env built from a **clean base**, not inherited: `PATH`, `HOME`, `XDG_CONFIG_HOME` (git's global
config and default attributes file live under it; F5-03), `TMPDIR`, `LC_ALL=C`,
`GIT_OPTIONAL_LOCKS=0`, `GIT_LITERAL_PATHSPECS=1`, `GIT_TERMINAL_PROMPT=0`, and nothing else from the
service's `GIT_*` (`GIT_DIFF_OPTS` overrides `-U`, and `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE`,
`GIT_CONFIG_PARAMETERS` would redirect or reshape a command; F4-03). A 10 s timeout and a `maxBuffer`.
Exit status is interpreted per command: `diff --no-index` exits 1 whenever the sides differ, which is
success. Never a shell. `--no-optional-locks` is what keeps `git status` from
refreshing the index under its lock, which is the "never interferes" requirement; literal pathspecs make
`a*.ts` or `:(glob)x` a file name and never a pattern (SCM-01). Diffs add `--no-ext-diff --no-textconv
--no-color`. *Alternative:* `isomorphic-git` / libgit2 bindings. Rejected: a new dependency (and a native
one), slower than git on status, and no `--diff-algorithm` parity.

### D2. Routes

| Route | Does |
|---|---|
| `GET /scm/repo?path=` | `rev-parse --show-toplevel`; answers the canonical top or a 400 naming why |
| `GET /scm/status?repo=` | `status --porcelain=v2 -z --untracked-files=all --branch`; parsed into `merge[]`, `staged[]` and `changes[]`, with line counts from `diff --numstat -z` and `diff --cached --numstat -z` (binary as `-`; untracked files are "new" with no count; a rename is the record `added\tremoved\t\0<old>\0<new>\0` with an empty path field, F5-02), plus `commentsRev` and `attrEpoch` |
| `GET /scm/file?repo=&group=&path=&oldPath=&algorithm=` | one **snapshot** of a file pair: both sides' text, their identities, and git's hunks between them (below) |
| `GET/POST/PATCH/DELETE /scm/comments?repo=` | comment CRUD (D9) |
| `POST /scm/stage?repo=` / `POST /scm/unstage?repo=` | the only writes: one file's index entry (D10) |

**The file route reads each side once and diffs what it read** (SCM-01, 03, 04, 06, 09). The side
identities are resolved by the server at request time, never taken from the client: `ls-tree -z HEAD`
and `ls-files -s -z` (literal pathspecs) give the HEAD and index oids and modes. A staged pair is (HEAD
oid at `oldPath ?? path`, index oid at `path`), an unstaged pair is (index oid, work tree), an untracked
file is (nothing, work tree), and a rename carries both paths. An **unborn HEAD** (`rev-parse --verify
-q HEAD` fails) is never handed to `ls-tree`: the old side is absent, `{ id: 'absent', text: '' }`, the
same shape every addition's old side and every deletion's new side uses (SCM-R2-04). Blobs are read by **object id** with `cat-file blob <oid>`, which is immutable, never with
`show :path` (a file literally named `2:config.ts` would select merge stage 2; SCM-02). The work tree side
is read once by the server itself through a **descriptor-relative walk** (SCM-04, SCM-R2-01,
SCM-R3-08). Node has no `openat`/`readlinkat`, but on Linux `/proc/self/fd/<dirfd>/<name>` resolves
`<name>` inside the directory the descriptor already holds, never by re-walking a path, which is what
`openat(dirfd, name)` does. So: open `top` with `O_DIRECTORY`; for each intermediate component open
`/proc/self/fd/<cur>/<comp>` with `O_DIRECTORY | O_NOFOLLOW` (a symlink there fails, and the read is
refused); open the final component the same way with `O_RDONLY | O_NOFOLLOW` and `fstat` it as a regular
file; when that open fails with `ELOOP` the final component is a symlink, and its target text comes from
`readlink('/proc/self/fd/<parentfd>/<name>')`, still relative to the validated parent, never from the
original pathname. Reads go through the descriptor up to the size limit. A directory swapped for a link
at any moment can only make an open fail; it can never redirect one. **Hosts without `/proc` fail
closed**: the work tree side of a snapshot is refused with a notice ("this server cannot read the work tree
safely"), so unstaged and untracked diffs are unavailable there; staged diffs, which read blobs only, still
work. palmux's own host is Linux. A test hook swaps a directory for a link between two steps of the walk,
deterministically, in both the regular-file and the symlink branch. **Git attributes are resolved for the original path** (SCM-R2-03): `git check-attr -z text eol crlf
diff binary filter working-tree-encoding ident -- <path>` plus `core.autocrlf` / `core.eol`. When git
would convert line endings on check-in, the work tree bytes get the same clean conversion (CRLF → LF)
before comparison, so a CRLF checkout of an LF blob shows only its real edits. That includes git's guard
for the auto-derived modes (F4-02): for `text=auto`, and for an unspecified `text` under
`core.autocrlf=true|input`, git converts only when the file is text by its own stats (no NUL, no lone CR)
**and the index blob does not already contain CRLF** (`has_crlf_in_index`); an untracked file has no index
blob and converts. palmux applies the same rule, using the index blob the pair already reads, and records
the decision in `attrs`. A CRLF blob that was never renormalised therefore diffs line for line, and
Reviewed never stages a whole-file renormalisation `git add` would not perform. `-diff` or `binary` marks
the file binary whatever its bytes are. A path with a `filter` driver, a `working-tree-encoding` or
`ident` is not reconstructed: the file answers `converted: true` and the review shows "This file is
converted by git and cannot be shown here", never a wrong diff, and never runs a filter command (an LFS
smudge would download). Both sides are written to a private temp directory and git
computes the hunks with `git -c diff.suppressBlankEmpty=false -c diff.noprefix=false -c
diff.mnemonicPrefix=false diff --no-index --no-color --no-ext-diff --no-textconv --diff-algorithm=X -U3
<old> <new>` (the user's diff config would otherwise change context-line and header shapes; F4-03), so the hunks are git's,
the algorithm is selectable, no pathspec is involved, and a rename is diffed as the pair it is (SCM-03).
The response is `{ old: {id, text}, new: {id, text}, hunks, binary, tooLarge, converted, modes,
attrs, version, token }`. A work tree `id` is **git's blob oid** of the canonical bytes (after clean conversion), computed with
`git hash-object --no-filters --stdin` without `-w`, so it is in the repository's object format (sha1 or
sha256) and comparable with the HEAD and index oids it sits beside (F4-09).
`attrs` is the effective attribute and conversion context the comparison was built with (the `check-attr`
values plus `core.autocrlf`/`core.eol`). `version` hashes the two ids, the modes and `attrs`: it is
**algorithm-free** (SCM-R2-07) but changes when the presentation rules change (SCM-R3-07), and the client
keys its row cache by `version + algorithm`. `token` identifies the served new side for staging (D10).

**Attribute changes invalidate loaded files** (SCM-R3-07). Every status answer carries an `attrEpoch`:
a hash of every `.gitattributes` git could read (F4-01). It is NOT a pathspec query: under the runner's
literal pathspecs a `:(glob)` pattern matches nothing. Instead, the full `ls-files -s -z` output is
filtered in code by basename `.gitattributes`, unioned with every status entry (modified, staged,
untracked) whose basename is `.gitattributes` (git reads the work tree copy first, so a new untracked one
applies), and each contributes its index oid and its work tree `lstat` (`mtime`, `ctime`, `size`, or
absent). Added to that: `.git/info/attributes`, `core.attributesFile` (or, when it is unset, its default
`$XDG_CONFIG_HOME/git/attributes`, else `~/.config/git/attributes`; F5-03), and the repository and global
config files' `mtime` and size. The `ls-files` result is cached per index `mtime`, so the epoch costs one
`lstat` per attributes file on a steady repository. When it changes, the review refetches every loaded file, so marking `yarn.lock` `-diff` turns it
binary without an edit to `yarn.lock` itself. Hunks,
text, colours and comment positions therefore always describe one version (SCM-06).

`repo` must be absolute and equal to its own `rev-parse --show-toplevel` (so every request is pinned to a
real work tree root). `path` and `oldPath` must be relative, contain no NUL, and stay inside `repo` after
normalisation. Limits: status 5,000 entries (`truncated: true`); **1 MB per side**: either side over it
makes the file `tooLarge`, shown as a notice with no lines, so a file is never half-supported with no
expansion or anchoring (SCM-09). Binary is decided by a NUL byte in the first 8 KB, as git does.

**Fingerprints** (SCM-05) cover everything that changes what the review shows. Status entries carry:
the record kind (ordinary, rename, unmerged, untracked), every mode git prints (HEAD, index, work tree),
the object ids, the rename's old path, and for a work tree side `mtimeMs`, `ctimeMs` and `size` from one
`lstat`. ctime catches a same-size replacement that preserved mtime; the modes catch a chmod.

### D3. Status refresh: adaptive poll, coalesced on the server

The client polls `/scm/status` only while a subscriber is visible (the dock or drawer view mounted and
shown, or a review pane `shown` in `PaneHost`) **and** `document.visibilityState === 'visible'`. One
request in flight at a time; the next starts `max(1000, 3 × tookMs)` ms after the previous answer, capped
at 10 s, so palmux (10 ms) refreshes every second and a 900 ms repository every 2.7 s. `visibilitychange`
to visible refreshes at once. The server coalesces concurrent requests for one repo onto one git process
and caches the answer for 500 ms, so two windows cost one read. *Alternatives:* `fs.watch` recursive
(an inotify watch per directory, firehose on build output — the reason the Explorer polls too); watching
`.git/index` only (misses work tree edits, which never touch the index). Lazygit's model, a periodic
refresh while in use, is what this is.

### D4. One status store per window, gated by the active project

A module-level store holds the latest status of the **active project only**, a refcount of visible
subscribers, and the timer. The Source Control view and every review pane subscribe through
`useScmStatus(repo, visible)` (`useSyncExternalStore`), and a subscription counts only when `repo` equals
the device's `scmActiveRepo` (SCM-07). Subscribers going to zero stop the timer. This is what makes "a
hidden view costs nothing" and "only the active project is read" true even with two review panes open.

- Focusing a review pane (`PaneHost`'s `focusedId`, or the tab becoming active) sets `scmActiveRepo` to
  its repo. In a split, only the focused slot can drive that, so an unfocused review of another project is
  a non-counting subscriber: it renders its last data under a "Paused · make <name> active" bar and issues
  no request.
- Removing a project from `scmRepos` turns its open reviews into a "Project removed" notice; they never
  read again unless the project is added back.
- The comment store polls nothing of its own: `commentsRev` rides on the status answer (D9).

### D5. Review tab kind `review`

A new `TabKind` `review` whose `url` is `changes:<abs top>` or `staged:<abs top>`. The server gates it in
`createTab`/`updateTab` (prefix plus `isAbsolute` of the rest) and persists it in `tabs.json` like an
editor file tab. **Creation is idempotent in the server registry** (SCM-11): `createTab` for a `review`
whose canonical url already belongs to a live tab returns that tab's id in `tabCreated` instead of
allocating a new one, and `updateTab` refuses to set a review url another tab already holds. That is the cross-window backstop only. **The
client never sends `createTab` for a review url that is live in `tabsRef`**: it selects that tab and hands
over the scroll target, the rule `openFileTab` already applies to editor tabs, and it coalesces its own
pending opens per url (F4-05). The controller's `tabCreated` dissolve, which treats an id colliding with
a split-pairing member as a stale ghost, is guarded to ids that are not a live tab of the expected kind
and url, so a backstop answer can never dissolve a split that holds the review. Opening a file therefore focuses the one tab, then scrolls to
the file (a pending "scroll to" handed through a ref map, the way the tmux target is). An older client drops
the unknown kind (`isTabKind` filter), which is the existing back-compat path. `displayTitle`:
`Changes · <repo name>` / `Staged · <repo name>`. *Alternative:* one tab per file like VS Code. Rejected:
on a phone with no tab strip, many files means many tabs to swipe through; a continuous review with file
navigation is what "rever vários files" needs.

### D6. Rows model and rendering

The review builds a flat array of rows per file: `fileHeader`, `notice` (binary, too large, rename),
`gap` (hidden unchanged lines, expandable), `hunkHeader`, `line` and `comment`. Unified rows hold one
line; split rows hold a left and a right cell, pairing deletions with additions inside each change block
(GitHub's pairing: the i-th deletion with the i-th addition, the remainder alone). Files not yet fetched
are one `placeholder` row with an estimated height (added + removed lines plus three context lines per
side × line height, from the status line counts; F4-08), and their header already shows the counts. The array is rendered by the kit's `VirtualList` (react-window `List` + `useDynamicRowHeight`).
Line rows are fixed height in no-wrap mode; comment rows and wrapped lines are measured.

- **Wrap:** split always wraps (two half-width columns cannot share one horizontal scroll). Unified has a
  Wrap toggle, on by default under the narrow threshold, off above it; off means rows are `max-content`
  wide inside a horizontally scrolling list and file headers are `position: sticky; left: 0`.
- **Current file bar:** react-window cannot do sticky rows, so the pane draws a bar over the list naming
  the file of the first visible row (`onRowsRendered`). On mobile it is also the file switcher.
- **Automatic layout:** unified below 720px of pane width, measured with a `ResizeObserver` that reports
  only the crossing (the `editor-layout.ts` pattern).

### D7. Fetching and memory

`onRowsRendered` asks for the snapshots (D2) of files within two files of the visible range, at most four
requests at a time; one response carries the hunks and both sides' text. An LRU keeps 60 files' rows and
at most 40 MB of text; an evicted file returns to a placeholder of its measured height, so the scroll
position does not jump. A status update whose fingerprint differs for a loaded file refetches that file
only. Every request carries a per-file generation; an answer older than the newest request for that file
is discarded, so a slow response never overwrites a newer version (SCM-06).

**Scroll anchoring relocates by text** (SCM-08). Before a rebuild the pane records the first visible
row's file, side, line text, three lines of context either side and its pixel offset. After it, the line
is found with the same function that anchors comments (D9). That function **scores every candidate,
the old position included** (SCM-R2-05): each exact match of the text is scored by how many context lines
agree, then by distance from the old number, and the old position wins only on the same terms as any
other, so a `}` or a blank line left at the old number never beats the real line ten rows down. A deleted line falls back to the nearest surviving line of the same hunk, then to the file
header. The recorded pixel offset is restored so the code does not shift under the reader.

### D8. Colouring and inner marks

After `getMonaco()` resolves, each side's full text from the snapshot is coloured with
`monaco.editor.colorize(text, languageOf(path), {})` and split on `<br/>` into per-line HTML, which line
cells render. Lines render plain first and swap to coloured when ready, without a height change. Above
20,000 lines a side stays plain (1 MB is already the snapshot's limit). **The theme bridge becomes a
subscription list** (SCM-13): `monaco-theme.ts` holds one listener today and `monaco-loader.ts` occupies
it with `applyTheme`, so `onEditorProfile(cb)` changes to add a listener and return an unsubscribe,
listeners run in registration order, and the loader's `applyTheme` stays first so Monaco's theme is
defined before a review recolours. Each review pane subscribes on mount and unsubscribes on unmount; a
profile change clears its coloured-line cache and recolours the loaded files. The colourised HTML is Monaco's escaped output;
nothing from the file is inserted as markup otherwise. Inner marks: for a paired line, a word-and-
punctuation tokenisation and an LCS bounded to lines under 400 characters and 10,000 comparison cells;
over the bound, no inner marks.

### D9. Comments store

`<configDir>/.cache/scm/<sha256(top) first 16 hex>.json`, shape
`{ v: 1, repo, rev, comments: [...] }`. A comment is `{ id, path, version: 'head'|'index'|
'worktree', side, start, end, lines[], before[], after[], body, createdAt, updatedAt }`. The version is
provenance: the content the commented side showed (Staged: head|index; Changes: index|worktree).
**Display is content-driven** (F4-06): a comment is drawn on whichever side of the open review its
`lines` and context anchor in, its own version's side preferred, one side per comment. So the owner's
flow (comment on Changes, tap Reviewed, open Staged) still shows the comment on Staged's right side, where
the same lines now are. The server applies each operation as one
read-modify-write under a per-file in-process mutex with an atomic rename, so two windows never clobber
each other on disk. **Windows also converge** (SCM-10, SCM-R2-02, SCM-R2-08): the file holds a `rev` counter bumped by
every write. **Every mutation answers with the whole authoritative comment list and its `rev`**, and the
client replaces its state with it, so a window can never hold a `rev` whose changes it has not applied.
Other windows learn of a write from a tiny control-socket broadcast, `scmComments { repo, rev }` (a new
server→client frame in `shared/protocol.ts`), sent on every write, independent of the git poll; a client
whose active project matches and whose view or review is visible refetches when the `rev` is newer than
the one it applied, and on reconnect. That keeps the 2-second promise even when a slow repository stretches
the status interval. A response older than the applied `rev` is dropped. `commentsRev` also rides on
status answers as a backstop for a missed frame. `.cache/` gets its own `.gitignore` holding `*`, written when the
directory is created. That ignores it in a dotfiles-tracked config dir without touching the user's root
`.gitignore`, which `ensureConfigGitignore` never overwrites.

**Anchoring** runs client-side against the version's current content: every exact match of `lines`,
the stored position included, is scored by matching `before`/`after` lines and then by distance from the
old start, and the best wins; a tie for best, or no match, is outdated. There is no fast path that accepts
the old position before context is compared (SCM-R2-05). **Export** is client-side: files in path order,
each comment as `path:L10-14`, a fenced block in the file's language with the stored lines, then the body;
outdated comments carry "(outdated)".

### D10. Stage and unstage: the only writes

Owner decision (2026-10-25): Reviewed stages the file and moves on, Staged offers Unstage, both with Undo;
the local Viewed mark is dropped, since staged now means reviewed. These are the only routes that write,
and they write only the index entry of the one file named.

- **Stage exactly what was shown, from an immutable snapshot only** (SCM-R3-03, R3-05, R3-06). The D2
  reader keeps every served work tree side in a server-side cache keyed by an opaque `token` that binds
  the repository, the path, the file type and mode, the canonical bytes' id and the `attrs` context
  (64 MB, 10 minutes, LRU, memory only). `POST /scm/stage {token}` looks the record up and checks that its
  repository and path match the request; it re-runs `check-attr` and refuses with `409 changed` if the
  attribute context differs from the snapshot's; it writes the **canonical comparison bytes** with `git
  hash-object -w --no-filters --stdin` (no filter reruns; the object database is append-only) and checks
  that the resulting oid equals the snapshot's id before touching the index. Two cases are kept apart (F4-04). A file the reader could not snapshot (over the size limit, converted
  by a filter, refused for safety) gets no token: it cannot be staged from palmux, Reviewed is disabled
  with the reason, and there is no live-path `git add` fallback. A token that has expired or been evicted
  answers `410 token` and the client recovers by itself: it refetches the snapshot, and if the new
  `version` equals the one on screen it retries the stage once with the new token without asking (one
  retry, never a loop); if the
  version differs it shows the new version with the "changed since you looked" notice and stages nothing.
  A long review on a phone therefore never strands Reviewed. A staged deletion is a snapshot too (the work tree side is recorded as absent).
- **Unstage** returns each affected entry to HEAD (HEAD's mode and oid, or removal when HEAD has no such
  path, unborn HEAD included); a staged rename restores both paths.
- **Every write is one index transaction under git's own lock protocol** (SCM-R3-02). palmux creates the
  index lock file (`git rev-parse --git-path index` + `.lock`) with `O_CREAT | O_EXCL`, exactly as git
  does; if it already exists, the route answers `409 busy` at once and nothing waits, retries or deletes a
  lock. Holding the lock, it copies the index to a private temp file, reads every affected path's
  *before* entry from that copy (`GIT_INDEX_FILE=<tmp> git ls-files -s -z`), applies the change with
  `GIT_INDEX_FILE=<tmp> git update-index --add --cacheinfo <mode>,<oid>,<path>` or `--force-remove`
  (`--add` because the entry may be absent: an untracked file, a staged deletion being unstaged, an Undo
  after a removal; SCM-R3-04), reads the *after* entries, writes the temp index into the lock file, fsyncs
  it and renames it over the index, which is git's own commit step. Any failure removes the lock file and
  leaves the index untouched. Process death is covered too (F4-12): live lock paths are kept in a module
  set and unlinked synchronously from `index.ts`'s shutdown and from `process.on('exit')`, as git does from
  its own signal handlers, so a `systemctl restart` mid-write never strands an `index.lock`. A directory /
  file conflict that `update-index` refuses (the index holds `foo/bar` and the request stages `foo`) is a
  `409` carrying git's message, not a `500`. A repository with a split index (`core.splitIndex` or a `link` extension) is
  refused with a notice rather than half-handled.
- **Undo is a compare-and-swap on a server-held receipt** (F4-07). Each write records a receipt (every
  affected path's before and after entry, rename paths included) in the same server-side cache as the
  snapshots, under an opaque `receiptId`, and answers with that id. `POST /scm/restore {receiptId}` runs
  the same transaction, checks that every path's current entry still equals the receipt's *after*, and
  only then writes the *before*; otherwise it answers `409 conflict` ("the index changed since; nothing
  was undone"). The client never supplies a mode, an oid or a path to restore, so restore can only
  reinstate entries palmux itself recorded. It is the third and last write route.
- A write invalidates the status cache and the coalescer, so the next poll reflects it.

### D11. Settings and keybindings

Synced (`SYNCED_KEYS`): `scmRepos: string[]`, canonicalised with `normalizePin`. Local: `scmActiveRepo`,
`scmLayout: 'auto'|'split'|'unified'`, `scmAlgorithm: 'myers'|'minimal'|'patience'|'histogram'`
(default `histogram`), `scmWrap`. New actions in `keybindings.ts` `ACTIONS`: `openSourceControl`
(**Ctrl+Alt+G**: VS Code's Ctrl+Shift+G is already `copyLastOutput` here, and `matchAction` returns the
first match, so reusing it would make one action unreachable; SCM-12), `scmNextChange` (Ctrl+Alt+J),
`scmPrevChange` (Ctrl+Alt+Shift+J), `scmNextFile` (Ctrl+Alt+N), `scmPrevFile` (Ctrl+Alt+Shift+N),
`scmReviewed` (Ctrl+Alt+Enter: Reviewed in Changes, Unstage in Staged). The keybinding model is one
`Chord` per action end to end (`DEFAULT_BINDINGS`, `loadBindings`, `matchAction`, the panel), so each
action has exactly one default (F5-01). They are letters, not VS Code's F7, because GNOME takes Alt+F7
(move window) before the browser sees it and a Mac's F-row is media keys (F4-10). Ctrl+Alt+K stays
`downloadFile`. They act only while a
review is the focused pane (except the first). A test asserts every default chord is unique.

**An older window must not erase `scmRepos`** (SCM-14). `saveSettings` replaces the stored object with
whatever a client sent, and an older bundle sends only the keys it knows. The server's settings write
becomes a shallow merge **that returns the merged object, and the handler uses that one object for
persistence, the theme export and the broadcast** (SCM-R2-06): today `server.ts` exports and broadcasts
the incoming blob, so a partial save without `themeId` would export the default palette and reload tmux
with it. A top-level key absent from the incoming blob keeps its stored value; a key that
is present, including an explicit `[]`, replaces it. This also closes the documented `themeMode` rollout
limit (CLAUDE.md "Rollout: older bundles erase the new keys"), and that paragraph is rewritten. It rides
the same restart as the new routes.

### D12. Mobile

- Drawer: a fourth Segmented item (`git-branch` icon) declared in `hostedViews`; the view reuses the dock
  view's body. Choosing a file calls `closeDrawer()` then opens the review.
- **The review bar replaces the extra-keys bar** (owner decision, 2026-10-25) while the active tab is a
  review: App renders `ReviewBar` in the extra-keys bar's slot instead of `ExtraKeysBar`, reading the
  ACTIVE TAB's kind as the editor routing does. It holds the file list, ↑ previous file, ↓ next file, and
  ✓ Reviewed (Changes) or ↩ Unstage (Staged), at `--ctl-h` (36px on mobile).
- **One release-time gesture classifier for taps and swipes** (SCM-R3-01). The buttons are NOT
  `pressClick`, which acts on pointerdown: a drawer swipe that started on ✓ would stage the file before it
  was a swipe. The bar owns one pointer state machine, the shape `ExtraKeysBar` already uses: pointerdown
  only records; a release within the 10px slop activates the button under the finger; horizontal travel
  past the swipe threshold is a swipe and activates nothing; any other movement or a `pointercancel`
  activates nothing. The release that acts marks its gesture (`consumeGesture`) so its trailing click
  cannot land on what the action redrew. A keyboard, assistive-tech or `element.click()` activation
  (`detail === 0`) still acts once. Tests start a swipe on every button, both directions.
  There are no terminal keys, so nothing can reach a shell. Navigating between changes inside a file is
  scrolling on a phone; desktop has Ctrl+Alt+J / Ctrl+Alt+Shift+J.
- **The bar keeps the swipes**, with the same gesture code the extra-keys bar uses (`onSwipe`):
  right→left opens the drawer; left→right returns to the tab that was active before the review was
  opened (App records it when a review becomes active), or the first terminal if that tab is gone. The
  extra-keys bar returns with that tab. The CLAUDE.md rule "the extra-keys bar is ALWAYS present on
  mobile" exists so the drawer is never out of reach; the review bar keeps that route, and the paragraph
  is rewritten to say so.
- The comment editor's ESC is the textarea's own Escape key; there is no key routing for reviews.
- Lists use `pressMove` (activate on pointer up within the slop) so panning never activates a row.
- Range selection is tap-then-tap on line numbers (a long-press would fight native text selection).
- The comment editor is a real `<textarea>`; on save or cancel focus returns to `#mobile-kbd` only if it
  held focus before.

### D14. Unmerged entries

Porcelain v2 `u` records (stages 1/2/3) become a `merge[]` group, listed first as Merge Changes and
marked conflicted (SCM-15). They are never asked for a stage-0 blob. Opening one shows a read-only notice
("This file has conflicts. Resolve them in your editor.") with Open file, and no diff; their fingerprint
is the three stage oids plus the work tree metadata, so the entry moves to Changes or Staged as soon as
the conflict is resolved and added. A stage comparison (ours / theirs) is left for later.

### D13. Kit scroll primitives

`ui/ScrollArea.tsx` over `@radix-ui/react-scroll-area` and `ui/VirtualList.tsx` over react-window 2.3.3,
both styled in `ui.css` from the tokens. The VirtualList uses `scrollbar-width: thin` and
`scrollbar-color` from the tokens so it matches the ScrollArea's thumb (the DS's own pattern).

## Risks / Trade-offs

- [Colouring a large file on the main thread janks a phone] → plain-first rendering, the 20k-line/1 MB
  cap, colouring scheduled with `requestIdleCallback` per file; measure on the S26, and move to a worker
  only if a frame over 50 ms is measured.
- [A slow repository makes "within 2 s" untrue] → the spec states the 300 ms condition; the adaptive
  interval degrades instead of stacking reads.
- [`--untracked-files=all` on a repo with a huge unignored folder] → the 5,000-entry cap with `truncated`.
- [The comment textarea fights the soft-keyboard machinery that keeps `#mobile-kbd` focused] → verify on
  the device; the drawer is closed during a review, so its hold logic is not involved.
- [Dynamic row heights cause scroll jumps when an off-screen row is measured] → placeholders keep measured
  heights; anchor-and-restore on every rebuild.
- [Status cached for 500 ms shows a just-made change late] → bounded by the 2 s requirement.
- [Staging from a phone is a write that can surprise] → it stages only the exact version shown, only on an
  explicit tap, never forces `index.lock`, and Undo restores the previous entry byte for byte.
- [The snapshot byte cache holds work tree contents in server memory] → 64 MB cap, 10-minute expiry, never
  written to disk.
- [Comments anchored by text can attach to a duplicated block] → context lines and distance break ties;
  an ambiguous tie marks it outdated rather than guessing.

## Migration Plan

1. Server routes, tab kind and the comments store ship first; they need **one restart** of the palmux
   service (owner approval; terminals end, tmux survives). Nothing calls them until the client ships.
2. Client deploy (`yarn workspace @palmux/client build`), pre-authorised after a batch passes inspection.
3. Rollback: revert the client build; the server routes are unused without it. A `review` tab persisted in
   `tabs.json` is dropped by an older server's `isTabKind` filter on restore.
4. `react-window` and `@radix-ui/react-scroll-area` are added to `packages/client` only.

## Open Questions

- The exact icon for Source Control (a branch glyph in the existing SVG set, or a new one drawn to its
  stroke) — decided while building the rail entry.

---
## FILE: tasks.md

# Tasks

## 1. Server: read-only git access

- [ ] 1.1 Add `server/scm.ts` with a git runner (argv arrays, `-C`, `--no-optional-locks`, `--literal-pathspecs`, `core.quotepath=false`, `GIT_OPTIONAL_LOCKS=0`, `GIT_LITERAL_PATHSPECS=1`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, 10 s timeout, output cap) and verify with a unit test that a hanging command is killed at the timeout and an oversized output is reported as truncated
- [ ] 1.2 Implement repo resolution (`rev-parse --show-toplevel`, canonical form, refusals for relative, missing and non-repo paths) and the `GET /scm/repo` route; verify with tests against a temporary repository, a subfolder of it, a plain folder and a relative path
- [ ] 1.3 Implement the porcelain v2 `-z` status parser (merge / staged / changes groups, `u` records as conflicted, renames with old path, untracked files individually, no-HEAD repositories, fingerprints covering record kind, all modes, oids, old path and work tree `mtimeMs`/`ctimeMs`/`size`, 5,000-entry cap) and `GET /scm/status`; verify with parser unit tests over captured git output (including a conflict and a chmod-only change) and a route test on a temporary repository holding each status kind
- [ ] 1.4 Add server-side coalescing (one git process per repo for concurrent requests, 500 ms answer cache) and verify with a test that ten concurrent status requests cost one status read (one set of git processes)
- [ ] 1.5 Implement the unified-diff parser (hunks, line numbers, no-newline markers) and the snapshot reader: HEAD and index oids from `ls-tree`/`ls-files -s` (an unborn HEAD gives an absent old side without calling `ls-tree`), blobs by oid with `cat-file blob`, the work tree read once through a descriptor-relative walk (`/proc/self/fd/<dirfd>/<name>` with `O_DIRECTORY|O_NOFOLLOW` per component, `O_NOFOLLOW` final open, `fstat` regular file, a final symlink's target via the validated parent; fail closed without `/proc`), git attributes from `check-attr` with clean line-ending conversion, `-diff`/`binary` as binary and `filter`/`working-tree-encoding`/`ident` answered as `converted`, both sides into a private temp dir, `git diff --no-index --diff-algorithm=X -U3`, binary by NUL in the first 8 KB, 1 MB per side → `tooLarge`, the response ids, modes, `attrs`, an algorithm-free `version` that includes `attrs`, and a staging `token`; plus the status `attrEpoch` (full `ls-files` filtered by basename in code, unioned with status entries, never a `:(glob)` pathspec) and `numstat` line counts (including the rename record with an empty path field followed by two NUL-terminated paths); a clean-base git env (no inherited `GIT_*`), pinned diff config, `--no-index` exit 1 as success, the work tree id as git's blob oid, and git's `text=auto` CRLF-in-index guard; verify with parser tests and route tests for staged, unstaged, untracked, a staged rename showing one changed line, a mode-only change, a staged file before the first commit, a CRLF checkout of an LF blob showing one edited line, a `-diff` path shown binary, a filter-driver path answered as converted, a `* text=auto` repo with a CRLF index blob showing one edited line, `diff.suppressBlankEmpty`/`diff.noprefix` set and `GIT_DIFF_OPTS=-u1` in the environment not changing the hunks, `attrEpoch` changing when a `.gitattributes` is edited, created untracked and deleted, and histogram vs myers producing git's own hunks
- [ ] 1.6 Expose the snapshot as `GET /scm/file` and verify with tests that `../` paths, absolute paths, NUL bytes, a folder swapped for a symlink to outside the repo (including swaps injected by a test hook between walk steps, in the regular-file and the symlink branch), a file named `a*.ts` next to `alpha.ts`, and a file named `2:config.ts` are each refused or read literally as specified, and that a final-component symlink answers its target text
- [ ] 1.7 Verify the "never interferes" requirement: a test runs `git commit` in the temporary repo while status requests loop, and the commit never fails with `index.lock`
- [ ] 1.8 Make the server's settings write a shallow merge that returns the merged object, and use that object for persistence, the theme export and the broadcast; verify with a `config` test that an older client's blob without `scmRepos` or `themeMode` leaves both in place, and a handler test that a partial save without `themeId` keeps a non-default theme and its generated exports
- [ ] 1.9 Add stage, unstage and restore as index transactions under git's lock protocol (exclusive lock file, temp index copy, before/after read from the copy, `update-index --add --cacheinfo` / `--force-remove`, fsync + rename; lock removed on any failure; split index refused), staging only from a cached snapshot `token` (repo + path + type/mode + canonical id + `attrs`), attributes re-checked, bytes written with `hash-object -w --no-filters` and the oid verified, receipts held server-side under an opaque `receiptId` with restore as a compare-and-swap, `410 token` for an expired token, lock paths unlinked on shutdown and on `process.on('exit')`, a D/F refusal as 409; verify with route tests for an untracked file, unstaging a deletion, a rename, a HEAD-less unstage, Undo restoring a partial stage byte for byte, Undo refused with 409 after another writer changed the entry, a held lock answering 409 without waiting, a changed attribute context answering 409, two snapshots with equal content and different modes staging their own modes, an over-limit or converted file being refused, an expired token answering 410, and a lock left by a killed write being removed at exit
- [ ] 1.10 Document the routes, the trust model, the limits and the poll contract in `CLAUDE.md` (a "Source Control" section), rewrite the "Rollout: older bundles erase the new keys" paragraph for the merge, and verify `yarn typecheck` and the server tests pass

## 2. Server: comments store

- [ ] 2.1 Add the comments store under `<configDir>/.cache/scm/` (per-repo file named by a sha256 prefix, atomic writes, per-file mutex) and create `.cache/.gitignore` holding `*` with the directory; verify with tests that a fresh config dir gets both and that the root `.gitignore` is untouched
- [ ] 2.2 Add comment create, update and delete routes, validating every field (path inside repo, version and side enums, line ranges, body size cap), with a `rev` bumped on every write; every mutation answers with the whole comment list and its `rev`, every write broadcasts `scmComments { repo, rev }` on the control socket (new frame in `shared/protocol.ts`), and status answers carry `commentsRev`; verify with route tests for two interleaved writers whose final lists both contain each other's change, and a protocol test for the new frame
- [ ] 2.3 Document the store layout and the `.cache` boundary in `CLAUDE.md`'s config-dir section and verify the docs match the test fixtures

## 3. Protocol: the review tab kind

- [ ] 3.1 Add `review` to `TabKind` and `isTabKind` in `shared/src/protocol.ts`, gate `changes:<abs>`/`staged:<abs>` urls in the server's `createTab`/`updateTab`, persist the kind in `tabs.json`, and make review creation idempotent on the server (an existing canonical url returns its tab id; `updateTab` refuses a url another tab holds) as a cross-window backstop; verify with protocol and server tests that a bad url is refused, two concurrent creates yield one tab, and a review tab survives a registry restore
- [ ] 3.2 Add the review tab's `displayTitle` (`Changes · <name>` / `Staged · <name>`) and kind icon on the client and verify with `tab-meta` tests

## 4. Kit: scroll primitives

- [ ] 4.1 Add `@radix-ui/react-scroll-area` and `react-window@2.3.3` to `packages/client` and verify `yarn install` and `yarn typecheck` succeed
- [ ] 4.2 Build `ui/ScrollArea.tsx` and `ui/VirtualList.tsx` (dynamic row heights, overscan, thin token-coloured scrollbar) with their rules in `ui.css`; verify with kit tests that 10,000 rows mount fewer than 100 elements, that a row growing pushes the rest down, and that `ui.test.tsx` and `scale.test.ts` pass with no colour literal and no off-scale size
- [ ] 4.3 Document the two primitives in `CLAUDE.md`'s kit section, including why the virtual list is its own scroll container

## 5. Client: projects, status and the Source Control view

- [ ] 5.1 Add `scmRepos` to `SYNCED_KEYS` (canonicalised with `normalizePin`) and the local `scmActiveRepo`, `scmLayout`, `scmAlgorithm` and `scmWrap` settings with sanitisers; verify with `settings.test.ts` that the local keys never sync and old blobs still parse
- [ ] 5.2 Build the per-window status store and `useScmStatus(repo, visible)` (only subscribers of the active project count, visible ones only, `document.visibilityState`, one request in flight, `max(1000, 3 × tookMs)` capped at 10 s, immediate refresh on return, `commentsRev` change triggers a comments refetch); verify with fake-timer tests that a hidden subscriber and a visible subscriber of a non-active project trigger no request, and that two visible subscribers share one timer
- [ ] 5.3 Build the Source Control view body: empty state, project selector (add with server validation, switch, remove), Merge Changes, Staged Changes and Changes groups with status, directory and file icon, truncation notice; verify with component tests for each spec scenario of `source-control`
- [ ] 5.4 Add the dock view and the rail entry between Explorer and Dictation (`DOCK_VIEWS`, `dock-rail-scm`) and verify with `DockPanel` tests that the rail order matches the modified `sidebar-dock` requirement
- [ ] 5.5 Update `CLAUDE.md` (dock views, rail order) and `tips/tips.ts` with the new view, and verify the tips test passes

## 6. Client: the review pane

- [ ] 6.1 Write the pure rows model: unified rows, split pairing per change block, gaps between hunks with expansion steps, notices for binary, too-large, rename and symlink, placeholders with estimated heights; verify with unit tests over parsed hunks for each case and correct old/new line numbers after an expansion
- [ ] 6.2 Build the review pane on `VirtualList`: file headers with counts and collapse, the current-file bar from `onRowsRendered`, automatic layout at 720px reported only on crossing, the Wrap toggle (split always wraps), and `visible` from `PaneHost`; verify with component tests and a `PaneHost` test that a hidden review issues no request
- [ ] 6.3 Add fetching near the visible range (two files either side, four requests at a time) with the 60-file / 40 MB LRU returning evicted files to measured placeholders; verify with tests that a 400-file group fetches only nearby diffs and that eviction keeps the scroll offset
- [ ] 6.4 Wire live refresh: refetch a loaded file when its fingerprint changes, and every loaded file when `attrEpoch` changes (per-file generations, stale answers dropped), add and remove files as the group changes, and relocate the first visible row by text and context with its pixel offset after each rebuild; verify with tests that an edit below the viewport leaves the visible lines in place, ten lines inserted above keep the same code in view, a deleted anchor line falls back to its nearest surviving neighbour, and a slow stale answer never replaces a newer one
- [ ] 6.5 Never send `createTab` for a review url live in the tab list (select it and hand over the scroll target) and guard the `tabCreated` dissolve to ids that are not a live tab of the expected kind and url; verify with a test that opening another file of a review held in a split keeps the split
- [ ] 6.6 Add the paused state for a visible review of a non-active project ("Paused · make <name> active"), make focusing a review set the active project, show "Project removed" for a removed project, and add the layout and algorithm controls (per device) that keep the current file in view on switch, and opening a file from the Source Control view focuses the existing review tab and scrolls to it; verify with tests for both `diff-review` scenarios of "A review opens in the content area"
- [ ] 6.7 Document the review pane (rows model, fetching, memory bounds) in `CLAUDE.md`

## 7. Client: colouring and inner marks

- [ ] 7.1 Colour each side's full content with `monaco.editor.colorize` and `languageOf`, plain-first then swapped without height change, per-file `requestIdleCallback`, plain above 20,000 lines or 1 MB; verify with tests that a line inside a block comment that starts outside the hunk is coloured as a comment and that a terminal-only session loads no monaco chunk
- [ ] 7.2 Turn the `monaco-theme.ts` bridge into a subscription list (`onEditorProfile` returns an unsubscribe, registration order, the loader's `applyTheme` first) and repaint review panes through it; verify with a test that an editor and two review panes all update on one profile change and an unmounted pane stops listening
- [ ] 7.3 Implement inner marks for paired lines (word/punctuation tokens, LCS bounded to lines under 400 characters and 10,000 cells) and verify with unit tests for the renamed-variable scenario and the over-bound fallback

## 8. Client: navigation, stage and open file

- [ ] 8.1 Implement next/previous change across files and next/previous file (fetching an unloaded target before scrolling) and add the `openSourceControl` (Ctrl+Alt+G), `scmNextChange` (Ctrl+Alt+J), `scmPrevChange` (Ctrl+Alt+Shift+J), `scmNextFile` (Ctrl+Alt+N) and `scmPrevFile` (Ctrl+Alt+Shift+N) actions; verify with tests that next change at a file's last change lands on the next file's first change, that the keybindings appear in the palette, and that every default chord is unique (`copyLastOutput` keeps Ctrl+Shift+G)
- [ ] 8.2 Add Reviewed (Changes: stage the shown version, then the next file; on `410 token` refetch and retry once, transparently, when the version is unchanged) and Unstage (Staged), the 6-second Undo toast, the busy and changed notices, the `scmReviewed` action (Ctrl+Alt+Enter), and Open file reusing the editor-tab focus rule; verify with tests for every `diff-review` scenario of "Reviewing a file stages it and moves on" and "A staged file can be unstaged", and "Opening the file"
- [ ] 8.3 Update `CLAUDE.md` and `tips/tips.ts` for the review keybindings and verify the keybinding-aware tips test passes

## 9. Client: comments

- [ ] 9.1 Write the pure anchoring function (every candidate scored by context then distance, the old position included, outdated on no match or a tie) and the markdown exporter; verify with unit tests for "Lines inserted above", "The code is deleted", repeated `}` and blank-line anchors that must move with their context, and the export scenario
- [ ] 9.2 Replace comment state with each mutation's authoritative answer, refetch on an `scmComments` frame (or a status `commentsRev`) newer than the applied `rev` while the project is active and visible, and drop older responses; verify with tests for the interleaved add/delete case and a 900 ms status repository still converging within 2 seconds
- [ ] 9.3 Draw each comment on whichever side of the open review its lines and context anchor in (its own version's side preferred); verify with a test for "A comment survives Reviewed"
- [ ] 9.4 Build range selection on line numbers (drag and shift-click on desktop, tap-then-tap on mobile), the inline comment editor with drafts that survive scrolling, edit and delete with the one-time confirm, and the outdated list; verify with component tests for each `review-comments` scenario
- [ ] 9.5 Add Copy comments to the Source Control view and verify with a test that the clipboard receives the exported document
- [ ] 9.6 Document comments (storage, versions, anchoring, export) in `CLAUDE.md`

## 10. Mobile

- [ ] 10.1 Add the Source Control segment to the drawer switcher (`hostedViews`, `git-branch` icon) and close the drawer through `closeDrawer()` when a file is chosen; verify with `SessionDrawer` tests and a 390px layout check that four segments and both side controls fit without truncation
- [ ] 10.2 Add `ReviewBar`, rendered in the extra-keys bar's slot while the active tab is a review (files, ↑ previous file, ↓ next file, ✓ Reviewed or ↩ Unstage; no terminal keys); with buttons at `--ctl-h` and no `press*` helper: one release-time tap/swipe classifier (pointerdown only records; release inside the slop acts; a swipe or cancel acts on nothing; `consumeGesture` on the acting release; `detail === 0` clicks act once); verify with tests that the extra-keys bar is not rendered for a review tab and returns for a terminal, that each button acts on a tap, and that a swipe starting on every button, in both directions, activates none of them
- [ ] 10.3 Give `ReviewBar` the extra-keys bar's swipes (right→left opens the drawer; left→right returns to the tab active before the review, or the first terminal), recording that tab when a review becomes active; verify with tests for both scenarios of "The review bar keeps the bar's swipes"
- [ ] 10.4 Use `pressMove` for every list row and make the comment textarea keep focus, returning it to `#mobile-kbd` only when it held focus before; verify with tests that a pan never activates a row
- [ ] 10.5 Update `CLAUDE.md`'s mobile and drawer sections (including the "extra-keys bar is ALWAYS present" paragraph, now "a bar with the drawer swipe is always present") and `tips/tips.ts`

## 11. Integration

- [ ] 11.1 Run `yarn typecheck`, `yarn test` and `yarn lint` and verify all pass
- [ ] 11.2 Smoke the whole flow on an isolated smoke server (disposable config dir, HOME, TMUX_TMPDIR and cwd, port 44099) against a temporary repository: add project, live edit within 2 s, review both layouts, comment, export, Reviewed with Undo, Unstage; verify with screenshots at 1440px and 390px
- [ ] 11.3 With the owner's approval, restart the production palmux service for the server routes, then build the client dist; verify `/scm/status` answers through `palmux.dgsl.pt` and the rail shows Source Control
- [ ] 11.4 On the S26, review a change set of at least 50 files, measure that colouring never blocks a frame for more than 50 ms, and confirm typing a comment does not dismiss or fight the keyboard

## Workflow follow-up

- Archive the change after every batch has passed its plan review, build and fresh inspection.
- Sync the delta specs into `openspec/specs/` at archive.

---
## FILE: specs/diff-review/spec.md

# Spec Delta

## Purpose

Renders the changes of the active project as a syntax-coloured diff that you can read, step through and
stage file by file on a desktop or a phone, one file or the whole change set at a time.

## ADDED Requirements

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

---
## FILE: specs/mobile-drawer/spec.md

# Spec Delta

## MODIFIED Requirements

### Requirement: Drawer navigation is ordered for thumb reach

In the drawer, the session list SHALL stay bottom-anchored with the footer actions under it. The
view switcher (sessions, files, source control, dictation) SHALL sit in the top row between the settings
entry and the close control, at the drawer's root views only (owner decision, 2026-10-25: he does not want
it at the bottom).

#### Scenario: Settings is the farthest target

- **WHEN** the drawer is open on a phone
- **THEN** the top row holds the settings entry, the view switcher and the close control, and the
  session list ends just above the footer

#### Scenario: Source Control is a drawer view

- **WHEN** the user selects the Source Control segment on a 390px wide phone
- **THEN** the drawer shows the Source Control view, the four segments and both side controls fit in the
  top row without truncation, and choosing a file there closes the drawer and opens the review

---
## FILE: specs/review-comments/spec.md

# Spec Delta

## Purpose

Lets the user leave pull-request-style comments on lines of a diff, keeps them outside the repository
and attached to their code as it changes, and hands them off as one markdown document.

## ADDED Requirements

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

---
## FILE: specs/sidebar-dock/spec.md

# Spec Delta

## MODIFIED Requirements

### Requirement: App surfaces render in a side dock instead of modals

palmux SHALL host Settings, the new-tab chooser, Files, Source Control and Dictation as **views of one
right-side dock** rather than as modal overlays. The dock SHALL occupy layout width, shrinking the content
area, and MUST NOT cover the terminal — the terminal is what the user is reading from while using these
surfaces. Exactly one view SHALL be active at a time, and the active view SHALL persist per device.

#### Scenario: Opening settings keeps the terminal readable

- **WHEN** the user opens Settings while a terminal is showing output
- **THEN** the dock appears beside the terminal, the terminal narrows, and no terminal content is
  hidden behind an overlay

#### Scenario: Switching views does not close the dock

- **WHEN** the dock is showing Settings and the user selects Files
- **THEN** the dock stays open and swaps its content

#### Scenario: Source Control is a dock view

- **WHEN** the user selects Source Control on the rail
- **THEN** the dock shows the Source Control view beside the content area, and a review it opens goes to
  the content area, not the dock

### Requirement: The rail orders entries by frequency of use

The desktop rail SHALL list, from top to bottom: New tab, Explorer, Source Control, Dictation, a
separator, Upload, Download, and Settings pinned to the bottom of the rail.

#### Scenario: Settings sits at the bottom

- **WHEN** the rail is visible on desktop
- **THEN** New tab is the topmost entry and Settings is the bottommost, separated from the other
  entries by free space

#### Scenario: Source Control follows Explorer

- **WHEN** the rail is visible on desktop
- **THEN** Source Control is the entry directly below Explorer and directly above Dictation

---
## FILE: specs/source-control/spec.md

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

---
## FILE: specs/ui-primitives/spec.md

# Spec Delta

## ADDED Requirements

### Requirement: The kit provides a scroll area and a virtualized list

The kit SHALL provide a scroll area for bounded content and a virtualized list for long content, both
styled only from the `--t-*` tokens and the size scale. The virtualized list SHALL mount only the rows
near the visible part plus a small overscan, SHALL support rows of different and changing heights, and
SHALL wear the same thin scrollbar as the scroll area, so the two read as one control.

#### Scenario: Ten thousand rows

- **WHEN** a virtualized list holds 10,000 rows in a 600px tall area
- **THEN** fewer than 100 row elements exist in the DOM, and scrolling to the end renders the last rows

#### Scenario: A row grows

- **WHEN** a row in a virtualized list grows because a comment editor opens inside it
- **THEN** the rows below it move down by the new height and none overlap

#### Scenario: A theme change

- **WHEN** the user switches themes
- **THEN** both scrollbars repaint from the new tokens, and neither stylesheet holds a colour literal

### Requirement: Scroll surfaces never compete with the terminal or the drawer

A kit scroll surface SHALL NOT be used inside the terminal grid, and on mobile its scrollbar SHALL NOT sit
under the drawer's edge gesture. Touch panning inside it SHALL stay native, so a swipe that starts inside
a list scrolls the list and a press there never cancels the pan.

#### Scenario: Panning a long list on a phone

- **WHEN** the user swipes up inside a virtualized list in the drawer
- **THEN** the list scrolls natively, and no row activates
