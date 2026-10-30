# Changelog

All notable changes to palmux are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [1.2.0] — 2026-10-30

Source Control with a full review pane, a desktop content area split into panes like VS Code's
editor groups, and real detached windows you can drag tabs between. The phone layout is denser
throughout. Each feature shipped as reviewed batches, with an independent plan review, a build, a
fresh code inspection and a browser end-to-end pass before it went live.

### Highlights

- **Source Control.** Add a git project, see its Staged and Changes files, and read them in one
  continuous diff. Comment on lines, then tap Reviewed to stage exactly what you saw.
- **Panes.** Drag a tab to the edge of a pane to split it. Panes nest in rows and columns, each
  with its own tab strip, and the layout survives a reload.
- **Detached windows.** "Open in new window" moves the tab into a window of its own with the same
  panes. Drag tabs between windows, and closing a window gives its tabs back.
- **A denser phone.** The drawer is narrower, its rows are compact, and the review pane fits more
  code on screen.

### Added

- **Source Control view.** A rail entry on desktop (Ctrl+Alt+G) and a fourth drawer segment on a
  phone. You add projects by path; the view shows only the one you select and stays idle when
  hidden. Files are grouped as Merge, Staged and Changes, as a folder tree by default or as a flat
  list. Which folders you collapse is remembered per device. Reading status never takes git's
  index lock, so it cannot get in the way of your own git, lazygit or editor.
- **Review pane.** Choosing a file opens a review tab of its whole group, scrolled to that file.
  It has side-by-side and unified layouts, git's four diff algorithms, word wrap, syntax colour in
  your theme and highlighted changed words. It stays fast on thousands of changed lines and keeps
  your place when the file changes on disk.
- **Review keys.** Ctrl+Alt+J and Ctrl+Alt+Shift+J step through changes, Ctrl+Alt+N and
  Ctrl+Alt+Shift+N step through files, and Ctrl+Alt+Enter marks a file reviewed.
- **Reviewed and Unstage.** Reviewed stages the exact version the review showed and moves on to
  the next file. In a Staged review the same action is Unstage. Both offer a 6-second Undo that
  restores the index entry exactly, and a file that changed since you looked is never staged.
- **Line comments.** Comment on a line or a range on either side of a diff, like a pull request
  review. Comments are stored per project under `~/.config/palmux/.cache/`, never in the
  repository, follow their code when the file changes, sync between windows within 2 seconds, and
  copy out as one markdown document.
- **Mobile review bar.** While a review is open on a phone, a bar with Files, previous file, next
  file and Reviewed (or Unstage) replaces the extra-keys bar. Right to left still opens the drawer;
  left to right goes back to the tab you came from.
- **Editor groups (desktop).** The content area is a tree of panes with draggable sashes. Drag a
  tab over a pane to see where it lands: an edge makes a new pane on that side, the centre or
  another pane's strip moves the tab there. Split right (Ctrl+Shift+D) and Split down
  (Ctrl+Shift+E) are in the tab menu. New tabs open in the focused pane.
- **Detached windows (desktop).** "Open in new window" moves the tab into a window with its own
  panes, strips and `+`. Inside it, the tab menu offers "Move to main window". Tabs drag between
  any two palmux windows of the same browser, onto a strip, a pane's centre, a pane's edge or the
  New-tab page. Every main window, on every device, hides tabs a detached window holds.
- **Code font size.** Settings › Appearance › Code font size sets the review's and the editor's
  size on this device, apart from the terminal's. The review also has a − and + stepper for it.

### Changed

- **No topbar on desktop.** Each pane draws its own tab strip, and the app menu is the first
  control of the dock rail.
- **Mobile drawer.** It now takes three quarters of the width, at most 340px. The top row is the
  view switcher (Sessions, Explorer, Source Control, Dictation) with the Settings gear at its end;
  the Close button is gone, and the drawer closes with the scrim, a swipe or Escape. Session rows
  are 28px tall with 12px titles.
- **Compact review on a phone.** A hunk has one divider row that carries its hidden-lines count,
  its controls and its heading, and file headers are shorter. Changed-file rows in Source Control
  are 24px with a smaller indent.
- **Editor font size.** Once you set a code font size, the editor follows it instead of the
  terminal's size.
- **Rail order.** New tab, Explorer, Source Control, Dictation, Upload, Download, with Settings
  pinned to the bottom.

### Fixed

- **Older windows no longer erase newer settings.** A settings save now merges into what is
  stored, so a window still running an older build cannot drop settings it does not know, such as
  the Match system theme slots. The 1.1.0 upgrade note asking you to reload every window first no
  longer applies.
- **No false "Opened somewhere else."** A slow connection that was replaced no longer delivers a
  late takeover notice to the pane that replaced it, and moving a tab between windows never shows
  the notice.
- **Editor theme.** An open editor and every review repaint when the theme changes, and nothing
  recolours when a reconnect sends the same palette.

### Removed

- **The fused split pill.** Split pairings, slot eject, divider swap, the rotate handle and the
  `toggleSplitOrientation` keybinding are replaced by panes. A saved split is ignored and a fresh
  layout starts with one pane.
- **The old pop-out.** The single-tab pop-out window, its return bar and its Take back are
  replaced by detached windows. `/popout/<id>` and `/<id>?popout=1` still work and open a detached
  window holding that tab.

### Upgrade notes

- **Restart the server.** Source Control, detached windows and the settings merge are
  server-side and take effect after a restart (`yarn service:update` or
  `systemctl --user restart palmux`). A restart ends open terminals; tmux sessions survive it.
  "Open in new window" stays hidden until the client sees a server that supports it.
- **Panes start fresh.** The first desktop load after the upgrade opens one pane holding every
  tab. The layout is kept per window from then on.
- **Known limits.**
  - A detached window left open on an idle computer keeps hiding its tabs from your phone until
    you close it.
  - Deleting `~/.config/palmux/.cache/` resets the comment revision, and another open window may
    ignore new comments until it reloads.
  - Two windows that create a terminal in the same instant can pick the same id; one of them then
    offers Take back for a tab nobody else holds.

## [1.1.0] — 2026-10-25

A full UI rework for desktop and mobile, a safer file API, and voice dictation that works with
more providers. The rework shipped as twelve reviewed batches. Each batch had an independent plan
review, a build, and a fresh code inspection before it went live.

### Highlights

- **Tabs are pills.** You can tell the active tab, a split and a group apart at a glance.
- **Settings are grouped cards.** Every control lines up on one column at one height.
- **A redesigned mobile drawer.** It opens full-height, reorders with long-press drag, and
  closes with a swipe.
- **Automatic theme.** Pick one theme for dark mode and one for light, and each device follows
  its own system setting.
- **The installed app remembers where you were.** That includes the last tab and the folders you
  had open in the Explorer.
- **Safer file operations.** The server no longer trims paths, so deleting `report ` (trailing
  space) can never delete `report`, and it refuses relative paths outright.

### Added

- **Theme follows the system.** Settings › Theme has a "Fixed | Match system" switch. In Match
  system you choose a theme for dark and a theme for light, and each device switches live with
  its own system setting. The tmux and Claude Code theme exports follow a real system switch, or
  a pick or import for the mode currently on screen.
- **In-place theme browser.** The Theme row opens a list inside the same dock or drawer. Every
  theme previews itself in its own palette, and a pick applies live while the list stays open.
  Import theme now lives at the top of this list.
- **App menu.** The topbar ends with a menu button, centred above the sidebar rail, holding
  Settings, Tips and Reload app.
- **Long-press drag in the mobile drawer.** Hold a row, then drag it to reorder, to join a group
  (drop on a group header) or to leave one (drop on the area below the list). A long press
  without moving opens the row menu, and a swipe left reveals Close.
- **Remembered Explorer state, per device.** The Explorer remembers which root sections (HOME and
  each pinned folder) and which folders inside them are open. The state survives closing the view,
  a reload and an app relaunch. HOME opens by itself only the first time on a device.
- **Last tab survives an app relaunch.** An installed PWA reopens on the tab you were last on.
  Two open windows still keep independent tabs.
- **Dictation providers.** Besides Gemini, dictation can use any OpenAI-compatible API (OpenRouter
  included) or Anthropic for the clean-up pass, with separate models for the audio and text passes.
- **Boot environment file.** `~/.config/palmux/env` holds `KEY=VALUE` lines loaded at every boot,
  under systemd too. Config values can refer to them with a `$` prefix, so API keys stay out of
  `config.json`.

### Changed

- **Tab strip.** Every tab is a bordered pill. The active pill has a raised fill and a ring, and a
  tab's colour is now a small dot instead of a tint. A group is a framed cluster with a filled
  chip, and a split pairing is one pill with a split glyph that stays visible when inactive.
- **Settings panel.** Sections are titled cards with one fixed control column, and every control
  is the same height: 28px on desktop, 36px on mobile. Long values end in an ellipsis with the full
  text on hover. Focus rings show for keyboard focus only. Font uses the same select as every other
  list. Editing `config.json` is a row at the end of the panel.
- **Mobile drawer.** It covers the full height, leaving a 44px strip to tap closed, over a dimmed
  scrim. The top row holds Settings (a gear), a Sessions | Explorer | Dictation switcher and Close.
  Session rows are pills, with the active row raised and ringed, and groups are framed clusters. The
  drawer keeps the soft keyboard: if it was up when you opened the drawer, it comes back when you
  close it, and the terminal resizes at most once.
- **Dock rail.** The order is New tab, Explorer, Dictation, then Upload and Download, with Settings
  pinned to the bottom. The rail is always shown on desktop.
- **Dictation history.** Each card has a header line (date and duration on the left, actions on
  the right) over the transcript at full width. Long transcripts are cut to four lines with a
  "Show more" button, and the scrubber appears under the text while a clip plays.
- **One visual scale.** Font sizes, spacing, radii and control heights come from one small set of
  tokens, enforced by a test. There are no off-scale values left in the client stylesheets.
- **Icons.** Emoji and text glyphs used as icons are replaced by one SVG icon set with a light,
  uniform stroke.
- **Motion.** Menus grow from where you opened them, kit buttons show a pressed state, and list
  rows fade and collapse their space when they leave instead of jumping.

### Fixed

- **Samsung keyboard.** On the Samsung keyboard, digits were sometimes typed twice. The soft
  keyboard now tracks committed text correctly.
- **Text selection.** After a mobile text selection, the keyboard no longer jumps closed and back
  open.
- **Drawer gestures.** A tap that redraws the screen under your finger, such as opening Settings
  or a scrim tap, no longer delivers a second, stray click to whatever appears there.
- **Keyboard access.** Buttons in the dashboard, the tab sheet and the new-tab chooser now respond
  to Enter, Space and assistive technology, not only to a pointer.
- **Focus.** Opening the theme list, the raw config editor or a drawer sub-view no longer loses
  focus or dismisses the soft keyboard.
- **Unsaved config.** Leaving Settings with unsaved `config.json` changes, or turning mobile mode
  on, now asks before discarding them.
- **Black band.** A black band under the terminal on desktop now paints in the terminal's own
  background colour.
- **Theme switch.** Hovering the selected segment of the drawer switcher no longer shows pale text
  on the accent fill.

### Security

- **File paths are used exactly as given.** `/files/list`, `/files/delete`, `/download`,
  `/md-file` and `/md-list` no longer trim the path, so an operation on a name that ends in a
  space never lands on its sibling. Previously, deleting the folder `report ` recursively deleted
  `report`.
- **Relative paths are refused.** The server checks that a path is absolute before resolving it.
  Previously a relative path was resolved against the server's working directory, so a relative
  delete could remove a directory inside the running checkout.

### Removed

- The "Sidebar rail" option. The desktop rail is always shown, and an old stored value is ignored.
- The "Dictation history" row in Settings, because the rail's Dictation entry covers it.
- The `palmux` wordmark in the topbar, replaced by the app menu.

### Upgrade notes

- **Restart the server.** The path-safety fixes are server-side and take effect after a restart
  (`yarn service:update` or `systemctl --user restart palmux`). A restart ends open terminals,
  and tmux sessions survive it.
- **Reload every open palmux window** (phone and desktop, Settings › Reload app) before you turn
  on Match system. An older window that saves settings would drop the new theme preferences.
- **Known limits.**
  - Two windows of one device changing Explorer folders in the same instant can bring back a
    folder's collapsed or deleted state.
  - Two devices saving settings in the same instant can leave the tmux and Claude export on the
    other device's theme until the next system switch.

## [1.0.1]

See the GitHub release for v1.0.1.

## [1.0.0]

Initial release.

[1.2.0]: https://github.com/jvPalma/palmux/releases/tag/v1.2.0
[1.1.0]: https://github.com/jvPalma/palmux/releases/tag/v1.1.0
[1.0.1]: https://github.com/jvPalma/palmux/releases/tag/v1.0.1
[1.0.0]: https://github.com/jvPalma/palmux/releases/tag/v1.0.0
