# Proposal

## Why

"Open in new window" opens `/popout/<id>`, a window that shows one tab and has no strip, no panes and no drop
targets. The tab also stays in the main window, where a terminal freezes on "Opened somewhere else." with
Take back. The owner wants VS Code's auxiliary window instead (2026-10-27): the tab leaves the main window
and lives only in the new one, and the new window manages tabs the way the main window does, without the
dock rail.

## What Changes

- **A detached window is a full editor-groups window.** It has the same pane tree, strips, sashes, drop
  overlays, Split right / Split down and `+` as the main window. It has no dock rail, no topbar and no
  `.popout-bar`. Its `+` opens the New-tab chooser in a dialog inside the window, because there is no dock to
  host it.
- **A tab belongs to exactly one window, and the server holds that.** `TabMeta` gains a transient
  `window?: string`, the id of the detached window that holds the tab. Absent means the main window. Every
  main window, on every device, shows only tabs with no `window`. A detached window shows only its own
  tabs. The owner chose this over a per-device rule (2026-10-27): the phone hides a detached tab too.
- **"Open in new window" MOVES the tab.** The main window stops showing it the moment the request is sent.
  The terminal is never attached twice, so the "Opened somewhere else." takeover no longer happens on this
  path.
- **Tabs move between windows by drag and drop.** You can drop a tab from another palmux window of the same
  browser on a strip, on a pane's centre, or on a pane's edge to split. This works main → detached,
  detached → main and detached → detached. The tab menu also offers "Move to main window" inside a detached
  window. The menu is the only command surface there (owner, 2026-10-27).
- **Closing a detached window returns its tabs to the main window.** Ownership is tied to the detached
  window's live control socket. When the last socket of that window closes, a grace timer starts. If the
  window does not come back, its tabs are released and reappear, inactive, in the focused pane of every
  main window. Nothing is killed. A reload comes back inside the grace period and keeps its tabs. A
  detached window whose last tab leaves closes itself, as VS Code's does.
- **Ownership is in memory only.** A server restart releases every tab to the main window, and a detached
  window that reconnects reclaims the tabs in its saved layout that nobody holds. The same reclaim covers a
  reload slower than the grace.
- **BREAKING (behaviour):** the old pop-out (one tab, no strip, the tab shown in both windows, the "return to
  main" bar, Take back after a pop-out) is gone. `/popout/<id>` and `/<id>?popout=1` still resolve and
  open as a detached window holding that tab.

## Capabilities

### New Capabilities

- `detached-windows`: window identity, server-held tab ownership with its lease and grace, moving tabs
  between windows (menu and cross-window drag), the detached window's chrome, and closing.

### Modified Capabilities

- `window-pop-out`: the single-tab, takeover pop-out and its return bar are replaced by `detached-windows`.
  Requirements that only described the old window are removed. The PTY sizing and DA/DSR focus-gate
  requirements stay.

## Impact

- **Objective, plainly:** open a tab in its own window and work there as you do in the main one: split it,
  drag tabs in and out, open new tabs. The tab is in one place at a time.
- **Today and its limits:** the pop-out shows one tab, and you cannot split it or drop anything on it. The
  main window keeps the tab, so a terminal is frozen there. "Return to main" is the only way back.
- **Who it affects:** desktop users. A phone only notices that a tab held by a desktop's detached window is
  not listed until that window closes or dies.
- **Main risks:**
  - A detached window that is still open, for example on a laptop left awake, hides its tabs from the
    phone. This is the owner's choice.
  - Tab ids are recycled lowest-free, and the order sends must keep carrying the FULL order. A filtered
    order would push the hidden tabs to the end (`forgivingOrder`).
  - `window.open` copies the opener's `sessionStorage`, so a detached window must not boot from the main
    window's saved layout.
  - The feature needs a **server restart**, which costs every live terminal (cold start plus snapshot
    restore). It needs the owner's OK at the time.
- **Success:**
  - Open a tab in a new window: it leaves the main strip, and the phone's drawer stops listing it.
  - Split and drag inside the detached window as in the main one.
  - Drag a tab from main to the detached window's pane edge: a split forms there.
  - Drag it back: it reappears in main.
  - Close the detached window: its tabs come back to main, still running.
  - Reload the detached window: it keeps its panes and tabs.
  - No "Opened somewhere else." on any of these paths.
- **Scope:** desktop only. The mobile layer has no detached windows. A detached window ignores the mobile
  layer and always draws panes.
- **Out of scope / non-goals:**
  - Dragging a tab past the edge of the browser window to spawn a window. The `window-pop-out` spec
    describes it, but it was never built (recon, 2026-10-27), and it stays unbuilt.
  - Detached windows on a phone.
  - A dock in a detached window.
  - Remembering detached windows across a browser restart (their layout is per window, in
    `sessionStorage`).
  - A per-window "Close other tabs" that reaches other windows.
- **Prerequisite:** `split-editor-groups` is archived before task 6.2 runs (`validate --strict` must see its
  `window-pop-out` requirement in the living spec). This change modifies the `window-pop-out`
  requirement that change introduces ("Popping out a tab in a pane keeps the pane").
- **Code:**
  - shared: `protocol.ts` (`TabMeta.window`, `parseTabMeta`, a `moveToWindow` message, a `windowClosing`
    message, `isWindowId`).
  - server: `server.ts` (registry field, lease and grace per window id, the control-socket `window` param,
    an attach-time claim limited to the spawn of a new id, `tabs()`). `tabs.json` is unchanged.
  - client:
    - `App.tsx`: the window's visible list, the order sends mapped onto the full list, cross-window drag,
      `+` routing, menu items, self-close;
    - `session-url.ts`: the `/window/<wid>` route, `openPopout`;
    - `useEditorGroups.ts`: layout key per window;
    - `GroupsView.tsx` and `GroupDropOverlay.tsx`: overlays for an external drag;
    - `SessionTabs.tsx`: menu, external `drop-into`;
    - `workspaceController.ts`;
    - `index.css`: the `.popout-bar` and `.app.popout` rules go.
  - Tests in each, plus `CLAUDE.md`.
- **Zoom-out review (2026-10-27), how it was addressed:** persistence of `window` in `tabs.json` dropped (in
  memory only, the reclaim covers a restart); `windowClosing` kept, because without it closing a detached
  window takes the full 15 s grace before its tabs come back, and a reload still keeps its tabs, since a reload
  that outlives the 3 s close grace reclaims them; both `window-pop-out` requirements that contradict or were
  never built are REMOVED by name; the cross-window transport is the existing `TAB_DND_TYPE` data; the
  attach-time claim applies only to the attach that spawns a new id.
