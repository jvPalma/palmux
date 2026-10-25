# ui-rework — apply batch 7 (group 8: drawer switcher on top, its contrast, a real settings icon)

Batch plan for the OpenSpec change `ui-rework`. Batches 1–6 are in production.

Owner feedback after the batch-6 deploy (2026-10-25), verbatim:
1. "a tab na drawer de mobile com o 'sessions | explorer | dictation' nao gosto de a ver em baixo"
2. "adicionalmente isto usa um fgcolor com pouco contraste"
3. "o icon das settings é um Sol, nao faz sentido. tem de ser um gear symbol ou qq outra coisa."

## What exists

- **The switcher** is a kit `Segmented` (`session/SessionDrawer.tsx:~1141–1154`, `.drawer-views`
  / `.drawer-views-seg` in `session/drawer-views.css`) rendered ABOVE THE FOOTER in every view,
  Settings included (where no segment is selected). Its options come from `SWITCHER_VIEWS` (~142):
  Sessions, Explorer, Dictation, icon-only with a visually hidden name. It keeps `keepFocus` (selects
  on pointerdown with the tail mark) so switching never blurs `#mobile-kbd`.
- **The top row** (`.drawer-top`, ~969) renders only `atRoot` (`view !== 'settings' && !chooserOpen`,
  ~479) and holds the Settings `IconButton` (left) and Close (right), `justify-content:
  space-between`.
- **Contrast:** an unselected `.ui-seg-item` is `color: var(--t-subtext)` (`ui/ui.css:~336`), the
  selected one `--t-accent` fill with `--t-accent-ink`. On the drawer's mantle the dim icons read as
  disabled.
- **The settings icon** (`ui/icons.tsx:~279–287`) is deliberately a sun (a comment says it kept the
  dock's old glyph). It is used by the drawer's top Settings button, the desktop rail's pinned
  Settings button and the app menu's Settings item.

## Acceptance criteria

### A. The switcher moves to the top (item 1)

- At the drawer's root views (Sessions, Explorer, Dictation — exactly where `.drawer-top` renders
  today) the top row is ONE line: Settings `IconButton` · the switcher · Close `IconButton`, the
  switcher taking the space between them (flex 1, min-width 0). The `.drawer-views` block above the
  footer is gone.
- In the sub-surfaces (Settings, the New-tab chooser) the switcher is not shown: their `‹` back
  header is the top control, as today, and the footer stays where it is. Reaching Explorer or
  Dictation from Settings is one back press away, which is the same depth as the chooser.
- Behaviour is unchanged: `keepFocus`, `hostedViews` availability, the selected value, the testid
  `drawer-view`, the accessible names, the tail-mark on pointerdown.
- CLAUDE.md's thumb-reach paragraph (the order "footer, switcher just above it, list, Settings at the
  top") and the `drawer-views.css` header comment are rewritten to the new order, and the spec
  `mobile-drawer` requirement "Drawer navigation is ordered for thumb reach" is amended by the
  coordinator before the build (owner decision, overriding D5's bottom placement for the switcher).

### B. The switcher's unselected items read as live (item 2)

- In the drawer switcher, an unselected item uses `var(--pill-text)` (the strip's inactive text:
  85% text toward mantle) instead of `--t-subtext`; hover/pressed may go to `--t-text`. The selected
  item keeps the accent fill and ink. Scoped to `.drawer-views-seg` (or its new top-row container):
  the kit's own Segmented colour, used by Settings and the file pane, is not changed in this batch.
- **The selected item keeps its ink while hovered or pressed (B7-001).** The kit's
  `.ui-seg-item:not(:disabled):hover` (`ui/ui.css:~347`, `--t-text`) out-specifies the selected rule
  (`~351`), so hovering the selected segment puts pale text on the accent fill. A drawer-scoped rule
  for the selected item in the hover and active states restores `--t-accent-ink` (and the accent
  fill), with enough specificity to beat the kit hover rule regardless of stylesheet order. Other
  Segmented consumers are untouched.
- A stylesheet test asserts the drawer switcher's unselected colour resolves to `--pill-text`, and that
  the selected item's colour stays `--t-accent-ink` in the rest, hover and active states (resolving the
  cascade with ui.css loaded both before and after drawer-views.css, as `ui.test.tsx` already does for
  the trigger type)
  (which `.drawer-sessions` already declares; the switcher's container must be inside a scope that
  declares `--pill-*`, or the token declaration is extended to cover it).

### C. Settings is a gear (item 3)

- `icons.tsx`'s `settings` glyph becomes a cog/gear in the module's house style: 24-unit viewBox,
  `stroke="currentColor"`, stroke 1.75, round caps and joins, no fill. The sun comment goes.
- Every place that shows the settings icon gets the gear (drawer top button, desktop rail, app
  menu), with no call-site change.
- `ui/icons.test.tsx` keeps passing (every icon an SVG, stroke 1.75, currentColor); a test asserts the
  settings glyph is no longer the sun (e.g. it is not the 3.5-radius circle + eight rays shape).

## Cluster

One builder (`claude-sonnet-5-5`, xhigh): `session/SessionDrawer.tsx`, `session/SessionDrawer.test.tsx`,
`session/drawer-views.css`, the drawer section of `index.css` only if the token scope needs it,
`ui/icons.tsx`, `ui/icons.test.tsx`, `CLAUDE.md` (the drawer thumb-order sentences only).
`ui/scale-baseline.json` stays `{}`.

## Non-goals

- The kit Segmented's colours elsewhere; the drawer's mono back headers and footer (open owner item).
- Any change to the footer, the list, gestures or the keyboard hold.

## Verification

- `yarn typecheck`, `yarn lint` (0 errors), `yarn test`.
- Isolated smoke: `PALMUX_HOST=127.0.0.1` and `"host":"127.0.0.1"` in a fresh /tmp config, port
  44099, the listener confirmed on 127.0.0.1 only (use `command ss`, since `ss` is a shell alias here),
  client built into /tmp. 390×844 dpr 2 with CDP touch: open the drawer → screenshot (top row:
  gear · switcher · close; no switcher above the footer); tap Explorer then Dictation then Sessions in
  the top switcher with `#mobile-kbd` focused → it stays focused; Settings and the New-tab chooser show
  no switcher. Desktop 1440×900: the rail's pinned Settings and the app menu show the gear.
