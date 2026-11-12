# Tasks

Each phase builds and passes `yarn typecheck && yarn test` on its own. Decisions are in design.md (D1–D10);
a task names the decision it implements.

## 1. Move the comment exporter and its helpers to `@palmux/shared` (D6)

- [x] 1.1 Move `packages/client/src/review/anchor.ts` and `anchor.test.ts` to `packages/shared/src/anchor.ts`
  and `anchor.test.ts` unchanged. Add `export * from './anchor';` to `packages/shared/src/index.ts`. Change
  every importer to `@palmux/shared`: `review/rows.ts`, `review/scroll-anchor.ts`, `review/colorize.ts`,
  `review/ReviewPane.tsx`, `review/rows.test.ts`. Delete the client files. Test: the moved `anchor.test.ts`
  passes under the shared package's vitest run.
- [x] 1.2 Move `packages/client/src/panes/editor-language.ts` and its test to
  `packages/shared/src/editor-language.ts` (+ test); add the `export *` line. Update `review/colorize.ts`,
  `review/export-md.ts`, `panes/markdown-code.ts`, `panes/EditorPane.tsx`. Delete the client files.
- [x] 1.3 Move `review/comment-placement.ts` (+ test) to `packages/shared/src/comment-placement.ts`; its
  `./anchor` import stays relative. Add the `export *` line. Update `scm/copy-comments.ts`,
  `review/CommentCard.tsx`, `review/annotations.ts` (+ `annotations.test.ts`), `review/review-model.ts`,
  `review/ReviewPane.tsx`, `review/export-md.ts`. Delete the client files.
- [x] 1.4 Move `review/export-md.ts` (+ test) to `packages/shared/src/export-md.ts`; add the `export *`
  line; update `scm/copy-comments.ts` (+ `copy-comments.test.ts`). Delete the client files.
- [x] 1.5 Create `packages/shared/src/comment-marks.ts` holding `ReadSnapshot`, `commentMarks` and
  `commentsMarkdown` moved from `scm/copy-comments.ts`, with `read: ReadSnapshot` a REQUIRED last
  parameter of both. Add the `export *` line. `scm/copy-comments.ts` keeps `copyPendingText` and exports
  `commentsMarkdown(repo, status, comments)` that calls the shared one with `fetchScmFile`. Move the
  marks cases of `copy-comments.test.ts` to `packages/shared/src/comment-marks.test.ts` (they already
  inject `read`); the clipboard cases stay.
- [x] 1.6 Run `grep -rn "review/anchor\|review/comment-placement\|review/export-md\|panes/editor-language" packages/`
  and confirm no match; run `yarn typecheck && yarn test`. No behaviour changes in this phase.

> Receipt 1.x: `anchor`, `editor-language`, `comment-placement`, `export-md` and the new `comment-marks` live in `packages/shared/src` (old client files deleted); the grep in 1.6 finds no old path; `yarn typecheck` 0 errors; shared 157 tests pass.

## 2. The agent-ready document, the visible buttons, Resolve and Clear all (D7, D9)

- [x] 2.1 `packages/shared/src/export-md.ts`: change `exportCommentsMarkdown(comments, marks)` to
  `exportCommentsMarkdown(top, comments, marks)` and emit exactly the D7 layout: the `# Review comments`
  title, the two-line instruction naming `top`, `## <path>` per file, `### <path>:L<start>-L<end> (<side>)<mark>`
  (or `:L<n>` for one line, ASCII hyphen), the fence, the body. Empty `comments` → `''`. Update
  `comment-marks.ts` `commentsMarkdown` to pass `top`. Tests in `export-md.test.ts`: the "Copying for an
  agent" and "A heading for a range" scenarios of `specs/review-comments`, a one-line heading, the
  outdated and not-shown marks after the side, and the empty case.
- [x] 2.2 Add `exportFileCommentsMarkdown(top, path, comments, marks)` to `export-md.ts`, which filters
  `comments` to `path` and calls `exportCommentsMarkdown`. Test: "One file's comments" scenario.
- [x] 2.3 `packages/client/src/review/ReviewPane.tsx` top bar (`.pane-header.rv-bar`): add a labelled
  kit `Button` "Copy comments" (`data-testid="review-copy-comments"`, `copy` icon) shown when the bar is
  not `compactBar`, disabled when the store holds no comment; when `compactBar` it is an item in the View
  options menu (`review-view-options`) as `review-copy-comments-menu`. It calls
  `scm/copy-comments.ts` `commentsMarkdown` + `copyPendingText` and toasts "Copied <n> comments". Test in
  `ReviewPane.test.tsx`: "Copy from the review on desktop" scenario, and the menu item at a compact width.
- [x] 2.4 `review/ReviewRow.tsx` file header row (`.rv-head`): when the file has at least one comment,
  add an icon button `review-copy-file-comments` (`copy` icon, `aria-label="Copy comments for <path>"`,
  `RowButton` on a phone) that copies `exportFileCommentsMarkdown` for that file. Test in
  `ReviewPane.test.tsx`: the button is absent on a file without comments and copies one section on a
  file with two.
- [x] 2.5 `packages/server/src/scm-comments.ts`: add `deleteAllComments(top)` (one read-modify-write
  under the file's mutex, `comments = []`, `rev + 1`, answers `{rev, comments: []}`). `server.ts` `DELETE
  /scm/comments`: `all=1` without `id` runs it through `commentRoute(..., true)` so it broadcasts
  `scmComments`; neither `id` nor `all=1` stays the existing 400. Tests: `scm-comments.test.ts` (rev
  bumps, file empty), the route test (broadcast sent, 400 without either).
- [x] 2.6 `packages/client/src/scm/scm-api.ts`: add `deleteAllScmComments(repo)`;
  `review/comments-store.ts`: add `clearAll()` that calls it and replaces state with the answer.
  Test in `comments-store.test.ts`.
- [x] 2.7 "Clear all comments" (`scm-clear-comments`) as a View options item in `ReviewPane.tsx` and a
  button in the `scm-comments-bar` row of task 2.9, both disabled with no comments. Each asks `window.confirm('Delete all <n> comments in <basename(top)>? This cannot be undone.')`
  and calls `clearAll()` only on OK. Tests: "Clear all" and "Clear all cancelled" scenarios.
- [x] 2.8 `review/CommentCard.tsx`: add Resolve (`review-comment-resolve`, `check` icon, label
  "Resolve") beside Edit and Delete for a stored comment. It calls `remove(id)` with no confirm, then the
  write toast "Comment resolved" with Undo; Undo calls `create` with the removed comment's `path, side,
  start, end, lines, before, after, body, version`. Test in `ReviewPane.test.tsx`: "Resolve and undo"
  scenario (comment gone, then back on the same lines with the same body).
- [x] 2.9 `scm/SourceControlView.tsx`: remove the icon-only `scm-copy-comments` `IconButton` from the
  project bar and add a row under that bar, `scm-comments-bar`, rendered only while the active project has
  comments, holding a kit `Button` size `sm` labelled "Copy comments" (keeps `data-testid="scm-copy-comments"`,
  `pressMove`, the same handler) and the "Clear all comments" button of 2.7. Layout in `scm/scm.css` (flex,
  `--sp-2` gap, no new sizes). Test in `SourceControlView.test.tsx`: the row is absent with no comments and
  the button's accessible name is "Copy comments".

> Receipt 2.x: agent document and per-file export in `shared/export-md.ts`; `review-copy-comments`, `review-copy-file-comments`, `review-comment-resolve`, `scm-copy-comments`, `scm-clear-comments` and `deleteAllComments`/`DELETE ?all=1`; Clear all sits in the review's View options menu, which exists only in the compact bar (<500px). Codex review 2 found Resolve's Undo dropped after a project switch: fixed test-first (`ReviewComments.test.tsx` "Undo after the device moved…"). E2E: verify.md rows 6, 15 and the comment-control section.

## 3. The server side of `/cli` (D2, D4, D5, D6, D8, D10)

- [x] 3.1 `packages/shared/src/protocol.ts`: add `CliOpenMessage`, `CliGitMessage` to the server→client
  union and `CliResultMessage` to the client→server union (D2 shapes), with the parse rules of D2 in
  `parseServerMessage` / `parseClientMessage`. Tests in `packages/server/src/protocol.test.ts`: each frame round-trips;
  `cliOpen` with an empty `paths` and `cliResult` with a non-boolean `ok` are dropped.
- [x] 3.2 `server.ts`: replace the `sendToTerminal` decorator with `terminalSocket(id): WebSocket |
  undefined` (open sockets only); add `cliAnswered(ws, msg)` and route `cliResult` from the message
  switch to it. `cli-api.ts` download path uses `terminalSocket(id)?.send(...)`. Existing
  `cli-api.test.ts` download cases keep passing.
- [x] 3.3 `cli-api.ts`: export `CLI_COMMANDS = ['download','open','git','comments'] as const`; every
  reply body carries `commands: CLI_COMMANDS`. Parse `{cmd, tty?, paths?, cwd?}`: `download`/`open` need
  `tty` and a non-empty string `paths`; `git` needs `tty` and `cwd`; `comments` needs `cwd`; else 400.
  Tests: "A malformed request" scenario and `commands` present on 200, 400, 403, 409.
- [x] 3.4 `cli-api.ts` pending answers: `randomUUID()` request ids, a `Map` keyed by id holding the
  socket, a 3000 ms timer (`CLI_ANSWER_MS`, exported for tests), resolve only when the answering socket is
  the one sent to. Timeout → `504 {error: 'no palmux window answered within 3 s'}`. Tests with fake
  timers: an answer from another socket is ignored; no answer → 504 after 3000 ms; an answer → resolves
  before the timer.
- [x] 3.5 `open`: export `expandHome` from `download.ts`; validate each path (expand, absolute,
  `file-rw.ts` `regularFile`, size ≤ the `maxUploadBytes` passed into the plugin as `maxEditBytes`) and
  put refusals in `failed` with the module's message. Send `cliOpen` with the survivors and answer `200
  {opened, failed}` from the window's results (a `{ok:false}` result goes to `failed`). Tests: "A
  directory", the missing and oversize cases, mixed valid/invalid order kept, none valid → no frame.
- [x] 3.6 `git`: `resolveRepo(cwd)`; a throw → `400 {error: message}` and no frame. Else send `cliGit
  {repo: top}` and answer `200 {repo, note?}` from the window's single result (`ok:false` → 400 with its
  error). Tests: "Not a repository", a nested cwd sends the top.
- [x] 3.7 `scm-snapshot.ts`: add `keepToken?: boolean` to `SnapshotRequest`; `false` skips `putToken`
  and returns no `token`. Test in `scm-snapshot.test.ts`: the token cache size is unchanged after a
  `keepToken: false` read.
- [x] 3.8 `comments`: `resolveRepo(cwd)` (throw → 400), `listComments(top)`, `getStatus(top)` (a throw →
  `null` status), shared `commentsMarkdown(top, status, comments, read)` with `read` =
  `readSnapshot({..., algorithm: 'histogram', keepToken: false})`. Answer `200 {markdown}`. Tests: three
  comments in two files produce the phase-2 document; no comments → `''`; "Outside a repository".
- [x] 3.9 Logging: one `console.info` per request in the D10 format, from a single exit point in the
  handler. Test: a spy sees one line with `open`, the tty and `opened=1 failed=0`, and no file content.

> Receipt 3.x: `/cli` in `cli-api.ts` (pending answers, 3 s 504, `commands` on every reply, D10 line, JSON errors for bad body/415/413/Origin 403); `terminalSocket`, `cliAnswered`, `keepToken`. Codex review 3: `open` paths are now `path.resolve`d before the frame, so a second spelling finds the open tab (`cli-api.test.ts` "canonical form"; verify.md row 16). Server 1065 tests pass. E2E: verify.md rows 1–13 and the server log lines quoted there.

## 4. The CLI (`palmux-cli.ts`) (D7, D8)

- [x] 4.1 `USAGE` lists the four commands with one line each and the shared path rules. `runCli`:
  `help`/`-h`/`--help`/no args → usage, 0; unknown command, or `download`/`open` with no path → usage on
  stderr, 2. Tests: the "Usage and exit statuses" scenarios.
- [x] 4.2 A shared reply reader: not JSON, or no `commands` array, or the array lacks `cmd` → `palmux:
  this palmux server predates \`palmux <cmd>\`; restart it`, exit 1; non-200 → `palmux: <error>`, exit
  1. Test: "A newer CLI against an older server".
- [x] 4.3 `open`: needs a tty (same message as download, naming `palmux open`); posts `{cmd:'open', tty,
  paths}`; prints `opened <path>` per opened path and `palmux: <path>: <error>` per failure; exit 1 on
  any failure. Tests: open one, already open (reported opened), a directory, another window.
- [x] 4.4 `git`: needs a tty; posts `{cmd:'git', tty, cwd}`; prints `Source Control: <repo>` and, when
  present, `palmux: <note>`; exit 0. Tests: nested folder, detached-window note, not a repository.
- [x] 4.5 `comments`: no tty lookup; posts `{cmd:'comments', cwd}`; writes `markdown` to stdout as is
  (no trailing newline added when empty); exit 0. Tests: three comments, none, outside a repository.

> Receipt 4.x: `palmux-cli.ts` usage, shared reply reader (predates message), open/git/comments; 16 CLI tests pass. E2E: verify.md rows 7, 9, 10, 14.

## 5. The window side (D3, D5)

- [x] 5.1 `packages/client/src/scm/scm-projects.ts`: `addScmProject(settings, top)` per D5; replace the
  inline logic in `SourceControlView.tsx`'s add flow with it. Tests: a new top appended and active; an
  existing top only made active; a non-canonical spelling of an existing top not duplicated.
- [x] 5.2 `App.openFileTab(path, opts?: { preview?: boolean })` returns `'opened' | 'held'` (D3). If
  `preview-tabs` has already changed this function, keep its signature and add only the return value.
  Callers that ignore the result are unchanged. Test in `App.test.tsx`: held-elsewhere returns `'held'`.
- [x] 5.3 `lib/ws.ts`: add a public `sendCliResult(msg: CliResultMessage)`. `terminal/TerminalPane.tsx`:
  on `cliOpen` call the new `onCliOpen(paths)` prop and on `cliGit` the `onCliGit(repo)` prop; send the
  `cliResult` each returns on the same socket. Thread both props from `App.tsx` through
  `session/GroupsView.tsx` the way `onTransferError` is threaded.
- [x] 5.4 `App.tsx` `onCliOpen`: for each path in order, `openFileTab(path, { preview: false })`;
  `'held'` → `{path, ok:false, error:'open in another window'}`, else `{path, ok:true}`. `onCliGit`:
  `updateSettings(addScmProject(settings, repo))`, then `openSourceControl()` unless the window is
  detached, where it answers `note: 'this window has no Source Control panel'`. Tests in `App.test.tsx`:
  "Open one file", "Already open", "Open in another window", "From a nested folder" (window half), "A
  window with no Source Control panel".
- [x] 5.5 `specs/source-control` "palmux git adds the project": test in `App.test.tsx` that the added
  project reaches the synced `scmRepos` save and `scmActiveRepo` is written locally.

> Receipt 5.x: `addScmProject`, `openFileTab` → `'opened'|'held'|'failed'`, `sendCliResult`, `onCliOpen`/`onCliGit`. Codex review 2 found three races (two `git` before a render, `git` with the control socket down, a stale pending create re-selecting): all fixed test-first in `App.test.tsx` "palmux open and palmux git" Codex review 3 found two more, both fixed test-first: a pending preview lost its pin and took the selection after a newer open (`PendingPreview.silent`, cleared again when that file is opened again), and `palmux git` reported success when the config.json discard confirm was cancelled (`openDockView` now returns whether it navigated). 609 App tests pass. E2E: verify.md rows 1–4, 11–13.

## 6. Docs and the end-to-end check

- [x] 6.1 `README.md`: a "palmux CLI" section with the four commands, the tmux note, exit statuses, and
  that `palmux comments` needs no palmux terminal (for agents).
- [x] 6.2 `CLAUDE.md`: extend the `palmux download` paragraph into a `palmux` CLI paragraph naming D1
  (data socket), D2 (`cliResult`, 3 s), D5 (window writes settings), D6 (shared exporter, no tokens) and
  the "starts with no project" exception.
- [x] 6.3 `CHANGELOG.md`: the 1.3.0 entry lists `palmux open`, `palmux git`, `palmux comments`, the agent
  format, Copy comments in the review bar, per-file copy, Resolve and Clear all; notes the server restart.
- [x] 6.4 Check on a dev server (`./scripts/dev.sh`, never prod :44040): in a palmux terminal run `palmux
  open README.md`, `palmux git` from `packages/client/src`, `palmux comments`, and `palmux open src`;
  record each exit status and what the window showed in the change folder's `verify.md`, with a
  "What would invalidate this" section.

> Receipt 6.x: README `## The palmux CLI`, CLAUDE.md palmux CLI and Export paragraphs, CHANGELOG `[1.3.0] — unreleased` (this change only). 6.4 ran on a scratch server on :44099 instead of `./scripts/dev.sh` (dev.sh binds :44040, where prod runs); results in `verify.md`. Gates: typecheck 0, lint warnings only, tests client 4992 / server 1065 / shared 157.
