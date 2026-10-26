# Tasks

## 1. Server: read-only git access

- [x] 1.1 Add `server/scm.ts` with a git runner (argv arrays, `-C`, `--no-optional-locks`, `--literal-pathspecs`, `core.quotepath=false`, `GIT_OPTIONAL_LOCKS=0`, `GIT_LITERAL_PATHSPECS=1`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, 10 s timeout, output cap) and verify with a unit test that a hanging command is killed at the timeout and an oversized output is reported as truncated
- [x] 1.2 Implement repo resolution (`rev-parse --show-toplevel`, canonical form, refusals for relative, missing and non-repo paths) and the `GET /scm/repo` route; verify with tests against a temporary repository, a subfolder of it, a plain folder and a relative path
- [x] 1.3 Implement the porcelain v2 `-z` status parser (merge / staged / changes groups, `u` records as conflicted, renames with old path, untracked files individually, no-HEAD repositories, fingerprints covering record kind, all modes, oids, old path and work tree `mtimeMs`/`ctimeMs`/`size`, 5,000-entry cap) and `GET /scm/status`; verify with parser unit tests over captured git output (including a conflict and a chmod-only change) and a route test on a temporary repository holding each status kind
- [x] 1.4 Add server-side coalescing (one git process per repo for concurrent requests, 500 ms answer cache) and verify with a test that ten concurrent status requests cost one status read (one set of git processes)
- [x] 1.5 Implement the unified-diff parser (hunks, line numbers, no-newline markers) and the snapshot reader: HEAD and index oids from `ls-tree`/`ls-files -s` (an unborn HEAD gives an absent old side without calling `ls-tree`), blobs by oid with `cat-file blob`, the work tree read once through a descriptor-relative walk (`/proc/self/fd/<dirfd>/<name>` with `O_DIRECTORY|O_NOFOLLOW` per component, `O_NOFOLLOW` final open, `fstat` regular file, a final symlink's target via the validated parent; fail closed without `/proc`), git attributes from `check-attr` with clean line-ending conversion, `-diff`/`binary` as binary and `filter`/`working-tree-encoding`/`ident` answered as `converted`, both sides into a private temp dir, `git diff --no-index --diff-algorithm=X -U3`, binary by NUL in the first 8 KB, 1 MB per side → `tooLarge`, the response ids, modes, `attrs`, an algorithm-free `version` that includes `attrs`, and a staging `token`; plus the status `attrEpoch` (full `ls-files` filtered by basename in code, unioned with status entries, never a `:(glob)` pathspec) and `numstat` line counts (including the rename record with an empty path field followed by two NUL-terminated paths); a clean-base git env (no inherited `GIT_*`), pinned diff config, `--no-index` exit 1 as success, the work tree id as git's blob oid, and git's `text=auto` CRLF-in-index guard; verify with parser tests and route tests for staged, unstaged, untracked, a staged rename showing one changed line, a mode-only change, a staged file before the first commit, a CRLF checkout of an LF blob showing one edited line, a `-diff` path shown binary, a filter-driver path answered as converted, a `* text=auto` repo with a CRLF index blob showing one edited line, `diff.suppressBlankEmpty`/`diff.noprefix` set and `GIT_DIFF_OPTS=-u1` in the environment not changing the hunks, `attrEpoch` changing when a `.gitattributes` is edited, created untracked and deleted, and histogram vs myers producing git's own hunks
- [x] 1.6 Expose the snapshot as `GET /scm/file` and verify with tests that `../` paths, absolute paths, NUL bytes, a folder swapped for a symlink to outside the repo (including swaps injected by a test hook between walk steps, in the regular-file and the symlink branch), a file named `a*.ts` next to `alpha.ts`, and a file named `2:config.ts` are each refused or read literally as specified, and that a final-component symlink answers its target text
- [x] 1.7 Verify the "never interferes" requirement: a test runs `git commit` in the temporary repo while status requests loop, and the commit never fails with `index.lock`
- [x] 1.8 Make the server's settings write a shallow merge that returns the merged object, and use that object for persistence, the theme export and the broadcast; verify with a `config` test that an older client's blob without `scmRepos` or `themeMode` leaves both in place, and a handler test that a partial save without `themeId` keeps a non-default theme and its generated exports
- [x] 1.9 Add stage, unstage and restore as index transactions under git's lock protocol (exclusive lock file, temp index copy, before/after read from the copy, `update-index --add --cacheinfo` / `--force-remove`, fsync + rename; lock removed on any failure; split index refused), staging only from a cached snapshot `token` (repo + path + type/mode + canonical id + `attrs`), attributes re-checked, bytes written with `hash-object -w --no-filters` and the oid verified, receipts held server-side under an opaque `receiptId` with restore as a compare-and-swap, `410 token` for an expired token, lock paths unlinked on shutdown and on `process.on('exit')`, a D/F refusal as 409; verify with route tests for an untracked file, unstaging a deletion, a rename, a HEAD-less unstage, Undo restoring a partial stage byte for byte, Undo refused with 409 after another writer changed the entry, a held lock answering 409 without waiting, a changed attribute context answering 409, two snapshots with equal content and different modes staging their own modes, an over-limit or converted file being refused, an expired token answering 410, and a lock left by a killed write being removed at exit
- [x] 1.10 Document the routes, the trust model, the limits and the poll contract in `CLAUDE.md` (a "Source Control" section), rewrite the "Rollout: older bundles erase the new keys" paragraph for the merge, and verify `yarn typecheck` and the server tests pass

## 2. Server: comments store

- [x] 2.1 Add the comments store under `<configDir>/.cache/scm/` (per-repo file named by a sha256 prefix, atomic writes, per-file mutex) and create `.cache/.gitignore` holding `*` with the directory; verify with tests that a fresh config dir gets both and that the root `.gitignore` is untouched
- [x] 2.2 Add comment create, update and delete routes, validating every field (path inside repo, version and side enums, line ranges, body size cap), with a `rev` bumped on every write; every mutation answers with the whole comment list and its `rev`, every write broadcasts `scmComments { repo, rev }` on the control socket (new frame in `shared/protocol.ts`), and status answers carry `commentsRev`; verify with route tests for two interleaved writers whose final lists both contain each other's change, and a protocol test for the new frame
- [x] 2.3 Document the store layout and the `.cache` boundary in `CLAUDE.md`'s config-dir section and verify the docs match the test fixtures

## 3. Protocol: the review tab kind

- [x] 3.1 Add `review` to `TabKind` and `isTabKind` in `shared/src/protocol.ts`, gate `changes:<abs>`/`staged:<abs>` urls in the server's `createTab`/`updateTab`, persist the kind in `tabs.json`, and make review creation idempotent on the server (an existing canonical url returns its tab id; `updateTab` refuses a url another tab holds) as a cross-window backstop; verify with protocol and server tests that a bad url is refused, two concurrent creates yield one tab, and a review tab survives a registry restore
- [x] 3.2 Add the review tab's `displayTitle` (`Changes · <name>` / `Staged · <name>`) and kind icon on the client and verify with `tab-meta` tests

## 4. Kit: scroll primitives

- [x] 4.1 Add `@radix-ui/react-scroll-area` and `react-window@2.3.3` to `packages/client` and verify `yarn install` and `yarn typecheck` succeed
- [x] 4.2 Build `ui/ScrollArea.tsx` and `ui/VirtualList.tsx` (dynamic row heights, overscan, thin token-coloured scrollbar) with their rules in `ui.css`; verify with kit tests that 10,000 rows mount fewer than 100 elements, that a row growing pushes the rest down, and that `ui.test.tsx` and `scale.test.ts` pass with no colour literal and no off-scale size
- [x] 4.3 Document the two primitives in `CLAUDE.md`'s kit section, including why the virtual list is its own scroll container

## 5. Client: projects, status and the Source Control view

- [x] 5.1 Add `scmRepos` to `SYNCED_KEYS` (canonicalised with `normalizePin`) and the local `scmActiveRepo`, `scmLayout`, `scmAlgorithm` and `scmWrap` settings with sanitisers; verify with `settings.test.ts` that the local keys never sync and old blobs still parse
- [x] 5.2 Build the per-window status store and `useScmStatus(repo, visible)` (only subscribers of the active project count, visible ones only, `document.visibilityState`, one request in flight, `max(1000, 3 × tookMs)` capped at 10 s, immediate refresh on return, `commentsRev` change triggers a comments refetch); verify with fake-timer tests that a hidden subscriber and a visible subscriber of a non-active project trigger no request, and that two visible subscribers share one timer
- [x] 5.3 Build the Source Control view body: empty state, project selector (add with server validation, switch, remove), Merge Changes, Staged Changes and Changes groups with status, directory and file icon, truncation notice; verify with component tests for each spec scenario of `source-control`
- [x] 5.4 Add the dock view and the rail entry between Explorer and Dictation (`DOCK_VIEWS`, `dock-rail-scm`) and verify with `DockPanel` tests that the rail order matches the modified `sidebar-dock` requirement
- [x] 5.5 Update `CLAUDE.md` (dock views, rail order) and `tips/tips.ts` with the new view, and verify the tips test passes

## 6. Client: the review pane

- [x] 6.1 Write the pure rows model: unified rows, split pairing per change block, gaps between hunks with expansion steps, notices for binary, too-large, rename and symlink, placeholders with estimated heights; verify with unit tests over parsed hunks for each case and correct old/new line numbers after an expansion
- [x] 6.2 Build the review pane on `VirtualList`: file headers with counts and collapse, the current-file bar from `onRowsRendered`, automatic layout at 720px reported only on crossing, the Wrap toggle (split always wraps), and `visible` from `PaneHost`; verify with component tests and a `PaneHost` test that a hidden review issues no request
- [x] 6.3 Add fetching near the visible range (two files either side, four requests at a time) with the 60-file / 40 MB LRU returning evicted files to measured placeholders; verify with tests that a 400-file group fetches only nearby diffs and that eviction keeps the scroll offset
- [x] 6.4 Wire live refresh: refetch a loaded file when its fingerprint changes, and every loaded file when `attrEpoch` changes (per-file generations, stale answers dropped), add and remove files as the group changes, and relocate the first visible row by text and context with its pixel offset after each rebuild; verify with tests that an edit below the viewport leaves the visible lines in place, ten lines inserted above keep the same code in view, a deleted anchor line falls back to its nearest surviving neighbour, and a slow stale answer never replaces a newer one
- [x] 6.5 Never send `createTab` for a review url live in the tab list (select it and hand over the scroll target) and guard the `tabCreated` dissolve to ids that are not a live tab of the expected kind and url; verify with a test that opening another file of a review held in a split keeps the split
- [x] 6.6 Add the paused state for a visible review of a non-active project ("Paused · make <name> active"), make focusing a review set the active project, show "Project removed" for a removed project, and add the layout and algorithm controls (per device) that keep the current file in view on switch, and opening a file from the Source Control view focuses the existing review tab and scrolls to it; verify with tests for both `diff-review` scenarios of "A review opens in the content area"
- [x] 6.7 Document the review pane (rows model, fetching, memory bounds) in `CLAUDE.md`

## 7. Client: colouring and inner marks

- [x] 7.1 Colour each side's full content with `monaco.editor.colorize` and `languageOf`, plain-first then swapped without height change, per-file `requestIdleCallback`, plain above 20,000 lines or 1 MB; verify with tests that a line inside a block comment that starts outside the hunk is coloured as a comment and that a terminal-only session loads no monaco chunk
- [x] 7.2 Turn the `monaco-theme.ts` bridge into a subscription list (`onEditorProfile` returns an unsubscribe, registration order, the loader's `applyTheme` first) and repaint review panes through it; verify with a test that an editor and two review panes all update on one profile change and an unmounted pane stops listening
- [x] 7.3 Implement inner marks for paired lines (word/punctuation tokens, LCS bounded to lines under 400 characters and 10,000 cells) and verify with unit tests for the renamed-variable scenario and the over-bound fallback

## 8. Client: navigation, stage and open file

- [x] 8.1 Implement next/previous change across files and next/previous file (fetching an unloaded target before scrolling) and add the `openSourceControl` (Ctrl+Alt+G), `scmNextChange` (Ctrl+Alt+J), `scmPrevChange` (Ctrl+Alt+Shift+J), `scmNextFile` (Ctrl+Alt+N) and `scmPrevFile` (Ctrl+Alt+Shift+N) actions; verify with tests that next change at a file's last change lands on the next file's first change, that the keybindings appear in the palette, and that every default chord is unique (`copyLastOutput` keeps Ctrl+Shift+G)
- [x] 8.2 Add Reviewed (Changes: stage the shown version, then the next file; on `410 token` refetch and retry once, transparently, when the version is unchanged) and Unstage (Staged), the 6-second Undo toast, the busy and changed notices, the `scmReviewed` action (Ctrl+Alt+Enter), and Open file reusing the editor-tab focus rule; verify with tests for every `diff-review` scenario of "Reviewing a file stages it and moves on" and "A staged file can be unstaged", and "Opening the file"
- [x] 8.3 Update `CLAUDE.md` and `tips/tips.ts` for the review keybindings and verify the keybinding-aware tips test passes

## 9. Client: comments

- [x] 9.1 Write the pure anchoring function (every candidate scored by context then distance, the old position included, outdated on no match or a tie) and the markdown exporter; verify with unit tests for "Lines inserted above", "The code is deleted", repeated `}` and blank-line anchors that must move with their context, and the export scenario
- [x] 9.2 Replace comment state with each mutation's authoritative answer, refetch on an `scmComments` frame (or a status `commentsRev`) newer than the applied `rev` while the project is active and visible, and drop older responses; verify with tests for the interleaved add/delete case and a 900 ms status repository still converging within 2 seconds
- [x] 9.3 Draw each comment on whichever side of the open review its lines and context anchor in (its own version's side preferred); verify with a test for "A comment survives Reviewed"
- [x] 9.4 Build range selection on line numbers (drag and shift-click on desktop, tap-then-tap on mobile), the inline comment editor with drafts that survive scrolling, edit and delete with the one-time confirm, and the outdated list; verify with component tests for each `review-comments` scenario
- [x] 9.5 Add Copy comments to the Source Control view and verify with a test that the clipboard receives the exported document
- [x] 9.6 Document comments (storage, versions, anchoring, export) in `CLAUDE.md`

## 10. Mobile

- [x] 10.1 Add the Source Control segment to the drawer switcher (`hostedViews`, `git-branch` icon) and close the drawer through `closeDrawer()` when a file is chosen; verify with `SessionDrawer` tests and a 390px layout check that four segments and both side controls fit without truncation
- [x] 10.2 Add `ReviewBar`, rendered in the extra-keys bar's slot while the active tab is a review (files, ↑ previous file, ↓ next file, ✓ Reviewed or ↩ Unstage; no terminal keys); with buttons at `--ctl-h` and no `press*` helper: one release-time tap/swipe classifier (pointerdown only records; release inside the slop acts; a swipe or cancel acts on nothing; `consumeGesture` on the acting release; `detail === 0` clicks act once); verify with tests that the extra-keys bar is not rendered for a review tab and returns for a terminal, that each button acts on a tap, and that a swipe starting on every button, in both directions, activates none of them
- [x] 10.3 Give `ReviewBar` the extra-keys bar's swipes (right→left opens the drawer; left→right returns to the tab active before the review, or the first terminal), recording that tab when a review becomes active; verify with tests for both scenarios of "The review bar keeps the bar's swipes"
- [x] 10.4 Use `pressMove` for every list row and make the comment textarea keep focus, returning it to `#mobile-kbd` only when it held focus before; verify with tests that a pan never activates a row
- [x] 10.5 Update `CLAUDE.md`'s mobile and drawer sections (including the "extra-keys bar is ALWAYS present" paragraph, now "a bar with the drawer swipe is always present") and `tips/tips.ts`

## 11. Integration

- [x] 11.1 Run `yarn typecheck`, `yarn test` and `yarn lint` and verify all pass
- [x] 11.2 Smoke the whole flow on an isolated smoke server (disposable config dir, HOME, TMUX_TMPDIR and cwd, port 44099) against a temporary repository: add project, live edit within 2 s, review both layouts, comment, export, Reviewed with Undo, Unstage; verify with screenshots at 1440px and 390px
- [x] 11.3 With the owner's approval, restart the production palmux service for the server routes, then build the client dist; verify `/scm/status` answers through `palmux.dgsl.pt` and the rail shows Source Control
- [ ] 11.4 On the S26, review a change set of at least 50 files, measure that colouring never blocks a frame for more than 50 ms, and confirm typing a comment does not dismiss or fight the keyboard

## Workflow follow-up

- Archive the change after every batch has passed its plan review, build and fresh inspection.
- Sync the delta specs into `openspec/specs/` at archive.

## 12. Tree view in the Source Control list

- [x] 12.1 Build the pure tree model (path-ordered nodes, compact single-child folder chains, file counts, flattening that honours collapsed folders) and its per-device collapse store (`localStorage`, keyed by project and group, forgiving parse); verify with unit tests for ordering equal to the review's, compaction, collapse hiding descendants, and persistence across a reload
- [x] 12.2 Render each group as the tree in `SourceControlView` (folder rows with chevron, folder icon, name, count, `aria-expanded`, Enter/Space and ArrowLeft/ArrowRight; file rows indented by depth; `pressMove` rows; `VirtualList` for long groups) with a per-device list/tree toggle (`scmTree`, default tree) in the view bar; verify with component tests for every scenario of "Changed files can be browsed as a tree" in the dock and in the drawer
- [x] 12.3 Document the tree in `CLAUDE.md`'s Source Control section and verify the scoped tests, typecheck and lint pass

## 13. Code font size, independent of the terminal

- [x] 13.1 Add the local (never synced) `codeFontSize: number | null` setting (null = follow the terminal; clamped to the terminal font range) with a sanitiser and tests that it never enters `SYNCED_KEYS` or the server blob
- [x] 13.2 Drive the review's code text, line numbers and row metrics from the code font size (row heights recomputed so rows stay aligned and the scroll anchor holds across a change), and add the − / value / + control to the review's view menu (live, menu stays open, keyboard reachable); verify with tests for both diff-review scenarios of "The code font size is adjustable at any time"
- [x] 13.3 Make the Monaco editor follow the code font size live (replacing "terminal size + offset" once set) and add a "Code font size" row to Settings' Appearance card in both hosts; verify with tests for every editor-pane scenario of the modified requirement
- [x] 13.4 Document it in `CLAUDE.md` (Source Control section and the Monaco editor notes) and verify scoped tests, typecheck and lint

## 14. Compact density on the phone

- [ ] 14.1 Drawer top row: remove the close control and put the settings entry at the row's right end (closing stays: scrim strip, swipe, every leaving action); session rows and group headers compact on a phone (at most 32px, 13px text) without changing kit controls elsewhere; verify with SessionDrawer tests for the modified and added mobile-drawer requirements and a 390px fit check
- [ ] 14.2 Source Control rows compact on a phone (at most 32px, 13px text, narrower indent); verify with tests for "The changed-files list is compact on a phone"
- [ ] 14.3 Review compact on a phone: gap rows and hunk headers at most 28px with small controls, a compact file header, a review bar no taller than the extra-keys bar, row metrics kept exact so anchoring and landing still hold; verify with tests for "The review wastes no height on a phone" and the existing landing tests
- [ ] 14.4 Update CLAUDE.md (drawer top row and sizing, mobile density of Source Control and the review) and verify scoped tests, typecheck and lint
