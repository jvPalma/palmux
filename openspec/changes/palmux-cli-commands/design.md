# Design

## Context

See proposal.md for why. What exists:

- `scripts/palmux` runs `packages/server/src/palmux-cli-main.ts` with the checkout's tsx; `palmux-cli.ts`
  parses arguments (`runCli`), finds the caller's tty (`callerTty`: `tmux display-message -p
  '#{client_tty}'` under tmux, else the first of fds 0–2 that is a `/dev/pts/N`), resolves paths
  (`serverPath`) and posts JSON to `POST /cli` with the secret as the session cookie (`localPost`).
- `cli-api.ts` accepts only `{cmd:'download', tty, paths}`, refuses an `Origin` (403), finds the terminal
  with `registry.terminalOnTty(tty)` and sends a `download` frame with `app.sendToTerminal(id, msg)` on
  the data socket attached to that terminal (`terminalSockets` in `server.ts`, last attach wins). There
  is no answer from the window.
- The window side is `terminal/TerminalPane.tsx` (`msg.type === 'download'`), mounted per pane by
  `session/GroupsView.tsx` with props from `App.tsx`.
- Files open through `App.openFileTab(path)` (focus if open, toast if another window holds it, else
  `createTab({kind:'editor', url})`). Projects are added in `scm/SourceControlView.tsx` (`normalizePin`
  of `/scm/repo`'s top, then `onChange({scmRepos, scmActiveRepo})`). `scmRepos` is synced, the active
  project is per device (`settings.ts`).
- The comment exporter (`review/export-md.ts`), placement (`review/comment-placement.ts`), line anchoring
  (`review/anchor.ts`), the language table (`panes/editor-language.ts`) and the outdated check
  (`commentMarks` in `scm/copy-comments.ts`) are client modules. The server stores comments only
  (`scm-comments.ts`) and reads snapshots (`scm-snapshot.ts` `readSnapshot`), each read adding a staging
  token to a shared 64 MB cache (`putToken`).

## Goals / Non-Goals

**Goals:** the four commands of `specs/palmux-cli`, an honest exit status for every window command, one
exporter for the button and the CLI, Resolve and Clear all.

**Non-Goals:** `palmux tabs | groups | status | settings`; targeting a window from a shell outside
palmux (SSH, a desktop terminal) — the old `jvPalma/dev` 6db54ba design's "most recently focused window"
fallback is not taken; a stored "resolved" state; opening a folder in the Explorer.

## Decisions

### D1 — Window commands ride the terminal's data socket, as `download` does

`open` and `git` reuse `terminalOnTty` + `sendToTerminal`. The data socket attached to the caller's
terminal IS the caller's window, detached windows included, with no knowledge of any window's selection.
Rejected: the 6db54ba design (`PALMUX_TAB_ID` in the shell env + a `focusTab` broadcast to every control
socket, each window matching it locally). It needs a new env var that tmux makes stale, a broadcast every
window must filter, and it was written for a CLI package this repo no longer has.

### D2 — The window answers with `cliResult`, and the server waits at most 3 s

New frames in `packages/shared/src/protocol.ts`:

```ts
// server → client (data socket)
interface CliOpenMessage { type: 'cliOpen'; requestId: string; paths: string[] }
interface CliGitMessage  { type: 'cliGit';  requestId: string; repo: string }
// client → server (same data socket)
interface CliResultMessage {
  type: 'cliResult';
  requestId: string;
  results: { path: string; ok: boolean; error?: string }[];   // open: one per path; git: one, path = repo
  note?: string;                                             // git: e.g. "this window has no Source Control panel"
}
```

`parseServerMessage` keeps `cliOpen` only with a string `requestId` and a non-empty string `paths`
array, `cliGit` only with string `requestId` and `repo`; `parseClientMessage` keeps `cliResult` only with
a string `requestId` and an array of `{path: string, ok: boolean, error?: string}` (extra or wrong-typed
entries dropped), `note` only when a string.

`cli-api.ts` keeps `pending: Map<requestId, { ws: WebSocket; resolve(r: CliResultMessage | null) }>`.
`requestId` is `randomUUID()`. It sends the frame, arms a 3000 ms timer (`CLI_ANSWER_MS`) that resolves
`null`, and `server.ts`'s message switch hands every `cliResult` to `app.cliAnswered(ws, msg)`, which
resolves the entry only when `msg.requestId` is pending AND `ws` is the socket it was sent on (anything
else is ignored). A `null` answers the CLI `504 {error: 'no palmux window answered within 3 s'}`.
`sendToTerminal` returning false (no open socket) is the existing 409. To get at the socket the frame
went on, `sendToTerminal` is replaced by `terminalSocket(id): WebSocket | undefined` (the decorator's
only caller is `cli-api.ts`); `download` keeps its fire-and-forget behaviour.
Rejected: fire-and-forget for `open`/`git` too — a window on an older bundle drops an unknown frame and
the CLI would exit 0 having done nothing (systems review).

### D3 — `openFileTab` reports what it did

`palmux open` calls the pinned entry point the sibling change `preview-tabs` defines in its design
("Contract for scm-row-actions and palmux-cli-commands"). Until that lands, this change uses
`openFileTab(path, { preview: false })` and changes its return type to `'opened' | 'held'`: `'held'` when
another window holds the tab (its existing toast still shows), else `'opened'` (focused or created).
`preview` is accepted and ignored until `preview-tabs` implements it. If `preview-tabs` lands first with a
different signature, task 3.2 adapts to it; the outcome values do not change.

The window opens the paths in order (the last one ends selected, because every successful open selects
or creates in the focused pane) and answers `{path, ok: true}` or `{path, ok: false, error: 'open in
another window'}` per path.

### D4 — Server validates `open` paths before the window sees them

`cli-api.ts` expands a leading `~`/`~/` with `os.homedir()` (the rule `download.ts` `expandHome` already
applies; it is exported for this), requires the result absolute, and runs `file-rw.ts` `regularFile`
plus the size check `readTextFile` applies (the same `maxUploadBytes` cap `GET /file` uses, passed in as
`maxEditBytes`). Refused paths go to `failed` with that module's message (`not found`, `path is a
directory`, `not a regular file`, `file is N bytes; the editor limit is M`). Only the survivors are sent;
when none survive no frame goes out and the answer is `200 {opened: [], failed}` (exit 1).

### D5 — `palmux git`: the server finds the top, the window writes the settings

Body `{cmd:'git', tty, cwd}`. `cli-api.ts` runs `scm-git.ts` `resolveRepo(cwd)`; a failure answers
`400 {error: <its message>}` (e.g. `path is not inside a git work tree`) and no frame is sent. On success
it sends `cliGit {repo: top}`. The window runs `addScmProject(settings, top)` — a pure helper extracted
from `SourceControlView.tsx`'s add flow into `scm/scm-projects.ts` and used by both — which returns
`{scmActiveRepo: top}` when `normalizePin(top)` is already listed, else `{scmRepos: [...repos, top],
scmActiveRepo: top}`; App applies it with `updateSettings` (the normal synced save, merged by the server,
so an older window cannot erase it), then calls `openSourceControl()`. In a detached window (no dock, no
drawer) it applies the settings and answers `note: 'this window has no Source Control panel'`, `ok: true`.
The answer is `200 {repo: top, note?}`.
Rejected: the server writing `scmRepos` itself. Settings are written only by windows today, the active
project is per device and cannot be set from the server at all, and a server write races a window's
stale save (systems review).

### D6 — `palmux comments` needs no tty and runs the same exporter on the server

Body `{cmd:'comments', cwd}` (no `tty`). `cli-api.ts` runs `resolveRepo(cwd)`, `listComments(top)`,
`getStatus(top)`, then the shared `commentsMarkdown(top, status, comments, read)` where `read` is
`readSnapshot({top, group, path, oldPath, algorithm: 'histogram', keepToken: false})`. Answer `200
{markdown}`; an empty list answers `{markdown: ''}`. A status failure is not fatal: the document is
produced unmarked, as the client already does with no status.

`readSnapshot` gains `keepToken?: boolean` on `SnapshotRequest` (default `true`); `false` skips
`putToken` so a CLI loop never evicts receipts. The anchoring compares side texts only, so the algorithm
is irrelevant to the marks; `'histogram'` is the client default.

The move to `packages/shared/src/` (flat, like the package's other modules; plain TS, no DOM, no React):

| From (client) | To (shared) |
|---|---|
| `review/anchor.ts` (+ test) | `anchor.ts` |
| `review/comment-placement.ts` (+ test) | `comment-placement.ts` |
| `review/export-md.ts` (+ test) | `export-md.ts` |
| `panes/editor-language.ts` (+ test) | `editor-language.ts` |
| `commentMarks` / `commentsMarkdown` / `ReadSnapshot` from `scm/copy-comments.ts` | `comment-marks.ts` (`read` becomes a required argument) |

`packages/shared/src/index.ts` re-exports all five. Every client importer switches to `@palmux/shared`
(no client re-export files are left behind: one implementation). `scm/copy-comments.ts` keeps only
`copyPendingText` and a thin `commentsMarkdown(repo, status, comments)` that passes `fetchScmFile`.

### D7 — The agent-ready document

Exactly:

~~~~
# Review comments

Address each review comment below in <top>. A heading names the file, the line range and the side
(old = before the change, new = after it); the fenced block is the code the comment was written on.

## <path>

### <path>:L<start>-L<end> (<side>)<mark>

```<lang>
<stored lines>
```

<body>
~~~~

One line is `:L<n>`. `<mark>` is ` (outdated)` or ` (not shown: file too large / converted)` as today.
Files in path order, comments in today's `byPosition` order. The per-file copy is the same function with
the comments filtered to one path. No comments → `''` (no preamble). The CLI prints the string as is.

### D8 — Supported commands and the "restart it" message

`cli-api.ts` exports `CLI_COMMANDS = ['download', 'open', 'git', 'comments'] as const` and every reply
body (200, 400, 403, 409, 504) carries `commands: CLI_COMMANDS`. The CLI prints `palmux: this palmux
server predates \`palmux <cmd>\`; restart it` when the body is not JSON, or has no `commands` array, or
the array lacks `<cmd>`. A 400 that lists the command prints its `error` as today.

### D9 — Resolve and Clear all

Resolve: `CommentCard` gets a Resolve control (`review-comment-resolve`, `check` icon) beside Edit and
Delete. It calls the comments store's `remove(id)` without a confirm, then shows the existing write toast
"Comment resolved" with Undo for its normal 6 s; Undo calls `create(input)` with the deleted comment's
`path, side, start, end, lines, before, after, body, version` (the store mints a new id and
`createdAt`). Clear all: `DELETE /scm/comments?repo=<top>&all=1` → `scm-comments.ts`
`deleteAllComments(top)` (one read-modify-write under the per-file mutex, `comments = []`, `rev + 1`,
answers the whole list, broadcast like every write). The control asks
`window.confirm('Delete all <n> comments in <name>? This cannot be undone.')` with `n` from the store's
current list; a `DELETE` with neither `id` nor `all=1` stays a 400.

### D10 — Logging

`cli-api.ts` logs `console.info(\`palmux: cli ${cmd} tty=${tty ?? '-'} -> ${status} ${outcome}\`)` once
per request, where `outcome` is `sent=N failed=M` (download), `opened=N failed=M` / `no answer` (open),
`repo=<top>` / `no answer` / the refusal (git), `comments=N` (comments), or the error. Same convention as
`server.ts`'s `/files/delete` warning; no file content or comment text.

## Risks / Trade-offs

- [The window answers after the user switched tabs] → the open still happens in the focused pane; the
  answer is about the open, not about what is on screen.
- [A slow window over a proxy misses the 3 s] → the CLI says no window answered and exits 1 although the
  open may still land; the message says "answered", not "failed". 3 s is far above a LAN round trip.
- [Clear all deletes comments another window just added] → it deletes what the server holds at that
  moment; the confirm count may be one short. Accepted: the action is "delete everything".
- [Moving five modules to shared touches many imports] → a pure move with tests moved alongside; the
  typecheck and the moved tests are the guard (phase 1 lands alone).
- [`palmux comments` on a project with many commented files reads one snapshot per file per group]
  → sequential, no tokens kept; output size is unbounded, as the button's already is.

## Migration Plan

1. Ship the client and server together; the server needs a restart for `open`, `git`, `comments`,
   `cliResult` and `DELETE …&all=1` (owner's OK, under systemd it costs every live terminal).
2. Before the restart: a new CLI says the server predates the command; the old server's 400 for a new
   `cmd` is caught by D8. Resolve works (it is a plain delete); Clear all answers 400 from the old server
   and the client shows its error toast.
3. Rollback: the protocol additions are optional frames; an old server ignores `cliResult`, an old client
   drops `cliOpen`/`cliGit` (the CLI then reports no answer). Comments storage is unchanged.
