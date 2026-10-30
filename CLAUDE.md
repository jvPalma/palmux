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
  `useSoftKeyboard`, `key-encoder`, `extra-keys`, `clipboard`, `ReviewBar`), `settings/`, `tips/`,
  `lib/ws.ts`, `scm/` (Source Control view, status store, API wrappers) and `review/` (the review pane,
  its model, file queue, colouring, anchoring and comments).

## Wire protocol

`packages/shared/src/protocol.ts` is authoritative. Text frames are a JSON discriminated union
(`{ type, ... }`); binary frames are raw PTY bytes (both directions).
Server→client: `ready` (carries `maxUploadBytes` + `webApps`), `settings`, `extraKeys`, `sessions`
(carries `ids`/`titles` **and** `tabs: TabMeta[]`), `snapshot`, `fonts`, `exit`, `scmComments`
(`{ repo, rev }`, see "Source Control"). Client→server:
`resize`, `settings`, `extraKeys`, `kill`, `createTab`, `updateTab`. File upload is out-of-band
over `POST /upload?session=<id>&filename=<name>` (not a WS frame), returning `{ path }`.
`settings`/`extraKeys` payloads are **opaque** to the server — it persists and rebroadcasts them; the
client owns the schema. No protobuf.

**Tabs.** A workspace slot is a tab with a `kind` (`terminal`/`web`/`dashboard`/`editor`/`markdown`/`review`); only
`terminal` tabs own a PTY. The registry (`server.ts`) generalizes the old session registry;
non-terminal tabs + every tab's name/color persist to `~/.config/palmux/tabs.json` (`tabs-store.ts`)
and survive restarts (terminals keep metadata only, respawn on attach). **Display order is
decoupled from id** (tab-reorder): the registry keeps an explicit `order` array (restored from
tabs.json's ARRAY ORDER — no schema field; new tabs append, even on a recycled low id), the
`sessions` broadcast's `tabs` array order is authoritative for every client, and the strip never
sorts. Client drag-along-the-strip → `reorderTabs { ids }` (server applies a forgiving permutation
— unknown ids dropped, omitted known ids appended in prior relative order — so no request can lose
or duplicate a tab), applied optimistically in `App.doReorder` + `reorderIds` (`tab-meta.ts`).
A strip drop reorders a tab the pane already holds; a tab from ANOTHER pane dropped on the strip
moves into that pane at its server-order place (`onDropFromOtherPane` → `moveTab`, no
`reorderTabs`; see "Editor groups"). **Closing the active tab** navigates to its LEFT strip neighbor (else right;
`neighborAfterClose` in `tab-meta.ts`, guarded by `seenTermIds` so fresh terminals are never
yanked (the flat path; panes use `pending`, see "Editor groups")); with nothing left the New-tab chooser renders as an ACTUAL page (`chooserPage` — no pane
mounts, so the dead id can't respawn), and the pane exit overlay is delayed 250ms so the Reconnect
UI never flashes mid-navigation (a pane that stays still shows it). **The `[+]` chooser opens in this
device's CONTAINER, never a floating box** — the dock's New-tab view on desktop, and on mobile a
sub-surface of the drawer's session list (a `‹ New tab` back header over `DashboardBody`, same shape
as the drawer's Settings). It was an anchored popover; on mobile it anchored to the `[+]` button,
which does not exist there (no strip), and fell back to a box floating over the screen corner. Both
hosts render `DashboardBody`, and so does a detached window's `Dialog` (a window with neither host,
see "Detached windows"), so there is one chooser. Attaching `/ws` to a
non-terminal tab is metadata-only: handshake + `sessions` broadcasts, but no `snapshot`, no binary,
and input/resize are ignored. `sessions.ids`/`titles` are retained (derived) for back-compat, and an
older server with no `tabs` is handled client-side by synthesizing terminal tabs from `ids`/`titles`.
Editor notes live at `~/.config/palmux/notes/<id>.md` via `GET`/`PUT /pane-file?tab=<id>`; HTML
artifacts are served same-origin from `~/.config/palmux/artifacts/` at `/artifacts/<name>`
(cookie-gated, traversal-guarded). Client panes (`client/src/panes/`) stay mounted while their tab
exists (iframe/editor state preserved); Monaco is a lazy chunk (`monaco-loader.ts`) so terminal-only
use downloads none of it.

**The URL is not the session. The app lives at `/`.** Which tab a window shows is BROWSER-LOCAL
state (`session/window-selection.ts`, `sessionStorage['palmux-window-tab']`, plus a device-wide
fallback in `localStorage['palmux-last-tab']`), the way VS Code remembers an open editor. The id is still identity everywhere it was — `/ws?session=<id>`, the
registry, `tabs.json`, `/pane-file?tab=` — it just stopped being an ADDRESS. What forced this: the
address bar can only name ONE thing, and palmux has two that both want it. A `web` pane's ← walks
the top-level joint history (rule 2 above), which `pushState` on every tab switch shared, so ←
undid a tab switch instead of a page. There is no arrangement of one stack that serves both, and
the framed page is the one with no alternative — a pane cannot reach its own history.
- **`sessionStorage` is the window's own selection, `localStorage` is only the fallback, and the
  distinction is the whole feature.** `sessionStorage` is per browsing CONTEXT; `localStorage` is per
  ORIGIN. Two palmux windows on the same host must hold different tabs — that is what having two
  windows means — and a shared key that every window READ would make the second window yank the
  first. Tabs, groups and order are server state; which WINDOW shows a tab is server state too; the
  SELECTION is local. A tab opened in one main window therefore appears in the other's strip and does
  not steal its view (a detached window's tabs are the exception: see "Detached windows").
  `sessionStorage` alone has one cost, and an installed PWA pays it on every launch:
  its window is a browsing context the OS ends whenever it likes (Android kills it freely), so a
  relaunch had no selection and opened the first tab. So the device's last selected tab is ALSO kept
  in `localStorage['palmux-last-tab']` (same `{id, kind}`), and `readSelection` returns the window's
  own value, falling back to it ONLY when the window has none — a fresh window or a relaunched PWA —
  so an open window is never moved by another. The price, taken on purpose: a second window opened
  later starts on whatever was selected last anywhere on this device.
  **Who WRITES the shared key matters as much as who reads it.** App writes it only when this window's
  resolved selection CHANGES in id or kind (`lastStoredRef`), never on a tab-list or title broadcast:
  the persist effect re-runs on every `sessions` message because `tabs` is a new array, and a window
  that merely heard a rename would overwrite the tab another window just chose. The comparison is
  cleared while the selection resolves to no tab (closed, or created and not yet broadcast, which then
  writes once it appears) and while the window is on the New-tab page, so an id that is recycled as
  another kind (close the last terminal `0`, create an editor that reuses it) is stored with its new
  kind. A reload that comes back on the window's OWN remembered tab is a restore, not a selection:
  the first-broadcast resolve seeds `lastStoredRef` with it, because the effect otherwise read the
  reload as a change and copied this window's older tab over a newer choice another window had made
  since. The seed is skipped while the device holds no usable value, so the boot choice initialises
  it; `?new=1`, a legacy `/<id>` and a remembered tab that is gone (the window lands elsewhere) all
  still write. A detached window writes neither key: it keeps its selection under
  `palmux-window-tab:<wid>` and never reads the device-wide one (see "Detached windows"). `?new=1` and
  a legacy `/<id>` still outrank any stored value, unless another window holds that tab (the legacy id
  then boots as a plain `/` would).
- **The stored value carries the `kind`, not just the id.** Ids are recycled lowest-free, so a
  remembered `2` can come back as a different kind of tab entirely; a kind mismatch is treated as
  gone, for the window's own value and the device-wide one alike. Boot then falls back to the FIRST
  tab in strip order — not the lowest id, which tab-reorder decoupled long ago — and to the chooser
  page when there are none.
- **The neighbour rule stays in `workspaceController`'s `sessionsBroadcast`**, not in the resolver.
  "The tab I was viewing was closed from another window, move me to its neighbour" needs the
  PREVIOUS strip order, and that broadcast is the only place holding it; at boot there is no
  "before" for a dead id to be a neighbour of. Two owners for one rule would cost more than the
  duplication it saves. With editor groups on (the desktop) the rule moved with the selection:
  `reconcile` in `session/pane-grid.ts` owns it per pane, against the previous order the layout
  hook keeps, and the controller keeps only "the last tab went, show the New-tab page" there and
  the flat rule for the mobile layer (see "Editor groups").
- **Mid-session, with editor groups, a kind change is a pane event.** The layout holds `{id, kind}`
  for every tab, so a selected tab whose id comes back from the server as ANOTHER kind (editor `3`
  is closed and another window creates terminal `3` before this window hears the close) is a dead
  tab and a new one: the old entry leaves its pane, the pane shows its neighbour by the usual rule,
  and the new tab joins the focused pane without becoming active. Nothing attaches a terminal to an
  id the window held as an editor. The flat path (the mobile layer) has no layout to
  hold the kind and keeps the old behaviour: `sessionId` stays and the pane shows whatever kind
  the id now is.
- **Every boot address normalises to `/` except a detached window's own** (`session/session-url.ts`
  `readBootIntent`, applied once at boot with `replaceState` so no entry is added):
  `/window/<wid>` is a detached window and is the ONLY one that keeps its address, because a detached
  window must survive a hard reload knowing which window it is (its `?tab=` is consumed once and
  removed); `/popout/<id>` and `/<id>?popout=1` are the retired pop-out and open a detached window
  under a fresh id that claims tab `<id>` itself; `/<id>` is the legacy path, still honoured: it names
  its tab but waits for the first `sessions` broadcast, like `?new=1` and a plain `/`, because another
  window may hold that tab, and one it holds boots as a plain `/` would; `?new=1` is an INTENT,
  consumed exactly once (a reload must not create a second terminal); `/` is the app. `GET /new` 302s
  to `/?new=1`. The `?new=1` consume is DEFERRED to the first `sessions` broadcast and seeds `tabsRef` from it — `nextFreeId` reads the tab list, so
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

**Terminal panes (desktop split) + de-singletonized terminal.** The terminal is NOT a singleton:
each on-screen terminal is a `terminal/TerminalPane.tsx` owning its own xterm + data
`/ws?session=<id>` socket + replay-suppression + DA/DSR report gate (per-document `hasFocus()`,
unchanged — two split terminals are different PTYs, so pane focus plays no part) + fit + exit
overlay (per-pane reconnect) + `useFileUpload` + gestures. `App.tsx` owns a persistent **control
socket** (`/ws?control=1`, a tab-unbound metadata attach) carrying ALL app state
(`sessions`/`settings`/`fonts`/`tabCreated`) and all control sends; pane data sockets ignore those
broadcasts. Shared input surfaces (soft keyboard, extra-keys, upload picker, the hoisted
Ctrl+Shift+C/V combo) route to the focused pane via `session/SplitFocusContext.ts` (a ref registry
of `PaneApi`s keyed by pane id, with `forEachApi` for the font and theme refresh across every pane;
no pane is focused until App sets one). Which panes exist, and what each holds, is "Editor groups"
(below): a tree of panes on the desktop and in a detached window, one virtual pane while the mobile
layer is active. **One active client per terminal (last attach wins)**:
`pty.ts` keeps a single `attachment` (client token + `clientKey` +
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
now tracks attach/detach rather than first-resize. **Open in new window** MOVES the tab into a
detached window instead of mirroring it, so a terminal is never attached from two windows and this
takeover is not the path it takes (see "Detached windows"). **Terminal input hygiene**: `terminal/mouse-frames.ts` gates SGR mouse reports in
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

**Editor groups (desktop-only).** The content area is a tree of panes, VS Code's editor groups: a
branch splits its space into a `row` or a `column` of children, a leaf is a pane with its own tab
strip, and every tab is in exactly one pane. `session/pane-grid.ts` is the model, pure (no React,
no DOM): `PaneLayout { v: 3, root, focused, nextId }`, `PaneLeaf { id, tabs: {id, kind}[], active,
size }`, `PaneBranch { orientation, children, size }`, where `size` is a node's fraction of its
parent's main axis and siblings sum to 1. Every operation (`splitPane`, `removeTab`, `removeLeaf`,
`moveTab`, `activate`, `focusLeaf`, `addTab`, `resizeSash`, `layoutRects`, `reconcile`,
`parseLayout`, `singleLeaf`) returns a new layout, and the SAME object when nothing changed,
because a title broadcast arrives every 300 ms and must not re-render or re-save anything.
**Two functions are ported from VS Code and carry its MIT notice in a head comment**: the
side → sibling-or-wrap decision of `grid.ts getRelativeLocation` (in `splitPane`: a drop on a side
whose orientation the parent already has inserts a sibling and halves the TARGET's size; any other
side wraps the target in a new branch) and the sibling collapse of `gridview.ts removeView` (in
`removeLeaf`: the freed size goes to the siblings in proportion, a branch left with one child is
replaced by it, a same-orientation child is spliced into the grandparent). Nothing else is ported
(no sizing modes, snapping, hidden views or layout priority), because VS Code's grid REPARENTS
views on every split and merge and pulls ~12k lines of `vs/base`, while its tree algebra is small
and pure. The libraries fail the same test or worse: dockview and FlexLayout make a panel a TAB
(one xterm per tab, and Chromium allows ~16 WebGL contexts) and own the chrome `SessionTabs`
already is; allotment and rc-dock reparent; react-mosaic's drag stack fights the native strip drag.
Leaf ids are `p` + a base-36 counter kept in the layout (`nextId`) and never a tab id: the earlier
split keyed itself by its first tab, which a swap of sides renamed.
**Rendering is FLAT, from percent rects, and nothing is ever reparented.** `session/GroupsView.tsx`
draws every pane's strip box, its terminal, the ONE `PaneHost`, a drop overlay per pane and a sash
per boundary as absolutely positioned DIRECT children of one `.groups-view` (`position: absolute;
inset: 0` in the stylesheet, so it is the positioned ancestor of all of them), at the rects
`layoutRects` computes. The tree is never rendered as nested elements: nesting would move a
`PaneHost` child to a new parent on every split or merge, and an iframe or a Monaco editor reloads
when its DOM parent changes (`GroupsView.test.tsx` holds that a web node keeps its identity across
a split beside it). A pane's body is its rect minus its strip, and the strip height is a TOKEN,
`--group-strip-h` on `.content-area` (`calc(var(--ctl-h) + 2 * (var(--cluster-pad) + 1px) + 1px)`:
the strip's own min-height plus the box's 1px bottom border, because every box is border-box and a
token that left the border out squeezed the strip by 1px), so the rect maths stays percentages only
and the offset is a CSS `calc` (`rectCss(rect, bodyOffset)`, which `PaneHost` takes as
`bodyOffset`). `--cluster-pad` is declared on `:root` as well as on the strip, because a custom
property resolves where it is USED and the content area is not inside a strip.
`groups-css.test.ts` and `tab-strip-css.test.ts` hold these numbers, since happy-dom has no layout.
With the mobile layer the token is `0px` (`.app.mobile .content-area`, and inline on the root) and no
strip is drawn; a detached window draws strips as the main window does and has no rule of its own. One pane renders the same elements as ten: there is
no single-pane path. While the New-tab PAGE is up only the focused pane's strip renders, with no
body, so nothing mounts and a dead id cannot respawn.
**One order, the server's.** A pane's strip is `tabs.filter(in this pane)` in broadcast order;
there is no per-pane order, so a reorder, a colour group and "Close tabs to the right" mean what
they always meant. A strip drop of a tab already in the pane goes through
`doReorder(leafTabIds, …)`: the index is resolved against THAT pane's visible entries and mapped to
the full order (past the pane's last entry the tab lands right after the pane's last tab, not at
the end of a list another pane may occupy). A strip drop of a tab from ANOTHER pane is a
membership move only (`moveTab`, no `reorderTabs`): the tab shows among the target's tabs at its
server-order place, and the strip lights whole (`.session-tabs.drop-into`) instead of drawing an
insertion bar that would lie. A positional cross-pane drop is a follow-up. "Close other tabs" and
"Close tabs to the right" stay computed from the FULL order across every pane of THIS window (owner, 2026-10-27), and never
reach a tab another window shows (see "Detached windows").
Colour groups are per pane in how they DRAW: each strip runs `buildStrip` over its own subset, so a
group spanning two panes draws a chip and a frame in each; membership and contiguity stay server
rules. The collapse guard reads every pane (`useTabGroups` takes `activeIds`, `stripOf` and
`switchTo`): collapsing a group is refused, with the existing toast, when ANY pane whose active tab
is a member has no tab outside the group, and otherwise each such pane switches to its nearest
outside tab first; auto-expand keys on every pane's active tab.
**The layout is the source of truth for the selection while panes are on.** `sessionId` is a
READING of the focused pane's active tab (`focusedActive`, in an App effect that writes
`sessionIdRef` first and skips `null`, so the New-tab page keeps its dead id as the persist effect
expects). Every navigation path (`showTab`, the controller's `navigate`, close-navigation,
`openFileTab`, `openReview`) already went through `setSessionId`; with panes on, that one
function is the choke point and calls the hook's `show({ id, kind, known })`: a tab some pane holds
is activated THERE and that pane focused, otherwise it joins the focused pane as active. `kind` and
`known` come from `tabsRef` (ahead of the render), and `known` is false only for a terminal this
window just picked an id for. A `show` made before the layout exists (`?new=1`, whose terminal is
created inside the first `sessions` handler, and a legacy `/<id>`, shown there too once both lists
exist, unless another window holds that tab) is parked and applied as the
selection on the first ready render. `window-selection.ts` still answers the BOOT question:
`bootSelection` is passed only when the stored value resolves to a live tab of its kind
(`resolveStoredSelection`, no `tabs[0]` guess) and is `null` otherwise, so a restored layout's own
focus stands (the guess would override a valid one). Its private `isKind` omitted `review`, so a
window on a review always reloaded onto the first tab; it uses the shared `isTabKind` now.
**`pending` keeps a terminal this window created alive until the server lists it.** A terminal
exists on the server only once its pane attaches, and the client picks its id (`nextFreeId`,
excluding every id in the list AND in the layout). The layout holds that id in `pending`, so a
broadcast that lacks it (the title debounce, an empty list that landed before the attach) does not
drop the pane that is about to create it; an id leaves `pending` the first time a broadcast lists
it. At boot `pending` is empty, so a saved terminal that is gone is dropped and never attached.
**The `sessions` handler deletes every listed id from `pending` itself, synchronously**, beside the
`tabsRef` writes: the hook forgets ids as it renders a list, but two frames handled before one
render show it only the SECOND, so a terminal that frame one listed and frame two omitted (killed
in between) stayed pending for ever and its pane stayed mounted, a shell the server no longer had.
The one id it keeps is an id the layout holds as ANOTHER kind than the list states (a guessed
terminal that is an editor): reconcile adopts the listed kind only while the id is pending, and the
hook forgets it after the render that adopted it. **Accepted limit:** two frames batched into one
render, where the first lists a pending id as another kind (so it is kept pending for adoption)
and the second omits it, show the hook only the second, so the guessed terminal ref stays and the
pane attaches and spawns a shell for that id. It needs a cross-window id collision and a kill of
that tab inside one batch.
**Reconcile runs on every broadcast, during render, and is idempotent.** `reconcile(layout, tabs,
prevOrder, pending)` drops every tab that is gone or whose kind changed (ids are recycled; a
pending id is kept and takes the kind the list states when it first appears), re-picks a pane's
active tab by the close rule against the PREVIOUS order, removes an emptied pane (never the last),
adds every tab no pane holds to the FOCUSED pane without making it active, and gives a pane that
shows none of its tabs its first in server order. **A BLANK window stays blank**: one pane that is
empty, or already showed nothing, keeps `active: null` on this and every later broadcast, so tabs
another window creates appear in its strip and do not become its selection (a window on the
New-tab page is not yanked off it). It is state derived DURING render and not an effect, because
an effect commits one frame with the old layout, and a pane for a dead terminal attaches in that
frame. `commit` and `setLive` reconcile whatever layout they are handed against the list the held
layout agrees with, so a layout computed from a stale capture can never bring back a tab a
broadcast removed. Reconcile never creates a tab and sends nothing. It owns per-pane
close-navigation: closing a pane's active tab shows its LEFT neighbour in THAT pane's strip, else
its right, and no other pane moves; an emptied pane goes and focus moves only when the pane that
went was the focused one.
**Persistence is per WINDOW, and there is no device copy on purpose.** The layout is
`sessionStorage['palmux-layout']` (`PaneLayout` as JSON, written on every committed change and, for
a sash drag, on release; a storage exception is swallowed; `parseLayout` discards anything that
fails its shape checks, such as a tab in two panes, a stale `nextId` or an `active` outside its
pane). A fresh window or a relaunched PWA opens ONE pane holding every tab, on the selection
`window-selection.ts` picks. A device-wide copy would let a new window inherit N panes, and N
terminals attached at once would EVICT the same terminals from every other open window (last
attach wins). The price is that a relaunched PWA loses its panes: accepted for v1, and a device
copy is the follow-up if it is reported. `palmux-splits` and `palmux-split` are never read again
and never deleted, so a rollback to the old client still finds them. A detached window keeps its own copy under `palmux-layout:<wid>` (`useEditorGroups`' `storageKey`:
`window.open` may have copied the opener's `sessionStorage`, so reading the main key would boot it from
the main window's panes). The mobile
layer neither reads nor writes the key: `useEditorGroups(false)` returns one virtual pane holding
every tab with `active = sessionId`, whose id is the held layout's focused pane (else `p0`) so its
terminal keeps its key when the layer flips, and an `active` that names no tab is appended as a
terminal, which is the spawn-on-attach fallback a phone creating a terminal relies on. Turning the
mobile layer off restores the saved layout and shows the window's selection in it; if the saved
focused pane does not hold that tab it moves panes like any other move, and `ws.ts` `abandon()` is
what keeps the replaced socket's late `detached` off the pane.
**Boot gating.** `layout` is `null` until the first `sessions` broadcast has landed and been
reconciled (`ready`), on every path, and `GroupsView` renders nothing for `null`: no pane mounts
before then, so a saved pane for a terminal that closed since is dropped during reconcile and never
attaches (an attach to an unknown id spawns a shell).
**Drop regions are VS Code's** (`session/GroupDropOverlay.tsx`, one per pane while a tab drag is
on): horizontal thirds first (the left third, the right third), then vertical thirds (top,
bottom), and the middle cell is the centre. An edge drop creates a pane on that side of the target
(`splitPane`) and the new pane takes focus; a centre drop or a strip drop moves the tab into the
pane (`moveTab`). The overlay mounts only while `dragTabId` is set, which only a tab pill
(`TAB_DND_TYPE`) sets, or while a tab from another window is over this one (`externalDrag`, see
"Detached windows"), so an OS file drag (the upload drop), a group chip and the drawer's rows
never show it. Its `z-index` is 40, above `.pane-host` (20) and `.newtab-page` (25), so a drag over
an iframe still reaches it. The preview is `.group-drop-preview`, the matching half of the pane or
the whole pane for the centre, the accent at 20% over a 2px inset ring, with no transition because
it floats over the terminal grid. A drop that would change nothing shows no preview and is not
cancelled: a pane's only tab on its own pane's edge or centre, since a pane cannot mirror itself
(the old gesture spawned a fresh terminal, which is not what dropping a tab means anywhere else).
**`dragTabId` has a fallback at the window.** A pill that unmounts mid-drag (a broadcast took its
tab) fires no `dragend`, so a `dragend` and a `drop` listener on `window` (capture, so a handler
that stops propagation cannot hide it) clear it. The clear WAITS one timer tick: the overlay's own
`drop` handler reads the id, and a discrete event's update renders before the event reaches its
target, so clearing at once would unmount the overlay under it and lose the drop (ASSUMED from
React's scheduling, not measured in a browser; happy-dom cannot reproduce it).
**One tab, one pane.** The same tab in two panes is a non-goal: two xterms on one PTY are two
attachments, and the last attach wins, so the other pane would evict itself ("Opened somewhere
else."). Opening a tab that is already open (a file or review from the dock) selects it in ITS
pane and focuses that pane (a tab another window holds is the exception: see "Detached windows"). A new tab opens in the FOCUSED pane, or in a strip's own pane from its
`+`, which focuses its pane first so every creation path targets "the focused pane" and none needs
to correlate a request with its answer. A server-created kind appears either in a broadcast first
(reconcile adds it to the focused pane, inactive) or as the `tabCreated` answer first (its
`navigate` shows it wherever it is); if the focus moves between the request and the answer it
opens in the pane focused when it arrives, as VS Code does. Split right and Split down (the tab
menu, `Ctrl+Shift+D` / `Ctrl+Shift+E`, which had no handler before this) move the tab into a new
pane; on a pane's ONLY tab they open a new terminal there instead (`splitLone`: an id from
`nextFreeId`, held in `pending`), an explicit request for a second terminal, which dropping that
tab on its own pane is not. `toggleSplitOrientation` is deleted, and a persisted binding for it is ignored (`loadBindings`
iterates `ACTIONS`).
**Sashes** (`session/Sash.tsx`): one between every two adjacent children of a branch, an 8px hit
area (`--sp-2`) centred on the boundary around a 2px line, with pointer capture and an rAF
throttle. Only the two siblings either side move (the old divider's rule, not VS Code's multi-view
priority resize), each clamped to 15% of its BRANCH. The drag reports a CUMULATIVE delta as a
fraction of the branch's main axis and App applies it to the layout captured when the drag
started (`setLive(resizeSash(start, …))`), never to the live one, or the deltas compound per
frame. Rects update every frame; the terminals' resize and the save happen on RELEASE only
(`resizePaused` on every `TerminalPane` while dragging, then one refit a frame later, so each
shell gets one SIGWINCH). While it is dragged `.content-area` takes `data-sash-drag="true"` and
iframes lose pointer events (VS Code's `sash.ts` does the same), or the drag is lost the moment
the pointer crosses a web pane. A broadcast that reshapes the layout mid-drag ends the drag's
capture (later frames are ignored and the release commits what the broadcast left), and layout
commands such as `menuSplit` are refused while a drag is on, because the next frame would undo
them. **Accepted limit:** a sash-drag frame adopted after ANOTHER window closed a pane's active tab
re-picks that pane's first surviving tab, not its left neighbour (rare: `adopt` has no previous
order).
**Focus.** Exactly one pane is focused. Clicking inside its body or on its strip (pointerdown,
capture, primary button) focuses it, and its active tab is the window's selection. The mark is the
focused strip's 1px bottom border turning `--t-accent` (`.group-strip.group-strip-focused`, a
selector that names the box because the edge is declared on `.group-strip`) and NOTHING in the
terminal: there is no ring on a pane's body, because nothing inside the grid animates or repaints
for focus. A strip box sets no `z-index`: its context menu is `position: fixed` inside it and has
to rise into the outer stacking context.

**Detached windows (desktop-only).** "Open in new window" MOVES a tab into a window of its own, VS
Code's auxiliary window: the editor-groups window of the main one, minus the dock. It replaced a
pop-out that showed one tab with no strip and left the tab in the main window, where its terminal froze
on "Opened somewhere else." (owner, 2026-10-27). The design is `openspec/changes/detached-windows/`
(D1–D15); code is `session/session-url.ts`, `session/window-selection.ts`, `session/useEditorGroups.ts`,
`session/workspaceController.ts`, `App.tsx`, `shared/protocol.ts` and `server.ts`.
- **Identity is minted by the opener and lives in the address (D1).** `newWindowId()` is `w` plus 10
  base-36 characters from `crypto.getRandomValues`, checked on both sides by the shared `isWindowId`
  (`/^w[0-9a-z]{6,16}$/`). The window lives at `/window/<wid>` and keeps it across reloads; `?tab=<id>`
  names the tab it was opened for and is consumed at boot. A malformed `/window/<x>` is a main window at
  `/`. Rejected: an id in `sessionStorage` (`window.open` copies the opener's, a browser behaviour not
  measured here, so two windows would share it) and the window NAME (not reliably readable across a
  reload, and a dedupe key today). The server serves the SPA shell there through its not-found handler,
  and Vite's history fallback covers dev; a dev-proxy entry for `/window` would serve the built bundle
  and kill HMR.
- **Ownership is a server field, in memory (D2).** `TabMeta.window` is the detached window holding the
  tab, absent for the main one; `parseTabMeta` keeps it only when `isWindowId`. `TabRecord.window` is
  emitted by `tabs()` and is NOT written to `tabs.json` (`persist` whitelists fields, so it cannot leak):
  a restart releases every tab and the reclaim below takes them back, which is cheaper than a second
  restore path for an event that already costs every terminal. It dies with the record. The owner chose
  "every device" over a per-device rule: every main window on every device shows only tabs with no
  `window`, so a phone's drawer stops listing a tab a desktop window holds.
- **Two messages and two optional fields (D3).** `moveToWindow { ids, window: string | null }` sets or
  clears `window` on each known id (unknown ids ignored, an invalid `window` rejected), broadcasts
  `sessions` once (the broadcast is the answer, there is no ack) and touches neither order nor groups.
  `windowClosing {}` is sent from `pagehide` and marks that socket so its close starts the short grace.
  `createTab.window` and `&window=<wid>` on a data-socket URL make a tab born in its window:
  `registry.get(id, { command, window })` sets `window` ONLY in the branch that creates the record for a
  NEW id, before `listChanged()`, so no broadcast lists the tab without it and a new terminal never
  flashes in main. A live record, and a dormant restored one that respawns, are never claimed by an
  attach (narrower than the tmux target, which does apply to a dormant respawn): an existing tab changes
  owner only by `moveToWindow`. `ready` carries `detachedWindows: true`.
- **Lease and grace per window id (D4).** The server keeps `windowSockets: Map<wid, Set<WebSocket>>`;
  only a CONTROL socket (`/ws?control=1&window=<wid>`) is the lease, a pane's data socket only claims.
  When an id holds tabs and has no control socket, an `unref()`ed timer starts: 3 s
  (`WINDOW_CLOSE_GRACE_MS`) if the closing socket had sent `windowClosing`, else 15 s
  (`WINDOW_GRACE_MS`). It also starts on a `moveToWindow`, a `createTab` or a spawn-claim for an id
  with no socket yet (a popup still loading), so a window that never loads gives its tab back. A control
  socket for the id cancels it; when it fires, the id's tabs are released and broadcast once, and
  `palmux: window <wid> released <n> tabs (grace|closing)` is logged (neither happens when nothing was
  left). Any message but `ping` or another `windowClosing` after `windowClosing` un-marks the socket (a cancelled unload), so a later real
  blip gets the full 15 s. Timers are not cleared at shutdown: a socket's close fires after
  `terminate()` and would arm one anyway. Rejected: releasing on close at once (a reload would bounce
  every tab through the main window) and a heartbeat message (the socket's ping/pong exists).
- **Each window reads one filtered list; the full list stays for ids and order (D5).** App keeps
  `tabs`/`tabsRef` (the full list) and derives `visibleTabs = visibleOf(tabs, optimisticWindow)` with a
  `visibleTabsRef` written beside every `tabsRef` write, always as `visibleOf(tabsRef.current,
  optimisticRef.current)`; it is `tabs` itself when nothing is hidden, so a main window with no
  detached window renders as before. VISIBLE: `useEditorGroups`' `tabs`, every strip's `allTabs` (bulk
  close never reaches another window), `GroupsView`'s `tabs` (`PaneHost` mounts a hidden pane for every
  non-terminal tab in the list), the controller's close-navigation and empty-list rule,
  `selectionFor`, `activeTab`, `leaveReview` and `useTabGroups` (collapse, Close all, Remove from group).
  FULL: `freshTerminalId`/`nextFreeId` (a window never takes an id another window holds), `tabOrder`,
  every reorder and drop (`doReorder`, `moveGroup`, the drawer's two, `applyDrop`) and
  `useTabGroups`' `fullTabsRef`, which only `addToGroup` reads to build `groupUpdate.order`. Orders go
  out FULL with the hidden tabs in place, because `forgivingOrder` appends any id a request omits at
  the END: a filtered order would push another window's tabs to the tail on every reorder. A strip
  reorder already mapped a pane's indices onto the full order, and the window filter is one more subset
  under that mapping. The `pending` and `seenTermIds` loops in the `sessions` handler still iterate the
  FULL list: if two windows pick the same lowest-free id, it is listed under the other window, reconcile
  drops it here, and this window never stays attached to another window's shell.
- **An optimistic move holds until the server agrees (D7).** A `sessions` frame already in flight when
  `moveToWindow` goes out names the old owner and would flash the tab back. `optimisticWindow` (id →
  owner) is React state, so its expiry re-renders, mirrored by `optimisticRef`, with one 2 s timer per
  entry (`OPTIMISTIC_MOVE_MS`); every writer (`moveTabsToWindow`, the dragend path, the handler's
  confirmation, the expiry) writes the ref and then the state. The `sessions` handler removes an entry
  synchronously once a broadcast shows the tab with that owner, and the timer removes it otherwise (the
  server refused or never answered, so the broadcast wins). Nothing removes one during render.
- **Opening a window (D7).** `doPopout(id)` refuses first: a terminal this window picked an id for and
  no broadcast lists yet is "Wait for the terminal to start", and a dirty editor asks
  `window.confirm('<n> editor tab(s) have unsaved changes. Move and discard them?')`, because it
  unmounts here and the new window loads the file from disk. Then `openDetached(id)` calls
  `window.open('/window/<wid>?tab=<id>', 'palmux-<wid>', 'popup,width=1000,height=640')`; a blocked popup
  toasts and moves nothing; only then does `moveToWindow` go out, with the hold, so the source pane
  unmounts in the same render and BEFORE the new window attaches ("Opened somewhere else." cannot
  appear); an unsent move (the control socket is down) closes the window it just opened. A move INTO this window (a reclaim, a drop here) never confirms, and a moved id leaves
  `dirtyTabs` so Reload stops counting it. A `web` pane loses its in-frame history on a move: accepted.
- **Opening a review or a file another window holds (D14).** A review `createTab` is idempotent on the
  server, so asking for a review another window holds would answer an id this window never shows. The
  client checks the FULL list first and MOVES the review here and shows it (it holds no unsaved state;
  VS Code would focus it in the other window, and this is the simpler rule, one tab per window). An
  editor FILE another window holds is NOT moved, because this window cannot see that buffer and D7's
  confirm would be blind: it toasts "<name> is open in another window" and sends nothing.
- **One guard against showing a hidden tab (D15).** `showTab`, `setSessionId` (the choke point) and the
  controller's `selectTab`/`tabCreated` dispatch IGNORE an id that is in `tabsRef` but not in
  `visibleTabsRef` (`heldElsewhere`). Without it any navigation to another window's tab resolves its
  kind from the full list, `show` puts it in a pane, a `TerminalPane` attaches and the other window shows
  "Opened somewhere else." It closes a `tabCreated` that answers an idempotent review create racing
  D14, `leaveReview` and any later `selectTab`; the dispatch check also keeps a refused navigation from
  clearing the New-tab page. `moveTabsToWindow` writes the refs BEFORE it navigates, so its own
  navigation passes.
- **Boot and reclaim (D13, D6).** `awaitingResolve` starts true and `sessionId` starts `''`, as for a
  plain `/`. The first `sessions` handler writes `tabsRef` and `visibleTabsRef`, runs the reclaim, then
  resolves from `visibleTabsRef` (`?tab=` when it resolves, else `readSelection(myWindow)`, else
  `resolveSelection`, with NO fallback to `palmux-last-tab`, which is what a MAIN window chose) and
  shows it; a saved layout with no remembered tab keeps the layout's own focus. The persist effect
  writes `writeSelection(sel, myWindow)` and never `writeLastTab`. **The reclaim** runs on the first
  `sessions` after EVERY control-socket open (`awaitingReclaimRef`, set in `onOpen`): the ids in the
  held or saved layout (`heldTabIds()`), plus the boot `?tab=` on the FIRST open only (`firstOpenRef`,
  so a tab later sent to main is never pulled back by a reconnect), that the list shows with no
  `window`, go out in one `moveToWindow` for this window and into `reclaiming`. That is React state and
  not a ref, so clearing it re-runs the self-close check; it works like `pending`, and an id leaves on
  the next broadcast whether granted or not. An id another window holds is not claimed and drops out
  through reconcile. It covers a reload slower than the grace, a server restart, and a legacy
  `/popout/<id>` boot, where nobody else knows the id the window minted for itself.
- **Chrome (D9, D11).** The root is `app detached`; `mobileActive = !detached && …` (the mobile layer
  never applies) and `groupsEnabled = !mobileActive`. Not rendered: `DockPanel`, `.wco-titlebar`, the
  drawer, `TabSheet`, the review bar and the extra-keys bar. Strips, sashes and drop overlays are the
  main window's, so `--group-strip-h` keeps its value. Layout and selection keys are per window,
  `layoutKey(wid)` (`palmux-layout:<wid>`) and `palmux-window-tab:<wid>`, and no main key is read or
  written; with no saved layout it opens one pane holding every tab it holds, `?tab=` active. **`+` opens
  a kit `Dialog` (`newtab-dialog`) holding `DashboardBody`**: the dock hosts the chooser in the main
  window and this one has none, and the New-tab PAGE cannot host it because it unmounts every pane the
  window still shows; `createTab` closes the dialog and the page stays the empty-window fallback.
  **Shortcuts:** `openDockView` returns at once (no dock view is ever written from here),
  `actionHandlers` leaves out `settings` and `openSourceControl` and the palette follows, `tips` and
  `dictationHistory` are modals (the toast's "Open history" included), and Ctrl+W closes the active tab,
  never the window. The tab menu is the command surface (owner, 2026-10-27): LAYOUT gains **Move to main
  window** (`menu-move-main`, detached only, before Open in new window, which stays).
- **Self-close (D10).** An effect on `visibleTabs`, `reclaiming` and `capDetached` reads the contents of `pendingTabs`
  (the hook's mutable `Set`, in the dependency list only for the lint: its identity never changes), because every pending id leaves on a broadcast that also
  changes `visibleTabs`. Once the window has held a tab (`seenOwnRef`), the server supports detached
  windows and the list is empty with nothing pending or reclaiming, it sends `windowClosing` and calls
  `window.close()`; one tick later, if `window.closed` is still false (the address was opened by hand),
  it shows the New-tab page. The attempt spends `seenOwnRef`, so the empty lists that follow do not ask
  the browser again. The controller returns no effect for a `sessionsBroadcast` in a detached window:
  close-navigation is reconcile's and an empty list is self-close's. `pagehide` sends `windowClosing`; a
  reload sends it too and comes back inside the 3 s grace, and a slower one is the reclaim's.
- **Cross-window drag uses the drag data that already exists (D8).** `dragstart` sets `TAB_DND_TYPE`
  (the bare id) and `effectAllowed = 'move'`; a same-origin window sees `dataTransfer.types` on
  `dragover` and reads the id on drop. A capture `dragover` listener on `window` that sees the type with
  no local drag live (`dragTabIdRef` null) sets `externalDrag` and restarts a 1000 ms timer
  (`EXTERNAL_DRAG_IDLE_MS`, measured: see "Accepted risks and limits"). `GroupsView` mounts overlays when `dragTabId !== null || externalDrag`, with
  every region live on every pane (the tab is in none, so a drop is never a no-op), and the strip
  lights `drop-into` with no insertion bar (a foreign tab keeps its server-order place). On drop,
  `getData` names the id: in `visibleTabsRef` it is the ordinary local drop; in the full list only,
  `moveTabsToWindow([id], myWindow)` and, only when that returns true, `place({ id, leafId, where })`
  parks a placement in the hook, applied in the render where the tab first appears in the layout
  (reconcile adds it, inactive, to the focused pane; then `moveTab` + `activate` for the centre or a
  strip, `splitPane` for an edge; a gone `leafId` falls back to the focused pane); in neither list it is
  ignored. A window on the New-tab page renders ONE centre-only overlay over `.content-area`.
  `externalDrag` clears on drop (one tick later, as `dragTabId`), on a `dragleave` with a null
  `relatedTarget` and the pointer outside the viewport, and on the timer. **The source** hears
  `dragend` in the same window-capture listener: `dropEffect === 'move'`, no local drop (`localDropRef`,
  set by the capture `drop` listener) and not a dirty editor hold the tab as moved to `OTHER_WINDOW`
  (`'?'`: it cannot name the receiver), so its pane unmounts before the receiver attaches, and the 2 s
  expiry restores it if the server never moved it. The receiving drop handlers `preventDefault` on a
  taken drop, or the drag ends as `none` and the source would read a tab handed over as one that never
  left. **That hold is a head start, not the guarantee, because `dragend` cannot be relied on**
  (measured 2026-10-28, Chrome 156 on Linux X11, a native XTEST pointer, two real windows, every drop
  taken with its `drop` default-prevented and its last `dragover` at `move`): the source read `none`
  in 27 of 49 main → detached drops and in 10 of 12 detached → main drops, and when the move's
  broadcast is rendered first the pill is already gone, so `dragend` reaches only the detached pill
  and never `window` (broadcast +6.5 ms, pill gone +14.6 ms, `dragend` +17.7 ms). Without the hold the
  source pane left only on that broadcast's render while the receiver attached at once, a margin of
  0–2 ms; delaying the source's `sessions` handling by 150 ms (a control socket slower than the data
  socket, as two connections through a proxy can be) showed "Opened somewhere else." on 6 of 6 drops.
  **The guarantee is the server's**: an eviction of a socket whose window (its `&window=`, absent for
  main) no longer holds the tab (`registry.windowOf`) is `detached { moved: true }`, and the pane
  stops reconnecting and shows nothing, because the `sessions` frame that moved the tab went out
  before the receiver could attach and takes the pane away. If the pane is still on that tab after 2 s
  (`MOVED_TAKEOVER_MS`, the hold's bound: the window missed the broadcast and a reclaim gave the tab
  back), it offers Take back. A rival in the window that holds the tab gets the plain `detached`, as
  before. It rests on one ordering, the receiver's own: its `moveToWindow` goes out on its open control
  socket before its pane opens a NEW data socket (1.5–16 ms later, measured), so the server has the new
  owner when the attach evicts. After the fix the same 150 ms delay showed nothing in 6 of 6.
- **A dirty editor is no drop target (D7).** A drag cannot ask the user, and the receiver cannot see the
  source's buffer. A dirty editor pill's `dragstart` also sets `TAB_DIRTY_DND_TYPE`
  (`application/x-palmux-dirty`), and a receiver treats a drag carrying it, with no local drag live
  (`getData` is hidden until the drop, so that is the only test of "foreign"), as no target on EVERY
  surface: no overlay mounts, the strip's `onDragOver` returns without `preventDefault` (the browser
  shows no-drop, so no `drop` ever fires), `commitDrop` returns before `onDropFromOtherPane`, and the
  capture `dragover` listener toasts "Save the file before moving it to another window" once per entry
  into the window (`dirtyToastRef`, cleared by the same timer). The menu route does ask.
- **Compatibility (D12): this needs a server restart.** The client hides "Open in new window" until a
  `ready` carries `detachedWindows`, so a client built ahead of the server opens no window that would
  show nothing. The restart costs every live terminal (a cold start plus snapshot restore) and needs the
  owner's OK at the time. A detached window that reconnects to an older server (a rollback) gets no flag:
  it toasts "This server does not support detached windows", shows the New-tab page, claims nothing and
  never self-closes. An older client on a new server drops `window` in `parseTabMeta`, shows every tab as
  before, and its pop-out still works as the old takeover. `tabs.json` is unchanged, so a rollback
  releases all ownership, harmlessly.
- **Accepted risks and limits.** A live but idle detached window (a laptop left awake) hides its tabs
  from the phone, the owner's choice; the only way to pull one back is closing that window, and a "Move
  to this device" row in the drawer is the follow-up if it bites. A reload slower than 3 s after
  `pagehide` flashes the tabs into main, which attaches the terminals, and the reclaim moves them back;
  the main pane unmounts, so last-attach-wins does not fight, at the cost of one extra SIGWINCH and a
  brief reorder. **The drag timer is MEASURED** (2026-10-28, Chrome 156 on Linux X11, a native XTEST
  pointer, two real windows): a STILL pointer gets one `dragover` every ~352 ms (351–353, n=8; the HTML
  spec's nominal repeat is 350 ms). The first build's 300 ms timer fired between two repeats and
  unmounted the overlay, and the next repeat found nothing to cancel it: releases after a still hold
  of 0, 100 and 250 ms landed, holds of 330, 350, 400, 700 and 1000 ms were all lost (0/5), and the
  source's `dragend` read `none`. The timer is 1000 ms now. A drag that leaves the viewport is cleared
  by its `dragleave` within ~18 ms, so the timer only bounds a drag whose end the browser never reports
  here, where a long one costs an overlay left up for a second. The same run showed that Chromium fires only
  `dragenter` on the element a drag has just moved onto, and that answer is the drop operation until the
  next `dragover`, so the strip root, each pill, each chip and each pane overlay accept on `dragenter` as
  well. **What would invalidate it:** an engine or OS whose still-pointer repeat is slower than the
  timer; macOS, Windows and Firefox are unmeasured. A group spanning windows draws only its members in
  each, and contiguity stays a server rule. A group CHIP
  dragged from another window onto a strip still only reorders the block in the full order (no window
  move): known, harmless. A foreign drag entering directly over a web pane's iframe is not seen until
  the pointer crosses a non-iframe region (`dragover` fires in the iframe's document): accepted. A
  duplicated detached window shares its wid: a popup has no tab strip, so the browser's Duplicate is not
  offered, but opening `/window/<wid>` by hand in a second window shows the same tabs twice (two
  attachments, last attach wins); not guarded. Two windows that pick the same lowest-free terminal id
  before either hears the other's broadcast collide: the loser's spawning attach evicts the owner as a
  plain rival (not `moved`), the loser's pane leaves on the broadcast, and the owner is left offering
  Take back for a tab nobody else holds; not guarded (pre-existing, needs both picks inside one round
  trip). Non-goals: dragging past the browser window's edge to
  spawn a window (never built), detached windows on a phone, a dock in a detached window, remembering
  detached windows across a browser restart, and a Close other tabs that reaches other windows.

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
(Button, IconButton, Input, Switch, Segmented, Select, Tooltip, Collapsible, Dialog, ScrollArea, VirtualList) styled entirely from the
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
**Two scroll surfaces, one scrollbar, and the list is its own scroller** (`ui/ScrollArea.tsx`,
`ui/VirtualList.tsx`, `ui/scroll.test.tsx`). `ScrollArea` is Radix ScrollArea for BOUNDED content (a
panel body, a short list): `type="auto"` shows the bar exactly when the content overflows, vertical is
the default, and `fill` is for a child of a flex column (`flex: 1 1 auto`; without it the area is
`height: 100%`, which scrolls only when its parent has a height of its own). Radix wraps the content
in an inline `display: table` box that grows to the widest line, so a long line opens a sideways scroll
where a vertical area wants it to wrap; the stylesheet cannot beat an inline style short of
`!important`, so the component sets `display: block` through a prop, and only the horizontal and
both-ways areas keep the table. `VirtualList` is a thin wrapper over react-window 2.3.3's `List`, whose
props it takes as written (`rowCount`, `rowHeight` as a number, a function or a `useDynamicRowHeight`
result, `rowComponent`, `rowProps`, `overscanCount`, `onRowsRendered`, `listRef`) and whose hooks it
re-exports, so nothing outside the kit imports react-window. It mounts only the rows near the visible
part: 10,000 rows in a 600px area cost fewer than 100 elements, and a test holds that. **It cannot sit
inside a `ScrollArea`**: the `List` element IS the scroller, rows are absolutely positioned inside it
and its row maths read THIS element's scroll offset, so a wrapper would nest two scrollers and break
them. That is why it wears the browser's thin NATIVE scrollbar (`scrollbar-width: thin`,
`scrollbar-color`) rather than Radix's, and why a row component must spread the `style` it is handed
on its root (with a dynamic height, leaving `height` out of it). **One token paints both bars**:
`--ui-scroll-thumb` (the text colour at 28% over transparent) is the Radix thumb's fill and the native
`scrollbar-color`, declared once, so a theme change repaints both and neither stylesheet holds a
colour literal; the `-hover` step exists for the Radix thumb alone, a native scrollbar has none.
**Both bars are hidden on a phone** (`:root[data-mobile='true']`: the Radix bar is `display: none`, the
list is `scrollbar-width: none`): the drawer's gesture lives on the right edge and a slider there
fights it, the reason the terminal's own scrollbar went, and touch panning is native and needs no
handle. Neither surface sets `touch-action` on the thing that scrolls and nothing in `VirtualList`
handles a pointer event, so a swipe that starts inside a list pans it and a press there never cancels
the pan (a test fires a touch `pointerdown` and `touchstart` on a row and asks that neither was
prevented). Neither belongs inside the terminal grid, which scrolls itself. Two callers today. The
Source Control view is a `ScrollArea`, and a group over 200 rows (`LONG_GROUP_ROWS`) is a `VirtualList`
of its own at `60vh` inside it, the one place a list sits in an area: accepted because a group that
long is rare and the alternative is drawing every row of a 5,000-entry status. The review pane is a
`VirtualList` with exact row heights (see "Source Control").
`session/DockPanel.tsx` + `dock.css` is the right-side dock that replaces modals: Settings, Files,
Source Control, Dictation and the new-tab chooser are all views of it. It is LAYOUT, not an overlay —
`.content-row` wraps `.content-area` and the dock so the terminal narrows instead of being covered.
**The desktop settings MODAL is gone** (`SettingsPanel` deleted): the dock is the desktop surface and
the drawer the mobile one, `SettingsFields` is still the single field list, and the `settings`
keybinding routes to whichever host is live. Its tests were never about the modal — they moved
verbatim to `SettingsFields.test.tsx`.
**A terminal pane is keyed by PANE and by nothing else.** The key is the pane's id (`leaf.id`),
minted once and stable across every layout operation except removing that pane. Its socket effect
takes `sessionId` as a dependency precisely so a tab switch swaps the session IN PLACE
— same xterm, same `clientKeyRef`. Adding anything tab-specific to a React key
above it (the error boundary's key did this for a day) REMOUNTS the pane on every
switch: a new xterm, and a fresh `clientKeyRef` uuid, which the server reads as a
RIVAL client — so the pane evicts itself and shows "Opened somewhere else." It
surfaces on a slow link, where the old socket is still attached when the new one
arrives, which is why it was reported from a phone. `GroupsView.test.tsx` asserts
one mount across three sessionId changes, and across a split, a merge and a move of another
tab; nothing else catches it, because it is
not a render error, not a type error, and the pane looks right in a screenshot.

**Boundaries now cover the PANES and the STRIP too**, not just the dock's views. A
render throw unmounts the whole React root, and outside the dock that costs every
attached terminal and every unsaved buffer. Each terminal pane gets its own boundary
keyed by the pane's id ALONE (a key that carried the tab id remounted the pane on every
switch; a stuck boundary is cleared by its own "Try again"), `PaneHost` gets one, and each
pane's `SessionTabs` gets one. The boundary's `style` prop applies to the
FALLBACK only — a pane is placed by absolute rect, so an unpositioned fallback
would land at 0,0 over the surviving pane, and putting a wrapper around the happy
path would be the reparenting the pane layout exists to avoid (an iframe or a
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
**The rail is always drawn on desktop, and `sidebarRail` is dead.** It was a per-device preference
(`always`|`hidden`), and `hidden` left Explorer, Dictation, Upload and Download with no pointer route
at all, so the Settings row is gone and nothing reads the value for layout: a stored `'hidden'` is
ignored. The type, the default and the sanitiser stay only so an old settings.json still parses. It
must still never join `SYNCED_KEYS` — a synced copy puts a per-machine value back in the
dotfiles-tracked settings.json (`settings.test.ts` pins that).
**There is exactly ONE action bar, and it is the rail.** Upload and download also
have keybindings (`uploadFile`/`downloadFile`) and therefore command-palette
entries — they date from when the rail could be hidden and that left two ACTIONS with no
route at all, which the old "reopen panels with the keybinding" warning did not disclose
because it only thought about views. The desktop topbar used to carry ⬆ Upload,
⬇ Download, ? Tips, ⚙ Settings and the ⬍ split-orientation toggle while the rail carried four views
— two action bars, one above the terminal and one beside it. The topbar is gone (each pane draws
its own strip and the app menu is the rail's first control, below). Upload and download became rail ACTIONS
(`RailAction` in `DockPanel`, rendered behind a `.dock-rail-sep` below the views, no `aria-pressed` because they open
nothing) rather than panel rows: both are one-click and a panel would make them three, and this is
also where the mobile drawer's footer already has them. Tips became a Settings row — of the three it
is the one nobody reaches for mid-session — and is also an app-menu item (below). The ⬍ toggle is
deleted with the orientation it flipped: a pane is placed by where a tab is dropped, not rotated.
**The rail is ordered by frequency of use**: New tab, Explorer, Source Control, Dictation, the
separator, Upload, Download, and Settings PINNED to the bottom edge — what you open mid-session sits
at the top, and preferences are the thing you reach for least. Source Control sits directly under
Explorer and over Dictation (`git-branch` icon, `dock-rail-scm`; the `sidebar-dock` spec pins both
neighbours). `DOCK_VIEWS` carries that order (nothing outside `DockPanel.tsx`
reads it, and `readDockView` accepts `scm` so a reload reopens it). The mobile drawer's `SWITCHER_VIEWS`
is a separate list, but it now follows the same relative order; `SessionDrawer.test.tsx` derives the
expected order from `DOCK_VIEWS` minus New tab and Settings, so the two cannot drift apart.
Settings leaves the flow through `.dock-rail-pinned { margin-top: auto }` on its OWN button, not
`justify-content: space-between` on the rail, which would also spread the views and the actions
apart whenever the rail has spare height. The testids (`dock-rail-<id>`) did not move.
**The app menu is the FIRST control of the dock rail, and there is no topbar.** Each pane draws
its own tab strip (see "Editor groups") and `+` lives in each strip, so the bar that held the
strip, `[+]` and the menu is gone. A 28px `IconButton` (`aria-label="palmux menu"`,
`data-testid="app-menu-button"`) is the first child of `nav.dock-rail`, above `dock-rail-newtab`,
in every display mode. The rail is already a column of 28px buttons at the window's right edge, so
the menu needs no alignment literal: `--rail-w` and `.topbar-menu` went with the bar, and so did
the `App.test.tsx` case that held them in step (`DockPanel.test.tsx` holds the menu as the rail's
first control instead). `DockPanel` takes it as `menu?: { items }` and App passes its
`appMenuItems`. **One explicit exception, window-controls-overlay.** An installed PWA in that
display mode has the native window controls lying over the top of the window, and the topbar that
used to be laid into the title-bar area is not there to keep them off the panes. `.wco-titlebar`, an
empty drag region (`-webkit-app-region: drag`, `height: env(titlebar-area-height)`, full width),
sits above `.content-row` and is `display: none` everywhere else, so the controls cover neither a
strip nor the rail's menu. It is built from the spec's geometry and not measured in an installed
WCO window: the owner's macOS PWA uses a normal title bar, so what holds it is the CSS test
(`groups-css.test.ts`, with `tab-strip-css.test.ts` failing any `.topbar` rule that returns). The
menu opens `ui/DropdownMenu` — the kit's wrapper over `@radix-ui/react-dropdown-menu`, a menu
opened by a BUTTON the way `ContextMenu` is one opened by a right-click or a long press — and the
dropdown is `align="end"` `side="left"`: the rail is at the window's right edge, so the menu
opens leftwards into the window instead of running off its edge (the kit's `DropdownMenuProps`
takes `side` and forwards it to Radix). It reuses `ContextMenuItemSpec` and the
`.ui-menu`/`.ui-menu-item` classes so the two menus cannot drift. It adds the transform origin, which comes from
`--radix-dropdown-menu-content-transform-origin` so it grows out of its trigger, and CHOICES: an item
with `checked` is a `menuitemcheckbox`, or with a `radioGroup` one option of a `menuitemradio` set
(adjacent items naming the group are one Radix `RadioGroup`), so a screen reader hears `aria-checked`
rather than a plain command with a check drawn beside it. The check goes in the icon slot every choice
keeps, so labels line up. A **stepper** item (`decrease`/`increase`/`value`) is a row of two real menu
items either side of a value that does NOT close the menu (`preventDefault` on Radix's select event),
because the control is meant to be tapped again and the thing it changes is the feedback. The buttons are
items so the roving focus reaches them and Enter or Space steps (Radix keeps Tab inside a menu, so a plain
button would be unreachable), the group is named by the label and the value is a polite live region. It
is built from the item classes the other rows use and has no sheet of its own, which is also why its two
buttons are 30px square on a phone, beside 32px rows. The review bar's View options menu (layout, wrap,
algorithm, code size, in a pane too narrow for the controls) is the caller that needed both. Items: Settings,
Tips, Reload app. The rail is always drawn on desktop, so the menu is a SECOND pointer route into
Settings — the rail's pinned Settings button is the first — and not a way back from a hidden rail;
Tips and Reload app are reachable here as well as from their own Settings rows. Settings runs ONE
`openSettings` shared with the `settings` keybinding — the dock view on desktop, the drawer view on
mobile — so the two routes cannot open different things. A detached window draws no rail and so has no app
menu: its commands are the tab menu's.
**Bulk close is Chrome's two items** — "Close other tabs" / "Close tabs to the
right" — computed from the FULL order of the tabs THIS window shows (another window's are never touched),
never the visible entries: whether a
group happens to be collapsed on this device must not change which tabs "to the
right" means. Both go through `closeMany`, which shares ONE kind-aware confirm with
the group's Close all (`session/close-many.ts`): a bulk close is the only action
here that can destroy work, and a bare "close 7 tabs?" hides which of it is a
running shell and which is unsaved text. All kills go out in one pass — routing
through `closeTab` would ask per tab and navigate to neighbours that are themselves
about to close. An item that would close nothing is not rendered.

**The tab context menu is three groups with a hairline between them** (`SessionTabs.tsx`,
`.tab-menu`): EDIT (Rename), LAYOUT (Split right, Split down, New group from this tab / Add to
<group>, Remove from group, the colour swatches, Move to main window (a detached window only), Open in new
window) and CLOSE (Close, Close other
tabs, Close tabs to the right), and CLOSE is always last so the one destructive item is never in
the middle of the others. Every group is non-empty — Rename, the swatches and Close always render
— so both `tab-menu-sep` separators always have an item on each side, which a test pins even with
every optional item absent. Every action leads with a 16px kit icon: `pencil`, `split`, the same
`split` turned a quarter for Split down (a vertical rule between two panes becomes a horizontal
one between two stacked panes; a transform on a static glyph, not motion), `plus`, `eject` for
Remove from group, `external` for both window items, and `close` for all three close items. An item is `--ctl-h` (28px;
the task named 30px, which is off the 4px grid), `--fs-3`, `--r-2`, and items are flush — groups
are told apart by the hairline, not by air — with the inner radius concentric inside the outer
`--r-3` less the padding. The item rules are scoped under `.tab-menu` because the mobile
long-press sheet (`TabSheet`) reuses `.tab-menu-item` for its group rows with its own sizing,
and the group chip's menu (`group-menu`) shares the `.tab-menu` surface and item rule but was
not regrouped: it has no icons or separators. Behaviour, `data-testid`s, the conditional
rendering above and the micro-tier entrance from the pointer corner did not change. The menu is
still hand-positioned and `contextmenu`-only, which is why the Explorer's menu is the Radix
`ContextMenu` instead.

**Middle-click closes a tab**; the action is on `auxclick` but
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
that is NOT active. The fill clears
one surface step off the strip in every built-in theme; `tab-strip-css.test.ts` checks the numbers,
because the CSS only names a mix, and mixing the surface TOWARD the text moves it away from the
mantle on a light theme as well as a dark one. A tab's colour is a 7px dot (`.ctab-dot`) before the
title and nothing else — `--tab-accent` is read by the dot rule alone. Colour used to carry state (a
fill, a tint, a top border) and, in the old fused split pill, a saturated member colour
out-shouted its focused half. The kind icon renders for non-terminal kinds
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
Each pane's strip box (`.group-strip`) ends in a **1px `border-bottom` in `--t-surface`**, and the
focused pane's turns `--t-accent`. The old Chrome-tab strip had no bottom border, only so the
active tab could merge into the content below it, and a pill merges with nothing. `session/tab-strip-css.test.ts` pins the shape — happy-dom has no layout, so a grep on the
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
**Empty strip space is a drop target, and the gaps are new space.** The 8px gaps and the cluster
padding did not exist when the strip was flush, and the strip's `onDragOver` treated any target that
was not `.ctab`/`.group-chip` as the TRAILING area: a tab dropped in a gap appended at the end, and
a grouped one LEFT its group (`groupUpdate{removeIds}`, which `server.ts` persists).
`gapBoundary(clientX)` now compares the pointer's x with the rects of the rendered units (`.ctab`
and `.group-chip`, in strip order): the boundary is before the first unit whose
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
default is stored. The default stays OWED until HOME is known (`homeOwed`), not until
something is stored: a pinned root toggled while HOME's request is pending or retrying
used to settle "first run" and leave HOME closed for good. Such a toggle is held in
memory and written, merged with HOME, when HOME lands — writing it at once would let a
reload in that window read "HOME collapsed". A pin settles the default (it stores
exactly `[newRoot]`), and so does a toggle of HOME's own path through a pin equal to it. With a state stored HOME is open only if the state says so —
`load(null)` no longer forces it — and `[]` is a state too (someone who collapsed
everything), never a first run. **The stored set is never pruned against the root
list.** `explorerRoots(root, pins)` is incomplete at boot twice over (HOME is unknown
until its request lands, and nothing says when the synced pins are authoritative), so
a prune keyed to it erased a remembered pinned root whichever of the two arrived
second, and stored the loss. What is shown is `stored ∩ explorerRoots(root, pins)`,
recomputed on every render; an entry for a path that is not a root today stays
dormant, costs nothing and reopens if the root comes back. Writes happen on user
actions (a header toggle, a pin; a toggle held while HOME is owed lands with HOME) and
each stores the FULL current set, dormant
entries included; `pin()` stores exactly `[newRoot]`, which is its design and also
clears the dormant ones. **Only LIVE open roots load and poll, and a root is loaded AS A ROOT.**
The load effect fetches each live open root directly; `expanded` holds only the folders the USER
opened, and a root is never put in it. It used to be (each root was seeded into the set as it entered
the intersection, to get it fetched), and that same set drives the folder row of a pin nested in HOME,
so a folder collapsed inside HOME came back open on every relaunch whenever it was also pinned as its
own section. A section lists from `dirs[root]`; a nested pin's folder row follows `expanded` alone,
and `pin()` no longer adds the new root to it. The 2-minute poll re-reads the same VISIBLE set the load
effect fetches (`neededDirs`), never every listing cached under an open root: the cache keeps whatever
was once shown there, so a nested pinned section collapsed while HOME stayed open kept its restored
subtree polling. A dormant root polls nothing either. The per-root ⟳ is an explicit request and still
re-reads that root's whole cached subtree.
**Folders opened INSIDE a root are remembered too, per device, and only the Explorer's own delete
forgets one.** `localStorage['palmux-explorer-expanded']` holds `{v:1, dirs:[<absolute paths>]}`, oldest
first (`explorer-open.ts`, with the same forgiving parse and swallowed storage errors), because an
installed PWA is relaunched from nothing. It is restored into `expanded` at mount and changed only by a
folder toggle — collapsing removes THAT folder and leaves its stored descendants, so reopening the
parent brings its open children back — or by a delete. **Every write is ONE change applied to what
is stored NOW** (`writeExpandedDir`, `forgetDeletedDirs`), never a mount's whole set: two trees can be
live (the dock and the drawer, two windows), and a delete can finish after the tree that sent it has
unmounted, so storing one mount's memory erased what another had opened meanwhile. A completed delete
is also announced to every mounted tree (`subscribeDeletedDirs`), so a tree that mounted mid-delete
drops the folder from memory too, instead of showing it open. **A stored folder is fetched only when a
LISTING proves it is on screen** (`neededDirs`, used by the loader AND the poll): it must appear as a
DIRECTORY entry in its parent's `ready` listing, the parent must itself be on screen or a live open root
(`stored-open ∩ explorerRoots`), and the folder must be expanded. A record for a folder that was deleted,
renamed or spelled in a form no listing produces is therefore never fetched and never polled; it stays
dormant in storage, bounded by the 200 cap, and wakes if a listing ever shows it again. The price is that
a restore loads one level per round trip, where it used to load every level at once from the paths alone.
The folders of a collapsed root, a dormant root or a collapsed ancestor stay stored and cost no request
until they can be seen. **Listings never prune**, because no listing is proof of
absence: `server/files.ts` answers a transient failure as 404, silently omits an entry whose `lstat`
failed, and reports a directory symlink whose target `stat` failed as `dir:false`, and fixing that on the
server would need a restart, which costs every live terminal. The one reliable signal is the Explorer's
own delete: when `POST /files/delete` reports a path deleted, that path and every stored folder under it
(by path segment, never by string prefix) are dropped from `expanded` and from storage. The list is
capped at 200, oldest dropped first on a write, and that cap is what bounds the stale records a folder
removed elsewhere leaves behind.
**A path has ONE identity, `normalizePin`, and it is the server's.** `server/files.ts` names every listing
by the `path.resolve`d path, so `normalizePin` (`explorer-pins.ts`) canonicalises with the same POSIX
semantics: it collapses `//`, drops `.`, resolves `..` (never above `/`), leaves no trailing slash except
on `/`, and rejects a path that is not absolute. **Whitespace is significant — it is part of the name.**
`report ` and `report` are two different folders, so nothing is trimmed: a trailing space inside the last
segment is kept, and a path that STARTS with whitespace is not absolute and is rejected as `''` rather than
repaired into one nobody named. Every store goes through it — both Explorer parses, the
pins (`addPin`/`removePin`/`isPinned`/`explorerRoots`), `writeExpandedDir` and `forgetDeletedDirs` — so a
pin synced as `/work/./project` is the root `/work/project` and unpins by either spelling. It must be
IDEMPOTENT (`normalizePin(normalizePin(x)) === normalizePin(x)`, pinned by a test over every short path
against `path.resolve`): it used to trim, so `/work/report /.` became `/work/report ` and then `/work/report`,
and a pin, its stored open flag or its expanded child could each resolve to the sibling (B10-INSPECT2-01).
Before that it trimmed whitespace and trailing slashes only, so a stored `/home/u/.` was requested as such,
answered under `/home/u`, filed there with the requested key deleted, and the load effect — seeing its own
key missing — asked again after every answer, for ever. The two typed-path fields follow the same rule: the
Download prompt and the Markdown… row use `trim()` only to DETECT a blank entry and send the string
unchanged, and a value holding a line break is refused, never stripped (`notes.md` and `notes.md\n` are
different files). The Markdown field catches it at the paste event, because a text `<input>` removes CR/LF
before `onChange` runs; `window.prompt` sanitises its value too, so a path with a line break cannot be
entered in the Download prompt at all (the Explorer's own download passes the row's path unchanged).
`FileTree.load` is still defended against a server that disagrees about the path. The route used to TRIM its
`dir` (it no longer does, see `/files/list` below), so a folder named `report ` was answered with its
sibling `report`'s listing — which is why the response-path mismatch guard exists, and it stays, because a
new client can meet a server that has not been restarted yet. That response is filed under the reported
path ONLY, never copied to the requested key: rows take their paths from the key they are drawn under, so
the file `report/x` would be drawn as `report /x`, which on disk may be a directory whose Delete is
recursive. The requested key takes a TERMINAL error instead (`the server listed a different path: <path>`),
so the load effect never refetches it. HOME, asked for with no `dir`, is the one request whose own key is
dropped.
**Known limit: two windows of ONE device changing folder expansion in the same instant.** A write is a
synchronous read-modify-write on `localStorage`, which has no cross-window locking, so the later write is
computed from the earlier stored set. It can (a) bring back the record of a folder the other window just
DELETED — harmless now, a record no listing shows is never fetched; (b) drop the other window's new
expansion — the user re-expands it; or (c) bring back the record of a folder the other window just
COLLAPSED while it still exists — that folder REOPENS on the next mount. (c) is a real reversal of a user
action, accepted because it needs two windows on one device acting within the same read/write gap, and
the owner's setup is one installed PWA per device. Web Locks were designed and rejected: they make the
write asynchronous, which opens a remount race, and a tree mounted in another window would still need a
cross-context delete transport. A controlled interleaving test pins (c) in `explorer-open.test.ts` and
again end to end in `FileTree.test.tsx`, so a change to the scheme has to decide on purpose.
**Freshness is a POLL, not a watcher** (`POLL_INTERVAL_MS`, 2 min, only for the
listings that are VISIBLE). An inotify watch per expanded directory is an fd per directory and
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
a MISTAKE, not an attacker: the cookie already grants a shell. **The path is used exactly as given:**
`report ` and `report` are two directories, and the route used to trim, so deleting the row `report `
removed `report`. `trim()` only detects a blank item — a blank item is a per-path failure (`path is
required`) inside the 200, in a mixed batch too, which `explorer-actions.ts` relies on. And `isAbsolute`
runs on the RAW item BEFORE `resolve`: `resolve` anchors any string to the server's cwd, so the check used
to run on a path that was always absolute and `packages/client` deleted that directory of whatever
checkout the server was started from (B11-01); a relative item is now a per-path `path must be absolute`,
and the refusals above still run on the resolved path. The confirm names
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
so there is ONE owner for "skin the app": three call sites exist (boot, a change of
the resolved theme id, a `themes` broadcast) and an editor wired to only some of them is the bug
this replaced. The bridge (`setEditorProfile`) lives in a module that must NEVER
import monaco — a static path from App to the loader would drag the 3.7 MB chunk into
every terminal-only session. `defineTheme` alone does not repaint a live editor;
Monaco re-reads only on `setTheme`, so both run, in that order.

**The editor's size follows the CODE size once one is set, and stops following the terminal**
(`editorFontSize` in `settings.ts`, read by `EditorPane`). Until a device sets `codeFontSize` the editor
is the terminal's size plus one (`EDITOR_FONT_OFFSET`), as it always was, so nothing moved when the
setting arrived. Once it is set that number is the editor's size outright, and a change of the terminal's
no longer reaches it; clearing it (Settings, an empty field) goes back to following. The live update takes
the settings the subscription hands it, not a fresh read of `localStorage`, and goes through `updateOptions`,
so an open editor changes with no reopen. The review reads the same setting but answers `null` differently
(it keeps its own 12px: see "Source Control"). The markdown viewer is not code and still follows the
terminal plus one. Measured against a real Monaco at 1440: 15px with the terminal at 14 and nothing set,
11px once set to 11 and still 11 with the terminal at 18, and back to 19 when cleared.

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

**A bar with the drawer swipe is ALWAYS present on mobile, and that is a trap fix rather than
a preference.** Which bar depends on the ACTIVE TAB's kind and never on a pane registry: the
extra-keys bar for every kind except `review`, and the review bar (`mobile/ReviewBar.tsx`, see
"Source Control") for a review, and never both. The invariant is the ROUTE, not the bar:
right→left across whichever bar is showing opens the drawer. The extra-keys bar used to hide
unless the active tab was a terminal, which looked tidy and left no way out of an editor: mobile has
no tab strip, and that swipe is the only route to the drawer. Measured on the reported path
(Explorer → open a file): the pane header offered only Read/Edit, the bar was hidden,
and nothing could switch tabs or close it. `FileTabPane` was also the one pane
`PaneHost` never passed `onMenu` to — but the fix is the bar, not a `☰` button that
exists nowhere else (owner decision). The rule was first written as "the extra-keys bar is always
present", and the review tab is what showed that the swipe was the only load-bearing part of it: a
review has no shell to type into and no editor to drive, so it takes the bar's slot with a bar of its
own, and that bar keeps the swipe. A new tab kind that wants its own bar must carry the swipe too.
On the extra-keys bar, left→right raises the soft keyboard; on the review bar it goes back to the tab
the review was opened from, because there is no keyboard to raise.
The extra-keys bar's keys now drive an EDITOR when the tab is not a terminal (`mobile/editor-keys.ts`
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
anything anyone edits; a PRESENT but blank `dir` is `400 dir is required`. **The path is used exactly as
given:** it used to be trimmed, so a request for the folder `report ` was answered with the sibling
`report`'s listing; `trim()` now only detects blank. `isAbsolute` runs on the RAW input before `resolve`
(which anchors any string to the server's cwd, so a check after it can never refuse), and a leading space
is therefore a `400 dir must be absolute`, not a repaired path.

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
   opens the socket — the pane is keyed by PANE, so consuming at mount would bind it to the wrong
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
three quarters of the WIDTH, at most 340px (`width: min(75vw, 340px)`; owner, 2026-10-26: "too large", with a
horizontal arrow across it, which the first pass of that day misread as height and answered with row
heights, so the drawer did not change): 292.5px on a 390px phone, where it was 346px. The uncovered rest is
the scrim strip, 97.5px at 390px, and `max-width: calc(100% - var(--drawer-strip))` keeps it at least
`--drawer-strip` (44px, the touch-target floor) on any viewport. The strip hit-tests as the scrim with the
keyboard up or down, so a thumb can always reach the terminal side to close it. The scrim is token-coloured (`--t-base` at 72%, the kit
Dialog overlay's mix) and is inert while closed; scrim and slide run on `--mo-surface` in and the
shorter `--mo-micro` out, and reduced motion drops both transitions. The drawer is the mobile
container for the SAME five surfaces the desktop dock rail hosts (sessions · settings · files ·
Source Control · dictation), ordered for the THUMB, bottom → top: the footer, the bottom-anchored
session list, and at the very TOP ONE row — the view switcher and, at its right end, the Settings gear
(owner decisions: 2026-10-25, he does not want the switcher at the bottom; 2026-10-26, no close control in
the top row, the gear takes the place Close had). **The drawer has no close button**: it closes through the
scrim strip, a swipe, every action that leaves it, and **Escape from inside it** (`closeOnEscape`, the
`<nav>`'s own `onKeyDown`, for a keyboard or assistive tech that has focus in here). It is never a document
handler: the drawer leaves `#mobile-kbd` focused, so an Escape typed while it is open still belongs to the
shell. A key something inside already took does not close it as well: the handler ignores a default-prevented
event (a Radix Select or menu closing prevents it, and renders in a portal outside the nav, so its keydown
only reaches the handler through React's tree, which the `contains` check also refuses), and an editable
target (a field cancelling its own edit). The switcher is a kit `Segmented` over FOUR
segments (Sessions · Explorer · Source Control · Dictation) wearing the rail's own icons in the rail's
own order (`git-branch` for Source Control, which took the slot between Explorer and Dictation);
Settings is the gear beside it and not a fifth segment, because a segment for it as well would be two
entries for one place. The top row
exists only at the drawer's ROOT: Settings and the new-tab chooser are sub-surfaces whose `‹` back
header is the top control there, a row above it would push the way back down the screen, and the
switcher goes with the row — Explorer, Source Control or Dictation is one back press from Settings,
the depth the chooser already has. **Four segments fit a 390px row with room to spare**: the row is
275.5px (the drawer's 292.5px less its 1px border and 2 × 8px of padding), the switcher 231.5px once the
gear and its gap are out, and each segment 54.9px (68.3px before the drawer was narrowed, 57.3px while Close
took a second button), measured in Chromium and recomputed from the stylesheets by
`SessionDrawer.test.tsx` because happy-dom has no layout. That is still over the 44px touch floor. The
drawer's `padding: 0` on a segment is room, not need: at the kit's `--sp-3` (12px a side) a segment needs
39px around its 15px icon, still under its 54.9px share, and the test asserts exactly that. The zero is
headroom for a narrower phone, where the share shrinks (a 320px phone's drawer is 240px and a segment 41.75px,
under the 44px floor but over the 23px an icon needs, which the test also holds); a segment's tap target is
its whole box either way. The icon is the whole label: each segment's name is
clipped to a 1px box that stays in the accessibility tree, so nothing in the row can be truncated,
and the test fails any rule in the row that clips or ellipsises. In the row the unselected icons wear `--pill-text` (the strip's inactive text),
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
**Drawer lists are compact on a phone, and the lists are the only thing that is** (owner, 2026-10-26: the
session rows were too big, in height and in text, beside the footer and the extra-keys bar, whose density he
called right; and, when 32px rows looked the same to him, again). A session row, a group header and
`+ New tab` take `--drawer-row-h`, declared once on `.drawer` as `calc(var(--ctl-h) - var(--sp-2))` (28px on a
phone, under the extra-keys bar's 33px key; the drawer only exists in the mobile layer), instead of `--ctl-h`;
a row's title is `--fs-2` (12px, the footer's size) where it was `--fs-3` (13px) two passes ago. The two halves
of the 4px row gap are still inside the leaf's clip, so the pitch is 32.3px where it was 36.3px (and 40px
before that), measured in Chromium at 390x844 with the owner's seven-row list, the top row, the footer and
`+ New tab` kept. The group header's type is the section-title one (`--fs-1`) and was not touched. What stays
`--ctl-h` is the rest of the drawer: the top row (the kit's Segmented and IconButton), the footer cells, the
`‹` back headers and every kit control a hosted view draws, because the kit's heights live in `ui.css` and
`scale.test.ts` fails a rule outside it that sizes one (a Source Control group header, a kit Collapsible
trigger, is compact through the kit's own extra-small step instead: see "The changed-files list is compact on
a phone"). `--drawer-row-h` is a custom property written from the two tokens, not a literal, so it is on the
scale by construction and follows the device class; `--ctl-h` itself is declared in exactly two places and a
third fails `scale.test.ts`.
Two things about the switcher. **Availability is DECLARED (`hostedViews`), never inferred from
`viewContent`**: files, Source Control and dictation have no body of their own, the host supplies
one, and a host can only supply it for the view that is ALREADY selected — so inferring left all
three permanently disabled and unreachable (`DRAWER_HOSTED_VIEWS` in App declares them once; a test
holds `scm` disabled without it and selectable with it, no body needed). The Source Control body is
the dock's own component, mounted with `visible={drawerOpen}`: the drawer stays mounted while it is
closed, so being mounted is not being seen, and a closed drawer must not keep the status poll alive
(the dock mounts it only while open). Choosing a file there calls `closeDrawer()` first and then
opens the review, because opening navigates and `closeDrawer()` is the one way out of the drawer
(see the keyboard-hold paragraph below). And the Segmented takes `keepFocus`, because Radix selects
on CLICK and a click focuses the segment, which blurs `#mobile-kbd` and dismisses the soft keyboard —
the exact reason every other control in here acts on pointerdown + `preventDefault`. That is also why the selection
moves INTO pointerdown, and that press marks its gesture (`consumeGesture`, below): selecting swaps
the drawer's whole body, so the tap's own mousedown and click would land on what the new view drew
under the finger. The mark swallows them for a touch pointer and a mouse alike. A key, assistive
tech or `click()` reaches a segment as a click with no count, which the mark lets through to Radix's
own handler; the item that is already selected reports `''` for the toggle-off there, which
`Segmented` already ignores.
The session LIST is bottom-anchored
(`margin-top: auto`) so the most-tapped surface sits in thumb reach. There is **no brand row**: a
`palmux` wordmark + settings icon used to have a row of their own, a duplicate control plus the name
of the app you are already inside. The one Settings entry is the gear at the right end of the top row.
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
`--pill-text` at weight 500 and is `--drawer-row-h` tall (28px on a phone, see "Drawer lists are compact on
a phone"); at rest its background is the drawer's own
`--t-mantle`, which reads as "no fill" and keeps it OPAQUE over the Close waiting behind it. The ACTIVE row
is `--pill-fill`, the `--pill-ring`, `--t-text` and weight 600, and is never filled with the tab colour,
so a red tab's red lives in its dot and nowhere else; the old 3px `--t-accent` left edge is gone. The ring
is OUTSET (1.5px) and `.drawer-leaf-inner` clips, so its room is the clip's side padding
(`--cluster-pad`, 2px) and the row's own vertical margin (half of `--sp-1` each side: two rows are 4px
apart, and the pitch on mobile went 38px → 40px, and 40px → 36px with the compact rows), both INSIDE the
clip. The vertical room is never padding
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
the list holds anything, not the first render: on a plain `/`, a `?new=1` or a legacy `/<id>` boot the
selection waits for the tab list (a legacy id names its tab, but another window may hold it), so the
drawer mounts empty and fills on the first broadcast. The drawer is closed at boot, so no
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
`closeDrawer()` is the ONE way out and every close path uses it (scrim, Escape from inside the drawer, choosing or
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

## Source Control

The user adds a git **project** (a work tree on the palmux host), the Source Control view lists its
Merge / Staged / Changes files, a `review` tab shows them as one continuous diff, comments hang off
lines of it, and **Reviewed** stages a file. The server half is `server/src/scm-*.ts` plus the `/scm`
routes in `server.ts`; the wire types are `shared/src/scm.ts` and `scm-comments.ts`. The change's
design is `openspec/changes/source-control-review/design.md`; this section is what a reader of the code
cannot get from it, and the places where measurement overruled the design.

**Routes and trust model.** Everything is cookie-gated like every route, and takes ABSOLUTE paths under
`/download`'s trust model (the cookie already grants a shell), so nothing here is confined to a root.

| Route | Does |
|---|---|
| `GET /scm/repo?path=` | `{ top }`, the canonical work tree top of any path inside one |
| `GET /scm/status?repo=` | the grouped status, plus `commentsRev` and `attrEpoch` |
| `GET /scm/file?repo=&group=&path=&oldPath=&algorithm=` | one file's snapshot; `group`, `path` and `algorithm` are required |
| `GET` / `POST` / `PATCH` / `DELETE /scm/comments?repo=[&id=]` | comment CRUD; `id` for PATCH and DELETE, the body is the comment (POST) or a patch (PATCH) |
| `POST /scm/stage?repo=` `{ path, token }` | stage the snapshot the token names |
| `POST /scm/unstage?repo=` `{ path, oldPath? }` | return the entry to HEAD |
| `POST /scm/restore?repo=` `{ receiptId }` | undo (or redo) one of palmux's own writes |

`repo` is the project's identity on every request: it must be absolute and EQUAL its own `git rev-parse
--show-toplevel` after `realpath` (`checkRepo`), so `…/app/src` is refused with a 400 that names the top
rather than silently reading the parent. `path` and `oldPath` are repository-relative, used exactly as
given (no trim, no normalise: `a*.ts`, `2:config.ts` and `report ` are the files they say), and refuse an
empty, `.`, `..` or `.git` component and a NUL (`checkRelPath`; the walk below never calls `resolve`, and
`a/../b` through a symlinked `a` is not `b`). **Every failure is JSON `{ error, code? }`** with the
module's own status, and `code` is a `ScmErrorCode`: 400 for every repo or path refusal and a token that
does not belong to its path; 403 for a path through a symlink; 409 `busy | changed | conflict | df` (and
a merge-conflicted file, no code); 410 `token` for an expired or unknown token or receipt; 413 for git
output over the cap; 501 `unsupported` for a submodule, a split index, or a work tree this host cannot
read safely; 504 for a git timeout. `scmRoute` wraps every handler so that a throw (the comment store's
validation, a filesystem fault) is still JSON: a fault is logged with its detail and answers `500
{ error: 'source control request failed' }`, which names no path. The not-found handler answers an
unknown `/scm/` path or method with a JSON 404, because the SPA shell would be a 200 that `res.json()`
chokes on without saying what was mistyped.

**One runner, `scm-git.ts`.** Argv arrays only, never a shell: `git -C <top> --no-optional-locks
--literal-pathspecs -c core.quotepath=false -c core.fsmonitor=false` (the last so a read cannot start a
daemon that writes into `.git`), with an environment built from a CLEAN BASE on each call, not inherited:
`GIT_DIFF_OPTS` would override `-U`, and `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE` and
`GIT_CONFIG_PARAMETERS` would redirect or reshape a command. `XDG_CONFIG_HOME` stays (git's global config
and default attributes file live under it). A 10 s timeout kills the whole process group (the child is
`detached`, so a hook or filter it started cannot outlive the limit) and an 8 MB output cap reports
`truncated` instead of buffering; `okCodes` is per command (`diff --no-index` exits 1 whenever the sides
differ, which is success). Untracked nested repositories are listed by git as ONE entry with a trailing
slash (`vendor/inner/`), which `checkRelPath` refuses as a snapshot path, so a client treats such an entry
as not reviewable.

**Status, and the poll contract.** `status --porcelain=v2 -z --untracked-files=all --branch --renames
--no-ahead-behind` is parsed into `merge` (`u` records, never asked for a stage-0 blob), `staged` and
`changes`, capped at 5,000 entries (`truncated: true`). Line counts come from `diff --cached --numstat -M`
and **`diff-files --numstat`, not `git diff`**: measured, plain `git diff` rewrites `.git/index` (it takes
the index lock) even with `--no-optional-locks` and `GIT_OPTIONAL_LOCKS=0`, which is the exact failure
"reading status never interferes with the user's git" forbids. `status`, `diff --cached`, `diff-files` and
`ls-files` leave the index's inode and mtime alone (a test pins it against a plain `git status`, which does
change them), and another test commits in a loop while status loops. A `0 0` numstat record for a
stat-dirty file is harmless because counts are looked up only for paths status lists. An entry's `fp`
hashes the record kind, every mode git prints, the object ids, the rename's old path and, for a work tree
side, one `lstat` (`mtimeMs`, `ctimeMs`, `size`, mode): ctime catches a same-size replacement that kept its
mtime, the mode catches a chmod. **`attrEpoch`** hashes every `.gitattributes` git could read, so marking
`yarn.lock` `-diff` turns it binary without an edit to `yarn.lock`: the full `ls-files -s -z` output is
filtered IN CODE by basename (a `:(glob)` pathspec matches nothing under literal pathspecs), unioned with
every status entry named `.gitattributes` (git reads the work tree copy first, so an untracked one
applies), plus `info/attributes`, `core.attributesFile` (else `$XDG_CONFIG_HOME/git/attributes`) and the
config files' `lstat`; the `ls-files` result is cached per index mtime.
**Coalescing is per repository**: concurrent `getStatus` calls share one set of git processes and the
answer is cached for 500 ms, so two windows cost one read. `invalidateStatus(top)` (called by every write)
bumps a generation, so a read that STARTED before a write never caches its answer. The cached object is
SHARED, so the route answers `{ ...status, commentsRev: latestRev(top) }` and never writes into it:
`commentsRev` changes independently of git, and a cached answer must still report the current one. What
the route adds is one `rev-parse` per request (`checkRepo` is not coalesced), so a poll inside the cache
window costs one cheap process. **The client half of the contract** (`scm/status-store.ts`): there is no
watcher (an inotify watch per directory is a firehose on build output, the reason the Explorer polls too).
Only a subscriber that is visible AND watching the device's active project counts, only while
`document.visibilityState` is visible, one request in flight, and the next starts `max(1000, 3 × tookMs)`
ms after the previous answer, capped at 10 s: palmux (10 ms) refreshes every second and a 900 ms
repository every 2.7 s. When nothing counts, nothing runs.

**The snapshot reader** (`scm-snapshot.ts`) reads both sides of one file ONCE and diffs what it read, so
an edit during loading can replace a version but never mix two. The client names a file and a group,
never a blob: HEAD and index identities come from `ls-tree -z` and `ls-files -s -z` under literal
pathspecs, a staged pair is (HEAD at `oldPath ?? path`, index at `path`), an unstaged pair is (index,
work tree), an untracked file is (nothing, work tree), and an UNBORN HEAD is never handed to `ls-tree`
(the old side is `{ id: 'absent', text: '' }`, the shape every addition's old side uses). Blobs are read
by OBJECT ID with `cat-file blob`, never `show :path` (a file named `2:config.ts` would select merge
stage 2). **The work tree is read through a descriptor-relative walk.** Node has no `openat`, but on Linux
`/proc/self/fd/<dirfd>/<name>` resolves `<name>` inside the directory the descriptor already holds, not by
re-walking a path: open `top` with `O_DIRECTORY`, open each intermediate component that way with
`O_NOFOLLOW` (a symlink fails the open and the read is refused with a 403), open the final component
`O_RDONLY | O_NOFOLLOW` and `fstat` it as a regular file, and when that open fails with `ELOOP` read the
link's target from `readlink('/proc/self/fd/<parentfd>/<name>')`, never from the original pathname. A
directory swapped for a link at any moment can only make an open fail, never redirect one;
`walkHooks.onStep` swaps one between two steps in the tests, in both the file and the symlink branch. A
host without `/proc` fails CLOSED: the work tree side answers 501 `unsupported`, while staged snapshots,
which read blobs only, still work. **Limits:** 1 MB per side, either over it and the file is `tooLarge`
with no lines (never half-supported); binary is a NUL in the first 8000 bytes, which is git's own
`FIRST_FEW_BYTES` and not 8192; unmerged entries answer `unmerged: true` with no diff; a submodule answers
501. The hunks are GIT'S: both sides go to a private temp directory and `git diff --no-index
--diff-algorithm=<x> -U3` runs over them with `diff.suppressBlankEmpty`, `diff.noprefix` and
`diff.mnemonicPrefix` pinned, and with an ISOLATED `HOME`, `XDG_CONFIG_HOME`, `GIT_CONFIG_NOSYSTEM` and a
ceiling directory, because git applies the user's global `core.autocrlf` and attributes to path-based
files even in `--no-index` mode (a test fails without the isolation). A work tree side's `id` is git's
blob oid of its canonical bytes (`hash-object --no-filters --stdin`, no `-w`), so it is in the repository's
object format and comparable with the oids beside it. `version` hashes the two ids, the modes and `attrs`
and is independent of the algorithm, so the client keys its row cache by `version + algorithm`.
**Attributes and line endings.** The snapshot resolves `check-attr` (`text eol crlf diff binary filter
working-tree-encoding ident`) plus `core.autocrlf` and `core.eol` for the ORIGINAL path. When git would
convert on check-in, the work tree bytes get the same clean conversion (CRLF to LF) before comparing, so
a CRLF checkout of an LF blob shows only its real edits. For the AUTO-derived modes (`text=auto`, and an
unspecified `text` under `core.autocrlf=true|input`) git converts only when the file is text by its own
stats (no NUL, no lone CR) AND the index blob does not already contain CRLF (`has_crlf_in_index`); an
untracked file has no index blob and converts. palmux applies that rule with the index blob the pair
already reads, so a CRLF blob that was never renormalised diffs line for line and Reviewed never stages a
whole-file renormalisation `git add` would not perform. `-diff` or `binary` marks the file binary whatever
its bytes are. A path with a `filter` driver, a `working-tree-encoding` or `ident` is NOT reconstructed:
it answers `converted: true` (in both groups, Staged included, because the spec says a converted path
shows the notice) and a filter command is never run (an LFS smudge would download). `attrs` is that
context and carries one extra key, `convert` (`off | on | binary | crlf-in-index`), which is the decision
record and not part of what staging compares: staging compares the `check-attr` values plus
`core.autocrlf` and `core.eol`.

**The three writes, and the only ones.** Stage, unstage and undo change only the index entries of the
paths they name, never the work tree and never a commit. **Stage writes what was SHOWN.** The reader keeps
every served work tree side in a memory-only cache (64 MB, 10 minutes absolute from creation, LRU by
bytes) under an opaque `token` binding the repository, path, mode, canonical bytes' id and the `attrs`
context. `POST /scm/stage` looks the token up (410 `token` if it expired or was evicted; 400 if it
names another repo or path), re-runs `check-attr` (409 `changed` if the context moved), writes the
canonical bytes with `hash-object -w --no-filters --stdin` and checks the resulting oid equals the
snapshot's id BEFORE touching the index. A file the reader could not snapshot (too large, converted,
refused) gets no token and cannot be staged from palmux, with no live-path `git add` fallback. The client
recovers from a 410 by refetching and retrying ONCE when the new `version` equals the one on screen. A
staged deletion is a snapshot too (the work tree side recorded as absent). **Unstage** returns each entry
to HEAD's mode and oid, or removes it when HEAD has no such path (unborn included); `oldPath` is honoured
only where it is a real rename source (absent from the index, present in HEAD) and otherwise ignored.
**Every write is one transaction under git's own lock protocol** (`scm-index.ts`): create `index.lock`
(`git rev-parse --git-path index` + `.lock`) with `O_CREAT | O_EXCL`; if it exists the answer is 409
`busy` AT ONCE and nothing waits, retries or deletes a lock. Holding it, copy the index to a private temp
file, read every affected path's BEFORE entries from that copy (`GIT_INDEX_FILE=<tmp> ls-files -s -z`),
apply `update-index --add --cacheinfo <mode>,<oid>,<path>` or `--force-remove` (`--add` because the entry
may be absent: an untracked file, a staged deletion being unstaged, an Undo after a removal), read the
AFTER entries, write the copy into the lock file, fsync and rename it over the index, which is git's own
commit step. Any failure unlinks the lock and leaves the index as it was. A split index (`core.splitIndex`
or a `link` extension that lands exactly on the trailing checksum, so a file NAMED `link` does not
trigger it) is refused 501. A directory/file conflict `update-index` refuses is 409 `df` carrying git's
message; **that detection reads git's stderr** (`both a file and as a directory|cannot add|directory/file`),
matches git 2.43, and is pinned in both directions, so a different wording degrades to a 500 rather than
to a wrong answer. An in-process queue per repository serialises palmux's own writes, so two quick
Reviewed taps queue instead of answering busy; a lock left by ANOTHER program, or by a palmux killed with
SIGKILL, still answers 409 until a human removes it, as git does. **A live lock must not outlive the
process:** the module keeps the set of lock paths it holds and `releaseAllLocks()` unlinks them
synchronously, called from `index.ts`'s `exitNow` (every `shutdown` exit) and from `process.on('exit')`
(the exits that bypass `shutdown`, the handoff included), so `systemctl restart` mid-write never strands
an `index.lock`. It runs ONLY as the process ends: an unlink while a write is in flight could let that
write `rename` a stranger's freshly created lock over the index. **Undo is a compare-and-swap on a
server-held receipt.** Each write records every affected path's before and after entries (rename paths
included) in the same cache under an opaque `receiptId` and answers it; `POST /scm/restore { receiptId }`
runs the same transaction, requires every path's CURRENT entry to equal the receipt's AFTER, and only then
writes the BEFORE, else 409 `conflict` ("nothing was undone"). The client never supplies a mode, an oid
or a path to restore, so restore can only reinstate entries palmux itself recorded. A successful restore
consumes the receipt and answers a fresh one, which is how redo works; a refusal does not spend it.

**Comments live outside the repository, under the config dir's `.cache/`** (`scm-comments.ts`). One file
per project, `<configDir>/.cache/scm/<sha256(top) first 16 hex>.json`, shaped `{ v: 1, repo, rev,
comments }`, mode 0600 in a 0700 directory. The config dir is dotfiles-tracked, so `.cache/` declares its
own boundary: the first write creates `.cache/.gitignore` holding `*\n` (flag `wx`, never overwritten),
which ignores the whole directory without touching the user's root `.gitignore` that
`ensureConfigGitignore` never rewrites, and `git status` in the reviewed project stays clean (the route test pins the file's content, the
directory and that clean status). Each operation is one read-modify-write under a
per-file in-process mutex committed with a temp file and `rename`, so two windows never clobber each
other. **Every mutation answers the WHOLE list and its `rev`** (`{ rev, comments }`) and the client
replaces its state with it, so a window can never hold a `rev` whose changes it has not applied. `rev`
is bumped by every write; deleting an unknown id writes nothing, bumps nothing and answers the current
list. Validation is strict and shared with the client (`SCM_COMMENT_LIMITS`): `lines.length` must equal
`end - start + 1`, at most 2,000 lines, 10 context lines per side, 256 KiB of code in all and a 64 KiB
body (an empty body is valid), the path relative and free of `..`; unknown keys are ignored; PATCH takes
any subset of the content fields and the MERGED comment is validated whole (an empty patch is a 400, an
unknown id a 404). A corrupt file reads as empty and stored comments that no longer validate are dropped,
the way `tabs.json` and `extra-keys.json` forgive. **Other windows learn of a write from the
`scmComments { repo, rev }` frame**, a control-socket broadcast (`app.broadcastScmComments`, decorated in
`attachWebSocket` beside `broadcastUpdating`) sent after every successful mutation, to EVERY socket
(including the writer, whose applied rev already equals it, so it refetches nothing; a delete of an
unknown id broadcasts the unchanged rev, which nobody applies). It is independent of the git poll, which
is what keeps the 2-second promise when a slow repository stretches the status interval; `commentsRev` on
the status answer is the backstop for a missed frame. **Known limit, unfixed:** if `.cache` is deleted the
rev restarts at 0, and a client that already applied a higher rev drops the lower-rev answers until the
rev passes it again; closing that needs a persisted epoch. Anchoring and export are client-side
(design D9).

**The `review` tab kind.** A `review` tab's `url` is `changes:<abs top>` or `staged:<abs top>`
(`reviewUrl` / `parseReviewUrl` in shared). `createTab` and `updateTab` accept only a known group prefix
and an absolute path, and store the CANONICAL form: the path goes through `path.resolve`, so `//`, `.`,
`..` and a trailing slash are gone (the design never defined "canonical"; this is the definition).
**Creation is idempotent in the registry**, as the cross-window backstop: `createTab` for a url a live
review already holds returns THAT tab's id in `tabCreated` and broadcasts nothing, and `updateTab` ignores
a url another tab holds while still applying the name and colour (and returns true, like the `web` kind).
The client's own rule is stronger and comes first: it never sends `createTab` for a review url live in
`tabsRef` (it selects that tab and hands over the scroll target, as `openFileTab` does for editor tabs).
A review persists in `tabs.json` like an editor file tab; an older server drops the unknown kind through
its `isTabKind` filter on restore, and an older client does the same on a `sessions` broadcast.
`displayTitle` is `Changes · <basename>` / `Staged · <basename>` and falls back to `review` for a missing
or unparseable url. **A trap left for the pane:** the `/ws` attach's `&kind=` whitelist
(`['terminal', 'web', 'dashboard', 'editor']`) omits `review` (and already omitted `markdown`), so an
attach by id to a review tab that was just killed is read as a terminal and SPAWNS A SHELL there. The
review pane must use the control socket and never attach by id; widen the whitelist before it ever does.

**The view LISTS, a review SHOWS.** `scm/SourceControlView.tsx` is ONE body for both hosts, the dock's
`scm` view on a desktop and the drawer's fourth segment on a phone, and it only lists: a row hands
`{ group, path, oldPath }` to its host (`onOpenFile`), and the diff is a `review` tab in the content
area, never drawn inside a 300px dock. It starts with NO project. A project is an absolute path the
user types, validated by `/scm/repo` and stored as the canonical top that answer returns; nothing is
inferred from the server's cwd, a terminal or an open file. **`scmRepos` is SYNCED** (canonicalised
with `normalizePin`: the paths are on the server's filesystem, so the same list is right on every
device, like `explorerPins`) and **`scmActiveRepo`, `scmLayout`, `scmAlgorithm`, `scmWrap` and
`scmTree` are LOCAL** and never join `SYNCED_KEYS` (`settings.test.ts` pins both halves), because which project this
device reads and how it draws or lists a diff are preferences of the screen in front of you. The synced list
leans on the server's settings MERGE (see "An older window no longer erases keys it does not know"),
which is what lets an explicit `[]` empty it while an older window's save cannot. The groups are kit
Collapsibles whose open state is per device (`palmux-scm-group-<id>`), rows activate on pointer UP
(`pressMove`, they live in a scroller), and a conflicted file opens the Changes review. **Opening a
file never creates a second review**: `App.openReview` selects the live tab whose url is
`reviewUrl(group, repo)` and otherwise sends `createTab`, coalescing its own pending creates per url
for `PENDING_REVIEW_MS`; either way the file to scroll to is parked in a ref map keyed by the url
(read and cleared by the pane, the way the tmux target is) and `reviewOpenTick` is bumped, because a
mounted pane has no other way to hear that its tab was chosen again for another file. The controller's
`tabCreated` only clears the New-tab page and navigates to the answered id; with editor groups the
hook's `show` activates a tab a pane already holds where it is, so the idempotent answer never
duplicates or moves a live review (`workspaceController.test.ts` pins the two effects).

**Each group is a folder TREE by default, and the tree lists files in the review's order**
(`scm/scm-tree.ts`; the same `SourceControlView` draws it in the dock and in the drawer). `scmTree`
(LOCAL, default true) flips every group to the flat list, which is the old view unchanged; the choice is
an `IconButton` in the project bar ("View as list" / "View as tree", the `sessions` and `folder` glyphs:
`ui/icons.tsx` has no dedicated pair). The view follows the setting through the settings pub/sub, as
`EditorPane` does, and writes it back through `onChange`, so neither host passes a prop for it.
**The tree is built FROM the entry list, in order.** A folder is created when its first file is met and
sits where that file sat; its children keep the order they were met in. Nothing sorts, and folders do NOT
come first, because the review walks the same list (`[...merge, ...changes]` for Changes, `staged` for
Staged) and "next file" has to follow the rows. The SERVER sorts each group by path, in code-unit order
(`toEntries` in `scm-status.ts`, pinned by `puts each group in path order`); git itself prints every tracked
change before the untracked files (measured: 55 then 94), so the guarantee is the server's, not git's. A folder's
files are therefore contiguous and the two orders are the same; only a list that is NOT sorted gathers a folder under its first file, which `treeOrder` computes and a
test pins. **A chain of folders holding one folder is one row** (`packages/client/src/review`): the collapse
key is the DEEPEST folder's path, a folder that also holds a file never joins a chain, and the name is drawn as
a shrinkable head and a fixed tail (`scm-chain-*`) because the folder a row is about is its last one, which
an end ellipsis would have cut first in a 300px dock. A file and a folder may share a name (a typechange leaves
both in Staged), so row keys are `f:<path>` and `d:<path>`; a nested repository listed as `vendor/inner/` keeps
its slash on the name. The folder row is a real `<button>` with `aria-expanded` and an `aria-label` that says
its file count, the chevron turns on the micro tier, and a file row keeps the chevron's column empty so its icon
stands under its siblings' folder icons. **It is `pressMove`, so Enter and Space are the button's own click.**
ArrowRight expands a collapsed folder; ArrowLeft collapses an open one, and from a collapsed folder or a file it
moves focus to the parent; any other arrow, or one with a modifier, is left to the browser. Focus is requested
by key and taken by the row as it mounts, because a long group draws only the rows near the view: the parent is
scrolled in first (`scrollToRow`), measured in a 600-row group where it was 30 rows out of the window.
**Which folders are collapsed is per device, project and group** (`palmux-scm-collapsed`, `{v:1, byRepo:
{[top]: {[group]: paths}}}`, forgiving parse, swallowed storage errors). Every write is ONE change applied to
what is stored now, never a mount's whole set (the Explorer's rule: the dock and the drawer can both be live). It
is NEVER pruned against the current tree, because no listing is proof that a folder is gone: a folder with no
changes today comes back collapsed when its changes do. A cap of 500 per group, oldest first, bounds it instead.
A group is keyed `<repo>:<group>`, so a project switch remounts it and re-reads. **`LONG_GROUP_ROWS` counts the
group's FILES, not the rows a tree shows**, so folding a folder never swaps the virtual list for plain rows under
the user's focus; `.scm-vlist` is `min(60vh, --scm-rows × --scm-row-h)`, so a mostly folded long group does not leave a
tall empty box (verified: 5 rows are 140px on a desktop).

**The changed-files list is compact on a phone** (owner, 2026-10-26: the drawer's tree was too large, 36px
rows and a 12px indent a level; and, when 32px rows looked the same to him, "needs to be compact" again).
`scm.css` states a row's metrics once, on `.scm-view`: `--scm-row-h` (`--ctl-h`), `--scm-indent` (`--sp-3`)
and `--scm-gap` (`--sp-2`), and `:root[data-mobile='true'] .scm-view` restates the three for a phone as
`calc(var(--ctl-h) - var(--sp-3))` (24px), `--sp-2` (8px a level) and `--sp-1` (4px between a row's chevron,
glyph and name). The rows, the folder rows and the virtual list's height cap all read them, so they cannot
disagree, and the desktop is exactly what it was (28px, 12px, 8px). **There is no gap between rows**: a row
and a folder row declare no margin, the plain list is an unstyled box and the virtual one only caps its
height, so the pitch is the row's height (a test holds that). The text was already the body size, `--fs-2`
(12px), so a row's text is unchanged and the saving is the height and the indent. A file four folders deep
starts its name 16px further left than at 12px a level, and the drawer's 275.5px row (390px, three quarters
of it, less the border and padding) leaves room for ~27 characters after it. Measured in Chromium at 390x844
with a 102-row tree (89 changed files, every folder open): rows 24px (were 32px, and 36px before that), 25
rows fully on screen above the footer (were 18). **The three group headers** (Merge Changes, Staged Changes,
Changes) are the kit's Collapsible trigger, which a consumer cannot size: `scale.test.ts` fails any
stylesheet but `ui.css` that sizes a kit control, and `--ctl-h` may not be redeclared in a subtree. So the KIT
has the step: `Collapsible` takes `size="xs"` (`.ui-collapsible-trigger-xs`, `calc(var(--ctl-h) - var(--sp-3))`,
one step below the small one Button and IconButton have), and `GroupSection` asks for it only in the mobile
layer, through `useMobileLayer` (`review/review-density.ts`, the `data-mobile` flag the review's compact rows
read). On a phone a header is 24px, the rows' own height; on a desktop it stays `--ctl-h` (28px), which is the
rows' height there. The view has to KNOW, unlike the rows, because a kit control's height is a class the kit
owns, never a property a consumer sets. **The guard learned the step**: `scale.test.ts`'s `boxOf` is the table
of kit steps (`-sm` is `--ctl-h` less 4px, `.ui-seg-item` less 6px), and `-xs` is `--ctl-h` less 12px (24px on
a phone, 16px on a desktop where nothing opts in). That one line is the only edit to the guard; without it a
new kit step cannot exist, and the alternative was sizing a kit control from `scm.css`, which is what the guard
is there to stop. An earlier build opted into `size="sm"` (32px, the small step), which is gone.

**The review pane is a flat array of rows on one `VirtualList`** (`review/ReviewPane.tsx`; what it
keeps that is not React state is `review-model.ts`, and React sees a version number and the rows).
`rows.ts` turns a status entry and, once fetched, its snapshot into rows of ten types: `fileHeader`,
`notice` (binary, too large, converted, unmerged, rename, mode, symlink), `placeholder`, `hunkHeader`,
`gap`, `line` (unified), `split`, and three that carry comments, `comment`, `editor` and `unplaced`.
Every row carries its file's `path` and a `key` unique across the whole list (`<path>|file` for a
header), which is how a visible row maps back to its file and is recognised again after a rebuild. A
split row pairs the i-th removed line with the i-th added one inside each change block and leaves the
rest alone (GitHub's pairing); only a paired row gets inner marks. An unchanged line in unified takes
the new side's number. Hunks are git's, and the hidden lines between them (and before the first, after
the last) are a `gap` that reveals 20 lines at a time from either end, out of the full side texts the
snapshot already carries. Rows are built PER FILE and cached under a signature of everything that shapes
them (the snapshot key, layout, collapse, reveals, comments and drafts, the entry's fingerprint), then
concatenated, so one snapshot landing rebuilds one file and the other 399 keep their arrays. A file not
fetched yet is one `placeholder` whose height is estimated from the status counts (changed lines plus
three context lines a side, at 20px; a binary or mode-only file is one row), and its header already shows
the counts.

**Row heights are exact, not measured by index, and this is where measurement overruled the design**
(D6 said `useDynamicRowHeight`). Heights keyed by index go stale the moment a rebuild shifts the rows (a
file loads above the viewport, a gap opens), and a placeholder several thousand pixels tall would skew
the average every unmeasured row falls back to. So `review-metrics.ts` derives a height from the row and
hands react-window a function: fixed for every row whose height is known (`ROW_METRICS`), an estimate
for a row that wraps until the browser has measured it, then the measured height keyed by the row's own
`key`, never its position, in a map that restarts whenever `layout|wrap|width bucket|code size` changes
(64px buckets). `review.css` declares the same numbers as `--rv-*-h` custom properties written from the
`--sp-*` scale (a custom property is a declaration `scale.test.ts` cannot see, and spelled from the scale
it cannot be off it), and `review-css.test.ts` resolves each and holds it equal to its twin: a row drawn
taller than it was sized overlaps the next, and no type error says so. They are not `--ctl-h`, which is
28px on a desktop and 36px on a phone, because this geometry is a number JavaScript must know. Nothing
in the pane animates: it is the busiest surface in the app, and a transition on a row is work per frame.

**On a phone the structural rows are shorter, as a second exact table, and a hunk has ONE divider row**
(owner, 2026-10-26: "too much lost space" with the gap rows marked, and "more compact" again when 28px + 20px
rows looked the same to him). `COMPACT_ROW_METRICS` is `ROW_METRICS` with a file header of 28px (40), a gap of
20px (32) and a hunk header of 20px (24), one code line each; a code line, a notice and an error row are what
they were, so the code keeps its size and the rows between code lines are what gave way. It is chosen by
`HeightContext.compact`, which the pane takes from `useMobileLayer()` (`review-density.ts`): the same
`data-mobile` flag on `:root` that raises `--ctl-h`, read through `useSyncExternalStore` over one
`MutationObserver` on that attribute, so a change of the mobile mode while a review is open takes effect at
once. It keys on the device class and NOT on the pane's width (as `review-layout.ts` does for the layout),
because a phone held sideways has a wide pane and still has little height. The pane writes `data-dense` on
`.rv-frame` from the same value, and `.rv-frame[data-dense='true']` restates `--rv-head-h`, `--rv-gap-h`,
`--rv-hunk-h` and `--rv-chip-h` from the scale; `review-css.test.ts` resolves that block and holds it equal to
`COMPACT_ROW_METRICS` the way it holds the first block to `ROW_METRICS`, and `review-metrics.test.ts` and
`ReviewPane.test.tsx` hold the sums (each row starts where the one above ends; landing and stepping put a
file's header exactly at the top with the shorter rows). Measured heights are not keyed by it: it changes
fixed heights and which rows exist, never a wrapped row's measure.
**The divider is merged in the MODEL, not hidden in CSS.** A hunk used to be two rows, a gap ("27 hidden lines
↑20 Show all", 28px) and a hunk header ("@@ -28,6 +28,7 @@ context", 20px), 48px a hunk. `RowsOptions.merged`
(`rows.ts`) makes the gap row with hidden lines carry the heading of the hunk below it (`GapRow.hunk`, a
`HunkLabel`: the hunk's number, git's heading and the range) and does not build the header row it replaces.
So a divider is one row, 20px, in the order count, controls, heading, and the heading is the part that gives
way (`flex: 1 1 0; min-width: 0` and an ellipsis); the count and the controls stay whole. A hunk with nothing
hidden above it (the file's first line, or its gap fully revealed) has no gap row to ride on and keeps its own
20px header row; the trailing gap has no hunk below it and is the count and controls alone. The row keeps the
gap's key, `gapIndex` and counts, so expanding, anchoring and landing read it as before, and the revealed
lines keep their order (above the row, between the heading and the hunk's own lines). `ReviewModel.getRows(layout,
merged)` takes the merge as an argument like the layout (a state change would notify subscribers mid-render),
keeps the last answer for a caller that names none, and keys each file's cached rows by it; the pane asks with
`compact`. The desktop keeps two rows, the kit's buttons and 40px headers. **A control of a structural row is a
plain `.rv-chip` button on a phone** (`RowButton` in `ReviewRow.tsx`; the gap's three controls, and the file
header's Reviewed/Unstage and Open file), `--rv-chip-h` tall, which is the divider's own 20px, because the
kit's small button is `--ctl-h` less a step, 32px, and fits neither the 20px divider nor the 28px header, and
the kit's sizes may not be restated outside `ui.css`; on a desktop they are the kit's Buttons still. The chip
reads as the ghost variant (hairline, secondary text, a press that fills; the primary one wears the accent
under its ink like the kit's primary button) with an inset focus ring, and keeps its test ids, accessible names
(Open file is icon-only and carries `aria-label`), `disabled` and `title`; on the divider it pads 4px a side and
the row's parts sit 4px apart, so the heading keeps the room. The state word beside the counts ("Modified") is
hidden by CSS on a phone (the letter keeps it as its `title`, and `.rv-current` above the list names the
file): it was what truncated the path to eleven characters. Measured in Chromium at 390x844 with a seven-hunk
`keybindings.ts` review (the same list height, 734px): each divider 20px (was 48px, a 28px gap and a 20px hunk
header), the file header 28px (36px), the review bar 37px, lines fully on screen 23 (21). The heading is what
the owner pays for: with all three controls on the row about twenty characters of it fit at 390px, which is
the hunk's range and the first word of its context.

**The code size is the DEVICE'S, apart from the terminal's, and a code line is the only height that moves**
(`codeFontSize: number | null` in `settings.ts`). The terminal font is a pinch away on a phone, and a diff
that shrank under a pinch meant for the shell is not what anyone wants, so the review's lines, line numbers
and inline marks read their own setting. It is local like `fontSize`: not in `SYNCED_KEYS`, so it never
reaches the server or the dotfiles-tracked `settings.json` (`settings.test.ts` pins that, down to a
byte-identical synced payload across a change, and `App.test.tsx` that a real change sends nothing), it
takes the terminal's range (6–48, `clampFontSize`), and the sanitiser turns anything that is not a finite
number into `null`. **`null` is "never chosen", and the review keeps what it always drew** (12px, `--fs-2`,
`DEFAULT_CODE_FONT_PX`), which does NOT follow the terminal: a review that began following it the day this
setting arrived would be a jump nobody asked for. The editor's null is different (see the Monaco notes), so
a first tap of minus in the review writes 11 and the editor, which was at the terminal's size plus one,
moves to 11 with it; that is one setting meaning one size once it is set. The pane writes `--rv-code-fs`
and `--rv-code-lh` inline on `.rv-frame` from the same `codeLineHeight` (`round(size × 20 / 12)`, so 20px
at the default and always whole pixels) that `review-metrics.ts` hands react-window, so the sheet and the
list are given one number and cannot disagree; the sheet declares the default pair for a frame without
them and `review-css.test.ts` holds it equal to `ROW_METRICS.line`. Only `.rv-line` and `.rv-split` read the
pair, so a file header, hunk header, gap, notice and comment are chrome and keep their heights whatever the
code is drawn at, and `.rv-no`/`.rv-sign` follow because their widths are in `ch`. The measured-height map
is part of the geometry key, so heights the browser reported at the old size are dropped and a wrapped row
is estimated afresh (`textColumns` uses the size's advance, 0.6em) until it is measured again; the scroll
anchor holds across a change because the pane already restores it on every new geometry, by the same
distance from the top. What it does not repair: a placeholder remembers the pixel height its file had when
it was evicted, and keeps it until the file loads again, as it already did across a layout change.
**The control is a stepper in the view menu, and in the bar when the pane is wide.** Below 500px it is the
kit's stepper row in the ⋯ menu (Smaller code, the value, Larger code; the menu stays open, so two taps
are two steps), above it the same minus, value and plus sit at the end of the bar. The bar has room only
from a body of about 762px, so a pane between 500 and 762px now wraps the controls onto a second row where
it used to wrap only below about 662px; that is the wrap the bar was always allowed, and the compact menu
was not widened to avoid it. Measured at 1440 and at 390: rows aligned to the pixel at every size from 10
to 16, the terminal grid unchanged (`stty size` the same at 9, unset and 30), and the value surviving a
reload.

**Fetching follows the viewport, and memory is bounded** (`review/file-queue.ts`, a framework-free class
with an injected `fetch`, D7). `onRowsRendered` reports the first and last visible row, the model maps
them to files, and the queue wants every file within `FETCH_WINDOW` (2) files of that range, nearest
first, with at most `FETCH_CONCURRENCY` (4) requests in flight. One `/scm/file` answer carries the hunks
AND both sides' text, so a file's lines, colours and comment positions always describe one version. It
keeps `MAX_LOADED_FILES` (60) files and `MAX_LOADED_BYTES` (40 MB, the `.length` of both sides' text),
least recently used first, and an evicted file goes back to a placeholder holding the height its rows were
last DRAWN at (`measureRows`), so the scroll position does not jump (a file removed from the group is
simply gone). A loaded file is refreshed wherever it is when it goes stale (its `fp`, the status's
`attrEpoch` or the algorithm changed), because a stale snapshot that scrolls into view must not show the
old version, and eviction cancels a refresh nobody is looking at. An unmerged file is never fetched (no
stage-0 blob); a failed file keeps its message and a Retry, and scrolling away and back retries it. A
hidden review or a paused one starts nothing (`setEnabled(false)`, answers in flight still land) and
takes no new entries until it is shown; `load()` is the one door that ignores that, because next change
into a file that is not loaded yet is a person asking. **Every request belongs to a per-file generation.**
Anything that changes what a file should show starts a new one (`supersede`: bump it, abort the
controller), and an answer from an older generation is dropped, so a slow response never overwrites a
newer version. The cap counts a superseded request until it SETTLES and not until it is aborted, so "at
most four in flight" holds for a fetch that ignores its abort signal. An answer with the same
`snapshotKey` (`version|algorithm`) as the one held lands as `changed: false`: only the staging token was
renewed, and no rows or colours are rebuilt. `version` is algorithm-free by design, so the algorithm joins
it in every cache key.

**Scroll anchoring relocates by TEXT, not by line number** (`review/scroll-anchor.ts`). Row indices mean
nothing across a rebuild, and neither do line numbers once the file changed: ten lines inserted above
must leave the same code in view. The pane captures an anchor on every scroll (a passive listener, and a
hidden pane's scroller reports a zero offset that is not the reader's, so it is ignored): the first
visible row's file, side, line number and pixel offset, scanning up to 12 rows below the top because
headers and gaps come first, or the file's header when a placeholder is at the top, which stays and so
opens the view onto the first lines of what loaded. When a snapshot is REPLACED the model calls
`onReplace` while both texts are at hand, and `relocateAnchor` finds the line again with the same function
that places a comment (`anchor.ts`): every exact match of the line's text is scored by how many of three
context lines either side agree, then by distance from the old number, and **the old position gets no
head start**, because a `}` or a blank line left at the old number must never beat the real line ten
rows down; a tie is not a guess. A deleted line falls back to the nearest surviving line of its hunk, then
to the file header. After every rebuild a layout effect sets `scrollTop` to the row's top minus the
recorded offset when that differs by a pixel, and a layout or wrap switch is a rebuild like any other, so
it holds the reader's place too. **A programmatic scroll is a REQUEST, not a write** (next change, next
file, Reviewed moving on, a Source Control row): it stores a row key and bumps a counter, and the same
layout effect applies it once the rows it names exist, falling back to the file's header when the row
was rebuilt under another key.

**A jump has to LAND, and a scroller sized from an average cannot hold one.** react-window 2.3.3 sizes
its scroller with one in-flow `aria-hidden` spacer, the list's last child, as tall as its ESTIMATE: the
row count times the average height of the rows it has laid out so far (read in its dist: the bounds cache
fills lazily from row 0 to the furthest row it has drawn, and starts over whenever the `rowHeight`
function changes, which is every new geometry). A review's rows run from a 20px line to a placeholder
thousands of pixels tall, so that average is rarely the real one, and it errs both ways. Too SHORT, and
the browser clamps a jump past the estimate to the end of the content it was given, so the view stops
short of the file: `in a group whose files are not the height they were estimated at`
(`ReviewPane.test.tsx`) is the shape that failed on a real screen, placeholders estimated from the
status counts far from the rows they turn into and a target past what react-window had sized for. The
answer is `.rv-extent`, a 1px box inside the list, absolutely positioned at its top, `visibility:
hidden` and `pointer-events: none`, as tall as the geometry's real total (`offsets[rows.length]`): an
absolutely positioned child still counts toward the scroller's scrollable overflow, so it raises the
scroller to the rows. Too TALL (the rows laid out first are taller than the rest), and the reader
scrolls past the last file into blank space, which the extent box alone cannot take back, so the sheet
also takes react-window's spacer out (`display: none` on `.rv-list > [aria-hidden='true']:not(.rv-extent)`)
and the extent box is the ONLY thing that sizes the scroller, in both directions. Measured in the
happy-dom browser model, not on a device: a 16,120px placeholder over 99 one-line files made the spacer
337,600px over 33,980px of rows, and End without the rule put the top of the view 303,020px below the
end of the last file.
The rule leans on react-window's DOM, so the model does not name the spacer: `browserScrolling`
(`review-test-support.tsx`, which clamps an offset as a browser does and reports it a turn later)
reads the `display: none` rules for list children from `review.css` and applies them with `matches()`
to react-window's real elements, and `the scroller is exactly as tall as the rows` fails if an upgrade
moves the spacer or drops its `aria-hidden`.
Four more things keep a landed jump where it landed. **A file's header lands as ITSELF**: `land()`
records the anchor as the header row (`kind: 'row'`), not the first line found near it, because the
files above it are mostly placeholders that each move it when they load or measure differently from
their estimate, and the notices under it do too. **The echo of the pane's own write is skipped**: every
programmatic offset goes through `writeScrollTop`, which keeps in `writtenTop` what `scrollTop` reads
back after the write (the browser may round or clamp it), and a `scroll` event within 1px of that is
the browser reporting the write, not the reader moving. Read as the reader's, it would replace the
anchor with whatever row sat at the landed offset, and the view would go off with that row as the rows
above load; any other offset clears `writtenTop`. **The restore runs INSIDE the list**: `BeforeList`, a child of the
`VirtualList`, runs `restoreView` as its layout effect, because React runs a child's layout effects
before its parent's and react-window picks the rows it draws in a layout effect of its own, from the
scroller's offset at that moment. Restored from the pane, react-window would read the offset a rebuild
left behind, draw the wrong place for a frame and report those rows, and the queue would fetch the files
there, each of which moves the view again as it loads. **`.rv-list` sets `overflow-anchor: none`**: the
browser's own scroll anchoring shifts the offset when content above the view changes size, which is
the change the pane already corrects, and two corrections for one change fight each other.

**Layout is by PANE width, and the observer reports only the crossing** (`review/review-layout.ts`).
Below `REVIEW_SPLIT_MIN_PX` (720) a review is unified, because two readable code columns need room, and
the rule keys off the pane and not the device for `editor-layout.ts`'s reason: the dock is 300px on a
desktop too. `observeReviewWidth` reports a change only when the width crosses the threshold, and once at
the start, because re-laying out a review on every frame of a dock animation is the resize storm the
motion rules forbid; a hidden pane measures 0 and is ignored, since panes stay mounted and that happens on
every tab switch. `scmLayout` (`auto` | `split` | `unified`, per device) overrides the rule. **Split always
wraps** (two half-width columns cannot share one horizontal scroll); unified follows the Wrap toggle
(`scmWrap`, where `null` follows the width rule: wrap exactly when narrow). Unwrapped lines make the list
scroll sideways and a file header is `position: sticky; left: 0`, and a sticky box needs a parent as wide as
the scrolled content to have room to stick in, so the other rows are given the width of the widest LINE on
screen (`--rv-scroll-w`) and their controls the view's width (`--rv-view-w`). Both are read from the lines
once a frame and never from the scroller's own `scrollWidth`, which the rows given that width would hold
up for ever, and both are REMOVED when lines wrap, since a width left over from no-wrap would hold every
sticky box at the width the view had then. A current-file bar over the list names the file of the first
visible row. D6 also made it the phone's file switcher, and it is not: the review bar's Files button
opens the file list in the drawer, so the bar stays a label.

**Colouring uses Monaco's tokenizer over the WHOLE side, and lines render plain first**
(`review/colorize.ts`, `line-html.ts`, `inner-diff.ts`). Each side's full text goes through
`monaco.editor.colorize(text, languageOf(path), {})` and is split on `<br/>` into per-line HTML. It is the
whole side and not the hunk so that a line inside a block comment that starts above the hunk is coloured
as a comment; it is the same 23 grammars and the same `palmux` theme as the editor and the markdown
viewer, one colour source for all three. Nothing imports Monaco at module load: the loader is a dynamic
import reached only when a side has a grammar to colour with, so a file with none, an empty side and a
side over 20,000 lines (`MAX_COLORIZED_LINES`; the snapshot's 1 MB limit is already behind it) never load
the chunk, and a terminal-only session still downloads none of it. Work is one job at a time through
`requestIdleCallback` (a 1 s timeout so a scroll that never idles cannot starve it, `setTimeout` where it
is missing), with the two sides coloured one after the other because both at once would be one long task on
the main thread. **The cache is keyed `path` + `version` + `side`, and the path is part of the key**
because a version names a pair of blobs and not a file: a copy not yet edited, or two identical new files,
share one. Keyed by version alone, forgetting one file erased the colours its twin was drawing, and a
plain-text twin's "stays plain" entry kept a file that has a grammar plain. A line renders plain, then
swaps to coloured HTML with NO change of height, which is why the two shapes must lay out identically:
Monaco expands a tab to 4-column stops and writes every space as `&#160;`, so plain text is expanded the
same way and the markup has its `&#160;` turned back to spaces, and `white-space: pre-wrap` keeps both.
Inner marks (the changed characters between a paired removed and added line) are computed here and not
by git (`--word-diff` is a non-goal), on the SOURCE text, between lines the rows model already paired:
word and punctuation tokens, the shared head and tail trimmed, then an LCS bounded to lines under 400
characters and 10,000 comparison cells, because this runs on the main thread while a phone scrolls. They
are spliced into Monaco's markup only if its decoded text is exactly the line; a markup that disagrees
with the text it claims to colour is drawn without marks and never with misplaced ones. Nothing from the
file is inserted as markup: plain text goes through React and the markup is Monaco's own escaped output.

**The theme bridge is a subscription list, and a pane recolours only on a REAL palette change**
(`panes/monaco-theme.ts`). `applyThemeTokens` publishes the profile through `setEditorProfile`, which was
one listener that `monaco-loader.ts` occupied with `applyTheme`; it now notifies a list, and
`onEditorProfile(cb)` adds one and returns the way to remove it. Listeners run in registration order,
except that a subscriber that asks for `{ first: true }` sits ahead of the rest, and **the loader asks**:
it registers only when Monaco first loads, which can be long after a review pane subscribed at mount,
so plain registration order would put it second, and `colorize` reads whatever theme Monaco holds at that
moment (Monaco's theme must be defined before a review recolours). One subscriber that throws does not
stop the others (the first failure is rethrown once everyone has run), so a review that failed to repaint
cannot leave Monaco's theme undefined, or the reverse. A pane subscribes on mount and unsubscribes on
unmount, so a closed review stops listening. **App publishes the profile on every `themes` message, which
every reconnect brings**, so the pane compares what it drew with (`JSON.stringify(buildMonacoTheme(profile))`)
against the latest one and a palette equal to the drawn one is no change at all: only a different one
clears the colour cache and requests the loaded snapshots again (`model.recolor()`). A hidden pane draws
nothing, so it records the latest palette and recolours in a LAYOUT effect when it is shown, so the old
colours never reach the screen, and N hidden reviews do not each colour their files at the instant a
theme changes (a hidden review that saw the palette change and change back draws nothing at all). Tests
hold that every open review updates on one profile change, that a closed one stops listening, and that
an equal palette recolours nothing.

**Only the ACTIVE project is read, and a paused review shows and does not write.** The status store counts
a subscriber only when it is visible AND on `scmActiveRepo`, so two reviews of two projects never mean
two reads. A review of another project (the unfocused half of a split, or one the dock has since moved
off) draws the last status it retained under a `Paused · Make <name> active` bar and issues no request;
a review of a project removed from `scmRepos` is a notice ("Project removed") and never reads again unless
the project is added back. Focusing a review makes its project active, in an App effect keyed on the
focused tab and its repo and NOTHING else, so choosing another project in the dock while the review stays
focused is not undone by the next tab broadcast (the review is then paused until it is focused again); a
removed project is never made active, and with several panes only the focused pane drives it, because
`sessionId` is the focused pane's active tab. Reviewed, Unstage and comments are gated on the review being the written one, because the
comments store holds the active project's comments only: a comment saved from a paused review would land
in the other project.

**Six chords, and they are letters, not F7** (`keybindings.ts`): Ctrl+Alt+G `openSourceControl`,
Ctrl+Alt+J / Ctrl+Alt+Shift+J `scmNextChange` / `scmPrevChange`, Ctrl+Alt+N / Ctrl+Alt+Shift+N
`scmNextFile` / `scmPrevFile`, and Ctrl+Alt+Enter `scmReviewed`. VS Code's F7 is out because GNOME takes
Alt+F7 (move window) before the browser sees it and a Mac's F-row is media keys; VS Code's Ctrl+Shift+G
for Source Control is out because it is `copyLastOutput` here and `matchAction` answers the FIRST match, so
reusing it would make one of the two unreachable. Ctrl+Alt+K stays `downloadFile`. The model is one `Chord`
per action end to end (`DEFAULT_BINDINGS`, `loadBindings`, `matchAction`, the panel), so each action has
exactly one default, and a test asserts every default chord is unique and that `copyLastOutput` keeps
Ctrl+Shift+G. **The five review actions are wired only while the active tab is a review**, found by tab id
through `review/review-registry.ts` (a ref registry like `panes/editor-registry.ts`, read when the key is
pressed so a handler never re-binds as a pane re-renders), so with any other tab focused the chord falls
through to the terminal and the palette does not offer them, and a hidden review ignores them.
`openSourceControl` is the exception: the dock view on a desktop, the drawer's view on a phone, and one
function behind the chord, the palette entry and the review bar's Files button. A CHANGE is one block of
changed lines; a file with no line to show (binary, too large, converted, conflicted, a mode change, a
pure rename, collapsed) counts as ONE change at its header, so stepping never passes a file in silence.
Next change at a file's last change goes to the next file's first, FETCHING an unloaded file first
(`findChange` answers `load`, the pane awaits it and looks again; a file that cannot load becomes a stop at
its header). A jump lands three lines above the change so its context shows, which means the row at the
top afterwards is not the change, and reading the top row would make "next" land on the same one:
`landedRef` remembers where the last jump left the view and, while `scrollTop` is still there, that is the
position; once the reader scrolls it is read from the offset. Previous file from inside a file goes to its
own start first, like a media player.

**Reviewed, Unstage and Undo** (`review/review-writes.ts`, `write-log.ts`). Reviewed in a Changes review
stages the version the review SHOWED (the snapshot's token) and then jumps to the next file, the one that
was next in the list before this file left it; the same key in a Staged review is Unstage, and the status
is re-read at once so the reader does not wait a second for the file to leave. A 410 `token` is not an
error to show: the file is fetched again and, when its `version` is unchanged, the stage is retried ONCE
with the new token and the reader never knows; a different version is shown with "changed since you
looked" and nothing is staged, because the newer change must be seen before it is called reviewed. Each
refusal says what to do (`describeFailure`: `busy` is `index.lock` and nothing waited, `conflict`, `changed`,
`unsupported`, `df`). Reviewed is disabled WITH its reason for a conflicted file, a file not loaded yet and
a snapshot with no token (too large, converted), and there is no fallback that stages what was not shown;
Unstage needs no snapshot, so a staged file palmux cannot read can still be unstaged. **A file with a
comment open on it is not staged or unstaged until the comment is saved or cancelled**, because the write
takes the file out of the review and the open editor with it: its text stays in the store but nothing would
draw it, and the reader would watch the comment vanish unsaved. The Undo toast holds 6 s, and the writes of
those 6 s are kept in `write-log.ts` because the app has ONE toast and a second write used to replace the
first one's: its Undo silently gone while the file it staged stayed staged. The toast names them all ("Staged
2 files"), one Undo restores them newest first, each a compare-and-swap on its own receipt, and it STOPS at
the first refusal and says how far it got, because undoing out of order would restore an older entry over a
newer one. The log is module state on purpose (two reviews of a window share the one toast) and holds
receipt ids and names only; a receipt is restored in the project that issued it.

**Comments on the client: the store is the window's, a version is provenance, and display is
content-driven** (storage and validation are in the comments paragraph above). `review/comments-store.ts`
holds the ACTIVE project's comments in `useSyncExternalStore` shape and REPLACES its state with each answer
(every read and write answers the whole list and its `rev`), dropping any answer whose `rev` is not newer
than the one applied, so two windows converge whatever interleaving the server saw. **It polls nothing.**
It learns of another window's write from the `scmComments` frame (App feeds `observeRev`), from
`commentsRev` on every status answer (`connectCommentsToStatus`, the backstop for a missed frame) and from
a `refresh()` on every `ready`, since frames were missed while the socket was down; a newer rev refetches
only while a subscriber counts (visible, on the active project), so a hidden view costs no request and
catches up when shown, and a failed read retries on the next frame or answer, never in a loop. That is what
keeps the 2-second promise when a slow repository stretches the status interval. **A comment's `version`
(`head` | `index` | `worktree`) is the content the commented side showed** (`versionOf`: Staged compares
HEAD with the index, Changes the index with the work tree), and it is provenance, not an address.
`placeComments` tries both sides of the open review, the side that shows the comment's own version first
(else the side it was made on), and draws it on the first where `anchorLines` finds it, one side per
comment; a tie for best counts as not found there. So the flow the owner uses, comment on Changes, tap
Reviewed, open Staged, still shows the comment on Staged's new side, where the same lines now are. A
comment found nowhere is OUTDATED and never moved onto a neighbour: it is listed at the end of its file
with the code it was about quoted. Two more reasons a comment is listed and not drawn on a line: its lines
sit in a gap nobody expanded (`hidden`, with where the anchor found it), and palmux never read the file
(`unread`: too large, converted), which is NOT outdated, since nothing says the code left, and the export
says "not shown" for it. **What a comment is about is captured when its editor OPENS, not when it is saved**
(the lines and three of context a side): a file edited while the comment is typed must not move it onto
whatever now sits at those numbers. **Drafts live in the store and not in the pane**, because the review is
virtualised and the editor row unmounts when it scrolls away; a draft is keyed by path, side, range, the
comment it edits and its SCOPE, the group, because a project's Changes and Staged can show the same lines
and two editors must not type into one draft. An edit of a stored comment is a draft of its own; if another
window deletes that comment while it is open, the editor says so and offers Save as new (on the code the
draft kept) or Discard, instead of saving into a comment that no longer exists, and no edit is drawn
until the comments have loaded, or it would look deleted. A range is picked on the line NUMBERS of one side
of one file (a comment belongs to one of each): drag across numbers or shift-click on a desktop, tap then
tap on a phone (a long-press would fight the browser's own text selection; the first tap already picks one
line, so a one-line comment is one tap and Comment), Enter or Space on a focused number with a keyboard,
Shift to widen. The editor is a real `<textarea>` so the soft keyboard and IME work as anywhere; Escape
cancels it, and focus returns to `#mobile-kbd` after a save or cancel only if that held focus when the
draft opened (recorded per draft in the pane, since the editor unmounts). Delete asks once, and only for
a non-empty body. **Export** (`export-md.ts`, "Copy comments" in the view) writes files in path order, a
comment as `**L10–14** (new)`, a fenced block in the file's language holding the STORED lines (the fence
one backtick longer than any run in the code), then the body. `copy-comments.ts` reads the snapshot of
each group a file is in and places the comments exactly as the review does, so the copy and the screen
cannot disagree: a comment is "(outdated)" only if it anchors in NONE of its file's groups, and a file in no
group, or a read that failed, marks nothing, because "unknown" must not be reported as "outdated".

**On a phone a review has a bar of its own, and it keeps the swipe** (`mobile/ReviewBar.tsx`). While the
ACTIVE TAB is a review App renders it in the extra-keys bar's slot and does not render the extra-keys bar
(which returns with the next tab that is not a review); the choice reads the active tab's kind, as the
editor routing does and not the pane registry, because panes stay mounted. Four buttons one step below
`--ctl-h` (`calc(var(--ctl-h) - var(--sp-1))`: 32px on a phone, the extra-keys bar's own 33px key): Files
(opens the drawer on Source Control), ↑ previous file, ↓ next file, and ✓ Reviewed (Changes) or ↩ Unstage
(Staged). The bar is 37px (a hairline, 2px, the button, 2px) where it was 45px, against the extra-keys bar's
67px: one key row, because a review is read on a phone and the bar's height is code it does not show (owner,
2026-10-26). Replacing the extra-keys bar was an owner decision (2026-10-25), and the bar has no terminal keys,
so nothing on it can reach a shell. **One release-time classifier handles taps and swipes, and no `press*`
helper is used**, because `press` and `pressClick` act on pointerdown and a drawer swipe that began on ✓
would have staged the file before anyone could tell it was a swipe. Pointerdown only records (and prevents
the default and captures the pointer on the BAR, never on a button, for the extra-keys bar's reasons: a
focusable capture target or a focus-moving mousedown would dismiss the soft keyboard, and here it would also
pull focus out of a comment being typed). A release within 10px of where the finger landed acts on the
button it landed on; horizontal travel past 60px is a swipe and acts on nothing; any other movement, or a
`pointercancel` (the OS's own bottom-edge gesture), acts on nothing. The release that acts marks its
gesture (`consumeGesture`), because Reviewed moves the view and the tap's trailing click would land on what
it drew, and a click with `detail === 0` (a key, assistive tech, `element.click()`) acts once. The two
thresholds are copies of the extra-keys bar's `MOVE_CANCEL_PX` and `DRAWER_SWIPE_PX`, kept so the files do
not reach into each other, and `ReviewBar.test.tsx` fails if they drift; its tests start a swipe on every
button, in both directions, and assert that none activates. **The swipes**: right→left opens the drawer,
as on the extra-keys bar, and left→right goes back to the last tab that was NOT a review (`returnTabRef`,
recorded as the selection moves, from the list as broadcast: a tab id the server has not announced reads as
a terminal, and a review just created must not be taken for the tab to return to), or to the first
terminal when that tab has closed. From one review to another it is still that tab, so swiping back
twice never ping-pongs between two reviews. List rows in the drawer's Source Control view and in the
review use `pressMove`, so a pan never activates a row (a test pans over a row and asserts it does not).

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
**`.cache/` is the one directory that carries its own ignore**: review comments live in
`.cache/scm/<sha256(project top) first 16 hex>.json`, and the first write creates `.cache/.gitignore`
holding `*` (never overwritten), so the whole directory is ignored without a line in the root
`.gitignore` that `ensureConfigGitignore` leaves alone (see "Source Control").
**`themeId` is the awkward one.** The client already withholds its purely-local settings
(`fontSize`, `codeFontSize`, `mobileMode` are not in `SYNCED_KEYS`, so the server never sees them), but `themeId`
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
  PTY (the shell can already read anything). Caps: 500 files / 256 MB per zip. The pattern is used
  exactly as given (`x` and `x ` are two files; it used to be trimmed and served the sibling), with
  `isAbsolute` on the raw string; a blank pattern is a 400, as is a relative or leading-space one.
  The one rewrite is a leading `~` or `~/`, which becomes the server's `os.homedir()` ($HOME), as a
  shell reads it, because paths are copied out of the terminal; `~user` is NOT expanded (still a 400).
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
  `markdownRoots` (realpath prefix, symlink-escape-safe) — browsing is the scoped surface. Both use
  the path exactly as given (`notes.md` and `notes.md ` are two files; they used to trim), with
  `isAbsolute` on the raw input, and each keeps its own blank rule: `md-file` blank → 400 `path must be
  absolute`, `md-list` absent OR blank → the roots overview (`trim()` only detects blank). The roots
  confinement runs on the same untrimmed path it lists. Relative
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
  **A dictation card is a HEADER over a TRANSCRIPT** (`dictation/DictationView.tsx`, which BOTH the
  dock view and the drawer's view render; `DictationHistory.tsx` is a separate modal and was not
  touched). The header is one line: `date · duration` in secondary text on the left, the actions on
  the right as compact icon buttons — play/pause, copy, insert, or Transcribe for an audio-only
  entry. The transcript sits under it at the card's FULL width, without quotes, at body size
  (`--fs-2`, line-height 1.5) and clamped to four lines with an ellipsis, with a real `Show more` /
  `Show less` `<button>` (`aria-expanded`, `aria-controls`) when it overflows; the scrubber, while a
  clip plays, goes under the text. Its length is read on `loadedmetadata` AND `durationchange`,
  because a MediaRecorder clip reports `duration: Infinity` at first and its real length only later,
  and the scrubber stays `disabled` until that length is finite and positive: a 0..0 track that took
  input would only pretend to seek. The transcript used to sit BESIDE the actions, which left a long dictation a
  ~150px column that wrapped at every other word and ran the card to the height of the dock. Two
  non-obvious calls. Overflow is MEASURED (`scrollHeight > clientHeight` in a layout effect plus a
  `ResizeObserver`), never guessed from the length: the answer depends on the card's width (the
  300px dock, the phone drawer) and on whichever font has loaded. Expanded text has no clamp to
  measure, so `overflows` keeps its last answer — which is what keeps `Show less` on screen. And the
  header WRAPS instead of squeezing: with Transcribe in place of copy + insert the pair can run out
  of room at 300px, so the actions drop under the date (pushed right by their auto margin) rather
  than breaking the date onto two lines. Cards are `--sp-2` apart and every colour comes from the
  tokens (the dashed audio-only card uses the theme's own ANSI slot 3).
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
  it up, stayed 44. A hint too long for the label column is a `note` under the row (`.srow-note`,
  `grid-column: 1 / -1`) — the Sidebar rail row's warning in the label column was a ~180px strip of
  one-word lines; that row is gone and no row passes a `note` today. There is no stacked row either:
  Import theme, the one that spanned both columns, now lives in the theme browser (see "The theme
  chooser"), where a URL or an install command gets a full-width line of its own.
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
  otherwise be its whole accessible name and hide the current value. In Match system the button
  reads `System · <dark> / <light>` (a slot never chosen reads as the fixed theme) and truncates the
  same way.
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
  **The App card is Reload app, Install as app, Latency overlay and, in the dock only, Edit
  config.json.** It lost two rows: **Sidebar rail** (the rail is always shown, so there is nothing
  to choose) and **Dictation history** (the rail's Dictation entry opens the same view, so the row
  was a second door to it; the `onOpenDictationHistory` prop is gone from the form and from both
  hosts, `App` and `SessionDrawer`). The history modal (`DictationHistory`) is still behind its
  `dictationHistory` keybinding and command-palette entry. **Import theme left the form too**: the
  Appearance card holds Theme, Font, Font size, Code font size, Cursor and Cursor blink. **Code font
  size** is Font size's twin: the same number input and range (`FONT_SIZE_MIN`/`MAX`), empty with the
  placeholder "Default" until the device chooses, and an empty field is `null` (a cleared field is
  not 0). It is in both hosts because both render `SettingsFields`, and it is per-device like the row
  above it.
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
  `reloadApp`), and the rail's app menu's Reload app. `reloadApp` reloads unconditionally, and an
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
  a change of the RESOLVED theme id via an App useLayoutEffect (useTerminal only owns the xterm canvas
  theme now; see "One RESOLVED theme id").
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
current theme's name (one line, ellipsis, the full name as `title`) and a chevron; in Match system
the label is `System · <dark> / <light>`, with the same truncation and `title`. Pressing it
swaps the panel's content for the `themes` SUB-VIEW, in place, inside whichever host holds
Settings: a `‹ Settings` back control (`settings-themes-back`), the title "Theme", then the
browser — the mode switch, an Import section, then the Dark / Light lists. It is the same shape as
the drawer's `‹ New tab` sub-surface. It replaced a Radix Select
popup because the owner asked for a full list he can browse "sem sair daquela janela", and a
300px popup over the dock was the thing being replaced; `ThemePicker.tsx`, its test and
`theme-picker.css` are deleted (the sheet became `theme-browser.css`, `tp-*` became `tb-*`)
rather than kept beside it, so there is one list and not two.
**Picking applies and the list STAYS OPEN.** In Fixed an entry calls `onChange({ themeId })`,
which re-skins the app and persists, and the browser does not close: a theme is judged by
trying two. `‹ Settings` returns to the form, whose row now shows the new name. The current
entry carries a `check` icon and `aria-current`. Entries are plain buttons, not a listbox — a
listbox promises arrow-key roving, and the popup that supplied it is gone.
**The browser has a mode, and every pick is mode-aware.** It opens on a kit `Segmented`
**Fixed | Match system** (`set-theme-mode`). Match system adds a second one, **For dark | For
light** (`set-theme-slot`: which scheme a tap fills, starting on the scheme this device is in), and
a note under it naming both slots' picks and, for the slot that is not on screen, when it will
show. Settings hold `themeMode` (`fixed`|`system`), `themeDark` and `themeLight`: SYNCED, because
"dark → X, light → Y" is one preference on every device, and opaque to the server like any synced
key (`LOCAL_SETTINGS_KEYS` stays `['themeId']`). An empty slot reads as `themeId`. `themePick`
(`settings.ts`) decides what a pick writes: `themeId` in Fixed, the edited slot in Match system. A
pick applies live ONLY when its slot is the scheme this device is in; picking the other slot
persists and changes nothing on screen. A pick for the ACTIVE slot also writes `themeId`
(`ThemeSubView.pick`): it is an explicit choice of what this device shows, so it moves the server
export exactly as a Fixed pick does. A pick for the inactive slot does not, and no boot, reconnect
or broadcast ever does. Switching mode (`themeModeChange`) changes nothing the eye can see: into
Match system an unchosen slot starts at the current theme, and back to Fixed `themeId` becomes the
theme that was showing.
**Import is the browser's own section, and its target is captured at submit.** The paste field
(`ThemeImport`, `tb-import`) used to sit in the form's Appearance card, two screens from the list
its result lands in. It is now the Import section above the Dark / Light lists, in the dock and the
drawer alike, a full-width line rather than a 140px settings row. What it accepts and does is
unchanged ("Theme import" below); what changed is where the result goes. `onImportTheme(source,
target)` captures a `ThemeTarget` — `{mode:'fixed'}`, or `{mode:'system', slot}` for the slot being
edited — when the request is sent, and App holds it in `importTargetRef` (one import at a time: Add
is disabled while `importingTheme`). `themeImported` carries no correlation id and can land long
after the user moved on, so `themePick(settings, target, id)` applies it to the CAPTURED target. A
slot switched after submit still gets the import. ANY mode change after submit SUPERSEDES it: a
fixed import landing after a switch to Match system must not write `themeId`, which would change the
export with no scheme change behind it, a slot import landing after a switch to Fixed is not
selected either, and neither is one landing after Fixed → Match system → Fixed, where the user may
already have picked a newer theme. Comparing modes at completion cannot see that round trip, so App
keeps a mode GENERATION (`themeModeGenRef`) that `importTargetRef` captures beside the target. It is
bumped where a transition is REQUESTED — `updateSettings`, and `applySettings` as each broadcast
arrives (`themeModeAfter` reads the mode a blob would leave) — not where it renders, because React
can fold two broadcasts into one render and a round trip would render as no change. A broadcast that
leaves the mode alone, an older bundle's blob without the key included, is not a transition. The
theme is still imported and appears in the list (the dir watcher rebroadcasts `themes`); it is just
not auto-selected. In Match system an import fills its slot, and an import into the ACTIVE slot also
writes `themeId`, as a pick for that slot does; one into the inactive slot does not.
**One RESOLVED theme id paints everything.** In Match system each client resolves its theme from
its OWN `prefers-color-scheme` (`useSystemPrefersDark`, a `useSyncExternalStore` over `matchMedia`:
right on the first render, live on a `change`). The scheme is the client's and never synced, so a
phone in light and a desktop in dark each show their own theme from the same settings.
`resolveThemeId(settings, prefersDark)` returns it, and it is the ONLY id a rendering path reads:
App's `applyThemeTokens` layout effect (CSS tokens, the `theme-color` meta, Monaco), the re-apply on
a `themes` broadcast, the diagnostics report, the terminals, and `main.tsx`'s pre-paint, which
resolves from the stored settings plus `matchMedia` before React mounts (reading `themeId` there
would flash the dark export on a light-scheme device at every load). The terminals needed no change
of their own: App hands each pane a `paneSettings` whose `themeId` is the resolved id, so
`useTerminal` still reads `settings.themeId` from the prop it always had — and a paint path that
read the persisted value from anywhere else would show the export's theme instead of this device's.
In Fixed the two ids are equal.
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
**In Match system `themeId` is the EXPORT's theme, and one rule writes it.** The server knows only
`themeId` — at boot, with no browser connected, it is the single theme `theme.sh`, `theme.tmux` and
the Claude theme are rendered from — so in Match system it stops being what any client paints (see
"One RESOLVED theme id") and becomes what the export follows. These write it: a system scheme that
actually CHANGES while the app is open (App's `lastSchemeRef` effect, keyed on the SCHEME rather than
the resolved id, which also moves on a slot pick or a settings broadcast — neither is a scheme
change); a pick for the ACTIVE slot; an import that lands in the ACTIVE slot; a pick or an import in
Fixed; and a switch back to Fixed, which writes the theme that was showing. These do not: a pick or
an import for the inactive slot, a superseded import (any mode change since it was submitted), a
switch INTO Match system, boot, a reconnect and a settings broadcast. Boot and reconnect matter most:
a device that opens in a different scheme from the last writer would otherwise overwrite the export
on every load, and two devices in different schemes would fight over it. So the export follows the
most recent real scheme switch or explicit choice.
**Known limit, accepted: a stale `themeId` can win the export once.** Every settings save sends
the whole synced snapshot, `themeId` included, and the server replaces it and re-exports. If device
A writes `themeId` on a scheme change and device B saves an unrelated setting in the milliseconds
before A's broadcast reaches it, B's stale `themeId` wins the export until the next real scheme
change. The server-side merge (below) does not close it: B's blob CARRIES `themeId`, so it replaces,
and the merge only protects keys a save OMITS. Closing it needs patch semantics from the client —
another restart, which ends every terminal — for a window one broadcast round trip wide whose only
effect is the tmux/Claude palette, so it is documented instead.
**An older window no longer erases keys it does not know: the settings write is a MERGE.** It used to
replace the stored object with whatever a client sent, and a window on a bundle from before a setting
existed neither reads nor sends it, so that window's next save of ANYTHING erased `themeMode` /
`themeDark` / `themeLight`, whenever it happened and not only in a race; the only defence was reloading
every window onto the new bundle before switching Match system on. `saveSettings` now shallow-merges
over what is stored and RETURNS the merged object: a top-level key the blob omits keeps its stored value,
and a key it carries replaces it, an explicit `[]` included (that is how `scmRepos` is emptied). The
`settings` handler uses that one object for the persistence, the theme export AND the broadcast, because
exporting or broadcasting the incoming blob would let a partial save without `themeId` regenerate
`theme.sh`/`theme.tmux` from the default palette and re-source tmux with it. The consequences: an older
window's save leaves `themeMode`, `scmRepos` and every other newer key in place, so no reload ordering is
needed any more; the sender is still excluded from the broadcast, so an older window never hears the
merged keys it cannot use anyway; and a key can only be removed by sending a value for it (a stale key
for a setting a later release deletes stays on disk). The ordering still matters for exactly one
interval: a server still running the pre-merge build replaces the whole object, so the merge protects
nothing until the restart that ships it (it rides the same restart as the `/scm` routes). `ws-handlers.test.ts`
pins the handler (theme, exports and broadcast survive a partial save, and a carried `[]` replaces),
`config.test.ts` the merge itself.

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

**Theme import** (`theme-import.ts` + `importTheme`/`themeImported` protocol pair). The theme browser's
Import section is a paste field accepting: the INSTALL COMMAND the Gogh gallery's Copy button gives out
(`bash -c "$(wget -qO- https://git.io/vQgMr)" -- "Everforest Light Hard"`), a bare Gogh name
(`Tokyo Night` → the Gogh raw URL, encoded NOT slugged), a Gogh gallery link (`.../Gogh/#Name`), a
github.com blob URL (rewritten to raw), or any http(s) URL. A pasted command is NEVER executed and
nothing in it is fetched — `themeNameFromCommand` treats it purely as a carrier for the quoted name
(first one wins; a standalone ` -- ` is required so `-qO-`/`-sLo-` can't match), and the URL it
carries is deliberately ignored because git.io still resolves to the pre-rename `Mayccoll/Gogh`. The
newer per-theme form (`.../installs/<name>.sh`) has no `--`, so there the URL IS used.
The server fetches (256 KB cap, 15s), parses (JSON → Windows-Terminal scheme, else Gogh), and writes
to `<configDir>/themes/<slug>.{yml,json}` named after the PARSED theme, never the URL. `watchThemes`
then rebroadcasts `themes` and the client selects the new id for the target captured at submit
(see "Import is the browser's own section"). Gogh ships YAML (`themes/*.yml`)
with `color_01`…`color_16` — **1-indexed**, so `color_01` is ansi0; `parseGoghTheme` (shared) reads
both that and the `installs/*.sh` form. `watchThemes` MKDIRs the themes dir before watching: it runs
once at boot, so a dir that first appears on an import would otherwise never be watched at all.

## Commit message prefixes

Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:` (and `ci:` for workflow
files — but do not touch CI without an explicit request).

## Known follow-ups

- No layout editor for the extra-keys bar yet (defaults + server-synced config only).
- Touch selection / mouse-encoding assumptions need real-device verification.
