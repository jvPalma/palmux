# Batch E — mobile: drawer segment, review bar, swipes, focus; then the docs pass

Change: `source-control-review`. Tasks **10.1, 10.2, 10.3, 10.4** and the tips half of **10.5**. Contract:
`design.md` D12; specs `mobile-drawer` delta, `diff-review` "The review is navigable…" (mobile part) and
"The review bar keeps the bar's swipes", `ui-primitives` "Scroll surfaces never compete…". Read CLAUDE.md's
mobile, drawer, press-helper (`consumeGesture`, `pressMove`, `pressClick`), extra-keys and keyboard-hold
sections in full: this batch lives inside those rules.

## E1 — drawer
- `packages/client/src/session/SessionDrawer.tsx` (+ test): a fourth Segmented item `scm` with the
  `git-branch` icon in `SWITCHER_VIEWS`, declared in `hostedViews`; App supplies the body
  (`SourceControlView`), and choosing a file calls `closeDrawer()` then opens the review. A 390px layout
  check: four segments plus the gear and Close fit in the top row without truncation.

## E2 — the review bar (after E1)
- `packages/client/src/mobile/ReviewBar.tsx` (+ test) and its CSS: rendered by App in the extra-keys bar's
  slot while the ACTIVE TAB is a review (reading the active tab's kind as the editor routing does): ≡ file
  list (opens the drawer on the Source Control view), ↑ previous file, ↓ next file, ✓ Reviewed (Changes) or
  ↩ Unstage (Staged), at `--ctl-h`, NO terminal keys, NO `press*` helper: one release-time tap/swipe
  pointer machine (ExtraKeysBar's shape: pointerdown records; release inside the 10px slop acts; horizontal
  travel past the swipe threshold is a swipe and acts on nothing; any other move or pointercancel acts on
  nothing; `consumeGesture` on the acting release; `detail === 0` click acts once).
- Swipes: right→left opens the drawer; left→right returns to the tab that was active before the review was
  opened (App records it when a review becomes active), or the first terminal if gone; the extra-keys bar
  returns with that tab.
- The comment textarea keeps focus; on save or cancel focus returns to `#mobile-kbd` only if it held focus
  before (task 10.4). List rows keep `pressMove`.
- `App.tsx` for the slot switch and the previous-tab record; `tips/tips.ts`.
- Tests: the extra-keys bar is not rendered for a review tab and returns for a terminal; each button acts on
  a tap; a swipe starting on EVERY button, both directions, activates none of them; both swipe scenarios.

## Docs pass (after every batch): `CLAUDE.md`
Tasks 4.3, 5.5, 6.7, 8.3, 9.6, 10.5: the kit's ScrollArea/VirtualList (why the virtual list is its own
scroll container), the Source Control dock view and rail order, the review pane (rows model, fetching and
memory bounds, anchoring, layouts, colouring and the bridge as a subscription list), keys and Reviewed,
comments (storage, versions as provenance, content-driven display, sync), the drawer segment, the review
bar and the rewritten "extra-keys bar is ALWAYS present" paragraph ("a bar with the drawer swipe is always
present"). Match CLAUDE.md's voice; extend batch A's "Source Control" section rather than adding a second.

## Gates
- `cd packages/client && npx tsc -p tsconfig.json --noEmit`
- `cd packages/client && npx vitest run src/session src/mobile src/review src/tips src/App.test.tsx`
- `npx oxlint packages/client`
