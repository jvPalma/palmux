# Tab Strip Redesign and Split Fusion

## Why

The Chrome-look strip (rounded tabs, thin color stripes, chip-style groups) reads poorly at a glance
and the split view's "hidden pairing" model confuses in practice: a split is invisible strip state
that any member summons, only one pairing can exist, creating a second split silently destroys the
first, and drag-to-split gives no preview of where the drop will land. João locked a redesign (visual
mockups iterated in `.superpowers/brainstorm/`, 2026-07-20): flat solid-fill tabs, groups as
first-class tab buttons, and splits represented as ONE fused strip button per pairing — making
"where is my split" a question the strip itself answers, and letting any number of pairings coexist.

## What Changes

**Part 1 — strip visuals (independently shippable, lands first):**

- Tabs become flat: squared corners, full strip height, `min-width: 120px`. Active tab = SOLID
  accent fill (its own tab color, else the theme accent); ink color flips by accent luminance.
  Inactive tab = 8% tint of the same color (`bg/92`). The Chrome curved-corner/notch CSS is removed.
- Group button restyled as a tab-like button (same height, min 120px). The 3px group line runs along
  the bottom of the group button AND every member tab. The group button renders ACTIVE (solid group
  color + flipped ink) whenever the active tab is one of its members.
- Tab color picker replaced: the active theme's 16 ANSI colors (two rows — 8 normal, 8 bright) plus
  "none", sourced from each theme's own `ansi16`. **BREAKING (internal):** persisted tab/group color
  names migrate from the 12 derived-accent names to ANSI slot names via nearest-color mapping.
- Mobile mirrors the same principles: drawer rows + tab sheet get flat solid-fill active states, 8%
  tints, and the same 16-swatch picker.

**Part 2 — split fusion:**

- **Fused tab buttons:** a split pairing renders as ONE strip button at the anchor tab's position —
  two clickable segments (min 90px each, 180px min total); the focused pane's segment is solid, the
  other dimmed; clicking a segment focuses that pane. At fuse time the partner tab is reordered
  adjacent to the anchor (plain `reorderTabs` — the server stays fusion-ignorant); unfusing leaves
  the two tabs adjacent, no reorder needed.
- **Multiple pairings:** split state becomes a versioned per-device array of pairings (a tab belongs
  to at most one; no nesting). Only the ACTIVE pairing (its fused button is the active tab) renders,
  through the existing SplitView/PaneHost machinery unchanged. Creating a second split no longer
  destroys the first.
- **Display scoping removed:** ◧/◨ member badges, hidden-pairing behavior, and
  `splitDisplayed`/`memberSlot` scoping are deleted — a pairing is on screen exactly when its fused
  button is active. (Group collapse auto-expand is grouping behavior and is untouched.)
- **Drop preview:** drag-to-split and slot drop zones highlight the actual region the drop would
  claim (theme-accent overlay) while hovering.
- **Groups × fusion:** fusing across memberships makes the dragged tab ADOPT the anchor's group
  membership (server `groupUpdate`), keeping groups contiguous.
- Slot eject (⏏) dissolves the pairing (both tabs remain, adjacent; the OTHER tab stays active).
  Dropping a third tab onto a slot replaces it (the replaced tab pops out standalone; the newcomer
  adopts membership). Dragging the fused button drags the pair as one unit.

## Capabilities

### New Capabilities

- `split-fusion`: the fused strip representation of split pairings — fused button rendering and
  segment interaction, the multi-pairing model and its invariants, fuse/unfuse lifecycle (adjacency
  reorder, membership adoption, eject, slot replacement, pair drag), and per-device persistence.

### Modified Capabilities

- `chrome-tab-strip`: flat squared full-height tabs, 120px min-width, solid active fill + 8% tint
  inactive, luminance-flipped ink; curved-corner treatment removed.
- `tab-accents`: accent presentation changes from top-stripe + wash to solid fill/tint; the accent
  palette becomes the theme's 16 ANSI colors.
- `tab-customization`: picker offers 16 theme ANSI swatches (8 normal / 8 bright) + none; persisted
  color names migrate by nearest-slot mapping.
- `tab-grouping`: group button styled as a tab (min 120px), renders active when a member is active;
  group line extends under the button + members; group colors come from the same ANSI palette;
  mobile drawer group headers follow the same visual rules.
- `split-layout`: single-pairing display scoping replaced by the multi-pairing fused model; badges
  and hidden-pairing behavior removed; eject dissolves the active pairing.
- `split-dnd`: drop zones gain hover previews of the claimed region; drops adopt the anchor's group
  membership; the fused button is a draggable unit; slot drop replaces + pops out the old slot tab.

## Impact

- **Client only** — no wire-protocol or server changes. The server continues to see plain
  `reorderTabs`/`groupUpdate`; splits stay per-device (`localStorage`, new versioned array format
  replacing `palmux-split`, migrated on load).
- Touched: `index.css` (strip/group/tab-menu blocks), `SessionTabs.tsx`, `TabSheet.tsx`,
  `SessionDrawer.tsx`, `settings/themes.ts` (ANSI accent derivation), `tab-groups.ts`,
  `useSplit.ts` (pairings model), `workspaceController.ts` (fuse/unfuse/slotReplace events, scoping
  events removed), `SplitView.tsx`, `SplitDropZones.tsx`, `SlotDropZones.tsx`, `App.tsx`,
  `tab-meta.ts`.
- Deleted behavior: ◧/◨ badges, hidden-pairing display scoping, drag-onto-slot-center without
  pop-out semantics.
- Tests: existing split/controller/strip suites updated to the new model; new suites for pairings
  invariants, fusion lifecycle, color migration, and ANSI accent derivation.
