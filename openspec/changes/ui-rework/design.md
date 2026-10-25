# Design

## Context

For motivation, see proposal.md (Why). The review page holds the measured evidence: screenshots,
counts and pixel samples (`~/.agent/diagrams/palmux-ui-review.html`). Constraints that shape the
approach:

- **Styling.** Palmux styles with plain CSS over eight `--t-*` colour tokens and a Radix-headless kit
  (`client/src/ui/`). There is no Tailwind, no shadcn and no icon library. `ui.test.tsx` already
  forbids colour literals in `ui.css` and off-tier durations.
- **Motion.** The contract has four tiers (0/140/240/380ms) and nothing animates inside the terminal
  grid.
- **Drawer gestures.** `SessionDrawer.tsx` owns its pointer gestures (`rowDown`/`rowMove`/`rowUp`,
  a 450ms long-press sheet). `press`/`pressMove` exist because a pointerdown action kills list
  scrolling and blurs `#mobile-kbd`. Any new drawer gesture has to live inside that model.
- **Viewport hold.** `App.tsx`'s viewport effect already holds the layout while a native selection
  is live (`deferred`) and re-raises the keyboard afterwards (`shouldRestoreKeyboard`). Today that
  path re-pins before re-raising the keyboard, which costs two resizes; the in-flight fix re-raises
  first with a 600ms fallback.
- **TreeView.** The DGSL `TreeView` (`~/dgsl/design/ds/src/ui/TreeView/`) is Tailwind +
  `lucide-react` and lives in another repository. Its behaviour is in `rows.ts`, `types.ts` and the
  drop maths in `TreeView.tsx`, which are pure. Its drag uses HTML5 `draggable`/`DragEvent`.
- **Tests.** `session/tab-strip-css.test.ts` pins the current strip's shape and must change with it.

## Goals / Non-Goals

**Goals:**

- Land the owner's D1–D8 answers as one coherent visual system, phase by phase. Each phase is
  verifiable on the phone and on the desktop before the next one starts.
- Make harmony mechanical: a scale with a guard test, so `yarn test` catches drift instead of the eye.
- Reuse existing paths (viewport hold, reorder and group operations, `SettingsFields`,
  theme-preview painting) instead of building parallel ones.

**Non-Goals:**

- No change to the wire protocol, the server, tab ids, or the split, group and reorder data model.
- No light/dark redesign of the palette and no new colour tokens. Depth stays base → mantle → surface.
- No change to the terminal canvas, xterm theming or the extra-keys bar (closed earlier the same day).
- No drag-to-split on mobile. Pairings stay desktop-only, per `split-fusion`.

## Decisions

### 1. The tab look is settled by a tunable prototype before any strip code

The owner picked the pills (B) but reserved the final look: "o active TAB tem de ter mais contraste,
e todos os tab items têm de ter um subtle border… tenho de ver para decidir". The tab phase therefore
opens with a self-contained prototype page on the visual-explainer gallery. It uses the owner's real
tab names and the Cobalt Next palette, and its knobs are:

- active fill step
- ring strength
- border alpha
- pill radius
- gap
- inactive text strength

It also has a light-theme toggle. The owner tunes the knobs and copies back the values, and the
values become the strip's CSS variables.

- **Alternative: iterate directly in `SessionTabs`.** Each round costs a client build and a reload
  on two devices.
- **Alternative: lock values now.** That ignores an explicit "tenho de ver".
- **What the spec pins instead.** The spec fixes only what is observable and not up for taste: a
  contrast floor of at least one surface step, a ring, a border on every pill, and colour never
  marking the active pill.

**Owner's tuned values (task 2.2, 2026-10-24),** copied verbatim from the prototype:

```css
/* palmux tab pills: fill step 1.5, ring 1.5px at 60%, border 10%, radius 8px, gap 6px, inactive text 85%, min width 92px, height 28px; dark (Cobalt Next Minimal); fits 9 of 9 at 1440px; active vs strip 1.81:1, dL +21.2 */
:root {
  --pill-fill-step: 1.5;   /* fill = mix(surface, text, step x 7%) */
  --pill-ring-w: 1.5px;
  --pill-ring-a: 60%;
  --pill-border-a: 10%;
  --pill-r: 8px;
  --pill-gap: 6px;
  --pill-inactive-text: 85%;
  --pill-min-w: 92px;
  --pill-h: 28px;
  --pill-theme: dark;   /* Cobalt Next Minimal */
}
```

The active fill is `color-mix(surface, text, 10.5%)`, and the measured contrast against the strip is
1.81:1 (ΔL +21.2). That clears the spec's floor of at least one surface step. Two values sit OFF the
scale from §2: radius 8px (scale 4/6/10) and gap 6px (4px grid).

**Owner decision (2026-10-24): snap to the current scale.** Radius becomes `--r-2` (6px), the
controls radius; `--r-3` (10px) is for cards and panels. Gap becomes `--sp-2` (8px), the nearest
4-grid step. All 9 pills still fit at 1440px (9 × 92 + 8 × 8 = 892px, plus the group chip, well under
the strip width). The other values stand as tuned: fill step 1.5, ring 1.5px at 60%, border alpha
10%, inactive text 85%, min width 92px, height 28px (= `--ctl-h`). The ring width (1.5px) is a border
width, which the scale guard does not govern.

### 2. One scale, enforced by a ratchet rather than a big-bang rewrite

Scale variables go next to the colour tokens in `index.css`:

- `--fs-1…4`: 11, 12, 13, 15
- `--fs-mono`: 13
- `--sp-1…6`: 4, 8, 12, 16, 20, 24
- `--r-1…3`: 4, 6, 10, plus `--r-pill`
- `--ctl-h`: 28 on desktop, 36 under the mobile class

A guard test scans every client stylesheet for font-size, padding, margin, gap, border-radius and
height/min-height literals and fails on any value outside the scale. A per-file **baseline count**
may only go down. Each phase migrates the files it touches, and the baseline reaches zero in the
final phase.

- **Alternative: migrate all ~5,100 lines of CSS first.** That is one huge diff that changes every
  surface before anyone can see one. The ratchet lands the rule on day one and the cleanup with the
  surfaces that motivate it.
- **Exempt from the scan:** the terminal grid and user font sizes (`fontSize` setting), `1px`
  hairlines, `0`, percentages and the extra-keys measurements already tuned on the device.

### 3. One icon module, grown from `key-icons.tsx`

`mobile/key-icons.tsx` already defines the house style: 24-unit viewBox, stroke 1.75, round caps,
`currentColor`. It becomes `ui/icons.tsx` with named exports. The bar keeps its import path through a
re-export.

- **Icons added:** close, menu, settings, upload, download, folder, file, pin, link, globe, book,
  pencil, plus, split, chevron, check, warning, record.
- **Emoji call sites replaced:** about 24 (the dashboard, the Explorer actions, the drawer footer,
  menus, toasts).
- **Material file icons stay.** They are vendored file-type art (`/file-icons/`), not chrome.
- **Alternative: add `lucide-react`.** That adds a dependency, a second visual dialect against the
  key icons, and tree-shaking concerns. Palmux needs about 25 glyphs.

### 4. The drawer's keyboard hold generalises the selection hold

The viewport effect's `deferred` flag currently means "a native selection is live". It becomes "the
layout is held". Two sources set it: a live selection and an open drawer, the latter passed from
`App` state through a ref, so the effect does not re-subscribe.

- **On drawer open,** record whether the keyboard is up: `#mobile-kbd` is focused and the pinned
  height is below the screen by more than `KEYBOARD_GONE_PX`.
- **While held,** viewport events update nothing.
- **On close,** run the same release path the selection uses: re-raise first if the keyboard was up,
  then re-pin on the fallback timer. That path is already measured to cost at most one resize.
- **The drawer becomes full-width** (`inset: 0` inside the app frame). It stays above the
  extra-keys bar's z-order and in the normal stacking context, so `--app-height` still bounds it.
- **Alternative: blur and re-focus the keyboard around the drawer.** The owner rejected that
  explicitly: "não quero forçar a fechar". He types, opens the drawer to upload a screenshot, and
  keeps typing.

### 5. The drawer tree ports TreeView's model; a spike picks the input layer

Port `rows.ts` and `types.ts` almost verbatim: flatten nodes to rows with depth, ancestors and
siblings. Port the drop computation: top quarter = before, bottom quarter = after, middle = inside,
and never onto self, a descendant or the current place.

- **Mapping.** Groups are parent nodes, tabs are leaves, and the list is two levels deep.
- **A drop becomes the existing operations:**
  - before/after → `reorderTabs`
  - inside a group, or before/after a member → `groupUpdate { addIds, order }`
  - top level out of a group → `groupUpdate { removeIds, order }`

  These are the same calls the strip's drag already makes, so the server's forgiving permutation
  guarantees nothing is lost.
- **Input layer: undecided until a spike on the S26.** TreeView drives drag with HTML5
  `draggable`. The owner reports it works on mobile with long-press; that is unverified on this
  device and conflicts with the drawer's own long-press menu and `touch-action` handling.
  - **The spike:** open the DS Storybook TreeView story on the S26 over adb and record whether
    long-press drag starts, whether the list still scrolls, and whether `contextmenu` fires.
  - **If HTML5 drag works:** use it, and bind the row menu to `contextmenu`.
  - **If not:** drive the same drop model with pointer events, inside the existing
    `rowDown`/`rowMove`/`rowUp` handlers. Hold for 450ms to arm, past 10px to drag with pointer
    capture on the list, release without moving to open the menu.

  Either path leaves the model, the operations and the tests unchanged.
  **Decision (2026-10-25, batch 4): pointer events, taken WITHOUT the spike.** adb to the S26 was
  down after the network outage, so the spike could not run. The pointer path is the specified
  fallback and the safer one: the drawer already owns its touch gestures, and HTML5 drag would
  compete with them, with the list's pan and with the long-press menu. Built as above, plus one
  non-passive `touchmove` listener that cancels the native pan only while a row is armed or
  dragging. The spike stays owed to the owner; if it shows HTML5 drag working, only the input layer
  changes.
- **Swipe-left-to-close** reveals a close action by translating the row's content on `transform`
  (micro tier). The drawer itself opens with a right→left swipe on the extra-keys bar, not on rows,
  so the two gestures cannot collide. A swipe right on a row cancels the reveal.
- **Alternative: import `@design/ds`.** It is a different repository, Tailwind-based, and built for
  Next. Palmux would need its whole toolchain.

### 6. Settings layout is CSS plus one sub-view; the theme browser reuses the preview painter

- **Layout.** `SettingsFields` keeps its field list. The change is markup and CSS:
  - each section's rows go in a `.set-card`
  - rows use a two-column grid with a fixed `--set-control` column
  - the Font `<select>` becomes the kit Select
  - the section header gets `:focus-visible`
- **Theme browser.** The Theme row renders a Button that pushes a `theme` sub-view inside the
  hosting container. That is the same shape as the drawer's `‹ New tab` sub-surface, and the dock
  gets the same stack. The list reuses `theme-preview.ts`, so each entry paints itself. A tap calls
  the existing theme setter, which applies and persists, and the list stays open. A checkmark marks
  the current theme.
- **Alternative: keep the Radix Select popup.** The owner asked for a full list he can browse
  "sem sair daquela janela"; a 300px popup over the dock is the thing being replaced.

### 7. The app menu needs `@radix-ui/react-dropdown-menu`

The wordmark's replacement is a menu button with menu semantics: roving focus, typeahead, Escape.
That is Radix DropdownMenu, the same family and styling path as the `ContextMenu` the kit already
wraps.

- **Alternative: a Popover with buttons.** It loses menu semantics and keyboard behaviour.
- **This is the only new dependency.**

### 8. Motion additions stay inside the existing tiers

| Addition | Tier | How |
|---|---|---|
| Drawer scrim | 240ms surface | opacity, exit at 70% |
| Popovers and menus | 140ms | `scale(.97)` + opacity from `--radix-*-transform-origin` |
| Kit button press | instant | instant press, 140ms release |
| Row enter/exit | 140ms | opacity + `translateY(4px)`, transitions |

Each one lands on a tier the guard already accepts. The review's rejected list stays rejected: tab
switch, a sliding active indicator, dock width, anything over the terminal.

## Risks / Trade-offs

- **[Prototype values never converge]** → Cap at two tuning rounds. If the owner is still unsure,
  ship his last values behind the CSS variables and revisit on real use; the variables make a later
  change one line.
- **[Pills cost strip density]** Gaps and borders fit fewer tabs before scrolling → The minimum
  width drops (it is pinned in the spec only as "a minimum"), and the prototype shows 9 real tabs
  at 1440px so the trade is visible before it is built.
- **[The ratchet guard is noisy]** It may flag legitimate one-offs → Explicit exemptions in the
  test (hairlines, terminal metrics, extra-keys) and a comment-pragma escape for a single line,
  reviewed like a `// oxlint-disable`.
- **[The drawer hold strands the layout]** If the drawer closes on a path that skips release, the
  terminal stays at keyboard height → Release on every close path (scrim, back, selecting a tab,
  the view switcher) through one `closeDrawer()`, plus the 600ms fallback that already rescues the
  selection path.
- **[HTML5 drag on Android]** It may fight scrolling or the menu → The spike decides before any tree
  code. The pointer-driven fallback is fully specified and shares the model.
- **[A swipe-to-close slip]** Destroys work → It only reveals the action and needs a second tap.
  Terminal closes keep their confirmation.
- **[Visual tests break wholesale]** `tab-strip-css.test.ts` pins the old shape → Rewrite it in the
  tab phase to pin the new contract (border on every pill, raised active, chip fill independent of
  activation, split glyph present when inactive).

## Migration Plan

- **Rollout.** Client-only. Each phase deploys with `yarn workspace @palmux/client build`, because
  production serves this checkout's `dist`, plus a reload on each device. No server restart.
- **Rollback.** Revert the phase's commit (the owner's git) and rebuild.
- **Persisted data.** Unchanged. Colours keep their slot names, and groups and order are untouched.
- **Docs.** CLAUDE.md's tab strip, split fusion, drawer and `--mbtn-h` paragraphs are rewritten in
  the phase that changes each one. `tips/tips.ts` gains the drawer long-press and swipe gestures.

## Open Questions

- **The exact scale values for the mobile control height (36) and the pill minimum width.** The
  prototype and the first device pass can tune them without changing the specs.
