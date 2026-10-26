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
| `GET /scm/status?repo=` | `status --porcelain=v2 -z --untracked-files=all --branch`; parsed into `merge[]`, `staged[]` and `changes[]`, with line counts from `diff-files --numstat -z` and `diff --cached --numstat -z` (NOT `git diff --numstat`: measured, plain `git diff` refreshes and rewrites `.git/index` under its lock even with `--no-optional-locks`, which `diff-files` and `diff --cached` do not) (binary as `-`; untracked files are "new" with no count; a rename is the record `added\tremoved\t\0<old>\0<new>\0` with an empty path field, F5-02), plus `commentsRev` and `attrEpoch` |
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
