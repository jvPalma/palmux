# Design — Tab Strip Redesign and Split Fusion

## Context

The strip today is Chrome-cosplay: rounded 30px tabs with curved-notch pseudo-elements, tab color
as a 3px TOP stripe + faint wash (`.ctab.colored`), groups as pill chips, and 12 invented accent
colors (`TAB_COLORS` → `--tab-c-<name>` CSS vars derived in `themes.ts`). Splits are ONE hidden
pairing (`useSplit.ts` `SplitState`): visible only while the active tab is a member
(`splitDisplayed`/`memberSlot`), signalled by ◧/◨ badges, destroyed by opening a second split, and
created via invisible edge drop zones with no placement preview. All decisions below were locked
with João over live mockups (2026-07-20, `.superpowers/brainstorm/`); the server must stay
fusion-ignorant and splits stay per-device.

## Goals / Non-Goals

**Goals:**

- Flat solid-fill strip (tabs AND group buttons), readable active/inactive states, theme-true
  colors from each profile's `ansi16`.
- Splits as first-class strip citizens: one fused button per pairing, any number of pairings,
  placement preview while dragging.
- Net-negative complexity in App: the display-scoping machinery is deleted, not ported.

**Non-Goals:**

- No wire-protocol or server changes; no server knowledge of pairings.
- No 3+ pane splits, no nested pairings, no split support in the mobile layer or popouts
  (unchanged: mobile forces single-pane).
- No layout editor or new persistence surfaces beyond the versioned localStorage blob.

## Decisions

**D1 — Accent rendering: solid fill + luminance-flipped ink, all via CSS vars.**
`applyThemeTokens` already computes theme-aware tab colors; it now also emits an ink var per slot
(`--tab-c-<slot>-ink`: dark ink on light accents, light on dark — same luminance helper the UI
token derivation uses). A tab button sets `--tab-accent`/`--tab-ink` inline; CSS does
`background: var(--tab-accent)` active and `color-mix(in srgb, var(--tab-accent) 8%, transparent)`
inactive (the locked 8% tint, over the strip's base). Uncolored tabs fall back to the theme accent
(`--t-accent`, locked variant A). The curved-corner pseudo-elements, top-stripe background trick,
and reorder-bar/box-shadow workaround notes all disappear; the insertion bar keeps box-shadow, now
trivially since no background-clip stripe competes.

**D2 — Palette: 16 ANSI slots, legacy names resolved forever, no data rewrite.**
`TAB_COLORS` becomes the 16 slots `ansi0`–`ansi15` (`--tab-c-ansi<N>`), values regenerated per
theme from `profile.ansi16` (replacing `deriveAccents`' 12 invented hues). Persisted color names
are opaque server-side, so instead of rewriting `tabs.json`/`groups.json`, `tabColorValue` keeps a
static legacy map (red→ansi1, green→ansi2, yellow→ansi3, blue→ansi4, pink→ansi13, teal→ansi6,
sky→ansi14, lavender→ansi12, peach→ansi9, maroon→ansi9, mauve→ansi5, gray→ansi8) — old tabs render
correctly in every theme with zero migration risk; the picker only writes new names. Group colors
use the same 16 (group palette in `tab-groups.ts` re-pointed at the slots).

**D3 — Group button = tab-shaped, active when a member is active.**
The chip is restyled to tab metrics (full height, min 120px, squared). `SessionTabs` already knows
the active id and each group's members; it adds `.active` to the chip when the active tab is a
member → solid group color + flipped ink. The group line becomes a 3px BOTTOM bar under the chip
and every member (replacing the `--group-accent` underline/wash composite); since the top-stripe
layer is gone, this is a plain absolutely-positioned bar, continuous across the block. Collapse
behavior, guards, and the auto-expand effect are grouping concerns and are untouched.

**D4 — Pairings: `SplitState[]`, anchor-keyed, versioned storage, self-healing invariants.**
`useSplit` generalizes to a pairings array (each pairing keeps today's `{a, b, orientation, ratio,
focused}`; slot `a` IS the anchor). Storage moves to `palmux-splits` `{v: 2, pairings: [...]}`;
a legacy `palmux-split` blob parses into a one-pairing array once. Invariants enforced on every
load/broadcast reconcile: a tab in at most one pairing; both members alive with matching kinds
(existing `reconcileSplit` logic per pairing); **members strip-adjacent (anchor immediately
followed by partner) and same group membership — a broadcast that breaks either (e.g. a reorder
from another client) silently dissolves that pairing.** Adjacency-as-invariant is what lets the
server stay ignorant: fusion is purely "render these two adjacent tabs as one button".

**D5 — The strip renders a derived view; the fused button is active for EITHER member id.**
A pure helper (`fusedStrip(tabs, pairings)` in `tab-meta.ts`) collapses each pairing's partner into
the anchor's entry; `SessionTabs` renders fused entries as the two-segment button (segments min
90px; focused segment solid, other dimmed to a mid-tint; clicking a segment = activate the pairing

- focus that slot). The URL keeps today's rule unchanged — the FOCUSED slot's tab id, updated via
  `replaceState` — so deep links to either member resolve to the pairing with that member focused,
  and the fused button is active whenever the active id is either member. Navigation, close-nav
  (`neighborAfterClose`), and history operate on the visible (fused) strip order. Killing/closing
  either member dissolves the pairing (survivor full-width, normal close rules).

**D6 — Controller: fuse/unfuse/slotReplace/segmentFocus events replace scoping.**
`workspaceController.decide()` gains `fuse{anchorId, partnerId, orientation}` (from content-area
edge drops), `unfuse{anchorId, keep}` (⏏ eject — pairing dissolves, both tabs remain adjacent,
the OTHER tab stays active), `slotReplace{anchorId, slot, newTabId}` (drop on a slot: replaced tab
pops out standalone, newcomer fuses), and `segmentFocus`. Fuse effects, in order: optional
`groupUpdate` (partner adopts the anchor's membership — server-side, keeps groups contiguous),
`reorderTabs` moving the partner adjacent to the anchor, then the local pairing insert. The
scoping-era events/effects (`focusSlot` no-op guards, collapse-on-hidden, split-shown derivation)
are deleted along with `splitDisplayed`/badge rendering.

**D7 — Drop preview: the zones paint the claimed region.**
`SplitDropZones`/`SlotDropZones` currently render invisible hit areas. Each zone gains a dragover
visual: a theme-accent overlay (`color-mix` ~20%) covering the REGION the drop would claim — the
actual half (left/right/top/bottom at the 0.5 ratio) for edge drops, the whole slot for slot
replacement — cleared on dragleave/drop. Pure CSS + a `hover` state per zone; no new components.

**D8 — Fused button drags as one unit.**
Dragging a fused button uses the existing tab-drag payload with the anchor id; strip drop handlers
detect the anchor is paired and move BOTH ids together (one `reorderTabs` permutation, partner kept
adjacent). Center-drop on a group member moves both into the group (`groupUpdate` with both ids).
The old drag-onto-slot-center replacement gesture keeps working via D6's `slotReplace`.

**D9 — Mobile: visuals only.**
Drawer rows, group headers, and the tab sheet adopt the flat fills/tints and the 16-swatch picker.
Pairings are desktop state: the mobile layer keeps forcing single-pane, the drawer lists members
individually (no fused rows), and storage round-trips untouched exactly as `useSplit` does today.

## Risks / Trade-offs

- [Strip width: 120px minimums + 180px fused buttons overflow sooner] → strip already scrolls
  horizontally with hidden scrollbars; accepted and locked by João.
- [Another client's reorder splits a pairing's adjacency] → invariant dissolves the pairing
  silently (D4); the panes fall back to full-width — graceful, no ghost state.
- [Legacy color names map imperfectly onto some themes' ANSI slots] → mapping is static and
  deterministic; worst case a tab shifts hue slightly — one-tap re-pick fixes it forever.
- [Deleting display scoping changes muscle memory (member tab no longer summons a hidden split)] →
  intended: the fused button IS the pairing; there is no hidden state left to summon.
- [`exactOptionalPropertyTypes` + new unions in controller events] → keep events discriminated and
  effects additive; the 25 existing `decide()` tests are extended, not rewritten.

## Migration Plan

1. Part 1 (visual phases) lands and ships alone — pure presentation; verify all 11 themes
   (light + dark) before Part 2 starts.
2. Part 2 replaces the split model behind the same gestures; `palmux-split` → `palmux-splits`
   parse-once migration; no server deploy needed either way.
3. Rollback = revert the client bundle; legacy storage key is left in place (not deleted) for one
   release so a rollback still finds it.

## Open Questions

None — all decisions locked in the 2026-07-20 brainstorm session (variant A fills, ANSI16 picker,
segment min-width 90px, membership adoption, per-device pairings, eject/replace/pair-drag rules).
