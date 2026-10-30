import type { Action } from '../keybindings/keybindings';

export interface Tip {
  category: string;
  title: string;
  description: string;
  /** If set, the tip renders this action's CURRENT keybinding live. */
  action?: Action;
}

export const TIPS: Tip[] = [
  // ── Mobile ──────────────────────────────────────────────────────────────────
  {
    category: 'Mobile',
    title: 'Mobile mode',
    description:
      'Settings → Mobile mode. Auto detects a touchscreen; force it On for the extra-keys bar + touch gestures on any device, or Off to disable.',
  },
  {
    category: 'Mobile',
    title: 'Sessions drawer',
    description:
      'A bar with the drawer swipe is always there on mobile, whatever the tab is — the extra-keys bar, or the review bar while a review is open — because it is how you reach everything else. Swipe RIGHT→LEFT across it to pull the drawer in from the right edge. It covers about three quarters of the screen and leaves a dimmed strip on the left: tap the strip to get back to the terminal. Choosing a tab, opening a file and every footer action close the drawer too, and with a keyboard, Escape closes it while focus is inside. The drawer is laid out for your thumb. Upload, Download, Dictate and Images sit at the bottom and your tabs above them. At the very top is one row: a four-icon switcher (Sessions, Explorer, Source Control, Dictation) with the Settings gear at its right end, the control you need least. All of it opens as drawer views, never a modal stacked over the terminal. From the session list, + New tab opens the chooser in place of the list (‹ New tab goes back); a tmux session, a URL or a note all start from there.',
  },
  {
    category: 'Mobile',
    title: 'Reorder and regroup in the drawer',
    description:
      'Long-press a session row for half a second — you feel a short buzz — then drag without letting go. Drop it between two rows to reorder. Drop it on the middle of a group header to add it to that group; the top or bottom edge of a header drops it beside the group instead. Drop it on "Drop here to ungroup" below the last row to take it out of its group. Drag a group header the same way to move the whole group. The list scrolls by itself when your finger nears its top or bottom edge. A plain swipe only scrolls: nothing moves unless you hold first. The order syncs to every device.',
  },
  {
    category: 'Mobile',
    title: 'Long-press a row for its menu',
    description:
      'Long-press a drawer row and let go without moving to open its menu: rename, colour, group, or close. It opens over the drawer, so you land back in the list when you are done. Closing a terminal from here still asks first. Move your finger after the hold and it becomes a drag instead.',
  },
  {
    category: 'Mobile',
    title: 'Swipe a row left to close it',
    description:
      'Swipe a drawer row to the left to reveal its Close button, then tap it. Rows carry no always-visible ✕. A terminal still asks before its shell is killed, and an editor with unsaved text asks too. Swipe right, tap anywhere else or scroll to put the row back. With a keyboard, press Left arrow on a focused row to reveal Close and Right arrow to hide it.',
  },
  {
    category: 'Mobile',
    title: 'Settings at the top of the drawer',
    description:
      'Settings is the gear button at the top of the drawer, at the right end of the row. It sits as far from your thumb as the drawer allows, because you reach for it least. Tap it to open the settings list; ‹ Settings goes back. The Explorer, Source Control and Dictation views are the icons of the switcher to its left.',
  },
  {
    category: 'Mobile',
    title: 'The drawer and the soft keyboard',
    description:
      'Opening the drawer never dismisses the keyboard, and the terminal keeps its size while the drawer is open, even if Android hides the keyboard meanwhile. Close the drawer and the keyboard comes back if it was up when you opened it, with at most one resize. Upload and Images keep the terminal still until the file picker returns, however long you take in it.',
  },
  {
    category: 'Mobile',
    title: 'The review bar',
    description:
      'While a review is the active tab, the review bar takes the extra-keys bar’s place, with no terminal keys on it: Files opens the drawer on Source Control, ↑ and ↓ go to the previous and next file, and Reviewed stages the file exactly as you saw it (Unstage in a Staged review), with an Undo toast. Swipe RIGHT→LEFT across it to open the drawer, as on the extra-keys bar, and LEFT→RIGHT to go back to the tab you opened the review from (the first terminal if that tab is gone), where the extra keys return. A button acts when you lift your finger, so a swipe that starts on Reviewed opens the drawer and stages nothing.',
  },
  {
    category: 'Mobile',
    title: 'Open the keyboard',
    description:
      'Swipe LEFT→RIGHT across the extra-keys bar to raise the soft keyboard — always, whatever state it is in. Long-press ESC (⌨ hint in its corner) TOGGLES it, and tapping the terminal raises it too.',
  },
  {
    category: 'Mobile',
    title: 'Extra-keys toolbar',
    description:
      'Termux-style bottom bar: ESC, TAB, CTRL, ALT, arrows, and more. CTRL/ALT/SHIFT are sticky — tap to arm for the next key only (e.g. CTRL then B for the tmux prefix), or LONG-PRESS to lock it on (orange) until you tap it off. Long-press any other key to send its popup (shown in the corner); long-press ESC to toggle the keyboard.',
  },
  {
    category: 'Mobile',
    title: 'Upload a file',
    description:
      'Open the drawer and tap 🖼 Images to go straight to the gallery — pick several and their paths are typed in the order you tapped them, space-separated. ⬆ Upload takes ANY file instead, at the cost of Android first asking photo / video / file. Each is saved to a temp path on the server (50 MB by default) and typed into the shell — hand it to a CLI, or press Enter.',
  },
  {
    category: 'Mobile',
    title: 'Customize the toolbar',
    description:
      'Edit ~/.config/palmux/extra-keys.json (Termux schema: keys, macros, and long-press popups). Saving reloads the toolbar live — no refresh needed.',
  },
  {
    category: 'Mobile',
    title: 'Pinch to zoom',
    description: 'Pinch with two fingers to change the font size.',
  },
  {
    category: 'Mobile',
    title: 'Swipe to scroll',
    description:
      'Drag one finger to scroll. Under an app with mouse reporting (tmux), the swipe scrolls that pane; otherwise it scrolls local scrollback.',
  },
  {
    category: 'Mobile',
    title: 'Tap to focus a tmux pane',
    description: 'When tmux mouse mode is on, a tap is a click — use it to focus or select a pane.',
  },
  {
    category: 'Mobile',
    title: 'Select & copy',
    description:
      'Long-press and drag to select — it copies automatically. Drag the teardrop handles to adjust the selection.',
  },

  // ── Tabs ──────────────────────────────────────────────────────────────────
  {
    category: 'Tabs',
    title: 'The side panel',
    description:
      'Settings and the new-tab chooser open in a panel on the RIGHT that takes space instead of covering the terminal — the point being that you can still read the output you are changing a setting for. The icon rail beside it switches views. It is desktop-only: on mobile the drawer is the container.',
  },
  {
    category: 'Tabs',
    title: 'Open a tmux session',
    description:
      '[+] → New terminal (tmux)… lists the tmux sessions running on the host, alphabetically, with ＋ New tmux session on top. A filled dot means a client is already attached — opening it HERE detaches that client, because tmux sizes a window to its smallest client and mirroring a desktop session onto a phone would shrink it. The shell spawns straight inside the session; nothing is typed for you to undo.',
  },
  {
    category: 'Tabs',
    title: 'Closing several at once',
    description:
      'Middle-click a tab to close it, exactly as in a browser. Right-click for “Close other tabs” and “Close tabs to the right” — both ask once, and the question names what it costs: how many shells will be killed, and whether any editor has unsaved text. Neither item appears when it would close nothing.',
  },
  {
    category: 'Tabs',
    title: 'Where the top buttons went',
    description:
      'There is no second row of buttons above the terminal any more. Upload (⬆) and Download (⬇) are the two icons at the bottom of the side rail, under a separator — they run something rather than opening a panel. Shortcuts & tips moved into Settings. Both also have keybindings and sit in the command palette.',
  },
  {
    category: 'Settings',
    title: 'Choosing a theme by looking at it',
    description:
      'The theme list is not a dropdown of names — every option is painted in its own palette, with that theme\'s background, its cursor block, and two lines of fake shell using a dozen of its sixteen colours. That is how you see whether a theme\'s red survives its own background before you pick it. Dark and light are grouped separately.',
  },
  {
    category: 'Side panel',
    title: 'Explorer roots and pinning',
    description:
      'The Explorer opens on the server\'s home folder. Right-click any folder → Pin as a root and it becomes its own section at the top, like a VS Code workspace — the other roots collapse and the new one opens, because that is what you are about to work in. ✕ on a root unpins it. Pins are synced, so a folder you pin on the desktop is there on the phone.',
  },
  {
    category: 'Side panel',
    title: 'Files open as tabs',
    description:
      'Clicking a file in the Explorer opens it as a TAB, next to your terminals — open several, switch freely, and the terminal you were in is one click away. Clicking a file that is already open just focuses its tab. A file tab is saved like any other, so it comes back after a restart; its ✕ (or a left swipe on its drawer row) closes it, and an unsaved buffer asks first.',
  },
  {
    category: 'Side panel',
    title: 'Right-click in the Explorer',
    description:
      'Right-click a row — long-press on a phone — for Open, Download, Select and Delete; folders offer Pin instead of Open, and download as a zip. Select switches the tree into a picking mode where a click adds to the selection instead of opening, so you can Download or Delete several at once. There is no trash: the confirmation names exactly what goes, and folders take their contents.',
  },
  {
    category: 'Side panel',
    title: 'Refreshing the tree',
    description:
      'The Explorer re-reads what is on screen every two minutes rather than watching the filesystem — a watch per folder is a firehose on a build output. The ⟳ on each root header re-reads that root immediately, and it is always visible for exactly that reason.',
  },
  {
    category: 'Side panel',
    title: 'Real file icons',
    description:
      'The file browser uses the Material Icon Theme — the same icons VS Code shows, so a .ts, a .lock and a node_modules folder are recognisable at a glance. They load in the background: rows appear immediately with a plain glyph and fill in a moment later.',
  },
  {
    category: 'Tabs',
    title: 'Chrome-style tabs',
    description:
      'The top bar is a real tab strip. Click a tab to switch; click its ✕ to close (terminals confirm first). Tabs live on the server and survive closed browser tabs. Each browser window remembers which tab IT was on, so two windows can sit on two different tabs — and both still see the same strip (a tab opened in a new window is the exception: it shows there alone).',
  },
  {
    category: 'Tabs',
    title: 'Rename & color',
    description:
      "Double-click a tab to rename it (empty = automatic title). Right-click for the menu: rename, a color from the theme's own 16 ANSI colors (8 normal + 8 bright — the same palette your shell shows), or close. The active tab fills solid with its color; inactive tabs show a faint tint. On mobile, long-press a drawer row and let go without moving for the same sheet. Names and colors sync to every device.",
  },
  {
    category: 'Tabs',
    title: 'Not just terminals',
    description:
      'Press + for the new-tab popover: New terminal, Open URL… (embeds any page in a tab), New editor (a full VS Code / Monaco editor saved server-side), plus your configured apps and quick links — the terminal stays visible behind it; click anywhere else to dismiss. Pin it as a dashboard tab. Closing a tab moves you to its left neighbor (then right); closing the last one shows this as a full page.',
  },
  {
    category: 'Tabs',
    title: 'Web tabs & artifacts',
    description:
      'A URL tab embeds the page in an iframe. Its ← and → belong to the framed page, not to palmux — switching tabs writes nothing to browser history, so back never undoes a tab switch. Sites that refuse embedding (most third-party apps) show a blank frame — use ⧉ to open them in a real browser tab. Drop HTML into ~/.config/palmux/artifacts/ and open /artifacts/<name> to embed it same-origin (always works).',
  },
  {
    category: 'Tabs',
    title: 'Panes (desktop)',
    description:
      "Drag a tab to the edge of a pane to open a new pane there, or onto a pane's middle or its tabs to move it. Right-click a tab → Split right / Split down, or Ctrl+Shift+D / Ctrl+Shift+E. Each pane has its own tabs and +, closes with its last tab, and drags its sashes to resize. Remembered per window; desktop-only.",
  },
  {
    category: 'Tabs',
    title: 'Open in a new window',
    description:
      'Right-click a tab → Open in new window to move it into a window of its own. The tab leaves the main window, so a terminal is never open in two places and nothing shows "Opened somewhere else." The new window has panes, tabs and + like the main one, without the side rail; its + opens the new-tab chooser in a dialog, and the tab menu has Move to main window. Close the window and its tabs come back to the main window, still running. While a window holds a tab, your other devices do not list it. Desktop-only, and the server must support it.',
  },
  {
    category: 'Tabs',
    title: 'Drag tabs between windows',
    description:
      "Drag a tab from one palmux window onto another window: onto its tab strip or a pane's middle to move it into that pane, or onto a pane's edge to open a new pane there. It works from the main window to a new window, back, and between two new windows. An editor with unsaved changes will not move by drag; save it first, or use the tab menu, which asks. A window whose last tab leaves closes itself.",
  },
  {
    category: 'Tabs',
    title: 'Rearrange tabs',
    description:
      'Drag a tab along the strip to move it, Chrome-style — an accent bar marks where it will land. The order is shared across all your devices and survives server restarts. New tabs always append at the end.',
  },
  {
    category: 'Tabs',
    title: 'Group tabs',
    description:
      "Right-click a tab → New group from this tab (or Add to <group>) to cluster related tabs behind a group button. Grouped tabs are always kept next to each other, and the group's colored line runs under the button and every member. The group button lights up solid whenever you are on one of its tabs. A group has its OWN name and color independent of each tab's. Grow a group by dragging a tab onto the middle of a member; drag a member fully out to leave. Drag the group button to move the whole block. Shared across devices, survives restarts.",
  },
  {
    category: 'Tabs',
    title: 'Collapse a group',
    description:
      'Click a group button to collapse it — its members fold away and it shows a count; click again to expand. If you were viewing a member, it hops to the nearest tab outside the group first. Selecting a collapsed member (a closed neighbour, anything) auto-expands the group. Collapse state is per device; on mobile the same groups appear as tappable headers in the drawer.',
  },
  {
    category: 'Mobile',
    title: 'The extra keys work in editors too',
    description:
      'On a file, a note or the config editor, the bar drives the EDITOR: arrows move the cursor, SHIFT+arrow extends the selection, HOME/END jump along the line, PGUP/PGDN by a screen, TAB indents and SHIFT+TAB outdents. CTRL takes its editor meaning — CTRL+A selects the whole file, CTRL+Z undoes, CTRL+F opens find — not the shell one.',
  },
  {
    category: 'Tabs',
    title: 'Markdown viewer',
    description:
      'Press + → 📖 Open markdown… and paste an absolute path (/home/user/notes/readme.md) to read it rendered, or leave it empty to browse — configure markdownRoots in config.json for a click-through file tree. Relative links between docs open in the same pane; ⟳ re-reads; 📂 returns to the browser. Read-only (use an editor tab to write).',
  },
  {
    category: 'Terminal',
    title: 'Download files from the server',
    description:
      'The ⬇ button (side rail on desktop, drawer on mobile) downloads files OFF the server machine: paste an absolute path for one file, a glob like /home/user/notes/*.md, or a directory — globs and directories arrive as a single .zip. Copy the path straight out of the terminal.',
  },
  {
    category: 'Tabs',
    title: 'Import any theme',
    description:
      'Settings → Import theme takes whatever gogh-co.github.io/Gogh gives you — paste the install command straight off its Copy button and palmux reads the theme name out of it (it never runs the command). A bare name ("Tokyo Night"), a gallery link, a GitHub file URL, or any URL to a colour scheme all work too. It downloads, saves and selects it immediately — no restart. The picked theme skins the WHOLE app, and also drives your shell prompt, tmux bar and git diffs through ~/.config/palmux/theme.sh.',
  },
  {
    category: 'Tabs',
    title: 'One device at a time',
    description:
      'Open the same terminal on your phone and it takes over from the desktop — whoever attached last owns the shell, so the grid is never squeezed to fit the smallest screen. The other view freezes on its last frame with a Take back button; press it to reclaim the session (which bumps the other one). The shell itself keeps running throughout.',
  },

  // ── Terminal ────────────────────────────────────────────────────────────────
  {
    category: 'Terminal',
    title: 'Workspaces',
    description:
      'Each terminal tab is a separate shell. Press + → New terminal for another; shells survive closed browser tabs, and reopening palmux puts you back on the tab that window was last on. Close a tab (✕ on the strip, a left swipe on a drawer row on mobile) to kill its shell for good.',
  },
  {
    category: 'Terminal',
    title: 'tmux',
    description:
      'Run real tmux inside the shell for sessions, windows, and panes. It survives reconnects on its own.',
  },
  {
    category: 'Terminal',
    title: 'Clickable links',
    description: 'URLs in the output are clickable (Cmd/Ctrl-click on desktop).',
  },
  {
    category: 'Terminal',
    title: 'Copy / paste',
    description:
      'Select with the mouse to copy; paste with your platform shortcut. Apps can set the clipboard via OSC 52.',
  },
  {
    category: 'Terminal',
    title: 'Images in the terminal',
    description:
      'Real pixels, not blocks: palmux speaks SIXEL and the iTerm2 inline-image protocol. Use timg -ps or chafa -f sixel (most tools pick the protocol from a hard-coded list of terminal names, not from what the terminal says it can do, so tell them). Inside tmux it just works, but ONLY for a tmux client that attached after this landed — tmux asks once, at attach: run tmux detach then re-attach if you get a "SIXEL IMAGE" placeholder box instead of the picture. Animation and video are not worth it — every frame crosses the network as raw pixels. Settings → Inline images turns it off.',
  },
  {
    category: 'Terminal',
    title: 'Upload files',
    description:
      'Paste an image (Ctrl+Shift+V), drag any file onto the terminal, or click ⬆ in the side rail. The file is saved server-side and its temp path is typed into the shell — ready to hand to a CLI. Max size is maxUploadBytes in config.json — a byte count or a size like "1GB" (50 MB default; the body is buffered in memory, so raise it knowingly).',
  },

  // ── Settings ────────────────────────────────────────────────────────────────
  {
    category: 'Settings',
    title: 'Themes & fonts',
    description:
      'Pick a color theme, font, size, cursor style, and scrollback depth in Settings — the theme skins the WHOLE app (topbar, tabs, panels), not just the terminal, and includes light themes. Tab colors follow the theme too, so a "blue" tab is that theme\'s blue. They follow you across browsers.',
  },

  // ── Keyboard (live shortcuts — rebind in Settings → Keybindings) ─────────────
  {
    category: 'Keyboard',
    title: 'Command palette',
    description: 'Fuzzy-search and run any action.',
    action: 'commandPalette',
  },
  {
    category: 'Keyboard',
    title: 'New tab',
    description: 'Open the new-tab chooser.',
    action: 'newTab',
  },
  {
    category: 'Keyboard',
    title: 'Search scrollback',
    description: 'Find text in the terminal buffer.',
    action: 'search',
  },
  {
    category: 'Keyboard',
    title: 'Export scrollback',
    description: 'Download the focused terminal buffer as text.',
    action: 'exportScrollback',
  },
  {
    category: 'Keyboard',
    title: 'Copy diagnostics',
    description: 'Copy a support bundle to the clipboard.',
    action: 'diagnostics',
  },
  // ── Review (live shortcuts, and what the review does) ───────────────────────
  {
    category: 'Review',
    title: 'Open Source Control',
    description:
      'Opens the Source Control panel from any tab: the branch icon on the rail. The Ctrl+Alt+G chord is not VS Code’s Ctrl+Shift+G, which is Copy last output here.',
    action: 'openSourceControl',
  },
  {
    category: 'Review',
    title: 'Next change',
    description:
      'While a review is the focused tab, jumps to the next change; hold Shift for the previous one. At a file’s last change it goes on to the next file’s first, fetching that file first if it has not loaded. A file with nothing to show line by line (binary, too large, a mode change) counts as one change at its header.',
    action: 'scmNextChange',
  },
  {
    category: 'Review',
    title: 'Next file',
    description:
      'Moves to the next file of the review; hold Shift for the previous one. From inside a file, previous goes to the start of that file first. These are letters rather than F7 because GNOME takes Alt+F7 before the browser sees it.',
    action: 'scmNextFile',
  },
  {
    category: 'Review',
    title: 'Reviewed',
    description:
      'In a Changes review, Reviewed stages the file exactly as you saw it, then moves to the next file; in a Staged review the same key unstages it. A toast offers Undo for six seconds and puts the index entry back exactly as it was, unless something else has changed it since. A second Reviewed inside those six seconds keeps the first one’s Undo: the toast counts them (Staged 2 files) and one Undo takes them all back, newest first, and stops, saying how far it got, at the first one something else has changed. If the file changed on disk after you saw it, the newer change stays under Changes, unseen. A file palmux cannot snapshot (too large, or converted by a git filter) cannot be reviewed from here, and its button says why.',
    action: 'scmReviewed',
  },
  {
    category: 'Review',
    title: 'Comment on lines',
    description:
      'Click a line number, drag across several, or shift-click to widen the range; on a phone tap one number, then tap the last line of the range. With a keyboard, Tab to a line number and press Enter or Space to pick it, and Shift+Enter or Shift+Space to widen the range. Comment opens an editor under the lines, Esc cancels it, and an unsaved draft survives scrolling away and back. Comments live on the server, outside the repository; they follow their code when the file changes and are listed as outdated, with the code they were about, when it is gone. A comment on a file that is too large or converted by git is listed as not shown instead, since palmux never read the file and nothing says its code left. If another window deletes the comment you are editing, your text stays with Save as new and Discard. Copy comments in Source Control puts all of them on the clipboard as one markdown document, marking the outdated and the not shown ones.',
  },
  {
    category: 'Review',
    title: 'Code size',
    description:
      'The review’s view menu (the gear in the review’s bar on a phone; the − and + beside the other controls on a wide pane) makes the diff’s code smaller or larger, and the menu stays open so you can tap again. The size is this device’s, apart from the terminal’s, so a pinch in the shell never moves the diff. Settings → Code font size sets the same value and also sizes the editor; leave it empty to keep the defaults.',
  },
  {
    category: 'Terminal',
    title: 'Links',
    description:
      'URLs in the output are clickable — both plain https:// text and OSC-8 hyperlinks emitted by tools. Right-click a link for "Open link" / "Copy link". Only http, https and mailto links can be opened.',
  },
  {
    category: 'Terminal',
    title: 'Send and receive files with trzsz',
    description:
      'Run trz (upload) or tsz (download) in the shell and the transfer happens in-band over the existing connection — no separate upload dialog. Terminals that never use it pay nothing: the trzsz code is only downloaded when a transfer actually starts.',
  },
  {
    category: 'Mobile',
    title: 'Tap to move the cursor',
    description:
      "With the keyboard already up, tapping a spot on the prompt line walks the cursor there with arrow keys (it never presses Enter). Tapping inside a command's output moves a menu highlight row by row instead. The first tap still just raises the keyboard, and under tmux/vim taps are forwarded as clicks as before.",
  },
  {
    category: 'Mobile',
    title: 'Selecting text',
    description:
      "Long-press and drag to select; the text is copied automatically. Settings → Native touch selection (experimental) swaps palmux's own handles for your browser's native selection handles — it needs a real device to judge, so the built-in selection stays the default.",
  },
  {
    category: 'Settings',
    title: 'Vim input mode',
    description:
      "Settings → Vim input mode gives palmux's own text inputs (the command palette) modal editing: Escape for normal mode, hjkl/w/b/e motions, x, d/y/c operators, p/P. A badge shows the current mode. Escape again in normal mode closes the palette.",
  },
  {
    category: 'Settings',
    title: 'Latency overlay',
    description:
      'Settings → Latency overlay shows rolling p50/p95 keydown-to-paint times in the corner of the terminal — useful for telling a slow network apart from a slow shell. Off by default, and per-device.',
  },

  // ── Side dock (desktop) ─────────────────────────────────────────────────────
  {
    category: 'Side panel',
    title: 'The side dock',
    description:
      'On desktop the icon rail down the right edge is always there and opens a panel: the New-tab chooser, Files, Source Control, Dictation and Settings. It is LAYOUT, not an overlay — the terminal narrows instead of being covered, so you can read the panel and the shell at once. Clicking the icon of the panel already open closes it. On mobile the same views are the drawer instead.',
  },
  {
    category: 'Side panel',
    title: 'Source Control',
    description:
      "The branch icon on the rail, between Explorer and Dictation, opens Source Control. It starts empty: Add project takes the absolute path of any folder inside a git repository and keeps the repository's top folder. The project list is shared by every device on this palmux; which project a device shows is its own choice. Changes are listed as Merge Changes (conflicted files, shown first), Staged Changes and Changes, each a folder tree with a status letter on every file, and a file changed both before and after staging appears in both. The list refreshes about once a second while the panel is open and the window is in front, and a slower repository is read less often; with the panel closed or the window in the background nothing is read. Choosing a file opens that group's review in the main area, or focuses the one already open. On a phone it is the branch icon in the drawer's switcher, and choosing a file closes the drawer.",
  },
  {
    category: 'Side panel',
    title: 'Changed files as a tree',
    description:
      'Each Source Control group is a folder tree, in the order a review walks the files, so Next file follows the rows. A folder that holds only one other folder shares its row, as in packages/client/src. Tap or click a folder, or press Enter or Space on it, to collapse or expand it; this device remembers which folders are closed, for each project and group. On a focused row, ArrowRight opens a closed folder, and ArrowLeft closes an open one or moves to the folder that holds the row. View as list, in the project bar, switches to the flat list, where each file shows its folder; View as tree switches back. That choice is per device too.',
  },
  {
    category: 'Side panel',
    title: 'Browse and edit files',
    description:
      'Files opens a tree starting at your home directory; click a folder to expand, a file to open it in the main area. A .md file offers Read (rendered) and Edit; anything else opens straight in Edit. The toggle keeps unsaved text either way. Saving writes back to that exact file on Ctrl+S, after ~2s idle, or when the page is hidden — it never CREATES a file, so a wrong path is refused rather than scattering new ones, and a refused save says why instead of claiming "saved".',
  },
  {
    category: 'Settings',
    title: 'While dictation records',
    description:
      'A toast floats at the bottom of the terminal with a live level meter, the elapsed time, and Stop. It takes no focus — keep typing into the shell while it records. A flat meter means the microphone is not picking anything up. If transcription then fails, the recording is still kept: the toast says so and offers Open history, where you can play it back or retry the transcription.',
  },
];
