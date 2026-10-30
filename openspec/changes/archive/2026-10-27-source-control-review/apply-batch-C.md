# Batch C — client: the review pane, colouring, inner marks

Change: `source-control-review`. Tasks **6.1–6.6, 7.1–7.3** (6.7 docs deferred to the docs pass). Contract:
`design.md` D4 (active project), D5 (review tab, client never re-creates a live one), D6, D7, D8, D9
(anchoring function only), D11 (layout/algorithm settings); specs `diff-review` (all requirements except
Reviewed/Unstage UI, navigation keybindings and the review bar, which are batches D/E) and `source-control`
"Only the active project is read".

## C1 — pure logic (new files only; runs in parallel with batches A and B)
All under `packages/client/src/review/`, each with a test file beside it:
- `rows.ts` — the rows model from an `ScmFileSnapshot` (shared/src/scm.ts): `fileHeader`, `notice`
  (binary, tooLarge, converted, unmerged, rename, mode, symlink), `hunkHeader`, `gap` with expansion
  (step of 20 lines or all; before the first hunk, between hunks, after the last, using the full side texts
  the snapshot carries; correct old/new numbers after expansion), `line` (unified) or split rows (GitHub
  pairing: i-th deletion with i-th addition inside each change block, the rest alone), and `placeholder`
  rows for unfetched files with an estimated height from the status counts (D6). Pure functions, no React.
- `anchor.ts` — the one anchoring function D7/D9 share: given current side text lines, a stored
  `{ lines, before, after, start }`, score EVERY exact match of `lines` (the old position included) by the
  number of agreeing context lines, then by distance from `start`; return the best, or `outdated` on no
  match or a tie for best. Also `relocateLine(oldText, newText, line, ctx)` used for scroll anchoring with
  the fallback to the nearest surviving line of the same hunk. Tests: insertion above, deletion, repeated
  `}` and blank-line anchors that must move with their context, ties.
- `inner-diff.ts` — inner marks for a paired line: word/punctuation tokens, LCS bounded to lines under 400
  characters and 10,000 comparison cells, returns changed ranges for each side; over the bound returns null.
- `file-queue.ts` — the D7 fetcher: request snapshots for files within two files of the visible range, at
  most four in flight, per-file generations (an answer older than the newest request for that file is
  dropped), LRU of 60 files / 40 MB of text with eviction callbacks, refetch on fingerprint change and on
  `attrEpoch` change, cache key `version + algorithm`. Framework-free class with an injected fetch.
- `colorize.ts` — colour each side's full text with `getMonaco().editor.colorize(text, languageOf(path), {})`
  split on `<br/>` into per-line HTML; plain above 20,000 lines; per-file scheduling with
  `requestIdleCallback` (fallback `setTimeout`); a cache keyed `version + side`; `clear()` for theme changes.
  It must not import monaco at module load (the loader is lazy; see `panes/monaco-loader.ts`,
  `panes/markdown-code.ts`). Tests mock the loader.

## C2 — the pane and its integration (after batches A and B)
- `packages/client/src/review/ReviewPane.tsx` + `review.css`: the D6 pane on `ui/VirtualList` with dynamic
  row heights; file headers with counts, status, collapse, Open file; the current-file bar from
  `onRowsRendered`; automatic layout at 720px (crossing-only `ResizeObserver`, the `editor-layout.ts`
  pattern) with the per-device `scmLayout` override and the Wrap toggle (`scmWrap`; split always wraps);
  the algorithm control (`scmAlgorithm`); plain-then-coloured lines without height change; inner marks;
  gap expansion; notices; live refresh through `useScmStatus` with fingerprint/attrEpoch refetch and
  text-relocated scroll anchoring with the pixel offset (D7); the paused state ("Paused · make <name>
  active") for a visible review of a non-active project and "Project removed" (D4). `visible` and `focused`
  come from PaneHost.
- `packages/client/src/panes/PaneHost.tsx`: render `ReviewPane` for kind `review` (replacing batch A's
  placeholder), passing `shown` as `visible` and focus.
- `packages/client/src/panes/monaco-theme.ts` + `monaco-loader.ts`: the bridge becomes a subscription list
  (`onEditorProfile(cb)` returns an unsubscribe; registration order; the loader's `applyTheme` first) (D8,
  task 7.2); review panes subscribe and clear their colour cache on change.
- `packages/client/src/App.tsx`: the scroll-to-file handoff (a ref map read and cleared by the pane, like the
  tmux target), focusing a review tab sets `scmActiveRepo` to its repo, never `createTab` for a live review
  url (select + hand over the scroll target) (D5, task 6.5).
- `packages/client/src/session/workspaceController.ts` (+ test): guard the `tabCreated` dissolve to ids that
  are not a live tab of the expected kind and url (F4-05).

## Gates
- `cd packages/client && npx tsc -p tsconfig.json --noEmit`
- `cd packages/client && npx vitest run src/review src/panes src/session src/App.test.tsx`
- `npx oxlint packages/client`
