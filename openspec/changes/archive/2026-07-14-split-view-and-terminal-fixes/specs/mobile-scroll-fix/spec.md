## ADDED Requirements

### Requirement: Swipe-scroll resolves the correct target under nested apps

On mobile, a vertical swipe SHALL scroll the surface the user intends when a mouse-reporting full-screen application (for example a TUI running inside tmux) is active — delivering wheel input to that application's own scroll region — rather than scrolling the wrong pane or scrolling erratically. When no application consumes wheel input, the swipe SHALL scroll the local xterm scrollback (unchanged behavior).

#### Scenario: Swipe scrolls the active full-screen app under tmux

- **WHEN** a mouse-reporting full-screen app is active inside tmux and the user swipes up
- **THEN** that application scrolls up and other tmux panes are not scrolled

#### Scenario: Claude inside tmux scrolls within its own view

- **WHEN** the user runs Claude inside tmux on mobile and swipes to scroll
- **THEN** scrolling stays within Claude's view and does not jump or scroll the wrong surface

#### Scenario: No mouse-reporting app falls back to local scrollback

- **WHEN** no application has enabled mouse reporting and the user swipes
- **THEN** the swipe scrolls the local xterm scrollback
