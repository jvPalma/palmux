# dashboard-pane Specification

## Purpose

The + button opens a touch-first new-tab dashboard that can be kept open as a tab, with user-editable, synced quick links.

## Requirements

### Requirement: The + button opens the new-tab page

Pressing `+` (desktop strip) or "New Session" (mobile drawer) SHALL open the new-tab surface —
**a view of the side dock on desktop, and the drawer's new-tab view on mobile** — instead of
immediately spawning a terminal or opening an anchored popover. It SHALL offer, in **collapsible
sections**: primary actions ("New terminal", "New terminal (tmux)…", "Open URL…", "New editor",
"Open markdown…"), the host's tmux sessions, configured `webApps` from config.json, and the user's
quick links. Each section's collapsed state SHALL persist per device. Choosing an option creates the
corresponding tab at the lowest free id and navigates to it; dismissing creates nothing.

When the **last tab is closed** the new-tab surface SHALL still render as an actual page rather than
as a dock view, because that path deliberately mounts no pane — a mounted pane would re-attach and
respawn the id that was just closed.

#### Scenario: New terminal from the new-tab page

- **WHEN** the user presses `+` and picks "New terminal"
- **THEN** a terminal tab is created at the lowest free id and becomes active

#### Scenario: Dismissal creates nothing

- **WHEN** the user presses `+` then presses Escape / navigates back
- **THEN** no tab is created and the previously active tab is shown

#### Scenario: Sections remember their state

- **WHEN** the user collapses the quick-links section and reopens the new-tab view later
- **THEN** that section is still collapsed and the others keep their own states

#### Scenario: Closing the last tab

- **WHEN** the user closes the only remaining tab
- **THEN** the new-tab surface fills the window as a page, no pane is mounted, and the closed id does
  not respawn a shell

### Requirement: A dashboard can be kept open as a tab

The user SHALL be able to pin the dashboard as a persistent `dashboard` tab (kind icon in the
strip, closable, renameable/colorable like any tab), restored across server restarts.

#### Scenario: Pinned dashboard survives restart

- **WHEN** a dashboard tab exists and the server restarts
- **THEN** the tab reappears and renders the dashboard when activated

### Requirement: Quick links are user-editable and synced

Quick links (`{ name, url }`) SHALL be editable directly in the dashboard (add, edit, remove)
and stored in the existing client-owned settings JSON (server-persisted opaque, broadcast on
change) so all devices share them. Opening a quick link creates a `web` tab pre-named with the
link's name.

#### Scenario: Add a link on desktop, use it on mobile

- **WHEN** the user adds "grafana → https://g.local" on desktop and later opens the new-tab page
  on their phone
- **THEN** the grafana link is present and tapping it opens a web tab named "grafana"

#### Scenario: Remove a link

- **WHEN** the user deletes a quick link
- **THEN** it disappears from the dashboard on all clients after the settings broadcast

### Requirement: Dashboard is touch-first

Dashboard entries SHALL meet the project's mobile touch-target size (≥ 48px rows/tiles) and
activate on the drawer's pointerdown convention so the soft keyboard is not dismissed by using it.

#### Scenario: Usable with keyboard open

- **WHEN** the soft keyboard is open and the user opens the new-tab page and picks an entry
- **THEN** the entry activates on first tap and the keyboard state is not lost
