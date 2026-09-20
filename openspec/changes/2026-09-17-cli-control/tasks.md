## 1. Source tab — `PALMUX_TAB_ID`

- [x] 1.1 `PtyOptions.tabId`; `buildShellEnv(base, opts)` exports `PALMUX_TAB_ID`
- [x] 1.2 `spawnInto()` passes the registry id it already holds
- [x] 1.3 `pty.test.ts`: the variable is present with a tab id, absent without one
- [x] 1.4 `sourceTab()` in the CLI returns `undefined` when `TMUX` is set — a tmux
      server hands its environment to every future pane, so the value can name a
      tab that ended days ago

## 2. Protocol

- [x] 2.1 `FocusTabMessage { type, id, from? }` — `from` omitted, never
      `undefined`, because an absent key and `from: undefined` must be
      indistinguishable to an `in` check
- [x] 2.2 `ActiveMessage { type: 'active' }` — no fields by design (D3)
- [x] 2.3 `parseServerMessage` / `parseClientMessage` cases
- [x] 2.4 `protocol.test.ts`: `focusTab` round-trips with and without `from`; a
      non-string `from` is DROPPED rather than coerced; a `focusTab` with no id
      is rejected; `active` ignores any payload riding with it

## 3. Server — `POST /cli`

- [x] 3.1 `connections` Set → `Map<WebSocket, {isControl, lastActiveAt}>`;
      `broadcast` iterates keys, `closeSockets` unchanged
- [x] 3.2 `attachWebSocket` returns `focusTab(id, from?)`: with `from` → every
      control socket; without → the one with the greatest `lastActiveAt`
- [x] 3.3 `case 'active'` in the message switch stamps `lastActiveAt`
- [x] 3.4 `cli-api.ts`: `open` (validate → reuse-or-create → `{id, created}`),
      `tabs`, `settings`, `status`
- [x] 3.5 `registerCliRoutes(app, deps)` called after `attachWebSocket(...)`,
      not beside the other route registrations — `focusTab` closes over the map
      that call creates
- [x] 3.6 `open` refuses a relative path, a missing path, and a directory, each
      with its own message (D5)
- [x] 3.7 `cli-api.test.ts`: create, reuse, every refusal, and the `focusTab`
      emission — including that a stale `from` still emits, so the tab appears
      in the strip even when no window moves
      · AMENDED during implementation: the registry helper must be built with
      in-memory stores. `createSessionRegistry`'s defaults point at the REAL
      `<configDir>/`, and it sweeps tty hints at construction — so a test taking
      the defaults DELETES the restore hints of the palmux running on the
      machine, costing its terminals the tmux `switch-client` knowledge only the
      hint channel carries. Verified by the disappearance of
      `restore: swept 4 stale tty hint(s)` from the test output.

## 4. Client

- [x] 4.1 `lib/ws.ts`: `sendActive()` beside `sendCreateTab` — one typed method
      per message, no generic escape hatch
- [x] 4.2 The control socket sends `active` on open, on window `focus`, and on
      `visibilitychange`-to-visible
- [x] 4.3 `workspaceController.decide` gains the `focusTab` case: popout → none;
      `from` mismatched → none; target absent → none; else `navigate`
- [x] 4.4 `App.tsx` control-socket `onMessage` dispatches it
- [x] 4.5 `workspaceController.test.ts`: all four branches
- [x] 4.6 `App.test.tsx`: the control-socket switch routes `focusTab`

## 5. CLI package

- [x] 5.1 `packages/cli/{package.json,tsconfig.json}` as a workspace
- [x] 5.2 `args.ts`: a bare word is a PATH, not a misspelled subcommand;
      `open <path>` is the escape hatch for a file named like a subcommand;
      flags and `serve` are refused with the command that does work
- [x] 5.3 `client.ts`: port from `PALMUX_PORT` → `config.json` → 44040; always
      dials `127.0.0.1` (the configured `host` is `0.0.0.0`, not a destination);
      reads `<configDir>/secret` and never creates one
- [x] 5.4 `index.ts`: `process.exitCode` rather than `process.exit()`, so a
      stdout write to a draining pipe is not truncated
- [x] 5.5 `args.test.ts` (10), `client.test.ts` (5), `render.test.ts` (15)
- [x] 5.6 `render.ts` labels a tab by name → title → NOTHING
      · AMENDED during implementation: the fallback was the KIND, which made the
      common case print it twice — a fresh terminal has neither a name nor an
      OSC title, so `palmux tabs` on a new instance read `0  terminal  terminal`
      on every line. The kind has its own column.

## 6. Bundling

- [x] 6.1 `scripts/bundle.mjs` emits `bin/palmux-cli.mjs` (node builtins only)
- [x] 6.2 The `bin/palmux` launcher routes argv: none / leading `-` / `serve` →
      the server; everything else → the CLI
- [x] 6.3 Root `package.json` gains a `palmux` script for running from source
- [x] 6.4 Measured: `palmux-cli.mjs` is **9.6 KB** against the server bundle's
      **2.0 MB** — the separate bundle exists so a command at a shell prompt
      does not pay for Fastify and node-pty
- [x] 6.5 Launcher dispatch verified on three argv shapes: `--print-config` →
      the server entry (printed config JSON), `help` → the CLI (printed HELP),
      a path → the CLI (proper error, exit 1)
- [x] 6.6 A 2xx that is not JSON is reported as a STALE SERVER, not a parse
      failure
      · AMENDED during implementation. Measured with `curl` against a deployed
      instance: without a cookie `401 text/plain`, but WITH one the SPA fallback
      answers `200 text/html`, 2708 bytes — because the running service predates
      the `/cli` route. That is the ORDINARY upgrade path (`yarn bundle`, service
      still on the old bundle), so the message names it. The first version said
      "the server sent no JSON", which names the symptom and reads as a palmux
      bug rather than a stale process.

## 7. Verification

- [x] 7.1 `yarn typecheck` clean
- [x] 7.2 `yarn test`: **1644 passing** — cli 30, client 1070, server 515, shared 29
- [x] 7.3 Live end-to-end, `./scripts/dev.sh` + an authenticated window:
      a palmux terminal runs `yarn palmux ~/.tmux.conf` and the window switches
      to a new editor tab showing the file
      · Run on `PALMUX_PORT=44041` rather than against prod: :44040 serves a
      bundle predating `/cli`, so the route is unreachable there until the
      service is restarted, and restarting is the owner's call. `PALMUX_PORT`
      is read by all four processes that need to agree (the dev.sh guard, the
      server bind, the vite proxy target, the CLI's port resolution), so the
      whole stack moves with no file edit.
- [x] 7.4 Re-running the same command focuses the existing tab, no duplicate
      · `{id, created:false}` on the second run; the tab count did not move.
- [x] 7.5 Two windows on different tabs; run from the first's shell → only the
      first moves
      · Window 1 held tab 9 and moved to 11; window 2 booted to 7 (first in
      strip order, empty sessionStorage) and stayed there while its strip grew
      to 14. The `focusTab` broadcast reached both; window 2 rejected it on the
      local `from` filter, which is the design.
- [x] 7.6 Run from a terminal outside palmux → the most recently focused window
      moves
      · `env -u PALMUX_TAB_ID ... ./bin/palmux /home/user/.zshenv` moved window
      2, which had been focused last. Exercises the `active`-ping fallback.
- [x] 7.7 `palmux tabs`, `groups`, `settings`, `status`
      · `groups` answered `400 unknown command: groups` on the first pass —
      the server's command switch had no case for it. Fixed (see the note in
      `cli-api.ts`) and re-verified live.
- [x] 7.8 `palmux /nonexistent`, `palmux /tmp` (a directory), `palmux rel/path`
      → clear errors, no tab created
- [x] 7.9 `yarn bundle`, then re-run 7.3 against `bin/palmux` to prove the
      launcher dispatch end to end
      · `bin/palmux.mjs` 2.0 MB + `bin/palmux-cli.mjs` 9.7 KB; the launcher
      opened the file and exited 0.
- [x] 7.10 (added) A relative path resolves against the CALLER's directory on
      both entry points. `yarn palmux <rel>` routed through `yarn workspace`,
      which re-roots cwd at `packages/cli` AND rewrites `INIT_CWD` to the same
      place — so `yarn palmux ../README.md` from `scripts/` looked for
      `packages/README.md`. The root script now invokes node on the source
      directly (see the note in `index.ts`), which keeps the caller's
      directory recoverable.

## 8. Documentation

- [x] 8.1 This change: proposal, design, tasks
- [x] 8.2 Spec deltas: new `cli-control`; modified `workspace-tabs`,
      `browser-local-tab-selection`, `file-browser`, `editor-pane`
- [x] 8.3 `README.md`: the command, the subcommands, the window-targeting rule,
      and the `palmux open ./tabs` escape hatch
