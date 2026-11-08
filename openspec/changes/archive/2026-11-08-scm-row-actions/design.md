# Design: Source Control row actions, live stage, discard with Undo, and a review header that stays

See `proposal.md` for the motivation and `openspec/brainstorms/2026-11-02-v1-3-scm-cli-preview.md`
(items 1 to 6) for the owner's decisions.

## Context

- **Writes today** (`packages/server/src/scm-index.ts`). `serialised(top)` queues palmux's own writes per
  repository. `transact(top, paths, decide)` creates `index.lock` with `O_EXCL` (409 `busy` at once),
  copies the index to a private temp file, reads the BEFORE entries of `paths` (`ls-files -s -z -- <paths>`,
  so the path list rides argv), lets `decide` return `Op[]`, runs one `update-index` per op on the copy,
  reads the AFTER entries, writes the copy into the lock, fsyncs and renames it. `write()` stores a receipt
  (`putReceipt`, prefix `r`) in the shared 64 MB / 10-minute LRU in `scm-snapshot.ts` (`cachePut`), which
  also holds staging tokens (prefix `t`). `restoreReceipt` is a compare-and-swap on index entries.
- **git runner** (`scm-git.ts` `runGit`): argv only, a clean environment, `--literal-pathspecs`,
  10 s timeout (`GIT_TIMEOUT_MS`), 8 MB output cap (`GIT_MAX_BUFFER`), per-call `input`, `env`,
  `okCodes`, `timeoutMs`, `maxBuffer`.
- **Work-tree reads** (`scm-snapshot.ts` `readWorkTree`): a descriptor-relative walk through
  `/proc/self/fd/<fd>/<name>` with `O_NOFOLLOW` on every component, a 1 MB read cap (`SIDE_LIMIT_BYTES`),
  and `walkHooks.onStep` for tests. `isConvertedByGit` / `readAttrContext` read `check-attr`.
- **Status** (`scm-status.ts`): `getStatus(top)` (coalesced, cached 500 ms), `invalidateStatus(top)`,
  `STATUS_ENTRY_LIMIT = 5000`, `truncated`, and an `fp` per entry that changes with any `lstat` change.
- **Client list** (`scm/SourceControlView.tsx`, `scm/scm.css`): `FileRow` and `FolderRow` are `<button>`
  elements activated with `pressMove`; a group over 200 files (`LONG_GROUP_ROWS`) is a `VirtualList`.
  `.scm-view` declares `--scm-row-h`, `--scm-indent`, `--scm-gap`; the phone restates them.
  `GroupSection` uses the kit `Collapsible` with `size={compact ? 'xs' : 'md'}`; the kit only knows
  `'xs' | 'md'`, but `ui/scale.test.ts` `boxOf` already resolves a `-sm` step (`--ctl-h` less `--sp-1`).
- **Review** (`review/ReviewPane.tsx`, `ReviewRow.tsx`): `.rv-current` names the top file and "n / N".
  `FileHeader` holds `ReviewButton` (driven by `writes: ReviewWrites`) and Open file. `write-log.ts` keeps
  the writes of the last 6 s for one shared Undo toast; `review-writes.ts` `describeWrites` names them and
  `undoWrites` restores them newest first.
- **Toast** (`App.tsx` `showToast(msg, action?)`) already takes `{ label, onClick }` and holds an actionable
  toast 6 s.
- **Sibling change.** `preview-tabs` adds the preview open. Its `design.md` section "Contract for
  scm-row-actions and palmux-cli-commands" defines `openFileTab(path: string, opts?: { preview?: boolean }):
  'opened' | 'held'`: `{ preview: true }` opens `path` in the focused pane's preview tab or replaces that
  tab's file, and without `ready.previewTabs` it ignores `preview`. Its caller table names this change's
  Open file as `openFileTab(<abs path>, { preview: true })`. It also edits `SourceControlView.tsx` (an
  "Open review" button on each group header) and keeps the row's click target and `onOpenFile`.

## Goals / Non-Goals

**Goals:**

- One request per folder action, whatever its size, with a bounded lock time.
- A discard never loses bytes palmux did not back up first, and never overwrites a file that changed since
  the user confirmed or since the discard.
- The review's Reviewed is reachable at every scroll position on a desktop.

**Non-Goals:**

- Batching the existing token stage (`/scm/stage`): Reviewed stays one file at a time.
- A server-side list of discards per project: the server keeps receipts, and each device remembers its own
  latest.
- Watching the work tree: the 1 s status poll already refreshes the list after a write.

## Decisions

### D1. Desktop density: 24px rows, 8px indent, a kit `sm` header (decision, flagged for the owner)

The brief targets "about 22px". 22px is off the scale and `ui/scale.test.ts` fails it. The nearest step
written from tokens is `calc(var(--ctl-h) - var(--sp-1))`, which is 24px on a desktop (`--ctl-h` 28px):
the phone's height, so both device classes share one geometry. `.scm-view` becomes:

```css
--scm-row-h: calc(var(--ctl-h) - var(--sp-1)); /* 24px on a desktop */
--scm-indent: var(--sp-2);                     /* 8px */
--scm-gap: var(--sp-1);                        /* 4px */
```

The phone block keeps its own `calc(var(--ctl-h) - var(--sp-3))` (24px at a 36px `--ctl-h`), `--sp-2`,
`--sp-1`. The group headers are kit Collapsible triggers, which a consumer may not size. The kit gains
`size="sm"` (`.ui-collapsible-trigger-sm`, `min-height: calc(var(--ctl-h) - var(--sp-1))`, the step
`boxOf` already knows), and `GroupSection` asks for `compact ? 'xs' : 'sm'`. The owner should check the
result against the VS Code screenshot at 1440px; a 20px row would need `--ctl-h` less `--sp-2`, also on
the scale.

- Rejected: a 22px literal with a `scale-ok` pragma. A pragma is for geometry measured against another
  box, and row rhythm is not that.
- Rejected: restating the header height in `scm.css`. `scale.test.ts` fails a consumer that sizes a kit
  control.

### D2. Row structure: a wrapper with a main button and sibling actions

A `<button>` cannot contain buttons. Each row becomes:

```html
<div class="scm-item" data-testid="scm-item">      <!-- ContextMenu trigger (asChild) -->
  <button class="scm-row | scm-folder" …>…</button>  <!-- unchanged content, pressMove -->
  <span class="scm-actions" role="group" aria-label="Actions for <name>">
    <IconButton size="sm" …/> …                      <!-- desktop only -->
  </span>
</div>
```

- `.scm-item` is `display: flex; height: var(--scm-row-h)`; the main button takes `flex: 1 1 auto;
  min-width: 0`, so its name truncates before the actions.
- `.scm-actions` is `display: none` and becomes `display: flex` on `.scm-item:hover` and
  `.scm-item:focus-within`. Focus on the main button therefore shows the actions, and Tab reaches them.
  Under `:root[data-mobile='true']` it is always `display: none`: a phone uses the menu.
- Each action is a kit `IconButton size="sm"` with `pressMove`, so a release never reaches the row button
  (the buttons are siblings, not children), and Enter or Space is the button's own click.
- Discard is last, preceded by a 1px `.scm-actions-sep` with `--sp-1` margin, and carries `danger` (the
  menu item's `danger: true`, and `data-danger` on the button for its hover colour from `--t-*`).
- Icons from `ui/icons.tsx`: Open file `external`, Stage `plus`, Unstage `eject`, Discard `undo`. There is
  no "minus" glyph, and `undo` is VS Code's discard glyph too.
- Test ids: `scm-action-open`, `scm-action-stage`, `scm-action-unstage`, `scm-action-discard`, and in the
  menu `scm-menu-<id>` (the `ContextMenu` `testidPrefix` is `scm-menu`).

The actions per row come from one pure function, `rowActions(group, row, ctx)` in a new
`scm/row-actions.ts`, returning `RowAction[]` (`{ id: 'open' | 'stage' | 'unstage' | 'discard', label,
icon, danger?, disabled?: string /* reason */, run }`). The same list renders the buttons and the
`ContextMenuItemSpec[]`, so the menu and the buttons cannot disagree. Labels: "Open file", "Stage",
"Unstage", "Discard changes" (files); "Stage all", "Unstage all", "Discard all" (folders). Disabled
reasons: "The file is deleted" (Open file on `D`), "The list is truncated: stage this folder from a
terminal" (folder actions while `status.truncated`), "Writing…" (while a write on this project is in
flight), and "Make <name> active to change it" (a paused review's project is never written; the view only
shows the active project, so this never shows in practice and is not tested).

### D3. Long-press and right-click: the kit `ContextMenu`

`.scm-item` is wrapped in `ui/ContextMenu` (Radix ContextMenu: right-click, and a touch long-press). Two
guards keep the press that opened the menu from also opening the review:

- `onOpen` calls `consumeGesture()` (`panes/press.ts`), which swallows that gesture's compatibility
  mousedown, mouseup and click.
- `onOpen` also sets `menuOpenedRef.current = true`; the main button's `pressMove` activation returns
  early when it is set, and the next `pointerdown` on the row clears it.

A pan that starts on a row still scrolls: neither guard prevents a touch `pointerdown`. ASSUMED, not
measured: Radix cancels its long-press timer on `pointermove` past its own threshold. Task 6.4 verifies
it in Chromium with touch emulation.

### D4. Open file calls the preview entry point

`SourceControlView` gains `onOpenPath?: (absolutePath: string) => void`. `App` passes
`(path) => openFileTab(path, { preview: true })` in both hosts (dock and drawer). The absolute path is
`top === '/' ? `/${path}` : `${top}/${path}``, the form `FileHeader` already builds. When the prop is
absent the action is not offered.

This depends on `preview-tabs` having added the options argument to `openFileTab`. Task 5.5 states that
ordering. Without `previewTabs` in `ready`, `preview-tabs` itself makes `openFileTab` open a normal tab, so
this change needs no fallback of its own. The return value (`'opened' | 'held'`) is ignored: a held file
already toasts inside `openFileTab`. The row's main button keeps `onOpenFile` and its click target, as the
contract requires, and the actions sit beside it, never inside it.

### D5. Live stage and unstage: git's own commands on the private copy

`transact` is generalised: its middle step becomes `change(before, copy): Promise<string[] | ScmFailure>`,
which returns the paths it touched. The existing single-file writes keep their `decide` + `applyOp` body
as one implementation of `change`. Two new exports:

- **`stagePaths({ top, paths })`**:
  1. Validate: `paths` is a non-empty array of at most 5,000 strings, each passing `checkRelPath`
     (otherwise 400, nothing done). Duplicates are dropped.
  2. Classify, before taking the lock:
     - `git check-attr -z --stdin filter working-tree-encoding ident` over the paths. A path whose
       `filter` is set (not `unspecified` or `unset`), whose `working-tree-encoding` is set, or whose
       `ident` is `set` is skipped as `converted`.
     - The current status entry of each path (`getStatus` after `invalidateStatus`): in `merge` →
       `unmerged`; listed with a trailing `/` → `nested-repo`; not in `changes` → `gone`.
     - The index entry mode `160000` (from the BEFORE read) → `submodule`.
  3. Under `transact`, with `GIT_INDEX_FILE=<copy>`:
     `git add --pathspec-from-file=- --pathspec-file-nul --` with the remaining paths on stdin
     (NUL-separated), `timeoutMs: GIT_BATCH_TIMEOUT_MS` (60 s). A rename entry's `oldPath` is added to
     the pathspec too. `git add` with a literal pathspec stages a deletion as a removal (git ≥ 2.0).
  4. The receipt records BEFORE and AFTER for every path in the pathspec whose entries differ.
- **`unstagePaths({ top, entries: { path, oldPath? }[] })`**: same validation and cap. Under `transact`:
  - HEAD exists: `git restore --staged --pathspec-from-file=- --pathspec-file-nul` on the copy.
  - Unborn HEAD (`rev-parse --verify -q HEAD` fails): `git rm --cached -r -q --ignore-unmatch
    --pathspec-from-file=- --pathspec-file-nul`.
  - An `oldPath` joins the pathspec only where today's `unstageFile` treats it as a real rename source
    (absent from the index, present in HEAD).
- **git version.** `--pathspec-from-file` exists on `add` since 2.25 and on `restore` since 2.26. The
  module reads `git version` once per process (`gitVersion()`, cached) and answers both routes with
  `501 { error: 'palmux needs git 2.26 or newer to stage folders', code: 'unsupported' }` below 2.26.
- **Batched index reads.** `readEntries` with more than 64 paths runs `ls-files -s -z` with no pathspec,
  `maxBuffer: 64 MB`, and filters with a `Set`. With 64 or fewer it keeps the argv pathspec. The
  `paths.includes` filter becomes a `Set` in both cases (it was O(n²)).
- **Batched restores.** `restoreReceipt` applies a receipt with more than one entry through one
  `update-index -z --index-info` on stdin: `<mode> SP <oid> TAB <path> NUL` for an entry, and mode `0` with
  the receipt's zero oid of the same length for a removal. One-entry receipts keep `applyOp`.
- The ignored, never-listed case: `git add` of an ignored path with a literal pathspec fails. It cannot
  happen from the list (status does not list ignored files); if it does, git's error is a 500 and nothing
  is committed, because the copy is discarded.

Rejected:

- **One `update-index --cacheinfo` per path with palmux's own hashing.** It reimplements git's clean
  conversion, which the brief rules out for list actions ("line endings behave as in a terminal"), and
  costs a process per path under the lock.
- **The token snapshot for list actions.** The list never fetched a snapshot; asking for 300 snapshots to
  stage a folder is the cost the owner rejected with "stage live content".
- **`git add` against the real index.** git would take `index.lock` itself, and palmux's queue, receipt and
  busy semantics would not hold.

### D6. Discard: a module that writes the work tree, never the index

New `packages/server/src/scm-discard.ts`, export `discardPaths({ top, entries: { path, fp }[] })`. It runs
under `serialised(top)` (exported from `scm-index.ts`), so it never interleaves with palmux's own index
writes, and takes no `index.lock`: it changes no index entry.

1. Validate as D5 (at most 5,000, `checkRelPath`, duplicates dropped). Otherwise 400.
2. `invalidateStatus(top)`, then `getStatus(top)`. For each entry:
   - not in `changes` → skip `gone`;
   - `fp` differs from the listed one → skip `changed`;
   - status `A` (intent-to-add) → skip `intent-to-add`; status `R` → skip `rename`;
   - path ends in `/` → skip `nested-repo`.
3. Attributes: the same `check-attr` batch as D5 → skip `converted`.
4. For each remaining entry, a descriptor walk (`readWorkTree` with a new `limit` option, default
   `SIDE_LIMIT_BYTES`, here `DISCARD_LIMIT_BYTES = 64 MiB`):
   - a symbolic link on the path or as the file → skip `symlink`; a socket, FIFO or device → skip
     `special`; an index entry of mode `120000` → skip `symlink`; `160000` → skip `submodule`;
   - over 64 MiB → refuse the WHOLE request with `413 { error: '<path> is larger than 64 MiB; discard it
     from a terminal' }` before anything is written.
5. **Backup, before any write.** For each remaining file present on disk: `git hash-object -w --no-filters
   --stdin` with the bytes read through the descriptor (`timeoutMs: 60 s`), giving `before = { oid, mode }`
   (`100755` when the owner exec bit is set, else `100644`). A file deleted in the work tree (`D`) has
   `before = 'absent'`. The bytes leave memory after each file, so memory is bounded by one file.
6. **Write.** Just before writing, `lstat` every remaining file again through the walk; one that no longer
   matches the stat taken at step 4 is skipped as `changed`. Then:
   - tracked (`M`, `D`, `T`): ONE `git checkout-index -f -z --stdin` with those paths on stdin, against the real
     index (read only; `checkout-index` without `-u` writes no index). It applies the eol conversion a
     checkout applies; no filter can run because step 3 skipped every filtered path. git itself refuses to
     write through a symlinked leading directory.
   - untracked (`?`): `unlink('/proc/self/fd/<parentfd>/<name>')`, then `rmdir` each parent through the
     same walk, from the deepest up to (not including) `top`, stopping at the first `ENOTEMPTY`.
7. **After-state.** A restored file is read again through the walk and hashed with `hash-object
   --no-filters --stdin` (no `-w`) for `after = { oid, mode }`; a deleted file has `after = 'absent'`.
8. The receipt holds `{ top, entries: { path, before, after }[] }` for the files actually changed. With
   none changed the answer's `receiptId` is `null`.
9. A write failure at step 6 or 7 (`EIO`, `EACCES`, a git error) skips that file as `failed`, logs its
   errno, and the loop goes on: each file is independent and its backup already exists. The answer is
   still 200 with the receipt for the files that did change. When the one `checkout-index` call exits
   non-zero, step 7 still reads every one of its paths: a path whose state now differs from `before` is
   recorded in the receipt as changed, and the rest are skipped as `failed`.

The discard brings a tracked file to its INDEX version, so staged changes stay (VS Code's "Discard
Changes" under Changes does the same).

Rejected:

- **Backup bytes in RAM.** The brief moved them to the object store: memory would cap the size, and the
  shared LRU would evict them.
- **`git restore --worktree` / `git checkout -- <paths>`.** Both run filters and hooks-adjacent
  machinery a palmux write must not, and neither reports per path.
- **`git clean` for untracked files.** It works on pathspecs that can match more than the confirmed set,
  and it has no per-file skip.
- **`files.ts` `deletePath`.** It is path-based, so a folder swapped for a link mid-request would be
  followed; the descriptor walk cannot be redirected.

### D7. The discard receipt store

A new store in `scm-discard.ts`, separate from the shared LRU: a `Map<string, DiscardReceipt>` with id
`d` + 32 hex characters (`randomBytes(16)`), a 10-minute TTL from creation (`DISCARD_RECEIPT_MS`), and at
most 20 receipts (`DISCARD_RECEIPT_MAX`, the oldest dropped first). Twenty covers several windows and
devices each holding a latest discard in several projects; tokens and index receipts cannot evict it. It is
process memory: a restart drops it, and the confirm says so.

`/scm/restore` dispatches by prefix: `r` → `restoreReceipt` (index), `d` → `restoreDiscard`, anything
else → 410 `token`.

`restoreDiscard({ top, receiptId })`, under `serialised(top)`:

1. Unknown or expired → `410 { error: 'Undo is no longer available.', code: 'token' }`. Another
   project's receipt → 400.
2. **Compare first, for every entry:** the current state through the walk (`absent`, or `{ oid, mode }`
   hashed without `-w`) must equal `after`. Any mismatch → `409 { error: 'The files changed since the
   discard; nothing was undone.', code: 'conflict' }`, and the receipt is kept.
3. **Then swap:** for `before = 'absent'`, unlink. Otherwise create missing parents with `mkdir` through
   the parent descriptor (mode `0o777`, the umask applies), read the blob with `cat-file blob <oid>`, write
   it to `.<name>.palmux-<8 hex>` in the parent through the descriptor, `fchmod` the mode, `fsync`, and
   `rename` over the name through the same descriptor path.
4. Success consumes the receipt and answers `{ receiptId: null, status: 'restored' }`. There is no redo.
5. A failure part way removes the restored entries from the receipt, keeps it for the rest, and answers
   500 naming the path, so a second Undo retries the rest.

### D8. Wire shapes and routes

`packages/shared/src/scm.ts`:

```ts
export type ScmSkipReason =
  | 'converted' | 'unmerged' | 'submodule' | 'nested-repo' | 'gone' | 'changed'
  | 'symlink' | 'special' | 'intent-to-add' | 'rename' | 'failed';
export interface ScmSkip { path: string; reason: ScmSkipReason }
export interface ScmBatchResult {
  receiptId: string | null;            // null when nothing changed
  status: 'staged' | 'unstaged' | 'discarded';
  done: string[];
  skipped: ScmSkip[];
}
// ScmWriteResult.receiptId widens to `string | null` (a discard Undo has no redo).
export const SCM_BATCH_LIMIT = 5000;
export const SCM_SKIP_LABEL: Record<ScmSkipReason, string>; // 'needs a git filter', 'unmerged', …
```

`ScmErrorCode` gains nothing: the refusals reuse `busy`, `conflict`, `token`, `unsupported`, `df`, and a
413 or 400 carries no code.

Routes in `server.ts`, beside the three index writes, all `POST ?repo=<abs top>` through `scmRoute` and
`checkRepo`:

| Route | Body | Answer |
|---|---|---|
| `/scm/stage-paths` | `{ paths: string[] }` | `ScmBatchResult` (`staged`) |
| `/scm/unstage-paths` | `{ entries: { path, oldPath? }[] }` | `ScmBatchResult` (`unstaged`) |
| `/scm/discard` | `{ entries: { path, fp }[] }` | `ScmBatchResult` (`discarded`) |
| `/scm/restore` | `{ receiptId }` | `ScmWriteResult` (now dispatching `r` / `d`) |

The `indexWrite` helper becomes generic over its result type. `ready` gains `scmBatchWrites: true`
(`ReadyMessage.scmBatchWrites?: true`, parsed like `detachedWindows`).

Client `scm/scm-api.ts`: `stageScmPaths(repo, paths)`, `unstageScmPaths(repo, entries)`,
`discardScmPaths(repo, entries)`, each answering `ScmFetchResult<ScmBatchResult>` through the existing
fetch helper and a `parseBatchResult`. `restoreScmWrite` accepts a `null` receipt id in the answer.

### D9. Undo on the client

- **List stage and unstage** join the review's write log. `LoggedWrite` gains `count?: number` (files in
  the write, default 1), `via?: 'list'`, and `action` gains `'discard'`. `describeWrites`:
  - one write: `Reviewed <name>` (stage from a review), `Staged <name>` (stage via list, one file),
    `Unstaged <name>`, `Discarded <name>`; a folder write names its count: `Staged 40 files`;
  - several: the counts summed per action, `Staged 40 files, discarded 2 files`.
  - skips append what was left alone: one file by name (`Discarded 3 files, skipped link.ts (a symbolic
    link)`), several with their one reason (`Staged 38 files, skipped 2 (needs a git filter)`), or with each
    reason and its count in the order met (`skipped 3 (needs a git filter: 2, no longer changed: 1)`).
  `undoWrites` already restores newest first through `restoreScmWrite`, which now reaches both stores.
  Its conflict message for a discard is "The files changed since the discard" (the server's count of what
  was put back is kept when it sends one), and a 410 on a discard receipt says "This Undo has expired" and
  takes the receipt out of the project bar's discard log.
- **The toast.** `SourceControlView` gains `onNotify?: (message: string, action?: { label: string;
  onClick: () => void }) => void`; `App` passes `showToast` in both hosts (it already takes an action).
  `onNotice` stays for plain messages.
- **Undo last discard** (decision, flagged for the owner: **latest only**, not a list). A new
  `scm/discard-log.ts` keeps `localStorage['palmux-scm-last-discard']` = `{ v: 1, byRepo: { [top]: {
  receiptId, at, count } } }` (forgiving parse, swallowed storage errors, the Explorer stores' rule), with
  `subscribe` and a `storage` listener so two windows of one device agree. A discard that answers a
  receipt replaces the project's entry. The project bar shows an `IconButton` (`undo` icon,
  `data-testid="scm-undo-discard"`, label "Undo last discard (<n> files)") while the active project's entry
  is younger than `DISCARD_UNDO_MS` (10 minutes); a timer removes it at expiry. Tapping it calls
  `restoreScmWrite`; success or a 410 removes the entry (a 410 toasts "This Undo has expired"); a 409
  toasts the conflict and keeps it. The toast's Undo of a discard also clears the entry when the receipt
  matches. Why latest only: a list of discards would need ordering rules between discards of overlapping
  files, and the compare-and-swap already refuses the stale ones; the latest is the mistake people undo.
- **Confirm.** `window.confirm` text, built by a pure `discardConfirmText(names, untrackedCount)` in
  `row-actions.ts`:
  `Discard changes to <name>?` or `Discard changes to <n> files?` followed by up to ten names, one per line,
  `…and <k> more`, then `<u> untracked files will be deleted.` when `u > 0`, then
  `You can undo this for 10 minutes. A server restart loses the Undo.`

### D10. Folder actions collect from the group's entries

A folder action takes every entry of that group (`merge`, `staged` or `changes`) whose path starts with
`<folder>/`, from the full group list and not from the rows on screen, so collapsed subfolders count.
Folder rows exist only in the tree view, so the flat list has file actions only. While `status.truncated`
the folder actions are disabled (D2). The write is one request; while it runs, the project's actions are
disabled ("Writing…") and the status store is asked to refresh as soon as it answers
(`scmStatusStore.refresh()`).

### D11. The review's current-file bar

`.rv-current` keeps its path and position and, when not in the mobile layer, adds after the path:

- the state letter and label (`STATUS_LABEL`, exported from `ReviewRow.tsx`), and the counts
  (`+added −removed`) from the file's status entry;
- the same `ReviewButton` the file header uses (exported from `ReviewRow.tsx`), given the pane's one
  `writes: ReviewWrites` object, so `writes.stateOf(path)` shows one running state on both and
  `writes.run` refuses a second run while one is in flight;
- Open file, an `IconButton size="sm"` with `data-testid="review-current-open"`, calling the same
  `onOpenFile` handler as the file header, disabled for status `D`.

`ReviewButton` already computes the blocker reason from `reviewBlocker` (not loaded, conflicted, no
token), so the bar's button carries the same reason. The bar's test ids for its own controls are
`review-current-reviewed` / `review-current-unstage` (a `testId` prop on `ReviewButton`, defaulting to
today's ids). The bar is outside the virtual list, so no row height changes. On a phone (`compact`) the bar
renders exactly as today.

The review pane still never discards: the new requirement in `diff-review` covers the header only, and
"The review never edits or discards" is untouched.

### D12. Audit lines

One `console.info` line per batch stage, batch unstage, discard and discard Undo, and per refusal of any
of them, in the `<module>: …` form `server.ts` already uses for `/files/delete`:

```text
scm: stage-paths repo=/home/u/p done=38 skipped=2 receipt=r1a2b… lockMs=41 ms=230 paths=a.ts,b.ts,…(+30)
scm: discard repo=/home/u/p done=3 skipped=1 receipt=d9f… ms=88 paths=tmp/out/x,…
scm: discard refused repo=/home/u/p requested=4 status=413 code=- ms=12 error="big.bin is larger than 64 MiB…"
scm: restore-discard repo=/home/u/p receipt=d9f… restored=1 kept=1 status=409 code=conflict ms=31
```

At most ten paths are printed, then `(+<rest>)`. A refusal says how many paths the call named (`requested`)
and how long it took (`ms`). An Undo of a discard says how many files it put back (`restored`) and how many the
receipt still keeps (`kept`, 0 once it is spent); a refused project counts both as 0 restored. `lockMs` is the time between creating and releasing
`index.lock` (stage and unstage only). Logging lives in the route handlers, through one `auditScm(op,
fields)` helper in `server.ts`, so the modules stay free of logging and testable.

## Risks / Trade-offs

- [A file changes between the backup read and its write] → the `lstat` re-check just before the write
  narrows the window to the time one `checkout-index` batch takes; the backup always holds what palmux read, so Undo still restores the
  pre-discard bytes. Accepted: a write that lands inside that window is lost to the discard.
- [Backup objects nobody undoes] → they are dangling blobs, pruned by `git gc` after git's default 2 weeks.
  Accepted; it is git's normal behaviour for `hash-object -w`.
- [A restart drops every Undo] → the confirm says so, and the receipt store is documented as memory.
- [Lock time on a 5,000-path stage] → one `git add` process, a 60 s timeout, `lockMs` in the log. The
  status poll is unaffected (it takes no lock).
- [`git add` honours `core.autocrlf`, which the token stage reconstructs] → this is the intended difference:
  list actions match a terminal, Reviewed matches what was read.
- [Radix's long-press may not cancel on a pan] → task 6.4 measures it; the fallback is a long-press timer of
  the drawer's kind (`LONG_PRESS_MS`) in the row, which the task names if the measurement fails.
- [An older git] → 501 `unsupported` for the batch routes only; Reviewed, Unstage and discard keep working
  (discard needs no `--pathspec-from-file`).

## Migration Plan

- No stored data changes. `tabs.json`, settings and the comment store are untouched; the only new key is the
  per-device `palmux-scm-last-discard`.
- Deploy: build the client, then restart the server (the routes and the `ready` flag are server-side). A
  restart under systemd ends every live terminal and needs the owner's OK at the time.
- Compatibility: a new client on an older server sees no `scmBatchWrites` and draws no actions and no Undo
  last discard; the review bar's new header controls work on any server (they use `/scm/stage` and
  `/scm/unstage`). An older client on a new server ignores the flag and the routes.
- Rollback: an older server drops the routes and the flag; the client hides the actions again. Pending
  discard receipts are lost, as on any restart.

## Observability

- The audit lines in D12, one per write or refusal.
- The existing `scmRoute` wrapper logs any thrown fault with its detail and answers a JSON 500.

## Cost

- Stage of a folder: one `check-attr`, one status read (cached 500 ms), one `ls-files` before and after, one
  `git add`. No network.
- Discard: one `hash-object -w` per file (object store growth equals the discarded bytes until `gc`), one
  `checkout-index` batch, one hash per restored file.
- Memory: at most one file of 64 MiB in flight per discard; receipts are small (paths and oids, at most 20
  discard receipts).

## Open Questions

None that change the specs or the tasks. The two the brief left to this change are decided above and
flagged for the owner: the desktop tokens (D1) and latest-only Undo (D9).

## Implementation decisions (2026-11-08, from the readiness review)

The readiness pass (`opsx-readiness-reviewer`) found gaps between this design and the code. These close them;
where they differ from a decision above, they win.

- **R1. A null receipt (1.1).** `ScmWriteResult.receiptId` is `string | null`. `review-writes.ts` `done()` turns
  a null receipt from a single-file stage or unstage into a notice (it cannot happen: those writes always answer
  one). `LoggedWrite.receiptId` stays `string`: a batch write that answers `receiptId: null` is NOT recorded, and
  its toast has no Undo. Its text is `Nothing staged` / `Nothing unstaged` / `Nothing discarded`, with the skip
  suffix of D9 when there are skips (`Nothing staged, skipped 2 (needs a git filter)`).
- **R2. `ScmBatchResult.done`** is the requested paths whose BEFORE and AFTER differ (stage, unstage), or the
  files the discard changed. A rename's `oldPath` is never listed in `done`. The toast's count is `done.length`.
- **R3. `lockMs`.** `Committed` gains `lockMs` (lock created → released). `stagePaths` and `unstagePaths` answer
  `{ ok: true; result: ScmBatchResult; lockMs: number } | ScmFailure` (`BatchWrite` in `scm-index.ts`);
  `discardPaths` answers `{ ok: true; result: ScmBatchResult } | ScmFailure`; `restoreDiscard` answers the
  existing `WriteResult`.
- **R4. Shared git helpers (2.3) live in `scm-git.ts`:** `GIT_BATCH_TIMEOUT_MS`, `parseGitVersion`,
  `gitVersion()`, `supportsPathspecFromFile(version)` and `convertedPaths(top, paths)` (one `check-attr -z
  --stdin filter working-tree-encoding ident`). Both the batch stage and the discard use `convertedPaths`.
- **R5. A nested repository entry** (`vendor/inner/`, one trailing `/`) is not a validation failure: it is
  validated without its slash and skipped `nested-repo`. Any other path failing `checkRelPath` refuses the whole
  request (400).
- **R6. The discard reads the real index itself** (`ls-files -s -z` with the paths, no lock) for D6 step 4's
  modes. It never writes the index.
- **R7. `readWorkTree` options (3.1).** `readWorkTree(top, path, opts?)` with `opts = { limit?: number;
  statOnly?: boolean; classify?: boolean }`. Without options every existing caller sees exactly today's
  results. `statOnly` returns the stat without reading bytes (D6 step 4 must not hold every file in memory);
  `'file'` and `'big'` results carry `stat: { size, mtimeMs, ctimeMs, ino, mode }`; with `classify: true` a
  socket, FIFO or device answers `{ ok: true, kind: 'special' }` and a symbolic link on the path answers
  `{ ok: true, kind: 'link-in-path' }` instead of the 400 / 403 failures. The discard's Undo creates a missing
  parent through the descriptor walk (an `ensureParent` helper in `scm-discard.ts`).
- **R8. Long-press and right-click guards (D3).** `consumeGesture` needs a pointer event, and `ContextMenu`'s
  `onOpen` has none. `.scm-item` records the last `pointerId` and `button` in `onPointerDownCapture`; `onOpen`
  sets `menuOpenedRef.current = true` and calls `consumeGesture({ pointerId, type: 'pointerdown' }, () => {})`.
  The main button's `pressMove` action returns early when `menuOpenedRef.current` is set or the press was not
  the primary button (`button !== 0`, a right-click). The next primary pointerdown clears the ref.
- **R9. Row-action context (5.3).** `rowActions(group, row, ctx)` takes `ctx = { top, entries, truncated, busy,
  onOpenPath?, onStage, onUnstage, onDiscard }` and the callbacks receive the collected entries. Open file is not
  offered when `onOpenPath` is absent. The `batchWrites` prop arrives with 5.4.
- **R10. Menu details (5.4).** The Discard menu item carries `danger: true` and `separatorBefore: true`. A
  disabled menu item shows no tooltip (the kit has none); the inline button carries the reason as `title`. The
  row keeps its `onDoubleClick` pin, and `useDynamicRowHeight`'s default becomes 24.
- **R11. The drawer host (D4).** The drawer's `onOpenPath` calls `closeDrawer()` before `openFileTab`, as every
  other drawer handler does.
- **R12. Tests (5.2).** The density tests are in `scm/SourceControlView.test.tsx` (the block titled after the
  removed requirement); they move to the desktop's 24px / 8px and the block takes the new requirement's name.

## Build decisions (2026-11-08, from the implementation reviews)

These record where the build departs from D5–D12 and R1–R12, and why. Each one came from an adversarial review
finding that was reproduced against real git 2.43 before it was fixed.

- **B1. No git command writes the work tree** (replaces D6 step 6's `checkout-index`). `checkout-index` opens
  ordinary paths, so a folder swapped for a link after palmux's walk redirected its write outside the project.
  The discard reads the index bytes with `cat-file --filters --path=<p> <oid>` (a checkout's eol conversion),
  writes a temp file beside the name through the parent descriptor (`O_EXCL | O_NOFOLLOW`, created `0o777` for
  `100755` and `0o666` otherwise, so the umask applies as git's does), takes a last `lstat`, and swaps it in
  through `/proc/self/fd/<parent>`: `rename` over an expected file, a hard `link` for an expected-absent one. A
  link found on the path or a file moved at the last look is skipped `symlink` / `changed`.
- **B2. The discard probes every entry before it reads the status**, and the backup read must match that probe's
  stat. Read the other way round, an edit landing between the status read and the probe became the confirmed
  version. The after-state comes from the bytes written and the temp file's `fstat`, before the swap, so a file
  joins the receipt exactly when its swap succeeds.
- **B3. Undo re-checks each file right before writing it.** A file edited or recreated after Undo's comparison
  stops the Undo with a 409 and keeps the edit. Files already restored stay restored, the receipt keeps the rest,
  and the message counts them ("1 of 2 were restored, and Undo keeps the rest."). This narrows the spec's "otherwise
  change nothing" to changes made before Undo starts: a change landing during the restore loop is a race a
  rollback would only re-run in reverse. The client shows the server's count.
- **B4. Batch stage classifies each path on disk first.** `git add foo` with `foo` now a folder also staged
  `foo/bar`, a path nobody named. Only files and symlinks go to `git add`. A path that is a folder or missing on
  disk but has a stage-0 entry is staged as a deletion (`update-index --force-remove -z --stdin`), and a folder
  with no entry is skipped `special`.
- **B5. No hook runs in any write.** `GIT_INDEX_FILE` does not stop `post-index-change`, so every index-writing
  command carries `-c core.hooksPath=/dev/null`.
- **B6. `rm --cached` runs with `-f`** (unborn HEAD unstage). Without it git refuses every entry edited after
  `git add`, which is the ordinary case. `--cached` still never touches the work tree.
- **B7. A stale path is a skip, not a failure.** On git 2.43, `git add` with one unmatched pathspec exits 128 and
  stages nothing from the whole batch, and `restore --staged` exits 1. Both batch writes check existence inside the
  lock and skip `gone` before calling git.
- **B8. Audit lines cover a refused repo too.** A `checkRepo` refusal prints the D12 refusal line with the raw
  `repo` value (control characters replaced). An index Undo (`r` receipt) stays unaudited, as before. A blank
  `receiptId` keeps the existing 400.
- **B9. Inline actions use the row's press guard.** A right-click on an inline action opened the menu and then ran
  the action on release. Both Undo routes (the toast's and the project bar's) forget a spent receipt in both the
  write log and the discard log.
- **B10. No filter driver can run in a discard, in any order** (replaces B1's `cat-file --filters`). `--filters`,
  `checkout-index`, `restore` and `checkout --` all read the WORK TREE's `.gitattributes` at the moment they run,
  so a `.gitattributes` restored earlier in the same batch let a later file be smudged (an LFS driver ran) or
  `ident`-expanded. The index version is read raw (`cat-file blob`) and palmux applies the one conversion left,
  LF → CRLF, itself: `checkoutBytes`, a port of git 2.43's `convert.c` (`convert_attrs`, `output_eol`,
  `will_convert_lf_to_crlf`, `crlf_to_worktree`), held equal to `checkout-index` by a 720-case test (8 attribute
  sets × 3 eol × 5 blob shapes × 6 configs). A path is skipped `converted` when EITHER the work tree's or the
  index's attributes (`check-attr --cached`) name a filter, an encoding or `ident`, before the size check, so an
  LFS file never refuses a batch with 413. Every `.gitattributes` is written first, and each of the two write groups
  re-reads `check-attr` before writing. Limits: palmux never refreshes the index's stat data, so a file whose size
  the checkout changes (an LF blob written as CRLF) shows ` M` in `git status` until git refreshes it; an
  `autocrlf` with a k/m/g suffix reads as false.
- **B11. Batch stage classifies under the lock** (replaces D5 step 2's "before taking the lock"): `convertedPaths`
  runs inside the locked step, right before `git add`, so a `.gitattributes` written meanwhile cannot start a clean
  filter. A stage where every path is filtered now takes the lock and can answer 409 busy.
- **B12. Undo removes the folders the discard created** (recorded in the receipt, `rmdir` through the parent
  descriptor, deepest first, stopping at ENOTEMPTY), and a skipped write removes the folders made for it. The temp
  name is `.palmux-<16 hex>`, independent of the file name's length (NAME_MAX).
- **B13. The private index copy carries the index's own times** (found by a flaky audit test, `done=3` of 13).
  git reads an entry's content instead of trusting its stat only while the entry is racy: no older than the
  index file. `transact` copies the index to a temp file, and a fresh copy is newer than every entry, so a
  same-size edit made in the second of the last index write (same size, same inode, same ctime second) looked
  clean to `git add` and was answered "Nothing staged". `transact` now `utimes` the copy to the index's atime and
  mtime. Node keeps milliseconds, which can only make the copy older, so more entries are read, never fewer; an
  ancient time is not used, because 0 disables the check and anything old makes git hash every entry. The test
  forces the window by moving the entry, the index and the file into 2020 under `core.trustctime=false`.
