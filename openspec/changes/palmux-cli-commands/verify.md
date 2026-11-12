# palmux-cli-commands: end-to-end check (task 6.4)

Run 2026-11-08, 23:22–23:35 Lisbon, Chromium (Playwright MCP) at 1440x900.

## Setup

- Server: a scratch palmux on `127.0.0.1:44099`, started from this checkout with `tsx src/index.ts`,
  `PALMUX_NO_AUTH=1`, `PALMUX_CONFIG_DIR=/tmp/palmux-cli/cfg`, client built into `/tmp/palmux-cli/dist`.
  The task names `./scripts/dev.sh`, which binds :44040, where prod runs, so dev.sh refuses to start
  there. The scratch port is the equivalent. Prod :44040 was not restarted and its dist was not
  rebuilt.
- Repository: `/tmp/palmux-cli/repo`, a Go repo with ` M internal/cli/cli.go`, ` D CONTRIBUTOR.md` and
  untracked `feature40/` and `scratch/`. Two comments seeded through `POST /scm/comments`.
- CLI: `scripts/palmux` run from the shell inside a palmux terminal, through a helper that appends
  each command, its output and `exit=$?` to `/tmp/palmux-cli/e2e.log`.
- Screenshots: `.playwright-mcp/cli-e2e/` in the checkout.

## Results

| # | Command (cwd) | Exit | Output | What the window showed |
|---|---|---|---|---|
| 1 | `palmux open cli.go ../../README.md` (`repo/internal/cli`) | 0 | `opened …/cli.go`, `opened …/README.md` | Two pinned editor tabs, README.md selected (`01-open-two.png`). Server log: `cli open tty=pts/8 -> 200 opened=2 failed=0` |
| 2 | Same command again | 0 | Same | No new tabs (still 3), README.md selected |
| 3 | `palmux open . missing.go cli.go` | 1 | `opened …/cli.go`; `…/internal/cli: path is a directory`; `…/missing.go: not found` | cli.go selected; nothing else opened. Log: `opened=1 failed=2` |
| 4 | `palmux git` (`repo/internal/cli`) | 0 | `Source Control: /tmp/palmux-cli/repo` | Dock switched to Source Control on `/tmp/palmux-cli/repo` (`02-git-nested.png`). `settings.json` gained the repo in `scmRepos` and has no `scmActiveRepo`; the browser's local settings have it active |
| 5 | `palmux git` (`/tmp`) | 1 | `palmux: path is not a git repository` | Nothing changed |
| 6 | `palmux comments` (`repo/internal/cli`) | 0 | The agent document: title, instruction naming the top, `## internal/cli/cli.go`, `### …:L1-L2 (new)` and `### …:L4 (new)` with fenced Go code and the bodies | — |
| 7 | `palmux help` | 0 | The four-command usage | — |
| 8 | `palmux comments` (no palmux terminal: a shell outside the app, stdin `/dev/null`) | 0 | Same document as 6 | Log: `cli comments tty=- -> 200 comments=2` |
| 9 | `palmux open README.md` (no palmux terminal) | 1 | `no open palmux terminal is on pts/19: run this inside a palmux terminal` | — |
| 10 | `palmux git` (no palmux terminal) | 1 | Same message | Log: `cli git tty=pts/19 -> 409 …` |
| 11 | `palmux open go.mod` inside `tmux -L palmuxe2e` in the palmux terminal | 0 | `opened …/go.mod` | go.mod tab opened and selected |
| 12 | `palmux git` in a detached window's terminal | 0 | `Source Control: …` then `palmux: this window has no Source Control panel` | Detached window unchanged (no dock) |
| 13 | `palmux open ../../README.md ../../LICENSE` in the detached window | 1 | `opened …/LICENSE`; `…/README.md: open in another window` | LICENSE opened in the detached window; README stayed in the main window (`03-detached.png`) |
| 14 | `palmux comments` against prod :44040 (the pre-change server) | 1 | `this palmux server predates \`palmux comments\`; restart it` | — (read-only request) |
| 15 | `palmux comments` after Clear all | 0 | Empty output | — |
| 16 | `palmux open /tmp/palmux-cli/repo/./internal/../go.mod` (after the codex-3 path fix; server restarted) | 0 | `opened /tmp/palmux-cli/repo/go.mod` | The existing go.mod tab was selected; no second tab |

## Follow-up commands (2026-11-09, same scratch setup, server and client rebuilt)

Added after the owner asked for `-v`/`--version`, common CLI conventions and `code`-like commands.

| # | Command (cwd `repo`) | Exit | Output | What the window showed |
|---|---|---|---|---|
| 17 | `palmux -v` | 0 | `palmux 1.2.0+cf7d3b6` | — (no request sent) |
| 18 | `palmux status` (in a palmux terminal) | 0 | `palmux …`, `server … at http://127.0.0.1:44099`, `tty pts/20: terminal 0, shown in the main window` | — |
| 19 | `palmux status` (outside palmux, stdin `/dev/null`) | 0 | `tty pts/18: not a palmux terminal` | — |
| 20 | `palmux status` with no server on the port | 1 | `palmux 1.2.0+cf7d3b6`, then `cannot reach the palmux server` | — |
| 21 | `palmux open long.txt:150:6` | 0 | `opened …/long.txt` | Edit mode, line 150 centred, cursor at column 6 (`10-open-line.png`) |
| 22 | `palmux open doc.md:4 notes:12 missing.go:3` | 1 | doc.md and `notes:12` opened; `missing.go: not found` | doc.md in Edit at line 4 (`11-md-edit.png`); the file literally named `notes:12` opened as itself |
| 23 | `palmux open long.txt:20` (tab already open) | 0 | `opened …/long.txt` | Existing tab selected and moved to line 20 (`12-open-again.png`) |
| 24 | `palmux web 5173`, twice | 0 | `opened http://localhost:5173/` | One `localhost` web tab; the second call selected it (the frame shows the proxy's 502: nothing listens on 5173) |
| 25 | `palmux web ftp://x` / `palmux web` | 1 / 2 | `not a port or an http(s) url` / usage | — |
| 26 | `palmux open --wait doc.md` | 0 | `opened …/doc.md`, then nothing until the tab closed | No `exit=` while the tab was open; closing the tab ended the command within one poll. Log: `cli wait tty=- -> 200 open=0` |

## Window-side comment controls

- Source Control `Copy comments` (`scm-copy-comments`) put the same document as row 6 on the
  clipboard (`04-copy-comments.png`).
- The `cli.go (Changes)` review listed both comments with Edit, Resolve and Delete
  (`05-review-comments.png`). Resolve removed one and showed "Comment resolved · Undo"
  (`06-resolved-toast.png`); Undo brought it back (2 comments, server rev 4).
- `Clear all comments` (`scm-clear-comments`) asked "Delete all 2 comments in repo? This cannot be
  undone.", and on OK the server answered `{"rev":5,"comments":[]}`. The comments bar and the review's
  Copy button went inactive (`07-cleared.png`).
- In a review pane under 500px wide, the View options menu lists Copy comments and Clear all comments
  after the code-size stepper (`08-narrow-menu.png`). A wide review has no View options menu, so it
  offers Copy comments in the bar and leaves Clear all to Source Control.

## Gates at the time of the run

`yarn typecheck`: 0 errors. `yarn lint`: warnings only. `yarn test` after the last fixes: client 4992,
server 1065, shared 157, all passing.

## What would invalidate this

- A change to the `/cli` reply shape, `CLI_COMMANDS`, the `cliOpen`/`cliGit`/`cliResult` frames or
  the 3 s answer window, because rows 1–13 exercised exactly that path.
- A window still on an older bundle. It drops `cliOpen` and the command times out with a 504. Not run
  live; only `cli-api.test.ts` covers it.
- `callerTty` meeting a terminal setup other than a plain palmux shell or tmux with its own socket
  (screen, a nested ssh, a tmux started outside palmux). Only these two were run.
- A browser other than Chromium, or a real phone. Neither was run; the phone layout of the review menu
  is covered by unit tests only.
- The server sending `tabCreated` before the `sessions` broadcast that lists the tab. The client only
  keeps an earlier open's tab unshown (`silent`) when the list arrives first. Today `createTab` and
  `replaceTab` broadcast synchronously (`registry.onListChanged` → `broadcast`) before the
  `tabCreated` reply on the same socket, so it always does.
- Two spellings of one file through a symlink (`/a/link/b.ts` and `/a/real/b.ts`). `open` normalises
  with `path.resolve`, which does not follow links, so these are still two tabs. This is the same
  url-string identity the rest of the app uses.
- Rows 17–26: a change to `CliGoto`, `cliWeb`, `CLI_WAIT_MS`/`CLI_APPEAR_MS`, or the `wait`
  reply. `--wait` past a server restart (the 60 × 1 s retry) and `--wait` as `GIT_EDITOR` were not run
  live; `palmux-cli.test.ts` covers the retry. A hidden editor pane receiving a goto was covered by
  unit tests only.
- The restart. Rows 1–16 went live in prod :44040 with the 2026-11-08 23:47 restart. Rows 17–26 need
  another restart (the server must know `web`, `status`, `wait` and the goto field), which ends every
  live terminal.
