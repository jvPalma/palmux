## Context

`palmux ~/.tmux.conf` must open that file in the browser window the user is
already using. The registry side of that is easy — `createTab` + `listChanged`
broadcasts to every client, so a tab created over HTTP appears in every strip
with no WebSocket from the CLI. The hard half is **targeting**: which window
should move.

The constraint that makes it hard is deliberate, not incidental.
`browser-local-tab-selection` states that which tab a window shows "MUST NOT be
sent to the server", and the reason is load-bearing: two palmux windows on one
host must hold different tabs — that is what having two windows means — so the
server holds the tab LIST and never the SELECTION. A naive
"server remembers the active tab, CLI tells it to change" design is not
available, and would be wrong if it were.

So the server can only ever learn two things: which window is in front (a fact
about the window, not about palmux), and — from inside a palmux shell — which
tab that shell belongs to. Both are enough, and neither is the selection.

## Goals / Non-Goals

**Goals**
- `palmux <path>` opens the file in the window that ran the command.
- A command run from outside palmux (SSH, a desktop terminal) targets the most
  recently focused window.
- Read-only queries over the same route: `tabs`, `groups`, `settings`, `status`.
- One `palmux` command. The existing launcher behaviour — bare invocation,
  `--print-config`, the systemd unit — is unchanged.

**Non-Goals**
- **Writes.** No settings setter, no file creation, no tab close. A text
  interface that mutates state needs a decision about what it may change without
  showing the user what it is changing, and that decision is not this one.
- **Remote CLI.** The CLI runs on the same host as the server: it reads that
  host's secret, and `PALMUX_TAB_ID` only exists in a shell that server spawned.
  Pointing it at a remote instance is a separate feature with a separate auth
  story.
- Serving multiple running instances, or discovering one on a non-default port
  without `PALMUX_PORT`.
- Tab targeting that guesses. See D3.

## Decisions

### D1 — `PALMUX_TAB_ID`, exported into the shell

`buildShellEnv(base, opts)` gains `opts.tabId`, and `spawnInto()` passes the
registry id it already holds. The CLI reads `process.env.PALMUX_TAB_ID` and
sends it as `from`.

The alternative considered and rejected was inferring the source from the
connection: the CLI could open a WebSocket and the server could match it to a
pane. That is strictly worse — it needs a handshake, it breaks when the CLI is
run from a script rather than a shell, and it cannot see through `sudo` or a
detached job.

`PALMUX_TAB_ID` is exact rather than heuristic because of how PTYs are spawned: a
terminal tab's PTY is created only by an attach to `/ws?session=<id>`, so the id
in the environment cannot drift from the tab the shell lives in. It survives
handoff and cold restore, both of which respawn under the same id.

**It is deliberately withheld inside tmux.** A tmux server hands its own
environment to every pane it creates, forever — so `$PALMUX_TAB_ID` read inside
tmux can name a tab from a session that ended days ago. `sourceTab()` returns
`undefined` when `process.env['TMUX']` is set, which falls back to the `active`
ping (D3). This is the one case where the exact join is unavailable, and reading
a stale id would move a window the user did not ask to move.

### D2 — `focusTab` carries `from`, and the server broadcasts when it is set

`{type: 'focusTab', id, from?}` is a new `ServerMessage`.

- `from` **set** ⇒ the server sends it to **every control socket**, and each
  client decides locally whether it matches. This is required, not lazy: the
  spec forbids the server knowing any window's selection, so it cannot address
  the matching window even if it wanted to.
- `from` **absent** ⇒ the server sends it to the control socket with the
  greatest `lastActiveAt` — the one window worth guessing about, and only
  because the command came from outside palmux entirely.

Client rule, in `workspaceController.decide` so it stays pure and testable:

- pop-out → no effect (a pop-out has no strip to move)
- `from` set and ≠ this window's active tab → no effect
- target tab not in the broadcast → no effect
- otherwise `[{type: 'navigate', id}]`

The last rule is the safe failure. If `from` names a tab no window is showing —
the user closed it, or opened the file from a shell whose tab is gone — nothing
navigates and the tab simply appears in the strip. Guessing a different window
would move a view the user did not ask to move.

### D3 — the `active` ping carries NO tab id

A new `{type: 'active'}` `ClientMessage`, sent by each client on control-socket
open, window `focus`, and `visibilitychange`-to-visible. It carries **no
fields**, and that is the whole design: it says "this window is in front", which
is a fact about the browser, and never "this window is showing tab 3", which is
the selection the spec keeps off the wire.

This is the narrow exception `browser-local-tab-selection` needs written down.
Without it the requirement reads as forbidding a mechanism the feature requires,
and the next reader either breaks the feature or breaks the rule.

### D4 — `connections` becomes a `Map`

`connections` in `attachWebSocket` is a flat `Set<WebSocket>`. It becomes
`Map<WebSocket, {isControl, lastActiveAt}>` — still one collection, carrying the
two facts the filter needs. `broadcast` iterates keys; `closeSockets` is
unchanged.

`attachWebSocket` returns a `focusTab(id, from?)` closure over that map, and
`createServer` hands it to `registerCliRoutes`. A return value rather than
`app.decorate`: the only caller is `createServer` itself, and `decorate` would
need module augmentation to stay typed.

Registration order matters: `registerCliRoutes` is called right after
`attachWebSocket(...)`, not beside the other route registrations, because those
run before the socket layer exists and `focusTab` closes over it.

### D5 — the existence check lives in the route, not in the registry

`registry.createTab` gates only `isAbsolute`. The CLI's `open` additionally
checks that the path exists and is a **regular file**, and rejects a directory
with its own message.

This is a deliberate divergence from the WS `createTab` path. A text interface
is where typos happen, and `palmux ~/.tmux.con` silently minting a broken editor
tab is worse than an error — the user sees a tab, assumes it worked, and
discovers otherwise later. The WS path keeps its current behaviour because the
Explorer only ever offers paths it has already listed.

**The cost, measured:** the CLI runs on the same host and could `stat` the path
itself, so a server-side check means a typo is reported only after a round trip —
and against a server predating this capability, `palmux ~/.tmux.con` answers "the
server is running an older palmux" rather than "no such file", which is the less
useful of the two. A local check would fix that case and duplicate the gate,
creating the second place that can disagree that D6 exists to prevent. Left as a
round trip: the misleading message only appears in the transient upgrade window,
and the duplicated gate would be permanent.

### D6 — the reuse rule is `openFileTab`'s, moved server-side

`open` reuses an existing `editor` tab whose `url` matches the path, else creates
one; the reply says which (`{id, created}`), because "moved to the tab already
showing this" and "opened a new tab" look identical otherwise.

`editor` tabs only. A `markdown` tab is a different surface with its own reader,
and the only thing that creates one is the New-tab chooser — the Explorer never
does, and the CLI is the Explorer's keyboard equivalent. So the two rules cannot
disagree in practice. **What would invalidate this:** a second place that creates
editor tabs and disagrees about reuse.

### D7 — one command, two bundles

`scripts/bundle.mjs` emits a second esbuild output, `bin/palmux-cli.mjs`, from
node builtins only. Measured: 9.6 KB against the server bundle's 2.0 MB. The CLI
runs at a shell prompt, so its start time is the feature.

The generated `bin/palmux` launcher routes argv:

- no arguments, a leading `-`, or `serve` → the server entry, so
  clone-and-run, `--print-config` and the service unit keep working unchanged
- a known subcommand → the CLI
- anything else → the CLI, so `palmux nonesuch` says "no such file" rather than
  silently starting a server

A file literally named `tabs` is shadowed by the subcommand; `palmux open ./tabs`
is the escape hatch, documented in the README.

From source, `yarn palmux <args>` runs the CLI through tsx. `yarn test` and
`yarn typecheck` pick up `packages/cli` automatically — both are
`yarn workspaces foreach -A`.

### D8 — the CLI duplicates three facts from the server, on purpose

Cookie name, secret filename, default port. Importing `@palmux/server` would
drag Fastify, node-pty and the whole registry into a command that sends one
request and exits.

Each duplicated fact names its source of truth in a comment, and each fails
loudly: a drifted cookie name is a 401, a drifted secret path is a 401, and a
drifted port is a connection error. The alternative — a shared constants module
— would put the CLI's start time back on the table for three strings.

## Open decisions

Four things were found during implementation that change behaviour outside the
CLI's own boundary. Each is **left undone** rather than decided silently.

### F11 — `allowedIps` blocks the CLI (needs the owner)

The CLI dials `127.0.0.1`, which `allowedIps` governs like any other source. A
host configured `allowedIps: ["192.168.1.0/24"]` therefore gets a 403 from the
CLI while every LAN browser works. The default is empty, so the CLI works out of
the box — but the failure for a host that has set it is confusing, and the fix
(exempt loopback) is a **change to a security boundary**. That is the owner's
call, not this change's.

### F10 — the CLI cannot find a server started with `-p`

`resolvePort` reads `PALMUX_PORT` then `config.json`, so a server started with
`palmux serve -p 5000` is invisible to the CLI unless the env var is exported.
The fix is to write `<configDir>/runtime.json` on `listen`. Not done here
because it adds a persisted file whose lifecycle (stale after a crash, a second
instance, `--host ::` being IPv6-only) needs its own decision.

### F12 — argv dispatch is in the `sh` launcher, not a TS entry

`bin/palmux` is a shell script, so `yarn start` and the systemd unit — which
invoke `index.ts` directly — do not get the dispatch. They do not need it today
(both are server-only), but the asymmetry means `palmux tabs` behaviour depends
on which of the two entry points is in use. Moving dispatch into one head TS
entry would make them identical.

### F7 — the path gate is duplicated

`cli-api.ts` re-implements the `regularFile` check that `file-rw.ts` already
has privately. Reusing it means exporting a helper whose name is about `/file`,
not about tabs, which is why it was not done inline.

## Risks

- **The CLI is used mostly from outside palmux** (SSH, a desktop terminal),
  which would make the `active` ping the primary path rather than the fallback,
  and the minimal version here worth less. Unmeasured; would change the
  priority of D3 relative to D1.
- **`PALMUX_TAB_ID` through tmux** is withheld by design (D1), so a tmux user
  always lands on the `active` fallback. If that proves wrong in practice — if
  the front window is usually not the one the user means — targeting needs a
  real signal out of tmux rather than a fallback.
- **A second editor-tab creator** appearing and disagreeing with D6.
