# Proposal

## Why

`palmux download` proved that a shell inside palmux can drive the browser window it runs in, but it is
the only command. Opening a file or a repository's Source Control still means leaving the shell for the
Explorer or the dock, and the review comments meant for an AI agent are reachable only through an
icon-only "Copy comments" that the owner did not find, then a paste. palmux 1.3.0 closes that loop:
the agent (Claude Code, or any other) reads the comments itself, and the shell opens what it names.

Source: `openspec/brainstorms/2026-11-02-v1-3-scm-cli-preview.md` (items 9–13), reviewed by five
Goldfish reviewers; its decisions are kept here.

## What Changes

- **`palmux open <path>...`** opens each file as a pinned editor tab in the palmux window the command
  ran in. A path is absolute, `~/…`, `./…` or plain relative (read from the shell's directory).
- **`palmux git`** finds the git work tree the shell's directory is in (any nested folder works),
  adds it to the project list if missing, makes it the active project on that window's device and
  opens Source Control there. Outside a work tree it exits 1 and changes nothing.
- **The window answers.** `open` and `git` wait up to 3 seconds for the window to report what it did
  (opened, held by another window, refused); the CLI prints that and exits 0 only on success. No answer
  is exit 1, never a false 0.
- **Old and new halves say so.** Every `/cli` answer names the commands the server supports, so a CLI
  newer than the running server prints "this palmux server predates `palmux <cmd>`; restart it".
- **Every CLI request is logged** by the server (command, tty, outcome).
- **`palmux comments`** prints every review comment of the shell's repository to stdout as agent-ready
  markdown. It needs no palmux terminal, so an agent can run it as a subprocess. Its text is the same
  text Copy comments puts on the clipboard, outdated marks included.
- **The export becomes agent-ready**: a short preamble telling the reader what to do, then
  `path:Lstart-Lend` headings. One exporter serves the button and the CLI.
- **Copy comments is visible**: a labelled button in the review's top bar and a per-file copy on each
  file header that has comments (the Source Control icon stays).
- **Resolve** deletes a comment without asking and offers Undo; **Clear all** deletes every comment of
  the project after one confirmation that names the count.
- `palmux download` is unchanged and is specified for the first time.

## Capabilities

### New Capabilities

- `palmux-cli`: the `palmux` command run from a shell on the palmux host — how it finds its terminal and
  window, its commands (`download`, `open`, `git`, `comments`), their answers and exit codes, and the
  endpoint's trust and compatibility rules.

### Modified Capabilities

- `source-control`: "The view starts with no project" gains one explicit exception: `palmux git` may
  name a project from the shell's directory, because the user asked for it by name.
- `review-comments`: "Comments can be edited and deleted" gains Resolve and Clear all; "Comments export
  as one markdown document" gains the agent format, the review-bar and per-file copy, and the CLI path.

## Impact

- **Server**: `packages/server/src/cli-api.ts` (new commands, pending-answer map, supported-commands
  list, logging), `palmux-cli.ts` (argument parsing, new commands, messages), `server.ts` (route the
  window's answer, `DELETE /scm/comments?all=1`), `scm-snapshot.ts` (a read that keeps no staging
  token), `scm-comments.ts` (delete all).
- **Shared**: new protocol frames (`cliOpen`, `cliGit` server→client; `cliResult` client→server). The
  comment exporter, comment placement, line anchoring and the language table move from the client to
  `packages/shared` so the server can produce the same markdown.
- **Client**: `TerminalPane.tsx` (handle the two frames, answer), `App.tsx` (open / git handlers), the
  review bar and file header (copy buttons), `CommentCard.tsx` (Resolve), Copy comments wiring.
- **Restart**: the new commands and routes need a server restart (under systemd that costs every live
  terminal; it needs the owner's OK at deploy time). Until then the CLI says the server predates them.
- **Depends on** sibling change `preview-tabs` for the pinned entry point of `openFileTab`; if it is
  not there yet this change uses `openFileTab(path, { preview: false })` and adds the opened/held result
  itself (see design D3).
- **Not run here**: the config rule asks for an `opsx-zoom-out` pass on this proposal. This change was
  written by a worker that may not spawn agents, so that pass is owed before `/opsx:apply`; the brief it
  comes from already had one (0 critical).
