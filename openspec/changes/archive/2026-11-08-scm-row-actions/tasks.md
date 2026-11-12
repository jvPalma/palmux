# Tasks

Decisions live in `design.md` (D1 to D12); a task cites the decision it builds. Spec scenarios are in
`specs/source-control/spec.md` (SC) and `specs/diff-review/spec.md` (DR). Gates for every task:
`yarn typecheck`, `yarn lint` (oxlint), and the named tests with `yarn vitest run <files>`.

The `opsx-readiness-reviewer` pass ran before 1.1 (2026-11-08). The build is ledgered in `validation.md`.

## 1. Shared types and the `ready` flag

- [x] 1.1 In `packages/shared/src/scm.ts` add `ScmSkipReason`, `ScmSkip`, `ScmBatchResult`,
  `SCM_BATCH_LIMIT = 5000` and `SCM_SKIP_LABEL` exactly as in D8 (labels: converted "needs a git filter",
  unmerged "unmerged", submodule "a submodule", nested-repo "a nested repository", gone "no longer
  changed", changed "changed since you confirmed", symlink "a symbolic link", special "not a regular
  file", intent-to-add "added with intent to add", rename "a rename", failed "could not be written"), and
  widen `ScmWriteResult.receiptId` to `string | null`. Verify: `yarn typecheck` passes with no other edit
  (callers only pass the id through).
  ✓ Receipt: types + labels in shared; typecheck 0.
- [x] 1.2 In `packages/shared/src/protocol.ts` add `scmBatchWrites?: true` to `ReadyMessage` and parse it
  beside `detachedWindows` (`raw['scmBatchWrites'] === true`). In `packages/server/src/server.ts` send
  `scmBatchWrites: true` in `ready` beside `detachedWindows: true`. Tests: extend
  `packages/server/src/protocol.test.ts` (flag kept when `true`, dropped otherwise). Satisfies SC "An
  older server" (server half). Depends on 1.1.
  ✓ Receipt: `ready.scmBatchWrites` sent and parsed; protocol.test.ts cases pass.

## 2. Batch stage and unstage on the server

- [x] 2.1 In `packages/server/src/scm-index.ts`: export `serialised`; make `readEntries` filter with a
  `Set` and, above 64 paths, run `ls-files -s -z` with no pathspec and `maxBuffer: 64 * 1024 * 1024`;
  generalise `transact` so its middle step is `change(before, copy) => Promise<string[] | ScmFailure>`
  (D5), and port `write()` to it with the existing `decide` + `applyOp` body (no behaviour change). Tests:
  `scm-index.test.ts` keeps passing unchanged; add a case staging and restoring with 100 paths in the
  receipt to cover the no-pathspec read. Depends on 1.1.
  ✓ Receipt: `transact(change)` + Set filter + no-pathspec read above 64 paths; 100-path stage/restore test passes.
- [x] 2.2 In `scm-index.ts` make `restoreReceipt` apply a receipt with more than one entry through one
  `update-index -z --index-info` (stdin lines as D5; a removal is mode `0` and a zero oid of the receipt
  oid's length). Tests in `scm-index.test.ts`: a 100-entry receipt restores every entry in one call
  (spy `runGit` call count), a removal entry deletes the path, a sha256 repository (`git init
  --object-format=sha256`) restores. Depends on 2.1.
  ✓ Receipt: one `--index-info` call for a multi-entry receipt (call-count spy), removal entry, sha256 repo; tests pass. Cannot answer `df` (noted in CLAUDE.md).
- [x] 2.3 In `scm-git.ts` add `gitVersion()` (runs `git version` once, caches `{ major, minor }`) and
  `GIT_BATCH_TIMEOUT_MS = 60_000`. Tests in `scm-git.test.ts`: parses `git version 2.43.0` and
  `git version 2.39.3 (Apple Git-146)`. Depends on nothing.
  ✓ Receipt: `gitVersion()` parses 2.43.0 and Apple Git; `GIT_BATCH_TIMEOUT_MS`.
- [x] 2.4 In `scm-index.ts` add `stagePaths({ top, paths })` per D5: validation (array, 1 to 5,000
  strings, `checkRelPath`, dedupe → 400), the git ≥ 2.26 check (501 `unsupported`), classification
  (`check-attr -z --stdin filter working-tree-encoding ident`; status `merge` → `unmerged`, trailing `/`
  → `nested-repo`, not in `changes` → `gone`; BEFORE mode `160000` → `submodule`), then `git add
  --pathspec-from-file=- --pathspec-file-nul --` on the copy with `GIT_INDEX_FILE` and
  `timeoutMs: GIT_BATCH_TIMEOUT_MS`, a rename's `oldPath` added to the pathspec. Answer
  `ScmBatchResult` (`staged`, `receiptId` null when nothing changed). Tests in `scm-index.test.ts`: a
  modified, a deleted and an untracked file stage in one call; a CRLF work-tree file under
  `core.autocrlf=true` stages LF (git's conversion); a path with `filter=lfs` in `.gitattributes` is
  skipped `converted` and no filter command runs (a filter driver that touches a marker file; the marker
  stays absent); an unmerged path is skipped; `a*.ts` stages only itself; 5,001 paths → 400; an existing
  `index.lock` → 409 `busy`; the receipt's Undo restores every entry. Satisfies SC "A list stage takes the
  file as it is on disk", "A file that needs a git filter is skipped", "Unmerged files, submodules and
  nested repositories are skipped", "The index is busy", "A batch over the limit", "A file name with
  pattern characters". Depends on 2.1, 2.3.
  ✓ Receipt: `stagePaths`; CRLF→LF, LFS marker never touched, unmerged/`a*.ts`/5001/busy cases pass. Review fixes B4, B5, B7, B11 (classify on disk and under the lock, no hooks, stale = `gone`), each test-first.
- [x] 2.5 In `scm-index.ts` add `unstagePaths({ top, entries })` per D5 (`restore --staged` with HEAD,
  `rm --cached -r -q --ignore-unmatch` when unborn; `oldPath` only when a real rename source). Tests: a
  staged modification, a staged addition and a staged rename (both sides) return to HEAD in one call; an
  unborn repository removes the entries; the work tree is byte-identical before and after (hash every
  file). Satisfies SC "The write surface" (unstage half). Depends on 2.1, 2.3.
  ✓ Receipt: `unstagePaths`; modification, addition, rename, unborn (`rm --cached -f`, B6); work tree hashes equal before/after.
- [x] 2.6 In `server.ts` make `indexWrite` generic over its result, add `POST /scm/stage-paths` (`{ paths
  }`) and `POST /scm/unstage-paths` (`{ entries }`), and add `auditScm(op, fields)` printing D12's
  `console.info` line for each success and refusal (stage and unstage report `lockMs`: `transact` returns
  it in `Committed`). Tests in `scm-routes.test.ts`: both routes answer `ScmBatchResult`, a relative
  `repo` is 400, a malformed body is 400, and one audit line per call (spy `console.info`, assert the
  `scm: stage-paths repo=… done=… skipped=… receipt=… lockMs=… ms=… paths=…` shape and the ten-path
  cap). Depends on 2.4, 2.5.
  ✓ Receipt: routes + `auditScm`; routes test asserts the audit line shape and ten-path cap; refused repo audited (B8). e2e audit line `scm: stage-paths … lockMs=26 … (+30)`.

## 3. Discard and its Undo on the server

- [x] 3.1 In `scm-snapshot.ts` give `readWorkTree` an optional `limit` (bytes, default
  `SIDE_LIMIT_BYTES`) and export the walk helpers the discard needs: `openParent(top, path)` (the
  descriptor of the file's directory, refusing links with 403) and `statAt(parentFd, name)`. Tests in
  `scm-snapshot.test.ts`: a 2 MB file reads in full with `limit: 64 MiB` and as `big` without it; the
  existing link-swap tests pass for the new helpers through `walkHooks.onStep`. Depends on nothing.
  ✓ Receipt: `readWorkTree` limit + walk helpers; 2 MB read and link-swap tests pass.
- [x] 3.2 Create `packages/server/src/scm-discard.ts` with `discardPaths({ top, entries })` per D6
  (steps 1 to 9) under `serialised(top)`, and the receipt store per D7 (`d` prefix, `DISCARD_RECEIPT_MS =
  600_000`, `DISCARD_RECEIPT_MAX = 20`, a `discardHooks.beforeWrite` test seam). Create
  `scm-discard.test.ts` in a temp repository: a modified tracked file returns to its INDEX version while
  its staged change stays (`git diff --cached` unchanged); a work-tree deletion (`D`) comes back; an
  untracked folder `tmp/out` with three files is deleted along with emptied `tmp/out` and `tmp`, while a
  sibling folder holding an ignored file stays; an entry whose `fp` differs is skipped `changed`; a file
  rewritten in `beforeWrite` is skipped `changed`; a symbolic link, a FIFO, a submodule and an LFS-filtered
  file are skipped with their reasons; a 65 MiB file refuses the whole request with 413 and nothing
  changes; a link swapped into the path through `walkHooks.onStep` writes nothing outside the project;
  `git cat-file -e <before oid>` succeeds for every changed file BEFORE `checkout-index` runs (assert in
  `beforeWrite`); `git diff --cached` and the index file's bytes are unchanged by every discard. Satisfies
  SC "A discard keeps staged changes", "An agent writes after the confirm", "Discarding an untracked
  folder", "The backup exists before the write", "A large file is not discarded", "A link or special file
  is not discarded", "A folder swapped for a link". Depends on 3.1, 2.1.
  ✓ Receipt: `discardPaths`; every listed case passes. Write path replaced per B1→B10 (raw blob + `checkoutBytes`, 720-case equivalence with `checkout-index`), probe before status (B2), `.palmux-<16hex>` temp (B12).
- [x] 3.3 In `scm-discard.ts` add `restoreDiscard({ top, receiptId })` per D7 (compare all, then swap;
  missing parents created; mode restored; consumed on success; 409 `conflict` keeps the receipt; 410
  `token` when unknown or expired; 400 for another project). Tests in `scm-discard.test.ts`: exact bytes
  and mode back after a discard of a `100755` file; deleted untracked files and their folders exist again;
  a recreated file makes Undo 409 and the receipt works once the file is removed again; an expired receipt
  (fake timers past 10 minutes) is 410; a second Undo of the same receipt is 410; 21 discards evict only
  the oldest discard receipt, and 64 MB of index receipts evict none. Satisfies SC "Undo from the toast",
  "The files changed since", "The receipt is gone", "A receipt is used once". Depends on 3.2.
  ✓ Receipt: `restoreDiscard`; bytes + mode back, folders recreated and removed (B12), 409 keeps the receipt with a partial count (B3), 410 expired/second use, 21st discard evicts only the oldest.
- [x] 3.4 In `server.ts` add `POST /scm/discard` (`{ entries: { path, fp }[] }`) and make `/scm/restore`
  dispatch by prefix (`r` → `restoreReceipt`, `d` → `restoreDiscard`, else 410 `token`), with `auditScm`
  lines for `discard`, `restore-discard` and their refusals. Tests in `scm-routes.test.ts`: discard then
  restore round-trips through the routes; an unknown prefix is 410; audit lines as D12. Satisfies SC
  "Every discard is logged", "The write surface". Depends on 3.3, 2.6.
  ✓ Receipt: `/scm/discard` + prefix dispatch; round-trip and unknown-prefix 410 tests; e2e `scm: discard … receipt=d…` and `restore-discard … status=200`.

## 4. Client API and Undo bookkeeping

- [x] 4.1 In `packages/client/src/scm/scm-api.ts` add `stageScmPaths`, `unstageScmPaths`,
  `discardScmPaths` and `parseBatchResult` (D8); let `restoreScmWrite` accept `receiptId: null`. Tests in
  `scm-api.test.ts`: each posts the body of D8 to its route with `?repo=`; a malformed answer is a
  failure; a 409 keeps its `code`. Depends on 1.1.
  ✓ Receipt: API wrappers + `parseBatchResult`; scm-api.test.ts cases pass.
- [x] 4.2 In `review/write-log.ts` add `count?: number`, `via?: 'list'` and `action: 'discard'`; in
  `review/review-writes.ts` update `describeWrites` to D9's wording (skips included through a new
  optional `skipped?: ScmSkip[]` on `LoggedWrite`) and `undoWrites`' conflict text for a discard. Tests in
  `write-log.test.ts` and `review-writes.test.ts`: "Reviewed a.ts", "Staged a.ts" (via list), "Staged 40
  files", "Staged 40 files, discarded 2 files", "Staged 38 files, skipped 2 (needs a git filter)", and
  the existing cases unchanged. Depends on 1.1.
  ✓ Receipt: D9 wording, all listed strings asserted; discard conflict keeps the server count (main-loop fix, test first).
- [x] 4.3 Create `scm/discard-log.ts` per D9 (`readLastDiscard(top)`, `recordDiscard(top, { receiptId,
  at, count })`, `forgetDiscard(top, receiptId)`, `subscribeDiscards(cb)` with a `storage` listener,
  `DISCARD_UNDO_MS = 600_000`) and `discard-log.test.ts`: forgiving parse of junk, a storage exception is
  swallowed, a newer discard replaces the older, expiry hides the entry, a `storage` event notifies.
  Depends on nothing.
  ✓ Receipt: `discard-log.ts` + tests (junk parse, storage throw, replace, expiry, `storage` event).

## 5. The Source Control list

- [x] 5.1 In `ui/Collapsible.tsx` add `size: 'sm'` and in `ui/ui.css` `.ui-collapsible-trigger-sm {
  min-height: calc(var(--ctl-h) - var(--sp-1)); }` (D1). Tests: `ui/scale.test.ts` resolves the new class
  through `boxOf` to 24px on a desktop (add the case beside `-xs`); `ui.test.tsx` passes. Depends on
  nothing.
  ✓ Receipt: `size="sm"` Collapsible; scale.test resolves 24px desktop.
- [x] 5.2 In `scm/scm.css` set the desktop `--scm-row-h`, `--scm-indent`, `--scm-gap` per D1, and in
  `SourceControlView.tsx` `GroupSection` use `size={compact ? 'xs' : 'sm'}`. Tests: update the density
  case in `SourceControlTree.test.tsx` (it resolves the sheets) so the desktop resolves 24px rows, 8px
  indent and 24px headers, and the phone stays 24px / 8px; `ui/scale.test.ts` passes. Satisfies SC "A
  deep tree on a desktop", "A deep tree on a phone". Depends on 5.1.
  ✓ Receipt: desktop 24px / 8px / 4px; density test updated; e2e 24px rows, folders and headers at 1440 and 390.
- [x] 5.3 Create `scm/row-actions.ts` with `rowActions(group, row, ctx)` and `discardConfirmText(names,
  untrackedCount)` per D2, D9 and D10 (`ctx`: `{ top, entries, truncated, busy, canWrite, openPath }`;
  a folder collects every entry of the group under `<folder>/`). Create `row-actions.test.ts`: the table
  of SC "Each group offers its own row actions" (Merge file → open; Staged file → open, unstage; Staged
  folder → unstage all; Changes file → open, stage, discard with Discard last and `danger`; Changes folder
  → stage all, discard all); Open file disabled on `D` with "The file is deleted"; folder actions disabled
  with the truncated reason; a folder collects collapsed descendants; the confirm text for one file, for
  12 files (ten names and "…and 2 more") and with untracked files. Satisfies SC "The actions of a changed
  file", "The actions of a staged folder", "A conflicted file", "A deleted file cannot be opened", "A
  truncated list", "Confirming a discard" (text). Depends on 1.1.
  ✓ Receipt: `rowActions` + `discardConfirmText`; the SC table, deleted-file and truncated reasons, 12-file text tested.
- [x] 5.4 In `SourceControlView.tsx` restructure `FileRow`, `FolderRow` and the virtual row into D2's
  `.scm-item` wrapper (the main button keeps its classes, `pressMove`, test ids and keyboard handling),
  render `.scm-actions` from `rowActions`, wrap each item in `ui/ContextMenu` with
  `testidPrefix="scm-menu"` and D3's two guards, and add `.scm-item`, `.scm-actions`, `.scm-actions-sep`
  and the `data-danger` hover to `scm.css` (colours from `--t-*` only). Render actions only when the new
  prop `batchWrites` is true. Tests in `SourceControlView.test.tsx`: hover shows the three actions on a
  Changes file and none when `batchWrites` is false; Tab from the row reaches each action and Enter runs
  it without calling `onOpenFile`; right-click opens the menu with the same items; a long-press (fake
  timers, touch pointer) opens the menu and its release does not call `onOpenFile`; a touch pan over the
  row is not prevented; under `data-mobile` no inline action renders. Satisfies SC "Hovering a changed
  file", "Keyboard focus shows the actions", "Long-press on a phone", "An older server" (client half).
  Depends on 5.3.
  ✓ Receipt: `.scm-item` / `.scm-actions` / ContextMenu with the press guard (B9); tests for hover, Tab, right-click, long-press, pan, `data-mobile`. e2e: hover, focus, right-click, long-press, swipe all PASS.
- [x] 5.5 Wire the writes in `SourceControlView.tsx`: Stage / Stage all → `stageScmPaths`, Unstage /
  Unstage all → `unstageScmPaths`, Discard / Discard all → `window.confirm(discardConfirmText(…))` then
  `discardScmPaths` with each entry's listed `fp`; after each answer `recordWrite({ …, via: 'list', count,
  skipped })`, `onNotify(describeWrites(recent), { label: 'Undo', onClick })` with `undoWrites`, refresh
  the status store, and for a discard with a receipt `recordDiscard`. Failures go to `onNotice` through
  `describeFailure`. Add props `onOpenPath`, `onNotify`, `batchWrites`; in `App.tsx` pass, in both hosts,
  `onOpenPath={(path) => openFileTab(path, { preview: true })}` (D4), `onNotify={showToast}` and
  `batchWrites={capScmBatch}` (a new `capScmBatch` state set from `msg.scmBatchWrites === true` beside `setCapDetached`, `App.tsx:1918`). This task depends on `preview-tabs` task 3.2 (the contract's `openFileTab(path, opts?: { preview?:
  boolean }): 'opened' | 'held'`); implement that task first if it has not landed. Tests in `SourceControlView.test.tsx` (mocked API):
  Stage all on a folder posts every descendant path once and toasts "Staged 40 files" with Undo, and Undo
  calls `restoreScmWrite`; Cancel on the confirm posts nothing; Discard posts each `fp`; a skip is in the
  toast; in `App.test.tsx`: Open file calls `openFileTab` with `{ preview: true }`. Satisfies SC "Staging
  a folder", "Skips are reported", "Confirming a discard", "Open file opens a preview". Depends on 4.1,
  4.2, 4.3, 5.4, 1.2.
  ✓ Receipt: writes wired in both hosts; tests for Stage all, Cancel, `fp`, skips, Open file `{ preview: true }`. e2e: "Staged 40 files" + Undo, "Discarded 3 files", preview tab opened.
- [x] 5.6 Add the Undo last discard button to the project bar in `SourceControlView.tsx` per D9
  (`scm-undo-discard`, `undo` icon, label with the count, visible while the active project's
  `readLastDiscard` entry is younger than 10 minutes, a timer hides it at expiry; tap → `restoreScmWrite`;
  success or 410 → `forgetDiscard`; 410 toasts "This Undo has expired"; 409 toasts the conflict and keeps
  it). The toast's Undo of a discard also calls `forgetDiscard` on success. Tests in
  `SourceControlView.test.tsx` (fake timers): visible after a discard, still visible at 8 minutes and
  restores on tap then hides, hidden after 10 minutes, a 410 hides it with the expired toast, a 409 keeps
  it. Satisfies SC "Undo later from the project bar", "The receipt is gone". Depends on 5.5.
  ✓ Receipt: project-bar Undo with timers; 8 min / 10 min / 410 / 409 tests; both Undos forget both logs (B9). e2e: Undo after reload restored the files on disk.

## 6. The review header and verification

- [x] 6.1 In `review/ReviewRow.tsx` export `ReviewButton` (with an optional `testId` prop, defaulting to
  today's ids) and `STATUS_LABEL`. In `review/ReviewPane.tsx` extend `.rv-current` per D11 when not
  `compact`: state letter and label, counts from the file's status entry, `ReviewButton` with the pane's
  `writes` and `testId` `review-current-reviewed` / `review-current-unstage`, and Open file
  (`review-current-open`, disabled for `D`, same `onOpenFile` handler). Add the bar's layout to
  `review/review.css` (`display: flex`, the path shrinking with an ellipsis, `--sp-2` gaps, no new height).
  Tests in `ReviewPane.test.tsx`: after scrolling past a file's header the bar still offers Reviewed and
  Open file for it; the next file at the top changes the bar; Reviewed in the bar stages, toasts Undo and
  jumps to the next file; tapping the bar's Reviewed shows the file header's button busy too and a second
  tap on either does not call the stage API twice; on a placeholder the bar's Reviewed is disabled with
  the loading reason; with `compact` the bar renders only the path and position (snapshot of its children
  by test id). `review-css.test.ts` passes. Satisfies DR "Scrolling deep into a long file", "The file at the
  top changes", "Reviewed from the bar", "One queue for both headers", "The snapshot is not loaded yet",
  "The phone keeps its label". Depends on nothing in this change.
  ✓ Receipt: bar with status, counts, Reviewed/Unstage, Open file; ReviewPane tests pass. e2e: bar fixed at y=72 through a 23,992px review, follows the top file, Reviewed stages and moves on.
- [x] 6.2 Update `CLAUDE.md` "Source Control": the write surface (the batch routes, the discard and its
  receipt store, the prefix dispatch), D1's density, D2's row structure and D11's header, replacing "The
  three writes, and the only ones" and the "compact on a phone" paragraph's desktop sentence. Verify: the
  paragraphs name `stage-paths`, `unstage-paths`, `discard`, `d` receipts and 24px desktop rows. Depends
  on 3.4, 5.6, 6.1.
  ✓ Receipt: CLAUDE.md Source Control: routes table, "The index writes", batch-write and discard paragraphs, row actions, 24px desktop density; names `stage-paths`, `unstage-paths`, `discard`, `d` receipts, 24px.
- [x] 6.3 Run `yarn typecheck`, `yarn lint` and `yarn test` across the repo. Verify: all pass; paste the
  totals into the task's completion note. Depends on 6.2.
  ✓ Receipt: typecheck 0; lint 0 errors (1141 warnings repo-wide); tests 5048 + 1029 + 45 = 6122 passed. See `validation.md`.
- [x] 6.4 Browser check on the dev server (`./scripts/dev.sh`, never the prod :44040), Chromium at 1440px
  and at 390x844 with touch emulation, on a scratch repository: measure a file row, a folder row and a
  group header at 24px on both; hover shows actions and the name truncates before them; a long-press opens
  the menu and its release opens no review; a vertical swipe starting on a row scrolls the list and opens
  no menu (if it opens one, replace Radix's long-press with the drawer's `LONG_PRESS_MS` row timer as D3
  names, and re-run); stage a folder of 40 files and Undo it; discard a file and an untracked folder, Undo
  from the project bar after a reload. Verify: screenshots and the measured heights in the task's
  completion note. Depends on 6.3.
  ✓ Receipt: :44099 isolated server, scratch repo, 1440 and 390x844 touch; every check PASS, 14 screenshots; details in `validation.md`.

## Workflow follow-up

- Restart the server to ship the routes only with the owner's OK at the time (under systemd it ends every
  live terminal).
- Run `/opsx:verify` before archiving.
