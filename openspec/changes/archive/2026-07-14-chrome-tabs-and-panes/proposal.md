# Chrome-style tabs & non-terminal panes

## Why

palmux's session UI is a row of numeric buttons (`0`, `1`, `+`) that only ever hosts terminals. The
user drives multiple long-lived workspaces daily (desktop and mobile) and needs: (a) tabs that read
like a real browser tab strip — identifiable at a glance by name and color, not by remembering what
`/3` was; and (b) tabs that aren't terminals at all — embedded web pages (SilverBullet, generated
HTML artifacts), a configurable link dashboard, and a real text editor — turning palmux from "a web
terminal" into a small self-hosted workspace shell.

## What Changes

- **Tab strip redesign (desktop)**: the topbar `SessionTabs` becomes a Chrome-visual tab strip —
  trapezoid/rounded-top tabs joined to the content edge, active-tab elevation, favicon-slot (kind
  icon), title, per-tab ✕ on hover/active, `+` at the end, horizontal scroll on overflow.
- **Rename & color**: any tab can be given a custom name (overrides the OSC-derived title) and one
  of a fixed palette of colors (Chrome tab-group style — colored underline/dot, not a full repaint).
  Persisted server-side so every device sees the same names/colors. Mobile drawer rows show the
  same name/color.
- **Non-terminal tab kinds**: the server's session registry generalizes into a _tab registry_.
  A tab has a `kind`:
  - `terminal` — exactly today's PTY session (unchanged behavior).
  - `web` — an embedded page (iframe): arbitrary URL, a configured SilverBullet instance, or a
    server-hosted HTML artifact (uploaded/generated files served same-origin, which sidesteps
    `X-Frame-Options` on third-party sites — external sites that refuse framing get an explicit
    "open externally" fallback, this is a hard browser limit).
  - `dashboard` — a configurable grid of links/URLs (name + URL + icon), doubling as the
    new-tab page.
  - `editor` — a Monaco-based text editor (the actual VS Code editor component: its keybindings,
    multi-cursor, find/replace) editing a server-backed scratch file per tab. Lazy-loaded chunk so
    terminal-only usage pays zero cost.
- **New-tab flow**: `+` opens the new-tab chooser (a `dashboard` pane): "New terminal", "Open
  URL…", "New editor", plus the user's configured quick links (e.g. SilverBullet when configured).
- **Protocol additions**: `sessions` message grows per-tab metadata (kind, name, color, url);
  client→server gains `createTab`, `updateTab` (rename/recolor/url) messages. Terminal `kill`
  keeps working; non-terminal tabs close via `updateTab`/`kill` equivalents. Non-terminal tab
  metadata persists across server restarts (`~/.config/palmux/tabs.json`); PTYs still don't.
- **NOT changing**: the PTY bridge, auth, upload, the mobile keyboard/gesture layer, the extra-keys
  bar. tmux remains the real multiplexer inside terminal tabs.

## Capabilities

### New Capabilities

- `workspace-tabs`: server-side tab registry generalizing sessions — tab kinds, metadata
  (name/color/url), wire-protocol messages (`tabs` broadcast, `createTab`, `updateTab`),
  persistence of non-terminal tabs, URL-path ↔ tab-id routing.
- `chrome-tab-strip`: Chrome-visual tab strip on desktop (shape, elevation, kind icon, close
  affordance, overflow scroll) and matching name/color rendering in the mobile session drawer.
- `tab-customization`: rename and recolor UX (context menu / long-press), palette, precedence
  rules (custom name > OSC title > default), cross-client sync.
- `web-panes`: iframe-embedded web tabs — arbitrary URL entry, SilverBullet integration via
  config, serving local HTML artifacts same-origin, frame-refusal fallback.
- `dashboard-pane`: configurable links dashboard (client-owned schema, server-persisted like
  settings) that is also the new-tab page.
- `editor-pane`: Monaco editor tabs with server-backed file load/save (new HTTP endpoints),
  dirty-state indicator, VS Code keybindings.

### Modified Capabilities

_(none — this repo has no existing specs; the terminal behavior itself is unchanged)_

## Impact

- **Client**: `session/SessionTabs.tsx` (rewrite), `session/SessionDrawer.tsx`, `App.tsx` (pane
  switching — the xterm host must stay mounted/hidden while a non-terminal pane is shown, so the
  PTY socket and replay logic are untouched), new `panes/` components (`WebPane`, `DashboardPane`,
  `EditorPane`), `session/session-url.ts` (ids stay numeric), `index.css`.
- **Server**: `server.ts` session registry → tab registry, `protocol.ts` (shared), new
  `tabs-store.ts` persistence, editor file endpoints, artifact-HTML serving route.
- **Dependencies**: adds `monaco-editor` (lazy chunk, self-hosted — no CDN, consistent with the
  bundle/PWA constraint). No other new deps; web panes are plain iframes.
- **Risks**: Monaco bundle weight (mitigated by lazy chunk); third-party sites refusing iframes
  (mitigated by same-origin artifact hosting + explicit fallback); tab-metadata schema is a wire
  change — old clients parse unknown fields as absent, so rollout is backward-compatible.
