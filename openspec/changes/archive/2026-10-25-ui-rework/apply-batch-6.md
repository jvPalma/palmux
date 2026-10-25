# ui-rework — apply batch 6 (group 7: drawer rows as pills)

Batch plan for the OpenSpec change `ui-rework`.

**Contracts:**
- `tasks.md` 7.1–7.2
- spec `mobile-drawer`, requirement "Drawer rows and groups wear the desktop strip's pills"
- `CLAUDE.md` "The tab strip is PILLS" (the tokens and their measured contrast)

The owner asked, after deploying batches 1–5: "as pills em desktop, devem de estar tambem na mobile
drawer". Batches 1–5 are in production; this batch is client CSS plus a small render change.

## What exists

- **Desktop pill tokens** are declared on `.session-tabs` only (`index.css:~2080`): `--pill-border`,
  `--pill-fill`, `--pill-ring`, `--pill-text`, `--pill-hover`, `--cluster-pad`. The pill is `.ctab`
  (~2112), the active pill `.ctab.active` (~2145), the group `.group-cluster` (~2257) and its
  `.group-chip` (~2283). The desktop chip's colours come from TWO helpers (`SessionTabs.tsx:~858`):
  `tabColorValue(g.color)` for `--group-accent` (the fill) and `tabColorInk(g.color)` for
  `--group-ink` (the text over it), both in `tab-meta.ts:~61–68`.
- **Drawer rows** (`index.css:~1526–1745`, `session/SessionDrawer.tsx:~823–880`) are FLAT leaves:
  every row, header or member, is its own `.drawer-leaf` > `.drawer-leaf-inner` (`overflow: hidden`,
  the clip that lets a leaving row's track collapse to `0fr`) > `.drawer-row`. A group header is a
  `.drawer-row.drawer-row-group` holding a `.drawer-group` button (caret, dot, label, count); members
  are `.drawer-row.grouped` with a 2px spine and an indent. The active row today is
  `color-mix(surface, text 10.5%)` plus `box-shadow: inset 3px 0 0 var(--t-accent)`. Rows are
  separated by `margin-bottom: 2px`. `.drawer-session` is opaque (`--t-mantle`) because the swipe
  Close action waits behind it.

## Acceptance criteria

### A. One set of pill tokens

The `--pill-*` and `--cluster-pad` declarations move from `.session-tabs` to a selector both hosts
match (`.session-tabs, .drawer-sessions`), unchanged in value, so the drawer cannot drift from the
strip. `tab-strip-css.test.ts` and its contrast check keep passing; a new stylesheet test asserts the
drawer's row rules read `var(--pill-border)`, `var(--pill-fill)`, `var(--pill-ring)` and
`var(--pill-text)` rather than restating any colour mix.

### B. A session row is a pill

- `.drawer-session` gets a 1px `--pill-border` border, `--r-2` radius, `--pill-text` text at rest,
  and stays `--ctl-h` tall (36px under the mobile class). It stays OPAQUE at rest (the Close action
  sits behind it): its rest background is the drawer's own surface, so it reads as "no fill".
- The ACTIVE row: `--pill-fill` background, the `--pill-ring`, `--t-text`, weight 600. The 3px
  accent edge is removed. Colour still appears only in the dot.
- **The ring must not be clipped.** `.drawer-leaf-inner` clips with `overflow: hidden`, and the
  desktop ring is an OUTSET 1.5px shadow. Either the leaf-inner gains enough padding for the ring
  (and the row margin shrinks by the same, so row pitch is unchanged), or the drawer uses the same
  ring inset. The builder picks one and states it; a screenshot at 390×844 dpr 2 must show all four
  sides of the ring.
- Pressed (`:active`), armed, lifted, revealed (swipe), drop-before/after and drop-inside states keep
  working and stay distinguishable from the active ring; the lifted shadow stays.
- Rows are separated by `--sp-1` (4px), each row's own spacing inside its leaf clip so a leaving
  row takes its gap with it (as today).

### C. A group is a framed cluster

- The group header becomes the CHIP: filled `--group-accent`, `--group-ink` text, `--r-2`, holding
  the caret, the label and the count (the dot is redundant on a filled chip and goes). It stays a
  button with the same `data-testid`, `aria-expanded`, tap-to-collapse and long-press/drag handling.
- One continuous 1px `--group-accent` frame with `--r-3` outer radius surrounds the chip and its
  VISIBLE members, with `--cluster-pad` inside it. Because the rows are flat leaves, the frame is
  assembled from per-row segments: the render marks each LEAF's position in its group
  (`group-first` on the header, `group-mid` on members, `group-last` on the last member; a
  collapsed group's header is both first and last). The member spine and the indent go (the frame
  replaces them).
- **The segments sit on the STATIONARY element, never on what a drag moves (B6-03).** A drag
  translates and scales `.drawer-row` (`SessionDrawer.tsx:~603–639`), so a segment on the row would
  travel with the finger and leave a hole in the frame. Segments go on `.drawer-leaf-inner`, which
  holds the slot while its row is lifted: dragging the header, a middle member or the last member
  leaves the frame closed in place while the pill (without segments) follows the finger.
- No gap in the frame between rows: inside a group, the vertical spacing is padding within the
  framed segment, not margin outside it.
- **Leaving rows: a trailing one leaves the frame, an interior one bridges it (B6-04, B6-05).**
  Positions (`group-first`/`-mid`/`-last`) are computed from the rows of `tracked` that are NOT
  `leaving`. Then each leaving row of a group is one of two kinds:
  - **Trailing** — no surviving row of its group below it (the last member closing, or every member
    of a collapsing group). It draws NO segments: `group-last` moves to the surviving row above at
    once and the frame closes there, because the leaf's clip would cut a bottom edge off long before
    the row unmounts. A collapse makes the header first+last at once.
  - **Interior** — surviving rows of its group both above and below (closing A in
    [header, A, B]). Its leaf takes `group-bridge`: the two SIDE segments only, on
    `.drawer-leaf-inner`, so they shrink with the slot's height to zero and the frame never opens
    between the header and B. The fade must not take the bridge with it: in a bridge leaf the opacity
    transition applies to the row (the pill), not to the leaf or its inner box; the height collapse
    is unchanged.
  Tests assert the classes per phase for: the last member closing, the FIRST member closing, a middle
  member closing, and a collapse; the smoke screenshots a middle-member close and a collapse
  mid-transition.
- `--group-accent` and `--group-ink` are set on every leaf of the group (the header today only
  colours its dot): `--group-accent` from `tabColorValue(group.color)` and `--group-ink` from
  `tabColorInk(group.color)` (B6-02), exactly as the desktop chip does, falling back to
  `--t-accent` / `--t-accent-ink` like `.group-cluster`. The chip's caret, label and count all read
  `--group-ink`; `member-active` no longer changes the chip's colours (the desktop rule).

### D. Docs and verification (7.2)

- CLAUDE.md's "A row is `{dot} {kind icon} {title} {number}`" paragraph and the drawer group
  sentences describe the pills, the shared tokens, the frame, and why the frame is per-row segments.
- Tests: the stylesheet assertions in A–C; a render test that a two-member expanded group marks
  first/mid/last correctly, a collapsed one marks first+last on the header, and that the classes
  follow a member leaving; every existing `SessionDrawer.test.tsx` gesture test stays green.

## Clusters

One builder (`claude-sonnet-5-5`, xhigh): `packages/client/src/index.css` (the strip token block and
the drawer row section only), `session/SessionDrawer.tsx`, `session/SessionDrawer.test.tsx`,
`session/tab-strip-css.test.ts` (only if a token-location assertion needs it), `ui/scale-baseline.json`
must stay `{}`, `CLAUDE.md` (the drawer row paragraph only).

## Non-goals

- Horizontal pills in the drawer (it stays a vertical list).
- Any behaviour change to drag, the menu, swipe-to-close, collapse or the keyboard hold.
- The drawer's mono `‹` headers and footer (a separate open item awaiting the owner).

## Risks

- **[The ring clips or the pitch changes]** → the screenshot check in B; row pitch measured before
  and after (it may change by at most the 2px → 4px gap).
- **[A frame with a gap or an open edge during a leave]** → the render test plus a real-touch close
  of the last member on loopback, screenshotted mid-transition.
- **[Drop markers hidden by the frame]** → drop-before/after lines and the drop-inside ring checked
  on a grouped row in the smoke.

## Verification (proof commands)

- `yarn typecheck`, `yarn lint` (0 errors) and `yarn test`, from the repo root.
- Isolated smoke, launched with `PALMUX_HOST=127.0.0.1` AND `"host":"127.0.0.1"` in its config.json
  (B6-01: `PALMUX_NO_AUTH` only disables auth, the default listener is 0.0.0.0), port 44099, config
  under /tmp, client built into /tmp. Before any request, `ss -ltnp` must show the listener bound to
  127.0.0.1:44099 only. 390×844 dpr 2 with real CDP touch: drawer open → screenshot (pills, active ring on all four sides, group frame
  continuous); long-press drag a row into the group and out; swipe-left a grouped member and close
  it (screenshot mid-transition: frame closed); hold a middle member and the last member lifted
  (screenshot: frame closed in place); tap the group chip to collapse and expand (screenshot
  mid-transition). No console errors. Production untouched.
