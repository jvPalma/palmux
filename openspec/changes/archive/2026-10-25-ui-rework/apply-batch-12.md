# ui-rework — apply batch 12 (group 13: owner's desktop notes before archive)

Batch plan for the OpenSpec change `ui-rework`. Batches 1–11 are in production (batch 11's server
part restarted live). The owner stopped the archive to add these notes from his desktop (2026-10-25),
verbatim in Portuguese, summarised here:

1. Settings › Theme: "Import theme" moves INTO the theme list view, as its own section at the top.
2. Settings › Theme: an automatic mode that follows the system — pick one theme for when the system
   is dark and another for when it is light.
3. Settings › App: drop the "Sidebar rail" option and the "Dictation history" row (the rail already
   has a Dictation entry); keep the rest.
4. The Dictation history (dock view and drawer view) is confusing and unreadable: a long transcript
   fills the card, squeezed beside its action buttons (screenshot `/tmp/palmux-clip-4945d9e0b06c-image.png`).
5. The app menu (hamburger, Settings / Tips / Reload app) sits at the top-LEFT of the topbar; move it
   to the far RIGHT of the topbar, above the sidebar rail column.

## Acceptance criteria

### A. Import theme lives in the theme list (1)

- The `ThemeImportRow` (`settings/SettingsFields.tsx:~254`, rendered at `~515` in the Appearance card)
  leaves the settings form and becomes the FIRST section of the theme sub-view
  (`settings/ThemeBrowser.tsx`, the `themes` sub-view), titled "Import" in the section-title style, above
  the Dark / Light groups. Its behaviour (accepted inputs, busy state, error/notice, auto-select of the
  imported theme) is unchanged; both hosts (dock and drawer) get it, since both render the sub-view.
- **Import in system mode (B12-04).** The import's TARGET is captured when the request is submitted:
  in `fixed` mode the imported theme becomes `themeId` (today's behaviour); in `system` mode it fills
  the slot the user is currently editing in the sub-view ("For dark" / "For light"), and it becomes the
  displayed theme only if that slot matches the active scheme. App's `themeImported` handler
  (`App.tsx:~1475–1484`) routes through this mode-aware selection instead of writing `themeId`
  unconditionally. A completion that lands after the user switched SLOT still applies to the slot
  captured at submit. A completion that lands after the MODE changed is superseded (B12-R2-02): a
  fixed-target import completing after a switch to Match system does NOT write `themeId` (which would
  overwrite the scheme export without a scheme change) — the theme is still imported and appears in
  the list, it just is not auto-selected; a slot-target import completing after a switch to Fixed is
  likewise not auto-selected.
- Tests: the form no longer renders the import field; the theme sub-view renders it first; an import
  still calls `onImportTheme`; fixed-mode import becomes current; system-mode import fills the captured
  slot (and is displayed only when that slot is active), including a completion after a slot switch;
  a fixed-target import completing after Fixed → Match system plus an intervening scheme change does
  not touch `themeId` and leaves the theme in the list.

### B. Theme follows the system, with a theme per scheme (2)

- New SYNCED settings: `themeMode: 'fixed' | 'system'` (default `'fixed'`), `themeDark` and
  `themeLight` (theme ids; default to the current `themeId` when first switched on, so nothing changes
  visually at the switch). They are part of `SYNCED_KEYS`: "dark → X, light → Y" is the same preference
  on every device.
- **One resolved runtime theme id (B12-02).** In `system` mode each client resolves its theme from
  its OWN `matchMedia('(prefers-color-scheme: dark)')`, live (a `change` listener). That RESOLVED id is
  a runtime value separate from the persisted `themeId`, and it is the ONLY id the rendering paths
  read: `applyThemeTokens` (CSS tokens, meta theme-color, Monaco), the terminal (`useTerminal.ts`
  reads `settings.themeId` at `~111`, `~458`, `~494` today — it must read the resolved id through
  whatever prop path `TerminalPane` already receives settings by), the dynamic-themes refresh
  (`App.tsx:~1466`, which re-applies on a `themes` broadcast), and `main.tsx`'s pre-paint (which
  resolves from the stored settings + `matchMedia` before React mounts, so a light-scheme device does
  not flash the dark export). In `fixed` mode the resolved id equals `themeId`. Tests assert the
  TERMINAL's theme too (a `useTerminal`/`TerminalPane` level test), not only App with a stubbed pane.
- **The server export (`themeId`, which drives `theme.sh` / `theme.tmux` / the Claude theme at boot)**:
  in `system` mode a client writes `themeId` = its resolved theme ONLY when its system scheme actually
  CHANGES while it is open (not on boot, not on reconnect), so the export follows the most recent real
  scheme switch and two devices in different schemes do not fight on every load. In `fixed` mode
  `themeId` is the picked theme, as today. Stated in CLAUDE.md as the deliberate rule.
- **Known limit, accepted (B12-03 rejected as a server change):** settings updates send the whole
  synced snapshot, `themeId` included, and the server replaces and re-exports it. So if device A
  writes `themeId` on a scheme change and device B saves an unrelated setting in the milliseconds
  before A's broadcast reaches it, B's stale `themeId` wins the export until the next real scheme
  change. Fixing it needs patch semantics on the server (another restart that ends every terminal) for
  a window the size of one broadcast round trip whose only effect is the tmux/Claude palette; stated in
  CLAUDE.md instead.
- **Every pick is mode-aware (B12-06).** In `fixed` mode a pick applies at once and persists, as today.
  In `system` mode a pick fills the slot being edited and applies at once only if that slot is the
  active scheme; picking the inactive slot persists without changing what is on screen.
- UI, in the Theme sub-view (above Import's section is fine, or as the sub-view's first control —
  the builder picks one and keeps it coherent): a kit `Segmented` "Fixed | Match system". In
  `system` mode the list offers TWO pick targets — "For dark" and "For light" (a Segmented choosing
  which slot a tap fills, with the current pick of each slot marked) — and picking applies live when
  that slot is the active scheme. The Theme ROW in the form shows "System · <dark> / <light>" in
  system mode (one line, ellipsis, full text as `title`).
- **Rollout (B12-R2-01).** A client still on the batch-11 bundle neither reads nor sends the three new
  keys, and the server replaces the whole settings object on every save — so that older client's next
  save would ERASE `themeMode`/`themeDark`/`themeLight`, whenever it happens, not just in a race. The
  rollout is therefore: deploy, then the owner reloads EVERY open palmux window (phone PWA, desktop)
  onto the new bundle BEFORE switching Match system on. The coordinator says this explicitly in the
  deploy message; CLAUDE.md records why (older bundles drop unknown synced keys). A server-side merge
  that preserves omitted keys is out of scope (a server change and a restart for a one-time rollout
  ordering).
- Server: `themeMode`/`themeDark`/`themeLight` are opaque synced settings (no server change needed;
  verify the server persists and rebroadcasts them like any other synced key, and that
  `LOCAL_SETTINGS_KEYS` stays `['themeId']`).
- Tests: `fixed` unchanged; `system` applies the dark theme when the media query matches and the
  light one when not, and switches live on a `change` event; a scheme change writes `themeId`, a boot
  does not; the row label; the slot picker.

### C. App section without Sidebar rail and Dictation history (3)

- The "Sidebar rail" row (`SettingsFields.tsx:~657–678`) and the "Dictation history" row (`~680–686`)
  are removed. With the option gone, the rail is ALWAYS shown on desktop: `sidebarRail` stops being
  read for layout (a stored `'hidden'` is ignored), its sanitiser and type stay so an old
  settings.json still parses, and the `onOpenDictationHistory` prop goes from the form and its hosts —
  `App.tsx` AND `session/SessionDrawer.tsx` (`~1042–1048`, declaration, destructuring, forwarding)
  (B12-05).
  The CLAUDE.md lines that describe `sidebarRail: 'hidden'` (the rail as the only pointer route, the
  app menu as the route when the rail is hidden, the per-device note) are rewritten to match.
- Tests: neither row renders; the dock rail renders with a stored `sidebarRail: 'hidden'`; the
  Dictation view still opens from the rail.

### D. A readable dictation history card (4)

- **The component is `DictationView.tsx` (B12-01):** the dock and the drawer render
  `dictation/DictationView.tsx` (`App.tsx:~2241`, `~2311`), which owns the quoted transcript and the
  side-by-side actions in the screenshot; `DictationHistory.tsx` is a separate modal. The card is
  implemented in `DictationView` (extract a shared card only if `DictationHistory` should match, and
  then use it in both). Each entry becomes:
  1. a HEADER line: date · duration on the left (secondary text), the actions on the right
     (play/pause, copy, insert, and Transcribe for an audio-only entry), as compact icon buttons on
     one line — the actions no longer sit beside the text column;
  2. the TRANSCRIPT below at full card width, clamped to 4 lines with an ellipsis, and a
     "Show more" / "Show less" toggle (a real button, keyboard-operable) when it overflows;
  3. the audio scrubber, when the entry is playing, under the text.
- The quotes around the transcript go; the text uses the body size (`--fs-2`) with comfortable line
  height; cards are separated by `--sp-2`; colours only from tokens. Works at the dock's 300px and
  in the mobile drawer.
- Tests: header holds date/duration and the actions; a long transcript is clamped and the toggle
  expands/collapses it; an audio-only entry shows Transcribe; existing behaviour tests stay green.

### E. The app menu moves to the top-right, above the rail (5)

- The app-menu `IconButton` (`App.tsx:~2059`, `app-menu-button`) moves from the start of the topbar to
  its END, aligned over the dock rail column (its right edge lines up with the rail's), after the `+`.
  Same menu, same items, same testid; its dropdown opens aligned to the right edge so it stays on
  screen. The tab strip starts at the left edge.
- Desktop only, as today (mobile has no topbar menu).
- Tests: the topbar's last child is the app menu; the menu still opens Settings with the rail present.
  A 1440×900 screenshot shows it above the rail.

### F. Docs and specs

- CLAUDE.md: the topbar/app-menu paragraph, the settings form rows, the theme chooser (import
  section, system mode, the export rule and its known limit), the dictation card, and the
  sidebar-rail lines.
- The change's spec deltas are reconciled before archive (B12-06): `specs/sidebar-dock/spec.md`
  (the rail is always shown on desktop; no hide option), `specs/chrome-tab-strip/spec.md` (the app menu
  is the topbar's LAST control, above the rail, not the first), and `specs/settings-panel/spec.md`
  (Import is a section of the theme browser; a Match-system mode with dark/light slots; a pick applies
  live only for the active slot). `openspec validate ui-rework` passes.

## Clusters (non-overlapping files)

| Cluster | Model | Files |
|---|---|---|
| C1 theme + settings | sonnet xhigh | `settings/SettingsFields.tsx` + test, `settings/ThemeBrowser.tsx` + test, `settings/settings.ts` + test, `settings/theme-browser.css`, `settings/themes.ts` if needed, `main.tsx` (pre-paint resolution), `terminal/useTerminal.ts` + `terminal/TerminalPane.tsx` (read the resolved id) + their tests, `App.tsx` (resolved id, `themeId` write, import routing, removal of `onOpenDictationHistory`/`sidebarRail` reads), `App.test.tsx`, `session/DockPanel.tsx` (rail always) + test, `session/SessionDrawer.tsx` (drop the prop) + test |
| C2 dictation card | sonnet xhigh | `dictation/DictationView.tsx` + test, `dictation/dictation-view.css`, `dictation/DictationHistory.tsx` + test only if a shared card is extracted |
| C3 app menu | sonnet xhigh | the topbar markup — it is in `App.tsx`, which C1 owns, so C3 runs AFTER C1 on `App.tsx` (+ `index.css` topbar rules, `App.test.tsx` topbar cases) |
| C4 docs + specs | sonnet xhigh | `CLAUDE.md`, the three spec deltas named in F |

C1 and C2 run in parallel; C3 after C1; C4 last. `ui/scale-baseline.json` stays `{}`.

## Non-goals

- Changing which themes exist, the theme preview look, or dictation recording/transcription.

## Verification

- `yarn typecheck`, `yarn lint` (0 errors), `yarn test`.
- Isolated smoke (B12-07: theme changes must not reach production state) — the smoke server runs
  with ALL of: `PALMUX_CONFIG_DIR` a fresh disposable dir (containing a no-op `theme-hook.mjs`, which
  REPLACES the built-in Claude export so `~/.claude/themes/palmux.json` is never written), `HOME` set
  to a fresh disposable dir (so no `~/.tmux.conf` and no `~/.claude` of the owner's is read or
  written), and `TMUX_TMPDIR` set to a fresh disposable dir (so the tmux-reload path cannot reach the
  owner's live tmux server); plus `PALMUX_HOST=127.0.0.1`, `"host":"127.0.0.1"`, :44099, `command ss
  -ltnp`, server cwd a disposable dir, client built into /tmp. Before and after the smoke, the
  coordinator records the mtime of `~/.claude/themes/palmux.json` and `~/.config/palmux/theme.tmux`;
  they must be unchanged. desktop 1440×900 — the app menu sits top-right above
  the rail; Settings › App has no Sidebar rail / Dictation history rows; Theme sub-view shows Import
  first, switch to Match system, pick dark/light themes, emulate `prefers-color-scheme` dark and light
  (Playwright `emulateMedia`) and see the app switch; Dictation view with a long seeded transcript
  (seed `<cfg>/transcripts/<id>.txt`) is clamped with Show more. Mobile 390×844: the drawer's
  Dictation view is readable. Screenshots for each.
