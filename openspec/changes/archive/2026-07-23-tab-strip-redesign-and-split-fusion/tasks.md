# Tasks — tab-strip-redesign-and-split-fusion

Part 1 (sections 1–3) is independently shippable; verify all 11 themes before starting Part 2
(sections 4–7).

## 1. ANSI palette + ink derivation (Part 1)

- [x] 1.1 `themes.ts`: replace `deriveAccents`' 12 invented hues with the 16 ANSI slots — emit
      `--tab-c-ansi<N>` plus a luminance-derived `--tab-c-ansi<N>-ink` per slot from
      `profile.ansi16` (reuse the existing luminance helper); keep `applyThemeTokens` call sites.
- [x] 1.2 `tab-meta.ts`: `TAB_COLORS` becomes the 16 slots; add the static legacy map
      (red→ansi1, green→ansi2, yellow→ansi3, blue→ansi4, mauve→ansi5, teal→ansi6, gray→ansi8,
      peach→ansi9, maroon→ansi9, lavender→ansi12, pink→ansi13, sky→ansi14) resolved inside
      `tabColorValue` (+ ink lookup); tests for legacy + slot resolution.
- [x] 1.3 `tab-groups.ts`: re-point the group palette (server-default pick + client swatches) at
      the same 16 slots; legacy group color names resolve via the same map.
- [x] 1.4 Picker UI (`SessionTabs` tab menu + `TabSheet`): render two labeled rows of 8
      theme-resolved swatches + "none"; writes slot names only. Tests updated.

## 2. Strip restyle (Part 1)

- [x] 2.1 `index.css` `.ctab` block: flat squared full-height tabs, `min-width: 120px`; DELETE the
      curved-corner pseudo-elements, top-stripe background-clip layers, and recessed/elevated
      treatment. Active = `background: var(--tab-accent)` + `color: var(--tab-ink)`; inactive =
      8% `color-mix` tint. Verify reorder insertion bar + dirty dot visibility on fills and tints.
- [x] 2.2 `SessionTabs.tsx`: set `--tab-accent`/`--tab-ink` per tab (own color else theme accent);
      luminance ink from the slot ink vars.
- [x] 2.3 Group button restyle: tab metrics (full height, min 120px, squared), 8% group tint
      idle, SOLID group fill + flipped ink when the active tab is a member; 3px bottom line
      continuous under button + members (replace the underline/wash channel). Update
      `SessionTabs` group rendering + CSS.
- [x] 2.4 Mobile: `SessionDrawer` rows + group headers and `TabSheet` adopt flat fills/8% tints
      with flipped ink.
- [x] 2.5 Client tests green (`SessionTabs`, `TabSheet`, `SessionDrawer`, tab-meta, themes) +
      visual pass over all 11 themes (light + dark) via dev server.

## 3. Part 1 gate

- [x] 3.1 `yarn typecheck` + `yarn test` + `yarn lint` clean; build; live e2e sanity (strip,
      groups, picker, mobile drawer) — Part 1 is shippable here.

## 4. Pairings model (Part 2)

- [x] 4.1 `useSplit.ts`: generalize to `pairings: SplitState[]` (slot `a` = anchor); storage
      `palmux-splits` `{v:2, pairings}` with parse-once migration from `palmux-split` (legacy key
      retained); forgiving parse; ops become pairing-scoped (open/dissolve/setRatio/
      toggleOrientation/focusSlot/setSlotTab by anchor id).
- [x] 4.2 Invariant enforcement (load + every reconcile): tab in ≤1 pairing, members
      strip-adjacent (anchor then partner) and same group membership, per-pairing dangling rules
      (reuse `reconcileSplit` logic) — violation dissolves ONLY that pairing. Unit tests incl.
      external-reorder adjacency break and one-of-two dissolution.
- [x] 4.3 `tab-meta.ts`: pure `fusedStrip(tabs, pairings)` derived view (partner collapses into
      anchor entry); `neighborAfterClose` + close-nav operate on the fused order. Tests.

## 5. Fused strip rendering + controller (Part 2)

- [x] 5.1 `SessionTabs.tsx` + CSS: fused two-segment button (segments min 90px, slot order, own
      accents; active = focused segment solid / other dimmed mid-tint; inactive = both 8%);
      segment click activates pairing + focuses slot; group line under fused buttons in groups;
      DELETE ◧/◨ badge rendering.
- [x] 5.2 `workspaceController.ts`: add `fuse{anchorId,partnerId,orientation}` (effects:
      membership-adopt `groupUpdate`? → adjacency `reorderTabs` → pairing insert),
      `unfuse{anchorId,keep}` (dissolve, OTHER tab active, no reorder), `slotReplace` (old tab
      pops out standalone, newcomer adopts), `segmentFocus`; DELETE display-scoping
      events/effects. Extend the pure `decide()` test suite (fuse across groups, second pairing,
      eject, deep link to partner, kill anchor/partner).
- [x] 5.3 `App.tsx` + `SplitView.tsx`: render the ACTIVE pairing only through the existing rect
      machinery; wire fused-button clicks/eject/segment focus to `dispatch`; URL keeps
      focused-slot + `replaceState` rule; delete `splitDisplayed`/`memberSlot` scoping usage and
      the split-shown derivation.

## 6. Dnd: preview, adoption, pair drag (Part 2)

- [x] 6.1 `SplitDropZones.tsx` + `SlotDropZones.tsx`: hover preview overlay painting the claimed
      region (edge = actual half at 0.5 ratio, slot = whole slot; theme-accent tint), cleared on
      leave/drop/end; file drags never trigger it.
- [x] 6.2 Edge/slot drop handlers dispatch `fuse`/`slotReplace` (membership adoption + adjacency
      per 5.2); menu "Split right/down" goes through `fuse`.
- [x] 6.3 Fused-button drag: pair moves as one unit (reorder keeps adjacency; group span/center
      drop = `groupUpdate` with both ids); fused drag never lights content drop zones; single tab
      dropped on a fused position reorders around it. Update `doReorder`/`moveGroup` optimistic
      paths for fused blocks.

## 7. Part 2 gate

- [x] 7.1 Full suites green + typecheck + lint; update `CLAUDE.md` (split section) and
      `tips/tips.ts` if gestures changed user-facing hints.
- [x] 7.2 Live e2e: fuse/unfuse, two coexisting pairings, cross-group fuse adoption, external
      reorder dissolution, drop previews, pair drag into a group, deep link to a partner id,
      mobile round-trip; 0 console errors.
