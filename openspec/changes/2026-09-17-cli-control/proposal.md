## Why

Every palmux action needs the browser. Opening a file means finding it in the
Explorer tree, and there is no way at all to ask a running instance what tabs it
has, what groups exist, or what its settings are — from a shell, from a script,
or from inside a palmux terminal.

That is the gap VS Code closed with `code`: a system-level command that talks to
a **running** instance. The canonical case here is
`palmux ~/.tmux.conf` — the file opens as an `editor` tab in the instance the
user is already looking at, and **that browser window switches to it**. Not a
new window, not a separate UI.

Three facts make this cheap rather than a new subsystem:

- The tab registry is **server-authoritative**. `registry.createTab()` calls
  `listChanged()`, which is wired to `broadcastSessions` — so an HTTP route can
  create a tab and every browser learns about it with no WebSocket involvement.
- `openFileTab()` (`App.tsx`) already encodes "focus the editor tab over this
  path, else create one". The dedupe rule exists; it only has to move
  server-side so the CLI and the Explorer cannot disagree.
- `buildShellEnv` (`pty.ts`) is the single place a shell's environment is built,
  and the tab id is already in hand at that call site — so a shell can be told
  which tab it lives in at no cost.

The one thing that is NOT cheap is targeting a window. Which tab a window shows
is browser-local by spec, so the server cannot know it and cannot address the
right window directly. That is the design problem this change solves.

## What Changes

- **`PALMUX_TAB_ID`** is exported into every shell palmux spawns, naming the tab
  that shell lives in. Correct by construction: a terminal tab's PTY is only
  ever spawned by an attach to `/ws?session=<id>`, so the id cannot drift.
- **`POST /cli`** — one authenticated route hosting the CLI's commands. Same
  cookie gate as every other route, so no new trust model.
- **`palmux <path>`** opens that file as an `editor` tab, reusing an existing
  tab already showing the same path. Read-only queries: `tabs`, `groups`,
  `settings`, `status`.
- **`focusTab`** (server→client) makes the window that ran the command navigate
  to the new tab. `active` (client→server) is a bare "I am the window in front"
  ping, used only when the command came from outside palmux.
- **One `palmux` command, two bundles.** The `bin/palmux` launcher routes argv:
  no arguments / a leading `-` / `serve` run the server exactly as today;
  everything else runs the CLI. `yarn start` and the systemd unit are untouched.

Explicitly NOT in this change: **writing** anything. `settings` is a getter,
there is no `palmux settings --set`, and no route here writes a file. Writes are
the interesting case and they need their own decision about what a text
interface may change without showing the user the file it is changing.

## Capabilities

### New Capabilities
- `cli-control`: the `palmux` command surface, `POST /cli`, the window-targeting
  rule, and the `PALMUX_TAB_ID` → `focusTab.from` join.

### Modified Capabilities
- `workspace-tabs`: a tab may be created over HTTP as well as over the wire, the
  server arbitrates the one-editor-tab-per-path rule, and `focusTab` plus the
  `active` ping are added to the protocol.
- `browser-local-tab-selection`: the "selection MUST NOT be sent to the server"
  rule gains a stated, narrow exception — a window may announce THAT it is in
  front, never WHICH tab it is showing.
- `file-browser`: the "SHALL NOT expose any write operation" requirement is
  scoped to the listing endpoint, so it does not read as forbidding `POST /cli`.
- `editor-pane`: a URL-backed editor tab gains a second way in (the CLI), and
  the server becomes the single owner of the reuse-by-path rule.
