# Batch D — client: navigation, Reviewed / Unstage / Undo, comments

Change: `source-control-review`. Tasks **8.1, 8.2, 9.1 (anchoring already built in C1 `review/anchor.ts`;
reuse it), 9.2, 9.3, 9.4, 9.5** (8.3 and 9.6 docs go to the docs pass). Contract: `design.md` D9, D10, D11;
specs `diff-review` ("Reviewing a file stages it and moves on", "A staged file can be unstaged", "The review
is navigable by change and by file" desktop part, "The review never edits or discards"), `review-comments`
(all). Server routes exist from batch A: `/scm/comments` (GET list; POST create; PATCH update; DELETE
delete; each answers `{ rev, comments }`), the `scmComments { repo, rev }` socket frame, `/scm/stage {path, token}`, `/scm/unstage {path, oldPath?}`, `/scm/restore {receiptId}` with codes `busy | conflict | changed | token |
unsupported | df`; `repo` rides in the query string on every route, and stage needs both `path` and `token` (batch A's contract; read `packages/server/src/server.ts` and `scm-*.ts` for the exact shapes before coding).

## D1 — comment state and export (pure, `packages/client/src/review/`)
- `comments-store.ts`: per-window store of the active project's comments; replaces state with every
  mutation's authoritative `{ rev, comments }`; refetches when an `scmComments` frame or a status
  `commentsRev` is newer than the applied rev, only while the project is active and a view or review is
  visible; drops responses older than the applied rev; drafts keyed by `path + side + start-end` survive
  unmount. Tests: the interleaved add/delete case; a 900 ms status repo still converging within 2 s via the
  frame.
- `export-md.ts`: the markdown exporter (files in path order; `**L10–14** (new)`; a fenced block in the
  file's language with the stored lines; the body; outdated marked). Tests.
- `comment-placement.ts`: content-driven display (D9/F4-06): for an open review's two sides, decide the
  side and line range each comment draws on using `review/anchor.ts`, own version's side preferred; returns
  outdated ones separately. Test "A comment survives Reviewed".

## D2 — UI (after D1 and batch C2)
- `review/ReviewPane.tsx`: line-number range selection (drag and shift-click on desktop; tap then tap on
  touch, no long-press), the inline comment editor row (a `<textarea>`, drafts kept, ESC cancels, save via
  the store), edit and delete (one confirm only when the body is non-empty), the outdated list, Reviewed on
  each Changes file header and Unstage on each Staged header, then move to the next file; the 6 s Undo
  toast (reuse the app's toast); notices for `busy`, `conflict`, `changed`, `unsupported`, `df`; `410 token`
  → refetch the snapshot and retry once when `version` is unchanged; Reviewed disabled with the reason when
  the snapshot has no token.
- `scm/scm-api.ts`: comment, stage, unstage, restore wrappers.
- `scm/SourceControlView.tsx`: Copy comments (robust clipboard: the app's existing clipboard helper).
- `keybindings/keybindings.ts` (+ tests): actions `openSourceControl` (Ctrl+Alt+G), `scmNextChange`
  (Ctrl+Alt+J), `scmPrevChange` (Ctrl+Alt+Shift+J), `scmNextFile` (Ctrl+Alt+N), `scmPrevFile`
  (Ctrl+Alt+Shift+N), `scmReviewed` (Ctrl+Alt+Enter); a test that every default chord is unique; palette
  entries appear. Next/previous change cross files and fetch an unloaded target before scrolling.
- `App.tsx`: route the new actions to the focused review pane (a small registry like `panes/editor-registry.ts`
  is fine) and `openSourceControl` to the dock view (desktop) or the drawer's view (mobile); handle the
  `scmComments` frame from the control socket into the comments store.
- `tips/tips.ts`: tips for the review keys and Reviewed.

## Gates
- `cd packages/client && npx tsc -p tsconfig.json --noEmit`
- `cd packages/client && npx vitest run src/review src/scm src/keybindings src/tips src/App.test.tsx`
- `npx oxlint packages/client`
