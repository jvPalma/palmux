# Batch A — server: git access, snapshot, stage, comments, protocol

Change: `source-control-review`. Tasks: **1.1–1.10, 2.1–2.3, 3.1, 3.2**. The design (`design.md` D1, D2, D3, D5,
D9, D10, D11, D14) and the specs (`specs/source-control`, `specs/diff-review` "Reviewing a file…", "A staged
file…", "Line endings…", "Special files…", `specs/review-comments` storage/sync) are the contract. Read them in
full before writing code. Nothing here may contradict them; if something does, the design wins and the
builder reports the conflict.

## Streams (disjoint files, run in parallel, then S3)

**Planner-written contracts (already on disk, exported from `packages/shared/src/index.ts`):**
`packages/shared/src/scm.ts` (status and snapshot wire types, `isScmGroup`, `isScmAlgorithm`, `reviewUrl`,
`parseReviewUrl`) and `packages/shared/src/scm-comments.ts` (comment wire types and validators). S1 may add
fields or helpers to `scm.ts`; S2 may add to `scm-comments.ts`; neither changes the other's file or
`index.ts`, and neither removes or renames a contract field without reporting it.

**S1 — git core (new files only)**
- `packages/server/src/scm-git.ts` — the runner (D1: argv only, clean-base env, literal pathspecs,
  `--no-optional-locks`, 10 s timeout, output cap, per-command ok exit codes), repo resolution and the
  `repo` / `path` parameter checks.
- `packages/server/src/scm-status.ts` — porcelain v2 `-z` parser (ordinary `1`, rename `2`, unmerged `u`,
  untracked `?`, headers `# branch.*`), numstat merge, fingerprints, `attrEpoch` (F4-01: never a `:(glob)`
  pathspec), the coalescer (one process per repo, 500 ms cache, `invalidateStatus(top)`), 5,000-entry cap.
- `packages/server/src/scm-snapshot.ts` — the D2 reader: HEAD/index oids (`ls-tree`, `ls-files -s`; unborn
  HEAD), blobs by oid, the descriptor-relative work tree walk via `/proc/self/fd/<dirfd>/<name>` with a test
  hook, attributes + line-ending rule incl. the `text=auto` CRLF-in-index guard, binary rule, converted
  rule, `git diff --no-index` with pinned config, the unified-diff parser, the token/receipt cache
  (64 MB, 10 min, LRU, memory only) and `version`.
- `packages/server/src/scm-index.ts` — stage / unstage / restore as index transactions under git's lock
  protocol (D10): `O_CREAT|O_EXCL` lock, temp index copy, `GIT_INDEX_FILE` reads and `update-index --add
  --cacheinfo` / `--force-remove`, fsync + rename, split index refused, receipts under `receiptId`, restore
  compare-and-swap, `409 busy|conflict|changed`, `410 token`, D/F refusal as 409, live lock set with
  `releaseAllLocks()` for shutdown, per-repo write mutex, status invalidation.
- Tests beside each: `scm-git.test.ts`, `scm-status.test.ts`, `scm-snapshot.test.ts`, `scm-index.test.ts`.

**S2 — comments, protocol, settings, tab kind (existing files + one new module)**
- `packages/server/src/scm-comments.ts` — store under `<configDir>/.cache/scm/<sha256(top)[:16]>.json`,
  `.cache/.gitignore` = `*`, per-file mutex, atomic rename, `rev`, in-memory latest rev per repo, CRUD that
  answers the whole list + rev (D9). Test `scm-comments.test.ts`.
- `packages/shared/src/protocol.ts` — `TabKind` gains `review`; new server→client frame
  `scmComments { repo: string; rev: number }` with its parser case; tests in `protocol.test.ts`.
- `packages/server/src/config.ts` — `saveSettings` becomes a shallow merge returning the merged object
  (D11; SCM-R2-06). `config.test.ts`.
- `packages/server/src/server.ts` — ONLY: the `settings` socket handler uses the merged object for persist,
  theme export and broadcast; `createTab`/`updateTab` gate `review` urls (`changes:`/`staged:` + absolute
  top) with server idempotency by canonical url (D5). Tests in `tabs-registry.test.ts` and a handler-level
  settings test. Do NOT add any `/scm` route (S3 does).
- `packages/server/src/tabs-store.ts` — nothing to change unless a `review` url fails to persist (it keeps
  any string url today); verify with a test.
- `packages/client/src/session/tab-meta.ts` + `packages/client/src/panes/PaneHost.tsx` — task 3.2 only:
  `displayTitle` (`Changes · <name>` / `Staged · <name>`), the kind icon, and PaneHost rendering an empty
  placeholder pane for `review` (the real pane is batch C). Tests in `tab-meta.test.ts`.

**S3 — wiring (after S1 and S2)**
- `packages/server/src/server.ts` — routes `GET /scm/repo`, `GET /scm/status`, `GET /scm/file`,
  `GET|POST|PATCH|DELETE /scm/comments`, `POST /scm/stage|unstage|restore`; every comment write broadcasts
  `scmComments`; status answers carry `commentsRev`. Route tests in `scm-routes.test.ts` (temp repos).
- `packages/server/src/index.ts` — call `releaseAllLocks()` from `shutdown` and `process.on('exit')`.
- `CLAUDE.md` — a "Source Control" section (routes, trust model, limits, poll contract, snapshot, the
  three writes and the lock protocol, comments store and `.cache` boundary) and the rewritten
  "Rollout: older bundles erase the new keys" paragraph (the merge closes it).

## Contracts

The wire types are the two shared files above.
`server/src/scm-comments.ts` exports `listComments(top)`, `createComment(top, input)`, `updateComment(top,
id, patch)`, `deleteComment(top, id)` (each resolves `{ rev, comments }`) and `latestRev(top)`.

## Gates (one runner, sequential)
- `yarn typecheck`
- `cd packages/server && npx vitest run` (the server suite is self-contained), `cd packages/shared && npx
  vitest run`, and in client only `npx vitest run src/session/tab-meta.test.ts src/panes`
- `yarn lint`

## Rules (every agent)
- No git write command of any kind (no `add`, `commit`, `stash`, `checkout`, `reset`, `init`...). Tests that
  need a repository create it under `os.tmpdir()` through the code under test's own runner or `execFile('git',
  ...)` inside the test process: that is test fixture setup in a throwaway directory, not a git write by the
  agent. The agent itself never runs git write commands in a shell.
- Never start, stop or restart the palmux service on :44040, never `tmux kill-server`, never `pkill -f`.
- Touch only the files your stream lists. Report anything else you would change instead of changing it.
- Scoped tests only, run sequentially; never run the client's whole suite in parallel with another.
- Follow CLAUDE.md conventions and `~/.claude/rules/typescript.md`; comments only where they explain why.
