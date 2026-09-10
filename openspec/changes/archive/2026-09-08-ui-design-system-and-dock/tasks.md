## 1. Component kit foundation

- [x] 1.1 Add the Radix primitive packages actually needed (dialog, popover, switch, toggle-group, tooltip, collapsible) and record the before/after gzipped client bundle size in the PR notes — the bundle is already 264 KB gz, so this is measured, not assumed
- [x] 1.2 Create `client/src/ui/` with `Button`, `IconButton`, `Input` styled from `--t-*` only (depth from the THREE REAL tokens base/mantle/surface — there is no `--t-crust`; 1px `--t-surface` border; shadow only on floating surfaces)
- [x] 1.3 Add `Switch`, `Segmented` (Radix toggle-group) and `Tooltip` to the kit
- [x] 1.4 Add `Collapsible` animating with `grid-template-rows: 0fr → 1fr`, with per-device open/closed persistence
- [x] 1.5 Add `Dialog` (kept for genuinely blocking confirms only — kill-tab, close-group — not for app surfaces)
- [x] 1.6 Define the motion tiers as CSS custom properties (0 / 140ms ease / 240ms `cubic-bezier(.2,.9,.3,1)` / 380ms + 40ms stagger) and wire `prefers-reduced-motion`
- [x] 1.7 Test: assert the kit stylesheet contains no color literal outside `color-mix()` over `--t-*`, extending the existing CSS-contract test pattern
- [x] 1.8 Test: `Collapsible` expands to full height when its content grew while collapsed (the tmux-session-list case)

## 2. Chrome-like tab strip

- [x] 2.1 Reshape `.ctab`: top-only radius, inactive tabs flush with no gap, 8% tint retained
- [x] 2.2 Active tab: taller than neighbours, fills with the content-area background, accent-colored top border
- [x] 2.3 Update `.ctab.fused` so a split pairing keeps ONE shared outer radius with an internal seam
- [x] 2.4 Update the group chip + members so the block keeps one outer radius and the group color stays visible across it
- [x] 2.5 Verify live at desktop width: normal, grouped, fused, and fused-inside-group, plus overflow scrolling with 8+ tabs
- [x] 2.6 Confirm the mobile drawer's tab rows are unaffected (they use their own chip, not `.ctab`)

## 3. Dock shell

- [x] 3.1 Add `session/DockPanel.tsx`: a layout sibling of the content area that shrinks it, with a header, close control, and one active view
- [x] 3.2 Add the icon rail and view switching; persist the active view per device
- [x] 3.3 Add `sidebarRail` (`always` | `hidden`) to client settings as a PER-DEVICE key — must not enter `SYNCED_KEYS`; default `always` on desktop, `hidden` on mobile
- [x] 3.4 Route the dock's width change through the existing `resizePaused` deferral so the PTY resize is issued on settle, not per animation frame
- [x] 3.5 Test: one dock toggle produces at most one resize per attached PTY
- [x] 3.6 Test: changing `sidebarRail` leaves the synced settings payload byte-identical
- [x] 3.7 Verify live: open/close the dock with two split terminals attached and confirm neither tmux redraws repeatedly

## 4. Settings as a dock view

- [x] 4.1 Mount the existing `SettingsFields` inside the dock as the Settings view (it is already host-agnostic)
- [x] 4.2 Convert its Appearance / Terminal / Keys / App groups to `Collapsible`
- [x] 4.3 Migrate the settings controls to the kit's `Switch` / `Segmented` / `Input`
- [x] 4.4 Remove the desktop `SettingsPanel` modal once the view reaches parity; keep the mobile drawer path working throughout (component + test deleted; its field assertions moved to `SettingsFields.test.tsx`; the mobile keybinding now opens the DRAWER's settings view)
- [x] 4.5 Verify live: every setting still applies, including theme switching repainting the dock itself

## 5. New tab as a dock view

- [x] 5.1 Move `DashboardBody` into the dock as the New-tab view; `[+]` opens the dock rather than the anchored popover (the popover survived the first pass and still fired on BOTH hosts — `.newtab-popover` and its outside-press dismissal are now deleted; on mobile the chooser is a sub-surface of the drawer's session list, since there is no dock there)
- [x] 5.2 (Create/Apps/Quick links done; tmux stays an on-demand disclosure under its tile — a standing section would refetch 26 sessions on every panel open) Split it into collapsible sections, each persisting its state per device
- [x] 5.3 Keep `chooserPage` rendering as an ACTUAL page when the last tab closes — no pane mounts there, or the closed id respawns
- [x] 5.4 Migrate the tiles and the tmux picker rows to kit components
- [x] 5.5 Test: closing the last tab still renders the page form and spawns no shell
- [x] 5.6 Verify live: create each tab kind from the dock, and pick a tmux session

## 6. Dictation view and recording indicator

- [x] 6.1 Mount `DictationHistory` as the Dictation dock view; retire its modal host
- [x] 6.2 Make the audio-only entry (clip saved, transcription failed) render as an offer to transcribe, not as an error
- [x] 6.3 Build the recording toast: floating bottom-centre, live waveform, elapsed time, Stop; non-modal so the terminal stays typeable
- [x] 6.4 Drive the waveform from real captured input level so a dead microphone is visibly flat
- [x] 6.5 Compact the toast in place after a delay on narrow viewports — same anchor, smaller footprint
- [x] 6.6 On transcription failure, state that the recording was kept and point at the history entry
- [x] 6.7 Test: the toast does not take focus, and keystrokes reach the shell while it is shown

## 7. Configuration editing (Raw / Form)

- [x] 7.1 Add the server route to read and write `config.json` through the existing validated config path
- [x] 7.2 Add the Raw / Form toggle to the settings dock view, Raw mounting the lazy Monaco chunk
- [x] 7.3 Add the status bar: valid/invalid, error message with line number
- [x] 7.4 Disable Save while the document is invalid — a write the server then ignores is indistinguishable from a broken setting
- [x] 7.5 Preserve unsaved Raw edits across a Form/Raw toggle
- [x] 7.6 Test: a trailing comma disables Save and writes nothing

## 8. File browser

- [x] 8.1 Add the authenticated read-only directory-listing route (name, is-directory, size, mtime, symlink), absolute paths per the `/download` trust model
- [x] 8.2 Return a readable error for a non-directory / missing / unreadable path rather than falling through to the SPA shell
- [x] 8.3 Build the tree in the dock: expandable folders, visible current path, selection and scroll preserved across expansion
- [x] 8.4 Open a selected file into the content pane holding `{path, mode}`, rendering through `MarkdownPane` or `EditorPane`
- [x] 8.5 Add the Read / Edit toggle; no new tab on toggle, unsaved edits preserved, Read unavailable for files with no rendered form
- [x] 8.6 Add the promote-to-pane control from the dock
- [x] 8.7 Decide and implement the default root (see design Open Questions) and document the choice
- [x] 8.8 Test: the listing route rejects an unauthenticated request and errors readably on a file path

## 9. Mobile

- [x] 9.1 Add the four-view segmented header to `SessionDrawer` (sessions · settings · files · dictation), reusing the dock's view components
- [x] 9.2 Keep the drawer on the right, keep the swipe trigger, keep the session list bottom-anchored and the 4-cell footer as they are
- [x] 9.3 Conform the extra-keys bar to the kit's tokens and radius — no layout, gesture or key-set change
- [x] 9.4 Force `sidebarRail: hidden` while the mobile layer is active; the drawer is the container
- [x] 9.5 Verify live at a phone viewport: terminal full-screen with the drawer closed, `.xterm-screen` rect inside the viewport, swipe opens the drawer, extra-keys unchanged

## 10. Close-out

- [x] 10.1 Full suite + typecheck + lint clean; no new lint warnings on touched files (1273 tests: 788 client + 465 server + 20 shared; `yarn lint` reports ZERO errors — three that this change had introduced are fixed: `new Array(n)` in RecordingToast, a missing `releaseMeter` dep in useDictation, a missing `root` dep in FileTree's rows memo)
- [x] 10.2 Measure and record the final gzipped bundle delta — main chunk **264.4 → 283.7 kB gzipped (+19.3)** for the Radix kit + dock + file browser + config editor. Monaco stays a lazy chunk (945 kB gz) that a terminal-only client never fetches; the file browser's Edit reuses it rather than adding an editor.
- [x] 10.3 Update `CLAUDE.md`: the kit, the dock, the per-device `sidebarRail`, the motion contract, and the Radix-not-shadcn reasoning
- [x] 10.4 Update `tips/tips.ts` for the dock, the Read/Edit toggle and the recording toast (a new 'Side panel' category: the dock and the file browser; the toast tip under Settings)
- [x] 10.5 Deploy and verify live on desktop AND a phone viewport before declaring done
  - VERIFIED live at both viewports on the dev server (1440x900 and 412x915): all four dock
    views, the tab strip, file Read/Edit + save + a refused save, the drawer's four views,
    terminal full-screen on mobile, and the recording toast clearing the extra-keys bar by 16px.
  - DEPLOYED to prod :44040 on the owner's instruction (`yarn service:update`), 2026-09-02, and
    four more times since as the phone rounds landed. Current bundle `index-C8F-pdZQ.js`.
  - What the DEVICE found that neither viewport could: the [+] chooser opened as a floating box
    (a popover anchored to a button that does not exist on mobile), pointerdown-activated rows
    made the drawer's lists unscrollable, DictationView's dock tab crashed the whole app (a
    synthetic event read inside a setState updater — this is why `ui/ErrorBoundary` now wraps
    every swappable view), and the recording toast unmounted on Stop with no `transcribing`
    phase. A 412px viewport is not a phone: it has no touch pointer, no IME and no soft keyboard.
