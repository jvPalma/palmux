# Design — chrome-tabs-and-panes

## Context

Today a "session" is a numeric workspace slot (`/0`, `/1`, …): the server registry
(`server.ts` `createSessionRegistry`) maps id → PTY, the client renders one xterm and swaps a
per-session WebSocket on switch (`App.tsx`), and the tab strip / mobile drawer list ids + OSC
titles from the `sessions` broadcast. Titles are ephemeral; there is no name, color, or non-PTY
content. The client owns opaque JSON schemas that the server persists blindly (`settings`,
`extraKeys`) — a pattern this design reuses. Constraints: full TS stack, minimal deps, no CDN
(self-contained `bin/` bundle + PWA), strict TS, the mobile input layer must not be disturbed.

## Goals / Non-Goals

**Goals:**

- Chrome-visual tab strip (desktop) with rename + color, synced across devices.
- Tabs generalize to kinds: `terminal` (unchanged), `web` (iframe), `dashboard` (links grid /
  new-tab page), `editor` (Monaco).
- Non-terminal tabs and all custom names/colors survive server restarts.
- Zero cost for terminal-only usage (Monaco lazy-loaded; web/dashboard panes are plain DOM).

**Non-Goals:**

- Drag-to-reorder tabs, tab groups, split panes (later change if wanted).
- Resurrecting PTY _processes_ across restarts (tmux inside the shell already covers this).
- A general file manager / arbitrary-path file browser for the editor.
- Mobile-optimized Monaco (it must render and scroll; deep touch polish is out of scope).
- SilverBullet API integration — v1 "integration" is a configured, embedded instance.

## Decisions

### D1 — Generalize the session registry into a tab registry (same numeric id space)

`SessionRegistry` becomes `TabRegistry`. A tab is
`{ id: string; kind: 'terminal'|'web'|'dashboard'|'editor'; name?: string; color?: string; url?: string }`;
only `terminal` tabs own a PTY. Ids stay numeric so `session-url.ts` routing (`/\d{1,4}/`),
history navigation, and `/ws?session=` all keep working unchanged.
_Alternative rejected_: separate client-only tab list for non-terminal kinds — breaks cross-device
sync and the "URL path is the workspace" model.

### D2 — Protocol: extend `sessions`, add `createTab`/`updateTab`

`SessionsMessage` gains `tabs: TabMeta[]` (id, kind, name, color, url, title). `ids`/`titles`
remain, derived, so an older cached PWA client still works (unknown fields ignored → pure
additive, no version negotiation needed). Client→server adds
`createTab { kind, url?, name?, color? }` and `updateTab { id, name?, color?, url? }`; existing
`kill { id }` closes any kind (for non-terminal tabs it just drops registry entry + persistence).
Name/color precedence for display: custom `name` > OSC `title` > `kind` default.

### D3 — WS attach works for every tab kind (metadata-only when non-terminal)

The client's one-socket-per-active-tab lifecycle in `App.tsx` is load-bearing (replay
suppression, settings/fonts delivery, sessions broadcast). Keep it: `/ws?session=<id>` on a
non-terminal tab attaches without spawning a PTY — server sends `ready`, `settings`,
`extraKeys`, `sessions`, `fonts` but no `snapshot`/binary; `resize` and binary input are ignored.
_Alternative rejected_: only connect WS for terminal tabs — then a client sitting on a dashboard
tab stops receiving `sessions` broadcasts and the strip goes stale.

### D4 — Client pane host: xterm stays mounted; non-terminal panes stay mounted per tab

`term-wrap` is hidden (CSS `display:none`-equivalent via class, _not_ unmount) when the active
tab is non-terminal — the xterm instance, socket effect, and replay logic are untouched. A
`PaneHost` renders one element per open non-terminal tab, hidden unless active: iframes and
Monaco models keep their state exactly like real browser tabs (that state _is_ the feature).
Memory is bounded by tab count, which is user-controlled and small in practice.
_Alternative rejected_: mount-on-activate — loses iframe navigation state and editor dirty
buffers on every switch.

### D5 — Persistence: `~/.config/palmux/tabs.json`, all kinds' metadata

Written on every registry mutation (debounced). On boot: non-terminal tabs are restored fully;
`terminal` entries restore _metadata only_ (name/color) — the slot model means `/3` named
"api-server" keeps its identity across restarts even though the PTY is gone and respawns on
first attach. Corrupt/missing file → empty start (same forgiving posture as `extra-keys.json`).

### D6 — Editor = Monaco, lazy chunk, server-backed file per tab

`monaco-editor` from npm, loaded via dynamic `import()` in `EditorPane` only (vite code-splits;
workers via vite's `?worker` handling; everything self-hosted — CDN would break the offline
bundle and PWA posture). The user's requirement is literally "VS Code keybindings/behavior";
Monaco _is_ that component — CodeMirror 6 (lighter) was rejected on that requirement.
Each editor tab binds to a file under `~/.config/palmux/notes/` (`<tab-id>.md` default). New
endpoints, cookie-gated like everything else: `GET /pane-file?tab=<id>` and
`PUT /pane-file?tab=<id>` (raw body, capped by `maxUploadBytes`). Save on Ctrl+S + debounced
autosave; dirty dot on the tab.

### D7 — Web panes: plain iframe + same-origin artifact serving; honest fallback for refusers

`WebPane` renders `<iframe src={url}>` with
`sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"` and a slim
pane header (URL, reload, "open externally"). Third-party sites that send
`X-Frame-Options`/`frame-ancestors` **cannot be embedded — hard browser limit, not detectable
cross-origin**; the header's "open externally" button is the permanent, honest fallback (no
fake detection heuristics). For Claude-generated HTML / artifacts: a new cookie-gated route
`GET /artifacts/<name>` serves files from `~/.config/palmux/artifacts/` (path-traversal-safe,
same-origin ⇒ always embeddable). v1 populates that dir manually or via the existing upload
flow; a dedicated "save as artifact" UI is a later change.

### D8 — Dashboard links: client-owned schema, two sources merged

Deployment-level apps (SilverBullet instance URL, dashboards ops cares about) live in
`config.json` → `webApps: [{ name, url, icon? }]`, delivered in `ready`. User-editable quick
links live in the existing settings JSON (client-owned, server-persisted opaque — the
established pattern). `DashboardPane` shows: New terminal / Open URL… / New editor, then
configured `webApps`, then user links (editable in place). The `+` button opens a transient
dashboard as the new-tab page; picking an option converts/creates the tab.

### D9 — Rename/recolor UX

Desktop: double-click tab → inline rename; right-click → context menu (rename, 8-color theme
palette shown Chrome-tab-group style: colored top-border + drawer dot, colorless default).
Mobile: long-press a drawer row → bottom sheet with the same options. All go through
`updateTab`; empty name clears the override (falls back to OSC title).

## Risks / Trade-offs

- [Monaco adds ~3 MB to `dist/`] → lazy chunk: nothing loads until an editor tab opens;
  bundle-size cost accepted for the explicit VS-Code-parity requirement.
- [External sites refuse framing (claude.ai, most SaaS)] → not solvable client-side; explicit
  "open externally" affordance + same-origin artifact hosting for the HTML-artifact use case.
- [Keeping all panes mounted grows memory on mobile] → bounded by user's open-tab count; if it
  bites, add an LRU unmount for background iframes later (state loss trade-off documented).
- [`tabs.json` metadata-by-id can mislabel a reused terminal slot] → accepted: slots are the
  product model (URL = workspace); user can rename/clear in two taps.
- [Iframe embeds run inside an authenticated origin] → external iframes never receive palmux
  cookies (cross-origin); `/artifacts` is cookie-gated and path-traversal-checked; sandbox
  attribute limits artifact scripts to the declared allowances.
- [Old cached PWA clients meet new protocol] → additive fields only; derived `ids`/`titles`
  retained; unknown client messages already ignored server-side.

## Migration Plan

Ship in one release (client + server deploy together via `yarn build` + service restart; the
bundle path re-runs `yarn bundle`). No data migration: `tabs.json` appears on first mutation.
Rollback = previous build; it ignores `tabs.json` and the extra `sessions` fields.

## Open Questions

- Drag-to-reorder tabs: deferred — needs a `reorderTab` message + persisted order; revisit after
  the strip lands.
- "Save this upload as artifact" one-tap flow: deferred to a follow-up change.
- Editor: open arbitrary server paths (beyond `notes/`)? Deliberately excluded v1 (auth blast
  radius); revisit with an explicit allowlist design if wanted.
