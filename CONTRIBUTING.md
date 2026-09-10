# Contributing to palmux

## What this project is

palmux is a self-hostable, GPU-accelerated terminal you reach from a browser,
built so that driving `tmux` from a phone feels like Termux. Full TypeScript —
a Fastify + `node-pty` server and a React + xterm.js client.

It is a terminal, not a multiplexer. palmux runs `tmux` inside a real shell and
concentrates on making that usable: touch gestures, a soft-keyboard layer that
survives Android IMEs, and a tab strip for the shells you keep open.

## Getting set up

```bash
yarn install
yarn dev:server     # backend on :44040 (tsx watch)
yarn dev:client     # Vite on :5173, proxies /ws and friends to :44040
```

`PALMUX_NO_AUTH=1` skips the token gate on localhost. Before opening a PR:

```bash
yarn test           # vitest across all three packages
yarn typecheck      # tsc --noEmit
yarn lint           # oxlint
```

All three must be clean. There is no CI in this repository — the gates are the
three commands above, run locally.

## What belongs here

- **Terminal fidelity** — rendering, the WebGL pipeline, escape-sequence
  handling, inline images, fonts and glyph coverage
- **The mobile layer** — touch gestures, the extra-keys bar, IME composition,
  text selection. This is the reason the project exists; it gets the most care.
- **Session durability** — reconnects, the replay ring, surviving a restart
- **Panes** — the file explorer, editor, markdown and web tabs, and the tab model
  around them
- **Self-hosting** — install, service management, config, themes

## What does not belong here

- Coupling to any single cloud, host or corporate environment. palmux runs
  anywhere a shell and Node 22 run, and that is a feature.
- A multiplexer of our own. `tmux` already solved sessions, windows and panes,
  and it keeps them alive when the browser is gone.
- Integrations with external SaaS.
- Anything that reaches the network from the server without the operator asking
  for it.

## House rules

These are not style preferences; they come from defects this project already
paid for.

1. **Comments explain WHY, never WHAT.** Many comments here record a measurement
   or a browser quirk. If you change behaviour a comment describes, update the
   comment in the same diff. If you find one that is wrong, fixing it is a
   welcome PR on its own.
2. **Measure before you claim.** "This is faster" needs a number. Several
   decisions in `CLAUDE.md` were reversed by measurement after seeming obvious.
3. **Tests are behavioural.** Assert what a user sees or what a byte stream
   contains — not implementation shape. Colocate them: `Thing/Thing.test.tsx`.
4. **One thing per PR.** Keep refactors out of behaviour changes.
5. **Nothing animates inside the terminal grid.** Compositing over the WebGL
   canvas costs frames that read as input latency.

`CLAUDE.md` is the long-form engineering context: why each non-obvious thing is
the way it is. It is worth reading before a substantial change, and it is the
place to record a finding a future reader would otherwise have to rediscover.

## Reporting issues

Open a [GitHub issue](https://github.com/jvPalma/palmux/issues). Include:

- What you did, what you expected, what happened
- Browser and OS, and whether you are in the installed PWA or a browser tab
- Server log lines and browser console output
- For a mobile input bug: a raw byte capture beats a description. Run
  `stty raw` in the terminal and record what actually reaches the PTY —
  `cat -v` cannot show you a backspace, because the tty eats it first.
