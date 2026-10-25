# ui-rework — apply batch 1 (tasks 1.1–1.5 and 2.1)

Batch plan for the OpenSpec change `ui-rework` (`proposal.md`, `design.md`, `specs/`, `tasks.md` in
this directory). Only tasks 1.1–1.5 (the scale and icon foundation) and 2.1 (the pills prototype)
are in scope. Every other task is gated on the owner:

- 2.2: his tuned prototype values
- 2.10: his sign-off on the tabs
- 5.1: an on-device spike
- the per-group confirmation that `tasks.md` requires

## Goal and acceptance criteria

1. **Scale variables exist (1.1)** in `packages/client/src/index.css` `:root`, next to the `--t-*`
   colour tokens (`index.css:29`):

   | Variable | Values |
   |---|---|
   | `--fs-1..4` | 11, 12, 13, 15px |
   | `--fs-mono` | 13px |
   | `--sp-1..6` | 4, 8, 12, 16, 20, 24px |
   | `--r-1..3` | 4, 6, 10px |
   | `--r-pill` | 999px |
   | `--ctl-h` | 28px |

   `--ctl-h` is 36px under `:root[data-mobile='true']`. `App.tsx` sets that attribute from the SAME
   resolved `mobileActive` that drives `.app.mobile` (`App.tsx:1475`), so explicit on/off and
   auto-with-touch-points all agree, and portalled Radix content (outside `.app`) inherits it. A
   `useEffect` keeps the attribute in sync and removes it on unmount. No media query is used, because
   `settings.ts:225–235` resolves auto mode from `maxTouchPoints`, not from the pointer type (R5).
   No existing rule is changed, so 1.1 produces no visual change.
   - **Proof.** An App-level test asserts the attribute follows `mobileMode` on/off.

2. **A scale guard test exists (1.2):** `packages/client/src/ui/scale.test.ts` plus
   `packages/client/src/ui/scale-baseline.json`.
   - **Scan.** Every `*.css` under `packages/client/src`, comments stripped.
   - **Declarations checked:**
     - `font-size` and the size in a `font:` shorthand
     - `padding*`, `margin*`, `gap`, `row-gap`, `column-gap`
     - `border-radius`
     - `height`, `min-height`, `max-height`, but only `px` literals
   - **A value passes if it is:**
     - `0`, `auto`, a `%`, an `em`/`rem`, `var(…)`, `calc(…)`, `env(…)`, `min(…)`/`max(…)`/`clamp(…)`
     - a font-size px in {11, 12, 13, 15}
     - a radius px in {4, 6, 10, 999}
     - a spacing or height px that is 1, 2, or a multiple of 4
   - **Exemptions:**
     - rules whose selector matches `.ek-`, `.extra-keys`, `.term-`, `.xterm`, `.md-body`,
       `.native-sel`, `.sel-handle` (terminal metrics and the extra-keys bar tuned on 2026-10-24)
     - any declaration followed by the pragma `/* scale-ok */`
   - **Ratchet.** The baseline maps each file to its current violation count. The test fails when a
     file exceeds its baseline, naming the file and the offending values. It also fails when a file
     is BELOW its baseline, with the message "lower the baseline for <file> to <n>", so progress is
     locked in.
   - **Proof.** A fixture string containing `font-size: 10.5px` produces exactly one violation, and
     the real tree passes against the committed baseline.

3. **One icon module (1.3).** `packages/client/src/ui/icons.tsx` owns the SVG wrapper: 24-unit
   viewBox, `stroke="currentColor"`, `stroke-width` 1.75, round caps and joins,
   `aria-hidden`, `focusable="false"`.
   - **API.** It exports `Icon({ name, size = 16 })`, which renders `null` for an unknown name;
     `namedIcon(name)`, kept for `ExtraKeysBar`; and `ICON_NAMES`.
   - **The registry holds:**
     - the five existing key names: `switch`, `folder`, `newline`, `mic`, `keyboard`
     - `close`, `menu`, `check`, `warning`, `pin`, `folder-open`, `file`, `book`, `globe`, `link`,
       `pencil`, `terminal`
     - `upload`, `download`, `external`, `back`, `arrow-left`, `arrow-right`, `arrow-up`,
       `arrow-down`
     - `checkbox-on`, `checkbox-off`, `play`, `pause`, `record`, `image`, `dot`, `plus`, `split`
     - added after review R3/R4: `eject`, `hourglass`, `reload`, `copy`, `chevron-left`,
       `chevron-right`, `chevron-up`, `chevron-down`, `settings`, `stop`, `sessions`, plus every
       shape the dock registry currently draws (see below)
   - **Sizing.** Width and height come from `size`, plus an inline `vertical-align: -0.125em` and
     `flex: none`, so no stylesheet change is needed.
   - **`mobile/key-icons.tsx` keeps** `keyFace` (the arrow and symbol faces) and imports the wrapper
     from `ui/icons.tsx`. It re-exports `namedIcon`, and `KEY_ICON_NAMES = ICON_NAMES`.
   - **The existing parallel SVG registries move into the shared module (R4):**
     - `session/DockPanel.tsx:37` `ICONS` (seven SVGs at stroke 1.4/1.5/1.6), which
       `SessionDrawer.tsx:53/204` imports. `ICONS` keeps its exported shape,
       `Record<IconName, ReactNode>`, but each entry becomes `<Icon name=… />`, so
       `SessionDrawer.tsx` needs no import change.
     - `dictation/DictationView.tsx:49` and `:64` (microphone and stop SVGs).

     After the move, no `.tsx` other than `ui/icons.tsx` and `mobile/key-icons.tsx` contains an
     inline `<svg`.
   - **Proof.**
     - `ExtraKeysBar.test.tsx` and `extra-keys.test.ts` pass unchanged.
     - A new `ui/icons.test.tsx` asserts every name renders an `<svg>` with `stroke-width="1.75"`
       and `stroke="currentColor"`, and that an unknown name renders nothing.
     - Rendered-consumer assertions: the dock rail and the drawer's view switcher render `<svg>`
       with `stroke-width="1.75"`.
     - A source scan asserts no inline `<svg` outside the two icon modules.

4. **No emoji or glyph icons in chrome (1.4).** Each call site below is replaced with
   `<Icon name=… />`. The receipts come from a scan of non-test sources:

   | File | Lines | Glyphs |
   |---|---|---|
   | `panes/DashboardBody.tsx` | 231, 238, 245, 252, 446, 456 | ❯ ✎ 🌐 📖 🔗 ✕ |
   | `panes/DashboardBody.tsx` | 421 | default of `app.icon ?? '🔗'`, now `link` |
   | `panes/DashboardTab.tsx` | 20 | ☰ |
   | `panes/EditorPane.tsx` | 275, 281 | ☰; ✓ → `check`, ● → `dot` |
   | `panes/FilePane.tsx` | 107, 130, 143 | ⚠ ✓ ● ✕ |
   | `panes/FileTree.tsx` | 401–418 | 📌 ↗ ⬇ ☑ ✕ in menu `icon` fields |
   | `panes/FileTree.tsx` | 561, 653, 679, 688 | ☑/☐, ✕, ⬇, ✕ |
   | `panes/MarkdownPane.tsx` | 178, 181, 195, 214, 249, 256 | ☰ 📖 📂 ↩ 📁 📄 |
   | `panes/NewTabChooser.tsx` | 31, 43, 53 | ☰ 📌 ✕ |
   | `panes/WebPane.tsx` | 87, 99, 108 | ☰ ← → |
   | `session/DockPanel.tsx` | 235 | ✕ |
   | `session/SessionDrawer.tsx` | 446, 477, 487, 500, 514 | ✕ ⬆ ⬇ 🔉→`mic` 🖼→`image` |
   | `session/SessionTabs.tsx` | 678 | ●/✕ |
   | `session/TabSheet.tsx` | 153 | ✕ |
   | `session/tab-meta.ts` | 11–15 | kind icons, now icon NAMES rendered via `<Icon>` |
   | `settings/ThemePicker.tsx` | 85 | ✓ |
   | `terminal/SearchBar.tsx` | 54, 57, 60 | ↑ ↓ ✕ |
   | `dictation/DictationPill.tsx` | 76 | 🔴 |
   | `dictation/DictationView.tsx` | 254, 273 | ❚❚/▶, ↵ |
   | `App.tsx` | 1488 | ⇱ |
   | `session/SplitView.tsx` | 265 | ⏏ |
   | `dictation/DictationPill.tsx` | 81 | ⏳ |
   | `panes/WebPane.tsx` | 135, 144 | ⟳ ⧉ |
   | `panes/MarkdownPane.tsx` | 204 | ⟳ |
   | `dictation/DictationView.tsx` | 265 | ⧉ |
   | `settings/ThemePicker.tsx` | 98, 104, 109 | ▾ ▴ ▾ |
   | `ui/Collapsible.tsx` | 93 | › (the span keeps its class, so the rotate rule in `ui.css` still applies) |
   | `session/SessionDrawer.tsx` | 305, 359, 389, 462 | ‹ ‹ ▸/▾, and the "+" of `+ New tab` |
   | `panes/FileTree.tsx` | 565, 571, 622, 642 | ▾/▸ disclosure, ▸/◆ row glyph, ▾/▸, ⟳ |
   | `panes/DashboardBody.tsx` | 336, 391 | ＋ ◉ |
   | `session/SplitDivider.tsx` | 182 | ⬍/⬌ (rotate handle, now `rotate-row`/`rotate-col` or `split`) |
   | `session/SessionTabs.tsx` | 692 | the `+` new-tab button, now `plus` |
   | `session/tab-meta.ts` | 13 | ▦ (dashboard kind) |

   **The table is a starting point, not the inventory.** The authority is the guard's own scan.
   Discovery MUST read the files as UTF-8 text (Node/Python), not with ripgrep or grep: they skip
   `panes/FileTree.tsx` as binary (`file` reports it as `data`), which is how review round 2 found
   sites that round 1 missed. C2 runs the scan before and after its edits, and replaces every site it
   reports.

   - **Type change.** The menu-item `icon` field (`FileTree.tsx:401`; its type is in the
     ContextMenu item model) changes from string to `ReactNode`.
   - **Not chrome, so untouched:**
     - user data: `app.icon` from config, `extra-keys.json` labels
     - prose: `tips/tips.ts`, `keybindings.ts` labels, arrows inside sentences
     - the fake shell sample in `settings/theme-preview.ts`
     - comments
   - **Accessibility.** Icon-only controls keep or gain an `aria-label` or `title`; none loses its
     accessible name.
   - **A new guard `ui/no-emoji-icons.test.ts`** scans non-test `.ts`/`.tsx` under
     `packages/client/src`, except `tips/tips.ts`, `settings/theme-preview.ts` and
     `keybindings/keybindings.ts`, with comments stripped. It fails on any Extended_Pictographic
     emoji or any of `✕ ☰ ⚙ ✓ ✔ ☑ ☐ ⬆ ⬇ ✎ ❯ ⇱ ↩ ↵ ⚠ ▶ ❚ ↗ ⏏ ⏳ ⟳ ⧉ ▾ ▴ ▸ ‹ › ◆ ◉ ▦ ⬍ ⬌ ＋ ●`. It reads
     sources as UTF-8 text, so binary-looking files are not skipped. A `●` that is a status DOT
     (unsaved) becomes the `dot` icon too. Plain `← → ↑ ↓` stay legal in prose,
     but the call sites above are replaced anyway.
   - **Proof.** The guard passes. Every existing test that asserted a glyph's text is realigned to
     assert the icon or the accessible name: these are intended changes, not regressions. The drawer
     footer renders four `<svg>`.

5. **Press and menu motion (1.5).** All of it is on existing tiers (`--mo-micro` 140ms,
   `--mo-ease`):

   | Where | Change |
   |---|---|
   | `ui/ui.css:128` | `.ui-btn:active` uses `transform: scale(0.97)` with no transition on press, and the base rule gains a `transform var(--mo-micro) ease` release |
   | `.ui-icon-btn` | the same |
   | reduced-motion block at `ui/ui.css:525` | keeps `transform: none` for both |
   | `ui/ui.css:575` | `.ui-menu` entrance moves from `--mo-surface` to `--mo-micro`, keeping its `--radix-context-menu-content-transform-origin` |
   | `index.css:2192` | `.tab-menu`, the hand-positioned tab menu opened at the pointer (`SessionTabs.tsx:278`/`699`), gains a `scale(.97)` + opacity entrance on `--mo-micro` with `transform-origin: top left` and a reduced-motion override |
   | `settings/theme-picker.css:71` | `.tp-content` enters on `--mo-micro` from `var(--radix-select-content-transform-origin)` |

   - **Pressed colour (R6).** `.ui-btn` and `.ui-icon-btn` also gain a token-derived `:active`
     background, distinct from their hover background (for example `color-mix` of the hover fill
     with `--t-text`). The reduced-motion block drops only the transform, so the colour change stays
     as the colour-only feedback the `ui-primitives` delta requires.
   - **Proof.** `ui/ui.test.tsx` gains assertions on `.ui-btn`, `.ui-icon-btn` and `.ui-menu`,
     including that the `:active` background differs from the hover background and that the
     reduced-motion block removes the transform but not the background.
     A new test reads `index.css` and asserts the `.tab-menu` animation uses `var(--mo-micro)`. All
     tier checks pass.

6. **Pills prototype (2.1).** Write `~/.agent/diagrams/palmux-tabs-pills-prototype.html`, one
   self-contained file following the visual-explainer conventions (`ve:` meta, `color-scheme`,
   fonts DM Sans + Fira Code, no external JS).
   - **Content.** A live strip rendered in the app's real palette (Cobalt Next Minimal: base
     `#0f1c23`, mantle `#0c161c`, surface `#253139`, text `#d8dee9`, subtext `#98a0aa`, accent
     `#99c794`, plus ANSI red `#ed6f7d`, yellow `#fac863`, blue `#6699cc`, magenta `#c594c5`, cyan
     `#5fb3b3`), with a Light toggle (Catppuccin Latte). It shows nine tabs from the owner's real
     strip:
     - group `DGSL` (blue): L0-PALMA-SOCIAL (magenta), AI-SYSTEM-REFACTOR (yellow)
     - L0_PALMA (red)
     - split pairing SEC-AUDIT-0 | DG-FO-0 (cyan)
     - PALMUX-0
     - TV-0
     - README.md (markdown)
     - docs (web)
   - **Interaction.** Clicking any pill makes it active; clicking a segment focuses it.
   - **Knobs (range inputs with live values):**
     - active fill step: 0–3 steps above surface
     - ring width: 0–2px
     - ring strength: 0–100%
     - border alpha: 0–40%
     - radius: 4–12px
     - gap: 2–10px
     - inactive text strength: 50–100%
     - pill min width: 72–140px
     - pill height: 24–32px
   - **Measurement.** A strip width readout shows how many pills fit at 1440px before scrolling,
     and a contrast readout gives the active fill vs the strip as a ΔL or contrast ratio.
   - **Copy.** "Copy values" uses the 3-path clipboard (secure API → `execCommand` → modal with
     pre-selected text) and emits a CSS custom-property block.
   - **Proof.** It loads from `http://10.0.0.18:7999/palmux-tabs-pills-prototype.html` with no
     console errors and no horizontal page overflow at 1440px and 390px, and the copy fallback works
     on the insecure LAN origin.

## Approach and decisions

- **Clusters with disjoint file ownership:**
  - **C1 (scale and motion):** `index.css`, `ui/ui.css`, `settings/theme-picker.css`,
    `ui/ui.test.tsx`, new `ui/scale.test.ts`, new `ui/scale-baseline.json`.
  - **C2 (icons):** new `ui/icons.tsx`, `mobile/key-icons.tsx`, new `ui/icons.test.tsx`, new
    `ui/no-emoji-icons.test.ts`, every 1.4 call-site file (including `SplitView.tsx`,
    `SplitDivider.tsx`, `Collapsible.tsx`, `DockPanel.tsx`, `DictationView.tsx`, `FileTree.tsx`),
    any further file the text-mode scan reports, the existing tests that assert those
    glyphs, and `App.tsx`, which needs the ⇱ icon and the `data-mobile` effect from 1.1. C2 MUST NOT edit any `.css`; icon sizing is inline in the component, which keeps C1's
    baseline stable.
  - **C3 (prototype):** the single gallery file, outside the repo.
- **The guard is a ratchet, not a migration (design §2).** This batch migrates no existing CSS
  values; it only records the baseline.
- **No new dependency in this batch.** The DropdownMenu dependency arrives with task 2.6.

## Non-goals

- No strip, settings, drawer or dock rework; those are groups 2–5.
- No CSS value migration beyond the 1.5 motion rules.
- No change to `extra-keys.json` handling, the terminal, the server or the protocol.

## Pre-existing uncommitted work (baseline, not part of this batch)

Earlier the same day, other batches left uncommitted edits in:

- `mobile/useSoftKeyboard.ts(+test)`
- `App.tsx(+test)`
- `mobile/ExtraKeysBar.tsx(+test)`
- `mobile/extra-keys.ts(+test)`
- `mobile/key-icons.tsx`
- `index.css` (the extra-keys rules)
- `README.md`
- `openspec/changes/ui-rework/**`

The diff against `HEAD` (b9d266c) contains them. Batch 1 must preserve them, and an inspection should
judge them only for regressions caused by this batch.

## Risks

- **[Realigning glyph-asserting tests hides a real regression]** → Each realigned assertion moves to
  the icon or the accessible name, never deleted outright. The adversarial review checks every
  changed assertion.
- **[`tab-meta.ts` kind icons change type]** Consumers (strip, drawer, chooser) render via `<Icon>`
  → Typecheck catches every consumer.
- **[`.app.mobile` scoping misses portalled content]** → Mitigated by the `pointer: coarse` media
  query, which matches how `mobileMode: auto` detects touch.

## Verification (proof commands)

- `yarn typecheck`, `yarn lint` (0 errors; existing warnings allowed) and `yarn test`, all from the
  repo root. All must pass.
- Smoke without touching production:

  ```bash
  # from the repo root; the subshell keeps the cwd at the root for the next command (R7)
  (cd packages/client && npx vite build --outDir /tmp/palmux-smoke/dist --emptyOutDir)
  ```

  Then serve it from a FRESH temp config directory, `/tmp/palmux-smoke/cfg`, which holds:
  - `config.json`:
    `{"host":"127.0.0.1","port":44099,"restoreSessions":false,"shell":"/bin/bash"}`
  - a no-op `theme-hook.mjs` (`export {};`). Its presence replaces the built-in Claude theme export
    (`theme-export.ts:212–222`), so nothing is written to `~/.claude/themes/palmux.json` (R2).

  Start it from the repo root (`/home/user/projects/palmux`):

  ```bash
  cd /home/user/projects/palmux
  PALMUX_HOST=127.0.0.1 PALMUX_CLIENT_DIR=/tmp/palmux-smoke/dist \
    PALMUX_CONFIG_DIR=/tmp/palmux-smoke/cfg PALMUX_NO_AUTH=1 \
    node node_modules/tsx/dist/cli.mjs packages/server/src/index.ts
  ```

  Auth is disabled ONLY together with an explicit loopback bind; the env var and `config.json` both
  pin `127.0.0.1` (R1). Stop the server afterwards by PID, after confirming its environment carries
  the smoke config directory. Check with Playwright at 1440×900 and 390×844 (mobile mode on):
  - no console errors
  - the drawer footer shows four SVG icons
  - the New-tab chooser buttons show SVG icons
  - a right-click tab menu appears
- The production `packages/client/dist` is NOT rebuilt by this batch.

## Deviations recorded after approval

- **Press feedback is colour-only (criterion 5).** The approved plan specified `scale(0.97)` on `:active`
  for `.ui-btn`/`.ui-icon-btn`. Inspection 2 (finding B1-001) showed that scaling the button shrinks its
  hit area: `pressKbdMove`/`pressMove` cancel on `pointerleave`, so a press near an edge cancelled itself.
  The transform was therefore removed. The token-derived pressed background, distinct from hover, is now
  the only press cue on every motion setting, and tests forbid any transform on `:active`. This still
  satisfies the `ui-primitives` delta ("feedback the moment pressed", "MUST NOT change the control's
  layout box", colour-only under reduced motion). It also matches the owner's choice of a subtle
  background change on the extra-keys bar. Inspection 3 (R2) flagged that this text and the code
  disagreed; this note reconciles them.
- **Open at batch close (inspection 3, R1, medium):** `ui/scale.test.ts` parses CSS strings without
  escape awareness. An escaped quote in a `content` string can swallow later declarations, and a quoted
  font family containing `/` can mislead `fontShorthandSize`. No current stylesheet triggers either
  case, verified by a scan. The fix is queued as the first item of batch 2: move declaration parsing to
  PostCSS, which is already a dependency.
