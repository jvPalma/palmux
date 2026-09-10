# palmux

A self-hostable, GPU-accelerated web terminal. Open a browser tab, get a real shell on
the host running the server. Built to be genuinely usable on mobile to drive `tmux`.

## What it is

- **Client** — a React app built on [`react-xtermjs`](https://github.com/Qovery/react-xtermjs)
  wrapping `@xterm/xterm`, rendered with the WebGL addon. xterm.js provides VT parsing,
  scrollback, mouse reporting, text selection, search, and clickable links natively.
- **Server** — a TypeScript [Fastify](https://fastify.dev) app that serves the built client,
  upgrades `/ws` with [`ws`](https://github.com/websockets/ws), and bridges each socket to a
  PTY via [`node-pty`](https://github.com/microsoft/node-pty). Run directly with `tsx`.
- **Mobile** — the headline feature. A Termux-style extra-keys bar (sticky `CTRL`/`ALT`/`SHIFT`,
  arrows, tmux prefix combos) plus touch gestures (pinch-zoom, tap-to-focus-pane, swipe-scroll,
  long-press select + copy) make running `tmux` from a phone practical.

It is coupled to no cloud and no host: anywhere Node 22 and a shell run, palmux runs.

## Requirements

- **Node 22+** (Node 24 works)
- **Yarn 4** (the repo pins `yarn@4.13.0` via `packageManager`)
- A shell (`$SHELL`, falling back to a login shell)
- **`tmux`** — optional, but the mobile layer is designed around driving it

## Quick start

```sh
yarn install
yarn build          # builds shared + client (Vite) + typechecks server
yarn start          # starts the server on :44040
```

On first start the server generates a token, prints it, and tells you where to
authenticate:

```
palmux listening on http://localhost:44040
config: /home/you/.config/palmux
auth: token required — authenticate at http://localhost:44040/auth
token: <64-hex-character token>
```

Open `http://localhost:44040/auth`, paste the token, and you're in. The token is
persisted at `~/.config/palmux/secret`, so subsequent starts print the same one.

### Configuration — one place for everything

**`~/.config/palmux/config.json`** (created with defaults on first run) is the single source of
truth. Precedence: **CLI flags > `PALMUX_*` env vars > config.json > defaults**. Inspect the fully
resolved result with `yarn start --print-config`.

```json
{
  "host": "0.0.0.0",
  "port": 44040,
  "auth": true,
  "shell": null,
  "cwd": null,
  "fontDirs": ["~/.fonts"],
  "allowedIps": [],
  "allowedOrigins": [],
  "scrollbackBytes": 524288,
  "cookieDays": 365,
  "maxUploadBytes": 52428800,
  "webApps": [],
  "markdownRoots": []
}
```

| field             | meaning                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `host`, `port`    | bind address / listening port                                                                                                                                                                                |
| `auth`            | token-cookie auth (`false` only on trusted networks)                                                                                                                                                         |
| `shell`, `cwd`    | shell to spawn (default `$SHELL`) and starting directory (default home)                                                                                                                                      |
| `fontDirs`        | directories scanned recursively for servable fonts                                                                                                                                                           |
| `allowedIps`      | exact IPs or CIDR ranges — `"192.168.1.5"`, `"10.0.0.0/24"`, `"fd00::/8"`. Applies to **every** request and WebSocket upgrade, `/auth` included. Empty = allow all                                           |
| `allowedOrigins`  | allowed `Origin` values for WebSocket upgrades — `"term.example.com"`, `"https://term.example.com"`, `"*.example.com"` (subdomain wildcard), `"host:44040"` (port-exact). Empty = allow all                  |
| `scrollbackBytes` | per-session output ring buffer replayed on reconnect                                                                                                                                                         |
| `cookieDays`      | session-cookie lifetime                                                                                                                                                                                      |
| `maxUploadBytes`  | max size of a pasted/dropped/picked upload (default 50 MB). Enforced server-side (413) and pre-checked client-side                                                                                           |
| `webApps`         | apps offered on the new-tab page — `[{ "name": "SilverBullet", "url": "https://sb.local", "icon": "📓" }]`. `icon` is optional. Opening one creates a pre-named web tab                                      |
| `markdownRoots`   | directories the **markdown viewer** can browse (`~` expanded). Listing is confined to these; opening a file by absolute path is not (same trust as the shell). Empty = browsing off, direct paths still work |

Invalid entries are reported and ignored at boot — a typo can't brick the server. Restart the
service after editing (`yarn service:update` or `systemctl --user restart palmux`).

### Run at boot (systemd user service)

```sh
yarn service:install     # build + generate the unit for THIS checkout/node + enable at boot
yarn service:update      # rebuild client + restart the service (kills live sessions!)
yarn service:status      # health + recent logs
yarn service:uninstall   # stop, disable, remove
```

The unit is regenerated from the current repo path and node binary on every install — after
moving the repo or switching node versions, just re-run `yarn service:install`.

### Prebuilt runtime (`bin/`) — no build on the target

`yarn bundle` compiles a **self-contained runtime** into `bin/` that runs with only Node (≥ 22) —
no yarn, no `node_modules`, no toolchain on the target:

```
bin/
├── palmux.mjs            single ESM server bundle (fastify/ws/fontkit/… inlined)
├── build/Release/pty.node   the node-pty native addon (platform-specific!)
├── client/              the built web client
└── palmux               launcher (./bin/palmux) — sets PALMUX_CLIENT_DIR, runs the bundle
```

Build it on a machine of the **same OS/arch** as the target (the `.node` is native — an x64 bundle
won't run on arm64), then commit it:

```sh
yarn install && yarn bundle
git add -f bin           # bin/build sits under a gitignored name; force-add once, then it stays tracked
```

With `bin/` committed to master, a fresh target just needs Node — clone and `./bin/palmux`. To ship
multiple architectures, run `yarn bundle` on each and commit the results side by side.

### Run at boot WITHOUT systemd (containers, minimal images)

On a box with no `systemctl` (a Docker-style container, a chroot, anything that only gives you a
boot hook such as `onBoot.sh`), use the supervised launcher `scripts/run.sh`. With `bin/` committed
(above), there is **no setup step** — just Node on the target. (Without the bundle it falls back to
the source path, which needs `corepack enable && yarn install && yarn build` once.)

Then, from your boot hook (`onBoot.sh`), launch it **in the background**:

```sh
# onBoot.sh
export PATH="$HOME/.nvm/versions/node/vXX/bin:$PATH"   # only if node isn't already on PATH at boot
# export PALMUX_NODE=/usr/local/bin/node               # …or point straight at the node binary
# export PALMUX_CONFIG_DIR=/data/palmux                # if $HOME is ephemeral (keeps the auth token!)
nohup "$HOME/palmux/scripts/run.sh" >/dev/null 2>&1 &
```

`scripts/run.sh` runs the server in a restart loop (crash → relaunch after 2 s) and logs to
`$PALMUX_LOG` (default `<repo>/palmux.log`). It only needs **Node ≥ 22** at runtime — it refuses to
start (with a clear log line) if the client bundle is missing. The auth token is generated on first
run at `$PALMUX_CONFIG_DIR/secret` (default `~/.config/palmux/secret`) — `cat` it to authenticate at
`/auth`, and edit `config.json` there for host/port/`allowedIps`/`allowedOrigins`.

> **Ephemeral filesystems:** if the container wipes `$HOME` on each boot, set `PALMUX_CONFIG_DIR` to a
> persisted volume — otherwise the token (and your config) regenerate every restart.

### CLI flags & environment

```
Usage: palmux [options]

  -p, --port <n>     Port to listen on (default 44040, env PALMUX_PORT)
      --host <addr>  Bind address (default 0.0.0.0, env PALMUX_HOST)
      --no-auth      Disable token auth (localhost dev only; env PALMUX_NO_AUTH=1)
      --new-token    Rotate the session token and exit
  -h, --help         Show this help
```

| Variable            | Default            | Purpose                                                |
| ------------------- | ------------------ | ------------------------------------------------------ |
| `PALMUX_PORT`       | `44040`            | Listening port                                         |
| `PALMUX_HOST`       | `0.0.0.0`          | Bind address                                           |
| `PALMUX_CONFIG_DIR` | `~/.config/palmux` | Where the secret, settings, and extra-keys config live |
| `PALMUX_NO_AUTH`    | unset              | Set to `1` to disable auth (same as `--no-auth`)       |

- **`--no-auth`** skips the token entirely. Use it only when binding to `localhost` for
  local development — there is no other access control.
- **`--new-token`** rotates the secret, invalidating every existing browser session, then exits.

```sh
yarn start --no-auth            # localhost dev, no token
yarn start --new-token          # rotate the token and exit
PALMUX_PORT=9000 yarn start # listen on :9000
```

## Development

Run the server in watch mode and the Vite dev server side by side:

```sh
# Terminal 1 — server on :44040 (tsx watch, restarts on change)
yarn dev:server

# Terminal 2 — Vite dev server on :5173 with HMR
yarn dev:client
```

Open `http://localhost:5173`. Vite proxies `/ws`, `/auth`, `/logout`, and `/ping`
through to the backend (default :44040, override with `PALMUX_PORT`). Authenticate
once at `http://localhost:5173/auth` with the token the server printed, or start the
server with `--no-auth`.

```sh
yarn test        # vitest across all packages
yarn typecheck   # tsc --noEmit across all packages
```

## Mobile usage

Toggle **mobile mode** in Settings (it also auto-detects on touch devices). Mobile mode
turns on the on-screen affordances:

- **Extra-keys bar** — a Termux-style toolbar above the soft keyboard. `CTRL`, `ALT`, and
  `SHIFT` are sticky modifiers: **tap** to arm one-shot (green — applies to the next key only),
  **long-press** to lock (orange — applies to every key until tapped off, e.g. lock `CTRL` and
  arrow through a long history). The bar also carries `ESC`, `TAB`, arrows, and a configurable
  tmux **prefix** combo. The layout follows the Termux extra-keys schema and is server-synced.
- **Pinch-zoom** — pinch to change font size live.
- **Tap to focus a pane** — a tap is translated into a mouse click, so tapping inside a
  `tmux` split focuses that pane.
- **Swipe-scroll** — drag to scroll the viewport; when an app has mouse tracking on, swipes
  become wheel events.
- **Long-press to select + Copy** — long-press starts a selection; a **Copy** action writes
  it to the clipboard (with an `execCommand` fallback where the Clipboard API is unavailable).
- **File upload** — paste an image (Ctrl+Shift+V), drag **any** file onto the terminal, or use
  the ⬆ button (top bar on desktop, drawer footer on mobile). The file is saved to a temp path
  on the server and that absolute path is typed into the shell — hand it straight to a CLI (e.g.
  Claude Code) or press Enter. Capped by `maxUploadBytes` (50 MB default).
- **File download** — the ⬇ button (top bar on desktop, drawer footer on mobile) pulls files
  OFF the server: give it an absolute path for a single file, a glob (`/home/user/notes/*.md`),
  or a directory — globs and directories arrive as one `.zip` (built in-process, no extra
  tools). Also works as a plain URL: `GET /download?path=<path-or-glob>` (cookie-gated like
  everything else — same trust boundary as the shell itself, which can already read any file).
  Caps: 500 files / 256 MB per zip.

### Install as an app (PWA)

palmux is installable: it ships a web-app manifest and icons, and opens standalone
(no browser chrome) once installed — Chrome/Edge show an **Install** entry in the menu,
Android offers **Add to Home screen**, iOS Safari **Share → Add to Home Screen**.

Two things to know:

- Browsers only offer the standalone install from a **secure context** — HTTPS or
  `localhost`. Over plain LAN HTTP you get a regular shortcut that opens in the browser
  instead. Put palmux behind HTTPS (reverse proxy, Tailscale, etc.) for the full app feel.
- The manifest and icons are served **without** the auth cookie by design (browsers fetch
  them credential-less during install); everything else stays behind the token, and the
  `allowedIps` rules still apply to them.

There is deliberately no service worker: a terminal is useless offline, and stale-cache
bugs against an authed WebSocket app are worse than a network-fresh load.

## Images in the terminal

palmux renders **SIXEL** and **iTerm2 inline images** — real pixels on the GPU canvas, not
unicode blocks. On by default; *Settings → Terminal → Inline images* turns it off.

```bash
timg -ps photo.png          # sixel
chafa -f sixel photo.png    # sixel
imgcat photo.png            # iTerm2 protocol
```

**Pass the format flag.** palmux announces itself as sixel-capable the standard way (its DA1
reply is `CSI ?62;4;9;22c`, and it answers XTSMGRAPHICS), but `timg` 1.5.2 and `chafa` 1.14
don't ask — they pick a protocol from a built-in table of terminal *names*. timg's own man page
recommends `alias timg='timg -ps'`.

**Inside tmux it works**, and tmux does use the DA1 answer, but it asks **once, when a client
attaches**. A tmux client that attached before you upgraded palmux still thinks the terminal has
no sixel and draws a `SIXEL IMAGE (81x23)` box of `+` characters instead of the picture. Fix:

```bash
tmux detach          # then re-attach — the new client re-queries
```

To skip the negotiation entirely, state it in `~/.tmux.conf`:

```tmux
set -as terminal-features ",xterm-256color:sixel"
```

**yazi needs no configuration.** It probes the terminal properly (kitty query, XTVERSION,
`CSI 16t`, `OSC 11`, then `CSI 0 c`) and picks the adapter from the answers — `yazi --debug`
reports `Adapter.matches: Sixel` both inside and outside tmux, and previews render at the
image's native resolution.

**lazygit cannot show images in its panels, by construction.** Its TUI rasterises everything
into a cell grid and drops the DCS sixel escape (verified: text printed around the image
survives, the escape never reaches the terminal). The only way to real pixels is to suspend the
TUI — a custom command with `output: terminal`:

```yaml
customCommands:
  - key: "<c-v>"
    context: "files"
    description: "View image at full resolution"
    command: 'palmux-view-image "{{.SelectedFile.Name}}"'
    output: terminal
```

Known limits:

- **`timg -pi` (iTerm2) draws nothing.** The renderer requires a `size=` field in the
  `OSC 1337;File=` header; timg omits it. `imgcat` sends it and works. Use `-ps` with timg.
- **No Kitty graphics protocol.** It only exists in an xterm.js beta line two major versions
  ahead; the iTerm2 protocol covers the same clients.
- **Animation and video are a bad idea.** Every frame crosses the WebSocket as raw pixel data.
- Memory is capped per pane — on mobile at 2048×2048 per image and a 32 MB cache, on desktop at
  4096×4096 and 128 MB. Images beyond the cap are dropped; evicted ones leave a placeholder.

## Customizing the extra-keys toolbar

The toolbar is configured by **`~/.config/palmux/extra-keys.json`** (created with a default
on first run). The server loads it and **hot-reloads on save** — edit, save, and the toolbar
updates live (no page refresh). It follows the [Termux extra-keys schema](https://wiki.termux.com/wiki/Touch_Keyboard).

A key is either a **bare string** (a key name or a single character) or an **object**:

| field     | meaning                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`     | key name (`ESC`, `TAB`, `UP`, `HOME`, `PGUP`, `F1`…) or a single character to send                                                                                  |
| `display` | label override (cosmetic; decoupled from what is sent)                                                                                                              |
| `macro`   | a space-separated key sequence sent as one chord (e.g. `"CTRL A CTRL K"`). Modifier tokens apply to the next key                                                    |
| `popup`   | a key (string or object) sent on **long-press** of this key — shown small in the corner                                                                             |
| `action`  | a named UI action run on **long-press** instead of a popup (takes precedence). Only `"keyboard"` today — raise/dismiss the soft keyboard. A tap still sends the key |

`CTRL` / `ALT` / `SHIFT` are sticky modifiers — **tap** to arm for the next key, **long-press** to
lock on until tapped off. Example:

```json
{
  "enabled": true,
  "layout": [
    [
      { "key": "ESC", "action": "keyboard" },
      "/",
      { "key": "-", "popup": "_" },
      "HOME",
      "UP",
      "END",
      "PGUP"
    ],
    ["TAB", "CTRL", "ALT", { "macro": "CTRL B C", "display": "win+" }, "DOWN", "RIGHT", "PGDN"]
  ]
}
```

By default **ESC carries `"action": "keyboard"`**, so long-pressing ESC toggles the soft keyboard —
a reliable way to raise it on mobile without tapping the terminal (a ⌨ hint shows in the key's corner).

A bare Termux-style array-of-arrays (no `{ enabled, layout }` wrapper) is also accepted.

## Architecture

Yarn 4 workspaces monorepo (`node-modules` linker):

```
packages/
├── shared/   wire protocol as plain-TS discriminated unions (no codegen)
├── server/   Fastify static host + ws upgrade + node-pty, token-cookie auth, config persistence
└── client/   React + Vite + react-xtermjs (webgl/fit/search/web-links/clipboard/unicode11)
```

### Workspaces

The URL path is the workspace: `/0`, `/1`, `/2`, … (bare `/` is `0`), and `/new` redirects to
the lowest free number — bookmark it to always land in a fresh session. Each number is its own
persistent shell on the server — close the tab, come back later, and the session is intact with
its recent scrollback replayed (vscode `serve-web` semantics). Terminal shells live in the server
process's memory: they survive any number of client disconnects, but a server restart ends them
(that's what `tmux` inside a session is for).

#### Chrome-style tabs & tab kinds

The top bar is a browser-style tab strip. Click a tab to switch, click its ✕ to close (terminals
confirm first — you land on the closed tab's **left strip neighbor**, else the right one, and
the New-tab page appears as real content when nothing is left), `+` opens the **new-tab
popover** (anchored, non-blocking — the terminal stays visible; any outside click dismisses it). Any tab can be **renamed** (double-click, or
right-click → Rename; long-press a drawer row on mobile) and given one of **12 theme-aware accent
colors** (right-click menu / mobile sheet) — the same color name renders in whatever theme is
active. Names and colors are persisted server-side and synced to every device.

The selected **color theme skins the whole app** — topbar, tabs, panels, drawer, and controls all
follow the terminal palette, not just the xterm canvas — and the built-ins include **light themes**
(Catppuccin Latte, GitHub Light, Solarized Light) with matching `color-scheme`. Pick it in Settings;
it applies before first paint (no flash) and live on change.

A tab has a **kind**:

- **terminal** — a PTY shell, exactly as before.
- **web** — an embedded page (iframe): any URL, a configured app, or a same-origin HTML artifact.
  Third-party sites that send `X-Frame-Options`/`frame-ancestors` can't be framed (a hard browser
  limit) — the pane's ⧉ button opens them in a real browser tab instead. HTML dropped into
  `~/.config/palmux/artifacts/` is served at `/artifacts/<name>` (cookie-gated, traversal-safe) and,
  being same-origin, always embeds.
- **dashboard** — a configurable grid of links; also the new-tab page. Deployment apps come from
  `config.json` `webApps`; per-user quick links live in synced settings and are editable in place.
- **editor** — the Monaco editor (VS Code's editor: multi-cursor, find/replace, its keybindings)
  bound to a note under `~/.config/palmux/notes/<id>.md`. Loads lazily (nothing downloads until you
  open one), saves on Ctrl+S and on idle. `GET`/`PUT /pane-file?tab=<id>` back it.

Non-terminal tabs and every tab's name/color persist to `~/.config/palmux/tabs.json`, so they
survive a server restart (a terminal slot keeps its name/color and respawns a fresh shell on next
attach; its process is not resurrected).

#### Rearrange tabs (drag to reorder)

Drag a tab along the strip to move it, Chrome-style — an accent bar marks the insertion point.
Display order is **decoupled from tab id**: `/0 /1 /2` URLs are stable identities and never change;
the order is a separate property, **server-authoritative** (shared live across every connected
device) and persisted via `tabs.json`'s array order, so it survives restarts. New tabs always
append at the end — a recycled low id never teleports into the middle of the strip. Split-member
tabs move like any other (the pairing follows the tab). Dropping a tab on the strip only reorders;
un-splitting is the per-slot **⏏ eject**.

#### Group tabs (Chrome-like)

Right-click a tab → **New group from this tab** (or **Add to _group_**) to cluster related tabs
behind a colored **chip**. Grouped tabs are always kept **contiguous** in the strip — the server
pulls members together and keeps them together through any reorder. A group has its **own name and
color, independent of each tab's**: a member shows _both_ — its own accent as the top stripe and the
group color as an underline + faint wash. The group model is **server-authoritative** and shared
across every connected device; it persists across restarts (per-tab `groupId` in `tabs.json` plus a
`groups.json` sidecar, both additive so an older build still loads).

Grow a group by dragging a tab onto the **middle** of a member (a group-colored ring previews the
join); a group of one is valid and grows the same way. Drag a member **fully out** of the cluster to
leave it. Drag the **chip** to move the whole block at once. **Rename / recolor / Ungroup / Close
all** live on the chip's right-click menu (Ungroup keeps every tab and its own color; Close all is a
single confirmation that names the terminal kill count and warns about unsaved editor tabs).

**Collapse** a group by clicking its chip — the members fold away and the chip shows a count; click
again to expand. Collapse is **per device** (it isn't on the wire). If you were viewing a member it
first hops to the nearest tab outside the group; if the group _is_ the whole strip it refuses with a
toast. Landing on a collapsed member by any route (back/forward, a split re-tile, closing the tab you
were on) **auto-expands** the group. On mobile the same groups appear as tappable headers in the
sessions drawer.

#### Split view (desktop)

See two tabs at once — any pairing, including **two terminals** or an editor beside a shell.
Right-click a tab → **Split right / Split down**, or **drag a tab to a screen edge**.

The split is a stable **pairing of exactly two tabs**, shown only while the active tab is one of
them (Chrome-tab-group style): selecting any other tab — or creating a new one with **+** — shows
it **full-width**, and the pairing re-tiles when you return to a member. Both members carry a
**◧/◨ badge** in the strip; the lit badge is the focused slot. Replacing a slot's content is an
explicit gesture: **drag a tab onto a slot**. Each slot has an **⏏ eject** control that removes it
(the other tab goes full-width; nothing is closed). Drag the divider to resize (each slot 15–85%),
**⬍/⬌** flips orientation. Click a slot to
focus it (the focused slot drives the URL and the keyboard). The layout is remembered per device.
Split is **desktop-only** — the mobile layer always shows a single tab.

#### Pop out to a window

Right-click a tab → **Open in new window** to pop it into a separate browser window on the same
session. Because a session is a server-side PTY, both windows **mirror the live shell** (like
`tmux attach` from two places), sized smallest-window-wins so neither renders wrapped garbage. The
popped window is chrome-less with a **⇱ return to main** button; closing it never ends the session.

### Wire protocol

A single WebSocket carries two kinds of frames:

- **Binary frames** are **raw PTY bytes** — client keystrokes server-bound, terminal output
  client-bound. No framing, no protocol overhead.
- **Text frames** are JSON control messages defined in `packages/shared`:
  - **Server → client:** `ready`, `settings`, `extraKeys`, `sessions`, `snapshot`, `fonts`, `exit`
  - **Client → server:** `resize`, `settings`, `extraKeys`, `kill`

The WebSocket upgrade carries the workspace id (`/ws?session=2`); the server keeps one PTY per
id in a registry and replays a 512 KB output ring buffer to (re)connecting clients. The same
registry backs **`POST /upload?session=<id>&filename=<name>`** (auth-gated like everything else):
it streams the body to a temp file with a hard size cap and returns `{ path }` for the client to
inject into the PTY.

The server treats `settings` and `extraKeys` as **opaque JSON it persists and rebroadcasts** —
the client owns the schema. Settings and the extra-keys layout therefore roam across browsers
and devices without the server needing to understand them.

## Authentication

A single **shared token** gates access:

- The token is a 64-character hex string (32 random bytes) stored at
  `~/.config/palmux/secret`. It is generated on first start and never leaves the server.
- Visiting `/auth` gives you a token form; submitting it (a POST, so the token never reaches a URL
  or an access log) sets a session cookie; the cookie is the credential for all
  subsequent requests, including the `/ws` upgrade.
- `--new-token` rotates the secret and invalidates every existing session.
- `--no-auth` disables the check entirely (localhost only).

There is no proxy-header trust, SSO, or per-user identity — anyone with the token (or any
client reaching a `--no-auth` server) gets a shell on the host. Bind to `localhost` or put it
behind your own authenticating reverse proxy / tunnel for anything beyond local use.

## What you get

- **A real shell**, one PTY per tab, surviving browser reloads and reconnects on a
  512 KB replay ring.
- **Tabs, groups and splits** — Chrome-like strip with drag-reorder, colours, and
  desktop split view. Non-terminal tabs too: a file explorer, a Monaco editor, a
  markdown viewer, and framed web pages.
- **A mobile layer that is the point** — Termux-style extra-keys bar with sticky
  modifiers, pinch-zoom, swipe-scroll into `tmux`, native text selection, and a
  soft-keyboard path built around Android IME composition.
- **Inline images** — SIXEL and iTerm2 IIP, drawn over the WebGL canvas.
- **Themes that leave the browser** — pick one and palmux regenerates your shell
  prompt, `tmux` bar and `git-delta` colours from the same palette.
- **Survives a restart** — terminals come back in their working directory with the
  foreground command typed back in; `tmux` sessions reattach because `tmux`'s own
  server outlives palmux.

## License

[MIT](./LICENSE) for palmux's own code. Two sets of bundled assets keep their
upstream terms:

- **File icons** — the [Material Icon Theme](https://github.com/PKief/vscode-material-icon-theme),
  MIT. Licence at `packages/client/public/file-icons/LICENSE.txt`.
- **Fonts** — JetBrains Mono (Nerd Fonts patched) and Noto Color Emoji, both
  SIL Open Font License 1.1. Licence and attribution at
  `packages/client/public/webfonts/LICENSE.txt`.
