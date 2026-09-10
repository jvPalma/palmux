## Why

palmux has a design *system* but no design *kit*. `deriveUiTokens` already skins the whole app from
the selected terminal theme — seven `--t-*` tokens, sixteen `--tab-c-ansi*` slots, applied pre-paint —
yet every control is hand-rolled at its call site. The result is inconsistent surfaces, no shared
focus/keyboard/ARIA behaviour, and a new-tab chooser the owner describes as painful to look at.

The second problem is structural: Settings, the new-tab chooser and dictation history are **modals**.
A modal covers the terminal, which is the one thing the user needs visible while changing a setting or
copying a transcript. VS Code solved this with a side panel that takes space instead of covering.

## What Changes

- **New component kit** (`client/src/ui/`) built on **Radix primitives (headless)**, styled entirely
  from `--t-*`. **No Tailwind and no shadcn/ui**: shadcn is authored against Tailwind's colour tokens
  and would introduce a second source of colour truth that has to be taught to obey the first. What is
  missing here is components, not colour.
- **A right-side dock** replacing modals. Settings, New tab, Files and Dictation become *views* of one
  panel that shrinks the terminal rather than covering it. An icon rail is shown or hidden per device.
- **BREAKING (visual)**: the desktop tab strip moves from flat squared tabs to Chrome-like tabs —
  top-only corner radius, the active tab taller and sharing the terminal's background.
- **A file browser**: a directory tree in the dock, and files opening in a pane with a **Read / Edit**
  toggle (rendered markdown ↔ Monaco) instead of two different tab kinds.
- **`config.json` editing** lands in the dock as a Raw / Form toggle over the same view, with a status
  bar that blocks Save on invalid JSON.
- **A recording indicator**: starting dictation with no panel open shows a floating bottom-centre
  toast with a live waveform, elapsed time and Stop.
- **Panel sections become collapsible** (VS Code style), animated with `grid-template-rows: 0fr → 1fr`.
- **A motion contract**: four durations, two curves, and one hard rule — nothing animates inside the
  terminal grid.
- **Mobile keeps its layout.** The terminal stays full-screen; the drawer stays on the right and stays
  swipe-triggered. It gains only a four-view segmented header so it hosts the same views as the dock.
  The extra-keys bar is unchanged apart from adopting the kit's tokens.

## Capabilities

### New Capabilities
- `ui-primitives`: a token-derived component kit (Button, IconButton, Input, Switch, Segmented,
  Collapsible, Tooltip, Dialog) on Radix headless primitives, plus the motion tier contract every
  animated surface in the app must follow.
- `sidebar-dock`: the right-side panel that hosts app views instead of modals — rail, view switching,
  the per-device `sidebarRail` preference, and the resize discipline that keeps a dock toggle from
  storming every attached shell with SIGWINCH.
- `file-browser`: server-side directory listing plus the in-app tree, and opening a file into a pane
  with a Read / Edit toggle over one path.
- `recording-indicator`: the non-blocking dictation recording surface and its states.

### Modified Capabilities
- `chrome-tab-strip`: tabs are no longer "FLAT, squared (no corner radius)" — the requirement changes
  to top-only radius with the active tab raised and fused with the content area. Group and fused-split
  rendering must survive the shape change.
- `dashboard-pane`: the `+` new-tab surface becomes a dock view rather than an anchored popover, with
  collapsible sections. The last-tab-closed case must keep rendering as an actual page (no pane mounts,
  so a dead id cannot respawn).
- `settings-in-editor`: configuration JSON opens in the dock as a Raw / Form toggle rather than an
  editor tab, and Save is gated on validity rather than merely "validated on save".
- `expanded-settings-surface`: adds `sidebarRail` as a **per-device** setting, which means it must NOT
  join `SYNCED_KEYS` — a synced copy reintroduces the dotfiles conflict that `settings.local.json` was
  created to end.

## Impact

**Client.** New `client/src/ui/` directory. Touches `App.tsx` (dock host, view routing), `SplitView`
(the content area now shares width with the dock), `index.css` (tab shape, dock, kit styles),
`panes/DashboardBody`, `settings/SettingsPanel`, `dictation/DictationHistory`, `session/SessionDrawer`,
`terminal/useTerminal` (fit under a changing content width).

**Server.** One new read-only route for directory listing, and a route to read/write `config.json`
through the existing validated config path.

**Dependencies.** Adds Radix primitive packages (headless, tree-shakeable). No build-system change: no
Tailwind, no PostCSS, no `cva`/`clsx`/`tailwind-merge`. The client bundle is already 901 KB / 264 KB
gzipped, so the addition must be measured, not assumed small.

**Risks.** Opening or closing the dock resizes every visible terminal; without the same deferral the
split divider already uses, a settings click redraws every attached tmux. Moving the `+` chooser also
touches `chooserPage`, the path that deliberately mounts no pane so a closed tab's id cannot respawn.
