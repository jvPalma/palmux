## MODIFIED Requirements

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
