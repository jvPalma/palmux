# palmux

A generic, self-hostable GPU-accelerated **web terminal**, built to make driving **tmux on mobile**
feel like Termux. Full TypeScript stack — no Go, no Cloud Workstations coupling.

- **Client**: React over `@xterm/xterm` 6, hosted directly by `terminal/useTerminal.ts` (no wrapper
  library), with the WebGL renderer (GPU). Vite build.
- **Server**: TypeScript (Node 24) — Fastify static host + `ws` + `node-pty`. **Workspace sessions**:
  a session is a numeric id (`0`, `1`, …); one persistent PTY per id in a registry
  (`server.ts`), attached via `/ws?session=<id>`. Sessions outlive client disconnects (512 KB replay
  ring in `pty.ts`), die on shell exit or a client `kill` message, and end with the server process.
  Run via `tsx` (no compile step). Generic token-cookie auth. **The app lives at `/`** — the URL is
  no longer the session (see below); `GET /new` 302s to `/?new=1`.
- **No multiplexer of our own** — users run real `tmux` inside the shell; the mobile layer makes it
  usable. `tmux`'s own server keeps sessions alive across reconnects.

## Layout (yarn 4 workspaces, `nodeLinker: node-modules`)

- `packages/shared/` — the wire protocol as plain TS discriminated unions (`src/protocol.ts`).
  Source-only package (consumed as TS by Vite + tsx); no build artifact.
- `packages/server/` — `src/index.ts` (CLI/entry), `server.ts` (Fastify + ws↔pty bridge),
  `pty.ts` (node-pty), `auth.ts` (token cookie), `config.ts` (secret + opaque settings/extra-keys).
- `packages/client/` — `App.tsx` (integration), `terminal/` (`useTerminal` xterm host + addons,
  `touch.ts` mouse/selection coordinate helpers), `mobile/` (`ExtraKeysBar`, `useMobileGestures`,
  `useSoftKeyboard`, `key-encoder`, `extra-keys`, `clipboard`), `settings/`, `tips/`, `lib/ws.ts`.

## Wire protocol

`packages/shared/src/protocol.ts` is authoritative. Text frames are a JSON discriminated union
(`{ type, ... }`); binary frames are raw PTY bytes (both directions).
Server→client: `ready` (carries `maxUploadBytes` + `webApps`), `settings`, `extraKeys`, `sessions`
(carries `ids`/`titles` **and** `tabs: TabMeta[]`), `snapshot`, `fonts`, `exit`. Client→server:
`resize`, `settings`, `extraKeys`, `kill`, `createTab`, `updateTab`. File upload is out-of-band
over `POST /upload?session=<id>&filename=<name>` (not a WS frame), returning `{ path }`.
`settings`/`extraKeys` payloads are **opaque** to the server — it persists and rebroadcasts them; the
client owns the schema. No protobuf.

**Tabs.** A workspace slot is a tab with a `kind` (`terminal`/`web`/`dashboard`/`editor`/`markdown`); only
`terminal` tabs own a PTY. The registry (`server.ts`) generalizes the old session registry;
non-terminal tabs + every tab's name/color persist to `~/.config/palmux/tabs.json` (`tabs-store.ts`)
and survive restarts (terminals keep metadata only, respawn on attach). **Display order is
decoupled from id** (tab-reorder): the registry keeps an explicit `order` array (restored from
tabs.json's ARRAY ORDER — no schema field; new tabs append, even on a recycled low id), the
`sessions` broadcast's `tabs` array order is authoritative for every client, and the strip never
sorts. Client drag-along-the-strip → `reorderTabs { ids }` (server applies a forgiving permutation
— unknown ids dropped, omitted known ids appended in prior relative order — so no request can lose
or duplicate a tab), applied optimistically in `App.doReorder` + `reorderIds` (`tab-meta.ts`).
Strip drops ONLY reorder — the old drag-back-to-strip collapse gesture is retired (⏏ eject
un-splits). **Closing the active tab** navigates to its LEFT strip neighbor (else right;
`neighborAfterClose` in `tab-meta.ts`, guarded by `seenTermIds` so fresh terminals are never
yanked); with nothing left the New-tab chooser renders as an ACTUAL page (`chooserPage` — no pane
mounts, so the dead id can't respawn), and the pane exit overlay is delayed 250ms so the Reconnect
UI never flashes mid-navigation (it still shows in popouts). **The `[+]` chooser opens in this
device's CONTAINER, never a floating box** — the dock's New-tab view on desktop, and on mobile a
sub-surface of the drawer's session list (a `‹ New tab` back header over `DashboardBody`, same shape
as the drawer's Settings). It was an anchored popover; on mobile it anchored to the `[+]` button,
which does not exist there (no strip), and fell back to a box floating over the screen corner. Both
hosts render `DashboardBody`, so there is one chooser. Attaching `/ws` to a
non-terminal tab is metadata-only: handshake + `sessions` broadcasts, but no `snapshot`, no binary,
and input/resize are ignored. `sessions.ids`/`titles` are retained (derived) for back-compat, and an
older server with no `tabs` is handled client-side by synthesizing terminal tabs from `ids`/`titles`.
Editor notes live at `~/.config/palmux/notes/<id>.md` via `GET`/`PUT /pane-file?tab=<id>`; HTML
artifacts are served same-origin from `~/.config/palmux/artifacts/` at `/artifacts/<name>`
(cookie-gated, traversal-guarded). Client panes (`client/src/panes/`) stay mounted while their tab
exists (iframe/editor state preserved); Monaco is a lazy chunk (`monaco-loader.ts`) so terminal-only
use downloads none of it.

**The URL is not the session. The app lives at `/`.** Which tab a window shows is BROWSER-LOCAL
state (`session/window-selection.ts`, `sessionStorage['palmux-window-tab']`), the way VS Code
remembers an open editor. The id is still identity everywhere it was — `/ws?session=<id>`, the
registry, `tabs.json`, `/pane-file?tab=` — it just stopped being an ADDRESS. What forced this: the
address bar can only name ONE thing, and palmux has two that both want it. A `web` pane's ← walks
the top-level joint history (rule 2 above), which `pushState` on every tab switch shared, so ←
undid a tab switch instead of a page. There is no arrangement of one stack that serves both, and
the framed page is the one with no alternative — a pane cannot reach its own history.
- **`sessionStorage`, not `localStorage`, and the distinction is the whole feature.**
  `sessionStorage` is per browsing CONTEXT; `localStorage` is per ORIGIN. Two palmux windows on the
  same host must hold different tabs — that is what having two windows means — and one shared key
  would make the second window yank the first. Tabs, groups and order stay server state and stay
  synchronised across every window; only the SELECTION is local. A tab opened in one window
  therefore appears in the other's strip and does not steal its view.
- **The stored value carries the `kind`, not just the id.** Ids are recycled lowest-free, so a
  remembered `2` can come back as a different kind of tab entirely; a kind mismatch is treated as
  gone. Boot then falls back to the FIRST tab in strip order — not the lowest id, which tab-reorder
  decoupled long ago — and to the chooser page when there are none.
- **The neighbour rule stays in `workspaceController`'s `sessionsBroadcast`**, not in the resolver.
  "The tab I was viewing was closed from another window, move me to its neighbour" needs the
  PREVIOUS strip order, and that broadcast is the only place holding it; at boot there is no
  "before" for a dead id to be a neighbour of. Two owners for one rule would cost more than the
  duplication it saves.
- **Four addresses still exist, and all of them normalise to `/`** (`session/session-url.ts`
  `readBootIntent`, applied once at boot with `replaceState` so no entry is added):
  `/popout/<id>` is the chrome-less pop-out and is the ONLY one that keeps its address, because a
  pop-out must survive a hard reload knowing which tab it is; `/<id>` is the legacy path, still
  honoured; `?new=1` is an INTENT, consumed exactly once (a reload must not create a second
  terminal); `/` is the app. `GET /new` 302s to `/?new=1`. The `?new=1` consume is DEFERRED to the
  first `sessions` broadcast and seeds `tabsRef` from it — `nextFreeId` reads the tab list, so
  creating at mount allocated from an empty list and collided with tab 0.
- **The id space is deliberately unchanged.** Numeric lowest-free recycling stays, with all of its
  cost (a recycled id inheriting a snapshot, a stored selection matching a stranger — hence the
  kind check). Moving to opaque ids would touch the registry, `tabs.json`, `groups.json`, every
  snapshot filename and both the restore and hint stores, and would buy nothing this change needs.
  What would reopen it: ids leaking somewhere a user can BOOKMARK or share, or a second
  recycled-id defect that a kind check cannot express.

**Web panes: framing, history, and the loopback proxy.** A `web` tab is an iframe, and three
distinct browser rules break it in ways that all look identical (a blank frame, no error).
1. **Third-party sites refuse framing.** `github.com` sends `X-Frame-Options: DENY`, `linear.app`
   sends `frame-ancestors 'self'`. Browser-enforced, not detectable cross-origin, not fixable —
   the header's ⧉ open-externally button is the permanent, honest fallback. Palmux sets NO app-wide
   CSP; the only `Content-Security-Policy` it emits is the sandbox on `/md-file`.
2. **Back/forward.** The framed page's `history` is cross-origin-unreachable, so the pane's ← / →
   walk the TOP-LEVEL joint session history — a nested-context navigation pushes an entry there,
   which is what the browser's own back button walks. That stack now belongs to the framed pages
   ALONE: switching tabs writes no history entry (see "The URL is not the session"), so ← can no
   longer pop a tab switch. Measured: three tab switches after an in-frame navigation left
   `history.length` unchanged, and ← then walked the frame back a page.
   These buttons must exist because an installed PWA has no browser chrome. The iframe was keyed on
   the url, which destroyed its browsing context on every url-bar commit and PRUNED those history
   entries; it now remounts only when the sandbox class flips (the attribute applies at navigation
   time, so a same-origin url must never reuse a frame carrying `allow-same-origin`) or on ⟳.
3. **A loopback URL names a port on the PALMUX HOST, not on the browser's device** — which is what
   the user means and what the browser cannot do. `http://localhost:5173` from an HTTPS palmux is
   additionally blocked as a public→loopback navigation. So `server/webproxy.ts` re-serves it under
   palmux's OWN origin at `/webproxy/<port>/…`, and `panes/webproxy-url.ts` rewrites any
   `localhost`/`127.0.0.1`/`0.0.0.0`/`[::1]` url to that route (the tab still STORES the readable
   form; only the iframe src changes). Same-origin ⇒ no X-Frame-Options, no private-network block,
   no mixed content. This is the ONLY thing that makes a dev server on the palmux machine viewable,
   and it needs no tunnel and no upstream auth — palmux fetches `127.0.0.1:<port>` directly.
   It is an `onRequest` hook, not a route: it runs after the auth hook (so the cookie gate still
   guards it), before any content-type parser (it forwards bytes, unparsed), and before the static
   handlers (so a proxied page's `/src/main.tsx` is never answered by palmux's own build).
   **The Referer is load-bearing**: a framed app emits root-absolute sub-resources (`/@vite/client`,
   `/src/main.tsx`) with no idea it lives under a prefix, and rewriting its JS is not reliably
   possible — so any request whose Referer is a `/webproxy/<port>/` page is re-routed to that same
   port — so a proxied response's `referrer-policy` is STRIPPED (an upstream `no-referrer` would
   silently strand every asset); a `<meta name="referrer">` in the page's own HTML is still beyond
   reach. The Referer also disambiguates a genuine collision: `/assets/<hash>.js` exists in palmux's
   OWN build, and the same path resolves to upstream or to palmux depending only on it. Header
   sanitizing is the security boundary, both ways: palmux's session cookie and `authorization` never
   travel upstream (the cookie IS the terminal), and the response's `set-cookie` is dropped (it
   could otherwise clobber the session cookie on palmux's origin) along with the framing headers and
   the now-wrong `content-encoding`/`content-length`. The upstream host is hard-coded to
   `127.0.0.1` — the port is the only free variable, so there is nothing to traverse into — and
   palmux's own port is refused (a request loop). A dead upstream answers a readable **502**, and an
   unresolvable `/webproxy/` path a **400**, because falling through to the SPA shell would be
   indistinguishable from the blank frame this whole feature exists to kill.
   **A proxied frame MUST get `allow-same-origin`** — the one place `WebPane`'s
   same-origin-means-opaque rule is inverted, and not as a nicety: an opaque origin makes every
   sub-resource cross-origin, and an ESM module fetch is CORS-mode with `same-origin` credentials,
   so the cookie is omitted. Measured against a real build's `<script type="module" crossorigin>`
   assets: uncredentialed, they are bounced by palmux's own gate (401) or, behind Cloud Workstations,
   by the ingress (302 to `_workstation/forwardAuthCookie`, surfacing as `net::ERR_FAILED`).
   Stripping the `crossorigin` attribute would not help — module fetches are CORS-mode regardless.
   The price, stated plainly: a proxied app runs IN palmux's origin and can script the app and open
   `/ws`, i.e. reach the shell. It only ever reaches loopback ports on the palmux host, so it trusts
   what you already chose to run there. `/artifacts/*` keeps the opaque origin.

**Split view (desktop-only) + de-singletonized terminal.** The terminal is NOT a singleton: each
on-screen terminal is a `terminal/TerminalPane.tsx` owning its own xterm + data `/ws?session=<id>`
socket + replay-suppression + DA/DSR report gate (per-document `hasFocus()`, unchanged — two split
terminals are different PTYs, so slot focus plays no part) + fit + exit overlay (per-pane reconnect)

- `useFileUpload` + gestures. `App.tsx` owns a persistent **control socket** (`/ws?control=1`, a
  tab-unbound metadata attach) carrying ALL app state (`sessions`/`settings`/`fonts`/`tabCreated`) and
  all control sends; pane data sockets ignore those broadcasts. Shared input surfaces (soft keyboard,
  extra-keys, upload picker, the hoisted Ctrl+Shift+C/V combo) route to the focused pane via
  `session/SplitFocusContext.ts` (a ref registry). Split state (`session/useSplit.ts`) is a
  **multi-pairing array**: each pairing is two `{tabId, kind}` slots + `row`/`column` + ratio
  0.15–0.85 + focused, persisted to `localStorage['palmux-splits']` (`{v:2, pairings}`; the old
  single-pairing `palmux-split` blob is parsed once as a fallback and never deleted), desktop-only
  (forced empty while the mobile layer or a pop-out window is active). Layout is rect-driven
  (`SplitView` geometry + `PaneHost` positions panes by rect, NEVER reparents, so iframes/editors
  don't reload); `SplitDivider` resizes, `SplitDropZones` handles drag-to-split with a
  claimed-half hover PREVIEW (`.split-drop-preview`).
  **Split fusion (supersedes display scoping):** a pairing renders in the strip as ONE fused
  pill (`buildStrip`'s `fused` items; a split glyph then two segments of min 90px, the focused one
  raised, clicking a segment activates+focuses that member) at its first member's position — members are
  ALWAYS strip-adjacent and share group membership (fuse-time `fuseSync` effect: one
  `groupUpdate`-or-`reorderTabs` moves the partner next to the anchor + adopts its membership; the
  server stays fusion-ignorant). Any number of pairings coexist (a tab in ≤1); only the ACTIVE
  pairing (its fused button is active — the URL id is either member, focused slot drives the URL
  via replaceState) is tiled through `SplitView`. `reconcilePairings` self-heals on every
  broadcast: a dead/kind-recycled member, broken adjacency (external reorder), or split membership
  dissolves ONLY that pairing (navigate to the survivor iff it was the active pairing). New tabs
  (`[+]`/`tabCreated`) never consume a slot; slot replacement is the explicit drag-onto-slot
  gesture (`SlotDropZones` → `slotReplace`: old tab pops out standalone, newcomer adopts); ⏏
  un-splits (both tabs stay adjacent, the OTHER goes full-width); a fused button drags as one
  unit (block reorder / whole-pair group join) and never lights the content drop zones. The old
  ◧/◨ badges, `splitDisplayed`, and hidden-pairing behavior are gone. **One active client per
  terminal (last attach wins)**: `pty.ts` keeps a single `attachment` (client token + `clientKey` +
  onData/onExit/onEvict); a new `attach` installs itself FIRST, then evicts the previous one (whose
  cleanup calls its own detach — the `client` identity guard stops it tearing down its successor).
  **`clientKey` is the LOGICAL client** (`&client=` on the ws URL, a per-pane uuid held in a ref so it
  survives reconnects AND Take-back): equal keys mean the same pane reconnecting after a blip, so the
  spent socket is closed QUIETLY — without it every reconnect read as a rival and the pane evicted
  itself ("opened somewhere else" with one client). An empty key never matches, so an older client
  keeps takeover semantics. The client side matters too: `ws.ts` `abandon()` nulls a replaced
  socket's handlers (and the pong watchdog nulls `onmessage` before closing), because a socket judged
  dead is often just SLOW — its late `detached` would otherwise surface on the very pane that
  replaced it. A genuinely rival evicted socket still gets `detached` (protocol) then a close; the client calls `ws.stopReconnect()` and shows the
  exit overlay as "Opened somewhere else." + **Take back**, which re-attaches and evicts the current
  owner — symmetric, and the stopReconnect is what stops the two fighting forever. `resizeClient`
  ignores a non-active client (an evicted socket can have a resize in flight), so the sole owner
  drives the grid; smallest-client-wins is GONE, as is `dropClient` (detach does it). `emptySince()`
  now tracks attach/detach rather than first-resize. **Pop-out**: `openPopout(id)` →
  `/popout/<id>` (a chrome-less window — it takes the session OVER rather than mirroring, since
  the rule is uniform); return via origin-validated `postMessage` to `window.opener`. This is the
  ONE address palmux still keeps, because a pop-out must survive a hard reload knowing which tab it
  is, and it writes NO selection — a pop-out must never overwrite the parent window's remembered
  tab. The server serves the SPA shell there (anchored so no static mount claims it) and Vite's own
  history fallback covers dev; a dev-proxy entry would serve the built bundle and kill HMR. The old
  `/<id>?popout=1` is still accepted and normalised. **Terminal input hygiene**: `terminal/mouse-frames.ts` gates SGR mouse reports in
  `TerminalPane.onData` — pure-motion frames (btn 32–63) are dropped while the document is unfocused
  and throttled latest-wins (33ms) while focused; clicks/wheel always pass (pending motion flushed
  first). Mobile swipe→wheel forwarding (`touch.ts` `drainScrollUnits`, `useMobileGestures`) emits
  **one notch per line of finger travel** (`WHEEL_CELLS_PER_NOTCH = 1`). It was 3, assuming apps
  multiply per-notch (~3, as tmux copy-mode/less do); a full-screen TUI that takes the wheel itself
  (Claude Code) scrolls ONE line per notch, so that cost a 3× under-scroll. The per-flush cap is now
  a TRAVEL limit (`MAX_WHEEL_TRAVEL_CELLS = 12`, notch count derived) so a finer notch can't make a
  flick silently lose distance — at the old 3 cells/notch, 12 cells was exactly the old 4-notch cap.
  Excess carries bounded to ≤1 further flush, and every frame anchors at the **gesture-start cell** so a swipe
  crossing a tmux pane border keeps scrolling the origin pane; local scrollback stays 1 line per
  cell-height. Fast swipes multiply finger travel up to 4× (`velocityGain`, px/ms, 1× ≤0.5 →
  4× ≥2.5) so flicks cover fling-like distance while slow drags stay precise.

**Scrolling inside tmux: measured, 2026-09-08.** `scripts/measure-tmux-scroll.mjs`
drives a real PTY with SGR wheel reports and counts what comes back. For the SAME
12 lines of travel on a 120x40 pane:

| granularity | bytes back | output chunks |
|---|---|---|
| 12 notches x 1 line (current) | 4027 | 23 |
| 6 x 2 | 2490 | 12 |
| **4 x 3** | **2276** | **8** |
| 2 x 6 | 2328 | 4 |

Outside tmux the cost is **zero** — the client sends no report at all, xterm scrolls
its own buffer. Two findings correct earlier guesses. tmux does NOT repaint the
whole pane per notch (that would be ~4800 cells; it is ~340 bytes, an incremental
scroll-region update), and the cost tracks LINES SCROLLED more than notches — so
coarser notches buy 44% fewer bytes and ~3x fewer round trips for the same finger
travel, not the order of magnitude a full-repaint model would predict. The sweet
spot is 3; past that tmux stops using the efficient path and bytes climb again.
**The saving is still not takeable**: `WHEEL_CELLS_PER_NOTCH` went 3 → 1 precisely
because a full-screen TUI that takes the wheel itself (Claude Code) scrolls one
line per notch, and palmux cannot tell that case from tmux copy-mode — inside tmux
the mouse mode xterm can see belongs to tmux, not to the app. So this is a
documented trade for a tmux-only user who sets both sides, not a change.
**What would invalidate this:** a way for the client to distinguish the consumer of
a wheel report (a tmux control-mode signal, or an app-level protocol); tmux changing
its scroll-region strategy; or a pane geometry far from 120x40, since the per-line
cost is dominated by line width.

Note the tool rebinds `WheelUpPane`, and tmux key tables are per-SERVER — there is
no session-scoped `bind-key`. It re-sources `~/.tmux.conf` on exit, including on a
throw. Do not remove that restore; without it a measurement run silently changes
every live session's scroll speed.

**The terminal's right gutter is three separate things, and only two are reclaimable.**
`addon-fit` 0.11 subtracts a flat `overviewRuler.width || 14` with no way to ask for zero, so
`.term-host` overhangs by exactly 14px and `.term-wrap` clips it — fit measures the host, the grid
lands on the full visible width. xterm's own `padding: 2px` goes too on mobile: four columns' worth
**The scrollbar itself is gone on EVERY device** (owner decision, 2026-09-03). It was mobile-only,
where a slider sits on the very edge the drawer gesture lives on. On desktop the width it gives
back is ~1.5 columns, and what goes with it is a drag target and a position indicator for a
5000-line local scrollback that is real OUTSIDE tmux and empty inside it — a tmux client
repaints its region with absolute addressing instead of pushing lines into the client's
history, so the indicator described the wrong buffer most of the time. It changes no scrolling
behaviour on either side of tmux. `scrollbarSlider*` stays in `toXtermTheme` so un-hiding it
cannot silently ship VS Code's grey.
of nothing across the two edges where columns are scarcest. What is LEFT is `width mod cellWidth`,
under one character, and it cannot be removed — a character grid does not divide a screen evenly, and
widening the overhang just buys a half-clipped column. It is instead painted out: `.term-wrap` takes
`--t-term-bg` (the xterm theme's background, set by `applyThemeTokens` — NOT the derived `--t-base`),
so the remainder reads as the terminal's own edge rather than a stripe of the app showing through. On
a light theme with a dark-background full-screen app that strip still differs from what the program
paints, because it is outside the grid and no program can reach it.

**Component kit + side dock.** `client/src/ui/` is a **Radix-headless** kit
(Button, IconButton, Input, Switch, Segmented, Select, Tooltip, Collapsible, Dialog) styled entirely from the
eight `--t-*` tokens — deliberately NOT shadcn/ui. shadcn is Radix already dressed in Tailwind, and
adopting it means adopting Tailwind's colour vocabulary and then teaching it to resolve back to
`--t-*`: a second source of colour truth with a translation layer between them. What was missing here
was components, not colour. `ui.test.tsx` mechanically forbids a colour literal in `ui.css` and any
duration outside the motion tiers — it caught a 220ms switch thumb that was a fifth tier.
**There are exactly eight tokens** (base, mantle, surface, text, subtext, accent, accent-alt,
accent-ink); `--t-crust` does NOT exist and using it fails silently because `deriveUiTokens` never
sets it. Depth is base (recessed) / mantle (default) / surface (raised + border).
**Motion is four tiers and one prohibition**: 0ms for keyboard-driven state, 140ms ease for micro
feedback, 240ms `cubic-bezier(.2,.9,.3,1)` for surfaces, 380ms + 40ms stagger for first-render lists —
and NOTHING inside the terminal grid animates, because compositing over the WebGL canvas costs frames
that read as input latency.
**Sizes are ONE scale, and a test holds it at zero** (`index.css` `:root`: `--fs-1…4` 11/12/13/15,
`--sp-1…6` 4/8/12/16/20/24, `--r-1…3` 4/6/10 plus `--r-pill`, `--ctl-h` 28px and 36px under the
mobile class). `ui/scale.test.ts` reads every client stylesheet as TEXT (parsed with PostCSS) and
fails on a px literal off the scale in `font-size`/`font`, `padding`, `margin`, `gap`,
`border-radius` and `height`/`min-height`/`max-height`; `var()`, `calc()`, `%` and `em`/`rem` carry
no literal and pass. It began as a RATCHET, a per-file baseline of known offenders that could only
go down, so the rule landed before the cleanup did. `ui/scale-baseline.json` is now `{}`: all 94
offenders in `index.css`, `ui/ui.css` and `dictation/dictation-view.css` were snapped or opted out,
so there is nothing left to ratchet. Any off-scale declaration in any sheet fails, and a new
stylesheet starts clean. A value midway between two steps snaps UP (6 → 8, the owner's 2026-10-24
pill-gap decision). The way out is a `/* scale-ok: <reason> */` pragma on that one declaration, for
GEOMETRY and not rhythm (a dot or thumb sized to sit inside another fixed box, a 1px radius on a 2px
drop line, a scroller's `max-height`), the reason naming the box the value is measured against. The
test pins the full list of pragma'd declarations and the exempt selectors (`.ek-`, `.extra-keys`,
`.term-`, `.xterm`, `.md-body`, `.native-sel`, `.sel-handle`, all tuned by hand), so using either
door is a decision made in that file, and it fails a pragma on a declaration already on the scale.
The literal scan cannot read `var(--mbtn-h, 30px)`, which is how the kit's heights got round it;
the kit-height cases close that by resolving every kit control's total box from the sheets.
`session/DockPanel.tsx` + `dock.css` is the right-side dock that replaces modals: Settings, Files,
Dictation and the new-tab chooser are all views of it. It is LAYOUT, not an overlay —
`.content-row` wraps `.content-area` and the dock so the terminal narrows instead of being covered.
**The desktop settings MODAL is gone** (`SettingsPanel` deleted): the dock is the desktop surface and
the drawer the mobile one, `SettingsFields` is still the single field list, and the `settings`
keybinding routes to whichever host is live. Its tests were never about the modal — they moved
verbatim to `SettingsFields.test.tsx`.
**A terminal pane is keyed by SLOT and by nothing else.** Its socket effect takes
`sessionId` as a dependency precisely so a tab switch swaps the session IN PLACE
— same xterm, same `clientKeyRef`. Adding anything tab-specific to a React key
above it (the error boundary's key did this for a day) REMOUNTS the pane on every
switch: a new xterm, and a fresh `clientKeyRef` uuid, which the server reads as a
RIVAL client — so the pane evicts itself and shows "Opened somewhere else." It
surfaces on a slow link, where the old socket is still attached when the new one
arrives, which is why it was reported from a phone. `SplitView.test.tsx` asserts
one mount across three sessionId changes; nothing else catches it, because it is
not a render error, not a type error, and the pane looks right in a screenshot.

**Boundaries now cover the PANES and the STRIP too**, not just the dock's views. A
render throw unmounts the whole React root, and outside the dock that costs every
attached terminal and every unsaved buffer. Each terminal slot gets its own
boundary keyed `slot:tabId` (so switching tabs also clears a stuck one), `PaneHost`
gets one, and `SessionTabs` gets one. The boundary's `style` prop applies to the
FALLBACK only — a pane is placed by absolute rect, so an unpositioned fallback
would land at 0,0 over the surviving pane, and putting a wrapper around the happy
path would be the reparenting the split layout exists to avoid (an iframe or a
Monaco editor reloads when its DOM parent changes).

**Every swappable view is wrapped in `ui/ErrorBoundary`** (the dock body, the drawer's hosted view,
the drawer's chooser), keyed by the view so switching away and back is the retry. A render-phase
throw unmounts the WHOLE React root, and in here that costs every attached terminal and every
unsaved buffer — far too much to lose over one panel. It is not hypothetical: reading
`e.currentTarget.duration` inside a functional `setState` updater took the entire app down from one
dictation card. React runs that updater during the NEXT render, long after it has nulled the
synthetic event, so the read threw where no handler's try/catch could reach it. Read event fields in
the handler; never inside the updater.
**The exit overlay is a modal moment, so it is drawn as one** — an `alertdialog`
with `aria-modal`, labelled by its message and described by its hint, and focus
moved onto the action as it mounts (xterm keeps DOM focus when the socket dies, so
without that the only actionable control in the app sits behind an unknown number
of Tab presses). "Session ended." / "Opened somewhere
else." freezes the pane on its last frame and the single button is the only way out — it was text on
a scrim with a bare `.icon-btn`, which has no fill of its own, so on a dark theme over dark terminal
output the one actionable control in the app was a thin outline you had to hunt for (reported from a
phone, where it is worst). It is now a raised `.exit-card` with the kit's `primary` Button.

**Anything absolutely positioned "over the terminal" belongs INSIDE `.content-area`**, which is the
only positioned ancestor between the panes and `.app`. Two things learned this the hard way: the
file overlay resolved `inset: 0` against `.app` (fixed to the viewport) and covered the tab strip AND
the dock — hiding the very tree that opened the file — and the recording toast was viewport-fixed and
sat on top of the mobile extra-keys bar, which is in normal flow and has no height a stylesheet can
subtract. Inside `.content-area`, "bottom" means the bottom of the terminal on both layouts.
Its own stylesheet, imported from the component, because `index.css` is 2000 lines that every feature
would otherwise have to edit. Two non-obvious decisions: the dock's **width is not animated** (only
its content slides in) because animating flex-basis fires every terminal's ResizeObserver per frame;
and `resizeBusy` reuses `TerminalPane`'s existing drag deferral so a toggle costs each shell ONE
SIGWINCH — measured live at 2 resize frames for 2 split panes, open and close.
**The dock is ONE width for every view** (300px). It used to be per-view (files
240, the rest 300), which made the terminal jump sideways on every panel switch —
the dock is layout, not an overlay, so a width change reflows and refits every
attached shell.
**The dock has TWO heading levels, and `ui/headings.test.ts` pins them.** The PANEL title
(`.dock-title`, `dock.css`) is `--fs-4` (15px), weight 650, `--t-text`, `letter-spacing: -0.01em`,
no uppercase. A SECTION title is the kit's `.ui-collapsible-trigger`: `--fs-1` (11px), weight 600,
`--t-subtext`, `letter-spacing: 0`, `text-transform: none`. Both used to be uppercase tracked
captions (the panel title at 10.5px, the sections at 10–11px with 0.06–0.12em), so the panel had
one heading style at the wrong size and no hierarchy. Every Collapsible is a section, so that one
rule is the heading of Settings and of the New-tab chooser; the others wear the same style by
restating it, because they are plain elements and not Collapsibles — the Explorer root header
(`.ft-sect-trigger`, whose path beside the name steps down by weight 400 and the theme's dim ANSI
slot), the Dictation history label (`.dictation-group`), the swatch captions
(`.swatch-row-label`), the theme browser's Dark / Light labels, and `.dash-label`, which nothing
renders today and is kept in step so a reuse cannot bring the old style back. No
`text-transform: uppercase` remains in any client stylesheet; a keycap or badge that genuinely
needs one is named in the test's `ALLOWED` map with the reason, so it is a decision somebody made.
**A consumer that restates the trigger's type silently wins.** `settings-view.css` (10px / 700 /
0.12em) and `dashboard.css` (10px / 600 / 0.12em) each carried a rule that out-specified the kit,
so restyling the kit alone left the old caption on screen in Settings and in New tab. A consumer
now states LAYOUT only (padding, `min-height`, a hover recolour), and two tests hold that:
`ui.test.tsx` resolves the effective trigger typography in the Settings and New-tab contexts by
parsing the sheets in cascade order with ui.css loaded both first and last, and `headings.test.ts`
fails on any rule outside ui.css whose selector ends in `.ui-collapsible-trigger` and declares
`font`, `font-size`, `font-weight`, `font-family`, `letter-spacing`, `text-transform` or `color`.
`.dock-body` pads `--sp-3`, matching the head's left padding, so a panel's content lines up under
its title.
`sidebarRail` (`always`|`hidden`) is **per-device and must never join `SYNCED_KEYS`** — a synced copy
puts a per-machine value back in the dotfiles-tracked settings.json.
**There is exactly ONE action bar, and it is the rail.** Upload and download also
have keybindings (`uploadFile`/`downloadFile`) and therefore command-palette
entries — without them `sidebarRail: 'hidden'` left two ACTIONS with no route at
all, which the old "reopen panels with the keybinding" warning did not disclose
because it only thought about views. The desktop topbar used to carry ⬆ Upload,
⬇ Download, ? Tips, ⚙ Settings and the ⬍ split-orientation toggle while the rail carried four views
— two action bars, one above the terminal and one beside it. The topbar is now the app menu button +
tabs + `[+]` and nothing else. Upload and download became rail ACTIONS (`RailAction` in `DockPanel`,
rendered behind a `.dock-rail-sep` below the views, no `aria-pressed` because they open
nothing) rather than panel rows: both are one-click and a panel would make them three, and this is
also where the mobile drawer's footer already has them. Tips became a Settings row — of the three it
is the one nobody reaches for mid-session — and is also an app-menu item (below). The ⬍ toggle moved
onto the SPLIT DIVIDER, which is contextual to a split the way the control is; it is `opacity: 0`
until the divider is hovered, because it floats over the terminal.
**The rail is ordered by frequency of use**: New tab, Explorer, Dictation, the separator, Upload,
Download, and Settings PINNED to the bottom edge — what you open mid-session sits at the top, and
preferences are the thing you reach for least. `DOCK_VIEWS` carries that order (nothing outside
`DockPanel.tsx` reads it; the mobile drawer's own `SWITCHER_VIEWS` list is a separate order and untouched).
Settings leaves the flow through `.dock-rail-pinned { margin-top: auto }` on its OWN button, not
`justify-content: space-between` on the rail, which would also spread the views and the actions
apart whenever the rail has spare height. The testids (`dock-rail-<id>`) did not move.
**The topbar leads with an APP MENU, not a `palmux` wordmark.** A 28px `IconButton`
(`aria-label="palmux menu"`, `app-menu-button`) opens `ui/DropdownMenu` — the kit's wrapper over
`@radix-ui/react-dropdown-menu`, a menu opened by a BUTTON the way `ContextMenu` is one opened by a
right-click or a long press. It reuses `ContextMenuItemSpec` and the `.ui-menu`/`.ui-menu-item`
classes so the two menus cannot drift, and the one thing it adds is the transform origin, which
comes from `--radix-dropdown-menu-content-transform-origin` so it grows out of its trigger. Items:
Settings, Tips, Reload app. The wordmark was the name of the app you are already inside; the button
takes its place and is also the POINTER route into Settings when `sidebarRail: 'hidden'` removes the
rail (the keybinding and the command palette still reach the other views, and the "Sidebar rail"
row's hint says Settings stays in the app menu). Settings runs ONE `openSettings` shared with the
`settings` keybinding — the dock view on desktop, the drawer view on mobile — so the two routes
cannot open different things. The pop-out bar is a different element and keeps its `palmux` brand
text: it has no tabs and no menu.
**Split gestures live on the divider.** The rotate handle is `opacity: 0` until
hover or focus, and `pointer-events: none` with it: it is 20px over a 10px divider,
so it overhangs the drag strip by 5px on each side and was measured swallowing
clicks on the TERMINAL while invisible. It has no transition either — it floats
over the WebGL canvas, and the motion contract is absolute about that. A stationary
tap no longer calls `onSettle()`, which would persist the split and refit every
attached pane for a gesture that moved nothing. Double-click (two taps within 500ms, `swapSlots`) trades the
two panes' sides; the hover handle rotates row ↔ column. The double-tap is built from the pointer
stream, NOT from `dblclick`: the divider is a drag handle, and `dblclick` fires after two mouseups
whatever happened between them, so two resizes would have spent as a swap — a gesture that moved more
than 4px is not half a double tap and also clears any pending first tap. `swapSlots` has to move
three things together: the refs, the `focused` SLOT (it names a slot, not a tab, so leaving it would
silently move focus and the URL to the other tab), and nothing else — the ratio stays, so the divider
holds still and the contents cross it. It also RENAMES the pairing key, which is `a.tabId`.
**Dragging the active tab onto its own pane is refused** (`dropSplit` returns no effects and App
hides the edge zones for that tab): a pane cannot mirror itself, so the gesture used to spawn a
fresh terminal, which is not what dropping a tab means anywhere else. `menuSplit` keeps the spawn —
"Split with… (this tab)" is an explicit request for a second terminal, not a misfired drag.
**Bulk close is Chrome's two items** — "Close other tabs" / "Close tabs to the
right" — computed from the FULL tab order, never the visible entries: whether a
group happens to be collapsed on this device must not change which tabs "to the
right" means. Both go through `closeMany`, which shares ONE kind-aware confirm with
the group's Close all (`session/close-many.ts`): a bulk close is the only action
here that can destroy work, and a bare "close 7 tabs?" hides which of it is a
running shell and which is unsaved text. All kills go out in one pass — routing
through `closeTab` would ask per tab and navigate to neighbours that are themselves
about to close. An item that would close nothing is not rendered.

**The tab context menu is three groups with a hairline between them** (`SessionTabs.tsx`,
`.tab-menu`): EDIT (Rename), LAYOUT (Split right, Split down, New group from this tab / Add to
<group>, Remove from group, the colour swatches, Open in new window) and CLOSE (Close, Close other
tabs, Close tabs to the right), and CLOSE is always last so the one destructive item is never in
the middle of the others. Every group is non-empty — Rename, the swatches and Close always render
— so both `tab-menu-sep` separators always have an item on each side, which a test pins even with
every optional item absent. Every action leads with a 16px kit icon: `pencil`, `split`, the same
`split` turned a quarter for Split down (a vertical rule between two panes becomes a horizontal
one between two stacked panes; a transform on a static glyph, not motion), `plus`, `eject` for
Remove from group, `external`, and `close` for all three close items. An item is `--ctl-h` (28px;
the task named 30px, which is off the 4px grid), `--fs-3`, `--r-2`, and items are flush — groups
are told apart by the hairline, not by air — with the inner radius concentric inside the outer
`--r-3` less the padding. The item rules are scoped under `.tab-menu` because the mobile
long-press sheet (`TabSheet`) reuses `.tab-menu-item` for its group rows with its own sizing,
and the group chip's menu (`group-menu`) shares the `.tab-menu` surface and item rule but was
not regrouped: it has no icons or separators. Behaviour, `data-testid`s, the conditional
rendering above and the micro-tier entrance from the pointer corner did not change. The menu is
still hand-positioned and `contextmenu`-only, which is why the Explorer's menu is the Radix
`ContextMenu` instead.

**Middle-click closes a tab**, plain or one half of a fused pairing; the action is on `auxclick` but
the `pointerdown` guard is load-bearing, because Chrome starts its autoscroll on middle-mousedown and
preventing it at auxclick time is already too late.

**The tab strip is PILLS, not Chrome tabs** (`ui-rework`; the owner's tuned values, snapped to the
scale). The Chrome shape — top-only radius, a taller active tab on the content background with an
accent top border, 8% colour tints — was measured unable to tell active, split and grouped tabs
apart, so it is gone. Every tab is a bordered pill on ONE centre line (`.session-tabs` is
`align-items: center`; nothing stands taller): a 1px border at 10% text, `--r-2` radius,
`--ctl-h` height, `--sp-2` between entries, `min-width: 92px` / `max-width: 200px` with
`flex: 1 1 auto`, so a title shows in full while there is room and the strip scrolls only once every
pill is at its minimum. The look is defined ONCE, as `--pill-*` custom properties on `.session-tabs, .drawer-sessions`
(the mobile drawer's rows are the same pills) derived from the eight tokens — a colour literal would not follow a theme change.
**Active is a fill and a ring, never a colour.** The active pill takes
`color-mix(surface, text 10.5%)` (fill step 1.5 × 7%), a 1.5px ring at 60% text, full-strength text
and weight 600. Inactive text is 85% toward mantle with no fill at rest, and hover fills only a pill
that is NOT active (a fused pill is excluded — its segments are the hover targets). The fill clears
one surface step off the strip in every built-in theme; `tab-strip-css.test.ts` checks the numbers,
because the CSS only names a mix, and mixing the surface TOWARD the text moves it away from the
mantle on a light theme as well as a dark one. A tab's colour is a 7px dot (`.ctab-dot`) before the
title and nothing else — `--tab-accent` is read by the dot rule alone. Colour used to carry state (a
fill, a tint, a top border) and a saturated member colour out-shouted the focused half of a fused
pairing, which is how a pairing came to need four cues. The kind icon renders for non-terminal kinds
only (`kindIcon`). The active pill differs from the rest in fill, ring and text ONLY — no height,
padding, margin or border change — or the taller active tab comes back and, on a centred strip, the
pill shifts a pixel on every switch.
**The ring and the drop marker share one `box-shadow`**: `.active` sets `--ring`,
`.drop-before`/`.drop-after`/`.join-armed` set `--mark`, and `.ctab` composes
`var(--mark), var(--ring)`, so a drag over the active pill shows both without a rule per
combination. Hovering the middle of a grouped member sets `.drop-before` AND `.join-armed`; both
write `--mark` at one specificity, so the join rule has to come later and win, or the will-join cue
the group colour exists for would read as a plain bar.
**The row is as tall as a framed cluster.** `.session-tabs` has
`min-height: calc(var(--ctl-h) + 2 * (var(--cluster-pad) + 1px))`, so creating a group does not
nudge the terminal by the frame and its padding. It also leaves the ring room: `overflow-x: auto`
makes overflow-y compute to `auto`, so the strip clips whatever a pill draws outside its own box.
The topbar ends in a **1px `border-bottom` in `--t-surface`**. The old "no bottom border" rule
existed only so the active Chrome tab could merge into the content below it, and a pill merges with
nothing. `session/tab-strip-css.test.ts` pins the shape — happy-dom has no layout, so a grep on the
stylesheet is the only cheap place to catch it — including that every strip child (pill, chip, `+`)
carries an explicit `--ctl-h` height: the group chip once collapsed to a 12px sliver that read as a
stray coloured line when the strip stopped stretching its children.
**A group is a FRAMED CLUSTER.** `.group-cluster` wraps the chip and its visible members (a
collapsed group's holds only the chip): a 1px `--group-accent` frame, `--r-3` radius,
`--cluster-pad` (2px) of padding and the same `--sp-2` gap. The chip is ALWAYS filled with
`--group-accent` and `--group-ink`, and no rule varies it by which tab is active — the
`member-active` class and everything that read it are gone, because colour must not say "active"
anywhere on the strip and a chip is a colour. The member pill carries the active treatment and its
own dot. The 3px group underline and the `:has(+ …)` shared-radius rules went with it; the frame is
the shared outline. `--group-accent`/`--group-ink` are set inline on the CLUSTER and the chip
inherits them, so the chip's own CSS declares no default (a default on the chip would shadow the
inherited value and recolour every chip; the CSS test pins it). The wrapper is PRESENTATIONAL: drop
indices, `entryIndexByPos` and `entryBefore` are still computed over the flat `strip`, chips are
still separators rather than entries, and the chip keeps its own DnD.
**A fused pairing is ONE pill with a glyph and a seam.** It leads with `<Icon name="split">`
(`fused-glyph-<a>-<b>`) and holds two segments divided by a 1px seam. The glyph and the seam draw
whether or not the pairing is active, so a pairing never reads as two ordinary tabs. Active: the
PILL takes the ring over a transparent fill (`.ctab.fused.active`), and the FOCUSED segment
(`.fused-seg.on`) takes the raised fill, full text and weight 600, while the other segment stays
unfilled with inactive text. Focus is fill and weight, never a member's colour — the old 3px accent
tip, accent icon and neutral recess went with the colour fill. Each segment shows its own dot, its
kind icon when it is not a terminal, and its title, and keeps a 90px minimum. The pill is
`flex: 0 0 auto` with `overflow: hidden`, so the pair shares one outer radius and the segments
square off against the seam; hover fills only a segment that is not the focused one.
**Empty strip space is a drop target, and the gaps are new space.** The 8px gaps and the cluster
padding did not exist when the strip was flush, and the strip's `onDragOver` treated any target that
was not `.ctab`/`.group-chip` as the TRAILING area: a tab dropped in a gap appended at the end, and
a grouped one LEFT its group (`groupUpdate{removeIds}`, which `server.ts` persists).
`gapBoundary(clientX)` now compares the pointer's x with the rects of the rendered units (`.ctab`,
plain or fused, and `.group-chip`, in strip order): the boundary is before the first unit whose
CENTRE is right of the pointer, and trailing only when no unit is. A gap always clears
`centerJoinRef` and `joinArmedIndex` — joining stays the middle third of a GROUPED pill and never
happens by landing in space.
**A boundary before a group carries an ANCHOR, because the entry index cannot name it.** That
index space excludes chips and collapsed members, so with full order `[a, g1, g2, b, c]` and
`{g1,g2}` collapsed, "before the chip" and "after it" both resolve to index 1, which is `b`, and a
tab meant to land before the group landed after it (the bug predates the pills; chip drops had it
too). `boundaryAt(k)` returns one `DropTarget {index, beforeId?}`. `beforeId` is the group's first
member in FULL order (`firstMemberId`, collapsed or not), set when the boundary is before a chip or
between an EXPANDED chip and its first member — a drop there commits the same way and never joins.
`onReorder(id, index, joinGid?, beforeId?)` and `onMoveGroup(gid, index, beforeId?)` pass it
through and `App.doReorder`/`moveGroup` let it win over `entries[index]`, but only while it is still
in the full order; otherwise they fall back to the index, so a stale anchor cannot mis-place the
drop. A plain reorder is still a 2-arg call. A boundary AFTER a group needs no anchor (that index
already is the entry after it), and a boundary drop never joins: a member of ANOTHER group dropped
before a chip keeps `decideGroupDrop`'s existing leave semantics.
**The preview is the commit.** ONE `DropTarget` in state feeds both the marker and `commitDrop`, so
they cannot disagree. An anchored boundary puts `drop-before` on that group's `.group-cluster` and
suppresses the numeric marker, which would have lit the entry AFTER the group while the commit
landed before it. The trailing `drop-after` goes on the last BLOCK, so a collapsed group at the end
carries it instead of the pill before it.
**The Explorer (the dock's file view) has ROOTS, not one tree.** HOME is one
collapsible section and every pinned folder is another — VS Code's multi-root
workspace without the workspace file. `explorerPins` is a SYNCED setting, unlike
the tab groups' collapse set: these are paths on the SERVER's filesystem, so the
same list is right on every device pointed at the same palmux. Pinning collapses
the other roots and opens the new one, because pinning is immediately followed by
working in the thing you just pinned; `explorer-pins.ts` keeps that ordering
(newest first) pure and tested. A root's header shows the last segment plus the
directory it lives IN — not the full path, which needs front-truncation, and the
`direction: rtl` trick that does that reorders the leading slash (measured:
`/home/user/work` rendered as `home/user/work/`).
**Which roots are OPEN is remembered per device, and the stored set is never pruned.**
`localStorage['palmux-explorer-open']` holds `{v:1, open:[<absolute paths>]}`
(`explorer-open.ts`; a forgiving parse, and a storage exception is swallowed, so the
Explorer renders either way). It is LOCAL where `explorerPins` is synced: a pin is a
path on the server's filesystem and is right on every device, but whether a section
is open is a preference of the screen in front of you, and a synced copy would let a
phone's collapsed HOME close the desktop's. The dock and the drawer mount the same
`FileTree`, so one device shows one state in both. **A first run opens HOME**: nothing
stored (or storage unreadable) reads as `null`, HOME is the one open root, and that
default is stored. With a state stored HOME is open only if the state says so —
`load(null)` no longer forces it — and `[]` is a state too (someone who collapsed
everything), never a first run. **The stored set is never pruned against the root
list.** `explorerRoots(root, pins)` is incomplete at boot twice over (HOME is unknown
until its request lands, and nothing says when the synced pins are authoritative), so
a prune keyed to it erased a remembered pinned root whichever of the two arrived
second, and stored the loss. What is shown is `stored ∩ explorerRoots(root, pins)`,
recomputed on every render; an entry for a path that is not a root today stays
dormant, costs nothing and reopens if the root comes back. Writes happen on user
actions only (a header toggle, a pin) and each stores the FULL current set, dormant
entries included; `pin()` stores exactly `[newRoot]`, which is its design and also
clears the dormant ones. **Only LIVE open roots load and poll.** An effect expands
every root in that intersection as it becomes a root — only expanded paths are
fetched, so a restored section would otherwise be open over no rows — and the 2-minute
poll iterates the same intersection, so an unpinned root's dormant flag never keeps
its subtree polling. Folders expanded INSIDE a root are not remembered.
**Freshness is a POLL, not a watcher** (`POLL_INTERVAL_MS`, 2 min, only for roots
that are OPEN). An inotify watch per expanded directory is an fd per directory and
a message per write — pointed at a build output that is a firehose nobody reads.
The ⟳ on every root header is the escape hatch and is always visible, never
hover-only: it is the only way to see a change before the poll.
**Right-click / long-press is `ui/ContextMenu`** (Radix), which is why that
dependency exists at all — the tab strip's hand-positioned menu listens for
`contextmenu` alone and a phone never fires it. A file offers open · download ·
select · delete; a folder offers pin · download · select · delete. `select` enters
a bulk mode where a plain click PICKS instead of navigating (a mode whose rows
still opened files would make building a selection impossible) and the bar always
carries a Cancel.
**Deleting has no trash and says so.** `POST /files/delete` takes a list because a
bulk selection cannot ride in a query string, answers 200 with PER-PATH outcomes
(a partial failure is normal and the caller has to know which survived), deletes
sequentially so a directory and its own child in one batch is not a race, and
removes a symlink as a LINK — following it would empty the directory it points at.
The refusals (`/`, `$HOME`, any top-level path, checked on the RESOLVED path) stop
a MISTAKE, not an attacker: the cookie already grants a shell. The confirm names
the single case, counts the bulk one, and always states that folders go with their
contents (`explorer-actions.ts`, pure, because a confirm built inline is a string
nobody tests).

**The editor follows the palmux theme, and getting there needed three fixes, not
one** (`panes/monaco-theme.ts`). Monaco has its own theme registry and does not read
CSS variables, so it was skinned once at first load from `getComputedStyle` with
`base: 'vs-dark'` hardcoded and `rules: []`. That meant: a theme change moved the
whole app EXCEPT the editor; a LIGHT palmux theme still inherited VS Code's dark
syntax colours (measured — app at `--t-base #eff1f5`, editor still `rgb(30,30,46)`,
class `vs-dark`); and syntax highlighting never used the palette at all. Now `base`
comes from `isLightBg(profile)` and the token rules come from the sixteen ANSI slots
palmux already resolves — a theme's green IS its string green, which is the mapping a
terminal colour scheme already implies. **`applyThemeTokens` publishes the profile**,
so there is ONE owner for "skin the app": three call sites exist (boot, themeId
change, a `themes` broadcast) and an editor wired to only some of them is the bug
this replaced. The bridge (`setEditorProfile`) lives in a module that must NEVER
import monaco — a static path from App to the loader would drag the 3.7 MB chunk into
every terminal-only session. `defineTheme` alone does not repaint a live editor;
Monaco re-reads only on `setTheme`, so both run, in that order.

**`--font-mono` was read in four places and set in none.** The markdown code blocks
and the tips panel fell back to `ui-monospace` while the terminal and the editor used
the configured face — visible as a code block in the wrong font beside an editor in
the right one. App now sets it from `settings.fontFamily`, pre-paint in `main.tsx`
too so a restored markdown tab does not flash the fallback.

**Monaco's gutter chrome is priced by PANE width, not by device**
(`panes/editor-layout.ts`). Measured on a 390px phone: the text got 319px and the
other 71px went to line numbers, folding, the decoration margin and the overview
ruler. Below `NARROW_EDITOR_PX` (500) all of that goes and the text gets the full
width. The threshold is the PANE's, not the viewport's, because the dock is 300px on
a desktop too — a `mobileMode` check would have fixed the phone and left the dock
just as cramped. `observeEditorWidth` reports only the CROSSING, never every resize:
`updateOptions` re-lays out the editor, and firing it per frame of a dock animation
is the resize storm the motion contract forbids. A hidden pane measures 0 and is
explicitly not "very narrow" — panes stay mounted, so that happens on every tab
switch.

**The extra-keys bar is ALWAYS present on mobile, and that is a trap fix rather than
a preference.** It used to hide unless the active tab was a terminal, which looked
tidy and left no way out of an editor: mobile has no tab strip, and the bar's
right→left swipe is the only route to the drawer. Measured on the reported path
(Explorer → open a file): the pane header offered only Read/Edit, the bar was hidden,
and nothing could switch tabs or close it. `FileTabPane` was also the one pane
`PaneHost` never passed `onMenu` to — but the fix is the bar, not a `☰` button that
exists nowhere else (owner decision).
Its keys now drive an EDITOR when the tab is not a terminal (`mobile/editor-keys.ts`
+ `panes/editor-registry.ts`), because a bar of visible dead keys is a UI that lies.
**They are routed as Monaco COMMANDS, not as keyboard events, and that is measured
rather than chosen**: real key presses moved the cursor 408px → 448px, a synthetic
`KeyboardEvent` carrying the same `key`/`code`/`keyCode` moved it nowhere. Monaco
0.55 takes input through the **EditContext API** (`div.native-edit-context`, not a
textarea), so it never sees an event the browser did not deliver — `editor.trigger()`
is the only route, and needing the instance is why the registry exists.
Two guards had to move with it. The routing decision reads the ACTIVE TAB's kind, not
the pane registry: panes stay mounted, so a terminal from another tab is still
registered and still "focused", and checking that sent every key to an invisible
shell. And the bar got its own `barBlocked` — `kbdBlocked` refuses anything outside a
terminal, which was right when the bar had one destination and now swallows every
editor-bound key. CTRL takes its EDITOR meaning (Ctrl+A selects all, not
start-of-line); ALT and unmapped control codes do nothing rather than type garbage
into a file; a macro is never offered, being a shell idiom.

**The markdown viewer's gaps were three different things.** Measured in a real
browser, not reasoned about: `<details>`, `<summary>`, `<section>`, `<table>` and
`<del>` all RENDER — they simply had no CSS, so they fell back to browser defaults
inside a themed pane and read as broken. Task lists were genuinely broken:
`FORBID_TAGS: ['input']` ate the checkbox GFM emits, leaving bare bullets (0
`input[type=checkbox]` in the DOM). `input` is now allowed and narrowed by hand to a
disabled checkbox with no other attributes — anything else is removed, which is what
the denylist was actually protecting against. Syntax highlighting was absent
outright: `language-*` classes were emitted and nothing coloured them.
**VS Code's markdown preview is not reachable** — it is a separate extension
(`markdown-language-features`) running markdown-it in a webview, not part of
`monaco-editor`. What IS reachable is the tokenizer under it: `markdown-code.ts` runs
`monaco.editor.colorize()` over each fenced block, reusing the 23 grammars already in
the lazy chunk and the SAME `palmux` theme the editor uses. One source of colour for
both, no new dependency, and a palette change repaints both. A highlighter with its
own theme would have recreated the editor-theme bug one layer over. The cost is
bounded: a document with a fenced block pulls the monaco chunk; one without does not.
**`.md-body` needed `width: 100%`, and `min-width: 0` does nothing here.** Measured
at 390px: 506.6px before, 506.6px with `min-width: 0`, 390px with `width: 100%`. The
cause is `margin: 0 auto` — auto margins on the cross axis cancel the flex stretch,
so the item sizes to its content and a code block drags the pane past the screen.

**The desktop settings-as-JSON modal is gone** (`SettingsEditor` deleted, with its
`openSettingsJson` keybinding). It edited the CLIENT settings blob while the dock's
Edit config.json editor edits the SERVER's `config.json` — two different documents behind one word,
which is most of why it was confusing. Nothing is lost: 16 of the 18 client settings
are in `SettingsFields`, and the two that are not (`quickLinks`, `explorerPins`) have
their own UI in the dashboard and the Explorer. `Ctrl+,` opens Settings; a persisted
binding for a removed action is ignored, because `loadBindings` iterates `ACTIONS`.

**`config.json` is edited from a Settings ROW, not from a mode toggle at the top of the panel.**
`ConfigEditor` (`settings/ConfigEditor.tsx`, Monaco over `GET`/`PUT /config-file`) used to render
a "CONFIG.JSON  Raw | Form" Segmented above the form — jargon at the top of the panel.
`SettingsFields` now takes an optional `onEditConfig`, and when a host passes it the App
card ends in an **Edit config.json** row (`LinkRow`, `edit-config`, a chevron at the control
column's edge) that `App` wires to `setCfgMode('raw')`. Only the DESKTOP DOCK passes it: the
editor lives in the dock and the drawer has no room for one. In Raw the editor's header is a
`‹ Settings` control (`config-back`, `onMode('form')`) and the title `config.json` (the file's
path is its `title`); the Segmented is gone. `mode` is still `'raw' | 'form'`, but it is state
now, not a control.
**In Form the component renders nothing VISIBLE and stays MOUNTED, hidden — it is never
unmounted and never `return null`.** Monaco is created once, as the file arrives, into the host
element, and returns early when there is no host; a component that rendered nothing in Form
would have no host at that moment and would never get an editor, so the first Raw would open
onto an empty box (`App` starts in Form). Keeping the same host mounted is also what lets
unsaved text, the cursor and the undo stack survive Raw → Form → Raw, and its dirty state
(`onDirtyChange`) reaches `guardedReload`, so a Reload with unsaved config text asks first even
while the Form view hides the editor. Two consequences. `.config-editor` sets `display`, which
outranks the attribute's own `display: none`, so the stylesheet restates `.config-editor[hidden]`.
And a host that is hidden gets no resize events: the dock creates the editor while Form is
showing, so the host measures 0 at create time and takes the WIDE gutter defaults — the width
observer re-measures it, and Raw calls `layout()` as it comes back into view.
Focus follows the swap, because Form hides the editor and the Edit config.json row goes out with
the form it sat in: entering Raw moves focus to `config-back`, and returning moves it to the row
that opened the editor (App's `editConfigRef`, the form coming back NEW), each only when focus was
LOST (on `<body>` or inside a `[hidden]` subtree; `focusLost`). It is never taken from a text field.
Leaving Settings for another dock view does unmount the editor (`App` renders it only while Settings
is the dock view), and the buffer goes with it, so a DIRTY buffer asks first. `openDockView` is the
only writer of `dockView`, which makes it the one door out of Settings (another rail view, the rail
toggle, the dock's close button, a keybinding, a row inside the form): with `configDirtyRef` set it
asks `window.confirm('Discard unsaved changes to config.json?')`, the counterpart of
`guardedReload`'s. OK clears the flag and proceeds; Cancel stays on Settings and switches to Raw, so
the text it protects is on screen even if it was hiding behind Form. A clean editor switches
silently. The other thing that removes the dock, and with it the editor, is an explicit
`mobileMode` change that turns the mobile layer on; `changeSettings` (App's `onChange` for the
dock's `SettingsFields`) asks the same question BEFORE the change is applied or persisted, and
Cancel leaves the setting and the editor alone. **One path is not guarded, by limit and not by
oversight:** `mobileMode: 'auto'` re-resolves from the device on every render (`isMobileDevice`: a
coarse pointer, touch points), so a desktop that starts reporting one flips the layer with no user
action to ask against, and the editor still unmounts. `onDirtyChange` reports `false` once it has.
Keeping the editor mounted across dock views is not done: it would load Monaco for every desktop
session, which terminal-only use must never pay.

**Monaco carries ~23 monarch GRAMMARS, not one.** Tokenizers are a few KB each and
run on the main thread; the 7 MB the loader's comment warns about is the language
SERVICES (ts.worker, the json/css/html validators), which are still excluded.
Measured: +4.3 KB raw / +1.4 KB gzip on a lazy chunk a terminal-only client never
fetches. Two entries in `LANGUAGE_BY_EXT` are substitutions, not matches: `json`
has no basic-language grammar (its colouring lives in the service) so it borrows
`javascript`, a superset of every valid JSON document; `toml` has none at all and
takes `ini`. `LANGUAGE_BY_NAME` handles the files whose NAME is the language, and
a leading dot is part of that name — looking `.zshrc` up as the extension `zshrc`
finds nothing and shadows the hit, the same trap the file icons had.

**File icons are the real Material Icon Theme**, vendored from the VS Code
extension `PKief.material-icon-theme` (MIT) by `scripts/build-file-icons.mjs` into
`client/public/file-icons/`. Run manually, output committed — a build that needed a
VS Code install would stop being self-hostable. `du` says 5.1 MB; that is block
overhead on 1135 tiny files, and the bytes are **825 KB**, of which a session
fetches only the icons on screen (~1 KB each, cached). The 213 KB lookup index is
FETCHED, not bundled (31 KB gzipped, and the `/file-icons/` mount pre-compresses
it to 25 KB brotli), so a terminal-only client downloads none of it and the tree
never waits on it — rows render the fallback glyph and swap when it lands. The
index deliberately OMITS `folderNamesExpanded`: all 4654 of its entries are
mechanically `<closed>-open`, so the client concatenates and the build refuses to
run if that ever stops being true. `file-icons.ts`'s resolvers take the index as an
ARGUMENT rather than reading the module cache — a version that read module state
needed a `tick` counter to force re-renders, which exhaustive-deps correctly called
a lie. **`/file-icons/` must not start with a path the Vite dev proxy claims by
PREFIX**: a bare `'/file'` key swallowed every icon request and answered the SPA
shell, so the tree silently rendered fallbacks; that key is now anchored
(`'^/file(\\?.*)?$'`).

`GET /files/list?dir=<abs>` (`server/files.ts`) is the file browser's listing: absolute paths under
the same shell-trust model as `/download` (NOT confined like `md-list`), directories first then
case-insensitive with punctuation significant, unreadable entries skipped rather than fatal, and a
JSON error status rather than falling through to the SPA shell. An ABSENT `dir` answers with the
server's HOME — the client cannot know it, and rooting the tree at `/` cost four expands to reach
anything anyone edits.

**A file from the Explorer is a TAB, not an overlay.** It used to render into a
full-width `.file-overlay` across the content area, which made it modal: it
covered whatever terminal was running and the only way back was to close it
(with a terminal tab focused, opening a file drew it ON TOP of that terminal).
An `editor` tab is therefore TWO things, told apart by `url` —
exactly the discrimination `markdown` already uses. **Without** a url it is the
tab's own note at `/pane-file?tab=<id>`, as before; **with** an absolute path it
is that file on disk, rendered by `panes/FileTabPane.tsx` (which exists only to
hold the Read/Edit mode per mounted tab: not a preference worth syncing, and not
global, because two open files would share one toggle). `displayTitle` names it
after the file, the server gates the url on `isAbsolute` in both `createTab` and
`updateTab`, and it persists to tabs.json — so a file tab survives a restart the
way a terminal does. Opening a path already open FOCUSES that tab rather than
making a second one: two tabs over one file would be two editors, and whichever
saved last would silently win.

**Editing an arbitrary file** is `GET`/`PUT /file?path=<abs>` (`server/file-rw.ts`), and it is not a
jail — the cookie is the boundary, exactly as for `/download` — but a set of refusals that stop a
MISTAKE being unrecoverable, because a bad write is silent in a way a bad shell command is not: it
never CREATES a file or a parent directory (you can only save over something the tree showed you),
refuses anything that is not a regular file (so a typo cannot stream a buffer into `/dev/sda`), and
writes atomically into the target's OWN directory (a rename across filesystems is EXDEV) after
resolving symlinks (renaming over a link would replace the link with a regular file and silently
detach a dotfile from its repo). The PUT lives inside the raw-body scope for the same reason
`/upload` does. `EditorPane` drives both this and the tab-note route (`/pane-file?tab=`) — same
editor, and they differ in exactly three details: `/file` answers JSON so its refusals can carry a
message, a note is always markdown while a file's language comes from its name (and Monaco carries
ONE grammar by choice, so everything else is `plaintext`), and a failed save on a file has a reason
the host must be able to show. A refused save is the one failure the user cannot infer — the text is
still on screen and the buffer still dirty, which alone is indistinguishable from "not saved yet" —
so `onSaveError` carries the server's own message up to `FilePane`'s header. `Read` is offered only
for a form that renders (`.md`), DISABLED rather than hidden for anything else, and both views stay
mounted so a toggle cannot discard unsaved text.

**tmux session picker.** `[+]` → "New terminal (tmux)…" lists the host's tmux sessions
(`server/tmux.ts`, `GET /tmux-sessions`, client `panes/tmux-sessions.ts`) with `＋ New tmux session`
pinned on top. Picking one spawns the terminal straight inside it. Three things make this work:
1. **The target rides the /ws attach, not a message.** A terminal tab is the one kind NOT created
   through `createTab` — the client picks a free id (`App.createTab`) and the PTY spawns lazily on
   the first `/ws?session=<id>` attach. A separate control message travels on a DIFFERENT socket and
   could lose the race with that attach, so the target goes on the attach URL itself
   (`&tmux=<name>`, empty value = a new unnamed session; absent = a plain shell — present-or-absent,
   never empty-as-absent). `registry.get(id, {command})` types it only when this call is what
   spawns; an already-live PTY ignores it, so a reconnect cannot re-run the attach into a shell in
   use. An explicit target also BEATS (and discards) a restore snapshot: the user just said what
   this terminal is for. App holds the pending target in a map read-and-cleared by the pane as it
   opens the socket — the pane is keyed by SLOT, so consuming at mount would bind it to the wrong
   tab, and leaving it would let a recycled id inherit it.
2. **Picking an attached session STEALS it** — `tmux new-session -A -D -s <name>` (`-A` =
   attach-or-create, so a session that died since the listing still opens something; `-D` = detach
   the other client). Verified against tmux 3.7b: the client count stays 1 across the second attach.
   Stealing is the deliberate choice because tmux sizes a window to its SMALLEST client, so a
   parallel attach from a phone would silently shrink the same session on a desktop. The row says so
   (filled dot + `attached` + a title explaining the cost).
3. **The name is untrusted twice.** It reaches a line typed into a shell, so `isTmuxSessionName`
   rejects tmux's own target punctuation (`.`/`:`) and every control character (quoting cannot
   contain a CR, exactly as session-restore documents), and `quoteArgv` quotes it again at the point
   of use. A name tmux allows but palmux could not safely type is dropped from the listing rather
   than offered.
Sorting is case-insensitive but PUNCTUATION-SIGNIFICANT: `localeCompare` at base sensitivity treats
`_`/`-` as ignorable, which collated `api_gateway-0` as `apigateway0` and scattered it past
the whole `api_gateway_*` group it belongs with. The list is fetched when the picker OPENS and
never cached (it belongs to a tmux server palmux does not manage), scrolls, and grows a filter past
8 entries — a real host had 26. tmux missing entirely (`ENOENT`) hides the section; a tmux with no
server running is a working tmux with an empty list, and the `＋ New` row still starts one.

**Tab groups.** A group is `{id, name?, color}` (`session/tab-groups.ts` +
`shared/protocol.ts` `TabGroup`; ids match `isGroupId` `/^g[0-9a-z]{5,12}$/`, minted server-side via
`crypto.randomBytes`). Each tab carries at most one `groupId`; the model is **server-authoritative**
— the registry (`server.ts`) keeps members **contiguous** in strip order via `normalizeOrder` (a
stable partition run after EVERY mutation), auto-removes empty groups, and broadcasts `groups:
TabGroup[]` on `sessions`. Because a bare reorder can't move membership (normalize bounces it back),
join/leave go through `groupUpdate{addIds|removeIds, order}` (membership THEN order THEN normalize,
atomically); a plain move stays `reorderTabs`. Persistence is additive + rollback-safe: per-tab
`groupId` in `tabs.json` (old parser ignores it) and group metadata in a NEW `groups.json` sidecar
(`tabs-store.ts` `createGroupsStore`); restore drops a `groupId` whose group is gone. Group color +
name are **independent** of per-tab color/name — a member shows both (the cluster's
`--group-accent` frame and chip around the member's own `--tab-accent` dot; see the strip above).
Creation is single-tab (menu: "New group
from this tab" / "Add to <group>"; group-of-one is valid and grown by dragging a tab onto a member's
**center**; drag a member fully OUT to leave; drag the chip to move the whole block —
`application/x-palmux-group`, its own payload, never sets `dragTabId`). Collapse is per-device view
state (`localStorage['palmux-collapsed-groups']`, forgiving parse, pruned each broadcast): the chip
click toggles with an **active-tab guard** (navigate to `nearestOutside` first; refuse-with-toast when
the group is the whole strip), and ONE centralized `useEffect([sessionId, tabs, groups])` in `App.tsx`
auto-expands whenever the active tab is a collapsed member — NOT in `selectTab`, because split
re-tile / boot / close-nav / reconcile all `setSessionId` directly and bypass it. Close-all is one
KIND-AWARE confirm (names the terminal kill count, warns on dirty editor members). The mobile drawer
(`SessionDrawer.tsx`) renders groups as tappable headers sharing the same collapse set. The drawer
lives on the RIGHT edge and covers the full HEIGHT (still bounded by `--app-top`/`--app-height`) and
all but a 44px scrim strip on the left (`width: calc(100% - var(--drawer-strip))`). 44px is the
touch-target floor, and the strip hit-tests as the scrim with the keyboard up or down, so a thumb can
always reach the terminal side to close it. The scrim is token-coloured (`--t-base` at 72%, the kit
Dialog overlay's mix) and is inert while closed; scrim and slide run on `--mo-surface` in and the
shorter `--mo-micro` out, and reduced motion drops both transitions. The drawer is the mobile
container for the SAME four surfaces the desktop dock rail hosts (sessions · settings · files ·
dictation), ordered for the THUMB, bottom → top: the footer, the bottom-anchored session list, and
at the very TOP ONE row — a Settings gear, the view switcher, Close (owner decision, 2026-10-25: he
does not want the switcher at the bottom). The switcher is a kit `Segmented` over THREE segments
(Sessions · Explorer · Dictation) wearing the rail's own icons; Settings is the gear beside it and not
a fourth segment, because a segment for it as well would be two entries for one place. The top row
exists only at the drawer's ROOT: Settings and the new-tab chooser are sub-surfaces whose `‹` back
header is the top control there, a row above it would push the way back down the screen, and the
switcher goes with the row — Explorer or Dictation is one back press from Settings, the depth the
chooser already has. In the row the unselected icons wear `--pill-text` (the strip's inactive text),
not the kit's `--t-subtext`, which read as disabled on the drawer's mantle; the selected segment
restates `--t-accent-ink` on the accent fill in its hover and press states, because the kit's
`.ui-seg-item:not(:disabled):hover` out-specifies its own selected rule and put pale text on the
accent. Both are scoped to the drawer (`drawer-views.css`), so every other Segmented keeps the kit's
colours. The strip and the list declare `--pill-text`, so `.drawer-top` declares it too (index.css);
`SessionDrawer.test.tsx` holds that value equal to the strip's and resolves the cascade with ui.css
loaded first and last.
Settings are drawer items rather than a modal (`settings/SettingsFields.tsx` holds the field list,
shared with the dock).
**Drawer controls are sized off `--ctl-h`** (28px on desktop, 36px under the mobile class), the step
the kit and Settings use, and NOT off `--mbtn-h`, and the KIT reads it itself. Button, IconButton,
Input, the Collapsible trigger and a Segmented item used to read `var(--mbtn-h, 30px)` (the
extra-keys key height with a 30px fallback, off the scale, and a function value the literal scale
guard cannot see), so a chooser, Explorer or Dictation hosted in the drawer came out 6px shorter than
every row the drawer draws itself. The drawer corrected that with rules of its own (`.drawer .ui-btn`,
`.ui-input`, `.ui-select-trigger` and `.ui-icon-btn` overridden to `--ctl-h`) and a
`.drawer { --mbtn-h: 30px }` pin so the controls it did not resize kept their size. Both are
DELETED: the kit's Button, IconButton, Input, Select trigger and Collapsible trigger are `--ctl-h`
and each small variant is `calc(var(--ctl-h) - var(--sp-1))` (24px on desktop), so one rule serves
the drawer, the dock, a pane header and a dialog, and a drawer override would only be a second place
to keep in step. A Segmented is the same in result and different in shape: its wrapper adds 2px of
padding and a 1px border a side, so the wrapper takes the `--ctl-h` floor (the OUTER box is the
control height) and an item `calc(var(--ctl-h) - 6px)`. The visible cost is deliberate: kit controls
on a phone OUTSIDE the drawer grow from 30px to the 36px touch target, and on desktop they shrink
2px to 28px. `--mbtn-h` is now declared nowhere and nothing reads it (the extra-keys bar sizes its
own keys); `ui/scale.test.ts` fails a declaration or a read in any stylesheet outside the
`.ek-`/`.extra-keys` exemption, and resolves the TOTAL box of every kit control from the sheets (kit
alone, inside `.drawer`, in `FilePane`'s header; 28px and 36px; `ui.css` loaded first and last).
`SessionDrawer.test.tsx` pins the drawer half: no drawer rule resizes a kit control, and `.drawer`
pins no `--mbtn-h`.
Two things about the switcher. **Availability is DECLARED (`hostedViews`), never inferred from
`viewContent`**: files and dictation have no body of their own, the host supplies one, and a host can
only supply it for the view that is ALREADY selected — so inferring left both permanently disabled
and unreachable. And the Segmented takes `keepFocus`, because Radix selects on CLICK and a click
focuses the segment, which blurs `#mobile-kbd` and dismisses the soft keyboard — the exact reason
every other control in here acts on pointerdown + `preventDefault`. That is also why the selection
moves INTO pointerdown, and that press marks its gesture (`consumeGesture`, below): selecting swaps
the drawer's whole body, so the tap's own mousedown and click would land on what the new view drew
under the finger. The mark swallows them for a touch pointer and a mouse alike. A key, assistive
tech or `click()` reaches a segment as a click with no count, which the mark lets through to Radix's
own handler; the item that is already selected reports `''` for the toggle-off there, which
`Segmented` already ignores.
The session LIST is bottom-anchored
(`margin-top: auto`) so the most-tapped surface sits in thumb reach. There is **no brand row**: a
`palmux` wordmark + settings icon used to have a row of their own, a duplicate control plus the name
of the app you are already inside. The one Settings entry is the gear at the left of the top row.
`+ New tab` is the list's TAIL box (`.drawer-tail`; the same box that turns into the root drop area
while a row is lifted, below) and opens the chooser as a sub-surface of this list
(`‹ New tab` back header over `DashboardBody`) and does NOT close the drawer — closing it to float
the chooser elsewhere is what this replaced. `DashboardBody` is written for the dock, so the drawer
re-scopes its metrics the way `.drawer-settings-body .settings-form` already does: its 10px padding
goes (in here it was the FOURTH nesting level, and in the old 300px drawer a tmux name lost 38px of
it before its first glyph), and its 40vh
`.dash-list-scroll` cap is lifted, because a list that scrolls inside the drawer's own scroller is
two scrollbars competing for one flick — that alone took the visible tmux rows from 10 to 23.
**A control inside a scroller cannot fire on pointerdown.** The drawer's convention is pointer
events, never the pointer's own `click`, so that using it does not blur `#mobile-kbd` and dismiss
the soft keyboard — and the original form (`press`: pointerdown + `preventDefault`) breaks a list in
two independent ways. The action runs the moment the finger LANDS, so a finger arriving to scroll has
already picked whatever was under it; and `preventDefault` on a touch pointerdown cancels the
browser's pan, so the list could not have scrolled anyway. Measured on the drawer's chooser: touching
a tmux row to scroll opened that session and closed the drawer. `panes/press.ts` therefore has two
forms — `press`/`pressKbd` for FIXED chrome (the scrim) and `pressMove`/`pressKbdMove` for anything
in a list: activate on pointer UP, only within 10px of where the finger landed, never
`preventDefault` a touch pointerdown, and restore `#mobile-kbd` focus on activation (the touch path
lets focus reach the control, which is the price of letting it pan). A mouse cannot pan, so there the
original preventDefault stays. `pressMove` answers a CLICK too, and acts on every click that reaches
it: Enter, Space, assistive tech, `element.click()` and the click a `<label>` forwards to its control
all activate exactly once, and `detail` plays no part in telling them apart (a forwarded click
carries a count) because a pointer press's own click never gets there (the mark, below). The one
click it skips ends a drag that went past the slop and was released on the same element, which a
mouse still turns into a click. It `preventDefault`s the click it acts on, so a `<label>` built on it
cannot forward a second activation to its control. `pressKbdMove` adds Enter and Space for an element
that is NOT a `<button>`: a `<button>` turns both into a click of its own, so acting on the keydown
as well was a double activation, and whether `preventDefault` on that keydown cancels the click
differs by engine, so nothing relies on it. The settings round trip (the Theme row, its `<label>`
through `Row`'s `onLabelPress`, every theme entry, the dock's `‹ Settings`) uses `pressMove` for the
same reason: a real press focuses a button natively before its click, and `carriesFocus` read that
as focus inside the panel and carried it into the list, which dismissed the soft keyboard. A fixed
BUTTON (the footer cells, the back headers, the top Settings and Close, the TabSheet's buttons, the
chooser's three and the dashboard's Open drawer) uses `pressClick`, a third export that is `press`
plus a `click` handler, so Enter, Space and an assistive-tech click reach it too — a focusable
button that ignored them would work for some users only — while a pointer press's own trailing click
is not a second activation.
**Every helper that acts on a pointer marks that GESTURE first** (`consumeGesture`, exported for
`Segmented` and for the drawer's row machine): `press`, `pressClick`, `pressMove` on activation,
Segmented's `keepFocus` pointerdown, and a row's tap or its hold released in place, which opens the
row menu. The action usually redraws the spot under the finger, and the browser hit-tests the rest of
the tap only after the release, so the gesture's own mousedown, mouseup and click land on whatever
the action put there: the scrim's tap on the terminal under it (under mouse reporting that is a click
report to tmux, which can change the focused pane), a chooser row's tap on the view it opened. One
capture listener on the document takes them all, wherever they land. It takes the compatibility
mousedown and mouseup as well as the click, not only the click: a touch can deliver its mousedown
AFTER pointerup, and a mousedown moves focus, so putting `#mobile-kbd` back at pointerup was undone a
moment later. The mousedown is `preventDefault`ed (which cancels that focus move) and stopped; a
POINTERDOWN is never touched, so the mark cannot stop a list from panning. The mark is armed BEFORE
the action runs, so whatever the action redraws is covered, and it stays live until the pointer has
been released AND the action has returned; `CLICK_TAIL_MS` (1s) counts from the later of the two. A
pointerdown action returns long before a held finger lifts, and a pointerup action can block — the
swipe Close reaches `window.confirm` inside `App.closeTab` — and the click it held back is delivered
after the answer and still swallowed. Mouse events and clicks with `detail === 0` always pass: a key,
assistive tech and `element.click()` produce them, and the upload and download actions call `click()`
on a file input or a link inside this very gesture. A new pointerdown, a pointercancel or a keydown
clears the mark. A scroll, a drag, a cancel and a press `endIfGone` ended acted on nothing, so they
mark nothing and their click still reaches the row. The drawer's own rows are not `pressMove`: they
are the pointer state machine below, where the slop also cancels the long-press, and they call
`consumeGesture` themselves in `up` on the two paths that act.
**A row is `{dot} {kind icon} {title} {number}`.** The dot is the tab colour (`--tab-accent`; a
neutral `--t-subtext` dot when the tab is uncoloured), and the kind icon appears for NON-terminal tabs
only — a terminal's kind is the prompt every row would repeat. The number is the TAB ID as secondary
text (`--fs-1`, `--t-subtext`, right-aligned): the id is still how you name a tab, but it is not what
the row is about. The numbered colour chip (it inverted on the active row), the per-row `❯` and the
always-visible ✕ cell are GONE; closing is the swipe-left action below.
**A row is a PILL, the desktop strip's own, and the two share one set of tokens.** `--pill-border`,
`--pill-fill`, `--pill-ring`, `--pill-text`, `--pill-hover` and `--cluster-pad` are declared ONCE, on
`.session-tabs, .drawer-sessions` (they lived on `.session-tabs` alone), unchanged in value, so the list
cannot drift from the strip; `tab-strip-css.test.ts` and `SessionDrawer.test.tsx` read that one rule and
the drawer's row rules restate no colour mix. `.drawer-session` takes the 1px `--pill-border`, `--r-2`,
`--pill-text` at weight 500 and stays `--ctl-h` tall; at rest its background is the drawer's own
`--t-mantle`, which reads as "no fill" and keeps it OPAQUE over the Close waiting behind it. The ACTIVE row
is `--pill-fill`, the `--pill-ring`, `--t-text` and weight 600, and is never filled with the tab colour,
so a red tab's red lives in its dot and nowhere else; the old 3px `--t-accent` left edge is gone. The ring
is OUTSET (1.5px) and `.drawer-leaf-inner` clips, so its room is the clip's side padding
(`--cluster-pad`, 2px) and the row's own vertical margin (half of `--sp-1` each side: two rows are 4px
apart, and the pitch on mobile went 38px → 40px), both INSIDE the clip. The vertical room is never padding
on the clip: that would hold a leaving leaf open at `0fr`, and the row below would jump when it unmounted.
The ring and a lifted row's shadow are two layers of one `box-shadow` (`--ring`, `--lift`), as on the
strip's pill, so a lifted active row keeps its ring.
**A group is a framed cluster, assembled from per-leaf segments.** The header is the CHIP: filled
`--group-accent` with `--group-ink` over it (caret, label and count declare no colour of their own), and no
dot, which would be the colour of its own ground. It is still a button with the same `data-testid`,
`aria-expanded`, tap-to-collapse and long-press/drag handling, and `member-active` no longer changes it, as
on the desktop. The two colours are set inline on EVERY leaf of the group, header and members, from
`tabColorValue`/`tabColorInk` (the desktop chip's helpers), with `--t-accent`/`--t-accent-ink` as the
fallback on `.drawer-leaf`. The frame is one continuous 1px `--group-accent` line with `--r-3` corners and
`--cluster-pad` inside, but the rows are flat leaves, so each draws its own piece: `frameClasses` marks a
leaf `group-first` (the header), `group-mid` or `group-last` (a folded header is both), and the segment is
drawn on the LEAF, NEVER on `.drawer-row`. A drag translates and scales the row, so a segment on it travels
with the finger and leaves a hole in the frame, where the leaf keeps holding the slot. Not on
`.drawer-leaf-inner` either, although it is as stationary: it is the grid item, and while its track runs
between `1fr` and `0fr` the leaf's height is fr × content and the item's is fr × THAT, so for the length of
every enter and leave a border on the item stops short of the slot and the frame opens between the rows
either side (measured on a 40px row at half way: leaf 20px, item 10px; the first build drew them on the
item and the gap was in the screenshot). Every leaf carries a 1px transparent side lane, so a member pill and
a plain pill share an edge and the frame is what sticks out. Positions come from the rows that are NOT
leaving, and a leaving row is one of two things. TRAILING, with nothing of its group left below it (the last
member closing, every member of a fold): it draws nothing and `group-last` has already moved up, because a
bottom edge on it would ride up with its shrinking slot, fading, while the new last row draws its own.
INTERIOR, with rows of its group left above and below (a first or middle member closing): it takes
`group-bridge`, the two SIDES only (a top or bottom border would hold its slot open), so the frame stays
unbroken between the rows either side while the slot shrinks; and the fade is the ROW's, not the leaf's,
because a leaf fade would take the sides with it. An ENTERING row is not special-cased: its segments fade in
with its leaf over the same micro tier. A group has no menu and no Close, and its
header keeps the section-title type.
**Row gestures are one press at a time, on pointer events — there is no HTML5 `draggable`.**
`draggable` would compete with the list's pan and with the long-press menu, and the pointer path
behaves the same whether or not Chrome for Android starts an HTML5 drag. That was decided WITHOUT the
device (adb was down), so the S26 spike that would show HTML5 drag working is still owed; the tree
MODEL below is shared by either input layer, so only this layer would change. A press is `pressed`;
held 450ms (`LONG_PRESS_MS`) inside the 10px slop it is `armed` (`navigator.vibrate?.(8)`). From
`armed`, a release without moving opens the row's menu (`onTabMenu` → `TabSheet`: rename, colour,
group membership, close; the terminal close keeps its confirm), and moving past the slop starts a
DRAG. Moving past the slop BEFORE arming is a scroll or a swipe — never a menu, never a drag. A plain
tap still switches tab and closes the drawer. The menu does NOT close the drawer: the sheet opens
over it, so a rename or a colour change lands you back in the list you pressed in.
**Pointer capture does not take the gesture from the browser's pan.** Capture changes where events
are delivered; it does not stop native scrolling, so a vertical move after the hold would start a pan
and end the gesture in `pointercancel` instead of a drag. ONE non-passive `touchmove` listener on the
list root (registered by hand — React's `onTouchMove` is passive and cannot `preventDefault`) cancels
the touch ONLY while the press is `armed` or `dragging`, reading the phase from a ref, so a move
before arming still pans natively and a touch pointerdown is still never prevented. ASSUMED, not
measured: Chrome holds the pan within its touch slop, so the first post-arm `touchmove` is still
cancelable; `e.cancelable` guards the call, and a miss would show as a drag that ends in
`pointercancel`. A drag takes pointer capture on the list, lifts the row on `transform` alone (plus
the list's scroll since the press, or an edge auto-scroll would leave the row behind the finger),
scrolls the list when the finger is within 40px of its top or bottom edge, and draws the drop it
resolves: a 2px accent line on a row edge, or a ring around a group header for "join". A release on a
refused drop cancels and nothing moves.
**Swipe left reveals Close.** A dominantly horizontal move left of more than 32px before arming
slides the row aside on `transform` (micro tier) over a Close button waiting behind it
(`.drawer-row-close`, `visibility: hidden` until revealed so it is neither tabbable nor read out).
Tapping it calls `onKill`, which is `App.closeTab`, so the terminal confirm and the dirty-editor
discard confirm still apply. It hides again on any press that is not on it (a press on ANOTHER row
only puts the open one back and does not also switch tabs or start a long-press), on a scroll, and
when the drawer closes — which is what makes a swipe right, a tap elsewhere and a scroll "hide". The
keyboard route is ArrowLeft on a focused row (reveals Close and moves focus onto it) and ArrowRight
back; an Enter, Space or assistive-tech click reaches a row as a `click` with `detail === 0` (a
pointer press's own trailing click carries a count).
**Drops go through a pure tree model and two App commits.** `session/drawer-tree.ts` ports the DGSL
design system's TreeView model: nodes are `t:<id>` and `g:<gid>`, a group sits at its first member and
holds its members in full order, and `dropAt` splits a TAB row in halves (before/after) and a GROUP
header in quarters (top before, bottom after, the middle half inside). `accepts(nodes, dragged, drop)`
refuses a drop on itself, a group into its own members, a group inside a group (one level only),
anything inside a tab, a group beside a member of a group, the place the node already holds, and a
node or target no longer in the tree (a drag outlives other windows' edits). `resolveDrop` returns
the full order, already through the shared `normalizeOrder` so the optimistic order equals what the
server will broadcast, plus at most one membership change; moving from group A to B returns only
`addTo: B` because the server's `groupUpdate` steals the tab, and `removeFrom` is set only when the
tab leaves for the top level. A tab dropped before/after a group HEADER lands as a top-level node
beside that whole block. A permanent ROOT drop area exists below the last row — the `+ New tab` box,
which reads "Drop here to ungroup" while a row is lifted — because with every tab grouped no other
top-level target exists. `App.moveTabInTree(id, drop)` sends `groupUpdate {id, addIds|removeIds,
order}` when membership changes and `reorderTabs(order)` otherwise; `moveGroupInTree(gid, drop)` is
always one `reorderTabs`. Both apply the same order optimistically and send NOTHING for a refused,
stale or no-op drop. They sit beside `doReorder`/`moveGroup` and do not replace the desktop paths;
no server change was needed.
**An optimistic drop is applied to the list React holds, never rebuilt from the drop's order.** A
drop is resolved against `tabsRef` and then applied inside a functional `setTabs` updater to `prev`,
which need not be the list it was resolved against: a `sessions` broadcast whose `setTabs` is queued
and not yet rendered can hold a tab the resolved order never named, and an updater that rebuilt the
list from `order` alone dropped that tab locally, while the server, already at that order, sent no
broadcast to put it back. Three things changed. The `sessions` handler moves `tabsRef` and
`groupsRef` to the new broadcast synchronously on EVERY broadcast, right AFTER the close-navigation
decision (`dispatch({ type: 'sessionsBroadcast' })`), because that is the one reader that needs the
PREVIOUS list. **A render never writes either ref**: only what changes the lists does (that handler,
the four drop commits, the split fuse sync). A pointer event renders before a queued broadcast does,
and the render-time `tabsRef.current = tabs` that used to sit beside them copied the OLDER list back,
so a drop right after went out without the tab the broadcast brought. A new `setTabs` therefore has
to write `tabsRef` first. And a module-level `applyDrop` applies a drop the way the server applies a `groupUpdate` and
then a `reorderTabs`: membership first and CONDITIONALLY (an add moves the tab into the group,
stealing it from any other; a removal acts only on a tab still in that group, so a tab another
window moved from G to H is not pulled out of H by a stale "leave G"), then the forgiving permutation
(unknown ids dropped, tabs the order never named kept in their prior relative order), then
`normalizeOrder`. Each commit also writes `tabsRef` at once, so a second drop before the next render
resolves against the first. `doReorder` and `moveGroup` had the same defect and go through
`applyDrop` too, and so does the fuse sync that moves a split's partner next to its anchor.
**Rows leave on the micro tier and enter on the stagger.** `ui/useLeavingItems.ts` keeps a removed
item rendered, `data-phase='leaving'`, for `--mo-micro` (read from the token, 140ms fallback, none
under reduced motion), then drops it. Each row sits in a `.drawer-leaf` that animates its OWN
occupied space — the kit Collapsible's `grid-template-rows: 1fr ↔ 0fr` — together with opacity:
fading the row alone and unmounting it after made every row below jump by its height at the end,
and collapsing the space with the fade lets them glide up. They are transitions, not keyframes, so
an interrupted change (a tab closed as its group folds) retargets. A list's FIRST fill is
`data-enter='stagger'` (`--mo-enter` plus a capped `--mo-stagger` step per row); rows inserted later
are `micro`, and a removal undone in time never replays the stagger. "First fill" is the first time
the list holds anything, not the first render: on a plain `/` or `?new=1` boot the selection waits
for the tab list, so the drawer mounts empty and fills on the first broadcast; a legacy `/<id>`
boot names its tab first, so the drawer's first fill is the one row it draws for that `current`
and the broadcast's other rows arrive on `micro`. The drawer is closed at boot either way, so no
stagger is ever seen there. The Explorer's rows use the same hook (`panes/FileTree.tsx`, where a
delete is the common exit), and there a listing already on screen STAYS on screen while it re-reads
— otherwise a delete's re-read of the parent would turn every sibling into a leave and a re-enter.
**The drawer holds the layout still, and never touches the keyboard.** The viewport effect's
`deferred` flag used to mean "a native selection holds the layout"; it now means "the layout is
held", set by a live selection OR an open drawer. The drawer's state reaches the effect through
`drawerHoldRef`, so the effect does not re-subscribe (which would drop `--app-height`).
`openDrawer()` records `kbdWasUp` — `#mobile-kbd` focused AND the pinned height more than
`KEYBOARD_GONE_PX` below `screen.height` — at the only moment it can be read: once the drawer takes a
tap Android may dismiss the IME without blurring anything, and from then on "was it up?" has no
answer. The drawer NEVER blurs `#mobile-kbd` itself (blurring and re-focusing around it was rejected:
you type, open the drawer to upload a screenshot, and keep typing). While held, viewport events
change nothing — no `--app-height` write, no refit, no resize reaching any PTY — but the hold never
blocks the FIRST pin, because mobile mode can come back on while the drawer is still open.
`closeDrawer()` is the ONE way out and every close path uses it (scrim, the root Close, choosing or
creating a tab, opening a file from the Explorer, dictation's Insert, every footer action): a path
that skipped it would strand the terminal at the keyboard-up height. It runs the selection's release
path — if `kbdWasUp`, re-raise FIRST (`kbdRaiseRef`), keep the keyboard-up height, and leave the
layout RESTORING until the keyboard is back, which costs at most one resize per PTY; a drawer opened
over a DOWN keyboard never raises however far the viewport grows, and re-pins at once.
**A restore is a pending state, and its end is a settle rule.** While the layout is restoring,
viewport events write NOTHING (no `--app-height`, no refit) and leave the `KEYBOARD_RETURN_MS`
(600ms) fallback armed. Before that, ANY viewport event ran `apply` again, cancelled the fallback and
pinned the grown height, and the IME's arrival then changed it a second time; the shape that cost it
was pinned 500px → the drawer closes at 844px → a scroll at 844px → the keyboard back at 500px, which
is two height writes and two resizes per PTY. Crossing back under the keyboard-presence threshold is
not completion either: an IME animates through intermediate heights (844 → 580 → 500), and
committing the first of them is the same second resize. So completion is a SETTLE rule: once the
viewport is within `KEYBOARD_GONE_PX` of the pinned height, a `RESTORE_SETTLE_MS` (150ms) timer
starts and EVERY later viewport event restarts it. When it fires, the final geometry is committed
ONCE, and not at all when it equals the geometry already pinned (844 → 580 → 500 against a pin of 500
writes nothing; a keyboard of a different height, 844 → 580 → 480, writes 480 once). The fallback
is the upper bound: when the keyboard never returns (a `focus()` without user activation) it fires
first and commits the real geometry once. A hold taken meanwhile, a new selection or the drawer
reopening, cancels both timers and takes over, and its own release decides afresh whether there is
anything to restore.
**A native picker keeps the hold until it comes back, and elapsed time never releases it.** Upload
and Images open an OS picker that can take the IME with it where the page cannot see it, so hiding
the drawer is separate from releasing the hold: `closeDrawer({ holdUntil: 'picker' })` hides it and
keeps the hold and the saved `kbdWasUp`. The hold is taken only when a picker ACTUALLY opened, so
the whole launch chain answers a boolean (`PaneApi.openPicker`/`openImagePicker`,
`DrawerActions.uploadFile`/`uploadImages`, App's guarded wrappers — which only toast on an editor,
markdown or web tab) and the drawer calls the action FIRST, then `closeDrawer` with or without the
picker hold. The release comes from `useFileUpload` (`armReturn`): the input's `change`, its
`cancel` (Chrome fires it on a dismissed file input), or a `focus` back on `window` while
`document.visibilityState === 'visible'`, the last followed by one tick plus 300ms
(`PICKER_RETURN_GRACE_MS`) for a late `change` to arrive first, after which it counts as a cancel.
`onReturn` fires once; a focus while hidden does nothing; a second launch settles the first; an
unmount settles a pending one. There is NO timeout, deliberately: browsing files or taking a photo
takes minutes and the terminal's row count must not change meanwhile. While a picker hold is on, the
`KEYBOARD_RETURN_MS` fallback never starts (the release path arms it, and a hold defers that path),
and reopening the drawer takes the hold back from a pending picker.
The footer is a 2-column gapless grid of equal cells — ⬆ Upload · ⬇ Download · 🔉 Dictate · 🖼 Images
(the sides ⚙ and 🎤 left behind are NOT reshuffled — the thumb knows where those two live). The ⌨
Keyboard cell is GONE (long-press ESC and the bar's left→right swipe both raise it); 🖼 Images took its slot.
It is the bottom of the thumb-ordered stack, under the session list, and every cell closes the drawer
through `closeDrawer()`. Cells use `pressClick`, so a press's trailing click is not a second
activation: Dictate is a toggle, and acting twice would start and stop it in one tap.
The remote-mic bridge (browser mic → server PipeWire: 🎤 cell, `/ws-mic`, `server/mic.ts`,
`client/mic/`, the `micBridge` keybinding) is REMOVED — it never worked as intended.

## Build / run

```bash
yarn install
yarn build                 # vite build of the client into packages/client/dist
yarn start                 # server on :44040 (prints token); visit /auth to authenticate
# localhost dev convenience:
PALMUX_NO_AUTH=1 yarn start
```

Dev with hot reload — `scripts/dev.sh` runs both and refuses if :44040 is already
being served (the installed service and dev's `tsx watch` bind the same port, and
without the guard the failure is silent):

```bash
./scripts/dev.sh           # both, one terminal, Ctrl+C stops both
yarn dev:server            # or separately: tsx watch, backend on :44040
yarn dev:client            # vite on :5173, proxies /ws,/auth,/logout,/ping to :44040
```

**The lifecycle scripts live in `scripts/`, and the only tricky part is deciding
WHOSE palmux they act on.** `start`/`stop`/`restart` hand off to systemd where a unit
owns this checkout and fall back to the supervised `run.sh` otherwise, so one command
serves both deployment modes. Two guards make that safe and both were written after
the failure, not before it:
- **`palmux_systemd_managed` compares the unit's `WorkingDirectory` to `$REPO`.**
  `palmux.service` is ONE machine-wide name, so a bare `is-enabled` check made every
  clone on the box claim it — a throwaway `cp -a` of this repo under /tmp stopped the
  real service, and a dev clone's `restart.sh` would restart production.
- **`stop.sh` confirms the pid file's pid is still OURS** via `/proc/<pid>/cmdline`
  before signalling. A pid file outlives a crash and Linux recycles pids from a low
  number after a reboot; without the check a stale file pointed at an unrelated
  `sleep` and stop.sh killed it, reporting "palmux: stopped". The `pkill` fallback
  below it was already repo-scoped — this closed the asymmetry.

All four resolve `$REPO` through symlinks, so linking one into `~/.local/bin` works.

Self-contained runtime (for machines without a toolchain): `yarn bundle` (`scripts/bundle.mjs`)
esbuild-bundles the server + client + node-pty native into `bin/` (committed to master, force-add
once); runs with only Node via `./bin/palmux` or the systemd-less supervisor `scripts/run.sh` (prefers
the bundle, falls back to tsx). The `.node` is arch-specific — bundle per target OS/arch. node-pty's
native is inlined via a `require`/`__dirname`/`__filename` banner (ESM) + `./build/Release/pty.node`.

**Size limits take a human form.** `maxUploadBytes` and `maxDownloadBytes` accept a
number of bytes OR `"<n><KB|MB|GB>"` (`shared/byte-size.ts`, binary units, also via
`PALMUX_MAX_UPLOAD_BYTES` / `_DOWNLOAD_BYTES`). The grammar is deliberately narrow —
no `1G`, no `KiB`, no `1 gigabyte` — because this value decides whether a request is
rejected, and a typo silently read as a different magnitude is exactly what
strictness prevents; anything unparseable keeps the default. **0 means NO LIMIT** for
both. **A bare byte count must parse from a STRING too**, not only from a JSON number:
an environment variable is only ever a string, so while `SIZE_RE` demanded a unit
`PALMUX_MAX_UPLOAD_BYTES=52428800` parsed to null and the caller silently kept its
default — the operator believes they capped it and have not — and `=0` could not
express "no limit" at all. Measured against `--print-config`. This does not loosen the
grammar above: a bare integer names one magnitude and only one, which is why the
number form was always accepted. Download defaults to 1 GB and is streamed. **Upload stays at 50 MB on purpose**:
the body is accumulated IN MEMORY on its way to the temp file, so `"1GB"` really means
one request may cost a gigabyte of RSS. That is the operator's trade to make
knowingly, not one the parser can make for them.

**The systemd unit is `KillMode=process`, and that is load-bearing.** A tmux
server started from inside a palmux shell daemonizes to ppid 1 but stays in this
unit's CGROUP, so the default `control-group` killed it on every `systemctl
restart` — every tmux session on the machine, not just palmux's. What that looked
like from the outside was tmux-resurrect rebuilding all of them at once from its
last SAVE (not the live state) while palmux's own session-restore typed `tmux
attach` into three terminals against a server still being reassembled. Verified by
reading the server's own cgroup: `tmux new-session -d -s _restore` in
`app.slice/palmux.service`. Nothing leaks by leaving the cgroup alone — palmux's
shells hold pty masters this process owns and die with it, crash included, while
the tmux server holds none of our fds. `service:update` now REWRITES the unit when
it has drifted from the template, because it previously only restarted and a
unit-level fix reached nobody.

Config: `~/.config/palmux/config.json` is the single source of truth (host, port 44040, auth,
`webApps` for the new-tab page,
shell, cwd, fontDirs, allowedIps w/ CIDR, allowedOrigins w/ `*.` wildcards, scrollbackBytes,
cookieDays) — see `server/src/app-config.ts` + `net-rules.ts`. Precedence: CLI > `PALMUX_*` env >
file > defaults; `--print-config` shows the result. Boot service: `yarn service:install|update|
uninstall|status` (`scripts/service.mjs`, systemd user unit + linger).

**The config dir is meant to be tracked by a dotfiles manager, so it declares its own
boundary.** `config.ts` writes a `.gitignore` on first run (`ensureConfigGitignore`, never
overwrites) covering everything in there that is per-machine or generated: `secret` — which IS
the shell — plus `sessions/`, `tabs.json`, `groups.json`, `transcripts/` (~100 MB of audio, the
single worst thing to sync), the generated `theme.{sh,tmux,json}`, and `*.log`. It is a DENYLIST
because people keep their own scripts in there (`theme-hook.mjs`, `hooks.d/`, a pager) and an
allowlist would silently stop tracking them; the price is that a new generated file needs a line.
Note it only governs UNTRACKED files — anything already committed stays tracked.
**`themeId` is the awkward one.** The client already withholds its purely-local settings
(`fontSize`, `mobileMode` are not in `SYNCED_KEYS`, so the server never sees them), but `themeId`
cannot take that route: `theme-export.ts` reads it AT BOOT, with no browser connected, to
regenerate `theme.sh`/`theme.tmux`/the Claude Code theme — browser-only storage would leave every
boot on the default palette and silently re-source tmux with the wrong colours. So it stays on the
wire and is split at the PERSISTENCE boundary instead: `saveSettings` routes `LOCAL_SETTINGS_KEYS`
to a gitignored `settings.local.json` and everything else to the tracked `settings.json`, and
`loadSettings` merges local OVER shared. That ordering is what makes a `yadm pull` carrying another
machine's `themeId` a no-op rather than a conflict. `ensureSettingsSplit` runs at boot to lift a
legacy `themeId` out of the shared file — without it a machine whose settings never change would
keep committing its theme forever, which is the whole complaint.

## Tests / typecheck

```bash
yarn test                  # vitest across packages
yarn typecheck             # tsc --noEmit across packages
```

## Auth

A single shared secret at `~/.config/palmux/secret` (32-byte hex, generated on first run).
`GET /auth` renders a token FORM and the token is POSTed — deliberately, so it never lands in a
URL, an access log, browser history or a Referer; the POST validates it (constant-time) and sets an
httpOnly session cookie; the cookie also
guards the `/ws` upgrade. There is **no** proxy-header trust. `--new-token` rotates the secret.

## Mobile layer (the point of the project)

`packages/client/src/mobile/` + `terminal/touch.ts`. Update tips in `tips/tips.ts` when adding a
user-facing interaction.

- **Mobile mode**: Settings → tri-state (`auto`/`on`/`off`, per-device localStorage). When on, the
  extra-keys bar shows and touch gestures are live.
- **Extra-keys bar**: gestures are tracked **per pointer**, not in one slot — holding a modifier and
  tapping another key is how a keyboard works, and a single slot dropped that second key at the
  one-at-a-time guard (reported as "long-press CTRL + ← does nothing" while tap-CTRL + ← worked).
  Only NON-modifier keys stay one-at-a-time, so two ordinary keys still cannot interleave.
  **The one that mattered was `onKeyDown`**, which built its modifiers from the PHYSICAL event only:
  `e.ctrlKey` is false however armed the bar's CTRL is, so the soft keyboard's Backspace left as a
  bare DEL — and its `preventDefault()` stopped the mods-aware `beforeinput` path from ever running.
  `e.isComposing` is what hid it for so long: with a composition live this handler returns early and
  the composition path (which does read the bar) sends the right bytes, so CTRL+Backspace appeared to
  work exactly ONCE right after typing a letter and never again — that one backspace empties the
  one-character composition. The reported shape ("only works if I press another key first, and only
  once") is the symptom of that, and no amount of reading the delete paths would have found it; the
  raw capture did.
  A raw byte capture from a real phone (`stty raw` — `cat -v` cannot see this, the tty's canonical
  mode eats the backspace as ERASE before any program does) also caught two keys skipping the
  modifier entirely: **Enter** sent a bare `\r` instead of going through the encoder, so ALT+Enter
  never became `ESC CR` and the modifier stayed armed to leak onto the next key; and a composition
  delta that REMOVES AND ADDS in one step sent a bare DEL and handed the modifier to the inserted
  character (measured `7f` then `18` for a CTRL-armed `b`→`x`). The modifier belongs to the DELETE,
  whatever else the delta carries, and `sendText` must not be the one to spend it — inside one key's
  burst `takeMods` replays the snapshot, which is right for one key seen twice and wrong for a delete
  and an insert in the same delta.
  `takeMods` also latches its consumed snapshot for `BURST_MS` (24ms): one physical key produces
  SEVERAL input events — GBoard sends a composition shrink where another IME sends
  `deleteContentBackward`, and `useSoftKeyboard` reads the modifiers on every path — so consuming on
  the first read sent `^H` and then a bare DEL, killing a word plus one more character.
- **Extra-keys bar**: Termux-schema layout; sticky CTRL/ALT/SHIFT — tap = one-shot `armed` (green,
  applied to the next key; how the tmux prefix Ctrl+B works from a touch keyboard), long-press =
  `locked` (orange, applies until tapped off). `key-encoder.ts` is the single source of truth
  for key→bytes, shared with the physical keyboard. Supports **macros** (`encodeMacro`), **long-press
  popups** (the `popup` field; ~350ms hold → popup key, shown in the key's corner), and **long-press
  actions** (the `action` field → `ExtraKeysBar` `onAction`; today only `'keyboard'` = toggle the
  soft keyboard via `kbd.toggle()`. ESC has it by default — the reliable mobile keyboard-raise). A
  tap still sends the key; the action/popup only fires on hold.
- **Config file**: `~/.config/palmux/extra-keys.json` (created on first run by `ensureExtraKeysFile`).
  The server loads it (`loadExtraKeys`, accepts `{enabled,layout}` or a bare Termux array) and
  **hot-reloads** via `fs.watch` → broadcasts `extraKeys` to all clients. The client never overwrites it
  (no in-app editor). Full schema documented in the README.
- **Soft keyboard**: hidden textarea with **incremental IME composition diffing** so typing flows live
  (Android GBoard would otherwise buffer whole words).
- **Gestures**: pinch→font zoom, tap→tmux pane-focus (under mouse reporting) or raise keyboard,
  vertical swipe→tmux wheel or local scrollback, long-press→text selection. On the EXTRA-KEYS BAR a
  horizontal swipe is reported by direction (`onSwipe 'left'|'right'`): left→right always RAISES the
  keyboard (`kbd.raise()` = blur+focus, because Android dismisses the IME without blurring and a bare
  `focus()` on a still-focused textarea is a no-op), right→left opens the drawer.
- **Text selection** (`mobile/native-selection.ts`, `settings.nativeTouchSelection`, DEFAULT ON): a
  transparent, selectable DOM text layer over the canvas so the BROWSER owns the long press, the
  handles, and the OS Copy/Share callout — the user selects exactly what they want and picks the
  action themselves, instead of palmux auto-copying. Consecutive `isWrapped` rows render as ONE
  element (`pre-wrap` + `break-all`) so the OS copy has no newline at a soft wrap; per-character
  advance is corrected with a measured `letter-spacing` so a DOM column is a canvas column (re-measured
  on `document.fonts` `loadingdone` — a webfont landing after the first measure never changes the
  family string). **Selection survival:** starting a selection BLURS `#mobile-kbd` (a page selection
  and a focused editable cannot coexist), so Android dismisses the IME → `visualViewport` fires →
  the terminal re-fits → the selection dies. Two guards: the layer freezes its TEXT while a selection
  is live and NEVER drops the selection itself (geometry still follows — moving an element keeps its
  text node), and `App`'s visualViewport handler DEFERS the `--app-height`/`refit()` write while
  `hasNativeSelection()`, replaying it on `selectionchange` once the user lets go. The layer's
  metrics comparison must include `rows` and the grid origin, not just cell size — a keyboard toggle
  changes only those.
  **The replay must also put the KEYBOARD back, and for two years it did not.** The blur is
  unavoidable, but nothing re-raised the IME afterwards, so the selection ended with the dead space
  collapsing and the user looking at a terminal they could no longer type into — reported from a
  phone as the terminal CLOSING, which sent the first investigation after the pane and the socket.
  Measured: the pane element and its `clientKey` both survive and no `exit` overlay appears; the only
  thing that moves is `document.activeElement`, to `BODY`. `shouldRestoreKeyboard` (App.tsx) gates the
  re-raise on TWO things, and both carry weight — `deferred`, so an ordinary keyboard dismissal is
  never fought, and the visual viewport having GROWN past the height the app was pinned to by more
  than `KEYBOARD_GONE_PX` (100, the same threshold as `ExtraKeysBar`'s `keyboardVanished`), which is
  the only available proof that the keyboard was up when the selection STARTED. Focus cannot answer
  that — a selection blurs the textarea whether or not the IME was showing — and without the growth
  test someone selecting a line while merely READING is handed a keyboard they never asked for.
  It is best-effort by nature: Android raises the IME only for a `focus()` carrying user activation,
  which the tap that dismisses a selection provides and the OS Copy callout may not; in that case the
  next tap on the terminal raises it as it always has. `contextmenu` suppression on the host is lifted in this mode — that is what
  kills the callout — and the tap path early-outs while a selection exists. Turning the setting OFF
  restores the custom long-press handles (`selection-handles.ts`) + copy-on-select, which stay as the
  fallback. Native selection wins even under mouse reporting (tmux drag-select on touch is worse).
  **Line breaks are explicit**: every logical line but the last ends in a real `\n` character,
  because Blink's plain-text serialiser emits NO break between out-of-flow blocks — the rows are
  absolutely positioned, so a multi-line copy came out as one run-on line (verified in Chromium: the
  same rows made `static` serialise with newlines, `absolute` without; the added newline's client
  rect is 0px wide, so the selection highlight is unchanged). A soft wrap still adds none — the
  wrapped line is ONE element with ONE terminating newline — and the last row stays bare so a copy
  can't paste a trailing newline that RUNS the command.
- **Pasting text on mobile** goes through the pane's `paste()` (`\n` → `\r`, bracketed-paste while
  the app has it on), not `sendInput`: the soft keyboard's `insertFromPaste` used to forward the raw
  clipboard string, so every `\n` reached the PTY as Enter and a multi-line paste submitted line by
  line instead of arriving as text. The clipboard string is read with `||`, not `??` — a paste can
  leave `InputEvent.data` empty rather than null, and `'' ?? x` never falls through to `dataTransfer`.
  **`insertFromPaste` is not how most pastes arrive.** Measured on Samsung's clipboard-history panel
  with a 3997-char, 64-line entry: NO `paste` event, NO `insertFromPaste` — one `beforeinput` of
  `inputType: 'insertText'` carrying the whole text, then a legacy `textInput` and 111 mirroring
  `input` events. Handled as typing that reaches the shell as 65 hand-typed lines: unbracketed, so
  the app RUNS them instead of inserting them. `isPaste()` therefore treats **any insertion carrying
  a line break** as a paste whatever the browser called it. The discriminator is the line break, not
  a length threshold: a keystroke never holds one, and neither does an IME word commit or an
  autocorrect replacement, so it cannot misfire on real typing; a long single-line paste still
  arrives as typing, which is what typing a long command already looks like. An insertion with no
  readable text no longer calls `preventDefault()` — silently eating a paste leaves no text, no
  error and no clue.
- Touch→mouse forwarding assumes SGR (1006) encoding (every modern app that enables mouse reporting
  negotiates it).
- - **Static assets ship pre-compressed and immutable** (`client/vite-precompress.ts`,
  a `closeBundle` plugin using `node:zlib` — no new dependency, same reasoning as
  the zip writer in `download.ts`). Measured before it existed: `GET
  /assets/index-*.js` answered **962 KB with no `content-encoding` at all** despite
  `Accept-Encoding: gzip, deflate, br`, and `max-age=0` on a file whose name
  contains its hash. Now 5.59 MB → 1.21 MB brotli across the build, and the main
  bundle answers **219 KB**. `/assets/` is its own `@fastify/static` mount with
  `preCompressed`, `immutable` and a year; `/file-icons/` gets compression and a
  day but NOT `immutable`, because those files are not content-hashed and
  re-running the vendor script has to take effect. **`Vary: Accept-Encoding` is not
  optional and this version of `@fastify/static` does not add it** — it sets
  `content-encoding` per request while declaring no variance, so a shared cache
  holding an `immutable` response would hand brotli to a gzip-only client and never
  revalidate its way out. `index.html` stays out of both mounts: it names the
  hashed bundles, so it must keep revalidating. The remaining ceiling is the
  **986 KB Nerd Font**, which is woff2 — brotli inside already, so compression does
  nothing for it and it is now the largest single item in a cold load. Owner
  decision: it stays preloaded ("quero que esteja sempre loaded and in memory, sem
  delay ou re-paints"); subsetting the face is the only lever left and is not taken.
- **The PTY's hottest path encodes each chunk ONCE.** `remember()` returns the
  buffer it appended to the replay ring and the `DataListener` receives it, so the
  WebSocket send no longer re-runs `Buffer.from(data, 'utf8')` over identical
  content — on the path every byte a shell prints travels, from boot, with no
  transfer involved. On the client, the replay branch no longer `latin1Decode`s:
  it writes the bytes directly, so the decode was building a string of up to
  512 KB character by character purely to discard it, once per tab switch.
- **trzsz can now stand down.** The filter is installed by a magic string in the
  OUTPUT, which any program can print — `cat` a log containing one and the terminal
  was behind a file-transfer filter with no way out. Two fixes: `processInput` only
  diverts a keystroke while a transfer is ACTUALLY running (that call exists so
  Ctrl-C can abort one; diverting whenever a filter existed meant the shell simply
  stopped responding), and an idle watchdog drops the filter after 20s of silence
  with nothing transferring. Standing down is not abandoning — the module is
  already in the bundle cache, so a real transfer later re-installs it.
- **OSC 8 link ranges are cleared with the terminal.** They are keyed by ABSOLUTE
  buffer cell and `Terminal.reset()` (what a tab switch does) restarts those
  coordinates at zero, so a surviving range pointed at whatever the next session
  drew there. `Osc8Tracker.clear()` existed for exactly this and had no callers.
  Known limit, unfixed: once the scrollback is FULL every absolute index shifts
  down by one per new line, so long-lived ranges drift — that needs an xterm marker
  per range rather than a number.

**The PWA manifest is SERVED, not static** (`server/manifest.ts`): an installed app paints its
  system bars from the MANIFEST, never from the `<meta name="theme-color">` the client rewrites on
  every theme change, so the hardcoded Mocha in the file put a near-black status bar over a light
  theme and nothing client-side could reach it. The route overwrites only `theme_color` and
  `background_color`, both from `profile.bg` (the terminal's own background — the app is a terminal,
  so that is what the splash should open on), and leaves every other field to the file. It resolves
  from the server's stored `themeId` because the manifest is fetched WITHOUT credentials; Chrome
  re-reads it on its own schedule, so the bars catch up at the next refresh while the meta tag covers
  the browser-tab case immediately.
- **PWA**: installable via `client/public/manifest.webmanifest` + `public/icons/` (no service worker
  on purpose — offline is useless for a terminal and cache staleness fights auth). The server exempts
  `/manifest.webmanifest` + `/icons/*` from the cookie gate (browsers fetch them credential-less);
  IP rules still apply. Standalone install requires a secure context (HTTPS or localhost).
- **Soft keyboard input** is a hidden `<textarea id="mobile-kbd">` (always focused to catch
  keystrokes). Being a text field, mobile keyboards (Samsung/GBoard) offer text autofill/suggestions
  and BLOCK image commits — attributes on it suppress autofill noise but can't accept images.
  There is therefore NO mobile clipboard-image path: the drawer's 📋 Paste
  button was removed (its `clipboard.read()` ran on pointerdown, before Android grants the activation
  it needs, so it only ever toasted) — use ⬆ Upload, which reaches the gallery. A native keyboard
  image-paste would require switching this to `contenteditable`, which would rewrite the IME
  composition-diffing engine (deliberately not done).
- **Backspace bytes** (`key-encoder.ts`): plain→`\x7f` (DEL), CTRL→`\x08` (^H), ALT→`\x1b\x7f`
  (ESC DEL) — xterm's convention. WHICH word each kills is the shell's business (zsh/readline bind
  ^H and ESC-DEL themselves); the terminal must not substitute ^W, which bypasses those bindings.
  The soft-keyboard delete paths (`deleteContentBackward`, `deleteWordBackward`, AND the
  one-character composition shrink — GBoard composes almost every word) all route through
  `encodeExtraKey('BKSP', getMods())` so an armed sticky modifier applies and is consumed.
- **File upload** (`terminal/useFileUpload.ts` + `pasteFile.ts` + server `upload.ts`): entry points —
  image paste (Ctrl+Shift+V / document paste listener / mobile keyboard `insertFromPaste`), drag-drop
  of ANY file onto `.term-wrap`, and TWO picker buttons. Both hidden inputs are `multiple`; a batch
  uploads STRICTLY in sequence and each path is typed as it lands (space-separated), so the pick
  order is the type order — parallel POSTs would let a small file overtake a large one. The two
  differ only in `accept`, which is the whole point: Chrome on Android builds its chooser from that
  list, and an EMPTY accept matches image AND video supertypes, so ⬆ Upload (any file, rail action
  desktop / drawer mobile) always asks "photo / video / file?" first. 🖼 Images (drawer, mobile)
  sets `accept="image/*"`, which passes Chromium's `isSupportedPhotoPickerTypes` and opens the
  system photo picker directly — the price is that it takes images only. There is no accept value
  that means "any file, no camera": `*/*` and an absent accept are the same case in
  `SelectFileDialog.acceptsType`, and any list containing an `image/` type re-adds the camera.
  POSTs to
  `/upload`, which saves to `<tmpdir>/palmux-clip-<hex>-<safename>` and returns the path; the client types it
  into the PTY (no newline). **The raw-body parser must be the ONLY one in that scope**: `'*'` is a
  FALLBACK, not a catch-all, so Fastify's built-in `application/json` and `text/plain` parsers won
  over it and handed the route an object/string instead of a Buffer — every `.json`/`.txt`/`.md`
  upload answered `empty body` while the same bytes labelled `application/octet-stream` saved fine.
  `removeAllContentTypeParsers()` inside the scope is what makes "any file" true. Cap is
  `cfg.maxUploadBytes` (config.json, 50 MB default), sent to the client in `ready` for an early size
  check; server enforces via a capped raw-body parser (413). **`maxUploadBytes: 0` means NO limit** —
  the config parser accepts `>= 0`, the server swaps 0 for `MAX_SAFE_INTEGER`, and the client skips
  its pre-reject (a `|| DEFAULT` there would have kept rejecting what the server accepts). The body
  is buffered in MEMORY on its way to the temp file, so "no limit" is really "bounded by RAM".
  Sessions live in a shared `SessionRegistry` (server.ts) so the HTTP route and WS bridge see the
  same PTYs.
- **File download** (`server/download.ts` + `GET /download?path=<abs|glob>`, client
  `terminal/download.ts` + ⬇ rail action (desktop) / drawer item (mobile)): single file streams raw; a glob,
  directory, or multi-match arrives as ONE zip built with node:zlib only (deflate + crc32, no
  deps). Absolute paths are by design — the cookie gate is the boundary, same trust model as the
  PTY (the shell can already read anything). Caps: 500 files / 256 MB per zip.
- **Inline images** (`@xterm/addon-image` + `terminal/image-support.ts`, `settings.inlineImages`,
  DEFAULT ON): real pixels in the terminal — **SIXEL** and **iTerm2 IIP**, drawn onto the addon's own
  `xterm-image-layer` canvas above the WebGL one (verified live: `timg -ps` renders in colour with
  WebGL active). Version is LOCKSTEP with xterm — `addon-image@0.9.0` ↔ `@xterm/xterm@6.0.0`; bumping
  one without the other is the whole compatibility story, and the addon declares NO peerDependencies,
  so the root `resolutions` pin is the only thing enforcing it. **Kitty's protocol is out**: the
  shipped addon has no Kitty handler at all (measured: zero references in its build).
  The addon is loaded in its OWN effect (`useTerminal`) because the setting is a live toggle and
  loading is not a private act — it claims `DCS q` + `OSC 1337`, turns on the CSI 14t/16t/18t pixel
  reports, and REPLACES the DA1 answer with `CSI ?62;4;9;22c`. Only `dispose()` unregisters those, so
  the toggle creates/destroys rather than setting a flag (verified: off → DA1 back to `?1;2c`, no
  layer). Image storage needs no teardown — each image is anchored to a buffer marker, so the
  `Terminal.reset()` on a tab switch disposes the markers and the addon evicts itself.
  **That DA1 answer is the entire integration.** `tmux` (3.7b, sixel compiled in) queries DA1 at
  CLIENT ATTACH and gains the `sixel` feature from the `;4;` in it — measured both ways via
  `#{client_termfeatures}`. Without it tmux draws its own `SIXEL IMAGE (WxH)` placeholder box of `+`
  instead of passing the image through, which is what a stale client (attached before this landed)
  still does: features are negotiated once, so a `tmux detach` + re-attach is the fix. This is also
  why `TerminalPane`'s focus-based DA/DSR report gate had to go — see the comment there; tmux's query
  landed inside the old 1s post-focus grace and got swallowed, and `suppressInputRef` already covers
  the replay case exactly (one binary frame, flag held across the whole `write()`).
  **What the apps do is the weak link, not the terminal.** `timg` 1.5.2 and `chafa` 1.14 pick a
  protocol from a hard-coded terminal-name table, never DA1 — measured: neither switches for any
  `TERM`/`TERM_PROGRAM` we could honestly claim (`TERM=xterm-kitty` makes chafa emit KITTY, which we
  cannot draw). So: `timg -ps`, `chafa -f sixel`. timg's own man page says the same ("alias
  timg='timg -ps'"). **IIP needs `size=`**: the addon's `IIPHandler` aborts on a header without
  `inline` AND a non-zero `size` — `imgcat` sends it (verified rendering, exact colour), `timg -pi`
  does NOT, so that flag silently draws nothing. Budgets are per-pane and mobile-aware
  (`image-support.ts`): a decode holds two RGBA buffers at once, so mobile caps at 2048×2048 (32 MB
  peak) + a 32 MB FIFO cache, desktop stays at the addon defaults. Animation/video are a non-goal —
  every frame crosses the WebSocket as raw pixels.
- **Markdown viewer** (`server/markdown.ts` + `GET /md-file?path=` / `GET /md-list?dir=`, client
  `panes/MarkdownPane.tsx` + lazy `panes/markdown-render.ts` = marked→DOMPurify→link/image
  rewriting). `markdown` tab kind; file path in `TabMeta.url` (kind-aware gate: absolute path).
  `md-file` reads any absolute path (shell-trust, 2 MB cap); `md-list` is CONFINED to config
  `markdownRoots` (realpath prefix, symlink-escape-safe) — browsing is the scoped surface. Relative
  `.md` links navigate in-pane (`data-md-path` → `updateTab{url}`); marked/dompurify are their own
  lazy chunks (terminal-only downloads neither).
**Surviving a restart.** Two mechanisms, for two different deaths.
`handoff.ts` is the good one: it passes each live pty master fd to a detached
successor, so the SAME shells keep running (SIGUSR1, or a staged self-update).
It **refuses under systemd** — `handoffBlockedReason` checks `INVOCATION_ID`,
because with `Type=simple` + the default `KillMode=control-group` the successor
dies with the unit's cgroup the moment we exit, which is worse than not trying.
The shipped unit IS Type=simple, and `service:update` runs `systemctl restart`,
so **on a normal install the handoff never fires** and every restart is a cold
start. A reboot always is. `session-restore.ts` covers the cold start: a process
whose pty master died cannot be reattached by anyone, so the terminal is REBUILT
from `cwd` + the foreground process group's command line (`/proc/<shell>/stat`
field 8 `tpgid` → `/proc/<tpgid>/cmdline` — parsed after the LAST `)`, since
`comm` may contain spaces and parens) + the replay ring, snapshotted to
`<configDir>/sessions/<id>.json` every 60s and on shutdown. On respawn the shell
starts in that cwd, the ring is replayed as scrollback (alt-screen switches
STRIPPED — a stray `?1049l` would wipe the replay — then a `── restored ──`
marker), and the command is TYPED back after 400ms. The snapshot stores **argv
as an ARRAY**, rendered with POSIX quoting (`quoteArgv`) only at the moment it is
typed: joining argv on spaces is not shell quoting, so `vim my notes.txt` opened
two files and a filename holding `;`/`$()` EXECUTED — a filename was enough to
inject. Control characters are rejected per argument on capture and on load
(quoting cannot save that: a CR ends the typed line inside quotes too), and a
`cwd` must be absolute and still exist. Nothing knows what tmux is:
whatever was in the foreground is what comes back, which for `tmux new -A -s x`
means a real reattach to a live session because tmux's own server outlives us.
**The hint channel** covers what /proc structurally cannot. A wrapper resolves
its target at RUN time (`dr tmux/session` with no argument names no session at
all), and tmux's `switch-client` moves a client to another session without
touching any argv — verified: after switching `a`→`b`, /proc still reports
`attach-session -t a`. Walking to the deepest child fixes neither, and it breaks
every wrapper that exists to inject env (`npm run dev`, `sudo`, `poetry run`)
besides being meaningless for a pipeline, whose process group has several leaves.
So the PROGRAM says it itself: anything may write its restore line to
`<configDir>/sessions/by-tty/<tty>.restore` (`pts/16` → `pts-16.restore`; bare
shell line, or `{"argv":[…]}`), and that BEATS the /proc capture. The tty is the
join key because both sides already know it without agreeing on anything —
palmux reads it off the shell's fd 0, and it is reachable from tmux hooks, which
run in the SERVER's environment and would never see an env var palmux exported
into a shell (`#{client_tty}` is right there). `$PALMUX_RESTORE_HINT_DIR` is
exported anyway for callers that CAN see the shell env. Palmux stays ignorant of
tmux; tmux is just the first caller. Staleness is handled by CLEARING the hint
when a terminal spawns on that tty — pts numbers are recycled, so a leftover
from a dead terminal would restore the wrong thing. `ttyOf` must return the
device name verbatim (`pts/16`, not `pts16`): it and `createHintStore`'s
filename mapping are the two halves of the join, and a mismatch makes every hint
silently invisible.
Be clear on the limit: this RELAUNCHES, it does not resume — only programs that
keep state outside the terminal (tmux, screen) truly come back. Capturing only
the FOREGROUND process is also the safety property (it selects long-lived
interactive programs), the command is re-checked for control characters on load
because the file is user-editable, and `restoreSessions: false` disables the
lot. A terminal tab with a snapshot counts as "worth keeping" on restore,
alongside name/color/group — bare terminals used to be dropped outright.
**A tty HINT dies with its terminal, and until 2026-09-09 nothing enforced it.**
A hint is only ever READ through `ttyOf(pty.pid)` of a live palmux terminal, but
it was only ever CLEARED by a palmux terminal touching that exact pts — three
terminals against fifty ptys — and every death that runs no code (SIGKILL, a
power cut, and until the KillMode fix every `systemctl restart`) skipped the
clear entirely. Measured on the owner's host: **17 files, the oldest three weeks
old, seven naming tmux sessions that no longer existed.** The bite is that pts
numbers are handed out LOWEST-FREE, so a restart frees the low numbers and a
brand-new terminal lands on `pts/2` and inherits `tmux attach-session -t build-0`
— and the hint BEATS the /proc capture, so the correct reading is discarded in
favour of the ghost. `HintStore.sweep(liveTtys)` is the counterpart the snapshots
always had: it runs at boot (AFTER the handoff adopt, so an adopted terminal
keeps its own) and on every snapshot tick.
**Liveness, NOT age.** A TTL looks equivalent and is not: a terminal attached to
the same tmux session for a fortnight has a fortnight-old hint that is still
exactly right, and it is the only thing that knows about a `switch-client`, which
/proc structurally cannot see. The sweep also translates `pts/7` → `pts-7` before
comparing — mixing the two vocabularies keeps everything or deletes everything,
and neither failure resembles the other.

**A snapshot dies with its session, and that is FOUR paths, not one.** Ids are
recycled lowest-free, so a snapshot outliving its tab is not litter — it is
handed to whoever takes the id next, which surfaces as a shell closed weeks ago
reappearing in a brand-new tab. `killTab` forgetting was never enough:
(1) the pty's `onExit` forgets too, so `exit`/Ctrl-D counts, gated on a registry
`shuttingDown` flag that `index.ts` sets BEFORE the final capture — every shell
exits on shutdown, and those are the snapshots the feature exists to keep;
(2) `killTab` marks the record `dying` and `snapshotForRestore` skips it,
because a kill returns before the shell is dead (up to the 3s SIGKILL
escalation) and the 60s tick or a shutdown landing in that window wrote the
snapshot straight back; (3) `createTab` forgets on the id it just claimed, so a
web/editor pane does not sit on a terminal snapshot; (4) boot sweeps every
snapshot with no tab in tabs.json, which is the only cover for the deaths that
run no code at all (SIGKILL, power cut). The exit path also clears the tty hint,
using a `tty` captured at spawn — `ttyOf` reads `/proc/<pid>/fd/0` and returns
null once the process is gone, so nothing after the exit could find it.
- **The dictation model is the failure surface, not the code** (`server/dictate.ts`). Measured
  2026-08-17: `gemini-3.6-flash` and `gemini-3.7-flash` answered `500 INTERNAL` to inline AUDIO while
  still serving TEXT normally — the same clip transcribed fine on `gemini-3.5-flash`,
  `gemini-3-flash-preview`, `gemini-3.1-flash-lite` and `gemini-2.5-flash`. Nothing in palmux
  changed; a model regressed upstream and the server only relayed the status.
  **That regression is FIXED — re-measured 2026-09-02**: 3.5, 3.6, 3.7 and 3.8-flash all accept
  inline audio. `model-audio` stays on **3.5-flash** anyway, because newer buys nothing here: over
  three stored clips (158–244 KB) word-level agreement was 3.5 97% · 3.7 96% · 3.8 97% · 3.6 93%,
  while latency was 3.5 1.4s · 3.7 1.4s · 3.8 **3.1s** and 3.8's cost climbed with clip length
  (1.5s → 4.6s across the three). Read that accuracy column with the bias in mind: the reference is
  the stored `.txt`, i.e. a previous 3.5 output, so 3.5 is partly scoring against itself — which is
  exactly why the tie is not a reason to move. The probe is `dictate.ts`'s own request shape, run
  straight against `generativelanguage.googleapis.com`; `dictation` is read at BOOT, so changing it
  costs a restart and every live terminal.
  **The two passes therefore have their own model**: pass 1 carries the audio, pass 2 is pure text,
  and they fail independently — so a regressed-for-audio model can still do the cleanup. Config keys
  are `dictation.model-audio` / `model-text` (`modelAudio`/`modelText` internally — the hyphenated
  names are the external shape, translated at the parse boundary); env is
  `PALMUX_DICTATION_MODEL_AUDIO`/`_TEXT`. A legacy single `model` (config or
  `PALMUX_DICTATION_MODEL`) still sets BOTH and is read FIRST so a specific key overrides it — each
  host has its own config.json, so old files are in the wild and ignoring the key would silently
  move them onto the defaults. Defaults are deliberately mixed: audio on `gemini-3.5-flash`, text on
  `gemini-3.7-flash`. Two more things keep a model swap usable: the error NAMES the model
  (a bare `502` sent us auditing palmux for an hour, and with two models it also says WHICH pass
  died), and the request RETRIES once without
  `thinkingConfig` when the API answers `400 Thinking level is not supported` — that field is 3.x-only
  and the 2.5 family rejects the whole request over it, so without the retry a model swap would
  trade a 500 for a 400. `rejectsThinkingLevel` matches that message ONLY, so a 500 stays a 500.
  `dictation` is read at BOOT, so a model change needs a server restart — which
  costs every live terminal. To check a model before restarting anything, POST the clip straight to
  `generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`; the stored clips in
  `<configDir>/transcripts/` are exactly the bytes the server would send.
- **Dictation history is AUDIO-FIRST** (`server/transcripts.ts` + `dictation/DictationHistory.tsx`).
  An entry is a STAMP id with up to two files in `~/.config/palmux/transcripts/`: the clip
  (`<id>.<ext>`) and its text (`<id>.txt`). `POST /dictate` writes the CLIP BEFORE calling the model
  — transcription is a paid network round-trip that fails for reasons the speaker can't act on, and
  until this a failure threw the recording away with it (no history entry at all). Which files exist
  IS the entry's state: audio+no text → the panel offers **Transcribe** (`POST /transcribe?name=<id>`
  re-runs `dictate()` on the stored clip server-side); text → Copy/Insert as before; text-only → an
  old entry, or one whose clip aged out. `GET /transcript-audio?name=<id>` streams it back for
  playback. A failed `/dictate` answers `recoverable: true`, which reaches the client as a FLAG on
  `onError` rather than wording baked into the message — the hook does not know whether the history
  is a dock view (desktop) or a panel (mobile), and the host does. That flag becomes a toast ACTION,
  and an action changes the toast's dwell: 1.4s is a confirmation ("Copied"), and nobody reads a
  sentence and reaches a button in 1.4s, so `Toast` holds an actionable message for 6s and takes
  pointer events only while it has one (a plain toast must not eat a tap on what it floats over).
  **The recording toast is a two-PHASE surface, and compaction is on a timer.** Stopping hands off
  to a paid round-trip that can fail, so the toast stays up as `transcribing` (accent dot, no meter,
  no Stop, the clip's final length held) instead of unmounting — vanishing on Stop made "still
  working" and "failed silently" identical. And `narrow` only says this screen will WANT its room
  back: the toast opens full and shrinks after `COMPACT_AFTER_MS`, narrowing the meter to three bars
  rather than dropping it. Keying compaction straight off the viewport meant a phone never saw the
  waveform at all — the one element that proves the microphone is live.
  Text prunes oldest-first past 100 entries; audio has its OWN 100 MB byte budget (a clip is four
  orders of magnitude bigger than the line it becomes), so a transcript can outlive its recording.
  Every path built from the `name` query param goes through `isTranscriptId` first.
  **`/transcript-audio` answers Range requests** (`parseRange` in `transcripts.ts`: 206 +
  `Content-Range`, a bare 416 for an out-of-file range, `Accept-Ranges: bytes` always announced,
  full body for an absent/multi-range header). That is not polish — the panel's `<audio>` had
  `preload="none"`, so the browser fetched nothing until play and every row rendered a dead
  `0:00 / 0:00` scrubber (verified in Chromium: `duration` NaN, `readyState` 0, `loadedmetadata`
  never fires; with `preload="metadata"` it reports the real 1.740s). Preloading metadata for every
  entry is only affordable WITH ranges — audio has its own 100 MB budget, so without them each row
  would pull a whole clip. Note the panel's timestamps are NOT off: the stamp id is the SERVER's
  local time (UTC here) and the client renders the epoch in the browser's zone, so a `1311` file
  correctly reads 14:11 in a UTC+1 browser.
- **Settings form** (`settings/SettingsFields.tsx` + `settings/settings-view.css`, with a
  `.settings-form` root in index.css). One field list for BOTH hosts (desktop DOCK, mobile drawer —
  the modal is gone). The look lives in `settings-view.css`, every rule under `.settings-view`, and
  its root rule is the compound `.settings-view.settings-form` so it beats index.css's block whatever
  order the bundler emits the two in. What stays in index.css is what a HOST reaches before that
  sheet loads: the control column (`--set-control`, 140px; the drawer overrides it to 55%) and the
  `--fs-2` type size.
  **Sections are titled cards.** Appearance / Terminal / Keys / App are kit `Collapsible`s — a flat
  list of fifteen gave the eye nothing to land on — and a section's rows sit in ONE `.set-card`
  (`--t-base` on the mantle panel, a 1px `--t-surface` border, `--r-3`) with a hairline between
  rows: depth is the kit's three levels, never a shadow. The title is the kit's small
  secondary-colour label (see "The dock has TWO heading levels"), so the panel title and a section
  title are two distinct levels. The gap under a title is the card's MARGIN, not padding on the
  collapsible's inner box: that box is what the 0fr → 1fr collapse squeezes, and padding there
  leaves a residue no row height can collapse into.
  **A row is a label column and ONE fixed control column.** `.srow` is a grid of
  `minmax(0, 1fr) var(--set-control)`: the label (+ a `.srow-sub` hint line) on the left, the
  control on the right at the same width in every row, so every control shares both edges.
  Text-like controls (Select, number Input, Segmented, the Theme button, text Buttons) fill the
  column; a Switch and a `LinkRow` chevron sit at its right edge. The column is 140px because
  132px clipped the cursor Segmented to "Blo… / Underli… / B…": its labels need ~101px of text,
  which is also why a settings Segmented item takes 2px of padding, not the kit's 10px. A row is
  44px at rest (a 28px control + 2 × 8px padding) with the control centred, hint or no hint. The
  hairline between rows takes 1px of the next row's own padding back, because a border is height:
  without that every row after the first was 45px while a Switch row, which has no control to hold
  it up, stayed 44. A stacked row (Import theme) spans both columns, and a hint too long for the
  label column is a `note` under the row (`.srow-note`, `grid-column: 1 / -1`) — the sidebar-rail
  warning in the label column was a ~180px strip of one-word lines.
  **Every control is `--ctl-h`** (28px; 36px under `:root[data-mobile='true']`), and the kit now
  gets there itself: Button, Input and the Select trigger are `--ctl-h` tall, and a Segmented's
  wrapper is a `--ctl-h` floor over items of `calc(var(--ctl-h) - 6px)` (it adds 2px of padding and a
  1px border a side). That was not so while the kit read `--mbtn-h`: its Button and Input carried a
  30px `min-height` that setting `height` alone could not beat, so the form overrode `min-height` on
  Button, Input and the Select trigger and sized the Segmented's OUTER box and then its items. Only
  `height` is left of that: an exact box on Button, Input and the Segmented's wrapper, where the kit
  sets a `min-height` floor. Everything else in Settings that matched the kit (the floors, the
  `--r-2` corners, the Select trigger's height, the section header's floor) is gone, and
  `ui/scale.test.ts` fails a rule outside the kit that restates the kit's own height or corner for
  a control. What still differs on a Segmented item is its 2px of padding, not the kit's `--sp-3`,
  and its ellipsis. The Switch keeps its 42×24 look
  and gets a hit area `--ctl-h` tall from an absolutely positioned `::before`, so the row's layout
  does not move. Measured in Chromium on a
  static render of the built CSS: Input, Select, Theme button, Segmented and Button are 28px at
  1440 and 36px at 390, with identical left and right edges. `SettingsFields.test.tsx` resolves the
  control heights from the stylesheets (and `ui.test.tsx` the Select trigger's), because happy-dom
  has no layout.
  **No native `<select>` is left.** Font is the kit `Select` (`ui/Select.tsx`, Radix Select): a
  `--ctl-h` trigger on the recessed level with the label on ONE line — a value longer than its box
  ends in an ellipsis and the whole of it is the trigger's `title` — and a popup that is `.ui-menu`,
  the context menu's own surface, entering on the micro tier from
  `--radix-select-content-transform-origin` (the context menu's variable resolves to nothing there
  and the popup would grow from its middle). A native one cannot take the kit's trigger or chevron,
  and a phone draws it as a full-screen picker. Radix reserves `''` for "no selection", so an
  option's value is never `''` (`fontOptionsFor` leaves an empty current font out). It also drops
  `className` on `Select.Value`, so the label is styled through `[data-ui-select-value]`; a
  `[data-radix-select-value]` selector matches nothing, because Radix sets no such attribute.
  **Long values truncate in their control**: the Select, the Theme button and the build string
  (`.srow-value`) are one line, end in an ellipsis and carry the full text as `title`. The Theme
  button's name also rides in its `aria-label` (`Theme: <name>`), because a `<label for>` would
  otherwise be its whole accessible name and hide the current value.
  **Focus rings are `:focus-visible`, and nothing in the settings sheets resets an outline.**
  `.ui-input:focus` used to end in `outline: none` at the same specificity as the kit's ring and
  AFTER it, which erased the keyboard ring — renaming the selectors alone would not have helped. A
  stylesheet test now fails on any rule that can cancel the ring of `.ui-btn`, `.ui-input`,
  `.ui-collapsible-trigger` or `.ui-select-trigger`. An EDITABLE input (Scrollback, Font size,
  Import theme) is the exception: Chromium matches `:focus-visible` on a focused text field
  whatever focused it, because the caret needs an indicator, and fighting that takes hand-rolled
  input-modality tracking that weakens keyboard and AT focus for no gain. So the native ring shows
  on any focus there, with the border change as a second cue, while a mouse click on a section
  header, a Button, a Segmented item, the Theme button or the Select leaves no ring.
  Two rows open something instead of holding a control: Theme opens the in-place theme browser and
  the last App row, Edit config.json, opens the raw config editor (each has its own paragraph:
  "The theme chooser" below, and "`config.json` is edited from a Settings ROW" in the Monaco notes).
  `KeybindingsPanel` still uses the bare `.field`
  rules, so those stay. **Reload app** (`settings/app-reload.ts`) is a row, not a nicety: an installed
  PWA has no reload button, and `location.reload()` re-runs against the HTTP cache — a cached
  index.html still names the OLD hashed bundle, so a device can sit on a replaced build indefinitely
  and look exactly like "the fix didn't work". It clears Cache Storage, `update()`s the service
  worker, re-fetches the document with `cache: 'reload'` (credentialed — the app is cookie-gated and
  an anonymous revalidation would cache a 401), then reloads; every step is best-effort and it
  ALWAYS reloads. The row shows the server build the client last saw.
  **Both routes to it go through `guardedReload`** (App.tsx): the row in BOTH Settings hosts (dock
  and drawer), via the `onReloadApp` prop (a host that passes nothing falls back to the bare
  `reloadApp`), and the topbar app menu's Reload app. `reloadApp` reloads unconditionally, and an
  editor whose save was refused keeps its text only in the buffer; `dirtyRef` is the one place that
  knows, so a bare reload destroyed it without a word. It counts dirty tabs of `kind === 'editor'`
  and asks `window.confirm('<n> editor tabs have unsaved changes. Reload and discard them?')`
  ("tab has" for one), the counterpart of the close-tab discard confirm; with none dirty it reloads
  without asking. It
  returns `Promise<boolean>` — `true` as soon as the reload is CONFIRMED, not when it ends (`reloadApp`
  sweeps caches and re-fetches the document before it navigates, and the row has to show
  "Reloading…" through that wait), `false` on cancel. `ReloadRow` goes busy only on `true` and
  resets on `false` or a throw: setting it first left a cancelled reload on a disabled "Reloading…"
  with nothing reloading, and the only way out was remounting Settings.
  **Install as app** (`settings/pwa-install.ts`) sits directly under it and is a REPLAY, not an
  install: a page cannot install itself, so the only lever is Chromium's `beforeinstallprompt`, whose
  `prompt()` is honoured only inside a user gesture. The capture therefore runs from `main.tsx` —
  the event fires as soon as the page is judged installable, long before anyone opens Settings, so a
  listener registered on mount would find it already gone and the row permanently dead. Module-level
  store + subscription; `preventDefault()` moves the offer out of Chromium's mini-infobar (which
  cannot be recalled once dismissed) into the row. The event is SINGLE-USE, so a spent prompt drops
  the row back to disabled. iOS Safari never fires it at all — install there is Share → Add to Home
  Screen, which no API can trigger — so the unavailable state NAMES that route in the hint instead of
  showing a button that does nothing; already-installed is detected via `display-mode: standalone` /
  `navigator.standalone` and reads "Installed".
- **Theming** (`settings/themes.ts`): a picked color profile skins the WHOLE app, not just xterm.
  `deriveUiTokens(profile)` computes the seven `--t-*` UI tokens (base/mantle/surface/text/subtext/
  accent/accent-alt) — luminance-aware shade direction (light themes darken surface), canonical
  Catppuccin values pinned via per-profile `ui` overrides so the DEFAULT stays pixel-identical.
  Tab colors are the theme's OWN 16 ANSI slots: `applyThemeTokens` emits `--tab-c-ansi<N>` +
  a luminance-flipped `--tab-c-ansi<N>-ink` per slot straight from `profile.ansi16` (plus
  `--t-accent-ink`), `color-scheme` on `:root` — called PRE-PAINT in main.tsx (no flash) and on
  themeId change via an App useLayoutEffect (useTerminal only owns the xterm canvas theme now).
  `TAB_COLORS` (tab-meta.ts) is the 16 `ansi0`–`ansi15` slots; the 12 LEGACY names persisted in old
  tabs.json/groups.json resolve FOREVER via a static name→slot map in `resolveColorSlot` (no data
  rewrite; the server still assigns legacy names as group defaults). On the strip a tab colour is a
  7px dot and never marks the active pill (the pill's own fill and ring do); the picker is two
  labeled rows (normal/bright) of theme-resolved swatches; a group colour is the 1px frame of its
  cluster plus the always-filled chip (`--group-accent` / `--group-ink`), unchanged by which member
  is active. (`deriveAccents` still exists in shared for other consumers but the client no longer
  emits its 12 vars.)

**The theme chooser is a list inside the panel, not a `<select>` and not a popup**
(`settings/ThemeBrowser.tsx` + `theme-preview.ts`). The Theme row is a Button showing the
current theme's name (one line, ellipsis, the full name as `title`) and a chevron. Pressing it
swaps the panel's content for the `themes` SUB-VIEW, in place, inside whichever host holds
Settings: a `‹ Settings` back control (`settings-themes-back`), the title "Theme", then the
browser. It is the same shape as the drawer's `‹ New tab` sub-surface. It replaced a Radix Select
popup because the owner asked for a full list he can browse "sem sair daquela janela", and a
300px popup over the dock was the thing being replaced; `ThemePicker.tsx`, its test and
`theme-picker.css` are deleted (the sheet became `theme-browser.css`, `tp-*` became `tb-*`)
rather than kept beside it, so there is one list and not two.
**Picking applies and the list STAYS OPEN.** An entry calls the same `onChange({ themeId })`,
which re-skins the app and persists, and the browser does not close: a theme is judged by
trying two. `‹ Settings` returns to the form, whose row now shows the new name. The current
entry carries a `check` icon and `aria-current`. Entries are plain buttons, not a listbox — a
listbox promises arrow-key roving, and the popup that supplied it is gone.
**One back stack.** `SettingsFields` owns `subView` (`SettingsSubView`, `'themes' | null`) by
default and takes optional controlled `subView` / `onSubViewChange`. `SessionDrawer` lifts it,
so its own `‹ Settings` header pops the browser first and leaves Settings only on the second
press; with the state inside the form that header could only ever leave, and a phone lost the
whole panel to step back from one list. The drawer drops the sub-view in a layout effect
whenever the view is not Settings, so a view changed by a controlled host cannot bring a stale
one back. In the drawer the sub-view's own back control is hidden by CSS (the header is that
control, and two stacked read as the same button twice); in the dock it stays.
An option list of NAMES cannot tell you whether a theme's red survives its own background, so
every entry paints itself in ITS OWN palette — the theme's `bg` as the fill, its `fg` for the
title, its `cursor` as a block where a terminal would leave one (it does not blink: twenty
blinking cursors in a list is a strobe), and two lines of fake shell covering slots 2–6, 8 and
9–14. This is the one place in the app where colour does NOT come from the eight `--t-*`
tokens: every swatch colour is an inline style computed from the profile, because a swatch
obeying the current theme would show you the current theme sixteen times. The chrome around
them still uses the tokens, and `theme-browser.css` holds no colour literal.
Entries are grouped **Dark / Light** (`isLightBg`) and never reordered inside a group — the
registry's order keeps each family's variants together; the group label wears the section-title
size, weight and colour. `MAX_PREVIEW_CHARS` is **32, measured not estimated**: the first
version used an em-width guess of 40, overflowed the 300px popup by 36px, and replaced the last
two tokens with an ellipsis — which in a colour sample silently hides the slots it exists to
show. That measurement is of the popup, at its type size; the list is never wider than the
300px dock, so the cap still bounds a line, but it was not re-measured at the entry's current
`--fs-1` type. The highlight is a RING, not a fill, for the same reason: the swatch owns the
fill, and a background on the entry would be painted over by the theme's own. In a list the
ring has two jobs — a thin accent border under the pointer, and a doubled one (border plus a 1px
inset shadow) on the current entry — so "hovered" and "current" never read as the same state,
and a keyboard ring sits at a negative offset because the entry clips its own overflow.

**Theme export (palmux → everything else).** `server/theme-export.ts` resolves `settings.themeId` to
the full palette and regenerates, on boot AND on every theme change: `<configDir>/theme.sh`
(`PALMUX_C_*` hex + `PALMUX_I_*` 256-index, for p10k/delta), `theme.tmux` (`@palmux_*` +
`@tmux2k-*`), and the Claude Code theme at `~/.claude/themes/palmux.json` (`claude-theme.ts` —
literal hex, `base` from `pickBase`). `base` must NOT be a `-ansi` variant: those
paint no diff background at all and force the flat `ansi` syntax theme (visible in
`/theme` — the two "ANSI colors only" options preview a diff with no highlight).
The plain-vs-daltonized choice works around **anthropics/claude-code#69445**: the
file-diff renderer reads its colours from the BASE and discards custom overrides,
so the six diff tokens are written but ignored. The base is the only lever, and it
answers one question — are additions GREEN or BLUE? Daltonized bases are the blue
ones, so `blue > green` in delta's `plus-style` picks `*-daltonized`. Compare by
HUE, not colour distance: on raw RGB a pale green sits nearer the pale blue than
the saturated stock green. Every other token DOES honour the override. Palmux also
writes `<configDir>/theme.json` (resolved palette + delta diff colours + target
path); if `<configDir>/theme-hook.mjs` exists it is run with palmux's own node
(`theme-hook.ts`) and REPLACES the built-in Claude export — re-read from disk each
run, so the mapping can be changed without restarting the service (a restart costs
every live terminal). Hook output goes to `theme-hook.log`; a broken hook is
non-fatal. Writes are atomic and each target is isolated
so one failure can't cost the others. A palette CHANGE (rendered `theme.tmux` differs from disk —
stateless, no cache) also re-sources the user's `~/.tmux.conf` via `tmux-reload.ts`, but ONLY if
that conf references the export (`consumesThemeExport`) — wiring the `source-file` line in IS the
opt-in, no config key. Claude Code has no equivalent: it reads themes at startup / `/theme` only.

**Diff colours come from git-delta, not the palette** (`delta-colors.ts`). The six Claude diff keys
are read from the user's own delta config via `git config --global --get-regexp '^delta\.'` (git is
the parser — handles includes/precedence), so a diff reads the same in git, lazygit and Claude. The
dark/light feature names are DISCOVERED (`delta.<name>.dark|light = true`), not hardcoded; a delta
with no such split falls back to the bare `delta.*` keys; a style with no hex (`red`, `auto`) leaves
that key on the palette derivation. `styleBackground` takes the LAST hex — delta writes
`<fg> <attrs> <bg>`. Colours pass through VERBATIM — no blending, no re-derivation; palmux only
decides WHICH of delta's two palettes applies. That decision is the fragile part: `getProfile`
answers with the DEFAULT profile for an id it doesn't know and user/emulator themes only exist after
`registerDynamicThemes`, so a light `user:` theme exported before discovery would take delta's DARK
palette. `writeThemeExport` calls `ensureResolvable` (re-discovers on a miss) instead of trusting
call order.

**Theme import** (`theme-import.ts` + `importTheme`/`themeImported` protocol pair). Settings has a
paste field accepting: the INSTALL COMMAND the Gogh gallery's Copy button gives out
(`bash -c "$(wget -qO- https://git.io/vQgMr)" -- "Everforest Light Hard"`), a bare Gogh name
(`Tokyo Night` → the Gogh raw URL, encoded NOT slugged), a Gogh gallery link (`.../Gogh/#Name`), a
github.com blob URL (rewritten to raw), or any http(s) URL. A pasted command is NEVER executed and
nothing in it is fetched — `themeNameFromCommand` treats it purely as a carrier for the quoted name
(first one wins; a standalone ` -- ` is required so `-qO-`/`-sLo-` can't match), and the URL it
carries is deliberately ignored because git.io still resolves to the pre-rename `Mayccoll/Gogh`. The
newer per-theme form (`.../installs/<name>.sh`) has no `--`, so there the URL IS used.
The server fetches (256 KB cap, 15s), parses (JSON → Windows-Terminal scheme, else Gogh), and writes
to `<configDir>/themes/<slug>.{yml,json}` named after the PARSED theme, never the URL. `watchThemes`
then rebroadcasts `themes` and the client auto-selects the new id. Gogh ships YAML (`themes/*.yml`)
with `color_01`…`color_16` — **1-indexed**, so `color_01` is ansi0; `parseGoghTheme` (shared) reads
both that and the `installs/*.sh` form. `watchThemes` MKDIRs the themes dir before watching: it runs
once at boot, so a dir that first appears on an import would otherwise never be watched at all.

## Commit message prefixes

Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:` (and `ci:` for workflow
files — but do not touch CI without an explicit request).

## Known follow-ups

- No layout editor for the extra-keys bar yet (defaults + server-synced config only).
- Touch selection / mouse-encoding assumptions need real-device verification.
